import * as readline from 'node:readline/promises';
import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import Decimal from 'decimal.js';
import { bootstrapTenant } from '../ai/context.js';
import { query } from '../database/connection.js';
import {
  PreRegistrationService,
  PROVEEDOR_NUEVO_SIN_AUTORIZAR,
} from '../services/xml-ingestion/pre-registration-service.js';
import { conLlave, hashDeCarga } from '../services/idempotency/idempotency-store.js';
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
  gateMutation,
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
  dateOnly,
  ExitCode,
  type ExitCodeValue,
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

// ---- la bandeja de CFDI ---------------------------------------------
//
// Los dominios son los CHECK de la tabla (005_xml_ingestion.sql), copiados
// aquí para poder rechazar un valor imposible ANTES de mandar SQL: un
// `--status listo` debe contestar con la lista de estados que existen, no con
// una tabla vacía que se lee como «no hay nada pendiente».

/** pre_registrations.status (005_xml_ingestion.sql:219-222). */
const ESTADOS_BANDEJA = [
  'draft', 'validating', 'ready', 'queued', 'processing', 'completed', 'rejected', 'error', 'duplicate',
] as const;

/** pre_registrations.processing_mode (005_xml_ingestion.sql:188-190). */
const MODOS_BANDEJA = ['auto', 'batch', 'manual', 'hold'] as const;

const ACCIONES_BANDEJA = ['process', 'approve', 'reject', 'set-batch'] as const;
type AccionBandeja = (typeof ACCIONES_BANDEJA)[number];

/** Las claves que admite `--query`. Son las mismas del listado, a propósito. */
const CLAVES_QUERY = ['status', 'mode', 'requires-approval', 'vendor', 'since', 'until', 'search'] as const;

/**
 * Cuántos pre-registros admite una sola orden masiva.
 *
 * No es un límite técnico: es lo que separa una orden que alguien revisó de
 * una que barre la bandeja. El REST tiene el suyo por construcción —el cliente
 * enumera los ids—; aquí la consulta puede seleccionar miles, así que el tope
 * lo pone el comando y obliga a acotar.
 */
const TOPE_DEL_LOTE = 200;

const INBOX_COLUMNS = [
  'ref', 'date', 'vendor', 'total', 'currency', 'status', 'mode', 'approval', 'valid',
] as const;

/**
 * Las columnas de una salida que OTRO va a consumir, con el id entero.
 *
 * `ref` son los ocho primeros caracteres del uuid, que caben en una tabla pero
 * que `bill inbox run` rechaza —exige el uuid completo—. Con sólo INBOX_COLUMNS
 * el `--json` tampoco traía `id`, así que el operador leía un identificador que
 * el comando siguiente no aceptaba y el agente, que lee esta fila en json, no
 * tenía forma de encadenar los dos comandos. La tabla sigue estrecha; las
 * salidas para máquina llevan el id.
 */
const INBOX_COLUMNS_MAQUINA = ['id', ...INBOX_COLUMNS] as const;

/**
 * Una columna cruda de la base, dicha en un mensaje.
 *
 * `String(x)` sobre un `unknown` imprime «[object Object]» en cuanto la
 * columna no es lo que se esperaba —y el linter lo avisa—, que es justo
 * cuando el mensaje más falta hace: el del documento raro.
 */
function textoDe(valor: unknown, alterno: string): string {
  return typeof valor === 'string' && valor.trim() ? valor : alterno;
}

/** Marca de la fila que más atención necesita. Viaja en el DATO, no en el color. */
const MARCA_NUEVO = '⚠ nuevo:';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Un renglón de la bandeja, con lo que hace falta para decidir y para mostrar. */
type FilaBandeja = {
  id: string;
  external_reference: string | null;
  document_date: Date | string | null;
  total_amount: string | null;
  currency_code: string | null;
  status: string;
  processing_mode: string;
  requires_approval: boolean | null;
  approval_status: string | null;
  validation_status: string | null;
  is_new_vendor: boolean | null;
  document_type: string;
  error_message: string | null;
  vendor_name: string | null;
  suggested_vendor_name: string | null;
  emisor_rfc: string | null;
  emisor_nombre: string | null;
};

type FiltroBandeja = {
  ids?: string[];
  status?: string[];
  processingMode?: string;
  requiresApproval?: boolean;
  vendorId?: string;
  since?: string;
  until?: string;
  search?: string;
};

type ResultadoLote = {
  action: string;
  total: number;
  ok: number;
  skipped: number;
  failed: number;
  /** Cuántos de los fallidos esperan a una persona y no a un arreglo. */
  needsHuman: number;
  results: Array<Record<string, unknown>>;
};

