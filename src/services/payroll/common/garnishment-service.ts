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
//     (garnishment-engine.ts:170), so a NULL is an order that exists on paper
//     and withholds nothing — the same silent zero 075 exists over. 085
//     deliberately does NOT restrict the column (its header says why), so this
//     explicit write is the guard, not a courtesy.
//
// Four columns get no flag on purpose, and the reason is not the same for all
// four — the first draft of this comment said it was, and it was wrong.
//
//   · `max_withholding_pct`, `total_owed` and `payee_bank_account_encrypted`
//     have NO reader anywhere in `src/` (measured: the only hits are
//     008_payroll.sql's own column list). Publishing a cap that does not cap
//     or a ceiling nothing consults is decorative surface — the exact shape of
//     lie 075 closed on the columns next door.
//   · `end_date` is different, and this tranche is what made it different. It
//     has no reader that DECIDES money: no query in `src/` filters, gates or
//     computes on it, and the engine's WHERE looks only at `is_active`. What
//     it now has — added here — are DISPLAY readers only: `LIST_COLUMNS`, the
//     archive's RETURNING, and the two leaves that print what they return. It is
//     written only by `archiveGarnishment`, and only as the historical date of
//     the archival alongside the `is_active` that actually stops the money.
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
// channel for its caps and every absence is coerced silently (see 085's
// header for the measured consequences). So a levy REQUIRES its exemption and
// a support order REQUIRES both cap answers, explicitly, and a levy REFUSES
// the three amount flags — for a levy the engine never reads `desired`
// (:229-232), so accepting a flag that changes no money is the same class of
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
// The SECOND pre-write read — the live orders' cap answers — is there for the
// same reason and carries the same caveat, stated rather than left implicit:
// the two refusals it feeds are about the SET of live orders, which no CHECK
// constraint can see, and two `record` calls racing each other could both pass
// them. What is NOT best-effort is the pair (employee, case number): 085's
// unique index decides that one in the database, and the 23505 it raises is
// translated below into a sentence. Where a race can only produce a refusal
// that did not fire, the cost is a cascade the operator is shown anyway; where
// it could produce a double withholding on the same case, the index is what
// answers.
//
// ── WHAT IS LEFT OUT, NAMED SO THE NEXT READER DOES NOT ASSUME ──────────
//
// THE >100 % AGGREGATE. There is no ceiling ACROSS order families: the levy
// branch takes `disposable - exempt` against no shared counter (engine :231)
// while child support is capped independently against its own counter
// (:213, :225-228), and the two are summed (:246). MEASURED BY READING on
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
 * 30 × 7.25 USD (:203-204) — CCPA Title III, not LFT art. 110. There is no
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
 *
 * AND THE TYPE DOOR IS CHECKED FIRST, ON PURPOSE, so the refusal has to be
 * true of BOTH sides of it. The first draft closed with «a row that withholds
 * nothing», which is false on the path this repository's own integration spec
 * pins: for a US employee the gate at paycheck-service.ts:493 opens,
 * `behaviourOf` returns child support, and the row WOULD withhold — under the
 * CCPA percentages three lines above. Withholding nothing is what happens on
 * the OTHER branch, the country one, which throws its own sentence. Two
 * outcomes, and the refusal now names both instead of borrowing one.
 */
