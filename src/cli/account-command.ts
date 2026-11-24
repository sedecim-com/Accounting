import type { Command } from 'commander';
import { t } from '../i18n/index.js';
import { dayOrToday } from '../services/policy/today.js';
import { bootstrapTenant } from '../ai/context.js';
import * as fs from 'node:fs';
import {
  listAccounts,
  getAccountById,
  resolveAccount,
  createAccount,
  updateAccount,
  deactivateAccount,
  reactivateAccount,
  setAccountGovernance,
  getAccountBalanceByPeriod,
  setAccountMapping,
  listAccountMappings,
  importAccountMappings,
  checkMappingCoverageDetallada,
  resolverEsquema,
  MAPPING_SCHEMES,
  ACCOUNT_TYPES,
  NORMAL_BALANCES,
  type AccountType,
  type NormalBalance,
  type GovernanceFlags,
} from '../services/accounting/account-service.js';
import {
  prepararValidacionAgrupador,
  exigirAgrupadorValido,
  type ResultadoValidacionAgrupador,
} from '../services/accounting/sat-agrupadores.js';
import {
  listAccountRoles,
  setAccountRole,
  rolesValidos,
} from '../services/accounting/account-roles-service.js';
import { seedAccountRoles } from '../services/xml-ingestion/account-roles-seed.js';
import {
  applyWithholdingLayout,
  censusWithholdingLayout,
  describeWithholdingPlan,
  hasWork,
} from '../services/accounting/withholding-accounts.js';
import { conLlave, hashDeCarga } from '../services/idempotency/idempotency-store.js';
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
  withStrict,
  resolveActiveEntity,
  requireExplicitEntity,
  usageError,
  notFound,
  exitCodeFor,
  checkExitCode,
  ExitCode,
  describeCommand,
  optionByKey,
  argumentByKey,
} from './kernel/index.js';
import { changePolicyHint } from '../services/policy/policy-hint.js';

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

// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// Todo lo que esta familia toma por `<code>` es el CÓDIGO del catálogo, no el
// nombre ni un uuid; los que aparecen abajo existen en el catálogo base que
// siembra chart-seed.ts (1110 Caja y Bancos, 1111 Banco Nacional MXN, 1120
// CxC, 1130 IVA Acreditable, 2110 CxP, 6100 Gastos de Administración).
//
// `account map import` es la tarea de alta más pesada de un despacho
// mexicano, así que su ejemplo enseña el ensayo antes que la carga.
// Prosa en inglés (idioma del nodo), datos mexicanos.
// ============================================================
const EJEMPLOS = {
  list: `
Examples:
  # Every active expense account.
  mnemosine account list --type expense
  # The children of Caja y Bancos (1110), which is where bank accounts hang.
  mnemosine account list --parent 1110
  # Retired accounts only, as CSV.
  mnemosine account list --inactive --format csv
`,
  show: `
Examples:
  # One account with its parent, its governance flags and its lifetime activity.
  mnemosine account show 1130
  # Skip the balance lookup, which is the slow part.
  mnemosine account show 1130 --no-balance
`,
  // MNE-001-229: by key, with the command lines as parameters (`help.account.create.examples`).
  create: () =>
    t('help.account.create.examples', {
      comment: '#',
      expense: 'mnemosine account create 6150 "Mantenimiento de oficina" --type expense --parent 6100',
      header: 'mnemosine account create 1250 "Activo Intangible" --type asset --parent 1200 --header',
    }),
  edit: `
Examples:
  # Rename an account. Its code, its type and its normal balance do not change here.
  mnemosine account edit 6150 --name "Mantenimiento y conservacion"
  # Move it to another financial-statement caption.
  mnemosine account edit 6150 --fs-category operating_expenses --subtype operating_expense
`,
  archive: `
Examples:
  # Retire an account. It is an undo verb, so --reason is required and audited.
  mnemosine account archive 6150 --reason "Sustituida por 6151 en el catalogo del despacho"
  # Run the checks and report first; --dry-run needs no reason because it writes nothing.
  mnemosine account archive 6150 --dry-run
`,
  set: `
Examples:
  # Make receivables a control account whose detail lives in the subledger.
  mnemosine account set 1120 control-account=true require-subsidiary=true
  # Restrict the dollar bank account to USD, validating before writing.
  mnemosine account set 1112 currency=USD --dry-run
`,
  balanceShow: `
Examples:
  # The bank account period by period: beginning, debits, credits, ending.
  mnemosine account balance show 1111
  # Only the period that contains a date.
  mnemosine account balance show 1111 --as-of 2026-07-31
`,
  roleList: `
Examples:
  # Every semantic role and the account automatic posting will use for it.
  mnemosine account role list
  # Just the creditable-VAT role.
  mnemosine account role list --role iva_acreditable
`,
  roleSet: `
Examples:
  # Repoint the creditable-VAT role at another account.
  mnemosine account role set iva_acreditable 1130 --note "Catalogo del despacho"
  # Validate the change without writing it.
  mnemosine account role set banco 1111 --dry-run
`,
  roleSeed: `
Examples:
  # Create the base accounts that are missing and map every UNMAPPED role.
  # It never overwrites a role someone pointed by hand.
  mnemosine account role seed
  # Do it on a named entity instead of the active one.
  mnemosine account role seed --entity "Molinos del Bajio SA de CV"
`,
  roleSync: `
Examples:
  # What would move for the withholding layout the panel chose, without writing.
  mnemosine account role sync --dry-run
  # Create the missing accounts and repoint the roles, audited.
  mnemosine account role sync --entity "Molinos del Bajio SA de CV"
`,
  mapSet: `
Examples:
  # Give the creditable-VAT account its SAT agrupador code (Anexo 24).
  mnemosine account map set 1130 --scheme sat-agrupador --value 118.01
  # Clear a mapping: an empty --value.
  mnemosine account map set 1130 --scheme sat-agrupador --value ""
`,
  mapList: `
Examples:
  # Every active account with its statutory mappings.
  mnemosine account map list
  # Only the SAT agrupador column, as CSV.
  mnemosine account map list --scheme sat-agrupador --format csv
`,
  mapImport: `
Examples:
  # Parse the CSV (one "code,value" per line) and resolve every account; write nothing.
  mnemosine account map import ./agrupador.csv --scheme sat-agrupador --dry-run
  # Load it for real, replay-safe: the same key and file return the first result.
  mnemosine account map import ./agrupador.csv --scheme sat-agrupador --idempotency-key agrupador-2026
`,
  // SIN --level, y no es un detalle de estilo: F07a la retiró y hoy la hoja la
  // RECHAZA con salida 2. Estos dos ejemplos llegaron de S-UX cuando la bandera
  // aún recortaba, y al fusionar quedaban documentando el 100 % de las
  // invocaciones de esta hoja con una bandera que muere. Peor: el corpus que
  // lee el agente se regenera de aquí, así que le habríamos enseñado dos
  // órdenes que el binario contesta con un error. La población la fija ahora la
  // política, y eso es lo que el segundo ejemplo enseña.
  mapCheck: `
Examples:
  # The coverage gate before any Anexo 24 catalog XML: what still lacks a code.
  mnemosine account map check --scheme sat-agrupador
  # Same, but exit 4 on any gap so CI can block on it.
  mnemosine account map check --scheme sat-agrupador --strict
`,
  restore: `
Examples:
  # Put a retired account back in service.
  mnemosine account restore 6150
  # Do it on a named entity instead of the active one.
  mnemosine account restore 6150 --entity "Molinos del Bajio SA de CV"
`,
} as const;

