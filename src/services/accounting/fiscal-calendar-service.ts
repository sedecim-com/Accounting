import pg from 'pg';
import { query, withTransaction, currentTenant } from '../../database/connection.js';
import { registrarAuditoria } from '../audit/audit-log.js';
import {
  NotFoundError,
  ValidationError,
  ConflictError,
  AccountingError,
} from '../../utils/errors.js';
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
 */
export async function resolvePeriod(entityId: string, ref: string): Promise<FiscalPeriodRow> {
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
      'Reabrir un periodo cerrado exige un motivo: queda en el rastro de auditoría.'
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
      throw new AccountingError('PERIOD_ALREADY_OPEN', `${period.period_name} ya está abierto.`);
    }
    if (previousStatus === 'locked') {
      throw new AccountingError(
        'PERIOD_LOCKED',
        `${period.period_name} está 'locked': su información ya salió del sistema y no se reabre. ` +
          'La corrección va en el periodo abierto más próximo.'
      );
    }
    if (previousStatus !== 'soft_close' && previousStatus !== 'hard_close') {
      throw new AccountingError(
        'PERIOD_NOT_CLOSED',
        `${period.period_name} está '${previousStatus}': esta operación es sólo para periodos cerrados.`
      );
    }

    const updated = await client.query<FiscalPeriod>(
      `UPDATE fiscal_periods SET status = 'open', updated_at = NOW()
       WHERE id = $1 AND entity_id = $2 RETURNING *`,
      [periodId, entityId]
    );

    await registrarAuditoria(client, {
      tenantId: await inquilinoDeEntidad(client, entityId),
      userId,
      action: 'reopen',
      entityType: 'fiscal_period',
      entityId: periodId,
      oldValues: { status: previousStatus },
      newValues: { status: 'open' },
      reason,
    });

    return { period: updated.rows[0], previousStatus };
  });
}

/**
 * Devuelve el periodo al estado del que se le sacó. Se usa en pareja con
 * reopenClosedPeriod: reabrir sin volver a cerrar deja el ejercicio abierto
 * sin que nadie lo haya decidido.
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
      `Sólo se restaura a 'soft_close' o 'hard_close'; se pidió '${status}'.`
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
        `No se pudo restaurar el periodo ${periodId}: ya no estaba abierto.`
      );
    }
    await registrarAuditoria(client, {
      tenantId: await inquilinoDeEntidad(client, entityId),
      userId,
      action: 'close',
      entityType: 'fiscal_period',
      entityId: periodId,
      oldValues: { status: 'open' },
      newValues: { status },
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
    throw new AccountingError('TENANT_NO_RESUELTO', `No se pudo determinar el inquilino de ${entityId}.`);
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
    if (period.status === 'open') {
      throw new AccountingError(
        'PERIOD_ALREADY_OPEN',
        `${period.period_name} is already open.`
      );
    }
    if (period.status !== 'future') {
      throw new AccountingError(
        'PERIOD_NOT_FUTURE',
        `${period.period_name} is '${period.status}', not 'future'. ` +
          'Only a future period can be opened; reopening a closed period is a separate, audited operation.'
      );
    }

    const updated = await client.query<FiscalPeriod>(
      `UPDATE fiscal_periods SET status = 'open', updated_at = NOW()
       WHERE id = $1 AND entity_id = $2 AND status = 'future'
       RETURNING *`,
      [periodId, entityId]
    );

    await client.query(
      `INSERT INTO audit_log (id, user_id, tenant_id, action, entity_type, entity_id, old_values, new_values, reason)
       VALUES (uuid_generate_v4(), $1,
               COALESCE($2::uuid, (SELECT tenant_id FROM legal_entities WHERE id = $3)),
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

export interface EnsureFiscalYearResult {
  created: boolean;
  fiscalYearId: string;
  yearNumber: number;
  periods: number;
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
 * `is_calendar_year` is true and there are exactly twelve regular periods:
 * a 52-53 week or 4-4-5 calendar, and the 13th adjustment period, are
 * different shapes with their own rules and are not invented here.
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

  const fiscalYearId = await withTransaction(async (client) => {
    const fy = await client.query<{ id: string }>(
      `INSERT INTO fiscal_years (entity_id, year_number, start_date, end_date, is_calendar_year, status)
       VALUES ($1, $2, $3, $4, true, 'open') RETURNING id`,
      [entityId, yearNumber, `${yearNumber}-01-01`, `${yearNumber}-12-31`]
    );

    for (let m = 1; m <= 12; m++) {
      const start = new Date(Date.UTC(yearNumber, m - 1, 1));
      const end = new Date(Date.UTC(yearNumber, m, 0));
      // Months already over, and the month we are living in, start open; the
      // rest start 'future' and are opened deliberately with `period open`.
      const isCurrentMonth = yearNumber === now.getFullYear() && m - 1 === now.getMonth();
      const status = end < now || isCurrentMonth ? 'open' : 'future';
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
    return fy.rows[0].id;
  });

  return { created: true, fiscalYearId, yearNumber, periods: 12 };
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
