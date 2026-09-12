import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import {
  queryTrialBalanceRows,
  totalTrialBalance,
} from '../reporting/report-service.js';
import { criterioDeCierreEnInformes } from '../reporting/criterio-cierre.js';
import { criterioDeCuentasArchivadas } from '../reporting/criterio-archivadas.js';
import { NotFoundError } from '../../utils/errors.js';

// ============================================================
// A6 · THE DOSSIER, AND THE ONLY PROMISE IT MAKES
//
// The acceptance test A6 was born with: THE DOSSIER THE CONDUCTOR HANDS OVER
// HAS TO BE RE-RUNNABLE BY A THIRD PARTY AND YIELD THE SAME FIGURES. This file
// is that sentence, made executable. Everything in it follows from one
// decision and it is worth stating plainly:
//
//   THE FIGURES COME FROM THE LEDGER, NEVER FROM THE RUN'S BOOKKEEPING.
//
// The conductor's step rows say what the conductor did. They are evidence of
// an ACT. A dossier built out of them would be a report about a program's
// memory, and a third party who re-ran it would be checking that the program
// still remembers — which is not an audit of anything. So the dossier reads
// the ledger, with the same query the trial balance already uses on all three
// surfaces, and the third party who re-runs it is asking the books, not us.
//
// ── WHAT IS SEALED, AND WHAT DELIBERATELY IS NOT ────────────────────────
//
// Sealed: the entity, the period, the as-of date, the criteria that shaped the
// figures, and the figures. Not sealed: when it was generated, by whom, and
// which run produced it. That line is not a convenience — it is the whole
// design. If `generated_at` were inside the seal, re-running the dossier one
// minute later would produce a different seal, and "the same figures" would be
// unverifiable BY CONSTRUCTION. The envelope is history; the sealed body is
// the claim.
//
// ── THE FOUR WAYS A DOSSIER STOPS BEING REPRODUCIBLE ────────────────────
//
// Each of these was a real temptation while writing this file, and each one
// has a criterion in `src/plan/criterios.ts` standing over it:
//
//   1. THE CLOCK. `as_of` is the period's end date, taken from the period row.
//      A `CURRENT_DATE` anywhere in the derivation — and the trial balance
//      accepts one happily — means the dossier verifies today and drifts
//      tomorrow, silently, for the best possible reason.
//   2. THE ORDER. Two runs that return the same rows in a different order
//      canonicalize differently and seal differently. Every query that feeds
//      the seal is ordered, and the canonical form sorts object keys.
//   3. DRAFTS. Only posted entries. A dossier that counted drafts would move
//      every time somebody edited one.
//   4. THE PANEL. `informes_asientos_de_cierre` and
//      `informes_cuentas_archivadas` change what the trial balance SHOWS. They
//      are read and SEALED, so a third party verifying under a different panel
//      is told exactly that, instead of being handed different numbers with no
//      explanation.
// ============================================================

export const CLOSING_PACK_SCHEMA_VERSION = 1;

/** The money scale of this house: four decimals, as strings, never a float. */
const SCALE = 4;

const money = (v: string | number | null | undefined): string =>
  new Decimal(v ?? 0).toFixed(SCALE);

export interface PackTrialBalanceRow {
  account_code: string;
  account_name: string;
  account_type: string;
  debit: string;
  credit: string;
  balance: string;
}

export interface PackActivityRow {
  source_type: string;
  entries: number;
  debit: string;
  credit: string;
}

export interface PackFigures {
  /** Cumulative, as of the period's end date, posted only, ordered by code. */
  trial_balance: PackTrialBalanceRow[];
  totals: { debit: string; credit: string; balanced: boolean };
  /** What was posted INSIDE the period, grouped by who posted it. */
  period_activity: PackActivityRow[];
}

export interface PackCriteria {
  informes_asientos_de_cierre: string;
  informes_cuentas_archivadas: string;
}

export interface SealedBody {
  schema_version: number;
  entity: { id: string; name: string; tax_id: string | null };
  /**
   * El periodo, SIN su estado. El estado viaja en el sobre y no en el sello por
   * la misma razón que el reloj: un expediente sellado en cierre suave y
   * comprobado después del cierre duro del ejercicio acusaría una diferencia
   * en un campo que avanzó como tenía que avanzar, y un instrumento que grita
   * sin motivo se apaga. El sello es la AFIRMACIÓN —al 31 de julio, bajo estos
   * criterios, los libros decían esto—; el estado del periodo es un hecho del
   * proceso, no de las cifras.
   */
  period: { id: string; name: string; start_date: string; end_date: string };
  /** The cut-off. The period's end date, and never the clock. */
  as_of: string;
  criteria: PackCriteria;
  figures: PackFigures;
}

export interface PackEnvelope {
  generated_at: string;
  generated_by: string | null;
  run_id: string | null;
  /** El estado del periodo cuando se selló. Contexto, no afirmación. */
  period_status: string;
}

export interface ClosingPack {
  mnemosine_closing_pack: number;
  sealed: SealedBody;
  /** SHA-256 of the canonical form of `sealed`, hex, lowercase. */
  seal: string;
  envelope: PackEnvelope;
}

