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
  getCustomerTaxProfile,
  setCustomerTaxProfile,
  listCustomerTaxProfiles,
} from '../services/ar/customer-service.js';
import type { Palette } from './palette.js';
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

const LIST_COLUMNS = [
  'customer_number', 'name', 'payment_terms', 'currency_code',
  'credit_status', 'open_balance', 'overdue_balance', 'open_documents', 'is_active',
] as const;

const MONEY = ['open_balance', 'overdue_balance', 'credit_limit', 'open_documents'];

const TAX_ID_TYPES = ['rfc', 'ein', 'vat'] as const;

const CREDIT_STATUSES = ['approved', 'on_hold', 'suspended'] as const;

function summarize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    customer_number: row.customer_number,
    name: customerLabel(row as { company_name?: string | null }),
    payment_terms: row.payment_terms,
    currency_code: row.currency_code,
    credit_status: row.credit_status,
    // Money stays a decimal STRING all the way out (output contract).
    open_balance: row.open_balance ?? '',
    overdue_balance: row.overdue_balance ?? '',
    open_documents: row.open_documents ?? '',
    is_active: row.is_active,
    tax_id: row.tax_id ?? '',
    email: row.email ?? '',
    id: row.id,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A DATE column arrives as a local-midnight Date; print the calendar day. */
export function day(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  return value === null || value === undefined ? '' : String(value);
}

/** True when the output is a table meant for a person, not for a pipe. */
function isHumanTable(opts: CommonOpts): boolean {
  return !opts.quiet && !opts.output && resolveFormat(opts) === 'table';
}

