import { Router, Request, Response } from 'express';
import Decimal from 'decimal.js';
import { query } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/async-handler.js';
import { ValidationError } from '../../../utils/errors.js';
import {
  getTrialBalance,
  getBalanceSheet,
  getIncomeStatement,
  getGeneralLedger,
  getAgedReceivables,
  getAgedPayables,
  type AgedReceivableRow,
  type AgedPayableRow,
} from '../../../services/reporting/report-service.js';

// ============================================================
// /v1/reports/*
//
// The SQL and the sign conventions moved to
// src/services/reporting/report-service.ts, so the CLI and the agent
// tools compute a trial balance the same way this endpoint does. What
// stays here is the HTTP contract and nothing else: the query-string
// names, the defaults, the response envelope and the exact key set of
// each row. The projections below are deliberate — the service returns a
// superset (ids, customer_number, vendor_number) that this surface has
// never published, and an endpoint is not the place to start.
// ============================================================

const router = Router();

const meta = (req: Request) => ({
  request_id: req.headers['x-request-id'],
  timestamp: new Date().toISOString(),
  version: 'v1',
});

// GET /v1/reports/trial-balance
router.get('/trial-balance', requirePermission('reports:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, fiscal_period_id, as_of_date, account_level = '5' } = req.query;
  const entityId = entity_id as string || req.entityId;

  if (!entityId) throw new ValidationError('entity_id is required');

  const report = await getTrialBalance(entityId, {
    maxLevel: parseInt(account_level as string, 10),
    fiscalPeriodId: fiscal_period_id as string | undefined,
    asOfDate: as_of_date as string | undefined,
  });

  res.json({
    data: {
      entity_id: entityId,
      accounts: report.rows,
      totals: report.totals,
    },
    meta: meta(req),
  });
}));

// GET /v1/reports/balance-sheet
router.get('/balance-sheet', requirePermission('reports:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, as_of_date } = req.query;
  const entityId = entity_id as string || req.entityId;

  if (!entityId || !as_of_date) throw new ValidationError('entity_id and as_of_date are required');

  const report = await getBalanceSheet(entityId, { asOfDate: as_of_date as string });

  res.json({
    data: {
      entity_id: entityId,
      as_of_date,
      assets: report.assets,
      liabilities: report.liabilities,
      equity: report.equity,
      total_liabilities_and_equity: report.total_liabilities_and_equity,
    },
    meta: meta(req),
  });
}));

// GET /v1/reports/income-statement
router.get('/income-statement', requirePermission('reports:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, start_date, end_date } = req.query;
  const entityId = entity_id as string || req.entityId;

  if (!entityId || !start_date || !end_date) throw new ValidationError('entity_id, start_date, end_date are required');

  const report = await getIncomeStatement(entityId, {
    startDate: start_date as string,
    endDate: end_date as string,
  });

  res.json({
    data: {
      entity_id: entityId,
      start_date, end_date,
      revenue: report.revenue,
      expenses: report.expenses,
      net_income: report.net_income,
    },
    meta: meta(req),
  });
}));

/** The key set this endpoint has always published, held stable by hand. */
const publishedInvoice = (r: AgedReceivableRow) => ({
  customer_id: r.customer_id,
  customer_name: r.customer_name,
  invoice_id: r.invoice_id,
  invoice_number: r.invoice_number,
  invoice_date: r.invoice_date,
  due_date: r.due_date,
  total_amount: r.total_amount,
  amount_due: r.amount_due,
  days_overdue: r.days_overdue,
});

const publishedBill = (r: AgedPayableRow) => ({
  vendor_id: r.vendor_id,
  vendor_name: r.vendor_name,
  bill_id: r.bill_id,
  bill_number: r.bill_number,
  bill_date: r.bill_date,
  due_date: r.due_date,
  total_amount: r.total_amount,
  amount_due: r.amount_due,
  days_overdue: r.days_overdue,
});

// GET /v1/reports/aged-receivables
router.get('/aged-receivables', requirePermission('reports:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, as_of_date } = req.query;
  const entityId = entity_id as string || req.entityId;
  const asOf = as_of_date as string || new Date().toISOString().split('T')[0];

  // Unlike its siblings this endpoint has never validated entity_id; the cast
  // keeps that behaviour rather than turning a silent empty result into a 422.
  const report = await getAgedReceivables(entityId as string, { asOfDate: asOf, order: 'party' });

  res.json({
    data: { entity_id: entityId, as_of_date: asOf, invoices: report.rows.map(publishedInvoice) },
    meta: meta(req),
  });
}));

// GET /v1/reports/aged-payables
router.get('/aged-payables', requirePermission('reports:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, as_of_date } = req.query;
  const entityId = entity_id as string || req.entityId;
  const asOf = as_of_date as string || new Date().toISOString().split('T')[0];

  const report = await getAgedPayables(entityId as string, { asOfDate: asOf, order: 'party' });

  res.json({
    data: { entity_id: entityId, as_of_date: asOf, bills: report.rows.map(publishedBill) },
    meta: meta(req),
  });
}));

// GET /v1/reports/cash-flow
//
// NOT extracted. The three defects the catalog records are still here and
// moving them into the service would only make them look official: the
// `method` parameter is echoed but never changes the calculation (there is
// no direct method), financing activities are hardcoded to zero, and AR/AP
// are detected by `name ILIKE '%receivable%'`. A statement of cash flows
// that only pretends to have a method does not belong in a shared service
// until it has one.
router.get('/cash-flow', requirePermission('reports:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
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
    meta: meta(req),
  });
}));

// GET /v1/reports/general-ledger
router.get('/general-ledger', requirePermission('reports:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, account_id, start_date, end_date, page = '1', per_page = '100' } = req.query;
  const entityId = entity_id as string || req.entityId;

  if (!entityId) throw new ValidationError('entity_id is required');

  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(250, parseInt(per_page as string, 10));
  const offset = (pageNum - 1) * perPage;

  const report = await getGeneralLedger(entityId, {
    accountId: account_id as string | undefined,
    startDate: start_date as string | undefined,
    endDate: end_date as string | undefined,
    limit: perPage,
    offset,
  });

  res.json({
    data: report.rows,
    pagination: {
      page: pageNum, per_page: perPage,
      total_pages: Math.ceil(report.total / perPage),
      total_count: report.total,
      next_cursor: null, prev_cursor: null,
    },
    meta: meta(req),
  });
}));

export default router;
