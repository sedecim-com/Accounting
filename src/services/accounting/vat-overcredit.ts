import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { sqlKeepsMexicanBooks } from '../jurisdiction/jurisdiction.js';
import { ivaToReclassify, reclassRoles, VAT_OVERCREDIT_CORRECTION_SOURCE } from './iva-cash-basis.js';
import { createJournalEntry, attestEntryAsync } from './posting.js';
import { reopenClosedPeriod, restorePeriodStatus } from './fiscal-calendar-service.js';
import { JournalEntryType } from '../../types/index.js';
import { AccountingError } from '../../utils/errors.js';
import { getPolicy } from '../policy/policy-service.js';
import { todayFor } from '../policy/today.js';
import { registrarAuditoria } from '../audit/audit-log.js';
import { billHeaderVat } from '../xml-ingestion/pre-registration-service.js';
import { VENDOR_CREDIT_NOTE_SOURCE } from '../xml-ingestion/received-credit-note.js';
import { CREDIT_DATE } from '../sat/diot/hechos.js';
import { writtenOffOf } from '../payments/payment-service.js';

// ============================================================
// THE VAT RELEASED ABOVE A CFDI'S VAT (MNE-001-562 · #725).
//
// Until MNE-001-488 a bill made from a received CFDI kept the XML's total of
// transferred taxes in `bills.tax_amount`: on a CFDI with IEPS, VAT plus IEPS.
// Each payment released its pro rata of that header from 1135 to 1130, so
// 1130 took IEPS as creditable VAT, which it never is (LIVA arts. 4 and
// 5-II). Migration 328 corrected the headers and posted nothing.
//
// This census names what is left: per bill, what its LIVE applications stored
// as released against what they should have released on the CFDI's VAT (002)
// alone, per payment and per month (LIVA art. 5-III). It writes nothing. An
// application undone or reversed gave its whole release back, so it carries no
// excess.
//
// `correctVatOvercredit`, run by a person with `--apply`, posts the excess
// back: DR 1135 / CR 1130, one audited entry per bill (or per bill and month),
// dated as the panel key `vat_overcredit_correction_period` says. No earlier
// entry, application row or header is edited (NIF B-1; ADR-0006 decision 2).
// ============================================================

export { VAT_OVERCREDIT_CORRECTION_SOURCE };

/** Money on this path is 19,4; a figure under half a cent is rounding, not excess. */
const SCALE = 4;
const NOISE = new Decimal('0.005');

export interface SplitRowInput {
  applied: string;
  /** `payment_applications.iva_reclass_amount`; null on a row written before migration 105. */
  stored: string | null;
  /** A cheque that still holds its VAT in 1135: it released nothing yet. */
  held: boolean;
}

export interface SplitRow {
  should: string;
  /** Null when the row stored no release: its excess is not known. */
  excess: string | null;
  /** The release was below the old header's pro rata: the parked cap trimmed it. */
  capped: boolean;
}

export interface Split {
  rows: SplitRow[];
  /** Over the rows whose release is known. */
  released: string;
  should: string;
  excess: string;
}

/**
 * What each live application should have released, as the payment computes it
 * (`ivaToReclassify`, cumulative targets in the order the rows were written)
 * but on the CFDI's VAT. A held cheque owes nothing yet, and its cash still
 * counts as prior, as `billsAppliedBy` counts it for the release that follows.
 */
