import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { recordCustomerPayment, reverseCustomerPayment } from '../../src/services/payments/payment-service.js';
import { completePaymentTrace, type ReceiptTraceFields } from '../../src/services/payments/payment-trace-service.js';
import { ligarPagoREP } from '../../src/services/xml-ingestion/rep-linkage.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { generarPolizas } from '../../src/services/sat/anexo24/polizas-service.js';
import { encrypt } from '../../src/utils/encryption.js';
import { NotFoundError, ValidationError } from '../../src/utils/errors.js';
import { validateAgainstOfficialXsd } from '../helpers/official-xsd.js';

// ============================================================
// MNE-001-570 (#612, part 3/4) · `receipt trace record`, AGAINST POSTGRES.
//
// A receipt registered without the customer's bank, its cheque number, the
// account it was drawn on or our bank account gets them afterwards, on the
// same service and rules as a vendor payment: only empty fields, one guarded
// UPDATE, one audit row, no entry. Hand figures from the plan's cases R1 and
// R2 (the receipt a REP created); every party is synthetic.
// ============================================================

const CLABE = '012180001234567895';
const PAYROLL_CLABE = '072180005555555551';
const PAYER_ACCOUNT = '002180009876543210';
const REQUEST = { tipo: 'AF' as const, numOrden: 'ABC1234567/26' };

let f: Fixture;
let sister: Fixture;
let customerId: string;
let operativaId: string;
let payrollBankId: string;

/** An issued invoice of `unitPrice` + 16 % IVA to «Cliente Puntual SA», dated `date`. */
async function issuedInvoice(unitPrice: string, date: string): Promise<{ invoiceId: string; total: string }> {
  const revenue = (await query<{ id: string }>(`SELECT id FROM accounts WHERE entity_id = $1 AND code = '4100'`, [f.entityId])).rows[0].id;
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: customerId, invoice_date: date, due_date: date, currency_code: 'MXN',
    lines: [{ revenue_account_id: revenue, description: 'Servicio', quantity: '1', unit_price: unitPrice, tax_rate: '16.0000' }],
    created_by: f.userId,
  });
  const issued = await issueInvoice(draft.id, f.userId, { entityId: f.entityId });
  return { invoiceId: issued.invoice.id, total: new Decimal(unitPrice).times('1.16').toFixed(2) };
}

/** A receipt of the whole invoice with no `--bank` and nothing of the payer's but what `extra` gives. */
async function received(
  unitPrice: string,
  date: string,
  extra: Partial<Pick<Parameters<typeof recordCustomerPayment>[0], 'paymentMethod' | 'checkNumber' | 'payerBankCode'>> = {}
): Promise<{ id: string; number: string; entry: string }> {
  const inv = await issuedInvoice(unitPrice, date);
  const r = await recordCustomerPayment(
    {
      entityId: f.entityId, paymentAmount: inv.total, paymentDate: date, paymentMethod: 'spei', ...extra,
      applications: [{ documentId: inv.invoiceId, amountApplied: inv.total }],
    },
    f.userId
  );
  const entry = r.journalEntry?.entry_number;
  if (!entry) throw new Error('the receipt must have posted');
  return { id: r.paymentId, number: r.paymentNumber, entry };
}

const complete = (id: string, fields: ReceiptTraceFields, reason = 'CEP del cobro', entityId = f.entityId) =>
  completePaymentTrace(entityId, 'customer', id, fields, reason, f.userId);

async function traceOf(id: string) {
  const r = await query<Record<string, string | null>>(
    `SELECT check_number, cuenta_origen, banco_origen_sat, banco_origen_extranjero, bank_account_id
       FROM customer_payments WHERE id = $1`, [id]
  );
  return r.rows[0];
}

