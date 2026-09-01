import type { Command } from 'commander';
import { bootstrapTenant, listEntities } from '../ai/context.js';
import {
  createEntity,
  archiveEntity,
  COUNTRY_PROFILES,
  type Country,
} from '../services/entity/entity-service.js';
import { resolveReviewer } from '../ai/draft-service.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  gateMutation,
  render,
  withContext,
  withOutput,
  withSelection,
  useEntity,
  resolveActiveEntity,
  clearActiveEntity,
  readState,
  statePath,
  notFound,
  usageError,
  globalsOf,
  exitCodeFor,
} from './kernel/index.js';

// ============================================================
// mnemosine entity
// The context mechanism a firm cannot work without: one bookkeeper,
// many client companies. `entity use` pins the company so every
// later command stops needing --entity, which is both the most
// typed flag and therefore the most mistyped one.
//
// `entity show` with no argument answers the question that matters
// before any write — "which books am I about to touch, and why
// that one?" — by naming the source of the choice, not just the
// name. A pinned entity that silently differs from the one the
// user has in mind is how a posting lands in the wrong company.
//
// Supersedes the flat `entities` command, which stays as a
// deprecated alias per the naming rulebook (R9): old names keep
// working and say so on stderr.
// ============================================================

export interface EntityCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  /** Overridable for tests; defaults to the real home directory. */
  home?: string;
}

interface ListOpts {
  tenant?: string;
  entity?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  limit?: number;
  all?: boolean;
}