export function splitOvercredit(input: {
  vat: string;
  total: string;
  /** The old header, VAT plus IEPS: only to mark a capped release. */
  oldVat?: string;
  rows: readonly SplitRowInput[];
}): Split {
  let cum = new Decimal(0);
  let released = new Decimal(0);
  let should = new Decimal(0);
  const rows: SplitRow[] = [];
  for (const r of input.rows) {
    const step = { documentTotal: input.total, priorApplied: cum.toFixed(SCALE), appliedNow: r.applied };
    const owed = r.held ? new Decimal(0) : new Decimal(ivaToReclassify({ ivaTotal: input.vat, ...step }));
    cum = cum.plus(r.applied);
    if (r.stored === null) {
      rows.push({ should: owed.toFixed(SCALE), excess: null, capped: false });
      continue;
    }
    const stored = new Decimal(r.stored);
    const excess = stored.minus(owed);
    const oldProRata = input.oldVat && !r.held ? new Decimal(ivaToReclassify({ ivaTotal: input.oldVat, ...step })) : null;
    released = released.plus(stored);
    should = should.plus(owed);
    rows.push({
      should: owed.toFixed(SCALE),
      excess: excess.toFixed(SCALE),
      capped: oldProRata !== null && excess.greaterThan(NOISE) && stored.lessThan(oldProRata.minus(NOISE)),
    });
  }
  return {
    rows,
    released: released.toFixed(SCALE),
    should: should.toFixed(SCALE),
    excess: released.minus(should).toFixed(SCALE),
  };
}

/** Why a listed bill is not corrected automatically. */
export type NotCorrectedReason =
  | 'release_not_stored'
  | 'closed_short'
  | 'credit_note'
  | 'foreign_currency'
  | 'header_edited'
  | 'header_uncorrected_open'
  | 'over_corrected'
  | 'no_role_account';

export interface OvercreditPayment {
  applicationId: string;
  paymentId: string;
  paymentNumber: string;
  /** The day the DIOT and the IVA workpaper count it (`CREDIT_DATE`); null for a held cheque. */
  creditDate: string | null;
  applied: string;
  stored: string | null;
  should: string;
  excess: string | null;
  capped: boolean;
}

export interface OvercreditFinding {
  tenantId: string;
  entityId: string;
  entityName: string;
  billId: string;
  billNumber: string;
  cfdiUuid: string | null;
  header: string;
  vatTransferred: string;
  released: string;
  should: string;
  excess: string;
  /** What correction entries already put back into 1135 for the bill. */
  corrected: string;
  /** `excess − corrected`: what a correction would move now. */
  open: string;
  payments: OvercreditPayment[];
  /** The excess by the month of each payment: the figure of each complementary return. */
  byMonth: Array<{ month: string; excess: string }>;
  reasons: Array<{ code: NotCorrectedReason; detail: string }>;
  correctable: boolean;
}

interface BillRow {
  tenant_id: string;
  bill_id: string;
  entity_id: string;
  entity_name: string;
  bill_number: string;
  cfdi_uuid: string | null;
  header: string;
  total: string;
  amount_due: string;
  currency_code: string;
  functional_currency: string | null;
  xml_taxes: string;
  tax_breakdown: unknown;
  has_note: boolean;
  corrected: string;
  correction_entries: string | null;
  roles: number;
}

interface ApplicationRow {
  application_id: string;
  bill_id: string;
  payment_id: string;
  payment_number: string;
  credit_date: string | null;
  applied: string;
  stored: string | null;
}

