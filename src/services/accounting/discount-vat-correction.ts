import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { sqlKeepsMexicanBooks } from '../jurisdiction/jurisdiction.js';
import {
  discountVatShare, ivaStillParked, receivedVatStillParked, reclassRoles, DISCOUNT_VAT_CORRECTION_SOURCE,
} from './iva-cash-basis.js';
import { createJournalEntry, attestEntryAsync } from './posting.js';
import { correctionPeriodOf, periodsFor, inReopenedPeriods, type CorrectionPeriod } from './vat-overcredit.js';
import { JournalEntryType } from '../../types/index.js';
import { AccountingError } from '../../utils/errors.js';
import { getPolicy } from '../policy/policy-service.js';
import { todayFor } from '../policy/today.js';
import { registrarAuditoria } from '../audit/audit-log.js';
import { writtenOffOf } from '../payments/payment-service.js';

// ============================================================
// THE VAT OF AN EARLY-PAYMENT DISCOUNT LEFT IN 1135 BEFORE 341 (MNE-001-599 · #831).
//
// On cash-basis books a received bill parks its VAT in 1135 and each payment
// moves the share of the cash it pays to 1130 (LIVA art. 5 fr. III). A
// discount lowers the price, and with it the VAT (art. 7): its share was never
// paid, so it is never creditable, and it is not a cost either. From migration
// 341 it leaves 1135 against the discount in the payment's own entry
// (MNE-001-597). Before 341 the whole discount went to 5200 and that share
// stayed in 1135, so both are overstated by it.
//
// This census names what is left: the live applications that took a discount
// and store no discount VAT (NULL, written before 341), on bills that still
// have something parked, with the share of each, per bill, payment and month,
// capped by what the bill still has in 1135. It writes nothing.
//
// `correctDiscountVat`, run by a person with `--apply`, posts DR 5200 / CR
// 1135 per bill and payment, audited, dated as the panel key
// `discount_vat_correction_period` says, and stores the share on the row in
// place of its NULL so that a later unapply gives back exactly that. No entry
// is edited and no stored value changes (NIF B-1; ADR-0006 decision 2). The
// VAT declared does not change: the DIOT and the IVA paper read what the cash
// paid. The ISR deductions of the corrected months rise by the share.
// ============================================================

export { DISCOUNT_VAT_CORRECTION_SOURCE };

const SCALE = 4;
/** A figure under half a cent is rounding. */
const NOISE = new Decimal('0.005');
const DISCOUNT_ROLE = 'devolucion_compras';

/**
 * The share of each discount on one bill, in the order the rows were
 * written, each capped by what is still parked after the ones before it. On a
 * bill that owes nothing the last one closes it (`discountVatShare`).
 */
export function splitDiscountVat(input: {
  taxAmount: string;
  totalAmount: string;
  /** What the bill still has in 1135 (`receivedVatStillParked`), functional currency. */
  parked: string;
  /** The bill owes nothing. */
  paid: boolean;
  /** The bill's historical rate, for a bill in another currency. */
  rate?: string;
  discounts: readonly string[];
}): string[] {
  let remainder = new Decimal(input.parked);
  return input.discounts.map((discount, i) => {
    const share = discountVatShare({
      discount, taxAmount: input.taxAmount, totalAmount: input.totalAmount, remainder,
      closes: input.paid && i === input.discounts.length - 1,
      ...(input.rate !== undefined ? { rate: input.rate } : {}),
    });
    remainder = remainder.minus(share);
    return share;
  });
}

/** Why a listed bill is not corrected automatically. */
export type DiscountVatReason = 'foreign_currency' | 'closed_short' | 'header_edited' | 'no_role_account';

export interface DiscountVatRow {
  applicationId: string;
  paymentId: string;
  paymentNumber: string;
  /** The day of the entry that posted the discount: the month of the error. */
  date: string;
  discount: string;
  share: string;
}

