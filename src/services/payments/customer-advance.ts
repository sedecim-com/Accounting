import Decimal from 'decimal.js';

/**
 * MNE-001-458 (#623) · THE TREATMENT A CUSTOMER ADVANCE IS RECORDED WITH.
 *
 * An advance collected before the sale causes its IVA the day the money
 * arrives (LIVA art. 1-B; NIF D-1 in `nif-registro.md`). Its rate is a fact
 * the accountant states, never a default: 16 or 0 (LIVA arts. 1 and 2-A),
 * 8 (the border region), exempt, or not subject to IVA.
 */
export const ADVANCE_TREATMENTS = ['16', '8', '0', 'exempt', 'not-subject'] as const;
export type AdvanceTreatment = (typeof ADVANCE_TREATMENTS)[number];

export interface AdvanceSplit {
  treatment: AdvanceTreatment;
  /** `customer_payments.advance_factor_type`: a 0 % rate and an exemption carry no IVA and are declared apart. */
  factorType: 'tasa' | 'exento' | 'no_objeto';
  /** A percent with two decimals; null unless the factor type is 'tasa'. */
  taxRate: string | null;
  base: string;
  iva: string;
}

export function isAdvanceTreatment(value: string): value is AdvanceTreatment {
  return (ADVANCE_TREATMENTS as readonly string[]).includes(value);
}

/**
 * The cash of an advance includes its IVA: the base is the cash over
 * 1 + rate, rounded half up to the cent, and the IVA is the difference, so
 * the two add up to the cash and the entry foots.
 */
export function splitAdvance(cash: string, treatment: AdvanceTreatment): AdvanceSplit {
  const amount = new Decimal(cash);
  if (treatment === 'exempt' || treatment === 'not-subject') {
    const factorType = treatment === 'exempt' ? 'exento' : 'no_objeto';
    return { treatment, factorType, taxRate: null, base: amount.toFixed(2), iva: '0.00' };
  }
  const rate = new Decimal(treatment);
  const base = amount.div(rate.div(100).plus(1)).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { treatment, factorType: 'tasa', taxRate: rate.toFixed(2), base: base.toFixed(2), iva: amount.minus(base).toFixed(2) };
}

/** MNE-001-421 · The spellings a typed invoice line already uses for the two treatments with no rate. */
const TYPED_AS: Record<string, AdvanceTreatment> = { exento: 'exempt', 'no-objeto': 'not-subject' };
/** Everything `--tax-rate` reads, for the message that refuses anything else. */
export const ADVANCE_TREATMENTS_AS_TYPED = [...ADVANCE_TREATMENTS, ...Object.keys(TYPED_AS)].join(', ');

/** `--tax-rate` as the accountant types it; null for anything outside the list, which the caller refuses. */
export function readAdvanceTreatment(typed: string): AdvanceTreatment | null {
  const value = typed.trim().toLowerCase();
  const treatment = TYPED_AS[value] ?? value;
  return isAdvanceTreatment(treatment) ? treatment : null;
}

/** The treatment a stored receipt was recorded with, read back from its two columns; null when it carries none. */
export function storedAdvanceTreatment(factorType: string | null, taxRate: string | null): AdvanceTreatment | null {
  if (factorType === null) return null;
  if (factorType === 'exento') return 'exempt';
  if (factorType === 'no_objeto') return 'not-subject';
  return new Decimal(taxRate ?? '0').toString() as AdvanceTreatment;
}
