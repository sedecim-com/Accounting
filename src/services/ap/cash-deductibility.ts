import type pg from 'pg';
import Decimal from 'decimal.js';
import { legalParameterAt } from '../jurisdiction/legal-parameters.js';
import { jurisdictionOf } from '../jurisdiction/jurisdiction.js';

/** LISR art. 27 fr. III, read by the date of the payment and never hard-coded. */
export const CASH_LIMIT_KEY = 'income_tax.cash_payment_deduction_limit';

/** c_FormaPago 01 = cash. */
const CFDI_CASH = '01';

/**
 * A signal, not a ledger change: the expense stays as booked and the reviewer
 * decides whether to reclassify it to `gasto_no_deducible` (the ingestion asks
 * the same question as `efectivo_no_deducible`). Reclassifying silently would
 * pick a tax treatment for the firm.
 */
export interface CashDeductibilityFinding {
  code: 'cash_over_limit_not_deductible';
  billNumber: string;
  /** What was paid in cash, in pesos. */
  amount: string;
  limit: string;
  /** The date of the payment the limit was read at, YYYY-MM-DD. */
  onDate: string;
  sourceUrl: string;
  message: string;
}

/**
 * The finding when `amount` paid in cash on `onDate` exceeds the limit in force
 * that day, or `[]`. Only Mexican-law entities and pesos are judged: a foreign
 * currency amount needs the firm's FX source and is left out (open point).
 *
 * The parameter is read ONLY when a cash payment is actually in play, so an
 * unseeded table cannot stop an approval that has nothing to do with cash; once
 * in play, a missing vigencia throws (LegalParameterUnavailableError).
 */
export async function cashLimitFinding(
  client: pg.PoolClient,
  args: { entityId: string; billNumber: string; amount: string; currency: string; onDate: string }
): Promise<CashDeductibilityFinding[]> {
  if (args.currency !== 'MXN') return [];
  const e = await client.query<{ incorporation_country: string | null; accounting_standard: string | null }>(
    'SELECT incorporation_country, accounting_standard FROM legal_entities WHERE id = $1',
    [args.entityId]
  );
  if (e.rows.length === 0 || jurisdictionOf(e.rows[0]).fiscal !== 'MX') return [];

  const limit = await legalParameterAt('MX', CASH_LIMIT_KEY, args.onDate, client);
  const amount = new Decimal(args.amount);
  if (!amount.greaterThan(limit.value)) return [];
  const limitText = new Decimal(limit.value).toFixed(2);
  return [{
    code: 'cash_over_limit_not_deductible',
    billNumber: args.billNumber,
    amount: amount.toFixed(2),
    limit: limitText,
    onDate: args.onDate,
    sourceUrl: limit.sourceUrl,
    message:
      `${args.billNumber}: ${amount.toFixed(2)} MXN paid in cash on ${args.onDate} exceeds the ` +
      `${limitText} limit of LISR art. 27 fr. III: not deductible, and its IVA is not ` +
      `creditable (LIVA art. 5 fr. I). Nothing was reclassified; decide whether to book it as non-deductible.`,
  }];
}

/** Does the bill's CFDI say it was paid in cash? (a bill without a CFDI has no method at approval.) */
export async function billCfdiPaidInCash(
  client: pg.PoolClient,
  entityId: string,
  cfdiUuid: string | null
): Promise<boolean> {
  if (!cfdiUuid) return false;
  const r = await client.query<{ forma_pago: string | null }>(
    'SELECT forma_pago FROM xml_documents WHERE cfdi_uuid = $1 AND entity_id = $2',
    [cfdiUuid, entityId]
  );
  return (r.rows[0]?.forma_pago ?? '').trim() === CFDI_CASH;
}
