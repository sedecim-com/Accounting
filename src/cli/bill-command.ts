import * as readline from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import {
  listBills,
  getBillById,
  resolveBill,
  createBill,
  setBillLine,
  approveBill,
  computeBill,
  APPROVABLE_STATUSES,
  type BillLineInput,
  type BillDateBasis,
} from '../services/ap/bill-service.js';
import { resolveVendor, dueDateFrom } from '../services/ap/vendor-service.js';
import { resolveAccount } from '../services/accounting/account-service.js';
import { attestEntryAsync } from '../services/accounting/posting.js';
import { resolvePeriodRange } from '../services/reporting/report-service.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { ErrorCodes } from '../utils/errors.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  withSelection,
  withTime,
  resolveActiveEntity,
  requireExplicitEntity,
  usageError,
  notFound,
  blockedByState,
  abortedByUser,
  exitCodeFor,
} from './kernel/index.js';

// ============================================================
// mnemosine bill
// Vendor bills from the terminal, on services/ap/bill-service.ts
// — the same path the REST API takes.
//
// `bill approve` is the boundary of this family: before it, a
// bill is a document we are arguing about; after it, it is a
// liability in the ledger and creditable IVA on a tax return.
// That is irreversible, so it is declared irreversible and the
// agent may not invoke it. What the agent CAN do is everything
// up to the boundary — read, list, and propose — which is the
// whole point of splitting the two.
//
// `--dry-run` on approve is not a simulation: it runs the real
// posting inside a transaction and rolls it back, so the entry
// it prints is the entry that would exist, computed by the same
// engine, with the same period and role lookups.
// ============================================================

export interface BillCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Test seam: answers the confirmation prompt. */
  confirm?: (question: string) => Promise<boolean>;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  limit?: number;
  offset?: number;
  all?: boolean;
  status?: string[];
  user?: string;
  period?: string;
  since?: string;
  until?: string;
  asOf?: string;
  dateBasis?: string;
}

const LIST_COLUMNS = [
  'bill_number', 'vendor_name', 'bill_date', 'due_date', 'status', 'total_amount', 'amount_due',
] as const;

/** Money stays a string: it came out of Postgres as a numeric string and it leaves as one. */
function summarize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    bill_number: row.bill_number,
    vendor_name: row.vendor_name ?? '',
    vendor_invoice_number: row.vendor_invoice_number ?? '',
    bill_date: dateOnly(row.bill_date),
    due_date: dateOnly(row.due_date),
    status: row.status,
    currency_code: row.currency_code,
    total_amount: row.total_amount,
    amount_due: row.amount_due,
    id: row.id,
  };
}

/**
 * A calendar date as YYYY-MM-DD. `node-postgres` hands a DATE back as a
 * Date at LOCAL midnight, so `toISOString()` would move it a day west of
 * Greenwich; the local getters are the ones that agree with the column.
 */
function dateOnly(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return String(value).slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function requireDate(flag: string, value: string): string {
  if (!DATE_RE.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime())) {
    throw usageError(`${flag} must be a date as YYYY-MM-DD; got "${value}".`);
  }
  return value;
}

/**
 * `--line "account=5100,qty=2,price=350.00,tax=112,description=Papelería"`.
 * Keys are spelled the way the flags are, not the way the columns are: a
 * person typing a bill is not reading the schema.
 */
export function parseLineSpec(spec: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of spec.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) {
      throw usageError(
        `Cannot read the line "${spec}". Each part is key=value, comma-separated: ` +
          '--line "account=5100,qty=2,price=350.00,tax=112,description=Text".'
      );
    }
    out[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim();
  }
  return out;
}

const LINE_KEYS = ['account', 'qty', 'quantity', 'price', 'unit-price', 'tax', 'description', 'cost-center', 'project'];

