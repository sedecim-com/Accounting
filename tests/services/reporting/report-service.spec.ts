import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import {
  resolvePeriodRange,
  queryTrialBalanceRows,
  totalTrialBalance,
  getTrialBalance,
  queryBalanceSheetRows,
  buildBalanceSheetSection,
  getBalanceSheet,
  queryIncomeStatementRows,
  buildIncomeStatementSection,
  getIncomeStatement,
  queryLedgerRows,
  countLedgerRows,
  getGeneralLedger,
  queryAgedReceivableRows,
  queryAgedPayableRows,
  getAgedReceivables,
  getAgedPayables,
} from '../../../src/services/reporting/report-service.js';
import { query } from '../../../src/database/connection.js';
import { ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => mockQuery.mockReset());

const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');
const params = (call: number) => mockQuery.mock.calls[call][1];

/** A trial-balance row shaped the way Postgres hands it back: money as strings. */
const tbRow = (code: string, debit: string, credit: string) => ({
  account_id: `id-${code}`,
  account_code: code,
  account_name: `Account ${code}`,
  account_type: 'asset',
  debit_total: debit,
  credit_total: credit,
  ending_balance: String(Number(debit) - Number(credit)),
});

// ============================================================
// The properties worth pinning are the ones that produce a WRONG
// NUMBER when they break, not the ones that produce an error.
// ============================================================

describe('the (jel JOIN je) pair — the defect that must never come back', () => {
  it.each([
    ['trial balance', () => queryTrialBalanceRows(ENTITY)],
    ['balance sheet', () => queryBalanceSheetRows(ENTITY, '2026-12-31')],
    ['income statement', () => queryIncomeStatementRows(ENTITY, { startDate: '2026-01-01', endDate: '2026-12-31' })],
  ])('%s pre-filters the join instead of chaining two LEFT JOINs', async (_name, run) => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await run();
    // The pair is parenthesized and the status predicate lives INSIDE it.
    expect(sql(0)).toMatch(
      /LEFT JOIN \(journal_entry_lines jel JOIN journal_entries je ON je\.id = jel\.journal_entry_id AND je\.status = 'posted'/
    );
    // A second, chained LEFT JOIN onto journal_entries would let draft and
    // void lines survive the failed predicate and be summed.
    expect(sql(0)).not.toMatch(/LEFT JOIN journal_entries/);
  });
});

describe('queryTrialBalanceRows', () => {
  it('scopes to the entity and to active accounts', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY);
    expect(sql(0)).toMatch(/WHERE a\.entity_id = \$1 AND a\.is_active = true/);
    expect(params(0)).toEqual([ENTITY]);
  });

  it('keeps zero-activity accounts: a missing row is not a zero balance', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY);
    expect(sql(0)).not.toMatch(/HAVING/);
  });

  it('filters by fiscal period id, inside the join', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, { fiscalPeriodId: 'fp-1' });
    expect(sql(0)).toMatch(/je\.status = 'posted' AND je\.fiscal_period_id = \$2\)/);
    expect(params(0)).toEqual([ENTITY, 'fp-1']);
  });

  it('numbers the level filter before the period filter, as the REST route always has', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, { maxLevel: 5, asOfDate: '2026-06-30' });
    expect(sql(0)).toMatch(/AND a\.account_level <= \$2/);
    expect(sql(0)).toMatch(/AND je\.entry_date <= \$3\)/);
    expect(params(0)).toEqual([ENTITY, 5, '2026-06-30']);
  });

  it('omits the level filter entirely when no level was asked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, {});
    expect(sql(0)).not.toMatch(/account_level/);
  });

  it('lets a date range replace the as-of cutoff for period activity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, { sinceDate: '2026-01-01', untilDate: '2026-03-31' });
    expect(sql(0)).toMatch(/AND je\.entry_date >= \$2 AND je\.entry_date <= \$3\)/);
    expect(params(0)).toEqual([ENTITY, '2026-01-01', '2026-03-31']);
  });

  it('prefers the fiscal period over the dates when both arrive', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, { fiscalPeriodId: 'fp-1', asOfDate: '2026-06-30', sinceDate: '2026-01-01' });
    expect(params(0)).toEqual([ENTITY, 'fp-1']);
  });
});

