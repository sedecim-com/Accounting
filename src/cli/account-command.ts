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
  checkMappingCoverage,
  resolverEsquema,
  MAPPING_SCHEMES,
  ACCOUNT_TYPES,
  NORMAL_BALANCES,
  type AccountType,
  type NormalBalance,
  type GovernanceFlags,
} from '../services/accounting/account-service.js';
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
  set.option('--dry-run', 'validate and report, without writing');
  declareRisk(set, { risk: 'escritura', agent: false, writes: 'accounts (banderas de gobierno)' });
  set.action((code: string, pairs: string[], opts: CommonOpts & { dryRun?: boolean }) =>
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
      const updated = await setAccountGovernance(target.id, flags, reviewer.userId);
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
    .option('--dry-run', 'validate and report, without writing');
  declareRisk(roleSet, { risk: 'escritura', agent: false, writes: 'account_roles' });
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
      const res = await setAccountRole(ctx.entityId, ctx.tenantId, roleName, cuenta.id, {
        qualifier: opts.qualifier ?? null,
        notes: opts.note ?? null,
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
    .option('--year <y>', 'catalog year (not supported yet: the versioned c_CodAgrup catalog does not exist)')
    .option('--dry-run', 'validate and report, without writing');
  declareRisk(mapSet, { risk: 'escritura', agent: false, writes: 'accounts (columnas estatutarias)' });
  mapSet.action((code: string, opts: CommonOpts & { scheme: string; value?: string; year?: string; dryRun?: boolean }) =>
    run(async () => {
      if (opts.year) {
        throw usageError(
          '--year aún no se soporta: el catálogo c_CodAgrup versionado no existe en el sistema. Omite la bandera.'
        );
      }
      resolverEsquema(opts.scheme);
      const ctx = await entityOf(opts);
      const target = await resolveAccount(ctx.entityId, code);
      const valor = opts.value?.trim() ? opts.value.trim() : null;
      if (opts.dryRun) {
        process.stdout.write(
          `${deps.palette.bold(target.code)}: ${opts.scheme} ${valor === null ? 'se limpiaría' : `sería ${valor}`} (dry-run)\n`
        );
        return;
      }
      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      await setAccountMapping(target.id, opts.scheme, valor, reviewer.userId);
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
    .description('Coverage gate before the Anexo 24 catalog XML: which top accounts still lack a mapping');
  withOutput(withStrict(withContext(mapCheck)));
  mapCheck
    .option('--check <names>', 'named checks to run (available: coverage; empty lists them)', 'coverage')
    .option('--scheme <name>', 'scheme to verify', 'sat-agrupador')
    .option('--level <n>', 'deepest account level required to be mapped', '2');
  declareRisk(mapCheck, { risk: 'lectura', agent: true });
  mapCheck.action((opts: CommonOpts & { check?: string; scheme: string; level: string; strict?: boolean }) =>
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
      const ctx = await entityOf(opts);
      const nivel = parseInt(opts.level, 10);
      if (!Number.isFinite(nivel) || nivel < 1) throw usageError(`--level ilegible: "${opts.level}".`);
      const huecos = await checkMappingCoverage(ctx.entityId, opts.scheme, nivel);
      render(huecos as unknown as Record<string, unknown>[], { ...opts, idField: 'code' });
      process.stderr.write(
        huecos.length === 0
          ? deps.palette.green(`✔ cobertura completa (${opts.scheme}, nivel ≤ ${nivel})\n`)
          : deps.palette.yellow(`${huecos.length} cuenta(s) sin ${opts.scheme} hasta nivel ${nivel}: el XML de catálogo saldría incompleto\n`)
      );
      return checkExitCode({ blocking: huecos.length, warning: 0 }, { strict: opts.strict });
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
