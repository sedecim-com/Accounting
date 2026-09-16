import { InvalidArgumentError, type Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { withTransaction } from '../database/connection.js';
import { entityScope, type EntityScope } from '../database/scope.js';
import {
  GARNISHMENT_TYPES,
  archiveGarnishment,
  listGarnishments,
  recordGarnishment,
  type GarnishmentRow,
  type GarnishmentState,
  type RecordedGarnishment,
} from '../services/payroll/common/garnishment-service.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  declareRisk,
  exitCodeFor,
  gateMutation,
  render,
  requireExplicitEntity,
  resolveActiveEntity,
  usageError,
  withContext,
  withNote,
  withOutput,
  withSelection,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine garnishment · embargo
//
// THREE LEAVES, and each one is required by the next.
//
//   garnishment record <employee>  · embargo registrar  — THE INSERT.
//   garnishment list [employee]    · embargo listar     — the cascade, in the
//                                                         order money is taken,
//                                                         and the only way to
//                                                         get an id for archive.
//   garnishment archive <id>       · embargo archivar   — is_active = false.
//
// WHY NOT `record` ALONE. `paycheck_deductions.garnishment_id` carries no
// `ON DELETE` clause (008_payroll.sql:447-448), so once a paycheck has
// withheld against an order that row can never be deleted; and the engine's
// only filter is `WHERE employee_id = $1 AND is_active = true`
// (garnishment-engine.ts:170) — no query in `src/` gates, filters or computes
// on `end_date`, and the only readers it has are the two display columns this
// tranche adds. A slice that shipped `record` by itself would create an
// obligation that withholds forever with no supported way to stop it, and hand
// SQL is precisely what migration 075's header says this table's users already
// resort to.
//
// THE REST OF THE FAMILY IS DELIBERATELY NOT REGISTERED, and the reasons are
// written here rather than rediscovered:
//
//   · `edit` (catalog :1669) — amending an order needs an audit trail, and
//     `garnishments` has no `created_at`, `updated_at` or `created_by`
//     (008:424-443), unlike `employees`, which has all three. Until those
//     columns exist, an order a court modified is archived and refiled, which
//     leaves the real history in two rows.
//   · `balance show` (:1671) — it cannot tell the truth off `total_paid`,
//     which has no writer; the cumulative is already derivable from
//     `paycheck_deductions.garnishment_id`. WHEN an order counts as paid —
//     at withholding or at remittance — is an accrual-vs-cash fork on a
//     third-party liability, and by invariant 6 that goes on the policy panel
//     with its reader, not into code here.
//   · `preview` (:1672) — needs `gross_wages`, which the row's `--disposable`
//     and `--frequency` do not supply and which a `percent_gross` order
//     requires. Reusing `--gross` would give a spelling frozen in G1b a second
//     meaning.
//   · `remit` (:1673) — phase 3, irreversible and external, which would force
//     `--dry-run`, `--yes`, `--idempotency-key` and a `llave` declaration
//     against a remittance rail that does not exist.
//   · `pension-alimenticia record` (:1677) — not shipped, and the writer
//     refuses the type as well. The reason is in the service's header and in
//     the refusal itself: the gate at paycheck-service.ts:493 means such an
//     order withholds nothing, and the caps the engine would apply are the
//     CCPA's, not LFT art. 110 in a dated table.
//
// THIS FILE IS BORN IN ENGLISH, AND IT HAS NO CHOICE. `scripts/language-status`
// gives a file with no baseline entry a floor of ZERO in every lane, so a
// Spanish identifier, a Spanish filename or a Spanish user-facing string
// written here fails `--check` («un archivo nuevo no nace con deuda»). Help
// prose stays English in place, as `src/cli/payroll-isn-command.ts` does:
// `src/i18n/en.ts` scopes `help.<familia>.<hoja>.*` to the leaves mnemosine.ts
// registers on its own, and a family with its own file adopting those keys is
// another tranche's work. The Spanish ALIASES are not prose — they come from
// the closed verb list — and they are here.
// ============================================================

export interface GarnishmentCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
}

interface RecordOpts extends CommonOpts {
  type?: string;
  amount?: string;
  percentDisposable?: string;
  percentGross?: string;
  priority?: number;
  case?: string;
  court?: string;
  payee?: string;
  start?: string;
  exemptAmount?: string;
  supportsSecondFamily?: string;
  arrears12wk?: string;
  note?: string;
  dryRun?: boolean;
}

interface ListOpts extends CommonOpts {
  type?: string;
  status?: string[];
  all?: boolean;
  limit?: number;
  offset?: number;
}

