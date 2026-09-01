import { v4 as uuidv4 } from 'uuid';
import { query } from '../../database/connection.js';
import { NotFoundError, ValidationError, ConflictError } from '../../utils/errors.js';
import { resolvePeriod } from './fiscal-calendar-service.js';
import type { Account } from '../../types/index.js';

// ============================================================
// CHART OF ACCOUNTS — domain service
//
// Extracted from the Express handlers so there is ONE implementation
// of each capability, callable from the REST API, from the CLI and
// from the agent's tools. Duplicating this logic per surface is how
// the three of them start disagreeing about what an account is.
//
// The functions here own the rules the database can only express as
// raw constraint failures:
//   - UNIQUE(code, entity_id) becomes a named conflict, not a 23505.
//   - CHECK (is_header = false OR allow_manual_entries = false) is
//     satisfied by construction: a header account defaults to
//     rejecting manual entries instead of dying on insert.
//   - Deactivation is not deletion. The historical rule (refuse when
//     any line exists) is preserved for the REST surface, while a
//     caller that can justify itself may override it.
// ============================================================

export const ACCOUNT_TYPES = [
  'asset', 'liability', 'equity', 'revenue', 'expense',
  'contra_asset', 'contra_liability', 'contra_equity',
] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const NORMAL_BALANCES = ['debit', 'credit'] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccountFilters {
  accountType?: string;
  isActive?: boolean;
  parentId?: string;
  /** Matches code or name, case-insensitively. */
  search?: string;
  limit?: number;
  offset?: number;
}

export interface AccountListPage {
  rows: Account[];
  /** Total matching rows, before limit/offset — so truncation is never silent. */
  total: number;
}