/**
 * Canonical JSON: object keys sorted, no whitespace, arrays in their order.
 *
 * Arrays are NOT sorted here, deliberately: their order is meaning (the trial
 * balance is ordered by account code because that is how a trial balance is
 * read), and it is the QUERY's job to fix it. Sorting here would have hidden
 * an unordered query instead of exposing it.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The seal of a sealed body. Pure: the same body always seals the same. */
export function sealOf(body: SealedBody): string {
  return createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
}

interface EntityRow {
  id: string;
  name: string;
  tax_id: string | null;
}

interface PeriodRow {
  id: string;
  period_name: string;
  start_date: string;
  end_date: string;
  status: string;
}

/**
 * THE DERIVATION, CALLED TWICE.
 *
 * `closing pack generate` calls it to write the dossier and
 * `closing pack verify` calls it to check one. It is the same function on
 * purpose: two derivations that were supposed to agree would be the third
 * engine this house spends its criteria preventing, and the day they disagreed
 * the verification would be measuring the difference between two programs
 * instead of the difference between two months.
 */
export async function deriveSealedBody(entityId: string, periodId: string): Promise<SealedBody> {
  const e = await query<EntityRow>(
    'SELECT id, name, tax_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  if (e.rows.length === 0) throw new NotFoundError(`Entity ${entityId} not found`);

  const p = await query<PeriodRow>(
    `SELECT id, period_name, start_date::text, end_date::text, status
       FROM fiscal_periods WHERE id = $1 AND entity_id = $2`,
    [periodId, entityId]
  );
  if (p.rows.length === 0) {
    throw new NotFoundError(`Fiscal period ${periodId} not found for this entity`);
  }
  const periodo = p.rows[0];

  // THE CUT-OFF IS THE PERIOD'S END DATE. Not `new Date()`, not CURRENT_DATE:
  // a dossier whose cut-off moves is a dossier nobody can re-run.
  const asOf = periodo.end_date;

  const [cierre, archivadas] = await Promise.all([
    criterioDeCierreEnInformes(entityId),
    criterioDeCuentasArchivadas(entityId),
  ]);

  const filas = await queryTrialBalanceRows(entityId, { asOfDate: asOf });
  const totales = totalTrialBalance(filas);

  const actividad = await query<{
    source_type: string;
    entries: string;
    debit: string;
    credit: string;
  }>(
    `SELECT COALESCE(je.source_type, 'manual') AS source_type,
            COUNT(DISTINCT je.id)::text        AS entries,
            COALESCE(SUM(jel.debit_amount), 0) AS debit,
            COALESCE(SUM(jel.credit_amount), 0) AS credit
       FROM journal_entries je
       JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
      WHERE je.entity_id = $1
        AND je.fiscal_period_id = $2
        AND je.status = 'posted'
      GROUP BY COALESCE(je.source_type, 'manual')
      ORDER BY COALESCE(je.source_type, 'manual')`,
    [entityId, periodId]
  );

  return {
    schema_version: CLOSING_PACK_SCHEMA_VERSION,
    entity: { id: e.rows[0].id, name: e.rows[0].name, tax_id: e.rows[0].tax_id },
    period: {
      id: periodo.id,
      name: periodo.period_name,
      start_date: periodo.start_date,
      end_date: periodo.end_date,
    },
    as_of: asOf,
    criteria: {
      informes_asientos_de_cierre: cierre.valor,
      informes_cuentas_archivadas: archivadas.valor,
    },
    figures: {
      trial_balance: filas.map((f) => ({
        account_code: f.account_code,
        account_name: f.account_name,
        account_type: f.account_type,
        debit: money(f.debit_total),
        credit: money(f.credit_total),
        balance: money(f.ending_balance),
      })),
      totals: {
        debit: money(totales.total_debits),
        credit: money(totales.total_credits),
        balanced: totales.is_balanced,
      },
      period_activity: actividad.rows.map((r) => ({
        source_type: r.source_type,
        entries: Number(r.entries),
        debit: money(r.debit),
        credit: money(r.credit),
      })),
    },
  };
}

export interface BuildPackOptions {
  runId?: string | null;
  userId?: string | null;
  /** The clock, injected. The only place in this file that is allowed one. */
  now?: Date;
}

/** Builds the dossier. The envelope carries the clock; the seal never does. */
export async function buildClosingPack(
  entityId: string,
  periodId: string,
  opts: BuildPackOptions = {}
): Promise<ClosingPack> {
  const sealed = await deriveSealedBody(entityId, periodId);
  const estado = await query<{ status: string }>(
    'SELECT status FROM fiscal_periods WHERE id = $1 AND entity_id = $2',
    [periodId, entityId]
  );
  return {
    mnemosine_closing_pack: CLOSING_PACK_SCHEMA_VERSION,
    sealed,
    seal: sealOf(sealed),
    envelope: {
      generated_at: (opts.now ?? new Date()).toISOString(),
      generated_by: opts.userId ?? null,
      run_id: opts.runId ?? null,
      period_status: estado.rows[0]?.status ?? 'unknown',
    },
  };
}

/** Persists the dossier. The table is append-only: this only ever INSERTs. */
export async function storeClosingPack(
  tenantId: string,
  entityId: string,
  periodId: string,
  pack: ClosingPack
): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO closing_packs
       (tenant_id, entity_id, fiscal_period_id, run_id, seal, body, generated_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      tenantId,
      entityId,
      periodId,
      pack.envelope.run_id,
      pack.seal,
      JSON.stringify(pack),
      pack.envelope.generated_by,
    ]
  );
  return r.rows[0].id;
}

