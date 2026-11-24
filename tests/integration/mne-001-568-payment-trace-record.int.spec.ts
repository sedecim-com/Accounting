import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { recordVendorPayment, reverseVendorPayment } from '../../src/services/payments/payment-service.js';
import { completePaymentTrace, type VendorTraceFields } from '../../src/services/payments/payment-trace-service.js';
import { generarPolizas } from '../../src/services/sat/anexo24/polizas-service.js';
import { encrypt } from '../../src/utils/encryption.js';
import { AppError, NotFoundError, ValidationError } from '../../src/utils/errors.js';
import { validateAgainstOfficialXsd } from '../helpers/official-xsd.js';

// ============================================================
// MNE-001-568 (#612, part 1/4) · `payment trace record`, AGAINST POSTGRES.
//
// A vendor payment registered without its cheque number or its destination
// gets them afterwards: only empty fields, one guarded UPDATE, one audit row,
// and no entry created, changed or reversed. Hand figures from the plan's
// cases P1-P9; every party is synthetic.
// ============================================================

const CLABE = '012180001234567895';
const TO_ACCOUNT = '002180001122334455';
const REQUEST = { tipo: 'AF' as const, numOrden: 'ABC1234567/26' };

let f: Fixture;
let sister: Fixture;
let vendorId: string;
let bankId: string;

/** A bill of `subtotal` + `iva`, approved, dated `date`. */
async function approvedBill(subtotal: string, iva: string, total: string, date: string): Promise<string> {
  const billId = uuidv4();
  const tag = billId.slice(0, 8);
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by, terms, cfdi_uuid
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,'MXN',$9,$9,'draft',$10,'PPD',$11)`,
    [billId, f.entityId, `BILL-${tag}`, vendorId, `CFDI-${tag}`, subtotal, iva, total, date, f.userId, uuidv4()]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio a crédito',1,$4,$4,$5,$6)`,
    [uuidv4(), billId, f.cuentas['6100'], subtotal, iva, total]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });
  return billId;
}

/** A payment of the whole bill from «Operativa BBVA», registered with no trace beyond what `extra` gives. */
async function paid(
  method: string,
  bill: [subtotal: string, iva: string, total: string],
  date: string
): Promise<{ id: string; number: string; entry: string }> {
  const billId = await approvedBill(...bill, date);
  const r = await recordVendorPayment(
    {
      entityId: f.entityId, paymentAmount: bill[2], paymentDate: date, paymentMethod: method,
      bankAccountId: bankId, applications: [{ documentId: billId, amountApplied: bill[2] }],
    },
    f.userId
  );
  const entry = r.journalEntry?.entry_number;
  if (!entry) throw new Error('the payment must have posted');
  return { id: r.paymentId, number: r.paymentNumber, entry };
}

const complete = (id: string, fields: VendorTraceFields, reason = 'Comprobante SPEI OP-0511', entityId = f.entityId) =>
  completePaymentTrace(entityId, 'vendor', id, fields, reason, f.userId);

async function traceOf(id: string) {
  const r = await query<Record<string, string | null>>(
    `SELECT status, check_number, cuenta_destino, banco_destino_sat, banco_destino_extranjero
       FROM vendor_payments WHERE id = $1`, [id]
  );
  return r.rows[0];
}

