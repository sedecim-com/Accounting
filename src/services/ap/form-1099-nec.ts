import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { legalParameterAt } from '../jurisdiction/legal-parameters.js';

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
//   - Only `completed` payments: a draft, failed or void payment moved no money.
//   - Card payments are left out: the processor reports them on Form 1099-K
//     (IRC 6050W), and the payer must not report them twice.
//   - Only USD payments: the form is in dollars and `vendor_payments` carries
//     no functional-currency amount to convert with.
//
// The threshold and the backup withholding rate come from `legal_parameters`
// read on the LAST DAY of the tax year (migration 250), so a 2025 return keeps
// the USD 600 threshold after the law raised it to USD 2 000 for 2026.
//
// A vendor without a TIN (an EIN in NN-NNNNNNN form; `vendors.tax_id_type`
// has no SSN) is not dropped: it gets a `draft` row flagged for backup
// withholding (IRC 3406, 24 %) with the amount that should have been withheld,
// so the firm sees the exposure. With a TIN the row is `ready`.
//
// DATA MINIMISATION: the row keeps the last four digits of the TIN and the
// vendor id, not the TIN; the vendor row is the single home of the number.
//
// IDEMPOTENT: regenerating updates `draft`/`ready` rows and never touches one
// already `filed`, `accepted`, `rejected` or `amended`; those are reported as
// `locked` so a filed return is not silently rewritten.
// ============================================================

const EIN_SHAPE = /^\d{2}-\d{7}$/;

export interface Form1099NecRow {
  vendorId: string;
  vendorName: string;
  /** Total paid in the year, 4-decimal string. */
  totalPaid: string;
  hasTin: boolean;
  status: 'draft' | 'ready';
  /** Amount to withhold at the backup rate; null when the vendor has a TIN. */
  backupWithholding: { rate: string; amount: string } | null;
}

export interface Form1099NecResult {
  taxYear: number;
  threshold: string;
  generated: Form1099NecRow[];
  /** Vendors whose existing filing is already filed or later: left untouched. */
  locked: string[];
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
  const locked: string[] = [];

  for (const r of paid.rows) {
    const total = new Decimal(r.total);
    if (total.lt(threshold)) continue;

    const hasTin = r.tax_id_type === 'ein' && r.tax_id !== null && EIN_SHAPE.test(r.tax_id);
    const status = hasTin ? 'ready' : 'draft';
    const backupWithholding = hasTin
      ? null
      : { rate: backupRate.toFixed(4), amount: total.mul(backupRate).toDecimalPlaces(2).toFixed(4) };
    const data = {
      tax_year: taxYear,
      recipient: { vendor_id: r.vendor_id, name: r.company_name, tin_last4: hasTin ? r.tax_id!.slice(-4) : null },
      box_1_nonemployee_compensation: total.toFixed(4),
      threshold: threshold.toFixed(4),
      tin_missing: !hasTin,
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
    if (up.rowCount === 0) {
      locked.push(r.vendor_id);
      continue;
    }
    generated.push({
      vendorId: r.vendor_id,
      vendorName: r.company_name,
      totalPaid: total.toFixed(4),
      hasTin,
      status,
      backupWithholding,
    });
  }

  return { taxYear, threshold: threshold.toFixed(4), generated, locked };
}