interface ArchiveOpts extends CommonOpts {
  asOf?: string;
  reason?: string;
}

const TYPE_MARKER = `<${GARNISHMENT_TYPES.join('|')}>`;

function wholeNumber(name: string) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new InvalidArgumentError(`${name} must be a whole number of 0 or more; got "${value}".`);
    }
    return n;
  };
}

/** The rehearsal sentinel: thrown to abort the transaction `--dry-run` opens. */
class RehearsedFiling extends Error {
  constructor(readonly result: RecordedGarnishment) {
    super('garnishment filing rehearsed');
    this.name = 'RehearsedFiling';
  }
}

function listRow(row: GarnishmentRow): Row {
  return {
    id: row.id,
    employee: row.employee_number,
    type: row.garnishment_type,
    rank: row.rank,
    priority: row.priority,
    amount_type: row.amount_type,
    amount_value: row.amount_value,
    case: row.case_number,
    court: row.issuing_authority,
    payee: row.payee_name,
    start: row.start_date,
    end: row.end_date,
    active: row.is_active === true,
  };
}

// ============================================================
// EXAMPLES · copyable invocations
//
// All three leaves carry one, `list` included: the surface census charges
// every leaf whose help never invokes the binary, reads or not, and a family
// that documents one of its mutating leaves has to document them all.
//
// English prose (the node's language); the data is a US payroll, because the
// cascade only runs for US employees today and an example a Mexican employee
// would be an example of a refusal.
// ============================================================
const EXAMPLES = {
  record: `
Examples:
  # A support order at 25 % of DISPOSABLE earnings. Both cap answers are
  # required and neither has a default: unanswered, the CCPA ceiling silently
  # becomes 60 % of disposable earnings instead of 50 %.
  mnemosine garnishment record E-1042 --type child_support --percent-disposable 25 --supports-second-family yes --arrears-12wk no --court "Travis County District Court" --case 2026-DF-004417 --payee "Texas SDU" --start 2026-08-01
  # A federal levy. It takes no amount flag — what it withholds is disposable
  # earnings minus the Pub 1494 exemption — and it refuses to be filed without
  # that exemption, because the absent figure is read as zero.
  mnemosine garnishment record E-1042 --type tax_levy_federal --exempt-amount 462.50 --court "IRS ACS" --case "LEVY-668-W" --start 2026-08-01
  # Rehearse the real path and undo it: same refusals, same boundary, and it
  # prints the cascade the order would be joining. Nothing is written.
  mnemosine garnishment record E-1042 --type creditor --percent-disposable 15 --court "JP Precinct 3" --start 2026-08-01 --dry-run
`,
  list: `
Examples:
  # Every live order of the entity, in the sequence money is actually taken:
  # statutory rank first, then priority, then start date.
  mnemosine garnishment list
  # One worker, history included, so an archived order is visible too.
  mnemosine garnishment list E-1042 --all
  # Just the levies, as JSON for a reconciliation script.
  mnemosine garnishment list --type tax_levy_federal --json
`,
  archive: `
Examples:
  # Stop the withholding. This clears is_active, which is the only thing the
  # engine filters on; --reason is required because archiving is an undo.
  mnemosine garnishment archive 7c1f0c6e-8b44-4a51-9a0a-2f1d9d0a51b3 --reason "order revoked, court notice 2026-09-12"
  # Same halt, recording the date the court set it aside. --as-of writes
  # end_date for the record: on its own it would stop nothing, because no
  # query in the system decides anything off that column.
  mnemosine garnishment archive 7c1f0c6e-8b44-4a51-9a0a-2f1d9d0a51b3 --as-of 2026-09-12 --reason "balance satisfied"
`,
} as const;