export interface DiscountVatFinding {
  tenantId: string;
  entityId: string;
  entityName: string;
  billId: string;
  billNumber: string;
  currency: string;
  taxAmount: string;
  totalAmount: string;
  /** What the bill still has in 1135 before the correction. */
  parked: string;
  /** What the correction takes out of 1135 and off the discount. */
  share: string;
  rows: DiscountVatRow[];
  byMonth: Array<{ month: string; share: string }>;
  reasons: Array<{ code: DiscountVatReason; detail: string }>;
  correctable: boolean;
}

interface Row {
  tenant_id: string;
  entity_id: string;
  entity_name: string;
  functional_currency: string | null;
  bill_id: string;
  bill_number: string;
  tax_amount: string;
  total_amount: string;
  amount_due: string;
  currency_code: string;
  exchange_rate: string | null;
  roles: number;
  application_id: string;
  payment_id: string;
  payment_number: string;
  discount: string;
  discount_date: string;
}

// The live applications that took a discount and store no discount VAT, on
// cash-basis books. The discount's day is the entry that posted it: the
// payment's, or a later application's, which shares the row's transaction
// time (both are written in one), so the latest of the payment's entries up
// to the row's creation. The entity bounds both ends of the bridge table.
const ROWS = `
SELECT le.tenant_id, le.id AS entity_id, le.name AS entity_name, le.functional_currency,
       b.id AS bill_id, b.bill_number, b.tax_amount::text AS tax_amount, b.total_amount::text AS total_amount,
       b.amount_due::text AS amount_due, b.currency_code, b.exchange_rate::text AS exchange_rate,
       (SELECT count(DISTINCT ar.role)::int FROM account_roles ar
         WHERE ar.entity_id = b.entity_id AND ar.qualifier IS NULL AND ar.role IN ($4, $5)) AS roles,
       pa.id AS application_id, vp.id AS payment_id, vp.payment_number,
       pa.discount_amount::text AS discount,
       to_char(COALESCE(d.entry_date, vp.payment_date), 'YYYY-MM-DD') AS discount_date
  FROM payment_applications pa
  JOIN bills b ON b.id = pa.bill_id
  JOIN vendor_payments vp ON vp.id = pa.payment_id AND vp.entity_id = b.entity_id
  JOIN legal_entities le ON le.id = b.entity_id
  LEFT JOIN LATERAL (
       SELECT je.entry_date FROM journal_entries je
        WHERE je.entity_id = b.entity_id AND je.source_id = vp.id AND je.status = 'posted'
          AND je.source_type IN ('vendor_payment', 'vendor_application') AND je.created_at <= pa.created_at
        ORDER BY je.created_at DESC, je.entry_date DESC LIMIT 1) d ON true
 WHERE le.tenant_id = $1
   AND ($2::uuid IS NULL OR le.id = $2::uuid)
   AND ($3::uuid IS NULL OR b.id = $3::uuid)
   AND ${sqlKeepsMexicanBooks('le')}
   AND b.status NOT IN ('void', 'cancelled')
   AND pa.unapplied_at IS NULL
   AND pa.discount_iva_amount IS NULL
   AND COALESCE(pa.discount_amount, 0) > 0
   AND vp.journal_entry_id IS NOT NULL
   AND vp.status <> 'void'
 ORDER BY le.name, b.bill_number, b.id, pa.created_at, pa.id`;

const sum = (xs: readonly string[]): Decimal => xs.reduce((s, x) => s.plus(x), new Decimal(0));

