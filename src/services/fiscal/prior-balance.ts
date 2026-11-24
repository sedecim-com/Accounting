import Decimal from 'decimal.js';
import type { Hallazgo } from '../sat/diot/index.js';
import { availableOf, type BalanceInFavorSource } from './filed-returns.js';
import { roundToWhole, toCents, type FilingRounding } from './iva-workpaper.js';

// ============================================================
// THE PRIOR BALANCE IN FAVOUR, FROM WHAT WAS DECLARED (#308 · MNE-001-386)
//
// The record of filed returns (migration 337, read by balancesInFavorBefore)
// says what each earlier balance was and what was done with it. This module
// says how much of it the month takes. Pure arithmetic: no query.
//
//   · AVAILABLE: a balance whose refund was requested is gone whole («Los
//     saldos cuya devolución se solicite no podrán acreditarse en
//     declaraciones posteriores», LIVA art. 6); otherwise the balance less
//     what other returns credited and what was compensated (CFF art. 23).
//   · THE CAP: «únicamente podrá acreditarlo contra el impuesto a su cargo»
//     (LIVA art. 6): the month's IVA payable after its own credit and
//     withholding, in the column the result uses (whole pesos under
//     cada_renglon, cents under solo_el_pago), never below zero. Crediting
//     never creates or enlarges a balance of the month.
//   · OLDEST FIRST: the law sets no order; the oldest first keeps the newer
//     balances whole, and so still refundable, since a refund covers a whole
//     balance (art. 6). Each remnant stays under its own return (23/IVA/N).
//     Another order is the person's override, with its reason.
//   · Under cada_renglon what is credited is whole pesos the balances hold:
//     crediting less than available is lawful, the rest carries forward.
// ============================================================

/** One earlier balance, with what this month takes of it. Two decimals. */
export interface PriorBalance extends BalanceInFavorSource {
  available: string;
  creditedHere: string;
  remnant: string;
}

export interface PriorBalanceProposal {
  /** The most the month can take: its tax payable, in the result's column, never below zero. */
  cap: string;
  available: string;
  credited: string;
  balances: PriorBalance[];
  findings: Hallazgo[];
}

const q2 = (d: Decimal): string => d.toFixed(2);

/** What a balance still holds: one formula, next to its reader, which the writer also checks (MNE-001-613). */
export { availableOf };

/** The month's payable in the result's column: whole pesos or cents. */
const inResultColumn = (amount: Decimal.Value, rounding: FilingRounding): Decimal =>
  rounding === 'cada_renglon' ? roundToWhole(amount) : toCents(amount);

/**
 * What the month credits from the record, oldest first, up to
 * `payableBeforeCredit`: the settlement's result with no prior balance, in
 * the column `rounding` declares.
 */
export function proposePriorCredit(
  sources: readonly BalanceInFavorSource[],
  payableBeforeCredit: string,
  rounding: FilingRounding
): PriorBalanceProposal {
  const findings: Hallazgo[] = [];
  const sorted = [...sources].sort((x, y) => x.period.localeCompare(y.period));
  const cap = Decimal.max(inResultColumn(payableBeforeCredit, rounding), 0);
  const available = sorted.reduce((acc, s) => acc.plus(availableOf(s)), new Decimal(0));
  const total = Decimal.min(rounding === 'cada_renglon' ? available.floor() : available, cap);
  let left = total;
  const balances = sorted.map((s): PriorBalance => {
    const overdrawn = new Decimal(s.balanceInFavor).minus(s.credited).minus(s.compensated);
    if (overdrawn.isNegative() && new Decimal(s.refundRequested).isZero()) {
      findings.push({
        codigo: 'IVA-WP-PRIOR-BALANCE-OVERDRAWN',
        severidad: 'aviso',
        mensaje:
          `El saldo a favor de ${s.period} (declaración ${s.acknowledgementNumber}) es ${s.balanceInFavor} y ya se ` +
          `acreditó o compensó por ${q2(overdrawn.negated())} más de eso: una complementaria lo redujo después de ` +
          `usarlo. Revisa las declaraciones que lo acreditaron antes de declarar.`,
      });
    }
    const own = availableOf(s);
    const here = Decimal.min(own, left);
    left = left.minus(here);
    if (here.greaterThan(0) && new Decimal(s.credited).isZero()) {
      findings.push({
        codigo: 'IVA-WP-PRIOR-BALANCE-FIRST-CREDIT',
        severidad: 'aviso',
        mensaje:
          `Es la primera vez que se acredita el saldo a favor de ${s.period} (declaración ${s.acknowledgementNumber}): ` +
          `se acreditan ${q2(here)} de ${q2(own)}. Desde esta declaración su remanente ya no puede pedirse en ` +
          `devolución y debe seguir acreditándose hasta agotarlo (criterio 23/IVA/N, LIVA art. 6).`,
      });
    }
    return { ...s, available: q2(own), creditedHere: q2(here), remnant: q2(own.minus(here)) };
  });
  return { cap: q2(cap), available: q2(available), credited: q2(total), balances, findings };
}

/** The findings of a figure a person gave instead of the record's, with the reason they gave. */
export function overrideFindings(
  amount: string,
  reason: string,
  proposal: PriorBalanceProposal,
  rounding: FilingRounding
): Hallazgo[] {
  const value = new Decimal(amount);
  const above = value.minus(proposal.available);
  const findings: Hallazgo[] = [{
    codigo: 'IVA-WP-PRIOR-BALANCE-OVERRIDE',
    severidad: 'aviso',
    mensaje:
      `El saldo a favor de periodos anteriores lo capturó una persona: ${q2(value)}, con el motivo «${reason}». ` +
      `Las declaraciones registradas proponían ${proposal.credited}` +
      (above.greaterThan(0)
        ? `, y lo capturado supera en ${q2(above)} lo que esas declaraciones dejan disponible (${proposal.available}).`
        : '.'),
  }];
  if (inResultColumn(value, rounding).greaterThan(proposal.cap)) {
    findings.push({
      codigo: 'IVA-WP-PRIOR-BALANCE-ABOVE-PAYABLE',
      severidad: 'bloqueante',
      mensaje:
        `El saldo a favor capturado (${q2(value)}) supera el IVA a cargo del mes (${proposal.cap}): un saldo a favor ` +
        `sólo se acredita contra el impuesto a cargo (LIVA art. 6), y acreditar de más crearía un saldo a favor de ` +
        `este mes. Captura a lo más ${proposal.cap}.`,
    });
  }
  return findings;
}
