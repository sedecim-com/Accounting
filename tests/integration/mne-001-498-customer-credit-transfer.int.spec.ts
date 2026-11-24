import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment,
  applyCustomerPayment,
  unapplyCustomerPayment,
  reverseCustomerPayment,
  getCustomerPayment,
  listCustomerPayments,
  transferCustomerCredit,
} from '../../src/services/payments/payment-service.js';
import { buildProvisionalIncomeTaxWorkpaper } from '../../src/services/fiscal/provisional-income-tax.js';
import { generarPolizas } from '../../src/services/sat/anexo24/polizas-service.js';
import { crearGrupoDeCotejo } from '../../src/services/banking/match-service.js';
import { entityScope } from '../../src/database/scope.js';
import { todayFor } from '../../src/services/policy/today.js';
import { AppError, NotFoundError } from '../../src/utils/errors.js';
import { validateAgainstOfficialXsd } from '../helpers/official-xsd.js';

// ============================================================
// MNE-001-498 (#695, part 1/2) · `receipt transfer record`, AGAINST POSTGRES.
//
// A customer's cash on account moves to another customer by an agreed,
// audited transfer: a credit row for B in customer_payments, linked to A's
// receipt, and its own entry dated on the agreed day, DR 2150 / CR 2150 with
// no bank, revenue or IVA line. Hand figures from the plan (comment
// 7027087081 on #695): A's invoice S1 is 1,000.00 + 160.00 at 16 % PUE,
// collected whole by SPEI on 2026-05-20 and unapplied on 2026-05-25, so its
// receipt holds 1,160.00 on account with no advance treatment. Every party
// is synthetic.
// ============================================================

const REASON = 'Convenio 15-jun';
const DAY = '2026-06-15';
const REQUEST = { tipo: 'AF' as const, numOrden: 'ABC1234567/26' };

let f: Fixture;
let sister: Fixture;
let iso: Fixture;
let us: Fixture;
let customerA: string;
let customerB: string;
let sisterCustomer: string;
let isoA: string;
let isoB: string;

async function customer(fx: Fixture, number: string, name: string, currency = 'MXN'): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, fx.entityId, number, name, currency, fx.userId]
  );
  return id;
}

/** An issued PUE invoice of 1,000.00 + 160.00 to `customerId`, dated `date`. */
async function invoice(fx: Fixture, customerId: string, date: string, terms: 'PUE' | 'PPD' = 'PUE'): Promise<string> {
  const draft = await createInvoice({
    entity_id: fx.entityId, customer_id: customerId, invoice_date: date, due_date: date,
    currency_code: 'MXN', terms,
    lines: [{
      revenue_account_id: fx.roles.ingreso, description: 'Synthetic service',
      quantity: '1', unit_price: '1000.00', tax_rate: '16.0000',
    }],
    created_by: fx.userId,
  });
  return (await issueInvoice(draft.id, fx.userId, { entityId: fx.entityId })).invoice.id;
}

/** The plan's setup: S1 collected whole by SPEI on 05-20 and unapplied on 05-25, 1,160.00 back on account. */
async function unappliedReceipt(fx: Fixture, customerId: string): Promise<{ id: string; number: string }> {
  const s1 = await invoice(fx, customerId, '2026-05-20');
  const r = await recordCustomerPayment(
    {
      entityId: fx.entityId, counterpartyId: customerId, paymentAmount: '1160.00', paymentDate: '2026-05-20',
      paymentMethod: 'spei', applications: [{ documentId: s1, amountApplied: '1160.00' }],
    },
    fx.userId
  );
  await unapplyCustomerPayment(
    fx.entityId, r.paymentId, { invoiceId: s1, reason: 'applied to the wrong customer', date: '2026-05-25' }, fx.userId
  );
  return { id: r.paymentId, number: r.paymentNumber };
}

const transfer = (
  fx: Fixture,
  sourceId: string,
  over: Partial<{ customerId: string; amount: string; date: string; reason: string }> = {},
  dryRun = false
) =>
  transferCustomerCredit(
    fx.entityId, sourceId,
    { customerId: customerB, amount: '1160.00', date: DAY, reason: REASON, ...over },
    fx.userId, { dryRun }
  );

