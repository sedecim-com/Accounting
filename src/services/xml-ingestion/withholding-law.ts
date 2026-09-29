import Decimal from 'decimal.js';
import type { LegalParameterInForce } from '../jurisdiction/legal-parameters.js';
import { toCalendarDate } from '../../utils/calendar-date.js';
import type { CfdiFacts } from './cfdi-facts.js';

// ============================================================
// WITHHOLDINGS ON FEES AND LEASES, FROM THE LAW (#309, MNE-001-056)
//
// A legal entity that pays an individual for professional services (LISR 106)
// or for the use of real estate (LISR 116) withholds 10 % of ISR, and two
// thirds of the VAT transferred to it (LIVA 1-A, RLIVA 3-I). The rates live in
// `legal_parameters` (migration 129) and are read on the CFDI date.
//
// WHICH CASE, FROM THE CFDI ITSELF: the receiver is a legal entity (a
// 12-character RFC), the issuer an individual (13). Regime 606 is a lease.
// Regime 612 covers both business and professional activity, and only the
// professional one is withheld on; the CFDI says which by declaring an ISR
// withholding. A 612 invoice for professional services that declares none is
// MNE-001-148's case, below: the firm's `fees_without_withholding` policy
// decides what happens to it.
// ============================================================

export const WITHHOLDING_KEYS = {
  professionalFeesIsr: 'income_tax.withholding.professional_fees_rate',
  leaseIsr: 'income_tax.withholding.lease_rate',
  vatThirds: 'vat.withholding.individual_thirds',
} as const;

export type WithholdingCase = 'professional_fees' | 'lease';

/** Reads one Mexican legal parameter on a date; fails closed like `legalParameterAt`. */
export type LegalParameterReader = (key: string, onDate: string) => Promise<LegalParameterInForce>;

export interface WithholdingByLaw {
  case: WithholdingCase;
  isr: number;
  iva: number;
  /** The rows the figures came from, to be quoted next to them. */
  basis: string;
}

export function withholdingCaseOf(f: CfdiFacts): WithholdingCase | null {
  if (f.direction !== 'recibido' || f.tipo !== 'I') return null;
  if (f.receptorRfc.length !== 12 || f.emisorRfc.length !== 13) return null;
  if (f.issuerRegime === '606') return 'lease';
  if (f.issuerRegime === '612' && f.isrRetenido > 0) return 'professional_fees';
  return null;
}

// ── MNE-001-148 · PROFESSIONAL FEES THAT DECLARE NO ISR WITHHELD ──
//
// Regime 612 also sells goods, and a purchase of goods is never withheld on,
// so the case is told from the c_ClaveProdServ of EVERY concept, and
// conservatively: only families of the catalog that are liberal professions
// count, and a CFDI with one concept outside them (a good, a lease, freight,
// construction, a software licence) is not flagged. Missing a real fee leaves
// the CFDI booked as declared, as before this task; flagging a purchase of
// goods would hold a legitimate invoice. The advance key 84111506 sits in the
// accounting family and is excluded: an advance may be for goods.
//
// The full c_ClaveProdServ catalog is not in the repo yet: these are family
// prefixes, the same device as the fixed-asset and restaurant prefixes of
// cfdi-decisions.ts.
const PROFESSIONAL_SERVICE_PREFIXES = [
  '8010', // management advisory (consulting)
  '8012', // legal services
  '8110', // professional engineering
  '811115', // software or hardware engineering
  '811116', // computer programmers
  '8411', // accounting, audit and tax
  '8512', // medical practice
];

export const UNWITHHELD_FEES_POLICIES = ['request_substitute_cfdi', 'withhold_by_law', 'record_as_issued'] as const;
export type UnwithheldFeesPolicy = (typeof UNWITHHELD_FEES_POLICIES)[number];

