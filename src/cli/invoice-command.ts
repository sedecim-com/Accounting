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
  updateDraftInvoice,
  deleteDraftInvoice,
  checkInvoiceSeries,
  type InvoiceLineInput,
} from '../services/ar/invoice-service.js';
import { InvoiceStatus, AccountType } from '../types/index.js';
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
  dateOnly as day,
  describeCommand,
  optionByKey,
  argumentByKey,
} from './kernel/index.js';
import { confirmarConReintento, yesNoPrompt } from './kernel/confirmacion.js';
import { addCalendarDays, calendarDateIn } from '../utils/calendar-date.js';
import { todayFor, zoneFor } from '../services/policy/today.js';
import {
  LEGACY_LINE_FORMS_RETIRE_IN,
  lineKeysHelp,
  normalizeLineRecord,
  parseKeyValueLine,
  type LineGrammar,
} from './kernel/line-spec.js';
import { t, type MessageParams, type TranslationKey } from '../i18n/index.js';

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
 * qty/quantity and price/unit-price set one field each, so a line that gives
 * both is refused. tax/tax-rate follows bill's tax/tax-amount rule instead:
 * the explicit key wins over the legacy one (resolveInvoiceTaxRate).
 */
const INVOICE_LINE_GRAMMAR: LineGrammar = {
  known: [
    'account', 'qty', 'quantity', 'price', 'unit-price', 'tax-rate', 'tax', 'tax-code',
    'description', 'cost-center', 'project',
  ],
  sameField: [['qty', 'quantity'], ['price', 'unit-price']],
};

const INVOICE_LINE_KEYS_HELP = lineKeysHelp([
  ['account', 'revenue account code (required)'],
  ['qty', 'quantity; defaults to 1'],
  ['quantity', 'same as qty'],
  ['price', 'unit price before tax (required)'],
  ['unit-price', 'same as price'],
  ['tax-rate', 'IVA RATE in percent: 16 means 16% — NOT an amount'],
  ['tax', `deprecated (warns; retired in ${LEGACY_LINE_FORMS_RETIRE_IN}): same as tax-rate`],
  ['tax-code', 'tax code of the line'],
  ['description', "the line's text; defaults to the account name"],
  ['cost-center', 'cost center id'],
  ['project', 'project id'],
]);

/** One stderr line, once per invocation, when a line used the bare `tax=`; read when printed. */
export function legacyInvoiceTaxKeyWarning(): string {
  return t('ar.invoice.line.legacy_tax_key', { version: LEGACY_LINE_FORMS_RETIRE_IN });
}

/**
 * One `--line` spec (or one object of --from-file), in the one grammar of
 * #327: `key=value` pairs separated by semicolons.
 *
 *   --line "account=4100;qty=2;price=1500;tax-rate=16;description=Consulting, July"
 *
 * Unknown keys are rejected: `tax-rate=16` used to be ignored in silence and
 * the invoice came out with 0 IVA.
 */
export function parseInvoiceLine(spec: string | Record<string, unknown>): Record<string, string> {
  const fields =
    typeof spec === 'string'
      ? parseKeyValueLine(spec, { grammar: INVOICE_LINE_GRAMMAR }).fields
      : normalizeLineRecord(spec, INVOICE_LINE_GRAMMAR);
  const label = typeof spec === 'string' ? spec : JSON.stringify(spec);
  if (!fields.account) throw usageError({ key: 'ledger.entry.line.no_account', params: { spec: label } });
  if (!(fields.price ?? fields['unit-price'])) throw usageError({ key: 'ar.invoice.line.no_price', params: { spec: label } });
  return fields;
}

/** The line's IVA rate: `tax-rate=` wins over the legacy bare `tax=`. */
export function resolveInvoiceTaxRate(fields: Record<string, string>): {
  tax_rate: string | null;
  usedLegacyTaxKey: boolean;
} {
  const explicit = fields['tax-rate'];
  return {
    tax_rate: explicit ?? fields.tax ?? null,
    usedLegacyTaxKey: explicit === undefined && fields.tax !== undefined,
  };
}