async function auditRows(id: string) {
  const r = await query<{ old_values: Record<string, unknown>; new_values: Record<string, unknown>; reason: string }>(
    `SELECT old_values, new_values, reason FROM audit_log
      WHERE entity_type = 'customer_payments' AND entity_id = $1 AND new_values->>'evento' = 'complete_trace'`, [id]
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
const findingsOf = (r: Awaited<ReturnType<typeof month>>, entry: string) => r.hallazgos.filter((h) => h.referencia === entry);

beforeAll(async () => {
  f = await crearInquilino('MNE-001-570 receipt trace');
  sister = await crearEntidadHermana(f, 'MNE-001-570 sister');
  await query(`UPDATE legal_entities SET name = 'Entidad de Prueba SA', tax_id = 'EPR010101AB1' WHERE id = $1`, [f.entityId]);
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, currency_code, created_by)
     VALUES ($1,$2,'C-570','Cliente Puntual SA','CPU010101AB1','MXN',$3)`,
    [customerId, f.entityId, f.userId]
  );
  // The `banco` role is 1111, and «Operativa BBVA» posts to it; «Nómina Banorte» to 1112.
  expect(f.roles['banco']).toBe(f.cuentas['1111']);
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

describe('R1 · a SPEI receipt of 2,320.00 registered with no --bank and no --payer-bank', () => {
  it('is completed with our account and the payer bank and account: the node goes out, and nothing posts', async () => {
    const p = await received('2000.00', '2026-11-12');

    const before = findingsOf(await month('11'), p.entry).filter((h) => h.check === 'poliza-con-dinero-sin-rastro');
    expect(before).toHaveLength(1);
    expect(before[0].severity).toBe('blocking');
    expect(before[0].detalle).toContain(`receipt trace record ${p.number} --bank <cuenta> --reason <motivo>`);
    expect(before[0].detalle).not.toContain('receipt record');

    const ledgerBefore = await ledger();
    const r = await complete(p.id, { bankAccountId: operativaId, payerBank: '002', payerAccount: PAYER_ACCOUNT });
    expect(r.filled.map((x) => [x.column, x.shown])).toEqual([
      ['cuenta_origen', '…3210'], ['banco_origen_sat', '002'], ['bank_account_id', 'Operativa BBVA'],
    ]);
    expect(r).toMatchObject({ paymentNumber: p.number, status: 'completed', journalEntry: p.entry, periodStatus: 'open' });
    expect(await traceOf(p.id)).toMatchObject({ cuenta_origen: PAYER_ACCOUNT, banco_origen_sat: '002', bank_account_id: operativaId });

    const after = await month('11');
    expect(voucherOf(after.xml, p.entry)).toContain(
      `<PLZ:Transferencia CtaOri="${PAYER_ACCOUNT}" BancoOriNal="002" CtaDest="${CLABE}" BancoDestNal="012" ` +
        `Fecha="2026-11-12" Benef="Cliente Puntual SA" RFC="CPU010101AB1" Monto="2320.00" Moneda="MXN"/>`
    );
    expect(validateAgainstOfficialXsd(after.xml, 'journal')).toEqual({ valid: true, errors: [] });
    expect(findingsOf(after, p.entry).filter((h) => h.check === 'poliza-con-dinero-sin-rastro')).toEqual([]);

    // One audit row under the receipts' table, the account masked; no entry touched.
    const rows = await auditRows(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('CEP del cobro');
    expect(rows[0].old_values).toEqual({ cuenta_origen: null, banco_origen_sat: null, bank_account_id: null });
    expect(rows[0].new_values).toEqual({
      evento: 'complete_trace', cuenta_origen: '…3210', banco_origen_sat: '002',
      bank_account_id: operativaId, bank_account: 'Operativa BBVA',
      period_status: 'open', journal_entry: p.entry, archived_voucher_files: 0,
    });
    expect(JSON.stringify(rows[0])).not.toContain(PAYER_ACCOUNT);
    expect(await ledger()).toBe(ledgerBefore);

    // A retry with the same values is unchanged; another payer bank is refused, naming the stored one.
    expect((await complete(p.id, { payerBank: '002' })).unchanged.map((x) => x.column)).toEqual(['banco_origen_sat']);
    const other = await complete(p.id, { payerBank: '072' }).catch((x: unknown) => x);
    expect(other).toBeInstanceOf(ValidationError);
    expect((other as Error).message).toMatch(/(ya tiene|already has) 002 (en|in) --payer-bank/);
    expect(await auditRows(p.id)).toHaveLength(1);
  }, 90_000);
});

describe('R2 · the receipt an issued REP created (rep_pago_no_registrado = crear_pago)', () => {
  it('is born with no bank account and no payer bank, and is completed the same way, with no CtaOri', async () => {
    await seedPolicies({ tenantId: f.tenantId });
    await resolvePolicy({ tenantId: f.tenantId }, 'rep_pago_no_registrado', 'crear_pago', f.userId, 'MNE-001-570');
    const invoiceId = uuidv4();
    const invoiceUuid = uuidv4();
    await query(
      `INSERT INTO invoices (
         id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
         amount_due, amount_paid, currency_code, invoice_date, due_date, status, cfdi_uuid, created_by
       ) VALUES ($1,$2,'INV-570-PPD',$3,8000.00,1280.00,9280.00,9280.00,0,'MXN','2026-10-05','2026-10-05','sent',$4,$5)`,
      [invoiceId, f.entityId, customerId, invoiceUuid, f.userId]
    );
    const rep = await ligarPagoREP({
      tenantId: f.tenantId, entityId: f.entityId, userId: f.userId, cfdiUuid: uuidv4(), direction: 'emitido', indice: 0,
      pago: {
        fechaPago: '2026-10-20T12:00:00', formaDePagoP: '03', monedaP: 'MXN', monto: 9280,
        docsRelacionados: [{ uuid: invoiceUuid, impSaldoAnt: 9280, impPagado: 9280, impSaldoInsoluto: 0, monedaDR: 'MXN' }],
      },
      fechaCfdi: new Date('2026-10-20T12:00:00Z'), monedaFuncional: 'MXN',
    });
    expect(rep.accion, rep.motivo).toBe('creado');
    const row = (await query<{ payment_number: string; entry: string }>(
      `SELECT cp.payment_number, je.entry_number AS entry FROM customer_payments cp
         JOIN journal_entries je ON je.id = cp.journal_entry_id WHERE cp.id = $1`, [rep.paymentId]
    )).rows[0];
    expect(await traceOf(rep.paymentId as string)).toMatchObject({ bank_account_id: null, banco_origen_sat: null });
    expect(findingsOf(await month('10'), row.entry)[0]?.detalle).toContain(`receipt trace record ${row.payment_number} --bank`);

    await complete(rep.paymentId as string, { bankAccountId: operativaId, payerBank: '002' });
    const voucher = voucherOf((await month('10')).xml, row.entry);
    expect(voucher).toContain(`<PLZ:Transferencia BancoOriNal="002" CtaDest="${CLABE}" BancoDestNal="012" `);
    expect(voucher).toContain('Monto="9280.00"');
    expect(voucher).not.toContain('CtaOri=');
  }, 90_000);
});

describe('a receipt by cheque registered with no number and no payer data', () => {
  it('is completed with its number, the issuing bank and the account it was drawn on', async () => {
    const p = await received('200.00', '2026-09-15', { paymentMethod: 'check' });
    expect(findingsOf(await month('09'), p.entry)[0]?.detalle).toContain(`receipt trace record ${p.number} --check-number`);
    await complete(p.id, { checkNumber: '4501', payerBank: '072', payerAccount: '1234567890' }, 'Ficha de depósito');
    expect(voucherOf((await month('09')).xml, p.entry)).toContain('<PLZ:Cheque Num="4501" BanEmisNal="072" CtaOri="1234567890" ');
  }, 60_000);
});

describe('a reversed receipt', () => {
  it('is completed: its entry stays in its month', async () => {
    const p = await received('100.00', '2026-08-10');
    await reverseCustomerPayment(f.entityId, p.id, { reason: 'Devuelto por el banco', cause: 'not_collected' }, f.userId);
    const r = await complete(p.id, { payerBank: '002' });
    expect(r.status).toBe('reversed');
    expect((await traceOf(p.id)).banco_origen_sat).toBe('002');
  }, 60_000);
});

describe('refusals write nothing', () => {
  it.each<[string, ReceiptTraceFields, RegExp]>([
    ['a payer account with no payer bank', { payerAccount: PAYER_ACCOUNT }, /cuenta del cliente.*banco/],
    ['a payer bank off c_Banco', { payerBank: '003' }, /«003».*c_Banco/],
    ['a national and a foreign payer bank', { payerBank: '002', payerForeignBank: 'Bank of Nowhere' }, /nacional.*extranjero/],
    ['a cheque number on a SPEI receipt', { checkNumber: '4501' }, /número de cheque/],
    ['a payer bank longer than three characters', { payerBank: '0021' }, /--payer-bank/],
    ['no trace field', {}, /--payer-bank/],
  ])('%s', async (_case, fields, message) => {
    const p = await received('10.00', '2026-07-15');
    const before = await traceOf(p.id);
    const e = await complete(p.id, fields).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as Error).message).toMatch(message);
    expect(await traceOf(p.id)).toEqual(before);
    expect(await auditRows(p.id)).toEqual([]);
  }, 60_000);

  it('a payer bank on a cash receipt', async () => {
    const p = await received('10.00', '2026-07-16', { paymentMethod: 'cash' });
    const e = await complete(p.id, { payerBank: '002' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as Error).message).toContain('«cash»');
    expect(await auditRows(p.id)).toEqual([]);
  }, 60_000);

  it('a bank account whose ledger account the entry did not move', async () => {
    const p = await received('10.00', '2026-07-17');
    const e = await complete(p.id, { bankAccountId: payrollBankId }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as Error).message).toContain('1111');
    expect((e as Error).message).toContain('1112');
    expect((await traceOf(p.id)).bank_account_id).toBeNull();
  }, 60_000);

  it('a receipt of another entity answers as one that does not exist', async () => {
    const p = await received('10.00', '2026-07-18');
    const random = uuidv4();
    const crossed = await complete(p.id, { payerBank: '002' }, 'x', sister.entityId).catch((x: unknown) => x);
    const missing = await complete(random, { payerBank: '002' }, 'x', sister.entityId).catch((x: unknown) => x);
    expect(crossed).toBeInstanceOf(NotFoundError);
    expect((crossed as Error).message.replace(p.id, '<id>')).toBe((missing as Error).message.replace(random, '<id>'));
    expect((await traceOf(p.id)).banco_origen_sat).toBeNull();
  }, 60_000);
});
