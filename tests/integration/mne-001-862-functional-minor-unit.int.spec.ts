import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations, postJournalEntry, reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { createDraftEntry } from '../../src/services/accounting/journal-entry-service.js';
import { softClosePeriod } from '../../src/services/accounting/period-close.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { arReconcile } from '../../src/services/ar/ar-controls.js';
import { issueInvoice } from '../../src/services/ar/invoice-service.js';
import { exigirPar, fijarTipo } from '../../src/services/fx/rate-service.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { generarBalanza } from '../../src/services/sat/anexo24/balanza-service.js';

/**
 * MNE-001-862 (#1066) · PESOS TO THE CENT, MEASURED AGAINST POSTGRES.
 *
 * The case of the standards review of 27 Nov 2026 (report 01, G01), by hand:
 *
 *   15 Jan  USD 33.35 × 17.1141 = 570.755235 → 570.76   (was 570.7552)
 *   10 Feb  USD  5.85 × 17.0950 = 100.005750 → 100.01   (was 100.0058)
 *
 * Both on the receivable: February declares 570.76 + 100.01 = 670.77. At four
 * decimals the ledger ended at 670.7610, the file declared 670.76 and the
 * rounding check refused it.
 *
 * And the cent, in March at 17.1141: USD 46.66 → 798.543906 → 798.54 and
 * USD 20.00 → 342.28 add up to 1 140.82; USD 66.66 → 1 140.825906 → 1 140.83.
 */

let f: Fixture;
const JAN = '2026-01-15';
const FEB = '2026-02-10';
const MAR = '2026-03-05';

apartarCatalogos('exchange_rates');