async function findingOf(client: pg.PoolClient, rows: Row[]): Promise<DiscountVatFinding | null> {
  const bill = rows[0];
  const reasons: DiscountVatFinding['reasons'] = [];
  const say = (code: DiscountVatReason, detail: string) => reasons.push({ code, detail });
  const foreign = bill.functional_currency !== null && bill.currency_code !== bill.functional_currency;

  let parked = new Decimal(0);
  if (bill.roles < 2) {
    say('no_role_account', `the entity has no account for the pending VAT or the ${DISCOUNT_ROLE} role`);
  } else {
    parked = new Decimal(await receivedVatStillParked(client, bill.entity_id, bill.bill_id));
    // Nothing parked: the bill never waited in 1135, or nothing is left there.
    if (parked.lessThanOrEqualTo(NOISE)) return null;
    if (foreign) {
      say('foreign_currency', `in ${bill.currency_code}: 1135 holds it at the bill's rate and 5200 at each payment's, so the share is not one figure`);
    } else {
      const born = new Decimal(await ivaStillParked(client, 'received', bill.entity_id, bill.bill_id, { beforeCreditNotes: true }));
      if (born.minus(bill.tax_amount).abs().greaterThan(NOISE)) {
        say('header_edited', `the bill parked ${born.toFixed(SCALE)} and its header says ${new Decimal(bill.tax_amount).toFixed(SCALE)}: the share would be a guess`);
      }
    }
    const writtenOff = await writtenOffOf(client, bill.entity_id, { id: bill.bill_id, total_amount: bill.total_amount, amount_due: bill.amount_due });
    if (writtenOff.abs().greaterThanOrEqualTo('0.01')) {
      say('closed_short', `closed short (${writtenOff.toFixed(2)} written off): the VAT of the write-off is stored nowhere`);
    }
  }

  const shares = splitDiscountVat({
    taxAmount: bill.tax_amount, totalAmount: bill.total_amount, parked: parked.toFixed(SCALE),
    paid: new Decimal(bill.amount_due).lessThanOrEqualTo(0),
    ...(foreign && bill.exchange_rate ? { rate: bill.exchange_rate } : {}),
    discounts: rows.map((r) => r.discount),
  });
  const share = sum(shares);
  const byMonth = new Map<string, Decimal>();
  rows.forEach((r, i) => {
    const month = r.discount_date.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? new Decimal(0)).plus(shares[i]));
  });

  return {
    tenantId: bill.tenant_id, entityId: bill.entity_id, entityName: bill.entity_name,
    billId: bill.bill_id, billNumber: bill.bill_number, currency: bill.currency_code,
    taxAmount: new Decimal(bill.tax_amount).toFixed(SCALE), totalAmount: new Decimal(bill.total_amount).toFixed(SCALE),
    parked: parked.toFixed(SCALE), share: share.toFixed(SCALE),
    rows: rows.map((r, i) => ({
      applicationId: r.application_id, paymentId: r.payment_id, paymentNumber: r.payment_number,
      date: r.discount_date, discount: new Decimal(r.discount).toFixed(SCALE), share: shares[i],
    })),
    byMonth: [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, s]) => ({ month, share: s.toFixed(SCALE) })),
    reasons,
    correctable: reasons.length === 0 && share.greaterThan(NOISE),
  };
}

async function readFindings(
  client: pg.PoolClient, tenantId: string, entityId: string | null, billId: string | null
): Promise<DiscountVatFinding[]> {
  const { from } = reclassRoles('received');
  const { rows } = await client.query<Row>(ROWS, [tenantId, entityId, billId, from, DISCOUNT_ROLE]);
  const byBill = new Map<string, Row[]>();
  for (const r of rows) byBill.set(r.bill_id, [...(byBill.get(r.bill_id) ?? []), r]);
  const out: DiscountVatFinding[] = [];
  for (const billRows of byBill.values()) {
    const finding = await findingOf(client, billRows);
    if (finding) out.push(finding);
  }
  return out;
}

/**
 * Every bill of the tenant (or of one entity) whose discount, posted before
 * migration 341, left its VAT in 1135. Writes nothing.
 */
export async function censusDiscountVat(tenantId: string, entityId?: string | null): Promise<DiscountVatFinding[]> {
  return withTransaction((client) => readFindings(client, tenantId, entityId ?? null, null));
}

// ============================================================
// THE CORRECTION
// ============================================================

const CORRECTION_PERIOD_KEY = 'discount_vat_correction_period';

export interface DiscountVatCorrectionResult {
  corrected: Array<{ billId: string; billNumber: string; entryIds: string[]; amount: string }>;
  skipped: Array<{ billId: string; billNumber: string; why: string }>;
  failures: string[];
  amount: string;
}

interface Posting {
  paymentId: string;
  paymentNumber: string;
  date: string;
  amount: Decimal;
  rows: DiscountVatRow[];
}

