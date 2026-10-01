import type pg from 'pg';
import Decimal from 'decimal.js';
import { legalParameterAt, LegalParameterUnavailableError } from '../jurisdiction/legal-parameters.js';
import { jurisdictionOf } from '../jurisdiction/jurisdiction.js';
import { getPolicy } from '../policy/policy-service.js';
import { tenantDe } from '../audit/audit-log.js';
import { createDraft, DraftValidationError, type DraftLine } from '../../ai/draft-service.js';
import { t } from '../../i18n/index.js';

/** LISR art. 27 fr. III, read by the date of the payment and never hard-coded. */
export const CASH_LIMIT_KEY = 'income_tax.cash_payment_deduction_limit';

/**
 * The panel key that decides what happens with cash above the limit OUTSIDE the
 * CFDI ingestion (the ingestion asks the same fork as `efectivo_no_deducible`).
 * Options: `signal` (default), `draft_reclassification`, `ignore`.
 */
export const CASH_POLICY_KEY = 'cash_over_limit_outside_ingestion';

/** c_FormaPago 01 = cash. */
const CFDI_CASH = '01';

/** Where the finding was raised: the CFDI's FormaPago at approval, or a real payment. */
export type CashFindingSource = 'bill_approve' | 'vendor_payment';

/**
 * A signal, not a ledger change. What to do with cash above the limit is a fork
 * the firm decides (panel key `cash_over_limit_outside_ingestion`): signal only,
 * propose the reclassification to `gasto_no_deducible` as a draft that a person
 * approves, or stay silent. The entry that was posted is never changed here.
 */
export interface CashDeductibilityFinding {
  code: 'cash_over_limit_deductibility_at_risk' | 'cash_limit_unavailable';
  billNumber: string;
  /** What was paid in cash, in pesos. */
  amount: string;
  /** Null when no vigencia covers the date (`cash_limit_unavailable`). */
  limit: string | null;
  /** The date the limit was read at, YYYY-MM-DD. */
  onDate: string;
  sourceUrl: string | null;
  source: CashFindingSource;
  /** The reclassification drafts proposed under `draft_reclassification`, for a person to review. */
  draftIds: string[];
  message: string;
}

export interface CashLimitArgs {
  entityId: string;
  billNumber: string;
  amount: string;
  currency: string;
  onDate: string;
  source: CashFindingSource;
  /** The bills the cash settles; the reclassification drafts are proposed for these. */
  billIds?: string[];
  /** False in a dry run: nothing may be written, so no draft is proposed. */
  proposeDrafts?: boolean;
}

/**
 * The findings when `amount` paid in cash on `onDate` exceeds the limit in force
 * that day, or `[]`. Only Mexican-law entities and pesos are judged: a foreign
 * currency amount needs the firm's FX source and is left out (open point).
 *
 * The parameter is read ONLY when a cash payment is actually in play, so an
 * unseeded table cannot stop an operation that has nothing to do with cash. Once
 * in play, a date with no vigencia is NOT silent and does not block either: it
 * comes back as a `cash_limit_unavailable` finding (the signal is informative,
 * and the posting it rides on has already been decided).
 */
export async function cashLimitFinding(
  client: pg.PoolClient,
  args: CashLimitArgs
): Promise<CashDeductibilityFinding[]> {
  if (args.currency !== 'MXN') return [];
  const e = await client.query<{ incorporation_country: string | null; accounting_standard: string | null }>(
    'SELECT incorporation_country, accounting_standard FROM legal_entities WHERE id = $1',
    [args.entityId]
  );
  if (e.rows.length === 0 || jurisdictionOf(e.rows[0]).fiscal !== 'MX') return [];

  const tenantId = await tenantDe(client, args.entityId);
  const policy = await getPolicy({ tenantId, entityId: args.entityId }, CASH_POLICY_KEY, client);
  if (policy.value === 'ignore') return [];

  const amount = new Decimal(args.amount);
  const base = {
    billNumber: args.billNumber,
    amount: amount.toFixed(2),
    onDate: args.onDate,
    source: args.source,
    draftIds: [] as string[],
  };

  let limit;
  try {
    limit = await legalParameterAt('MX', CASH_LIMIT_KEY, args.onDate, client);
  } catch (err) {
    if (!(err instanceof LegalParameterUnavailableError)) throw err;
    return [{
      ...base,
      code: 'cash_limit_unavailable',
      limit: null,
      sourceUrl: null,
      message: t('cash_limit.finding.unavailable', { bill: args.billNumber, date: args.onDate }),
    }];
  }
  if (!amount.greaterThan(limit.value)) return [];
  const limitText = new Decimal(limit.value).toFixed(2);

  const draftIds: string[] = [];
  let draftNote = '';
  if (policy.value === 'draft_reclassification' && args.proposeDrafts !== false) {
    try {
      for (const billId of args.billIds ?? []) {
        const id = await proposeNonDeductibleDraft(client, tenantId, args.entityId, billId, args.onDate);
        if (id) draftIds.push(id);
      }
      if (draftIds.length > 0) {
        draftNote = ' ' + t('cash_limit.finding.draft_proposed', { count: String(draftIds.length) });
      }
    } catch (err) {
      if (!(err instanceof DraftValidationError)) throw err;
      draftNote = ' ' + t('cash_limit.finding.draft_failed', { reason: err.errors.join('; ') });
    }
  }

  return [{
    ...base,
    code: 'cash_over_limit_deductibility_at_risk',
    limit: limitText,
    sourceUrl: limit.sourceUrl,
    draftIds,
    message:
      t(args.source === 'bill_approve' ? 'cash_limit.finding.at_approve' : 'cash_limit.finding.at_payment', {
        bill: args.billNumber,
        amount: amount.toFixed(2),
        date: args.onDate,
        limit: limitText,
      }) + draftNote,
  }];
}

