import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe } from './helpers/servidor.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { issueInvoice } from '../../src/services/ar/invoice-service.js';
import { exigirPar, fijarTipo } from '../../src/services/fx/rate-service.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { getAgedPayables, getAgedReceivables } from '../../src/services/reporting/report-service.js';
import { arReconcile } from '../../src/services/ar/ar-controls.js';
import { apReconcile } from '../../src/services/ap/ap-controls.js';
import reportsRouter from '../../src/api/rest/routes/reports.js';
import { buildReportTools } from '../../src/ai/tools/report-tools.js';
import type { AgentContext } from '../../src/ai/context.js';

/**
 * MNE-001-647 (#596) · THE AGING IS BY CURRENCY, WITH THE BOOK VALUE IN THE
 * FUNCTIONAL CURRENCY.
 *
 * An entity in pesos, USD at 17.50 on the day of the documents:
 *
 *   invoice A  MXN 2 400            book 2 400
 *   invoice B  USD 1 000 × 17.50    book 17 500     receivables: 19 900
 *   bill C     MXN 800              book 800
 *   bill D     USD 500 × 17.50      book 8 750      payables: 9 550
 *
 * Before this task the listing carried no currency and its one total added
 * the raw balances: 2 400 + 1 000 = 3 400 and 800 + 500 = 1 300.
 */

let f: Fixture;
let ctx: AgentContext;
const DAY = '2026-08-20';
const AS_OF = '2026-08-31';

apartarCatalogos('exchange_rates');

async function invoice(currency: string, amount: number, name: string): Promise<void> {
  const tag = uuidv4().slice(0, 8);
  const customerId = uuidv4();
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,$4,'XEXX010101000','rfc',$5,$6)`,
    [customerId, f.entityId, `C-${tag}`, name, currency, f.userId]
  );
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
       amount_due, currency_code, exchange_rate, invoice_date, due_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,0,$5,$5,$6,1,$7,$7,'draft',$8)`,
    [id, f.entityId, `INV-647-${tag}`, customerId, amount, currency, DAY, f.userId]
  );
  await query(
    `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price,
       revenue_account_id, tax_amount, line_amount, total_amount)
     VALUES ($1,$2,1,'Servicio',1,$3,$4,0,$3,$3)`,
    [uuidv4(), id, amount, f.cuentas['4100']]
  );
  await issueInvoice(id, f.userId, { entityId: f.entityId });
}

async function bill(currency: string, amount: number, rate: number, name: string): Promise<void> {
  const tag = uuidv4().slice(0, 8);
  const vendorId = uuidv4();
  const id = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,$4,'CCC030303CC3','rfc',$5,$6)`,
    [vendorId, f.entityId, `V-${tag}`, name, currency, f.userId]
  );
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
       total_amount, amount_due, amount_paid, currency_code, exchange_rate, bill_date, due_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,0,$6,$6,0,$7,$8,$9,$9,'draft',$10)`,
    [id, f.entityId, `BILL-647-${tag}`, vendorId, `F-${tag}`, amount, currency, rate, DAY, f.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio',1,$4,$4,0,$4)`,
    [uuidv4(), id, f.cuentas['6100'], amount]
  );
  await approveBill(id, f.userId, { entityId: f.entityId });
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-647 aging by currency');
  ctx = {
    entityId: f.entityId, entityName: 'MNE-001-647', tenantId: f.tenantId,
    currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'XAXX010101000',
  };
  await seedPolicies({ tenantId: f.tenantId });
  await fijarTipo({ par: exigirPar('USD/MXN'), fecha: DAY, tasa: '17.5000', fuente: 'dof', creadoPor: f.userId });
  // Names in the order the «party» listing prints them.
  await invoice('MXN', 2400, 'Alfa en pesos');
  await invoice('USD', 1000, 'Beta en dolares');
  await bill('MXN', 800, 1, 'Gama en pesos');
  await bill('USD', 500, 17.5, 'Omega en dolares');
});

afterAll(async () => {
  await drainAttestations();
  await closeDatabase();
});

describe('MNE-001-647 · aged receivables with documents in MXN and USD', () => {
  it('no figure of the report adds dollars to pesos (the defect printed 2 400 + 1 000 = 3 400)', async () => {
    const aging = await getAgedReceivables(f.entityId, { asOfDate: AS_OF, order: 'party' });
    expect(JSON.stringify(aging)).not.toContain('3400');
  });

  it('each row carries its currency and its book value, and the totals come out per currency', async () => {
    const aging = await getAgedReceivables(f.entityId, { asOfDate: AS_OF, order: 'party' });
    expect(aging.rows.map((r) => [r.currency_code, r.amount_due, r.book_amount_due])).toEqual([
      ['MXN', '2400.0000', '2400.0000'],
      ['USD', '1000.0000', '17500.0000'],
    ]);
    expect(aging.totals_by_currency).toEqual([
      { currency_code: 'MXN', documents: 1, amount_due: '2400.0000', book_amount_due: '2400.0000' },
      { currency_code: 'USD', documents: 1, amount_due: '1000.0000', book_amount_due: '17500.0000' },
    ]);
    expect(aging.total_book_amount_due).toBe('19900.0000');
  });

  it('the sum of the book values is what ar reconcile weighs against the control, and it ties', async () => {
    const r = await arReconcile(f.entityId);
    expect(r.open_invoices).toBe('19900.00');
    expect(r.balanced).toBe(true);
  });

  it('the page does not change the totals', async () => {
    const aging = await getAgedReceivables(f.entityId, { asOfDate: AS_OF, order: 'party', limit: 1 });
    expect(aging.rows).toHaveLength(1);
    expect(aging.total).toBe(2);
    expect(aging.total_book_amount_due).toBe('19900.0000');
  });
});