async function auditRows(id: string) {
  const r = await query<{ action: string; user_id: string; old_values: Record<string, unknown>; new_values: Record<string, unknown>; reason: string }>(
    `SELECT action, user_id, old_values, new_values, reason FROM audit_log
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

beforeAll(async () => {
  f = await crearInquilino('MNE-001-568 payment trace');
  sister = await crearEntidadHermana(f, 'MNE-001-568 sister');
  await query(`UPDATE legal_entities SET name = 'Entidad de Prueba SA', tax_id = 'EPR010101AB1' WHERE id = $1`, [f.entityId]);
  vendorId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,'V-568','Proveedor Puntual SA','PPU010101AB1','rfc','MXN',$3)`,
    [vendorId, f.entityId, f.userId]
  );
  bankId = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id,
       currency_code, sat_bank_code, clabe_encrypted, clabe_last4, is_active)
     VALUES ($1,$2,'Operativa BBVA','BBVA México',$3,'MXN','012',$4,$5,true)`,
    [bankId, f.entityId, f.roles['banco'], encrypt(CLABE), CLABE.slice(-4)]
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('P1 · a SPEI of 1,160.00 with no destination, completed with its account and bank', () => {
  it('is blocked before, and after it goes out as a Transferencia, validates and can be delivered', async () => {
    const p = await paid('spei', ['1000.00', '160.00', '1160.00'], '2026-11-05');

    const before = await month('11');
    expect(untraced(before, p.entry)).toHaveLength(1);
    expect(untraced(before, p.entry)[0].severity).toBe('blocking');
    expect(untraced(before, p.entry)[0].detalle).toContain(`payment trace record ${p.number} --to-account`);
    expect(untraced(before, p.entry)[0].detalle).not.toContain('payment create');
    expect(before.puedeEntregarse).toBe(false);

    const entries = await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM journal_entries WHERE entity_id = $1', [f.entityId]);
    const ledgerBefore = await ledger();
    const r = await complete(p.id, { toAccount: TO_ACCOUNT, toBank: '002' });
    expect(r.filled.map((x) => [x.column, x.shown])).toEqual([['cuenta_destino', '…4455'], ['banco_destino_sat', '002']]);
    expect(r).toMatchObject({ paymentNumber: p.number, status: 'completed', unchanged: [], journalEntry: p.entry, period: '2026-11', periodStatus: 'open', archivedVoucherFiles: 0 });
    expect(await traceOf(p.id)).toMatchObject({ cuenta_destino: TO_ACCOUNT, banco_destino_sat: '002' });

    const after = await month('11');
    expect(voucherOf(after.xml, p.entry)).toContain(
      `<PLZ:Transferencia CtaOri="${CLABE}" BancoOriNal="012" CtaDest="${TO_ACCOUNT}" BancoDestNal="002" ` +
        `Fecha="2026-11-05" Benef="Proveedor Puntual SA" RFC="PPU010101AB1" Monto="1160.00" Moneda="MXN"/>`
    );
    expect(validateAgainstOfficialXsd(after.xml, 'journal')).toEqual({ valid: true, errors: [] });
    expect(untraced(after, p.entry)).toEqual([]);
    expect(after.hallazgos.filter((h) => h.severity === 'blocking')).toEqual([]);
    expect(after.puedeEntregarse).toBe(true);

    // One audit row, field by field; no entry created, changed or reversed.
    const rows = await auditRows(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'update', user_id: f.userId, reason: 'Comprobante SPEI OP-0511' });
    expect(rows[0].old_values).toEqual({ cuenta_destino: null, banco_destino_sat: null });
    expect(rows[0].new_values).toEqual({
      evento: 'complete_trace', cuenta_destino: '…4455', banco_destino_sat: '002',
      period_status: 'open', journal_entry: p.entry, archived_voucher_files: 0,
    });
    expect(JSON.stringify(rows[0])).not.toContain(TO_ACCOUNT);
    expect((await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM journal_entries WHERE entity_id = $1', [f.entityId])).rows[0].n)
      .toBe(entries.rows[0].n);
    expect(await ledger()).toBe(ledgerBefore);
  }, 90_000);
});

describe('P2-P4 · a cheque of 580.00 with no number', () => {
  let p: { id: string; number: string; entry: string };

  it('P2 · completed with 000123, it goes out as Cheque Num 000123', async () => {
    p = await paid('check', ['500.00', '80.00', '580.00'], '2026-03-10');
    expect(untraced(await month('03'), p.entry)[0].detalle).toContain(`payment trace record ${p.number} --check-number`);
    const r = await complete(p.id, { checkNumber: '000123' }, 'Talón del cheque');
    expect(r.filled).toEqual([{ column: 'check_number', flag: '--check-number', shown: '000123' }]);
    const after = await month('03');
    expect(voucherOf(after.xml, p.entry)).toContain(
      `<PLZ:Cheque Num="000123" BanEmisNal="012" CtaOri="${CLABE}" Fecha="2026-03-10" ` +
        `Benef="Proveedor Puntual SA" RFC="PPU010101AB1" Monto="580.00" Moneda="MXN"/>`
    );
    expect(validateAgainstOfficialXsd(after.xml, 'journal')).toEqual({ valid: true, errors: [] });
  }, 60_000);

  it('P3 · the same value again is unchanged, with no second audit row', async () => {
    const r = await complete(p.id, { checkNumber: '000123' }, 'Talón del cheque');
    expect(r.filled).toEqual([]);
    expect(r.unchanged).toEqual([{ column: 'check_number', flag: '--check-number', shown: '000123' }]);
    expect(await auditRows(p.id)).toHaveLength(1);
  });

  it('P4 · another value is refused naming the stored one, and nothing is written', async () => {
    const e = await complete(p.id, { checkNumber: '000124' }, 'Talón del cheque').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as Error).message).toContain('000123');
    expect((await traceOf(p.id)).check_number).toBe('000123');
    expect(await auditRows(p.id)).toHaveLength(1);
  });
});

describe('P5 · a payment of another entity', () => {
  it('answers as one that does not exist', async () => {
    const p = await paid('spei', ['100.00', '16.00', '116.00'], '2026-02-10');
    const random = uuidv4();
    const crossed = await complete(p.id, { toAccount: TO_ACCOUNT }, 'x', sister.entityId).catch((x: unknown) => x);
    const missing = await complete(random, { toAccount: TO_ACCOUNT }, 'x', sister.entityId).catch((x: unknown) => x);
    expect(crossed).toBeInstanceOf(NotFoundError);
    expect(missing).toBeInstanceOf(NotFoundError);
    expect((crossed as Error).message.replace(p.id, '<id>')).toBe((missing as Error).message.replace(random, '<id>'));
    expect((await traceOf(p.id)).cuenta_destino).toBeNull();
  });
});

describe('P6 · a reversed payment', () => {
  it('is completed: its own month emits the node and the mirror of the reversal is left as it was', async () => {
    const p = await paid('spei', ['200.00', '32.00', '232.00'], '2026-06-20');
    const reversal = await reverseVendorPayment(f.entityId, p.id, { reason: 'Devuelta por el banco', date: '2026-07-10' }, f.userId);
    const mirror = reversal.reversals.find((x) => x.of === p.entry)?.entryNumber ?? '';
    expect(mirror).not.toBe('');
    const julyBefore = untraced(await month('07'), mirror);

    const r = await complete(p.id, { toAccount: TO_ACCOUNT, toBank: '002' });
    expect(r.status).toBe('reversed');
    expect(r.period).toBe('2026-06');
    expect(voucherOf((await month('06')).xml, p.entry)).toContain(`CtaDest="${TO_ACCOUNT}" BancoDestNal="002"`);
    expect(untraced(await month('07'), mirror)).toEqual(julyBefore);
  }, 90_000);
});

describe('P7 · a payment of a hard-closed month', () => {
  it('is completed with no gate, says the state, and writes no entry', async () => {
    const p = await paid('spei', ['300.00', '48.00', '348.00'], '2026-09-15');
    await query(`UPDATE fiscal_periods SET status = 'hard_close', hard_close_date = NOW() WHERE id = $1`, [f.periodos[9]]);
    const ledgerBefore = await ledger();
    const r = await complete(p.id, { toAccount: TO_ACCOUNT, toBank: '002' });
    expect(r).toMatchObject({ period: '2026-09', periodStatus: 'hard_close' });
    expect((await auditRows(p.id))[0].new_values).toMatchObject({ period_status: 'hard_close' });
    expect(await ledger()).toBe(ledgerBefore);
  }, 60_000);
});

describe('P8 · two completions at once', () => {
  it('exactly one writes; the other is refused', async () => {
    const p = await paid('spei', ['400.00', '64.00', '464.00'], '2026-04-15');
    const outcomes = await Promise.allSettled([
      complete(p.id, { toAccount: '002180001122334455' }),
      complete(p.id, { toAccount: '002180009999999999' }),
    ]);
    const won = outcomes.filter((o) => o.status === 'fulfilled');
    const lost = outcomes.filter((o): o is PromiseRejectedResult => o.status === 'rejected');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(AppError);
    expect(await auditRows(p.id)).toHaveLength(1);
  }, 60_000);
});

describe('P9 · refusals write nothing', () => {
  it.each<[string, VendorTraceFields, string, RegExp]>([
    ['a cheque number on a SPEI', { checkNumber: '000123' }, 'x', /cheque number/],
    ['a national and a foreign bank at once', { toAccount: TO_ACCOUNT, toBank: '002', toForeignBank: 'Bank of Nowhere' }, 'x', /national destination bank .* and a foreign one/],
    ['a bank with no account stored or given', { toBank: '002' }, 'x', /the destination account was not/],
    ['a bank code of two digits', { toAccount: TO_ACCOUNT, toBank: '12' }, 'x', /has 2 characters/],
    ['no trace field', {}, 'x', /--to-account/],
    ['no reason', { toAccount: TO_ACCOUNT }, ' ', /--reason/],
  ])('%s', async (_case, fields, reason, message) => {
    const p = await paid('spei', ['50.00', '8.00', '58.00'], '2026-05-15');
    const before = await traceOf(p.id);
    const e = await complete(p.id, fields, reason).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as Error).message).toMatch(message);
    expect(await traceOf(p.id)).toEqual(before);
    expect(await auditRows(p.id)).toEqual([]);
  }, 60_000);

  it('a void payment', async () => {
    const p = await paid('spei', ['50.00', '8.00', '58.00'], '2026-05-16');
    await query(`UPDATE vendor_payments SET status = 'void' WHERE id = $1`, [p.id]);
    const e = await complete(p.id, { toAccount: TO_ACCOUNT }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as Error).message).toContain('"void"');
    expect((await traceOf(p.id)).cuenta_destino).toBeNull();
    expect(await auditRows(p.id)).toEqual([]);
  }, 60_000);
});
