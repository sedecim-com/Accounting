import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import {
  actoresPorInquilino,
  censusRolesOnParentAccounts,
  repointRolesToLeaves,
} from '../../src/services/accounting/account-roles-backfill.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';

/**
 * BAN-1 (#324): the `banco` role lives on a leaf, and entities seeded before
 * the fix are repointed by the backfill, once.
 *
 * The seed mapped `banco` to 1110 «Caja y Bancos», the parent of the bank
 * accounts, and `seedAccountRoles` never overwrites a mapping. So the entities
 * of this suite are put back into the old state by hand, and the backfill has
 * to bring them to the leaf their books use: 1111 for a Mexican entity, 1115
 * for a non-Mexican one.
 */

let mx: Fixture;
let us: Fixture;

async function accountId(entityId: string, code: string): Promise<string> {
  const r = await query<{ id: string }>(
    `SELECT id FROM accounts WHERE entity_id = $1 AND code = $2`, [entityId, code]
  );
  return r.rows[0].id;
}

async function bankCode(entityId: string): Promise<string> {
  const r = await query<{ code: string }>(
    `SELECT a.code FROM account_roles ar JOIN accounts a ON a.id = ar.account_id
      WHERE ar.entity_id = $1 AND ar.role = 'banco' AND ar.qualifier IS NULL`,
    [entityId]
  );
  return r.rows[0].code;
}

async function restoreOldSeed(f: Fixture): Promise<void> {
  await query(
    `UPDATE account_roles SET account_id = $1
      WHERE entity_id = $2 AND role = 'banco' AND qualifier IS NULL`,
    [await accountId(f.entityId, '1110'), f.entityId]
  );
}

beforeAll(async () => {
  mx = await crearInquilino('BAN-1 MX');
  us = await crearInquilino('BAN-1 US', { pais: 'US' });
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('a freshly seeded entity', () => {
  it('maps banco to the leaf of its chart, not to 1110', async () => {
    expect(await bankCode(mx.entityId)).toBe('1111');
    expect(await bankCode(us.entityId)).toBe('1115');
  });
});

describe('the backfill of an entity seeded with banco → 1110', () => {
  beforeAll(async () => {
    await restoreOldSeed(mx);
    await restoreOldSeed(us);
  });

  it('the census finds it and writes nothing', async () => {
    const before = await bankCode(mx.entityId);
    const census = await censusRolesOnParentAccounts(mx.tenantId);
    expect(census.fixable.map((r) => [r.role, r.fromCode, r.toCode])).toEqual([['banco', '1110', '1111']]);
    // 6100 is a parent too, but the seed has no leaf to offer for `gasto`:
    // reported, never guessed.
    expect(census.unfixable.map((u) => u.role)).toContain('gasto');
    // `efectivo` sits on 1110 by design: it names cash, it does not post.
    expect(census.unfixable.map((u) => u.role)).not.toContain('efectivo');
    expect(await bankCode(mx.entityId)).toBe(before);
  });

  it('repoints each entity to its own leaf, with an audit row', async () => {
    for (const [f, leaf] of [[mx, '1111'], [us, '1115']] as const) {
      const census = await censusRolesOnParentAccounts(f.tenantId);
      const r = await repointRolesToLeaves(census.fixable, await actoresPorInquilino([f.tenantId]));
      expect(r).toEqual({ repointed: 1, failures: [] });
      expect(await bankCode(f.entityId)).toBe(leaf);

      const audit = await query<{ old_values: { code: string }; new_values: { code: string } }>(
        `SELECT old_values, new_values FROM audit_log
          WHERE tenant_id = $1 AND entity_type = 'account_role' AND entity_id = $2`,
        [f.tenantId, census.fixable[0].roleId]
      );
      expect(audit.rows.map((a) => [a.old_values.code, a.new_values.code])).toEqual([['1110', leaf]]);
    }
  });

  it('is idempotent: a second run finds nothing and a stale row is left alone', async () => {
    const census = await censusRolesOnParentAccounts(mx.tenantId);
    expect(census.fixable).toEqual([]);

    // Replaying the first census (someone ran it twice at once) must not
    // move a row that is no longer where the census saw it.
    const stale = {
      roleId: (await query<{ id: string }>(
        `SELECT id FROM account_roles WHERE entity_id = $1 AND role = 'banco' AND qualifier IS NULL`,
        [mx.entityId]
      )).rows[0].id,
      entityId: mx.entityId, entityName: 'BAN-1 MX', tenantId: mx.tenantId, role: 'banco',
      fromAccountId: await accountId(mx.entityId, '1110'), fromCode: '1110',
      toAccountId: await accountId(mx.entityId, '1112'), toCode: '1112',
    };
    const r = await repointRolesToLeaves([stale], await actoresPorInquilino([mx.tenantId]));
    expect(r.repointed).toBe(0);
    expect(r.failures[0]).toMatch(/cambió desde el censo/);
    expect(await bankCode(mx.entityId)).toBe('1111');
  });
});

describe('a qualified variant on the parent', () => {
  it('is not the seed’s to move', async () => {
    await query(
      `INSERT INTO account_roles (tenant_id, entity_id, role, account_id, qualifier)
       VALUES ($1, $2, 'banco', $3, 'caja-chica')`,
      [mx.tenantId, mx.entityId, await accountId(mx.entityId, '1110')]
    );
    const census = await censusRolesOnParentAccounts(mx.tenantId);
    expect(census.fixable).toEqual([]);
  });
});

describe('a tenant with no active user', () => {
  it('is reported instead of inventing an author for the move', async () => {
    const r = await repointRolesToLeaves(
      [{
        roleId: mx.entityId, entityId: mx.entityId, entityName: 'Huérfana', tenantId: 'none',
        role: 'banco', fromAccountId: 'x', fromCode: '1110', toAccountId: 'y', toCode: '1111',
      }],
      new Map()
    );
    expect(r).toEqual({ repointed: 0, failures: [expect.stringMatching(/ningún usuario activo/)] });
  });
});
