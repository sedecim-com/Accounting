import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError, NotImplementedError, ValidationError } from '../../../utils/errors.js';
import {
  createEmployee,
  getEmployee,
  listEmployees,
  updateSalary,
  terminateEmployee,
} from '../../../services/payroll/common/employee-service.js';
import {
  createPaySchedule,
  generatePayPeriods,
} from '../../../services/payroll/common/pay-period-service.js';
import {
  createPayRun,
  calculatePayRun,
  approvePayRun,
  markPayRunPaid,
} from '../../../services/payroll/common/pay-run-service.js';
import { postPayRunToGL } from '../../../services/payroll/common/gl-posting-service.js';
import { generateAndStampCfdiNomina } from '../../../services/payroll/mx/cfdi-nomina-generator.js';
import { generateSuaFile } from '../../../services/payroll/mx/sua-generator.js';
import { calculateFiniquito } from '../../../services/payroll/mx/finiquito-calculator.js';
import { generateW2 } from '../../../services/payroll/usa/forms/w2-generator.js';
import { generateForm941 } from '../../../services/payroll/usa/forms/form-941-generator.js';
import { generateForm940 } from '../../../services/payroll/usa/forms/form-940-generator.js';
import { generateW3, generateEfw2File } from '../../../services/payroll/usa/forms/w3-generator.js';
import {
  createBenefitPlan,
  electBenefit,
  listBenefitPlans,
  listEmployeeElections,
} from '../../../services/payroll/usa/benefits/benefits-service.js';
import { generateIdseBatch } from '../../../services/payroll/integrations/imss-idse-adapter.js';
import { generateNachaFile } from '../../../services/payroll/usa/nacha-generator.js';
import { PAY_RUN_TYPES } from '../../../database/enums.js';

const router = Router();

const meta = (req: Request) => ({
  request_id: req.headers['x-request-id'],
  timestamp: new Date().toISOString(),
  version: 'v1',
});

// ─── Request schemas ───
const createEmployeeSchema = z.object({
  entity_id: z.string().uuid().optional(),
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  email: z.string().email().optional(),
  country_code: z.enum(['MX', 'US']),
  hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'YYYY-MM-DD'),
  // Country-specific (one of these blocks)
  rfc: z.string().optional(),
  curp: z.string().optional(),
  nss: z.string().optional(),
  sbc: z.union([z.string(), z.number()]).optional(),
  ssn_encrypted: z.string().optional(),
  work_state: z.string().optional(),
  residence_state: z.string().optional(),
  work_city: z.string().optional(),
  w4_data: z.record(z.unknown()).optional(),
  salary_type: z.enum(['salary', 'hourly']).optional(),
  annual_salary: z.union([z.string(), z.number()]).optional(),
  hourly_rate: z.union([z.string(), z.number()]).optional(),
}).passthrough();

const compensationChangeSchema = z.object({
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  salary_type: z.enum(['salary', 'hourly']),
  annual_salary: z.union([z.string(), z.number()]).optional(),
  hourly_rate: z.union([z.string(), z.number()]).optional(),
  reason: z.string().optional(),
});

const createPayRunSchema = z.object({
  pay_period_id: z.string().uuid(),
  // El vocabulario sale de src/database/enums.ts, no de una copia a mano.
  // Aceptaba 'finiquito', que el CHECK no tiene: la petición pasaba la
  // validación y Postgres lanzaba 23514, o sea un 500 en vez de un 422.
  // El valor canónico de un finiquito es 'final'.
  run_type: z.enum(PAY_RUN_TYPES).default('regular'),
  notes: z.string().optional(),
}).passthrough();

const electBenefitSchema = z.object({
  employee_id: z.string().uuid(),
  benefit_plan_id: z.string().uuid(),
  election_type: z.enum(['percentage', 'fixed_amount']),
  election_value: z.union([z.string(), z.number()]),
  effective_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
});

const createBenefitPlanSchema = z.object({
  entity_id: z.string().uuid().optional(),
  plan_name: z.string().min(1),
  plan_type: z.enum(['401k', 'roth_401k', 'hsa', 'fsa', 'dcfsa', 'health_insurance', 'dental', 'vision', 'life']),
  is_pre_tax: z.boolean().default(true),
  annual_limit: z.union([z.string(), z.number()]).optional(),
  employer_match_formula: z.record(z.unknown()).nullable().optional(),
}).passthrough();

