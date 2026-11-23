import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment,
  unapplyCustomerPayment,
  listCustomerPayments,
  transferCustomerCredit,
} from '../../src/services/payments/payment-service.js';
import { completePaymentTrace, type ReceiptTraceFields } from '../../src/services/payments/payment-trace-service.js';
import { encrypt } from '../../src/utils/encryption.js';
import type { AppError } from '../../src/utils/errors.js';

// ============================================================
// MNE-001-594 (#695) · A TRANSFER OF CUSTOMER CREDIT HAS NO TRACE AND OWES NO REP.
//
// A transfer (MNE-001-498) is a customer_payments row whose method is
// 'balance_transfer', with no bank account, numbered TRF-AAAA-NNNNN, and its
// entry is DR 2150 / CR 2150: no money moved. So `receipt trace record` has
// nothing to complete on it (no cheque, no payer bank, no bank account of
// ours), and it is refused before anything is written, by its key, naming the
// transfer and its source. And `receipt list --needs-rep` leaves it out: a
// REP documents a payment received, and the transfer received none.
//
// Hand figures: A's PUE invoice of 1,000.00 + 160.00, collected whole by SPEI
// on 2026-05-20 and unapplied on 2026-05-25, so its receipt holds 1,160.00 on
// account; 1,160.00 of it moves to B on 2026-06-15 as TRF-2026-00001. Every
// party is synthetic.
// ============================================================

const CLABE = '012180001234567895';

let f: Fixture;
let customerA: string;
let customerB: string;
let operativaId: string;
let source: { id: string; number: string };
let trf: { id: string; number: string };

async function customer(number: string, name: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, $3, $4, 'MXN', $5)`,
    [id, f.entityId, number, name, f.userId]
  );
  return id;
}

async function refusal(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected a refusal');
}

/** The transfer row's trace, the entity's audit rows and its entries, counted: a refusal leaves them all. */
async function footprint(): Promise<unknown> {
  const row = (await query(
    `SELECT check_number, cuenta_origen, banco_origen_sat, banco_origen_extranjero, bank_account_id, updated_at
       FROM customer_payments WHERE id = $1`, [trf.id]
  )).rows[0];
  const audits = (await query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM audit_log WHERE legal_entity_id = $1', [f.entityId]
  )).rows[0].n;
  const entries = (await query<{ n: string }>(
    'SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1', [f.entityId]
  )).rows[0].n;
  return { row, audits, entries };
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-594 transfer trace');
  customerA = await customer('C-594-A', 'Cliente Cedente SA');
  customerB = await customer('C-594-B', 'Cliente Cesionario SA');
  operativaId = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id,
       currency_code, sat_bank_code, clabe_encrypted, clabe_last4, is_active)
     VALUES ($1, $2, 'Operativa BBVA', 'BBVA México', $3, 'MXN', '012', $4, $5, true)`,
    [operativaId, f.entityId, f.cuentas['1111'], encrypt(CLABE), CLABE.slice(-4)]
  );

  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: customerA, invoice_date: '2026-05-20', due_date: '2026-05-20',
    currency_code: 'MXN', terms: 'PUE',
    lines: [{
      revenue_account_id: f.roles.ingreso, description: 'Synthetic service',
      quantity: '1', unit_price: '1000.00', tax_rate: '16.0000',
    }],
    created_by: f.userId,
  });
  const s1 = (await issueInvoice(draft.id, f.userId, { entityId: f.entityId })).invoice.id;
  const r = await recordCustomerPayment(
    {
      entityId: f.entityId, counterpartyId: customerA, paymentAmount: '1160.00', paymentDate: '2026-05-20',
      paymentMethod: 'spei', applications: [{ documentId: s1, amountApplied: '1160.00' }],
    },
    f.userId
  );
  await unapplyCustomerPayment(
    f.entityId, r.paymentId, { invoiceId: s1, reason: 'applied to the wrong customer', date: '2026-05-25' }, f.userId
  );
  source = { id: r.paymentId, number: r.paymentNumber };
  const t = await transferCustomerCredit(
    f.entityId, source.id,
    { customerId: customerB, amount: '1160.00', date: '2026-06-15', reason: 'Convenio 15-jun' },
    f.userId
  );
  trf = { id: t.transferId, number: t.transferNumber };
  expect(trf.number).toBe('TRF-2026-00001');
}, 240_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('receipt trace record on a transfer row', () => {
  // The bank account's id is known only once beforeAll has run.
  const cases: [string, () => ReceiptTraceFields][] = [
    ['--bank', () => ({ bankAccountId: operativaId })],
    ['--check-number', () => ({ checkNumber: '0001234' })],
    ['--payer-bank and --payer-account', () => ({ payerBank: '012', payerAccount: '002180009876543210' })],
  ];

  for (const [flags, given] of cases) {
    it(`with ${flags} is refused before any write, by its key, naming TRF-2026-00001 and its source`, async () => {
      const fields = given();
      const before = await footprint();
      for (const dryRun of [true, false]) {
        const e = await refusal(completePaymentTrace(f.entityId, 'customer', trf.id, fields, 'CEP del cobro', f.userId, { dryRun }));
        expect(e.messageKey?.key).toBe('receipt.trace.balance_transfer');
        expect(e.messageKey?.params).toEqual({ number: trf.number, source: source.number });
        expect(e.statusCode).toBe(422);
        for (const language of ['en', 'es'] as const) {
          const text = e.localized(language);
          expect(text).toContain('TRF-2026-00001');
          expect(text).toContain(source.number);
        }
      }
      expect(await footprint()).toEqual(before);
    }, 60_000);
  }

  it('leaves the source receipt completable: its own --bank still links', async () => {
    const done = await completePaymentTrace(
      f.entityId, 'customer', source.id, { bankAccountId: operativaId }, 'CEP del cobro', f.userId, { dryRun: true }
    );
    expect(done.filled.map((x) => x.flag)).toEqual(['--bank']);
  }, 60_000);
});

describe('receipt list --needs-rep', () => {
  it('leaves the TRF row out and keeps its source, which was collected by SPEI and has no REP', async () => {
    const needsRep = (await listCustomerPayments(f.entityId, { needsRep: true })).rows.map((r) => r.payment_number);
    expect(needsRep).toContain(source.number);
    expect(needsRep).not.toContain('TRF-2026-00001');
  }, 60_000);

  it('still shows the TRF row everywhere else: in the plain list and under --unapplied, with its 1,160.00', async () => {
    const all = (await listCustomerPayments(f.entityId)).rows.map((r) => r.payment_number);
    expect(all).toContain('TRF-2026-00001');
    const unapplied = (await listCustomerPayments(f.entityId, { unapplied: true })).rows;
    expect(unapplied.find((r) => r.payment_number === 'TRF-2026-00001')?.unapplied_amount).toBe('1160.00');
  }, 60_000);
});
