import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { crearActivo, sembrarCategoriasDeActivo } from '../../src/services/assets/asset-service.js';
import { runMonthlyDepreciation } from '../../src/services/assets/depreciation.js';
import { planDeDepreciacion } from '../../src/services/assets/depreciation-plan.js';

/**
 * ACT-1 (#322, MNE-001-020). Before it no entity had a single asset class, so
 * `asset create` could not register anything and `tasa_lisr` posted the book
 * number. The fixture creates the entity through `ensureEntityAccounting`,
 * which is the seam `entity create` uses.
 */

let A: Fixture;

interface AssetClass {
  name: string;
  max_tax_rate: string;
  legal_basis: string;
  default_useful_life_months: number;
  asset: string | null;
  accumulated: string | null;
  expense: string | null;
}

async function classesOf(entityId: string): Promise<AssetClass[]> {
  const r = await query<AssetClass>(
    `SELECT ac.name, ac.max_tax_rate::text AS max_tax_rate, ac.legal_basis,
            ac.default_useful_life_months,
            a1.code AS asset, a2.code AS accumulated, a3.code AS expense
       FROM asset_categories ac
       LEFT JOIN accounts a1 ON a1.id = ac.default_asset_account_id AND a1.entity_id = ac.entity_id
       LEFT JOIN accounts a2 ON a2.id = ac.default_depreciation_account_id AND a2.entity_id = ac.entity_id
       LEFT JOIN accounts a3 ON a3.id = ac.default_expense_account_id AND a3.entity_id = ac.entity_id
      WHERE ac.entity_id = $1
      ORDER BY ac.name`,
    [entityId]
  );
  return r.rows;
}

async function registerDie(f: Fixture): Promise<string> {
  enterTenant(f.tenantId);
  const category = await query<{ id: string }>(
    `SELECT id FROM asset_categories WHERE entity_id = $1 AND name LIKE 'Herramientas%'`,
    [f.entityId]
  );
  const r = await crearActivo(
    f.entityId,
    {
      asset_name: 'Troquel sintético',
      category_id: category.rows[0].id,
      acquisition_date: '2026-01-01',
      acquisition_cost: '120000.0000',
      contabilizacion: 'ya_contabilizado',
    },
    f.userId
  );
  expect(r.tax_rate).toBe('0.3500');
  expect(r.useful_life_months).toBe(35);
  return r.id;
}

async function postedRows(assetId: string): Promise<string[]> {
  const r = await query<{ d: string }>(
    `SELECT depreciation_expense::text AS d FROM depreciation_schedules
      WHERE asset_id = $1 AND is_posted = true ORDER BY depreciation_date`,
    [assetId]
  );
  return r.rows.map((x) => x.d);
}

beforeAll(async () => {
  A = await crearInquilino('ACT-1 classesOf');
  await seedPolicies({ tenantId: A.tenantId, entityId: A.entityId });
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe('a Mexican entity is born with its asset classes', () => {
  it('six classes, each with the art. 34/35 rate from legal_parameters, its basis and three accounts', async () => {
    const c = await classesOf(A.entityId);
    expect(c).toHaveLength(6);
    const laws = await query<{ value: string }>(
      `SELECT value FROM legal_parameters
        WHERE jurisdiction = 'MX' AND key LIKE 'income_tax.depreciation_max_rate.%' ORDER BY key`
    );
    expect(c.map((x) => x.max_tax_rate).sort()).toEqual(laws.rows.map((x) => x.value).sort());
    for (const x of c) {
      expect(x.legal_basis, x.name).toMatch(/^LISR art\. 3[45]/);
      expect(x.default_useful_life_months, x.name).toBeGreaterThan(0);
      expect([x.asset, x.accumulated, x.expense], x.name).not.toContain(null);
      expect([x.accumulated, x.expense]).toEqual(['1290', '6140']);
    }
    expect(c.find((x) => x.name === 'Equipo de Cómputo')).toMatchObject({
      max_tax_rate: '0.3000',
      default_useful_life_months: 40,
      asset: '1220',
    });
  });

  it('a foreign entity gets none: those rates are not its law', async () => {
    const U = await crearInquilino('ACT-1 delaware', { pais: 'US' });
    expect(await classesOf(U.entityId)).toEqual([]);
  });
});

describe('`asset category seed` on an entity born before the seeding', () => {
  it('seeds the six once, and a second run creates nothing', async () => {
    const B = await crearEntidadHermana(A, 'ACT-1 anterior');
    await query('DELETE FROM asset_categories WHERE entity_id = $1', [B.entityId]);
    const first = await sembrarCategoriasDeActivo(B.entityId);
    const second = await sembrarCategoriasDeActivo(B.entityId);
    expect(first.creadas).toHaveLength(6);
    expect(second.creadas).toEqual([]);
    expect(second.yaExistian).toHaveLength(6);
    expect(await classesOf(B.entityId)).toHaveLength(6);
  });
});

describe('`tasa_lisr` posts at the rate, and the basis of a posted asset is locked', () => {
  it('under tasa_lisr a 35 % die posts 120000 × 35 % / 12, not 120000 / 35', async () => {
    const C = await crearEntidadHermana(A, 'ACT-1 tasa');
    await seedPolicies({ tenantId: C.tenantId, entityId: C.entityId });
    await resolvePolicy({ tenantId: C.tenantId, entityId: C.entityId }, 'base_depreciacion', 'tasa_lisr', C.userId);
    const id = await registerDie(C);
    const r = await runMonthlyDepreciation(C.entityId, C.periodos[1], C.userId);
    expect(r.errors).toEqual([]);
    expect(await postedRows(id)).toEqual(['3500.0000']);
  });

  it('an asset that posted on the book life does not switch when the panel says tasa_lisr', async () => {
    const D = await crearEntidadHermana(A, 'ACT-1 candado');
    await seedPolicies({ tenantId: D.tenantId, entityId: D.entityId });
    const id = await registerDie(D);
    expect((await runMonthlyDepreciation(D.entityId, D.periodos[1], D.userId)).processed).toBe(1);
    expect(await postedRows(id)).toEqual(['3428.5714']);

    await resolvePolicy({ tenantId: D.tenantId, entityId: D.entityId }, 'base_depreciacion', 'tasa_lisr', D.userId);
    const plan = await planDeDepreciacion(D.entityId, D.periodos[2]);
    expect(plan.omitidos.find((o) => o.asset_id === id)?.motivo).toBe('base_bloqueada');
    const r = await runMonthlyDepreciation(D.entityId, D.periodos[2], D.userId);
    expect(r.errors.join(' ')).toMatch(/cannot change/);
    expect(await postedRows(id)).toEqual(['3428.5714']);
  });
});
