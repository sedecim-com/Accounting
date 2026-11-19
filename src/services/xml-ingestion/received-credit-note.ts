import Decimal from 'decimal.js';
import type { ErrorMessageKey } from '../../utils/errors.js';
import type { CfdiFacts } from './cfdi-facts.js';
import { TIPO_RELACION } from './cfdi-facts.js';

// ============================================================
// THE RECEIVED CREDIT NOTE (MNE-001-489, #692)
//
// A vendor's type E with TipoRelacion 01 or 03 lowers the one bill it names:
// DR accounts payable for its total, CR the cost side, and its VAT out of
// "pending crediting" (1135) up to what the bill still has parked there, the
// rest out of creditable VAT (1130). The share already credited comes off the
// credit of the note's month, the unpaid share was never creditable (LIVA
// arts. 5 fr. III and 7; decided in #692 on 2026-11-17).
//
// This file is the rule as pure functions. Nothing here reads or writes: the
// posting is `postReceivedCreditNote` (received-credit-note-posting.ts).
// ============================================================

/** `journal_entries.source_type` of the note's entry; its `source_id` is the bill. */
export const VENDOR_CREDIT_NOTE_SOURCE = 'vendor_credit_note';

/** The two answers of the panel key `received_credit_note_cost`. */
export type ReceivedCreditNoteCost = 'bill_accounts' | 'purchase_returns';

/** A line of the bill: its account, its amount before tax, and the roles of that account. */
export interface BillCostLine { accountId: string; amount: string; roles: readonly string[] }

/** A bill of the entity whose UUID the note names among its related CFDI. */
export interface RelatedBill {
  billNumber: string;
  vendorRfc: string;
  status: string;
  currency: string;
  foreignCurrency: boolean;
  amountDue: string;
  taxAmount: string;
  totalAmount: string;
  /** A live application from before migration 105 stored no `iva_reclass_amount`. */
  hasApplicationWithoutRelease: boolean;
  lines: readonly BillCostLine[];
}

export type CostCredit =
  | { kind: 'account'; accountId: string; amount: string }
  | { kind: 'role'; role: 'devolucion_compras'; amount: string };

type RefusalReason =
  | 'not_received' | 'not_credit_note' | 'note_foreign_currency' | 'other_taxes' | 'related_bills'
  | 'bill_foreign_currency' | 'other_vendor' | 'bill_not_payable' | 'release_not_recorded'
  | 'exceeds_balance' | 'vat_out_of_proportion' | 'capitalised_line';

/** NOTE: the statuses a payment accepts too (the same list in payments/payment-service.ts). */
export const PAYABLE = ['approved', 'posted', 'partially_paid'];
/** A credit on these would write down an asset, not reverse an expense: a person decides. */
const CAPITALISED_ROLES = ['inventario', 'activo_fijo', 'gasto_anticipado'];
const LEDGER_SCALE = 4;
const CENT = new Decimal('0.01');

/** The transferred VAT of the note, as the taxonomy reads it (`A.ivaTrasladado`). */
export function noteVat(note: CfdiFacts): Decimal {
  return new Decimal(note.ivaTrasladado16).plus(note.ivaTrasladado8);
}

/**
 * Why this note waits for a person, or null when it can be posted. The first
 * reason that holds is the one named; `bills` are the entity's bills among the
 * note's related UUIDs.
 */
