import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { legalParameterAt } from '../jurisdiction/legal-parameters.js';
import { normalizeTaxId } from './vendor-service.js';

// ============================================================
// FORM 1099-NEC FROM WHAT THE ENTITY PAID ITS 1099 VENDORS (MNE-001-332, #124)
//
// One `tax_form_filings` row per vendor and year: the nonemployee
// compensation the entity actually paid (box 1), for every vendor flagged
// `is_1099_vendor` whose total reaches the threshold in force.
//
// What counts as paid, and why (all of it is law, none of it a policy fork):
//   - CASH BASIS: the payment date decides the year, not the bill date
//     (IRC 6041A, Form 1099-NEC instructions).
//   - Only `completed` payments: a draft, failed, void or reversed payment
//     moved no money in the year.
//   - Card payments are left out: the processor reports them on Form 1099-K
//     (IRC 6050W), and the payer must not report them twice.
//   - Only USD payments count toward box 1: the form is in dollars and the
//     conversion source belongs to the FX work (MNE-001-081..083). The money
//     left out is NEVER dropped silently: `excluded` lists, per vendor and
//     currency, the count and sum of the completed non-card payments skipped.
//
// The threshold and the backup withholding rate come from `legal_parameters`
// read on the LAST DAY of the tax year (migration 250), so a 2025 return keeps
// the USD 600 threshold after the law raised it to USD 2 000 for 2026.
//
// The TIN has three states, and they are not the same signal:
//   - `valid`: an EIN that passes `normalizeTaxId` (the one rule of the vendor
//     service, hyphen optional) under `tax_id_type = 'ein'` -> row `ready`.
//   - `missing`: no tax id on file -> `draft` with backup withholding exposure
//     (IRC 3406, 24 %) and the amount that should have been withheld.
//   - `unverifiable`: a tax id is on file but of a kind the model cannot check
//     (`vendors.tax_id_type` has no SSN or ITIN, and an RFC or VAT is not a US
//     TIN) or malformed -> `draft`, flagged for review, and NO backup
//     withholding amount: the payee may well have furnished a TIN, and telling
//     the firm to withhold from them would be a confident wrong signal.
//
// DATA MINIMISATION: the row keeps the last four digits of the TIN and the
// vendor id, not the TIN; the vendor row is the single home of the number.
//
// IDEMPOTENT: regenerating updates `draft`/`ready` rows and never touches one
// already `filed`, `accepted`, `rejected` or `amended`; those are reported as
// `locked`, with the stored total next to the recomputed one so a corrected
// return can be prepared. A `draft`/`ready` row whose vendor no longer
// qualifies (payment reversed or voided, flag removed, total under the
// threshold) is deleted and reported as `withdrawn`: it holds no filed state.
//
// LIMITS of this first slice (follow-ups, not silent gaps):
//   - Box 1 sums every completed non-card USD payment to a flagged vendor; it
//     does not classify by purpose (merchandise, rent and royalties are not NEC).
//   - There is no box 4 (federal income tax withheld): `backup_withholding`
//     is exposure, not a record of what was actually withheld.
//   - There is no payee type: a corporate payee (generally exempt) is not told
//     apart from an individual.
//   - No caller yet: wiring a command or route (risk 'escritura', table
//     `tax_form_filings`) is the next slice.
//
// CONTRACT: the `data` JSON stored in `tax_form_filings` (form_type
// '1099_nec') is what the later IRS e-file generator reads: keys `tax_year`,
// `recipient{vendor_id,name,tin_last4}`, `box_1_nonemployee_compensation`,
// `threshold`, `tin_status`, `tin_missing`, `backup_withholding`.
// ============================================================

export type TinStatus = 'valid' | 'missing' | 'unverifiable';

function tinStatusOf(taxId: string | null, taxIdType: string | null): TinStatus {
  if (taxId === null || taxId.trim() === '') return 'missing';
  if (taxIdType !== 'ein') return 'unverifiable';
  try {
    normalizeTaxId(taxId, 'ein');
    return 'valid';
  } catch {
    return 'unverifiable';
  }
}

