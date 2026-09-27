import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { entityScope } from '../../src/database/scope.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createInvoice, issueInvoice, voidInvoice, listInvoices } from '../../src/services/ar/invoice-service.js';
import { createCreditNote, issueCreditNote, applyCreditNote } from '../../src/services/ar/credit-note-service.js';
import {
  recordCustomerPayment,
  unapplyCustomerPayment,
  reverseCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { getCustomerById } from '../../src/services/ar/customer-service.js';
import type { Invoice } from '../../src/types/index.js';

/**
 * MNE-001-034 (#94): the balance "as of" a date must match the maintained
 * balance when the date is today. Three events move `amount_due` without a
 * live cash allocation behind them — a full credit note, an NSF reversal and
 * an unapplication — and the reconstruction used to miss all three. Every
 * figure is synthetic.
 */

const DOC_DATE = '2026-08-15';
/** After the documents and payments, before every event this spec runs today. */
const BEFORE_EVENTS = '2026-08-20';

let f: Fixture;
let customerId: string;
let today: string;
let credited: Invoice; // 100,000 fully credited by a CFDI de egreso
let bounced: Invoice; // 50,000 paid by a cheque that bounced (NSF)
let unapplied: Invoice; // 30,000 whose payment was unapplied
let draft: Invoice;
let voided: Invoice;

async function draftInvoice(amount: string): Promise<Invoice> {
  return createInvoice({
    entity_id: f.entityId,
    customer_id: customerId,
    invoice_date: DOC_DATE,
    due_date: DOC_DATE,
    currency_code: 'MXN',
    lines: [
      { revenue_account_id: f.cuentas['4100'], description: 'Service', quantity: '1', unit_price: amount, tax_rate: '0' },
    ],
    created_by: f.userId,
  });
}

async function issuedInvoice(amount: string): Promise<Invoice> {
  const d = await draftInvoice(amount);
  return (await issueInvoice(d.id, f.userId, { entityId: f.entityId })).invoice;
}

async function pay(invoice: Invoice, amount: string): Promise<string> {
  const r = await recordCustomerPayment(
    {
      entityId: f.entityId,
      counterpartyId: customerId,
      paymentAmount: amount,
      paymentDate: DOC_DATE,
      paymentMethod: 'spei',
      applications: [{ documentId: invoice.id, amountApplied: amount }],
      onAccount: true,
    },
    f.userId
  );
  return r.paymentId;
}

async function show(asOf?: string) {
  const card = await getCustomerById(customerId, entityScope(f.tenantId, f.entityId), {
    withBalance: true,
    includeDocuments: true,
    asOf,
  });
  const docs = (card!.open_invoices as Array<{ invoice_number: string; amount_due: string }>) ?? [];
  return {
    balance: Number(card!.open_balance),
    pastDue: Number(card!.overdue_balance),
    docs: Object.fromEntries(docs.map((d) => [d.invoice_number, Number(d.amount_due)])),
  };
}

async function listAsOf(asOf: string, dateBasis: 'posting' | 'document') {
  const { rows } = await listInvoices(f.entityId, { customerId, asOf, dateBasis, withAging: true });
  return Object.fromEntries(
    rows.map((r) => [r.invoice_number, Number((r as unknown as { amount_due_as_of: string }).amount_due_as_of)])
  );
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-034 amount due as of');
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-034-001', 'Synthetic Customer SA', 'MXN', $3)`,
    [customerId, f.entityId, f.userId]
  );
  today = (await query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;

  credited = await issuedInvoice('100000.00');
  const note = await createCreditNote(
    { entity_id: f.entityId, invoice_id: credited.id, type: 'devolucion', subtotal: '100000.00', tax_amount: '0.00' },
    f.userId
  );
  await issueCreditNote(f.entityId, note.id, f.userId);
  await applyCreditNote(f.entityId, note.id, [{ invoiceId: credited.id, amount: '100000.00' }], f.userId);

  bounced = await issuedInvoice('50000.00');
  await reverseCustomerPayment(f.entityId, await pay(bounced, '50000.00'), { reason: 'NSF' }, f.userId);

  unapplied = await issuedInvoice('30000.00');
  await unapplyCustomerPayment(
    f.entityId, await pay(unapplied, '30000.00'), { invoiceId: unapplied.id, reason: 'wrong invoice' }, f.userId
  );

  draft = await draftInvoice('7000.00');
  voided = await issuedInvoice('9000.00');
  await voidInvoice(voided.id, f.userId, { entityId: f.entityId, reason: 'synthetic' });
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('customer show: --as-of today equals the maintained balance', () => {
  it('without --as-of: the credited invoice is settled, the bounced and unapplied ones are owed', async () => {
    const now = await show();
    expect(now.balance).toBeCloseTo(80000);
    expect(now.docs).toEqual({ [bounced.invoice_number]: 50000, [unapplied.invoice_number]: 30000 });
  });

  it('with --as-of today: the same 80,000, document by document', async () => {
    const dated = await show(today);
    // Before the fix: 100,000 — the credit note was ignored and the bounced
    // and unapplied cash still counted.
    expect(dated.balance).toBeCloseTo(80000);
    expect(dated.pastDue).toBeCloseTo(80000);
    expect(dated.docs).toEqual({ [bounced.invoice_number]: 50000, [unapplied.invoice_number]: 30000 });
  });

  it('before the bounce and the unapplication, that cash still settled; the note was not applied yet', async () => {
    // Guards the dating, not the defect: a fix that just dropped closed
    // allocations or reversed payments would wrongly reopen these here. The
    // credit note is dated by its application's created_at (today).
    const dated = await show(BEFORE_EVENTS);
    expect(dated.docs).toEqual({ [credited.invoice_number]: 100000 });
  });
});

describe('invoice list --as-of: same figure, same documents', () => {
  it('amount_due_as_of at today equals amount_due for every listed invoice', async () => {
    const dated = await listAsOf(today, 'posting');
    expect(dated).toEqual({
      [credited.invoice_number]: 0,
      [bounced.invoice_number]: 50000,
      [unapplied.invoice_number]: 30000,
    });
  });

  it('never lists draft, void or cancelled documents, on either date basis', async () => {
    for (const basis of ['posting', 'document'] as const) {
      const dated = await listAsOf(today, basis);
      expect(Object.keys(dated)).not.toContain(draft.invoice_number);
      expect(Object.keys(dated)).not.toContain(voided.invoice_number);
    }
  });

  it('agrees with customer show before the events', async () => {
    const dated = await listAsOf(BEFORE_EVENTS, 'document');
    expect(dated).toEqual({
      [credited.invoice_number]: 100000,
      [bounced.invoice_number]: 0,
      [unapplied.invoice_number]: 0,
    });
  });
});