// The bill's oldest xml_cfdi pre-registration of its own entity, as migration
// 328 and the REP linkage read it, and only when its summary lists a transfer
// that is not VAT: a CFDI with VAT alone and a bill with no CFDI never enter.
const BILLS = `
SELECT le.tenant_id, b.id AS bill_id, b.entity_id, le.name AS entity_name, b.bill_number, b.cfdi_uuid,
       b.tax_amount::text AS header, b.total_amount::text AS total, b.amount_due::text AS amount_due,
       b.currency_code, le.functional_currency, c.xml_taxes::text AS xml_taxes, c.tax_breakdown,
       EXISTS (SELECT 1 FROM journal_entries n
                WHERE n.entity_id = b.entity_id AND n.source_type = $3 AND n.source_id = b.id
                  AND n.status = 'posted' AND n.reversed_by_entry_id IS NULL) AS has_note,
       COALESCE((SELECT SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0))
                   FROM journal_entries k
                   JOIN journal_entry_lines l ON l.journal_entry_id = k.id
                   JOIN account_roles ar ON ar.account_id = l.account_id AND ar.entity_id = b.entity_id
                                        AND ar.role = $5 AND ar.qualifier IS NULL
                  WHERE k.entity_id = b.entity_id AND k.source_type = $4 AND k.source_id = b.id
                    AND k.status = 'posted' AND k.reversed_by_entry_id IS NULL), 0)::text AS corrected,
       (SELECT string_agg(k.entry_number, ', ' ORDER BY k.entry_date, k.entry_number) FROM journal_entries k
         WHERE k.entity_id = b.entity_id AND k.source_type = $4 AND k.source_id = b.id
           AND k.status = 'posted' AND k.reversed_by_entry_id IS NULL) AS correction_entries,
       (SELECT count(DISTINCT ar.role)::int FROM account_roles ar
         WHERE ar.entity_id = b.entity_id AND ar.qualifier IS NULL AND ar.role IN ($5, $6)) AS roles
  FROM (SELECT DISTINCT ON (p.bill_id) p.bill_id, p.entity_id, p.tax_amount AS xml_taxes, p.tax_breakdown
          FROM pre_registrations p
         WHERE p.source_type = 'xml_cfdi' AND p.bill_id IS NOT NULL
         ORDER BY p.bill_id, p.created_at, p.id) c
  JOIN bills b ON b.id = c.bill_id AND b.entity_id = c.entity_id
  JOIN legal_entities le ON le.id = b.entity_id
 WHERE le.tenant_id = $1
   AND ($2::uuid IS NULL OR le.id = $2::uuid)
   AND ($7::uuid IS NULL OR b.id = $7::uuid)
   AND ${sqlKeepsMexicanBooks('le')}
   AND b.status NOT IN ('void', 'cancelled')
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.tax_breakdown->'traslados') = 'array'
                                                       THEN c.tax_breakdown->'traslados' ELSE '[]'::jsonb END) x
                WHERE lpad(COALESCE(x->>'impuesto', ''), 3, '0') <> '002')
 ORDER BY le.name, b.bill_number, b.id`;

// The live applications, bounded by the entity on both ends of the bridge
// table (hechos.ts explains why both), in the order they were written.
const APPLICATIONS = `
SELECT pa.id AS application_id, pa.bill_id, vp.id AS payment_id, vp.payment_number,
       to_char(${CREDIT_DATE}, 'YYYY-MM-DD') AS credit_date,
       pa.amount_applied::text AS applied, pa.iva_reclass_amount::text AS stored
  FROM payment_applications pa
  JOIN bills b ON b.id = pa.bill_id
  JOIN vendor_payments vp ON vp.id = pa.payment_id AND vp.entity_id = b.entity_id
  JOIN legal_entities le ON le.id = b.entity_id
 WHERE le.tenant_id = $1
   AND pa.bill_id = ANY($2::uuid[])
   AND pa.unapplied_at IS NULL
   AND vp.journal_entry_id IS NOT NULL
   AND vp.status <> 'void'
 ORDER BY pa.created_at, pa.id`;

const same = (x: unknown, y: unknown): boolean => new Decimal(String(x)).equals(new Decimal(String(y)));

