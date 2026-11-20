import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment, reverseVendorPayment } from '../../src/services/payments/payment-service.js';
import { completePaymentTrace, type VendorTraceFields } from '../../src/services/payments/payment-trace-service.js';
import { generarPolizas } from '../../src/services/sat/anexo24/polizas-service.js';
import { encrypt } from '../../src/utils/encryption.js';
import { AppError, ValidationError } from '../../src/utils/errors.js';
import { validateAgainstOfficialXsd } from '../helpers/official-xsd.js';

// ============================================================
// MNE-001-569 (#612, part 2/4) · `payment trace record --bank`, AGAINST
// POSTGRES, and the c_Banco list at capture and at completion.
//
// A payment registered without `--bank` posted to the entity's `banco` role.
// Linking a bank account afterwards is accepted only when the ledger account
// that bank account posts to is one the payment's own entry moved, and its
// currency is the payment's: the voucher must never declare a bank the ledger
// did not move. Hand figures from the plan's cases B1-B4; every party is
// synthetic.
// ============================================================

const CLABE = '012180001234567895';
const PAYROLL_CLABE = '072180005555555551';
const TO_ACCOUNT = '002180001122334455';
const REQUEST = { tipo: 'AF' as const, numOrden: 'ABC1234567/26' };

let f: Fixture;
let vendorId: string;
let usdVendorId: string;
let operativaId: string;
let payrollBankId: string;

