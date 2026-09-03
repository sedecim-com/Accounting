import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../database/connection.js';
import { NotFoundError, ValidationError, ConflictError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import { getPolicy } from '../policy/policy-service.js';
import type { PolicyContext } from '../policy/policy-service.js';
import { resolvePeriod } from './fiscal-calendar-service.js';
import {
  prepararValidacionAgrupador,
  validarCodigoAgrupador,
  exigirAgrupadorValido,
} from './sat-agrupadores.js';
import type {
  ContextoValidacionAgrupador,
  ResultadoValidacionAgrupador,
} from './sat-agrupadores.js';
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
  /** G3: por qué nace esta cuenta. Va a `audit_log.reason` si el llamador lo trae. */
  reason?: string | null;
}

// ============================================================
// G3 · EL CATÁLOGO DEJA RASTRO
//
// Una cuenta es el DESTINO del dinero. Crearla, renombrarla, archivarla o
// cambiarle las banderas de gobierno decide a dónde puede postear el sistema
// y a dónde ya no, y hasta hoy ninguno de esos cuatro actos escribía una fila
// en `audit_log`: quedaba `updated_by` —el ÚLTIMO que tocó, que se pisa con
// cada cambio— y nada más. `updated_by` no es un rastro; es una foto.
//
// Tres decisiones de forma, y ninguna es de estilo:
//
//  1. Cada escritor pasa a `withTransaction`. Con `query()` el hecho y su
//     rastro se confirmaban en transacciones distintas (dos conexiones del
//     pool), así que un fallo entre ambos dejaba uno sin el otro. Es la misma
//     razón que `registrarAuditoria` documenta al recibir el cliente.
//  2. Las columnas del rastro se ENUMERAN. Un `{...row}` publicaría en la
//     bitácora —que es de sólo agregar— cualquier columna que una migración
//     futura añada, sin que nadie lo decidiera.
//  3. El inquilino se resuelve con `tenantDe` desde la ENTIDAD de la cuenta,
//     no desde el contexto RLS a secas: los tres escritores que reciben sólo
//     un id de cuenta (update, archive, gobierno) tienen que leer la fila de
//     todas formas para poder decir de qué valor vino.
// ============================================================

/** Lo que un lector del rastro necesita de una cuenta, y nada más. */
const ACCOUNT_AUDIT_FIELDS = [
  'code', 'name', 'account_type', 'account_subtype', 'fs_category',
  'parent_id', 'currency_code', 'normal_balance', 'allow_manual_entries',
  'is_header', 'is_control_account', 'require_subsidiary', 'is_active',
  'description',
] as const;

