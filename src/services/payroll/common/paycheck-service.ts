import { v4 as uuidv4 } from 'uuid';
import { daysBetween, toCalendarDate } from '../../../utils/calendar-date.js';
import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../../database/connection.js';
import { NotFoundError } from '../../../utils/errors.js';
import { taxRegistry } from '../tax-engine/tax-registry.js';
// This module is what reads the registry, so it owns filling it: every entry
// point that calculates (the CLI, REST, a spec) gets the calculators without
// remembering a side-effect import of its own (#586).
import '../tax-engine/register-all.js';
import { getEmployeeYtd, getEmployeeSutaYtd } from '../tax-engine/ytd-service.js';
import { calculateGarnishments } from '../usa/garnishments/garnishment-engine.js';
import {
  leerRegistroDelSubsidio,
  notaDelSubsidioEntregado,
  type RegistroSubsidioLeido,
} from '../mx/subsidio-entregado.js';
import { isrPartsOf, type IsrExemptionContext } from '../mx/isr-exemption.js';
import {
  MINIMUM_WAGE_ISR_DETAIL,
  baseForTariff,
  minimumWageIsr,
  minimumWageIsrDetail,
  minimumWageIsrNote,
} from '../mx/minimum-wage-worker.js';
import {
  readEmploymentSubsidyRounding,
  isSeparatePaycheck,
  readEmploymentSubsidySeparateRun,
  otherPaychecksInPeriod,
  CONTRIBUTIONS_ELSEWHERE_DETAIL,
  subsidyOfPaycheckInPeriod,
  EMPLOYMENT_SUBSIDY_EXCESS_LAW,
  applyEmploymentSubsidy,
  readEmploymentSubsidyExcessRule,
  type EmploymentSubsidyExcessRule,
} from '../mx/employment-subsidy.js';
import { readOldAgeBandEdge, readOldAgeMinimumWageArea } from '../mx/old-age-band.js';
import {
  readSeparatePaymentIsr,
  isrOfPaycheckInPeriod,
  SEPARATE_PAYMENT_ISR_DETAIL,
} from '../mx/separate-payment-isr.js';
import type { TaxInput, TaxOutput, PayFrequency } from '../tax-engine/tax-engine.interface.js';

// ============================================================
// PAYCHECK SERVICE
// Takes employee + pay period + earnings → computes gross to net.
// Dispatches to tax calculators per jurisdiction.
//
// F08a · DOS DEFECTOS QUE VIVÍAN AQUÍ, Y LO QUE LOS CORRIGE
//
// 1. EL DESGLOSE SE CALCULABA Y SE TIRABA. Cada componente —isr, subsidio,
//    imss del trabajador y del patrón, infonavit, fit, fica, futa, suta— se
//    calculaba con su base y su tasa, se resumía en un par de columnas de
//    `paychecks` y el detalle se perdía. `paycheck_taxes` existe desde la
//    008 con exactamente la forma que hacía falta y ningún camino la
//    escribía: los formularios que la leen reportaban CEROS con aspecto de
//    números. Ahora cada componente calculado deja su renglón, con base
//    gravable y tasa, DENTRO de la misma transacción que inserta el recibo.
//
// 2. EL SUBSIDIO QUE EL TRABAJADOR NO RECIBÍA. Ver `../mx/subsidio-entregado.ts`.
// ============================================================

export interface EarningLine {
  earning_type: string;
  hours?: number;
  rate?: number;
  amount: number;
  is_taxable_fit?: boolean;
  is_taxable_fica?: boolean;
  is_taxable_futa?: boolean;
  is_taxable_state?: boolean;
  is_taxable_isr?: boolean;
  is_taxable_imss?: boolean;
  is_supplemental?: boolean;
  cfdi_clave_sat?: string;
  description?: string;
}

export interface DeductionLine {
  deduction_type: string;
  is_pre_tax: boolean;
  is_employer_contribution?: boolean;
  amount: number;
  benefit_plan_id?: string;
  garnishment_id?: string;
  cfdi_clave_sat?: string;
  description?: string;
}

export interface PaycheckInput {
  tenant_id: string;
  pay_run_id: string;
  employee_id: string;
  // NO `pay_period_id` (TEN-12). It used to be here, and the service used it:
  // measured, the same own employee got an IMSS quota of 133.00 with a 28-day
  // period sent in the request body, against 71.25 with the 15-day period of
  // the run the paycheck belongs to. A run already HAS its period; letting the
  // caller name another one let the body decide the money. It is not kept as
  // an ignored optional field either — a parameter that is silently discarded
  // is one a caller believes still chooses something.
  earnings: EarningLine[];
  deductions?: DeductionLine[];
  hours_worked?: number;
}

export interface CalculatedPaycheck {
  paycheck_id: string;
  gross_earnings: number;
  pre_tax_deductions: number;
  post_tax_deductions: number;
  employee_taxes: number;
  employer_taxes: number;
  net_pay: number;
  /**
   * Subsidio al empleo que excedió al ISR y que el patrón ENTREGA en efectivo
   * al trabajador. Va en cadena con cuatro decimales —y no en `number` como
   * el resto de esta interfaz, que es anterior a la regla— porque es dinero
   * que nace en este tramo y no hay razón para nacerlo mal.
   */
  subsidio_entregado_efectivo: string;
  breakdown: Record<string, number>;
  /** The period's payment date, 'YYYY-MM-DD', as the paycheck read it: the run checks its dated parameters on it. */
  pay_date: string;
  country_code: string;
}

/**
 * Un renglón de `paycheck_taxes` listo para escribirse: el componente tal
 * como lo calculó su calculadora, con la base sobre la que se aplicó.
 */
interface RenglonDeImpuesto {
  tax_type: string;
  jurisdiction: string;
  employee_employer: 'EE' | 'ER';
  taxable_wages: string;
  rate: string | null;
  tax_amount: string;
  is_credit: boolean;
  calculation_notes: string | null;
}

/** Lo que un renglón puede sobrescribir de la salida de su calculadora. */
interface AjustesDelRenglon {
  tax_type?: string;
  taxable_wages?: Decimal.Value;
  tax_amount?: Decimal.Value;
  is_credit?: boolean;
  notas?: string;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => new Decimal(a).plus(b).toNumber(), 0);
}

