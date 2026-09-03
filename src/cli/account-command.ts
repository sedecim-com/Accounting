import type { Command } from 'commander';
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
  create: `
Examples:
  # A new expense account hanging off Gastos de Administracion (6100).
  mnemosine account create 6150 "Mantenimiento de oficina" --type expense --parent 6100
  # A grouping node: --header means it accepts no manual entries.
  mnemosine account create 1250 "Activo Intangible" --type asset --parent 1200 --header
`,
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
  mapCheck: `
Examples:
  # The coverage gate before any Anexo 24 catalog XML: what still lacks a code.
  mnemosine account map check --scheme sat-agrupador --level 2
  # Same, but exit 4 on any gap so CI can block on it.
  mnemosine account map check --scheme sat-agrupador --level 3 --strict
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
  const account = program
    .command('account')
    .alias('cuenta')
    .description('Chart of accounts: inspect, create and retire accounts');

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
  list.addHelpText('after', EJEMPLOS.list);
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
  show.addHelpText('after', EJEMPLOS.show);
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
          throw usageError('Nothing to change. Pass --name, --description, --subtype or --fs-category.');
        }
        const updated = await updateAccount(target.id, patch, reviewer.userId);
        process.stdout.write(`${deps.palette.green('✔')} ${updated.code} updated.\n`);
      })
  );

  // ---- account archive (F01; antes `deactivate`) -------------------
  // R9: el catálogo retira `account deactivate` → `account archive`; los
  // nombres viejos quedan como alias para no romper a nadie. `archive` es
  // verbo de razón (kernel/risk.ts): gateMutation exige --reason SIEMPRE, no
  // solo con --force — un archivado sin motivo escrito no se puede auditar.
  const archive = account
    .command('archive')
    .aliases(['archivar', 'deactivate', 'desactivar'])
    .argument('<code>', 'account code or id')
    .description('Retire an account from active use (never deletes; requires zero balance unless --force)');
  withContext(archive);
  withForce(archive);
  archive.option('--dry-run', 'run the checks and report, without writing');
  declareRisk(archive, { risk: 'escritura', agent: false, writes: 'accounts.is_active' });
  archive.addHelpText('after', EJEMPLOS.archive);
  archive.action((code: string, opts: CommonOpts & { force?: boolean; reason?: string; dryRun?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const target = await resolveAccount(ctx.entityId, code);
      const { reason } = gateMutation(archive, opts as Record<string, unknown>);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);

      const { hadHistory, balance } = await deactivateAccount(target.id, reviewer.userId, {
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
          `${deps.palette.bold(target.code)} se archivaría. Saldo de por vida: ${balance}.` +
            (hadHistory ? deps.palette.dim(' Tiene historia posteada, que quedaría intacta.') : '') +
            ' (dry-run: nada se escribió)\n'
        );
        return;
      }
      process.stdout.write(
        `${deps.palette.green('✔')} ${target.code} archived. Reason: ${reason}` +
          (Number(balance) !== 0 ? deps.palette.yellow(` (con saldo vivo ${balance}, forzado)`) : '') +
          (hadHistory ? deps.palette.dim(' Posted history stays intact.') : '') +
          '\n'
      );
    })
  );

  // ---- account set (F01: banderas de gobierno) ---------------------
  const set = account
    .command('set')
    .alias('fijar')
    .argument('<code>', 'account code or id')
    .argument('<pairs...>', 'key=value: allow-manual, header, control-account, require-subsidiary, currency')
    .description('Set the governance flags of an account (who may post to it, and how)');
  withContext(set);
  set
    .option('--dry-run', 'validate and report, without writing')
    // La fila del catálogo de `account set` lista `--reason` desde siempre y
    // no estaba declarada: cambiar quién puede postear a una cuenta es
    // exactamente el acto que alguien pregunta después.
    .option('--reason <text>', 'why these flags change; recorded in the audit trail');
  declareRisk(set, { risk: 'escritura', agent: false, writes: 'accounts (banderas de gobierno)' });
  set.addHelpText('after', EJEMPLOS.set);
  set.action((code: string, pairs: string[], opts: CommonOpts & { dryRun?: boolean; reason?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const target = await resolveAccount(ctx.entityId, code);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const flags = parseGovernancePairs(pairs);
      if (opts.dryRun) {
        process.stdout.write(
          `${deps.palette.bold(target.code)} fijaría: ${JSON.stringify(flags)} (dry-run: nada se escribió)\n`
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
  const balance = account
    .command('balance')
    .alias('saldo')
    .description('Balances of one account, decomposed by fiscal period');
  const balShow = balance
    .command('show')
    .alias('ver')
    .argument('<code>', 'account code or id')
    .description('Beginning, debits, credits and ending by period, with the period status');
  withOutput(withContext(balShow));
  balShow
    .option('--period <name>', 'only the periods whose name matches')
    .option('--as-of <date>', 'only the period containing this date (YYYY-MM-DD)');
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
        process.stderr.write(deps.palette.dim(
          'Nota: beginning_balance solo se siembra en el cierre duro; en periodos abiertos lee la actividad, no el acumulado.\n'
        ));
      }
      render(rows as unknown as Record<string, unknown>[], { ...opts, idField: 'period_name' });
    })
  );

  // ---- account role (F01: la capa semántica gana CRUD) -------------
  const role = account
    .command('role')
    .alias('rol')
    .description('Semantic account roles (cxc, banco, iva_acreditable…) that automatic posting reads');

  const roleList = role
    .command('list')
    .alias('listar')
    .description('Each role and the account it points to, default and qualified variants');
  withOutput(withSelection(withContext(roleList)));
  roleList
    .option('--role <name>', 'only this role')
    .option('--qualifier <q>', 'only this qualified variant');
  declareRisk(roleList, { risk: 'lectura', agent: true });
  roleList.addHelpText('after', EJEMPLOS.roleList);
  roleList.action((opts: CommonOpts & { role?: string; qualifier?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const rows = await listAccountRoles(ctx.entityId, { role: opts.role, qualifier: opts.qualifier });
      render(rows as unknown as Record<string, unknown>[], { ...opts, idField: 'role' });
    })
  );

  const roleSet = role
    .command('set')
    .alias('fijar')
    .argument('<role>', `one of: ${rolesValidos().slice(0, 6).join(', ')}… (see role list)`)
    .argument('<code>', 'account code the role should point to')
    .description('Repoint a role to another account, or create a qualified variant');
  withContext(roleSet);
  roleSet
    .option('--qualifier <q>', 'per-context variant (NULL = the default mapping)')
    .option('--note <text>', 'why this role points here')
    // NO se declara `--reason` aquí: la fila del catálogo de
    // `account role set` lista exactamente `--qualifier`, `--note` y
    // `--dry-run`, y una bandera que el catálogo no tiene no se inventa en el
    // código. `setAccountRole` sí acepta razón —la ruta REST y el agente la
    // van a necesitar— y la fila propuesta va en el informe de G3.
    .option('--dry-run', 'validate and report, without writing');
  declareRisk(roleSet, { risk: 'escritura', agent: false, writes: 'account_roles' });
  roleSet.addHelpText('after', EJEMPLOS.roleSet);
  roleSet.action((roleName: string, code: string, opts: CommonOpts & { qualifier?: string; note?: string; dryRun?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const cuenta = await resolveAccount(ctx.entityId, code);
      if (opts.dryRun) {
        process.stdout.write(
          `El rol ${deps.palette.bold(roleName)}${opts.qualifier ? `[${opts.qualifier}]` : ''} ` +
            `apuntaría a ${cuenta.code} ${cuenta.name} (dry-run: nada se escribió)\n`
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

  const roleSeed = role
    .command('seed')
    .alias('sembrar')
    .description('Create the missing base accounts and map every unmapped role (never overwrites a manual choice)');
  withContext(roleSeed);
  declareRisk(roleSeed, { risk: 'escritura', agent: false, writes: 'accounts, account_roles (solo faltantes)' });
  roleSeed.addHelpText('after', EJEMPLOS.roleSeed);
  roleSeed.action((opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const res = await seedAccountRoles(ctx.entityId, ctx.tenantId, reviewer.userId);
      process.stdout.write(
        `${deps.palette.green('✔')} ${res.rolesMapped} rol(es) mapeados, ` +
          `${res.accountsCreated.length} cuenta(s) base creadas` +
          (res.unmapped.length > 0
            ? deps.palette.yellow(` — sin mapear: ${res.unmapped.map((u) => u.role).join(', ')}`)
            : '') +
          '\n'
      );
    })
  );

  // ---- account map (F01: mapeos estatutarios) ----------------------
  const map = account
    .command('map')
    .alias('mapeo')
    .description('Statutory mappings per account: SAT agrupador (Anexo 24), US tax line, IFRS');

  const mapSet = map
    .command('set')
    .alias('fijar')
    .argument('<code>', 'account code or id')
    .description('Map the account to a statutory scheme value');
  withContext(mapSet);
  mapSet
    .requiredOption('--scheme <name>', `scheme: ${Object.keys(MAPPING_SCHEMES).join(', ')}`)
    .option('--value <v>', 'the code in that scheme; empty clears the mapping')
    // F07a: la bandera existía y sólo sabía rechazarse — «el catálogo
    // c_CodAgrup versionado no existe en el sistema», que era cierto hasta la
    // 063. Ya existe y tiene vigencias, así que --year vuelve a significar lo
    // que el catálogo de comandos siempre dijo: contra QUÉ ejercicio se valida.
    .option('--year <y>', "fiscal year whose SAT catalog validates the code (default: today's)")
    .option('--dry-run', 'validate and report, without writing');
  declareRisk(mapSet, { risk: 'escritura', agent: false, writes: 'accounts (columnas estatutarias)' });
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
            fecha ?? new Date().toISOString().slice(0, 10)
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
          `${deps.palette.bold(target.code)}: ${opts.scheme} ${valor === null ? 'se limpiaría' : `sería ${valor}${confirmacion}`} (dry-run)\n`
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

  const mapList = map
    .command('list')
    .alias('listar')
    .description('Every active account with its statutory mappings');
  withOutput(withSelection(withContext(mapList)));
  mapList.option('--scheme <name>', 'project only this scheme');
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

  const mapImport = map
    .command('import')
    .alias('importar')
    .argument('<file>', 'CSV: code,valor (una cuenta por línea; separador coma o punto y coma)')
    .description('Bulk-load a statutory scheme from CSV — the heaviest setup task of a Mexican firm');
  withContext(mapImport);
  mapImport
    .requiredOption('--scheme <name>', `scheme: ${Object.keys(MAPPING_SCHEMES).join(', ')}`)
    .option('--dry-run', 'parse and resolve everything, write nothing')
    .option('--idempotency-key <key>', 'replay-safe key: the same key with the same file returns the first result');
  declareRisk(mapImport, { risk: 'escritura', agent: false, writes: 'accounts (columnas estatutarias, en lote)' });
  mapImport.addHelpText('after', EJEMPLOS.mapImport);
  mapImport.action((file: string, opts: CommonOpts & { scheme: string; dryRun?: boolean; idempotencyKey?: string }) =>
    run(async () => {
      resolverEsquema(opts.scheme);
      const ctx = await entityOf(opts);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const contenido = fs.readFileSync(file, 'utf-8');
      const pares = parseMappingCsv(contenido);
      if (pares.length === 0) {
        throw usageError(`El archivo ${file} no trae pares código,valor legibles.`);
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
        `${deps.palette.green('✔')} ${aplicados}/${resultados.length} mapeos ${opts.dryRun ? 'aplicables' : 'aplicados'} (${opts.scheme})` +
          (repetido ? deps.palette.dim(' [repetido: resultado de la primera corrida]') : '') +
          (opts.dryRun ? deps.palette.dim(' (dry-run: nada se escribió)') : '') +
          '\n'
      );
      for (const r of sinCuenta) process.stderr.write(deps.palette.yellow(`  · ${r.code}: no existe en el catálogo\n`));
      for (const r of vacios) process.stderr.write(deps.palette.dim(`  · ${r.code}: valor vacío, omitido\n`));
    })
  );

  const mapCheck = map
    .command('check')
    .alias('verificar')
    .description('Coverage gate before the Anexo 24 catalog XML: which accounts still lack a mapping');
  withOutput(withStrict(withContext(mapCheck)));
  mapCheck
    .option('--check <names>', 'named checks to run (available: coverage; empty lists them)', 'coverage')
    .option('--scheme <name>', 'scheme to verify', 'sat-agrupador')
    // SIN VALOR POR OMISIÓN, a propósito: la bandera ya no recorta nada y lo
    // único honesto es decírselo a quien la escribe. Con un defecto, commander
    // la daría por puesta siempre y el error saltaría sin que nadie la pidiera.
    .option('--level <n>', 'retired: the gate no longer measures by account level');
  declareRisk(mapCheck, { risk: 'lectura', agent: true });
  mapCheck.addHelpText('after', EJEMPLOS.mapCheck);
  mapCheck.action((opts: CommonOpts & { check?: string; scheme: string; level?: string; strict?: boolean }) =>
    run(async () => {
      const disponibles = ['coverage'];
      const pedidos = (opts.check ?? 'coverage').split(',').map((c) => c.trim()).filter(Boolean);
      if (pedidos.length === 0) {
        process.stdout.write(`Verificaciones disponibles: ${disponibles.join(', ')}\n`);
        return;
      }
      const desconocidos = pedidos.filter((c) => !disponibles.includes(c));
      if (desconocidos.length > 0) {
        throw usageError(`Verificación desconocida: ${desconocidos.join(', ')}. Disponibles: ${disponibles.join(', ')}.`);
      }
      // F07a · --level SE RECHAZA en vez de ignorarse. El recorte por nivel de
      // cuenta ERA el defecto: sobre una entidad real acusaba 43 huecos, 42 de
      // ellos cuentas sin un solo movimiento, y dejaba fuera la única cuenta
      // movida sin agrupador por vivir en el nivel 3. Aceptar la bandera y no
      // aplicarla sería peor que el defecto —el usuario creería haber acotado
      // algo—, así que se hace lo mismo que hacía --year: decir qué pasó y
      // dónde se decide ahora.
      if (opts.level !== undefined) {
        throw usageError(
          '--level ya no aplica: la compuerta medía por nivel de cuenta y ése era el defecto ' +
            '(43 huecos sobre una entidad real, 42 de ellos cuentas sin un solo movimiento, ' +
            'y la cuenta movida sin agrupador fuera de la lista por estar en nivel 3). ' +
            'Hoy la población la fija la política agrupador_alcance_de_la_compuerta: mnemosine pending list.'
        );
      }
      const ctx = await entityOf(opts);
      const cobertura = await checkMappingCoverageDetallada(ctx.entityId, opts.scheme, {
        tenantId: ctx.tenantId,
      });
      render(cobertura.huecos as unknown as Record<string, unknown>[], { ...opts, idField: 'code' });
      // El alcance y de dónde salió viajan SIEMPRE en el resumen: «3 huecos» no
      // significa lo mismo medido sobre las cuentas movidas que sobre el
      // catálogo entero, y quien lee la compuerta tiene que saber cuál miró.
      const comoSeEligio = cobertura.alcanceElegido ? 'elegido en el panel' : 'por omisión';
      const contexto = `alcance "${cobertura.alcance}", ${comoSeEligio}`;
      process.stderr.write(
        cobertura.poblacion === 0
          ? // Cero cuentas en el alcance no es cobertura completa: es que no
            // había nada que mirar. El verde por vacuidad es el defecto que
            // este tramo persigue en el checklist del cierre; aquí tampoco.
            deps.palette.yellow(`0 cuentas en el ${contexto}: no se comprobó nada\n`)
          : cobertura.huecos.length === 0
            ? deps.palette.green(
                `✔ cobertura completa: ${cobertura.poblacion} cuenta(s) con ${opts.scheme} (${contexto})\n`
              )
            : deps.palette.yellow(
                `${cobertura.huecos.length} de ${cobertura.poblacion} cuenta(s) sin ${opts.scheme} (${contexto}): ` +
                  `el XML de catálogo saldría incompleto\n`
              )
      );
      return checkExitCode(
        { blocking: cobertura.huecos.length, warning: cobertura.poblacion === 0 ? 1 : 0 },
        { strict: opts.strict }
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
  // La fila del catálogo listaba `--reason` con la nota «no tiene dónde
  // guardarse hoy». Ya lo tiene: `updateAccount` escribe en `audit_log`.
  restore.option('--reason <text>', 'why the account comes back into service; recorded in the audit trail');
  declareRisk(restore, { risk: 'escritura', agent: false, writes: 'accounts.is_active' });
  restore.addHelpText('after', EJEMPLOS.restore);
  restore.action((code: string, opts: CommonOpts & { reason?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const target = await resolveAccount(ctx.entityId, code);
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const updated = await reactivateAccount(target.id, reviewer.userId, opts.reason ?? null);
      process.stdout.write(`${deps.palette.green('✔')} ${updated.code} is active again.\n`);
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
    throw usageError(`--year tiene que ser un ejercicio de cuatro dígitos; llegó "${year}".`);
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
    if (eq < 0) throw usageError(`Par ilegible "${par}": se espera clave=valor.`);
    const clave = par.slice(0, eq).trim();
    const valor = par.slice(eq + 1).trim();
    const campo = CLAVES[clave];
    if (!campo) {
      throw usageError(`Clave desconocida "${clave}". Válidas: ${Object.keys(CLAVES).join(', ')}.`);
    }
    if (campo === 'currency_code') {
      flags.currency_code = valor === '' ? null : valor.toUpperCase();
    } else if (valor === 'true' || valor === 'false') {
      flags[campo] = valor === 'true';
    } else {
      throw usageError(`Valor ilegible "${valor}" para ${clave}: usa true o false.`);
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
