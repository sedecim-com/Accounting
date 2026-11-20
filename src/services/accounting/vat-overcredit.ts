import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { sqlKeepsMexicanBooks } from '../jurisdiction/jurisdiction.js';
import { ivaToReclassify, reclassRoles } from './iva-cash-basis.js';
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
// excess. Part 2 of the plan adds the audited correction.
// ============================================================

/** The source type of the correction entry (part 2); its `source_id` is the bill. */
export const VAT_OVERCREDIT_CORRECTION_SOURCE = 'vat_overcredit_correction';

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
SELECT b.id AS bill_id, b.entity_id, le.name AS entity_name, b.bill_number, b.cfdi_uuid,
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
    say('over_corrected', `the corrections put back ${new Decimal(bill.corrected).toFixed(SCALE)} and the live excess is ${split.excess}: reverse them (entry reverse) and run again`);
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
    entityId: bill.entity_id, entityName: bill.entity_name, billId: bill.bill_id, billNumber: bill.bill_number,
    cfdiUuid: bill.cfdi_uuid, header: new Decimal(bill.header).toFixed(SCALE), vatTransferred: vat,
    released: split.released, should: split.should, excess: split.excess,
    corrected: new Decimal(bill.corrected).toFixed(SCALE), open: open.toFixed(SCALE),
    payments,
    byMonth: [...byMonth].sort(([m1], [m2]) => m1.localeCompare(m2)).map(([month, e]) => ({ month, excess: e.toFixed(SCALE) })),
    reasons,
    correctable: reasons.length === 0 && open.greaterThan(NOISE),
  };
}

/**
 * Every bill of the tenant (or of one entity) whose live payments released
 * more VAT than its CFDI transfers. Writes nothing.
 */
export async function censusVatOvercredit(tenantId: string, entityId?: string | null): Promise<OvercreditFinding[]> {
  const { from, to } = reclassRoles('received');
  return withTransaction(async (client) => {
    const bills = await client.query<BillRow>(BILLS, [
      tenantId, entityId ?? null, VENDOR_CREDIT_NOTE_SOURCE, VAT_OVERCREDIT_CORRECTION_SOURCE, from, to,
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
  });
}
