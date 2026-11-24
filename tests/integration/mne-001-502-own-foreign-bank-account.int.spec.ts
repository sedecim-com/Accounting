import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { recordCustomerPayment, recordVendorPayment } from '../../src/services/payments/payment-service.js';
import { getBankAccount, updateBankAccount, type ParcheCuenta } from '../../src/services/banking/bank-account-service.js';
import { generarPolizas } from '../../src/services/sat/anexo24/polizas-service.js';
import { encrypt } from '../../src/utils/encryption.js';
import { ValidationError } from '../../src/utils/errors.js';
import { validateAgainstOfficialXsd } from '../helpers/official-xsd.js';

// ============================================================
// MNE-001-502 (#697, part 1) · AN OWN BANK ACCOUNT A PERSON MARKS AS AT A
// FOREIGN BANK, AGAINST POSTGRES.
//
// Migration 343's column and CHECK, `bank account edit --foreign-bank` with
// its reason, its audit row and its refusals, and the month's vouchers: the
// payments from F go out as 999 with F's name, the same payments from N stay
// named with the two ways out. Hand figures P1-P5 from the plan; every party
// and every number is synthetic.
// ============================================================

const F_NUMBER = '000123456789';
const F_BANK = 'First Example Bank, N.A.';
const VENDOR_CLABE = '012180001234567899';
const PAYER_ACCOUNT = '072180005555555551';
const REQUEST = { tipo: 'AF' as const, numOrden: 'ABC1234567/26' };
const REASON = 'Cuenta abierta en Nueva York, estado de cuenta de octubre';

let f: Fixture;
let vendorId: string;
let customerId: string;
/** F: at a foreign bank, no code, no CLABE. N: the same, unmarked. R: with code 012 and a CLABE. S: with code 012, no CLABE. */
let F: string;
let N: string;
let R: string;
let S: string;

apartarCatalogos('sat_bancos');

const scope = () => entityScope(f.tenantId, f.entityId);
const edit = (ref: string, patch: ParcheCuenta, reason: string | null = REASON, dryRun = false) =>
  updateBankAccount(scope(), ref, patch, { userId: f.userId, reason, dryRun });

async function rowOf(id: string) {
  const r = await query<{ bank_is_foreign: boolean; sat_bank_code: string | null; has_clabe: boolean }>(
    `SELECT bank_is_foreign, sat_bank_code, clabe_encrypted IS NOT NULL AS has_clabe FROM bank_accounts WHERE id = $1`, [id]
  );
  return r.rows[0];
}

async function auditRows(id: string) {
  const r = await query<{ old_values: Record<string, unknown>; new_values: Record<string, unknown>; reason: string | null }>(
    `SELECT old_values, new_values, reason FROM audit_log
      WHERE entity_type = 'bank_accounts' AND entity_id = $1 ORDER BY timestamp, id`, [id]
  );
  return r.rows;
}

/**
 * Refused with the key, before any write: the row and its audit trail are as they were.
 * The attempt is a thunk, started only after the before-snapshot: a promise passed in
 * already running would reject while the snapshot is read, with no handler attached yet.
 */
async function refused(id: string, attempt: () => Promise<unknown>, key: string): Promise<void> {
  const before = [await rowOf(id), await auditRows(id)];
  const e = await attempt().catch((x: unknown) => x);
  expect(e).toBeInstanceOf(ValidationError);
  expect((e as ValidationError).messageKey?.key).toBe(key);
  expect([await rowOf(id), await auditRows(id)]).toEqual(before);
}