export function registerAccountCommand(program: Command, deps: AccountCommandDeps): void {
  const account = describeCommand(program.command('account').alias('cuenta'), 'help.account.description');

  // F01: fn puede DEVOLVER un código de salida (map check sale 4 con huecos
  // bloqueantes); void = 0. El patrón es el mismo run de entry-command.
  const run = async (fn: () => Promise<number | void>): Promise<void> => {
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

  // ---- account list ------------------------------------------------
  const list = describeCommand(account.command('list').alias('listar'), 'help.account.list.description');
  argumentByKey(list, '[search]', 'help.account.list.argument.search');
  withOutput(withSelection(withContext(list)));
  optionByKey(list, '--type <type>', 'help.account.list.option.type', { params: { types: ACCOUNT_TYPES.join(', ') } });
  optionByKey(list, '--parent <code>', 'help.account.list.option.parent');
  optionByKey(list, '--inactive', 'help.account.list.option.inactive');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EJEMPLOS.list);
  list.action((search: string | undefined, opts: CommonOpts & { type?: string; parent?: string; inactive?: boolean; status?: string[] }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      if (opts.type && !(ACCOUNT_TYPES as readonly string[]).includes(opts.type)) {
        throw usageError({ key: 'ledger.account.type_unknown', params: { value: opts.type, types: ACCOUNT_TYPES.join(', ') } });
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
  const show = describeCommand(account.command('show').alias('ver'), 'help.account.show.description');
  argumentByKey(show, '<code>', 'help.account.show.argument.code');
  withOutput(withContext(show));
  optionByKey(show, '--no-balance', 'help.account.show.option.no_balance');
  declareRisk(show, { risk: 'lectura', agent: true });
  show.addHelpText('after', EJEMPLOS.show);
  show.action((code: string, opts: CommonOpts & { balance?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const found = await resolveAccount(ctx.entityId, code);
      const full = await getAccountById(ctx.entityId, found.id, {
        includeBalance: opts.balance !== false,
        includeHierarchy: true,
      });
      if (!full) throw notFound({ key: 'ledger.account.show.disappeared', params: { code } });
      render([full], { ...opts, idField: 'code' });
    })
  );

  // ---- account create ----------------------------------------------
  const create = describeCommand(account.command('create').alias('crear'), 'help.account.create.description');
  argumentByKey(create, '<code>', 'help.account.create.argument.code');
  argumentByKey(create, '<name>', 'help.account.create.argument.name');
  withContext(create);
  optionByKey(create, '--type <type>', 'help.account.create.option.type', {
    params: { types: ACCOUNT_TYPES.join(', ') },
    mandatory: true,
  });
  optionByKey(create, '--normal-balance <side>', 'help.account.create.option.normal_balance');
  optionByKey(create, '--parent <code>', 'help.account.create.option.parent');
  optionByKey(create, '--currency <code>', 'help.account.create.option.currency');
  optionByKey(create, '--subtype <name>', 'help.account.create.option.subtype');
  optionByKey(create, '--fs-category <name>', 'help.account.create.option.fs_category');
  optionByKey(create, '--description <text>', 'help.account.create.option.description');
  optionByKey(create, '--header', 'help.account.create.option.header');
  optionByKey(create, '--json', 'help.account.create.option.json');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'accounts' });
  create.addHelpText('after', EJEMPLOS.create);
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
          throw usageError({ key: 'ledger.account.type_unknown', params: { value: opts.type, types: ACCOUNT_TYPES.join(', ') } });
        }
        const normal = (opts.normalBalance ?? defaultNormalBalance(opts.type as AccountType)) as NormalBalance;
        if (!(NORMAL_BALANCES as readonly string[]).includes(normal)) {
          throw usageError({ key: 'ledger.account.normal_balance_unknown', params: { value: normal } });
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
  const edit = describeCommand(account.command('edit').alias('editar'), 'help.account.edit.description');
  argumentByKey(edit, '<code>', 'help.account.edit.argument.code');
  withContext(edit);
  optionByKey(edit, '--name <text>', 'help.account.edit.option.name');
  optionByKey(edit, '--description <text>', 'help.account.edit.option.description');
  optionByKey(edit, '--subtype <name>', 'help.account.edit.option.subtype');
  optionByKey(edit, '--fs-category <name>', 'help.account.edit.option.fs_category');
  declareRisk(edit, { risk: 'escritura', agent: false, writes: 'accounts' });
  edit.addHelpText('after', EJEMPLOS.edit);
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
          throw usageError({ key: 'ledger.account.edit.nothing_to_change' });
        }
        const updated = await updateAccount(ctx.entityId, target.id, patch, reviewer.userId);
        process.stdout.write(`${deps.palette.green('✔')} ${t('ledger.account.edit.done', { code: updated.code })}\n`);
      })
  );

  // ---- account archive (F01; antes `deactivate`) -------------------
  // R9: el catálogo retira `account deactivate` → `account archive`; los
  // nombres viejos quedan como alias para no romper a nadie. `archive` es
  // verbo de razón (kernel/risk.ts): gateMutation exige --reason SIEMPRE, no
  // solo con --force — un archivado sin motivo escrito no se puede auditar.
  const archive = describeCommand(
    account.command('archive').aliases(['archivar', 'deactivate', 'desactivar']),
    'help.account.archive.description'
  );
  argumentByKey(archive, '<code>', 'help.account.archive.argument.code');
  withContext(archive);
  withForce(archive);
  optionByKey(archive, '--dry-run', 'help.account.archive.option.dry_run');
  declareRisk(archive, { risk: 'escritura', agent: false, writes: 'accounts.is_active' });
  archive.addHelpText('after', EJEMPLOS.archive);
  archive.action((code: string, opts: CommonOpts & { force?: boolean; reason?: string; dryRun?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const target = await resolveAccount(ctx.entityId, code);
      const { reason } = gateMutation(archive, opts as Record<string, unknown>);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

      const { hadHistory, balance } = await deactivateAccount(ctx.entityId, target.id, reviewer.userId, {
        // Archivar una cuenta con historia es lo normal al cierre; lo que se
        // exige es saldo cero, salvo --force con razón (el saldo queda dicho).
        allowWithHistory: true,
        enforceZeroBalance: opts.force !== true,
        dryRun: opts.dryRun === true,
        // G3: `gateMutation` ya EXIGÍA esta razón —`archive` es verbo de
        // razón— y la razón se imprimía en la terminal y ahí se moría. Ahora
        // llega a `audit_log.reason`, que es donde alguien la va a buscar.
        reason,
      });
      if (opts.dryRun) {
        process.stdout.write(
          t('ledger.account.archive.would_archive', { code: deps.palette.bold(target.code), balance }) +
            (hadHistory ? deps.palette.dim(t('ledger.account.archive.would_keep_history')) : '') +
            `${t('ledger.account.dry_run_note')}\n`
        );
        return;
      }
      process.stdout.write(
        `${deps.palette.green('✔')} ${t('ledger.account.archive.done', { code: target.code, reason: reason ?? '' })}` +
          (Number(balance) !== 0 ? deps.palette.yellow(t('ledger.account.archive.forced', { balance })) : '') +
          (hadHistory ? deps.palette.dim(t('ledger.account.archive.history_intact')) : '') +
          '\n'
      );
    })
  );

  // ---- account set (F01: banderas de gobierno) ---------------------
  const set = describeCommand(account.command('set').alias('fijar'), 'help.account.set.description');
  argumentByKey(set, '<code>', 'help.account.set.argument.code');
  argumentByKey(set, '<pairs...>', 'help.account.set.argument.pairs');
  withContext(set);
  optionByKey(set, '--dry-run', 'help.account.set.option.dry_run');
  // La fila del catálogo de `account set` lista `--reason` desde siempre y
  // no estaba declarada: cambiar quién puede postear a una cuenta es
  // exactamente el acto que alguien pregunta después.
  optionByKey(set, '--reason <text>', 'help.account.set.option.reason');
  declareRisk(set, { risk: 'escritura', agent: false, writes: 'accounts (governance flags)' });
  set.addHelpText('after', EJEMPLOS.set);
  set.action((code: string, pairs: string[], opts: CommonOpts & { dryRun?: boolean; reason?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const target = await resolveAccount(ctx.entityId, code);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const flags = parseGovernancePairs(pairs);
      if (opts.dryRun) {
        process.stdout.write(
          `${t('ledger.account.set.would_set', { code: deps.palette.bold(target.code), flags: JSON.stringify(flags) })}` +
            `${t('ledger.account.dry_run_note')}\n`
        );
        return;
      }
      const updated = await setAccountGovernance(target.id, flags, reviewer.userId, opts.reason ?? null);
      process.stdout.write(
        `${deps.palette.green('✔')} ${updated.code}: ` +
          `allow_manual=${updated.allow_manual_entries} header=${updated.is_header} ` +
          `control=${updated.is_control_account} require_subsidiary=${updated.require_subsidiary} ` +
          `currency=${updated.currency_code ?? '—'}\n`
      );
    })
  );

  // ---- account balance show (F01) ----------------------------------
  const balance = describeCommand(account.command('balance').alias('saldo'), 'help.account.balance.description');
  const balShow = describeCommand(balance.command('show').alias('ver'), 'help.account.balance.show.description');
  argumentByKey(balShow, '<code>', 'help.account.balance.show.argument.code');
  withOutput(withContext(balShow));
  optionByKey(balShow, '--period <expr>', 'help.account.balance.show.option.period');
  optionByKey(balShow, '--as-of <date>', 'help.account.balance.show.option.as_of');
  declareRisk(balShow, { risk: 'lectura', agent: true });
  balShow.addHelpText('after', EJEMPLOS.balanceShow);
  balShow.action((code: string, opts: CommonOpts & { period?: string; asOf?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const target = await resolveAccount(ctx.entityId, code);
      const rows = await getAccountBalanceByPeriod(ctx.entityId, target.id, {
        period: opts.period,
        asOf: opts.asOf,
      });
      // El inicial solo lo siembra el cierre DURO: en periodos abiertos un
      // beginning de 0 es ausencia de arrastre, no un saldo. Decirlo evita
      // que alguien lea un acumulado donde solo hay actividad del periodo.
      if (rows.some((r) => r.period_status === 'open' || r.period_status === 'soft_close')) {
        process.stderr.write(deps.palette.dim(`${t('ledger.account.balance.open_period_note')}\n`));
      }
      render(rows as unknown as Record<string, unknown>[], { ...opts, idField: 'period_name' });
    })
  );

  // ---- account role (F01: la capa semántica gana CRUD) -------------
  const role = describeCommand(account.command('role').alias('rol'), 'help.account.role.description');

  const roleList = describeCommand(role.command('list').alias('listar'), 'help.account.role.list.description');
  withOutput(withSelection(withContext(roleList)));
  optionByKey(roleList, '--role <name>', 'help.account.role.list.option.role');
  optionByKey(roleList, '--qualifier <q>', 'help.account.role.list.option.qualifier');
  declareRisk(roleList, { risk: 'lectura', agent: true });
  roleList.addHelpText('after', EJEMPLOS.roleList);
  roleList.action((opts: CommonOpts & { role?: string; qualifier?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const rows = await listAccountRoles(ctx.entityId, { role: opts.role, qualifier: opts.qualifier });
      render(rows as unknown as Record<string, unknown>[], { ...opts, idField: 'role' });
    })
  );

  const roleSet = describeCommand(role.command('set').alias('fijar'), 'help.account.role.set.description');
  argumentByKey(roleSet, '<role>', 'help.account.role.set.argument.role', {
    params: { roles: rolesValidos().slice(0, 6).join(', ') },
  });
  argumentByKey(roleSet, '<code>', 'help.account.role.set.argument.code');
  withContext(roleSet);
  optionByKey(roleSet, '--qualifier <q>', 'help.account.role.set.option.qualifier');
  optionByKey(roleSet, '--note <text>', 'help.account.role.set.option.note');
  // NO se declara `--reason` aquí: la fila del catálogo de
  // `account role set` lista exactamente `--qualifier`, `--note` y
  // `--dry-run`, y una bandera que el catálogo no tiene no se inventa en el
  // código. `setAccountRole` sí acepta razón —la ruta REST y el agente la
  // van a necesitar— y la fila propuesta va en el informe de G3.
  optionByKey(roleSet, '--dry-run', 'help.account.role.set.option.dry_run');
  declareRisk(roleSet, { risk: 'escritura', agent: false, writes: 'account_roles' });
  roleSet.addHelpText('after', EJEMPLOS.roleSet);
  roleSet.action((roleName: string, code: string, opts: CommonOpts & { qualifier?: string; note?: string; dryRun?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const cuenta = await resolveAccount(ctx.entityId, code);
      if (opts.dryRun) {
        process.stdout.write(
          t('ledger.account.role.set.would_point', {
            role: deps.palette.bold(roleName),
            qualifier: opts.qualifier ? `[${opts.qualifier}]` : '',
            code: cuenta.code,
            name: cuenta.name,
          }) + `${t('ledger.account.dry_run_note')}\n`
        );
        return;
      }
      // El autor se resuelve ANTES de escribir, no después: si no hay a quién
      // atribuirle el reapunte, el acto no ocurre. `role seed` ya lo hacía
      // así; `role set` —el que SÍ sobreescribe— no.
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const res = await setAccountRole(ctx.entityId, ctx.tenantId, roleName, cuenta.id, {
        qualifier: opts.qualifier ?? null,
        notes: opts.note ?? null,
        userId: reviewer.userId,
      });
      process.stdout.write(
        `${deps.palette.green('✔')} ${res.role}${res.qualifier ? `[${res.qualifier}]` : ''} → ` +
          `${res.account_code} (${res.accion})\n`
      );
    })
  );

  const roleSeed = describeCommand(role.command('seed').alias('sembrar'), 'help.account.role.seed.description');
  withContext(roleSeed);
  declareRisk(roleSeed, { risk: 'escritura', agent: false, writes: 'accounts, account_roles (only the missing ones)' });
  roleSeed.addHelpText('after', EJEMPLOS.roleSeed);
  roleSeed.action((opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const res = await seedAccountRoles(ctx.entityId, ctx.tenantId, reviewer.userId);
      process.stdout.write(
        `${deps.palette.green('✔')} ` +
          t('ledger.account.role.seed.done', { roles: res.rolesMapped, accounts: res.accountsCreated.length }) +
          (res.unmapped.length > 0
            ? deps.palette.yellow(t('ledger.account.role.seed.unmapped', { roles: res.unmapped.map((u) => u.role).join(', ') }))
            : '') +
          '\n'
      );
    })
  );

  // MNE-001-147 (#309): the explicit act `withholding_accounts_existing` =
  // "warn" names. Posts nothing; a mapping set by hand is listed, not moved.
  const roleSync = describeCommand(
    role.command('sync').alias('sincronizar'),
    'help.account.role.sync.description'
  );
  withContext(roleSync);
  optionByKey(roleSync, '--dry-run', 'help.account.role.sync.option.dry_run');
  declareRisk(roleSync, { risk: 'escritura', agent: false, writes: 'accounts, account_roles' });
  roleSync.addHelpText('after', EJEMPLOS.roleSync);
  roleSync.action((opts: CommonOpts & { dryRun?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const [plan] = await censusWithholdingLayout({ tenantId: ctx.tenantId, entityId: ctx.entityId });
      if (!plan) throw usageError({ key: 'ledger.account.role.sync.not_mexican' });
      const lines = describeWithholdingPlan(plan);
      process.stdout.write(
        `${deps.palette.bold(plan.entityName)} · withholding_accounts_layout = ${plan.layout}\n` +
          (lines.length > 0 ? lines.map((l) => `  ${l}\n`).join('') : `  ${t('ledger.account.role.sync.nothing')}\n`)
      );
      if (plan.blocked) return ExitCode.BLOCKED;
      if (opts.dryRun || !hasWork(plan)) return;
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      await applyWithholdingLayout(plan, reviewer.userId);
      process.stdout.write(`${deps.palette.green('✔')} ${t('ledger.account.role.sync.done')}\n`);
    })
  );

  // ---- account map (F01: mapeos estatutarios) ----------------------
  const map = describeCommand(account.command('map').alias('mapeo'), 'help.account.map.description');
  const schemes = Object.keys(MAPPING_SCHEMES).join(', ');

  const mapSet = describeCommand(map.command('set').alias('fijar'), 'help.account.map.set.description');
  argumentByKey(mapSet, '<code>', 'help.account.map.set.argument.code');
  withContext(mapSet);
  optionByKey(mapSet, '--scheme <name>', 'help.account.map.set.option.scheme', {
    params: { schemes },
    mandatory: true,
  });
  optionByKey(mapSet, '--value <v>', 'help.account.map.set.option.value');
  // F07a: la bandera existía y sólo sabía rechazarse — «el catálogo
  // c_CodAgrup versionado no existe en el sistema», que era cierto hasta la
  // 063. Ya existe y tiene vigencias, así que --year vuelve a significar lo
  // que el catálogo de comandos siempre dijo: contra QUÉ ejercicio se valida.
  optionByKey(mapSet, '--year <y>', 'help.account.map.set.option.year');
  optionByKey(mapSet, '--dry-run', 'help.account.map.set.option.dry_run');
  declareRisk(mapSet, { risk: 'escritura', agent: false, writes: 'accounts (statutory columns)' });
  mapSet.addHelpText('after', EJEMPLOS.mapSet);
  mapSet.action((code: string, opts: CommonOpts & { scheme: string; value?: string; year?: string; dryRun?: boolean }) =>
    run(async () => {
      resolverEsquema(opts.scheme);
      const fecha = fechaDeCatalogo(opts.year);
      const ctx = await entityOf(opts);
      const target = await resolveAccount(ctx.entityId, code);
      const valor = opts.value?.trim() ? opts.value.trim() : null;
      // Un aviso del validador («se guarda SIN VALIDAR porque no hay catálogo
      // sembrado») no puede quedarse en el log del servicio: quien teclea el
      // comando es el único que puede sembrarlo.
      const avisar = (r: ResultadoValidacionAgrupador): void => {
        if (r.aviso) process.stderr.write(deps.palette.yellow(`${r.aviso}\n`));
      };

      if (opts.dryRun) {
        // «validate and report, without writing» es lo que la bandera promete
        // y hasta F07a no validaba NADA: imprimía la frase y salía, así que un
        // ensayo limpio no decía nada sobre si la escritura pasaría. Ahora el
        // ensayo corre la MISMA comprobación que la escritura —el c_CodAgrup
        // vigente para el ejercicio— y lo único que se salta es el UPDATE.
        let confirmacion = '';
        if (opts.scheme === 'sat-agrupador' && valor !== null) {
          const ctxVal = await prepararValidacionAgrupador(
            { tenantId: ctx.tenantId, entityId: ctx.entityId },
            await dayOrToday({ tenantId: ctx.tenantId, entityId: ctx.entityId }, fecha)
          );
          // Revienta igual que reventaría la escritura: un ensayo que sale 0
          // sobre un código que el sistema va a rechazar es peor que no tenerlo.
          const veredicto = await exigirAgrupadorValido(ctxVal, valor);
          avisar(veredicto);
          // El NOMBRE oficial es la mitad útil del ensayo: confirma en pantalla
          // que 102.01 es la cuenta que se creía, antes de escribirla.
          if (veredicto.nombre) confirmacion = ` «${veredicto.nombre}»`;
        }
        process.stdout.write(
          `${t('ledger.account.map.set.dry_run', {
            code: deps.palette.bold(target.code),
            scheme: opts.scheme,
            clear: valor === null ? 'yes' : 'no',
            value: valor ?? '',
            name: confirmacion,
          })}\n`
        );
        return;
      }
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      await setAccountMapping(target.id, opts.scheme, valor, reviewer.userId, {
        fecha,
        onAviso: avisar,
      });
      process.stdout.write(
        `${deps.palette.green('✔')} ${target.code}: ${opts.scheme} = ${valor ?? '—'}\n`
      );
    })
  );

  const mapList = describeCommand(map.command('list').alias('listar'), 'help.account.map.list.description');
  withOutput(withSelection(withContext(mapList)));
  optionByKey(mapList, '--scheme <name>', 'help.account.map.list.option.scheme');
  declareRisk(mapList, { risk: 'lectura', agent: true });
  mapList.addHelpText('after', EJEMPLOS.mapList);
  mapList.action((opts: CommonOpts & { scheme?: string }) =>
    run(async () => {
      if (opts.scheme) resolverEsquema(opts.scheme);
      const ctx = await entityOf(opts);
      const rows = await listAccountMappings(ctx.entityId);
      const proyectadas = opts.scheme
        ? rows.map((r) => ({
            code: r.code, name: r.name, account_level: r.account_level,
            [opts.scheme as string]: r[MAPPING_SCHEMES[opts.scheme as keyof typeof MAPPING_SCHEMES]],
          }))
        : rows;
      render(proyectadas as unknown as Record<string, unknown>[], { ...opts, idField: 'code' });
    })
  );

  const mapImport = describeCommand(map.command('import').alias('importar'), 'help.account.map.import.description');
  argumentByKey(mapImport, '<file>', 'help.account.map.import.argument.file');
  withContext(mapImport);
  optionByKey(mapImport, '--scheme <name>', 'help.account.map.import.option.scheme', {
    params: { schemes },
    mandatory: true,
  });
  optionByKey(mapImport, '--dry-run', 'help.account.map.import.option.dry_run');
  optionByKey(mapImport, '--idempotency-key <key>', 'help.account.map.import.option.idempotency_key');
  declareRisk(mapImport, {
    risk: 'escritura',
    agent: false,
    llave: { scope: 'account map import' },
    writes: 'accounts (statutory columns, in bulk)',
  });
  mapImport.addHelpText('after', EJEMPLOS.mapImport);
  mapImport.action((file: string, opts: CommonOpts & { scheme: string; dryRun?: boolean; idempotencyKey?: string }) =>
    run(async () => {
      resolverEsquema(opts.scheme);
      const ctx = await entityOf(opts);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const contenido = fs.readFileSync(file, 'utf-8');
      const pares = parseMappingCsv(contenido);
      if (pares.length === 0) {
        throw usageError({ key: 'ledger.account.map.import.no_pairs', params: { file } });
      }

      const correr = () =>
        importAccountMappings(ctx.entityId, opts.scheme, pares, reviewer.userId, {
          dryRun: opts.dryRun === true,
        }).then((resultados) => ({ resultados }));

      const { repetido, resultado } = opts.dryRun
        ? { repetido: false, resultado: await correr() }
        : await conLlave(
            ctx,
            { scope: 'account map import', clave: opts.idempotencyKey, payloadHash: hashDeCarga(opts.scheme, contenido) },
            correr
          );

      const resultados = resultado.resultados as { code: string; resultado: string }[];
      const aplicados = resultados.filter((r) => r.resultado === 'aplicado').length;
      const sinCuenta = resultados.filter((r) => r.resultado === 'sin_cuenta');
      const vacios = resultados.filter((r) => r.resultado === 'valor_vacio');
      process.stdout.write(
        `${deps.palette.green('✔')} ` +
          t('ledger.account.map.import.done', {
            applied: aplicados,
            total: resultados.length,
            mode: opts.dryRun ? 'dry_run' : 'done',
            scheme: opts.scheme,
          }) +
          (repetido ? deps.palette.dim(t('ledger.account.map.import.repeated')) : '') +
          (opts.dryRun ? deps.palette.dim(t('ledger.account.dry_run_note')) : '') +
          '\n'
      );
      for (const r of sinCuenta) process.stderr.write(deps.palette.yellow(`${t('ledger.account.map.import.no_account', { code: r.code })}\n`));
      for (const r of vacios) process.stderr.write(deps.palette.dim(`${t('ledger.account.map.import.empty_value', { code: r.code })}\n`));
    })
  );

  const mapCheck = describeCommand(map.command('check').alias('verificar'), 'help.account.map.check.description');
  withOutput(withStrict(withContext(mapCheck)));
  optionByKey(mapCheck, '--check <names>', 'help.account.map.check.option.check', { defaultValue: 'coverage' });
  optionByKey(mapCheck, '--scheme <name>', 'help.account.map.check.option.scheme', { defaultValue: 'sat-agrupador' });
  // SIN VALOR POR OMISIÓN, a propósito: la bandera ya no recorta nada y lo
  // único honesto es decírselo a quien la escribe. Con un defecto, commander
  // la daría por puesta siempre y el error saltaría sin que nadie la pidiera.
  optionByKey(mapCheck, '--level <n>', 'help.account.map.check.option.level');
  declareRisk(mapCheck, { risk: 'lectura', agent: true });
  mapCheck.addHelpText('after', EJEMPLOS.mapCheck);
  mapCheck.action((opts: CommonOpts & { check?: string; scheme: string; level?: string; strict?: boolean }) =>
    run(async () => {
      const disponibles = ['coverage'];
      const pedidos = (opts.check ?? 'coverage').split(',').map((c) => c.trim()).filter(Boolean);
      if (pedidos.length === 0) {
        process.stdout.write(`${t('ledger.account.map.check.available', { checks: disponibles.join(', ') })}\n`);
        return;
      }
      const desconocidos = pedidos.filter((c) => !disponibles.includes(c));
      if (desconocidos.length > 0) {
        throw usageError({
          key: 'ledger.account.map.check.unknown',
          params: { unknown: desconocidos.join(', '), checks: disponibles.join(', ') },
        });
      }
      // F07a · --level SE RECHAZA en vez de ignorarse. El recorte por nivel de
      // cuenta ERA el defecto: sobre una entidad real acusaba 43 huecos, 42 de
      // ellos cuentas sin un solo movimiento, y dejaba fuera la única cuenta
      // movida sin agrupador por vivir en el nivel 3. Aceptar la bandera y no
      // aplicarla sería peor que el defecto —el usuario creería haber acotado
      // algo—, así que se hace lo mismo que hacía --year: decir qué pasó y
      // dónde se decide ahora.
      if (opts.level !== undefined) {
        throw usageError({
          key: 'ledger.account.map.check.level_retired',
          params: { hint: changePolicyHint('agrupador_alcance_de_la_compuerta') },
        });
      }
      const ctx = await entityOf(opts);
      const cobertura = await checkMappingCoverageDetallada(ctx.entityId, opts.scheme, {
        tenantId: ctx.tenantId,
      });
      render(cobertura.huecos as unknown as Record<string, unknown>[], { ...opts, idField: 'code' });
      // El alcance y de dónde salió viajan SIEMPRE en el resumen: «3 huecos» no
      // significa lo mismo medido sobre las cuentas movidas que sobre el
      // catálogo entero, y quien lee la compuerta tiene que saber cuál miró.
      const contexto = t('ledger.account.map.check.scope', {
        scope: cobertura.alcance,
        chosen: cobertura.alcanceElegido ? 'panel' : 'default',
      });
      process.stderr.write(
        cobertura.poblacion === 0
          ? // Cero cuentas en el alcance no es cobertura completa: es que no
            // había nada que mirar. El verde por vacuidad es el defecto que
            // este tramo persigue en el checklist del cierre; aquí tampoco.
            deps.palette.yellow(`${t('ledger.account.map.check.empty', { scope: contexto })}\n`)
          : cobertura.huecos.length === 0
            ? deps.palette.green(
                `${t('ledger.account.map.check.complete', { count: cobertura.poblacion, scheme: opts.scheme, scope: contexto })}\n`
              )
            : deps.palette.yellow(
                `${t('ledger.account.map.check.gaps', {
                  gaps: cobertura.huecos.length,
                  count: cobertura.poblacion,
                  scheme: opts.scheme,
                  scope: contexto,
                })}\n`
              )
      );
      return checkExitCode(
        { blocking: cobertura.huecos.length, warning: cobertura.poblacion === 0 ? 1 : 0 },
        { strict: opts.strict }
      );
    })
  );

  // ---- account restore ---------------------------------------------
  const restore = describeCommand(account.command('restore').alias('restaurar'), 'help.account.restore.description');
  argumentByKey(restore, '<code>', 'help.account.restore.argument.code');
  withContext(restore);
  // La fila del catálogo listaba `--reason` con la nota «no tiene dónde
  // guardarse hoy». Ya lo tiene: `updateAccount` escribe en `audit_log`.
  optionByKey(restore, '--reason <text>', 'help.account.restore.option.reason');
  declareRisk(restore, { risk: 'escritura', agent: false, writes: 'accounts.is_active' });
  restore.addHelpText('after', EJEMPLOS.restore);
  restore.action((code: string, opts: CommonOpts & { reason?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const target = await resolveAccount(ctx.entityId, code);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const updated = await reactivateAccount(ctx.entityId, target.id, reviewer.userId, opts.reason ?? null);
      process.stdout.write(`${deps.palette.green('✔')} ${t('ledger.account.restore.done', { code: updated.code })}\n`);
    })
  );
}