/** Rows carry children_count so a caller can render the hierarchy without a second pass. */
export async function listAccounts(
  entityId: string,
  filters: AccountFilters = {}
): Promise<AccountListPage> {
  const where: string[] = ['entity_id = $1'];
  const params: unknown[] = [entityId];
  let i = 2;

  if (filters.accountType) {
    where.push(`account_type = $${i++}`);
    params.push(filters.accountType);
  }
  if (filters.isActive !== undefined) {
    where.push(`is_active = $${i++}`);
    params.push(filters.isActive);
  }
  if (filters.parentId) {
    where.push(`parent_id = $${i++}`);
    params.push(filters.parentId);
  }
  if (filters.search) {
    where.push(`(code ILIKE $${i} OR name ILIKE $${i})`);
    params.push(`%${filters.search}%`);
    i++;
  }
  const whereClause = `WHERE ${where.join(' AND ')}`;

  const counted = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM accounts ${whereClause}`,
    params
  );
  const total = parseInt(counted.rows[0].count, 10);

  const limit = filters.limit ?? total;
  const offset = filters.offset ?? 0;
  const rows = await query<Account>(
    `SELECT a.*,
            (SELECT COUNT(*) FROM accounts c WHERE c.parent_id = a.id) AS children_count
     FROM accounts a ${whereClause}
     ORDER BY a.code ASC
     LIMIT $${i++} OFFSET $${i}`,
    [...params, limit, offset]
  );

  return { rows: rows.rows, total };
}

export interface GetAccountOptions {
  includeBalance?: boolean;
  includeHierarchy?: boolean;
}

export async function getAccountById(
  id: string,
  opts: GetAccountOptions = {}
): Promise<Record<string, unknown> | null> {
  const select = opts.includeHierarchy
    ? 'SELECT a.*, p.code AS parent_code, p.name AS parent_name'
    : 'SELECT a.*';
  const join = opts.includeHierarchy ? ' LEFT JOIN accounts p ON p.id = a.parent_id' : '';

  const result = await query<Account>(`${select} FROM accounts a${join} WHERE a.id = $1`, [id]);
  if (result.rows.length === 0) return null;
  const account = result.rows[0] as unknown as Record<string, unknown>;

  if (opts.includeBalance) {
    // Lifetime activity, NOT SUM(ending_balance): carried-forward periods embed
    // the prior ending in their beginning, so summing endings double-counts.
    // Activity totals are carryforward-invariant.
    const balance = await query<{ balance: string }>(
      `SELECT COALESCE(SUM(debit_total - credit_total), 0) AS balance
       FROM account_balances WHERE account_id = $1`,
      [id]
    );
    account.current_balance = balance.rows[0].balance;
  }
  return account;
}

/**
 * Resolves a human-supplied reference — a UUID or an account code — inside one
 * entity. Codes are what people actually type; ids are what the tables hold.
 */
export async function resolveAccount(entityId: string, ref: string): Promise<Account> {
  const trimmed = ref.trim();
  const result = UUID_RE.test(trimmed)
    ? await query<Account>(`SELECT * FROM accounts WHERE id = $1 AND entity_id = $2`, [trimmed, entityId])
    : await query<Account>(`SELECT * FROM accounts WHERE code = $1 AND entity_id = $2`, [trimmed, entityId]);

  if (result.rows.length === 0) {
    throw new NotFoundError('Account', trimmed);
  }
  return result.rows[0];
}

export interface CreateAccountInput {
  code: string;
  name: string;
  account_type: AccountType;
  normal_balance: NormalBalance;
  entity_id: string;
  created_by: string;
  account_subtype?: string | null;
  fs_category?: string | null;
  parent_id?: string | null;
  currency_code?: string | null;
  allow_manual_entries?: boolean;
  is_header?: boolean;
  description?: string | null;
  tags?: string[];
}

export async function createAccount(input: CreateAccountInput): Promise<Account> {
  const existing = await query<{ id: string }>(
    'SELECT id FROM accounts WHERE code = $1 AND entity_id = $2',
    [input.code, input.entity_id]
  );
  if (existing.rows.length > 0) {
    throw new ConflictError(`Account with code "${input.code}" already exists`);
  }

  // A header account is a grouping node, and the table's CHECK forbids it from
  // accepting manual entries. Defaulting it to false here turns what would be a
  // raw constraint violation into the behaviour the caller obviously meant.
  const isHeader = input.is_header ?? false;
  const allowManual = input.allow_manual_entries ?? !isHeader;
  if (isHeader && allowManual) {
    throw new ValidationError(
      'A header account cannot accept manual entries: pass allow_manual_entries=false, or make it a postable account.'
    );
  }

  const result = await query<Account>(
    `INSERT INTO accounts (
      id, code, name, account_type, account_subtype, fs_category,
      parent_id, entity_id, currency_code, normal_balance,
      allow_manual_entries, is_header, description, tags, created_by
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
    RETURNING *`,
    [
      uuidv4(), input.code, input.name, input.account_type,
      input.account_subtype || null, input.fs_category || null,
      input.parent_id || null, input.entity_id, input.currency_code || null,
      input.normal_balance, allowManual, isHeader,
      input.description || null, input.tags ? JSON.stringify(input.tags) : '{}',
      input.created_by,
    ]
  );
  return result.rows[0];
}

/** The only columns a caller may change. Structure (code, type, parent) is immutable here. */
export const UPDATABLE_FIELDS = [
  'name', 'description', 'is_active', 'tags', 'fs_category', 'account_subtype',
] as const;
export type UpdatableField = (typeof UPDATABLE_FIELDS)[number];

export type AccountPatch = Partial<Record<UpdatableField, unknown>>;

export async function updateAccount(
  id: string,
  patch: AccountPatch,
  userId: string
): Promise<Account> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  for (const field of UPDATABLE_FIELDS) {
    if (patch[field] === undefined) continue;
    sets.push(`${field} = $${i++}`);
    params.push(field === 'tags' ? JSON.stringify(patch[field]) : patch[field]);
  }
  if (sets.length === 0) {
    throw new ValidationError(
      `No updatable field given. One of: ${UPDATABLE_FIELDS.join(', ')}.`
    );
  }

  sets.push('updated_at = NOW()');
  sets.push(`updated_by = $${i++}`);
  params.push(userId, id);

  const result = await query<Account>(
    `UPDATE accounts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  );
  if (result.rows.length === 0) throw new NotFoundError('Account', id);
  return result.rows[0];
}