async function bankAccount(name: string, gl: string, over: { code?: string; clabe?: string } = {}): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, sat_bank_code,
       clabe_encrypted, clabe_last4, account_number_encrypted, account_number_last4, is_active)
     VALUES ($1,$2,$3,$4,$5,'MXN',$6,$7,$8,$9,$10,true)`,
    [id, f.entityId, name, F_BANK, f.cuentas[gl], over.code ?? null,
     over.clabe ? encrypt(over.clabe) : null, over.clabe ? over.clabe.slice(-4) : null,
     encrypt(F_NUMBER), F_NUMBER.slice(-4)]
  );
  return id;
}

/** A bill of `subtotal` + 16 % IVA, approved on `date`, paid whole from `bank` with `method`. */
async function paid(bank: string, subtotal: string, iva: string, total: string, date: string,
  method: Pick<Parameters<typeof recordVendorPayment>[0], 'paymentMethod' | 'checkNumber' | 'cuentaDestino' | 'bancoDestinoSat'>
): Promise<string> {
  const billId = uuidv4();
  const tag = billId.slice(0, 8);
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount, total_amount,
       amount_due, amount_paid, currency_code, exchange_rate, bill_date, due_date, status, created_by, terms, cfdi_uuid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'MXN','1',$9,$9,'draft',$10,'PPD',$11)`,
    [billId, f.entityId, `BILL-${tag}`, vendorId, `CFDI-${tag}`, subtotal, iva, total, date, f.userId, uuidv4()]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio a crédito',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, f.cuentas['6100'], subtotal, iva, total]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });
  const r = await recordVendorPayment(
    { entityId: f.entityId, paymentAmount: total, paymentDate: date, bankAccountId: bank, ...method,
      applications: [{ documentId: billId, amountApplied: total }] },
    f.userId
  );
  const entry = r.journalEntry?.entry_number;
  if (!entry) throw new Error('the payment must have posted');
  return entry;
}

/** An invoice of 200.00 + 16 % IVA, received whole into `bank` by SPEI from a payer at bank 072. */
async function received(bank: string, date: string): Promise<string> {
  const revenue = (await query<{ id: string }>(`SELECT id FROM accounts WHERE entity_id = $1 AND code = '4100'`, [f.entityId])).rows[0].id;
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: customerId, invoice_date: date, due_date: date, currency_code: 'MXN',
    lines: [{ revenue_account_id: revenue, description: 'Servicio', quantity: '1', unit_price: '200.00', tax_rate: '16.0000' }],
    created_by: f.userId,
  });
  const issued = await issueInvoice(draft.id, f.userId, { entityId: f.entityId });
  const r = await recordCustomerPayment(
    { entityId: f.entityId, paymentAmount: '232.00', paymentDate: date, paymentMethod: 'spei', bankAccountId: bank,
      payerBankCode: '072', payerAccount: PAYER_ACCOUNT,
      applications: [{ documentId: issued.invoice.id, amountApplied: '232.00' }] },
    f.userId
  );
  const entry = r.journalEntry?.entry_number;
  if (!entry) throw new Error('the receipt must have posted');
  return entry;
}

const month = () => generarPolizas(f.entityId, { periodo: '2026-10', solicitud: REQUEST });
const voucherOf = (xml: string, entry: string) =>
  xml.split('<PLZ:Poliza ').find((block) => block.includes(`NumUnIdenPol="${entry}"`)) ?? '';
const findingsOf = (r: Awaited<ReturnType<typeof month>>, entry: string, check: string) =>
  r.hallazgos.filter((h) => h.check === check && h.referencia === entry);

