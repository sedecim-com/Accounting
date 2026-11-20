import Decimal from 'decimal.js';
import { aFechaUtc, aniosDeServicioCumplidos } from './finiquito-math.js';

// ============================================================
// THE SEPARATION EXEMPTION, WITHOUT POSTGRES (MNE-001-375 · #194)
//
// LISR art. 93 fr. XIII exempts what a worker receives at separation «por
// concepto de primas de antigüedad, retiro e indemnizaciones u otros pagos»
// «hasta por el equivalente a noventa veces el salario mínimo general del
// área geográfica del contribuyente por cada año de servicio», and goes on:
// «Los años de servicio serán los que se hubieran considerado para el cálculo
// de los conceptos mencionados. Toda fracción de más de seis meses se
// considerará un año completo. Por el excedente se pagará el impuesto en los
// términos de este Título.» (Text checked against the Chamber of Deputies'
// compiled LISR, last reform DOF 01-04-2024.) The minimum wage as a unit
// reads as the UMA since the desindexation decree (DOF 27-01-2016), as the
// other art. 93 caps of this tree already do.
//
// ONLY SEPARATION PAYMENTS COME IN. Pending salary, the aguinaldo, the
// vacation premium and pending vacations are ordinary income, with their own
// fr. XIV caps applied by the payslip engine (isr-exemption.ts): they never
// reach this cap, and they never use it up.
//
// The withholding on what is taxed (LISR art. 96, the paragraph on payments
// of art. 95, and RLISR art. 172) is MNE-001-579. This module only says what
// is exempt and what is taxed.
// ============================================================

/** The decimals of money in this system, as in finiquito-math.ts. */
const DECIMALS = 4;

/**
 * `date` plus `months` calendar months, the day clamped to the end of a
 * shorter month: 31 August + 6 months is 28 (or 29) February, never 3 March.
 */
function addMonthsClamped(date: Date, months: number): Date {
  const target = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(target / 12);
  const month = ((target % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

/**
 * The years of service of fr. XIII: the completed years, plus one when the
 * fraction is MORE than six months.
 *
 * The six months run from the hire date (hire + completed years + 6 months),
 * not from an anniversary already clamped: a hire on 29 February keeps its
 * day. «More than» is strict: exactly six months is not more. It is the same
 * rule the payroll CFDI states for `NumAñosServicio` («hay más de 6 meses»).
 */
export function separationYearsOfService(hireDate: string | Date, terminationDate: string | Date): number {
  const hire = aFechaUtc(hireDate);
  const termination = aFechaUtc(terminationDate);
  if (termination < hire) return 0;
  const completed = aniosDeServicioCumplidos(hire, termination);
  return termination > addMonthsClamped(hire, completed * 12 + 6) ? completed + 1 : completed;
}

export interface SeparationExemptionInput {
  /** What is paid for separation (premium, indemnity), as a string. */
  payments: string;
  /** From `separationYearsOfService`. */
  years: number;
  /** `tax_parameters.uma_daily` at the termination date. */
  umaDaily: string;
  /** The law row: 90 UMA per year of service. */
  capUmaPerYear: string;
}

/** Four-decimal strings; `exempt + taxable = payments`. */
export interface SeparationExemption {
  cap: string;
  exempt: string;
  taxable: string;
}

/**
 * The exempt and the taxable part of the separation payments.
 *
 * The cap is UMA × 90 × years rounded to the cent half-up, as the payslip
 * caps are (`exemptRoom`, isr-exemption.ts); the split is not rounded again.
 */
export function separationExemption(input: SeparationExemptionInput): SeparationExemption {
  const payments = new Decimal(input.payments);
  const cap = new Decimal(input.capUmaPerYear)
    .times(input.umaDaily)
    .times(input.years)
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const exempt = Decimal.max(0, Decimal.min(payments, cap));
  return {
    cap: cap.toFixed(DECIMALS),
    exempt: exempt.toFixed(DECIMALS),
    taxable: payments.minus(exempt).toFixed(DECIMALS),
  };
}