export function refusalOf(note: CfdiFacts, bills: readonly RelatedBill[]): ErrorMessageKey | null {
  const refuse = (reason: RefusalReason, params: Record<string, string | number> = {}): ErrorMessageKey => ({
    key: `credit_note.received.refusal.${reason}`,
    params: { note: note.uuid, ...params },
  });
  const money = (v: Decimal.Value): string => new Decimal(v).toFixed(2);

  if (note.direction !== 'recibido') {
    return refuse('not_received', { issuer: note.emisorRfc, receiver: note.receptorRfc });
  }
  const relation = note.tipoRelacion ?? '';
  if (note.tipo !== 'E' || (relation !== TIPO_RELACION.NOTA_CREDITO && relation !== TIPO_RELACION.DEVOLUCION)) {
    return refuse('not_credit_note', { type: note.tipo, relation: relation || '-' });
  }
  if (note.esMonedaExtranjera) return refuse('note_foreign_currency', { currency: note.moneda });
  const otherTaxes = [note.iepsTrasladado, note.impuestosLocalesTrasladados, note.isrRetenido, note.ivaRetenido, note.impuestosLocalesRetenidos];
  if (otherTaxes.some((amount) => amount !== 0)) return refuse('other_taxes');

  const [bill] = bills;
  if (!bill || bills.length !== 1) return refuse('related_bills', { count: bills.length });
  const named = { bill: bill.billNumber };
  if (bill.foreignCurrency) return refuse('bill_foreign_currency', { ...named, currency: bill.currency });
  if (bill.vendorRfc !== note.emisorRfc) {
    return refuse('other_vendor', { ...named, issuer: note.emisorRfc, vendor: bill.vendorRfc });
  }
  if (!PAYABLE.includes(bill.status)) {
    return refuse('bill_not_payable', { ...named, status: bill.status, payable: PAYABLE.join(', ') });
  }
  if (bill.hasApplicationWithoutRelease) return refuse('release_not_recorded', named);
  if (new Decimal(note.total).greaterThan(bill.amountDue)) {
    return refuse('exceeds_balance', { ...named, total: money(note.total), due: money(bill.amountDue) });
  }
  // One rate of VAT on the whole bill is what lets the note's VAT be read off
  // the bill's own proportion; a bill of mixed rates fails this by more than a cent.
  const vat = noteVat(note);
  const expected = new Decimal(note.total).times(bill.taxAmount).dividedBy(bill.totalAmount);
  if (vat.minus(expected).abs().toDecimalPlaces(LEDGER_SCALE).greaterThan(CENT)) {
    return refuse('vat_out_of_proportion', { ...named, vat: money(vat), expected: money(expected) });
  }
  const capitalised = bill.lines.flatMap((line) => line.roles).find((role) => CAPITALISED_ROLES.includes(role));
  if (capitalised) return refuse('capitalised_line', { ...named, role: capitalised });
  return null;
}

/**
 * Splits the note's VAT: out of the pending account up to what the bill still
 * has parked there (`receivedVatStillParked`), the rest out of creditable VAT.
 */
export function splitNoteVat(vat: Decimal.Value, stillParked: Decimal.Value): { fromPending: string; fromCreditable: string } {
  const total = new Decimal(vat);
  const fromPending = Decimal.max(Decimal.min(total, stillParked), 0);
  return {
    fromPending: fromPending.toFixed(LEDGER_SCALE),
    fromCreditable: total.minus(fromPending).toFixed(LEDGER_SCALE),
  };
}

/**
 * The credits of the cost side. `bill_accounts` reverses what the bill booked:
 * one credit per account the bill debited, pro rata to its lines and rounded
 * to the cent, the last one taking the remainder so they sum exactly.
 * `purchase_returns` is one credit on the role of purchase returns.
 */
export function spreadCost(
  cost: Decimal.Value,
  lines: readonly BillCostLine[],
  policy: ReceivedCreditNoteCost
): CostCredit[] {
  const total = new Decimal(cost);
  if (policy === 'purchase_returns') {
    return [{ kind: 'role', role: 'devolucion_compras', amount: total.toFixed(LEDGER_SCALE) }];
  }
  const byAccount = new Map<string, Decimal>();
  for (const line of lines) {
    byAccount.set(line.accountId, (byAccount.get(line.accountId) ?? new Decimal(0)).plus(line.amount));
  }
  const weight = [...byAccount.values()].reduce((sum, amount) => sum.plus(amount), new Decimal(0));
  if (weight.lessThanOrEqualTo(0)) {
    throw new Error('spreadCost: the bill has no line amount to prorate the cost of the note on');
  }
  let left = total;
  const accounts = [...byAccount.entries()];
  return accounts.map(([accountId, amount], index) => {
    const share = index === accounts.length - 1 ? left : total.times(amount).dividedBy(weight).toDecimalPlaces(2);
    left = left.minus(share);
    return { kind: 'account' as const, accountId, amount: share.toFixed(LEDGER_SCALE) };
  });
}