beforeAll(async () => {
  f = await crearInquilino('MNE-001-502 own foreign bank account');
  await query(`UPDATE legal_entities SET name = 'Entidad de Prueba SA', tax_id = 'EPR010101AB1' WHERE id = $1`, [f.entityId]);
  vendorId = uuidv4();
  customerId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,'V-502','Proveedor Puntual SA','PPU010101AB1','rfc','MXN',$3)`,
    [vendorId, f.entityId, f.userId]
  );
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, currency_code, created_by)
     VALUES ($1,$2,'C-502','Cliente Puntual SA','CPU010101AB1','MXN',$3)`,
    [customerId, f.entityId, f.userId]
  );
  // R and S never post: they sit on two header accounts no entry moves.
  F = await bankAccount('Cuenta en Nueva York', '1111');
  N = await bankAccount('Cuenta sin marca', '1112');
  R = await bankAccount('Cuenta con CLABE', '1100', { code: '012', clabe: VENDOR_CLABE });
  S = await bankAccount('Cuenta con clave', '1110', { code: '012' });
  // The published list, as far as these vouchers need it.
  await query(
    `INSERT INTO sat_bancos (clave, nombre_corto, vigente) VALUES ('012','BBVA',true), ('072','Banorte',true), ('999','N/A',true)
     ON CONFLICT (clave) DO NOTHING`
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('migration 343 · the column and its CHECK', () => {
  it('no existing account is foreign: the column defaults to false', async () => {
    for (const id of [F, N, R, S]) expect((await rowOf(id)).bank_is_foreign).toBe(false);
  });

  it.each([
    ['marking an account with a code and a CLABE', () => R, `UPDATE bank_accounts SET bank_is_foreign = true WHERE id = $1`],
    ['marking an account with a code', () => S, `UPDATE bank_accounts SET bank_is_foreign = true WHERE id = $1`],
  ])('a raw UPDATE %s raises 23514', async (_case, id, sql) => {
    const e = (await query(sql, [id()]).catch((x: unknown) => x)) as { code?: string; constraint?: string };
    expect(e.code).toBe('23514');
    expect(e.constraint).toBe('bank_accounts_foreign_bank_has_no_national_identifier');
  });
});

describe('bank account edit --foreign-bank, with its reason', () => {
  it('without a reason it is refused, keyed, and nothing is written', async () => {
    await refused(F, () => edit(F, { foreignBank: true }, null), 'bank.account.foreign_bank.reason_required');
    await refused(F, () => edit(F, { foreignBank: true }, '   '), 'bank.account.foreign_bank.reason_required');
  });

  it('with --dry-run nothing is written', async () => {
    const r = await edit(F, { foreignBank: true }, REASON, true);
    expect(r.dryRun).toBe(true);
    expect(r.cuenta.foreignBank).toBe(true);
    expect(await rowOf(F)).toEqual({ bank_is_foreign: false, sat_bank_code: null, has_clabe: false });
    expect(await auditRows(F)).toEqual([]);
  });

  it('marks F: the mark is stored, the audit row holds the before, the after and the reason, and show prints it', async () => {
    const r = await edit(F, { foreignBank: true });
    expect(r.cambios).toEqual([{ campo: 'bank_is_foreign', antes: false, despues: true }]);
    expect((await rowOf(F)).bank_is_foreign).toBe(true);
    const rows = await auditRows(F);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ old_values: { bank_is_foreign: false }, new_values: { bank_is_foreign: true }, reason: REASON });
    expect((await getBankAccount(scope(), F)).foreignBank).toBe(true);
    expect((await getBankAccount(scope(), N)).foreignBank).toBe(false);
  });

  it.each([
    ['marking an account with a code and a CLABE', () => R, { foreignBank: true }, 'bank.account.foreign_bank.keeps_sat_bank_code'],
    ['clearing the code but keeping the CLABE', () => R, { foreignBank: true, satBankCode: null }, 'bank.account.foreign_bank.keeps_clabe'],
    ['adding a code to a marked account', () => F, { satBankCode: '012' }, 'bank.account.foreign_bank.keeps_sat_bank_code'],
    ['adding 999 to a marked account', () => F, { satBankCode: '999' }, 'bank.account.foreign_bank.keeps_sat_bank_code'],
    ['adding a CLABE to a marked account', () => F, { clabe: VENDOR_CLABE }, 'bank.account.foreign_bank.keeps_clabe'],
  ] as const)('%s is refused before any write', async (_case, id, patch, key) => {
    await refused(id(), () => edit(id(), patch), key);
  });

  it('one edit that clears the code and sets the mark is accepted, judged on the row as it leaves it', async () => {
    const r = await edit(S, { satBankCode: null, foreignBank: true });
    expect(r.cambios.map((c) => c.campo)).toEqual(['sat_bank_code', 'bank_is_foreign']);
    expect(await rowOf(S)).toEqual({ bank_is_foreign: true, sat_bank_code: null, has_clabe: false });
  });
});