/**
 * Parses every line and resolves its account; warns once if any line used
 * the legacy `tax=`.
 */
async function invoiceLinesFrom(
  entityId: string,
  specs: Array<string | Record<string, unknown>>,
  palette: Palette,
  onAccount: (account: Awaited<ReturnType<typeof resolveAccount>>) => void = () => undefined
): Promise<InvoiceLineInput[]> {
  const lines: InvoiceLineInput[] = [];
  let legacyTax = false;
  for (const spec of specs) {
    const fields = parseInvoiceLine(spec);
    const account = await resolveAccount(entityId, fields.account);
    onAccount(account);
    const tax = resolveInvoiceTaxRate(fields);
    legacyTax ||= tax.usedLegacyTaxKey;
    lines.push({
      revenue_account_id: account.id,
      description: fields.description ?? account.name,
      quantity: fields.qty ?? fields.quantity ?? '1',
      unit_price: fields.price ?? fields['unit-price'],
      tax_rate: tax.tax_rate,
      tax_code: fields['tax-code'] ?? null,
      cost_center_id: fields['cost-center'] ?? null,
      project_id: fields.project ?? null,
    });
  }
  if (legacyTax) process.stderr.write(palette.dim(`  ${legacyInvoiceTaxKeyWarning()}\n`));
  return lines;
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
  return addCalendarDays(invoiceDate, Number(match[1]));
}

// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// The `--line` separator is the SEMICOLON in invoice, bill and entry (#327),
// and the rate is spelled `tax-rate=`, which cannot be mistaken for bill's
// `tax-amount=`: the H3 gap. Every example is written out in full instead of
// pointing at another command.
//
// Las cuentas son códigos del catálogo base real (chart-seed.ts): 4100
// Ventas, 4200 Ingresos por Servicios. Prosa en inglés (idioma del nodo),
// datos mexicanos.
// ============================================================
const EJEMPLOS = {
  list: `
Examples:
  # Open invoices of one customer that are at least 30 days past due.
  mnemosine invoice list --customer "Grupo Alameda" --overdue-days 30
  # Everything sent in July 2026, as CSV.
  mnemosine invoice list --period 2026-07 --status sent --format csv
`,
  show: `
Examples:
  # The invoice with its lines, the cash applied and its ledger entry.
  mnemosine invoice show INV-2026-00042
  # As JSON, for a script that reads amount_due.
  mnemosine invoice show INV-2026-00042 --json
`,
  create: `
Examples:
  # One service line at 16% IVA. Inside --line the pairs are separated by
  # SEMICOLONS, and tax-rate= is a RATE in percent — 16 means 16%, not 16 pesos.
  mnemosine invoice create --customer "Grupo Alameda" --date 2026-07-15 --line "account=4200;qty=1;price=85000.00;tax-rate=16;description=Servicios contables julio"
  # Goods and services on one document, against the customer's purchase order.
  mnemosine invoice create --customer "Grupo Alameda" --po-number OC-2026-118 --line "account=4100;qty=10;price=1250.00;tax-rate=16" --line "account=4200;qty=1;price=32000.00;tax-rate=16"
`,
  issue: `
Examples:
  # Post DR receivable / CR revenue / CR IVA. It does not stamp and does not send.
  mnemosine invoice issue INV-2026-00042
  # See the entry it would post, writing nothing.
  mnemosine invoice issue INV-2026-00042 --dry-run
`,
  void: `
Examples:
  # Void a local invoice and reverse its ledger entry. --reason is required.
  mnemosine invoice void INV-2026-00042 --reason "Emitida al cliente equivocado"
  # See what would be reversed before deciding.
  mnemosine invoice void INV-2026-00042 --dry-run
`,
  edit: `
Examples:
  # Move the due date of a DRAFT and correct its memo.
  mnemosine invoice edit INV-2026-00043 --due-date 2026-08-30 --memo "Vence a 45 dias por convenio"
  # Replace ALL the lines of the draft: what you pass IS the invoice.
  mnemosine invoice edit INV-2026-00043 --line "account=4200;qty=1;price=92000.00;tax-rate=16"
`,
  delete: `
Examples:
  # Delete a DRAFT that never reached the ledger; the folio stays as an explained gap.
  mnemosine invoice delete INV-2026-00043 --reason "Capturada por duplicado"
  # See the gap it would leave, writing nothing.
  mnemosine invoice delete INV-2026-00043 --dry-run
`,
  seriesList: `
Examples:
  # Each folio counter, the last number issued and the next one.
  mnemosine invoice series list
  # The same, as JSON, for the numbering audit.
  mnemosine invoice series list --json
`,
  seriesCheck: `
Examples:
  # Report the gaps in the folio series; an explained gap is not a finding.
  mnemosine invoice series check
  # Only fiscal 2026, and fail (exit 4) even when every gap is explained.
  mnemosine invoice series check --year 2026 --strict
`,
} as const;

