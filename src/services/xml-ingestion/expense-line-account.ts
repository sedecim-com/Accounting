import type { AccountRole } from './cfdi-taxonomy.js';
import type { Queryable } from '../../utils/sequence.js';

// ============================================================
// WHICH ACCOUNT A RECEIVED CFDI'S EXPENSE LINE MAY BE SUGGESTED
// (MNE-001-487 · #684)
//
// One eligibility test, as SQL, for every reader of a suggestion. A purchase
// posted on its own payable, or on a bank or a tax account, records no
// expense. It is a deny-list on purpose: an expense account with no role
// (6200) or with an expense role (6310) must stay suggestible.
// ============================================================

/** Roles whose account is moved by a subledger, a bank or a tax engine, never by an expense line. */
export const CONTROL_ROLES: readonly AccountRole[] = [
  'cxp', 'cxc', 'anticipo_clientes', 'ingreso_cobrado_por_anticipado', 'anticipo_proveedores', 'banco', 'efectivo',
  'iva_trasladado', 'iva_trasladado_no_cobrado', 'iva_acreditable', 'iva_pendiente_acreditar',
  'iva_retenido_por_pagar', 'iva_retenido_a_favor',
  'isr_retenido_por_pagar', 'isr_retenido_a_favor', 'isr_nomina_por_pagar',
  'ieps_acreditable', 'ieps_por_pagar', 'ieps_trasladado_no_cobrado', 'impuestos_locales_por_pagar',
  'sueldos_por_pagar', 'imss_por_pagar',
  'provision_aguinaldo', 'provision_vacaciones', 'provision_prima_vacacional',
  'depreciacion_acumulada',
];

/**
 * Role → the seeded code that stands in for it in an entity with no row for
 * the role: one seeded before account_roles existed and not yet backfilled (E1.1).
 */
export const LEGACY_ROLE_CODES: Partial<Record<AccountRole, string>> = {
  cxp: '2110',
  iva_acreditable: '1130',
  iva_pendiente_acreditar: '1135',
};

// Both lists are compile-time constants of this file, never input: inlining
// them keeps the predicate free of parameters other than the entity.
const ROLE_LIST = CONTROL_ROLES.map((role) => `'${role}'`).join(', ');
const LEGACY_ROWS = Object.entries(LEGACY_ROLE_CODES).map(([role, code]) => `('${role}', '${code}')`).join(', ');

/**
 * The predicate over an `accounts a` row; `$1` must be the entity id. The role
 * rows are tied to the entity's tenant inside the statement (invariant 4).
 */
export const ELIGIBLE_EXPENSE_ACCOUNT_SQL = `
  a.entity_id = $1 AND a.is_active = true AND a.is_header = false
  AND a.allow_manual_entries = true AND a.is_control_account = false
  AND NOT EXISTS (
    SELECT 1 FROM bank_accounts ba WHERE ba.entity_id = $1 AND ba.gl_account_id = a.id)
  AND NOT EXISTS (
    SELECT 1 FROM account_roles ar
      JOIN legal_entities le ON le.id = ar.entity_id AND le.tenant_id = ar.tenant_id
     WHERE ar.entity_id = $1 AND ar.account_id = a.id AND ar.role IN (${ROLE_LIST}))
  AND NOT EXISTS (
    SELECT 1 FROM (VALUES ${LEGACY_ROWS}) AS legacy(role, code)
     WHERE legacy.code = a.code
       AND NOT EXISTS (
         SELECT 1 FROM account_roles ar
           JOIN legal_entities le ON le.id = ar.entity_id AND le.tenant_id = ar.tenant_id
          WHERE ar.entity_id = $1 AND ar.role = legacy.role AND ar.qualifier IS NULL))`;

/** Of `ids`, the accounts of the entity that an expense line may be suggested. */
export async function eligibleExpenseAccounts(
  db: Queryable,
  entityId: string,
  ids: readonly string[]
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const r = await db.query<{ id: string }>(
    `SELECT a.id FROM accounts a WHERE a.id = ANY($2::uuid[]) AND ${ELIGIBLE_EXPENSE_ACCOUNT_SQL}`,
    [entityId, [...ids]]
  );
  return new Set(r.rows.map((row) => row.id));
}

// ============================================================
// WHICH ACCOUNT THE LINE POSTS TO (MNE-001-552 · #684)
// ============================================================

/** What a stored line says about its account. */
export interface CodableLine {
  account_id?: string | null;
  suggested_account_id?: string | null;
}

/** For a reader that made no eligibility read: no suggestion posts. */
export const NO_ELIGIBLE_SUGGESTION: ReadonlySet<string> = new Set();

/** The suggestions of `lines` that may still post, read when the row is read: a stored row is never rewritten. */
export function eligibleSuggestions(
  db: Queryable,
  entityId: string,
  lines: readonly CodableLine[]
): Promise<Set<string>> {
  return eligibleExpenseAccounts(db, entityId, lines.flatMap((l) => (l.suggested_account_id ? [l.suggested_account_id] : [])));
}

/**
 * The account a line posts to: its own, then the one a person gave the whole
 * document, then its suggestion while it is in `eligible`. The first two are
 * what a person or a rule wrote and are not judged here (#684).
 */
export function pickLineAccount(
  line: CodableLine,
  defaultAccountId: string | null | undefined,
  eligible: ReadonlySet<string>
): string | undefined {
  if (line.account_id) return line.account_id;
  if (defaultAccountId) return defaultAccountId;
  const suggested = line.suggested_account_id;
  return suggested && eligible.has(suggested) ? suggested : undefined;
}

/** The lines `pickLineAccount` finds no account for. */
export function uncodedLines<L extends CodableLine>(
  lines: readonly L[],
  defaultAccountId: string | null | undefined,
  eligible: ReadonlySet<string>
): L[] {
  return lines.filter((line) => !pickLineAccount(line, defaultAccountId, eligible));
}
