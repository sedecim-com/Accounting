import { v4 as uuidv4 } from 'uuid';
import { query } from '../../database/connection.js';
import { NotFoundError, ValidationError, ConflictError } from '../../utils/errors.js';
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
}

export async function deactivateAccount(
  id: string,
  userId: string,
  opts: DeactivateOptions = {}
): Promise<{ hadHistory: boolean }> {
  const lines = await query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM journal_entry_lines WHERE account_id = $1',
    [id]
  );
  const hadHistory = parseInt(lines.rows[0].count, 10) > 0;

  if (hadHistory && !opts.allowWithHistory) {
    throw new ValidationError('Cannot delete account with existing transactions');
  }

  const result = await query(
    `UPDATE accounts SET is_active = false, updated_at = NOW(), updated_by = $1 WHERE id = $2`,
    [userId, id]
  );
  if (result.rowCount === 0) throw new NotFoundError('Account', id);
  return { hadHistory };
}

export async function reactivateAccount(id: string, userId: string): Promise<Account> {
  return updateAccount(id, { is_active: true }, userId);
}
