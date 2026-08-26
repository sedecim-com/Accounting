import * as readline from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import {
  listJournalEntries,
  getJournalEntryDetail,
  resolveJournalEntry,
  createDraftEntry,
  checkExistingEntry,
  checkDraftDocument,
  parseEntryDocument,
  parseLineFlag,
  MANUAL_ENTRY_TYPES,
  ENTRY_TYPES,
  ENTRY_STATUSES,
  type DraftLineInput,
  type EntryCheckResult,
  type JournalEntryLineWithAccount,
} from '../services/accounting/journal-entry-service.js';
import { resolvePeriod } from '../services/accounting/fiscal-calendar-service.js';
import {
  postJournalEntry,
  reverseJournalEntry,
  voidJournalEntry,
} from '../services/accounting/posting.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  gateMutation,
  render,
  resolveFormat,
  checkExitCode,
  withContext,
  withOutput,
  withSelection,
  withTime,
  withStrict,
  resolveActiveEntity,
  requireExplicitEntity,
  usageError,
  validationFailed,
  notFound,
  blockedByState,
  abortedByUser,
  exitCodeFor,
  ExitCode,
  type ExitCodeValue,
} from './kernel/index.js';

// ============================================================
// mnemosine entry · poliza
// The double-entry cycle from the terminal: draft, inspect, validate,
// and — only ever by an explicit human act — post, reverse or void.
//
// THE SAFETY PROPERTY THIS FILE EXISTS TO PRESERVE:
//   `entry create` ALWAYS produces a draft. There is no --post, no
//   --auto-post, and no flag that makes it reach the ledger; the REST
//   surface's auto_post (journal-entries.ts:194) is deliberately not
//   exposed. That is what lets `create` be agent-invocable at all: the
//   agent proposes an entry, a human runs `entry post`.
//
// `post`, `reverse` and `void` are irreversible and are never agent
// invocable — declareRisk throws at startup if anyone tries.
//
// Semantics that come from the engine (posting.ts) and are not
// re-decided here:
//   - a POSTED entry is never mutated and never flips to 'void';
//     `reverse` creates a linked, posted mirror in the same transaction;
//   - `void` marks an unposted draft 'void'; asked to void a posted
//     entry it produces that same mirror, because the alternative
//     (flipping the status) makes the materialised trial balance
//     disagree with account_balances;
//   - one reversal per entry, ever.
// ============================================================

export interface EntryCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Test seam for the confirmation prompt. */
  confirm?: (question: string) => Promise<boolean>;
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
  limit?: number;
  offset?: number;
  all?: boolean;
  status?: string[];
  dryRun?: boolean;
  yes?: boolean;
  reason?: string;
}

const LIST_COLUMNS = [
  'entry_number', 'entry_date', 'entry_type', 'status',
  'description', 'reference', 'total_debits', 'source_type',
] as const;

/**
 * Domain error codes that mean "the ledger's state forbids this", mapped to
 * the exit contract's BLOCKED (5). They arrive as AccountingError, whose 422
 * would otherwise read as "your input is invalid" — it is not: the input was
 * fine and the entry had already moved on.
 */
const BLOCKED_CODES = new Set([
  'ALREADY_POSTED', 'ENTRY_VOID', 'ENTRY_NOT_POSTED', 'ALREADY_REVERSED',
  'ALREADY_VOID', 'PERIOD_CLOSED', 'PERIOD_NOT_FUTURE', 'PERIOD_ALREADY_OPEN',
]);

export function translateDomainError(err: unknown): unknown {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  if (typeof code !== 'string') return err;
  if (BLOCKED_CODES.has(code)) return blockedByState(message, { code });
  if (code === 'ENTRY_NOT_FOUND') return notFound(message, { code });
  return err;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A DATE column comes back as a local-midnight Date; print the calendar day. */
export function day(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return value === null || value === undefined ? '' : String(value);
}

function summarize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    entry_number: row.entry_number,
    entry_date: day(row.entry_date),
    entry_type: row.entry_type,
    status: row.status,
    description: row.description,
    reference: row.reference,
    // Money stays a decimal STRING all the way out (output contract).
    total_debits: row.total_debits,
    total_credits: row.total_credits,
    source_type: row.source_type,
    id: row.id,
  };
}