export function registerGarnishmentCommand(program: Command, deps: GarnishmentCommandDeps): void {
  const garnishment = program
    .command('garnishment')
    .alias('embargo')
    .description('Court-ordered wage withholding: file an order, see the cascade, stop it');

  const run = async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? 0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  /** A write never guesses the entity: it is named, or it is pinned. */
  const scopeForWrite = async (opts: CommonOpts): Promise<EntityScope> => {
    // Tenant FIRST: entity resolution is itself bounded by RLS, so a --tenant
    // applied afterwards resolves nothing.
    bootstrapTenant(opts.tenant);
    const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
    return entityScope(ctx.tenantId, ctx.entityId);
  };

  const scopeForRead = async (opts: CommonOpts): Promise<EntityScope> => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity({ entity: opts.entity }, { home: deps.home });
    return entityScope(ctx.tenantId, ctx.entityId);
  };

  // ---- garnishment record · embargo registrar -------------------------
  const record = garnishment
    .command('record')
    .alias('registrar')
    .argument('<employee>', 'employee number or id the order is against')
    .description('File a court order already dictated, with its basis, its authority and its caps');
  withContext(record);
  withOutput(record);
  withNote(record);
  record
    .option(`--type ${TYPE_MARKER}`, 'the order type, in the vocabulary the column stores')
    .option('--amount <n>', 'a fixed amount per period')
    .option('--percent-disposable <n>', 'a percentage of DISPOSABLE earnings (gross minus employee taxes)')
    .option('--percent-gross <n>', 'a percentage of GROSS wages — different money from --percent-disposable')
    .option('--priority <n>', 'tie-breaker WITHIN a statutory rank; it does not decide the rank', wholeNumber('--priority'))
    .option('--case <number>', 'the court file number, unique per worker while the order is live')
    .option('--court <text>', 'the authority that issued the order (required)')
    .option('--payee <name>', 'who the withholding is remitted to')
    .option('--start <date>', 'the date the order bears (YYYY-MM-DD); withholding starts when it is ACTIVE')
    .option('--exempt-amount <n>', 'IRS Pub 1494 exempt amount; required on a tax levy, read by nothing else')
    .option('--supports-second-family <yes|no>', 'does this worker support another family? decides a 50 % or 60 % CCPA cap — no default')
    .option('--arrears-12wk <yes|no>', 'are arrears more than twelve weeks old? adds five points to the cap — no default')
    .option('--dry-run', 'run the real path and undo it: shows the order and the cascade it would join');
  // ESCRITURA, and the agent may NOT call it. A court order is not a review
  // queue: what is written here reduces a person's pay every period until
  // someone archives it. `declareRisk` only admits escritura + agent with
  // `draftOnly`, which would be a lie. Same resolution as `asset create` and
  // `isn rate set`.
  declareRisk(record, {
    risk: 'escritura',
    agent: false,
    writes:
      'garnishments (one order); no journal entry and no withholding — the engine applies it ' +
      'on the next pay run',
  });
  record.addHelpText('after', EXAMPLES.record);
  record.action((employee: string, opts: RecordOpts, cmd: Command) =>
    run(async () => {
      const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);

      // The three the flags themselves can catch are named together: asking
      // for them one at a time costs three round trips.
      const missing = [
        opts.type ? null : '--type',
        opts.court ? null : '--court',
        opts.start ? null : '--start',
      ].filter((f): f is string => f !== null);
      if (missing.length > 0) {
        throw usageError(
          `Missing ${missing.join(', ')}. An order with no type cannot be computed, one with no ` +
            'issuing authority cannot be traced back to the court that dictated it, and ' +
            '`start_date` is NOT NULL.'
        );
      }

      const scope = await scopeForWrite(opts);
      const input = {
        employee_id: employee,
        type: opts.type,
        amount: opts.amount,
        percent_disposable: opts.percentDisposable,
        percent_gross: opts.percentGross,
        priority: opts.priority,
        case_number: opts.case,
        issuing_authority: opts.court,
        payee_name: opts.payee,
        start_date: opts.start,
        exempt_amount: opts.exemptAmount,
        supports_second_family: opts.supportsSecondFamily,
        arrears_over_12_weeks: opts.arrears12wk,
      };

      let filed: RecordedGarnishment;
      if (dryRun) {
        // THE REAL PATH, UNDONE. What gets printed comes out of the same code
        // that would write — the same refusals, the same boundary, the same
        // uniqueness check — and the transaction is aborted with a sentinel so
        // nothing is left behind.
        try {
          filed = await withTransaction(async (client) => {
            throw new RehearsedFiling(await recordGarnishment(input, scope, { client }));
          });
        } catch (err) {
          if (!(err instanceof RehearsedFiling)) throw err;
          filed = err.result;
        }
      } else {
        filed = await recordGarnishment(input, scope);
      }

      render(
        [
          {
            id: filed.id,
            employee,
            type: filed.order.garnishment_type,
            amount_type: filed.order.amount_type,
            amount_value: filed.order.amount_value,
            priority: filed.order.priority,
            case: filed.order.case_number,
            court: filed.order.issuing_authority,
            payee: filed.order.payee_name,
            start: filed.order.start_date,
            active: true,
          },
        ],
        { ...opts, idField: 'id', numeric: ['amount_value'] }
      );

      const err = process.stderr;
      if (dryRun) {
        err.write(deps.palette.dim('Rehearsal: the transaction was undone. No order was filed.\n'));
      }
      // THE CASCADE THIS ORDER JOINS. There is no aggregate ceiling across
      // order families — a levy and a support order can together ask for more
      // than disposable earnings — so the least this leaf can do is show the
      // operator the queue they just joined, in the sequence payday will use.
      if (filed.cascade.length > 1) {
        err.write(
          deps.palette.yellow(
            `  ⚠ this worker now has ${filed.cascade.length} live orders. Payday takes them in ` +
              'this sequence, and nothing caps their TOTAL against disposable earnings:\n'
          )
        );
        for (const other of filed.cascade) {
          err.write(
            deps.palette.dim(
              `      ${other.garnishment_type} · rank ${other.rank} · priority ${other.priority} · ` +
                `${other.amount_type} ${other.amount_value}\n`
            )
          );
        }
      }
      return ExitCode.OK;
    })
  );

  // ---- garnishment list · embargo listar ------------------------------
  const list = garnishment
    .command('list')
    .alias('listar')
    .argument('[employee]', 'narrow to one worker, by employee number or id')
    .description('List orders in the sequence money is taken: statutory rank, then priority, then date');
  withContext(list);
  withSelection(list);
  withOutput(list);
  list.option(`--type ${TYPE_MARKER}`, 'only orders of this type');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EXAMPLES.list);
  list.action((employee: string | undefined, opts: ListOpts) =>
    run(async () => {
      const states = (opts.status ?? []).map((s) => s.trim().toLowerCase());
      const unknown = states.filter((s) => s !== 'active' && s !== 'archived');
      if (unknown.length > 0) {
        throw usageError(
          `--status ${unknown.join(', ')}: an order is either active or archived. ` +
            'Use -a/--all for both.'
        );
      }
      // THE STATES TRAVEL AS STATES. Folding them into one boolean is what the
      // first draft did — `all = opts.all || states.includes('archived')` —
      // and the service then only SKIPPED its predicate, so asking for the
      // archived orders returned the live ones too, each printed
      // `active: true`. The refusal three lines up promises the distinction;
      // this is where it is kept.
      const scope = await scopeForRead(opts);
      const rows = await listGarnishments(scope, {
        employee_id: employee,
        type: opts.type,
        states: states as GarnishmentState[],
        all: opts.all === true,
        limit: opts.limit,
        offset: opts.offset,
      });

      render(rows.map(listRow), {
        ...opts,
        idField: 'id',
        numeric: ['amount_value', 'priority', 'rank'],
      });
      if (rows.length === 0) {
        process.stderr.write(
          deps.palette.dim('No garnishment orders matched. Nothing is being withheld here.\n')
        );
      }
      return ExitCode.OK;
    })
  );

  // ---- garnishment archive · embargo archivar -------------------------
  const archive = garnishment
    .command('archive')
    .alias('archivar')
    .argument('<id>', 'the order id, as `garnishment list` prints it')
    .description('Stop the withholding by clearing is_active, keeping the order and its history');
  withContext(archive);
  withOutput(archive);
  archive.option(
    '--as-of <date>',
    'the date the order ceased (YYYY-MM-DD), recorded in end_date alongside the halt'
  );
  // ESCRITURA and agent ✗, like `record`. `archive` is an undo verb, so
  // `declareRisk` injects --reason and `gateMutation` refuses without it.
  declareRisk(archive, {
    risk: 'escritura',
    agent: false,
    writes: 'garnishments (is_active = false, and end_date when --as-of is given); no journal entry',
  });
  archive.addHelpText('after', EXAMPLES.archive);
  archive.action((id: string, opts: ArchiveOpts, cmd: Command) =>
    run(async () => {
      gateMutation(cmd, opts as unknown as Record<string, unknown>);
      const scope = await scopeForWrite(opts);
      const stopped = await archiveGarnishment(id, scope, { asOf: opts.asOf });
      render(
        [
          {
            id: stopped.id,
            employee_id: stopped.employee_id,
            type: stopped.garnishment_type,
            case: stopped.case_number,
            end: stopped.end_date,
            active: false,
          },
        ],
        { ...opts, idField: 'id' }
      );
      process.stderr.write(
        deps.palette.dim(
          'The order stays on file. What stopped is the withholding: the engine reads is_active ' +
            'and nothing else.\n'
        )
      );
      return ExitCode.OK;
    })
  );
}
