import pg from 'pg';
import { query, withTransaction, currentTenant } from '../../database/connection.js';
import { registrarAuditoria } from '../audit/audit-log.js';
// El arrastre vive en period-close, el único orquestador del cierre. Se
// importa en vez de copiarse: dos INSERT ... ON CONFLICT que siembran el
// mismo saldo inicial son dos saldos iniciales en cuanto uno de los dos se
// corrija. (El ciclo con period-close → ledger-checks → este módulo se
// resuelve en tiempo de llamada, no de carga: nadie usa el otro módulo
// mientras se evalúa el suyo.)
import {
  carryForwardBalances,
  closeFiscalYearIfSealed,
  openFiscalYearOnSealedBooks,
  reopenFiscalYearOf,
  type FiscalYearOpening,
} from './period-close.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  AccountingError,
} from '../../utils/errors.js';
import { FiscalPeriodStatus } from '../../types/index.js';
import type { FiscalPeriod, FiscalYear } from '../../types/index.js';

// ============================================================
// FISCAL CALENDAR — domain service (years, periods, the open gate)
//
// Three things that existed in three different places now live here:
//   - the period listing the REST route did inline (routes/fiscal-periods.ts:21),
//   - the fiscal-year + 12-period calendar the onboarding wizard built inside
//     itself (cli/init/s1-identity.ts:154), which meant a firm could only ever
//     get the CURRENT year, and only by rerunning the wizard,
//   - the future → open transition, which had no driver in any layer: periods
//     are NOT all born open (s1-identity.ts:177 marks the months after the
//     current one 'future'), so without this a fresh entity cannot capture
//     next month at all.
//
// What is deliberately NOT here: closing. `close`/`cierre` is the single
// orchestrator of the monthly close (period-close.ts: checklist, soft close,
// hard close, carry-forward) and this module never duplicates it.
// ============================================================

