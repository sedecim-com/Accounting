import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import {
  actoresPorInquilino,
  addMissingRoles,
  censusMissingRole,
} from '../../src/services/accounting/account-roles-backfill.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';

/**
 * BAN-1 (#324), preparatory part: the `efectivo` role anchors cash on 1110,
 * and entities seeded before the role existed get it from the backfill, once.
 *
 * `seedAccountRoles` never runs again on a seeded entity, and the old census
 * of the backfill only looks at entities with NO roles, so without this pass
 * those entities would never get the role. The suite removes it by hand to
 * put them back in that state.
 */

let mx: Fixture;
let us: Fixture;

async function cashCode(entityId: string): Promise<string | undefined> {
  const r = await query<{ code: string }>(
    `SELECT a.code FROM account_roles ar JOIN accounts a ON a.id = ar.account_id
      WHERE ar.entity_id = $1 AND ar.role = 'efectivo' AND ar.qualifier IS NULL`,
    [entityId]
  );
  return r.rows[0]?.code;
}

async function dropCashRole(f: Fixture): Promise<void> {
  await query(`DELETE FROM account_roles WHERE entity_id = $1 AND role = 'efectivo'`, [f.entityId]);
}

beforeAll(async () => {
  mx = await crearInquilino('BAN-1 efectivo MX');
  us = await crearInquilino('BAN-1 efectivo US', { pais: 'US' });
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('a freshly seeded entity', () => {
  it('maps efectivo to 1110 in both charts', async () => {
    expect(await cashCode(mx.entityId)).toBe('1110');
    expect(await cashCode(us.entityId)).toBe('1110');
  });
});

describe('the backfill of an entity seeded before efectivo existed', () => {
  beforeAll(async () => {
    await dropCashRole(mx);
    await dropCashRole(us);
  });

  it('the census finds it and writes nothing', async () => {
    const census = await censusMissingRole('efectivo', mx.tenantId);
    expect(census.missing.map((m) => [m.entityId, m.code])).toEqual([[mx.entityId, '1110']]);
    expect(census.unmappable).toEqual([]);
    expect(await cashCode(mx.entityId)).toBeUndefined();
  });

  it('adds the role to each entity, with an audit row', async () => {
    for (const f of [mx, us]) {
      const census = await censusMissingRole('efectivo', f.tenantId);
      const r = await addMissingRoles(census.missing, await actoresPorInquilino([f.tenantId]));
      expect(r).toEqual({ added: 1, failures: [] });
      expect(await cashCode(f.entityId)).toBe('1110');

      const audit = await query<{ action: string; new_values: { role: string; code: string } }>(
        `SELECT a.action, a.new_values FROM audit_log a
          JOIN account_roles ar ON ar.id = a.entity_id
         WHERE a.tenant_id = $1 AND a.entity_type = 'account_role' AND ar.role = 'efectivo'`,
        [f.tenantId]
      );
      expect(audit.rows.map((x) => [x.action, x.new_values.role, x.new_values.code])).toEqual([
        ['create', 'efectivo', '1110'],
      ]);
    }
  });

  it('is idempotent: a second census is empty and a replay writes nothing', async () => {
    expect((await censusMissingRole('efectivo', mx.tenantId)).missing).toEqual([]);

    const replay = {
      entityId: mx.entityId, entityName: 'BAN-1 efectivo MX', tenantId: mx.tenantId,
      role: 'efectivo' as const, accountId: mx.cuentas['1110'], code: '1110',
    };
    const r = await addMissingRoles([replay], await actoresPorInquilino([mx.tenantId]));
    expect(r.added).toBe(0);
    expect(r.failures[0]).toMatch(/ya estaba mapeado/);
    const rows = await query(
      `SELECT 1 FROM account_roles WHERE entity_id = $1 AND role = 'efectivo'`, [mx.entityId]
    );
    expect(rows.rowCount).toBe(1);
  });
});

describe('an entity whose chart lacks 1110', () => {
  it('is reported, not mapped to something close enough', async () => {
    const f = await crearInquilino('BAN-1 efectivo sin 1110');
    await dropCashRole(f);
    await query(`UPDATE accounts SET is_active = false WHERE entity_id = $1 AND code = '1110'`, [f.entityId]);

    const census = await censusMissingRole('efectivo', f.tenantId);
    expect(census.missing).toEqual([]);
    expect(census.unmappable).toEqual([{ entityName: expect.any(String), role: 'efectivo', code: '1110' }]);
  });
});

describe('a tenant with no active user', () => {
  it('is reported instead of inventing an author', async () => {
    const r = await addMissingRoles(
      [{
        entityId: mx.entityId, entityName: 'Huérfana', tenantId: 'none',
        role: 'efectivo', accountId: 'x', code: '1110',
      }],
      new Map()
    );
    expect(r).toEqual({ added: 0, failures: [expect.stringMatching(/ningún usuario activo/)] });
  });
});
