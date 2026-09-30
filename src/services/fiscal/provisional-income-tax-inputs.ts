import Decimal from 'decimal.js';
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
//     the accountant reads off an earlier annual return. They are captured
//     here, each with that return as its source, in a table by fiscal year
//     (owner decision MNE-001-114). Append-only: a correction is a new row
//     and the latest capture is the one in force (migration 166).
//   · the CORPORATE RATE, which is law: it is read from legal_parameters on
//     the date of the payment, never from a constant.
//
// The calculation itself is MNE-001-059; this module only keeps and reads
// the inputs, and fails closed on what it cannot vouch for.
// ============================================================

export type IncomeTaxInputKind = 'profit_coefficient' | 'pending_tax_losses';

/** The legal_parameters key of the corporate rate (LISR art. 9). */
export const CORPORATE_INCOME_TAX_RATE_KEY = 'income_tax.corporate_rate';

export interface IncomeTaxInputCapture {
  /** The year whose provisional payments use the figure. */
  fiscalYear: number;
  kind: IncomeTaxInputKind;
  /** Decimal string, up to 4 places: the house discipline for money and rates. */
  value: string;
  /** The year of the annual return the figure was read from. */
  sourceFiscalYear: number;
  /** How the accountant identifies that return (operation number, date). */
  sourceDocument: string;
  recordedBy?: string;
}

export interface IncomeTaxInput {
  id: string;
  fiscalYear: number;
  kind: IncomeTaxInputKind;
  value: string;
  sourceFiscalYear: number;
  sourceDocument: string;
  recordedAt: string;
}

const KINDS: readonly IncomeTaxInputKind[] = ['profit_coefficient', 'pending_tax_losses'];
const DECIMAL_4 = /^\d+(\.\d{1,4})?$/;
/** LISR art. 14 fr. I: a coefficient from a return up to five years older. */
const COEFFICIENT_MAX_AGE_YEARS = 5;

/**
 * Records one captured figure for the entity. Never overwrites: the previous
 * capture stays as history and this one becomes the figure in force.
 *
 * The entity bound lives in the INSERT itself (it copies the entity only if it
 * belongs to the scope's tenant), so a foreign entity answers 404 exactly like
 * a missing one.
 */
export async function recordIncomeTaxInput(
  scope: EntityScope,
  capture: IncomeTaxInputCapture,
  client?: pg.PoolClient
): Promise<IncomeTaxInput> {
  assertCapture(capture);
  const r = await run(client)<IncomeTaxInput>(
    `INSERT INTO income_tax_annual_inputs
       (entity_id, fiscal_year, kind, value, source_fiscal_year, source_document, recorded_by)
     SELECT le.id, $3, $4, $5::numeric, $6, $7, $8
       FROM legal_entities le
      WHERE le.id = $1 AND le.tenant_id = $2
     RETURNING ${COLUMNS}`,
    [scope.entityId, scope.tenantId, capture.fiscalYear, capture.kind, capture.value,
     capture.sourceFiscalYear, capture.sourceDocument.trim(), capture.recordedBy ?? null]
  );
  if (r.rows.length === 0) throw new NotFoundError('Entity', scope.entityId);
  return r.rows[0];
}

/**
 * The figure in force for the year: the latest capture, or null when nobody
 * captured it. Null is not zero, and the caller decides what a missing
 * coefficient means; this reader does not invent one.
 */
export async function incomeTaxInputInForce(
  scope: EntityScope,
  fiscalYear: number,
  kind: IncomeTaxInputKind,
  client?: pg.PoolClient
): Promise<IncomeTaxInput | null> {
  const r = await run(client)<IncomeTaxInput>(
    `SELECT ${COLUMNS}
       FROM income_tax_annual_inputs
      WHERE entity_id = $1 AND fiscal_year = $2 AND kind = $3
        AND entity_id IN (SELECT id FROM legal_entities WHERE tenant_id = $4)
      ORDER BY recorded_at DESC
      LIMIT 1`,
    [scope.entityId, fiscalYear, kind, scope.tenantId]
  );
  return r.rows[0] ?? null;
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

const COLUMNS = `id, fiscal_year AS "fiscalYear", kind, value::text AS value,
       source_fiscal_year AS "sourceFiscalYear", source_document AS "sourceDocument",
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
  if (!Number.isInteger(c.fiscalYear) || !Number.isInteger(c.sourceFiscalYear)) {
    throw new ValidationError('El ejercicio y el de la declaración fuente son años enteros.', 'fiscalYear');
  }
  if (!DECIMAL_4.test(c.value)) {
    throw new ValidationError(
      `"${c.value}" no es una cifra no negativa con hasta cuatro decimales.`, 'value');
  }
  if (c.sourceDocument.trim() === '') {
    throw new ValidationError(
      'Falta la fuente: la declaración anual de la que se tomó la cifra.', 'sourceDocument');
  }
  if (c.sourceFiscalYear >= c.fiscalYear) {
    throw new ValidationError(
      `La declaración fuente (${c.sourceFiscalYear}) tiene que ser de un ejercicio anterior a ${c.fiscalYear}.`,
      'sourceFiscalYear');
  }
  if (c.kind === 'profit_coefficient') {
    if (new Decimal(c.value).gt(1)) {
      throw new ValidationError(
        `El coeficiente de utilidad es una fracción de los ingresos: ${c.value} excede 1.`, 'value');
    }
    if (c.fiscalYear - c.sourceFiscalYear > COEFFICIENT_MAX_AGE_YEARS) {
      throw new ValidationError(
        `El coeficiente de ${c.sourceFiscalYear} no puede aplicarse en ${c.fiscalYear}: la declaración ` +
          'no puede ser anterior en más de cinco años (LISR art. 14 fr. I).',
        'sourceFiscalYear');
    }
  }
}