/**
 * What a paycheck still owes of one contribution of its period, once the
 * period's other paychecks are counted (MNE-001-658, #601).
 *
 * THE DAYS OF A PERIOD CONTRIBUTE ONCE. IMSS quotas are owed for the
 * contribution days of the period on the worker's SBC (LSS arts. 27 to 29 and
 * 39), and INFONAVIT on the same base and days (INFONAVIT law, art. 29 frs.
 * II and III): the law charges the days, never the payment, and the year-end
 * bonus is already inside the SBC through its integration (LSS art. 27). Each
 * paycheck used to charge its period's whole quota, so the fortnight plus a
 * year-end bonus in its own run charged the same fifteen days twice. The
 * engine's figure is the quota OF THE PERIOD; a paycheck charges what the
 * others have not, and never less than zero. It follows the employment
 * subsidy, which already reads those paychecks (#430), and reuses its one read.
 *
 * No panel key: the law settles that the days contribute once (ADR-0006). The
 * paycheck calculated first carries them, whatever its run type.
 */
function leftInPeriod(ofPeriod: TaxOutput, charged: Decimal, base: Decimal): TaxOutput {
  if (!charged.greaterThan(0)) return ofPeriod;
  const quota = new Decimal(ofPeriod.tax_amount);
  return {
    ...ofPeriod,
    tax_amount: Decimal.max(0, quota.minus(charged)).toNumber(),
    taxable_wages_used: Decimal.max(0, new Decimal(ofPeriod.taxable_wages_used).minus(base)).toNumber(),
    // The parts of the period's quota no longer add up to what is charged.
    breakdown: undefined,
    notes:
      `${ofPeriod.notes ? `${ofPeriod.notes} · ` : ''}quota of the period ${quota.toFixed(2)}; its other ` +
      `paychecks already charged ${charged.toFixed(2)} (the days of a period contribute once)`,
  };
}

/** The run, the employee and the period of one paycheck, each checked against the one before. */
async function paycheckScope(input: Pick<PaycheckInput, 'tenant_id' | 'pay_run_id' | 'employee_id'>) {
  // THE THREE KEYS, AND THE ORDER IS THE POINT (TEN-12, #235).
  //
  // The tenant boundary already lived in the SQL of all three, and for a good
  // reason written here before: the paycheck is inserted with the tenant the
  // request brings, so an employee of ANOTHER tenant produced a whole paycheck
  // filed under the tenant that asked. That closed the tenant axis. The ENTITY
  // axis stayed open on all three: measured against Postgres, a session of
  // company A calculating its own run with an `employee_id` of sibling company
  // B wrote B's employee's paycheck into A's run. The damage is the one this
  // file already described for tenants — the GL posting sums paychecks by
  // `pay_run_id`, so B's wages land in A's ledger, and B's employer liability
  // loses the paycheck. And the period came from the request body.
  //
  // So the RUN goes first: it is the one key the route already scoped (T9c),
  // and the other two hang from it. The employee must belong to the run's
  // entity — reached by path, because `pay_runs` has no `entity_id` — and the
  // period is the run's own, never one the caller names.
  const runResult = await query<{ id: string; pay_period_id: string; entity_id: string; run_type: string }>(
    `SELECT r.id, r.pay_period_id, ps.entity_id, r.run_type
       FROM pay_runs r
       JOIN pay_periods pp ON pp.id = r.pay_period_id
       JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id
      WHERE r.id = $1 AND r.tenant_id = $2`,
    [input.pay_run_id, input.tenant_id]
  );
  // 404, not a plain Error: a 500 for a missing id next to a success for a
  // foreign one tells the caller which ids exist.
  if (runResult.rows.length === 0) throw new NotFoundError('Pay run', input.pay_run_id);
  const run = runResult.rows[0];

  const empResult = await query<{
    id: string;
    country_code: 'MX' | 'US';
    sbc: string | null;
    annual_salary: string | null;
    tipo_regimen_sat: string | null;
    riesgo_puesto: string | null;
    infonavit_credit_type: string | null;
    infonavit_credit_value: string | null;
    w4_data: Record<string, unknown>;
    work_state: string | null;
    residence_state: string | null;
    work_city: string | null;
  }>(
    `SELECT id, country_code, sbc, annual_salary, tipo_regimen_sat, riesgo_puesto,
            infonavit_credit_type, infonavit_credit_value,
            w4_data, work_state, residence_state, work_city
     FROM employees WHERE id = $1 AND tenant_id = $2 AND entity_id = $3`,
    [input.employee_id, input.tenant_id, run.entity_id]
  );
  if (empResult.rows.length === 0) throw new NotFoundError('Employee', input.employee_id);
  const emp = empResult.rows[0];

  // `entity_id` sale del calendario de pago —es donde vive— y hace falta para
  // acotar la política del subsidio a la entidad, igual que hace el posteo.
  const periodResult = await query<{
    period_start: string;
    period_end: string;
    pay_date: string;
    tax_year: number;
    frequency: PayFrequency;
    entity_id: string;
  }>(
    `SELECT pp.period_start, pp.period_end, pp.pay_date, pp.tax_year,
            ps.frequency, ps.entity_id
     FROM pay_periods pp JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id
     WHERE pp.id = $1 AND pp.tenant_id = $2`,
    [run.pay_period_id, input.tenant_id]
  );
  if (periodResult.rows.length === 0) throw new NotFoundError('Pay period', run.pay_period_id);
  const period = periodResult.rows[0];

  // #243 · Días de calendario, inclusive. La resta de milisegundos daba un
  // día de menos o de más según dónde estuviera el servidor, y este número
  // divide el sueldo.
  const daysInPeriod = daysBetween(period.period_start, period.period_end) + 1;
  return { run, emp, period, daysInPeriod };
}

/** What the ISR exemptions need of one paycheck; null outside Mexico. */
function isrContextOf(
  input: Pick<PaycheckInput, 'tenant_id' | 'employee_id'>,
  scope: Awaited<ReturnType<typeof paycheckScope>>
): IsrExemptionContext | null {
  const { run, emp, period, daysInPeriod } = scope;
  return emp.country_code === 'MX'
    ? {
        tenantId: input.tenant_id,
        employeeId: input.employee_id,
        payRunId: run.id,
        payDate: toCalendarDate(period.pay_date),
        entityId: period.entity_id,
        periodDays: daysInPeriod,
        annualSalary: emp.annual_salary,
      }
    : null;
}