async function refusal(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a refusal');
}

/** Every row that a transfer writes, counted: the receipts, the entries, the audit rows and the TRF series. */
async function footprint(fx: Fixture): Promise<Record<string, number>> {
  const one = async (sql: string) => Number((await query<{ n: string }>(sql, [fx.entityId])).rows[0].n);
  return {
    receipts: await one(`SELECT COUNT(*)::text AS n FROM customer_payments WHERE entity_id = $1`),
    entries: await one(`SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1`),
    audits: await one(`SELECT COUNT(*)::text AS n FROM audit_log WHERE legal_entity_id = $1`),
    series: await one(`SELECT COUNT(*)::text AS n FROM entity_sequences WHERE entity_id = $1 AND name LIKE 'customer_balance_transfer%'`),
  };
}

async function linesOf(entryId: string): Promise<{ account: string; debit: string; credit: string }[]> {
  const r = await query<{ account: string; debit: string; credit: string }>(
    `SELECT a.id AS account, COALESCE(l.debit_amount, 0)::text AS debit, COALESCE(l.credit_amount, 0)::text AS credit
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.journal_entry_id = $1 ORDER BY l.line_number`,
    [entryId]
  );
  return r.rows;
}

const onAccountOf = async (fx: Fixture, ref: string) => (await getCustomerPayment(fx.entityId, ref)).unapplied_amount;

