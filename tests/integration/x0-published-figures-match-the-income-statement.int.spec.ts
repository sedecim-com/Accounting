import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Decimal from 'decimal.js';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { blockchainOrchestrator } from '../../src/services/blockchain/orchestrator.js';
import { getIncomeStatement } from '../../src/services/reporting/report-service.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// X0 · WHAT IS PUBLISHED IS WHAT THE FIRM'S OWN INCOME STATEMENT SAYS
//
// The publisher is a SECOND query over the ledger, and it disagrees with the
// income statement in two ways that both inflate what a firm publishes about
// itself:
//
//  · It flips the sign PER ACCOUNT instead of per section, so a contra-natural
//    account adds to its section. Sales returns (4400: revenue with a DEBIT
//    normal balance) are added to revenue instead of subtracted; purchase
//    returns (5200: expense with a CREDIT normal balance) are added to
//    expenses. `report-service` flips per section, on purpose and with its
//    reason written down.
//  · It filters only on `status = 'posted'`, so the year-end closing entry —
//    which sweeps the WHOLE year into the period being closed — is counted as
//    that month's activity. Whether closing entries belong in a report is a
//    panel decision (`informes_asientos_de_cierre`), and the publisher does
//    not ask it.
//
// The assertion is not "the number is positive": it is that the published
// figure EQUALS the one the firm's own income statement shows for the same
// period. Two figures about the same month, published under a seal, that do
// not agree with each other.
// ============================================================

let fx: Fixture;

const REVENUE_PERIOD = 8;
const CLOSING_PERIOD = 9;

async function entry(period: number, type: JournalEntryType, description: string, lines: Array<{ account: string; debit?: string; credit?: string }>): Promise<void> {
  await createJournalEntry(
    fx.entityId,
    fechaEnPeriodo(period),
    type,
    description,
    lines.map((l) => ({
      account_id: l.account,
      debit_amount: l.debit ?? null,
      credit_amount: l.credit ?? null,
      description,
    })),
    fx.userId,
    { autoPost: true }
  );
}

const publishedAmount = async (period: number, dimension: string): Promise<string | undefined> => {
  const { rows } = await query<{ public_amount: string }>(
    `SELECT public_amount::text FROM published_aggregates
      WHERE entity_id = $1 AND period_id = $2 AND dimension_value = $3
      ORDER BY version DESC LIMIT 1`,
    [fx.entityId, fx.periodos[period], dimension]
  );
  return rows[0]?.public_amount;
};

const statementTotals = async (period: number): Promise<{ revenue: string; expenses: string }> => {
  const { rows } = await query<{ start_date: string; end_date: string }>(
    `SELECT start_date::text, end_date::text FROM fiscal_periods WHERE id = $1`,
    [fx.periodos[period]]
  );
  const r = await getIncomeStatement(fx.entityId, { startDate: rows[0].start_date, endDate: rows[0].end_date });
  return { revenue: r.revenue.total, expenses: r.expenses.total };
};

beforeAll(async () => {
  fx = await crearInquilino('X0 · published vs income statement');
  await query(
    `INSERT INTO disclosure_config (tenant_id, entity_id, minimum_aggregation_count, round_to_nearest)
     VALUES ($1, $2, 1, 1)
     ON CONFLICT (tenant_id, entity_id) DO UPDATE SET minimum_aggregation_count = 1, round_to_nearest = 1`,
    [fx.tenantId, fx.entityId]
  );
  const bank = fx.roles.banco ?? fx.cuentas['1110'];

  // Month with a sale and a sales return, and a cost with a purchase return.
  await entry(REVENUE_PERIOD, JournalEntryType.STANDARD, 'X0 sale', [
    { account: bank!, debit: '10000.0000' }, { account: fx.cuentas['4100'], credit: '10000.0000' },
  ]);
  await entry(REVENUE_PERIOD, JournalEntryType.STANDARD, 'X0 sales return', [
    { account: fx.cuentas['4400'], debit: '2000.0000' }, { account: bank!, credit: '2000.0000' },
  ]);
  await entry(REVENUE_PERIOD, JournalEntryType.STANDARD, 'X0 cost', [
    { account: fx.cuentas['5100'], debit: '3000.0000' }, { account: bank!, credit: '3000.0000' },
  ]);
  await entry(REVENUE_PERIOD, JournalEntryType.STANDARD, 'X0 purchase return', [
    { account: bank!, debit: '1000.0000' }, { account: fx.cuentas['5200'], credit: '1000.0000' },
  ]);

  // A month whose own activity is small, plus the closing entry that sweeps
  // the year into it — exactly what a hard close of the last period posts.
  await entry(CLOSING_PERIOD, JournalEntryType.STANDARD, 'X0 small sale', [
    { account: bank!, debit: '500.0000' }, { account: fx.cuentas['4100'], credit: '500.0000' },
  ]);
  await entry(CLOSING_PERIOD, JournalEntryType.CLOSING, 'X0 year-end close', [
    { account: fx.cuentas['4100'], debit: '8500.0000' }, { account: fx.cuentas['3300'], credit: '8500.0000' },
  ]);

  await drainAttestations(3000);
  for (const p of [REVENUE_PERIOD, CLOSING_PERIOD]) {
    await blockchainOrchestrator.publishAggregates({ tenantId: fx.tenantId, entityId: fx.entityId, periodId: fx.periodos[p] });
  }
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('what the firm publishes about itself', () => {
  it('revenue equals the revenue of its own income statement — returns SUBTRACT', async () => {
    const statement = await statementTotals(REVENUE_PERIOD);
    expect(statement.revenue, 'the income statement itself is wrong; this test is measuring the wrong thing').toBe('8000.0000');
    const published = await publishedAmount(REVENUE_PERIOD, 'revenue');
    expect(published && new Decimal(published).toFixed(4), 'published revenue disagrees with the income statement').toBe(statement.revenue);
  });

  it('expenses equal the expenses of its own income statement — purchase returns SUBTRACT', async () => {
    const statement = await statementTotals(REVENUE_PERIOD);
    expect(statement.expenses).toBe('2000.0000');
    const published = await publishedAmount(REVENUE_PERIOD, 'expense');
    expect(published && new Decimal(published).toFixed(4), 'published expenses disagree with the income statement').toBe(statement.expenses);
  });

  it('the year-end closing entry does not become that month s activity', async () => {
    const statement = await statementTotals(CLOSING_PERIOD);
    expect(statement.revenue, 'the closing policy changed: the statement itself now counts the close').toBe('500.0000');
    const published = await publishedAmount(CLOSING_PERIOD, 'revenue');
    expect(published && new Decimal(published).toFixed(4), 'the published month counts the whole year being swept').toBe(statement.revenue);
  });
});