export const PERIOD_STATUSES = ['future', 'open', 'soft_close', 'hard_close', 'locked'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YEAR_MONTH_RE = /^(\d{4})-(\d{2})$/;

export interface PeriodFilters {
  fiscalYearId?: string;
  status?: string | string[];
  /** Calendar/fiscal year number, e.g. 2026 — resolved through fiscal_years. */
  yearNumber?: number;
}

export interface ListPeriodOptions {
  /**
   * Adds year_number and the overdue flag. Off by default because the REST
   * response is a bare `SELECT *` of fiscal_periods and must stay that way.
   */
  includeYear?: boolean;
}

export type FiscalPeriodRow = FiscalPeriod & { year_number?: number; overdue?: boolean };

export async function listFiscalPeriods(
  entityId: string,
  filters: PeriodFilters = {},
  opts: ListPeriodOptions = {}
): Promise<FiscalPeriodRow[]> {
  const where: string[] = ['fp.entity_id = $1'];
  const params: unknown[] = [entityId];
  let i = 2;

  if (filters.fiscalYearId) {
    where.push(`fp.fiscal_year_id = $${i++}`);
    params.push(filters.fiscalYearId);
  }
  // Truthiness, not `!== undefined` — see journal-entry-service.buildWhere:
  // the REST handler's `if (status)` ignored an empty `?status=`, and this
  // must keep ignoring it instead of filtering on the empty string.
  if (Array.isArray(filters.status)) {
    where.push(`fp.status = ANY($${i++})`);
    params.push(filters.status);
  } else if (filters.status) {
    where.push(`fp.status = $${i++}`);
    params.push(filters.status);
  }
  if (filters.yearNumber !== undefined) {
    where.push(
      `fp.fiscal_year_id IN (SELECT id FROM fiscal_years WHERE entity_id = fp.entity_id AND year_number = $${i++})`
    );
    params.push(filters.yearNumber);
  }

  // The REST surface reads the table's own columns and nothing else; the CLI
  // asks for the year and the overdue flag it needs to render a calendar.
  const select = opts.includeYear
    ? `SELECT fp.*, fy.year_number, (fp.end_date < CURRENT_DATE) AS overdue
       FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id`
    : 'SELECT * FROM fiscal_periods fp';

  const result = await query<FiscalPeriodRow>(
    `${select} ${`WHERE ${where.join(' AND ')}`} ORDER BY fp.start_date`,
    params
  );
  return result.rows;
}

/**
 * Resolves what a person types into one period: a uuid, "2026-08", or any
 * unambiguous part of the period name ("august", "August 2026"). Refuses an
 * ambiguous match instead of picking the first, which is how `close -p` can
 * silently close a different month than the one that was meant.
 *
 * `YYYY-MM` names the regular month by default. December also starts the
 * year-end adjustments period (period 13, which starts on YYYY-12-31), so a
 * caller that must not guess — the close leaves, where hard-closing period 12
 * instead of 13 skips the annual closing entries — passes
 * `refuseSharedMonth` and gets the same refusal an ambiguous name gets.
 */
export async function resolvePeriod(
  entityId: string,
  ref: string,
  opts: { refuseSharedMonth?: boolean } = {}
): Promise<FiscalPeriodRow> {
  const trimmed = ref.trim();

  if (UUID_RE.test(trimmed)) {
    const byId = await query<FiscalPeriodRow>(
      `SELECT fp.*, fy.year_number, (fp.end_date < CURRENT_DATE) AS overdue
       FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
       WHERE fp.id = $1 AND fp.entity_id = $2`,
      [trimmed, entityId]
    );
    if (byId.rows.length === 0) throw new NotFoundError('Fiscal period', trimmed);
    return byId.rows[0];
  }

  const yearMonth = YEAR_MONTH_RE.exec(trimmed);
  if (yearMonth) {
    const byDate = await query<FiscalPeriodRow>(
      `SELECT fp.*, fy.year_number, (fp.end_date < CURRENT_DATE) AS overdue
       FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
       WHERE fp.entity_id = $1
         AND EXTRACT(YEAR FROM fp.start_date) = $2
         AND EXTRACT(MONTH FROM fp.start_date) = $3
       ORDER BY fp.period_number`,
      [entityId, Number(yearMonth[1]), Number(yearMonth[2])]
    );
    if (byDate.rows.length === 0) throw new NotFoundError('Fiscal period', trimmed);
    if (opts.refuseSharedMonth && byDate.rows.length > 1) {
      throw new ValidationError(
        `"${trimmed}" matches ${byDate.rows.length} periods: ` +
          `${byDate.rows.map((p) => `${p.period_name} (${p.id})`).join(', ')}. ` +
          'Name one of them by its full name or its id.'
      );
    }
    return byDate.rows[0];
  }

  const byName = await query<FiscalPeriodRow>(
    `SELECT fp.*, fy.year_number, (fp.end_date < CURRENT_DATE) AS overdue
     FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
     WHERE fp.entity_id = $1 AND fp.period_name ILIKE $2
     ORDER BY fp.start_date`,
    [entityId, `%${trimmed}%`]
  );
  if (byName.rows.length === 0) throw new NotFoundError('Fiscal period', trimmed);
  if (byName.rows.length > 1) {
    throw new ValidationError(
      `"${trimmed}" matches ${byName.rows.length} periods: ` +
        `${byName.rows.map((p) => p.period_name).join(', ')}. Name one of them, or use YYYY-MM.`
    );
  }
  return byName.rows[0];
}

export interface PeriodDetail extends FiscalPeriodRow {
  closed_by_email: string | null;
  entry_counts: Record<string, number>;
  entry_count: number;
}

/** The period plus who closed it, the checklist it was closed with, and its entries by state. */
export async function getPeriodDetail(entityId: string, ref: string): Promise<PeriodDetail> {
  const period = await resolvePeriod(entityId, ref);

  const [counts, closer] = await Promise.all([
    query<{ status: string; count: string }>(
      `SELECT status, COUNT(*)::text AS count FROM journal_entries
       WHERE fiscal_period_id = $1 AND entity_id = $2 GROUP BY status`,
      [period.id, entityId]
    ),
    period.closed_by
      ? query<{ email: string }>('SELECT email FROM users WHERE id = $1', [period.closed_by])
      : Promise.resolve({ rows: [] as Array<{ email: string }> }),
  ]);

  const entry_counts: Record<string, number> = {};
  let entry_count = 0;
  for (const row of counts.rows) {
    const n = parseInt(row.count, 10);
    entry_counts[row.status] = n;
    entry_count += n;
  }

  return {
    ...period,
    closed_by_email: closer.rows[0]?.email ?? null,
    entry_counts,
    entry_count,
  };
}

/**
 * future → open, the gate that lets bookkeeping start in a period.
 *
 * It is a POLICY gate, not a hard barrier: createJournalEntry (posting.ts:94)
 * only refuses hard_close and locked, so a 'future' period would already
 * accept entries. Opening it is what makes that intentional and visible, and
 * the reason is written to the audit trail.
 *
 * Only future → open. Reopening a CLOSED period is a different operation with
 * a different blast radius (derived statements, filed trial balances) and is
 * not smuggled in here.
 */
/**
 * REABRIR UN PERIODO YA CERRADO.
 *
 * openPeriod() se niega a hacerlo y remite a «una operación aparte,
 * auditada». Esta es esa operación, y existe porque hay correcciones que
 * pertenecen al periodo en que ocurrió el hecho y no al de hoy: reclasificar
 * un IVA mal acreditado en marzo no es un gasto de agosto.
 *
 * Tres cerrojos, en este orden:
 *  · 'locked' NO se reabre por ningún camino. Es el estado que se pone
 *    cuando la información ya salió del sistema (dictamen, declaración
 *    anual): reabrirlo desde aquí sería falsear un documento presentado.
 *  · Exige un motivo. Un periodo reabierto sin explicación es un agujero en
 *    el rastro; el motivo queda en audit_log junto con el estado anterior.
 *  · Devuelve el estado del que venía, para que quien reabre sepa a qué
 *    tiene que volver a dejarlo.
 */
export async function reopenClosedPeriod(
  entityId: string,
  periodId: string,
  userId: string,
  reason: string
): Promise<{ period: FiscalPeriod; previousStatus: string }> {
  if (!reason || reason.trim().length === 0) {
    throw new AccountingError(
      'REASON_REQUIRED',
      { key: 'error.REASON_REQUIRED' }
    );
  }

  return withTransaction(async (client) => {
    const current = await client.query<FiscalPeriod>(
      'SELECT * FROM fiscal_periods WHERE id = $1 AND entity_id = $2 FOR UPDATE',
      [periodId, entityId]
    );
    if (current.rows.length === 0) throw new NotFoundError('Fiscal period', periodId);
    const period = current.rows[0];
    const previousStatus = period.status as string;

    if (previousStatus === 'open') {
      throw new AccountingError('PERIOD_ALREADY_OPEN', {
        key: 'error.PERIOD_ALREADY_OPEN',
        params: { period: period.period_name },
      });
    }
    if (previousStatus === 'locked') {
      throw new AccountingError(
        'PERIOD_LOCKED',
        { key: 'error.PERIOD_LOCKED', params: { period: period.period_name } }
      );
    }
    if (previousStatus !== 'soft_close' && previousStatus !== 'hard_close') {
      throw new AccountingError(
        'PERIOD_NOT_CLOSED',
        { key: 'error.PERIOD_NOT_CLOSED', params: { period: period.period_name, status: previousStatus } }
      );
    }

    const updated = await client.query<FiscalPeriod>(
      `UPDATE fiscal_periods SET status = 'open', updated_at = NOW()
       WHERE id = $1 AND entity_id = $2 RETURNING *`,
      [periodId, entityId]
    );
    // A closed year with an open period in it would be a lie (#99).
    const yearReopened = await reopenFiscalYearOf(client, entityId, periodId);

    await registrarAuditoria(client, {
      tenantId: await inquilinoDeEntidad(client, entityId),
      legalEntityId: entityId,
      userId,
      action: 'reopen',
      entityType: 'fiscal_period',
      entityId: periodId,
      oldValues: { status: previousStatus },
      newValues: { status: 'open', ...(yearReopened !== null ? { fiscal_year_reopened: yearReopened } : {}) },
      reason,
    });

    return { period: updated.rows[0], previousStatus };
  });
}

/**
 * Devuelve el periodo al estado del que se le sacó. Se usa en pareja con
 * reopenClosedPeriod: reabrir sin volver a cerrar deja el ejercicio abierto
 * sin que nadie lo haya decidido.
 *
 * VOLVER A CERRAR NO ES UN UPDATE DE LA COLUMNA `status`.
 *
 * Se reabre para ESCRIBIR —la reclasificación del IVA PPD es el llamador
 * vivo, y postea un asiento en el periodo reabierto—, así que al restaurar,
 * los saldos finales de ese periodo ya no son los que se arrastraron cuando
 * se cerró la primera vez. Un `UPDATE ... SET status` devolvía la etiqueta y
 * dejaba el saldo INICIAL del periodo siguiente exactamente como estaba: la
 * corrección quedaba dentro del mes reabierto y desaparecía en el siguiente,
 * que seguía partiendo del acumulado viejo. Y ese inicial es el que el
 * auxiliar publica y el XML del Anexo 24 atesta.
 *
 * El arrastre se rehace sólo al restaurar a 'hard_close' porque es el cierre
 * duro el que lo genera; un 'soft_close' nunca sembró nada que rehacer.
 */
export async function restorePeriodStatus(
  entityId: string,
  periodId: string,
  status: string,
  userId: string,
  reason: string
): Promise<FiscalPeriod> {
  if (status !== 'soft_close' && status !== 'hard_close') {
    throw new AccountingError(
      'INVALID_STATUS',
      { key: 'error.INVALID_STATUS', params: { status } }
    );
  }
  return withTransaction(async (client) => {
    const r = await client.query<FiscalPeriod>(
      `UPDATE fiscal_periods SET status = $3, updated_at = NOW()
       WHERE id = $1 AND entity_id = $2 AND status = 'open' RETURNING *`,
      [periodId, entityId, status]
    );
    if (r.rows.length === 0) {
      throw new AccountingError(
        'PERIOD_NOT_OPEN',
        { key: 'error.PERIOD_NOT_OPEN.restore', params: { period: periodId } }
      );
    }

    // Mismo cliente que el UPDATE: o el periodo vuelve a estar cerrado CON su
    // arrastre rehecho, o no vuelve a estar cerrado.
    const carry =
      status === 'hard_close' ? await carryForwardBalances(client, entityId, periodId) : null;
    // The reopen took the year back to 'open'; sealing its period again closes it again.
    const yearClosed = status === 'hard_close' ? await closeFiscalYearIfSealed(client, entityId, periodId) : null;

    await registrarAuditoria(client, {
      tenantId: await inquilinoDeEntidad(client, entityId),
      legalEntityId: entityId,
      userId,
      action: 'close',
      entityType: 'fiscal_period',
      entityId: periodId,
      oldValues: { status: 'open' },
      newValues: {
        status,
        carried_accounts: carry?.carried ?? 0,
        ...(carry ? { carried_into: carry.periods } : {}),
        ...(carry?.stopped_at_locked ? { carry_stopped_at_locked: carry.stopped_at_locked } : {}),
        ...(yearClosed !== null ? { fiscal_year_closed: yearClosed } : {}),
      },
      reason,
    });
    return r.rows[0];
  });
}

async function inquilinoDeEntidad(client: pg.PoolClient, entityId: string): Promise<string> {
  const delContexto = currentTenant();
  if (delContexto) return delContexto;
  const r = await client.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  const tenantId = r.rows[0]?.tenant_id;
  if (!tenantId) {
    throw new AccountingError('TENANT_NO_RESUELTO', { key: 'error.TENANT_NO_RESUELTO.period', params: { entity: entityId } });
  }
  return tenantId;
}

export async function openPeriod(
  entityId: string,
  periodId: string,
  userId: string,
  reason?: string
): Promise<FiscalPeriod> {
  return withTransaction(async (client) => {
    const current = await client.query<FiscalPeriod>(
      'SELECT * FROM fiscal_periods WHERE id = $1 AND entity_id = $2 FOR UPDATE',
      [periodId, entityId]
    );
    if (current.rows.length === 0) throw new NotFoundError('Fiscal period', periodId);

    const period = current.rows[0];
    if (period.status === FiscalPeriodStatus.OPEN) {
      throw new AccountingError('PERIOD_ALREADY_OPEN', {
        key: 'error.PERIOD_ALREADY_OPEN',
        params: { period: period.period_name },
      });
    }
    if (period.status !== FiscalPeriodStatus.FUTURE) {
      throw new AccountingError(
        'PERIOD_NOT_FUTURE',
        { key: 'error.PERIOD_NOT_FUTURE', params: { period: period.period_name, status: period.status } }
      );
    }

    const updated = await client.query<FiscalPeriod>(
      `UPDATE fiscal_periods SET status = 'open', updated_at = NOW()
       WHERE id = $1 AND entity_id = $2 AND status = 'future'
       RETURNING *`,
      [periodId, entityId]
    );

    await client.query(
      `INSERT INTO audit_log (id, user_id, tenant_id, legal_entity_id, action, entity_type, entity_id, old_values, new_values, reason)
       VALUES (uuid_generate_v4(), $1,
               COALESCE($2::uuid, (SELECT tenant_id FROM legal_entities WHERE id = $3)),
               $3,
               'update', 'fiscal_period', $4, $5, $6, $7)`,
      [
        userId,
        currentTenant() ?? null,
        entityId,
        periodId,
        JSON.stringify({ status: 'future' }),
        JSON.stringify({ status: 'open' }),
        reason ?? null,
      ]
    );

    return updated.rows[0];
  });
}

// ---- Fiscal years ---------------------------------------------------

export type FiscalYearRow = FiscalYear & {
  period_count: number;
  open_period_count: number;
  closed_period_count: number;
};

export async function listFiscalYears(
  entityId: string,
  filters: { status?: string } = {}
): Promise<FiscalYearRow[]> {
  const where: string[] = ['fy.entity_id = $1'];
  const params: unknown[] = [entityId];
  if (filters.status) {
    where.push('fy.status = $2');
    params.push(filters.status);
  }

  const result = await query<FiscalYearRow>(
    `SELECT fy.*,
            (SELECT COUNT(*) FROM fiscal_periods p WHERE p.fiscal_year_id = fy.id)::int AS period_count,
            (SELECT COUNT(*) FROM fiscal_periods p WHERE p.fiscal_year_id = fy.id AND p.status = 'open')::int AS open_period_count,
            (SELECT COUNT(*) FROM fiscal_periods p WHERE p.fiscal_year_id = fy.id
              AND p.status IN ('hard_close', 'locked'))::int AS closed_period_count
     FROM fiscal_years fy
     WHERE ${where.join(' AND ')}
     ORDER BY fy.year_number DESC`,
    params
  );
  return result.rows;
}

export async function getFiscalYear(
  entityId: string,
  yearNumber: number
): Promise<{ year: FiscalYearRow; periods: FiscalPeriodRow[] }> {
  const years = await query<FiscalYearRow>(
    `SELECT fy.*,
            (SELECT COUNT(*) FROM fiscal_periods p WHERE p.fiscal_year_id = fy.id)::int AS period_count,
            (SELECT COUNT(*) FROM fiscal_periods p WHERE p.fiscal_year_id = fy.id AND p.status = 'open')::int AS open_period_count,
            (SELECT COUNT(*) FROM fiscal_periods p WHERE p.fiscal_year_id = fy.id
              AND p.status IN ('hard_close', 'locked'))::int AS closed_period_count
     FROM fiscal_years fy
     WHERE fy.entity_id = $1 AND fy.year_number = $2`,
    [entityId, yearNumber]
  );
  if (years.rows.length === 0) throw new NotFoundError('Fiscal year', String(yearNumber));

  const periods = await listFiscalPeriods(entityId, { fiscalYearId: years.rows[0].id }, { includeYear: true });
  return { year: years.rows[0], periods };
}

/** The year-end adjustment period: the thirteenth, after the twelve months. */
export const YEAR_END_PERIOD_NUMBER = 13;

export interface EnsureFiscalYearResult {
  created: boolean;
  fiscalYearId: string;
  yearNumber: number;
  periods: number;
  /** Only when the year was created: the period before it and what it carried in. */
  opening?: FiscalYearOpening;
}

/**
 * The calendar year and its twelve monthly periods, idempotent.
 *
 * Extracted verbatim from the onboarding wizard (s1-identity.ts:154) with one
 * generalisation: the wizard could only ever build the CURRENT year, so it
 * compared the month number alone to decide which period starts open. For any
 * other year that test opens a random month, so it is now qualified by the
 * year. For the current year the result is identical to the wizard's.
 *
 * `is_calendar_year` is true and there are twelve regular periods: a 52-53
 * week or 4-4-5 calendar is a different shape with its own rules and is not
 * invented here.
 *
 * And a thirteenth, the year-end ADJUSTMENT period (#304). It is where the
 * annual close posts its entries and what `e-accounting balance generate
 * --closing` declares as month 13; without it that balance could not be
 * generated for any entity. It spans only the last day of the year, so an
 * entry dated December 31 still lands in December while December is open
 * (every date lookup orders by period_number), and its status follows
 * December's.
 *
 * And its beginning balances, when the period before it is already sealed
 * (#594): that seal found no next period to carry into, so the year is born
 * with the carry it missed. `opening` says from where and how much.
 */
export async function ensureFiscalYear(
  entityId: string,
  yearNumber: number,
  now: Date = new Date()
): Promise<EnsureFiscalYearResult> {
  const existing = await query<{ id: string; n: string }>(
    `SELECT fy.id, count(fp.id)::text AS n
     FROM fiscal_years fy
     LEFT JOIN fiscal_periods fp ON fp.fiscal_year_id = fy.id
     WHERE fy.entity_id = $1 AND fy.year_number = $2
     GROUP BY fy.id`,
    [entityId, yearNumber]
  );
  if (existing.rows.length > 0) {
    return {
      created: false,
      fiscalYearId: existing.rows[0].id,
      yearNumber,
      periods: parseInt(existing.rows[0].n, 10),
    };
  }

  const born = await withTransaction(async (client) => {
    const fy = await client.query<{ id: string }>(
      `INSERT INTO fiscal_years (entity_id, year_number, start_date, end_date, is_calendar_year, status)
       VALUES ($1, $2, $3, $4, true, 'open') RETURNING id`,
      [entityId, yearNumber, `${yearNumber}-01-01`, `${yearNumber}-12-31`]
    );

    let status = 'future';
    for (let m = 1; m <= 12; m++) {
      const start = new Date(Date.UTC(yearNumber, m - 1, 1));
      const end = new Date(Date.UTC(yearNumber, m, 0));
      // Months already over, and the month we are living in, start open; the
      // rest start 'future' and are opened deliberately with `period open`.
      const isCurrentMonth = yearNumber === now.getFullYear() && m - 1 === now.getMonth();
      status = end < now || isCurrentMonth ? 'open' : 'future';
      await client.query(
        `INSERT INTO fiscal_periods (
           entity_id, fiscal_year_id, period_number, period_name,
           start_date, end_date, period_type, status
         ) VALUES ($1,$2,$3,$4,$5,$6,'regular',$7)`,
        [
          entityId, fy.rows[0].id, m,
          // Period names are stored, not translated at render time; the CLI UI
          // is English, so they are minted in English.
          start.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }) + ` ${yearNumber}`,
          start.toISOString().split('T')[0], end.toISOString().split('T')[0], status,
        ]
      );
    }
    // CONTRACT: period 13 of type 'adjustment' is what the Anexo 24 closing
    // balance (balanza-service.ts, periodoDeCierre) reads as Mes 13.
    await client.query(
      `INSERT INTO fiscal_periods (
         entity_id, fiscal_year_id, period_number, period_name,
         start_date, end_date, period_type, status
       ) VALUES ($1,$2,$3,$4,$5,$6,'adjustment',$7)`,
      [
        entityId, fy.rows[0].id, YEAR_END_PERIOD_NUMBER, `Year-end adjustments ${yearNumber}`,
        `${yearNumber}-12-31`, `${yearNumber}-12-31`, status,
      ]
    );
    // Same transaction as the calendar: a year whose predecessor is already
    // sealed exists with its beginning balances, or does not exist (#594).
    const opening = await openFiscalYearOnSealedBooks(client, entityId, fy.rows[0].id);
    return { fiscalYearId: fy.rows[0].id, opening };
  });

  return { created: true, yearNumber, periods: YEAR_END_PERIOD_NUMBER, ...born };
}