describe('totalTrialBalance — the footing', () => {
  it('adds money with Decimal, so a cent never evaporates', () => {
    const rows = Array.from({ length: 10 }, () => ({ debit_total: '0.10', credit_total: '0.10' }));
    const totals = totalTrialBalance(rows);
    // 0.1 * 10 in binary floating point is 0.9999999999999999.
    expect(totals.total_debits).toBe('1.0000');
    expect(totals.is_balanced).toBe(true);
  });

  it('returns strings, never numbers', () => {
    const totals = totalTrialBalance([{ debit_total: '5', credit_total: '5' }]);
    expect(typeof totals.total_debits).toBe('string');
    expect(typeof totals.total_credits).toBe('string');
  });

  it('tolerates a cent and refuses two', () => {
    expect(totalTrialBalance([{ debit_total: '100.01', credit_total: '100.00' }]).is_balanced).toBe(true);
    expect(totalTrialBalance([{ debit_total: '100.02', credit_total: '100.00' }]).is_balanced).toBe(false);
  });

  it('honours the caller scale, so the agent can round without the API doing so', () => {
    expect(totalTrialBalance([{ debit_total: '1.5', credit_total: '1.5' }], 2).total_debits).toBe('1.50');
  });
});

describe('getTrialBalance — truncation must never change the answer', () => {
  it('foots over EVERY account and pages only what is displayed', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [tbRow('1000', '100', '0'), tbRow('2000', '0', '60'), tbRow('3000', '0', '40')],
    });
    const report = await getTrialBalance(ENTITY, { limit: 1 });
    expect(report.rows).toHaveLength(1);
    // total is what makes render() announce the cut instead of lying.
    expect(report.total).toBe(3);
    // The footing covers all three rows, not the single displayed one.
    expect(report.totals.total_debits).toBe('100.0000');
    expect(report.totals.total_credits).toBe('100.0000');
    expect(report.totals.is_balanced).toBe(true);
  });

  it('offsets without losing the total', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [tbRow('1000', '10', '0'), tbRow('2000', '20', '0'), tbRow('3000', '30', '0')],
    });
    const report = await getTrialBalance(ENTITY, { limit: 1, offset: 1 });
    expect(report.rows[0].account_code).toBe('2000');
    expect(report.total).toBe(3);
  });

  it('excludeZero drops zero-balance accounts and the total follows', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [tbRow('1000', '100', '0'), tbRow('1500', '0', '0'), tbRow('2000', '0', '100')],
    });
    const report = await getTrialBalance(ENTITY, { excludeZero: true });
    expect(report.rows.map((r) => r.account_code)).toEqual(['1000', '2000']);
    expect(report.total).toBe(2);
  });

  it('returns every account when no limit is given: a statement is not a page', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [tbRow('1000', '1', '0'), tbRow('2000', '0', '1')] });
    const report = await getTrialBalance(ENTITY);
    expect(report.rows).toHaveLength(2);
    expect(report.total).toBe(2);
  });
});