/**
 * Checks one employee's overtime lines against LISR art. 93 fr. I and the LFT
 * limit WITHOUT writing anything (MNE-001-110).
 *
 * `calculatePayRun` calls this for every input first, so a refused line stops
 * the run before its first paycheck is calculated. When this was written each
 * paycheck committed on its own and the tenth employee's refusal left nine
 * written; since MNE-001-657 the run is one transaction, and this check is
 * what makes the refusal cheap. It runs the same reader the calculation runs,
 * so the two cannot disagree.
 */
export async function checkOvertimeLines(input: PaycheckInput): Promise<void> {
  const overtime = input.earnings.filter((e) => e.earning_type === 'overtime');
  if (overtime.length === 0) return;
  await isrPartsOf(overtime, isrContextOf(input, await paycheckScope(input)));
}

/**
 * The bracket-table gaps one US employee's paycheck would hit, WITHOUT writing
 * anything (MNE-001-353). Empty for a non-US employee.
 *
 * FIT and SIT throw when the table for the employee's filing status is not
 * seeded. Found mid-run, that names one employee and one table at a time (and,
 * before MNE-001-657 made the run one transaction, left the earlier paychecks
 * written). `calculatePayRun` collects these for every employee first. It runs
 * the same calculators on a nominal wage, so this check and the calculation
 * cannot disagree about which table is read.
 */
