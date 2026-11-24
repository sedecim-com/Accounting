import Decimal from 'decimal.js';
import type pg from 'pg';
import { AccountingError } from '../../utils/errors.js';
import { ivaToReclassify } from './iva-cash-basis.js';
import type { AccountRole } from '../xml-ingestion/cfdi-taxonomy.js';

// ============================================================
// IEPS ON CASH BASIS (LIEPS arts. 10, 5o. and 5o.-C)
//
// On a sale the IEPS «se causa en el momento en el que se cobren las
// contraprestaciones y sobre el monto de lo cobrado» (art. 10), a partial
// collection on the part actually received, with LIVA's tests of collection
// (art. 5o.-C). A PPD sale's IEPS therefore waits in its own uncollected role
// (grouping code 209.02, beside 209.01 for VAT) and moves to `ieps_por_pagar`
// (2180) with each collection, pro rata, on the entry that moves its VAT
// from 2125 to 2120 (#699).
//
// This module only MOVES what is parked; it parks nothing. Until an
// invoice's entry credits the uncollected role nothing here writes a line
// or reads a role, so an entity without that role posts exactly as before.
//
// THE LEDGER IS THE RECORD. The base is what the invoice's own entry parked,
// and every line that moves IEPS carries a tag naming its invoice and its
// receipt, so what a receipt has moved for an invoice is read back from the
// posted, unreversed entries. That makes an unapply exact (it gives back
// what that receipt moved, net of its earlier unapplies) and lets a reversal
// unwind both pairs with no bookkeeping of its own. VAT stores the same
// figure on `payment_allocations.iva_reclass_amount`; IEPS needs no column.
// ============================================================

/**
 * The role a PPD sale's IEPS waits in (2181): the taxonomy credits it on a PPD
 * sale, the seed maps it on Mexican books, and the backfill gives it to an
 * entity seeded before (MNE-001-505).
 */
export const IEPS_UNCOLLECTED_ROLE: AccountRole = 'ieps_trasladado_no_cobrado';
/** Where caused IEPS is owed (2180). */
export const IEPS_DUE_ROLE: AccountRole = 'ieps_por_pagar';
/** The key under `journal_entry_lines.tags` that ties an IEPS move to its invoice and receipt. */
export const IEPS_MOVE_TAG = 'ieps_release';

const SCALE = 4;

export interface IepsLine {
  account_id: string;
  debit_amount: string | null;
  credit_amount: string | null;
  description: string;
  tags: Record<string, unknown>;
}

/** One invoice's IEPS share of a collection event. */
export interface IepsMove {
  invoiceId: string;
  invoiceNumber: string;
  /** Functional currency, 4 dp. */
  amount: string;
  /**
   * MNE-001-590 · on a release only: the IEPS that the cash already carries,
   * caused when it was collected (`iepsKeptOnAccount`). It nets against the
   * share, so 2180 moves by amount − take, in either direction, and not at all
   * when the two are equal.
   */
  take?: string;
  /**
   * MNE-001-604 · on a release only: the allocation row it belongs to, tagged
   * on its lines (`allocation_id`), so the row's take is read back by row
   * (`iepsTakenByRows`).
   */
  allocationId?: string;
  /**
   * MNE-001-604 · on a `keep` only: what the rows took from the cash on
   * account goes back with it, net of the share released on that cash
   * (`iepsBackOf`), signed: 2180 is credited it, debited when negative.
   */
  back?: string;
}

/**
 * IEPS the invoice's own posted, unreversed entry parked in the uncollected
 * role, in the functional currency. Zero when nothing was parked, which is
 * also the answer on an entity without the role.
 */
