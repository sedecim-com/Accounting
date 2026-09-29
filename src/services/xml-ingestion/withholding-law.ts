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
// withholding. A 612 invoice that should declare one and does not is the
// discrepancy MNE-001-057 will name.
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

export async function withholdingByLaw(
  f: CfdiFacts,
  read: LegalParameterReader
): Promise<WithholdingByLaw | null> {
  const which = withholdingCaseOf(f);
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