export function registerEntityCommand(program: Command, deps: EntityCommandDeps): void {
  const entity = program
    .command('entity')
    .alias('entidad')
    .description('Select and inspect the legal entity commands operate on');

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  // ---- entity list -------------------------------------------------
  const list = entity
    .command('list')
    .alias('listar')
    .description('List the active legal entities');
  withOutput(withSelection(withContext(list)));
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action((opts: ListOpts) =>
    run(async () => {
      bootstrapTenant(opts.tenant);
      const all = await listEntities();
      const active = readState(deps.home).entityId;
      const limit = opts.all ? all.length : (opts.limit ?? all.length);
      const rows = all.slice(0, limit).map((e) => ({
        id: e.id,
        name: e.name,
        tax_id: e.tax_id,
        country: e.incorporation_country,
        currency: e.functional_currency,
        standard: e.accounting_standard,
        active: e.id === active ? '*' : '',
      }));
      render(rows, { ...opts, total: all.length, idField: 'id' });
    })
  );

  // ---- entity show -------------------------------------------------
  const show = entity
    .command('show')
    .alias('ver')
    .argument('[idOrName]', 'entity to describe; omit for the active one')
    .description('Show one entity — with no argument, the one commands would use, and why');
  withOutput(withContext(show));
  declareRisk(show, { risk: 'lectura', agent: true });
  show.action((idOrName: string | undefined, opts: ListOpts & { entity?: string }) =>
    run(async () => {
      bootstrapTenant(opts.tenant);
      const { ctx, source } = await resolveActiveEntity(
        { entity: idOrName ?? opts.entity },
        { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
      );
      const SOURCE_LABEL: Record<typeof source, string> = {
        flag: 'named on the command line',
        env: 'from MNEMOSINE_ENTITY',
        stored: 'pinned with `mnemosine entity use`',
        only: 'the only active entity',
      };
      render(
        [
          {
            id: ctx.entityId,
            name: ctx.entityName,
            tax_id: ctx.taxId,
            country: ctx.country,
            currency: ctx.currency,
            standard: ctx.accountingStandard,
            selected_because: SOURCE_LABEL[source],
          },
        ],
        { ...opts, idField: 'id' }
      );
    })
  );

  // ---- entity use --------------------------------------------------
  const use = entity
    .command('use')
    .alias('usar')
    .argument('<idOrName>', 'entity id, tax id, or a fragment of the name')
    .description('Pin the entity that later commands operate on');
  withContext(use);
  // Writes a local cursor, never the ledger — but not the agent's to change:
  // silently redirecting the operator's next command is exactly the kind of
  // side effect a human must own.
  declareRisk(use, { risk: 'escritura', agent: false, writes: 'active entity pointer (~/.mnemosine/state.json)' });
  use.action((idOrName: string, opts: { tenant?: string }) =>
    run(async () => {
      bootstrapTenant(opts.tenant);
      const { ctx, file } = await useEntity(idOrName, deps.home);
      process.stdout.write(
        `${deps.palette.green('✔')} Active entity: ${deps.palette.bold(ctx.entityName)} ` +
          `${deps.palette.dim(`(${ctx.taxId}, ${ctx.country}, ${ctx.currency})`)}\n`
      );
      process.stderr.write(deps.palette.dim(`  stored in ${file}\n`));
    })
  );

  // ---- entity create -----------------------------------------------
  //
  // Until now the ONLY way to create a company was the interactive wizard,
  // which held it as a private method. Every other capability in the product
  // is downstream of an entity existing, so this is the root of the tree.
  const create = entity
    .command('create')
    .alias('crear')
    .argument('<name>', 'legal name of the company')
    .description('Create a legal entity with its chart of accounts, roles and payroll mapping');
  withContext(create);
  create
    .requiredOption('--tax-id <id>', 'RFC (Mexico) or EIN (USA)')
    .option('--country <code>', `MX or USA`, 'MX')
    .option('--currency <code>', 'functional currency (defaults to the country\'s)')
    .option('--chart <strategy>', 'auto | siempre | nunca — whether to seed the base chart', 'auto')
    .option('--json', 'JSON output');
  // Creates rows but touches no ledger, and it is not the agent's to do:
  // bringing a company into existence is a decision with legal consequences.
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'legal_entities, organizations, accounts' });
  create.action(
    (
      name: string,
      _opts: ListOpts,
      command: Command
    ) =>
      run(async () => {
        // optsWithGlobals, not opts: the root program declares --tenant, so
        // Commander keeps the user's value there and this command's own
        // opts.tenant is undefined. See globalsOf() in the kernel.
        const opts = globalsOf<ListOpts & { taxId: string; country?: string; currency?: string; chart?: string }>(command);
        bootstrapTenant(opts.tenant);
        const country = (opts.country ?? 'MX').toUpperCase();
        if (!(country in COUNTRY_PROFILES)) {
          throw usageError(
            `Unknown --country "${opts.country}". Supported: ${Object.keys(COUNTRY_PROFILES).join(', ')}.`
          );
        }
        const chart = opts.chart ?? 'auto';
        if (!['auto', 'siempre', 'nunca'].includes(chart)) {
          throw usageError(`Unknown --chart "${chart}". Use auto, siempre or nunca.`);
        }

        // Attribution: a real user when one is reachable, and the tenant's
        // system account otherwise — never the entity's own id, which is what
        // the wizard used to write into created_by.
        let createdBy: string | undefined;
        if (opts.tenant) {
          try {
            createdBy = (await resolveReviewer(opts.tenant, opts.user)).userId;
          } catch {
            createdBy = undefined;
          }
        }

        const result = await createEntity({
          name,
          taxId: opts.taxId,
          country: country as Country,
          currency: opts.currency,
          tenantId: opts.tenant,
          createdBy,
          estrategia: chart as 'auto' | 'siempre' | 'nunca',
        });

        if (opts.json) {
          render([result as unknown as Record<string, unknown>], { json: true });
          return;
        }
        const p = deps.palette;
        process.stdout.write(
          `${p.green('✔')} ${p.bold(result.name)} ${p.dim(`(${result.taxId}, ${result.country}, ${result.currency})`)}\n`
        );
        process.stderr.write(p.dim(`  entity  ${result.entityId}\n`));
        process.stderr.write(p.dim(`  tenant  ${result.tenantId}\n`));
        process.stderr.write(
          p.dim(`  chart   ${result.accounting.cuentasBaseCreadas.length} account(s) seeded, ` +
            `${result.accounting.accountsCreated.length} role account(s), ` +
            `${result.accounting.nomina.bucketsMapped.length} payroll bucket(s)\n`)
        );
        for (const u of result.accounting.nomina.bucketsUnmappable) {
          process.stderr.write(
            p.yellow(`  ! payroll bucket ${u.bucket} needs account ${u.code}, which this chart lacks — map it before the first pay run\n`)
          );
        }
        if (result.attributedToSystem) {
          process.stderr.write(
            p.dim(`  attributed to the tenant's system account (no user was in session)\n`)
          );
        }
        process.stderr.write(p.dim(`  pin it with: mnemosine entity use ${result.taxId}\n`));
      })
  );

  // ---- entity archive ----------------------------------------------
  const archive = entity
    .command('archive')
    .alias('archivar')
    .argument('<idOrName>', 'entity to archive')
    .description('Archive an entity (never deletes: its ledger has to survive)');
  withContext(archive);
  // --reason is NOT declared here: declareRisk owns it for undo verbs, and
  // declaring it twice is a Commander error at startup. That collision is
  // the kernel doing its job — the safety flags have exactly one owner.
  declareRisk(archive, { risk: 'escritura', agent: false, writes: 'legal_entities.is_active' });
  archive.action((idOrName: string, opts: ListOpts & { reason?: string }) =>
    run(async () => {
      bootstrapTenant(opts.tenant);
      const { ctx } = await resolveActiveEntity({ entity: idOrName }, { home: deps.home });
      gateMutation(archive, opts as Record<string, unknown>);
      const { name } = await archiveEntity(ctx.entityId);
      if (readState(deps.home).entityId === ctx.entityId) {
        clearActiveEntity(deps.home);
        process.stderr.write(deps.palette.dim('  it was the pinned entity; the pin was cleared\n'));
      }
      process.stdout.write(`${deps.palette.green('✔')} ${name} archived.\n`);
    })
  );

  // ---- entity unset ------------------------------------------------
  const unset = entity
    .command('unset')
    .alias('limpiar')
    .description('Clear the pinned entity; commands go back to requiring --entity');
  declareRisk(unset, { risk: 'escritura', agent: false, writes: 'active entity pointer' });
  unset.action(() =>
    run(async () => {
      const had = readState(deps.home).entityName;
      clearActiveEntity(deps.home);
      process.stdout.write(
        had
          ? `${deps.palette.green('✔')} Unpinned ${had}. ${deps.palette.dim(statePath(deps.home))}\n`
          : `${deps.palette.dim('No entity was pinned.')}\n`
      );
    })
  );
}

/** Thrown when a command needs an entity and none can be determined. */
export const noEntitySelected = () =>
  notFound(
    'No entity selected. Pin one with `mnemosine entity use <id|name>`, pass --entity, ' +
      'or set MNEMOSINE_ENTITY.'
  );