describe('P1-P5 · the month of October, from F marked and from N unmarked', () => {
  const entries: Record<string, string> = {};

  beforeAll(async () => {
    entries.P1 = await paid(F, '50.00', '8.00', '58.00', '2026-10-05', { paymentMethod: 'check', checkNumber: '4001' });
    entries.P2 = await paid(F, '100.00', '16.00', '116.00', '2026-10-06',
      { paymentMethod: 'spei', cuentaDestino: VENDOR_CLABE, bancoDestinoSat: '012' });
    entries.P3 = await received(F, '2026-10-07');
    entries.P4 = await paid(N, '50.00', '8.00', '58.00', '2026-10-08', { paymentMethod: 'check', checkNumber: '4002' });
    entries.P5 = await paid(N, '100.00', '16.00', '116.00', '2026-10-09',
      { paymentMethod: 'spei', cuentaDestino: VENDOR_CLABE, bancoDestinoSat: '012' });
  }, 180_000);

  it('P1-P3 go out as 999 with F\'s name, the file validates, and none is off the c_Banco list', async () => {
    const r = await month();
    expect(voucherOf(r.xml, entries.P1)).toContain(
      `<PLZ:Cheque Num="4001" BanEmisNal="999" BanEmisExt="${F_BANK}" CtaOri="${F_NUMBER}" Fecha="2026-10-05" ` +
        `Benef="Proveedor Puntual SA" RFC="PPU010101AB1" Monto="58.00" Moneda="MXN"/>`
    );
    expect(voucherOf(r.xml, entries.P2)).toContain(
      `<PLZ:Transferencia CtaOri="${F_NUMBER}" BancoOriNal="999" BancoOriExt="${F_BANK}" CtaDest="${VENDOR_CLABE}" ` +
        `BancoDestNal="012" Fecha="2026-10-06" Benef="Proveedor Puntual SA" RFC="PPU010101AB1" Monto="116.00" Moneda="MXN"/>`
    );
    expect(voucherOf(r.xml, entries.P3)).toContain(
      `<PLZ:Transferencia CtaOri="${PAYER_ACCOUNT}" BancoOriNal="072" CtaDest="${F_NUMBER}" BancoDestNal="999" ` +
        `BancoDestExt="${F_BANK}" Fecha="2026-10-07" Benef="Cliente Puntual SA" RFC="CPU010101AB1" Monto="232.00" Moneda="MXN"/>`
    );
    expect(validateAgainstOfficialXsd(r.xml, 'journal')).toEqual({ valid: true, errors: [] });
    for (const p of ['P1', 'P2', 'P3']) {
      expect(findingsOf(r, entries[p]!, 'poliza-con-dinero-sin-rastro'), p).toEqual([]);
      expect(findingsOf(r, entries[p]!, 'banco-en-catalogo'), p).toEqual([]);
    }
  }, 90_000);

  it('P4 and P5 from N stay named «no tiene clave c_Banco», with both ways out', async () => {
    const r = await month();
    for (const p of ['P4', 'P5']) {
      expect(voucherOf(r.xml, entries[p]!), p).not.toContain('999');
      const [h] = findingsOf(r, entries[p]!, 'poliza-con-dinero-sin-rastro');
      expect(h?.detalle, p).toContain('«Cuenta sin marca»');
      expect(h?.detalle, p).toContain('que no tiene clave c_Banco');
      expect(h?.detalle, p).toContain('`bank account edit <cuenta> --sat-bank-code <clave>`');
      expect(h?.detalle, p).toContain('`bank account edit <cuenta> --foreign-bank --reason <motivo>`');
    }
    expect((await rowOf(N)).bank_is_foreign).toBe(false);
  }, 90_000);

  it('a name over 150 characters leaves F\'s nodes out and is never truncated; a name of 150 goes out whole', async () => {
    const long = 'B'.repeat(150) + '\u{1D505}';
    await edit(F, { bankName: long });
    const r = await month();
    const [h] = findingsOf(r, entries.P1!, 'poliza-con-dinero-sin-rastro');
    expect(h?.detalle).toContain('BanEmisExt, que admite 150');
    expect(h?.detalle).toContain('tiene 151 caracteres');
    expect(h?.detalle).toContain('`bank account edit <cuenta> --bank <nombre de hasta 150 caracteres>`');
    expect(r.xml).not.toContain('B'.repeat(150));

    const whole = 'B'.repeat(149) + '\u{1D505}';
    await edit(F, { bankName: whole });
    const again = await month();
    expect(voucherOf(again.xml, entries.P1)).toContain(`BanEmisExt="${whole}"`);
    expect(validateAgainstOfficialXsd(again.xml, 'journal')).toEqual({ valid: true, errors: [] });
    await edit(F, { bankName: F_BANK });
  }, 120_000);

  it('removing the mark is audited the same way, and F\'s vouchers are named again', async () => {
    await refused(F, () => edit(F, { foreignBank: false }, null), 'bank.account.foreign_bank.reason_required');
    await edit(F, { foreignBank: false }, 'El banco resultó residente en México');
    const last = (await auditRows(F)).at(-1);
    expect(last).toEqual({
      old_values: { bank_is_foreign: true }, new_values: { bank_is_foreign: false }, reason: 'El banco resultó residente en México',
    });
    const r = await month();
    for (const p of ['P1', 'P2', 'P3']) {
      expect(findingsOf(r, entries[p]!, 'poliza-con-dinero-sin-rastro')[0]?.detalle, p).toContain('que no tiene clave c_Banco');
    }
  }, 90_000);
});