export function refuseOrderWithoutAnEngine(type: GarnishmentType, countryCode: string): void {
  if (type === 'pension_alimenticia') {
    throw new ValidationError(
      'A Mexican maintenance order (pension_alimenticia) cannot be filed here yet. The engine ' +
        'would treat it as child support and apply the CCPA Title III caps (50/55/60/65 % of ' +
        'disposable earnings), which are US statute hard-coded in the engine, not LFT art. 110 ' +
        'in a dated table — and no Mexican garnishment ceiling exists in legal_parameters. ' +
        'Recording it would either withhold under a foreign statute\'s caps (a US employee, ' +
        'whose paycheck does run the cascade) or withhold nothing at all (any other country, ' +
        'where the cascade never runs), and neither of those is the order the judge wrote.'
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
 * accountant learns that «I forgot» and «I declared zero» BUY THE SAME THING,
 * and the thing is the whole cheque.
 *
 * AND THE ZERO IS REFUSED TOO, which the first draft did not do. The refusal
 * below said, correctly, that without the figure «the engine reads zero and
 * withholds 100 % of disposable earnings» — and then `requireAmount` accepted
 * `--exempt-amount 0` and stored `"0.0000"`, which the engine reads back as
 * zero and turns into exactly that outcome, byte for byte, with `cap_applied`
 * null. A fence whose gate produces the state it was built against is not a
 * fence. `--amount` has refused its own non-positive value since the first
 * draft (`an order for nothing is not an order`); this is the same sentence
 * for the flag where the stakes are inverted — there, zero withholds nothing;
 * here, zero withholds everything.
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
    const exempt = requireAmount('--exempt-amount', input.exempt_amount);
    if (new Decimal(exempt).lessThanOrEqualTo(0)) {
      throw new ValidationError(
        `--exempt-amount ${input.exempt_amount} is the same order as one with no exemption at ` +
          'all: the engine computes disposable earnings minus the exemption, so zero leaves ' +
          '100 % of the cheque withheld and `cap_applied` empty on the payslip. The IRS Pub 1494 ' +
          'table has no zero row — every filing status and pay frequency exempts something. ' +
          'Read the figure off the notice.'
      );
    }
    return { exempt_amount: exempt };
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

/**
 * The width the COLUMN declares, refused here so it comes back as a sentence.
 *
 * `case_number VARCHAR(50)`, `issuing_authority VARCHAR(200)` and
 * `payee_name VARCHAR(200)` (008:432-434). Without this a 60-character docket
 * number reaches Postgres as 22001 — «value too long for type character
 * varying(50)» — with no statusCode, which the kernel maps to the generic
 * failure: the same exit code as a lost connection, for a typo.
 */
function requireWithin(flag: string, value: string, max: number): string {
  if (value.length > max) {
    throw new ValidationError(
      `${flag} is ${value.length} characters and the column holds ${max}. Postgres would refuse ` +
        'this with a 22001 in the middle of the transaction; the order is refused here instead, ' +
        'where the message can say which flag.'
    );
  }
  return value;
}

/** Everything the writer refuses, with no database in sight. */
export function prepareGarnishment(
  input: GarnishmentOrderInput,
  opts: { today?: string } = {}
): PreparedGarnishment {
  const type = requireGarnishmentType(input.type);
  const { amount_type, amount_value } = resolveAmount(type, input);
  const metadata = resolveCcpaMetadata(type, input);

  const authority = requireWithin('--court', (input.issuing_authority ?? '').trim(), 200);
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
  // A DATE IN THE FUTURE IS REFUSED, BECAUSE NOTHING IN THE SYSTEM WAITS FOR
  // IT. The row is written `is_active = true` and the engine's only filter is
  // `is_active = true` — `start_date` is read once, to break ties within a
  // rank (the query's `ORDER BY priority ASC, start_date ASC`,
  // garnishment-engine.ts:171, under the stable sort at :200). So an order a
  // court dated for next June, filed today, takes its percentage on the very
  // NEXT pay run: nine months of someone's wages, early, with every gate green. The previous draft printed
  // that trap in the flag help and in the message above and then accepted the
  // date anyway, which is a warning, not a fence. Filing it dormant is not on
  // offer either: `is_active` is what the engine reads, so a dormant row would
  // be an order that exists and does nothing — the silent zero 075 exists
  // over. When a scheduler reads `start_date`, this refusal is what it
  // replaces.
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  if (start > today) {
    throw new ValidationError(
      `--start ${start} is in the future and nothing in this system waits for it: the order is ` +
        'filed ACTIVE, the engine filters on is_active alone, and start_date only breaks ties ' +
        `within a statutory rank. Filed today it would withhold on the next pay run, not on ` +
        `${start}. File it on or after the date it takes effect.`
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
    case_number: requireWithin('--case', input.case_number?.trim() ?? '', 50) || null,
    issuing_authority: authority,
    payee_name: requireWithin('--payee', input.payee_name?.trim() ?? '', 200) || null,
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

/** What the cascade already holds for this worker, as the CAPS the engine reads. */
interface LiveCapAnswers {
  id: string;
  garnishment_type: GarnishmentType;
  case_number: string | null;
  supports_second_family: boolean | null;
  arrears_over_12_weeks: boolean | null;
}

async function liveCapAnswersOf(
  employeeId: string,
  scope: EntityScope,
  client: pg.PoolClient
): Promise<LiveCapAnswers[]> {
  const r = await client.query<LiveCapAnswers>(
    `SELECT g.id,
            g.garnishment_type,
            g.case_number,
            (g.metadata ->> 'supports_second_family')::boolean AS supports_second_family,
            (g.metadata ->> 'arrears_over_12_weeks')::boolean  AS arrears_over_12_weeks
       FROM garnishments g
      WHERE g.employee_id = $1
        AND g.is_active
        AND ${reciboEnEntidad('g.employee_id', 2)}`,
    [employeeId, scope.entityId]
  );
  return r.rows;
}

/**
 * THE TWO THINGS THE CASCADE CANNOT COMPUTE, REFUSED BEFORE THEY ARE FILED.
 *
 * Neither is a rule about one order: both are about the SET of live orders,
 * which is why neither can be a CHECK constraint and why `record` — the only
 * thing that can make the set grow — is where they belong.
 *
 * ONE · TWO LEVIES. The engine's levy branch is `disposable - exempt` against
 * NO shared counter (garnishment-engine.ts:229-232), unlike child support
 * (:225-228) and creditor (:236), which each subtract what is already taken.
 * So a second levy does not split what is left, it takes it again: MEASURED on
 * 2,000 disposable with a 462.50 exemption filed twice, the engine returns
 * 1,537.50 + 1,537.50 = 3,075 — 153.75 % of disposable earnings, out of one
 * order family. That is NOT the >100 % aggregate this file discloses in its
 * header, which is explicitly about the sum ACROSS families; it is one branch
 * double-counting, and there is no honest number to file here.
 *
 * TWO · TWO ANSWERS TO ONE QUESTION. `supports_second_family` and
 * `arrears_over_12_weeks` are facts about the WORKER, and the schema stores
 * them per ORDER. The engine takes the MAXIMUM ceiling across the live support
 * orders (:207-213): filing a second support order answering «no» where the first
 * answered «yes» moves the FIRST order's ceiling from 50 % to 60 % — on 2,000
 * disposable, 200 more taken, on an order nobody amended. The whole reason
 * `requireYesNo` has no default is that those ten points must be said out
 * loud; letting them in through a second row would hand back what the flag
 * refuses to give away.
 *
 * Both refusals name the order already on file, so the operator can archive it
 * or correct the new one. Neither is silent, and neither invents a figure.
 */
function refuseWhatTheCascadeCannotCompute(
  order: PreparedGarnishment,
  live: LiveCapAnswers[]
): void {
  if (LEVY_TYPES.includes(order.garnishment_type)) {
    const other = live.find((o) => LEVY_TYPES.includes(o.garnishment_type));
    if (other) {
      throw new ConflictError(
        `This worker already has a live ${other.garnishment_type} order (${other.id}` +
          `${other.case_number ? `, case ${other.case_number}` : ''}), and the cascade cannot ` +
          'compute two levies at once: the engine takes disposable earnings minus each levy\'s ' +
          'own exemption, with no counter between them, so the two together withhold more than ' +
          'the whole cheque. Archive the one that no longer applies, or wait for the engine to ' +
          'gain a shared levy counter — inventing a split here would be inventing a cap.'
      );
    }
  }

  if (!SUPPORT_TYPES.includes(order.garnishment_type)) return;
  const mine = order.metadata as { supports_second_family?: boolean; arrears_over_12_weeks?: boolean };
  for (const other of live) {
    if (!SUPPORT_TYPES.includes(other.garnishment_type)) continue;
    const clashes: string[] = [];
    if (other.supports_second_family !== null && other.supports_second_family !== mine.supports_second_family) {
      clashes.push(
        `--supports-second-family (${other.id} says ${other.supports_second_family ? 'yes' : 'no'}, ` +
          `this order says ${mine.supports_second_family ? 'yes' : 'no'})`
      );
    }
    if (other.arrears_over_12_weeks !== null && other.arrears_over_12_weeks !== mine.arrears_over_12_weeks) {
      clashes.push(
        `--arrears-12wk (${other.id} says ${other.arrears_over_12_weeks ? 'yes' : 'no'}, ` +
          `this order says ${mine.arrears_over_12_weeks ? 'yes' : 'no'})`
      );
    }
    if (clashes.length > 0) {
      throw new ConflictError(
        `These two answers describe the WORKER, not the order, and they cannot disagree: ` +
          `${clashes.join(' and ')}. The engine takes the highest CCPA ceiling across a worker's ` +
          'live support orders, so filing this would raise the ceiling of the order already on ' +
          'file — ten points of disposable earnings on an order no court amended. Correct this ' +
          'order, or archive the one that carries the stale answer and refile it.'
      );
    }
  }
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
    refuseWhatTheCascadeCannotCompute(
      order,
      await liveCapAnswersOf(employee.id, scope, client)
    );

    const inserted = await client
      .query<{ id: string }>(
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
      )
      // THE 23505 IS TRANSLATED, LIKE THE 23514 IS. `requireGarnishmentType`
      // above validates in TypeScript «so a typo comes back as a sentence
      // instead of a 23514 naming a constraint» — and the first draft let 085's
      // own unique index answer a double filing with the raw driver message.
      // A pg error carries no `statusCode`, so `exitCodeFor` (kernel/index.ts)
      // falls through to the generic FAILURE: the same exit code as a lost
      // connection, for the most ordinary mistake there is. The house does
      // this everywhere else (asset-service.ts:716, vendor-service.ts:474,
      // bank-account-service.ts:649, customer-service.ts:402).
      .catch((err: unknown) => {
        const e = err as { code?: string; constraint?: string };
        if (e?.code === '23505' && e.constraint === 'ux_garnishments_case_active') {
          throw new ConflictError(
            `This worker already has a LIVE order on case ${order.case_number}. Filing it twice ` +
              'does not split the withholding, it doubles it — which is why 085 made the pair ' +
              '(employee, case number) unique while the order is active. If the court reissued ' +
              'the order, archive the one on file first; if this is a second, distinct order, ' +
              'give it its own case number.'
          );
        }
        throw err;
      });
    if (inserted.rowCount === 0) throw new NotFoundError('Employee', input.employee_id);

    return {
      id: inserted.rows[0].id,
      order,
      cascade: await liveOrdersOf(employee.id, scope, client),
    };
  };

  return opts.client ? run(opts.client) : withTransaction(run);
}

export type GarnishmentState = 'active' | 'archived';

export interface GarnishmentListFilters {
  employee_id?: string;
  type?: string;
  /**
   * The lifecycle states asked for. Empty means the default, which is LIVE
   * ONLY; both states means no predicate at all, which is what `--all` means.
   */
  states?: readonly GarnishmentState[];
  /** Archived orders too. Without it only the live ones are listed. */
  all?: boolean;
  limit?: number;
  offset?: number;
}

/**
 * THE STATE PREDICATE, AND WHY IT IS NOT A BOOLEAN.
 *
 * The first draft collapsed the state list into `all = opts.all || states
 * .includes('archived')` and the service then merely SKIPPED the predicate —
 * so `garnishment list --status archived`, which asks which orders were
 * stopped, answered with the ones still taking money, each marked
 * `active: true`. The leaf's own usage error («an order is either active or
 * archived. Use -a/--all for both») documented a distinction the query did not
 * implement.
 *
 * `IS NOT TRUE` and not `= false`, because 085 deliberately leaves the column
 * nullable and says why: a row carrying NULL withholds nothing (the engine
 * filters `is_active = true`), so it belongs with the stopped ones and not
 * with the live ones. The same reasoning puts `IS NOT FALSE` in the archive's
 * WHERE, so that row can also be normalised.
 */
function statePredicate(filters: GarnishmentListFilters): string | null {
  const states = new Set(filters.states ?? []);
  if (filters.all || (states.has('active') && states.has('archived'))) return null;
  if (states.has('archived')) return 'g.is_active IS NOT TRUE';
  return 'g.is_active';
}

/**
 * THE ORDERS, IN THE SEQUENCE MONEY IS ACTUALLY TAKEN.
 *
 * Sorted by the engine's statutory rank first and only then by `priority` and
 * `start_date`, because that is what the engine does (garnishment-engine.ts:200,
 * over the query's own `ORDER BY priority ASC, start_date ASC` at :171)
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
  const state = statePredicate(filters);
  if (state) where.push(state);

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
 * `is_active = true` and nothing else (garnishment-engine.ts:170). No reader
 * in `src/` DECIDES anything off `end_date` — this tranche added the only
 * readers it has, and every one of them merely prints it — so an archive that wrote
 * only the date would stop nothing and the order would keep withholding
 * forever. `--as-of` is therefore recorded ALONGSIDE the flag, as the
 * historical date of the archival, never instead of it.
 *
 * Guarded the way invariant 3 requires: a state predicate in the WHERE, the
 * entity boundary in the same statement, and a rowCount check after. When it
 * touches nothing the reason is looked up rather than guessed, because
 * «already archived» and «not yours» deserve different sentences — and looking
 * after a write that did not happen opens no window.
 *
 * THE PREDICATE IS `IS NOT FALSE` AND NOT `g.is_active`, which is a one-word
 * difference and a whole state. 085 deliberately leaves the column nullable
 * and its header says why, so rows carrying NULL survive the migration by
 * design. Under the first draft's `AND g.is_active` such a row matched
 * nothing, the diagnostic SELECT found it anyway, and the operator was told it
 * «stopped withholding when is_active was cleared» — by a clearing that never
 * happened. The row could not be listed, could not be archived and could not
 * be normalised by any supported path: a dead end whose only exit was hand
 * SQL, which is the thing this whole tranche exists to replace. No money was
 * at risk (the engine filters `is_active = true`), but a false sentence is its
 * own defect. With `IS NOT FALSE` the NULL row is archivable and the
 * ConflictError below is left saying the only thing that is true of the rows
 * that still reach it: `is_active` is already `false`.
 */
export async function archiveGarnishment(
  id: string,
  scope: EntityScope,
  opts: { asOf?: string } = {}
): Promise<ArchivedGarnishment> {
  // A non-UUID id is «not found», not a 22P02. `garnishment list` prints `id`
  // and `employee` side by side, so handing this the employee number is the
  // expected slip; without this guard Postgres answers «invalid input syntax
  // for type uuid», which carries no statusCode and exits FAILURE instead of
  // NOT_FOUND. Indistinguishable from «not yours», which is what scope.ts
  // requires of every boundary answer.
  if (!UUID_RE.test(id)) throw new NotFoundError('Garnishment', id);

  const updated = await query<ArchivedGarnishment>(
    `UPDATE garnishments g
        SET is_active = false,
            end_date = COALESCE($2::date, g.end_date)
      WHERE g.id = $1
        AND g.is_active IS NOT FALSE
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
