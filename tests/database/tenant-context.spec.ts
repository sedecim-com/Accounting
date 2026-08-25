import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// The pool is built at module import time, so pg has to be intercepted.
const poolQuery = vi.fn();
const clientQuery = vi.fn();
const release = vi.fn();
const connect = vi.fn(async () => ({ query: clientQuery, release }));

vi.mock('pg', () => {
  class Pool {
    query = poolQuery;
    connect = connect;
    on = vi.fn();
  }
  return { default: { Pool } };
});

// The import stays dynamic because the mock factory above closes over these
// vi.fn()s: a static import would run it while they are still in the TDZ. It
// lives in beforeAll because the test project compiles as CommonJS, where
// top-level await is not allowed.
type ConnectionModule = typeof import('../../src/database/connection.js');
let query: ConnectionModule['query'];
let withTransaction: ConnectionModule['withTransaction'];
let withTenant: ConnectionModule['withTenant'];
let currentTenant: ConnectionModule['currentTenant'];

beforeAll(async () => {
  ({ query, withTransaction, withTenant, currentTenant } = await import(
    '../../src/database/connection.js'
  ));
});

const TENANT = 'tttttttt-tttt-tttt-tttt-tttttttttttt';

beforeEach(() => {
  poolQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  clientQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  release.mockReset();
  connect.mockClear();
});

describe('without tenant context (historical behavior)', () => {
  it('uses the pool directly, a single round trip', async () => {
    await query('SELECT 1', [7]);
    expect(poolQuery).toHaveBeenCalledWith('SELECT 1', [7]);
    expect(connect).not.toHaveBeenCalled();
  });

  it('currentTenant() is undefined', async () => {
    expect(currentTenant()).toBeUndefined();
  });

  it('withTransaction does not set a tenant', async () => {
    await withTransaction(async (c) => c.query('SELECT 1'));
    const statements = clientQuery.mock.calls.map((c) => c[0]);
    expect(statements).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
  });
});

describe('with tenant context', () => {
  it('wraps the query in a transaction and sets the tenant with local scope', async () => {
    await withTenant(TENANT, () => query('SELECT 1'));

    const statements = clientQuery.mock.calls.map((c) => c[0]);
    expect(statements).toEqual([
      'BEGIN',
      'SELECT set_config($1, $2, true)',
      'SELECT 1',
      'COMMIT',
    ]);
    // set_config's third argument `true` is the local scope: a session-level
    // SET would survive release() and contaminate the next connection.
    expect(clientQuery.mock.calls[1][1]).toEqual(['app.current_tenant', TENANT]);
    expect(poolQuery).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('exposes the tenant through currentTenant()', async () => {
    const seen = await withTenant(TENANT, async () => currentTenant());
    expect(seen).toBe(TENANT);
  });

  it('the tenant does not leak outside the scope', async () => {
    await withTenant(TENANT, async () => undefined);
    expect(currentTenant()).toBeUndefined();
  });

  it('the tenant travels through the await, not through the argument', async () => {
    // A nested function that never received the tenant still sees it: this is
    // what lets 164 call sites stay unchanged.
    const nested = async () => query('SELECT deep');
    await withTenant(TENANT, async () => {
      await new Promise((r) => setImmediate(r));
      return nested();
    });
    expect(clientQuery.mock.calls[1][1]).toEqual(['app.current_tenant', TENANT]);
  });

  it('ROLLBACKs and releases the connection if the query fails', async () => {
    clientQuery
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [] }) // set_config
      .mockRejectedValueOnce(new Error('boom')) // the query
      .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

    await expect(withTenant(TENANT, () => query('SELECT boom'))).rejects.toThrow('boom');
    expect(clientQuery.mock.calls.map((c) => c[0])).toContain('ROLLBACK');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('withTransaction sets the tenant before the body', async () => {
    await withTenant(TENANT, () => withTransaction(async (c) => c.query('SELECT 1')));
    const statements = clientQuery.mock.calls.map((c) => c[0]);
    expect(statements).toEqual([
      'BEGIN',
      'SELECT set_config($1, $2, true)',
      'SELECT 1',
      'COMMIT',
    ]);
  });

  it('nests: the inner tenant wins within its scope', async () => {
    const OTHER = 'oooooooo-oooo-oooo-oooo-oooooooooooo';
    await withTenant(TENANT, async () => {
      await withTenant(OTHER, () => query('SELECT inner'));
      expect(currentTenant()).toBe(TENANT);
    });
    expect(clientQuery.mock.calls[1][1]).toEqual(['app.current_tenant', OTHER]);
  });
});