export function registerBillCommand(program: Command, deps: BillCommandDeps): void {
  const bill = program
    .command('bill')
    .alias('factura-proveedor')
    .description('Vendor bills: capture, code, inspect and approve what we owe');

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
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

  const ask = async (question: string): Promise<boolean> => {
    if (deps.confirm) return deps.confirm(question);
    if (!stdin.isTTY) return false;
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const answer = await rl.question(deps.palette.cyan(`${question} [y/N] `)).catch(() => '');
      return /^y(es)?$/i.test((answer ?? '').trim());
    } finally {
      rl.close();
    }
  };

  // ---- bill list ---------------------------------------------------
  const list = bill
    .command('list')
    .alias('listar')
    .argument('[search]', 'match against bill number, the vendor invoice number or the vendor name')
    .description('List vendor bills by vendor, state, document date, posting date or due date');
  withOutput(withSelection(withTime(withContext(list))));
  // A bill list must show bills that were never posted — they are the ones
  // somebody still has to act on — so the date flags mean the DOCUMENT date
  // here unless the caller says otherwise. The kernel's global default
  // (posting) is right for the ledger and wrong for a subledger inbox.
  const basisOption = list.options.find((o) => o.long === '--date-basis');
  if (basisOption) {
    basisOption.defaultValue = 'document';
    // Commander copies an option's default into the parsed values at
    // REGISTRATION time (addOption), so moving `defaultValue` afterwards only
    // rewrites the help text: the value the action reads was already 'posting'.
    // Both have to move, or `bill list --since` silently answers the ledger
    // question — and every unapproved bill, the ones somebody still has to act
    // on, disappears from a list that says nothing is wrong.
    list.setOptionValueWithSource('dateBasis', 'document', 'default');
  }
  list
    .option('--vendor <ref>', 'only this vendor (number, name or id)')
    .option('--due-before <date>', 'only bills falling due on or before this date (YYYY-MM-DD)')
    .option('--open', 'only bills that still owe money (excludes paid, void and cancelled)');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action(
    (search: string | undefined, opts: CommonOpts & { vendor?: string; dueBefore?: string; open?: boolean }) =>
      run(async () => {
        const ctx = await entityOf(opts);

        if (opts.asOf) {
          throw usageError(
            '--as-of asks what was open on a date, which is an aging question this command cannot answer ' +
              '(it needs the payment history joined per bill). Use --until for the document date.'
          );
        }
        const basis = String(opts.dateBasis ?? 'document');
        if (basis !== 'document' && basis !== 'posting') {
          throw usageError(
            `--date-basis ${basis} is not defined for a bill: a bill has a document date and, once approved, ` +
              'a posting date. Use document or posting.'
          );
        }

        let since = opts.since;
        let until = opts.until;
        if (opts.period) {
          const range = await resolvePeriodRange(ctx.entityId, opts.period);
          since = range.start_date;
          until = range.end_date;
        }

        const vendorId = opts.vendor ? (await resolveVendor(ctx.entityId, opts.vendor)).id : undefined;
        const status = opts.open
          ? ['draft', 'pending_approval', 'approved', 'posted', 'partially_paid']
          : opts.status;

        const { rows, total } = await listBills(ctx.entityId, {
          vendorId,
          status,
          startDate: since,
          endDate: until,
          dateBasis: basis as BillDateBasis,
          dueBefore: opts.dueBefore ? requireDate('--due-before', opts.dueBefore) : undefined,
          search,
          limit: opts.all ? undefined : (opts.limit ?? 50),
          offset: opts.offset,
        });

        render(rows.map(summarize), {
          ...opts,
          total,
          idField: 'bill_number',
          // Only name the default columns when there are rows to have them.
          fields: opts.fields ?? (rows.length ? LIST_COLUMNS.join(',') : undefined),
          numeric: ['total_amount', 'amount_due'],
        });
      })
  );

  // ---- bill show ---------------------------------------------------
  const show = bill
    .command('show')
    .alias('ver')
    .argument('<bill>', 'bill number, vendor invoice number or id')
    .description('Show one bill with its lines, its journal entry and its source CFDI');
  withOutput(withContext(show));
  show
    .option('--no-lines', 'header only')
    .option('--journal', 'include the journal entry approval produced')
    .option('--cfdi', 'include the CFDI this bill came from, when it came from one');
  declareRisk(show, { risk: 'lectura', agent: true });
  show.action((ref: string, opts: CommonOpts & { lines?: boolean; journal?: boolean; cfdi?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const found = await resolveBill(ctx.entityId, ref);
      const full = await getBillById(found.id, {
        includeLines: opts.lines !== false,
        includeLineAccounts: true,
        includeJournal: opts.journal === true,
        includeCfdi: opts.cfdi === true,
      });
      if (!full) throw notFound(`Bill ${ref} disappeared while reading it.`);

      const lines = (full.lines as Record<string, unknown>[] | undefined) ?? [];
      const journal = full.journal_entry as { lines?: Record<string, unknown>[] } | undefined;
      const format = opts.json ? 'json' : (opts.format ?? 'table');

      // Machine formats get one nested object; a terminal gets the tables
      // stacked, because a JSON blob is not something a person reads.
      if (format !== 'table' || opts.quiet) {
        render([full], { ...opts, idField: 'bill_number' });
        return;
      }

      // A bill has thirty columns. Side by side they are a wall; stacked as
      // field/value they are a document.
      const { lines: _l, journal_entry: _j, cfdi: _c, ...header } = full;
      render(
        Object.entries(header).map(([field, value]) => ({
          field,
          // Calendar dates lose their spurious midnight; timestamps keep theirs.
          value: /_date$/.test(field) ? dateOnly(value) : (value ?? ''),
        })),
        { format: 'table', idField: 'field' }
      );

      if (lines.length) {
        process.stderr.write(deps.palette.dim('\nLines\n'));
        render(
          lines.map((l) => ({
            line: l.line_number,
            account: l.account_code ?? l.account_id,
            account_name: l.account_name ?? '',
            description: l.description ?? '',
            quantity: l.quantity, unit_price: l.unit_price, line_amount: l.line_amount,
            tax_amount: l.tax_amount, total_amount: l.total_amount,
          })),
          { format: 'table', idField: 'line' }
        );
      }
      if (journal?.lines?.length) {
        process.stderr.write(deps.palette.dim('\nJournal entry\n'));
        render(journal.lines, { format: 'table', idField: 'line_number' });
      }
      if (opts.cfdi) {
        const cfdi = (full.cfdi as Record<string, unknown>[] | undefined) ?? [];
        process.stderr.write(deps.palette.dim('\nCFDI\n'));
        if (cfdi.length) render(cfdi, { format: 'table', idField: 'cfdi_uuid' });
        else process.stderr.write(deps.palette.dim('  None: this bill was not captured from an XML.\n'));
      }
    })
  );

  // ---- bill create -------------------------------------------------
  const create = bill
    .command('create')
    .alias('crear')
    .argument('[vendor]', 'vendor number, name or id')
    .description('Capture a vendor bill with its lines and their account coding');
  withContext(create);
  create
    .option('--vendor <ref>', 'vendor number, name or id (same as the positional argument)')
    .option('--vendor-invoice-number <text>', "the vendor's own invoice number or folio")
    .option('--bill-date <date>', 'document date (YYYY-MM-DD); defaults to today')
    .option('--due-date <date>', "due date (YYYY-MM-DD); defaults to the vendor's terms")
    .option(
      '--line <spec...>',
      `one line, repeatable: "${LINE_KEYS.slice(0, 5).join('=…,')}=…". Account is a code from the chart`
    )
    .option('--currency <code>', "3-letter ISO code; defaults to the vendor's currency")
    .option('--terms <text>', 'payment terms recorded on the bill; defaults to the vendor terms')
    .option('--description <text>', 'what this bill is for')
    .option('--from-file <path>', 'read the bill as JSON instead: { lines: [...], ... }')
    .option('--json', 'JSON output');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'bills, bill_lines' });
  create.action(
    (
      positional: string | undefined,
      opts: CommonOpts & {
        vendor?: string; vendorInvoiceNumber?: string; billDate?: string; dueDate?: string;
        line?: string[]; currency?: string; terms?: string; description?: string; fromFile?: string;
      }
    ) =>
      run(async () => {
        // Tenant FIRST: entity resolution is itself scoped by RLS, so a
        // --tenant applied afterwards resolves nothing.
        bootstrapTenant(opts.tenant);
        const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });

        const fromFile = opts.fromFile ? readBillFile(opts.fromFile) : {};
        const vendorRef = positional ?? opts.vendor ?? (fromFile.vendor as string | undefined);
        if (!vendorRef) throw usageError('Which vendor? Pass it as the argument or with --vendor.');
        const vendorRow = await resolveVendor(ctx.entityId, vendorRef);

        const specs = [...(opts.line ?? []), ...((fromFile.lines as unknown[] | undefined) ?? [])];
        if (specs.length === 0) {
          throw usageError(
            'A bill needs at least one line: --line "account=5100,qty=1,price=1000,tax=160".'
          );
        }

        const lines: BillLineInput[] = [];
        for (const spec of specs) {
          const parsed = typeof spec === 'string' ? parseLineSpec(spec) : (spec as Record<string, string>);
          const unknown = Object.keys(parsed).filter((k) => !LINE_KEYS.includes(k));
          if (unknown.length) {
            throw usageError(
              `Unknown key(s) in --line: ${unknown.join(', ')}. Known keys: ${LINE_KEYS.join(', ')}.`
            );
          }
          const accountRef = parsed.account;
          if (!accountRef) throw usageError('Every line needs account=<code>: a line with no account cannot be posted.');
          const price = parsed.price ?? parsed['unit-price'];
          if (price === undefined) throw usageError(`Line "account=${accountRef}" has no price=<amount>.`);

          const account = await resolveAccount(ctx.entityId, accountRef);
          lines.push({
            account_id: account.id,
            description: parsed.description ?? null,
            quantity: parsed.qty ?? parsed.quantity ?? '1',
            unit_price: price,
            tax_amount: parsed.tax ?? '0',
            cost_center_id: parsed['cost-center'] ?? null,
            project_id: parsed.project ?? null,
          });
        }

        const billDate = opts.billDate
          ? requireDate('--bill-date', opts.billDate)
          : ((fromFile.bill_date as string | undefined) ?? new Date().toISOString().slice(0, 10));
        const terms = opts.terms ?? (fromFile.terms as string | undefined) ?? vendorRow.payment_terms;
        const dueDate =
          (opts.dueDate ? requireDate('--due-date', opts.dueDate) : undefined) ??
          (fromFile.due_date as string | undefined) ??
          dueDateFrom(billDate, terms) ??
          undefined;
        if (!dueDate) {
          throw usageError(
            `No due date, and "${terms}" implies none. Pass --due-date, or set terms a due date can be ` +
              'computed from with `vendor terms set`.'
          );
        }

        // The arithmetic is shown before it is written: a bill whose total
        // surprises the person typing it should not reach the database.
        const computed = computeBill(lines);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const created = await createBill({
          entity_id: ctx.entityId,
          vendor_id: vendorRow.id,
          created_by: reviewer.userId,
          bill_date: billDate,
          due_date: dueDate,
          lines,
          vendor_invoice_number:
            opts.vendorInvoiceNumber ?? (fromFile.vendor_invoice_number as string | undefined) ?? null,
          currency_code: opts.currency ?? (fromFile.currency_code as string | undefined) ?? vendorRow.currency_code,
          terms,
          description: opts.description ?? (fromFile.description as string | undefined) ?? null,
        });

        if (opts.json) {
          render([created as unknown as Record<string, unknown>], { json: true });
          return;
        }
        process.stdout.write(
          `${deps.palette.green('✔')} ${deps.palette.bold(created.bill_number)} ` +
            `${vendorRow.company_name} ${deps.palette.dim(
              `· ${computed.subtotal} + ${computed.tax_amount} tax = ${computed.total_amount} ${created.currency_code} · due ${dueDate}`
            )}\n`
        );
        process.stderr.write(
          deps.palette.dim('  Status draft: nothing is in the ledger until `bill approve`.\n')
        );
      })
  );

  // ---- bill line set -----------------------------------------------
  const line = bill.command('line').alias('linea').description('Line coding');
  const lineSet = line
    .command('set')
    .alias('fijar')
    .argument('<bill>', 'bill number, vendor invoice number or id')
    .description('Re-code one line of a bill that has not been approved yet');
  withContext(lineSet);
  lineSet
    .requiredOption('--line <n>', 'line number to change')
    .option('--account <code>', 'expense account, by code')
    .option('--cost-center <id>', 'cost center id')
    .option('--project <id>', 'project id')
    .option('--description <text>', 'line description');
  declareRisk(lineSet, { risk: 'escritura', agent: false, writes: 'bill_lines' });
  lineSet.action(
    (
      ref: string,
      opts: CommonOpts & { line: string; account?: string; costCenter?: string; project?: string; description?: string }
    ) =>
      run(async () => {
        const ctx = await entityOf(opts);
        const lineNumber = Number(opts.line);
        if (!Number.isInteger(lineNumber) || lineNumber < 1) {
          throw usageError(`--line must be a line number; got "${opts.line}".`);
        }
        const target = await resolveBill(ctx.entityId, ref);
        const accountId = opts.account ? (await resolveAccount(ctx.entityId, opts.account)).id : undefined;

        const { line: updated } = await setBillLine(target.id, lineNumber, {
          ...(accountId !== undefined ? { account_id: accountId } : {}),
          ...(opts.costCenter !== undefined ? { cost_center_id: opts.costCenter } : {}),
          ...(opts.project !== undefined ? { project_id: opts.project } : {}),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
        });

        process.stdout.write(
          `${deps.palette.green('✔')} ${target.bill_number} line ${updated.line_number} recoded ` +
            `${deps.palette.dim(`(${updated.total_amount})`)}\n`
        );
      })
  );

  // ---- bill approve ------------------------------------------------
  const approve = bill
    .command('approve')
    .alias('aprobar')
    .argument('<bill>', 'bill number, vendor invoice number or id')
    .description('Approve a bill and recognize the liability in the ledger (DR expense + IVA / CR payables)');
  withContext(approve);
  // irreversible ⇒ the kernel adds --dry-run, --yes and --idempotency-key,
  // and refuses at startup to let the agent invoke this.
  declareRisk(approve, { risk: 'irreversible', agent: false, writes: 'bills.status, journal_entries' });
  approve.action(
    (ref: string, opts: CommonOpts & { dryRun?: boolean; yes?: boolean; idempotencyKey?: string }) =>
      run(async () => {
        // Tenant FIRST: entity resolution is itself scoped by RLS, so a
        // --tenant applied afterwards resolves nothing.
        bootstrapTenant(opts.tenant);
        const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });

        const target = await resolveBill(ctx.entityId, ref);
        if (!(APPROVABLE_STATUSES as readonly string[]).includes(target.status)) {
          throw blockedByState(
            `Bill ${target.bill_number} is "${target.status}", not ${APPROVABLE_STATUSES.join(' or ')}. ` +
              (target.journal_entry_id
                ? 'It is already in the ledger; reversing it is `bill reverse`, which has no backend yet.'
                : 'Only a bill still being worked on can be approved.')
          );
        }
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        // The preview and the real thing are the same code path; only the
        // commit differs. Anything the engine would refuse — a closed
        // period, a missing account role, an unbalanced entry — is refused
        // here too, before anyone is asked to confirm.
        const preview = await approveBill(target.id, reviewer.userId, {
          entityId: ctx.entityId,
          dryRun: true,
        }).catch((err: unknown) => {
          throw asLedgerRefusal(err, target.bill_number);
        });
        printEntry(preview, deps.palette, target.bill_number);

        if (opts.dryRun) {
          process.stderr.write(deps.palette.dim('Dry run: nothing was written.\n'));
          return;
        }

        if (!opts.yes) {
          const question =
            `Post ${target.bill_number} (${target.total_amount} ${target.currency_code}) to the ledger of ` +
            `${ctx.entityName}? This cannot be undone.`;
          if (!stdin.isTTY && !deps.confirm) {
            throw abortedByUser(
              'This posts to the ledger and there is no terminal to confirm at. ' +
                'Re-run with --yes when you mean it, or with --dry-run to see the entry.'
            );
          }
          if (!(await ask(question))) throw abortedByUser();
        }

        const result = await approveBill(target.id, reviewer.userId, { entityId: ctx.entityId })
          .catch((err: unknown) => { throw asLedgerRefusal(err, target.bill_number); });
        if (result.attestation) {
          attestEntryAsync(ctx.tenantId, result.attestation.entityId, result.attestation.entryId);
        }

        process.stdout.write(
          `${deps.palette.green('✔')} ${deps.palette.bold(target.bill_number)} approved` +
            (result.entry
              ? ` · entry ${deps.palette.bold(result.entry.entry_number)} posted ${dateOnly(result.entry.entry_date)}`
              : ' · no entry: it was already posted') +
            '\n'
        );
        if (opts.idempotencyKey) {
          process.stderr.write(
            deps.palette.dim(
              '  --idempotency-key was not needed: approval is idempotent behind the bill status and its journal_entry_id.\n'
            )
          );
        }
      })
  );
}

