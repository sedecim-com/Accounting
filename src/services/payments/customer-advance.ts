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

/**
 * MNE-001-422 · What one allocation takes from a receipt's advance.
 *
 * The cash on account that carries no advance IVA goes first (`plain`), and
 * the advance after it: no norm orders how cash on account is consumed, and
 * this order means that undoing an application and making it again never
 * moves the advance's IVA (a systems rule, ADR-0006 Decision 2). The IVA the
 * advance's cash carries is a cumulative target, the advance's IVA times the
 * share of it consumed, minus what was already cancelled: the telescope of
 * `ivaToReclassify`, with the receipt as the document, so the last part
 * cancels exactly the rest. Amounts at four decimals.
 */
export interface AdvanceTake {
  /** The advance, base plus IVA, as the receipt stored it. */
  total: string;
  iva: string;
  /** The advance's cash already taken, and its IVA already cancelled, by live allocations (and earlier ones of the same event). */
  consumed: string;
  cancelled: string;
  /** Cash on account that is no advance, not yet taken. */
  plain: string;
  /** The cash this allocation applies. */
  applied: string;
}

export function takeFromAdvance(t: AdvanceTake): { plain: string; base: string; iva: string } {
  const total = new Decimal(t.total);
  const consumed = new Decimal(t.consumed);
  const applied = new Decimal(t.applied);
  const plain = Decimal.min(applied, Decimal.max(new Decimal(t.plain), 0));
  const fromAdvance = Decimal.min(applied.minus(plain), Decimal.max(total.minus(consumed), 0));
  if (fromAdvance.lessThanOrEqualTo(0)) return { plain: applied.toFixed(4), base: '0.0000', iva: '0.0000' };
  const after = consumed.plus(fromAdvance);
  const target = after.greaterThanOrEqualTo(total)
    ? new Decimal(t.iva)
    : new Decimal(t.iva).times(after).dividedBy(total).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
  const iva = Decimal.min(Decimal.max(target.minus(t.cancelled), 0), fromAdvance);
  return { plain: applied.minus(fromAdvance).toFixed(4), base: fromAdvance.minus(iva).toFixed(4), iva: iva.toFixed(4) };
}