/** A 612 CFDI to a legal entity, all professional services, with no ISR withheld declared. */
export function isUnwithheldProfessionalFees(f: CfdiFacts): boolean {
  if (f.direction !== 'recibido' || f.tipo !== 'I' || f.esAnticipo) return false;
  if (f.receptorRfc.length !== 12 || f.emisorRfc.length !== 13 || f.issuerRegime !== '612') return false;
  if (f.isrRetenido > 0) return false;
  return (
    f.clavesProdServ.length > 0 &&
    f.clavesProdServ.every((k) => PROFESSIONAL_SERVICE_PREFIXES.some((p) => k.startsWith(p)))
  );
}

/** The panel's answer; anything it does not know holds the CFDI, which never posts by mistake. */
export function unwithheldFeesPolicyOf(value: string | undefined): UnwithheldFeesPolicy {
  return UNWITHHELD_FEES_POLICIES.find((p) => p === value) ?? 'request_substitute_cfdi';
}

/** The finding of the default: nothing is proposed, the vendor is asked for a substitute. */
export function substituteCfdiFinding(f: CfdiFacts): string {
  return (
    `Professional fees from an individual (${f.emisorRfc}, regime 612) with no ISR withheld declared: ` +
    'a legal entity withholds ISR and VAT on them (LISR 106, LIVA 1-A). ' +
    'Ask the vendor for a substitute CFDI that declares the withholding; nothing was written to the ledger. ' +
    'Policy fees_without_withholding=request_substitute_cfdi.'
  );
}

export async function withholdingByLaw(
  f: CfdiFacts,
  read: LegalParameterReader,
  /** Forced by the fees policy when the CFDI itself does not say it is fees. */
  which: WithholdingCase | null = withholdingCaseOf(f)
): Promise<WithholdingByLaw | null> {
  if (which === null) return null;
  const onDate = toCalendarDate(f.fecha);
  const isrRate = await read(
    which === 'lease' ? WITHHOLDING_KEYS.leaseIsr : WITHHOLDING_KEYS.professionalFeesIsr,
    onDate
  );
  const thirds = await read(WITHHOLDING_KEYS.vatThirds, onDate);
  // ISR on the payment without any deduction and without VAT; VAT on the VAT
  // transferred. Rounded once, to the cent, as the CFDI states amounts.
  const base = new Decimal(f.subtotal).minus(f.descuento);
  const vat = new Decimal(f.ivaTrasladado16).plus(f.ivaTrasladado8);
  return {
    case: which,
    isr: base.times(isrRate.value).toDecimalPlaces(2).toNumber(),
    iva: vat.times(thirds.value).div(3).toDecimalPlaces(2).toNumber(),
    basis:
      `${isrRate.key} = ${isrRate.value} and ${thirds.key} = ${thirds.value} ` +
      `(in force on ${onDate}; ${isrRate.sourceUrl}, ${thirds.sourceUrl})`,
  };
}

/**
 * What gets booked: the law's amount. Within rounding, the CFDI's own cents
 * stand, since the issuer rounds per concept and the entry must match the
 * document. Beyond it the law's amount is booked anyway, so the entry stops
 * balancing against the CFDI total and is held for the accountant, never
 * posted with the issuer's figure. The CFDI is a third party's and is not
 * corrected.
 */
export function settleWithholding(
  f: CfdiFacts,
  law: WithholdingByLaw
): { due: { isr: number; iva: number }; mismatch: string | null } {
  const tolerance = new Decimal('0.01').times(Math.max(1, f.clavesProdServ.length));
  const close = (a: number, b: number) => new Decimal(a).minus(b).abs().lessThanOrEqualTo(tolerance);
  const isrOk = close(law.isr, f.isrRetenido);
  const ivaOk = close(law.iva, f.ivaRetenido);
  const due = { isr: isrOk ? f.isrRetenido : law.isr, iva: ivaOk ? f.ivaRetenido : law.iva };
  if (isrOk && ivaOk) return { due, mismatch: null };
  return {
    due,
    mismatch:
      `Withholding by law on a ${law.case.replace('_', ' ')} CFDI: ISR ${law.isr.toFixed(2)} and ` +
      `VAT ${law.iva.toFixed(2)}, but the CFDI declares ISR ${f.isrRetenido.toFixed(2)} and VAT ` +
      `${f.ivaRetenido.toFixed(2)}. The law's amounts are booked and the entry is held: ${law.basis}.`,
  };
}