export async function checkUsTaxTables(input: PaycheckInput): Promise<string[]> {
  const { emp, period } = await paycheckScope(input);
  if (emp.country_code !== 'US') return [];
  const probe: TaxInput = {
    taxable_wages: 1,
    pay_frequency: period.frequency,
    tax_year: period.tax_year,
    pay_date: toCalendarDate(period.pay_date),
    w4_data: emp.w4_data as TaxInput['w4_data'],
    state: emp.work_state || undefined,
  };
  const calculators = [taxRegistry.getRequired('US-FEDERAL', 'fit')];
  const sit = emp.work_state ? taxRegistry.get(`US-${emp.work_state}`, 'sit') : undefined;
  if (sit) calculators.push(sit);
  const problems: string[] = [];
  for (const calc of calculators) {
    try {
      await calc.calculate(probe);
    } catch (e) {
      problems.push(`employee ${input.employee_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return problems;
}

/**
 * Calculates one paycheck and writes it with its earnings, deductions and taxes.
 *
 * `tx` is the transaction of the run being calculated (MNE-001-657): the
 * paycheck is written on it, so it lives or dies with the whole run. Without
 * it the paycheck commits on its own, as a single paycheck always did. The
 * reads stay on the pool either way: none of them counts a paycheck of this
 * same run, so they need not see what the transaction has not committed.
 */
export async function calculatePaycheck(input: PaycheckInput, tx?: PoolClient): Promise<CalculatedPaycheck> {
  const scope = await paycheckScope(input);
  const { emp, period, daysInPeriod } = scope;

  // --- Gross + deductions ---
  const grossEarnings = sum(input.earnings.map((e) => e.amount));
  const deductions = input.deductions || [];
  const preTaxDeductions = sum(
    deductions.filter((d) => d.is_pre_tax && !d.is_employer_contribution).map((d) => d.amount)
  );
  const postTaxDeductions = sum(
    deductions.filter((d) => !d.is_pre_tax && !d.is_employer_contribution).map((d) => d.amount)
  );

  // --- Taxable bases ---
  const taxableFit = sum(
    input.earnings.filter((e) => e.is_taxable_fit !== false).map((e) => e.amount)
  ) - preTaxDeductions;
  const taxableFica = sum(
    input.earnings.filter((e) => e.is_taxable_fica !== false).map((e) => e.amount)
  ) - sum(deductions.filter((d) => d.is_pre_tax && !d.is_employer_contribution && d.deduction_type !== '401k' && d.deduction_type !== 'roth_401k').map((d) => d.amount));
  // 401k is pre-tax for FIT but NOT for FICA
  const taxableFuta = taxableFica;
  const taxableState = taxableFit;
  // Each earning's ISR parts (#297): the aguinaldo is exempt up to 30 UMA a
  // year (LISR art. 93 fr. XIV), overtime by half up to 5 UMA a week (fr. I),
  // and only the rest is taxed. The parts are written on the earning row, and
  // the ISR base is the sum of the taxable ones.
  const mx = isrContextOf(input, scope);
  const isrParts = await isrPartsOf(input.earnings, mx);
  const taxableIsr = sum(isrParts.map((p) => p.taxable.toNumber())) - preTaxDeductions;
  // NOTE(#296): the IMSS base is the period's SBC (capped at 25 UMA), not the
  // ISR base: it was `taxableIsr`, so exempt earnings and pre-tax deductions
  // leaked into `taxable_wages_imss`. It is set below from the IMSS engine,
  // the only place that knows the cap; zero outside Mexico.
  let taxableImss = 0;

  // --- YTD ---
  const ytd = await getEmployeeYtd(input.employee_id, period.tax_year, new Date(period.pay_date));

  const breakdown: Record<string, number> = {};

  // LOS ACUMULADORES DE IMPUESTO SON DECIMAL, no `number`.
  //
  // Eran `let x = 0; x += tax.tax_amount`, y sobre esa suma se calculan las
  // «disposable earnings» de los embargos: un centavo de coma flotante ahí
  // decide cuánto se le retiene a alguien por orden judicial.
  let employeeTaxes = new Decimal(0);
  let employerTaxes = new Decimal(0);

  // Lo que el trabajador ve descontado y NO es un impuesto retenido: hoy sólo
  // el crédito INFONAVIT (ver más abajo por qué no puede vivir con los
  // impuestos). Resta del neto igual, pero no del cálculo del embargo.
  let otrasRetencionesDelTrabajador = new Decimal(0);

  // --- Renglones de `paycheck_taxes` ---
  const renglones: RenglonDeImpuesto[] = [];

  /**
   * Apunta un componente calculado para que acabe en `paycheck_taxes`.
   *
   * Se llama junto a cada `breakdown.x = ...` a propósito: el defecto que se
   * está corrigiendo fue exactamente que el desglose se calculaba en un sitio
   * y no se persistía en ninguno, y dos bucles separados lo repetirían a la
   * primera calculadora nueva que alguien añada.
   */
  const apuntar = (out: TaxOutput, lado: 'EE' | 'ER', ajustes: AjustesDelRenglon = {}): void => {
    renglones.push({
      tax_type: ajustes.tax_type ?? out.tax_type,
      jurisdiction: out.jurisdiction,
      employee_employer: lado,
      taxable_wages: new Decimal(ajustes.taxable_wages ?? out.taxable_wages_used).toFixed(4),
      rate:
        out.rate_applied === undefined || out.rate_applied === null
          ? null
          : new Decimal(out.rate_applied).toFixed(6),
      tax_amount: new Decimal(ajustes.tax_amount ?? out.tax_amount).toFixed(4),
      is_credit: ajustes.is_credit ?? out.is_credit ?? false,
      calculation_notes: ajustes.notas ?? out.notes ?? null,
    });
  };

  const baseTaxInput: Omit<TaxInput, 'taxable_wages'> = {
    pay_frequency: period.frequency,
    tax_year: period.tax_year,
    // The dates of the act the law fixes (#242): payment for ISR and subsidy,
    // each contribution day for IMSS and INFONAVIT.
    pay_date: toCalendarDate(period.pay_date),
    period_start: toCalendarDate(period.period_start),
    period_end: toCalendarDate(period.period_end),
    w4_data: emp.w4_data as TaxInput['w4_data'],
    sbc_daily: emp.sbc ? parseFloat(emp.sbc) : undefined,
    days_in_period: Math.floor(daysInPeriod),
    riesgo_puesto: emp.riesgo_puesto || undefined,
    state: emp.work_state || undefined,
    residence_state: emp.residence_state || undefined,
    work_city: emp.work_city || undefined,
  };

  // Employment subsidy handed over in cash (Mexico). Zero while the ISR
  // absorbs the subsidy, and zero for every paycheck paid from 1 May 2024:
  // the law of the payment date decides (#600).
  let subsidioEntregado = new Decimal(0);
  let registroDelSubsidio: RegistroSubsidioLeido | null = null;
  // The excess over the ISR that the rule did not hand over, and the row of
  // `legal_parameters` that said so: the paycheck records which law it applied.
  let subsidyExcessNotPaid = new Decimal(0);
  let subsidyExcessRule: EmploymentSubsidyExcessRule | null = null;
  // What the period's other paychecks already charged of IMSS and INFONAVIT
  // (MNE-001-658): the audit trail says why a quota here is smaller or zero.
  let contributionsElsewhere: Record<string, string | number> | null = null;
  // Which treatment of the panel the ISR followed, when the paycheck shares
  // its period or is itself separate (MNE-001-739).
  let separatePaymentIsr: Record<string, string | number | boolean> | null = null;
  // How LISR art. 96, first paragraph, was read for a minimum-wage worker (MNE-001-923).
  let minimumWageIsrRecord: Record<string, string | number | null> | null = null;

  if (emp.country_code === 'US') {
    // FIT
    const fitCalc = taxRegistry.getRequired('US-FEDERAL', 'fit');
    const fit = await fitCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFit, ytd_wages: ytd.gross_wages });
    breakdown.fit = fit.tax_amount;
    employeeTaxes = employeeTaxes.plus(fit.tax_amount);
    apuntar(fit, 'EE', { taxable_wages: taxableFit });

    // FICA SS
    const ssCalc = taxRegistry.getRequired('US-FEDERAL', 'fica_ss');
    const ss = await ssCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica, ytd_wages: ytd.ss_taxable_wages });
    breakdown.fica_ss = ss.tax_amount;
    employeeTaxes = employeeTaxes.plus(ss.tax_amount);
    apuntar(ss, 'EE');

    const ssErCalc = taxRegistry.getRequired('US-FEDERAL', 'fica_ss_employer');
    const ssEr = await ssErCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica, ytd_wages: ytd.ss_taxable_wages });
    breakdown.fica_ss_employer = ssEr.tax_amount;
    employerTaxes = employerTaxes.plus(ssEr.tax_amount);
    apuntar(ssEr, 'ER', { tax_type: 'fica_ss' });

    // Medicare
    const medCalc = taxRegistry.getRequired('US-FEDERAL', 'fica_medicare');
    const med = await medCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica });
    breakdown.fica_medicare = med.tax_amount;
    employeeTaxes = employeeTaxes.plus(med.tax_amount);
    apuntar(med, 'EE');

    const medErCalc = taxRegistry.getRequired('US-FEDERAL', 'fica_medicare_employer');
    const medEr = await medErCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica });
    breakdown.fica_medicare_employer = medEr.tax_amount;
    employerTaxes = employerTaxes.plus(medEr.tax_amount);
    apuntar(medEr, 'ER', { tax_type: 'fica_medicare' });

    // Additional Medicare
    const addlCalc = taxRegistry.getRequired('US-FEDERAL', 'additional_medicare');
    const addl = await addlCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica, ytd_wages: ytd.medicare_taxable_wages });
    breakdown.additional_medicare = addl.tax_amount;
    employeeTaxes = employeeTaxes.plus(addl.tax_amount);
    apuntar(addl, 'EE');

    // FUTA
    const futaCalc = taxRegistry.getRequired('US-FEDERAL', 'futa');
    const futa = await futaCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFuta, ytd_wages: ytd.futa_taxable_wages });
    breakdown.futa = futa.tax_amount;
    employerTaxes = employerTaxes.plus(futa.tax_amount);
    apuntar(futa, 'ER');

    // State SIT + SUTA + SDI (if state has them)
    if (emp.work_state) {
      const juris = `US-${emp.work_state}`;
      const sitCalc = taxRegistry.get(juris, 'sit');
      if (sitCalc) {
        const sit = await sitCalc.calculate({ ...baseTaxInput, taxable_wages: taxableState });
        breakdown.sit = sit.tax_amount;
        employeeTaxes = employeeTaxes.plus(sit.tax_amount);
        apuntar(sit, 'EE', { taxable_wages: taxableState });
      }
      const sutaCalc = taxRegistry.get(juris, 'suta');
      if (sutaCalc) {
        // Per-state SUTA YTD (each state has its own wage base)
        const sutaYtd = await getEmployeeSutaYtd(
          input.employee_id, period.tax_year, emp.work_state, new Date(period.pay_date)
        );
        const suta = await sutaCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFuta, ytd_wages: sutaYtd });
        breakdown.suta = suta.tax_amount;
        employerTaxes = employerTaxes.plus(suta.tax_amount);
        apuntar(suta, 'ER');
      }
      const sdiCalc = taxRegistry.get(juris, 'sdi');
      if (sdiCalc) {
        const sdi = await sdiCalc.calculate({ ...baseTaxInput, taxable_wages: taxableState });
        if (sdi.tax_amount > 0) {
          breakdown.sdi = sdi.tax_amount;
          employeeTaxes = employeeTaxes.plus(sdi.tax_amount);
          apuntar(sdi, 'EE', { taxable_wages: taxableState });
        }
      }

      // Local (city) income taxes — try known locality codes for this state
      if (emp.work_city) {
        const cityCode3 = emp.work_city.toUpperCase().slice(0, 3);
        const localJuris = `US-${emp.work_state}-${cityCode3}`;
        const localCalc = taxRegistry.get(localJuris, 'local');
        if (localCalc) {
          const local = await localCalc.calculate({ ...baseTaxInput, taxable_wages: taxableState });
          if (local.tax_amount > 0) {
            breakdown.local = local.tax_amount;
            employeeTaxes = employeeTaxes.plus(local.tax_amount);
            apuntar(local, 'EE', { taxable_wages: taxableState });
          }
        }
      }
    }
  } else {
    // --- MEXICO ---
    // The worker's other paychecks of the same pay period, read once: the ISR,
    // the subsidy, IMSS and INFONAVIT below all count them.
    const otherRuns = await otherPaychecksInPeriod({
      tenantId: input.tenant_id,
      employeeId: input.employee_id,
      payRunId: scope.run.id,
      payPeriodId: scope.run.pay_period_id,
    });
    const separate = isSeparatePaycheck(scope.run.run_type, input.earnings);

    // WHO ONLY EARNS THE MINIMUM WAGE OF THEIR AREA SUFFERS NO WITHHOLDING
    // (LISR art. 96, first paragraph · #1076, MNE-001-923). Measured on the
    // ISR base of the worker's paychecks of the period; null for everyone
    // else, who costs no statement. See ../mx/minimum-wage-worker.ts.
    const minimumWage =
      mx &&
      (await minimumWageIsr({
        who: mx,
        frequency: period.frequency,
        taxableOfPeriod: otherRuns.taxableIsr.plus(taxableIsr),
        client: tx,
      }));
    const notWithheld = minimumWage?.treatment === 'not_withheld';

    const isrCalc = taxRegistry.getRequired('MX', 'isr');
    const isrOnOwnBase = await isrCalc.calculate({
      ...baseTaxInput,
      taxable_wages: baseForTariff(minimumWage, taxableIsr, otherRuns.taxableIsr),
    });
    let isr = isrOnOwnBase;
    // THE ISR OF A PAYMENT MADE APART (#601, MNE-001-739) is the panel's
    // answer: on the period's accumulated base (default), by the regulation's
    // optional procedure, or on this paycheck alone. A paycheck alone in its
    // period that is not separate asks nothing and keeps its figure.
    if (!notWithheld && (otherRuns.paychecks > 0 || separate)) {
      // On the run's transaction when there is one: one round trip, not four.
      const isrPolicy = await readSeparatePaymentIsr({ tenantId: input.tenant_id, entityId: period.entity_id }, tx);
      // The tariff is cached after its first read, so this sends no statement.
      const ofPeriod =
        isrPolicy.treatment === 'period_accumulated_base' && otherRuns.paychecks > 0
          ? await isrCalc.calculate({
              ...baseTaxInput,
              taxable_wages: baseForTariff(minimumWage, otherRuns.taxableIsr.plus(taxableIsr)),
            })
          : null;
      const amount = isrOfPaycheckInPeriod({
        treatment: isrPolicy.treatment,
        separate,
        otherPaychecks: otherRuns.paychecks,
        ownBase: isrOnOwnBase.tax_amount,
        onCombinedBase: ofPeriod?.tax_amount ?? null,
        alreadyCaused: otherRuns.isr,
      });
      separatePaymentIsr = {
        treatment: isrPolicy.treatment,
        answered_by_firm: isrPolicy.answeredByFirm,
        separate,
        other_paychecks: otherRuns.paychecks,
        other_taxable_isr: otherRuns.taxableIsr.toFixed(2),
        other_isr: otherRuns.isr.toFixed(2),
        // What the period carries with this paycheck.
        isr_of_period: otherRuns.isr.plus(amount).toFixed(2),
        isr_on_own_base: new Decimal(isrOnOwnBase.tax_amount).toFixed(2),
      };
      isr = {
        ...isrOnOwnBase,
        tax_amount: amount.toNumber(),
        notes:
          `${isrOnOwnBase.notes ?? 'ISR of the period'} · on its own base ${isrOnOwnBase.tax_amount.toFixed(2)}; ` +
          `other paychecks of the period ${otherRuns.paychecks}, base ${otherRuns.taxableIsr.toFixed(2)}, ` +
          `ISR caused ${otherRuns.isr.toFixed(2)}${separate ? ' · separate paycheck' : ''} [${isrPolicy.treatment}]`,
      };
    }
    // `isr` stays what the tariff gives on this paycheck, also when art. 96
    // withholds none of it: the employment subsidy is still measured against it.
    if (minimumWage) {
      minimumWageIsrRecord = minimumWageIsrDetail(minimumWage, isr.tax_amount);
      isr = { ...isr, notes: `${isr.notes ?? 'ISR of the period'} · ${minimumWageIsrNote(minimumWage, isr.tax_amount)}` };
    }
    breakdown.isr = notWithheld ? 0 : isr.tax_amount;

    // The decree leaves the rounding open, so the entity's policy decides it
    // (#298); the engine refuses to compute without it.
    const subCalc = taxRegistry.getRequired('MX', 'subsidio_empleo');
    const employmentSubsidyRounding = await readEmploymentSubsidyRounding({
      tenantId: input.tenant_id,
      entityId: period.entity_id,
    });
    const subsidyInput = {
      ...baseTaxInput,
      employment_subsidy_rounding: employmentSubsidyRounding,
    };
    const ownSubsidy = await subCalc.calculate({ ...subsidyInput, taxable_wages: taxableIsr });
    // ONE SUBSIDY PER PERIOD (#430, MNE-001-398): an aguinaldo paid in its own
    // run of a period whose fortnight already caused the subsidy got it again.
    // Another paycheck of the period, or a paycheck that is itself the
    // separate one (whatever was calculated first), hands the amount to the
    // policy.
    let sub = ownSubsidy;
    if (otherRuns.paychecks > 0 || separate) {
      const treatment = await readEmploymentSubsidySeparateRun({
        tenantId: input.tenant_id,
        entityId: period.entity_id,
      });
      const combined =
        treatment === 'recompute_on_combined_income' && otherRuns.paychecks > 0
          ? await subCalc.calculate({
              ...subsidyInput,
              taxable_wages: otherRuns.taxableIsr.plus(taxableIsr).toNumber(),
            })
          : null;
      const amount = subsidyOfPaycheckInPeriod({
        treatment,
        separate,
        own: ownSubsidy.tax_amount,
        onCombinedIncome: (combined ?? ownSubsidy).tax_amount,
        alreadyCaused: otherRuns.subsidy,
      });
      if (otherRuns.paychecks > 0 || !amount.equals(ownSubsidy.tax_amount)) {
        sub = {
          ...ownSubsidy,
          tax_amount: amount.toNumber(),
          notes:
            `${(combined ?? ownSubsidy).notes ?? 'Subsidio al empleo'} · otros recibos del periodo ya causaron ` +
            `${otherRuns.subsidy.toFixed(2)}${separate ? ' · recibo aparte' : ''} [${treatment}]`,
        };
      }
    }
    breakdown.subsidio_empleo = sub.tax_amount;

    // THE SUBSIDY IN EXCESS OF THE ISR FOLLOWS THE LAW OF THE PAYMENT DATE (#600).
    //
    // Until 30 April 2024 the employer hands the difference to the worker in
    // cash; from 1 May 2024 nothing is handed over and nothing is carried
    // forward. Which one applies is a dated row of `legal_parameters`, read on
    // the payment date like the ISR tariff and the amount of the subsidy; no
    // date and no default live here, and without a row in force the paycheck
    // is refused. (The line was once `Math.max(0, isr - sub)` for every date,
    // which dropped the cash of the old rule too.)
    subsidyExcessRule = await readEmploymentSubsidyExcessRule(toCalendarDate(period.pay_date));
    //
    // With nothing withheld (art. 96, first paragraph) nothing is credited
    // either: the cash of the rule before May 2024 is still the excess over
    // the tariff, and what the tariff would have absorbed is neither paid
    // nor credited.
    const applied = applyEmploymentSubsidy(isr.tax_amount, sub.tax_amount, subsidyExcessRule);
    const isrWithheld = notWithheld ? new Decimal(0).toFixed(4) : applied.isrWithheld;
    employeeTaxes = employeeTaxes.plus(isrWithheld);
    subsidioEntregado = new Decimal(applied.paidInCash);
    subsidyExcessNotPaid = new Decimal(applied.excessNotPaid).plus(notWithheld ? applied.subsidyCredited : 0);

    apuntar(isr, 'EE', {
      taxable_wages: taxableIsr,
      ...(notWithheld ? { tax_amount: 0 } : {}),
      notas: `${isr.notes ?? 'ISR del periodo'} · retenido tras acreditar el subsidio: ${isrWithheld}`,
    });
    // EL RENGLÓN LLEVA LO ACREDITADO, NO EL SUBSIDIO ENTERO.
    //
    // El subsidio causado se parte en dos: lo que se acredita contra el ISR de
    // este trabajador y lo que se le entrega en efectivo porque ya no quedaba
    // ISR contra el que acreditarlo. Los dos renglones existen, y su SUMA es el
    // causado. Poner el causado en éste y el entregado en el otro contaba dos
    // veces la parte entregada: un verificador sumó los créditos de la tabla y
    // el ISR neto del periodo salió −248.04 donde el fisco ve −124.02.
    //
    // Under the rule of 1 May 2024 there is no second row: the excess is not
    // money, so the note of this row names it and the row of the law.
    const subsidioAcreditado = new Decimal(notWithheld ? 0 : applied.subsidyCredited);
    apuntar(sub, 'EE', {
      tax_amount: subsidioAcreditado,
      taxable_wages: taxableIsr,
      is_credit: true,
      notas:
        `${sub.notes ?? 'Subsidio al empleo'} · causado ${new Decimal(sub.tax_amount).toFixed(2)}, ` +
        `acreditado contra el ISR del periodo ${subsidioAcreditado.toFixed(2)}` +
        (subsidyExcessNotPaid.greaterThan(0)
          ? ` · excess over the ISR ${subsidyExcessNotPaid.toFixed(2)} neither paid to the worker nor credited: ` +
            `${EMPLOYMENT_SUBSIDY_EXCESS_LAW} in force from ${subsidyExcessRule.effectiveFrom}` +
            (subsidyExcessRule.sourceNote ? ` (${subsidyExcessRule.sourceNote.split(':')[0]})` : '')
          : ''),
    });

    if (subsidioEntregado.greaterThan(0)) {
      // La política se lee SÓLO cuando hay algo que registrar: mientras el
      // ISR absorba el subsidio no gobierna nada y no hay por qué gastar una
      // consulta ni presentar un criterio que no aplica.
      registroDelSubsidio = await leerRegistroDelSubsidio({
        tenantId: input.tenant_id,
        entityId: period.entity_id,
      });
      apuntar(sub, 'EE', {
        tax_type: 'subsidio_entregado_efectivo',
        taxable_wages: taxableIsr,
        tax_amount: subsidioEntregado,
        is_credit: true,
        notas: notaDelSubsidioEntregado(registroDelSubsidio),
      });
    }

    // IMSS employee
    const imssEeCalc = taxRegistry.getRequired('MX', 'imss_employee');
    // The IMSS engines derive their base from `sbc_daily`, not `taxable_wages`.
    const imssEe = leftInPeriod(
      await imssEeCalc.calculate({ ...baseTaxInput, taxable_wages: 0 }),
      otherRuns.imssEmployee,
      otherRuns.contributionBase
    );
    breakdown.imss_employee = imssEe.tax_amount;
    employeeTaxes = employeeTaxes.plus(imssEe.tax_amount);
    apuntar(imssEe, 'EE', { tax_type: 'imss' });

    // IMSS employer
    const imssErCalc = taxRegistry.getRequired('MX', 'imss_employer');
    // LSS art. 168 gives no rounding rule for the edges of the old-age bands,
    // so the entity's policy decides (#661); the engine refuses without it.
    const oldAgeBandEdge = await readOldAgeBandEdge({ tenantId: input.tenant_id, entityId: period.entity_id });
    // And which minimum measures its «1.00 SM» band: the registration's area (#196, MNE-001-578).
    const minimumWageArea = await readOldAgeMinimumWageArea({ tenantId: input.tenant_id, entityId: period.entity_id });
    const imssErOfPeriod = await imssErCalc.calculate({
      ...baseTaxInput,
      taxable_wages: 0,
      imss_old_age_band_edge: oldAgeBandEdge,
      imss_minimum_wage_area: minimumWageArea,
    });
    // The base the engines are handed is the period's; the one this paycheck
    // stores is the part of it no other paycheck of the period contributed on.
    const periodContributionBase = imssErOfPeriod.taxable_wages_used;
    const imssEr = leftInPeriod(imssErOfPeriod, otherRuns.imssEmployer, otherRuns.contributionBase);
    taxableImss = imssEr.taxable_wages_used;
    breakdown.imss_employer = imssEr.tax_amount;
    employerTaxes = employerTaxes.plus(imssEr.tax_amount);
    apuntar(imssEr, 'ER', { tax_type: 'imss' });

    // INFONAVIT employer (always)
    const infErCalc = taxRegistry.getRequired('MX', 'infonavit_employer');
    const infEr = leftInPeriod(
      await infErCalc.calculate({ ...baseTaxInput, taxable_wages: periodContributionBase }),
      otherRuns.infonavitEmployer,
      otherRuns.contributionBase
    );
    breakdown.infonavit_employer = infEr.tax_amount;
    employerTaxes = employerTaxes.plus(infEr.tax_amount);
    apuntar(infEr, 'ER', { tax_type: 'infonavit' });

    // INFONAVIT credit discount (only if employee has active credit)
    if (emp.infonavit_credit_type && emp.infonavit_credit_value) {
      const infCrCalc = taxRegistry.getRequired('MX', 'infonavit_credit');
      const infCr = leftInPeriod(
        await infCrCalc.calculate({
          ...baseTaxInput,
          taxable_wages: periodContributionBase,
          // @ts-expect-error — extended input for infonavit
          credit_type: emp.infonavit_credit_type,
          credit_value: parseFloat(emp.infonavit_credit_value),
        }),
        otherRuns.infonavitCredit,
        otherRuns.contributionBase
      );
      breakdown.infonavit_credit = infCr.tax_amount;
      // EL DESCUENTO DE CRÉDITO INFONAVIT NO ES UN IMPUESTO RETENIDO.
      //
      // Sumaba a `employeeTaxes`, y `employeeTaxes` es la base de las
      // «disposable earnings» del motor de embargos: meter ahí una amortización
      // de vivienda reduce artificialmente el ingreso embargable, o sea que
      // decide cuánto cobra un acreedor con orden judicial. Resta del neto
      // igual —el trabajador sí lo ve descontado—, pero por la vía de las
      // retenciones que no son impuesto.
      otrasRetencionesDelTrabajador = otrasRetencionesDelTrabajador.plus(infCr.tax_amount);
      apuntar(infCr, 'EE', {
        tax_type: 'infonavit_credit',
        notas:
          `${infCr.notes ?? 'Crédito INFONAVIT'} · es una DEDUCCIÓN de vivienda, no un impuesto ` +
          'retenido: no entra en la base de las disposable earnings',
      });
    }

    const { imssEmployee, imssEmployer, infonavitEmployer, infonavitCredit } = otherRuns;
    if (imssEmployee.plus(imssEmployer).plus(infonavitEmployer).plus(infonavitCredit).greaterThan(0)) {
      contributionsElsewhere = {
        paychecks: otherRuns.paychecks,
        imss_employee: imssEmployee.toFixed(2),
        imss_employer: imssEmployer.toFixed(2),
        infonavit_employer: infonavitEmployer.toFixed(2),
        infonavit_credit: infonavitCredit.toFixed(2),
      };
    }
  }

  // --- Garnishments (USA) ---
  // Disposable earnings = gross − mandatory (tax) withholdings
  let garnishmentTotal = 0;
  const garnishmentDeductions: DeductionLine[] = [];
  if (emp.country_code === 'US') {
    const disposable = new Decimal(grossEarnings).minus(employeeTaxes).toNumber();
    const freqMap: Record<PayFrequency, 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'> = {
      weekly: 'weekly', biweekly: 'biweekly', semimonthly: 'semimonthly',
      monthly: 'monthly', quincenal: 'semimonthly', annual: 'monthly',
    };
    const g = await calculateGarnishments({
      employee_id: input.employee_id,
      disposable_earnings: disposable,
      gross_wages: grossEarnings,
      pay_frequency: freqMap[period.frequency] || 'biweekly',
    });
    garnishmentTotal = g.total_withheld;
    breakdown.garnishments = garnishmentTotal;
    for (const po of g.per_order) {
      if (po.amount > 0) {
        garnishmentDeductions.push({
          deduction_type: po.type,
          is_pre_tax: false,
          amount: po.amount,
          garnishment_id: po.order_id,
          description: po.cap_applied ? `Cap: ${po.cap_applied}` : undefined,
        });
      }
    }
  }
  const totalPostTax = new Decimal(postTaxDeductions).plus(garnishmentTotal).toNumber();

  // --- Net pay ---
  //
  // El subsidio entregado SUMA: es la única partida del recibo que aumenta lo
  // que el trabajador se lleva sin ser una percepción gravable. It is zero
  // when the law of the payment date hands over nothing (#600).
  const netPay = new Decimal(grossEarnings)
    .minus(preTaxDeductions)
    .minus(employeeTaxes)
    .minus(otrasRetencionesDelTrabajador)
    .minus(totalPostTax)
    .plus(subsidioEntregado)
    .toNumber();

  // El rastro de auditoría guarda, además del desglose, el importe entregado
  // y BAJO QUÉ CRITERIO se registró — incluida la advertencia de que nadie
  // contestó la política todavía, que es distinto de haberla contestado así.
  const detalleDelCalculo: Record<string, unknown> = {
    ...breakdown,
    subsidio_entregado_efectivo: subsidioEntregado.toFixed(4),
    subsidio_entregado_registro: registroDelSubsidio
      ? {
          valor: registroDelSubsidio.valor,
          decidido_por_el_despacho: registroDelSubsidio.decididoPorElDespacho,
        }
      : null,
    // Which law the excess over the ISR followed (#600): a Mexican paycheck
    // names the row it read, whether or not it had an excess.
    employment_subsidy_excess_not_paid: subsidyExcessNotPaid.toFixed(4),
    employment_subsidy_excess_rule: subsidyExcessRule
      ? {
          paid_share: subsidyExcessRule.paidShare,
          effective_from: subsidyExcessRule.effectiveFrom,
          source_url: subsidyExcessRule.sourceUrl,
        }
      : null,
    // Present only when another paycheck of the period charged them: the
    // employer liability reads it to tell this zero from a missing SBC.
    ...(contributionsElsewhere ? { [CONTRIBUTIONS_ELSEWHERE_DETAIL]: contributionsElsewhere } : {}),
    ...(separatePaymentIsr ? { [SEPARATE_PAYMENT_ISR_DETAIL]: separatePaymentIsr } : {}),
    ...(minimumWageIsrRecord ? { [MINIMUM_WAGE_ISR_DETAIL]: minimumWageIsrRecord } : {}),
  };

  // --- Persist ---
  const paycheckId = uuidv4();
  const persist = async (client: PoolClient): Promise<void> => {
    await client.query(
      `INSERT INTO paychecks (
        id, tenant_id, pay_run_id, employee_id,
        gross_earnings, pre_tax_deductions, post_tax_deductions,
        taxable_wages_fit, taxable_wages_fica, taxable_wages_futa, taxable_wages_state,
        taxable_wages_isr, taxable_wages_imss,
        fit_withheld, fica_ss_withheld, fica_medicare_withheld, additional_medicare_withheld,
        state_tax_withheld, sdi_withheld,
        fica_ss_employer, fica_medicare_employer, futa, suta,
        isr_withheld, subsidio_empleo, imss_employee, infonavit_withheld,
        imss_employer, infonavit_employer,
        net_pay, ytd_snapshot, calculation_details, hours_worked,
        local_tax_withheld, garnishments, subsidio_entregado_efectivo
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13,
        $14, $15, $16, $17,
        $18, $19,
        $20, $21, $22, $23,
        $24, $25, $26, $27,
        $28, $29,
        $30, $31::jsonb, $32::jsonb, $33,
        $34, $35, $36
      )`,
      [
        paycheckId, input.tenant_id, input.pay_run_id, input.employee_id,
        grossEarnings, preTaxDeductions, totalPostTax,
        taxableFit, taxableFica, taxableFuta, taxableState,
        taxableIsr, taxableImss,
        breakdown.fit || 0, breakdown.fica_ss || 0, breakdown.fica_medicare || 0, breakdown.additional_medicare || 0,
        breakdown.sit || 0, breakdown.sdi || 0,
        breakdown.fica_ss_employer || 0, breakdown.fica_medicare_employer || 0, breakdown.futa || 0, breakdown.suta || 0,
        breakdown.isr || 0, breakdown.subsidio_empleo || 0, breakdown.imss_employee || 0, breakdown.infonavit_credit || 0,
        breakdown.imss_employer || 0, breakdown.infonavit_employer || 0,
        netPay, JSON.stringify(ytd), JSON.stringify(detalleDelCalculo), input.hours_worked || null,
        // Tres columnas que existían desde la 008 y nadie escribía: el
        // impuesto local retenido y los embargos salían en CERO en el recibo
        // aunque el neto sí los descontara.
        breakdown.local || 0, garnishmentTotal, subsidioEntregado.toFixed(4),
      ]
    );

    for (const [i, e] of input.earnings.entries()) {
      await client.query(
        `INSERT INTO paycheck_earnings (paycheck_id, earning_type, hours, rate, amount,
          is_taxable_fit, is_taxable_state, is_taxable_fica, is_taxable_futa,
          is_taxable_isr, is_taxable_imss, is_supplemental, cfdi_clave_sat, description,
          isr_exempt_amount, isr_taxable_amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          paycheckId, e.earning_type, e.hours || null, e.rate || null, e.amount,
          e.is_taxable_fit !== false, e.is_taxable_state !== false, e.is_taxable_fica !== false, e.is_taxable_futa !== false,
          e.is_taxable_isr !== false, e.is_taxable_imss !== false, e.is_supplemental || false,
          e.cfdi_clave_sat || null, e.description || null,
          isrParts[i].exempt.toString(), isrParts[i].taxable.toString(),
        ]
      );
    }

    for (const d of [...deductions, ...garnishmentDeductions]) {
      await client.query(
        `INSERT INTO paycheck_deductions (paycheck_id, deduction_type, is_pre_tax, is_employer_contribution,
          amount, benefit_plan_id, garnishment_id, cfdi_clave_sat, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          paycheckId, d.deduction_type, d.is_pre_tax, d.is_employer_contribution || false,
          d.amount, d.benefit_plan_id || null, d.garnishment_id || null,
          d.cfdi_clave_sat || null, d.description || null,
        ]
      );
    }

    // EL DESGLOSE, EN LA MISMA TRANSACCIÓN QUE EL RECIBO.
    //
    // Va aquí y no en un paso posterior porque un recibo con la mitad de sus
    // impuestos apuntados es peor que uno sin ninguno: el formulario suma lo
    // que encuentra y no puede saber que falta algo.
    //
    // SIN `ON CONFLICT`, a propósito. El UNIQUE de la 067
    // (paycheck_id, tax_type, jurisdiction, employee_employer) está para que
    // apuntar dos veces el mismo impuesto sea un error ruidoso; taparlo con
    // DO NOTHING devolvería el silencio que la migración vino a quitar. Un
    // recibo es de un solo `paycheck_id` recién generado, así que un choque
    // aquí sólo puede venir de dos calculadoras declarando el mismo par —un
    // defecto de programación, no un reintento.
    for (const r of renglones) {
      await client.query(
        `INSERT INTO paycheck_taxes (
           paycheck_id, tax_type, jurisdiction, employee_employer,
           taxable_wages, rate, tax_amount, is_credit, calculation_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          paycheckId, r.tax_type, r.jurisdiction, r.employee_employer,
          r.taxable_wages, r.rate, r.tax_amount, r.is_credit, r.calculation_notes,
        ]
      );
    }
  };
  await (tx ? persist(tx) : withTransaction(persist));

  return {
    paycheck_id: paycheckId,
    gross_earnings: grossEarnings,
    pre_tax_deductions: preTaxDeductions,
    post_tax_deductions: totalPostTax,
    employee_taxes: employeeTaxes.toNumber(),
    employer_taxes: employerTaxes.toNumber(),
    net_pay: netPay,
    subsidio_entregado_efectivo: subsidioEntregado.toFixed(4),
    breakdown,
    pay_date: toCalendarDate(period.pay_date),
    country_code: emp.country_code,
  };
}