beforeAll(async () => {
  f = await crearInquilino('MNE-001-498 transfer');
  sister = await crearEntidadHermana(f, 'MNE-001-498 sister');
  iso = await crearInquilino('MNE-001-498 isolated month');
  us = await crearInquilino('MNE-001-498 US', { pais: 'US' });
  await query(`UPDATE legal_entities SET name = 'Entidad de Prueba SA', tax_id = 'EPR010101AB1' WHERE id = $1`, [iso.entityId]);
  customerA = await customer(f, 'C-498-A', 'Cliente Cedente SA');
  customerB = await customer(f, 'C-498-B', 'Cliente Cesionario SA');
  sisterCustomer = await customer(sister, 'C-498-S', 'Cliente Hermano SA');
  isoA = await customer(iso, 'C-498-IA', 'Cedente Aislado SA');
  isoB = await customer(iso, 'C-498-IB', 'Cesionario Aislado SA');
}, 240_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('T1-T2 · PMT-1 with 1,160.00 on account moves whole to B on 06-15', () => {
  let source: { id: string; number: string };
  let trf: Awaited<ReturnType<typeof transferCustomerCredit>>;

  beforeAll(async () => {
    source = await unappliedReceipt(f, customerA);
  }, 120_000);

  it('T1 · the dry run shows DR 2150 / CR 2150 1,160.00 and both balances, and leaves nothing behind', async () => {
    expect(await onAccountOf(f, source.id)).toBe('1160.00');
    const before = await footprint(f);
    const r = await transfer(f, source.id, {}, true);
    expect(r.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['2150', '1160.00', '0.00'],
      ['2150', '0.00', '1160.00'],
    ]);
    expect(r.sourceOnAccount).toEqual({ before: '1160.00', after: '0.00' });
    expect(r.customerOnAccount).toEqual({ before: '0.00', after: '1160.00' });
    expect(r.date).toBe(DAY);
    expect(await footprint(f)).toEqual(before);
    expect(await onAccountOf(f, source.id)).toBe('1160.00');
  }, 120_000);

  it('T2 · with --yes: TRF-2026-00001 for B, its 06-15 entry with two 2150 lines and nothing else, and one audit row', async () => {
    trf = await transfer(f, source.id);
    expect(trf.transferNumber).toBe('TRF-2026-00001');
    expect(trf.sourceNumber).toBe(source.number);

    const row = (await query<Record<string, unknown>>(
      `SELECT customer_id, payment_amount::text AS amount, payment_method, transferred_from_payment_id,
              transfer_reason, bank_account_id, to_char(payment_date, 'YYYY-MM-DD') AS date, status, currency_code
         FROM customer_payments WHERE id = $1`, [trf.transferId]
    )).rows[0];
    expect(row).toEqual({
      customer_id: customerB, amount: '1160.0000', payment_method: 'balance_transfer',
      transferred_from_payment_id: source.id, transfer_reason: REASON, bank_account_id: null,
      date: DAY, status: 'completed', currency_code: 'MXN',
    });

    const entry = (await query<{ id: string; date: string; source_type: string; source_id: string; status: string }>(
      `SELECT je.id, to_char(je.entry_date, 'YYYY-MM-DD') AS date, je.source_type, je.source_id, je.status
         FROM journal_entries je JOIN customer_payments cp ON cp.journal_entry_id = je.id
        WHERE cp.id = $1`, [trf.transferId]
    )).rows[0];
    expect(entry).toMatchObject({ date: DAY, source_type: 'customer_credit_transfer', source_id: trf.transferId, status: 'posted' });
    expect(await linesOf(entry.id)).toEqual([
      { account: f.roles.anticipo_clientes, debit: '1160.0000', credit: '0' },
      { account: f.roles.anticipo_clientes, debit: '0', credit: '1160.0000' },
    ]);
    expect(f.roles.anticipo_clientes).toBe(f.cuentas['2150']);

    expect(await onAccountOf(f, source.id)).toBe('0.00');
    expect(await onAccountOf(f, trf.transferId)).toBe('1160.00');

    const audits = (await query<{ action: string; new_values: Record<string, unknown>; reason: string }>(
      `SELECT action, new_values, reason FROM audit_log
        WHERE entity_type = 'customer_payments' AND entity_id = $1`, [trf.transferId]
    )).rows;
    expect(audits).toHaveLength(1);
    expect(audits[0].action).toBe('create');
    expect(audits[0].reason).toBe(REASON);
    expect(audits[0].new_values).toMatchObject({
      evento: 'transfer', transfer_number: 'TRF-2026-00001', source_number: source.number,
      from_customer: 'C-498-A Cliente Cedente SA', to_customer: 'C-498-B Cliente Cesionario SA',
      amount: '1160.00', date: DAY,
    });
  }, 120_000);

  it('T7 · A has nothing left to apply and cannot be reversed while the transfer lives (its events: MNE-001-499\'s spec)', async () => {
    const invoiceA = await invoice(f, customerA, '2026-06-16');
    const apply = await refusal(
      applyCustomerPayment(f.entityId, source.id, [{ documentId: invoiceA, amountApplied: '1160.00' }], f.userId, { date: '2026-06-16' })
    );
    expect(apply.message).toContain('no alcanza');

    const reverse = await refusal(reverseCustomerPayment(f.entityId, source.id, { reason: 'bounced', cause: 'taken_back' }, f.userId));
    expect(reverse.messageKey?.key).toBe('receipt.reverse.has_transfer');
    expect(reverse.message).toContain('TRF-2026-00001');

    expect(await onAccountOf(f, source.id)).toBe('0.00');
    expect(await onAccountOf(f, trf.transferId)).toBe('1160.00');
  }, 120_000);

  it('T7 · the bank match does not offer the TRF row, which moved no money', async () => {
    const bankId = uuidv4();
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, is_active)
       VALUES ($1, $2, 'Operativa 498', 'Banco de prueba', $3, 'MXN', true)`,
      [bankId, f.entityId, f.roles.banco]
    );
    const txId = uuidv4();
    await query(
      `INSERT INTO bank_transactions (id, bank_account_id, transaction_date, amount, transaction_type, description, is_matched)
       VALUES ($1, $2, '2026-06-15'::date, 1160.0000, 'credit', 'deposito', false)`,
      [txId, bankId]
    );
    const e = await refusal(crearGrupoDeCotejo(
      entityScope(f.tenantId, f.entityId),
      { cuentaId: bankId, banco: [txId], libros: [{ tipo: 'customer_payment', id: trf.transferId }] },
      { userId: f.userId, dryRun: true }
    ));
    expect(e).toBeInstanceOf(NotFoundError);
    expect(e.message).toContain(trf.transferId);
  }, 120_000);
});

describe('T3 · partial transfers', () => {
  it('400.00 leaves 760.00, 800.00 is refused, 760.00 leaves 0.00, and the list no longer shows the receipt', async () => {
    const source = await unappliedReceipt(f, customerA);
    await transfer(f, source.id, { amount: '400.00' });
    expect(await onAccountOf(f, source.id)).toBe('760.00');

    const over = await refusal(transfer(f, source.id, { amount: '800.00' }));
    expect(over.messageKey?.key).toBe('receipt.transfer.exceeds_on_account');
    expect(over.message).toContain('760.00');

    // The source's events are dated from its transfers on: an apply on 06-10 would use cash given away on 06-15.
    const invoiceA = await invoice(f, customerA, '2026-06-01');
    const early = await refusal(
      applyCustomerPayment(f.entityId, source.id, [{ documentId: invoiceA, amountApplied: '100.00' }], f.userId, { date: '2026-06-10' })
    );
    expect(early.messageKey?.key).toBe('receipt.apply.date_before_last_event');
    expect(early.message).toContain(DAY);

    await transfer(f, source.id, { amount: '760.00' });
    expect(await onAccountOf(f, source.id)).toBe('0.00');

    const rows = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM customer_payments WHERE entity_id = $1 AND transferred_from_payment_id = $2`,
      [f.entityId, source.id]
    );
    expect(rows.rows[0].n).toBe('2');
    const listed = await listCustomerPayments(f.entityId, { unapplied: true, limit: 500 });
    expect(listed.rows.map((r) => r.payment_number)).not.toContain(source.number);
    expect(listed.rows.find((r) => r.id === source.id)).toBeUndefined();
  }, 180_000);
});

