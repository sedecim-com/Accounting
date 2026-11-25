import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice, voidInvoice, listInvoices } from '../../src/services/ar/invoice-service.js';
import { createCreditNote, issueCreditNote, applyCreditNote } from '../../src/services/ar/credit-note-service.js';
import { recordCustomerPayment, reverseCustomerPayment } from '../../src/services/payments/payment-service.js';
import { exigirPar, fijarTipo } from '../../src/services/fx/rate-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { getAgedReceivables } from '../../src/services/reporting/report-service.js';
import reportsRouter from '../../src/api/rest/routes/reports.js';
import { buildReportTools } from '../../src/ai/tools/report-tools.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { Invoice } from '../../src/types/index.js';

/**
 * MNE-001-648 (#596) · THE AGED RECEIVABLES AS OF A DATE SHOW WHAT WAS OWED
 * THAT DAY.
 *
 * An entity in pesos, USD at 17.50. Every invoice is dated 10 Aug and due
 * 25 Aug unless it says otherwise; the cutoff is 31 Aug; «today» is the day
 * the spec runs, after every event.
 *
 *   invoice      total        what happened                    owed 31 Aug   owed today
 *   paidAfter    MXN 10 000   collected in full on 5 Sep       10 000        —
 *   partly       MXN  8 000   3 000 on 20 Aug, 5 000 on 10 Sep  5 000        —
 *   dollars      USD  1 000   USD 400 collected on 5 Sep       USD 1 000     USD 600
 *   bounced      MXN  6 000   collected 20 Aug, reversed today  —            6 000
 *   credited     MXN  4 000   credit note applied today         4 000        —
 *   cashSale     MXN  3 000   born paid: never a receivable     —            —
 *   voided       MXN  2 500   voided today                      2 500        —
 *   later        MXN  1 200   dated 3 Sep                       —            1 200
 *
 * 31 Aug: MXN 10 000 + 5 000 + 4 000 + 2 500 = 21 500 in four documents;
 * USD 1 000 × 17.50 = 17 500; book value 39 000.
 * Today: MXN 6 000 + 1 200 = 7 200; USD 600 × 17.50 = 10 500; book 17 700.
 *
 * Before this task the listing «as of 31 Aug» printed today's balances
 * with August's ageing: paidAfter was not in it at all.
 */

const DOC = '2026-08-10';
const DUE = '2026-08-25';
const CUTOFF = '2026-08-31';

let f: Fixture;
let ctx: AgentContext;
let customerId: string;
let today: string;
const inv: Record<string, Invoice> = {};

apartarCatalogos('exchange_rates');

async function issued(amount: string, currency = 'MXN', date = DOC): Promise<Invoice> {
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: customerId, invoice_date: date, due_date: date === DOC ? DUE : date,
    currency_code: currency,
    lines: [{ revenue_account_id: f.cuentas['4100'], description: 'Service', quantity: '1', unit_price: amount, tax_rate: '0' }],
    created_by: f.userId,
  });
  return (await issueInvoice(draft.id, f.userId, { entityId: f.entityId })).invoice;
}

async function collect(invoice: Invoice, amount: string, date: string, currency = 'MXN'): Promise<string> {
  const r = await recordCustomerPayment(
    {
      entityId: f.entityId, counterpartyId: customerId, paymentAmount: amount, paymentDate: date,
      paymentMethod: 'spei', applications: [{ documentId: invoice.id, amountApplied: amount }],
      ...(currency === 'MXN' ? {} : { currencyCode: currency, exchangeRate: '17.5000' }),
    },
    f.userId
  );
  return r.paymentId;
}

