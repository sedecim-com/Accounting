import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import {
  listVendors,
  getVendorById,
  resolveVendor,
  createVendor,
  updateVendor,
  setVendorTerms,
  normalizeTaxId,
  taxIdTypeForCountry,
  parsePaymentTerms,
  TAX_ID_TYPES,
  type TaxIdType,
} from '../services/ap/vendor-service.js';
import { resolveAccount } from '../services/accounting/account-service.js';
import { resolveReviewer } from '../ai/draft-service.js';
import type { Palette } from './palette.js';
import { t } from '../i18n/index.js';
import { entityScope } from '../database/scope.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  withSelection,
  resolveActiveEntity,
  requireExplicitEntity,
  usageError,
  notFound,
  exitCodeFor,
  describeCommand,
  optionByKey,
  argumentByKey,
} from './kernel/index.js';

// ============================================================
// mnemosine vendor
// The vendor master from the terminal, on services/ap/
// vendor-service.ts — the same path the REST API takes.
//
// NAME COLLISION, DELIBERATELY NOT RESOLVED HERE: `mnemosine
// providers`·`proveedores` already exists and lists AI MODEL
// providers. This family owns `vendor`·`proveedor` (singular,
// never a plural alias) for the commercial vendor. Renaming the
// shipped command is the integrator's call, not this file's.
//
// Nothing that writes is agent-invocable. A vendor record is
// where money is aimed: the name, the tax id and the bank details
// decide who gets paid, and none of that may be changed by
// something that cannot be asked why.
//
// There is no bank flag anywhere in this family. Changing a
// vendor's bank details is one of the three gates a human never
// delegates, and it needs a pending state, out-of-band
// verification and a second approver — none of which exist yet.
// A `--clabe` here would look like that gate and be none of it.
// ============================================================

export interface VendorCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
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
  user?: string;
}

/** Columns worth seeing by default; --fields reaches the rest. */
const LIST_COLUMNS = [
  'vendor_number', 'company_name', 'tax_id', 'payment_terms', 'currency_code', 'is_active',
] as const;

/** The sections `vendor show --include` can add. */
export const INCLUDABLE = ['activity'] as const;

function summarize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    vendor_number: row.vendor_number,
    company_name: row.company_name,
    tax_id: row.tax_id ?? '',
    tax_id_type: row.tax_id_type ?? '',
    payment_terms: row.payment_terms,
    currency_code: row.currency_code,
    is_1099_vendor: row.is_1099_vendor,
    is_active: row.is_active,
    id: row.id,
  };
}

// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// El identificador fiscal se valida por FORMA según el país: RFC mexicano
// (3 o 4 letras, AAMMDD y homoclave) o EIN estadounidense NN-NNNNNNN. Los de
// abajo son inventados y bien formados. `--default-account` es un CÓDIGO del
// catálogo, no un nombre: 6100 Gastos de Administración.
// Prosa en inglés (idioma del nodo), datos mexicanos.
// ============================================================
const EJEMPLOS = {
  list: `
Examples:
  # Vendors with no tax id on file — the DIOT and 1099 blockers.
  mnemosine vendor list --no-tax-id
  # Archived vendors, as CSV.
  mnemosine vendor list --inactive --format csv
`,
  show: `
Examples:
  # Show the identity, the terms, the currency and the flags of a vendor.
  mnemosine vendor show "Papeleria del Centro"
  # Add the activity section to what it shows.
  mnemosine vendor show "Papeleria del Centro" --include activity
`,
  create: `
Examples:
  # A Mexican vendor, with its RFC, terms and default expense account.
  mnemosine vendor create "Papeleria del Centro SA de CV" --tax-id PCE180412TF4 --terms "Net 30" --currency MXN --default-account 6100
  # A US vendor flagged for an information return.
  mnemosine vendor create "Northwind Supplies LLC" --tax-id 47-1234567 --tax-id-type ein --currency USD --1099
`,
  edit: `
Examples:
  # Contact data, with the reason that lands in the audit row.
  mnemosine vendor edit "Papeleria del Centro" --email cobranza@papeleriadelcentro.mx --reason "Aviso de cambio del proveedor"
  # Change who to talk to and how to reach them.
  mnemosine vendor edit "Papeleria del Centro" --contact "Laura Zepeda" --phone "5555123344"
`,
  termsSet: `
Examples:
  # Early-payment terms a due date can actually be computed from.
  mnemosine vendor terms set "Papeleria del Centro" --terms "2/10 Net 30" --reason "Renegociacion de julio"
  # Settle in dollars from now on.
  mnemosine vendor terms set "Northwind Supplies LLC" --terms "Net 45" --currency USD --reason "Contrato 2026"
`,
} as const;