async function findingOf(client: pg.PoolClient, bill: BillRow, rows: ApplicationRow[]): Promise<OvercreditFinding | null> {
  const vat = new Decimal(String(billHeaderVat({ tax_amount: bill.xml_taxes, tax_breakdown: bill.tax_breakdown }))).toFixed(SCALE);
  const split = splitOvercredit({
    vat, total: bill.total, oldVat: bill.xml_taxes,
    rows: rows.map((r) => ({ applied: r.applied, stored: r.stored, held: r.credit_date === null })),
  });
  const open = new Decimal(split.excess).minus(bill.corrected);

  const reasons: OvercreditFinding['reasons'] = [];
  const say = (code: NotCorrectedReason, detail: string) => reasons.push({ code, detail });
  const unstored = rows.filter((r) => r.stored === null).length;
  if (unstored > 0) {
    say('release_not_stored', `${unstored} live application(s) written before migration 105 stored no release: its excess would be a guess`);
  }
  const writtenOff = await writtenOffOf(client, { id: bill.bill_id, total_amount: bill.total, amount_due: bill.amount_due });
  if (writtenOff.abs().greaterThanOrEqualTo('0.01')) {
    say('closed_short', `closed short (${writtenOff.toFixed(2)} written off): the VAT of the write-off is stored nowhere`);
  }
  if (bill.has_note) {
    say('credit_note', 'a received credit note took its VAT from what the excess left parked, so part of the excess may already have left 1130');
  }
  if (bill.functional_currency && bill.currency_code !== bill.functional_currency) {
    say('foreign_currency', `in ${bill.currency_code}: 1130 took the payment day's rate and 1135 the bill's, so the excess is not one figure`);
  }
  if (!same(bill.header, vat)) {
    if (!same(bill.header, bill.xml_taxes)) {
      say('header_edited', `the header was edited to ${new Decimal(bill.header).toFixed(SCALE)}; the CFDI's VAT is ${vat}`);
    } else if (new Decimal(bill.amount_due).greaterThan(0)) {
      say('header_uncorrected_open', `the header still holds VAT plus IEPS (${new Decimal(bill.header).toFixed(SCALE)}, the CFDI's VAT is ${vat}): its next payment would release too much again`);
    }
  }
  if (open.lessThan(NOISE.negated())) {
    say('over_corrected', `the corrections ${bill.correction_entries ?? ''} put back ${new Decimal(bill.corrected).toFixed(SCALE)} and the live excess is ${split.excess}: reverse them (entry reverse) and run again`);
  }
  if (bill.roles < 2) {
    say('no_role_account', 'the entity has no account for the pending or the creditable VAT role');
  }

  if (open.abs().lessThanOrEqualTo(NOISE) && unstored === 0) return null;

  const byMonth = new Map<string, Decimal>();
  const payments = rows.map((r, i) => {
    const s = split.rows[i];
    if (r.credit_date && s.excess !== null) {
      const month = r.credit_date.slice(0, 7);
      byMonth.set(month, (byMonth.get(month) ?? new Decimal(0)).plus(s.excess));
    }
    return {
      applicationId: r.application_id, paymentId: r.payment_id, paymentNumber: r.payment_number,
      creditDate: r.credit_date, applied: new Decimal(r.applied).toFixed(SCALE),
      stored: r.stored === null ? null : new Decimal(r.stored).toFixed(SCALE),
      should: s.should, excess: s.excess, capped: s.capped,
    };
  });

  return {
    tenantId: bill.tenant_id, entityId: bill.entity_id, entityName: bill.entity_name, billId: bill.bill_id, billNumber: bill.bill_number,
    cfdiUuid: bill.cfdi_uuid, header: new Decimal(bill.header).toFixed(SCALE), vatTransferred: vat,
    released: split.released, should: split.should, excess: split.excess,
    corrected: new Decimal(bill.corrected).toFixed(SCALE), open: open.toFixed(SCALE),
    payments,
    byMonth: [...byMonth].sort(([m1], [m2]) => m1.localeCompare(m2)).map(([month, e]) => ({ month, excess: e.toFixed(SCALE) })),
    reasons,
    correctable: reasons.length === 0 && open.greaterThan(NOISE),
  };
}

