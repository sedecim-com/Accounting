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
// THE WITHHOLDING (MNE-001-579) is LISR art. 96, the paragraph on the
// payments of art. 95 (third from the end; not its last paragraph):
// «efectuarán la retención aplicando al ingreso total por este concepto, una
// tasa que se calculará dividiendo el impuesto correspondiente al último
// sueldo mensual ordinario, entre dicho sueldo [...]. Cuando los pagos por
// estos conceptos sean inferiores al último sueldo mensual ordinario, la
// retención se calculará aplicándoles la tarifa establecida en este
// artículo.» The rate applies to the TAXABLE part: RLISR art. 172 nets the
// fr. XIII exemption out of the art. 95 total. What is compared with the USMO
// is the panel's `separation_isr_usmo_comparison`.
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

/** What is compared with the USMO (`separation_isr_usmo_comparison`). Its values are persisted. */
export type UsmoComparison = 'total_payments' | 'taxable_payments';

/**
 * `exempt` when nothing is taxed; `tariff` when the payments compared are
 * BELOW the USMO («inferiores», strict); `effective_rate` otherwise;
 * `no_usmo` when the USMO is zero and there is no rate to divide by.
 */
export type SeparationWithholdingRoute = 'exempt' | 'tariff' | 'effective_rate' | 'no_usmo';

export function separationRoute(args: {
  payments: string;
  taxable: string;
  usmo: string;
  comparison: UsmoComparison;
}): SeparationWithholdingRoute {
  if (new Decimal(args.taxable).lessThanOrEqualTo(0)) return 'exempt';
  const usmo = new Decimal(args.usmo);
  const compared = new Decimal(args.comparison === 'total_payments' ? args.payments : args.taxable);
  if (compared.lessThan(usmo)) return 'tariff';
  return usmo.greaterThan(0) ? 'effective_rate' : 'no_usmo';
}

/**
 * The withholding at the USMO rate: taxable × (ISR of the USMO − subsidy) /
 * USMO, rounded to the cent half-up at the END. The rate itself is never
 * rounded (the law prescribes no rounding); `ratePercent` is for display, to
 * four decimals. A subsidy above the ISR floors the rate at zero.
 *
 * @param isrOfUsmo the ISR of the USMO by the monthly tariff, to the cent.
 * @param subsidyOfUsmo the monthly employment subsidy of the USMO under
 *   `net_of_subsidy`, or null under `gross_of_tariff`.
 */
export function withholdingAtUsmoRate(args: {
  taxable: string;
  usmo: string;
  isrOfUsmo: string;
  subsidyOfUsmo: string | null;
}): { ratePercent: string; withholding: string } {
  const tax = Decimal.max(0, new Decimal(args.isrOfUsmo).minus(args.subsidyOfUsmo ?? 0));
  const usmo = new Decimal(args.usmo);
  return {
    ratePercent: tax.dividedBy(usmo).times(100).toFixed(DECIMALS),
    withholding: new Decimal(args.taxable)
      .times(tax)
      .dividedBy(usmo)
      .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
      .toFixed(DECIMALS),
  };
}