function lineRow(line: JournalEntryLineWithAccount): Record<string, unknown> {
  return {
    line: line.line_number,
    account: line.account_code,
    name: line.account_name,
    debit: line.debit_amount ?? '',
    credit: line.credit_amount ?? '',
    description: line.description ?? '',
  };
}

export function registerEntryCommand(program: Command, deps: EntryCommandDeps): void {
  const entry = program
    .command('entry')
    .alias('poliza')
    // Second Spanish spelling, following the `memory teach|enseña|ensena`
    // precedent: an accountant types whichever word their firm uses.
    .alias('asiento')
    .description('Journal entries: draft, inspect, validate, post, reverse and void');

  const run = async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? ExitCode.OK);
    } catch (err) {
      const mapped = translateDomainError(err);
      deps.reportError(mapped);
      await deps.shutdown(exitCodeFor(mapped));
    }
  };

  const entityOf = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity(
      { entity: opts.entity },
      { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
    );
    return ctx;
  };

  /**
   * Says out loud which company is about to be written to when the entity was
   * not named on the command line. The active-entity pin is a convenience for
   * reads; for a write it is the difference between drafting in the client you
   * are looking at and drafting in the one you looked at yesterday.
   */
  const announceTarget = (opts: CommonOpts, ctx: { entityName: string }): void => {
    if (opts.entity) return;
    process.stderr.write(
      deps.palette.dim(`  → ${ctx.entityName} (active entity; name another with --entity)\n`)
    );
  };

  /**
   * An irreversible act needs a human yes. Without a terminal there is nobody
   * to ask, so the command refuses instead of assuming consent — the opposite
   * default is how an unattended script posts a month it never meant to.
   */
  /**
   * The kernel gives every irreversible command an --idempotency-key. There is
   * no idempotency store in this repo yet, so saying nothing would let a caller
   * believe a retry is deduplicated when it is not. What actually protects a
   * retry here is the entry's own state — the second post, reversal or void is
   * refused by the ledger.
   */
  const noteIdempotencyKey = (opts: { idempotencyKey?: string }): void => {
    if (!opts.idempotencyKey) return;
    process.stderr.write(
      deps.palette.yellow(
        '  --idempotency-key is accepted but not yet stored: nothing deduplicates on it. ' +
          "A repeat is refused by the entry's state instead (already posted / already reversed).\n"
      )
    );
  };

  const confirmOrAbort = async (opts: CommonOpts, question: string): Promise<void> => {
    if (opts.yes) return;
    if (deps.confirm) {
      if (await deps.confirm(question)) return;
      throw abortedByUser();
    }
    if (!process.stdin.isTTY) {
      throw abortedByUser(
        `${question} — there is no terminal to ask on. Re-run with --yes once you are sure, or with --dry-run to see the effect first.`
      );
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') throw abortedByUser();
    } finally {
      rl.close();
    }
  };

  // ---- entry list --------------------------------------------------
  const list = entry
    .command('list')
    .alias('listar')
    .argument('[search]', 'text to match in the description or reference')
    .description('Search journal entries by text, account, date, amount, state, type or source');
  withOutput(withSelection(withTime(withContext(list))));
  list
    .option('--type <type...>', 'entry type (repeatable)')
    .option('--source <name>', 'origin subledger: invoice, bill, payroll, manual…')
    .option('--account <code>', 'only entries with a line on this account')
    .option('--min-amount <amount>', 'minimum total debits')
    .option('--max-amount <amount>', 'maximum total debits');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action((
    search: string | undefined,
    opts: CommonOpts & {
      period?: string; since?: string; until?: string; asOf?: string; dateBasis?: string;
      type?: string[]; source?: string; account?: string; minAmount?: string; maxAmount?: string;
    }
  ) =>
    run(async () => {
      const ctx = await entityOf(opts);

      // Two axes the tables cannot answer, refused rather than silently
      // answered with a different one: posted_date is not filterable and
      // there is no document/value date column (catalog: --date-basis is
      // withdrawn for this command).
      if (opts.asOf) {
        throw usageError('`entry list` filters a date RANGE: use --since and --until, not --as-of.');
      }
      if (opts.dateBasis && opts.dateBasis !== 'posting') {
        throw usageError(
          `--date-basis ${opts.dateBasis} is not available: journal_entries stores one date ` +
            '(entry_date, the ledger date). Only --date-basis posting is supported.'
        );
      }
      for (const state of opts.status ?? []) {
        if (!(ENTRY_STATUSES as readonly string[]).includes(state)) {
          throw usageError(`Unknown --status "${state}". Use one of: ${ENTRY_STATUSES.join(', ')}.`);
        }
      }
      for (const type of opts.type ?? []) {
        if (!(ENTRY_TYPES as readonly string[]).includes(type)) {
          throw usageError(`Unknown --type "${type}". Use one of: ${ENTRY_TYPES.join(', ')}.`);
        }
      }

      const period = opts.period ? await resolvePeriod(ctx.entityId, opts.period) : undefined;

      const { rows, total } = await listJournalEntries(ctx.entityId, {
        search,
        fiscalPeriodId: period?.id,
        status: opts.status?.length ? opts.status : undefined,
        entryType: opts.type?.length ? opts.type : undefined,
        startDate: opts.since,
        endDate: opts.until,
        sourceType: opts.source,
        accountCode: opts.account,
        minAmount: opts.minAmount,
        maxAmount: opts.maxAmount,
        limit: opts.all ? undefined : (opts.limit ?? 50),
        offset: opts.offset,
      });

      render(
        (rows as unknown as Record<string, unknown>[]).map(summarize),
        {
          ...opts,
          total,
          idField: 'entry_number',
          // With no rows there are no columns to name: an explicit --fields
          // list would be rejected as unknown.
          fields: opts.fields ?? (rows.length ? LIST_COLUMNS.join(',') : undefined),
          numeric: ['total_debits', 'total_credits'],
        }
      );
    })
  );

  // ---- entry show --------------------------------------------------
  const show = entry
    .command('show')
    .alias('ver')
    .argument('<number>', 'entry number (JE-2026-00042) or id')
    .description('Show one entry with its lines, totals, period and linked reversal');
  withOutput(withContext(show));
  show.option('--no-lines', 'header only, without the lines');
  declareRisk(show, { risk: 'lectura', agent: true });
  show.action((number: string, opts: CommonOpts & { lines?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const detail = await getJournalEntryDetail(ctx.entityId, number);
      const header = {
        ...summarize(detail as unknown as Record<string, unknown>),
        posted_date: detail.posted_date ? new Date(detail.posted_date).toISOString() : '',
        is_reversal: detail.is_reversal,
        reverses: detail.reverses_entry_number ?? '',
        reversed_by: detail.reversed_by_entry_number ?? '',
        notes: detail.notes ?? '',
      };

      // Machine formats get one object with the lines nested; a terminal gets
      // a header block and then the lines as a table, which is how an
      // accountant reads a póliza.
      if (resolveFormat(opts) !== 'table' || opts.quiet) {
        render([{ ...header, lines: opts.lines === false ? undefined : detail.lines.map(lineRow) }], {
          ...opts,
          idField: 'entry_number',
        });
        return;
      }

      const p = deps.palette;
      const out = process.stdout;
      out.write(
        `\n${p.bold(String(detail.entry_number))}  ${p.dim(
          `${day(detail.entry_date)} · ${detail.entry_type} · ${detail.status}`
        )}\n`
      );
      if (detail.description) out.write(`  ${detail.description}\n`);
      if (detail.reference) out.write(p.dim(`  reference: ${detail.reference}\n`));
      if (detail.reverses_entry_number) {
        out.write(p.dim(`  reverses: ${detail.reverses_entry_number}\n`));
      }
      if (detail.reversed_by_entry_number) {
        out.write(
          p.yellow(`  reversed by: ${detail.reversed_by_entry_number} (this entry is annulled)\n`)
        );
      }
      out.write(
        p.dim(`  totals: ${detail.total_debits} debit / ${detail.total_credits} credit\n\n`)
      );
      if (opts.lines !== false) {
        render(detail.lines.map(lineRow), {
          ...opts,
          format: 'table',
          fields: undefined,
          numeric: ['debit', 'credit'],
        });
        out.write('\n');
      }
    })
  );

  // ---- entry create ------------------------------------------------
  const create = entry
    .command('create')
    .alias('crear')
    .description('Create a journal entry — ALWAYS a draft; posting is a separate human step');
  withContext(create);
  create
    .option(
      '--line <spec...>',
      'a line as <account>:<debit|credit>:<amount>[:description]; repeat for each line'
    )
    .option('--file <path>', 'JSON document with date, type, description and lines')
    .option('--date <date>', 'entry date (YYYY-MM-DD); defaults to today')
    .option('--type <type>', `entry type: ${MANUAL_ENTRY_TYPES.join(', ')} (default: standard)`)
    .option('--description <text>', 'what the entry records')
    .option('--reference <text>', 'external reference (document, folio, memo)')
    .option('--dry-run', 'validate and show the entry that would be drafted; write nothing')
    .option('--json', 'JSON output');
  // agent: true is safe here ONLY because every path through this command
  // produces status='draft'. The draft IS the review queue: it does not move
  // a single balance until a human runs `entry post`.
  declareRisk(create, {
    risk: 'escritura',
    agent: true,
    draftOnly: true,
    writes: 'journal_entries (draft) + journal_entry_lines',
  });
  create.action((
    opts: CommonOpts & {
      line?: string[]; file?: string; date?: string; type?: string;
      description?: string; reference?: string;
    }
  ) =>
    run(async () => {
      // Tenant FIRST: resolving the entity is itself a query, and under RLS a
      // connection with no app.current_tenant sees zero rows in legal_entities.
      // With this the other way round every write in this family died with
      // "No active entity matches …" even when --tenant/--entity were correct.
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
      announceTarget(opts, ctx);

      if (opts.line?.length && opts.file) {
        throw usageError('Pass either --line flags or a --file document, not both.');
      }
      let lines: DraftLineInput[];
      let date = opts.date;
      let type = opts.type;
      let description = opts.description;
      let reference = opts.reference;

      if (opts.file) {
        const doc = parseEntryDocument(readFileSync(opts.file, 'utf-8'));
        lines = doc.lines;
        date = opts.date ?? doc.date;
        type = opts.type ?? doc.type;
        description = opts.description ?? doc.description;
        reference = opts.reference ?? doc.reference;
      } else if (opts.line?.length) {
        lines = opts.line.map(parseLineFlag);
      } else {
        throw usageError(
          'Nothing to record. Give the lines with --line <account>:<debit|credit>:<amount> ' +
            '(repeat it), or a JSON document with --file.'
        );
      }

      const entryDate = date ?? day(new Date());
      const input = {
        entityId: ctx.entityId,
        createdBy: (await resolveReviewer(ctx.tenantId, opts.user)).userId,
        date: entryDate,
        type,
        description,
        reference,
        lines,
      };

      if (opts.dryRun) {
        // The dry run is the real check: same rules, same period resolution,
        // nothing written.
        const check = await checkDraftDocument(input);
        printCheck(check, deps.palette, opts, 'Would draft');
        return check.isValid ? ExitCode.OK : ExitCode.VALIDATION;
      }

      const created = await createDraftEntry(input);

      if (opts.json) {
        render([summarize(created as unknown as Record<string, unknown>)], { json: true });
        return;
      }
      const p = deps.palette;
      process.stdout.write(
        `${p.green('✔')} ${p.bold(created.entry_number)} drafted ` +
          `${p.dim(`(${lines.length} lines, ${created.total_debits} / ${created.total_credits})`)}\n` +
          p.dim(`  Nothing moved in the ledger. Post it with: mnemosine entry post ${created.entry_number}\n`)
      );
    })
  );

  // ---- entry check -------------------------------------------------
  const check = entry
    .command('check')
    .alias('verificar')
    .description('Run the seven NIF validation rules over an entry or a document; writes nothing');
  withOutput(withContext(check));
  withStrict(check);
  check
    .option('--entry <number>', 'an existing entry, by number or id')
    .option('--file <path>', 'a JSON entry document that does not exist yet');
  declareRisk(check, { risk: 'lectura', agent: true });
  check.action((opts: CommonOpts & { entry?: string; file?: string; strict?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      if (!opts.entry && !opts.file) {
        throw usageError('Nothing to check: pass --entry <number> or --file <path>.');
      }
      if (opts.entry && opts.file) {
        throw usageError('Check one thing at a time: --entry or --file, not both.');
      }

      const result = opts.entry
        ? await checkExistingEntry(ctx.entityId, opts.entry)
        : await checkDraftDocument({
            ...parseEntryDocument(readFileSync(opts.file as string, 'utf-8')),
            entityId: ctx.entityId,
            createdBy: '',
          });

      printCheck(result, deps.palette, opts, 'Checked');
      // A check that FOUND something exits 4 so it can gate a pipeline; a
      // check that could not run threw long before this line.
      return checkExitCode(
        { blocking: result.errors.length, warning: result.warnings.length },
        { strict: opts.strict }
      );
    })
  );

  // ---- entry post --------------------------------------------------
  const post = entry
    .command('post')
    .alias('contabilizar')
    .argument('<number>', 'entry number or id')
    .description('Post ONE entry to the ledger: validates the seven rules, then moves balances');
  withContext(post);
  post.option('--json', 'JSON output');
  // Irreversible: declareRisk adds --dry-run, --yes and --idempotency-key,
  // and refuses to let the agent anywhere near this command.
  declareRisk(post, { risk: 'irreversible', writes: 'journal_entries.status + account_balances' });
  post.action((number: string, opts: CommonOpts & { idempotencyKey?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      announceTarget(opts, ctx);
      const target = await resolveJournalEntry(ctx.entityId, number);
      const { dryRun } = gateMutation(post, opts as Record<string, unknown>);
      noteIdempotencyKey(opts);

      if (target.status === 'posted') {
        throw blockedByState(
          `${target.entry_number} is already posted (${day(target.posted_date)}). ` +
            'Correct it with `entry reverse`, which leaves an audit trail.'
        );
      }
      if (target.status === 'void') {
        throw blockedByState(`${target.entry_number} is void and can never be posted.`);
      }

      const verdict = await checkExistingEntry(ctx.entityId, target.entry_number);
      if (dryRun) {
        printCheck(verdict, deps.palette, opts, 'Would post');
        return verdict.isValid ? ExitCode.OK : ExitCode.VALIDATION;
      }
      if (!verdict.isValid) {
        printCheck(verdict, deps.palette, opts, 'Cannot post');
        throw validationFailed(
          `${target.entry_number} does not pass validation, so it was not posted.`,
          { errors: verdict.errors }
        );
      }

      await confirmOrAbort(
        opts,
        `Post ${target.entry_number} (${target.total_debits}) to the ledger? This cannot be undone.`
      );

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const posted = await postJournalEntry(target.id, reviewer.userId);

      if (opts.json) {
        render([summarize(posted as unknown as Record<string, unknown>)], { json: true });
        return;
      }
      process.stdout.write(
        `${deps.palette.green('✔')} ${deps.palette.bold(posted.entry_number)} posted ` +
          `${deps.palette.dim(`(${posted.total_debits} / ${posted.total_credits})`)}\n`
      );
    })
  );

  // ---- entry reverse -----------------------------------------------
  const reverse = entry
    .command('reverse')
    .alias('reversar')
    .argument('<number>', 'the POSTED entry to reverse')
    .description('Create the linked posted mirror of an entry (NIF B-1: correct by reversal)');
  withContext(reverse);
  reverse.option('--date <date>', 'date of the mirror entry (YYYY-MM-DD); defaults to today');
  // declareRisk adds --reason for an undo verb, and gateMutation requires it.
  declareRisk(reverse, { risk: 'irreversible', writes: 'a new posted journal_entry + account_balances' });
  reverse.action((number: string, opts: CommonOpts & { date?: string; idempotencyKey?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      announceTarget(opts, ctx);
      const target = await resolveJournalEntry(ctx.entityId, number);
      const { dryRun, reason } = gateMutation(reverse, opts as Record<string, unknown>);
      noteIdempotencyKey(opts);

      if (target.status !== 'posted') {
        throw blockedByState(
          `${target.entry_number} is '${target.status}' and never touched the ledger, so there is ` +
            'nothing to mirror. Use `entry void` on a draft.'
        );
      }
      if (target.reversed_by_entry_id) {
        throw blockedByState(
          `${target.entry_number} already has a reversal. A second mirror would double the correction.`
        );
      }

      const detail = await getJournalEntryDetail(ctx.entityId, target.entry_number);
      if (dryRun) {
        const p = deps.palette;
        process.stdout.write(
          `\n${p.bold('Would create the mirror of ' + target.entry_number)} ` +
            `${p.dim(`dated ${opts.date ?? day(new Date())}, posted immediately`)}\n\n`
        );
        render(
          detail.lines.map((line) => ({
            account: line.account_code,
            name: line.account_name,
            debit: line.credit_amount ?? '',
            credit: line.debit_amount ?? '',
          })),
          { ...opts, format: 'table', numeric: ['debit', 'credit'] }
        );
        process.stdout.write(
          p.dim(`\n  ${target.entry_number} stays posted and unchanged; the two are linked.\n`)
        );
        return;
      }

      await confirmOrAbort(
        opts,
        `Reverse ${target.entry_number} (${target.total_debits})? The mirror posts immediately.`
      );

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const mirror = await reverseJournalEntry(target.id, reviewer.userId, {
        reason,
        // Local midnight: see createDraftEntry — a UTC midnight Date lands in
        // the DATE column as the previous day west of Greenwich.
        reversalDate: opts.date ? new Date(`${opts.date}T00:00:00`) : undefined,
      });

      process.stdout.write(
        `${deps.palette.green('✔')} ${deps.palette.bold(mirror.entry_number)} posted as the reversal of ` +
          `${target.entry_number}.\n` +
          deps.palette.dim(`  ${target.entry_number} is unchanged and now linked to its mirror.\n`)
      );
    })
  );

  // ---- entry void --------------------------------------------------
  const voidCmd = entry
    .command('void')
    .alias('anular')
    .argument('<number>', 'entry number or id')
    .description('Annul an entry: a draft is marked void, a posted one gets its linked mirror');
  withContext(voidCmd);
  declareRisk(voidCmd, { risk: 'irreversible', writes: 'journal_entries.status or a mirror entry' });
  voidCmd.action((number: string, opts: CommonOpts & { idempotencyKey?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      announceTarget(opts, ctx);
      const target = await resolveJournalEntry(ctx.entityId, number);
      const { dryRun, reason } = gateMutation(voidCmd, opts as Record<string, unknown>);
      noteIdempotencyKey(opts);

      if (target.status === 'void') {
        throw blockedByState(`${target.entry_number} is already void.`);
      }
      const posted = target.status === 'posted';
      if (posted && target.reversed_by_entry_id) {
        throw blockedByState(
          `${target.entry_number} was already annulled by its reversal. A second one would double the correction.`
        );
      }

      const effect = posted
        ? `${target.entry_number} is posted, so it will NOT change state: a linked mirror entry is ` +
          'created and posted, which is how a posted entry is annulled without making the trial ' +
          'balance disagree with the balances.'
        : `${target.entry_number} is '${target.status}' and never reached the ledger, so it is ` +
          'marked void. Its number is kept and never reused.';

      if (dryRun) {
        process.stdout.write(`\n${deps.palette.bold('Would void ' + target.entry_number)}\n  ${effect}\n\n`);
        return;
      }

      await confirmOrAbort(opts, `Void ${target.entry_number} (${target.total_debits})?`);

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const result = await voidJournalEntry(target.id, reviewer.userId, reason as string);

      const p = deps.palette;
      process.stdout.write(
        `${p.green('✔')} ${p.bold(result.entry_number)} annulled ${p.dim(`(now '${result.status}')`)}\n` +
          p.dim(`  ${effect}\n`)
      );
    })
  );
}