function cuentaParaRastro(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of ACCOUNT_AUDIT_FIELDS) out[f] = row[f] ?? null;
  return out;
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

  return withTransaction(async (client) => {
    const result = await client.query<Account>(
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
    const cuenta = result.rows[0];
    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, input.entity_id),
      userId: input.created_by,
      action: 'create',
      entityType: 'account',
      entityId: cuenta.id,
      oldValues: null,
      newValues: cuentaParaRastro(cuenta as unknown as Record<string, unknown>),
      reason: input.reason ?? null,
    });
    return cuenta;
  });
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
  userId: string,
  reason?: string | null
): Promise<Account> {
  const cambiados = UPDATABLE_FIELDS.filter((f) => patch[f] !== undefined);
  if (cambiados.length === 0) {
    throw new ValidationError(
      `No updatable field given. One of: ${UPDATABLE_FIELDS.join(', ')}.`
    );
  }

  return withTransaction(async (client) => {
    // FOR UPDATE: la fila anterior es el `old_values` del rastro y a la vez
    // el candado que impide que dos ediciones simultáneas dejen el estado de
    // una y el antes de la otra.
    const antes = await client.query<Account>(
      'SELECT * FROM accounts WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (antes.rows.length === 0) throw new NotFoundError('Account', id);
    const previa = antes.rows[0] as unknown as Record<string, unknown>;

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    for (const field of cambiados) {
      sets.push(`${field} = $${i++}`);
      params.push(field === 'tags' ? JSON.stringify(patch[field]) : patch[field]);
    }
    sets.push('updated_at = NOW()');
    sets.push(`updated_by = $${i++}`);
    params.push(userId, id);

    const result = await client.query<Account>(
      `UPDATE accounts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );
    const despues = result.rows[0] as unknown as Record<string, unknown>;

    // Sólo los campos TOCADOS, con su antes y su después. El documento
    // completo convertiría cada renombre en una copia entera de la cuenta y
    // haría ilegible la pregunta que el rastro contesta: qué cambió.
    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, previa.entity_id as string),
      userId,
      action: 'update',
      entityType: 'account',
      entityId: id,
      oldValues: Object.fromEntries(cambiados.map((f) => [f, previa[f] ?? null])),
      newValues: Object.fromEntries(cambiados.map((f) => [f, despues[f] ?? null])),
      reason: reason ?? null,
    });

    return result.rows[0];
  });
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
  /**
   * G3: por qué se archiva. `--force` sobre una cuenta con saldo vivo YA
   * exige razón en el CLI (§3.5); esto es lo que hace que esa razón llegue a
   * algún sitio en vez de morir en la terminal.
   */
  reason?: string | null;
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

  await withTransaction(async (client) => {
    const antes = await client.query<{ entity_id: string; code: string; is_active: boolean }>(
      'SELECT entity_id, code, is_active FROM accounts WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (antes.rows.length === 0) throw new NotFoundError('Account', id);
    const previa = antes.rows[0];

    await client.query(
      `UPDATE accounts SET is_active = false, updated_at = NOW(), updated_by = $1 WHERE id = $2`,
      [userId, id]
    );

    // Archivar es 'update', no 'delete': la cuenta sigue ahí y su historia
    // también. El vocabulario de `audit_log.action` lo fija un CHECK (001) y
    // llamarle 'delete' a lo que no borra haría mentir a todo lector que
    // filtre por acción.
    //
    // El saldo y la historia entran en `new_values` porque son las DOS
    // condiciones que el archivado evalúa: quien lea el rastro tiene que
    // poder ver si se archivó una cuenta con movimientos, o con saldo vivo
    // por la vía de `--force`, sin recalcular nada seis meses después.
    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, previa.entity_id),
      userId,
      action: 'update',
      entityType: 'account',
      entityId: id,
      oldValues: { code: previa.code, is_active: previa.is_active },
      newValues: {
        code: previa.code,
        is_active: false,
        had_history: hadHistory,
        balance_at_archive: balance,
        forced_with_balance: opts.enforceZeroBalance !== true && Number(balance) !== 0,
      },
      reason: opts.reason ?? null,
    });
  });

  return { hadHistory, balance };
}

export async function reactivateAccount(
  id: string,
  userId: string,
  reason?: string | null
): Promise<Account> {
  return updateAccount(id, { is_active: true }, userId, reason);
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
  userId: string,
  reason?: string | null
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

  return withTransaction(async (client) => {
    const actual = await client.query<Account>(
      'SELECT * FROM accounts WHERE id = $1 FOR UPDATE',
      [id]
    );
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

    const result = await client.query<Account>(
      `UPDATE accounts SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      params
    );

    // Las banderas de gobierno son la puerta del posteo: `allow_manual_entries`
    // decide si un humano puede escribir en esta cuenta, y `is_control_account`
    // si el mayor la considera control de un subdiario. Cambiarlas sin dejar
    // quién es exactamente lo que hace irrebatible un asiento discutido.
    const previa = cuenta as unknown as Record<string, unknown>;
    const despues = result.rows[0] as unknown as Record<string, unknown>;
    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, cuenta.entity_id),
      userId,
      action: 'update',
      entityType: 'account',
      entityId: id,
      oldValues: Object.fromEntries(keys.map((k) => [k, previa[k] ?? null])),
      newValues: Object.fromEntries(keys.map((k) => [k, despues[k] ?? null])),
      reason: reason ?? null,
    });

    return result.rows[0];
  });
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
// us_gaap_code, mx_nif_code e ifrs_code viven en accounts desde la
// 001, tipadas y siempre nulas: ninguna ruta las escribía. Son la
// tarea de alta más pesada de un despacho. Esquemas sin columna
// (fs-line, cash-flow, consolidation) se RECHAZAN con mensaje, no se
// ignoran: fingir que se guardó un mapeo es peor que decir que aún no
// se puede.
//
// F07a · EL AGRUPADOR CAMBIA DE CASILLA. Hasta la 063, 'sat-agrupador'
// escribía en mx_nif_code. Era el sitio equivocado y se notaba en el
// nombre: mx_nif_code nació hermana de us_gaap_code e ifrs_code, o sea
// una familia de códigos de NORMA CONTABLE — cómo se PRESENTA una
// cuenta bajo NIF, US-GAAP o IFRS. El agrupador del SAT es FISCAL: cómo
// la AGRUPA la autoridad para leer la contabilidad. Compartían casilla
// mientras nadie usara las dos; el día que una entidad mexicana
// necesitara su código NIF de presentación Y su agrupador del Anexo 24,
// uno pisaba al otro en silencio. Desde la 063 el agrupador tiene la
// suya, `accounts.codigo_agrupador_sat`, que es la que la 037 había
// creado para esto y llevaba dos años sin un solo lector.
// ============================================================