export interface Form1099NecRow {
  vendorId: string;
  vendorName: string;
  /** Total paid in the year, 4-decimal string. */
  totalPaid: string;
  hasTin: boolean;
  tinStatus: TinStatus;
  status: 'draft' | 'ready';
  /** Amount to withhold at the backup rate; only when no tax id is on file. */
  backupWithholding: { rate: string; amount: string } | null;
}

export interface Form1099NecLocked {
  vendorId: string;
  status: string;
  storedTotal: string;
  /** Recomputed from the payments today; differs from storedTotal when a correction is due. */
  currentTotal: string;
  changed: boolean;
}

export interface Form1099NecExcluded {
  vendorId: string;
  currency: string;
  count: number;
  total: string;
}

export interface Form1099NecResult {
  taxYear: number;
  threshold: string;
  generated: Form1099NecRow[];
  /** Filings already filed or later: left untouched, with the total to compare. */
  locked: Form1099NecLocked[];
  /** Vendors whose draft/ready filing was removed because they no longer qualify. */
  withdrawn: string[];
  /** Completed non-card payments left out of box 1 for not being USD. */
  excluded: Form1099NecExcluded[];
}

export async function generate1099Nec(
  tenantId: string,
  entityId: string,
  taxYear: number
): Promise<Form1099NecResult> {
  const yearEnd = `${taxYear}-12-31`;
  const threshold = new Decimal((await legalParameterAt('US', 'form_1099_nec.threshold', yearEnd)).value);
  const backupRate = new Decimal((await legalParameterAt('US', 'backup_withholding.rate', yearEnd)).value);

  // Scope: the entity must belong to the tenant, inside the SQL (invariant 4).
  const paid = await query<{
    vendor_id: string;
    company_name: string;
    tax_id: string | null;
    tax_id_type: string | null;
    total: string;
  }>(
    `SELECT v.id AS vendor_id, v.company_name, v.tax_id, v.tax_id_type,
            SUM(p.payment_amount)::text AS total
       FROM vendor_payments p
       JOIN vendors v ON v.id = p.vendor_id AND v.entity_id = p.entity_id
       JOIN legal_entities e ON e.id = p.entity_id
      WHERE e.tenant_id = $1 AND p.entity_id = $2
        AND v.is_1099_vendor = true
        AND p.status = 'completed'
        AND p.currency_code = 'USD'
        AND p.payment_method <> 'credit_card'
        AND p.payment_date >= make_date($3, 1, 1)
        AND p.payment_date < make_date($3 + 1, 1, 1)
      GROUP BY v.id, v.company_name, v.tax_id, v.tax_id_type
      ORDER BY v.company_name, v.id`,
    [tenantId, entityId, taxYear]
  );

  const generated: Form1099NecRow[] = [];
  const totals = new Map<string, Decimal>();
  const qualifying: string[] = [];

  for (const r of paid.rows) {
    const total = new Decimal(r.total);
    totals.set(r.vendor_id, total);
    if (total.lt(threshold)) continue;
    qualifying.push(r.vendor_id);

    const tinStatus = tinStatusOf(r.tax_id, r.tax_id_type);
    const hasTin = tinStatus === 'valid';
    const status = hasTin ? 'ready' : 'draft';
    const backupWithholding =
      tinStatus === 'missing'
        ? { rate: backupRate.toFixed(4), amount: total.mul(backupRate).toDecimalPlaces(2).toFixed(4) }
        : null;
    const data = {
      tax_year: taxYear,
      recipient: { vendor_id: r.vendor_id, name: r.company_name, tin_last4: hasTin ? r.tax_id!.slice(-4) : null },
      box_1_nonemployee_compensation: total.toFixed(4),
      threshold: threshold.toFixed(4),
      tin_status: tinStatus,
      tin_missing: tinStatus === 'missing',
      backup_withholding: backupWithholding,
    };

    // Invariant 3: the state predicate is in the WHERE and rowCount is read.
    const up = await query(
      `INSERT INTO tax_form_filings (tenant_id, entity_id, form_type, tax_year, status, data, vendor_id)
       VALUES ($1, $2, '1099_nec', $3, $4, $5::jsonb, $6)
       ON CONFLICT (entity_id, form_type, tax_year, vendor_id) WHERE vendor_id IS NOT NULL
       DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data
         WHERE tax_form_filings.status IN ('draft', 'ready')`,
      [tenantId, entityId, taxYear, status, JSON.stringify(data), r.vendor_id]
    );
    if (up.rowCount === 0) continue; // locked: reported below with both totals
    generated.push({
      vendorId: r.vendor_id,
      vendorName: r.company_name,
      totalPaid: total.toFixed(4),
      hasTin,
      tinStatus,
      status,
      backupWithholding,
    });
  }

  // Draft/ready rows of vendors that no longer qualify: a 'ready' form for money
  // no longer paid must not be filed. Status, entity and tenant are in the WHERE.
  const withdrawnRows = await query<{ vendor_id: string }>(
    `DELETE FROM tax_form_filings
      WHERE tenant_id = $1 AND entity_id = $2 AND form_type = '1099_nec' AND tax_year = $3
        AND vendor_id IS NOT NULL AND status IN ('draft', 'ready')
        AND NOT (vendor_id = ANY($4::uuid[]))
      RETURNING vendor_id`,
    [tenantId, entityId, taxYear, qualifying]
  );

  // Filed or later: never rewritten; show stored vs recomputed so a correction is visible.
  const lockedRows = await query<{ vendor_id: string; status: string; stored: string | null }>(
    `SELECT vendor_id, status, data->>'box_1_nonemployee_compensation' AS stored
       FROM tax_form_filings
      WHERE tenant_id = $1 AND entity_id = $2 AND form_type = '1099_nec' AND tax_year = $3
        AND vendor_id IS NOT NULL AND status NOT IN ('draft', 'ready')
      ORDER BY vendor_id`,
    [tenantId, entityId, taxYear]
  );
  const locked: Form1099NecLocked[] = lockedRows.rows.map((l) => {
    const stored = new Decimal(l.stored ?? '0');
    const current = totals.get(l.vendor_id) ?? new Decimal(0);
    return {
      vendorId: l.vendor_id,
      status: l.status,
      storedTotal: stored.toFixed(4),
      currentTotal: current.toFixed(4),
      changed: !stored.eq(current),
    };
  });

  // Money left out of box 1 for not being USD: a signal, never a silent drop.
  const skipped = await query<{ vendor_id: string; currency_code: string; n: string; total: string }>(
    `SELECT p.vendor_id, p.currency_code, COUNT(*)::text AS n, SUM(p.payment_amount)::text AS total
       FROM vendor_payments p
       JOIN vendors v ON v.id = p.vendor_id AND v.entity_id = p.entity_id
       JOIN legal_entities e ON e.id = p.entity_id
      WHERE e.tenant_id = $1 AND p.entity_id = $2
        AND v.is_1099_vendor = true
        AND p.status = 'completed'
        AND p.currency_code <> 'USD'
        AND p.payment_method <> 'credit_card'
        AND p.payment_date >= make_date($3, 1, 1)
        AND p.payment_date < make_date($3 + 1, 1, 1)
      GROUP BY p.vendor_id, p.currency_code
      ORDER BY p.vendor_id, p.currency_code`,
    [tenantId, entityId, taxYear]
  );

  return {
    taxYear,
    threshold: threshold.toFixed(4),
    generated,
    locked,
    withdrawn: withdrawnRows.rows.map((w) => w.vendor_id),
    excluded: skipped.rows.map((x) => ({
      vendorId: x.vendor_id,
      currency: x.currency_code,
      count: Number(x.n),
      total: new Decimal(x.total).toFixed(4),
    })),
  };
}
