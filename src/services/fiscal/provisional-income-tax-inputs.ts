import type pg from 'pg';
import { query } from '../../database/connection.js';
import type { EntityScope } from '../../database/scope.js';
import { NotFoundError, ValidationError } from '../../utils/errors.js';
import { legalParameterAt, type LegalParameterInForce } from '../jurisdiction/legal-parameters.js';

// ============================================================
// THE INPUTS OF THE PROVISIONAL ISR OF A LEGAL ENTITY (#308 · MNE-001-115)
//
// LISR art. 14 needs three figures the ledger does not hold:
//
//   · the PROFIT COEFFICIENT and the TAX LOSSES pending amortization, which
//     the accountant reads off an annual return. They are captured here, each
//     with that return (its year, filing date and identification), in a table
//     by the return's fiscal year (owner decision MNE-001-114). Append-only,
//     enforced by a trigger: a correction is a new row (migration 166).
//   · the CORPORATE RATE, which is law: it is read from legal_parameters on
//     the date of the payment, never from a constant.
//
// WHICH RETURN A PAYMENT USES is the law's, not the latest capture's: the
// last return filed, or due, by the payment's due date (art. 14 fr. I). So
// January and February read the return before last unless the last one was
// already filed. A re-run passes asOf and reads what had been captured then.
//
// The calculation itself is MNE-001-059; this module only keeps and reads
// the inputs, and fails closed on what it cannot vouch for.
// ============================================================

export type IncomeTaxInputKind = 'profit_coefficient' | 'pending_tax_losses';

/** The legal_parameters key of the corporate rate (LISR art. 9). */
export const CORPORATE_INCOME_TAX_RATE_KEY = 'income_tax.corporate_rate';

export interface IncomeTaxInputCapture {
  kind: IncomeTaxInputKind;
  /**
   * Decimal string, up to 4 places. A coefficient may exceed 1: the nominal
   * income of its denominator excludes the accumulable inflation adjustment
   * that the utilidad fiscal includes.
   */
  value: string;
  /** The year of the annual return the figure was read from. */
  sourceFiscalYear: number;
  /** When that return was filed, YYYY-MM-DD. */
  sourceFiledOn: string;
  /** How the accountant identifies that return (operation number). */
  sourceDocument: string;
  /**
   * Pending tax losses only, and required for them: the INPC month (YYYY-MM)
   * the amount is already updated through (LISR art. 57). The calculation
   * (MNE-001-059) finishes the update to the year of application.
   */
  updatedThrough?: string;
  /** A user of the scope's tenant; any other answers 404. */
  recordedBy?: string;
}

export interface IncomeTaxInput {
  id: string;
  kind: IncomeTaxInputKind;
  value: string;
  sourceFiscalYear: number;
  sourceFiledOn: string;
  sourceDocument: string;
  /** YYYY-MM, or null for a coefficient. */
  updatedThrough: string | null;
  recordedAt: string;
}

/** The monthly provisional payment whose input is asked for. */
export interface ProvisionalPayment {
  fiscalYear: number;
  /** 1..12, the month the payment covers. */
  month: number;
}

const KINDS: readonly IncomeTaxInputKind[] = ['profit_coefficient', 'pending_tax_losses'];
const DECIMAL_4 = /^\d+(\.\d{1,4})?$/;
const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const ISO_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** LISR art. 14 fr. I: a coefficient from a return up to five years older. */
export const COEFFICIENT_MAX_AGE_YEARS = 5;
/** LISR art. 14: the provisional payment is due by the 17th of the next month. */
const PAYMENT_DUE_DAY = 17;

/**
 * Records one captured figure for the entity. Never overwrites: an earlier
 * capture of the same return stays as history and this one is in force.
 *
 * The entity and the user are bound inside the statement (each is copied
 * only if it belongs to the scope's tenant), so a foreign one answers 404
 * exactly like a missing one.
 */
export async function recordIncomeTaxInput(
  scope: EntityScope,
  capture: IncomeTaxInputCapture,
  client?: pg.PoolClient
): Promise<IncomeTaxInput> {
  assertCapture(capture);
  const r = await run(client)<Partial<IncomeTaxInput> & { entityFound: boolean }>(
    `WITH le AS (
       SELECT id FROM legal_entities WHERE id = $1 AND tenant_id = $2
     ), who AS (
       SELECT id FROM users WHERE id = $9::uuid AND tenant_id = $2
     ), ins AS (
       INSERT INTO income_tax_annual_inputs
         (entity_id, kind, value, source_fiscal_year, source_filed_on, source_document,
          updated_through, recorded_by)
       SELECT le.id, $3, $4::numeric, $5, $6::date, $7, $8::date, (SELECT id FROM who)
         FROM le
        WHERE $9::uuid IS NULL OR EXISTS (SELECT 1 FROM who)
       RETURNING ${COLUMNS}
     )
     SELECT EXISTS (SELECT 1 FROM le) AS "entityFound", ins.*
       FROM (SELECT 1) AS one LEFT JOIN ins ON true`,
    [scope.entityId, scope.tenantId, capture.kind, capture.value, capture.sourceFiscalYear,
     capture.sourceFiledOn, capture.sourceDocument.trim(),
     capture.updatedThrough ? `${capture.updatedThrough}-01` : null, capture.recordedBy ?? null]
  );
  const row = r.rows[0];
  if (!row?.entityFound) throw new NotFoundError('Entity', scope.entityId);
  if (!row.id) throw new NotFoundError('User', capture.recordedBy);
  const { entityFound: _entityFound, ...input } = row;
  return input as IncomeTaxInput;
}

