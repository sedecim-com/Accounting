import Decimal from 'decimal.js';
import type pg from 'pg';

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
  /**
   * MNE-001-462 · The excess of a collection left on account whose treatment
   * nobody stated takes the one of the invoices it collects: their numbers,
   * and what was assumed when they carry several (`treatmentOfSale`).
   */
  from?: { invoices: string; assumed: 'highest' | 'exempt' | null };
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

/**
 * MNE-001-462 · What the cash an unapply puts back on account carries, on a
 * receipt recorded with a treatment.
 *
 * Under the owner's «no re-park» (#623, 17 Nov 2026; LIVA art. 1-B) the cash
 * on account of such a receipt is a taxed advance: its IVA was caused when it
 * was collected, by the invoice it paid or by the advance it was, and an
 * unapply moves no money. So the part of an allocation that took no advance
 * (`plain`, the record-time cash of a collection with an excess) goes back as
 * an advance at the receipt's own treatment, as part 6 returns an advance at
 * its declared rate (#623, comment 7005284036), split row by row as the
 * advance itself was (`splitAdvance`). Unapply posts it, and the advance a
 * later application consumes, and the IVA paper, read it with this same
 * function, so the three agree to the cent.
 */
export function backAsAdvance(plain: readonly string[], treatment: AdvanceTreatment): { cash: string; base: string; iva: string } {
  let cash = new Decimal(0);
  let iva = new Decimal(0);
  for (const p of plain) {
    if (!new Decimal(p).greaterThan(0)) continue;
    cash = cash.plus(p);
    iva = iva.plus(splitAdvance(new Decimal(p).toFixed(2), treatment).iva);
  }
  return { cash: cash.toFixed(4), base: cash.minus(iva).toFixed(4), iva: iva.toFixed(4) };
}

/**
 * MNE-001-572 · The cash a receipt's unapplies put back on account that took
 * no advance, as `backAsAdvance` splits it at the receipt's treatment. One
 * reader for the three that must agree to the cent: what is left of the
 * advance (`advanceLeft`), and the IVA a cheque's cashing causes for the cash
 * an unapply put back while the cheque was held (`pendingRelease`). Every
 * closed allocation of a held cheque was closed while it was held, because a
 * cheque is cashed once. Entity-scoped in the SQL.
 */
export async function advanceBackOnAccount(
  client: pg.PoolClient,
  entityId: string,
  receiptId: string,
  treatment: AdvanceTreatment
): Promise<{ cash: string; base: string; iva: string }> {
  const r = await client.query<{ plain: string }>(
    `SELECT (pa.amount_applied - pa.advance_base_amount - pa.advance_iva_amount)::text AS plain
       FROM payment_allocations pa
       JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $2
      WHERE pa.payment_id = $1 AND pa.unapplied_at IS NOT NULL`,
    [receiptId, entityId]
  );
  return backAsAdvance(r.rows.map((x) => x.plain), treatment);
}

/**
 * MNE-001-572 · Whether applying a held cheque's advance would cancel IVA
 * nobody has caused (LIVA art. 1-B, second paragraph): the cash takes IVA
 * from the advance (c > 0) while the cheque is not cashed, and the invoice's
 * own IVA for that cash does not offset it in the invoice's month. A PPD
 * invoice parks its IVA and a held cheque releases none of it; a PUE invoice
 * at another treatment, or one with several, carries other IVA than the
 * advance's. A PUE invoice at the receipt's single treatment is applied: its
 * entry cancels in its own month the IVA its issuance caused, and the
 * cashing causes the advance's on the bank's day (the owner's PUE ruling of
 * 19 Nov 2026 on #789).
 */
export function cancelsUncausedIva(a: {
  held: boolean;
  /** The advance's IVA this cash takes (c). */
  iva: string;
  ppd: boolean;
  /** The invoice's treatment (`treatmentOfSales`); null when it has none to read. */
  sale: { treatment: AdvanceTreatment; assumed: string | null } | null;
  receipt: AdvanceTreatment | null;
}): boolean {
  if (!a.held || !new Decimal(a.iva).greaterThan(0)) return false;
  if (a.ppd) return true;
  return a.sale === null || a.sale.assumed !== null || a.sale.treatment !== a.receipt;
}

/** MNE-001-462 · The note an entry carries when the excess took its treatment from the invoices it collects. */
export function advanceSourceNote(split: Pick<AdvanceSplit, 'treatment' | 'from'>): string {
  if (!split.from) return '';
  const rate = split.treatment === 'exempt' ? ', exempt' : split.treatment === 'not-subject' ? ', not subject to IVA' : ` at ${split.treatment} %`;
  const why = split.from.assumed === 'highest'
    ? ' (several rates: the highest assumed)'
    : split.from.assumed === 'exempt'
      ? ' (several treatments, none with IVA: exempt assumed)'
      : '';
  return ` · excess on account is an advance${rate}, from ${split.from.invoices}${why}`;
}