export interface DeactivateOptions {
  /**
   * When false (the default, and what the REST surface passes), an account
   * that has ever been posted to cannot be deactivated. That is strictly the
   * rule for a DELETE; a caller that understands the difference — and can
   * record a reason — may deactivate an account with history, which is the
   * normal way to retire a line of the chart at year end.
   */
  allowWithHistory?: boolean;
  /**
   * F01: la regla del ARCHIVADO (`account archive`) — la cuenta puede tener
   * historia, pero no saldo vivo: archivar una cuenta con saldo esconde
   * dinero del catálogo activo. `--force` con razón lo salta a sabiendas.
   * Actividad de por vida (Σ cargos − Σ abonos), invariante al arrastre.
   */
  enforceZeroBalance?: boolean;
  /** Corre las verificaciones y NO escribe: el informe de `--dry-run`. */
  dryRun?: boolean;
}

export async function deactivateAccount(
  id: string,
  userId: string,
  opts: DeactivateOptions = {}
): Promise<{ hadHistory: boolean; balance: string }> {
  const lines = await query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM journal_entry_lines WHERE account_id = $1',
    [id]
  );
  const hadHistory = parseInt(lines.rows[0].count, 10) > 0;

  if (hadHistory && !opts.allowWithHistory) {
    throw new ValidationError('Cannot delete account with existing transactions');
  }

  const saldo = await query<{ balance: string }>(
    `SELECT COALESCE(SUM(debit_total - credit_total), 0)::text AS balance
       FROM account_balances WHERE account_id = $1`,
    [id]
  );
  const balance = saldo.rows[0].balance;
  if (opts.enforceZeroBalance && Number(balance) !== 0) {
    throw new ValidationError(
      `La cuenta tiene saldo vivo (${balance}): salda o reclasifica antes de archivar, o usa --force con razón.`
    );
  }

  if (opts.dryRun) return { hadHistory, balance };

  const result = await query(
    `UPDATE accounts SET is_active = false, updated_at = NOW(), updated_by = $1 WHERE id = $2`,
    [userId, id]
  );
  if (result.rowCount === 0) throw new NotFoundError('Account', id);
  return { hadHistory, balance };
}

export async function reactivateAccount(id: string, userId: string): Promise<Account> {
  return updateAccount(id, { is_active: true }, userId);
}

// ============================================================
// F01 · BANDERAS DE GOBIERNO — un escritor propio, no un PATCH más
//
// allow_manual_entries, is_header, is_control_account,
// require_subsidiary y currency_code existen desde la 001 y nadie las
// escribía: el PATCH del REST las excluye de UPDATABLE_FIELDS a
// propósito (son gobierno del catálogo, no edición de texto) y esa
// exclusión es contrato. El escritor vive aparte, con la resolución
// por construcción del CHECK `is_header = false OR
// allow_manual_entries = false` que createAccount ya practica.
// ============================================================

export interface GovernanceFlags {
  allow_manual_entries?: boolean;
  is_header?: boolean;
  is_control_account?: boolean;
  require_subsidiary?: boolean;
  /** null limpia la restricción de moneda. */
  currency_code?: string | null;
}