/** A bill of `subtotal` + `iva`, approved, dated `date`; in dollars at `rate` when given. */
async function approvedBill(subtotal: string, iva: string, total: string, date: string, rate?: string): Promise<string> {
  const billId = uuidv4();
  const tag = billId.slice(0, 8);
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, exchange_rate, bill_date, due_date, status, created_by, terms, cfdi_uuid
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,$9,$10,$11,$11,'draft',$12,'PPD',$13)`,
    [billId, f.entityId, `BILL-${tag}`, rate ? usdVendorId : vendorId, `CFDI-${tag}`, subtotal, iva, total,
     rate ? 'USD' : 'MXN', rate ?? '1', date, f.userId, uuidv4()]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio a crédito',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, f.cuentas['6100'], subtotal, iva, total]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });
  return billId;
}

/** A payment of the whole bill registered with NO `--bank`: it posts to the `banco` role. */
async function paidWithoutBank(
  bill: [subtotal: string, iva: string, total: string],
  date: string,
  extra: { toAccount?: string; toBank?: string; rate?: string } = {}
): Promise<{ id: string; number: string; entry: string }> {
  const billId = await approvedBill(...bill, date, extra.rate);
  const r = await recordVendorPayment(
    {
      entityId: f.entityId, paymentAmount: bill[2], paymentDate: date, paymentMethod: 'spei',
      cuentaDestino: extra.toAccount ?? TO_ACCOUNT, bancoDestinoSat: extra.toBank ?? '002',
      ...(extra.rate ? { exchangeRate: extra.rate } : {}),
      applications: [{ documentId: billId, amountApplied: bill[2] }],
    },
    f.userId
  );
  const entry = r.journalEntry?.entry_number;
  if (!entry) throw new Error('the payment must have posted');
  return { id: r.paymentId, number: r.paymentNumber, entry };
}

const link = (id: string, bankAccountId: string, fields: VendorTraceFields = {}, reason = 'Estado de cuenta de noviembre') =>
  completePaymentTrace(f.entityId, 'vendor', id, { ...fields, bankAccountId }, reason, f.userId);

async function bankOf(id: string): Promise<string | null> {
  return (await query<{ bank_account_id: string | null }>('SELECT bank_account_id FROM vendor_payments WHERE id = $1', [id]))
    .rows[0].bank_account_id;
}

async function auditRows(id: string) {
  const r = await query<{ old_values: Record<string, unknown>; new_values: Record<string, unknown>; reason: string }>(
    `SELECT old_values, new_values, reason FROM audit_log
      WHERE entity_type = 'vendor_payments' AND entity_id = $1 AND new_values->>'evento' = 'complete_trace'`, [id]
  );
  return r.rows;
}

/** Every entry of the entity and every line, whole: a completion touches none. */
async function ledger(): Promise<string> {
  await drainAttestations(2000);
  const r = await query<{ row: unknown }>(
    `SELECT jsonb_build_object('entry', to_jsonb(je), 'lines',
              (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.line_number) FROM journal_entry_lines l WHERE l.journal_entry_id = je.id)) AS row
       FROM journal_entries je WHERE je.entity_id = $1 ORDER BY je.id`, [f.entityId]
  );
  return JSON.stringify(r.rows);
}

const month = (m: string) => generarPolizas(f.entityId, { periodo: `2026-${m}`, solicitud: REQUEST });
const voucherOf = (xml: string, entry: string) =>
  xml.split('<PLZ:Poliza ').find((block) => block.includes(`NumUnIdenPol="${entry}"`)) ?? '';
const untraced = (r: Awaited<ReturnType<typeof month>>, entry: string) =>
  r.hallazgos.filter((h) => h.check === 'poliza-con-dinero-sin-rastro' && h.referencia === entry);

/** A refusal that wrote nothing: no bank linked, no audit row. */
async function refusedWithNothingWritten(id: string, attempt: Promise<unknown>): Promise<Error> {
  const e = await attempt.catch((x: unknown) => x);
  expect(e).toBeInstanceOf(AppError);
  expect(await bankOf(id)).toBeNull();
  expect(await auditRows(id)).toEqual([]);
  return e as Error;
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-569 payment bank link');
  await query(`UPDATE legal_entities SET name = 'Entidad de Prueba SA', tax_id = 'EPR010101AB1' WHERE id = $1`, [f.entityId]);
  vendorId = uuidv4();
  usdVendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,'V-569','Proveedor Puntual SA','PPU010101AB1','rfc','MXN',$3),
            ($4,$2,'V-569-USD','Proveedor en Dólares SA','PDO010101AB1','rfc','USD',$3)`,
    [vendorId, f.entityId, f.userId, usdVendorId]
  );
  // The `banco` role is 1111, and «Operativa BBVA» posts to it; «Nómina Banorte» to 1112.
  expect(f.roles['banco']).toBe(f.cuentas['1111']);
  expect(f.cuentas['1112']).toBeDefined();
  operativaId = uuidv4();
  payrollBankId = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id,
       currency_code, sat_bank_code, clabe_encrypted, clabe_last4, is_active)
     VALUES ($1,$2,'Operativa BBVA','BBVA México',$3,'MXN','012',$4,$5,true),
            ($6,$2,'Nómina Banorte','Banorte',$7,'MXN','072',$8,$9,true)`,
    [operativaId, f.entityId, f.cuentas['1111'], encrypt(CLABE), CLABE.slice(-4),
     payrollBankId, f.cuentas['1112'], encrypt(PAYROLL_CLABE), PAYROLL_CLABE.slice(-4)]
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('B1 · a transfer of 1,160.00 registered with no bank account, posted to 1111 by the role', () => {
  it('links «Operativa BBVA», which posts to 1111: the node gains BancoOriNal 012 and CtaOri, and nothing posts', async () => {
    const p = await paidWithoutBank(['1000.00', '160.00', '1160.00'], '2026-11-05');

    const before = await month('11');
    expect(untraced(before, p.entry)).toHaveLength(1);
    expect(untraced(before, p.entry)[0].detalle).toContain(`payment trace record ${p.number} --bank <cuenta> --reason <motivo>`);
    expect(untraced(before, p.entry)[0].detalle).not.toContain('payment create');

    const ledgerBefore = await ledger();
    const r = await link(p.id, operativaId);
    expect(r.filled).toEqual([{ column: 'bank_account_id', flag: '--bank', shown: 'Operativa BBVA' }]);
    expect(r.unchanged).toEqual([]);
    expect(await bankOf(p.id)).toBe(operativaId);

    const after = await month('11');
    expect(voucherOf(after.xml, p.entry)).toContain(
      `<PLZ:Transferencia CtaOri="${CLABE}" BancoOriNal="012" CtaDest="${TO_ACCOUNT}" BancoDestNal="002" ` +
        `Fecha="2026-11-05" Benef="Proveedor Puntual SA" RFC="PPU010101AB1" Monto="1160.00" Moneda="MXN"/>`
    );
    expect(validateAgainstOfficialXsd(after.xml, 'journal')).toEqual({ valid: true, errors: [] });
    expect(untraced(after, p.entry)).toEqual([]);
    expect(after.puedeEntregarse).toBe(true);

    // The audit row names the account, by id and by name.
    const rows = await auditRows(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].old_values).toEqual({ bank_account_id: null });
    expect(rows[0].new_values).toEqual({
      evento: 'complete_trace', bank_account_id: operativaId, bank_account: 'Operativa BBVA',
      period_status: 'open', journal_entry: p.entry, archived_voucher_files: 0,
    });
    expect(await ledger()).toBe(ledgerBefore);

    // The same account again is unchanged; another one is refused, naming the linked one.
    const again = await link(p.id, operativaId);
    expect(again.filled).toEqual([]);
    expect(again.unchanged).toEqual([{ column: 'bank_account_id', flag: '--bank', shown: 'Operativa BBVA' }]);
    expect(await auditRows(p.id)).toHaveLength(1);
  }, 90_000);

  it('an inactive bank account is accepted: linking is history, not new money movement', async () => {
    const p = await paidWithoutBank(['100.00', '16.00', '116.00'], '2026-10-06');
    await query('UPDATE bank_accounts SET is_active = false WHERE id = $1', [operativaId]);
    try {
      const r = await link(p.id, operativaId);
      expect(r.filled.map((x) => x.column)).toEqual(['bank_account_id']);
      expect(await bankOf(p.id)).toBe(operativaId);
    } finally {
      await query('UPDATE bank_accounts SET is_active = true WHERE id = $1', [operativaId]);
    }
  }, 60_000);
});

describe('B2 · linking the wrong bank account', () => {
  it('«Nómina Banorte», which posts to 1112, is refused naming both accounts, and nothing is written', async () => {
    const p = await paidWithoutBank(['1000.00', '160.00', '1160.00'], '2026-08-05');
    const e = await refusedWithNothingWritten(p.id, link(p.id, payrollBankId));
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.message).toContain('1111');
    expect(e.message).toContain('Nómina Banorte');
    expect(e.message).toContain('1112');
  }, 60_000);

  it('a payment with no posted entry has no line to check against, and is refused', async () => {
    const p = await paidWithoutBank(['50.00', '8.00', '58.00'], '2026-08-06');
    await query('UPDATE vendor_payments SET journal_entry_id = NULL WHERE id = $1', [p.id]);
    const e = await refusedWithNothingWritten(p.id, link(p.id, operativaId));
    expect(e).toBeInstanceOf(ValidationError);
    expect(e.message).toContain(p.number);
  }, 60_000);

  it('the other given fields of a refused link are not written either', async () => {
    const p = await paidWithoutBank(['50.00', '8.00', '58.00'], '2026-08-07', { toAccount: '', toBank: '' });
    await refusedWithNothingWritten(p.id, link(p.id, payrollBankId, { toAccount: TO_ACCOUNT, toBank: '002' }));
    const row = (await query<{ cuenta_destino: string | null }>('SELECT cuenta_destino FROM vendor_payments WHERE id = $1', [p.id])).rows[0];
    expect(row.cuenta_destino).toBeNull();
  }, 60_000);
});

describe('B3 · a payment of 100.00 USD at 18.50 registered with no bank account', () => {
  it('a peso bank account is refused in the terms of the capture: the currencies do not match', async () => {
    const p = await paidWithoutBank(['100.00', '0.00', '100.00'], '2026-07-15', { rate: '18.50' });
    const e = await refusedWithNothingWritten(p.id, link(p.id, operativaId));
    expect((e as AppError).code).toBe('FX_BANK_CURRENCY_MISMATCH');
    expect(e.message).toContain('USD');
    expect(e.message).toContain('MXN');
  }, 60_000);
});

describe('B4 · a bank code off the SAT c_Banco list', () => {
  it('`payment trace record --to-bank 003` is refused against c_Banco, and nothing is written', async () => {
    const p = await paidWithoutBank(['50.00', '8.00', '58.00'], '2026-06-05', { toAccount: '', toBank: '' });
    const e = await completePaymentTrace(f.entityId, 'vendor', p.id, { toAccount: TO_ACCOUNT, toBank: '003' }, 'x', f.userId)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as Error).message).toContain('«003»');
    expect((e as Error).message).toContain('c_Banco');
    expect(await auditRows(p.id)).toEqual([]);
  }, 60_000);

  it('`payment create --to-bank 003` is refused too, before anything is recorded', async () => {
    const billId = await approvedBill('50.00', '8.00', '58.00', '2026-06-06');
    const count = async () =>
      (await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM vendor_payments WHERE entity_id = $1', [f.entityId])).rows[0].n;
    const before = await count();
    const e = await recordVendorPayment(
      {
        entityId: f.entityId, paymentAmount: '58.00', paymentDate: '2026-06-06', paymentMethod: 'spei',
        bankAccountId: operativaId, cuentaDestino: '003180009876543210', bancoDestinoSat: '003',
        applications: [{ documentId: billId, amountApplied: '58.00' }],
      },
      f.userId
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as Error).message).toContain('c_Banco');
    expect(await count()).toBe(before);
  }, 60_000);

  it('999 given together with a foreign bank name is refused: a foreign bank is given by its name alone', async () => {
    const p = await paidWithoutBank(['50.00', '8.00', '58.00'], '2026-06-07', { toAccount: '', toBank: '' });
    const e = await completePaymentTrace(
      f.entityId, 'vendor', p.id, { toAccount: TO_ACCOUNT, toBank: '999', toForeignBank: 'Bank of Nowhere' }, 'x', f.userId
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as Error).message).toContain('999');
    expect(await auditRows(p.id)).toEqual([]);
  }, 60_000);
});

describe('a completion racing a `payment reverse` of the same payment', () => {
  it('the two serialize on the payment row: the link is written once, and the reversal once', async () => {
    const p = await paidWithoutBank(['400.00', '64.00', '464.00'], '2026-05-15');
    const outcomes = await Promise.allSettled([
      link(p.id, operativaId),
      reverseVendorPayment(f.entityId, p.id, { reason: 'Devuelta por el banco', date: '2026-05-20' }, f.userId),
    ]);
    // A reversed payment's entry stays in its month, so the link is accepted after the reversal too.
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(await bankOf(p.id)).toBe(operativaId);
    expect(await auditRows(p.id)).toHaveLength(1);
    const status = (await query<{ status: string }>('SELECT status FROM vendor_payments WHERE id = $1', [p.id])).rows[0].status;
    expect(status).toBe('reversed');
    const mirrors = await query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM journal_entries
        WHERE entity_id = $1 AND reverses_entry_id = (SELECT journal_entry_id FROM vendor_payments WHERE id = $2)`,
      [f.entityId, p.id]
    );
    expect(mirrors.rows[0].n).toBe(1);
  }, 60_000);
});