/**
 * `--year` → la fecha con la que se le pregunta al catálogo del SAT.
 *
 * El c_CodAgrup lo revisa la autoridad POR EJERCICIO y la tabla lo guarda con
 * vigencias, así que la pregunta es una fecha, no un año. De un ejercicio se
 * toma su ÚLTIMO día: el catálogo en vigor al cerrar el ejercicio es el que
 * valida su presentación, y tomar el primero elegiría el catálogo saliente en
 * un año en que la autoridad publique uno nuevo a mitad de camino.
 *
 * Devuelve `undefined` sin bandera, para que el servicio aplique su propio
 * defecto (hoy) en vez de que la CLI fabrique una fecha equivalente por su
 * cuenta: dos defectos que hay que mantener iguales terminan distintos.
 */
export function fechaDeCatalogo(year?: string): string | undefined {
  if (year === undefined) return undefined;
  if (!/^\d{4}$/.test(year.trim())) {
    throw usageError({ key: 'ledger.account.map.year_invalid', params: { value: year } });
  }
  return `${year.trim()}-12-31`;
}

/**
 * key=value → banderas de gobierno. Vocabulario cerrado y valores estrictos:
 * un `header=yes` que se colara como false silencioso sería una bandera de
 * gobierno fijada al revés sin que nadie lo note.
 */