/** invoice number → [currency, amount due, book value, days overdue]. */
function byNumber(rows: Array<{ invoice_number: string; currency_code: string; amount_due: string; book_amount_due: string; days_overdue: number }>) {
  return Object.fromEntries(rows.map((r) => [r.invoice_number, [r.currency_code, r.amount_due, r.book_amount_due, r.days_overdue]]));
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-648 aged receivables as of');
  ctx = {
    entityId: f.entityId, entityName: 'MNE-001-648', tenantId: f.tenantId,
    currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'XAXX010101000',
  };
  await seedPolicies({ tenantId: f.tenantId });
  await fijarTipo({ par: exigirPar('USD/MXN'), fecha: DOC, tasa: '17.5000', fuente: 'dof', creadoPor: f.userId });
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-648-001', 'Synthetic Customer SA', 'MXN', $3)`,
    [customerId, f.entityId, f.userId]
  );
  today = (await query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;

  inv.paidAfter = await issued('10000.00');
  await collect(inv.paidAfter, '10000.00', '2026-09-05');

  inv.partly = await issued('8000.00');
  await collect(inv.partly, '3000.00', '2026-08-20');
  await collect(inv.partly, '5000.00', '2026-09-10');

  inv.dollars = await issued('1000.00', 'USD');
  await collect(inv.dollars, '400.00', '2026-09-05', 'USD');

  inv.bounced = await issued('6000.00');
  await reverseCustomerPayment(f.entityId, await collect(inv.bounced, '6000.00', '2026-08-20'), { reason: 'NSF' }, f.userId);

  inv.credited = await issued('4000.00');
  const note = await createCreditNote(
    { entity_id: f.entityId, invoice_id: inv.credited.id, type: 'devolucion', subtotal: '4000.00', tax_amount: '0.00' },
    f.userId
  );
  await issueCreditNote(f.entityId, note.id, f.userId);
  await applyCreditNote(f.entityId, note.id, [{ invoiceId: inv.credited.id, amount: '4000.00' }], f.userId);

  // As `issued-invoice-approval.ts` writes a sale collected on the spot: paid
  // at birth, with no collection row and an entry that never touched receivables.
  const cashSaleId = uuidv4();
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
       amount_due, amount_paid, currency_code, exchange_rate, invoice_date, due_date, status, created_by)
     VALUES ($1,$2,'INV-648-CASH',$3,3000,0,3000,0,3000,'MXN',1,$4,$4,'paid',$5)`,
    [cashSaleId, f.entityId, customerId, DOC, f.userId]
  );
  inv.cashSale = { id: cashSaleId, invoice_number: 'INV-648-CASH' } as Invoice;

  inv.voided = await issued('2500.00');
  await voidInvoice(inv.voided.id, f.userId, { entityId: f.entityId, reason: 'synthetic' });

  inv.later = await issued('1200.00', 'MXN', '2026-09-03');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('MNE-001-648 · aged receivables as of the cutoff', () => {
  it('an invoice collected after the cutoff is listed with what was due that day', async () => {
    const aging = await getAgedReceivables(f.entityId, { asOfDate: CUTOFF, order: 'overdue', reconstruct: true });
    const rows = byNumber(aging.rows);
    expect(rows[inv.paidAfter.invoice_number]).toEqual(['MXN', '10000.0000', '10000.0000', 6]);
    expect(aging.balance_basis).toBe('as_of_date');
  });

  it('every document reads what it owed on 31 Aug, aged against 31 Aug, and nothing else is listed', async () => {
    const aging = await getAgedReceivables(f.entityId, { asOfDate: CUTOFF, order: 'overdue', reconstruct: true });
    expect(byNumber(aging.rows)).toEqual({
      [inv.paidAfter.invoice_number]: ['MXN', '10000.0000', '10000.0000', 6],
      [inv.partly.invoice_number]: ['MXN', '5000.0000', '5000.0000', 6],
      [inv.dollars.invoice_number]: ['USD', '1000.0000', '17500.0000', 6],
      [inv.credited.invoice_number]: ['MXN', '4000.0000', '4000.0000', 6],
      [inv.voided.invoice_number]: ['MXN', '2500.0000', '2500.0000', 6],
    });
    expect(aging.totals_by_currency).toEqual([
      { currency_code: 'MXN', documents: 4, amount_due: '21500.0000', book_amount_due: '21500.0000' },
      { currency_code: 'USD', documents: 1, amount_due: '1000.0000', book_amount_due: '17500.0000' },
    ]);
    expect(aging.total_book_amount_due).toBe('39000.0000');
  });

  it('as of today it is the maintained balances, document by document', async () => {
    const dated = await getAgedReceivables(f.entityId, { asOfDate: today, order: 'overdue', reconstruct: true });
    const current = await getAgedReceivables(f.entityId, { asOfDate: today, order: 'overdue' });
    expect(current.balance_basis).toBe('current');
    expect(byNumber(dated.rows)).toEqual(byNumber(current.rows));
    expect(Object.keys(byNumber(dated.rows)).sort()).toEqual(
      [inv.dollars.invoice_number, inv.bounced.invoice_number, inv.later.invoice_number].sort()
    );
    expect(byNumber(dated.rows)[inv.dollars.invoice_number].slice(0, 3)).toEqual(['USD', '600.0000', '10500.0000']);
    expect(dated.total_book_amount_due).toBe('17700.0000');
  });

  it('a sale collected on the spot owed nothing on any date, at any door that reads a date', async () => {
    const { rows } = await listInvoices(f.entityId, { customerId, asOf: CUTOFF, withAging: true });
    const cash = (rows as unknown as Array<{ invoice_number: string; amount_due_as_of: string }>).find(
      (r) => r.invoice_number === inv.cashSale.invoice_number
    );
    expect(cash?.amount_due_as_of).toBe('0.0000');
  });
});

describe('MNE-001-648 · the same reading over REST and for the agent', () => {
  it('GET /v1/reports/aged-receivables with as_of_date reads that day; without it, today', async () => {
    const s = await levantar([['/v1/reports', reportsRouter]], sesionDe(f));
    try {
      interface Published { balance_basis: string; total_book_amount_due: string; invoices: Array<{ invoice_number: string; amount_due: string }> }
      const dated = (await pedir(s, 'GET', `/v1/reports/aged-receivables?entity_id=${f.entityId}&as_of_date=${CUTOFF}`)).body.data as Published;
      expect(dated.total_book_amount_due).toBe('39000.0000');
      expect(dated.invoices.find((i) => i.invoice_number === inv.paidAfter.invoice_number)?.amount_due).toBe('10000.0000');
      expect(dated.balance_basis).toBe('as_of_date');

      const current = (await pedir(s, 'GET', `/v1/reports/aged-receivables?entity_id=${f.entityId}`)).body.data as Published;
      expect(current.balance_basis).toBe('current');
      expect(current.total_book_amount_due).toBe('17700.0000');

      // Payables still read today's balances under a date, and say so (MNE-001-649).
      const payables = await pedir(s, 'GET', `/v1/reports/aged-payables?entity_id=${f.entityId}&as_of_date=${CUTOFF}`);
      expect((payables.body.data as { balance_basis: string }).balance_basis).toBe('current');
    } finally {
      await s.cerrar();
    }
  });

  it("the agent's get_aged_receivables with as_of_date: 39 000 in the books that day, and it says which balances it read", async () => {
    const tool = buildReportTools(ctx).find((t) => t.name === 'get_aged_receivables') as unknown as {
      run: (input: { as_of_date?: string }) => Promise<string>;
    };
    const dated = await tool.run({ as_of_date: CUTOFF });
    expect(dated).toContain('"total_due":"39000.00"');
    expect(dated).toContain(inv.paidAfter.invoice_number);
    expect(dated).toContain('"balance_basis":"as_of_date"');
    const current = await tool.run({});
    expect(current).toContain('"balance_basis":"current"');
    expect(current).toContain('"total_due":"17700.00"');
    const payables = buildReportTools(ctx).find((t) => t.name === 'get_aged_payables') as unknown as typeof tool;
    expect(await payables.run({ as_of_date: CUTOFF })).toContain('"balance_basis":"current"');
  });
});
