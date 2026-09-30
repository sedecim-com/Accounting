import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { apartarCatalogos } from './helpers/catalogos-globales.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { issueInvoice } from '../../src/services/ar/invoice-service.js';
import { exigirPar, fijarTipo } from '../../src/services/fx/rate-service.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { revalueForeignBalances } from '../../src/services/accounting/fx-revaluation.js';
import { JournalEntryType } from '../../src/types/index.js';

/**
 * MNE-001-083 (#305) · the closing revaluation of foreign balances (NIF B-15).
 *
 * A USD 1 000 receivable and a USD 500 payable born at 17.50, and USD 200 in
 * the bank at 17.50. August closes at the DOF 18.20 of its last calendar day:
 * receivable +700, bank +140 (gain 840), payable +350 (loss 350), in one
 * adjusting entry with its own source_type, reversed on September 1st.
 */

let f: Fixture;
const DAY = '2026-08-20';
const RATE = (day: string, rate: string, source: 'dof' | 'banco_mexico' = 'dof') =>
  fijarTipo({ par: exigirPar('USD/MXN'), fecha: day, tasa: rate, fuente: source, creadoPor: f.userId });

interface Line { account_id: string; debit: string | null; credit: string | null }
const linesOf = async (entryId: string): Promise<Line[]> =>
  (
    await query<Line>(
      `SELECT account_id, debit_amount::text AS debit, credit_amount::text AS credit
         FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number`,
      [entryId]
    )
  ).rows;
const entriesOf = async (): Promise<number> =>
  Number((await query<{ n: string }>('SELECT count(*) AS n FROM journal_entries WHERE entity_id = $1', [f.entityId])).rows[0].n);
const ctx = () => ({ tenantId: f.tenantId, entityId: f.entityId });

apartarCatalogos('exchange_rates');

beforeAll(async () => {
  f = await crearInquilino('MNE-001-083 revaluation');
  await RATE(DAY, '17.5000');
  await RATE('2026-08-31', '18.2000');

  const tag = uuidv4().slice(0, 8);
  const custId = uuidv4();
  const invId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Cliente USD','XEXX010101000','rfc','USD',$4)`,
    [custId, f.entityId, `CR-${tag}`, f.userId]
  );
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
       amount_due, currency_code, exchange_rate, invoice_date, due_date, status, created_by)
     VALUES ($1,$2,$3,$4,1000,0,1000,1000,'USD',1,$5,$5,'draft',$6)`,
    [invId, f.entityId, `INV-RV-${tag}`, custId, DAY, f.userId]
  );
  await query(
    `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price,
       revenue_account_id, tax_amount, line_amount, total_amount)
     VALUES ($1,$2,1,'Servicio exportado',1,1000,$3,0,1000,1000)`,
    [uuidv4(), invId, f.cuentas['4100']]
  );
  await issueInvoice(invId, f.userId, { entityId: f.entityId });

  const vendorId = uuidv4();
  const billId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor USD','CCC030303CC3','rfc','USD',$4)`,
    [vendorId, f.entityId, `VR-${tag}`, f.userId]
  );
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount,
       total_amount, amount_due, amount_paid, currency_code, exchange_rate, bill_date, due_date, status, created_by)
     VALUES ($1,$2,$3,$4,$5,500,0,500,500,0,'USD',17.5,$6,$6,'draft',$7)`,
    [billId, f.entityId, `BILL-RV-${tag}`, vendorId, `V-${tag}`, DAY, f.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio en USD',1,500,500,0,500)`,
    [uuidv4(), billId, f.cuentas['6100']]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });

  await createJournalEntry(
    f.entityId, DAY, JournalEntryType.STANDARD, 'USD deposit',
    [
      { account_id: f.roles.banco, debit_amount: '3500.0000', credit_amount: null, description: 'USD 200',
        currency_code: 'USD', foreign_debit: '200.0000', exchange_rate: '17.5000000000' },
      { account_id: f.cuentas['4100'], debit_amount: null, credit_amount: '3500.0000', description: 'deposit' },
    ],
    f.userId, { autoPost: true }
  );
});