/**
 * The range `year create` accepts. Exported so a caller previewing the act
 * (`year create --dry-run`) can fail exactly where the act itself fails — a
 * dry run that promises a calendar the real run refuses is worse than none.
 */
export function assertFiscalYearNumber(yearNumber: number): void {
  if (!Number.isInteger(yearNumber) || yearNumber < 1900 || yearNumber > 2999) {
    throw new ValidationError(`"${yearNumber}" is not a four-digit year.`);
  }
}

/** `year create`: the same calendar, but an existing year is a conflict, not a no-op. */
export async function createFiscalYear(
  entityId: string,
  yearNumber: number,
  now: Date = new Date()
): Promise<EnsureFiscalYearResult> {
  assertFiscalYearNumber(yearNumber);
  const result = await ensureFiscalYear(entityId, yearNumber, now);
  if (!result.created) {
    throw new ConflictError(
      `Fiscal year ${yearNumber} already exists for this entity, with ${result.periods} period(s).`
    );
  }
  return result;
}

/** One account whose beginning balance the carry changes, in the ledger's sign (debit positive). */
export interface OpeningCorrection {
  code: string;
  before: string;
  after: string;
}

/** What `year carry-forward run` found, and did, on a year's first period. */
export interface YearCarryForward {
  year_number: number;
  /** The year's first period in books order: the one the carry writes. */
  period: { id: string; period_name: string; status: FiscalPeriodStatus };
  /** The sealed period right before it, whose endings are carried. */
  carried_from: string;
  /** The accounts whose beginning changes; empty when they already are the carried figures. */
  corrections: OpeningCorrection[];
  /** False on a dry run and when there was nothing to correct: the run was rolled back. */
  written: boolean;
}