export const MAPPING_SCHEMES = {
  'sat-agrupador': 'codigo_agrupador_sat',
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

export interface OpcionesDeMapeo {
  /**
   * Fecha contra la que se comprueba la vigencia del catálogo del SAT. El
   * agrupador válido depende del EJERCICIO, así que la fecha es un dato del
   * mapeo, no del reloj: por omisión hoy, pero quien mapea un ejercicio
   * anterior debe poder decirlo.
   */
  fecha?: string;
  /** Veredicto ya resuelto por el llamador (import en lote): evita releer la política por fila. */
  validacion?: ContextoValidacionAgrupador;
  /** Recibe el aviso cuando el código se acepta con reparos, en vez de perderlo. */
  onAviso?: (r: ResultadoValidacionAgrupador) => void;
}

/**
 * Resuelve el contexto de políticas de una cuenta. `setAccountMapping` sólo
 * recibe el id de la cuenta, y la política vive por inquilino/entidad: hay que
 * subir por la cuenta hasta su entidad. Se hace en UNA consulta.
 */
async function contextoDePoliticaDeCuenta(id: string): Promise<PolicyContext | null> {
  const r = await query<{ entity_id: string; tenant_id: string }>(
    `SELECT a.entity_id, le.tenant_id
       FROM accounts a JOIN legal_entities le ON le.id = a.entity_id
      WHERE a.id = $1`,
    [id]
  );
  const row = r.rows[0];
  return row ? { tenantId: row.tenant_id, entityId: row.entity_id } : null;
}

export async function setAccountMapping(
  id: string,
  scheme: string,
  value: string | null,
  userId: string,
  opts: OpcionesDeMapeo = {}
): Promise<Account> {
  const columna = resolverEsquema(scheme);

  // F07a · el agrupador se valida contra el catálogo oficial ANTES de
  // escribirse. Sólo el agrupador: us-tax-line e ifrs son otras taxonomías y
  // no tienen catálogo sembrado que las juzgue. Limpiar (value null) nunca se
  // valida — borrar un mapeo no puede estar «fuera de catálogo».
  if (scheme === 'sat-agrupador' && value !== null) {
    const ctxPol = await contextoDePoliticaDeCuenta(id);
    if (ctxPol === null) throw new NotFoundError('Account', id);
    const fecha = opts.fecha ?? new Date().toISOString().slice(0, 10);
    const ctxVal = opts.validacion ?? (await prepararValidacionAgrupador(ctxPol, fecha));
    // Revienta si la política dice rechazar; devuelve el veredicto si no.
    const veredicto = await exigirAgrupadorValido(ctxVal, value);
    // Un aviso que nadie recoge es un aviso perdido, así que va al log
    // SIEMPRE y además al llamador si lo pidió. Lo que no se hace es
    // guardarlo en una variable de módulo: este servicio atiende peticiones
    // concurrentes y dos mapeos a la vez se robarían el aviso el uno al otro.
    if (veredicto.aviso) {
      logger.warn(veredicto.aviso, {
        cuenta: id,
        codigo: value,
        veredicto: veredicto.veredicto,
      });
      opts.onAviso?.(veredicto);
    }
  }

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
  /** El agrupador FISCAL del Anexo 24. Desde la 063 vive aquí. */
  codigo_agrupador_sat: string | null;
  /** Presentación bajo NIF mexicanas. NO es el agrupador: ver MAPPING_SCHEMES. */
  mx_nif_code: string | null;
  us_gaap_code: string | null;
  ifrs_code: string | null;
}

export async function listAccountMappings(entityId: string): Promise<FilaMapeo[]> {
  const result = await query<FilaMapeo>(
    `SELECT code, name, account_level, is_active,
            codigo_agrupador_sat, mx_nif_code, us_gaap_code, ifrs_code
       FROM accounts WHERE entity_id = $1 AND is_active = true
      ORDER BY code`,
    [entityId]
  );
  return result.rows;
}

export interface ResultadoImportacionMapeo {
  code: string;
  resultado: 'aplicado' | 'sin_cuenta' | 'valor_vacio' | 'fuera_de_catalogo';
  detalle?: string;
}

/**
 * Carga masiva de un esquema desde pares (código de cuenta, valor).
 *
 * F07a: el agrupador ya SÍ se valida contra el c_CodAgrup (`sat-agrupadores`).
 * La política y la vigencia del catálogo se resuelven UNA vez para toda la
 * tanda —son las mismas para las mil filas de un CSV— y una fila fuera de
 * catálogo no aborta el lote: se marca y el resto entra. Un import de mil
 * cuentas que muere en la 700 deja al despacho peor que uno que reporta las
 * tres malas.
 */
export async function importAccountMappings(
  entityId: string,
  scheme: string,
  pares: { code: string; value: string }[],
  userId: string,
  opts: { dryRun?: boolean; fecha?: string } = {}
): Promise<ResultadoImportacionMapeo[]> {
  resolverEsquema(scheme); // valida ANTES de tocar fila alguna

  let ctxVal: ContextoValidacionAgrupador | undefined;
  if (scheme === 'sat-agrupador') {
    const r = await query<{ tenant_id: string }>(
      'SELECT tenant_id FROM legal_entities WHERE id = $1',
      [entityId]
    );
    const tenantId = r.rows[0]?.tenant_id;
    if (tenantId) {
      ctxVal = await prepararValidacionAgrupador(
        { tenantId, entityId },
        opts.fecha ?? new Date().toISOString().slice(0, 10)
      );
    }
  }

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
    const valor = par.value.trim();

    // En dry-run también se valida: el sentido de un dry-run es enterarse
    // antes, y un dry-run que aprueba lo que la corrida real va a rechazar es
    // el peor de los dos mundos.
    if (ctxVal) {
      const v = await validarCodigoAgrupador(ctxVal, valor);
      if (v.accion === 'rechazar') {
        resultados.push({ code: par.code, resultado: 'fuera_de_catalogo', detalle: v.aviso });
        continue;
      }
      if (v.aviso) logger.warn(v.aviso, { cuenta: par.code, codigo: valor });
    }

    if (!opts.dryRun) {
      await setAccountMapping(cuenta.id, scheme, valor, userId, { validacion: ctxVal });
    }
    resultados.push({ code: par.code, resultado: 'aplicado' });
  }
  return resultados;
}