describe('buildBalanceSheetSection — contra accounts NET, they do not inflate', () => {
  const rows = [
    { id: 'a', code: '1200', name: 'Equipo', account_type: 'asset', fs_category: 'fixed_assets', balance: '1000.0000' },
    { id: 'b', code: '1290', name: 'Depreciación Acumulada', account_type: 'contra_asset', fs_category: 'fixed_assets', balance: '-400.0000' },
  ];

  it('subtracts accumulated depreciation instead of adding its absolute value', () => {
    const section = buildBalanceSheetSection(rows, ['asset', 'contra_asset'], 'Assets', 1);
    expect(section.total).toBe('600.0000');
    expect(section.subsections[0].accounts.map((a) => a.balance)).toEqual(['1000.0000', '-400.0000']);
  });

  it('flips the sign for credit-natural sections rather than taking abs()', () => {
    const liabilities = [
      { id: 'c', code: '2110', name: 'Proveedores', account_type: 'liability', fs_category: 'current_liabilities', balance: '-16008.0000' },
    ];
    const section = buildBalanceSheetSection(liabilities, ['liability', 'contra_liability'], 'Liabilities', -1);
    expect(section.total).toBe('16008.0000');
  });

  it('groups accounts with no fs_category under "Other" rather than dropping them', () => {
    const orphan = [{ id: 'd', code: '1999', name: 'Sin categoría', account_type: 'asset', fs_category: null, balance: '5.0000' }];
    const section = buildBalanceSheetSection(orphan, ['asset'], 'Assets', 1);
    expect(section.subsections[0].name).toBe('Other');
    expect(section.total).toBe('5.0000');
  });

  it('every amount it produces is a string', () => {
    const section = buildBalanceSheetSection(rows, ['asset', 'contra_asset'], 'Assets', 1);
    expect(typeof section.total).toBe('string');
    expect(typeof section.subsections[0].total).toBe('string');
    expect(typeof section.subsections[0].accounts[0].balance).toBe('string');
  });
});

describe('queryBalanceSheetRows / getBalanceSheet', () => {
  it('cuts at the as-of date and only on permanent accounts', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryBalanceSheetRows(ENTITY, '2026-12-31');
    expect(sql(0)).toMatch(/AND je\.entry_date <= \$2/);
    expect(sql(0)).toMatch(/a\.account_type IN \('asset', 'liability', 'equity', 'contra_asset', 'contra_liability', 'contra_equity'\)/);
    expect(params(0)).toEqual([ENTITY, '2026-12-31']);
  });

  it('adds liabilities and equity into the balancing figure', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'a', code: '1110', name: 'Bancos', account_type: 'asset', fs_category: 'current_assets', balance: '100.0000' },
        { id: 'b', code: '2110', name: 'Proveedores', account_type: 'liability', fs_category: 'current_liabilities', balance: '-60.0000' },
        { id: 'c', code: '3100', name: 'Capital', account_type: 'equity', fs_category: 'equity', balance: '-40.0000' },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] }); // nothing unclosed
    const bs = await getBalanceSheet(ENTITY, { asOfDate: '2026-12-31' });
    expect(bs.assets.total).toBe('100.0000');
    expect(bs.total_liabilities_and_equity).toBe('100.0000');
    expect(bs.is_balanced).toBe(true);
    expect(bs.out_of_balance).toBe('0.0000');
  });
});

// ============================================================
// The identity A = L + E, which the statement used to violate and then
// explain away. The number that closed the gap on real data was exactly
// the unclosed result of the period: assets -261.12 against liabilities
// plus equity 16,008.00, a gap of 16,269.12 — the P&L nobody had swept.
// ============================================================