/** Takes a result out of a transaction that has to roll back (the pattern of invoice-service.ts). */
class CarryRolledBack extends Error {
  constructor(readonly result: YearCarryForward) {
    super('carry rolled back');
    this.name = 'CarryRolledBack';
  }
}

/**
 * One period's beginning balances by account code: one statement, whatever
 * the size of the chart. In byte order, so the corrections are listed the
 * same way whatever the collation of the database.
 */
async function beginningsOf(
  client: pg.PoolClient,
  entityId: string,
  periodId: string
): Promise<Map<string, string>> {
  const r = await client.query<{ code: string; beginning: string }>(
    `SELECT a.code, ab.beginning_balance::text AS beginning
       FROM account_balances ab JOIN accounts a ON a.id = ab.account_id
      WHERE ab.fiscal_period_id = $2 AND ab.entity_id = $1
      ORDER BY a.code COLLATE "C"`,
    [entityId, periodId]
  );
  return new Map(r.rows.map((row) => [row.code, row.beginning]));
}

/**
 * MNE-001-645 (#594). `year carry-forward run`: the carry for a year that
 * already exists. A year created after its predecessor was sealed, by the
 * code before MNE-001-644, has no beginning balances and cannot close its
 * first period. This runs on it the carry `ensureFiscalYear` runs at
 * creation, `openFiscalYearOnSealedBooks`, and nothing of its own: it reads
 * the first period's beginnings before and after, and what differs is what
 * the carry corrected. So it writes what a year created today is born with.
 *
 * The carry writes beginnings and recomputes endings from them; entries,
 * lines and the period's debit and credit totals are not touched, so a first
 * period that already has movements keeps them and moves by the difference.
 *
 * Idempotent: with nothing to correct the transaction is rolled back and no
 * audit row is written. A dry run is the same run, rolled back, so it shows
 * what the real one writes and fails where the real one fails.
 *
 * It refuses when the period before the year is not sealed (its own hard
 * close will carry), when there is none, and when the first period is itself
 * sealed and would change: a closed period does not change without being
 * reopened. The lock on the first period makes its hard close, and a second
 * run of this, wait.
 */