/** Another run, or another event, changed the bill between the census and the write. */
class ChangedMeanwhile extends Error {}

/**
 * One entry per payment: the source of each is its payment, so `payment
 * reverse` mirrors it. Dated today, or on the day each discount was posted,
 * one entry per payment and month.
 */
async function postingsOf(x: DiscountVatFinding, option: CorrectionPeriod): Promise<Posting[]> {
  const today = option === 'current_period' ? await todayFor({ tenantId: x.tenantId, entityId: x.entityId }) : null;
  const byKey = new Map<string, Posting>();
  for (const r of x.rows) {
    if (new Decimal(r.share).lessThanOrEqualTo(0)) continue;
    const key = `${r.paymentId}|${today ?? r.date.slice(0, 7)}`;
    const p = byKey.get(key) ?? { paymentId: r.paymentId, paymentNumber: r.paymentNumber, date: today ?? r.date, amount: new Decimal(0), rows: [] };
    p.amount = p.amount.plus(r.share);
    if (r.date > p.date && !today) p.date = r.date;
    p.rows.push(r);
    byKey.set(key, p);
  }
  return [...byKey.values()].sort((a, b) => a.date.localeCompare(b.date) || a.paymentNumber.localeCompare(b.paymentNumber));
}

const sameRows = (a: DiscountVatFinding, b: DiscountVatFinding): boolean =>
  JSON.stringify(a.rows.map((r) => [r.applicationId, r.share])) === JSON.stringify(b.rows.map((r) => [r.applicationId, r.share]));

/**
 * Takes each correctable finding's discount VAT out of 1135 against the
 * discount. The panel key is read for every entity before anything is
 * written. Each bill is its own transaction: it is locked, read again, and
 * skipped when it moved, and each row is filled only while it is still NULL,
 * so a second run, or two at once, posts nothing twice.
 */