export function registerInvoiceCommand(program: Command, deps: InvoiceCommandDeps): void {
  const invoice = describeCommand(program.command('invoice').alias('factura'), 'help.invoice.description');

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
  const confirmOrAbort = async (opts: CommonOpts, question: { key: TranslationKey; params: MessageParams }): Promise<void> => {
    if (opts.yes) return;
    const asked = t(question.key, question.params);
    if (deps.confirm) {
      if (await deps.confirm(asked)) return;
      throw abortedByUser();
    }
    if (!process.stdin.isTTY) {
      throw abortedByUser({ key: 'ap.payment.confirm.no_terminal', params: { question } });
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    try {
      const veredicto = await confirmarConReintento(
        (p) => rl.question(p).catch(() => null),
        yesNoPrompt(asked)
      );
      if (veredicto.si) return;
      // The reason nests as the key `noEntendi` renders, so the refusal reads in one language.
      throw abortedByUser(
        veredicto.incomprendida !== undefined
          ? { key: 'ar.confirm.aborted', params: { reason: { key: 'confirm_answer_not_understood', params: { answer: veredicto.incomprendida } } } }
          : undefined
      );
    } finally {
      rl.close();
    }
  };

  // ---- invoice list ------------------------------------------------
  const list = describeCommand(invoice.command('list').alias('listar'), 'help.invoice.list.description');
  argumentByKey(list, '[search]', 'help.invoice.list.argument.search');
  withOutput(withSelection(withTime(withContext(list))));
  optionByKey(list, '--customer <ref>', 'help.invoice.list.option.customer');
  optionByKey(list, '--overdue-days <n>', 'help.invoice.list.option.overdue_days');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EJEMPLOS.list);
  list.action((search: string | undefined, opts: CommonOpts & { customer?: string; overdueDays?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);

      for (const state of opts.status ?? []) {
        if (!INVOICE_STATUSES.includes(state)) {
          throw usageError({ key: 'ledger.period.status_unknown', params: { value: state, statuses: INVOICE_STATUSES.join(', ') } });
        }
      }
      if (opts.dateBasis === 'value') {
        throw usageError({ key: 'ar.invoice.list.date_basis_value' });
      }
      if (opts.period && (opts.since || opts.until)) {
        throw usageError({ key: 'ar.invoice.list.period_or_range' });
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
          throw usageError({ key: 'cli.flag.error_not_whole_number', params: { name: '--overdue-days', value: opts.overdueDays } });
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
  const show = describeCommand(invoice.command('show').alias('ver'), 'help.invoice.show.description');
  argumentByKey(show, '<ref>', 'help.invoice.show.argument.ref');
  withOutput(withContext(show));
  declareRisk(show, { risk: 'lectura', agent: true });
  show.addHelpText('after', EJEMPLOS.show);
  show.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const found = await resolveInvoice(ctx.entityId, ref);
      const full = await getInvoiceById(found.id, {
        includeLines: true,
        includeAllocations: true,
        includeLedger: true,
      });
      if (!full) throw notFound({ key: 'ar.invoice.show.disappeared', params: { ref } });

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
      // Subtotal, Total and CFDI read the same in Spanish. The labels pad to the longest
      // one (18 at least, the English width), so the column lines up in every language.
      const facts: Array<[string, unknown]> = [
        [t('ar.invoice.show.invoice_date'), full.invoice_date],
        [t('ar.invoice.show.due_date'), full.due_date],
        ['Subtotal', full.subtotal],
        [t('ar.invoice.show.tax'), full.tax_amount],
        ['Total', `${full.total_amount} ${full.currency_code}`],
        [t('ar.invoice.show.paid'), full.amount_paid],
        [t('ar.invoice.show.due'), full.amount_due],
        [t('ar.invoice.show.po'), full.po_number],
        [t('ar.invoice.show.memo'), full.memo],
        [t('ar.invoice.show.ledger_entry'), full.journal_entry_number
          ? `${full.journal_entry_number} (${full.journal_entry_status})`
          : p.dim(t('ar.invoice.show.not_posted', { command: 'invoice issue' }))],
        ['CFDI', full.cfdi_uuid ? `${full.cfdi_uuid} (${full.cfdi_status})` : p.dim(t('ar.invoice.show.not_stamped'))],
      ];
      const width = Math.max(18, ...facts.map(([label]) => label.length + 1));
      for (const [label, value] of facts) {
        if (value === null || value === undefined || value === '') continue;
        out.write(`  ${p.dim(label.padEnd(width))}${day(value)}\n`);
      }

      out.write(`\n${p.bold(t('ar.invoice.show.lines'))} ${p.dim(`(${lines.length})`)}\n`);
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

      out.write(`\n${p.bold(t('ar.invoice.show.cash_applied'))} ${p.dim(`(${allocations.length})`)}\n`);
      if (allocations.length) {
        render(
          allocations.map((row) => ({
            payment: row.payment_number,
            date: day(row.payment_date),
            method: row.payment_method,
            status: row.payment_status,
            applied: row.amount_applied,
            isr_withheld: row.withholding_isr_amount,
            vat_withheld: row.withholding_iva_amount,
          })),
          { format: 'table', numeric: ['applied', 'isr_withheld', 'vat_withheld'] }
        );
      }
      out.write('\n');
    })
  );

  // ---- invoice create ----------------------------------------------
  const create = describeCommand(invoice.command('create').alias('crear'), 'help.invoice.create.description');
  withContext(create);
  optionByKey(create, '--customer <ref>', 'help.invoice.create.option.customer', { mandatory: true });
  optionByKey(create, '--line <spec...>', 'help.invoice.create.option.line');
  optionByKey(create, '--from-file <path>', 'help.invoice.create.option.from_file');
  optionByKey(create, '--date <date>', 'help.invoice.create.option.date');
  optionByKey(create, '--due-date <date>', 'help.invoice.create.option.due_date');
  optionByKey(create, '--currency <code>', 'help.invoice.create.option.currency');
  optionByKey(create, '--terms <text>', 'help.invoice.create.option.terms');
  optionByKey(create, '--memo <text>', 'help.invoice.create.option.memo');
  optionByKey(create, '--po-number <text>', 'help.invoice.create.option.po_number');
  optionByKey(create, '--json', 'help.invoice.create.option.json');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'invoices + invoice_lines (draft)' });
  create.addHelpText('after', INVOICE_LINE_KEYS_HELP);
  create.addHelpText('after', EJEMPLOS.create);
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
          throw blockedByState({ key: 'ar.invoice.create.customer_archived', params: { number: customer.customer_number, command: 'customer restore' } });
        }

        const specs = [
          ...(opts.line ?? []),
          ...(opts.fromFile ? readLineFile(opts.fromFile) : []),
        ];
        if (specs.length === 0) {
          throw usageError({ key: 'ar.invoice.create.lines_missing' });
        }

        // Today is the day in the entity's zona_horaria, not the process clock (a UTC server
        // reads tomorrow from 18:00 in Mexico City).
        const invoiceDate = opts.date ?? (await todayFor({ tenantId: ctx.tenantId, entityId: ctx.entityId }));
        const dueDate = opts.dueDate ?? dueDateFromTerms(customer.payment_terms, invoiceDate);
        if (!dueDate) {
          throw usageError({ key: 'ar.invoice.create.terms_unreadable', params: { terms: String(customer.payment_terms) } });
        }
        if (dueDate < invoiceDate) {
          throw usageError({ key: 'ar.invoice.due_before_date', params: { due: dueDate, date: invoiceDate } });
        }

        const lines = await invoiceLinesFrom(ctx.entityId, specs, deps.palette, (account) => {
          if (account.account_type !== AccountType.REVENUE && account.account_type !== AccountType.CONTRA_ASSET) {
            process.stderr.write(
              deps.palette.yellow(
                `${t('ar.invoice.create.not_revenue', { code: account.code, name: account.name, type: account.account_type })}\n`
              )
            );
          }
        });

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
          `${p.green('✔')} ${t('ar.invoice.create.drafted', { number: p.bold(created.invoice_number), customer: customerLabel(customer) })} ` +
            `${p.dim(t('ar.invoice.amount_due_on', { amount: created.total_amount, currency: created.currency_code, date: day(created.due_date) }))}\n` +
            p.dim(`  ${t('ar.invoice.create.not_posted', { command: 'invoice issue' })}\n`)
        );
      })
  );

  // ---- invoice issue -----------------------------------------------
  const issue = describeCommand(invoice.command('issue').alias('emitir'), 'help.invoice.issue.description');
  argumentByKey(issue, '<ref>', 'help.invoice.issue.argument.ref');
  withContext(issue);
  optionByKey(issue, '--json', 'help.invoice.issue.option.json');
  // Posting to the ledger is irreversible: declareRisk adds --dry-run, --yes
  // and --idempotency-key, and refuses to let the agent near this command.
  declareRisk(issue, {
    risk: 'irreversible',
    llave: { sinLlave: { key: 'ar.invoice.retry_reissues' } },
    writes: 'journal_entries + account_balances + invoices.status',
  });
  issue.addHelpText('after', EJEMPLOS.issue);
  issue.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await writeEntityOf(opts);
      const target = await resolveInvoice(ctx.entityId, ref);
      const { dryRun } = gateMutation(issue, opts as Record<string, unknown>);
      const p = deps.palette;

      if (target.journal_entry_id) {
        throw blockedByState({ key: 'ar.invoice.issue.already_issued', params: { number: target.invoice_number, command: 'invoice void' } });
      }
      if (target.status === InvoiceStatus.VOID || target.status === InvoiceStatus.CANCELLED) {
        throw blockedByState({ key: 'ar.invoice.issue.never', params: { number: target.invoice_number, status: target.status } });
      }
      if (!new Decimal(target.total_amount).greaterThan(0)) {
        throw validationFailed({ key: 'ar.invoice.issue.zero_total', params: { number: target.invoice_number, total: target.total_amount, command: 'invoice edit' } });
      }

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

      if (!dryRun) {
        await confirmOrAbort(opts, { key: 'ar.invoice.issue.confirm', params: { number: target.invoice_number, amount: target.total_amount, currency: target.currency_code } });
      }

      const result = await issueInvoice(target.id, reviewer.userId, {
        entityId: ctx.entityId,
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
      const entryNumber = result.entry?.entry_number;
      out.write(
        dryRun
          ? `\n${p.bold(t('ar.invoice.issue.would_post', { number: target.invoice_number }))} ` +
              `${p.dim(t('ar.invoice.issue.as_entry', { entry: entryNumber ?? t('ar.invoice.issue.no_entry') }))}\n\n`
          : `${p.green('✔')} ${t('ar.invoice.issue.issued', { number: p.bold(target.invoice_number), entry: entryNumber ?? `(${t('ar.invoice.issue.no_entry')})` })}\n`
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
            ? `\n  ${t('ar.invoice.issue.dry_run_note')}\n`
            : `  ${t('ar.invoice.issue.posted_note')}\n`
        )
      );
    })
  );

  // ---- invoice void ------------------------------------------------
  const voidCmd = describeCommand(invoice.command('void').alias('anular'), 'help.invoice.void.description');
  argumentByKey(voidCmd, '<ref>', 'help.invoice.void.argument.ref');
  withContext(voidCmd);
  optionByKey(voidCmd, '--json', 'help.invoice.void.option.json');
  // declareRisk adds --reason for an undo verb, and gateMutation requires it.
  declareRisk(voidCmd, {
    risk: 'irreversible',
    llave: { sinLlave: { key: 'ar.invoice.retry_void_mirror' } },
    writes: 'invoices.status + a reversing journal_entry',
  });
  voidCmd.addHelpText('after', EJEMPLOS.void);
  voidCmd.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await writeEntityOf(opts);
      const target = await resolveInvoice(ctx.entityId, ref);
      const { dryRun, reason } = gateMutation(voidCmd, opts as Record<string, unknown>);
      const p = deps.palette;

      if (target.status === InvoiceStatus.VOID) {
        throw blockedByState({ key: 'ledger.entry.void.already_void', params: { number: target.invoice_number } });
      }
      if (target.status === InvoiceStatus.PAID) {
        throw blockedByState({ key: 'ar.invoice.void.paid', params: { number: target.invoice_number } });
      }

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

      if (!dryRun) {
        const reverse = target.journal_entry_id ? 'yes' : 'no';
        await confirmOrAbort(opts, {
          key: 'ar.invoice.void.confirm',
          params: { number: target.invoice_number, amount: target.total_amount, currency: target.currency_code, reverse },
        });
      }

      const result = await voidInvoice(target.id, reviewer.userId, { entityId: ctx.entityId, reason, dryRun });
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
          ? `${p.bold(t('ar.invoice.void.would_void', { number: target.invoice_number }))}`
          : `${p.green('✔')} ${t('ar.invoice.void.voided', { number: p.bold(target.invoice_number) })}`) +
          (result.reversalEntryId
            ? p.dim(` ${t(dryRun ? 'ar.invoice.void.would_reverse' : 'ar.invoice.void.reversed')}`)
            : p.dim(` ${t('ar.invoice.void.never_posted')}`)) +
          (dryRun ? p.dim(` ${t('ar.invoice.dry_run')}`) : '') +
          '\n'
      );
    })
  );

  // ---- invoice edit ------------------------------------------------
  const edit = describeCommand(invoice.command('edit').alias('editar'), 'help.invoice.edit.description');
  argumentByKey(edit, '<ref>', 'help.invoice.edit.argument.ref');
  withContext(edit);
  optionByKey(edit, '--line <spec...>', 'help.invoice.edit.option.line');
  optionByKey(edit, '--from-file <path>', 'help.invoice.edit.option.from_file');
  optionByKey(edit, '--date <date>', 'help.invoice.edit.option.date');
  optionByKey(edit, '--due-date <date>', 'help.invoice.edit.option.due_date');
  optionByKey(edit, '--memo <text>', 'help.invoice.edit.option.memo');
  optionByKey(edit, '--po-number <text>', 'help.invoice.edit.option.po_number');
  optionByKey(edit, '--json', 'help.invoice.edit.option.json');
  declareRisk(edit, { risk: 'escritura', agent: false, writes: 'invoices + invoice_lines (draft only)' });
  edit.addHelpText('after', EJEMPLOS.edit);
  edit.action(
    (
      ref: string,
      opts: CommonOpts & {
        line?: string[]; fromFile?: string; date?: string; dueDate?: string;
        memo?: string; poNumber?: string;
      }
    ) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);
        const target = await resolveInvoice(ctx.entityId, ref);
        if (target.status !== InvoiceStatus.DRAFT) {
          throw blockedByState({ key: 'ar.invoice.edit.not_draft', params: { number: target.invoice_number, status: target.status, command: 'invoice void' } });
        }

        const specs = [
          ...(opts.line ?? []),
          ...(opts.fromFile ? readLineFile(opts.fromFile) : []),
        ];
        const lines = specs.length > 0 ? await invoiceLinesFrom(ctx.entityId, specs, deps.palette) : undefined;
        if (opts.dueDate && opts.date && opts.dueDate < opts.date) {
          throw usageError({ key: 'ar.invoice.due_before_date', params: { due: opts.dueDate, date: opts.date } });
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const updated = await updateDraftInvoice(
          target.id,
          {
            entityId: ctx.entityId,
            invoice_date: opts.date,
            due_date: opts.dueDate,
            memo: opts.memo,
            po_number: opts.poNumber,
            lines,
          },
          reviewer.userId
        );

        if (opts.json) {
          render([updated as unknown as Record<string, unknown>], { json: true });
          return;
        }
        const p = deps.palette;
        process.stdout.write(
          `${p.green('✔')} ${t('ar.invoice.edit.edited', { number: p.bold(updated.invoice_number) })} ` +
            `${p.dim(t('ar.invoice.amount_due_on', { amount: updated.total_amount, currency: updated.currency_code, date: day(updated.due_date) }))}\n` +
            p.dim(`  ${t('ar.invoice.edit.still_draft')}\n`)
        );
      })
  );

  // ---- invoice delete ----------------------------------------------
  const del = describeCommand(invoice.command('delete').alias('eliminar'), 'help.invoice.delete.description');
  argumentByKey(del, '<ref>', 'help.invoice.delete.argument.ref');
  withContext(del);
  optionByKey(del, '--json', 'help.invoice.delete.option.json');
  // Un DELETE es el único acto sin espejo: irreversible por definición, con
  // --reason obligatorio (verbo de deshacer) y jamás del agente.
  declareRisk(del, {
    risk: 'irreversible',
    llave: { sinLlave: { key: 'ar.invoice.delete_by_state' } },
    writes: 'invoices + invoice_lines (hard delete, audit-logged)',
  });
  del.addHelpText('after', EJEMPLOS.delete);
  del.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await writeEntityOf(opts);
      const target = await resolveInvoice(ctx.entityId, ref);
      const { dryRun, reason } = gateMutation(del, opts as Record<string, unknown>);
      const p = deps.palette;

      if (target.status !== InvoiceStatus.DRAFT) {
        throw blockedByState({ key: 'ar.invoice.delete.not_draft', params: { number: target.invoice_number, status: target.status } });
      }

      if (dryRun) {
        process.stdout.write(
          `${p.bold(t('ar.invoice.delete.would_delete', { number: target.invoice_number }))} ${p.dim(
            t('ar.invoice.delete.would_delete_detail', { amount: target.total_amount, currency: target.currency_code })
          )}\n`
        );
        return;
      }
      await confirmOrAbort(opts, { key: 'ar.invoice.delete.confirm', params: { number: target.invoice_number, amount: target.total_amount, currency: target.currency_code } });

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const result = await deleteDraftInvoice(
        target.id,
        { entityId: ctx.entityId, reason: reason as string },
        reviewer.userId
      );

      if (opts.json) {
        render([{ invoice_number: result.invoiceNumber, deleted: true, folio_gap: result.folioGap }], { json: true });
        return;
      }
      process.stdout.write(
        `${p.green('✔')} ${t('ar.invoice.delete.deleted', { number: p.bold(result.invoiceNumber) })} ` +
          p.dim(`· ${t('ar.invoice.delete.gap_note', { command: 'invoice series check' })}\n`)
      );
    })
  );

  // ---- invoice series list -----------------------------------------
  const series = describeCommand(invoice.command('series').alias('serie'), 'help.invoice.series.description');

  const seriesList = describeCommand(series.command('list').alias('listar'), 'help.invoice.series.list.description');
  withOutput(withSelection(withContext(seriesList)));
  declareRisk(seriesList, { risk: 'lectura', agent: true });
  seriesList.addHelpText('after', EJEMPLOS.seriesList);
  seriesList.action((opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      // The selection group carries --status for every list; a folio counter
      // has no lifecycle, so the flag is refused rather than ignored.
      if (opts.status?.length) {
        throw usageError({ key: 'ar.invoice.series.list.no_status', params: { command: 'invoice series list' } });
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

  // ---- invoice series check ----------------------------------------
  const seriesCheck = describeCommand(
    series.command('check').alias('verificar'),
    'help.invoice.series.check.description'
  );
  withOutput(withContext(seriesCheck));
  optionByKey(seriesCheck, '--year <year>', 'help.invoice.series.check.option.year');
  optionByKey(seriesCheck, '--strict', 'help.invoice.series.check.option.strict');
  declareRisk(seriesCheck, { risk: 'lectura', agent: true });
  seriesCheck.addHelpText('after', EJEMPLOS.seriesCheck);
  seriesCheck.action((opts: CommonOpts & { year?: string; strict?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      let year: number | undefined;
      if (opts.year !== undefined) {
        year = Number(opts.year);
        if (!Number.isSafeInteger(year) || year < 1900 || year > 9999) {
          throw usageError({ key: 'ar.invoice.series.check.year_invalid', params: { value: opts.year } });
        }
      }
      const series = await checkInvoiceSeries(ctx.entityId, { year });
      const p = deps.palette;

      const zone = await zoneFor(ctx);
      const rows = series.flatMap((s) => {
        const explicadosPorFolio = new Map(s.explained.map((e) => [e.folio, e]));
        return s.missing.map((folio) => {
          const e = explicadosPorFolio.get(folio);
          return {
            folio,
            year: s.year,
            explained: e ? 'yes' : 'NO',
            reason: e?.reason ?? '',
            deleted_at: e ? calendarDateIn(zone, new Date(e.deleted_at)) : '',
          };
        });
      });
      const sinExplicar = rows.filter((r) => r.explained === 'NO').length;

      if (opts.json || opts.output || opts.format) {
        render(rows, {
          ...opts,
          total: rows.length,
          idField: 'folio',
          fields: opts.fields ?? 'folio,year,explained,reason,deleted_at',
        });
      } else {
        for (const s of series) {
          process.stdout.write(
            `${p.bold(`INV ${s.year}`)} ${p.dim(`· ${t('ar.invoice.series.check.usage', { used: s.used, counter: s.counterAt })}`)}\n`
          );
        }
        if (rows.length === 0) {
          process.stdout.write(`${p.green('✔')} ${t('ar.invoice.series.check.no_gaps')}\n`);
        } else {
          render(rows, { format: 'table' });
          process.stdout.write(
            sinExplicar > 0
              ? p.yellow(`\n${t('ar.invoice.series.check.unexplained', { count: sinExplicar })}\n`)
              : p.dim(`\n${t('ar.invoice.series.check.all_explained')}\n`)
          );
        }
      }

      // Un hueco sin explicar es hallazgo (exit 4); con --strict, cualquiera.
      const hallazgos = opts.strict ? rows.length : sinExplicar;
      if (hallazgos > 0) {
        await deps.shutdown(4);
      }
    })
  );
}

/** Lines from a JSON file: an array of the same key=value fields, as objects. */
function readLineFile(path: string): Array<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw usageError({ key: 'ar.invoice.file.unreadable', params: { path, message: (err as Error).message } });
  }
  if (!Array.isArray(parsed)) {
    throw usageError({ key: 'ar.invoice.file.not_array', params: { path } });
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw usageError({ key: 'ar.invoice.file.line_not_object', params: { path } });
    }
    return entry as Record<string, unknown>;
  });
}