describe('T4-T5 · an isolated entity: the ISR workpaper and June\'s Anexo 24 vouchers', () => {
  let entry: string;

  beforeAll(async () => {
    const source = await unappliedReceipt(iso, isoA);
    const r = await transferCustomerCredit(
      iso.entityId, source.id, { customerId: isoB, amount: '1160.00', date: DAY, reason: REASON }, iso.userId
    );
    entry = r.journalEntry.entry_number;
  }, 120_000);

  it('T4 · ISR-WP-ADVANCES for 2026 reads 1,160.00, the unapply\'s credit, and not 2,320.00', async () => {
    const june = await buildProvisionalIncomeTaxWorkpaper({ tenantId: iso.tenantId, entityId: iso.entityId, year: 2026, month: 6 });
    expect(june.advancesCollected).toEqual([{ code: '2150', amount: '1160.0000' }]);
    expect(june.findings.map((h) => h.codigo)).toContain('ISR-WP-ADVANCES');
  }, 120_000);

  it('T5 · June\'s vouchers validate, and the transfer\'s carries no payment node and no finding', async () => {
    // The vouchers read the entity under the current tenant: the isolated entity's.
    enterTenant(iso.tenantId);
    const june = await generarPolizas(iso.entityId, { periodo: '2026-06', solicitud: REQUEST }).finally(() => enterTenant(f.tenantId));
    expect(validateAgainstOfficialXsd(june.xml, 'journal')).toEqual({ valid: true, errors: [] });
    const voucher = june.xml.split('<PLZ:Poliza ').find((block) => block.includes(`NumUnIdenPol="${entry}"`)) ?? '';
    expect(voucher).toContain('2150');
    for (const node of ['<PLZ:Cheque', '<PLZ:Transferencia', '<PLZ:OtrMetodoPago']) expect(voucher).not.toContain(node);
    expect(june.hallazgos.filter((h) => h.referencia === entry)).toEqual([]);
  }, 120_000);
});