export interface PackDifference {
  path: string;
  expected: string;
  actual: string;
}

/**
 * Field-by-field difference between what the dossier claims and what the books
 * say now. Reported as paths, because "the seals differ" is a true statement
 * that helps nobody: an auditor needs the account.
 */
export function differences(
  expected: unknown,
  actual: unknown,
  path = '',
  out: PackDifference[] = []
): PackDifference[] {
  const brief = (v: unknown): string => {
    const s = typeof v === 'object' && v !== null ? canonicalJson(v) : String(v);
    return s.length > 120 ? `${s.slice(0, 117)}...` : s;
  };

  if (Array.isArray(expected) && Array.isArray(actual)) {
    const n = Math.max(expected.length, actual.length);
    for (let i = 0; i < n; i++) {
      if (i >= expected.length) out.push({ path: `${path}[${i}]`, expected: '(absent)', actual: brief(actual[i]) });
      else if (i >= actual.length) out.push({ path: `${path}[${i}]`, expected: brief(expected[i]), actual: '(absent)' });
      else differences(expected[i], actual[i], `${path}[${i}]`, out);
    }
    return out;
  }

  const objeto = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

  if (objeto(expected) && objeto(actual)) {
    for (const k of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      differences(expected[k], actual[k], path ? `${path}.${k}` : k, out);
    }
    return out;
  }

  if (canonicalJson(expected) !== canonicalJson(actual)) {
    out.push({ path: path || '(root)', expected: brief(expected), actual: brief(actual) });
  }
  return out;
}

export interface PackVerdict {
  /** The seal recomputed over the body AS DELIVERED: false = the file was edited. */
  sealIntact: boolean;
  /** The books still yield the figures the dossier claims. */
  figuresReproduce: boolean;
  /** The panel still says what it said when the dossier was sealed. */
  criteriaUnchanged: boolean;
  expectedSeal: string;
  recomputedSeal: string;
  differences: PackDifference[];
}

/**
 * THE ACCEPTANCE TEST, AS A FUNCTION.
 *
 * Two questions, and they are not the same one:
 *
 *   · IS THE FILE THE ONE WE SIGNED? Re-seal the body as delivered. A
 *     mismatch means somebody edited the dossier — the figures may still
 *     reproduce, and it still is not our dossier.
 *   · DO THE BOOKS STILL SAY IT? Derive again and compare field by field.
 *
 * A verification that only compared seals would have answered "no" to both
 * questions with one word, and an auditor would not know which of the two had
 * happened.
 */
export async function verifyClosingPack(pack: ClosingPack): Promise<PackVerdict> {
  const recomputedSeal = sealOf(pack.sealed);
  const actual = await deriveSealedBody(pack.sealed.entity.id, pack.sealed.period.id);
  const diffs = differences(pack.sealed, actual);
  return {
    sealIntact: recomputedSeal === pack.seal,
    figuresReproduce: diffs.length === 0,
    criteriaUnchanged:
      canonicalJson(pack.sealed.criteria) === canonicalJson(actual.criteria),
    expectedSeal: pack.seal,
    recomputedSeal,
    differences: diffs,
  };
}

/**
 * Reads a dossier out of untrusted text and refuses anything that is not one.
 *
 * `verify` is the one command of this family that takes a file from OUTSIDE —
 * the third party's copy — so it is the one place where "it parsed" is not the
 * same as "it is a dossier".
 */
export function parseClosingPack(text: string): ClosingPack {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Not a closing pack: the file is not valid JSON.');
  }
  const p = parsed as Partial<ClosingPack>;
  if (typeof p?.mnemosine_closing_pack !== 'number') {
    throw new Error('Not a closing pack: no `mnemosine_closing_pack` version marker.');
  }
  if (p.mnemosine_closing_pack > CLOSING_PACK_SCHEMA_VERSION) {
    throw new Error(
      `This dossier is version ${p.mnemosine_closing_pack} and this build understands up to ` +
        `${CLOSING_PACK_SCHEMA_VERSION}. Verifying it with an older reader would compare fields it does not know about.`
    );
  }
  if (typeof p.seal !== 'string' || !/^[0-9a-f]{64}$/.test(p.seal)) {
    throw new Error('Not a closing pack: the seal is missing or is not a SHA-256.');
  }
  if (!p.sealed?.entity?.id || !p.sealed?.period?.id) {
    throw new Error('Not a closing pack: the sealed body names no entity or no period.');
  }
  return p as ClosingPack;
}
