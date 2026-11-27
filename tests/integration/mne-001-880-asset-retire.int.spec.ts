import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { getPeriodCloseStatus } from '../../src/services/accounting/period-close.js';
import { conductClose } from '../../src/services/accounting/closing-conductor.js';
import { crearActivo } from '../../src/services/assets/asset-service.js';
import { retireAsset, undoAssetRetirement } from '../../src/services/assets/asset-retire.js';
import { runMonthlyDepreciation } from '../../src/services/assets/depreciation.js';
import { planDeDepreciacion } from '../../src/services/assets/depreciation-plan.js';
import type { ClosablePeriod } from '../../src/ai/close-service.js';
import type { AppError } from '../../src/utils/errors.js';

/**
 * MNE-001-880 (#1069), part 2 · `asset retire` leaves an asset `inactive`, so
 * the run stops taking it, and `--undo` brings it back. No posted month moves
 * and nothing is posted by either.
 *
 * THE FIGURES, BY HAND. Class "Equipo de Transporte": a 48-month book life.
 * Panel defaults, both assets bought on 2026-01-08, so depreciation starts on
 * 2026-01-01:
 *
 *   the van and the truck   96,000.00 / 48 = 2,000.00 a month each
 *   the van after January   96,000.00 − 2,000.00 = 94,000.00
 *
 * The truck is retired before any month runs; the van after January.
 */

const REASON = 'Out of service: engine seized, kept for parts';
const mid = (month: string) => ({ now: new Date(`2026-${month}-15T18:00:00Z`) });

let f: Fixture;
let sister: Fixture;
let van: { id: string; asset_number: string };
let truck: { id: string; asset_number: string };

async function register(on: Fixture, name: string): Promise<{ id: string; asset_number: string }> {
  const transport = await query<{ id: string }>(
    `SELECT id FROM asset_categories WHERE entity_id = $1 AND name = 'Equipo de Transporte'`,
    [on.entityId]
  );
  return crearActivo(
    on.entityId,
    {
      asset_name: name,
      category_id: transport.rows[0].id,
      acquisition_date: '2026-01-08',
      acquisition_cost: '96000.00',
      contabilizacion: 'ya_contabilizado',
    },
    on.userId
  );
}

async function card(assetId: string) {
  const r = await query<Record<'status' | 'accumulated' | 'book_value', string>>(
    `SELECT status, accumulated_depreciation::text AS accumulated, current_book_value::text AS book_value
       FROM fixed_assets WHERE id = $1 AND entity_id = $2`,
    [assetId, f.entityId]
  );
  return r.rows[0];
}

/** The live rows of an asset, by month: what the ledger backs. */
async function rows(assetId: string) {
  const r = await query<{ period: string; number: string; expense: string }>(
    `SELECT fp.period_name AS period, je.entry_number AS number, ds.depreciation_expense::text AS expense
       FROM depreciation_schedules ds
       JOIN fiscal_periods fp ON fp.id = ds.fiscal_period_id AND fp.entity_id = $2
       JOIN journal_entries je ON je.id = ds.journal_entry_id AND je.entity_id = $2
      WHERE ds.asset_id = $1 AND je.reversed_by_entry_id IS NULL
      ORDER BY fp.start_date`,
    [assetId, f.entityId]
  );
  return r.rows;
}

async function auditOf(assetId: string) {
  const r = await query<{ action: string; old_values: unknown; new_values: unknown; reason: string }>(
    `SELECT action, old_values, new_values, reason FROM audit_log
      WHERE entity_type = 'fixed_assets' AND entity_id = $1 AND legal_entity_id = $2 AND action <> 'create'
      ORDER BY timestamp`,
    [assetId, f.entityId]
  );
  return r.rows;
}

const box = async (on: Fixture, month: number) =>
  (await getPeriodCloseStatus(on.periodos[month], on.entityId)).checklist.find((i) => i.codigo === 'depreciation-posted')!;
const keyOf = async (act: Promise<unknown>) => ((await act.catch((e: unknown) => e)) as AppError).messageKey;