/**
 * A closed or locked period is not a validation failure, it is a state that
 * blocks the write — exit 5, per the exit-code contract. The posting engine
 * only knows HTTP 422, so the translation happens here, where the state is
 * known.
 */
function asLedgerRefusal(err: unknown, billNumber: string): unknown {
  const code = (err as { code?: string } | null)?.code;
  if (code === ErrorCodes.PERIOD_CLOSED) {
    return blockedByState(
      `${billNumber} cannot be posted: ${(err as Error).message}. ` +
        'Its bill date falls in a period that is closed or locked. Reopen the period, or post it ' +
        'in an open one once `bill edit` exists to move the date.'
    );
  }
  if (code === 'MISSING_ROLE_ACCOUNT') {
    return blockedByState(
      `${billNumber} cannot be posted: ${(err as Error).message}`
    );
  }
  return err;
}

/** Reads --from-file, tolerating the `@file.json` spelling the catalog uses. */
function readBillFile(path: string): Record<string, unknown> {
  const clean = path.startsWith('@') ? path.slice(1) : path;
  let text: string;
  try {
    text = readFileSync(clean, 'utf-8');
  } catch {
    throw usageError(`Cannot read --from-file "${clean}".`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw usageError(`--from-file "${clean}" is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw usageError(`--from-file "${clean}" must contain a JSON object with a "lines" array.`);
  }
  return parsed as Record<string, unknown>;
}

function printEntry(
  result: { entry: { entry_number: string; entry_date: Date | string } | null; entryLines: Array<Record<string, unknown>> },
  p: Palette,
  billNumber: string
): void {
  if (!result.entry) {
    process.stderr.write(p.yellow(`${billNumber} produces no journal entry (already posted, or a zero total).\n`));
    return;
  }
  process.stderr.write(
    p.dim(`\nEntry ${result.entry.entry_number} · ${dateOnly(result.entry.entry_date)}\n`)
  );
  render(result.entryLines, { format: 'table', idField: 'line_number' });
}
