import type { Command } from 'commander';
import Decimal from 'decimal.js';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import {
  listCustomers,
  getCustomerById,
  resolveCustomer,
  createCustomer,
  updateCustomer,
  archiveCustomer,
  restoreCustomer,
  customerLabel,
  amountsByCurrency,
  describeBalance,
  type CurrencyBalance,
  getCustomerTaxProfile,
  setCustomerTaxProfile,
  listCustomerTaxProfiles,
} from '../services/ar/customer-service.js';
import type { Palette } from './palette.js';
import { t } from '../i18n/index.js';
import { entityScope } from '../database/scope.js';
import {
  declareRisk,
  gateMutation,
  render,
  resolveFormat,
  withContext,
  withOutput,
  withSelection,
  withTime,
  withForce,
  resolveActiveEntity,
  requireExplicitEntity,
  usageError,
  notFound,
  exitCodeFor,
  dateOnly as day,
  describeCommand,
  optionByKey,
  argumentByKey,
} from './kernel/index.js';

// ============================================================
// mnemosine customer · cliente
// The AR master file from the terminal, on top of
// services/ar/customer-service.ts — the same path the REST API takes.
//
// What this family shows that the tables do not hold: the OPEN BALANCE.
// It is computed from the invoices on every read, never stored, so the
// customer card and the subsidiary ledger cannot drift apart.
//
// None of the writes are agent-invocable. The catalog's IA column marks
// `customer create` and `customer edit` ✓, but neither lands in a review
// queue — they write master data directly — and the kernel refuses to
// call that agent-safe (risk.ts: an `escritura` with agent access must
// assert draftOnly). The sibling master-data family, `account`, is
// declared the same way. The agent reads the padrón; a human edits it.
//
// Credit is deliberately absent: `--credit-limit` and `credit_status`
// belong to `customer credit set|hold|release`, which need an approval
// threshold this phase does not have. `customer edit` changes commercial
// and contact data only.
// ============================================================

export interface CustomerCommandDeps {
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
  limit?: number;
  offset?: number;
  all?: boolean;
  status?: string[];
  force?: boolean;
  reason?: string;
  period?: string;
  since?: string;
  until?: string;
  asOf?: string;
  dateBasis?: string;
}

// MNE-001-741: one row per customer, as before. What is owed per currency is
// one cell (`open_by_currency`) for table and csv and a list
// (`balances_by_currency`) for json; open_balance and overdue_balance are
// book values in `book_currency`, the figure --balance-gt compares.
const LIST_COLUMNS = [
  'customer_number', 'name', 'payment_terms', 'currency_code',
  'credit_status', 'open_by_currency', 'open_balance', 'overdue_balance', 'book_currency',
  'open_documents', 'is_active',
] as const;
const JSON_LIST_COLUMNS = [...LIST_COLUMNS, 'balances_by_currency'] as const;

const MONEY = ['open_balance', 'overdue_balance', 'credit_limit', 'open_documents'];

export const TAX_ID_TYPES = ['rfc', 'ein', 'vat'] as const;

const CREDIT_STATUSES = ['approved', 'on_hold', 'suspended'] as const;

function summarize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    customer_number: row.customer_number,
    name: customerLabel(row),
    payment_terms: row.payment_terms,
    currency_code: row.currency_code,
    credit_status: row.credit_status,
    // Money stays a decimal STRING all the way out (output contract).
    open_by_currency: amountsByCurrency(row.balances_by_currency as CurrencyBalance[] | undefined),
    open_balance: row.open_balance ?? '',
    overdue_balance: row.overdue_balance ?? '',
    book_currency: row.book_currency ?? '',
    balances_by_currency: row.balances_by_currency ?? [],
    open_documents: row.open_documents ?? '',
    is_active: row.is_active,
    tax_id: row.tax_id ?? '',
    email: row.email ?? '',
    id: row.id,
  };
}


/** True when the output is a table meant for a person, not for a pipe. */
function isHumanTable(opts: CommonOpts): boolean {
  return !opts.quiet && !opts.output && resolveFormat(opts) === 'table';
}

// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// Los RFC de abajo son inventados pero con la FORMA que exige el validador
// (3 letras para persona moral, 4 para física; luego AAMMDD y homoclave de
// tres). El régimen y el UsoCFDI salen de los catálogos del SAT que el repo
// copia en sat-catalogs.ts: 601 General de Ley Personas Morales, G03 Gastos
// en general.
//
// `customer show` NO acepta un rango de fechas —lo rechaza y remite a
// `invoice list`—; lo que sí toma es `--as-of`.
// Prosa en inglés (idioma del nodo), datos mexicanos.
// ============================================================
const EJEMPLOS = {
  list: `
Examples:
  # Customers with something past due.
  mnemosine customer list --overdue
  # Those owing more than 100,000, as CSV.
  mnemosine customer list --balance-gt 100000 --format csv
`,
  show: `
Examples:
  # Profile, tax id, credit, balance and open documents.
  mnemosine customer show "Grupo Alameda"
  # The balance as it stood at the close date. A date RANGE belongs to invoice list.
  mnemosine customer show "Grupo Alameda" --as-of 2026-07-31
`,
  create: `
Examples:
  # A company: RFC of a persona moral (3 letters), terms and billing currency.
  mnemosine customer create --name "Grupo Alameda SA de CV" --tax-id GAL150623QK8 --terms "Net 30" --currency MXN --email cobranza@grupoalameda.mx
  # An individual: given and family name, and a persona fisica RFC (4 letters).
  mnemosine customer create --first-name "Maria" --last-name "Robledo Cruz" --tax-id ROCM850214J78 --tax-id-type rfc
`,
  edit: `
Examples:
  # Commercial and contact data. The tax profile is NOT edited here.
  mnemosine customer edit "Grupo Alameda" --email pagos@grupoalameda.mx --terms "Net 45" --reason "2026 commercial agreement"
  # Leave a note on the customer file.
  mnemosine customer edit "Grupo Alameda" --notes "Requires a purchase order on every invoice"
`,
  archive: `
Examples:
  # Deactivate a customer. It is an undo verb, so --reason is required.
  mnemosine customer archive "Grupo Alameda" --reason "Customer inactive since 2025"
  # Archive one that still shows a balance: --force overrides the check, never the reason.
  mnemosine customer archive "Grupo Alameda" --force --reason "Uncollectible balance already written off"
`,
  restore: `
Examples:
  # Put an archived customer back in service.
  mnemosine customer restore "Grupo Alameda"
  # With the justification that lands in the audit trail.
  mnemosine customer restore "Grupo Alameda" --reason "Reactivated with the 2026 contract"
`,
  taxShow: `
Examples:
  # The fiscal profile, and what is missing before this customer can be stamped.
  mnemosine customer tax show "Grupo Alameda"
  # As JSON, for a pre-billing gate.
  mnemosine customer tax show "Grupo Alameda" --json
`,
  taxSet: `
Examples:
  # The four fields CFDI 4.0 stamps against, validated against the SAT catalogs.
  mnemosine customer tax set "Grupo Alameda" --rfc GAL150623QK8 --tax-regime 601 --postal-code 06600 --uso-cfdi G03 --reason "Tax status certificate of July"
  # Only the default UsoCFDI.
  mnemosine customer tax set "Grupo Alameda" --uso-cfdi G01 --reason "Customer request"
`,
  taxList: `
Examples:
  # The whole pre-billing control, as CSV.
  mnemosine customer tax list --format csv
  # Only the customers that could NOT be stamped today.
  mnemosine customer tax list --missing
`,
} as const;