describe('the result of the period belongs to equity', () => {
  const PERMANENT = [
    { id: 'a', code: '1110', name: 'Bancos', account_type: 'asset', fs_category: 'current_assets', balance: '100.0000' },
    { id: 'b', code: '2110', name: 'Proveedores', account_type: 'liability', fs_category: 'current_liabilities', balance: '-70.0000' },
  ];

  it('makes the statement foot when a period is still open', async () => {
    mockQuery.mockResolvedValueOnce({ rows: PERMANENT });
    // Revenue 50 credit, expense 20 debit → debit-positive net of -30.
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '-30.0000' }] });

    const bs = await getBalanceSheet(ENTITY, { asOfDate: '2026-06-30' });
    expect(bs.equity.subsections.map((s) => s.name)).toContain('Result Of The Period');
    expect(bs.equity.total).toBe('30.0000');
    expect(bs.total_liabilities_and_equity).toBe('100.0000');
    expect(bs.assets.total).toBe('100.0000');
    expect(bs.is_balanced).toBe(true);
  });

  it('sums temporary accounts from INCEPTION, so a closed year cannot double count', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] });
    await getBalanceSheet(ENTITY, { asOfDate: '2026-12-31' });

    const earningsSql = sql(1);
    expect(earningsSql).toMatch(/account_type IN \('revenue', 'expense', 'contra_revenue'\)/);
    // A closing entry debits revenue and credits expense, so a closed year
    // nets to zero here on its own. Bounding by a fiscal-year start would
    // double count it against retained earnings.
    expect(earningsSql).not.toMatch(/fiscal_year|start_date/);
    expect(params(1)).toEqual([ENTITY, '2026-12-31']);
  });

  it('omits the line entirely when there is nothing unclosed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: PERMANENT });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] });
    const bs = await getBalanceSheet(ENTITY, { asOfDate: '2026-12-31' });
    expect(bs.equity.subsections.map((s) => s.name)).not.toContain('Result Of The Period');
  });

  it('reports the gap instead of hiding it when the ledger is genuinely inconsistent', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'a', code: '1110', name: 'Bancos', account_type: 'asset', fs_category: 'current_assets', balance: '100.0000' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] });
    const bs = await getBalanceSheet(ENTITY, { asOfDate: '2026-12-31' });
    expect(bs.is_balanced).toBe(false);
    expect(bs.out_of_balance).toBe('100.0000');
  });

  it('keeps a retired account that still carries a balance on the statement', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] });
    await getBalanceSheet(ENTITY, { asOfDate: '2026-12-31' });
    // Filtering by is_active removed real money from the balance sheet.
    expect(sql(0)).not.toMatch(/a\.is_active/);
  });
});

describe('income statement', () => {
  it('keeps the historical HAVING by default and widens it only on request', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryIncomeStatementRows(ENTITY, { startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(sql(0)).toMatch(/HAVING COALESCE\(SUM\(COALESCE\(jel\.debit_amount, 0\) - COALESCE\(jel\.credit_amount, 0\)\), 0\) != 0/);

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryIncomeStatementRows(ENTITY, { startDate: '2026-01-01', endDate: '2026-12-31', include: 'any-activity' });
    expect(sql(1)).toMatch(/HAVING COALESCE\(SUM\(COALESCE\(jel\.debit_amount, 0\)\), 0\) != 0 OR/);
  });

  it('bounds the range with BETWEEN in parameter order', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryIncomeStatementRows(ENTITY, { startDate: '2026-01-01', endDate: '2026-03-31' });
    expect(sql(0)).toMatch(/je\.entry_date BETWEEN \$2 AND \$3/);
    expect(params(0)).toEqual([ENTITY, '2026-01-01', '2026-03-31']);
  });

  it('reports revenue positive even though it is credit-natural', () => {
    const section = buildIncomeStatementSection(
      [{ id: 'r', code: '4100', name: 'Ventas', account_type: 'revenue', fs_category: null, debit_total: '0', credit_total: '1000' }],
      'revenue'
    );
    expect(section.total).toBe('1000.0000');
    expect(section.accounts[0].amount).toBe('1000.0000');
  });

  it('does not let a sales return inflate revenue the way abs() would', () => {
    const section = buildIncomeStatementSection(
      [
        { id: 'r', code: '4100', name: 'Ventas', account_type: 'revenue', fs_category: null, debit_total: '0', credit_total: '1000' },
        { id: 'x', code: '4400', name: 'Devoluciones', account_type: 'revenue', fs_category: null, debit_total: '300', credit_total: '0' },
      ],
      'revenue'
    );
    // Netted: 1000 − 300. abs() would have said 1300.
    expect(section.total).toBe('700.0000');
    expect(section.accounts[1].amount).toBe('-300.0000');
  });

  it('nets income as revenue minus expenses, as strings', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'r', code: '4100', name: 'Ventas', account_type: 'revenue', fs_category: null, debit_total: '0', credit_total: '1000' },
        { id: 'e', code: '6100', name: 'Gastos', account_type: 'expense', fs_category: null, debit_total: '400', credit_total: '0' },
      ],
    });
    const is = await getIncomeStatement(ENTITY, { startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(is.net_income).toBe('600.0000');
    expect(typeof is.net_income).toBe('string');
  });
});

