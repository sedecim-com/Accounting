import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import {
  actoresPorInquilino,
  addMissingRoles,
  censusMissingRole,
} from '../../src/services/accounting/account-roles-backfill.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';

/**
 * MNE-001-505 (#699, part 2/2) · THE ROLE WHERE A PPD SALE'S IEPS WAITS.
 *
 * A PPD sale's IEPS is caused on collection (LIEPS art. 10), so it waits in
 * `ieps_trasladado_no_cobrado`, account 2181 (Anexo 24 grouping code 209.02,
 * beside 209.01 for VAT), until each collection moves its share to 2180. An
 * entity on Mexican books is born with both; any other with neither. An
 * entity seeded before gets them from `npm run backfill:account-roles`: the
 * census only lists, `--aplicar` writes, audited, and a role someone already
 * mapped is never moved.
 */

const ROLE = 'ieps_trasladado_no_cobrado';
const ROOT = path.join(__dirname, '..', '..');

let mx: Fixture;
let us: Fixture;

async function ieps2181(f: Fixture) {
  const account = (await query<{ id: string; account_type: string; normal_balance: string; is_header: boolean; parent: string | null }>(
    `SELECT a.id, a.account_type, a.normal_balance, a.is_header, p.code AS parent
       FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
      WHERE a.entity_id = $1 AND a.code = '2181'`,
    [f.entityId]
  )).rows[0];
  const role = (await query<{ code: string }>(
    `SELECT a.code FROM account_roles ar JOIN accounts a ON a.id = ar.account_id
      WHERE ar.entity_id = $1 AND ar.role = $2 AND ar.qualifier IS NULL`,
    [f.entityId, ROLE]
  )).rows[0];
  return { account, role: role?.code };
}

/** Puts an entity back where one seeded before MNE-001-505 is: no role and no 2181. */
async function seededBefore(f: Fixture): Promise<void> {
  await query(`DELETE FROM account_roles WHERE entity_id = $1 AND role = $2`, [f.entityId, ROLE]);
  await query(`DELETE FROM accounts WHERE entity_id = $1 AND code = '2181'`, [f.entityId]);
}

beforeAll(async () => {
  mx = await crearInquilino('MNE-001-505 IEPS role MX');
  us = await crearInquilino('MNE-001-505 IEPS role US', { pais: 'US' });
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('the seed', () => {
  it('gives an entity on Mexican books 2181, a credit liability under 2100, with the role on it', async () => {
    const { account, role } = await ieps2181(mx);
    expect(account).toMatchObject({ account_type: 'liability', normal_balance: 'credit', is_header: false, parent: '2100' });
    expect(role).toBe('2181');
  });

  it('gives any other entity neither', async () => {
    expect(await ieps2181(us)).toEqual({ account: undefined, role: undefined });
    expect(await censusMissingRole(ROLE, us.tenantId)).toEqual({ missing: [], unmappable: [] });
  });
});

describe('the backfill of an entity seeded before the role', () => {
  beforeAll(() => seededBefore(mx));

  it('without --aplicar only lists it, the account it will create included', async () => {
    const out = execFileSync('npx', ['tsx', 'scripts/rellenar-roles-de-cuenta.ts', '--tenant', mx.tenantId], {
      cwd: ROOT, encoding: 'utf8', env: process.env,
    });
    expect(out).toMatch(/Entidades sembradas sin el rol «ieps_trasladado_no_cobrado»/);
    expect(out).toMatch(/ieps_trasladado_no_cobrado → 2181 \(se crea 2181 IEPS Trasladado No Cobrado\)/);
    expect(await ieps2181(mx)).toEqual({ account: undefined, role: undefined });
  }, 120_000);

  it('with --aplicar creates 2181 under 2100 and maps the role, each with an audit row', async () => {
    const out = execFileSync('npx', ['tsx', 'scripts/rellenar-roles-de-cuenta.ts', '--tenant', mx.tenantId, '--aplicar'], {
      cwd: ROOT, encoding: 'utf8', env: process.env,
    });
    expect(out).toMatch(/1 entidades con el rol «ieps_trasladado_no_cobrado» añadido/);
    const { account, role } = await ieps2181(mx);
    expect(account).toMatchObject({ account_type: 'liability', normal_balance: 'credit', is_header: false, parent: '2100' });
    expect(role).toBe('2181');

    const audit = await query<{ entity_type: string; action: string; reason: string }>(
      `SELECT entity_type, action, reason FROM audit_log
        WHERE tenant_id = $1 AND legal_entity_id = $2 AND reason LIKE 'MNE-001-505 (#699)%' ORDER BY entity_type`,
      [mx.tenantId, mx.entityId]
    );
    expect(audit.rows.map((r) => [r.entity_type, r.action])).toEqual([['account', 'create'], ['account_role', 'create']]);
  }, 120_000);

  it('is idempotent: the census is empty afterwards and a second run writes nothing', async () => {
    expect(await censusMissingRole(ROLE, mx.tenantId)).toEqual({ missing: [], unmappable: [] });
    execFileSync('npx', ['tsx', 'scripts/rellenar-roles-de-cuenta.ts', '--tenant', mx.tenantId, '--aplicar'], {
      cwd: ROOT, encoding: 'utf8', env: process.env,
    });
    const counts = await query<{ accounts: number; roles: number }>(
      `SELECT (SELECT count(*) FROM accounts WHERE entity_id = $1 AND code = '2181')::int AS accounts,
              (SELECT count(*) FROM account_roles WHERE entity_id = $1 AND role = $2)::int AS roles`,
      [mx.entityId, ROLE]
    );
    expect(counts.rows[0]).toEqual({ accounts: 1, roles: 1 });
  }, 120_000);
});

describe('what the backfill leaves alone', () => {
  it('never moves a role mapped by hand', async () => {
    const f = await crearInquilino('MNE-001-505 mapped by hand');
    await query(`UPDATE account_roles SET account_id = $3 WHERE entity_id = $1 AND role = $2`, [f.entityId, ROLE, f.cuentas['2180']]);
    expect(await censusMissingRole(ROLE, f.tenantId)).toEqual({ missing: [], unmappable: [] });
    expect((await ieps2181(f)).role).toBe('2180');
  });

  it('uses a 2181 the chart already has when it is a credit liability, and reports one of another kind', async () => {
    const fit = await crearInquilino('MNE-001-505 own 2181');
    await query(`DELETE FROM account_roles WHERE entity_id = $1 AND role = $2`, [fit.entityId, ROLE]);
    const census = await censusMissingRole(ROLE, fit.tenantId);
    expect(census.missing.map((m) => [m.code, m.accountId, m.create])).toEqual([['2181', fit.cuentas['2181'], undefined]]);
    expect(await addMissingRoles(census.missing, await actoresPorInquilino([fit.tenantId]))).toEqual({ added: 1, failures: [] });

    const other = await crearInquilino('MNE-001-505 2181 of another kind');
    await query(`DELETE FROM account_roles WHERE entity_id = $1 AND role = $2`, [other.entityId, ROLE]);
    await query(`UPDATE accounts SET account_type = 'asset', normal_balance = 'debit' WHERE entity_id = $1 AND code = '2181'`, [other.entityId]);
    expect(await censusMissingRole(ROLE, other.tenantId)).toEqual({
      missing: [],
      unmappable: [{ entityName: expect.any(String), role: ROLE, code: '2181', why: '2181 is not a liability account with a credit balance' }],
    });
  });
});
