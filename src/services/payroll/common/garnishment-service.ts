import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction, query } from '../../../database/connection.js';
import { requireByIdInScope, type EntityScope } from '../../../database/scope.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../utils/errors.js';
import { reciboEnEntidad } from './alcance-nomina.js';
import {
  RANK,
  type AmountType,
  type GarnishmentType,
} from '../usa/garnishments/garnishment-engine.js';

// ============================================================
// GARNISHMENT ORDERS — the first writer `garnishments` has ever had
//
// The table is read by the payslip, by the deduction lines and by the whole
// CCPA cascade, and until this file existed no path in `src/` could put a row
// in it. Migration 075's header says what that meant in practice: whoever
// filed an order did it by hand SQL following the column comment, which was
// precisely the path that withheld zero.
//
// THE FILE LIVES IN `common/` AND NOT IN `usa/garnishments/`. The ENGINE is
// US-only, but the TABLE is not: 075's CHECK admits `pension_alimenticia`, and
// a Mexican court order is a fact a firm has to be able to hold even while
// nothing computes it. Importing the engine's vocabulary from here is already
// the tree's own shape (paycheck-service.ts:7 does it), and it is deliberate:
// the seven type names and the three amount names come from the engine's
// exported unions rather than being retyped. A third copy of that vocabulary
// is exactly how 075 happened.
//
// ── FOUR DECISIONS THAT ARE NOT STYLE ───────────────────────────────────
//
// THE FIRST · THE COLUMN LIST, AND ITS OMISSIONS.
//
//   · `id` is omitted: DEFAULT uuid_generate_v4() (008_payroll.sql:425).
//   · `tenant_id` is omitted because it is DERIVED, not a caller's datum. The
//     trigger `garnishments_hereda_inquilino` (077:251) runs
//     `NEW.tenant_id := derivado` (077:185) and overwrites anything sent, so
//     listing the column would be the writer claiming an ownership it does
//     not decide.
//   · `total_paid` is omitted: DEFAULT 0, and it must stay DERIVED. The
//     cumulative already exists — `paycheck_deductions.garnishment_id` is
//     written on every withholding (paycheck-service.ts:611-619) — and a
//     second, writable copy of a number recorded elsewhere is an invitation
//     for the two to diverge.
//   · `is_active` is written EXPLICITLY rather than left to the DEFAULT. The
//     column is nullable (008:441) and the engine filters `is_active = true`
//     (garnishment-engine.ts:164), so a NULL is an order that exists on paper
//     and withholds nothing — the same silent zero 075 exists over. 084
//     deliberately does NOT restrict the column (its header says why), so this
//     explicit write is the guard, not a courtesy.
//
// Four columns get no flag and no value on purpose, each for the same reason:
// `max_withholding_pct`, `total_owed`, `end_date` and
// `payee_bank_account_encrypted` have NO reader anywhere in `src/`. Publishing
// a cap that does not cap, an end date the engine never filters on, or a
// ceiling nothing consults would be decorative surface — the exact shape of
// lie 075 closed on the columns next door. `end_date` IS written, but only by
// `archiveGarnishment`, and only as the historical date of the archival
// alongside the `is_active` that actually stops the money.
//
// THE SECOND · THE CLI VOCABULARY IS THE PERSISTED VOCABULARY, AND THE AMOUNT
// IS THREE FLAGS. `--amount`, `--percent-disposable` and `--percent-gross` map
// one-to-one onto `amount_type`, and exactly one is required. 075's header
// MEASURED why a single `--percent` cannot be honest: the same 25 % order over
// 2,000 disposable earnings withholds 500 under one spelling and 0 under the
// other, and one flag cannot say which. Zero or two amount flags is a refusal,
// never a default: a defaulted basis is how the defect re-enters.
//
// THE THIRD · FAIL CLOSED ON THE CCPA INPUTS. `metadata` is the engine's only
// channel for its caps and every absence is coerced silently (see 084's
// header for the measured consequences). So a levy REQUIRES its exemption and
// a support order REQUIRES both cap answers, explicitly, and a levy REFUSES
// the three amount flags — for a levy the engine never reads `desired`
// (:223-226), so accepting a flag that changes no money is the same class of
// lie. A levy is stored as `amount_type='fixed', amount_value=0`, which is
// already the repo's own encoding (tests/payroll/usa/garnishments.spec.ts:103).
//
// THE FOURTH · THE ENTITY BOUNDARY DOES NOT COME FROM THE GENERIC HELPER.
// `garnishments` gained a `tenant_id` in 077 and has no `entity_id`, so
// `columnaDeAlcance` (scope.ts:75-76) resolves it to `tenant_id` and
// `requireByIdInScope('garnishments', …)` would emit `tenant_id = $2`
// (scope.ts:167-170) — TENANT scope. Two legal entities of one tenant would
// reach each other's court orders, which scope.ts:28-31 names as exactly the
// axis RLS does not defend. The boundary comes from `employees.entity_id`
// INSIDE each statement, through `reciboEnEntidad`, the predicate that already
// exists for this jump and whose every hop is pinned key-by-key by a criterion.
//
// ── WHY `record` READS THE EMPLOYEE BEFORE IT WRITES ────────────────────
//
// The country refusal cannot be a rowCount of zero. `scope.ts` makes zero rows
// deliberately indistinguishable from «not yours» (:20-22, :152-163), so an
// `AND e.country_code = 'US'` folded into the INSERT's WHERE would answer a
// Mexican order with a bare 404 and the operator would never learn why.
//
// So the employee is resolved WITHIN SCOPE first, in the same transaction, and
// the country refusal is thrown with its own sentence. That is not the
// check-then-write window `condicionDeAlcance` exists to close: the INSERT
// still carries the entity predicate in its own SQL and still checks its
// rowCount, so nothing about the write's safety depends on the prior read. The
// read exists only to produce a legible refusal.
//
// ── WHAT IS LEFT OUT, NAMED SO THE NEXT READER DOES NOT ASSUME ──────────
//
// THE >100 % AGGREGATE. There is no ceiling ACROSS order families: the levy
// branch takes `disposable - exempt` against no shared counter (engine :225)
// while child support is capped independently against its own counter
// (:207, :219-222), and the two are summed (:240). MEASURED BY READING on
// 2,000 disposable with an exemption of 200: the levy takes 1,800, a support
// order takes up to 1,200, total 3,000 — and paycheck-service.ts:519 adds that
// into `totalPostTax` while :525-531 computes net pay by subtraction with no
// clamp. Filing a second order is what makes that reachable, so this file is
// what makes it reachable. It stays out because implementing the aggregate
// correctly means choosing WHICH order loses, and the figures that would
// decide it are CCPA Title III hard-coded in the engine — which
// docs/investigacion/2026-09-06-normas-y-motores/motores/nomina-us.md already
// classifies as law that belongs in a dated table. Fixing it here would be
// inventing a cap in the same file that refuses to invent one for Mexico. What
// this file does instead is SHOW the cascade being joined: `recordGarnishment`
// returns the employee's other live orders, and the leaf prints them.
// ============================================================

