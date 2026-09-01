import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import {
  listAccounts,
  getAccountById,
  resolveAccount,
  createAccount,
  updateAccount,
  deactivateAccount,
  UPDATABLE_FIELDS,
} from '../../../src/services/accounting/account-service.js';
import { query } from '../../../src/database/connection.js';
import { NotFoundError, ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER = 'user-1';

beforeEach(() => mockQuery.mockReset());

const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');
const params = (call: number) => mockQuery.mock.calls[call][1];

describe('listAccounts', () => {
  it('reports the true total so a caller can detect truncation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '412' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ code: '1110' }] });
    const page = await listAccounts(ENTITY, { limit: 1 });
    expect(page.total).toBe(412);
    expect(page.rows).toHaveLength(1);
  });

  it('scopes every query to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listAccounts(ENTITY);
    expect(sql(0)).toMatch(/WHERE entity_id = \$1/);
    expect(params(0)[0]).toBe(ENTITY);
    expect(params(1)[0]).toBe(ENTITY);
  });

  it('matches the search term against both code and name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listAccounts(ENTITY, { search: 'banco' });
    expect(sql(0)).toMatch(/\(code ILIKE \$2 OR name ILIKE \$2\)/);
    expect(params(0)[1]).toBe('%banco%');
  });

  it('combines filters without renumbering the placeholders wrongly', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listAccounts(ENTITY, { accountType: 'asset', isActive: true, parentId: 'p1', search: 'x' });
    expect(params(0)).toEqual([ENTITY, 'asset', true, 'p1', '%x%']);
    expect(sql(0)).toMatch(/account_type = \$2 AND is_active = \$3 AND parent_id = \$4/);
  });

  it('counts children in one pass rather than a query per row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listAccounts(ENTITY);
    expect(sql(1)).toMatch(/SELECT COUNT\(\*\) FROM accounts c WHERE c\.parent_id = a\.id/);
    expect(mockQuery.mock.calls).toHaveLength(2);
  });
});

describe('getAccountById', () => {
  it('returns null instead of throwing, so callers choose the error', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getAccountById('x')).toBeNull();
  });

  it('computes balance as lifetime ACTIVITY, never a sum of ending balances', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1', code: '1110' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '1500.00' }] });
    const account = await getAccountById('a1', { includeBalance: true });
    expect(account?.current_balance).toBe('1500.00');
    // Summing ending_balance would double-count carried-forward periods.
    expect(sql(1)).toMatch(/SUM\(debit_total - credit_total\)/);
    expect(sql(1)).not.toMatch(/ending_balance/);
  });

  it('joins the parent only when the hierarchy was asked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1' }] });
    await getAccountById('a1');
    expect(sql(0)).not.toMatch(/LEFT JOIN/);

    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1' }] });
    await getAccountById('a1', { includeHierarchy: true });
    expect(sql(0)).toMatch(/LEFT JOIN accounts p ON p\.id = a\.parent_id/);
  });
});

describe('resolveAccount — what a person types vs what the tables hold', () => {
  it('looks up a code, scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1', code: '1110' }] });
    await resolveAccount(ENTITY, '1110');
    expect(sql(0)).toMatch(/WHERE code = \$1 AND entity_id = \$2/);
    expect(params(0)).toEqual(['1110', ENTITY]);
  });

  it('looks up a uuid by id, still scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: ENTITY }] });
    await resolveAccount(ENTITY, ENTITY);
    expect(sql(0)).toMatch(/WHERE id = \$1 AND entity_id = \$2/);
  });

  it('throws NotFound naming what was looked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolveAccount(ENTITY, '9999')).rejects.toThrow(
      expect.objectContaining({ name: 'NotFoundError', message: expect.stringContaining('9999') })
    );
  });
});

describe('createAccount', () => {
  const base = {
    code: '5100', name: 'Gastos', account_type: 'expense' as const,
    normal_balance: 'debit' as const, entity_id: ENTITY, created_by: USER,
  };

  it('rejects a duplicate code as a conflict, not a raw constraint error', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }] });
    await expect(createAccount(base)).rejects.toThrow(
      expect.objectContaining({ name: 'ConflictError', message: expect.stringContaining('"5100" already exists') })
    );
  });

  it('makes a header account reject manual entries, satisfying the table CHECK', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new', code: '5100' }] });
    await createAccount({ ...base, is_header: true });
    // allow_manual_entries is the 11th parameter, is_header the 12th
    expect(params(1)[10]).toBe(false);
    expect(params(1)[11]).toBe(true);
  });

  it('refuses the contradiction rather than letting the database raise it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      createAccount({ ...base, is_header: true, allow_manual_entries: true })
    ).rejects.toThrow(ValidationError);
  });

  it('leaves a postable account accepting manual entries', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new' }] });
    await createAccount(base);
    expect(params(1)[10]).toBe(true);
    expect(params(1)[11]).toBe(false);
  });
});

describe('updateAccount', () => {
  it('writes only whitelisted fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1' }] });
    await updateAccount('a1', { name: 'Nuevo', is_active: false }, USER);
    expect(sql(0)).toMatch(/SET name = \$1, is_active = \$2, updated_at = NOW\(\), updated_by = \$3/);
  });

  it('names the updatable fields when given none of them', async () => {
    await expect(updateAccount('a1', {}, USER)).rejects.toThrow(
      new RegExp(UPDATABLE_FIELDS.join(', '))
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('serialises tags as JSON, matching the JSONB column', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1' }] });
    await updateAccount('a1', { tags: ['a', 'b'] }, USER);
    expect(params(0)[0]).toBe('["a","b"]');
  });

  it('throws NotFound when the row does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(updateAccount('gone', { name: 'x' }, USER)).rejects.toThrow(NotFoundError);
  });
});

describe('deactivateAccount — retiring is not deleting', () => {
  it('refuses an account with history by default (the DELETE rule)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    await expect(deactivateAccount('a1', USER)).rejects.toThrow(ValidationError);
    // Nothing was written.
    expect(mockQuery.mock.calls).toHaveLength(1);
  });

  it('allows it when the caller can justify itself, and reports the history', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    const result = await deactivateAccount('a1', USER, { allowWithHistory: true });
    expect(result.hadHistory).toBe(true);
    expect(sql(1)).toMatch(/SET is_active = false/);
  });

  it('never issues a DELETE — history has to survive', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await deactivateAccount('a1', USER);
    expect(sql(1)).not.toMatch(/DELETE/i);
  });

  it('throws NotFound when nothing was updated', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 0 });
    await expect(deactivateAccount('gone', USER)).rejects.toThrow(NotFoundError);
  });
});