// ---------- Employees ----------
router.get('/employees', requirePermission('payroll:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const entityId = (req.query.entity_id as string) || req.entityId!;
  const rows = await listEmployees(req.tenantId!, {
    entity_id: entityId,
    status: req.query.status as string | undefined,
    country: req.query.country as string | undefined,
  });
  res.json({ data: rows, meta: meta(req) });
}));

router.get('/employees/:id', requirePermission('payroll:read'), asyncHandler(async (req: Request, res: Response) => {
  const emp = await getEmployee(req.params.id);
  res.json({ data: emp, meta: meta(req) });
}));

router.post(
  '/employees',
  requirePermission('payroll:create'),
  requireEntityAccess,
  validateBody(createEmployeeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = await createEmployee({
      ...req.body,
      tenant_id: req.tenantId!,
      entity_id: req.body.entity_id || req.entityId!,
      created_by: req.user!.user_id,
    });
    res.status(201).json({ data: { id }, meta: meta(req) });
  })
);

router.post(
  '/employees/:id/compensation',
  requirePermission('payroll:update'),
  validateBody(compensationChangeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { effective_date, salary_type, annual_salary, hourly_rate, reason } = req.body;
    await updateSalary(
      req.params.id,
      { salary_type, annual_salary, hourly_rate },
      effective_date,
      reason || '',
      req.user!.user_id
    );
    res.json({ data: { ok: true }, meta: meta(req) });
  })
);

router.post('/employees/:id/terminate', requirePermission('payroll:update'), asyncHandler(async (req: Request, res: Response) => {
  const { termination_date, termination_reason } = req.body;
  if (!termination_date) throw new ValidationError('termination_date required');
  await terminateEmployee(req.params.id, termination_date, termination_reason || '');
  res.json({ data: { ok: true }, meta: meta(req) });
}));

// ---------- Pay schedules & periods ----------
router.post('/pay-schedules', requirePermission('payroll:create'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const id = await createPaySchedule({
    ...req.body,
    tenant_id: req.tenantId!,
    entity_id: req.body.entity_id || req.entityId!,
  });
  res.status(201).json({ data: { id }, meta: meta(req) });
}));

router.post('/pay-schedules/:id/generate-periods', requirePermission('payroll:create'), asyncHandler(async (req: Request, res: Response) => {
  const { count = 24 } = req.body;
  const ids = await generatePayPeriods(req.params.id, count);
  res.json({ data: { period_ids: ids }, meta: meta(req) });
}));

router.get('/pay-periods', requirePermission('payroll:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const entityId = (req.query.entity_id as string) || req.entityId!;
  const result = await query(
    `SELECT pp.* FROM pay_periods pp
     JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id
     WHERE ps.entity_id = $1
     ORDER BY pp.period_start DESC LIMIT 100`,
    [entityId]
  );
  res.json({ data: result.rows, meta: meta(req) });
}));

// ---------- Pay runs ----------
router.post(
  '/pay-runs',
  requirePermission('payroll:create'),
  validateBody(createPayRunSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = await createPayRun({
      ...req.body,
      tenant_id: req.tenantId!,
      created_by: req.user!.user_id,
    });
    res.status(201).json({ data: { id }, meta: meta(req) });
  })
);

router.post(
  '/pay-runs/:id/calculate',
  requirePermission('payroll:create'),
  asyncHandler(async (req: Request, res: Response) => {
    await calculatePayRun(req.params.id, {
      ...req.body,
      tenant_id: req.tenantId!,
      created_by: req.user!.user_id,
    });
    const r = await query(`SELECT * FROM pay_runs WHERE id = $1`, [req.params.id]);
    res.json({ data: r.rows[0], meta: meta(req) });
  })
);

router.post(
  '/pay-runs/:id/approve',
  requirePermission('payroll:approve'),
  asyncHandler(async (req: Request, res: Response) => {
    await approvePayRun(req.params.id, req.user!.user_id);
    res.json({ data: { ok: true }, meta: meta(req) });
  })
);