const AMOUNT_RE = /^\d+(\.\d+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The seven names 075's CHECK admits, derived from the engine's own union. */
export const GARNISHMENT_TYPES: readonly GarnishmentType[] = Object.keys(
  RANK
) as GarnishmentType[];

/** The types whose caps the engine reads out of `metadata`, and what it needs. */
const LEVY_TYPES: readonly GarnishmentType[] = ['tax_levy_federal', 'tax_levy_state'];
const SUPPORT_TYPES: readonly GarnishmentType[] = ['child_support', 'pension_alimenticia'];

export interface GarnishmentOrderInput {
  employee_id: string;
  type?: string;
  /** Exactly one of the three, except on a levy, which refuses all three. */
  amount?: string;
  percent_disposable?: string;
  percent_gross?: string;
  priority?: number;
  case_number?: string;
  issuing_authority?: string;
  payee_name?: string;
  start_date?: string;
  /** IRS Pub 1494, required on a levy. Stored as a JSON string, as the tree already persists it. */
  exempt_amount?: string;
  /** `yes` / `no`, both required on a support order. No default. */
  supports_second_family?: string;
  arrears_over_12_weeks?: string;
}

export interface PreparedGarnishment {
  garnishment_type: GarnishmentType;
  amount_type: AmountType;
  amount_value: string;
  priority: number;
  case_number: string | null;
  issuing_authority: string;
  payee_name: string | null;
  start_date: string;
  metadata: Record<string, string | boolean>;
}

export interface GarnishmentRow {
  id: string;
  employee_id: string;
  employee_number: string;
  garnishment_type: string;
  rank: number;
  priority: number;
  amount_type: string;
  amount_value: string;
  case_number: string | null;
  issuing_authority: string | null;
  payee_name: string | null;
  start_date: string;
  end_date: string | null;
  is_active: boolean | null;
}

export interface RecordedGarnishment {
  id: string;
  order: PreparedGarnishment;
  /** The orders this one joins, in the sequence money is actually taken. */
  cascade: GarnishmentRow[];
}

/**
 * A `yes`/`no` answer that has NO default.
 *
 * The same shape `asset create --capitalized` uses, and for the same reason:
 * the absence of these two answers is what silently moves a support order's
 * ceiling from 50 % to 60 % of disposable earnings. «I did not say» and «no»
 * have to be different words, or the defect comes back through the help text.
 */
export function requireYesNo(flag: string, value: string | undefined, why: string): boolean {
  const v = (value ?? '').trim().toLowerCase();
  if (v === 'yes' || v === 'y') return true;
  if (v === 'no' || v === 'n') return false;
  throw new ValidationError(
    `${flag} must be answered yes or no and has no default: ${why}`
  );
}

function requireAmount(flag: string, value: string): string {
  const clean = value.trim().replace(/,/g, '');
  if (!AMOUNT_RE.test(clean)) {
    throw new ValidationError(`${flag} must be an unsigned decimal amount; got "${value}".`);
  }
  return new Decimal(clean).toFixed(4);
}

function requirePercent(flag: string, value: string): string {
  const amount = requireAmount(flag, value);
  const n = new Decimal(amount);
  if (n.lessThanOrEqualTo(0) || n.greaterThan(100)) {
    throw new ValidationError(
      `${flag} is a percentage and must fall in (0, 100]; got "${value}".`
    );
  }
  return amount;
}

/**
 * The type, from the vocabulary the COLUMN documents and 075's CHECK enforces.
 *
 * Validated here so a typo comes back as a sentence instead of a 23514 naming
 * a constraint, and so the seven names are read from the engine's union rather
 * than written down a third time.
 */
export function requireGarnishmentType(value: string | undefined): GarnishmentType {
  const v = (value ?? '').trim();
  if (!(GARNISHMENT_TYPES as string[]).includes(v)) {
    throw new ValidationError(
      `--type "${value ?? ''}" is not one of the seven the column admits: ` +
        `${GARNISHMENT_TYPES.join(', ')}.`
    );
  }
  return v as GarnishmentType;
}

/**
 * THE MEXICAN ORDER IS REFUSED, AND THE REFUSAL SAYS WHY — accurately.
 *
 * Two facts, and neither is the one an audit comment on #113 guessed. The
 * engine DOES admit `pension_alimenticia`: it is in the `GarnishmentType`
 * union (garnishment-engine.ts:70) and `behaviourOf` maps it to child support
 * (:86). What makes a Mexican order a silent zero is the country gate around
 * the call: `calculateGarnishments` runs only inside
 * `if (emp.country_code === 'US')` (paycheck-service.ts:493, call at :500), so
 * an order filed against a Mexican employee changes no paycheck, with no throw
 * and no warning.
 *
 * And lifting that gate would not help, because the arithmetic behind it is
 * not Mexican law: the caps `behaviourOf` routes to are `ccpaChildSupportCap`
 * 50/55/60/65 % (:50-53) and the creditor ceiling of 25 % or the excess over
 * 30 × 7.25 USD (:197-198) — CCPA Title III, not LFT art. 110. There is no
 * Mexican garnishment ceiling anywhere in a dated table: legal-parameters-seed
 * carries eight MX keys and none of them is one, and the corpus records the
 * gap in writing. Applying US percentages to a Mexican judge's order would be
 * inventing a cap, in the same file that refuses a levy for lacking its Pub
 * 1494 exemption.
 *
 * So the writer refuses at BOTH doors — the type and the employee's country —
 * and nothing is removed from the engine or the CHECK: rows may already exist,
 * and taking away a behaviour that exists is what 075 explicitly declined to
 * do with `bankruptcy`.
 */
export function refuseOrderWithoutAnEngine(type: GarnishmentType, countryCode: string): void {
  if (type === 'pension_alimenticia') {
    throw new ValidationError(
      'A Mexican maintenance order (pension_alimenticia) cannot be filed here yet. The engine ' +
        'would treat it as child support and apply the CCPA Title III caps (50/55/60/65 % of ' +
        'disposable earnings), which are US statute hard-coded in the engine, not LFT art. 110 ' +
        'in a dated table — and no Mexican garnishment ceiling exists in legal_parameters. ' +
        'Recording the order would produce a row that withholds nothing and a promise the ' +
        'system cannot keep.'
    );
  }
  if (countryCode !== 'US') {
    throw new ValidationError(
      `This employee's country_code is "${countryCode}", and the garnishment cascade runs only ` +
        'for US employees: paycheck-service.ts calls calculateGarnishments inside a ' +
        "`country_code === 'US'` gate, so an order filed here would change no paycheck, " +
        'silently. Filing it would be minting a supported front door onto the exact silent zero ' +
        'migration 075 exists over.'
    );
  }
}

/**
 * THE AMOUNT, WHICH IS THREE FLAGS AND EXACTLY ONE ANSWER.
 *
 * On a levy it is none of the three: the engine's levy branch never reads
 * `desired`, so a flag there would be a number that changes no money.
 */
export function resolveAmount(
  type: GarnishmentType,
  input: GarnishmentOrderInput
): { amount_type: AmountType; amount_value: string } {
  const given = [
    input.amount === undefined ? null : '--amount',
    input.percent_disposable === undefined ? null : '--percent-disposable',
    input.percent_gross === undefined ? null : '--percent-gross',
  ].filter((f): f is string => f !== null);

  if (LEVY_TYPES.includes(type)) {
    if (given.length > 0) {
      throw new ValidationError(
        `A ${type} order takes no amount flag: ${given.join(', ')} would be stored and never ` +
          'read. What a levy withholds is disposable earnings minus the Pub 1494 exemption, ' +
          'which is --exempt-amount. The order is stored as fixed 0 so the number on file is ' +
          'the number the engine uses.'
      );
    }
    return { amount_type: 'fixed', amount_value: '0.0000' };
  }

  if (given.length === 0) {
    throw new ValidationError(
      'An order needs exactly one of --amount, --percent-disposable or --percent-gross, and ' +
        'there is no default. A percentage of DISPOSABLE earnings and a percentage of GROSS ' +
        'wages are different money on the same order: migration 075 measured a 25 % order over ' +
        '2,000 disposable withholding 500 under one spelling and 0 under the other.'
    );
  }
  if (given.length > 1) {
    throw new ValidationError(
      `An order has one amount basis, and ${given.join(' and ')} were both given. Pick the one ` +
        'the court wrote.'
    );
  }

  if (input.amount !== undefined) {
    const value = requireAmount('--amount', input.amount);
    if (new Decimal(value).lessThanOrEqualTo(0)) {
      throw new ValidationError('--amount must be greater than zero: an order for nothing is not an order.');
    }
    return { amount_type: 'fixed', amount_value: value };
  }
  if (input.percent_disposable !== undefined) {
    return {
      amount_type: 'percent_disposable',
      amount_value: requirePercent('--percent-disposable', input.percent_disposable),
    };
  }
  return {
    amount_type: 'percent_gross',
    amount_value: requirePercent('--percent-gross', input.percent_gross as string),
  };
}

/**
 * THE CCPA INPUTS, OR A REFUSAL THAT NAMES THE CONSEQUENCE.
 *
 * The message matters more than the throw: this is the only place an
 * accountant learns the difference between «I forgot» and «I declared zero»,
 * and the difference is the whole cheque.
 */
export function resolveCcpaMetadata(
  type: GarnishmentType,
  input: GarnishmentOrderInput
): Record<string, string | boolean> {
  if (LEVY_TYPES.includes(type)) {
    if (input.exempt_amount === undefined) {
      throw new ValidationError(
        `A ${type} order requires --exempt-amount, the figure the IRS Pub 1494 table gives for ` +
          "this worker's filing status, dependents and pay frequency. Without it the engine " +
          'reads zero and withholds 100 % of disposable earnings, with no cap shown on the ' +
          'payslip. There is no default, because the default is the whole cheque.'
      );
    }
    // Stored as a STRING, which is what the tree already persists and what the
    // engine reads back with `->>` plus parseFloat.
    return { exempt_amount: requireAmount('--exempt-amount', input.exempt_amount) };
  }

  if (SUPPORT_TYPES.includes(type)) {
    return {
      supports_second_family: requireYesNo(
        '--supports-second-family',
        input.supports_second_family,
        'whether this worker supports another spouse or child decides a CCPA ceiling of 50 % ' +
          'or 60 % of disposable earnings, and an unanswered question is read as «no», which is ' +
          'the more expensive of the two by ten points'
      ),
      arrears_over_12_weeks: requireYesNo(
        '--arrears-12wk',
        input.arrears_over_12_weeks,
        'arrears more than twelve weeks old add five points to the CCPA ceiling, and an ' +
          'unanswered question is read as «no»'
      ),
    };
  }

  if (input.exempt_amount !== undefined) {
    throw new ValidationError(
      `--exempt-amount is the IRS Pub 1494 figure of a tax levy; a ${type} order has no use ` +
        'for it and the engine would never read it.'
    );
  }
  return {};
}

/** Everything the writer refuses, with no database in sight. */
export function prepareGarnishment(input: GarnishmentOrderInput): PreparedGarnishment {
  const type = requireGarnishmentType(input.type);
  const { amount_type, amount_value } = resolveAmount(type, input);
  const metadata = resolveCcpaMetadata(type, input);

  const authority = (input.issuing_authority ?? '').trim();
  if (authority === '') {
    throw new ValidationError(
      '--court is required: an order that reduces a person\'s pay every period has to say which ' +
        'authority dictated it. `issuing_authority` is merely nullable, so nothing but this ' +
        'refusal stops an order from being filed with no source.'
    );
  }

  const start = (input.start_date ?? '').trim();
  const parsed = new Date(`${start}T00:00:00Z`);
  if (!DATE_RE.test(start) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== start) {
    throw new ValidationError(
      `--start must be a real date in YYYY-MM-DD form; got "${input.start_date ?? ''}". ` +
        'It is required because `start_date` is NOT NULL — but withholding begins when the ' +
        'order is ACTIVE, not on this date: the engine filters on is_active and uses start_date ' +
        'only to break ties within a statutory rank.'
    );
  }

  const priority = input.priority ?? 100;
  if (!Number.isSafeInteger(priority) || priority < 0) {
    throw new ValidationError(`--priority must be a whole number of 0 or more; got "${priority}".`);
  }

  return {
    garnishment_type: type,
    amount_type,
    amount_value,
    priority,
    case_number: input.case_number?.trim() || null,
    issuing_authority: authority,
    payee_name: input.payee_name?.trim() || null,
    start_date: start,
    metadata,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * THE WORKER, BY ID OR BY THE NUMBER THAT IS ON HIS PAYSLIP — and in scope.
 *
 * `employees` DOES carry `entity_id` (008:14), so the generic helper is
 * correct here and is used: it emits `entity_id = $2` inside the SQL and
 * answers 404 for a worker of the sister company, indistinguishable from one
 * that does not exist. That is the whole reason this lookup does not hand-roll
 * a predicate — the trap is on `garnishments`, which has no such column, not
 * on this table.
 */
export async function requireEmployeeInScope(
  reference: string,
  scope: EntityScope,
  opts: { client?: pg.PoolClient } = {}
): Promise<{ id: string; country_code: string }> {
  return requireByIdInScope<{ id: string; country_code: string }>(
    'employees',
    reference,
    scope,
    {
      ...opts,
      columns: 'id, country_code',
      idColumn: UUID_RE.test(reference) ? 'id' : 'employee_number',
    }
  );
}

/** The cascade order the engine actually uses, derived from its own table. */
const CASCADE_ORDER = `CASE g.garnishment_type ${Object.entries(RANK)
  .map(([type, rank]) => `WHEN '${type}' THEN ${rank}`)
  .join(' ')} ELSE 99 END`;

const LIST_COLUMNS = `g.id,
          g.employee_id,
          e.employee_number,
          g.garnishment_type,
          ${CASCADE_ORDER} AS rank,
          g.priority,
          g.amount_type,
          g.amount_value,
          g.case_number,
          g.issuing_authority,
          g.payee_name,
          g.start_date,
          g.end_date,
          g.is_active`;

async function liveOrdersOf(
  employeeId: string,
  scope: EntityScope,
  client: pg.PoolClient
): Promise<GarnishmentRow[]> {
  const r = await client.query<GarnishmentRow>(
    `SELECT ${LIST_COLUMNS}
       FROM garnishments g
       JOIN employees e ON e.id = g.employee_id
      WHERE g.employee_id = $1
        AND g.is_active
        AND ${reciboEnEntidad('g.employee_id', 2)}
      ORDER BY ${CASCADE_ORDER}, g.priority ASC, g.start_date ASC`,
    [employeeId, scope.entityId]
  );
  return r.rows;
}

/**
 * FILE AN ORDER. The single `INSERT INTO garnishments` of this repository.
 *
 * `opts.client` is how `--dry-run` rehearses the real path: the leaf opens a
 * transaction, calls this, and aborts it. What gets printed then comes out of
 * the same code that would write, refusals included — the alternative is a
 * second implementation of the filing living in the presentation layer.
 */
export async function recordGarnishment(
  input: GarnishmentOrderInput,
  scope: EntityScope,
  opts: { client?: pg.PoolClient } = {}
): Promise<RecordedGarnishment> {
  const order = prepareGarnishment(input);

  const run = async (client: pg.PoolClient): Promise<RecordedGarnishment> => {
    // Resolved within scope FIRST, so the country refusal can be a sentence
    // instead of a rowCount of zero. The write below does not lean on this
    // read for its boundary: it carries its own.
    const employee = await requireEmployeeInScope(input.employee_id, scope, { client });
    refuseOrderWithoutAnEngine(order.garnishment_type, employee.country_code);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO garnishments (
         employee_id, garnishment_type, priority, amount_type, amount_value,
         case_number, issuing_authority, payee_name, start_date, is_active, metadata
       )
       SELECT e.id, $2, $3, $4, $5, $6, $7, $8, $9, true, $10::jsonb
         FROM employees e
        WHERE e.id = $1 AND ${reciboEnEntidad('e.id', 11)}
       RETURNING id`,
      [
        employee.id,
        order.garnishment_type,
        order.priority,
        order.amount_type,
        order.amount_value,
        order.case_number,
        order.issuing_authority,
        order.payee_name,
        order.start_date,
        JSON.stringify(order.metadata),
        scope.entityId,
      ]
    );
    if (inserted.rowCount === 0) throw new NotFoundError('Employee', input.employee_id);

    return {
      id: inserted.rows[0].id,
      order,
      cascade: await liveOrdersOf(employee.id, scope, client),
    };
  };

  return opts.client ? run(opts.client) : withTransaction(run);
}

export interface GarnishmentListFilters {
  employee_id?: string;
  type?: string;
  /** Archived orders too. Without it only the live ones are listed. */
  all?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * THE ORDERS, IN THE SEQUENCE MONEY IS ACTUALLY TAKEN.
 *
 * Sorted by the engine's statutory rank first and only then by `priority` and
 * `start_date`, because that is what the engine does (garnishment-engine.ts:194)
 * and a list sorted by `priority` alone would show a creditor with priority 1
 * ahead of a support order with 100 — the reverse of what payday will do.
 * The rank expression is built from the engine's own exported table, so the
 * two cannot drift.
 */
export async function listGarnishments(
  scope: EntityScope,
  filters: GarnishmentListFilters = {}
): Promise<GarnishmentRow[]> {
  const where: string[] = [reciboEnEntidad('g.employee_id', 1)];
  const values: unknown[] = [scope.entityId];

  if (filters.employee_id) {
    // Resolved through the same scoped helper the writer uses, so naming the
    // sister company's worker answers 404 instead of an empty list — an empty
    // list would read as «that worker has no orders», which is a different and
    // reassuring lie.
    const employee = await requireEmployeeInScope(filters.employee_id, scope);
    values.push(employee.id);
    where.push(`g.employee_id = $${values.length}`);
  }
  if (filters.type) {
    values.push(requireGarnishmentType(filters.type));
    where.push(`g.garnishment_type = $${values.length}`);
  }
  if (!filters.all) where.push('g.is_active');

  values.push(Math.min(filters.limit ?? 50, 500));
  const limit = `$${values.length}`;
  values.push(filters.offset ?? 0);
  const offset = `$${values.length}`;

  const r = await query<GarnishmentRow>(
    `SELECT ${LIST_COLUMNS}
       FROM garnishments g
       JOIN employees e ON e.id = g.employee_id
      WHERE ${where.join(' AND ')}
      ORDER BY ${CASCADE_ORDER}, g.priority ASC, g.start_date ASC
      LIMIT ${limit} OFFSET ${offset}`,
    values
  );
  return r.rows;
}

export interface ArchivedGarnishment {
  id: string;
  employee_id: string;
  garnishment_type: string;
  case_number: string | null;
  end_date: string | null;
}

/**
 * STOP THE WITHHOLDING. It is `is_active`, and it is only `is_active`.
 *
 * The catalog row promises that archiving «detiene la retención», and there is
 * exactly one way to keep that promise: the engine's order query filters
 * `is_active = true` and nothing else (garnishment-engine.ts:164). `end_date`
 * has no reader anywhere in `src/`, so an archive that wrote only the date
 * would stop nothing and the order would keep withholding forever. `--as-of`
 * is therefore recorded ALONGSIDE the flag, as the historical date of the
 * archival, never instead of it.
 *
 * Guarded the way invariant 3 requires: a state predicate in the WHERE, the
 * entity boundary in the same statement, and a rowCount check after. When it
 * touches nothing the reason is looked up rather than guessed, because
 * «already archived» and «not yours» deserve different sentences — and looking
 * after a write that did not happen opens no window.
 */
export async function archiveGarnishment(
  id: string,
  scope: EntityScope,
  opts: { asOf?: string } = {}
): Promise<ArchivedGarnishment> {
  const updated = await query<ArchivedGarnishment>(
    `UPDATE garnishments g
        SET is_active = false,
            end_date = COALESCE($2::date, g.end_date)
      WHERE g.id = $1
        AND g.is_active
        AND ${reciboEnEntidad('g.employee_id', 3)}
      RETURNING g.id, g.employee_id, g.garnishment_type, g.case_number, g.end_date`,
    [id, opts.asOf ?? null, scope.entityId]
  );
  if (updated.rowCount === 0) {
    const existing = await query<{ is_active: boolean | null }>(
      `SELECT g.is_active
         FROM garnishments g
        WHERE g.id = $1 AND ${reciboEnEntidad('g.employee_id', 2)}`,
      [id, scope.entityId]
    );
    if (existing.rows.length > 0) {
      throw new ConflictError(
        `Garnishment ${id} is already archived: it stopped withholding when is_active was ` +
          'cleared, and archiving it again would report a halt that did not happen.'
      );
    }
    throw new NotFoundError('Garnishment', id);
  }
  return updated.rows[0];
}