export async function setAccountGovernance(
  id: string,
  flags: GovernanceFlags,
  userId: string
): Promise<Account> {
  const keys = Object.keys(flags) as (keyof GovernanceFlags)[];
  if (keys.length === 0) {
    throw new ValidationError(
      'Ninguna bandera de gobierno dada. Una de: allow-manual, header, control-account, require-subsidiary, currency.'
    );
  }
  if (flags.currency_code != null && !/^[A-Z]{3}$/.test(flags.currency_code)) {
    throw new ValidationError(`Moneda ilegible "${flags.currency_code}": tres letras (MXN, USD) o vacía para limpiar.`);
  }

  const actual = await query<Account>('SELECT * FROM accounts WHERE id = $1', [id]);
  if (actual.rows.length === 0) throw new NotFoundError('Account', id);
  const cuenta = actual.rows[0];

  // El CHECK de la 001 en una frase, ANTES del UPDATE: un nodo agrupador no
  // acepta pólizas manuales. Se valida sobre el estado RESULTANTE.
  const seraHeader = flags.is_header ?? cuenta.is_header;
  const aceptaraManual = flags.allow_manual_entries ?? cuenta.allow_manual_entries;
  if (seraHeader && aceptaraManual) {
    throw new ValidationError(
      'Una cuenta agrupadora (header=true) no puede aceptar pólizas manuales: fija también allow-manual=false.'
    );
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  for (const k of keys) {
    sets.push(`${k} = $${i++}`);
    params.push(flags[k] ?? null);
  }
  sets.push('updated_at = NOW()', `updated_by = $${i++}`);
  params.push(userId, id);

  const result = await query<Account>(
    `UPDATE accounts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
    params
  );
  return result.rows[0];
}

// ============================================================
// F01 · SALDO POR PERIODO — la descomposición que ninguna ruta exponía
//
// account_balances lleva las cuatro columnas por (cuenta, periodo)
// desde la 001 y la única lectura era el SUM de por vida. Este es el
// servicio ÚNICO de descomposición: lo comparten `account balance
// show` y `ledger balance show` (el catálogo tiene las dos puertas y
// no las reconcilia; dos servicios serían la deriva asegurada).
//
// Honestidad del inicial: beginning_balance solo lo siembra el cierre
// duro (carryForwardBalances). Cada fila dice el status de su periodo
// para que el lector sepa si el inicial es arrastre real o cero.
// ============================================================

export interface SaldoPorPeriodo {
  period_number: number;
  period_name: string;
  start_date: string;
  end_date: string;
  period_status: string;
  beginning_balance: string;
  debit_total: string;
  credit_total: string;
  ending_balance: string;
}

export async function getAccountBalanceByPeriod(
  entityId: string,
  accountId: string,
  filtros: { period?: string; asOf?: string } = {}
): Promise<SaldoPorPeriodo[]> {
  const cond: string[] = ['ab.account_id = $1', 'fp.entity_id = $2'];
  const params: unknown[] = [accountId, entityId];
  let i = 3;
  if (filtros.period) {
    // Por id, no por texto: un `ILIKE` que no casa ningún periodo devuelve una
    // lista vacía, y una lista vacía se lee como «esta cuenta no tuvo
    // movimiento», que es una respuesta distinta de «no encontré ese periodo».
    // `resolvePeriod` acepta uuid, «2026-08» o parte inequívoca del nombre, y
    // se niega en vez de contestar sobre la nada.
    const periodo = await resolvePeriod(entityId, filtros.period);
    cond.push(`fp.id = $${i++}`);
    params.push(periodo.id);
  }
  if (filtros.asOf) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(filtros.asOf)) {
      throw new ValidationError(`Fecha ilegible "${filtros.asOf}": se espera YYYY-MM-DD.`);
    }
    cond.push(`fp.start_date <= $${i}::date AND fp.end_date >= $${i}::date`);
    params.push(filtros.asOf);
    i++;
  }
  const result = await query<SaldoPorPeriodo>(
    `SELECT fp.period_number, fp.period_name,
            fp.start_date::text AS start_date, fp.end_date::text AS end_date,
            fp.status AS period_status,
            ab.beginning_balance::text AS beginning_balance,
            ab.debit_total::text AS debit_total,
            ab.credit_total::text AS credit_total,
            ab.ending_balance::text AS ending_balance
       FROM account_balances ab
       JOIN fiscal_periods fp ON fp.id = ab.fiscal_period_id
      WHERE ${cond.join(' AND ')}
      ORDER BY fp.start_date`,
    params
  );
  return result.rows;
}

// ============================================================
// F01 · MAPEOS ESTATUTARIOS — las columnas que nadie escribía
//
// mx_nif_code (agrupador SAT c_CodAgrup), us_gaap_code e ifrs_code
// viven en accounts desde la 001, tipadas y siempre nulas: ninguna
// ruta las escribía. Son la tarea de alta más pesada de un despacho
// mexicano (el agrupador por cuenta es requisito del XML de catálogo
// del Anexo 24). Esquemas sin columna (fs-line, cash-flow,
// consolidation) se RECHAZAN con mensaje, no se ignoran: fingir que
// se guardó un mapeo es peor que decir que aún no se puede.
// ============================================================

export const MAPPING_SCHEMES = {
  'sat-agrupador': 'mx_nif_code',
  'us-tax-line': 'us_gaap_code',
  'ifrs': 'ifrs_code',
} as const;
export type MappingScheme = keyof typeof MAPPING_SCHEMES;

const ESQUEMAS_SIN_COLUMNA = ['fs-line', 'cash-flow', 'consolidation'];

export function resolverEsquema(scheme: string): (typeof MAPPING_SCHEMES)[MappingScheme] {
  if (scheme in MAPPING_SCHEMES) return MAPPING_SCHEMES[scheme as MappingScheme];
  if (ESQUEMAS_SIN_COLUMNA.includes(scheme)) {
    throw new ValidationError(
      `El esquema "${scheme}" aún no tiene columna en el catálogo: hoy se soportan ${Object.keys(MAPPING_SCHEMES).join(', ')}.`
    );
  }
  throw new ValidationError(
    `Esquema desconocido "${scheme}". Soportados: ${Object.keys(MAPPING_SCHEMES).join(', ')}.`
  );
}

export async function setAccountMapping(
  id: string,
  scheme: string,
  value: string | null,
  userId: string
): Promise<Account> {
  const columna = resolverEsquema(scheme);
  const result = await query<Account>(
    `UPDATE accounts SET ${columna} = $1, updated_at = NOW(), updated_by = $2
      WHERE id = $3 RETURNING *`,
    [value, userId, id]
  );
  if (result.rows.length === 0) throw new NotFoundError('Account', id);
  return result.rows[0];
}

export interface FilaMapeo {
  code: string;
  name: string;
  account_level: number;
  is_active: boolean;
  mx_nif_code: string | null;
  us_gaap_code: string | null;
  ifrs_code: string | null;
}

export async function listAccountMappings(entityId: string): Promise<FilaMapeo[]> {
  const result = await query<FilaMapeo>(
    `SELECT code, name, account_level, is_active, mx_nif_code, us_gaap_code, ifrs_code
       FROM accounts WHERE entity_id = $1 AND is_active = true
      ORDER BY code`,
    [entityId]
  );
  return result.rows;
}

export interface ResultadoImportacionMapeo {
  code: string;
  resultado: 'aplicado' | 'sin_cuenta' | 'valor_vacio';
  detalle?: string;
}

/**
 * Carga masiva de un esquema desde pares (código de cuenta, valor). No valida
 * contra el catálogo c_CodAgrup (no existe en el repo todavía): la cobertura
 * la vigila `map check`; la validez del agrupador queda para `map match`.
 */
export async function importAccountMappings(
  entityId: string,
  scheme: string,
  pares: { code: string; value: string }[],
  userId: string,
  opts: { dryRun?: boolean } = {}
): Promise<ResultadoImportacionMapeo[]> {
  resolverEsquema(scheme); // valida ANTES de tocar fila alguna
  const resultados: ResultadoImportacionMapeo[] = [];
  for (const par of pares) {
    if (!par.value?.trim()) {
      resultados.push({ code: par.code, resultado: 'valor_vacio' });
      continue;
    }
    let cuenta: Account;
    try {
      cuenta = await resolveAccount(entityId, par.code);
    } catch {
      resultados.push({ code: par.code, resultado: 'sin_cuenta' });
      continue;
    }
    if (!opts.dryRun) {
      await setAccountMapping(cuenta.id, scheme, par.value.trim(), userId);
    }
    resultados.push({ code: par.code, resultado: 'aplicado' });
  }
  return resultados;
}

export interface HuecoDeCobertura {
  code: string;
  name: string;
  account_level: number;
}

/**
 * `map check --check coverage`: cuentas activas de nivel mayor y subcuenta de
 * primer nivel (account_level ≤ nivel) sin valor en el esquema. Es la
 * compuerta previa al XML de catálogo del Anexo 24.
 */
export async function checkMappingCoverage(
  entityId: string,
  scheme: string,
  nivel = 2
): Promise<HuecoDeCobertura[]> {
  const columna = resolverEsquema(scheme);
  const result = await query<HuecoDeCobertura>(
    `SELECT code, name, account_level
       FROM accounts
      WHERE entity_id = $1 AND is_active = true
        AND account_level <= $2 AND ${columna} IS NULL
      ORDER BY code`,
    [entityId, nivel]
  );
  return result.rows;
}