export function registerBillCommand(program: Command, deps: BillCommandDeps): void {
  const bill = program
    .command('bill')
    .alias('factura-proveedor')
    .description('Vendor bills: capture, code, inspect and approve what we owe');

  // Devuelve un código porque `bill inbox run` puede terminar a medias: parte
  // de un lote contabilizada y parte esperando a una persona no es ni éxito ni
  // fallo, y salir 0 lo escondería. Los demás manejadores siguen devolviendo
  // void, que es 0.
  const run = async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? 0);
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
          dateBasis: basis,
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
          : ((fromFile.bill_date as string | undefined) ?? dateOnly(new Date()));
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

  // ============================================================
  // LA BANDEJA DE CFDI — `bill inbox`
  //
  // Entre «llegó un XML» y «existe una factura de proveedor» vive un
  // pre-registro: el comprobante ya parseado, con el proveedor que se le pudo
  // casar, la cuenta que se le sugiere y el motivo por el que sigue parado.
  // `inbox list` es esa cola; `inbox run` es lo que la vacía.
  //
  // El nodo intermedio no declara riesgo ni tiene acción, igual que `bill
  // line`: la auditoría sólo exige verbo en la última posición de las HOJAS, y
  // `bill inbox list` mide justo los tres tokens que R1 permite.
  //
  // SOBRE LA CLASE DE RIESGO DE `run`, que conviene dejar escrita. El catálogo
  // la declara `escritura` y aquí se respeta, pero lo que hace de verdad con
  // `--action process` es más grave que la etiqueta: el pre-registro nace ya
  // como bill en estado 'posted' y su póliza se postea en la misma llamada
  // (`createBillFromPreReg`). Es decir, hace lo mismo que `bill approve`
  // declara irreversible, y sobre varios documentos a la vez. Lo que sostiene
  // la línea aquí no es la etiqueta sino tres cosas concretas: `agent: false`
  // —la IA no lo invoca—, la confirmación obligatoria de `process`, y que
  // `--allow-new-vendor` sea la única forma de que nazca una contraparte.
  // ============================================================
  const inbox = bill
    .command('inbox')
    .alias('bandeja')
    .description('CFDI inbox: pre-registrations waiting to become vendor bills');

  // ---- bill inbox list ---------------------------------------------
  const inboxList = inbox
    .command('list')
    .alias('listar')
    .description('The CFDI queue: what arrived, whose it is, and what is holding it up');
  withOutput(withSelection(withContext(inboxList)));
  inboxList
    .option('--processing-mode <mode>', `how it is meant to be processed: ${MODOS_BANDEJA.join(', ')}`)
    .option('--requires-approval', 'only the ones held for a prior approval')
    .option('--vendor <ref>', 'only this vendor (number, name or id)');
  declareRisk(inboxList, { risk: 'lectura', agent: true });
  inboxList.action(
    (opts: CommonOpts & { processingMode?: string; requiresApproval?: boolean; vendor?: string }) =>
      run(async () => {
        const ctx = await entityOf(opts);

        const filtro: FiltroBandeja = {
          status: opts.status?.length ? validarDominio('--status', opts.status, ESTADOS_BANDEJA) : undefined,
          processingMode: opts.processingMode
            ? validarDominio('--processing-mode', [opts.processingMode], MODOS_BANDEJA)[0]
            : undefined,
          requiresApproval: opts.requiresApproval === true ? true : undefined,
          vendorId: opts.vendor ? (await resolveVendor(ctx.entityId, opts.vendor)).id : undefined,
        };

        const { rows, total } = await leerBandeja(ctx.entityId, filtro, {
          limit: opts.all ? undefined : (opts.limit ?? 50),
          offset: opts.offset,
        });

        render(rows.map(resumirPreRegistro), {
          ...opts,
          total,
          // El id COMPLETO se queda en la fila aunque no se pinte: `--quiet`
          // lee del renglón, no de las columnas elegidas, así que
          // `bill inbox list -q | xargs -n1 mnemosine bill inbox run` funciona.
          idField: 'id',
          fields:
            opts.fields ??
            (rows.length
              ? (opts.json || opts.output || (opts.format && opts.format !== 'table')
                  ? INBOX_COLUMNS_MAQUINA
                  : INBOX_COLUMNS
                ).join(',')
              : undefined),
          numeric: ['total'],
        });

        const nuevos = rows.filter(esProveedorNuevo);
        if (nuevos.length) {
          // La fila del proveedor nuevo se marca EN EL TEXTO de la celda y no
          // con color: el color rompe el ancho de la columna que calcula el
          // renderizador y desaparece en csv, json y en un `| less`. La marca
          // viaja con el dato.
          process.stderr.write(
            deps.palette.yellow(
              `\n${nuevos.length} de ${rows.length} traen un proveedor que NO está en el catálogo ` +
                `(marcados «${MARCA_NUEVO}»).\n`
            ) +
              deps.palette.dim(
                '  Contabilizarlos daría de alta la contraparte con el nombre y el RFC del XML.\n' +
                  '  `bill inbox run` los rechaza salvo que lleve --allow-new-vendor; la otra salida\n' +
                  '  es darlos de alta a mano con `vendor create`.\n'
              )
          );
        }
      })
  );

  // ---- bill inbox run ----------------------------------------------
  const inboxRun = inbox
    .command('run')
    .alias('ejecutar')
    .argument('[id]', 'one pre-registration, by id')
    .description('Turn pre-registrations into vendor bills, or approve, reject and schedule them in bulk');
  withContext(inboxRun);
  inboxRun
    .option('--action <process|approve|reject|set-batch>', 'what to do with the selection', 'process')
    .option('--bulk', 'act on everything --query selects, instead of a single id')
    .option('--query <expr>', `selection for --bulk, comma-separated key=value: ${CLAVES_QUERY.join(', ')}`)
    .option('--batch <ref>', 'processing batch to schedule into; required by --action set-batch')
    .option(
      '--allow-new-vendor',
      "authorize creating the CFDI issuer as a vendor when the catalog does not have it; without it, those are refused"
    )
    .option('--reason <text>', 'why it is rejected; required by --action reject')
    .option('--note <text>', 'annotation stored with the approval')
    .option('--dry-run', 'compute and show the full effect; write nothing')
    .option('-y, --yes', 'skip the confirmation prompt')
    .option(
      '--idempotency-key <key>',
      'client dedupe key, stored on success: a retry with the same key and payload returns the recorded result'
    )
    .option('--json', 'JSON output');
  // `escritura` es lo que el catálogo comete; el porqué —y por qué no basta—
  // está en el bloque de arriba. `writes` nombra el camino más grave, que es
  // lo que va al rastro de auditoría.
  declareRisk(inboxRun, {
    risk: 'escritura',
    agent: false,
    writes:
      'pre_registrations; con --action process además bills, bill_lines, ASIENTOS POSTEADOS y, ' +
      'sólo con --allow-new-vendor, vendors',
  });
  inboxRun.action(
    (
      idArg: string | undefined,
      opts: CommonOpts & {
        action?: string; bulk?: boolean; query?: string; batch?: string;
        allowNewVendor?: boolean; reason?: string; note?: string;
        dryRun?: boolean; yes?: boolean; idempotencyKey?: string;
      }
    ) =>
      run(async () => {
        // Tenant FIRST: entity resolution is itself scoped by RLS, so a
        // --tenant applied afterwards resolves nothing.
        bootstrapTenant(opts.tenant);
        const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
        const { dryRun } = gateMutation(inboxRun, opts as unknown as Record<string, unknown>);

        const accion = normalizarAccion(opts.action);
        if (accion === 'reject' && !opts.reason) {
          throw usageError('--action reject descarta un documento: exige --reason "<por qué>".');
        }
        if (accion === 'set-batch' && !opts.batch) {
          throw usageError('--action set-batch necesita --batch <id o número de lote>.');
        }

        // ── LA SELECCIÓN. Un id, o --bulk con --query; nunca las dos, y nunca
        // --bulk a secas: un lote que no nombra su selección acabaría actuando
        // sobre la bandeja entera, que es el error que no se puede deshacer.
        if (idArg && opts.bulk) {
          throw usageError('Pasa un id, o --bulk con --query. Los dos a la vez no significan nada.');
        }
        let filtro: FiltroBandeja;
        if (idArg) {
          if (!UUID_RE.test(idArg.trim())) {
            throw usageError(`"${idArg}" no es el id de un pre-registro (uuid). Sácalo de \`bill inbox list\`.`);
          }
          filtro = { ids: [idArg.trim()] };
        } else if (!opts.bulk) {
          throw usageError(
            '¿Sobre qué? Pasa el id de un pre-registro, o --bulk con --query "status=ready".'
          );
        } else if (!opts.query) {
          throw usageError(
            '--bulk sin --query actuaría sobre TODA la bandeja. Nombra la selección: ' +
              `--query "status=ready,mode=manual" (claves: ${CLAVES_QUERY.join(', ')}).`
          );
        } else {
          filtro = await filtroDesdeQuery(ctx.entityId, opts.query);
        }

        // Se lee una fila de más a propósito: es lo que distingue «doscientas»
        // de «más de doscientas» sin un segundo conteo.
        const { rows } = await leerBandeja(ctx.entityId, filtro, { limit: TOPE_DEL_LOTE + 1 });
        if (idArg && rows.length === 0) {
          // «No existe» y «no es de tu entidad» dan la misma respuesta: el
          // filtro va dentro del SQL y aquí no hay rama que los distinga.
          throw notFound(`El pre-registro ${idArg} no está en la bandeja de ${ctx.entityName}.`);
        }
        if (rows.length > TOPE_DEL_LOTE) {
          throw usageError(
            `La selección pasa de ${TOPE_DEL_LOTE} pre-registros. Un lote más grande que eso no es ` +
              'una orden que alguien haya revisado: acota con --query (status, mode, since, until, vendor).'
          );
        }
        if (rows.length === 0) {
          // Y SE DICE DÓNDE MIRAR, porque el caso frecuente no es que no haya
          // nada: es que lo que falló ya no está donde se le busca. Un CFDI
          // que se rechaza por proveedor sin autorizar sale de 'ready' y cae a
          // 'draft'/needs_review, así que repetir LA MISMA consulta tras dar de
          // alta al proveedor selecciona cero filas y responde «nada que
          // hacer» — con los documentos fuera del mes y el operador creyendo
          // que terminó.
          const rezagados = await query<{ n: string }>(
            `SELECT COUNT(*) AS n FROM pre_registrations
              WHERE entity_id = $1 AND status = 'draft' AND validation_status = 'needs_review'`,
            [ctx.entityId]
          );
          const n = Number(rezagados.rows[0]?.n ?? 0);
          process.stderr.write(
            deps.palette.dim(`La consulta "${opts.query}" no selecciona ningún pre-registro. Nada que hacer.\n`) +
              (n > 0
                ? deps.palette.yellow(
                    `  Hay ${n} pre-registro(s) esperando una decisión humana, que esta consulta no alcanza.\n`
                  ) +
                  deps.palette.dim(
                    '  Se ven con `bill inbox list --status draft`, y ahí están los que se pararon\n' +
                      '  por traer proveedor nuevo: repítelos con --query "status=draft".\n'
                  )
                : '')
          );
          return;
        }

        // ── LA MARCHA SECA. Enumera exactamente lo que tocaría, con la misma
        // tabla del listado para que sea la misma lectura, y luego el resumen
        // que decide: cuántos, cuáles parirían un proveedor y cuánto suman.
        //
        // Con --json la selección sólo se emite en la marcha seca: en una
        // corrida de verdad el documento que sale por stdout tiene que ser UNO,
        // el del resultado. Dos objetos JSON seguidos no los lee nadie.
        const nuevos = rows.filter(esProveedorNuevo);
        const vistaPreviaJson = dryRun && opts.json === true;
        if (dryRun || !opts.json) {
          render(rows.map(resumirPreRegistro), {
            format: vistaPreviaJson ? 'json' : 'table',
            idField: 'id',
            fields: vistaPreviaJson ? undefined : INBOX_COLUMNS.join(','),
            numeric: ['total'],
          });
        }
        process.stderr.write(
          deps.palette.dim(
            `\n${accion}: ${rows.length} pre-registro(s)` +
              `${totalesPorMoneda(rows)}\n`
          )
        );
        if (accion === 'process') {
          const yaHechos = rows.filter((r) => r.status === 'completed').length;
          if (yaHechos) {
            process.stderr.write(
              deps.palette.dim(`  ${yaHechos} ya está(n) contabilizado(s) y se saltará(n).\n`)
            );
          }
          if (nuevos.length) {
            const aviso =
              `  ${nuevos.length} crearía(n) un PROVEEDOR NUEVO: ` +
              `${nuevos.map((r) => `${nombreDelEmisor(r)} (${r.emisor_rfc ?? 'sin RFC'})`).join('; ')}\n`;
            process.stderr.write(
              (opts.allowNewVendor ? deps.palette.yellow(aviso) : deps.palette.dim(aviso)) +
                deps.palette.dim(
                  opts.allowNewVendor
                    ? '  --allow-new-vendor está puesto: se darán de alta con el nombre y el RFC del XML.\n'
                    : '  Sin --allow-new-vendor se rechazan uno a uno, con el motivo, y el resto sigue.\n'
                )
            );
          }
        }

        if (dryRun) {
          process.stderr.write(deps.palette.dim('Dry run: nothing was written.\n'));
          return;
        }

        // ── LA CONFIRMACIÓN. `process` siempre, porque postea al mayor; y
        // cualquier acción sobre más de un documento, porque un lote escrito
        // de memoria es la forma normal de equivocarse.
        if (!opts.yes && (accion === 'process' || rows.length > 1)) {
          const pregunta =
            accion === 'process'
              ? `¿Contabilizar ${rows.length} pre-registro(s) en los libros de ${ctx.entityName}? ` +
                'Cada uno nace como factura POSTEADA con su póliza. Esto no se deshace.'
              : `¿Aplicar "${accion}" a ${rows.length} pre-registro(s) de ${ctx.entityName}?`;
          if (!stdin.isTTY && !deps.confirm) {
            throw abortedByUser(
              'No hay terminal donde confirmar. Re-ejecuta con --yes cuando lo tengas decidido, ' +
                'o con --dry-run para ver lo que haría.'
            );
          }
          if (!(await ask(pregunta))) throw abortedByUser();
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        // El lote se resuelve ANTES de la llave: un --batch que no existe es
        // un error de uso, y debe salir como tal en vez de convertirse en el
        // fallo de doscientas filas.
        const batchId = opts.batch ? await resolverLote(ctx.entityId, opts.batch) : undefined;
        const ids = rows.map((r) => r.id);
        const acto = await conLlave(
          { tenantId: ctx.tenantId, entityId: ctx.entityId },
          {
            scope: 'bill inbox run',
            clave: opts.idempotencyKey,
            // La carga incluye la AUTORIZACIÓN, y eso resuelve el caso
            // incómodo: el lote se graba tal como salió —con los que se
            // rechazaron dentro—, así que repetir la MISMA llave devuelve ese
            // mismo informe sin ejecutar nada. Quien vuelva a intentarlo
            // después de dar de alta al proveedor, o añadiendo
            // --allow-new-vendor, está ejecutando otro acto: el hash cambia y
            // el almacén acusa reuso de llave (salida 6) en vez de contestar
            // con el informe viejo, que es el fallo que de verdad duele.
            payloadHash: hashDeCarga(
              accion,
              [...ids].sort().join(','),
              opts.allowNewVendor === true,
              opts.batch ?? '',
              opts.reason ?? ''
            ),
          },
          async () =>
            ejecutarBandeja({
              accion,
              filas: rows,
              entityId: ctx.entityId,
              userId: reviewer.userId,
              permitirProveedorNuevo: opts.allowNewVendor === true,
              batchId,
              reason: opts.reason,
              note: opts.note,
            })
        );

        if (acto.repetido) {
          process.stderr.write(
            `↩ Idempotency hit: key "${opts.idempotencyKey}" already completed this act — ` +
              `${acto.resultado.ok}/${acto.resultado.total} ${accion}\n` +
              '  Nothing was executed again; this is the recorded result.\n'
          );
          if (opts.json) render([acto.resultado], { json: true });
          return;
        }

        const { ok, skipped, failed, needsHuman, results } = acto.resultado;
        if (opts.json) {
          render([acto.resultado], { json: true });
        } else {
          render(results, { format: 'table', idField: 'ref' });
          process.stdout.write(
            `${failed === 0 ? deps.palette.green('✔') : deps.palette.yellow('!')} ` +
              `${accion}: ${ok} de ${results.length}` +
              (skipped ? deps.palette.dim(` · ${skipped} ya estaba(n)`) : '') +
              (failed ? deps.palette.dim(` · ${failed} sin hacer`) : '') +
              '\n'
          );
        }

        if (failed === 0) return ExitCode.OK;
        // Un pre-registro que espera a una persona no es un fallo del programa:
        // es el código 11 del contrato, «needs human». Sólo cuando TODO lo que
        // falló era eso; si hubo un error de verdad, manda el error.
        return needsHuman === failed ? ExitCode.NEEDS_HUMAN : ExitCode.FAILURE;
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

// ============================================================
// LA BANDEJA, POR DENTRO
// ============================================================

/** Un valor fuera del dominio de la columna se rechaza aquí, con la lista. */
function validarDominio(flag: string, values: string[], dominio: readonly string[]): string[] {
  for (const v of values) {
    if (!dominio.includes(v)) {
      throw usageError(`${flag} "${v}" no existe. Los valores posibles son: ${dominio.join(', ')}.`);
    }
  }
  return values;
}

/**
 * El WHERE de la bandeja.
 *
 * `pr.entity_id = $1` es el primer predicado y no es opcional: la frontera
 * multi-inquilino vive DENTRO del SQL, nunca en un filtro de JavaScript
 * aplicado después. Todo lo demás se le añade encima.
 */
function whereDeBandeja(entityId: string, f: FiltroBandeja): { where: string; params: unknown[] } {
  const params: unknown[] = [entityId];
  let where = 'WHERE pr.entity_id = $1';
  const siguiente = (valor: unknown): number => params.push(valor);

  if (f.ids?.length) where += ` AND pr.id = ANY($${siguiente(f.ids)}::uuid[])`;
  if (f.status?.length) where += ` AND pr.status = ANY($${siguiente(f.status)}::text[])`;
  if (f.processingMode) where += ` AND pr.processing_mode = $${siguiente(f.processingMode)}`;
  if (f.requiresApproval !== undefined) {
    where += ` AND pr.requires_approval = $${siguiente(f.requiresApproval)}`;
  }
  if (f.vendorId) where += ` AND pr.vendor_id = $${siguiente(f.vendorId)}`;
  if (f.since) where += ` AND pr.document_date >= $${siguiente(f.since)}`;
  if (f.until) where += ` AND pr.document_date <= $${siguiente(f.until)}`;
  if (f.search) {
    const i = siguiente(`%${f.search}%`);
    where +=
      ` AND (pr.external_reference ILIKE $${i} OR xd.emisor_nombre ILIKE $${i} OR xd.cfdi_uuid ILIKE $${i})`;
  }
  return { where, params };
}

async function leerBandeja(
  entityId: string,
  filtro: FiltroBandeja,
  page: { limit?: number; offset?: number }
): Promise<{ rows: FilaBandeja[]; total: number }> {
  const { where, params } = whereDeBandeja(entityId, filtro);

  const conteo = await query<{ n: string }>(
    `SELECT COUNT(*) AS n
       FROM pre_registrations pr
       LEFT JOIN xml_documents xd ON xd.id = pr.xml_document_id
      ${where}`,
    params
  );

  const conPagina = [...params];
  let limites = '';
  if (page.limit !== undefined) limites += ` LIMIT $${conPagina.push(page.limit)}`;
  if (page.offset) limites += ` OFFSET $${conPagina.push(page.offset)}`;

  // El importe sale como texto y se queda como texto: es dinero, y un
  // redondeo de coma flotante en el camino a la terminal es un centavo que
  // nadie encuentra después.
  const filas = await query<FilaBandeja>(
    `SELECT pr.id, pr.external_reference, pr.document_date,
            pr.total_amount::text AS total_amount, pr.currency_code,
            pr.status, pr.processing_mode, pr.requires_approval, pr.approval_status,
            pr.validation_status, pr.is_new_vendor, pr.document_type, pr.error_message,
            v.company_name AS vendor_name,
            pr.suggested_vendor_data->>'company_name' AS suggested_vendor_name,
            COALESCE(pr.suggested_vendor_data->>'tax_id', xd.emisor_rfc) AS emisor_rfc,
            xd.emisor_nombre
       FROM pre_registrations pr
       LEFT JOIN vendors v ON v.id = pr.vendor_id
       LEFT JOIN xml_documents xd ON xd.id = pr.xml_document_id
      ${where}
      ORDER BY pr.created_at DESC${limites}`,
    conPagina
  );

  return { rows: filas.rows, total: Number(conteo.rows[0]?.n ?? 0) };
}

/**
 * Un pre-registro cuyo emisor no está en el catálogo.
 *
 * Es la fila que más atención necesita: contabilizarla no sólo reconoce un
 * pasivo, además da de alta la contraparte con datos escritos por un tercero.
 */
function esProveedorNuevo(r: FilaBandeja): boolean {
  return !r.vendor_name && r.is_new_vendor === true;
}

function nombreDelEmisor(r: FilaBandeja): string {
  return r.suggested_vendor_name ?? r.emisor_nombre ?? 'emisor sin nombre';
}

function resumirPreRegistro(r: FilaBandeja): Record<string, unknown> {
  return {
    ref: String(r.id).slice(0, 8),
    date: dateOnly(r.document_date),
    vendor: esProveedorNuevo(r) ? `${MARCA_NUEVO} ${nombreDelEmisor(r)}` : (r.vendor_name ?? nombreDelEmisor(r)),
    total: r.total_amount ?? '',
    currency: r.currency_code ?? '',
    status: r.status,
    mode: r.processing_mode,
    // En blanco significa «no requiere aprobación»; con texto, en qué punto
    // de la aprobación está.
    approval: r.requires_approval ? (r.approval_status ?? 'pending') : '',
    valid: r.validation_status ?? '',
    id: r.id,
    document: r.external_reference ?? '',
    rfc: r.emisor_rfc ?? '',
    type: r.document_type,
    error: r.error_message ?? '',
  };
}

/**
 * El importe seleccionado, por moneda.
 *
 * Nunca en una sola cifra: sumar pesos con dólares produce un número que
 * parece un total y no lo es.
 */
function totalesPorMoneda(filas: FilaBandeja[]): string {
  const por = new Map<string, Decimal>();
  for (const f of filas) {
    const moneda = f.currency_code ?? 'MXN';
    por.set(moneda, (por.get(moneda) ?? new Decimal(0)).plus(f.total_amount ?? '0'));
  }
  const partes = [...por.entries()].map(([m, t]) => `${t.toFixed(2)} ${m}`);
  return partes.length ? ` · ${partes.join(' + ')}` : '';
}

function normalizarAccion(valor: string | undefined): AccionBandeja {
  const v = (valor ?? 'process').trim().toLowerCase();
  // El REST escribe `set_batch` y el catálogo promete `set-batch`. El guión
  // medio es la grafía del CLI; la traducción a la del backend ocurre donde
  // se manda el SQL, no en la superficie.
  const canon = v === 'set_batch' ? 'set-batch' : v;
  if (!(ACCIONES_BANDEJA as readonly string[]).includes(canon)) {
    throw usageError(`--action "${valor}" no existe. Usa una de: ${ACCIONES_BANDEJA.join(', ')}.`);
  }
  return canon as AccionBandeja;
}

/** `--query "status=ready,mode=manual"` → el mismo filtro que usa el listado. */
async function filtroDesdeQuery(entityId: string, spec: string): Promise<FiltroBandeja> {
  const pares: Record<string, string> = {};
  for (const parte of spec.split(',')) {
    const eq = parte.indexOf('=');
    if (eq < 0) {
      throw usageError(
        `No se entiende --query "${spec}". Cada parte es clave=valor separada por comas: ` +
          `--query "status=ready,mode=manual". Claves: ${CLAVES_QUERY.join(', ')}.`
      );
    }
    pares[parte.slice(0, eq).trim().toLowerCase()] = parte.slice(eq + 1).trim();
  }

  const desconocidas = Object.keys(pares).filter((k) => !(CLAVES_QUERY as readonly string[]).includes(k));
  if (desconocidas.length) {
    throw usageError(
      `Clave(s) que --query no conoce: ${desconocidas.join(', ')}. Claves: ${CLAVES_QUERY.join(', ')}.`
    );
  }

  const filtro: FiltroBandeja = {};
  if (pares.status) filtro.status = validarDominio('status', pares.status.split('|'), ESTADOS_BANDEJA);
  if (pares.mode) filtro.processingMode = validarDominio('mode', [pares.mode], MODOS_BANDEJA)[0];
  if (pares['requires-approval']) {
    const v = pares['requires-approval'].toLowerCase();
    if (v !== 'true' && v !== 'false') {
      throw usageError(`requires-approval sólo admite true o false; llegó "${pares['requires-approval']}".`);
    }
    filtro.requiresApproval = v === 'true';
  }
  if (pares.vendor) filtro.vendorId = (await resolveVendor(entityId, pares.vendor)).id;
  if (pares.since) filtro.since = requireDate('--query since', pares.since);
  if (pares.until) filtro.until = requireDate('--query until', pares.until);
  if (pares.search) filtro.search = pares.search;

  // Una consulta con todas las claves vacías selecciona la bandeja entera,
  // que es justo lo que --bulk no puede hacer sin nombrarlo.
  if (Object.keys(filtro).length === 0) {
    throw usageError(`--query "${spec}" no acota nada. Nombra al menos un criterio.`);
  }
  return filtro;
}

/** El lote programado, por número o por id, dentro de la entidad. */
async function resolverLote(entityId: string, ref: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM processing_batches
      WHERE entity_id = $1 AND (batch_number = $2 OR id::text = $2)
      LIMIT 1`,
    [entityId, ref.trim()]
  );
  if (r.rows.length === 0) throw notFound(`No hay un lote de proceso "${ref}" en esta entidad.`);
  return r.rows[0].id;
}

/**
 * Aplica la acción, documento a documento.
 *
 * Un fallo no detiene al resto: en un lote de treinta, el que le falta un
 * proveedor no puede impedir que los veintinueve buenos entren. Cada renglón
 * sale con su motivo, y el código de salida distingue «esto espera a una
 * persona» de «esto se rompió».
 */
async function ejecutarBandeja(orden: {
  accion: AccionBandeja;
  filas: FilaBandeja[];
  entityId: string;
  userId: string;
  permitirProveedorNuevo: boolean;
  batchId?: string;
  reason?: string;
  note?: string;
}): Promise<ResultadoLote> {
  // Se construye sólo cuando hace falta: instanciarlo arrastra el parser de
  // CFDI, el validador del SAT y el motor de reglas, y `approve`/`reject` no
  // necesitan ninguno de los tres.
  const service = orden.accion === 'process' ? new PreRegistrationService() : null;

  const results: Array<Record<string, unknown>> = [];
  let ok = 0;
  let skipped = 0;
  let failed = 0;
  let needsHuman = 0;

  for (const fila of orden.filas) {
    const ref = fila.id.slice(0, 8);
    try {
      if (orden.accion === 'process' && fila.status === 'completed') {
        // Repetir un lote donde algunos ya entraron es normal, no un error:
        // se salta y se dice, y el código de salida no se mancha por ello.
        skipped++;
        results.push({ ref, status: 'skipped', detail: 'ya estaba contabilizado', id: fila.id });
        continue;
      }
      const detail = await unActoDeBandeja(orden, fila, service);
      ok++;
      results.push({ ref, status: 'ok', detail, id: fila.id });
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      const espera = code === PROVEEDOR_NUEVO_SIN_AUTORIZAR || code === 'CFDI_REQUIERE_DECISION';
      failed++;
      if (espera) needsHuman++;
      results.push({
        ref,
        status: espera ? 'needs-human' : 'error',
        detail: (err as Error).message,
        id: fila.id,
      });
    }
  }

  return { action: orden.accion, total: orden.filas.length, ok, skipped, failed, needsHuman, results };
}

/** Una sola fila, una sola acción. Todo UPDATE lleva su `entity_id` dentro. */
async function unActoDeBandeja(
  orden: {
    accion: AccionBandeja;
    entityId: string;
    userId: string;
    permitirProveedorNuevo: boolean;
    batchId?: string;
    reason?: string;
    note?: string;
  },
  fila: FilaBandeja,
  service: PreRegistrationService | null
): Promise<string> {
  switch (orden.accion) {
    case 'process': {
      // Se relee acotada por entidad justo antes de contabilizar: el servicio
      // recibe la FILA entera, así que quien se la entrega es responsable de
      // haberla acotado, y el estado que importa es el de ahora.
      const fresca = await query<Record<string, unknown>>(
        `SELECT * FROM pre_registrations WHERE id = $1 AND entity_id = $2`,
        [fila.id, orden.entityId]
      );
      if (fresca.rows.length === 0) throw notFound('desapareció de la bandeja mientras se procesaba');
      const cruda = fresca.rows[0];

      // ESTE COMANDO SÓLO CONTABILIZA FACTURAS DE PROVEEDOR.
      //
      // `processToAccounting` bifurca por `document_type`, y `'payment'` va a
      // `procesarREP`, que para un REP EMITIDO registra COBROS DE CLIENTES.
      // La bandeja no filtraba por tipo, así que `bill inbox run --bulk` podía
      // registrar cartera de clientes bajo una confirmación que decía
      // «cada uno nace como factura POSTEADA»: el operador aprobaba una cosa y
      // ocurría otra. La ruta REST ya exigía permiso de `invoices:create` para
      // ese caso; aquí no había contrapeso ninguno.
      //
      // Se rechaza en voz alta en vez de filtrarse en silencio: un documento
      // que el operador seleccionó y no se contabiliza tiene que decir por qué.
      if (cruda.document_type !== 'bill') {
        throw blockedByState(
          `es un pre-registro de tipo "${textoDe(cruda.document_type, 'desconocido')}", ` +
            'no una factura de proveedor. ' +
            '`bill inbox run` sólo contabiliza gastos; un complemento de pago emitido registraría ' +
            'COBROS DE CLIENTES, que no es lo que este comando dice hacer.'
        );
      }

      // LA APROBACIÓN QUE EL LISTADO PROMETE, EXIGIDA.
      //
      // `bill inbox list` pinta una columna `approval`, este mismo comando
      // ofrece `--action approve` para levantar la retención… y `process` la
      // atravesaba sin mirarla: el gasto nacía posteado con `approved_by` en
      // NULL para siempre. Una columna que anuncia un control y un verbo que
      // lo ignora es peor que no tener el control.
      if (cruda.requires_approval === true && cruda.approval_status !== 'approved') {
        throw blockedByState(
          `requiere aprobación previa y está en "${textoDe(cruda.approval_status, 'pending')}". ` +
            'Apruébalo primero: `bill inbox run <id> --action approve`.'
        );
      }

      const r = await service!.processToAccounting(cruda, orden.userId, {
        permitirProveedorNuevo: orden.permitirProveedorNuevo,
      });
      const bill = r.bill as { bill_number?: string } | undefined;
      const asiento = r.journalEntry as { entry_number?: string } | null | undefined;
      return [
        bill?.bill_number ? `factura ${bill.bill_number}` : null,
        asiento?.entry_number ? `póliza ${asiento.entry_number}` : null,
        r.paymentId ? `pago ${r.paymentId}` : null,
      ]
        .filter(Boolean)
        .join(' · ') || 'contabilizado';
    }

    case 'approve': {
      // La condición de aprobación va en el WHERE, como en la ruta individual
      // del REST: aprobar lo que no estaba pendiente no es una aprobación, y
      // el lote del REST —que no mira rowCount— reporta «success» al hacerlo.
      const r = await query(
        `UPDATE pre_registrations
            SET approval_status = 'approved', approved_by = $1, approved_at = NOW(),
                approval_notes = COALESCE($2, approval_notes)
          WHERE id = $3 AND entity_id = $4
            AND requires_approval = true AND approval_status = 'pending'
            -- Y NO ESTA RECHAZADO. Sin esta linea se podia aprobar lo que se
            -- acababa de rechazar: reject no tocaba approval_status, asi que
            -- la retencion seguia "pendiente" sobre un documento muerto y el
            -- listado lo mostraba esperando una firma que ya no sirve. Se
            -- ataca por los dos lados: aqui y en la rama reject.
            AND status <> 'rejected'`,
        [orden.userId, orden.note ?? null, fila.id, orden.entityId]
      );
      if (!r.rowCount) {
        throw blockedByState(
          'no estaba pendiente de aprobación (o no requiere aprobación, o ya se rechazó)'
        );
      }
      return 'aprobado';
    }

    case 'reject': {
      const r = await query(
        // Rechazar CIERRA también la aprobación pendiente: dejarla viva
        // mantenía el documento en `bill inbox list --requires-approval`
        // esperando una firma que ya no puede servir para nada.
        // Y no se rechaza dos veces: repetirlo concatenaba una segunda nota
        // sobre el mismo documento y respondía «ok» las dos veces.
        `UPDATE pre_registrations
            SET status = 'rejected',
                notes = COALESCE(notes, '') || $1,
                approval_status = CASE
                  WHEN requires_approval AND approval_status = 'pending' THEN 'rejected'
                  ELSE approval_status END
          WHERE id = $2 AND entity_id = $3
            AND status NOT IN ('completed', 'rejected')`,
        [
          `\nRechazado: ${orden.reason}${orden.note ? ` - ${orden.note}` : ''}`,
          fila.id,
          orden.entityId,
        ]
      );
      if (!r.rowCount) {
        throw blockedByState(
          'ya está contabilizado o ya estaba rechazado: lo contabilizado no se rechaza, se reversa'
        );
      }
      return 'rechazado';
    }

    case 'set-batch': {
      const r = await query(
        `UPDATE pre_registrations
            SET scheduled_batch_id = $1, processing_mode = 'batch'
          WHERE id = $2 AND entity_id = $3 AND status NOT IN ('completed', 'rejected')`,
        [orden.batchId, fila.id, orden.entityId]
      );
      if (!r.rowCount) throw blockedByState('está completado o rechazado: ya no se programa');
      return `programado en el lote ${orden.batchId}`;
    }
  }
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