afterAll(async () => {
  await drainAttestations();
  await closeDatabase();
});

describe('MNE-001-083 · closing fx revalue', () => {
  it('a dry run shows the revaluation at the DOF of the last calendar day and writes nothing', async () => {
    const before = await entriesOf();
    const run = await revalueForeignBalances(ctx(), f.periodos[8], f.userId, { dryRun: true });
    expect(run.closingDate).toBe('2026-08-31');
    expect(run.reversalDate).toBe('2026-09-01');
    expect(run.rates).toEqual([expect.objectContaining({ currency: 'USD', fuente: 'dof', fecha: '2026-08-31' })]);
    const byAccount = Object.fromEntries(run.lines.map((l) => [l.accountId, l.difference]));
    expect(byAccount).toEqual({
      [f.roles.cxc]: '700.0000',
      [f.roles.cxp]: '-350.0000',
      [f.roles.banco]: '140.0000',
    });
    expect([run.gain, run.loss]).toEqual(['840.0000', '350.0000']);
    expect(run.entry).toBeNull();
    expect(await entriesOf()).toBe(before);
    const marker = await query('SELECT 1 FROM fx_revaluation_runs WHERE entity_id = $1', [f.entityId]);
    expect(marker.rowCount).toBe(0);
  });

  it('posts an adjusting fx_revaluation entry on the last day and its mirror on day 1 of the next period', async () => {
    const run = await revalueForeignBalances(ctx(), f.periodos[8], f.userId);
    expect(run.entry).not.toBeNull();
    const je = await query<{ entry_type: string; source_type: string; d: string; fiscal_period_id: string; reversed_by_entry_id: string }>(
      `SELECT entry_type, source_type, to_char(entry_date, 'YYYY-MM-DD') AS d, fiscal_period_id, reversed_by_entry_id
         FROM journal_entries WHERE id = $1`,
      [run.entry?.id]
    );
    expect(je.rows[0]).toMatchObject({
      entry_type: 'adjusting', source_type: 'fx_revaluation', d: '2026-08-31', fiscal_period_id: f.periodos[8],
      reversed_by_entry_id: run.reversal?.id,
    });
    const lines = await linesOf(run.entry?.id as string);
    const at = (id: string) => lines.find((l) => l.account_id === id);
    expect(at(f.roles.cxc)?.debit).toBe('700.0000');
    expect(at(f.roles.banco)?.debit).toBe('140.0000');
    expect(at(f.roles.cxp)?.credit).toBe('350.0000');
    expect(at(f.roles.utilidad_cambiaria)?.credit).toBe('840.0000');
    expect(at(f.roles.perdida_cambiaria)?.debit).toBe('350.0000');

    const rev = await query<{ d: string; fiscal_period_id: string; status: string }>(
      `SELECT to_char(entry_date, 'YYYY-MM-DD') AS d, fiscal_period_id, status FROM journal_entries WHERE id = $1`,
      [run.reversal?.id]
    );
    expect(rev.rows[0]).toEqual({ d: '2026-09-01', fiscal_period_id: f.periodos[9], status: 'posted' });
  });

  it('the mirror lands on day 1 of the NEXT period even with later ones open, and is found by the marker and reverses_entry_id', async () => {
    const open = await query<{ status: string }>('SELECT status FROM fiscal_periods WHERE id = ANY($1) ORDER BY period_number', [
      [f.periodos[9], f.periodos[10]],
    ]);
    expect(open.rows.map((r) => r.status)).toEqual(['open', 'open']);
    const marker = await query<{ journal_entry_id: string; reversal_entry_id: string; sequence: number }>(
      'SELECT journal_entry_id, reversal_entry_id, sequence FROM fx_revaluation_runs WHERE entity_id = $1',
      [f.entityId]
    );
    expect(marker.rows).toHaveLength(1);
    expect(marker.rows[0].sequence).toBe(1);
    const mirror = await query<{ reverses_entry_id: string; fiscal_period_id: string; d: string; source_type: string | null }>(
      `SELECT reverses_entry_id, fiscal_period_id, to_char(entry_date, 'YYYY-MM-DD') AS d, source_type
         FROM journal_entries WHERE id = $1`,
      [marker.rows[0].reversal_entry_id]
    );
    expect(mirror.rows[0]).toEqual({
      reverses_entry_id: marker.rows[0].journal_entry_id,
      fiscal_period_id: f.periodos[9],
      d: '2026-09-01',
      source_type: null,
    });
  });

  it('a deleted or rewritten marker is refused against the ledger instead of posting the revaluation again', async () => {
    const row = (await query<Record<string, unknown>>('SELECT * FROM fx_revaluation_runs WHERE entity_id = $1', [f.entityId]))
      .rows[0];
    const before = await entriesOf();
    try {
      await query('DELETE FROM fx_revaluation_runs WHERE id = $1', [row.id]);
      await expect(revalueForeignBalances(ctx(), f.periodos[8], f.userId)).rejects.toMatchObject({
        code: 'FX_REVALUATION_MARKER_MISMATCH',
      });
      await query(
        `INSERT INTO fx_revaluation_runs (id, entity_id, fiscal_period_id, journal_entry_id, reversal_entry_id, sequence,
           rate_date, rates, lines, created_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '[]'::jsonb, $9, $10)`,
        [row.id, row.entity_id, row.fiscal_period_id, row.journal_entry_id, row.reversal_entry_id, row.sequence,
          row.rate_date, JSON.stringify(row.rates), row.created_by, row.created_at]
      );
      await expect(revalueForeignBalances(ctx(), f.periodos[8], f.userId)).rejects.toMatchObject({
        code: 'FX_REVALUATION_MARKER_MISMATCH',
      });
      expect(await entriesOf()).toBe(before);
    } finally {
      await query('UPDATE fx_revaluation_runs SET lines = $2::jsonb WHERE id = $1', [row.id, JSON.stringify(row.lines)]);
    }
  });

  it('running it again posts nothing: the marker says the period was revalued', async () => {
    const before = await entriesOf();
    const again = await revalueForeignBalances(ctx(), f.periodos[8], f.userId);
    expect(again.alreadyRun).not.toBeNull();
    expect(again.entry).toBeNull();
    expect(await entriesOf()).toBe(before);
  });

  it('a USD posting dated inside the period after the run is revalued by a supplement, also once the month is soft-closed', async () => {
    await query(`UPDATE fiscal_periods SET status = 'soft_close', soft_close_date = NOW() WHERE id = $1`, [f.periodos[8]]);
    await createJournalEntry(
      f.entityId, '2026-08-25', JournalEntryType.ADJUSTING, 'Late USD deposit',
      [
        { account_id: f.roles.banco, debit_amount: '17500.0000', credit_amount: null, description: 'USD 1 000',
          currency_code: 'USD', foreign_debit: '1000.0000', exchange_rate: '17.5000000000' },
        { account_id: f.cuentas['4100'], debit_amount: null, credit_amount: '17500.0000', description: 'late deposit' },
      ],
      f.userId, { autoPost: true }
    );
    const plan = await revalueForeignBalances(ctx(), f.periodos[8], f.userId, { dryRun: true });
    expect(plan.alreadyRun).toBeNull();
    expect(plan.sequence).toBe(2);
    const bank = plan.lines.find((l) => l.accountId === f.roles.banco);
    // 1 200 × 18.20 = 21 840, book 21 000, and 140 already posted: 700 left.
    expect(bank).toMatchObject({ alreadyPosted: '140.0000', difference: '700.0000' });
    expect(plan.lines.find((l) => l.accountId === f.roles.cxc)?.difference).toBe('0.0000');
    expect([plan.gain, plan.loss]).toEqual(['700.0000', '0.0000']);

    const run = await revalueForeignBalances(ctx(), f.periodos[8], f.userId, { expect: { gain: plan.gain, loss: plan.loss } });
    expect(run.sequence).toBe(2);
    const lines = await linesOf(run.entry?.id as string);
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.account_id === f.roles.banco)?.debit).toBe('700.0000');
    expect(lines.find((l) => l.account_id === f.roles.utilidad_cambiaria)?.credit).toBe('700.0000');
    const rev = await query<{ d: string }>(`SELECT to_char(entry_date, 'YYYY-MM-DD') AS d FROM journal_entries WHERE id = $1`, [
      run.reversal?.id,
    ]);
    expect(rev.rows[0].d).toBe('2026-09-01');

    const before = await entriesOf();
    const again = await revalueForeignBalances(ctx(), f.periodos[8], f.userId);
    expect(again.alreadyRun).toMatchObject({ sequence: 2 });
    expect(await entriesOf()).toBe(before);
  });

  it('a hard-closed period is refused: the revaluation belongs before the seal', async () => {
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [f.periodos[7]]);
    await expect(revalueForeignBalances(ctx(), f.periodos[7], f.userId, { dryRun: true })).rejects.toMatchObject({
      code: 'FX_REVALUATION_PERIOD_NOT_OPEN',
    });
  });

  it('an entity whose functional currency is not MXN is refused (#124)', async () => {
    await query(`UPDATE legal_entities SET functional_currency = 'USD' WHERE id = $1`, [f.entityId]);
    try {
      await expect(revalueForeignBalances(ctx(), f.periodos[9], f.userId, { dryRun: true })).rejects.toMatchObject({
        code: 'FX_REVALUATION_FUNCTIONAL_NOT_SUPPORTED',
      });
    } finally {
      await query(`UPDATE legal_entities SET functional_currency = 'MXN' WHERE id = $1`, [f.entityId]);
    }
  });

  it('with no rate of the source for the last calendar day it fails and posts nothing', async () => {
    const before = await entriesOf();
    await expect(revalueForeignBalances(ctx(), f.periodos[9], f.userId)).rejects.toThrow(
      /No hay tipo de cambio USD→MXN de la fuente 'dof' para 2026-09-30/
    );
    expect(await entriesOf()).toBe(before);
  });

  it('closing_exchange_rate_source = fix_banxico revalues at the FIX of that day', async () => {
    await RATE('2026-09-30', '18.0000', 'banco_mexico');
    // MNE-001-112: the key changes only once August's revaluation is sealed.
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [f.periodos[8]]);
    await seedPolicies({ tenantId: f.tenantId });
    await resolvePolicy({ tenantId: f.tenantId }, 'closing_exchange_rate_source', 'fix_banxico', f.userId);
    const run = await revalueForeignBalances(ctx(), f.periodos[9], f.userId, { dryRun: true });
    expect(run.rates[0].fuente).toBe('banco_mexico');
    expect(Number(run.rates[0].tasa)).toBe(18);
    // Back at the historical 17.50 after the August mirror: 1 000 × 0.50.
    expect(run.lines.find((l) => l.accountId === f.roles.cxc)?.difference).toBe('500.0000');
  });

  it('a live run whose recomputation differs from the confirmed plan posts nothing', async () => {
    const before = await entriesOf();
    await expect(
      revalueForeignBalances(ctx(), f.periodos[9], f.userId, { expect: { gain: '1.0000', loss: '0.0000' } })
    ).rejects.toMatchObject({ code: 'FX_REVALUATION_PLAN_CHANGED' });
    expect(await entriesOf()).toBe(before);
  });

  it('a source the panel chose that published nothing names the panel, by key', async () => {
    await expect(revalueForeignBalances(ctx(), f.periodos[10], f.userId, { dryRun: true })).rejects.toMatchObject({
      code: 'FX_RATE_MISSING',
      messageKey: { key: 'error.FX_RATE_MISSING', params: { source: 'banco_mexico', date: '2026-10-31' } },
    });
  });

  it('without an open next period the revaluation is refused instead of leaving its mirror for later', async () => {
    await expect(revalueForeignBalances(ctx(), f.periodos[12], f.userId)).rejects.toMatchObject({
      code: 'FX_REVALUATION_NEXT_PERIOD_NOT_OPEN',
    });
  });
});
