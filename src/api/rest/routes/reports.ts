import { Router, Request, Response } from 'express';
import Decimal from 'decimal.js';
import { query } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { ValidationError } from '../../../utils/errors.js';
import type { TrialBalanceRow, BalanceSheetSection, IncomeStatementSection } from '../../../types/index.js';

const router = Router();

// GET /v1/reports/trial-balance
router.get('/trial-balance', requirePermission('reports:read'), requireEntityAccess, async (req: Request, res: Response) => {
  const { entity_id, fiscal_period_id, as_of_date, account_level = '5', format = 'json' } = req.query;
  const entityId = entity_id as string || req.entityId;

  if (!entityId) throw new ValidationError('entity_id is required');

  let whereClause = 'WHERE a.entity_id = $1 AND a.is_active = true';
  const params: unknown[] = [entityId];
  let paramIndex = 2;

  const maxLevel = parseInt(account_level as string, 10);
  whereClause += ` AND a.account_level <= $${paramIndex++}`;
  params.push(maxLevel);

  let periodFilter = '';
  if (fiscal_period_id) {
    periodFilter = `AND je.fiscal_period_id = $${paramIndex++}`;
    params.push(fiscal_period_id);
  } else if (as_of_date) {
    periodFilter = `AND je.entry_date <= $${paramIndex++}`;
    params.push(as_of_date);
  }

  const result = await query<TrialBalanceRow>(
    `SELECT
      a.id as account_id,
      a.code as account_code,
      a.name as account_name,
      a.account_type,
      COALESCE(SUM(CASE WHEN jel.debit_amount IS NOT NULL THEN jel.debit_amount ELSE 0 END), 0) as debit_total,
      COALESCE(SUM(CASE WHEN jel.credit_amount IS NOT NULL THEN jel.credit_amount ELSE 0 END), 0) as credit_total,
      COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) as ending_balance
    FROM accounts a
    LEFT JOIN (journal_entry_lines jel
               JOIN journal_entries je
                 ON je.id = jel.journal_entry_id
                AND je.status = 'posted' ${periodFilter})
           ON jel.account_id = a.id
    ${whereClause}
    GROUP BY a.id, a.code, a.name, a.account_type
    ORDER BY a.code`,
    params
  );

  const totalDebits = result.rows.reduce((sum, r) => sum.plus(new Decimal(r.debit_total)), new Decimal(0));
  const totalCredits = result.rows.reduce((sum, r) => sum.plus(new Decimal(r.credit_total)), new Decimal(0));

  res.json({
    data: {
      entity_id: entityId,
      accounts: result.rows,
      totals: {
        total_debits: totalDebits.toFixed(4),
        total_credits: totalCredits.toFixed(4),
        is_balanced: totalDebits.minus(totalCredits).abs().lessThanOrEqualTo('0.01'),
      },
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// GET /v1/reports/balance-sheet
router.get('/balance-sheet', requirePermission('reports:read'), requireEntityAccess, async (req: Request, res: Response) => {
  const { entity_id, as_of_date } = req.query;
  const entityId = entity_id as string || req.entityId;

  if (!entityId || !as_of_date) throw new ValidationError('entity_id and as_of_date are required');

  const result = await query<{ account_type: string; fs_category: string; code: string; name: string; id: string; balance: string }>(
    `SELECT
      a.account_type, a.fs_category, a.code, a.name, a.id,
      COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) as balance
    FROM accounts a
    LEFT JOIN (journal_entry_lines jel
               JOIN journal_entries je
                 ON je.id = jel.journal_entry_id
                AND je.status = 'posted' AND je.entry_date <= $2)
           ON jel.account_id = a.id
    WHERE a.entity_id = $1 AND a.is_active = true
      AND a.account_type IN ('asset', 'liability', 'equity', 'contra_asset', 'contra_liability', 'contra_equity')
    GROUP BY a.id, a.account_type, a.fs_category, a.code, a.name
    HAVING COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) != 0
    ORDER BY a.code`,
    [entityId, as_of_date]
  );

  // naturalSign flips the debit-positive raw balance into each section's
  // natural sign so contra accounts NET against their section instead of
  // inflating it (summing abs() overstated assets by accumulated depreciation).
  const buildSection = (types: string[], name: string, naturalSign: 1 | -1): BalanceSheetSection => {
    const accounts = result.rows.filter((r) => types.includes(r.account_type));
    const categorized = new Map<string, typeof accounts>();
    for (const acct of accounts) {
      const cat = acct.fs_category || 'other';
      if (!categorized.has(cat)) categorized.set(cat, []);
      categorized.get(cat)!.push(acct);
    }

    const subsections = Array.from(categorized.entries()).map(([cat, accts]) => ({
      name: cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      total: accts.reduce((sum, a) => sum.plus(a.balance), new Decimal(0)).times(naturalSign).toFixed(4),
      accounts: accts.map((a) => ({ id: a.id, code: a.code, name: a.name, balance: new Decimal(a.balance).times(naturalSign).toFixed(4) })),
    }));

    return {
      name,
      total: subsections.reduce((sum, s) => sum.plus(new Decimal(s.total)), new Decimal(0)).toFixed(4),
      subsections,
    };
  };

  const assets = buildSection(['asset', 'contra_asset'], 'Assets', 1);
  const liabilities = buildSection(['liability', 'contra_liability'], 'Liabilities', -1);
  const equity = buildSection(['equity', 'contra_equity'], 'Equity', -1);

  res.json({
    data: {
      entity_id: entityId,
      as_of_date,
      assets,
      liabilities,
      equity,
      total_liabilities_and_equity: new Decimal(liabilities.total).plus(new Decimal(equity.total)).toFixed(4),
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// GET /v1/reports/income-statement
router.get('/income-statement', requirePermission('reports:read'), requireEntityAccess, async (req: Request, res: Response) => {
  const { entity_id, start_date, end_date } = req.query;
  const entityId = entity_id as string || req.entityId;

  if (!entityId || !start_date || !end_date) throw new ValidationError('entity_id, start_date, end_date are required');

  const result = await query<{ account_type: string; fs_category: string; code: string; name: string; id: string; amount: string }>(
    `SELECT
      a.account_type, a.fs_category, a.code, a.name, a.id,
      COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) as amount
    FROM accounts a
    LEFT JOIN (journal_entry_lines jel
               JOIN journal_entries je
                 ON je.id = jel.journal_entry_id
                AND je.status = 'posted' AND je.entry_date BETWEEN $2 AND $3)
           ON jel.account_id = a.id
    WHERE a.entity_id = $1 AND a.is_active = true
      AND a.account_type IN ('revenue', 'expense')
    GROUP BY a.id, a.account_type, a.fs_category, a.code, a.name
    HAVING COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) != 0
    ORDER BY a.code`,
    [entityId, start_date, end_date]
  );

  // Revenue is credit-natural (raw debit-positive amount is negative), so flip
  // the sign instead of abs() — abs() would inflate sections holding
  // contra-natural rows (e.g. sales returns booked as revenue-type debits).
  const buildIS = (type: string): IncomeStatementSection => {
    const naturalSign = type === 'revenue' ? -1 : 1;
    const accounts = result.rows.filter((r) => r.account_type === type);
    const total = accounts.reduce((sum, a) => sum.plus(a.amount), new Decimal(0)).times(naturalSign);
    return {
      name: type === 'revenue' ? 'Revenue' : 'Expenses',
      total: total.toFixed(4),
      accounts: accounts.map((a) => ({ id: a.id, code: a.code, name: a.name, amount: new Decimal(a.amount).times(naturalSign).toFixed(4) })),
    };
  };

  const revenue = buildIS('revenue');
  const expenses = buildIS('expense');
  const netIncome = new Decimal(revenue.total).minus(new Decimal(expenses.total));

  res.json({
    data: {
      entity_id: entityId,
      start_date, end_date,
      revenue, expenses,
      net_income: netIncome.toFixed(4),
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// GET /v1/reports/aged-receivables
router.get('/aged-receivables', requirePermission('reports:read'), requireEntityAccess, async (req: Request, res: Response) => {
  const { entity_id, as_of_date } = req.query;
  const entityId = entity_id as string || req.entityId;
  const asOf = as_of_date as string || new Date().toISOString().split('T')[0];

  const result = await query(
    `SELECT
      c.id as customer_id, c.company_name as customer_name,
      i.id as invoice_id, i.invoice_number, i.invoice_date, i.due_date,
      i.total_amount, i.amount_due,
      ($2::date - i.due_date) as days_overdue
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    WHERE i.entity_id = $1 AND i.status IN ('sent', 'viewed', 'partially_paid', 'overdue')
      AND i.amount_due > 0
    ORDER BY c.company_name, i.due_date`,
    [entityId, asOf]
  );

  res.json({
    data: { entity_id: entityId, as_of_date: asOf, invoices: result.rows },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// GET /v1/reports/aged-payables
router.get('/aged-payables', requirePermission('reports:read'), requireEntityAccess, async (req: Request, res: Response) => {
  const { entity_id, as_of_date } = req.query;
  const entityId = entity_id as string || req.entityId;
  const asOf = as_of_date as string || new Date().toISOString().split('T')[0];

  const result = await query(
    `SELECT
      v.id as vendor_id, v.company_name as vendor_name,
      b.id as bill_id, b.bill_number, b.bill_date, b.due_date,
      b.total_amount, b.amount_due,
      ($2::date - b.due_date) as days_overdue
    FROM bills b
    JOIN vendors v ON v.id = b.vendor_id
    WHERE b.entity_id = $1 AND b.status IN ('approved', 'posted', 'partially_paid')
      AND b.amount_due > 0
    ORDER BY v.company_name, b.due_date`,
    [entityId, asOf]
  );

  res.json({
    data: { entity_id: entityId, as_of_date: asOf, bills: result.rows },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// GET /v1/reports/cash-flow
router.get('/cash-flow', requirePermission('reports:read'), requireEntityAccess, async (req: Request, res: Response) => {
  const { entity_id, start_date, end_date, method = 'indirect' } = req.query;
  const entityId = entity_id as string || req.entityId;

  if (!entityId || !start_date || !end_date) throw new ValidationError('entity_id, start_date, end_date are required');

  // Operating Activities
  const netIncome = await query<{ amount: string }>(
    `SELECT COALESCE(
      SUM(CASE WHEN a.account_type = 'revenue' THEN COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)
               WHEN a.account_type = 'expense' THEN COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)
               ELSE 0 END), 0) as amount
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted'
       AND je.entry_date BETWEEN $2 AND $3
     JOIN accounts a ON a.id = jel.account_id
     WHERE a.entity_id = $1 AND a.account_type IN ('revenue', 'expense')`,
    [entityId, start_date, end_date]
  );

  // Depreciation add-back
  const depreciation = await query<{ amount: string }>(
    `SELECT COALESCE(SUM(jel.debit_amount), 0) as amount
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted'
       AND je.entry_date BETWEEN $2 AND $3 AND je.entry_type = 'auto_depreciation'
     JOIN accounts a ON a.id = jel.account_id
     WHERE a.entity_id = $1`,
    [entityId, start_date, end_date]
  );

  // AR changes (investing in receivables)
  const arChange = await query<{ amount: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) as amount
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted'
       AND je.entry_date BETWEEN $2 AND $3
     JOIN accounts a ON a.id = jel.account_id
     WHERE a.entity_id = $1 AND a.account_subtype = 'current_asset'
       AND a.name ILIKE '%receivable%'`,
    [entityId, start_date, end_date]
  );

  // AP changes
  const apChange = await query<{ amount: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)), 0) as amount
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.status = 'posted'
       AND je.entry_date BETWEEN $2 AND $3
     JOIN accounts a ON a.id = jel.account_id
     WHERE a.entity_id = $1 AND a.account_subtype = 'current_liability'
       AND a.name ILIKE '%payable%'`,
    [entityId, start_date, end_date]
  );

  // Investing Activities (fixed asset purchases)
  const assetPurchases = await query<{ amount: string }>(
    `SELECT COALESCE(SUM(acquisition_cost), 0) as amount
     FROM fixed_assets
     WHERE entity_id = $1 AND acquisition_date BETWEEN $2 AND $3`,
    [entityId, start_date, end_date]
  );

  const assetDisposals = await query<{ amount: string }>(
    `SELECT COALESCE(SUM(disposal_amount), 0) as amount
     FROM fixed_assets
     WHERE entity_id = $1 AND disposal_date BETWEEN $2 AND $3 AND disposal_amount IS NOT NULL`,
    [entityId, start_date, end_date]
  );

  const netIncomeAmt = new Decimal(netIncome.rows[0].amount);
  const depreciationAmt = new Decimal(depreciation.rows[0].amount);
  const arChangeAmt = new Decimal(arChange.rows[0].amount).negated();
  const apChangeAmt = new Decimal(apChange.rows[0].amount);
  const operatingCashFlow = netIncomeAmt.plus(depreciationAmt).plus(arChangeAmt).plus(apChangeAmt);

  const assetPurchasesAmt = new Decimal(assetPurchases.rows[0].amount).negated();
  const assetDisposalsAmt = new Decimal(assetDisposals.rows[0].amount);
  const investingCashFlow = assetPurchasesAmt.plus(assetDisposalsAmt);

  const totalCashFlow = operatingCashFlow.plus(investingCashFlow);

  res.json({
    data: {
      entity_id: entityId,
      start_date, end_date, method,
      operating_activities: {
        net_income: netIncomeAmt.toFixed(4),
        adjustments: {
          depreciation: depreciationAmt.toFixed(4),
          accounts_receivable_change: arChangeAmt.toFixed(4),
          accounts_payable_change: apChangeAmt.toFixed(4),
        },
        total: operatingCashFlow.toFixed(4),
      },
      investing_activities: {
        asset_purchases: assetPurchasesAmt.toFixed(4),
        asset_disposals: assetDisposalsAmt.toFixed(4),
        total: investingCashFlow.toFixed(4),
      },
      financing_activities: { total: '0.0000' },
      net_cash_flow: totalCashFlow.toFixed(4),
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// GET /v1/reports/general-ledger
router.get('/general-ledger', requirePermission('reports:read'), requireEntityAccess, async (req: Request, res: Response) => {
  const { entity_id, account_id, start_date, end_date, page = '1', per_page = '100' } = req.query;
  const entityId = entity_id as string || req.entityId;

  if (!entityId) throw new ValidationError('entity_id is required');

  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(250, parseInt(per_page as string, 10));
  const offset = (pageNum - 1) * perPage;

  let whereClause = 'WHERE a.entity_id = $1 AND je.status = \'posted\'';
  const params: unknown[] = [entityId];
  let idx = 2;

  if (account_id) { whereClause += ` AND a.id = $${idx++}`; params.push(account_id); }
  if (start_date) { whereClause += ` AND je.entry_date >= $${idx++}`; params.push(start_date); }
  if (end_date) { whereClause += ` AND je.entry_date <= $${idx++}`; params.push(end_date); }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id
     JOIN accounts a ON a.id = jel.account_id
     ${whereClause}`,
    params
  );

  const result = await query(
    `SELECT
      a.id as account_id, a.code as account_code, a.name as account_name,
      je.id as journal_entry_id, je.entry_number, je.entry_date, je.entry_type, je.description as entry_description,
      jel.line_number, jel.debit_amount, jel.credit_amount, jel.description as line_description,
      jel.cost_center_id, jel.project_id
     FROM journal_entry_lines jel
     JOIN journal_entries je ON je.id = jel.journal_entry_id
     JOIN accounts a ON a.id = jel.account_id
     ${whereClause}
     ORDER BY a.code, je.entry_date, je.entry_number, jel.line_number
     LIMIT $${idx++} OFFSET $${idx}`,
    [...params, perPage, offset]
  );

  const totalCount = parseInt(countResult.rows[0].count, 10);

  res.json({
    data: result.rows,
    pagination: {
      page: pageNum, per_page: perPage,
      total_pages: Math.ceil(totalCount / perPage),
      total_count: totalCount,
      next_cursor: null, prev_cursor: null,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

export default router;
