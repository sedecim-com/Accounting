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
// decision:
//
//   THE FIGURES COME FROM THE LEDGER, NEVER FROM THE RUN'S BOOKKEEPING.
//
// The conductor's step rows say what the conductor did. A dossier built out of
// them would be a report about a program's memory, and a third party who
// re-ran it would be checking that the program still remembers. So the
// dossier reads the ledger, with the query the trial balance already uses on
// all three surfaces, and the third party who re-runs it is asking the books.
//
// ── WHAT IS SEALED, AND WHAT DELIBERATELY IS NOT ────────────────────────
//
// Sealed: the entity, the period, the as-of date, the criteria that shaped the
// figures, and the figures. Not sealed: when it was generated, by whom, with
// which run, and the period's status. If `generated_at` were inside the seal,
// re-running the dossier one minute later would produce a different seal, and
// "the same figures" would be unverifiable BY CONSTRUCTION. The envelope is
// history; the sealed body is the claim.
//
// ── A SEAL IS NOT A SIGNATURE ───────────────────────────────────────────
//
// The seal is an UNKEYED SHA-256, and that is on purpose: a third party must
// be able to recompute it. The price is that anyone can also edit a dossier
// and recompute it. So a seal matching its body proves only that the file
// agrees with itself; whether THESE BOOKS ISSUED it is a separate question,
// answered by the append-only `closing_packs` registry. `verify` asks both.
//
// ── THE WAYS A DOSSIER STOPS BEING REPRODUCIBLE, AND WHAT GUARDS EACH ───
//
//   1. THE CLOCK. `as_of` is the period's end date, taken from the period row.
//      Criterion `closing-dossier-seals-the-books-not-the-clock`.
//   2. THE ORDER. Rows are sorted HERE, by code unit, before sealing — not
//      left to the database's collation, which can differ between the
//      machine that sealed and the machine that verifies. Criterion
//      `closing-dossier-reads-the-posted-ledger-in-order`.
//   3. DRAFTS. Only posted entries. Same criterion.
//   4. ACCOUNTS THAT NEVER MOVED. The trial balance keeps zero-activity
//      accounts on purpose (a report that hides them hides the accounts
//      someone forgot to use), but an account created in September with
//      nothing in it is not a figure of July. The dossier seals only accounts
//      with something at the cut-off, and compares them BY CODE, so adding or
//      archiving an empty account neither breaks an old dossier nor shifts
//      the blame onto the accounts after it. Same criterion.
//   5. THE PANEL. `informes_asientos_de_cierre` and
//      `informes_cuentas_archivadas` change what the trial balance SHOWS. They
//      are read and SEALED, and a verification under a different panel says
//      so as its own finding instead of dressing it up as a moved figure.
//
// ── WHAT THIS DOES NOT GUARANTEE, SAID HERE ─────────────────────────────
//
// The derivation is not one database snapshot: the criteria, the trial balance
// and the period activity are separate queries, and `queryTrialBalanceRows`
// reads the panel again inside. A posting that lands between them can seal a
// body whose parts describe two instants. It cannot pass unnoticed: the next
// verification compares every part with the books of THAT moment and reports
// the part that disagrees. Making it one snapshot means threading a client
// through the shared report service, which is its own change.
// ============================================================

export const CLOSING_PACK_SCHEMA_VERSION = 1;

/** The money scale of this house: four decimals, as strings, never a float. */
const SCALE = 4;

const money = (v: string | number | null | undefined): string =>
  new Decimal(v ?? 0).toFixed(SCALE);

/** Code-unit order: the same on every machine, whatever its collation. */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  /** Cumulative to the cut-off, posted only, accounts with movement, ordered by code. */
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
  /** The period, without its status: see the envelope. */
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
  /** The status of the period when it was sealed. Context, not claim. */
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
 * Arrays are NOT sorted here: their order is meaning, and `deriveSealedBody`
 * fixes it explicitly before anything is sealed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => byCodeUnit(a, b));
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
 * engine this house spends its criteria preventing.
 */
