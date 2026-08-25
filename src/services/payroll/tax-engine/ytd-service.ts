import { query } from '../../../database/connection.js';

// ============================================================
// YEAR-TO-DATE SERVICE
// Critical for capped taxes: Social Security wage base, FUTA $7k,
// SUTA per-state wage base, IMSS 25 UMA cap, Additional Medicare.
// Reads from paychecks table (authoritative source).
// ============================================================

export interface YtdSnapshot {
  year: number;
  gross_wages: number;
  ss_taxable_wages: number;
  medicare_taxable_wages: number;
  futa_taxable_wages: number;
  suta_taxable_wages: number;
  sit_taxable_wages: number;
  isr_taxable_wages: number;
  imss_taxable_wages: number;
  fit_withheld: number;
  ss_withheld: number;
  medicare_withheld: number;
  additional_medicare_withheld: number;
  sit_withheld: number;
  isr_withheld: number;
  imss_employee: number;
  infonavit_withheld: number;
  subsidio_empleo: number;
  pretax_401k: number;
  employer_401k: number;
  paycheck_count: number;
}

function emptySnapshot(year: number): YtdSnapshot {
  return {
    year,
    gross_wages: 0,
    ss_taxable_wages: 0,
    medicare_taxable_wages: 0,
    futa_taxable_wages: 0,
    suta_taxable_wages: 0,
    sit_taxable_wages: 0,
    isr_taxable_wages: 0,
    imss_taxable_wages: 0,
    fit_withheld: 0,
    ss_withheld: 0,
    medicare_withheld: 0,
    additional_medicare_withheld: 0,
    sit_withheld: 0,
    isr_withheld: 0,
    imss_employee: 0,
    infonavit_withheld: 0,
    subsidio_empleo: 0,
    pretax_401k: 0,
    employer_401k: 0,
    paycheck_count: 0,
  };
}

export async function getEmployeeYtd(
  employeeId: string,
  taxYear: number,
  beforePayDate?: Date
): Promise<YtdSnapshot> {
  const result = await query<{
    gross: string;
    ss_wages: string;
    med_wages: string;
    futa_wages: string;
    sit_wages: string;
    isr_wages: string;
    imss_wages: string;
    fit: string;
    ss: string;
    med: string;
    addl_med: string;
    sit: string;
    isr: string;
    imss_ee: string;
    infonavit: string;
    subsidio: string;
    cnt: string;
  }>(
    `SELECT
        COALESCE(SUM(p.gross_earnings), 0)              AS gross,
        COALESCE(SUM(p.taxable_wages_fica), 0)          AS ss_wages,
        COALESCE(SUM(p.taxable_wages_fica), 0)          AS med_wages,
        COALESCE(SUM(p.taxable_wages_futa), 0)          AS futa_wages,
        COALESCE(SUM(p.taxable_wages_state), 0)         AS sit_wages,
        COALESCE(SUM(p.taxable_wages_isr), 0)           AS isr_wages,
        COALESCE(SUM(p.taxable_wages_imss), 0)          AS imss_wages,
        COALESCE(SUM(p.fit_withheld), 0)                AS fit,
        COALESCE(SUM(p.fica_ss_withheld), 0)            AS ss,
        COALESCE(SUM(p.fica_medicare_withheld), 0)      AS med,
        COALESCE(SUM(p.additional_medicare_withheld),0) AS addl_med,
        COALESCE(SUM(p.state_tax_withheld), 0)          AS sit,
        COALESCE(SUM(p.isr_withheld), 0)                AS isr,
        COALESCE(SUM(p.imss_employee), 0)               AS imss_ee,
        COALESCE(SUM(p.infonavit_withheld), 0)          AS infonavit,
        COALESCE(SUM(p.subsidio_empleo), 0)             AS subsidio,
        COUNT(*)                                        AS cnt
     FROM paychecks p
     JOIN pay_runs pr ON pr.id = p.pay_run_id
     JOIN pay_periods pp ON pp.id = pr.pay_period_id
     WHERE p.employee_id = $1
       AND pp.tax_year = $2
       AND pr.status IN ('calculated', 'approved', 'paid')
       AND ($3::date IS NULL OR pp.pay_date < $3::date)`,
    [employeeId, taxYear, beforePayDate || null]
  );

  const r = result.rows[0];
  if (!r) return emptySnapshot(taxYear);

  return {
    year: taxYear,
    gross_wages: parseFloat(r.gross),
    ss_taxable_wages: parseFloat(r.ss_wages),
    medicare_taxable_wages: parseFloat(r.med_wages),
    futa_taxable_wages: parseFloat(r.futa_wages),
    suta_taxable_wages: parseFloat(r.futa_wages), // Aggregate fallback; use getEmployeeSutaYtd(state) for per-state cap
    sit_taxable_wages: parseFloat(r.sit_wages),
    isr_taxable_wages: parseFloat(r.isr_wages),
    imss_taxable_wages: parseFloat(r.imss_wages),
    fit_withheld: parseFloat(r.fit),
    ss_withheld: parseFloat(r.ss),
    medicare_withheld: parseFloat(r.med),
    additional_medicare_withheld: parseFloat(r.addl_med),
    sit_withheld: parseFloat(r.sit),
    isr_withheld: parseFloat(r.isr),
    imss_employee: parseFloat(r.imss_ee),
    infonavit_withheld: parseFloat(r.infonavit),
    subsidio_empleo: parseFloat(r.subsidio),
    pretax_401k: 0,
    employer_401k: 0,
    paycheck_count: parseInt(r.cnt, 10),
  };
}

/**
 * Per-state SUTA YTD. SUTA wage bases are state-specific (CA $7k, WA $72,800,
 * etc.) and an employee that moves states resets toward a new base in the new
 * state. We track wages where the employee's recorded work_state matches the
 * requested state. Multi-state employees in a single year are handled by
 * computing this separately per state.
 */
export async function getEmployeeSutaYtd(
  employeeId: string,
  taxYear: number,
  state: string,
  beforePayDate?: Date
): Promise<number> {
  const r = await query<{ wages: string }>(
    `SELECT COALESCE(SUM(p.taxable_wages_futa), 0) AS wages
       FROM paychecks p
       JOIN pay_runs pr     ON pr.id = p.pay_run_id
       JOIN pay_periods pp  ON pp.id = pr.pay_period_id
       JOIN employees e     ON e.id = p.employee_id
      WHERE p.employee_id = $1
        AND pp.tax_year = $2
        AND e.work_state = $3
        AND pr.status IN ('calculated', 'approved', 'paid')
        AND ($4::date IS NULL OR pp.pay_date < $4::date)`,
    [employeeId, taxYear, state, beforePayDate || null]
  );
  return parseFloat(r.rows[0]?.wages ?? '0');
}

/**
 * Remaining room against a capped wage base.
 * Returns the portion of new wages that is taxable.
 */
export function cappedTaxableWages(
  ytdTaxableWages: number,
  newWages: number,
  wageBaseCap: number
): number {
  const remaining = Math.max(0, wageBaseCap - ytdTaxableWages);
  return Math.min(newWages, remaining);
}
