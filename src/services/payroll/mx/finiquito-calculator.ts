import { query } from '../../../database/connection.js';

// ============================================================
// MX — Finiquito (termination settlement)
// Pays accrued amounts: pending salary + proportional aguinaldo (year-end bonus) +
// proportional prima vacacional (vacation premium) + pending vacation days.
// Reference: LFT Art. 76, 79, 80, 87.
// ============================================================

export interface FiniquitoInput {
  employee_id: string;
  termination_date: string;
  last_paid_through: string;
  pending_vacation_days?: number;
  aguinaldo_days_per_year?: number; // default 15 (LFT Art. 87 minimum)
  prima_vacacional_pct?: number;    // default 0.25 (25% LFT minimum)
}

export interface FiniquitoResult {
  salary_pending_days: number;
  salary_pending_amount: number;
  aguinaldo_days: number;
  aguinaldo_amount: number;
  prima_vacacional_days: number;
  prima_vacacional_amount: number;
  vacation_pending_amount: number;
  total: number;
}

function daysBetween(a: string, b: string): number {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

export async function calculateFiniquito(input: FiniquitoInput): Promise<FiniquitoResult> {
  const result = await query<{
    sbc: string;
    hire_date: string;
    annual_salary: string | null;
  }>(
    `SELECT sbc, hire_date, annual_salary FROM employees WHERE id = $1`,
    [input.employee_id]
  );
  if (result.rows.length === 0) throw new Error('Employee not found');
  const e = result.rows[0];
  const dailyWage = e.sbc ? parseFloat(e.sbc) : (e.annual_salary ? parseFloat(e.annual_salary) / 365 : 0);

  // 1. Pending salary — days from last_paid_through to termination_date
  const salaryDays = Math.max(0, daysBetween(input.last_paid_through, input.termination_date));
  const salaryAmount = salaryDays * dailyWage;

  // 2. Proportional aguinaldo (year-end bonus) — minimum 15 days/year (LFT Art. 87)
  const aguinaldoDaysPerYear = input.aguinaldo_days_per_year || 15;
  const yearStart = `${new Date(input.termination_date).getUTCFullYear()}-01-01`;
  const daysWorkedThisYear = daysBetween(yearStart, input.termination_date);
  const aguinaldoDays = (aguinaldoDaysPerYear * daysWorkedThisYear) / 365;
  const aguinaldoAmount = aguinaldoDays * dailyWage;

  // 3. Proportional prima vacacional (vacation premium, 25% of earned vacation)
  // Vacation days per year per LFT Art. 76 (2023 reform): 12 days the first year, escalating.
  const yearsWorked = Math.floor(daysBetween(e.hire_date, input.termination_date) / 365);
  const vacDaysPerYear = vacationDaysPerYear(yearsWorked);
  const primaPct = input.prima_vacacional_pct || 0.25;
  const primaDays = (vacDaysPerYear * daysWorkedThisYear) / 365;
  const primaAmount = primaDays * dailyWage * primaPct;

  // 4. Pending vacation days
  const pendingVacDays = input.pending_vacation_days || 0;
  const vacationAmount = pendingVacDays * dailyWage;

  const total = salaryAmount + aguinaldoAmount + primaAmount + vacationAmount;

  return {
    salary_pending_days: salaryDays,
    salary_pending_amount: Math.round(salaryAmount * 100) / 100,
    aguinaldo_days: Math.round(aguinaldoDays * 100) / 100,
    aguinaldo_amount: Math.round(aguinaldoAmount * 100) / 100,
    prima_vacacional_days: Math.round(primaDays * 100) / 100,
    prima_vacacional_amount: Math.round(primaAmount * 100) / 100,
    vacation_pending_amount: Math.round(vacationAmount * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
}

// LFT Art. 76 (2023 reform)
function vacationDaysPerYear(years: number): number {
  if (years < 1) return 12;
  if (years === 1) return 14;
  if (years === 2) return 16;
  if (years === 3) return 18;
  if (years === 4) return 20;
  if (years <= 9) return 22;
  // +2 days every 5 years after year 5
  return 22 + Math.floor((years - 9) / 5) * 2;
}