/** One rendering of a validation verdict, shared by check, create and post. */
function printCheck(
  result: EntryCheckResult,
  p: Palette,
  opts: { json?: boolean; format?: string; quiet?: boolean; fields?: string | boolean; output?: string },
  headline: string
): void {
  if (opts.json || (opts.format && opts.format !== 'table')) {
    render(
      [
        {
          entry_number: result.entry_number,
          entry_date: result.entry_date,
          period_name: result.period_name,
          period_status: result.period_status,
          line_count: result.line_count,
          valid: result.isValid,
          errors: result.errors,
          warnings: result.warnings,
        },
      ],
      { ...opts, idField: 'entry_number' }
    );
    return;
  }

  const out = process.stdout;
  const label = result.entry_number ?? '(new entry)';
  out.write(
    `\n${p.bold(`${headline}: ${label}`)}  ` +
      `${p.dim(`${result.entry_date} · ${result.period_name} (${result.period_status}) · ${result.line_count} lines`)}\n\n`
  );
  for (const error of result.errors) out.write(`  ${p.red('✘')} ${error}\n`);
  for (const warning of result.warnings) out.write(`  ${p.yellow('!')} ${warning}\n`);
  if (result.isValid && result.warnings.length === 0) {
    out.write(`  ${p.green('✔')} All seven rules pass.\n`);
  } else if (result.isValid) {
    out.write(`  ${p.green('✔')} No blocking errors.\n`);
  }
  out.write('\n');
}
