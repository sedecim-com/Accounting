import { query } from '../../database/connection.js';
import type { TranslationKey } from '../../i18n/index.js';
import { AccountingError } from '../../utils/errors.js';
import { PAYABLE_OPEN_STATUSES } from '../reporting/report-service.js';

// ============================================================
// THE NAMED PAYABLES CHECKS (`ap check`, MNE-001-432, #643)
//
// The payables counterpart of `runArChecks` (src/services/ar/ar-controls.ts):
// named probes, each with its level, its count and what it found. It reads
// and never writes.
//
// Its first probe, `cancelled-cfdi-open`, names each open bill with an amount
// due whose received CFDI the SAT reports cancelled: the mark MNE-001-431
// writes through `markBillCfdiCancelled` (bill-cfdi-cancellation.ts).
//
// It WARNS where its AR peer blocks. On the AR side the entity is the issuer,
// and collecting on a voucher it cancelled itself contradicts its own books.
// Here the cancellation is the vendor's act, and the usual one (motivo 01 of
// Anexo 20) is a voucher replaced by a new CFDI: the debt is still owed, and
// what to do is hold the payment until the replacement arrives. The firm that
// wants it to fail a script runs `ap check --strict`. The level changes no
// figure, entry or close, so it is not a panel choice (invariant 6).
//
// A paid bill is not named: it owes nothing, and what its cancelled CFDI
// means for the deduction and the VAT already declared is a fiscal question,
// out of scope here (#643).
// ============================================================

export type ApCheckLevel = 'clean' | 'warning' | 'blocking';

/** One bill a probe names: what the accountant needs to find it and act. */
export interface ApCheckBill {
  bill_number: string;
  vendor: string;
  cfdi_uuid: string;
  /** The amount due in the bill's own currency, two decimals: what is owed to the vendor. */
  amount_due: string;
  currency: string;
  /** YYYY-MM-DD: the day this system learned of the cancellation. */
  noted_on: string;
}

export interface ApCheckResult {
  name: string;
  level: ApCheckLevel;
  count: number;
  /** The edge renders it in the reader's language. */
  detailKey: TranslationKey;
  /** Every bill found, not a sample: the acceptance asks for each one. */
  bills: ApCheckBill[];
}

export interface ApChecksResult {
  results: ApCheckResult[];
  blocking: number;
  warnings: number;
}

interface Probe {
  name: string;
  /** The level when it finds something; 'clean' when it does not. */
  severity: 'blocking' | 'warning';
  run: (entityId: string) => Promise<{ bills: ApCheckBill[]; detailKey: TranslationKey }>;
}

const PROBES: Probe[] = [
  {
    name: 'cancelled-cfdi-open',
    severity: 'warning',
    run: async (entityId) => {
      // The open set is the aging's and `ap reconcile`'s, imported and not copied.
      const r = await query<ApCheckBill>(
        `SELECT b.bill_number, v.company_name AS vendor, b.cfdi_uuid,
                b.amount_due::numeric(19,2)::text AS amount_due,
                COALESCE(b.currency_code, le.functional_currency) AS currency,
                b.cfdi_cancellation_noted_at::date::text AS noted_on
           FROM bills b
           JOIN vendors v ON v.id = b.vendor_id AND v.entity_id = b.entity_id
           JOIN legal_entities le ON le.id = b.entity_id
          WHERE b.entity_id = $1
            AND b.status = ANY($2::text[])
            AND b.amount_due > 0
            AND b.cfdi_cancellation_noted_at IS NOT NULL
          ORDER BY b.bill_number, b.id`,
        [entityId, [...PAYABLE_OPEN_STATUSES]]
      );
      return {
        bills: r.rows,
        detailKey: r.rows.length ? 'ap.check.cancelled_cfdi_open.found' : 'ap.check.cancelled_cfdi_open.none',
      };
    },
  },
];

export const AP_CHECK_NAMES = PROBES.map((p) => p.name);

export async function runApChecks(entityId: string, opts: { checks?: string[] } = {}): Promise<ApChecksResult> {
  const asked = opts.checks?.length ? opts.checks : AP_CHECK_NAMES;
  const unknown = asked.filter((name) => !AP_CHECK_NAMES.includes(name));
  if (unknown.length > 0) {
    throw new AccountingError(
      'UNKNOWN_CHECK',
      `Unknown check(s): ${unknown.join(', ')}. The ones that exist: ${AP_CHECK_NAMES.join(', ')}.`
    );
  }

  const results: ApCheckResult[] = [];
  for (const probe of PROBES) {
    if (!asked.includes(probe.name)) continue;
    const { bills, detailKey } = await probe.run(entityId);
    results.push({
      name: probe.name,
      level: bills.length > 0 ? probe.severity : 'clean',
      count: bills.length,
      detailKey,
      bills,
    });
  }
  return {
    results,
    blocking: results.filter((r) => r.level === 'blocking').length,
    warnings: results.filter((r) => r.level === 'warning').length,
  };
}
