import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import {
  listAccounts,
  getAccountById,
  resolveAccount,
  createAccount,
  updateAccount,
  deactivateAccount,
  reactivateAccount,
  ACCOUNT_TYPES,
  NORMAL_BALANCES,
  type AccountType,
  type NormalBalance,
} from '../services/accounting/account-service.js';
import { resolveReviewer } from '../ai/draft-service.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  gateMutation,
  render,
  withContext,
  withOutput,
  withSelection,
  withForce,
  resolveActiveEntity,
  requireExplicitEntity,
  usageError,
  notFound,
  exitCodeFor,
} from './kernel/index.js';

// ============================================================
// mnemosine account
// The chart of accounts from the terminal. Every command here goes
// through services/accounting/account-service.ts, the same path the
// REST API takes, so the two surfaces cannot drift.
//
// None of these are agent-invocable except the reads: an account is
// the skeleton every posting hangs from, and a chart edited by
// something that cannot be asked "why?" is a chart nobody can audit.
// ============================================================

export interface AccountCommandDeps {
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
const LIST_COLUMNS = ['code', 'name', 'account_type', 'normal_balance', 'is_active', 'children_count'] as const;

function summarize(row: Record<string, unknown>): Record<string, unknown> {
  return {
    code: row.code,
    name: row.name,
    account_type: row.account_type,
    normal_balance: row.normal_balance,
    is_active: row.is_active,
    children_count: row.children_count ?? 0,
    id: row.id,
  };
}

export function registerAccountCommand(program: Command, deps: AccountCommandDeps): void {
  const account = program
    .command('account')
    .alias('cuenta')
    .description('Chart of accounts: inspect, create and retire accounts');

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

  // ---- account list ------------------------------------------------
  const list = account
    .command('list')
    .alias('listar')
    .argument('[search]', 'match against code or name')
    .description('List accounts, filtered by type, state, parent or free text');
  withOutput(withSelection(withContext(list)));
  list
    .option('--type <type>', `account type: ${ACCOUNT_TYPES.join(', ')}`)
    .option('--parent <code>', 'only children of this account code')
    .option('--inactive', 'show inactive accounts instead of active ones');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action((search: string | undefined, opts: CommonOpts & { type?: string; parent?: string; inactive?: boolean; status?: string[] }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      if (opts.type && !(ACCOUNT_TYPES as readonly string[]).includes(opts.type)) {
        throw usageError(`Unknown --type "${opts.type}". Use one of: ${ACCOUNT_TYPES.join(', ')}.`);
      }

      let parentId: string | undefined;
      if (opts.parent) parentId = (await resolveAccount(ctx.entityId, opts.parent)).id;

      const { rows, total } = await listAccounts(ctx.entityId, {
        accountType: opts.type,
        // --all means "everything", including retired accounts.
        isActive: opts.all ? undefined : !opts.inactive,
        parentId,
        search,
        limit: opts.all ? undefined : (opts.limit ?? 50),
        offset: opts.offset,
      });

      render((rows as unknown as Record<string, unknown>[]).map(summarize), {
        ...opts,
        total,
        idField: 'code',
        fields: opts.fields ?? LIST_COLUMNS.join(','),
      });
    })
  );

  // ---- account show ------------------------------------------------
  const show = account
    .command('show')
    .alias('ver')
    .argument('<code>', 'account code or id')
    .description('Show one account with its parent, flags and lifetime activity');
  withOutput(withContext(show));
  show.option('--no-balance', 'skip the lifetime activity lookup');
  declareRisk(show, { risk: 'lectura', agent: true });
  show.action((code: string, opts: CommonOpts & { balance?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const found = await resolveAccount(ctx.entityId, code);
      const full = await getAccountById(found.id, {
        includeBalance: opts.balance !== false,
        includeHierarchy: true,
      });
      if (!full) throw notFound(`Account ${code} disappeared while reading it.`);
      render([full], { ...opts, idField: 'code' });
    })
  );