describe('T6 · refused before any write, each by its key', () => {
  let source: { id: string; number: string };

  beforeAll(async () => {
    source = await unappliedReceipt(f, customerA);
  }, 120_000);

  const refusedWithNothingWritten = async (p: () => Promise<unknown>, fx: Fixture = f): Promise<AppError> => {
    const before = await footprint(fx);
    const e = await refusal(p());
    expect(await footprint(fx)).toEqual(before);
    return e;
  };
  const keyOf = async (p: () => Promise<unknown>) => (await refusedWithNothingWritten(p)).messageKey?.key;

  it('over the balance, to the same customer, or an amount that is not positive with at most 4 decimals', async () => {
    expect(await keyOf(() => transfer(f, source.id, { amount: '1160.01' }))).toBe('receipt.transfer.exceeds_on_account');
    expect(await keyOf(() => transfer(f, source.id, { customerId: customerA }))).toBe('receipt.transfer.same_customer');
    for (const amount of ['0', '-5.00', '1.00001', 'abc']) {
      expect(await keyOf(() => transfer(f, source.id, { amount }))).toBe('receipt.transfer.amount_invalid');
    }
  }, 120_000);

  it('another entity\'s customer is a 404', async () => {
    const e = await refusedWithNothingWritten(() => transfer(f, source.id, { customerId: sisterCustomer }));
    expect(e).toBeInstanceOf(NotFoundError);
    expect(e.statusCode).toBe(404);
  }, 120_000);

  it('no reason, a future date, or a date before the receipt\'s last event (the unapply of 05-25)', async () => {
    expect(await keyOf(() => transfer(f, source.id, { reason: '   ' }))).toBe('receipt.transfer.reason_required');
    const today = await todayFor({ tenantId: f.tenantId, entityId: f.entityId });
    const tomorrow = new Date(`${today}T12:00:00Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const future = await refusedWithNothingWritten(() => transfer(f, source.id, { date: tomorrow.toISOString().slice(0, 10) }));
    expect(future.messageKey?.key).toBe('receipt.transfer.date_future');
    const early = await refusedWithNothingWritten(() => transfer(f, source.id, { date: '2026-05-24' }));
    expect(early.messageKey?.key).toBe('receipt.transfer.date_before_last_event');
    expect(early.message).toContain('2026-05-25');
  }, 120_000);

  it('a hard-closed May is refused by posting itself', async () => {
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [f.periodos[5]]);
    try {
      await refusedWithNothingWritten(() => transfer(f, source.id, { date: '2026-05-28' }));
    } finally {
      await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [f.periodos[5]]);
    }
  }, 120_000);

  it('a receipt not in the functional currency, or not completed', async () => {
    const usd = await unappliedReceipt(f, customerA);
    await query(`UPDATE customer_payments SET currency_code = 'USD' WHERE id = $1`, [usd.id]);
    expect(await keyOf(() => transfer(f, usd.id))).toBe('receipt.transfer.not_functional_currency');

    const reversed = await unappliedReceipt(f, customerA);
    await reverseCustomerPayment(f.entityId, reversed.id, { reason: 'bounced', cause: 'taken_back' }, f.userId);
    const e = await refusedWithNothingWritten(() => transfer(f, reversed.id));
    expect(e.messageKey?.key).toBe('receipt.transfer.not_completed');
    expect(e.message).toContain('reversed');
  }, 180_000);

  it('cash an unapply put back keeping its IVA caused (MNE-001-574) cannot follow the credit, and is refused', async () => {
    const ppd = await invoice(f, customerA, '2026-05-20', 'PPD');
    const r = await recordCustomerPayment(
      {
        entityId: f.entityId, counterpartyId: customerA, paymentAmount: '1160.00', paymentDate: '2026-05-20',
        paymentMethod: 'spei', applications: [{ documentId: ppd, amountApplied: '1160.00' }],
      },
      f.userId
    );
    await unapplyCustomerPayment(
      f.entityId, r.paymentId, { invoiceId: ppd, reason: 'applied to the wrong customer', date: '2026-05-25' }, f.userId
    );
    const kept = await query<{ kept: string }>(
      'SELECT unapply_kept_iva_amount::text AS kept FROM payment_allocations WHERE payment_id = $1',
      [r.paymentId]
    );
    expect(kept.rows.map((x) => x.kept)).toEqual(['160.0000']);
    const e = await refusedWithNothingWritten(() => transfer(f, r.paymentId, { amount: '100.00' }));
    expect(e.messageKey?.key).toBe('receipt.transfer.kept_caused');
    expect(e.message).toContain(r.paymentNumber);
  }, 180_000);

  it('a cheque the bank has not cashed and a TRF row are refused (a treated advance moves: MNE-001-499\'s spec)', async () => {
    const check = await recordCustomerPayment(
      {
        entityId: f.entityId, counterpartyId: customerA, paymentAmount: '1160.00', paymentDate: '2026-05-20',
        paymentMethod: 'check', checkNumber: '4501', applications: [], onAccount: true,
      },
      f.userId
    );
    expect(await keyOf(() => transfer(f, check.paymentId))).toBe('receipt.transfer.cheque_not_cashed');

    const fresh = await unappliedReceipt(f, customerA);
    const trf = await transfer(f, fresh.id, { amount: '100.00' });
    const chained = await refusedWithNothingWritten(
      () => transferCustomerCredit(f.entityId, trf.transferId, { customerId: customerA, amount: '100.00', date: DAY, reason: REASON }, f.userId)
    );
    expect(chained.messageKey?.key).toBe('receipt.transfer.source_is_transfer');
  }, 180_000);

  it('an entity off Mexican books', async () => {
    const usCustomer = await customer(us, 'C-498-US', 'Synthetic Payer Inc', 'USD');
    const r = await recordCustomerPayment(
      {
        entityId: us.entityId, counterpartyId: usCustomer, paymentAmount: '100.00', paymentDate: '2026-05-20',
        paymentMethod: 'wire', applications: [], onAccount: true,
      },
      us.userId
    );
    const other = await customer(us, 'C-498-US2', 'Synthetic Assignee Inc', 'USD');
    const e = await refusedWithNothingWritten(
      () => transferCustomerCredit(us.entityId, r.paymentId, { customerId: other, amount: '100.00', date: DAY, reason: REASON }, us.userId),
      us
    );
    expect(e.messageKey?.key).toBe('receipt.transfer.not_mexican_books');
  }, 120_000);
});

describe('migration 339 · the CHECKs of a transfer row', () => {
  const insert = async (over: Record<string, unknown>) => {
    const source = (await query<{ id: string }>(
      `SELECT id FROM customer_payments WHERE entity_id = $1 AND payment_method = 'spei' LIMIT 1`, [f.entityId]
    )).rows[0].id;
    const id = (over.id as string | undefined) ?? uuidv4();
    const row = {
      method: 'balance_transfer', from: source, reason: 'agreed', bank: null, ...over,
    } as { method: string; from: string | null; reason: string | null; bank: string | null };
    return query(
      `INSERT INTO customer_payments (id, entity_id, payment_number, customer_id, payment_amount, currency_code,
         payment_method, bank_account_id, payment_date, status, created_by, transferred_from_payment_id, transfer_reason)
       VALUES ($1, $2, $3, $4, 1, 'MXN', $5, $6, '2026-06-15', 'completed', $7, $8, $9)`,
      [id, f.entityId, `TRF-X-${id.slice(0, 8)}`, customerB, row.method, row.bank, f.userId, row.from, row.reason]
    );
  };
  const violation = async (over: Record<string, unknown>) => (await refusal(insert(over)) as unknown as { code: string }).code;

  it('refuse a transfer with a bank account, without a reason, pointing at itself, or a source without the method', async () => {
    expect(await violation({ bank: uuidv4() })).toBe('23514');
    expect(await violation({ reason: null })).toBe('23514');
    expect(await violation({ reason: '  ' })).toBe('23514');
    const self = uuidv4();
    expect(await violation({ id: self, from: self })).toMatch(/^23(514|503)$/);
    expect(await violation({ from: null })).toBe('23514');
    expect(await violation({ method: 'spei' })).toBe('23514');
  });
});
