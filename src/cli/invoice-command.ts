import * as readline from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import Decimal from 'decimal.js';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { resolveAccount } from '../services/accounting/account-service.js';
import { resolvePeriod } from '../services/accounting/fiscal-calendar-service.js';
import { attestEntryAsync } from '../services/accounting/posting.js';
import { resolveCustomer, customerLabel } from '../services/ar/customer-service.js';
import {
  listInvoices,
  getInvoiceById,
  resolveInvoice,
  createInvoice,
  issueInvoice,
  voidInvoice,
  listEntitySequences,
  type InvoiceLineInput,
} from '../services/ar/invoice-service.js';
import { InvoiceStatus } from '../types/index.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  gateMutation,
  render,
  resolveFormat,
  withContext,
  withOutput,
  withSelection,
  withTime,
  resolveActiveEntity,
  requireExplicitEntity,
  usageError,
  notFound,
  validationFailed,
  blockedByState,
  abortedByUser,
  exitCodeFor,
} from './kernel/index.js';

// ============================================================
// mnemosine invoice · factura
// Customer invoices from the terminal, on top of
// services/ar/invoice-service.ts — the same path the REST API takes.
//
// WHAT THIS FAMILY DOES NOT DO: it does not stamp, it does not cancel
// before the SAT, and it does not send anything to anyone. An invoice
// created here is a LOCAL document; in Mexico it becomes a CFDI only
// when the fiscal family stamps it with a PAC. Every command below says
// so in its own description, because "created the invoice" and "issued
// the CFDI" are two very different claims to make to a tax authority.
//
// `issue` and `void` reach the general ledger, so they are irreversible
// by the kernel's definition and can never be agent-invoked — declareRisk
// throws at startup if anyone tries. `create` only produces a draft, but
// a draft in `invoices` is not a review queue, so it is not agent-invoked
// either: the catalog's IA ✓ predates the kernel's draftOnly rule.
// ============================================================

export interface InvoiceCommandDeps {
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
  period?: string;
  since?: string;
  until?: string;
  asOf?: string;
  dateBasis?: string;
  dryRun?: boolean;
  yes?: boolean;
  reason?: string;
  idempotencyKey?: string;
}

const LIST_COLUMNS = [
  'invoice_number', 'invoice_date', 'due_date', 'customer_name',
  'status', 'total_amount', 'amount_due', 'cfdi_status',
] as const;

const MONEY = ['total_amount', 'subtotal', 'tax_amount', 'amount_paid', 'amount_due', 'amount_due_as_of'];

const INVOICE_STATUSES = Object.values(InvoiceStatus) as string[];

const pad = (n: number) => String(n).padStart(2, '0');

/** A DATE column arrives as a local-midnight Date; print the calendar day. */
export function day(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return value === null || value === undefined ? '' : String(value);
}

function summarize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    invoice_number: row.invoice_number,
    invoice_date: day(row.invoice_date),
    due_date: day(row.due_date),
    customer_name: row.customer_name ?? '',
    status: row.status,
    currency_code: row.currency_code,
    // Money stays a decimal STRING all the way out (output contract).
    total_amount: row.total_amount,
    amount_paid: row.amount_paid,
    amount_due: row.amount_due,
    ...(row.amount_due_as_of !== undefined ? { amount_due_as_of: row.amount_due_as_of } : {}),
    ...(row.days_overdue !== undefined ? { days_overdue: row.days_overdue } : {}),
    cfdi_status: row.cfdi_status ?? '',
    id: row.id,
  };
}

function isHumanTable(opts: CommonOpts): boolean {
  return !opts.quiet && !opts.output && resolveFormat(opts) === 'table';
}

/**
 * One `--line` spec: `key=value` pairs separated by semicolons, because a
 * description with a comma in it is normal and a description with a semicolon
 * in it is not.
 *
 *   --line "account=4100;qty=2;price=1500;tax=16;description=Consulting, July"
 */
