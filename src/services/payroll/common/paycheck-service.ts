import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../../../database/connection.js';
import { taxRegistry } from '../tax-engine/tax-registry.js';
import { getEmployeeYtd, getEmployeeSutaYtd } from '../tax-engine/ytd-service.js';
import { calculateGarnishments } from '../usa/garnishments/garnishment-engine.js';
import type { TaxInput, PayFrequency } from '../tax-engine/tax-engine.interface.js';

// ============================================================
// PAYCHECK SERVICE
// Takes employee + pay period + earnings → computes gross to net.
// Dispatches to tax calculators per jurisdiction.
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
  pay_period_id: string;
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
  breakdown: Record<string, number>;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => new Decimal(a).plus(b).toNumber(), 0);
}

export async function calculatePaycheck(input: PaycheckInput): Promise<CalculatedPaycheck> {
  // Fetch employee + pay period
  const empResult = await query<{
    id: string;
    country_code: 'MX' | 'US';
    sbc: string | null;
    tipo_regimen_sat: string | null;
    riesgo_puesto: string | null;
    infonavit_credit_type: string | null;
    infonavit_credit_value: string | null;
    w4_data: Record<string, unknown>;
    work_state: string | null;
    residence_state: string | null;
    work_city: string | null;
  }>(
    `SELECT id, country_code, sbc, tipo_regimen_sat, riesgo_puesto,
            infonavit_credit_type, infonavit_credit_value,
            w4_data, work_state, residence_state, work_city
     FROM employees WHERE id = $1`,
    [input.employee_id]
  );
  if (empResult.rows.length === 0) throw new Error('Employee not found');
  const emp = empResult.rows[0];

  const periodResult = await query<{
    period_start: string;
    period_end: string;
    pay_date: string;
    tax_year: number;
    frequency: PayFrequency;
  }>(
    `SELECT pp.period_start, pp.period_end, pp.pay_date, pp.tax_year, ps.frequency
     FROM pay_periods pp JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id
     WHERE pp.id = $1`,
    [input.pay_period_id]
  );
  if (periodResult.rows.length === 0) throw new Error('Pay period not found');
  const period = periodResult.rows[0];

  const daysInPeriod =
    (new Date(period.period_end).getTime() - new Date(period.period_start).getTime()) / 86400000 + 1;

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
  const taxableIsr = sum(
    input.earnings.filter((e) => e.is_taxable_isr !== false).map((e) => e.amount)
  ) - preTaxDeductions;
  const taxableImss = taxableIsr;

  // --- YTD ---
  const ytd = await getEmployeeYtd(input.employee_id, period.tax_year, new Date(period.pay_date));

  const breakdown: Record<string, number> = {};
  let employeeTaxes = 0;
  let employerTaxes = 0;

  const baseTaxInput: Omit<TaxInput, 'taxable_wages'> = {
    pay_frequency: period.frequency,
    tax_year: period.tax_year,
    w4_data: emp.w4_data as TaxInput['w4_data'],
    sbc_daily: emp.sbc ? parseFloat(emp.sbc) : undefined,
    days_in_period: Math.floor(daysInPeriod),
    riesgo_puesto: emp.riesgo_puesto || undefined,
    state: emp.work_state || undefined,
    residence_state: emp.residence_state || undefined,
    work_city: emp.work_city || undefined,
  };

  if (emp.country_code === 'US') {
    // FIT
    const fitCalc = taxRegistry.getRequired('US-FEDERAL', 'fit');
    const fit = await fitCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFit, ytd_wages: ytd.gross_wages });
    breakdown.fit = fit.tax_amount;
    employeeTaxes += fit.tax_amount;

    // FICA SS
    const ssCalc = taxRegistry.getRequired('US-FEDERAL', 'fica_ss');
    const ss = await ssCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica, ytd_wages: ytd.ss_taxable_wages });
    breakdown.fica_ss = ss.tax_amount;
    employeeTaxes += ss.tax_amount;

    const ssErCalc = taxRegistry.getRequired('US-FEDERAL', 'fica_ss_employer');
    const ssEr = await ssErCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica, ytd_wages: ytd.ss_taxable_wages });
    breakdown.fica_ss_employer = ssEr.tax_amount;
    employerTaxes += ssEr.tax_amount;

    // Medicare
    const medCalc = taxRegistry.getRequired('US-FEDERAL', 'fica_medicare');
    const med = await medCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica });
    breakdown.fica_medicare = med.tax_amount;
    employeeTaxes += med.tax_amount;

    const medErCalc = taxRegistry.getRequired('US-FEDERAL', 'fica_medicare_employer');
    const medEr = await medErCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica });
    breakdown.fica_medicare_employer = medEr.tax_amount;
    employerTaxes += medEr.tax_amount;

    // Additional Medicare
    const addlCalc = taxRegistry.getRequired('US-FEDERAL', 'additional_medicare');
    const addl = await addlCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica, ytd_wages: ytd.medicare_taxable_wages });
    breakdown.additional_medicare = addl.tax_amount;
    employeeTaxes += addl.tax_amount;

    // FUTA
    const futaCalc = taxRegistry.getRequired('US-FEDERAL', 'futa');
    const futa = await futaCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFuta, ytd_wages: ytd.futa_taxable_wages });
    breakdown.futa = futa.tax_amount;
    employerTaxes += futa.tax_amount;

    // State SIT + SUTA + SDI (if state has them)
    if (emp.work_state) {
      const juris = `US-${emp.work_state}`;
      const sitCalc = taxRegistry.get(juris, 'sit');
      if (sitCalc) {
        const sit = await sitCalc.calculate({ ...baseTaxInput, taxable_wages: taxableState });
        breakdown.sit = sit.tax_amount;
        employeeTaxes += sit.tax_amount;
      }
      const sutaCalc = taxRegistry.get(juris, 'suta');
      if (sutaCalc) {
        // Per-state SUTA YTD (each state has its own wage base)
        const sutaYtd = await getEmployeeSutaYtd(
          input.employee_id, period.tax_year, emp.work_state, new Date(period.pay_date)
        );
        const suta = await sutaCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFuta, ytd_wages: sutaYtd });
        breakdown.suta = suta.tax_amount;
        employerTaxes += suta.tax_amount;
      }
      const sdiCalc = taxRegistry.get(juris, 'sdi');
      if (sdiCalc) {
        const sdi = await sdiCalc.calculate({ ...baseTaxInput, taxable_wages: taxableState });
        if (sdi.tax_amount > 0) {
          breakdown.sdi = sdi.tax_amount;
          employeeTaxes += sdi.tax_amount;
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
            employeeTaxes += local.tax_amount;
          }
        }
      }
    }
  } else {
    // --- MEXICO ---
    const isrCalc = taxRegistry.getRequired('MX', 'isr');
    const isr = await isrCalc.calculate({ ...baseTaxInput, taxable_wages: taxableIsr });
    breakdown.isr = isr.tax_amount;

    const subCalc = taxRegistry.getRequired('MX', 'subsidio_empleo');
    const sub = await subCalc.calculate({ ...baseTaxInput, taxable_wages: taxableIsr });
    breakdown.subsidio_empleo = sub.tax_amount;

    // Net ISR = ISR - subsidio (employee pays the difference; if negative, employee receives as cash)
    const netIsr = Math.max(0, isr.tax_amount - sub.tax_amount);
    employeeTaxes += netIsr;

    // IMSS employee
    const imssEeCalc = taxRegistry.getRequired('MX', 'imss_employee');
    const imssEe = await imssEeCalc.calculate({ ...baseTaxInput, taxable_wages: taxableImss });
    breakdown.imss_employee = imssEe.tax_amount;
    employeeTaxes += imssEe.tax_amount;

    // IMSS employer
    const imssErCalc = taxRegistry.getRequired('MX', 'imss_employer');
    const imssEr = await imssErCalc.calculate({ ...baseTaxInput, taxable_wages: taxableImss });
    breakdown.imss_employer = imssEr.tax_amount;
    employerTaxes += imssEr.tax_amount;

    // INFONAVIT employer (always)
    const infErCalc = taxRegistry.getRequired('MX', 'infonavit_employer');
    const infEr = await infErCalc.calculate({ ...baseTaxInput, taxable_wages: taxableImss });
    breakdown.infonavit_employer = infEr.tax_amount;
    employerTaxes += infEr.tax_amount;

    // INFONAVIT credit discount (only if employee has active credit)
    if (emp.infonavit_credit_type && emp.infonavit_credit_value) {
      const infCrCalc = taxRegistry.getRequired('MX', 'infonavit_credit');
      const infCr = await infCrCalc.calculate({
        ...baseTaxInput,
        taxable_wages: taxableImss,
        // @ts-expect-error — extended input for infonavit
        credit_type: emp.infonavit_credit_type,
        credit_value: parseFloat(emp.infonavit_credit_value),
      });
      breakdown.infonavit_credit = infCr.tax_amount;
      employeeTaxes += infCr.tax_amount;
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
  const netPay = new Decimal(grossEarnings)
    .minus(preTaxDeductions)
    .minus(employeeTaxes)
    .minus(totalPostTax)
    .toNumber();

  // --- Persist ---
  const paycheckId = uuidv4();
  await withTransaction(async (client) => {
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
        net_pay, ytd_snapshot, calculation_details, hours_worked
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
        $30, $31::jsonb, $32::jsonb, $33
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
        netPay, JSON.stringify(ytd), JSON.stringify(breakdown), input.hours_worked || null,
      ]
    );

    for (const e of input.earnings) {
      await client.query(
        `INSERT INTO paycheck_earnings (paycheck_id, earning_type, hours, rate, amount,
          is_taxable_fit, is_taxable_state, is_taxable_fica, is_taxable_futa,
          is_taxable_isr, is_taxable_imss, is_supplemental, cfdi_clave_sat, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          paycheckId, e.earning_type, e.hours || null, e.rate || null, e.amount,
          e.is_taxable_fit !== false, e.is_taxable_state !== false, e.is_taxable_fica !== false, e.is_taxable_futa !== false,
          e.is_taxable_isr !== false, e.is_taxable_imss !== false, e.is_supplemental || false,
          e.cfdi_clave_sat || null, e.description || null,
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
  });

  return {
    paycheck_id: paycheckId,
    gross_earnings: grossEarnings,
    pre_tax_deductions: preTaxDeductions,
    post_tax_deductions: totalPostTax,
    employee_taxes: employeeTaxes,
    employer_taxes: employerTaxes,
    net_pay: netPay,
    breakdown,
  };
}