export async function iepsParkedByInvoice(
  client: pg.PoolClient,
  entityId: string,
  invoiceId: string
): Promise<Decimal> {
  const { rows } = await client.query<{ ieps_parked: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS ieps_parked
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN account_roles ar ON ar.account_id = l.account_id
                            AND ar.entity_id = je.entity_id AND ar.qualifier IS NULL
      WHERE je.entity_id = $1 AND je.source_type = 'invoice' AND je.source_id = $2
        AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL
        AND ar.role = $3`,
    [entityId, invoiceId, IEPS_UNCOLLECTED_ROLE]
  );
  return Decimal.max(new Decimal(rows[0]?.ieps_parked ?? '0'), 0);
}

/**
 * Net IEPS moved out of the uncollected role for an invoice by every receipt,
 * or by one when `paymentId` is given: the tagged lines of posted entries
 * that have not been reversed. A reversed event's original stops counting
 * and its mirror is left out too, so a reversed event moved nothing.
 */
export async function iepsMovedForInvoice(
  client: pg.PoolClient,
  entityId: string,
  invoiceId: string,
  paymentId?: string
): Promise<Decimal> {
  const { rows } = await client.query<{ moved: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::text AS moved
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN account_roles ar ON ar.account_id = l.account_id
                            AND ar.entity_id = je.entity_id AND ar.qualifier IS NULL
      WHERE je.entity_id = $1 AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL
        AND je.is_reversal = false
        AND ar.role = $2
        AND l.tags -> '${IEPS_MOVE_TAG}' ->> 'invoice_id' = $3
        AND ($4::text IS NULL OR l.tags -> '${IEPS_MOVE_TAG}' ->> 'payment_id' = $4::text)`,
    [entityId, IEPS_UNCOLLECTED_ROLE, invoiceId, paymentId ?? null]
  );
  return new Decimal(rows[0]?.moved ?? '0');
}

/**
 * MNE-001-590 (#792) · The IEPS that a receipt's cash on account carries,
 * caused when it was collected: what the receipt's tagged lines credited to
 * 2180 net, less what they moved out of 2181 net. Both roles are liabilities,
 * so this is the sum of credit − debit over both. A live collection nets 0
 * (2181 Dr / 2180 Cr), and so does a re-park. An unapply that keeps the IEPS
 * caused adds the invoice's share (2181 Cr alone), and a later application
 * that takes some of it subtracts what it takes. The read covers posted,
 * unreversed entries that are not reversals, as `iepsMovedForInvoice` does.
 * Rows unapplied before this task re-parked or kept nothing back in 2181,
 * so they read 0.
 */