/**
 * The reclassification of a bill's posted expense to `gasto_no_deducible`, as a
 * draft in the same review queue as everything else (never a posting). Every
 * debit of the bill's entry (the expense and the IVA it credited) moves to the
 * non-deductible account: no deduction and no IVA credit, LISR 27-III and LIVA
 * 5-I. One open draft per bill: a second signal returns null.
 */
async function proposeNonDeductibleDraft(
  client: pg.PoolClient,
  tenantId: string,
  entityId: string,
  billId: string,
  onDate: string
): Promise<string | null> {
  const reference = `cash27:${billId}`;
  const open = await client.query(
    `SELECT 1 FROM ai_drafts WHERE entity_id = $1 AND payload->>'reference' = $2
        AND status IN ('pending_review', 'approved')`,
    [entityId, reference]
  );
  if ((open.rowCount ?? 0) > 0) return null;

  const target = await client.query<{ code: string }>(
    `SELECT a.code FROM account_roles r JOIN accounts a ON a.id = r.account_id
      WHERE r.entity_id = $1 AND r.role = 'gasto_no_deducible' AND r.qualifier IS NULL`,
    [entityId]
  );
  const targetCode = target.rows[0]?.code;
  if (!targetCode) throw new DraftValidationError(['no account is mapped to the role gasto_no_deducible']);

  const debits = await client.query<{ code: string; amount: string }>(
    `SELECT a.code, SUM(l.debit_amount)::text AS amount
       FROM bills b
       JOIN journal_entry_lines l ON l.journal_entry_id = b.journal_entry_id
       JOIN accounts a ON a.id = l.account_id
      WHERE b.id = $1 AND b.entity_id = $2 AND l.debit_amount > 0 AND a.code <> $3
      GROUP BY a.code ORDER BY a.code`,
    [billId, entityId, targetCode]
  );
  if (debits.rows.length === 0) return null;

  const lines: DraftLine[] = [];
  let total = new Decimal(0);
  for (const d of debits.rows) {
    lines.push({
      account_code: d.code,
      credit: Number(d.amount),
      description: 'Reclassify: cash above the LISR 27-III limit',
    });
    total = total.plus(d.amount);
  }
  lines.push({
    account_code: targetCode,
    debit: total.toNumber(),
    description: 'Non-deductible: cash above the LISR 27-III limit',
  });

  const draft = await createDraft(
    { tenantId, entityId },
    {
      payload: {
        entry_date: onDate,
        description: 'Reclassify to non-deductible: cash payment above the LISR art. 27 fr. III limit',
        reference,
        lines,
      },
      confidence: 1,
      reasoning:
        'The expense settled in cash above the limit in force (LISR 27-III; its IVA is not creditable, LIVA 5-I). ' +
        'The figures are the posted entry; the review decides whether the CFDI payment method is in fact wrong.',
      model: 'cash-limit-signal',
    },
    client
  );
  return draft.id;
}

/**
 * Does the bill's CFDI say it was paid in cash AND did the bill NOT come from the
 * ingestion? A bill the ingestion created already went through its
 * `efectivo_no_deducible` question, whose answer is the human decision; the
 * signal never second-guesses it.
 */
export async function billCfdiPaidInCash(
  client: pg.PoolClient,
  entityId: string,
  cfdiUuid: string | null,
  billId: string
): Promise<boolean> {
  if (!cfdiUuid) return false;
  const r = await client.query<{ forma_pago: string | null }>(
    `SELECT x.forma_pago FROM xml_documents x
      WHERE x.cfdi_uuid = $1 AND x.entity_id = $2
        AND NOT EXISTS (SELECT 1 FROM pre_registrations p WHERE p.xml_document_id = x.id AND p.bill_id = $3)`,
    [cfdiUuid, entityId, billId]
  );
  return (r.rows[0]?.forma_pago ?? '').trim() === CFDI_CASH;
}

/**
 * The bills a cash payment settles whose cash question the ingestion already
 * asked (born from a pre-registration whose CFDI said cash): their decision is
 * recorded and the payment signal leaves them out.
 */
export async function billsDecidedByIngestion(
  client: pg.PoolClient,
  entityId: string,
  billIds: string[]
): Promise<Set<string>> {
  if (billIds.length === 0) return new Set();
  const r = await client.query<{ bill_id: string }>(
    `SELECT p.bill_id FROM pre_registrations p JOIN xml_documents x ON x.id = p.xml_document_id
      WHERE p.entity_id = $1 AND p.bill_id = ANY($2::uuid[]) AND btrim(x.forma_pago) = $3`,
    [entityId, billIds, CFDI_CASH]
  );
  return new Set(r.rows.map((x) => x.bill_id));
}