describe('MNE-001-647 · aged payables with documents in MXN and USD', () => {
  it('no figure of the report adds dollars to pesos (the defect printed 800 + 500 = 1 300)', async () => {
    const aging = await getAgedPayables(f.entityId, { asOfDate: AS_OF, order: 'party' });
    expect(JSON.stringify(aging)).not.toContain('1300');
  });

  it('each row carries its currency and its book value, and the totals come out per currency', async () => {
    const aging = await getAgedPayables(f.entityId, { asOfDate: AS_OF, order: 'party' });
    expect(aging.rows.map((r) => [r.currency_code, r.amount_due, r.book_amount_due])).toEqual([
      ['MXN', '800.0000', '800.0000'],
      ['USD', '500.0000', '8750.0000'],
    ]);
    expect(aging.totals_by_currency).toEqual([
      { currency_code: 'MXN', documents: 1, amount_due: '800.0000', book_amount_due: '800.0000' },
      { currency_code: 'USD', documents: 1, amount_due: '500.0000', book_amount_due: '8750.0000' },
    ]);
    expect(aging.total_book_amount_due).toBe('9550.0000');
  });

  it('the sum of the book values is what ap reconcile weighs against the control, and it ties', async () => {
    const r = await apReconcile(f.entityId, { asOf: AS_OF });
    expect(r.subdiario).toBe('9550.00');
    expect(r.cuadra).toBe(true);
  });
});

describe('MNE-001-647 · the same columns over REST and for the agent', () => {
  it('GET /v1/reports/aged-receivables and aged-payables publish the currency, the book value and the totals', async () => {
    const s = await levantar([['/v1/reports', reportsRouter]], sesionDe(f));
    try {
      const ar = await pedir(s, 'GET', `/v1/reports/aged-receivables?entity_id=${f.entityId}&as_of_date=${AS_OF}`);
      expect(ar.status).toBe(200);
      const receivables = ar.body.data as {
        invoices: Array<{ currency_code: string; amount_due: string; book_amount_due: string }>;
        totals_by_currency: unknown[];
        total_book_amount_due: string;
      };
      expect(receivables.invoices.map((i) => [i.currency_code, i.amount_due, i.book_amount_due])).toEqual([
        ['MXN', '2400.0000', '2400.0000'],
        ['USD', '1000.0000', '17500.0000'],
      ]);
      expect(receivables.totals_by_currency).toHaveLength(2);
      expect(receivables.total_book_amount_due).toBe('19900.0000');

      const ap = await pedir(s, 'GET', `/v1/reports/aged-payables?entity_id=${f.entityId}&as_of_date=${AS_OF}`);
      const payables = ap.body.data as {
        bills: Array<{ currency_code: string; book_amount_due: string }>;
        total_book_amount_due: string;
      };
      expect(payables.bills.map((b) => [b.currency_code, b.book_amount_due])).toEqual([
        ['MXN', '800.0000'],
        ['USD', '8750.0000'],
      ]);
      expect(payables.total_book_amount_due).toBe('9550.0000');
    } finally {
      await s.cerrar();
    }
  });

  it("the agent's get_aged_receivables: total_due is the book value in the entity's currency, and the dollar row says USD", async () => {
    const tool = buildReportTools(ctx).find((t) => t.name === 'get_aged_receivables') as unknown as {
      run: (input: { as_of_date?: string }) => Promise<string>;
    };
    const out = await tool.run({ as_of_date: AS_OF });
    expect(out).toContain('"currency":"MXN"');
    expect(out).toContain('"total_due":"19900.00"');
    expect(out).toContain('"currency_code":"USD"');
    expect(out).toContain('"book_amount_due":"17500.00"');
    expect(out).not.toContain('3400');
  });

  it("the agent's get_aged_payables: the same", async () => {
    const tool = buildReportTools(ctx).find((t) => t.name === 'get_aged_payables') as unknown as {
      run: (input: { as_of_date?: string }) => Promise<string>;
    };
    const out = await tool.run({ as_of_date: AS_OF });
    expect(out).toContain('"total_due":"9550.00"');
    expect(out).toContain('"book_amount_due":"8750.00"');
    expect(out).not.toContain('1300');
  });
});