export function parseGovernancePairs(pairs: string[]): GovernanceFlags {
  const CLAVES: Record<string, keyof GovernanceFlags> = {
    'allow-manual': 'allow_manual_entries',
    'header': 'is_header',
    'control-account': 'is_control_account',
    'require-subsidiary': 'require_subsidiary',
    'currency': 'currency_code',
  };
  const flags: GovernanceFlags = {};
  for (const par of pairs) {
    const eq = par.indexOf('=');
    if (eq < 0) throw usageError({ key: 'ledger.account.set.pair_unreadable', params: { pair: par } });
    const clave = par.slice(0, eq).trim();
    const valor = par.slice(eq + 1).trim();
    const campo = CLAVES[clave];
    if (!campo) {
      throw usageError({ key: 'ledger.account.set.key_unknown', params: { key: clave, keys: Object.keys(CLAVES).join(', ') } });
    }
    if (campo === 'currency_code') {
      flags.currency_code = valor === '' ? null : valor.toUpperCase();
    } else if (valor === 'true' || valor === 'false') {
      flags[campo] = valor === 'true';
    } else {
      throw usageError({ key: 'ledger.account.set.value_unreadable', params: { value: valor, key: clave } });
    }
  }
  return flags;
}

/**
 * CSV mínimo de dos columnas (código, valor), separador coma o punto y coma.
 * Tolera un encabezado, BOM y comillas simples alrededor de celdas; todo lo
 * demás se rechaza línea a línea en el reporte, no en silencio.
 */
export function parseMappingCsv(contenido: string): { code: string; value: string }[] {
  const pares: { code: string; value: string }[] = [];
  const lineas = contenido.replace(/^﻿/, '').split(/\r?\n/);
  for (const [idx, cruda] of lineas.entries()) {
    const linea = cruda.trim();
    if (linea === '') continue;
    const celdas = linea.split(/[,;]/).map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
    if (celdas.length < 2) continue;
    // Encabezado: primera línea sin dígito alguno en la primera celda.
    if (idx === 0 && !/\d/.test(celdas[0])) continue;
    pares.push({ code: celdas[0], value: celdas[1] });
  }
  return pares;
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