export interface HuecoDeCobertura {
  account_id: string;
  code: string;
  name: string;
  account_level: number;
  /** Cuántas líneas posteadas tiene en el alcance medido. 0 bajo los alcances que no miran el mayor. */
  lineas_posteadas: number;
}

/** Los tres alcances del panel para 'agrupador_alcance_de_la_compuerta'. */
export const ALCANCES_DE_COMPUERTA = [
  'cuentas_con_movimientos',
  'todas_las_de_detalle',
  'todas',
] as const;
export type AlcanceDeCompuerta = (typeof ALCANCES_DE_COMPUERTA)[number];

export interface OpcionesDeCompuerta {
  /** Evita subir por la entidad para encontrar el inquilino cuando el llamador ya lo sabe. */
  tenantId?: string;
  /** Acota el movimiento a un periodo fiscal concreto. */
  fiscalPeriodId?: string;
  /** Acota el movimiento por fecha de asiento. */
  desde?: string;
  hasta?: string;
  /** Fuerza el alcance sin pasar por el panel. Para pruebas y para `--scope`. */
  alcance?: AlcanceDeCompuerta;
}

export interface CoberturaDeMapeo {
  alcance: AlcanceDeCompuerta;
  /** true = el usuario contestó la política; false = se usó el defecto. */
  alcanceElegido: boolean;
  /** Cuentas de la población medida, con hueco y sin él. */
  poblacion: number;
  huecos: HuecoDeCobertura[];
}

/**
 * `map check --check coverage`: la compuerta previa al XML de catálogo del
 * Anexo 24 — qué cuentas no pueden entregarse porque les falta el mapeo.
 *
 * F07a · POR QUÉ ESTO SE REESCRIBIÓ ENTERO. La versión anterior filtraba
 * `account_level <= 2`, y una sonda contra una entidad real con dos cuentas
 * movidas devolvió 43 huecos, 42 de ellos cuentas SIN UN SOLO MOVIMIENTO —
 * mientras que la única cuenta que sí se había movido sin agrupador, la 1120,
 * NO salía en la lista por estar en el nivel 3. Fallaba en las dos
 * direcciones a la vez: ruido donde no hay riesgo y silencio donde lo hay.
 * Las dos mitades del fallo son la misma equivocación — el nivel de una
 * cuenta en el catálogo no dice nada sobre si la autoridad va a leerla.
 *
 * Lo que la autoridad lee es el saldo y las pólizas, así que la población por
 * omisión son las cuentas CON MOVIMIENTO POSTEADO. Es la respuesta que el
 * panel trae de fábrica en 'agrupador_alcance_de_la_compuerta', y quien
 * prefiera cubrir el catálogo entero antes de que se mueva lo contesta ahí.
 *
 * Sobre `nivel`: el tercer parámetro se acepta como número por compatibilidad
 * con los llamadores de F01 y se IGNORA a propósito — es el filtro que
 * causaba el defecto. Está anotado en el informe de F07a para que el CLI
 * retire `--level` en vez de seguir prometiendo un recorte que no ocurre.
 */