async function readFindings(
  client: pg.PoolClient, tenantId: string, entityId: string | null, billId: string | null
): Promise<OvercreditFinding[]> {
  const { from, to } = reclassRoles('received');
  const bills = await client.query<BillRow>(BILLS, [
    tenantId, entityId, VENDOR_CREDIT_NOTE_SOURCE, VAT_OVERCREDIT_CORRECTION_SOURCE, from, to, billId,
  ]);
  if (bills.rows.length === 0) return [];
  const apps = await client.query<ApplicationRow>(APPLICATIONS, [tenantId, bills.rows.map((b) => b.bill_id)]);
  const byBill = new Map<string, ApplicationRow[]>();
  for (const r of apps.rows) byBill.set(r.bill_id, [...(byBill.get(r.bill_id) ?? []), r]);

  const out: OvercreditFinding[] = [];
  for (const bill of bills.rows) {
    const finding = await findingOf(client, bill, byBill.get(bill.bill_id) ?? []);
    if (finding) out.push(finding);
  }
  return out;
}

/**
 * Every bill of the tenant (or of one entity) whose live payments released
 * more VAT than its CFDI transfers. Writes nothing.
 */
export async function censusVatOvercredit(tenantId: string, entityId?: string | null): Promise<OvercreditFinding[]> {
  return withTransaction((client) => readFindings(client, tenantId, entityId ?? null, null));
}

// ============================================================
// THE CORRECTION (part 2 of 2)
// ============================================================

const CORRECTION_PERIOD_KEY = 'vat_overcredit_correction_period';
const CORRECTION_PERIODS = ['ask', 'current_period', 'payment_month'] as const;
type CorrectionPeriod = (typeof CORRECTION_PERIODS)[number];

export interface CorrectionOptions {
  /** Under `payment_month`, reopen a closed month and put it back. A locked one never. */
  reopen?: boolean;
}

export interface CorrectionResult {
  corrected: Array<{ billId: string; billNumber: string; entryIds: string[]; amount: string }>;
  skipped: Array<{ billId: string; billNumber: string; why: string }>;
  failures: string[];
  amount: string;
}

interface Posting {
  date: string;
  amount: Decimal;
  payments: OvercreditPayment[];
}

/** Another run, or another event, changed the bill between the census and the write. */
class ChangedMeanwhile extends Error {}