  // ---- account create ----------------------------------------------
  const create = account
    .command('create')
    .alias('crear')
    .argument('<code>', 'account code, unique within the entity')
    .argument('<name>', 'account name')
    .description('Create an account');
  withContext(create);
  create
    .requiredOption('--type <type>', `account type: ${ACCOUNT_TYPES.join(', ')}`)
    .option('--normal-balance <side>', `debit or credit (defaults from the type)`)
    .option('--parent <code>', 'parent account code')
    .option('--currency <code>', 'restrict the account to one currency (3 letters)')
    .option('--subtype <name>', 'account subtype')
    .option('--fs-category <name>', 'financial-statement caption')
    .option('--description <text>', 'description')
    .option('--header', 'a grouping node: it accepts no manual entries')
    .option('--json', 'JSON output');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'accounts' });
  create.action(
    (
      code: string,
      name: string,
      opts: CommonOpts & {
        type: string; normalBalance?: string; parent?: string; currency?: string;
        subtype?: string; fsCategory?: string; description?: string; header?: boolean;
      }
    ) =>
      run(async () => {
        // Tenant context FIRST: resolving the entity is itself a query, and RLS
        // scopes it. Reversing these two lines makes every write in this file
        // fail with "no active entity matches" under tenant isolation.
        bootstrapTenant(opts.tenant);
        const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });

        if (!(ACCOUNT_TYPES as readonly string[]).includes(opts.type)) {
          throw usageError(`Unknown --type "${opts.type}". Use one of: ${ACCOUNT_TYPES.join(', ')}.`);
        }
        const normal = (opts.normalBalance ?? defaultNormalBalance(opts.type as AccountType)) as NormalBalance;
        if (!(NORMAL_BALANCES as readonly string[]).includes(normal)) {
          throw usageError(`Unknown --normal-balance "${normal}". Use debit or credit.`);
        }

        const parentId = opts.parent ? (await resolveAccount(ctx.entityId, opts.parent)).id : null;
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

        const created = await createAccount({
          code, name,
          account_type: opts.type as AccountType,
          normal_balance: normal,
          entity_id: ctx.entityId,
          created_by: reviewer.userId,
          parent_id: parentId,
          currency_code: opts.currency ?? null,
          account_subtype: opts.subtype ?? null,
          fs_category: opts.fsCategory ?? null,
          description: opts.description ?? null,
          is_header: opts.header ?? false,
        });

        if (opts.json) {
          render([created as unknown as Record<string, unknown>], { json: true });
          return;
        }
        process.stdout.write(
          `${deps.palette.green('✔')} ${deps.palette.bold(`${created.code} ${created.name}`)} ` +
            `${deps.palette.dim(`(${created.account_type}, ${created.normal_balance})`)}\n`
        );
      })
  );

  // ---- account edit ------------------------------------------------
  const edit = account
    .command('edit')
    .alias('editar')
    .argument('<code>', 'account code or id')
    .description('Change an account name, description, subtype or statement caption');
  withContext(edit);
  edit
    .option('--name <text>', 'new name')
    .option('--description <text>', 'new description')
    .option('--subtype <name>', 'new subtype')
    .option('--fs-category <name>', 'new financial-statement caption');
  declareRisk(edit, { risk: 'escritura', agent: false, writes: 'accounts' });
  edit.action(
    (code: string, opts: CommonOpts & { name?: string; description?: string; subtype?: string; fsCategory?: string }) =>
      run(async () => {
        const ctx = await entityOf(opts);
        const target = await resolveAccount(ctx.entityId, code);
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const patch = {
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.subtype !== undefined ? { account_subtype: opts.subtype } : {}),
          ...(opts.fsCategory !== undefined ? { fs_category: opts.fsCategory } : {}),
        };
        if (Object.keys(patch).length === 0) {
          throw usageError('Nothing to change. Pass --name, --description, --subtype or --fs-category.');
        }
        const updated = await updateAccount(target.id, patch, reviewer.userId);
        process.stdout.write(`${deps.palette.green('✔')} ${updated.code} updated.\n`);
      })
  );

  // ---- account deactivate ------------------------------------------
  const deactivate = account
    .command('deactivate')
    .alias('desactivar')
    .argument('<code>', 'account code or id')
    .description('Retire an account (never deletes it; postings keep their history)');
  withContext(deactivate);
  withForce(deactivate);
  deactivate.option('--reason <text>', 'justification, required with --force');
  declareRisk(deactivate, { risk: 'escritura', agent: false, writes: 'accounts.is_active' });
  deactivate.action((code: string, opts: CommonOpts & { force?: boolean; reason?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const target = await resolveAccount(ctx.entityId, code);
      const { reason } = gateMutation(deactivate, opts as Record<string, unknown>);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

      const { hadHistory } = await deactivateAccount(target.id, reviewer.userId, {
        allowWithHistory: opts.force === true,
      });
      process.stdout.write(
        `${deps.palette.green('✔')} ${target.code} retired.` +
          (hadHistory ? deps.palette.dim(` It has posted history, which stays intact. Reason: ${reason}`) : '') +
          '\n'
      );
    })
  );

  // ---- account restore ---------------------------------------------
  const restore = account
    .command('restore')
    .alias('restaurar')
    .argument('<code>', 'account code or id')
    .description('Put a retired account back in service');
  withContext(restore);
  declareRisk(restore, { risk: 'escritura', agent: false, writes: 'accounts.is_active' });
  restore.action((code: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const target = await resolveAccount(ctx.entityId, code);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const updated = await reactivateAccount(target.id, reviewer.userId);
      process.stdout.write(`${deps.palette.green('✔')} ${updated.code} is active again.\n`);
    })
  );
}

/**
 * The natural side for a type. Stated once so `account create` does not make
 * every user remember that a contra-asset is a credit account.
 */
export function defaultNormalBalance(type: AccountType): NormalBalance {
  switch (type) {
    case 'asset':
    case 'expense':
    case 'contra_liability':
    case 'contra_equity':
      return 'debit';
    default:
      return 'credit';
  }
}