export async function correctDiscountVat(
  findings: readonly DiscountVatFinding[],
  actorUserId: string,
  opts: { reopen?: boolean } = {}
): Promise<DiscountVatCorrectionResult> {
  const out: DiscountVatCorrectionResult = { corrected: [], skipped: [], failures: [], amount: '0.0000' };
  let total = new Decimal(0);
  const toAttest: Array<{ tenantId: string; entityId: string; entryId: string }> = [];
  const optionOf = await correctionPeriodOf(findings, CORRECTION_PERIOD_KEY, (scope) => getPolicy(scope, CORRECTION_PERIOD_KEY));

  for (const x of findings) {
    const skip = (why: string) => out.skipped.push({ billId: x.billId, billNumber: x.billNumber, why });
    if (!x.correctable) {
      skip(x.reasons.length > 0 ? x.reasons.map((r) => `${r.code}: ${r.detail}`).join('; ') : `nothing to take out (${x.share})`);
      continue;
    }
    const option = optionOf.get(x.entityId) as CorrectionPeriod;
    if (option === 'ask') {
      skip(
        `${CORRECTION_PERIOD_KEY} is "ask": choose \`mnemosine pending define ${CORRECTION_PERIOD_KEY} current_period\` ` +
          `(one entry per payment, today) or \`mnemosine pending define ${CORRECTION_PERIOD_KEY} payment_month\` ` +
          `(in the month each discount was posted, a closed month reopened with --reopen)`
      );
      continue;
    }
    const postings = await postingsOf(x, option);
    const periods = await periodsFor(x.entityId, postings.map((p) => p.date), option, opts.reopen === true);
    if ('blocked' in periods) {
      skip(periods.blocked);
      continue;
    }

    const reason = `MNE-001-599 · the VAT of an early-payment discount on ${x.billNumber} leaves 1135 against the discount`;
    try {
      const entryIds = await inReopenedPeriods(x.entityId, periods.toReopen, actorUserId, reason, (m) => out.failures.push(m), () =>
        withTransaction(async (client) => {
          const locked = await client.query(`SELECT 1 FROM bills WHERE id = $1 AND entity_id = $2 FOR UPDATE`, [x.billId, x.entityId]);
          if (locked.rowCount !== 1) throw new ChangedMeanwhile();
          const [fresh] = await readFindings(client, x.tenantId, x.entityId, x.billId);
          if (!fresh || !fresh.correctable || !sameRows(fresh, x)) throw new ChangedMeanwhile();

          const { from } = reclassRoles('received');
          const accounts = await client.query<{ role: string; account_id: string }>(
            `SELECT role, account_id FROM account_roles WHERE entity_id = $1 AND qualifier IS NULL AND role IN ($2, $3)`,
            [x.entityId, from, DISCOUNT_ROLE]
          );
          const accountOf = (role: string): string => {
            const found = accounts.rows.find((r) => r.role === role);
            if (!found) {
              throw new AccountingError('MISSING_ROLE_ACCOUNT', {
                key: 'error.MISSING_ROLE_ACCOUNT.no_account',
                params: { entity: x.entityName, role },
              });
            }
            return found.account_id;
          };

          const ids: string[] = [];
          for (const p of postings) {
            const amount = p.amount.toFixed(SCALE);
            const entry = await createJournalEntry(
              x.entityId,
              p.date,
              JournalEntryType.CORRECTION,
              `VAT of the early-payment discount on ${x.billNumber}, paid by ${p.paymentNumber}: posted before ` +
                `migration 341, the whole discount went to ${DISCOUNT_ROLE} and its VAT stayed in ${from}, never ` +
                `creditable · ${p.rows.map((r) => `${r.date} discount ${r.discount} VAT ${r.share}`).join(' · ')} · ` +
                `LIVA arts. 5-III and 7 · the ISR deductions of the month rise by ${amount}; the VAT declared does not change`,
              [
                { account_id: accountOf(DISCOUNT_ROLE), debit_amount: amount, credit_amount: null, description: `The discount's VAT is not a lower cost - Bill ${x.billNumber}` },
                { account_id: accountOf(from), debit_amount: null, credit_amount: amount, description: `IVA on the early-payment discount leaves ${from} without becoming creditable - Bill ${x.billNumber}` },
              ],
              actorUserId,
              { autoPost: true, client, sourceType: DISCOUNT_VAT_CORRECTION_SOURCE, sourceId: p.paymentId, reference: x.billNumber }
            );
            ids.push(entry.id);
          }
          // The fact 341 stores from its day on, filled where it is still NULL:
          // a later unapply gives back exactly what left.
          for (const r of x.rows) {
            const filled = await client.query(
              `UPDATE payment_applications SET discount_iva_amount = $1 WHERE id = $2 AND discount_iva_amount IS NULL AND unapplied_at IS NULL`,
              [r.share, r.applicationId]
            );
            if (filled.rowCount !== 1) throw new ChangedMeanwhile();
          }

          await registrarAuditoria(client, {
            tenantId: x.tenantId,
            legalEntityId: x.entityId,
            userId: actorUserId,
            action: 'post',
            entityType: 'bills',
            entityId: x.billId,
            oldValues: { parked: x.parked, discount_iva_amount: null },
            newValues: {
              discount_vat: x.share,
              period_option: option,
              journal_entry_ids: ids,
              applications: x.rows.map((r) => ({
                application_id: r.applicationId, payment_id: r.paymentId, payment_number: r.paymentNumber,
                date: r.date, discount: r.discount, discount_iva_amount: r.share,
              })),
            },
            reason,
          });
          return ids;
        })
      );
      for (const entryId of entryIds) toAttest.push({ tenantId: x.tenantId, entityId: x.entityId, entryId });
      out.corrected.push({ billId: x.billId, billNumber: x.billNumber, entryIds, amount: x.share });
      total = total.plus(x.share);
    } catch (e) {
      if (e instanceof ChangedMeanwhile) skip('the bill changed since the census, or another run corrected it: run the census again');
      else out.failures.push(`${x.billNumber}: ${(e as Error).message}`);
    }
  }

  // After the commits: attestation re-reads the entry (posting.ts).
  for (const a of toAttest) attestEntryAsync(a.tenantId, a.entityId, a.entryId);
  out.amount = total.toFixed(SCALE);
  return out;
}