describe('general ledger', () => {
  it('filters by account id, code and dates in a stable parameter order', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryLedgerRows(ENTITY, { accountId: 'acc-1', startDate: '2026-01-01', endDate: '2026-03-31', limit: 50, offset: 10 });
    expect(sql(0)).toMatch(/WHERE a\.entity_id = \$1 AND je\.status = 'posted' AND a\.id = \$2 AND je\.entry_date >= \$3 AND je\.entry_date <= \$4/);
    expect(params(0)).toEqual([ENTITY, 'acc-1', '2026-01-01', '2026-03-31', 50, 10]);
  });

  it('accepts an account code, which is what a person types', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryLedgerRows(ENTITY, { accountCode: '1110', limit: 101 });
    expect(sql(0)).toMatch(/AND a\.code = \$2/);
    expect(params(0)).toEqual([ENTITY, '1110', 101, 0]);
  });

  it('counts with exactly the same predicate it selects with', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '412' }] });
    await countLedgerRows(ENTITY, { accountCode: '1110', startDate: '2026-01-01' });
    expect(sql(0)).toMatch(/SELECT COUNT\(\*\) as count/);
    expect(sql(0)).toMatch(/AND a\.code = \$2 AND je\.entry_date >= \$3/);
    expect(params(0)).toEqual([ENTITY, '1110', '2026-01-01']);
  });

  it('reports the true total next to a short page', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '412' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ debit_amount: '10.0000', credit_amount: null }, { debit_amount: null, credit_amount: '4.0000' }],
    });
    const gl = await getGeneralLedger(ENTITY, { limit: 2 });
    expect(gl.total).toBe(412);
    expect(gl.rows).toHaveLength(2);
    expect(gl.period_debits).toBe('10.0000');
    expect(gl.period_credits).toBe('4.0000');
  });

  it('treats a null amount as zero without turning it into NaN', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ debit_amount: null, credit_amount: null }] });
    const gl = await getGeneralLedger(ENTITY, { limit: 10 });
    expect(gl.period_debits).toBe('0.0000');
  });
});

describe('ageing', () => {
  it('receivables: only open invoices with something still due', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAgedReceivableRows(ENTITY, { asOfDate: '2026-08-25' });
    expect(sql(0)).toMatch(/i\.status IN \('sent', 'viewed', 'partially_paid', 'overdue'\)/);
    expect(sql(0)).toMatch(/AND i\.amount_due > 0/);
    expect(sql(0)).toMatch(/\(\$2::date - i\.due_date\) as days_overdue/);
    expect(params(0)).toEqual([ENTITY, '2026-08-25']);
  });

  it('payables: only bills that are approved, posted or partly paid', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAgedPayableRows(ENTITY, { asOfDate: '2026-08-25' });
    expect(sql(0)).toMatch(/b\.status IN \('approved', 'posted', 'partially_paid'\)/);
    expect(sql(0)).toMatch(/AND b\.amount_due > 0/);
  });

  it('orders by party for the API and by age for a human chasing money', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAgedPayableRows(ENTITY, { asOfDate: '2026-08-25', order: 'party' });
    expect(sql(0)).toMatch(/ORDER BY v\.company_name, b\.due_date/);

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAgedPayableRows(ENTITY, { asOfDate: '2026-08-25', order: 'overdue' });
    expect(sql(1)).toMatch(/ORDER BY days_overdue DESC, v\.company_name/);
  });

  it('the order option cannot smuggle SQL in: it is a closed choice', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAgedPayableRows(ENTITY, { asOfDate: '2026-08-25', order: 'x; DROP TABLE bills' as never });
    expect(sql(0)).toMatch(/ORDER BY v\.company_name, b\.due_date$/);
    expect(sql(0)).not.toMatch(/DROP TABLE/);
  });

  it('totals the amount due over every open document, not over the page', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { amount_due: '1000.0000' }, { amount_due: '2000.0000' }, { amount_due: '3000.0000' },
      ],
    });
    const aging = await getAgedReceivables(ENTITY, { asOfDate: '2026-08-25', limit: 1 });
    expect(aging.rows).toHaveLength(1);
    expect(aging.total).toBe(3);
    expect(aging.total_due).toBe('6000.0000');
  });

  it('payables total the same way', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ amount_due: '1160.0000' }, { amount_due: '2900.0000' }] });
    const aging = await getAgedPayables(ENTITY, { asOfDate: '2026-08-25' });
    expect(aging.total_due).toBe('4060.0000');
  });
});