/** One entry dated today, or one per month the excess was credited in. */
async function postingsOf(x: OvercreditFinding, option: CorrectionPeriod): Promise<Posting[] | { why: string }> {
  const owed = x.payments.filter((p) => p.excess !== null && new Decimal(p.excess).greaterThan(0));
  if (option === 'current_period') {
    return [{ date: await todayFor({ tenantId: x.tenantId, entityId: x.entityId }), amount: new Decimal(x.open), payments: owed }];
  }
  if (new Decimal(x.corrected).greaterThan(NOISE)) {
    return {
      why: `already corrected by ${x.corrected}: post the rest under current_period, or reverse its corrections and run again`,
    };
  }
  const byMonth = new Map<string, Posting>();
  for (const p of owed) {
    const month = (p.creditDate as string).slice(0, 7);
    const m = byMonth.get(month) ?? { date: p.creditDate as string, amount: new Decimal(0), payments: [] };
    m.amount = m.amount.plus(p.excess as string);
    if ((p.creditDate as string) > m.date) m.date = p.creditDate as string;
    m.payments.push(p);
    byMonth.set(month, m);
  }
  const postings = [...byMonth.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (postings.length === 0) return { why: 'no payment month carries an excess' };
  // Rows that owe less than nothing by a rounding are left out above; their
  // sub-cent goes to the last month, so the entries add up to `open`.
  const rest = new Decimal(x.open).minus(postings.reduce((s, p) => s.plus(p.amount), new Decimal(0)));
  postings[postings.length - 1].amount = postings[postings.length - 1].amount.plus(rest);
  return postings;
}

/**
 * Posts the open excess of each correctable finding back from 1130 to 1135.
 * The panel key is read for every entity before anything is written. Each bill
 * is its own transaction: it is locked, read again, and skipped when the
 * figure moved, so a second run, or two at once, posts nothing twice.
 */
export async function correctVatOvercredit(
  findings: readonly OvercreditFinding[],
  actorUserId: string,
  opts: CorrectionOptions = {}
): Promise<CorrectionResult> {
  const out: CorrectionResult = { corrected: [], skipped: [], failures: [], amount: '0.0000' };
  let total = new Decimal(0);
  const toAttest: Array<{ tenantId: string; entityId: string; entryId: string }> = [];

  const optionOf = new Map<string, CorrectionPeriod>();
  for (const x of findings) {
    if (optionOf.has(x.entityId)) continue;
    const value = (await getPolicy({ tenantId: x.tenantId, entityId: x.entityId }, 'vat_overcredit_correction_period')).value;
    if (!(CORRECTION_PERIODS as readonly string[]).includes(value)) {
      throw new AccountingError(
        'POLICY_VALUE_UNKNOWN',
        `${CORRECTION_PERIOD_KEY} = "${value}" is not a value this system knows (${CORRECTION_PERIODS.join(' | ')}); nothing was posted.`
      );
    }
    optionOf.set(x.entityId, value as CorrectionPeriod);
  }

  for (const x of findings) {
    const skip = (why: string) => out.skipped.push({ billId: x.billId, billNumber: x.billNumber, why });
    if (!x.correctable) {
      skip(x.reasons.length > 0 ? x.reasons.map((r) => `${r.code}: ${r.detail}`).join('; ') : `nothing open (${x.open})`);
      continue;
    }
    const option = optionOf.get(x.entityId) as CorrectionPeriod;
    if (option === 'ask') {
      skip(
        `${CORRECTION_PERIOD_KEY} is "ask": choose \`mnemosine pending define ${CORRECTION_PERIOD_KEY} current_period\` ` +
          `(one entry today) or \`mnemosine pending define ${CORRECTION_PERIOD_KEY} payment_month\` ` +
          `(one per month paid, a closed month reopened with --reopen)`
      );
      continue;
    }
    const postings = await postingsOf(x, option);
    if (!Array.isArray(postings)) {
      skip(postings.why);
      continue;
    }

    // Every period first: a bill is corrected whole or not at all.
    const toReopen: Array<{ id: string; name: string }> = [];
    let blocked: string | null = null;
    for (const p of postings) {
      const { rows: [period] } = await withTransaction((client) =>
        client.query<{ id: string; period_name: string; status: string }>(
          `SELECT id, period_name, status FROM fiscal_periods
            WHERE entity_id = $1 AND $2::date BETWEEN start_date AND end_date`,
          [x.entityId, p.date]
        )
      );
      if (!period) blocked = `no fiscal period holds ${p.date}`;
      else if (period.status === 'locked') blocked = `${period.period_name} is locked: it is never reopened`;
      else if (period.status === 'open') continue;
      else if (option === 'payment_month' && (period.status === 'soft_close' || period.status === 'hard_close')) {
        if (opts.reopen) toReopen.push({ id: period.id, name: period.period_name });
        else blocked = `${period.period_name} is ${period.status}: run with --reopen to post in it`;
      } else blocked = `${period.period_name} is ${period.status}, not open`;
      if (blocked) break;
    }
    if (blocked) {
      skip(blocked);
      continue;
    }

    const reason = `MNE-001-562 · VAT released above the CFDI's VAT on ${x.billNumber} is put back in 1135`;
    const restore: Array<{ id: string; name: string; previous: string }> = [];
    try {
      for (const period of toReopen) {
        const r = await reopenClosedPeriod(x.entityId, period.id, actorUserId, reason);
        restore.push({ ...period, previous: r.previousStatus });
      }
      const entryIds = await withTransaction(async (client) => {
        const locked = await client.query(`SELECT 1 FROM bills WHERE id = $1 AND entity_id = $2 FOR UPDATE`, [x.billId, x.entityId]);
        if (locked.rowCount !== 1) throw new ChangedMeanwhile();
        const [fresh] = await readFindings(client, x.tenantId, x.entityId, x.billId);
        if (!fresh || !fresh.correctable || new Decimal(fresh.open).minus(x.open).abs().greaterThan(NOISE)) {
          throw new ChangedMeanwhile();
        }

        const { from, to } = reclassRoles('received');
        const accounts = await client.query<{ role: string; account_id: string }>(
          `SELECT role, account_id FROM account_roles WHERE entity_id = $1 AND qualifier IS NULL AND role IN ($2, $3)`,
          [x.entityId, from, to]
        );
        const accountOf = (role: string): string => {
          const found = accounts.rows.find((r) => r.role === role);
          if (!found) throw new AccountingError('MISSING_ROLE_ACCOUNT', `${x.entityName} has no account for the ${role} role.`);
          return found.account_id;
        };

        const ids: string[] = [];
        for (const p of postings) {
          const amount = p.amount.toFixed(SCALE);
          const paid = p.payments.map((q) => `${q.paymentNumber} ${q.creditDate ?? ''} ${q.excess ?? ''}`.trim()).join(' · ');
          const entry = await createJournalEntry(
            x.entityId,
            p.date,
            JournalEntryType.CORRECTION,
            `VAT released above the CFDI's VAT on ${x.billNumber}${x.cfdiUuid ? ` (CFDI ${x.cfdiUuid})` : ''}: ` +
              `the CFDI transfers ${x.vatTransferred} and its payments released ${x.released}, IEPS read as VAT ` +
              `before MNE-001-488 · ${paid} · LIVA arts. 4, 5-II, 5-III`,
            [
              { account_id: accountOf(from), debit_amount: amount, credit_amount: null, description: `VAT back in ${from} - Bill ${x.billNumber}` },
              { account_id: accountOf(to), debit_amount: null, credit_amount: amount, description: `VAT out of ${to}: IEPS is not VAT - Bill ${x.billNumber}` },
            ],
            actorUserId,
            { autoPost: true, client, sourceType: VAT_OVERCREDIT_CORRECTION_SOURCE, sourceId: x.billId, reference: x.billNumber }
          );
          ids.push(entry.id);
        }

        await registrarAuditoria(client, {
          tenantId: x.tenantId,
          legalEntityId: x.entityId,
          userId: actorUserId,
          action: 'post',
          entityType: 'bills',
          entityId: x.billId,
          oldValues: { vat_released: x.released, vat_should: x.should, corrected: x.corrected },
          newValues: {
            vat_transferred: x.vatTransferred,
            vat_released: x.released,
            excess: x.open,
            period_option: option,
            journal_entry_ids: ids,
            payments: x.payments.map((q) => ({
              payment_id: q.paymentId, payment_number: q.paymentNumber, credit_date: q.creditDate,
              stored: q.stored, should: q.should, excess: q.excess,
            })),
          },
          reason,
        });
        return ids;
      });
      for (const entryId of entryIds) toAttest.push({ tenantId: x.tenantId, entityId: x.entityId, entryId });
      out.corrected.push({ billId: x.billId, billNumber: x.billNumber, entryIds, amount: x.open });
      total = total.plus(x.open);
    } catch (e) {
      if (e instanceof ChangedMeanwhile) skip('the bill changed since the census, or another run corrected it: run the census again');
      else out.failures.push(`${x.billNumber}: ${(e as Error).message}`);
    } finally {
      for (const period of restore) {
        await restorePeriodStatus(
          x.entityId, period.id, period.previous, actorUserId, `${reason}; the period goes back to ${period.previous}.`
        ).catch((e) => out.failures.push(`could not put ${period.name} back to ${period.previous}: ${(e as Error).message}`));
      }
    }
  }

  // After the commits: attestation re-reads the entry (posting.ts).
  for (const a of toAttest) attestEntryAsync(a.tenantId, a.entityId, a.entryId);
  out.amount = total.toFixed(SCALE);
  return out;
}