export async function carryForwardIntoYear(
  entityId: string,
  yearNumber: number,
  userId: string,
  opts: { dryRun?: boolean } = {}
): Promise<YearCarryForward> {
  try {
    return await withTransaction(async (client) => {
      const first = await client.query<{
        fiscal_year_id: string; id: string; period_name: string; status: FiscalPeriodStatus;
      }>(
        `SELECT fy.id AS fiscal_year_id, fp.id, fp.period_name, fp.status
           FROM fiscal_years fy
           JOIN fiscal_periods fp ON fp.fiscal_year_id = fy.id AND fp.entity_id = fy.entity_id
          WHERE fy.entity_id = $1 AND fy.year_number = $2
          ORDER BY fp.start_date ASC, fp.period_number ASC LIMIT 1
          FOR UPDATE OF fp`,
        [entityId, yearNumber]
      );
      if (first.rows.length === 0) throw new NotFoundError('Fiscal year', String(yearNumber));
      const { fiscal_year_id: fiscalYearId, ...period } = first.rows[0];
      const names = { year: yearNumber, period: period.period_name };
      // The carry never writes a locked period, so there is nothing to compare.
      if (period.status === FiscalPeriodStatus.LOCKED) {
        throw new AccountingError('CARRY_TARGET_SEALED', { key: 'error.CARRY_TARGET_SEALED.locked', params: names });
      }

      const before = await beginningsOf(client, entityId, period.id);
      const opening = await openFiscalYearOnSealedBooks(client, entityId, fiscalYearId);
      if (!opening.previous) {
        throw new AccountingError('CARRY_SOURCE_MISSING', { key: 'error.CARRY_SOURCE_MISSING', params: names });
      }
      const previous = opening.previous.period_name;
      if (!opening.carry) {
        throw new AccountingError('CARRY_SOURCE_NOT_SEALED', {
          key: 'error.CARRY_SOURCE_NOT_SEALED',
          params: { ...names, previous, status: opening.previous.status },
        });
      }

      const corrections: OpeningCorrection[] = [];
      for (const [code, after] of await beginningsOf(client, entityId, period.id)) {
        // A row the carry created had no beginning: it opened at zero.
        const was = before.get(code) ?? '0.0000';
        if (was !== after) corrections.push({ code, before: was, after });
      }
      const result: YearCarryForward = {
        year_number: yearNumber, period, carried_from: previous, corrections, written: false,
      };
      if (corrections.length === 0) throw new CarryRolledBack(result);
      if (period.status === FiscalPeriodStatus.HARD_CLOSE) {
        throw new AccountingError('CARRY_TARGET_SEALED', {
          key: 'error.CARRY_TARGET_SEALED.hard_close',
          params: { ...names, previous, count: corrections.length },
        });
      }
      if (opts.dryRun) throw new CarryRolledBack(result);

      const figures = (side: 'before' | 'after') =>
        Object.fromEntries(corrections.map((c) => [c.code, c[side]]));
      await registrarAuditoria(client, {
        tenantId: await inquilinoDeEntidad(client, entityId),
        legalEntityId: entityId,
        userId,
        action: 'update',
        entityType: 'fiscal_period',
        entityId: period.id,
        oldValues: { beginning_balances: figures('before') },
        newValues: { beginning_balances: figures('after'), carried_from: previous, fiscal_year: yearNumber },
      });
      return { ...result, written: true };
    });
  } catch (err) {
    if (err instanceof CarryRolledBack) return err.result;
    throw err;
  }
}
