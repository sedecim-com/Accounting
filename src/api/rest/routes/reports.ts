import { Router, Request, Response } from 'express';
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
import {
  getCashFlowStatement,
  type MetodoDeFlujo,
} from '../../../services/reporting/cash-flow-service.js';
import { toCsv, csvAttachment } from '../../../utils/csv.js';

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

/**
 * Columns of the CSV rendering of the trial balance, in order.
 *
 * These are exactly the columns queryTrialBalanceRows projects -- so the CSV
 * and the JSON `data.accounts` carry the same facts in two encodings, and
 * neither one invents a field.
 *
 * The totals block stays out of the CSV. A trailing total row is the classic
 * way to break every consumer that sums a column; callers who want the
 * is_balanced check ask for JSON, which is where it lives.
 */
const TRIAL_BALANCE_CSV_COLUMNS = [
  'account_id',
  'account_code',
  'account_name',
  'account_type',
  'debit_total',
  'credit_total',
  'ending_balance',
] as const;

/**
 * F07a · LAS DOS COLUMNAS DEL ANEXO 24, Y POR QUÉ VAN Y VIENEN.
 *
 * El nodo Ctas de la BalanzaComprobacion pide cuatro cifras —SaldoIni, Debe,
 * Haber y SaldoFin— y este CSV es con lo que un despacho arma el papel de
 * trabajo de la entrega. Publicaba tres, así que la cuarta columna que el
 * servicio ya calcula se caía en el borde de la ruta sin que nada lo dijera.
 *
 * Se añaden SÓLO cuando la balanza tiene un ANTES (un periodo fiscal o un
 * rango con fecha de inicio). Emitirlas siempre pondría una celda vacía en la
 * balanza acumulada, y una celda vacía en una hoja de cálculo se lee como un
 * cero: sería declarar que el contribuyente abrió en nada, que es exactamente
 * la mentira que F07a vino a matar. La cabecera cambia con el alcance porque
 * el documento cambia con el alcance.
 *
 * El orden es el del Anexo 24 —SaldoIni, Debe, Haber, SaldoFin— con
 * `ending_balance` conservado en su sitio: para un rango NO es un saldo final
 * sino el movimiento neto (Debe menos Haber), y los consumidores que ya leen
 * esa columna la siguen encontrando donde estaba.
 */
const TRIAL_BALANCE_CSV_ANEXO24 = [
  'account_id',
  'account_code',
  'account_name',
  'account_type',
  'beginning_balance',
  'debit_total',
  'credit_total',
  'ending_balance',
  'final_balance',
] as const;

// GET /v1/reports/trial-balance
router.get('/trial-balance', requirePermission('reports:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, fiscal_period_id, as_of_date, account_level = '5', format = 'json' } = req.query;

  // Rechazado, no servido en silencio como JSON. Contestar ?format=xlsx con un
  // cuerpo JSON es exactamente como ?format=csv pasó ignorado tanto tiempo.
  if (format !== 'json' && format !== 'csv') {
    throw new ValidationError(`format must be 'json' or 'csv', got '${String(format)}'`, 'format');
  }
  const entityId = entity_id as string || req.entityId;

  if (!entityId) throw new ValidationError('entity_id is required');

  const report = await getTrialBalance(entityId, {
    maxLevel: parseInt(account_level as string, 10),
    fiscalPeriodId: fiscal_period_id as string | undefined,
    asOfDate: as_of_date as string | undefined,
  });

  if (format === 'csv') {
    res.type('text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', csvAttachment(`trial-balance-${entityId}`));
    res.send(
      toCsv(report.inicial ? TRIAL_BALANCE_CSV_ANEXO24 : TRIAL_BALANCE_CSV_COLUMNS, report.rows)
    );
    return;
  }

  res.json({
    data: {
      entity_id: entityId,
      accounts: report.rows,
      totals: report.totals,
      // Sólo viaja cuando el rango contiene el cierre del ejercicio: la
      // balanza lo cuenta y tiene que decirlo, o no se puede atar contra un
      // estado de resultados que lo deja fuera.
      ...(report.closing ? { closing_entries: report.closing } : {}),
      // F07a · La cuarta columna sin su procedencia no se puede firmar. Este
      // bloque dice de dónde salió el SaldoIni (del mayor o del arrastre del
      // cierre duro), si ya es FIRME —lo jura el periodo ANTERIOR, no el
      // consultado— y, sobre todo, `descuadres`: las cuentas donde
      // SaldoIni + Debe − Haber no da el SaldoFin, que es el recálculo que la
      // autoridad rehace sobre el archivo sellado. Calcularlo y no publicarlo
      // dejaba la balanza con cara de correcta. Viaja por lo mismo que
      // `closing_entries` y sólo cuando la balanza tiene un ANTES.
      ...(report.inicial ? { opening_balance: report.inicial } : {}),
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
      ...(report.closing ? { closing_entries: report.closing } : {}),
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

/**
 * `?method=` en el idioma de la API (inglés) y en el del panel (español).
 *
 * Un valor que no se reconoce se RECHAZA en vez de caer al indirecto: pedir
 * «direct» y recibir el indirecto sin aviso es el defecto que G1b vino a
 * corregir, y pedir «dirceto» y recibirlo también lo sería.
 */
function metodoPedido(valor: string): MetodoDeFlujo {
  const v = valor.toLowerCase();
  if (v === 'direct' || v === 'directo') return 'directo';
  if (v === 'indirect' || v === 'indirecto') return 'indirecto';
  throw new ValidationError(`method must be 'indirect' or 'direct', received '${valor}'`);
}

// GET /v1/reports/cash-flow
//
// EXTRACTED (G1b). The engine lived here, entire, and was the reason the CLI
// and the agent had no statement of cash flows at all. It now lives in
// src/services/reporting/cash-flow-service.ts, and what stays here is the
// HTTP contract: the query-string names, the defaults and the envelope.
//
// The published key set DOES change, and deliberately. The old body carried
// `adjustments.accounts_receivable_change`, `accounts_payable_change` and
// `asset_purchases`/`asset_disposals` — names for three concepts the engine
// could not compute: the first two were matched with `name ILIKE
// '%receivable%'` against a chart seeded in Spanish (so they were always
// '0.0000'), and the last two came from the `fixed_assets` master rather than
// the ledger. Keeping the names over the corrected numbers would publish a
// concept the sections no longer carry; the account-level `lines` now say
// what moved, and `self_check` says whether every account that moved landed
// in a section — which is what decides whether this document can tie to the
// bank at all. The three section keys keep their published names.
//
// `method` is no longer echoed. Asking for the direct method used to return
// the indirect one labelled as direct; now it fails with what is missing.
router.get('/cash-flow', requirePermission('reports:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, start_date, end_date, method } = req.query;
  const entityId = entity_id as string || req.entityId;

  if (!entityId || !start_date || !end_date) throw new ValidationError('entity_id, start_date, end_date are required');

  const statement = await getCashFlowStatement(entityId, {
    startDate: start_date as string,
    endDate: end_date as string,
    ...(method ? { metodo: metodoPedido(method as string) } : {}),
  });

  res.json({ data: statement, meta: meta(req) });
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
