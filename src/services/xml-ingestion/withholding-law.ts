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
//
// FREIGHT AND RESICO (MNE-001-057). A legal entity that receives land freight
// of goods withholds 4 % of the consideration as VAT, whoever the carrier is
// (LIVA 1-A II c, RLIVA 3-II). A legal entity that pays an individual in the
// simplified regime (RESICO, 626) withholds 1.25 % of ISR on whatever it pays
// for, goods, services or rent (LISR 113-J), and two thirds of the VAT when it
// is an independent personal service or the use of goods (LIVA 1-A II a). A
// CFDI whose declared withholdings differ from these follows the firm's
// `withholding_mismatch` policy, below; the CFDI is a third party's and is
// never corrected.
//
// Freight VAT is withheld only on VAT actually transferred: zero-rated
// international freight (LIVA 29-V) has none to withhold, and the withholding
// never exceeds what the carrier charged. Freight at the 8 % border rate is
// not computed: no rule in legal_parameters sets its withholding, so its
// declared figures stand and the classifier says so.
// ============================================================

export const WITHHOLDING_KEYS = {
  professionalFeesIsr: 'income_tax.withholding.professional_fees_rate',
  leaseIsr: 'income_tax.withholding.lease_rate',
  vatThirds: 'vat.withholding.individual_thirds',
  freightVat: 'vat.withholding.freight_rate',
  resicoIsr: 'income_tax.withholding.resico_rate',
} as const;

export type WithholdingCase = 'professional_fees' | 'lease' | 'freight' | 'resico';

/** c_ClaveProdServ family of land freight of goods ("transporte de carga por carretera"). */
const LAND_FREIGHT_PREFIX = '781018';
/** c_ClaveProdServ family of the lease of real estate. */
const REAL_ESTATE_LEASE_PREFIX = '801315';
const RESICO_REGIME = '626';

const allConceptsIn = (f: CfdiFacts, prefixes: readonly string[]): boolean =>
  f.clavesProdServ.length > 0 && f.clavesProdServ.every((k) => prefixes.some((p) => k.startsWith(p)));

/** An individual in RESICO: its ISR is withheld 1.25 % by a legal entity that pays it (LISR 113-J). */
const isResicoIndividual = (f: CfdiFacts): boolean =>
  f.emisorRfc.length === 13 && f.issuerRegime === RESICO_REGIME;

/** Reads one Mexican legal parameter on a date; fails closed like `legalParameterAt`. */
export type LegalParameterReader = (key: string, onDate: string) => Promise<LegalParameterInForce>;

export interface WithholdingByLaw {
  case: WithholdingCase;
  isr: number;
  iva: number;
  /** The rows the figures came from, to be quoted next to them. */
  basis: string;
}

/** Land freight at the 8 % border rate: its withholding is not in legal_parameters (see above). */
export function isBorderRateFreight(f: CfdiFacts): boolean {
  return allConceptsIn(f, [LAND_FREIGHT_PREFIX]) && f.ivaTrasladado8 > 0;
}

/**
 * The account qualifier of the ISR withheld (withholding-accounts.ts): a
 * RESICO individual's real-estate lease is a lease (grouping code 216.03)
 * even though its rate is 113-J's; anything else RESICO withholds falls back
 * to the default mapping, as the layout declares.
 */
export function withholdingQualifierOf(f: CfdiFacts): WithholdingCase | null {
  const which = withholdingCaseOf(f);
  return which === 'resico' && allConceptsIn(f, [REAL_ESTATE_LEASE_PREFIX]) ? 'lease' : which;
}

export function withholdingCaseOf(f: CfdiFacts): WithholdingCase | null {
  if (f.direction !== 'recibido' || f.tipo !== 'I') return null;
  if (f.receptorRfc.length !== 12) return null;
  // Freight first: it is withheld whoever the carrier is, individual or not.
  if (allConceptsIn(f, [LAND_FREIGHT_PREFIX])) return isBorderRateFreight(f) ? null : 'freight';
  if (f.emisorRfc.length !== 13) return null;
  if (f.issuerRegime === RESICO_REGIME) return 'resico';
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
  // ISR on the payment without any deduction and without VAT; VAT on the VAT
  // transferred, or on the consideration for freight. Rounded once, to the
  // cent, as the CFDI states amounts.
  const base = new Decimal(f.subtotal).minus(f.descuento);
  const vat = new Decimal(f.ivaTrasladado16).plus(f.ivaTrasladado8);
  const cents = (d: Decimal) => d.toDecimalPlaces(2).toNumber();
  const used: LegalParameterInForce[] = [];
  const rate = async (key: string) => {
    const p = await read(key, onDate);
    used.push(p);
    return p.value;
  };
  let isr = 0;
  let iva = 0;
  if (which === 'freight') {
    // Only on the concepts that carry VAT (zero-rated and exempt ones are
    // left out of the base), and never more than the VAT transferred.
    const taxed = Decimal.max(0, base.minus(f.ivaTasaCero).minus(f.importeExento));
    if (vat.greaterThan(0) && taxed.greaterThan(0)) {
      iva = cents(Decimal.min(taxed.times(await rate(WITHHOLDING_KEYS.freightVat)), vat));
    }
    // A RESICO carrier is an individual paid by a legal entity: 113-J applies too.
    if (isResicoIndividual(f)) isr = cents(base.times(await rate(WITHHOLDING_KEYS.resicoIsr)));
  } else if (which === 'resico') {
    isr = cents(base.times(await rate(WITHHOLDING_KEYS.resicoIsr)));
    // Two thirds of the VAT only on an independent personal service or the use
    // of goods, not on a sale, told from the concepts alone: professional
    // services or a real-estate lease. What the CFDI declares is what gets
    // checked, never the proof: a sale that declares VAT withheld is a
    // discrepancy, and so asked.
    if (allConceptsIn(f, [...PROFESSIONAL_SERVICE_PREFIXES, REAL_ESTATE_LEASE_PREFIX])) {
      iva = cents(vat.times(await rate(WITHHOLDING_KEYS.vatThirds)).div(3));
    }
  } else {
    isr = cents(base.times(
      await rate(which === 'lease' ? WITHHOLDING_KEYS.leaseIsr : WITHHOLDING_KEYS.professionalFeesIsr)
    ));
    iva = cents(vat.times(await rate(WITHHOLDING_KEYS.vatThirds)).div(3));
  }
  return {
    case: which,
    isr,
    iva,
    basis:
      `${used.map((p) => `${p.key} = ${p.value}`).join(' and ')} ` +
      `(in force on ${onDate}; ${used.map((p) => p.sourceUrl).join(', ')})`,
  };
}

// ── MNE-001-057 · A DECLARED WITHHOLDING THAT DIFFERS FROM THE LAW'S ──
//
// The panel key `withholding_mismatch` (pending-catalog.ts) says what happens
// to it; pre-registration passes the firm's answer as the answer to the
// classifier's question of the same name. Unanswered, the CFDI is held and
// the question is asked; an unknown value is taken as unanswered.
export const WITHHOLDING_MISMATCH_POLICIES = ['request_substitute_cfdi', 'withhold_by_law', 'record_as_issued'] as const;
export type WithholdingMismatchPolicy = (typeof WITHHOLDING_MISMATCH_POLICIES)[number];

export function withholdingMismatchPolicyOf(value: string | undefined): WithholdingMismatchPolicy | null {
  return WITHHOLDING_MISMATCH_POLICIES.find((p) => p === value) ?? null;
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