export async function deriveSealedBody(entityId: string, periodId: string): Promise<SealedBody> {
  const e = await query<EntityRow>(
    'SELECT id, name, tax_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  if (e.rows.length === 0) throw new NotFoundError('Entity', entityId);

  const p = await query<PeriodRow>(
    `SELECT id, period_name, start_date::text, end_date::text, status
       FROM fiscal_periods WHERE id = $1 AND entity_id = $2`,
    [periodId, entityId]
  );
  if (p.rows.length === 0) throw new NotFoundError('Fiscal period', periodId);
  const periodo = p.rows[0];

  // THE CUT-OFF IS THE PERIOD'S END DATE. A dossier whose cut-off moves is a
  // dossier nobody can re-run.
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
      GROUP BY COALESCE(je.source_type, 'manual')`,
    [entityId, periodId]
  );

  const trialBalance = filas
    .map((f) => ({
      account_code: f.account_code,
      account_name: f.account_name,
      account_type: f.account_type,
      debit: money(f.debit_total),
      credit: money(f.credit_total),
      balance: money(f.ending_balance),
    }))
    // AN ACCOUNT THAT NEVER MOVED IS NOT A FIGURE OF THIS MONTH (header, 4).
    .filter((f) => !new Decimal(f.debit).isZero() || !new Decimal(f.credit).isZero())
    .sort((a, b) => byCodeUnit(a.account_code, b.account_code));

  const periodActivity = actividad.rows
    .map((r) => ({
      source_type: r.source_type,
      entries: Number(r.entries),
      debit: money(r.debit),
      credit: money(r.credit),
    }))
    .sort((a, b) => byCodeUnit(a.source_type, b.source_type));

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
      trial_balance: trialBalance,
      totals: {
        debit: money(totales.total_debits),
        credit: money(totales.total_credits),
        balanced: totales.is_balanced,
      },
      period_activity: periodActivity,
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

/** Registers the dossier as issued. The table is append-only: this only ever INSERTs. */
export async function storeClosingPack(
  entityId: string,
  periodId: string,
  pack: ClosingPack
): Promise<string> {
  const r = await query<{ id: string }>(
    `INSERT INTO closing_packs
       (entity_id, fiscal_period_id, run_id, seal, body, generated_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
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

/** What a difference is about. Only `figure` means the books moved. */
export type DifferenceKind = 'figure' | 'identity' | 'criteria';

export interface PackDifference {
  kind: DifferenceKind;
  path: string;
  expected: string;
  actual: string;
}

const ABSENT = '(absent)';

function brief(v: unknown): string {
  if (v === undefined) return ABSENT;
  const s = typeof v === 'string' ? v : canonicalJson(v);
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

/** Leaf-by-leaf comparison of two plain values under one path. */
function compareLeaves(
  kind: DifferenceKind,
  expected: unknown,
  actual: unknown,
  path: string,
  out: PackDifference[]
): void {
  const objeto = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v);
  if (objeto(expected) && objeto(actual)) {
    for (const k of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort(byCodeUnit)) {
      compareLeaves(kind, expected[k], actual[k], `${path}.${k}`, out);
    }
    return;
  }
  if (canonicalJson(expected) !== canonicalJson(actual)) {
    out.push({ kind, path, expected: brief(expected), actual: brief(actual) });
  }
}

/** Rows compared BY THEIR KEY, never by position. */
function compareKeyed<T extends object>(
  expected: readonly T[],
  actual: readonly T[],
  key: keyof T & string,
  path: string,
  out: PackDifference[]
): void {
  const index = (rows: readonly T[]) =>
    new Map(rows.map((r) => [String((r as Record<string, unknown>)[key]), r]));
  const a = index(expected);
  const b = index(actual);
  for (const k of [...new Set([...a.keys(), ...b.keys()])].sort(byCodeUnit)) {
    const ea = a.get(k);
    const eb = b.get(k);
    if (ea === undefined || eb === undefined) {
      out.push({ kind: 'figure', path: `${path}[${k}]`, expected: brief(ea), actual: brief(eb) });
    } else {
      compareLeaves('figure', ea, eb, `${path}[${k}]`, out);
    }
  }
}

/**
 * What the dossier claims against what the books say now, section by section.
 *
 * Reported as paths, because "the seals differ" is a true statement that helps
 * nobody: an auditor needs the account. And classified, because a renamed
 * entity or a changed panel is not a moved figure, and saying it was would
 * send the auditor to look for an entry that does not exist.
 */
export function differences(expected: SealedBody, actual: SealedBody): PackDifference[] {
  const out: PackDifference[] = [];
  compareLeaves('identity', expected.schema_version, actual.schema_version, 'schema_version', out);
  compareLeaves('identity', expected.entity, actual.entity, 'entity', out);
  compareLeaves('identity', expected.period, actual.period, 'period', out);
  compareLeaves('identity', expected.as_of, actual.as_of, 'as_of', out);
  compareLeaves('criteria', expected.criteria, actual.criteria, 'criteria', out);
  compareKeyed(
    expected.figures?.trial_balance ?? [],
    actual.figures.trial_balance,
    'account_code',
    'figures.trial_balance',
    out
  );
  compareLeaves('figure', expected.figures?.totals, actual.figures.totals, 'figures.totals', out);
  compareKeyed(
    expected.figures?.period_activity ?? [],
    actual.figures.period_activity,
    'source_type',
    'figures.period_activity',
    out
  );
  return out;
}

export interface PackVerdict {
  /** The seal recomputed over the body AS DELIVERED matches: the file agrees with itself. */
  sealIntact: boolean;
  /** These books registered a dossier with this seal for this entity and period. */
  issued: boolean;
  /** When it was registered, if it was. */
  issuedAt: string | null;
  /** The envelope in the file is the one registered (unsealed, so a warning). */
  envelopeMatches: boolean;
  /** No figure differs from what the books say now. */
  figuresReproduce: boolean;
  /** Entity and period identity, schema and cut-off unchanged. */
  identityUnchanged: boolean;
  /** The panel still says what it said when the dossier was sealed. */
  criteriaUnchanged: boolean;
  expectedSeal: string;
  recomputedSeal: string;
  differences: PackDifference[];
}

/** The findings of a verdict, for the exit contract: blocking vs warning. */
export function verdictFindings(v: PackVerdict): { blocking: number; warning: number } {
  return {
    blocking: [v.sealIntact, v.issued, v.figuresReproduce].filter((x) => !x).length,
    warning: [v.identityUnchanged, v.criteriaUnchanged, !v.issued || v.envelopeMatches].filter(
      (x) => !x
    ).length,
  };
}

/**
 * THE ACCEPTANCE TEST, AS A FUNCTION.
 *
 * Three questions, and they are not the same one:
 *
 *   · DOES THE FILE AGREE WITH ITSELF? Re-seal the body as delivered.
 *   · DID THESE BOOKS ISSUE IT? Ask the append-only registry for that seal.
 *     A file edited and re-hashed agrees with itself and was never issued.
 *   · DO THE BOOKS STILL SAY IT? Derive again and compare, section by section.
 *
 * It never throws for what a crafted file says: a period id these books do not
 * have is a finding, reported like any other difference.
 */
export async function verifyClosingPack(pack: ClosingPack): Promise<PackVerdict> {
  const recomputedSeal = sealOf(pack.sealed);

  const registro = await query<{ generated_at: string; envelope: unknown }>(
    `SELECT generated_at::text AS generated_at, body->'envelope' AS envelope
       FROM closing_packs
      WHERE entity_id = $1 AND fiscal_period_id = $2 AND seal = $3
      ORDER BY generated_at`,
    [pack.sealed.entity.id, pack.sealed.period.id, pack.seal]
  );
  const issued = registro.rows.length > 0;
  const envelopeMatches = registro.rows.some(
    (r) => canonicalJson(r.envelope) === canonicalJson(pack.envelope)
  );

  let diffs: PackDifference[];
  try {
    const actual = await deriveSealedBody(pack.sealed.entity.id, pack.sealed.period.id);
    diffs = differences(pack.sealed, actual);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    diffs = [
      {
        kind: 'figure',
        path: 'period.id',
        expected: pack.sealed.period.id,
        actual: '(not in these books)',
      },
    ];
  }

  return {
    sealIntact: recomputedSeal === pack.seal,
    issued,
    issuedAt: registro.rows[0]?.generated_at ?? null,
    envelopeMatches,
    figuresReproduce: !diffs.some((d) => d.kind === 'figure'),
    identityUnchanged: !diffs.some((d) => d.kind === 'identity'),
    criteriaUnchanged: !diffs.some((d) => d.kind === 'criteria'),
    expectedSeal: pack.seal,
    recomputedSeal,
    differences: diffs,
  };
}

/**
 * Reads a dossier out of untrusted text and refuses anything that is not one.
 *
 * `verify` is the one command of this family that takes a file from OUTSIDE,
 * so it is the one place where "it parsed" is not the same as "it is a
 * dossier" — and where an id that is not a UUID must be refused here, before
 * it reaches Postgres as a raw cast error.
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
  if (!UUID_RE.test(String(p.sealed.entity.id)) || !UUID_RE.test(String(p.sealed.period.id))) {
    throw new Error('Not a closing pack: the entity or period id is not a UUID.');
  }
  if (!p.sealed.figures || !Array.isArray(p.sealed.figures.trial_balance)) {
    throw new Error('Not a closing pack: the sealed body carries no figures.');
  }
  if (!p.envelope || typeof p.envelope !== 'object') {
    throw new Error('Not a closing pack: no envelope.');
  }
  return p as ClosingPack;
}

/**
 * The most recently closed period of an entity — soft, hard or locked — which
 * is the month a dossier is normally asked for.
 */
export async function latestClosedPeriodOf(
  entityId: string
): Promise<{ id: string; period_name: string } | null> {
  const r = await query<{ id: string; period_name: string }>(
    `SELECT id, period_name FROM fiscal_periods
      WHERE entity_id = $1 AND status IN ('soft_close', 'hard_close', 'locked')
      ORDER BY end_date DESC, id DESC
      LIMIT 1`,
    [entityId]
  );
  return r.rows[0] ?? null;
}