router.post(
  '/pay-runs/:id/post-to-gl',
  requirePermission('payroll:approve'),
  asyncHandler(async (req: Request, res: Response) => {
    const journalEntryId = await postPayRunToGL(req.params.id, req.user!.user_id);
    res.json({ data: { journal_entry_id: journalEntryId }, meta: meta(req) });
  })
);

router.post(
  '/pay-runs/:id/mark-paid',
  requirePermission('payroll:approve'),
  asyncHandler(async (req: Request, res: Response) => {
    await markPayRunPaid(req.params.id);
    res.json({ data: { ok: true }, meta: meta(req) });
  })
);

router.get('/pay-runs/:id', requirePermission('payroll:read'), asyncHandler(async (req: Request, res: Response) => {
  const run = await query(`SELECT * FROM pay_runs WHERE id = $1`, [req.params.id]);
  if (run.rows.length === 0) throw new NotFoundError('PayRun', req.params.id);
  const paychecks = await query(`SELECT * FROM paychecks WHERE pay_run_id = $1`, [req.params.id]);
  res.json({ data: { ...run.rows[0], paychecks: paychecks.rows }, meta: meta(req) });
}));

// ---------- MX CFDI payroll (Nomina complement) ----------
router.post('/paychecks/:id/cfdi-nomina', requirePermission('payroll:approve'), asyncHandler(async (req: Request, res: Response) => {
  const result = await generateAndStampCfdiNomina(req.params.id, { tenantId: req.tenantId!, userId: req.user!.user_id });
  res.json({ data: result, meta: meta(req) });
}));

// ---------- MX SUA ----------
router.post('/sua', requirePermission('payroll:approve'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, year, month } = req.body;
  if (!year || !month) throw new ValidationError('year, month required');
  const result = await generateSuaFile(req.tenantId!, entity_id || req.entityId!, year, month);
  res.json({ data: result, meta: meta(req) });
}));

// ---------- MX Finiquito (severance settlement) ----------
router.post('/finiquito', requirePermission('payroll:create'), asyncHandler(async (req: Request, res: Response) => {
  const result = await calculateFiniquito(req.body);
  res.json({ data: result, meta: meta(req) });
}));

// ---------- USA W-2 ----------
router.post('/w2', requirePermission('payroll:approve'), asyncHandler(async (req: Request, res: Response) => {
  const { employee_id, tax_year } = req.body;
  if (!employee_id || !tax_year) throw new ValidationError('employee_id, tax_year required');
  const result = await generateW2(employee_id, tax_year);
  res.json({ data: result, meta: meta(req) });
}));

// ---------- USA Form 941 ----------
router.post('/form-941', requirePermission('payroll:approve'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, tax_year, quarter } = req.body;
  if (!tax_year || !quarter) throw new ValidationError('tax_year, quarter required');
  const result = await generateForm941(req.tenantId!, entity_id || req.entityId!, tax_year, quarter);
  res.json({ data: result, meta: meta(req) });
}));

// ---------- USA Form 940 ----------
router.post('/form-940', requirePermission('payroll:approve'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, tax_year } = req.body;
  if (!tax_year) throw new ValidationError('tax_year required');
  const result = await generateForm940(req.tenantId!, entity_id || req.entityId!, tax_year);
  res.json({ data: result, meta: meta(req) });
}));

// ---------- USA NACHA ----------
router.post('/nacha', requirePermission('payroll:approve'), asyncHandler(async (req: Request, res: Response) => {
  const { pay_run_id, company_info } = req.body;
  if (!pay_run_id || !company_info) throw new ValidationError('pay_run_id, company_info required');
  const result = await generateNachaFile(pay_run_id, company_info);
  res.json({ data: result, meta: meta(req) });
}));

// ---------- USA W-3 / EFW2 ----------
router.post('/w3', requirePermission('payroll:approve'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, tax_year } = req.body;
  if (!tax_year) throw new ValidationError('tax_year required');
  const result = await generateW3(req.tenantId!, entity_id || req.entityId!, tax_year);
  res.json({ data: result, meta: meta(req) });
}));