export function registerVendorCommand(program: Command, deps: VendorCommandDeps): void {
  const vendor = describeCommand(program.command('vendor').alias('proveedor'), 'help.vendor.description');

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

  // ---- vendor list -------------------------------------------------
  const list = describeCommand(vendor.command('list').alias('listar'), 'help.vendor.list.description');
  argumentByKey(list, '[search]', 'help.vendor.list.argument.search');
  withOutput(withSelection(withContext(list)));
  optionByKey(list, '--inactive', 'help.vendor.list.option.inactive');
  // A key segment cannot start with a digit, so --1099's keys are named after the column it reads.
  optionByKey(list, '--1099', 'help.vendor.list.option.is_1099');
  optionByKey(list, '--no-tax-id', 'help.vendor.list.option.no_tax_id');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EJEMPLOS.list);
  list.action((search: string | undefined, opts: CommonOpts & { inactive?: boolean; taxId?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const raw = opts as unknown as Record<string, unknown>;

      const { rows, total } = await listVendors(ctx.entityId, {
        // --all means everything, archived vendors included.
        isActive: opts.all ? undefined : !opts.inactive,
        search,
        is1099: raw['1099'] === true ? true : undefined,
        // Commander gives `--no-tax-id` as taxId === false.
        missingTaxId: opts.taxId === false,
        limit: opts.all ? undefined : (opts.limit ?? 50),
        offset: opts.offset,
      });

      render(rows.map(summarize), {
        ...opts,
        total,
        idField: 'vendor_number',
        // The default column set only applies when there ARE columns: an
        // empty result has no fields to name, and naming them would turn
        // "nothing matched" into a usage error.
        fields: opts.fields ?? (rows.length ? LIST_COLUMNS.join(',') : undefined),
      });
    })
  );

  // ---- vendor show -------------------------------------------------
  const show = describeCommand(vendor.command('show').alias('ver'), 'help.vendor.show.description');
  argumentByKey(show, '<vendor>', 'help.vendor.show.argument.vendor');
  withOutput(withContext(show));
  optionByKey(show, '--include <parts>', 'help.vendor.show.option.include', {
    params: { parts: INCLUDABLE.join(', ') },
  });
  declareRisk(show, { risk: 'lectura', agent: true });
  show.addHelpText('after', EJEMPLOS.show);
  show.action((ref: string, opts: CommonOpts & { include?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const parts = (opts.include ?? '').split(',').map((p) => p.trim()).filter(Boolean);
      for (const part of parts) {
        if (!(INCLUDABLE as readonly string[]).includes(part)) {
          throw usageError({ key: 'ap.vendor.show.include_unknown', params: { part, parts: INCLUDABLE.join(', ') } });
        }
      }

      const found = await resolveVendor(ctx.entityId, ref);
      const full = await getVendorById(found.id, entityScope(ctx.tenantId, ctx.entityId), { includeActivity: parts.includes('activity') });
      if (!full) throw notFound({ key: 'ap.vendor.show.disappeared', params: { ref } });

      // The encrypted bank columns never leave the service; what a reader
      // gets is bank_details_on_file, which is the fact they need.
      render([full], { ...opts, idField: 'vendor_number' });
    })
  );

  // ---- vendor create -----------------------------------------------
  const create = describeCommand(vendor.command('create').alias('crear'), 'help.vendor.create.description');
  argumentByKey(create, '<name>', 'help.vendor.create.argument.name');
  withContext(create);
  optionByKey(create, '--tax-id <id>', 'help.vendor.create.option.tax_id');
  optionByKey(create, '--tax-id-type <type>', 'help.vendor.create.option.tax_id_type', {
    params: { types: TAX_ID_TYPES.join(' | ') },
  });
  optionByKey(create, '--contact <name>', 'help.vendor.create.option.contact');
  optionByKey(create, '--email <address>', 'help.vendor.create.option.email');
  optionByKey(create, '--phone <number>', 'help.vendor.create.option.phone');
  optionByKey(create, '--terms <text>', 'help.vendor.create.option.terms', { defaultValue: 'Net 30' });
  optionByKey(create, '--currency <code>', 'help.vendor.create.option.currency');
  optionByKey(create, '--default-account <code>', 'help.vendor.create.option.default_account');
  optionByKey(create, '--1099', 'help.vendor.create.option.is_1099');
  optionByKey(create, '--json', 'help.vendor.create.option.json');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'vendors' });
  create.addHelpText('after', EJEMPLOS.create);
  create.action(
    (
      name: string,
      opts: CommonOpts & {
        taxId?: string; taxIdType?: string; contact?: string; email?: string; phone?: string;
        terms?: string; currency?: string; defaultAccount?: string;
      }
    ) =>
      run(async () => {
        // Tenant FIRST: entity resolution is itself scoped by RLS, so a
        // --tenant applied afterwards resolves nothing.
        bootstrapTenant(opts.tenant);
        const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
        const raw = opts as unknown as Record<string, unknown>;

        // ---- tax id: which country's rule, said out loud ----
        let taxId: string | null = null;
        let taxIdType: TaxIdType | null = null;
        let taxRule: string | null = null;
        if (opts.taxId) {
          const declared = opts.taxIdType ?? taxIdTypeForCountry(ctx.country);
          if (!declared) {
            throw usageError({
              key: 'ap.vendor.create.no_default_tax_id_type',
              params: { country: ctx.country, types: TAX_ID_TYPES.join('|') },
            });
          }
          if (!(TAX_ID_TYPES as readonly string[]).includes(declared)) {
            throw usageError({
              key: 'ap.vendor.create.tax_id_type_unknown',
              params: { value: declared, types: TAX_ID_TYPES.join(', ') },
            });
          }
          const checked = normalizeTaxId(opts.taxId, declared as TaxIdType);
          taxId = checked.taxId;
          taxIdType = checked.taxIdType;
          taxRule = checked.rule;
        } else if (opts.taxIdType) {
          throw usageError({ key: 'ap.vendor.create.tax_id_type_alone' });
        }

        // ---- terms: parsed now, so a due date can be computed later ----
        const terms = parsePaymentTerms(opts.terms ?? 'Net 30');
        if (!terms.recognized) {
          throw usageError({ key: 'ap.vendor.create.terms_not_understood', params: { terms: opts.terms ?? '' } });
        }

        const accountId = opts.defaultAccount
          ? (await resolveAccount(ctx.entityId, opts.defaultAccount)).id
          : null;
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const created = await createVendor({
          entity_id: ctx.entityId,
          company_name: name,
          created_by: reviewer.userId,
          contact_name: opts.contact ?? null,
          tax_id: taxId,
          tax_id_type: taxIdType,
          email: opts.email ?? null,
          phone: opts.phone ?? null,
          payment_terms: terms.normalized,
          default_expense_account_id: accountId,
          // The entity's own currency, not a hardcoded USD: a Mexican entity
          // whose vendors default to dollars revalues liabilities that never
          // existed.
          currency_code: opts.currency ?? ctx.currency,
          is_1099_vendor: raw['1099'] === true,
        });

        if (opts.json) {
          render([created], { json: true });
          return;
        }
        process.stdout.write(
          `${deps.palette.green('✔')} ${deps.palette.bold(`${created.vendor_number} ${created.company_name}`)} ` +
            `${deps.palette.dim(`(${created.payment_terms}, ${created.currency_code})`)}\n`
        );
        if (taxRule) {
          process.stderr.write(
            deps.palette.dim(`  ${t('ap.vendor.create.tax_id_accepted', { taxId: taxId ?? '', rule: taxRule })}\n`)
          );
        } else {
          process.stderr.write(deps.palette.yellow(`  ${t('ap.vendor.create.no_tax_id')}\n`));
        }
      })
  );

  // ---- vendor edit -------------------------------------------------
  const edit = describeCommand(vendor.command('edit').alias('editar'), 'help.vendor.edit.description');
  argumentByKey(edit, '<vendor>', 'help.vendor.edit.argument.vendor');
  withContext(edit);
  optionByKey(edit, '--name <text>', 'help.vendor.edit.option.name');
  optionByKey(edit, '--contact <name>', 'help.vendor.edit.option.contact');
  optionByKey(edit, '--email <address>', 'help.vendor.edit.option.email');
  optionByKey(edit, '--phone <number>', 'help.vendor.edit.option.phone');
  optionByKey(edit, '--notes <text>', 'help.vendor.edit.option.notes');
  optionByKey(edit, '--reason <text>', 'help.vendor.edit.option.reason');
  declareRisk(edit, { risk: 'escritura', agent: false, writes: 'vendors' });
  edit.addHelpText('after', EJEMPLOS.edit);
  edit.action(
    (
      ref: string,
      opts: CommonOpts & {
        name?: string; contact?: string; email?: string; phone?: string; notes?: string; reason?: string;
      }
    ) =>
      run(async () => {
        const ctx = await entityOf(opts);
        const target = await resolveVendor(ctx.entityId, ref);
        const patch = {
          ...(opts.name !== undefined ? { company_name: opts.name } : {}),
          ...(opts.contact !== undefined ? { contact_name: opts.contact } : {}),
          ...(opts.email !== undefined ? { email: opts.email } : {}),
          ...(opts.phone !== undefined ? { phone: opts.phone } : {}),
          ...(opts.notes !== undefined ? { notes: opts.notes } : {}),
        };
        if (Object.keys(patch).length === 0) {
          throw usageError({ key: 'ap.vendor.edit.nothing_to_change' });
        }
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const updated = await updateVendor(target.id, entityScope(ctx.tenantId, ctx.entityId), patch, {
          userId: reviewer.userId,
          tenantId: ctx.tenantId,
          reason: opts.reason,
        });
        process.stdout.write(
          `${deps.palette.green('✔')} ${t('ap.vendor.edit.done', {
            number: String(updated.vendor_number),
            fields: deps.palette.dim(Object.keys(patch).join(', ')),
          })}\n`
        );
      })
  );

  // ---- vendor terms set --------------------------------------------
  const terms = describeCommand(vendor.command('terms').alias('terminos'), 'help.vendor.terms.description');
  const termsSet = describeCommand(terms.command('set').alias('fijar'), 'help.vendor.terms.set.description');
  argumentByKey(termsSet, '<vendor>', 'help.vendor.terms.set.argument.vendor');
  withContext(termsSet);
  optionByKey(termsSet, '--terms <text>', 'help.vendor.terms.set.option.terms');
  optionByKey(termsSet, '--currency <code>', 'help.vendor.terms.set.option.currency');
  optionByKey(termsSet, '--reason <text>', 'help.vendor.terms.set.option.reason');
  declareRisk(termsSet, { risk: 'escritura', agent: false, writes: 'vendors.payment_terms' });
  termsSet.addHelpText('after', EJEMPLOS.termsSet);
  termsSet.action(
    (ref: string, opts: CommonOpts & { terms?: string; currency?: string; reason?: string }) =>
      run(async () => {
        const ctx = await entityOf(opts);
        if (opts.terms === undefined && opts.currency === undefined) {
          throw usageError({ key: 'ap.vendor.terms.nothing_to_set' });
        }
        const target = await resolveVendor(ctx.entityId, ref);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const { vendor: updated, terms: parsed } = await setVendorTerms(
          target.id,
          entityScope(ctx.tenantId, ctx.entityId),
          { terms: opts.terms, currencyCode: opts.currency },
          { userId: reviewer.userId, tenantId: ctx.tenantId, reason: opts.reason }
        );

        process.stdout.write(
          `${deps.palette.green('✔')} ${updated.vendor_number} → ` +
            `${deps.palette.bold(String(updated.payment_terms))} ${updated.currency_code}\n`
        );
        if (parsed) {
          const readAs = t('ap.vendor.terms.read_as', {
            net: parsed.netDays === null ? 'none' : 'days',
            days: parsed.netDays ?? 0,
            discount: parsed.discountPct === null ? 'none' : 'pct',
            pct: parsed.discountPct ?? 0,
            discountDays: parsed.discountDays ?? 0,
          });
          process.stderr.write(deps.palette.dim(`  ${readAs}\n`));
        }
      })
  );
}