export async function checkMappingCoverageDetallada(
  entityId: string,
  scheme: string,
  opciones: OpcionesDeCompuerta = {}
): Promise<CoberturaDeMapeo> {
  const columna = resolverEsquema(scheme);

  let alcance: AlcanceDeCompuerta;
  let alcanceElegido = false;
  if (opciones.alcance) {
    alcance = opciones.alcance;
  } else {
    const tenantId =
      opciones.tenantId ??
      (
        await query<{ tenant_id: string }>(
          'SELECT tenant_id FROM legal_entities WHERE id = $1',
          [entityId]
        )
      ).rows[0]?.tenant_id;
    if (!tenantId) throw new NotFoundError('LegalEntity', entityId);
    const pol = await getPolicy({ tenantId, entityId }, 'agrupador_alcance_de_la_compuerta');
    alcance = (ALCANCES_DE_COMPUERTA as readonly string[]).includes(pol.value)
      ? (pol.value as AlcanceDeCompuerta)
      : 'cuentas_con_movimientos';
    alcanceElegido = pol.defined;
  }

  // La entidad va DENTRO del SQL en las dos tablas, no sólo en `accounts`:
  // un asiento de otra entidad no puede ser el que obligue a mapear ésta.
  const params: unknown[] = [entityId];
  const movimiento: string[] = [];
  if (opciones.fiscalPeriodId) {
    params.push(opciones.fiscalPeriodId);
    movimiento.push(`AND je.fiscal_period_id = $${params.length}`);
  }
  if (opciones.desde) {
    params.push(opciones.desde);
    movimiento.push(`AND je.entry_date >= $${params.length}`);
  }
  if (opciones.hasta) {
    params.push(opciones.hasta);
    movimiento.push(`AND je.entry_date <= $${params.length}`);
  }

  // Un solo recorrido para las dos cifras: la población y el hueco. Contarlas
  // por separado invita a que una consulta cambie y la otra no, y entonces el
  // «3 de 40» del informe deja de ser sobre el mismo conjunto.
  const poblacionFiltro =
    alcance === 'todas'
      ? ''
      : alcance === 'todas_las_de_detalle'
        ? 'AND a.is_header = false'
        : 'AND m.lineas > 0';

  const result = await query<HuecoDeCobertura & { sin_mapeo: boolean }>(
    `WITH mov AS (
       SELECT jel.account_id, COUNT(*)::int AS lineas
         FROM journal_entry_lines jel
         JOIN journal_entries je
           ON je.id = jel.journal_entry_id
          AND je.status = 'posted'
          AND je.entity_id = $1
        ${movimiento.join(' ')}
        GROUP BY jel.account_id
     )
     SELECT a.id AS account_id, a.code, a.name, a.account_level,
            COALESCE(m.lineas, 0) AS lineas_posteadas,
            (a.${columna} IS NULL) AS sin_mapeo
       FROM accounts a
       LEFT JOIN mov m ON m.account_id = a.id
      WHERE a.entity_id = $1 AND a.is_active = true
        ${poblacionFiltro}
      ORDER BY a.code`,
    params
  );

  return {
    alcance,
    alcanceElegido,
    poblacion: result.rows.length,
    huecos: result.rows
      .filter((r) => r.sin_mapeo)
      .map(({ account_id, code, name, account_level, lineas_posteadas }) => ({
        account_id, code, name, account_level, lineas_posteadas,
      })),
  };
}

/** Forma histórica: sólo los huecos. Los llamadores de F01 siguen compilando. */
export async function checkMappingCoverage(
  entityId: string,
  scheme: string,
  nivelOOpciones: number | OpcionesDeCompuerta = 2
): Promise<HuecoDeCobertura[]> {
  const opciones = typeof nivelOOpciones === 'number' ? {} : nivelOOpciones;
  const r = await checkMappingCoverageDetallada(entityId, scheme, opciones);
  return r.huecos;
}