async function invoice(day: string, amounts: string[]): Promise<string> {
  const tag = uuidv4().slice(0, 8);
  const customerId = uuidv4();
  const id = uuidv4();
  const total = amounts.reduce((s, a) => s + Number(a), 0).toFixed(2);
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Cliente en dolares','XEXX010101000','rfc','USD',$4)`,
    [customerId, f.entityId, `C-${tag}`, f.userId]
  );
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
       amount_due, currency_code, exchange_rate, invoice_date, due_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,0,$5,$5,'USD',1,$6,$6,'draft',$7)`,
    [id, f.entityId, `INV-862-${tag}`, customerId, total, day, f.userId]
  );
  for (const [i, amount] of amounts.entries()) {
    await query(
      `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price,
         revenue_account_id, tax_amount, line_amount, total_amount)
       VALUES ($1,$2,$3,'Servicio',1,$4,$5,0,$4,$4)`,
      [uuidv4(), id, i + 1, amount, f.cuentas[i === 0 ? '4100' : '4200'] ?? f.cuentas['4100']]
    );
  }
  await issueInvoice(id, f.userId, { entityId: f.entityId });
  return id;
}

async function bill(day: string, amounts: string[]): Promise<string> {
  const tag = uuidv4().slice(0, 8);
  const vendorId = uuidv4();
  const id = uuidv4();
  const total = amounts.reduce((s, a) => s + Number(a), 0).toFixed(2);
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor en dolares','CCC030303CC3','rfc','USD',$4)`,
    [vendorId, f.entityId, `V-${tag}`, f.userId]
  );
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
       total_amount, amount_due, amount_paid, currency_code, exchange_rate, bill_date, due_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,0,$6,$6,0,'USD',17.1141,$7,$7,'draft',$8)`,
    [id, f.entityId, `BILL-862-${tag}`, vendorId, `F-${tag}`, total, day, f.userId]
  );
  for (const [i, amount] of amounts.entries()) {
    await query(
      `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
       VALUES ($1,$2,$3,$4,'Servicio',1,$5,$5,0,$5)`,
      [uuidv4(), id, i + 1, f.cuentas[i === 0 ? '6100' : '5100'], amount]
    );
  }
  await approveBill(id, f.userId, { entityId: f.entityId });
  return id;
}

interface Line {
  code: string;
  debit: string | null;
  credit: string | null;
  currency: string | null;
  foreign: string | null;
}

/** The lines of a document's entry, as the ledger holds them, in line order. */
async function entryLines(table: 'invoices' | 'bills', id: string): Promise<Line[]> {
  const r = await query<Line>(
    `SELECT a.code, l.debit_amount::text AS debit, l.credit_amount::text AS credit, l.currency_code AS currency,
            COALESCE(l.foreign_debit, l.foreign_credit)::text AS foreign
       FROM ${table} d
       JOIN journal_entry_lines l ON l.journal_entry_id = d.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE d.id = $1 AND d.entity_id = $2
      ORDER BY l.line_number`,
    [id, f.entityId]
  );
  return r.rows;
}

const codeOf = async (accountId: string): Promise<string> =>
  (await query<{ code: string }>('SELECT code FROM accounts WHERE id = $1 AND entity_id = $2', [accountId, f.entityId])).rows[0].code;

beforeAll(async () => {
  f = await crearInquilino('MNE-001-862 pesos to the cent');
  enterTenant(f.tenantId);
  await seedPolicies({ tenantId: f.tenantId });
  for (const [day, rate] of [[JAN, '17.1141'], [FEB, '17.0950'], [MAR, '17.1141']]) {
    await fijarTipo({ par: exigirPar('USD/MXN'), fecha: day, tasa: rate, fuente: 'dof', creadoPor: f.userId });
  }
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('MNE-001-862 · the January and February invoices and February\'s trial balance', () => {
  it('the receivable holds 570.76 and 100.01, each with its dollars', async () => {
    const receivable = await codeOf(f.roles.cxc);
    const jan = await entryLines('invoices', await invoice(JAN, ['33.35']));
    const feb = await entryLines('invoices', await invoice(FEB, ['5.85']));
    expect(jan[0]).toEqual({ code: receivable, debit: '570.7600', credit: null, currency: 'USD', foreign: '33.3500' });
    expect(feb[0]).toEqual({ code: receivable, debit: '100.0100', credit: null, currency: 'USD', foreign: '5.8500' });
    expect(jan).toHaveLength(2);
    expect(jan[1]).toMatchObject({ credit: '570.7600', foreign: '33.3500' });
  });

  it("February's file declares SaldoFin 670.77 and is generated: no rounding finding", async () => {
    const receivable = await codeOf(f.roles.cxc);
    await softClosePeriod(f.periodos[1], f.entityId, f.userId, 'soft close of January');
    const b = await generarBalanza(f.entityId, { periodo: f.periodos[2] });
    const node = b.xml.split('\n').find((l) => l.includes(`NumCta="${receivable}"`))?.trim();
    expect(node).toBe(`<BCE:Ctas NumCta="${receivable}" SaldoIni="570.76" Debe="100.01" Haber="0.00" SaldoFin="670.77"/>`);
  });

  it('ar reconcile weighs the open invoices at the same cents as the control', async () => {
    const r = await arReconcile(f.entityId);
    expect(r.open_invoices).toBe('670.77');
    expect(r.control_balance).toBe('670.77');
    expect(r.delta).toBe('0.00');
  });
});

describe('MNE-001-862 · the cent between the converted lines and the converted total', () => {
  it('by default it is a line on the exchange difference accounts, and the control account keeps its origin', async () => {
    const [receivable, payable, gain, loss] = await Promise.all(
      [f.roles.cxc, f.roles.cxp, f.roles.utilidad_cambiaria, f.roles.perdida_cambiaria].map(codeOf)
    );
    const sale = await entryLines('invoices', await invoice(MAR, ['46.66', '20.00']));
    expect(sale.map((l) => [l.code === receivable || l.code === gain ? l.code : 'line', l.debit, l.credit, l.foreign])).toEqual([
      [receivable, '1140.8300', null, '66.6600'],
      ['line', null, '798.5400', '46.6600'],
      ['line', null, '342.2800', '20.0000'],
      [gain, null, '0.0100', null],
    ]);
    const purchase = await entryLines('bills', await bill(MAR, ['46.66', '20.00']));
    expect(purchase[0]).toEqual({ code: payable, debit: null, credit: '1140.8300', currency: 'USD', foreign: '66.6600' });
    expect(purchase[3]).toEqual({ code: loss, debit: '0.0100', credit: null, currency: null, foreign: null });
  });

  it('under largest_line it is a line on the account of the largest line, without origin', async () => {
    await resolvePolicy(
      { tenantId: f.tenantId, entityId: f.entityId }, 'fx_conversion_cent_difference', 'largest_line', 'tester@test'
    );
    const purchase = await entryLines('bills', await bill(MAR, ['46.66', '20.00']));
    expect(purchase.map((l) => [l.code, l.debit, l.foreign]).slice(1)).toEqual([
      ['6100', '798.5400', '46.6600'],
      ['5100', '342.2800', '20.0000'],
      ['6100', '0.0100', null],
    ]);
  });
});

describe('MNE-001-862 · what was posted before, at four decimals', () => {
  it('an earlier foreign entry is still reversed, and its mirror is what was posted', async () => {
    // As develop posted USD 33.35 at 17.1141 before this task: 570.7552 on both sides.
    const id = uuidv4();
    await query(
      `INSERT INTO journal_entries (id, entry_number, entry_type, entity_id, fiscal_period_id, entry_date,
         status, description, created_by, source_type)
       VALUES ($1, $2, 'auto_invoice', $3, $4, $5::date, 'draft', 'Factura en dolares anterior', $6, 'invoice')`,
      [id, `OLD-${id.slice(0, 8)}`, f.entityId, f.periodos[3], MAR, f.userId]
    );
    await query(
      `INSERT INTO journal_entry_lines (journal_entry_id, line_number, account_id, debit_amount, credit_amount,
         currency_code, foreign_debit, foreign_credit, exchange_rate)
       VALUES ($1, 1, $2, 570.7552, NULL, 'USD', 33.35, NULL, 17.1141),
              ($1, 2, $3, NULL, 570.7552, 'USD', NULL, 33.35, 17.1141)`,
      [id, f.roles.cxc, f.cuentas['4100']]
    );
    await postJournalEntry(id, f.userId);

    const mirror = await reverseJournalEntry(id, f.userId, { reversalDate: MAR });
    const lines = await query<{ debit: string | null; credit: string | null; foreign: string }>(
      `SELECT debit_amount::text AS debit, credit_amount::text AS credit,
              COALESCE(foreign_debit, foreign_credit)::text AS foreign
         FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number`,
      [mirror.id]
    );
    expect(lines.rows).toEqual([
      { debit: null, credit: '570.7552', foreign: '33.3500' },
      { debit: '570.7552', credit: null, foreign: '33.3500' },
    ]);
  });
});

describe('MNE-001-862 · a hand entry with half a cent', () => {
  it('entry create refuses 0.005 on a peso entity, naming the line, and writes nothing', async () => {
    const before = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1', [f.entityId]);
    await expect(
      createDraftEntry({
        entityId: f.entityId, createdBy: f.userId, date: MAR,
        lines: [{ account: '6100', debit: '0.005' }, { account: '1140', credit: '0.005' }],
      })
    ).rejects.toThrow(/^Line 1: "0\.005" is finer than the minor unit of MXN \(2 decimals\)/);
    const after = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1', [f.entityId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });
});
