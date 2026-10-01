import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { crearActivo } from '../../src/services/assets/asset-service.js';
import { runMonthlyDepreciation } from '../../src/services/assets/depreciation.js';
import { planDeDepreciacion } from '../../src/services/assets/depreciation-plan.js';

/**
 * MNE-001-396 (#429, owner decision MNE-001-135). Under `tasa_lisr` the rate
 * applies to the original investment (LISR art. 31), with no salvage value
 * subtracted; `vida_util_nif` keeps subtracting it (NIF C-6); an asset whose
 * tax rows started on cost less salvage keeps that base.
 */

let A: Fixture;

/** The issue's example: 100000 with 10000 of salvage, at 25 %. */
async function registerExample(f: Fixture): Promise<string> {
  enterTenant(f.tenantId);
  const category = await query<{ id: string }>(
    `SELECT id FROM asset_categories WHERE entity_id = $1 AND name LIKE 'Herramientas%'`,
    [f.entityId]
  );
  const r = await crearActivo(
    f.entityId,
    {
      asset_name: 'Troquel sintético con desecho',
      category_id: category.rows[0].id,
      acquisition_date: '2026-01-01',
      acquisition_cost: '100000.0000',
      salvage_value: '10000.0000',
      tax_rate: '0.2500',
      contabilizacion: 'ya_contabilizado',
    },
    f.userId
  );
  expect(r.tax_rate).toBe('0.2500');
  return r.id;
}

async function postedRows(assetId: string): Promise<Array<{ d: string; meta: Record<string, unknown> }>> {
  const r = await query<{ d: string; meta: Record<string, unknown> }>(
    `SELECT depreciation_expense::text AS d, calculation_metadata AS meta
       FROM depreciation_schedules
      WHERE asset_id = $1 AND is_posted = true ORDER BY depreciation_date`,
    [assetId]
  );
  return r.rows;
}

async function entityOn(name: string, basis: 'tasa_lisr' | 'vida_util_nif'): Promise<Fixture> {
  const f = await crearEntidadHermana(A, name);
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  if (basis === 'tasa_lisr') {
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'base_depreciacion', basis, f.userId);
  }
  return f;
}

beforeAll(async () => {
  A = await crearInquilino('MNE-396 art. 31');
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe('the base the rate applies to (art. 31 LISR)', () => {
  it('under tasa_lisr it posts 2083.3333 a month and the schedule stops at 100000', async () => {
    const C = await entityOn('MNE-396 tasa', 'tasa_lisr');
    const id = await registerExample(C);

    const plan = await planDeDepreciacion(C.entityId, C.periodos[1]);
    expect(plan.renglones.find((r) => r.asset_id === id)?.depreciacion).toBe('2083.3333');

    const r = await runMonthlyDepreciation(C.entityId, C.periodos[1], C.userId);
    expect(r.errors).toEqual([]);
    const rows = await postedRows(id);
    expect(rows.map((x) => x.d)).toEqual(['2083.3333']);
    expect(rows[0].meta).toMatchObject({
      base_depreciable: '100000.0000',
      investment_base: 'original_investment',
      periodos_totales: 48,
    });
  });

  it('under vida_util_nif it keeps subtracting the salvage value', async () => {
    const B = await entityOn('MNE-396 libro', 'vida_util_nif');
    const id = await registerExample(B);
    const r = await runMonthlyDepreciation(B.entityId, B.periodos[1], B.userId);
    expect(r.errors).toEqual([]);
    const rows = await postedRows(id);
    expect(rows[0].meta).toMatchObject({ base_depreciable: '90000.0000', investment_base: 'cost_less_salvage' });
  });

  it('an asset with no stored rate posts the same amount under tasa_lisr as under vida_util_nif', async () => {
    const posted: string[] = [];
    for (const basis of ['tasa_lisr', 'vida_util_nif'] as const) {
      const E = await entityOn(`MNE-396 sin tasa ${basis}`, basis);
      const id = await registerExample(E);
      // An asset registered before 088 stores no rate: it runs on its life.
      await query(`UPDATE fixed_assets SET tax_rate = NULL, useful_life_years = 5, useful_life_months = 60 WHERE id = $1`, [id]);

      const plan = await planDeDepreciacion(E.entityId, E.periodos[1]);
      expect(plan.renglones.find((r) => r.asset_id === id)?.depreciacion).toBe('1500.0000');
      const r = await runMonthlyDepreciation(E.entityId, E.periodos[1], E.userId);
      expect(r.errors).toEqual([]);
      const rows = await postedRows(id);
      expect(rows[0].meta).toMatchObject({ base_depreciable: '90000.0000', investment_base: 'cost_less_salvage' });
      posted.push(rows[0].d);
    }
    expect(posted).toEqual(['1500.0000', '1500.0000']);
  });

  it('an asset whose tax rows started on cost less salvage keeps that base', async () => {
    const L = await entityOn('MNE-396 heredado', 'tasa_lisr');
    const id = await registerExample(L);
    expect((await runMonthlyDepreciation(L.entityId, L.periodos[1], L.userId)).processed).toBe(1);
    // A row posted before MNE-001-396 carries no `investment_base`: it was
    // computed on cost less salvage, 90000 × 25 % / 12.
    await query(
      `UPDATE depreciation_schedules
          SET depreciation_expense = 1875, calculation_metadata = calculation_metadata - 'investment_base'
        WHERE asset_id = $1 AND is_posted = true`,
      [id]
    );

    const plan = await planDeDepreciacion(L.entityId, L.periodos[2]);
    expect(plan.renglones.find((r) => r.asset_id === id)?.depreciacion).toBe('1875.0000');
    const r = await runMonthlyDepreciation(L.entityId, L.periodos[2], L.userId);
    expect(r.errors).toEqual([]);
    const rows = await postedRows(id);
    expect(rows.map((x) => x.d)).toEqual(['1875.0000', '1875.0000']);
    expect(rows[1].meta).toMatchObject({ base_depreciable: '90000.0000', investment_base: 'cost_less_salvage' });
  });
});