export async function iepsKeptOnAccount(
  client: pg.PoolClient,
  entityId: string,
  paymentId: string
): Promise<string> {
  const { rows } = await client.query<{ kept: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)), 0)::text AS kept
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN account_roles ar ON ar.account_id = l.account_id
                            AND ar.entity_id = je.entity_id AND ar.qualifier IS NULL
      WHERE je.entity_id = $1 AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL
        AND je.is_reversal = false
        AND ar.role = ANY($2::text[])
        AND l.tags -> '${IEPS_MOVE_TAG}' ->> 'payment_id' = $3`,
    [entityId, [IEPS_UNCOLLECTED_ROLE, IEPS_DUE_ROLE], paymentId]
  );
  return Decimal.max(new Decimal(rows[0]?.kept ?? '0'), 0).toFixed(SCALE);
}

/**
 * MNE-001-604 (#792) · What each allocation row's application moved, read
 * back from its tagged lines (`allocation_id`, written since this task):
 * `released`, the invoice's share it moved out of 2181, and `taken`, the
 * IEPS it took from the cash on account (2181 Dr r and 2180 Cr r − e sum, as
 * debit − credit, to e). A row written before carries no such tag and is
 * absent, so its unapply reads as before. One query, entity-scoped.
 */
export async function iepsTakenByRows(
  client: pg.PoolClient,
  entityId: string,
  allocationIds: readonly string[]
): Promise<Map<string, { released: string; taken: string }>> {
  if (allocationIds.length === 0) return new Map();
  const { rows } = await client.query<{ allocation_id: string; released: string; taken: string }>(
    `SELECT l.tags -> '${IEPS_MOVE_TAG}' ->> 'allocation_id' AS allocation_id,
            SUM(CASE WHEN ar.role = $2 THEN COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0) ELSE 0 END)::text AS released,
            SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))::text AS taken
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id
       JOIN account_roles ar ON ar.account_id = l.account_id
                            AND ar.entity_id = je.entity_id AND ar.qualifier IS NULL
      WHERE je.entity_id = $1 AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL
        AND je.is_reversal = false
        AND ar.role = ANY($3::text[])
        AND l.tags -> '${IEPS_MOVE_TAG}' ->> 'allocation_id' = ANY($4::text[])
      GROUP BY 1`,
    [entityId, IEPS_UNCOLLECTED_ROLE, [IEPS_UNCOLLECTED_ROLE, IEPS_DUE_ROLE], [...allocationIds]]
  );
  return new Map(rows.map((r) => [r.allocation_id, {
    released: new Decimal(r.released).toFixed(SCALE), taken: new Decimal(r.taken).toFixed(SCALE),
  }]));
}

/**
 * MNE-001-608 (#792, risk 3 of #891) · The IEPS of the share whose IVA a held
 * cheque's unapply stored for its cashing (`unapply_kept_iva_amount`, 586):
 * the invoice's parked IEPS × `marked` / its IVA, at four decimals, half up,
 * never more than parked. The marker is the invoice's IVA times the fraction
 * those rows settled (its telescope), and the cashing would have released the
 * parked IEPS by the same fraction, so the marker is all the row needs to
 * keep. Zero when the invoice has no IVA to read the fraction from.
 */
export function heldIepsShare(s: { parked: Decimal.Value; marked: Decimal.Value; tax: Decimal.Value }): string {
  const parked = Decimal.max(new Decimal(s.parked), 0);
  const marked = new Decimal(s.marked);
  const tax = new Decimal(s.tax);
  if (!parked.greaterThan(0) || !marked.greaterThan(0) || !tax.greaterThan(0)) return new Decimal(0).toFixed(SCALE);
  return Decimal.min(parked.times(marked).dividedBy(tax).toDecimalPlaces(SCALE, Decimal.ROUND_HALF_UP), parked).toFixed(SCALE);
}

/**
 * MNE-001-608 · The IEPS a held cheque's cash back on account carries for its
 * cashing, per invoice (`heldIepsShare`): the receipt's closed rows that
 * stored a marker, summed by invoice. A cheque is cashed once, and every row
 * it closes before that is a held one, so only the cashing reads this.
 */
export async function iepsHeldForCashing(
  client: pg.PoolClient,
  entityId: string,
  paymentId: string
): Promise<IepsMove[]> {
  const { rows } = await client.query<{ invoice_id: string; invoice_number: string; tax: string; marked: string }>(
    `SELECT pa.invoice_id::text, i.invoice_number, i.tax_amount::text AS tax,
            SUM(pa.unapply_kept_iva_amount)::text AS marked
       FROM payment_allocations pa
       JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1
       JOIN invoices i ON i.id = pa.invoice_id AND i.entity_id = $1
      WHERE pa.payment_id = $2 AND pa.unapplied_at IS NOT NULL AND pa.unapply_kept_iva_amount > 0
      GROUP BY pa.invoice_id, i.invoice_number, i.tax_amount
      ORDER BY i.invoice_number`,
    [entityId, paymentId]
  );
  const moves: IepsMove[] = [];
  for (const row of rows) {
    const parked = await iepsParkedByInvoice(client, entityId, row.invoice_id);
    const amount = heldIepsShare({ parked, marked: row.marked, tax: row.tax });
    if (new Decimal(amount).greaterThan(0)) moves.push({ invoiceId: row.invoice_id, invoiceNumber: row.invoice_number, amount });
  }
  return moves;
}

/**
 * The IEPS one collection event causes on one invoice: the invoice's parked
 * IEPS times what this event collects over the invoice total, as the
 * difference of two cumulative targets (the VAT's `ivaToReclassify`), so
 * partial collections never drift and the one that completes the invoice
 * moves the exact remainder. Never more than is still parked.
 *
 * `priorApplied` and `appliedNow` are in the invoice's currency, the parked
 * base in the functional one: the ratio carries no currency, so the share
 * comes out at the value the IEPS was parked at.
 */
export async function iepsCausedBy(
  client: pg.PoolClient,
  entityId: string,
  doc: { invoiceId: string; totalAmount: string; priorApplied: string; appliedNow: string }
): Promise<string> {
  const parked = await iepsParkedByInvoice(client, entityId, doc.invoiceId);
  if (parked.lessThanOrEqualTo(0)) return new Decimal(0).toFixed(SCALE);
  const share = new Decimal(
    ivaToReclassify({
      ivaTotal: parked.toFixed(SCALE),
      documentTotal: doc.totalAmount,
      priorApplied: doc.priorApplied,
      appliedNow: doc.appliedNow,
    })
  );
  const still = parked.minus(await iepsMovedForInvoice(client, entityId, doc.invoiceId));
  return Decimal.max(Decimal.min(share, still), 0).toFixed(SCALE);
}

/**
 * The IEPS a receipt's own entry causes, per invoice it applies to: its live
 * allocations (cash plus the customer's withholding, as the VAT counts them)
 * over what every live allocation had applied before it.
 */
export async function iepsCausedByReceipt(
  client: pg.PoolClient,
  entityId: string,
  paymentId: string
): Promise<IepsMove[]> {
  const { rows } = await client.query<{
    invoice_id: string; invoice_number: string; total_amount: string; applied_now: string; applied_total: string;
  }>(
    `SELECT pa.invoice_id, i.invoice_number, i.total_amount::text AS total_amount,
            SUM(pa.amount_applied + pa.withholding_isr_amount + pa.withholding_iva_amount)::text AS applied_now,
            (SELECT COALESCE(SUM(pa2.amount_applied + pa2.withholding_isr_amount + pa2.withholding_iva_amount), 0)
               FROM payment_allocations pa2
              WHERE pa2.invoice_id = pa.invoice_id AND pa2.unapplied_at IS NULL)::text AS applied_total
       FROM payment_allocations pa
       JOIN invoices i ON i.id = pa.invoice_id
      WHERE pa.payment_id = $1 AND i.entity_id = $2 AND pa.unapplied_at IS NULL
      GROUP BY pa.invoice_id, i.invoice_number, i.total_amount
      ORDER BY i.invoice_number`,
    [paymentId, entityId]
  );
  const moves: IepsMove[] = [];
  for (const row of rows) {
    const now = new Decimal(row.applied_now);
    const prior = Decimal.max(new Decimal(row.applied_total).minus(now), 0);
    const amount = await iepsCausedBy(client, entityId, {
      invoiceId: row.invoice_id,
      totalAmount: row.total_amount,
      priorApplied: prior.toFixed(SCALE),
      appliedNow: now.toFixed(SCALE),
    });
    if (new Decimal(amount).greaterThan(0)) {
      moves.push({ invoiceId: row.invoice_id, invoiceNumber: row.invoice_number, amount });
    }
  }
  return moves;
}

/**
 * The lines that move each share between the two IEPS roles, tagged with the
 * invoice and the receipt. `release` debits the uncollected role and credits
 * 2180 (both are liabilities); `repark` is its mirror, for an unapply. The
 * roles are read only when there is something to move, so an entity that
 * parks nothing never needs them; one that parked IEPS and lacks 2180's role
 * is told so instead of posting a half.
 *
 * MNE-001-590 (#792) · `keep` is the unapply of a receipt whose IEPS stays
 * caused: the share goes back to the uncollected role because the invoice is
 * owed again, and 2180 does not move, so the cash back on account carries it
 * (LIEPS art. 10). A release with a `take` nets it: 2180 is credited
 * amount − take, debited when that is negative, and gets no line at zero. A
 * take is written even for an invoice that releases nothing.
 *
 * MNE-001-604 · A `keep` with `back` also gives the cash what its rows took
 * from it: one 2180 line, CR back (DR when negative), tagged, beside 2181 Cr
 * amount (none at zero). A release tags its row (`allocationId`).
 *
 * MNE-001-608 · `cause` is a held cheque's cashing of the IEPS its cash back
 * on account carries (`iepsHeldForCashing`): one 2180 credit, tagged, so the
 * cash carries it (`iepsKeptOnAccount`); 2181 does not move, because the
 * invoice is owed again, and the caller debits 2150, as for the IVA marker.
 */
export async function iepsMoveLines(
  client: pg.PoolClient,
  entityId: string,
  paymentId: string,
  moves: readonly IepsMove[],
  direction: 'release' | 'repark' | 'keep' | 'cause',
  event: string
): Promise<IepsLine[]> {
  const live = moves.filter((m) =>
    new Decimal(m.amount).greaterThan(0) || new Decimal(m.take ?? '0').greaterThan(0) || !new Decimal(m.back ?? '0').isZero());
  if (live.length === 0) return [];
  const { rows } = await client.query<{ role: string; account_id: string }>(
    `SELECT role, account_id FROM account_roles
      WHERE entity_id = $1 AND role = ANY($2::text[]) AND qualifier IS NULL`,
    [entityId, [IEPS_UNCOLLECTED_ROLE, IEPS_DUE_ROLE]]
  );
  const accountOf = (role: string): string => {
    const id = rows.find((r) => r.role === role)?.account_id;
    if (!id) {
      throw new AccountingError(
        'MISSING_ROLE_ACCOUNT',
        `No account is mapped to the role "${role}" on this entity, and an invoice parked IEPS that this ` +
          `${event} causes (LIEPS art. 10). Map it with: mnemosine account map set (or check with: mnemosine doctor)`
      );
    }
    return id;
  };
  const uncollected = accountOf(IEPS_UNCOLLECTED_ROLE);
  const due = accountOf(IEPS_DUE_ROLE);

  return live.flatMap((m): IepsLine[] => {
    const tags = {
      [IEPS_MOVE_TAG]: { invoice_id: m.invoiceId, payment_id: paymentId, ...(m.allocationId ? { allocation_id: m.allocationId } : {}) },
    };
    const amount = new Decimal(m.amount).toFixed(SCALE);
    if (direction === 'cause') {
      return [{
        account_id: due,
        debit_amount: null,
        credit_amount: amount,
        description: `IEPS now in ${IEPS_DUE_ROLE} (caused on ${event}, LIEPS art. 10) on the cash back on account, ` +
          `kept for the cashing when it was unapplied - Invoice ${m.invoiceNumber}`,
        tags,
      }];
    }
    if (direction === 'keep') {
      const back = new Decimal(m.back ?? '0');
      return [
        ...(new Decimal(amount).greaterThan(0)
          ? [{
              account_id: uncollected,
              debit_amount: null,
              credit_amount: amount,
              description: `IEPS back in ${IEPS_UNCOLLECTED_ROLE} (${event}), kept caused in ${IEPS_DUE_ROLE} on the cash ` +
                `back on account (LIEPS art. 10) - Invoice ${m.invoiceNumber}`,
              tags,
            }]
          : []),
        ...(back.isZero()
          ? []
          : [{
              account_id: due,
              debit_amount: back.isNegative() ? back.negated().toFixed(SCALE) : null,
              credit_amount: back.isNegative() ? null : back.toFixed(SCALE),
              description: back.isNegative()
                ? `IEPS released on cash from on account undone (${event}), net of what it carried - Invoice ${m.invoiceNumber}`
                : `IEPS the cash on account carried, taken on its application, back with it (${event}; caused when ` +
                  `collected, LIEPS art. 10) - Invoice ${m.invoiceNumber}`,
              tags,
            }]),
      ];
    }
    const take = new Decimal(m.take ?? '0');
    if (direction === 'release' && take.greaterThan(0)) {
      const net = new Decimal(amount).minus(take);
      return [
        ...(new Decimal(amount).greaterThan(0)
          ? [{
              account_id: uncollected,
              debit_amount: amount,
              credit_amount: null,
              description: `IEPS released from ${IEPS_UNCOLLECTED_ROLE} on ${event} - Invoice ${m.invoiceNumber}`,
              tags,
            }]
          : []),
        ...(net.isZero()
          ? []
          : [{
              account_id: due,
              debit_amount: net.isNegative() ? net.negated().toFixed(SCALE) : null,
              credit_amount: net.isNegative() ? null : net.toFixed(SCALE),
              description: net.isNegative()
                ? `IEPS the cash on account carried (caused when collected) taken on ${event}: ` +
                  `${take.toFixed(SCALE)}, net of ${amount} released - Invoice ${m.invoiceNumber}`
                : `IEPS now in ${IEPS_DUE_ROLE} (caused on ${event}, LIEPS art. 10) - Invoice ${m.invoiceNumber}, ` +
                  `net of ${take.toFixed(SCALE)} the cash on account carried, caused when collected`,
              tags,
            }]),
      ];
    }
    const out = direction === 'release';
    return [
      {
        account_id: out ? uncollected : due,
        debit_amount: amount,
        credit_amount: null,
        description: out
          ? `IEPS released from ${IEPS_UNCOLLECTED_ROLE} on ${event} - Invoice ${m.invoiceNumber}`
          : `IEPS re-parked out of ${IEPS_DUE_ROLE} (${event}) - Invoice ${m.invoiceNumber}`,
        tags,
      },
      {
        account_id: out ? due : uncollected,
        debit_amount: null,
        credit_amount: amount,
        description: out
          ? `IEPS now in ${IEPS_DUE_ROLE} (caused on ${event}, LIEPS art. 10) - Invoice ${m.invoiceNumber}`
          : `IEPS back in ${IEPS_UNCOLLECTED_ROLE} (${event}) - Invoice ${m.invoiceNumber}`,
        tags,
      },
    ];
  });
}