router.post('/efw2', requirePermission('payroll:approve'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, tax_year, submitter } = req.body;
  if (!tax_year || !submitter) throw new ValidationError('tax_year, submitter required');
  const result = await generateEfw2File(req.tenantId!, entity_id || req.entityId!, tax_year, submitter);
  res.json({ data: result, meta: meta(req) });
}));

// ---------- Benefits ----------
router.get('/benefit-plans', requirePermission('payroll:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const entityId = (req.query.entity_id as string) || req.entityId!;
  const rows = await listBenefitPlans(entityId);
  res.json({ data: rows, meta: meta(req) });
}));

router.post(
  '/benefit-plans',
  requirePermission('payroll:create'),
  requireEntityAccess,
  validateBody(createBenefitPlanSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const id = await createBenefitPlan({
      ...req.body,
      tenant_id: req.tenantId!,
      entity_id: req.body.entity_id || req.entityId!,
    });
    res.status(201).json({ data: { id }, meta: meta(req) });
  })
);

router.get('/employees/:id/benefit-elections', requirePermission('payroll:read'), asyncHandler(async (req: Request, res: Response) => {
  const rows = await listEmployeeElections(req.params.id);
  res.json({ data: rows, meta: meta(req) });
}));

router.post(
  '/employees/:id/benefit-elections',
  requirePermission('payroll:update'),
  validateBody(electBenefitSchema.partial({ employee_id: true })),
  asyncHandler(async (req: Request, res: Response) => {
    const id = await electBenefit({ ...req.body, employee_id: req.params.id });
    res.status(201).json({ data: { id }, meta: meta(req) });
  })
);

// ---------- MX IMSS IDSE ----------
// Wrapped in asyncHandler, unlike its neighbours: this is the endpoint the
// four 501s above tell the caller to use instead, and it now refuses a
// malformed SBC with a ValidationError. Left as a bare `async` handler, that
// throw would be an unforwarded rejection under Express 4 — the request would
// hang instead of answering 422, which is a worse answer than the one we
// withdrew. The rest of this file has the same latent bug; see the note in
// the lane report.
router.post('/imss-idse/batch', requirePermission('payroll:approve'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, movements } = req.body;
  if (!Array.isArray(movements)) throw new ValidationError('movements[] required');
  const result = await generateIdseBatch(req.tenantId!, entity_id || req.entityId!, movements);
  res.json({ data: result, meta: meta(req) });
}));

// ============================================================
// WITHDRAWN TRANSMISSION ENDPOINTS
//
// These four answered 200 with a folio, a submission id and a
// status of 'accepted' or 'pending' while transmitting nothing to
// anyone. mnemosine holds no IMSS FIEL, no IRS MeF transmitter
// credentials and no SSA BSO account; there was no socket, no
// signature and no acknowledgement behind any of them.
//
// They now answer 501 and name the file to produce and the portal
// that accepts it. They are NOT deleted: a 404 would read as a
// wrong URL and invite a retry, and the whole hazard here was a
// caller who believed they had filed.
// ============================================================

router.post('/imss-idse/submit', requirePermission('payroll:approve'), asyncHandler(async () => {
  throw new NotImplementedError(
    'mnemosine does not transmit to IMSS. Generate the batch with POST /v1/payroll/imss-idse/batch, ' +
      'then upload the .txt yourself at idse.imss.gob.mx with the patron FIEL, and record the IMSS ' +
      'acuse on the filing. Nothing was sent by this call.'
  );
}));

// ---------- IRS e-file (941/940) — WITHDRAWN ----------
router.post('/irs-efile/:filing_id', requirePermission('payroll:approve'), asyncHandler(async () => {
  throw new NotImplementedError(
    'mnemosine does not transmit to the IRS. Produce the form with POST /v1/payroll/form-941 or ' +
      'POST /v1/payroll/form-940 and file it yourself — through an authorized e-file provider, or by ' +
      'mail — then record the confirmation number on the filing. Nothing was sent by this call.'
  );
}));

router.get('/irs-efile/status/:submission_id', requirePermission('payroll:read'), asyncHandler(async () => {
  throw new NotImplementedError(
    'mnemosine has no submission to ask the IRS about: it never transmitted one. Acknowledgements come ' +
      'from whoever filed on your behalf; record the result on the filing yourself.'
  );
}));