beforeAll(async () => {
  f = await crearInquilino('MNE-001-880 asset retire');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  enterTenant(f.tenantId);
  sister = await crearEntidadHermana(f, 'MNE-001-880 sister');
  van = await register(f, 'Synthetic van');
  truck = await register(f, 'Synthetic truck');
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe('a retired asset', () => {
  it('is left inactive with its audit row, and the close of January depreciates the van alone', async () => {
    const done = await retireAsset(f.entityId, truck.asset_number, '2026-01-15', REASON, f.userId, mid('02'));
    expect(done).toMatchObject({ asset_number: truck.asset_number, from: 'active', to: 'inactive', effective: '2026-01-15', months: [] });
    expect(await auditOf(truck.id)).toEqual([
      { action: 'close', old_values: { status: 'active' }, new_values: { status: 'inactive', effective_date: '2026-01-15' }, reason: REASON },
    ]);

    // The plan and the run do not see it: it owes nothing.
    const plan = await planDeDepreciacion(f.entityId, f.periodos[1]);
    expect([...plan.renglones, ...plan.omitidos].map((r) => r.asset_number)).toEqual([van.asset_number]);

    const period = await query<ClosablePeriod>(
      `SELECT fp.id, fp.period_name, fp.period_number, fp.start_date::text, fp.end_date::text, fp.status,
              fy.year_number, false AS overdue
         FROM fiscal_periods fp JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
        WHERE fp.id = $1 AND fp.entity_id = $2`,
      [f.periodos[1], f.entityId]
    );
    const close = await conductClose(
      { entityId: f.entityId, entityName: 'MNE-001-880', tenantId: f.tenantId, currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'XAXX010101000' },
      period.rows[0],
      { userId: f.userId }
    );
    expect(close.steps.find((s) => s.step === 'depreciate-assets')).toMatchObject({
      status: 'done', processed: 1, detail: '1 asset(s) depreciated',
    });
    expect(close.status, JSON.stringify(close.steps)).toBe('completed');
    expect((await rows(van.id)).map((r) => r.expense)).toEqual(['2000.0000']);
    expect(await rows(truck.id)).toEqual([]);
    expect(await card(truck.id)).toEqual({ status: 'inactive', accumulated: '0.0000', book_value: '96000.0000' });

    // The box is complete and names the asset held out of depreciation.
    const st = await getPeriodCloseStatus(f.periodos[1], f.entityId);
    expect(st.checklist.find((i) => i.codigo === 'depreciation-posted')).toMatchObject({
      is_complete: true,
      details: `1 asset(s) retired (inactive), not depreciated: ${truck.asset_number}`,
    });
    expect([...st.warnings, ...st.blocking_issues].join(' ')).not.toMatch(/asset|depreciation/i);
  }, 240_000);

  it("another entity's asset answers as a missing one", async () => {
    const foreign = (await retireAsset(sister.entityId, truck.id, '2026-01-20', REASON, sister.userId, mid('02')).catch(
      (e: unknown) => e
    )) as AppError;
    expect(foreign.code).toBe('RESOURCE_NOT_FOUND');
    expect(await card(truck.id)).toMatchObject({ status: 'inactive' });
  });

  it('refuses a date after today, a date before the asset was in service, and an asset that is not in use', async () => {
    expect(await keyOf(retireAsset(f.entityId, van.id, '2026-02-16', REASON, f.userId, mid('02')))).toEqual({
      key: 'error.VALIDATION_ERROR.asset.retire_effective_future',
      params: { effective: '2026-02-16', today: '2026-02-15' },
    });
    expect(await keyOf(retireAsset(f.entityId, van.id, '2025-12-31', REASON, f.userId, mid('02')))).toEqual({
      key: 'error.VALIDATION_ERROR.asset.retire_effective_before_service',
      params: { asset: van.asset_number, effective: '2025-12-31', start: '2026-01-01' },
    });
    expect(await keyOf(retireAsset(f.entityId, truck.id, '2026-02-01', REASON, f.userId, mid('02')))).toEqual({
      key: 'error.VALIDATION_ERROR.asset.retire_not_active',
      params: { asset: truck.asset_number, status: 'inactive' },
    });
    expect(await card(van.id)).toMatchObject({ status: 'active' });
  });

  it('retired in a month already posted: the month stands and is named, and February posts nothing for it', async () => {
    const [january] = await rows(van.id);
    const done = await retireAsset(f.entityId, van.id, '2026-01-20', REASON, f.userId, mid('02'));
    expect(done.months).toEqual([`Periodo 1/2026 (${january.number})`]);
    expect(await rows(van.id)).toEqual([january]);
    expect(await card(van.id)).toEqual({ status: 'inactive', accumulated: '2000.0000', book_value: '94000.0000' });
    expect(await runMonthlyDepreciation(f.entityId, f.periodos[2], f.userId)).toEqual({ processed: 0, errors: [], skipped: [] });
    expect(await box(f, 2)).toMatchObject({ is_complete: true });
  }, 120_000);
});

describe('--undo', () => {
  it('brings back only an asset this command retired', async () => {
    const neverRetired = await register(f, 'Synthetic trailer');
    const undoKey = 'error.VALIDATION_ERROR.asset.retire_undo_not_retired';
    expect(await keyOf(undoAssetRetirement(f.entityId, neverRetired.id, REASON, f.userId))).toEqual({
      key: undoKey, params: { asset: neverRetired.asset_number, status: 'active' },
    });
    // Inactive for another reason: no retirement of this command in its trail.
    await query(`UPDATE fixed_assets SET status = 'inactive' WHERE id = $1 AND entity_id = $2`, [neverRetired.id, f.entityId]);
    expect(await keyOf(undoAssetRetirement(f.entityId, neverRetired.id, REASON, f.userId))).toEqual({
      key: undoKey, params: { asset: neverRetired.asset_number, status: 'inactive' },
    });
    expect(await card(neverRetired.id)).toMatchObject({ status: 'inactive' });
  }, 60_000);

  it('posts nothing for the months skipped and names them; the next run takes the asset again', async () => {
    const back = await undoAssetRetirement(f.entityId, van.asset_number, 'Engine rebuilt, back on the road', f.userId, mid('04'));
    expect(back).toMatchObject({ from: 'inactive', to: 'active', effective: '2026-01-20' });
    // January stands; February to April (today is 15 April) have no row.
    expect(back.months).toEqual(['Periodo 2/2026', 'Periodo 3/2026', 'Periodo 4/2026']);
    expect((await rows(van.id)).map((r) => r.period)).toEqual(['Periodo 1/2026']);
    expect((await auditOf(van.id)).slice(-1)).toEqual([
      {
        action: 'reopen',
        old_values: { status: 'inactive', effective_date: '2026-01-20' },
        new_values: { status: 'active' },
        reason: 'Engine rebuilt, back on the road',
      },
    ]);

    expect(await runMonthlyDepreciation(f.entityId, f.periodos[3], f.userId)).toMatchObject({ processed: 1, errors: [] });
    expect((await rows(van.id)).map((r) => [r.period, r.expense])).toEqual([
      ['Periodo 1/2026', '2000.0000'],
      ['Periodo 3/2026', '2000.0000'],
    ]);
    // Undone once: the last change of state is no longer a retirement.
    expect((await keyOf(undoAssetRetirement(f.entityId, van.id, REASON, f.userId)))?.key).toBe(
      'error.VALIDATION_ERROR.asset.retire_undo_not_retired'
    );
  }, 120_000);
});

/**
 * What `depreciation-posted` answers, case by case, on an entity of its own.
 * An EMPTY register and a register whose assets are all out of use are two
 * facts: the first could not be checked and stays open; the second was
 * checked and no asset owes the month.
 */
describe('the close box, case by case', () => {
  let crane: { id: string; asset_number: string };
  let forklift: { id: string; asset_number: string };
  const januaryOf = async () => {
    const st = await getPeriodCloseStatus(sister.periodos[1], sister.entityId);
    return { box: st.checklist.find((i) => i.codigo === 'depreciation-posted')!, st };
  };

  it('(a) no asset registered: open, and it says it could not check', async () => {
    const { box: empty, st } = await januaryOf();
    expect(empty).toMatchObject({
      is_complete: false,
      severity: 'warning',
      details: '0 activos fijos registrados: no se pudo comprobar',
    });
    expect(st.blocking_issues.join(' ')).not.toMatch(/depreciation/i);
  });

  it('(d) one asset in use with the month not posted and one retired: open, both named', async () => {
    crane = await register(sister, 'Synthetic crane');
    forklift = await register(sister, 'Synthetic forklift');
    await retireAsset(sister.entityId, forklift.id, '2026-01-20', REASON, sister.userId, mid('02'));
    const { box: owing, st } = await januaryOf();
    expect(owing).toMatchObject({
      is_complete: false,
      severity: 'warning',
      details: `1 assets without depreciation; 1 asset(s) retired (inactive), not depreciated: ${forklift.asset_number}`,
    });
    expect(st.warnings).toContain('1 assets without depreciation posted');
  }, 60_000);

  it('(b) every asset retired: complete, named, and the run posts nothing', async () => {
    await retireAsset(sister.entityId, crane.id, '2026-01-20', REASON, sister.userId, mid('02'));
    expect(await runMonthlyDepreciation(sister.entityId, sister.periodos[1], sister.userId)).toEqual({
      processed: 0, errors: [], skipped: [],
    });
    const { box: retired, st } = await januaryOf();
    expect(retired).toMatchObject({
      is_complete: true,
      details:
        '0 fixed assets in use: nothing to depreciate; 2 asset(s) retired (inactive), not depreciated: ' +
        `${crane.asset_number}, ${forklift.asset_number}`,
    });
    expect([...st.warnings, ...st.blocking_issues].join(' ')).not.toMatch(/asset|depreciation/i);
  }, 60_000);

  it('(c) every asset fully depreciated: complete, named — nothing is left to depreciate', async () => {
    // No command writes this state yet: it is written as the engine will.
    await query(`UPDATE fixed_assets SET status = 'fully_depreciated' WHERE entity_id = $1`, [sister.entityId]);
    const { box: spent } = await januaryOf();
    expect(spent).toMatchObject({
      is_complete: true,
      details:
        '0 fixed assets in use: nothing to depreciate; 2 asset(s) fully depreciated: ' +
        `${crane.asset_number}, ${forklift.asset_number}`,
    });
  });
});