export function parseInvoiceLine(spec: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of spec.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) {
      throw usageError(
        `Cannot read the line "${spec}". Expected key=value pairs separated by ";", ` +
          'for example: --line "account=4100;qty=2;price=1500;tax=16;description=Consulting".'
      );
    }
    fields[trimmed.slice(0, eq).trim().toLowerCase()] = trimmed.slice(eq + 1).trim();
  }
  if (!fields.account) throw usageError(`Line "${spec}" has no account=<code>.`);
  if (!fields.price) throw usageError(`Line "${spec}" has no price=<amount>.`);
  return fields;
}

/**
 * "Net 30" and friends. Payment terms are free text in this schema
 * (002_ap_ar_schema.sql:159), so only the forms that actually appear are
 * read; anything else means the caller must give an explicit --due-date
 * rather than have a date invented for them.
 */
export function dueDateFromTerms(terms: string | null | undefined, invoiceDate: string): string | null {
  const match = /^\s*(?:net|neto)\s*[- ]?\s*(\d{1,3})\s*$/i.exec(terms ?? '');
  if (!match) return null;
  const base = new Date(`${invoiceDate}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + Number(match[1]));
  return base.toISOString().slice(0, 10);
}

export function registerInvoiceCommand(program: Command, deps: InvoiceCommandDeps): void {
  const invoice = program
    .command('invoice')
    .alias('factura')
    .description('Customer invoices: draft, inspect, issue to the ledger and void (never stamped here)');

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

  const writeEntityOf = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    return requireExplicitEntity(
      { entity: opts.entity },
      { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
    );
  };

  /**
   * An irreversible act needs a human yes. Without a terminal there is nobody
   * to ask, so the command refuses instead of assuming consent.
   */
  const confirmOrAbort = async (opts: CommonOpts, question: string): Promise<void> => {
    if (opts.yes) return;
    if (deps.confirm) {
      if (await deps.confirm(question)) return;
      throw abortedByUser();
    }
    if (!process.stdin.isTTY) {
      throw abortedByUser(
        `${question} — there is no terminal to ask on. Re-run with --yes once you are sure, ` +
          'or with --dry-run to see the effect first.'
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

  // ---- invoice list ------------------------------------------------
  const list = invoice
    .command('list')
    .alias('listar')
    .argument('[search]', 'text to match in the invoice number or the customer name')
    .description('List invoices by customer, state, period or days past due');
  withOutput(withSelection(withTime(withContext(list))));
  list
    .option('--customer <ref>', 'only this customer (number, name or id)')
    .option('--overdue-days <n>', 'only open invoices at least this many days past due');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action((search: string | undefined, opts: CommonOpts & { customer?: string; overdueDays?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);

      for (const state of opts.status ?? []) {
        if (!INVOICE_STATUSES.includes(state)) {
          throw usageError(`Unknown --status "${state}". Use one of: ${INVOICE_STATUSES.join(', ')}.`);
        }
      }
      if (opts.dateBasis === 'value') {
        throw usageError(
          '--date-basis value is not available on an invoice: the value date belongs to the cash ' +
            'that settles it, not to the document. Use --date-basis document or posting.'
        );
      }
      if (opts.period && (opts.since || opts.until)) {
        throw usageError('Use --period or --since/--until, not both.');
      }

      let since = opts.since;
      let until = opts.until;
      if (opts.period) {
        const period = await resolvePeriod(ctx.entityId, opts.period);
        since = day(period.start_date);
        until = day(period.end_date);
      }

      let overdueDays: number | undefined;
      if (opts.overdueDays !== undefined) {
        overdueDays = Number(opts.overdueDays);
        if (!Number.isSafeInteger(overdueDays) || overdueDays < 0) {
          throw usageError(`--overdue-days must be a non-negative whole number; got "${opts.overdueDays}".`);
        }
      }

      const customerId = opts.customer
        ? (await resolveCustomer(ctx.entityId, opts.customer)).id
        : undefined;

      const { rows, total } = await listInvoices(ctx.entityId, {
        search,
        customerId,
        statuses: opts.status?.length ? opts.status : undefined,
        since,
        until,
        asOf: opts.asOf,
        overdueDays,
        dateBasis: opts.dateBasis === 'document' ? 'document' : 'posting',
        withAging: true,
        limit: opts.all ? undefined : (opts.limit ?? 50),
        offset: opts.offset,
      });

      // The columns a dated question asks for are shown without being asked
      // for twice: --as-of brings the reconstructed balance, --overdue-days
      // brings the age. Otherwise the answer would omit what was asked.
      const columns = [
        ...LIST_COLUMNS,
        ...(opts.asOf ? ['amount_due_as_of'] : []),
        ...(overdueDays !== undefined ? ['days_overdue'] : []),
      ];

      render((rows as unknown as Record<string, unknown>[]).map(summarize), {
        ...opts,
        total,
        idField: 'invoice_number',
        numeric: [...MONEY, 'days_overdue'],
        fields: opts.fields ?? columns.join(','),
      });
    })
  );

  // ---- invoice show ------------------------------------------------
  const show = invoice
    .command('show')
    .alias('ver')
    .argument('<ref>', 'invoice number (INV-2026-00042) or id')
    .description('Show one invoice with its lines, the cash applied and its ledger entry');
  withOutput(withContext(show));
  declareRisk(show, { risk: 'lectura', agent: true });
  show.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const found = await resolveInvoice(ctx.entityId, ref);
      const full = await getInvoiceById(found.id, {
        includeLines: true,
        includeAllocations: true,
        includeLedger: true,
      });
      if (!full) throw notFound(`Invoice ${ref} disappeared while reading it.`);

      const lines = (full.lines as Record<string, unknown>[]) ?? [];
      const allocations = (full.payment_allocations as Record<string, unknown>[]) ?? [];

      if (!isHumanTable(opts)) {
        render([full], { ...opts, idField: 'invoice_number', numeric: MONEY });
        return;
      }

      const p = deps.palette;
      const out = process.stdout;
      out.write(
        `\n${p.bold(String(full.invoice_number))} ${p.dim(String(full.status))}  ` +
          `${full.customer_name ?? ''}\n`
      );
      const fact = (label: string, value: unknown) => {
        if (value === null || value === undefined || value === '') return;
        out.write(`  ${p.dim(label.padEnd(18))}${day(value)}\n`);
      };
      fact('Invoice date', full.invoice_date);
      fact('Due date', full.due_date);
      fact('Subtotal', full.subtotal);
      fact('Tax', full.tax_amount);
      fact('Total', `${full.total_amount} ${full.currency_code}`);
      fact('Paid', full.amount_paid);
      fact('Due', full.amount_due);
      fact('PO', full.po_number);
      fact('Memo', full.memo);
      fact(
        'Ledger entry',
        full.journal_entry_number
          ? `${full.journal_entry_number} (${full.journal_entry_status})`
          : p.dim('not posted — run `invoice issue`')
      );
      fact(
        'CFDI',
        full.cfdi_uuid
          ? `${full.cfdi_uuid} (${full.cfdi_status})`
          : p.dim('not stamped — this is a local document')
      );

      out.write(`\n${p.bold('Lines')} ${p.dim(`(${lines.length})`)}\n`);
      if (lines.length) {
        render(
          lines.map((line) => ({
            line: line.line_number,
            description: line.description,
            qty: line.quantity,
            unit_price: line.unit_price,
            tax_rate: line.tax_rate ?? '',
            line_amount: line.line_amount,
            total: line.total_amount,
          })),
          { format: 'table', numeric: ['qty', 'unit_price', 'tax_rate', 'line_amount', 'total'] }
        );
      }

      out.write(`\n${p.bold('Cash applied')} ${p.dim(`(${allocations.length})`)}\n`);
      if (allocations.length) {
        render(
          allocations.map((row) => ({
            payment: row.payment_number,
            date: day(row.payment_date),
            method: row.payment_method,
            status: row.payment_status,
            applied: row.amount_applied,
          })),
          { format: 'table', numeric: ['applied'] }
        );
      }
      out.write('\n');
    })
  );

  // ---- invoice create ----------------------------------------------
  const create = invoice
    .command('create')
    .alias('crear')
    .description('Create a DRAFT invoice from scratch: a local document, neither posted nor stamped');
  withContext(create);
  create
    .requiredOption('--customer <ref>', 'customer number, name or id')
    .option('--line <spec...>', 'a line: "account=4100;qty=2;price=1500;tax=16;description=…"')
    .option('--from-file <path>', 'JSON array of lines instead of repeated --line')
    .option('--date <date>', 'invoice date (YYYY-MM-DD); defaults to today')
    .option('--due-date <date>', "due date; defaults to the customer's payment terms")
    .option('--currency <code>', "billing currency; defaults to the customer's")
    .option('--terms <text>', 'payment terms printed on the document')
    .option('--memo <text>', 'memo')
    .option('--po-number <text>', 'the customer purchase order this bills against')
    .option('--json', 'JSON output');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'invoices + invoice_lines (draft)' });
  create.action(
    (
      opts: CommonOpts & {
        customer: string; line?: string[]; fromFile?: string;
        date?: string; dueDate?: string; currency?: string;
        terms?: string; memo?: string; poNumber?: string;
      }
    ) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);
        const customer = await resolveCustomer(ctx.entityId, opts.customer);

        if (!customer.is_active) {
          throw blockedByState(
            `${customer.customer_number} is archived. Restore it with \`customer restore\` before billing it.`
          );
        }

        const specs = [
          ...(opts.line ?? []),
          ...(opts.fromFile ? readLineFile(opts.fromFile) : []),
        ];
        if (specs.length === 0) {
          throw usageError(
            'An invoice needs at least one line: pass --line "account=<code>;qty=<n>;price=<amount>" ' +
              '(repeatable) or --from-file <path>.'
          );
        }

        const invoiceDate = opts.date ?? new Date().toISOString().slice(0, 10);
        const dueDate = opts.dueDate ?? dueDateFromTerms(customer.payment_terms, invoiceDate);
        if (!dueDate) {
          throw usageError(
            `Cannot derive a due date from this customer's terms ("${customer.payment_terms}"). ` +
              'Pass --due-date <YYYY-MM-DD>.'
          );
        }
        if (dueDate < invoiceDate) {
          throw usageError(`--due-date ${dueDate} falls before the invoice date ${invoiceDate}.`);
        }

        const lines: InvoiceLineInput[] = [];
        for (const spec of specs) {
          const fields = parseInvoiceLine(spec);
          const account = await resolveAccount(ctx.entityId, fields.account);
          if (account.account_type !== 'revenue' && account.account_type !== 'contra_asset') {
            process.stderr.write(
              deps.palette.yellow(
                `Note: ${account.code} ${account.name} has type "${account.account_type}", not revenue.\n`
              )
            );
          }
          lines.push({
            revenue_account_id: account.id,
            description: fields.description ?? account.name,
            quantity: fields.qty ?? fields.quantity ?? '1',
            unit_price: fields.price ?? fields.unit_price,
            tax_rate: fields.tax ?? fields.tax_rate ?? null,
            tax_code: fields['tax-code'] ?? null,
            cost_center_id: fields['cost-center'] ?? null,
            project_id: fields.project ?? null,
          });
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const created = await createInvoice({
          entity_id: ctx.entityId,
          customer_id: customer.id,
          invoice_date: invoiceDate,
          due_date: dueDate,
          currency_code: opts.currency ? opts.currency.toUpperCase() : customer.currency_code,
          lines,
          terms: opts.terms ?? customer.payment_terms,
          memo: opts.memo ?? null,
          po_number: opts.poNumber ?? null,
          created_by: reviewer.userId,
        });

        if (opts.json) {
          render([created as unknown as Record<string, unknown>], { json: true });
          return;
        }
        const p = deps.palette;
        process.stdout.write(
          `${p.green('✔')} ${p.bold(created.invoice_number)} drafted for ${customerLabel(customer)} ` +
            `${p.dim(`(${created.total_amount} ${created.currency_code}, due ${day(created.due_date)})`)}\n` +
            p.dim('  Nothing was posted and nothing was stamped. Post it with `invoice issue`.\n')
        );
      })
  );

  // ---- invoice issue -----------------------------------------------
  const issue = invoice
    .command('issue')
    .alias('emitir')
    .argument('<ref>', 'invoice number or id')
    .description('Issue an invoice: post DR receivable / CR revenue / CR VAT. Does not stamp or send');
  withContext(issue);
  issue.option('--json', 'JSON output');
  // Posting to the ledger is irreversible: declareRisk adds --dry-run, --yes
  // and --idempotency-key, and refuses to let the agent near this command.
  declareRisk(issue, {
    risk: 'irreversible',
    writes: 'journal_entries + account_balances + invoices.status',
  });
  issue.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await writeEntityOf(opts);
      const target = await resolveInvoice(ctx.entityId, ref);
      const { dryRun } = gateMutation(issue, opts as Record<string, unknown>);
      const p = deps.palette;

      if (target.journal_entry_id) {
        throw blockedByState(
          `${target.invoice_number} was already issued and is in the ledger. ` +
            'Correct it with `invoice void`, which reverses the entry and leaves the trail.'
        );
      }
      if (target.status === 'void' || target.status === 'cancelled') {
        throw blockedByState(`${target.invoice_number} is ${target.status} and can never be issued.`);
      }
      if (!new Decimal(target.total_amount).greaterThan(0)) {
        throw validationFailed(
          `${target.invoice_number} totals ${target.total_amount}. An invoice with no amount posts nothing; ` +
            'add lines with `invoice edit` or void it.'
        );
      }

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

      if (!dryRun) {
        await confirmOrAbort(
          opts,
          `Post ${target.invoice_number} (${target.total_amount} ${target.currency_code}) to the ledger? This cannot be undone.`
        );
      }

      const result = await issueInvoice(target.id, reviewer.userId, {
        markSent: false,
        enforceStatusGuard: true,
        dryRun,
      });

      if (result.attest && !dryRun) attestEntryAsync(ctx.tenantId, result.attest.entityId, result.attest.entryId);

      if (opts.json) {
        render(
          [
            {
              invoice_number: result.invoice.invoice_number,
              status: result.invoice.status,
              entry_number: result.entry?.entry_number ?? null,
              total_debits: result.entry?.total_debits ?? null,
              dry_run: result.dryRun,
            },
          ],
          { json: true }
        );
        return;
      }

      const out = process.stdout;
      out.write(
        dryRun
          ? `\n${p.bold(`Would post ${target.invoice_number}`)} ${p.dim(`as ${result.entry?.entry_number ?? 'no entry'}`)}\n\n`
          : `${p.green('✔')} ${p.bold(target.invoice_number)} issued as ${result.entry?.entry_number ?? '(no entry)'}\n`
      );
      if (result.entryLines.length) {
        render(
          result.entryLines.map((line) => ({
            account: line.account_code,
            name: line.account_name,
            debit: line.debit_amount ?? '',
            credit: line.credit_amount ?? '',
          })),
          { format: 'table', numeric: ['debit', 'credit'] }
        );
      }
      out.write(
        p.dim(
          dryRun
            ? '\n  Nothing was written. Re-run without --dry-run to post it.\n'
            : '  The document is posted, not stamped and not delivered.\n'
        )
      );
    })
  );

  // ---- invoice void ------------------------------------------------
  const voidCmd = invoice
    .command('void')
    .alias('anular')
    .argument('<ref>', 'invoice number or id')
    .description('Void a local invoice and reverse its ledger entry; refuses a stamped or paid one');
  withContext(voidCmd);
  voidCmd.option('--json', 'JSON output');
  // declareRisk adds --reason for an undo verb, and gateMutation requires it.
  declareRisk(voidCmd, {
    risk: 'irreversible',
    writes: 'invoices.status + a reversing journal_entry',
  });
  voidCmd.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await writeEntityOf(opts);
      const target = await resolveInvoice(ctx.entityId, ref);
      const { dryRun, reason } = gateMutation(voidCmd, opts as Record<string, unknown>);
      const p = deps.palette;

      if (target.status === 'void') {
        throw blockedByState(`${target.invoice_number} is already void.`);
      }
      if (target.status === 'paid') {
        throw blockedByState(
          `${target.invoice_number} is paid. Unapply the cash first, or issue a credit note.`
        );
      }

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

      if (!dryRun) {
        await confirmOrAbort(
          opts,
          `Void ${target.invoice_number} (${target.total_amount} ${target.currency_code})` +
            (target.journal_entry_id ? ' and reverse its ledger entry' : '') +
            '?'
        );
      }

      const result = await voidInvoice(target.id, reviewer.userId, { reason, dryRun });
      if (result.attest && !dryRun) {
        attestEntryAsync(ctx.tenantId, result.attest.entityId, result.attest.entryId);
      }

      if (opts.json) {
        render(
          [
            {
              invoice_number: result.invoice.invoice_number,
              status: result.invoice.status,
              reversal_entry_id: result.reversalEntryId,
              dry_run: result.dryRun,
            },
          ],
          { json: true }
        );
        return;
      }
      process.stdout.write(
        (dryRun
          ? `${p.bold(`Would void ${target.invoice_number}`)}`
          : `${p.green('✔')} ${p.bold(target.invoice_number)} voided`) +
          (result.reversalEntryId
            ? p.dim(dryRun ? ' and reverse its ledger entry.' : ' and its ledger entry reversed.')
            : p.dim(' (it had never reached the ledger).')) +
          (dryRun ? p.dim(' Nothing was written.') : '') +
          '\n'
      );
    })
  );

  // ---- invoice series list -----------------------------------------
  const series = invoice
    .command('series')
    .alias('serie')
    .description('Folio series: the counters this entity draws document numbers from');

  const seriesList = series
    .command('list')
    .alias('listar')
    .description('List the folio counters, the last number issued and the next one');
  withOutput(withSelection(withContext(seriesList)));
  declareRisk(seriesList, { risk: 'lectura', agent: true });
  seriesList.action((opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      // The selection group carries --status for every list; a folio counter
      // has no lifecycle, so the flag is refused rather than ignored.
      if (opts.status?.length) {
        throw usageError(
          '`invoice series list` has no lifecycle state to filter on: a folio series is a counter, not a document.'
        );
      }
      const rows = await listEntitySequences(ctx.entityId);
      const limited = opts.all ? rows : rows.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50));
      render(
        limited.map((row) => ({
          document_type: row.document_type,
          issued: row.issued,
          last_number: row.last_number ?? '',
          next_number: row.next_number,
          updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : '',
        })),
        { ...opts, total: rows.length, idField: 'document_type', numeric: ['issued'] }
      );
    })
  );
}

/** Lines from a JSON file: an array of the same key=value fields, as objects. */
function readLineFile(path: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw usageError(`Cannot read ${path} as JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw usageError(`${path} must contain a JSON array of line objects.`);
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object') {
      throw usageError(`${path} contains a line that is not an object.`);
    }
    return Object.entries(entry as Record<string, unknown>)
      .filter(([, value]) => value !== null && value !== undefined)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(';');
  });
}