// ---------- SSA BSO (W-2 EFW2 bundle) — WITHDRAWN ----------
router.post('/ssa-bso/submit', requirePermission('payroll:approve'), requireEntityAccess, asyncHandler(async () => {
  throw new NotImplementedError(
    'mnemosine does not upload to the SSA. Produce the EFW2 file with POST /v1/payroll/efw2, run it ' +
      'through AccuWage, upload it yourself at the SSA Business Services Online portal, and record the ' +
      'WFID it returns on the filing. Nothing was uploaded by this call.'
  );
}));

// ---------- Employee self-service ----------
router.get('/me/paychecks', asyncHandler(async (req: Request, res: Response) => {
  // Map user → employee via email (simple MVP)
  const userResult = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [req.user!.user_id]);
  if (userResult.rows.length === 0) throw new NotFoundError('User', req.user!.user_id);
  const empResult = await query<{ id: string }>(
    `SELECT id FROM employees WHERE email = $1 AND tenant_id = $2 LIMIT 1`,
    [userResult.rows[0].email, req.tenantId!]
  );
  if (empResult.rows.length === 0) return res.json({ data: [], meta: meta(req) });
  const paychecks = await query(
    `SELECT p.id, p.gross_earnings, p.net_pay, p.created_at, pp.pay_date, pp.period_start, pp.period_end
     FROM paychecks p
     JOIN pay_runs pr ON pr.id = p.pay_run_id AND pr.status IN ('approved', 'paid')
     JOIN pay_periods pp ON pp.id = pr.pay_period_id
     WHERE p.employee_id = $1 ORDER BY pp.pay_date DESC LIMIT 100`,
    [empResult.rows[0].id]
  );
  res.json({ data: paychecks.rows, meta: meta(req) });
}));

router.get('/me/w2/:tax_year', asyncHandler(async (req: Request, res: Response) => {
  const userResult = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [req.user!.user_id]);
  if (userResult.rows.length === 0) throw new NotFoundError('User', req.user!.user_id);
  const empResult = await query<{ id: string }>(
    `SELECT id FROM employees WHERE email = $1 AND tenant_id = $2 LIMIT 1`,
    [userResult.rows[0].email, req.tenantId!]
  );
  if (empResult.rows.length === 0) throw new NotFoundError('Employee', req.user!.user_id);
  const w2 = await query(
    `SELECT data FROM tax_form_filings
     WHERE employee_id = $1 AND form_type = 'w2' AND tax_year = $2`,
    [empResult.rows[0].id, parseInt(req.params.tax_year, 10)]
  );
  if (w2.rows.length === 0) throw new NotFoundError('W-2', req.params.tax_year);
  res.json({ data: w2.rows[0], meta: meta(req) });
}));

// ---------- Paychecks & filings ----------
router.get('/paychecks/:id', requirePermission('payroll:read'), asyncHandler(async (req: Request, res: Response) => {
  const pc = await query(`SELECT * FROM paychecks WHERE id = $1`, [req.params.id]);
  if (pc.rows.length === 0) throw new NotFoundError('Paycheck', req.params.id);
  const earnings = await query(`SELECT * FROM paycheck_earnings WHERE paycheck_id = $1`, [req.params.id]);
  const deductions = await query(`SELECT * FROM paycheck_deductions WHERE paycheck_id = $1`, [req.params.id]);
  const taxes = await query(`SELECT * FROM paycheck_taxes WHERE paycheck_id = $1`, [req.params.id]);
  res.json({ data: { ...pc.rows[0], earnings: earnings.rows, deductions: deductions.rows, taxes: taxes.rows }, meta: meta(req) });
}));

router.get('/tax-filings', requirePermission('payroll:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const entityId = (req.query.entity_id as string) || req.entityId!;
  const result = await query(
    `SELECT id, form_type, tax_year, period, status, filed_at, created_at
     FROM tax_form_filings WHERE entity_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [entityId]
  );
  res.json({ data: result.rows, meta: meta(req) });
}));

export default router;