export function registerCustomerCommand(program: Command, deps: CustomerCommandDeps): void {
  const customer = describeCommand(program.command('customer').alias('cliente'), 'help.customer.description');

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

  // ---- customer list -----------------------------------------------
  const list = describeCommand(customer.command('list').alias('listar'), 'help.customer.list.description');
  // The text filter is the positional query, as the catalog specifies and as
  // the sibling `invoice list [search]` already does. One concept, one
  // spelling: a `--search` flag here would make the same idea look like two.
  argumentByKey(list, '[query]', 'help.customer.list.argument.query');
  withOutput(withSelection(withContext(list)));
  optionByKey(list, '--overdue', 'help.customer.list.option.overdue');
  optionByKey(list, '--balance-gt <amount>', 'help.customer.list.option.balance_gt');
  optionByKey(list, '--inactive', 'help.customer.list.option.inactive');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EJEMPLOS.list);
  list.action((query: string | undefined, opts: CommonOpts & { overdue?: boolean; balanceGt?: string; inactive?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);

      if (opts.balanceGt !== undefined) {
        try {
          new Decimal(opts.balanceGt);
        } catch {
          throw usageError({ key: 'ar.customer.list.balance_not_number', params: { value: opts.balanceGt } });
        }
      }
      for (const state of opts.status ?? []) {
        if (!(CREDIT_STATUSES as readonly string[]).includes(state)) {
          throw usageError({ key: 'ar.customer.list.status_unknown', params: { value: state, statuses: CREDIT_STATUSES.join(', ') } });
        }
      }

      const { rows, total } = await listCustomers(ctx.entityId, {
        search: query,
        // --all means everything, archived customers included.
        isActive: opts.all ? undefined : !opts.inactive,
        creditStatuses: opts.status?.length ? opts.status : undefined,
        withBalance: true,
        overdueOnly: opts.overdue === true,
        balanceGreaterThan: opts.balanceGt,
        limit: opts.all ? undefined : (opts.limit ?? 50),
        offset: opts.offset,
      });

      render((rows as unknown as Record<string, unknown>[]).map(summarize), {
        ...opts,
        total,
        idField: 'customer_number',
        numeric: MONEY,
        fields:
          opts.fields ??
          (['json', 'ndjson'].includes(resolveFormat(opts)) ? JSON_LIST_COLUMNS : LIST_COLUMNS).join(','),
      });
    })
  );

  // ---- customer show -----------------------------------------------
  const show = describeCommand(customer.command('show').alias('ver'), 'help.customer.show.description');
  argumentByKey(show, '<ref>', 'help.customer.show.argument.ref');
  withOutput(withTime(withContext(show)));
  declareRisk(show, { risk: 'lectura', agent: true });
  show.addHelpText('after', EJEMPLOS.show);
  show.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);

      // A customer card is a point-in-time view. The range flags have no
      // meaning here and are refused rather than silently ignored; the dated
      // register is `invoice list --customer <ref> --since … --until …`.
      if (opts.period || opts.since || opts.until) {
        throw usageError({ key: 'ar.customer.show.point_in_time', params: { command: 'customer show', range: 'invoice list --customer <ref> --since … --until …' } });
      }
      if (opts.dateBasis && opts.dateBasis !== 'posting') {
        throw usageError({ key: 'ar.customer.show.date_basis' });
      }

      const found = await resolveCustomer(ctx.entityId, ref);
      const card = await getCustomerById(found.id, entityScope(ctx.tenantId, ctx.entityId), {
        withBalance: true,
        includeDocuments: true,
        asOf: opts.asOf,
      });
      if (!card) throw notFound({ key: 'ar.customer.show.disappeared', params: { ref } });

      const invoices = (card.open_invoices as Record<string, unknown>[]) ?? [];
      const payments = (card.recent_payments as Record<string, unknown>[]) ?? [];

      if (!isHumanTable(opts)) {
        render([card], { ...opts, idField: 'customer_number', numeric: MONEY });
        return;
      }

      const p = deps.palette;
      const out = process.stdout;
      out.write(
        `\n${p.bold(customerLabel(card))} ` +
          `${p.dim(String(card.customer_number))}${card.is_active ? '' : p.yellow(`  ${t('ar.customer.show.archived')}`)}\n`
      );
      // The labels pad to the longest one (16 at least, the English width).
      const labels = ['tax_id', 'email', 'phone', 'terms', 'currency', 'credit_status', 'credit_limit', 'amount_due', 'past_due', 'book_value', 'oldest_due', 'as_of'] as const;
      const width = Math.max(16, ...labels.map((l) => t(`ar.customer.show.${l}`).length + 1));
      const fact = (label: string, value: unknown) => {
        if (value === null || value === undefined || value === '') return;
        out.write(`  ${p.dim(label.padEnd(width))}${day(value)}\n`);
      };
      fact(t('ar.customer.show.tax_id'), card.tax_id ? `${card.tax_id}${card.tax_id_type ? ` (${String(card.tax_id_type).toUpperCase()})` : ''}` : '');
      fact(t('ar.customer.show.email'), card.email);
      fact(t('ar.customer.show.phone'), card.phone);
      fact(t('ar.customer.show.terms'), card.payment_terms);
      fact(t('ar.customer.show.currency'), card.currency_code);
      fact(t('ar.customer.show.credit_status'), card.credit_status);
      fact(t('ar.customer.show.credit_limit'), card.credit_limit);
      // What is still owed after cash AND credit notes — the same measure as an
      // invoice's `amount_due` — not "open balance", which read as cash only.
      // MNE-001-741: per currency, never added; the book value in the
      // functional currency only when a foreign currency is in it.
      const balances = card.balances_by_currency as CurrencyBalance[];
      fact(t('ar.customer.show.amount_due'), amountsByCurrency(balances) || card.open_balance);
      fact(t('ar.customer.show.past_due'), amountsByCurrency(balances.filter((b) => new Decimal(b.overdue_balance).gt(0)), 'overdue_balance'));
      if (balances.some((b) => b.currency_code !== card.book_currency)) {
        fact(t('ar.customer.show.book_value'), `${String(card.open_balance)} ${String(card.book_currency)}`);
      }
      fact(t('ar.customer.show.oldest_due'), card.oldest_due_date);
      if (opts.asOf) out.write(`  ${p.dim(t('ar.customer.show.as_of').padEnd(width))}${opts.asOf}\n`);

      out.write(`\n${p.bold(t('ar.customer.show.open_documents'))} ${p.dim(`(${invoices.length})`)}\n`);
      if (invoices.length) {
        render(
          invoices.map((row) => ({
            invoice: row.invoice_number,
            date: day(row.invoice_date),
            due: day(row.due_date),
            status: row.status,
            currency: row.currency_code,
            total: row.total_amount,
            due_amount: row.amount_due,
            book_due: row.book_amount_due,
            days_overdue: row.days_overdue,
          })),
          { format: 'table', numeric: ['total', 'due_amount', 'book_due', 'days_overdue'] }
        );
      }

      out.write(`\n${p.bold(t('ar.customer.show.recent_payments'))} ${p.dim(`(${payments.length})`)}\n`);
      if (payments.length) {
        render(
          payments.map((row) => ({
            payment: row.payment_number,
            date: day(row.payment_date),
            amount: row.payment_amount,
            method: row.payment_method,
            status: row.status,
          })),
          { format: 'table', numeric: ['amount'] }
        );
      }
      out.write('\n');
    })
  );

  // ---- customer create ---------------------------------------------
  const create = describeCommand(customer.command('create').alias('crear'), 'help.customer.create.description');
  withContext(create);
  optionByKey(create, '--name <text>', 'help.customer.create.option.name');
  optionByKey(create, '--first-name <text>', 'help.customer.create.option.first_name');
  optionByKey(create, '--last-name <text>', 'help.customer.create.option.last_name');
  optionByKey(create, '--tax-id <id>', 'help.customer.create.option.tax_id');
  optionByKey(create, '--tax-id-type <type>', 'help.customer.create.option.tax_id_type', {
    params: { types: TAX_ID_TYPES.join(', ') },
  });
  optionByKey(create, '--email <address>', 'help.customer.create.option.email');
  optionByKey(create, '--phone <number>', 'help.customer.create.option.phone');
  optionByKey(create, '--terms <text>', 'help.customer.create.option.terms');
  optionByKey(create, '--currency <code>', 'help.customer.create.option.currency');
  optionByKey(create, '--json', 'help.customer.create.option.json');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'customers' });
  create.addHelpText('after', EJEMPLOS.create);
  create.action(
    (
      opts: CommonOpts & {
        name?: string; firstName?: string; lastName?: string;
        taxId?: string; taxIdType?: string; email?: string; phone?: string;
        terms?: string; currency?: string;
      }
    ) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);

        if (!opts.name && !opts.firstName) {
          throw usageError({ key: 'ar.customer.create.name_missing' });
        }
        const taxIdType = opts.taxIdType ?? (opts.taxId ? inferTaxIdType(ctx.country) : undefined);
        if (taxIdType && !(TAX_ID_TYPES as readonly string[]).includes(taxIdType)) {
          throw usageError({ key: 'ap.vendor.create.tax_id_type_unknown', params: { value: taxIdType, types: TAX_ID_TYPES.join(', ') } });
        }
        if (opts.currency && opts.currency.length !== 3) {
          throw usageError({ key: 'ar.customer.create.currency_invalid', params: { value: opts.currency } });
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const created = await createCustomer({
          entity_id: ctx.entityId,
          created_by: reviewer.userId,
          company_name: opts.name ?? null,
          first_name: opts.firstName ?? null,
          last_name: opts.lastName ?? null,
          tax_id: opts.taxId ?? null,
          tax_id_type: taxIdType ?? null,
          email: opts.email ?? null,
          phone: opts.phone ?? null,
          payment_terms: opts.terms ?? null,
          currency_code: opts.currency ? opts.currency.toUpperCase() : ctx.currency,
        });

        if (opts.json) {
          render([created as unknown as Record<string, unknown>], { json: true });
          return;
        }
        process.stdout.write(
          `${deps.palette.green('✔')} ${deps.palette.bold(`${created.customer_number} ${customerLabel(created)}`)} ` +
            `${deps.palette.dim(`(${created.payment_terms}, ${created.currency_code})`)}\n`
        );
      })
  );

  // ---- customer edit -----------------------------------------------
  const edit = describeCommand(customer.command('edit').alias('editar'), 'help.customer.edit.description');
  argumentByKey(edit, '<ref>', 'help.customer.edit.argument.ref');
  withContext(edit);
  optionByKey(edit, '--name <text>', 'help.customer.edit.option.name');
  optionByKey(edit, '--first-name <text>', 'help.customer.edit.option.first_name');
  optionByKey(edit, '--last-name <text>', 'help.customer.edit.option.last_name');
  optionByKey(edit, '--email <address>', 'help.customer.edit.option.email');
  optionByKey(edit, '--phone <number>', 'help.customer.edit.option.phone');
  optionByKey(edit, '--terms <text>', 'help.customer.edit.option.terms');
  optionByKey(edit, '--notes <text>', 'help.customer.edit.option.notes');
  // Same spelling declareRisk uses for the undo verbs; here it is optional,
  // and supplying it is what writes the audit row with old and new values.
  optionByKey(edit, '--reason <text>', 'help.customer.edit.option.reason');
  declareRisk(edit, { risk: 'escritura', agent: false, writes: 'customers' });
  edit.addHelpText('after', EJEMPLOS.edit);
  edit.action(
    (
      ref: string,
      opts: CommonOpts & {
        name?: string; firstName?: string; lastName?: string;
        email?: string; phone?: string; terms?: string; notes?: string;
      }
    ) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);
        const target = await resolveCustomer(ctx.entityId, ref);
        const patch = {
          ...(opts.name !== undefined ? { company_name: opts.name } : {}),
          ...(opts.firstName !== undefined ? { first_name: opts.firstName } : {}),
          ...(opts.lastName !== undefined ? { last_name: opts.lastName } : {}),
          ...(opts.email !== undefined ? { email: opts.email } : {}),
          ...(opts.phone !== undefined ? { phone: opts.phone } : {}),
          ...(opts.terms !== undefined ? { payment_terms: opts.terms } : {}),
          ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
        };
        if (Object.keys(patch).length === 0) {
          throw usageError({ key: 'ar.customer.edit.nothing_to_change' });
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const updated = await updateCustomer(target.id, entityScope(ctx.tenantId, ctx.entityId), patch, {
          audit: { userId: reviewer.userId, tenantId: ctx.tenantId, reason: opts.reason },
        });
        process.stdout.write(
          `${deps.palette.green('✔')} ${t('ar.customer.edit.updated', { number: updated.customer_number })}` +
            (opts.reason ? deps.palette.dim(` — ${opts.reason}`) : '') +
            '\n'
        );
      })
  );

  // ---- customer archive --------------------------------------------
  const archive = describeCommand(customer.command('archive').alias('archivar'), 'help.customer.archive.description');
  argumentByKey(archive, '<ref>', 'help.customer.archive.argument.ref');
  withContext(archive);
  withForce(archive);
  // 'archive' is an undo verb: declareRisk adds --reason and gateMutation requires it.
  declareRisk(archive, { risk: 'escritura', agent: false, writes: 'customers.is_active' });
  archive.addHelpText('after', EJEMPLOS.archive);
  archive.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await writeEntityOf(opts);
      const target = await resolveCustomer(ctx.entityId, ref);
      const { reason } = gateMutation(archive, opts as Record<string, unknown>);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

      const { balance } = await archiveCustomer(target.id, entityScope(ctx.tenantId, ctx.entityId), {
        allowWithBalance: opts.force === true,
        audit: { userId: reviewer.userId, tenantId: ctx.tenantId, reason },
      });

      process.stdout.write(
        `${deps.palette.green('✔')} ${t('ar.customer.archive.archived', { number: target.customer_number })}` +
          (balance.open_documents > 0
            ? deps.palette.yellow(
                ` ${t('ar.customer.archive.open_documents', { count: balance.open_documents, balance: describeBalance(balance) })}`
              )
            : '') +
          '\n'
      );
    })
  );

  // ---- customer restore --------------------------------------------
  const restore = describeCommand(customer.command('restore').alias('restaurar'), 'help.customer.restore.description');
  argumentByKey(restore, '<ref>', 'help.customer.restore.argument.ref');
  withContext(restore);
  optionByKey(restore, '--reason <text>', 'help.customer.restore.option.reason');
  declareRisk(restore, { risk: 'escritura', agent: false, writes: 'customers.is_active' });
  restore.addHelpText('after', EJEMPLOS.restore);
  restore.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await writeEntityOf(opts);
      const target = await resolveCustomer(ctx.entityId, ref);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const updated = await restoreCustomer(target.id, entityScope(ctx.tenantId, ctx.entityId), {
        audit: { userId: reviewer.userId, tenantId: ctx.tenantId, reason: opts.reason },
      });
      process.stdout.write(`${deps.palette.green('✔')} ${t('ar.customer.restore.active', { number: updated.customer_number })}\n`);
    })
  );

  // ============================================================
  // customer tax · cliente fiscal (F03)
  // El perfil que el CFDI 4.0 valida contra el padrón del SAT: RFC,
  // régimen, CP y UsoCFDI. Sin él, el timbrado rechaza; con él, el
  // control previo a facturar (`tax list --missing`) tiene qué medir.
  // La validación contra el padrón VIVO (tax check, vía PAC) queda
  // fuera hasta la decisión §5.
  // ============================================================
  const tax = describeCommand(customer.command('tax').alias('fiscal'), 'help.customer.tax.description');

  // ---- customer tax show -------------------------------------------
  const taxShow = describeCommand(tax.command('show').alias('ver'), 'help.customer.tax.show.description');
  argumentByKey(taxShow, '<ref>', 'help.customer.tax.show.argument.ref');
  withOutput(withContext(taxShow));
  declareRisk(taxShow, { risk: 'lectura', agent: true });
  taxShow.addHelpText('after', EJEMPLOS.taxShow);
  taxShow.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const target = await resolveCustomer(ctx.entityId, ref);
      const perfil = await getCustomerTaxProfile(
        String(target.id),
        entityScope(ctx.tenantId, ctx.entityId)
      );
      const p = deps.palette;
      if (opts.json || opts.output || opts.format) {
        render([perfil as unknown as Record<string, unknown>], { ...opts, idField: 'customer_number' });
        return;
      }
      const out = process.stdout;
      out.write(`\n${p.bold(perfil.customer_number)}  ${perfil.name ?? ''}\n`);
      const fact = (label: string, value: string | null | undefined, extra?: string | null) => {
        out.write(
          `  ${p.dim(label.padEnd(16))}${value ? `${String(value)}${extra ? p.dim(` · ${extra}`) : ''}` : p.yellow('—')}\n`
        );
      };
      fact('RFC', perfil.tax_id);
      fact(t('ar.customer.tax.regime'), perfil.tax_regime, perfil.tax_regime_name);
      fact(t('ar.customer.tax.postal_code'), perfil.tax_postal_code);
      fact('UsoCFDI', perfil.uso_cfdi, perfil.uso_cfdi_name);
      out.write(
        perfil.complete
          ? `\n${p.green('✔')} ${t('ar.customer.tax.complete')}\n`
          : `\n${p.yellow('▲')} ${t('ar.customer.tax.missing', { missing: perfil.missing.join(', ') })}\n`
      );
    })
  );

  // ---- customer tax set --------------------------------------------
  const taxSet = describeCommand(tax.command('set').alias('fijar'), 'help.customer.tax.set.description');
  argumentByKey(taxSet, '<ref>', 'help.customer.tax.set.argument.ref');
  withContext(taxSet);
  // The RFC mask goes in as a parameter: the catalog check reads a literal # as an unfilled plural count.
  optionByKey(taxSet, '--rfc <rfc>', 'help.customer.tax.set.option.rfc', { params: { shape: 'AAAA######XXX' } });
  optionByKey(taxSet, '--tax-regime <code>', 'help.customer.tax.set.option.tax_regime');
  optionByKey(taxSet, '--postal-code <cp>', 'help.customer.tax.set.option.postal_code');
  optionByKey(taxSet, '--uso-cfdi <code>', 'help.customer.tax.set.option.uso_cfdi');
  optionByKey(taxSet, '--reason <text>', 'help.customer.tax.set.option.reason');
  optionByKey(taxSet, '--json', 'help.customer.tax.set.option.json');
  declareRisk(taxSet, { risk: 'escritura', agent: false, writes: 'customers.tax_regime/tax_postal_code/uso_cfdi' });
  taxSet.addHelpText('after', EJEMPLOS.taxSet);
  taxSet.action(
    (
      ref: string,
      opts: CommonOpts & { rfc?: string; taxRegime?: string; postalCode?: string; usoCfdi?: string }
    ) =>
      run(async () => {
        const ctx = await writeEntityOf(opts);
        const target = await resolveCustomer(ctx.entityId, ref);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const perfil = await setCustomerTaxProfile(
          String(target.id),
          entityScope(ctx.tenantId, ctx.entityId),
          {
            taxId: opts.rfc,
            taxRegime: opts.taxRegime,
            postalCode: opts.postalCode,
            usoCfdi: opts.usoCfdi,
          },
          { userId: reviewer.userId, tenantId: ctx.tenantId, reason: opts.reason }
        );
        if (opts.json) {
          render([perfil as unknown as Record<string, unknown>], { json: true });
          return;
        }
        const p = deps.palette;
        process.stdout.write(
          `${p.green('✔')} ${t('ar.customer.tax.updated', { number: p.bold(perfil.customer_number) })}` +
            (perfil.complete
              ? p.dim(` · ${t('ar.customer.tax.updated_complete')}\n`)
              : p.yellow(` · ${t('ar.customer.tax.still_missing', { missing: perfil.missing.join(', ') })}\n`))
        );
      })
  );

  // ---- customer tax list -------------------------------------------
  const taxList = describeCommand(tax.command('list').alias('listar'), 'help.customer.tax.list.description');
  withOutput(withSelection(withContext(taxList)));
  optionByKey(taxList, '--missing', 'help.customer.tax.list.option.missing');
  declareRisk(taxList, { risk: 'lectura', agent: true });
  taxList.addHelpText('after', EJEMPLOS.taxList);
  taxList.action((opts: CommonOpts & { missing?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      if (opts.status?.length) {
        throw usageError({ key: 'ar.customer.tax.list_no_status', params: { command: 'customer tax list' } });
      }
      const { rows, total } = await listCustomerTaxProfiles(
        entityScope(ctx.tenantId, ctx.entityId),
        { missing: opts.missing, limit: opts.all ? 500 : (opts.limit ?? 100) }
      );
      render(
        rows.map((r) => ({
          customer_number: r.customer_number,
          name: r.name ?? '',
          rfc: r.tax_id ?? '',
          regime: r.tax_regime ?? '',
          postal_code: r.tax_postal_code ?? '',
          uso_cfdi: r.uso_cfdi ?? '',
          complete: r.complete ? 'yes' : `missing: ${r.missing.join(',')}`,
          id: r.id,
        })),
        {
          ...opts,
          total,
          idField: 'customer_number',
          fields: opts.fields ?? 'customer_number,name,rfc,regime,postal_code,uso_cfdi,complete',
        }
      );
    })
  );
}

/**
 * The tax id a country actually issues. Only a default: `--tax-id-type`
 * always wins, and a customer abroad is exactly why the flag exists.
 */
export function inferTaxIdType(country: string | undefined): string | undefined {
  switch ((country ?? '').toUpperCase()) {
    case 'MX':
      return 'rfc';
    case 'US':
      return 'ein';
    default:
      return undefined;
  }
}