describe('resolvePeriodRange — the entity owns the definition of a period', () => {
  it('prefers a fiscal period matched by name over calendar arithmetic', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'fp-8', period_name: 'August 2026', start_date: '2026-08-01', end_date: '2026-08-31' }],
    });
    const range = await resolvePeriodRange(ENTITY, 'August 2026');
    expect(range.fiscal_period_id).toBe('fp-8');
    expect(range.matched_fiscal_period).toBe(true);
    expect(params(0)).toEqual([ENTITY, 'August 2026']);
  });

  it('falls back to the calendar month and SAYS it did not match a period', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no period named 2026-02
    mockQuery.mockResolvedValueOnce({ rows: [] }); // none with those exact bounds
    const range = await resolvePeriodRange(ENTITY, '2026-02');
    expect(range).toMatchObject({
      start_date: '2026-02-01',
      end_date: '2026-02-28',
      matched_fiscal_period: false,
    });
  });

  it('gets February right in a leap year', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect((await resolvePeriodRange(ENTITY, '2028-02')).end_date).toBe('2028-02-29');
  });

  it('adopts a fiscal period whose bounds coincide with the calendar expression', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'fp-1', period_name: '2026-01', start_date: '2026-01-01', end_date: '2026-01-31' }],
    });
    const range = await resolvePeriodRange(ENTITY, '2026-01');
    expect(range.fiscal_period_id).toBe('fp-1');
    expect(range.matched_fiscal_period).toBe(true);
  });

  it('understands quarters and fiscal years', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await resolvePeriodRange(ENTITY, '2026-Q3')).toMatchObject({ start_date: '2026-07-01', end_date: '2026-09-30' });
    expect(await resolvePeriodRange(ENTITY, 'FY2026')).toMatchObject({ start_date: '2026-01-01', end_date: '2026-12-31' });
  });

  it('spans a..b by taking the start of one and the end of the other', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const range = await resolvePeriodRange(ENTITY, '2026-01..2026-06');
    expect(range).toMatchObject({ start_date: '2026-01-01', end_date: '2026-06-30' });
  });

  it('refuses a range that runs backwards instead of returning nothing', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(resolvePeriodRange(ENTITY, '2026-06..2026-01')).rejects.toThrow(ValidationError);
  });

  it('names the periods it knows when nothing matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // exact
    mockQuery.mockResolvedValueOnce({ rows: [] }); // fuzzy
    mockQuery.mockResolvedValueOnce({ rows: [{ period_name: 'January 2026' }] });
    await expect(resolvePeriodRange(ENTITY, 'brumario')).rejects.toThrow(/Known periods: January 2026/);
  });

  it('spans several periods when one name matches many', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no exact match
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'fp-1', period_name: 'Q1 M1', start_date: '2026-01-01', end_date: '2026-01-31' },
        { id: 'fp-2', period_name: 'Q1 M2', start_date: '2026-02-01', end_date: '2026-02-28' },
      ],
    });
    const range = await resolvePeriodRange(ENTITY, 'Q1');
    expect(range).toMatchObject({ start_date: '2026-01-01', end_date: '2026-02-28', matched_fiscal_period: false });
    // Without a single period there is no id to hand on: saying so beats guessing.
    expect(range.fiscal_period_id).toBeUndefined();
  });

  it('every period lookup is scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await resolvePeriodRange(ENTITY, '2026-03');
    for (const call of mockQuery.mock.calls) {
      expect(String(call[0])).toMatch(/entity_id = \$1/);
      expect((call[1] as unknown[])[0]).toBe(ENTITY);
    }
  });
});
