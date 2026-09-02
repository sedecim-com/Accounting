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
  # Identity, terms, currency and flags.
  mnemosine vendor show "Papeleria del Centro"
  # Add the activity section.
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
  const vendor = program
    .command('vendor')
    .alias('proveedor')
    .description('Vendor master: who we owe money to, on what terms, under which tax id');

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
  const list = vendor
    .command('list')
    .alias('listar')
    .argument('[search]', 'match against company name or vendor number')
    .description('List vendors, filtered by state, 1099 flag or a missing tax id');
  withOutput(withSelection(withContext(list)));
  list
    .option('--inactive', 'show archived vendors instead of active ones')
    .option('--1099', 'only vendors flagged for a US information return')
    .option('--no-tax-id', 'only vendors with no tax id on file (the DIOT/1099 blockers)');
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
  const INCLUDABLE = ['activity'] as const;
  const show = vendor
    .command('show')
    .alias('ver')
    .argument('<vendor>', 'vendor number, name or id')
    .description('Show one vendor: identity, terms, currency and flags');
  withOutput(withContext(show));
  show.option('--include <parts>', `extra sections, comma-separated: ${INCLUDABLE.join(', ')}`);
  declareRisk(show, { risk: 'lectura', agent: true });
  show.addHelpText('after', EJEMPLOS.show);
  show.action((ref: string, opts: CommonOpts & { include?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const parts = (opts.include ?? '').split(',').map((p) => p.trim()).filter(Boolean);
      for (const part of parts) {
        if (!(INCLUDABLE as readonly string[]).includes(part)) {
          throw usageError(
            `Cannot include "${part}". This command can include: ${INCLUDABLE.join(', ')}. ` +
              '"compliance" needs the vendor_tax_profiles and vendor_compliance_checks tables, and ' +
              '"bank" needs the audited decrypt path — neither exists yet.'
          );
        }
      }

      const found = await resolveVendor(ctx.entityId, ref);
      const full = await getVendorById(found.id, entityScope(ctx.tenantId, ctx.entityId), { includeActivity: parts.includes('activity') });
      if (!full) throw notFound(`Vendor ${ref} disappeared while reading it.`);

      // The encrypted bank columns never leave the service; what a reader
      // gets is bank_details_on_file, which is the fact they need.
      render([full], { ...opts, idField: 'vendor_number' });
    })
  );

  // ---- vendor create -----------------------------------------------
  const create = vendor
    .command('create')
    .alias('crear')
    .argument('<name>', 'company name')
    .description('Register a vendor with its tax id, terms, currency and default expense account');
  withContext(create);
  create
    .option('--tax-id <id>', 'RFC (Mexico), EIN (USA) or VAT number')
    .option('--tax-id-type <type>', `${TAX_ID_TYPES.join(' | ')} (defaults from the entity's country)`)
    .option('--contact <name>', 'contact person')
    .option('--email <address>', 'contact email')
    .option('--phone <number>', 'contact phone')
    .option('--terms <text>', 'payment terms: "Net 30", "2/10 Net 30", "Due on receipt"', 'Net 30')
    .option('--currency <code>', "3-letter ISO code (defaults to the entity's functional currency)")
    .option('--default-account <code>', 'default expense account, by code')
    .option('--1099', 'flag the vendor for a US information return')
    .option('--json', 'JSON output');
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
            throw usageError(
              `This entity is incorporated in "${ctx.country}", which has no default tax id type. ` +
                `Say which one with --tax-id-type ${TAX_ID_TYPES.join('|')}.`
            );
          }
          if (!(TAX_ID_TYPES as readonly string[]).includes(declared)) {
            throw usageError(`Unknown --tax-id-type "${declared}". Use one of: ${TAX_ID_TYPES.join(', ')}.`);
          }
          const checked = normalizeTaxId(opts.taxId, declared as TaxIdType);
          taxId = checked.taxId;
          taxIdType = checked.taxIdType;
          taxRule = checked.rule;
        } else if (opts.taxIdType) {
          throw usageError('--tax-id-type was given without --tax-id.');
        }

        // ---- terms: parsed now, so a due date can be computed later ----
        const terms = parsePaymentTerms(opts.terms ?? 'Net 30');
        if (!terms.recognized) {
          throw usageError(
            `Payment terms "${opts.terms}" were not understood, so no due date could ever be computed ` +
              'from them. Use "Net 30", "2/10 Net 30" or "Due on receipt".'
          );
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
          process.stderr.write(deps.palette.dim(`  Tax id ${taxId} accepted under: ${taxRule}.\n`));
        } else {
          process.stderr.write(
            deps.palette.yellow(
              '  No tax id on file. A received CFDI cannot be matched to this vendor and it cannot appear in a DIOT or a 1099.\n'
            )
          );
        }
      })
  );

  // ---- vendor edit -------------------------------------------------
  const edit = vendor
    .command('edit')
    .alias('editar')
    .argument('<vendor>', 'vendor number, name or id')
    .description('Change the non-banking, non-fiscal details of a vendor, leaving an audit row');
  withContext(edit);
  edit
    .option('--name <text>', 'new company name')
    .option('--contact <name>', 'new contact person')
    .option('--email <address>', 'new email')
    .option('--phone <number>', 'new phone')
    .option('--notes <text>', 'replace the notes')
    .option('--reason <text>', 'why the change was made; recorded in the audit trail');
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
          throw usageError(
            'Nothing to change. Pass --name, --contact, --email, --phone or --notes. ' +
              'Payment terms are `vendor terms set`; bank details are not editable from here.'
          );
        }
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const updated = await updateVendor(target.id, entityScope(ctx.tenantId, ctx.entityId), patch, {
          userId: reviewer.userId,
          tenantId: ctx.tenantId,
          reason: opts.reason,
        });
        process.stdout.write(
          `${deps.palette.green('✔')} ${updated.vendor_number} updated ` +
            `${deps.palette.dim(`(${Object.keys(patch).join(', ')})`)}\n`
        );
      })
  );

  // ---- vendor terms set --------------------------------------------
  const terms = vendor.command('terms').alias('terminos').description('Payment terms');
  const termsSet = terms
    .command('set')
    .alias('fijar')
    .argument('<vendor>', 'vendor number, name or id')
    .description('Set payment terms and settlement currency, validated so a due date can be computed');
  withContext(termsSet);
  termsSet
    .option('--terms <text>', '"Net 30", "2/10 Net 30", "Due on receipt"')
    .option('--currency <code>', '3-letter ISO code')
    .option('--reason <text>', 'why the change was made; recorded in the audit trail');
  declareRisk(termsSet, { risk: 'escritura', agent: false, writes: 'vendors.payment_terms' });
  termsSet.addHelpText('after', EJEMPLOS.termsSet);
  termsSet.action(
    (ref: string, opts: CommonOpts & { terms?: string; currency?: string; reason?: string }) =>
      run(async () => {
        const ctx = await entityOf(opts);
        if (opts.terms === undefined && opts.currency === undefined) {
          throw usageError('Nothing to set. Pass --terms, --currency, or both.');
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
          const due = parsed.netDays === null ? 'no net term' : `due ${parsed.netDays} days after the bill date`;
          const disc = parsed.discountPct === null
            ? ''
            : `, ${parsed.discountPct}% off if paid within ${parsed.discountDays} days`;
          process.stderr.write(deps.palette.dim(`  Read as: ${due}${disc}.\n`));
        }
      })
  );
}