/**
 * The figure a provisional payment uses: from the latest return filed, or
 * due, by the payment's due date (LISR art. 14 fr. I) and, for a coefficient,
 * no more than five years older than the payment's year; within that return,
 * the latest capture. `asOf` (an ISO timestamp) reads only what had been
 * captured by then, so a re-run explains the payment as it was filed.
 *
 * Null when nothing applicable was captured. Null is not zero: the caller
 * decides what a missing coefficient means. An entity outside the scope's
 * tenant answers 404, never null.
 */
export async function incomeTaxInputForPayment(
  scope: EntityScope,
  kind: IncomeTaxInputKind,
  payment: ProvisionalPayment,
  options: { asOf?: string } = {},
  client?: pg.PoolClient
): Promise<IncomeTaxInput | null> {
  const dueOn = provisionalPaymentDueOn(payment);
  const r = await run(client)<Partial<IncomeTaxInput>>(
    `SELECT t.* FROM legal_entities le
       LEFT JOIN LATERAL (
         SELECT ${COLUMNS}
           FROM income_tax_annual_inputs
          WHERE entity_id = le.id AND kind = $3
            AND source_fiscal_year < $4
            AND (kind <> 'profit_coefficient' OR source_fiscal_year >= $4 - $5)
            AND (source_filed_on <= $6::date
                 OR make_date(source_fiscal_year + 1, 3, 31) <= $6::date)
            AND ($7::timestamptz IS NULL OR recorded_at <= $7::timestamptz)
          ORDER BY source_fiscal_year DESC, seq DESC
          LIMIT 1
       ) t ON true
      WHERE le.id = $1 AND le.tenant_id = $2`,
    [scope.entityId, scope.tenantId, kind, payment.fiscalYear, COEFFICIENT_MAX_AGE_YEARS,
     dueOn, options.asOf ?? null]
  );
  if (r.rows.length === 0) throw new NotFoundError('Entity', scope.entityId);
  const row = r.rows[0];
  return row.id ? (row as IncomeTaxInput) : null;
}

/** The 17th of the month after the one the payment covers (LISR art. 14). */
export function provisionalPaymentDueOn(p: ProvisionalPayment): string {
  if (!Number.isInteger(p.fiscalYear) || !Number.isInteger(p.month) || p.month < 1 || p.month > 12) {
    throw new ValidationError(`${p.fiscalYear}-${p.month} no es un mes de pago provisional.`, 'month');
  }
  const year = p.month === 12 ? p.fiscalYear + 1 : p.fiscalYear;
  const month = p.month === 12 ? 1 : p.month + 1;
  return `${year}-${String(month).padStart(2, '0')}-${PAYMENT_DUE_DAY}`;
}

/**
 * The corporate ISR rate in force on the date of the payment, with its date
 * of entry and its source. Fails closed (LegalParameterUnavailableError) when
 * the law has no row for that date.
 */
export function corporateIncomeTaxRateAt(
  onDate: string,
  client?: pg.PoolClient
): Promise<LegalParameterInForce> {
  return legalParameterAt('MX', CORPORATE_INCOME_TAX_RATE_KEY, onDate, client);
}

const COLUMNS = `id, kind, value::text AS value, source_fiscal_year AS "sourceFiscalYear",
       to_char(source_filed_on, 'YYYY-MM-DD') AS "sourceFiledOn", source_document AS "sourceDocument",
       to_char(updated_through, 'YYYY-MM') AS "updatedThrough",
       to_char(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "recordedAt"`;

function run(client?: pg.PoolClient) {
  return client
    ? <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => client.query<T>(sql, params)
    : query;
}

/**
 * The same rules the table's CHECKs hold, said to the accountant in words
 * before Postgres says them as a constraint name.
 */
function assertCapture(c: IncomeTaxInputCapture): void {
  if (!KINDS.includes(c.kind)) {
    throw new ValidationError(`"${c.kind}" no es un dato del ISR provisional: ${KINDS.join(', ')}.`, 'kind');
  }
  if (!Number.isInteger(c.sourceFiscalYear)) {
    throw new ValidationError('El ejercicio de la declaración fuente es un año entero.', 'sourceFiscalYear');
  }
  if (!DECIMAL_4.test(c.value)) {
    throw new ValidationError(
      `"${c.value}" no es una cifra no negativa con hasta cuatro decimales.`, 'value');
  }
  if (c.sourceDocument.trim() === '') {
    throw new ValidationError(
      'Falta la fuente: la declaración anual de la que se tomó la cifra.', 'sourceDocument');
  }
  if (!ISO_DATE.test(c.sourceFiledOn) || c.sourceFiledOn <= `${c.sourceFiscalYear}-12-31`) {
    throw new ValidationError(
      `La declaración de ${c.sourceFiscalYear} se presenta después de que termina el ejercicio: ` +
        `"${c.sourceFiledOn}" no puede ser su fecha.`,
      'sourceFiledOn');
  }
  const losses = c.kind === 'pending_tax_losses';
  if (losses !== (c.updatedThrough !== undefined) ||
      (c.updatedThrough !== undefined && !ISO_MONTH.test(c.updatedThrough))) {
    throw new ValidationError(
      losses
        ? 'Las pérdidas pendientes dicen hasta qué mes del INPC están actualizadas (AAAA-MM, LISR art. 57).'
        : 'Sólo las pérdidas pendientes llevan mes de actualización.',
      'updatedThrough');
  }
}