export function registerCustomerCommand(program: Command, deps: CustomerCommandDeps): void {
  const customer = program
    .command('customer')
    .alias('cliente')
    .description('Customers: the AR master file, with the balance each one owes');

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
  const list = customer
    .command('list')
    .alias('listar')
    // The text filter is the positional query, as the catalog specifies and as
    // the sibling `invoice list [search]` already does. One concept, one
    // spelling: a `--search` flag here would make the same idea look like two.
    .argument('[query]', 'text to match in the customer name or number')
    .description('List customers with terms, credit state and the balance they owe');
  withOutput(withSelection(withContext(list)));
  list
    .option('--overdue', 'only customers with something past due')
    .option('--balance-gt <amount>', 'only customers owing more than this')
    .option('--inactive', 'show archived customers instead of active ones');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action((query: string | undefined, opts: CommonOpts & { overdue?: boolean; balanceGt?: string; inactive?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);

      if (opts.balanceGt !== undefined) {
        try {
          new Decimal(opts.balanceGt);
        } catch {
          throw usageError(`--balance-gt must be a number; got "${opts.balanceGt}".`);
        }
      }
      for (const state of opts.status ?? []) {
        if (!(CREDIT_STATUSES as readonly string[]).includes(state)) {
          throw usageError(
            `Unknown --status "${state}". A customer's lifecycle state is its credit state: ${CREDIT_STATUSES.join(', ')}.`
          );
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
        fields: opts.fields ?? LIST_COLUMNS.join(','),
      });
    })
  );

  // ---- customer show -----------------------------------------------
  const show = customer
    .command('show')
    .alias('ver')
    .argument('<ref>', 'customer number, name or id')
    .description('Show one customer: profile, tax id, credit, balance and open documents');
  withOutput(withTime(withContext(show)));
  declareRisk(show, { risk: 'lectura', agent: true });
  show.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);

      // A customer card is a point-in-time view. The range flags have no
      // meaning here and are refused rather than silently ignored; the dated
      // register is `invoice list --customer <ref> --since … --until …`.
      if (opts.period || opts.since || opts.until) {
        throw usageError(
          '`customer show` is a point-in-time card: use --as-of for the reference date. ' +
            'For a date range, use `invoice list --customer <ref> --since … --until …`.'
        );
      }
      if (opts.dateBasis && opts.dateBasis !== 'posting') {
        throw usageError(
          '--date-basis does not apply to a customer balance: it is built from the document ' +
            'date of what was billed and the payment date of what was collected, both at once.'
        );
      }

      const found = await resolveCustomer(ctx.entityId, ref);
      const card = await getCustomerById(found.id, entityScope(ctx.tenantId, ctx.entityId), {
        withBalance: true,
        includeDocuments: true,
        asOf: opts.asOf,
      });
      if (!card) throw notFound(`Customer ${ref} disappeared while reading it.`);

      const invoices = (card.open_invoices as Record<string, unknown>[]) ?? [];
      const payments = (card.recent_payments as Record<string, unknown>[]) ?? [];

      if (!isHumanTable(opts)) {
        render([card], { ...opts, idField: 'customer_number', numeric: MONEY });
        return;
      }

      const p = deps.palette;
      const out = process.stdout;
      out.write(
        `\n${p.bold(customerLabel(card as { company_name?: string | null }))} ` +
          `${p.dim(String(card.customer_number))}${card.is_active ? '' : p.yellow('  [archived]')}\n`
      );
      const fact = (label: string, value: unknown) => {
        if (value === null || value === undefined || value === '') return;
        out.write(`  ${p.dim(label.padEnd(16))}${day(value)}\n`);
      };
      fact('Tax id', card.tax_id ? `${card.tax_id}${card.tax_id_type ? ` (${String(card.tax_id_type).toUpperCase()})` : ''}` : '');
      fact('Email', card.email);
      fact('Phone', card.phone);
      fact('Terms', card.payment_terms);
      fact('Currency', card.currency_code);
      fact('Credit status', card.credit_status);
      fact('Credit limit', card.credit_limit);
      fact('Open balance', card.open_balance);
      fact('Past due', card.overdue_balance);
      fact('Oldest due', card.oldest_due_date);
      if (opts.asOf) out.write(`  ${p.dim('As of'.padEnd(16))}${opts.asOf}\n`);

      out.write(`\n${p.bold('Open documents')} ${p.dim(`(${invoices.length})`)}\n`);
      if (invoices.length) {
        render(
          invoices.map((row) => ({
            invoice: row.invoice_number,
            date: day(row.invoice_date),
            due: day(row.due_date),
            status: row.status,
            total: row.total_amount,
            due_amount: row.amount_due,
            days_overdue: row.days_overdue,
          })),
          { format: 'table', numeric: ['total', 'due_amount', 'days_overdue'] }
        );
      }

      out.write(`\n${p.bold('Recent payments')} ${p.dim(`(${payments.length})`)}\n`);
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
  const create = customer
    .command('create')
    .alias('crear')
    .description('Register a customer with its tax id, payment terms and currency');
  withContext(create);
  create
    .option('--name <text>', 'company name')
    .option('--first-name <text>', 'given name, for an individual')
    .option('--last-name <text>', 'family name, for an individual')
    .option('--tax-id <id>', 'RFC (MX), EIN (US) or VAT number')
    .option('--tax-id-type <type>', `one of: ${TAX_ID_TYPES.join(', ')}; inferred from the entity's country`)
    .option('--email <address>', 'billing contact email')
    .option('--phone <number>', 'contact phone')
    .option('--terms <text>', 'payment terms, e.g. "Net 30"')
    .option('--currency <code>', 'billing currency (3 letters)')
    .option('--json', 'JSON output');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'customers' });
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
          throw usageError('A customer needs a name: pass --name "ACME SA" or --first-name.');
        }
        const taxIdType = opts.taxIdType ?? (opts.taxId ? inferTaxIdType(ctx.country) : undefined);
        if (taxIdType && !(TAX_ID_TYPES as readonly string[]).includes(taxIdType)) {
          throw usageError(`Unknown --tax-id-type "${taxIdType}". Use one of: ${TAX_ID_TYPES.join(', ')}.`);
        }
        if (opts.currency && opts.currency.length !== 3) {
          throw usageError(`--currency must be a 3-letter code; got "${opts.currency}".`);
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
  const edit = customer
    .command('edit')
    .alias('editar')
    .argument('<ref>', 'customer number, name or id')
    .description('Change commercial and contact data; never the tax profile or credit');
  withContext(edit);
  edit
    .option('--name <text>', 'new company name')
    .option('--first-name <text>', 'new given name')
    .option('--last-name <text>', 'new family name')
    .option('--email <address>', 'new billing email')
    .option('--phone <number>', 'new phone')
    .option('--terms <text>', 'new payment terms')
    .option('--notes <text>', 'free notes stored on the customer')
    // Same spelling declareRisk uses for the undo verbs; here it is optional,
    // and supplying it is what writes the audit row with old and new values.
    .option('--reason <text>', 'justification recorded in the audit trail');
  declareRisk(edit, { risk: 'escritura', agent: false, writes: 'customers' });
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
          throw usageError(
            'Nothing to change. Pass --name, --first-name, --last-name, --email, --phone, --terms or --notes.'
          );
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const updated = await updateCustomer(target.id, entityScope(ctx.tenantId, ctx.entityId), patch, {
          audit: { userId: reviewer.userId, tenantId: ctx.tenantId, reason: opts.reason },
        });
        process.stdout.write(
          `${deps.palette.green('✔')} ${updated.customer_number} updated` +
            (opts.reason ? deps.palette.dim(` — ${opts.reason}`) : '') +
            '\n'
        );
      })
  );

  // ---- customer archive --------------------------------------------
  const archive = customer
    .command('archive')
    .alias('archivar')
    .argument('<ref>', 'customer number, name or id')
    .description('Deactivate a customer; refused while they still owe something');
  withContext(archive);
  withForce(archive);
  // 'archive' is an undo verb: declareRisk adds --reason and gateMutation requires it.
  declareRisk(archive, { risk: 'escritura', agent: false, writes: 'customers.is_active' });
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
        `${deps.palette.green('✔')} ${target.customer_number} archived.` +
          (balance.open_documents > 0
            ? deps.palette.yellow(
                ` ${balance.open_documents} open document(s) worth ${balance.open_balance} remain on the books.`
              )
            : '') +
          '\n'
      );
    })
  );

  // ---- customer restore --------------------------------------------
  const restore = customer
    .command('restore')
    .alias('restaurar')
    .argument('<ref>', 'customer number, name or id')
    .description('Put an archived customer back in service');
  withContext(restore);
  restore.option('--reason <text>', 'justification recorded in the audit trail');
  declareRisk(restore, { risk: 'escritura', agent: false, writes: 'customers.is_active' });
  restore.action((ref: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await writeEntityOf(opts);
      const target = await resolveCustomer(ctx.entityId, ref);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const updated = await restoreCustomer(target.id, entityScope(ctx.tenantId, ctx.entityId), {
        audit: { userId: reviewer.userId, tenantId: ctx.tenantId, reason: opts.reason },
      });
      process.stdout.write(`${deps.palette.green('✔')} ${updated.customer_number} is active again.\n`);
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
  const tax = customer
    .command('tax')
    .alias('fiscal')
    .description('The fiscal profile CFDI 4.0 stamps against: RFC, regime, postal code, UsoCFDI');

  // ---- customer tax show -------------------------------------------
  const taxShow = tax
    .command('show')
    .alias('ver')
    .argument('<ref>', 'customer number, name or id')
    .description('Show the fiscal profile and what is missing before this customer can be stamped');
  withOutput(withContext(taxShow));
  declareRisk(taxShow, { risk: 'lectura', agent: true });
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
      const fact = (label: string, value: unknown, extra?: string | null) => {
        out.write(
          `  ${p.dim(label.padEnd(16))}${value ? `${String(value)}${extra ? p.dim(` · ${extra}`) : ''}` : p.yellow('—')}\n`
        );
      };
      fact('RFC', perfil.tax_id);
      fact('Regime', perfil.tax_regime, perfil.tax_regime_name);
      fact('Postal code', perfil.tax_postal_code);
      fact('UsoCFDI', perfil.uso_cfdi, perfil.uso_cfdi_name);
      out.write(
        perfil.complete
          ? `\n${p.green('✔')} Complete: stamping has what the SAT padrón will be matched against.\n`
          : `\n${p.yellow('▲')} Missing ${perfil.missing.join(', ')}: a CFDI for this customer would be rejected.\n`
      );
    })
  );

  // ---- customer tax set --------------------------------------------
  const taxSet = tax
    .command('set')
    .alias('fijar')
    .argument('<ref>', 'customer number, name or id')
    .description('Set RFC, regime, postal code or UsoCFDI, validated against the SAT catalogs before writing');
  withContext(taxSet);
  taxSet
    .option('--rfc <rfc>', 'the RFC (form-validated: AAAA######XXX)')
    .option('--tax-regime <code>', 'c_RegimenFiscal code: 601, 612, 626…')
    .option('--postal-code <cp>', 'fiscal address postal code (5 digits)')
    .option('--uso-cfdi <code>', 'default c_UsoCFDI: G01, G03, P01…')
    .option('--reason <text>', 'justification recorded in the audit trail')
    .option('--json', 'JSON output');
  declareRisk(taxSet, { risk: 'escritura', agent: false, writes: 'customers.tax_regime/tax_postal_code/uso_cfdi' });
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
          `${p.green('✔')} ${p.bold(perfil.customer_number)} fiscal profile updated` +
            (perfil.complete
              ? p.dim(' · complete\n')
              : p.yellow(` · still missing ${perfil.missing.join(', ')}\n`))
        );
      })
  );

  // ---- customer tax list -------------------------------------------
  const taxList = tax
    .command('list')
    .alias('listar')
    .description('The pre-billing control: customers whose fiscal profile is incomplete or malformed');
  withOutput(withSelection(withContext(taxList)));
  taxList.option('--missing', 'only customers that could NOT be stamped today');
  declareRisk(taxList, { risk: 'lectura', agent: true });
  taxList.action((opts: CommonOpts & { missing?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      if (opts.status?.length) {
        throw usageError('`customer tax list` has no lifecycle filter: use --missing.');
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
