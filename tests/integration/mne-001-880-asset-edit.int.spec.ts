import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase, enterTenant, withTransaction } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { crearActivo } from '../../src/services/assets/asset-service.js';
import { editAsset, type AssetChanges } from '../../src/services/assets/asset-edit.js';
import { runMonthlyDepreciation } from '../../src/services/assets/depreciation.js';
import { DepreciationMethod } from '../../src/types/index.js';
import type { AppError } from '../../src/utils/errors.js';

/**
 * MNE-001-880 (#1069), part 1 · `asset edit` corrects an asset that has no
 * live depreciation row; with one it refuses, and nothing already posted
 * moves.
 *
 * THE FIGURES, BY HAND. Class "Equipo de Transporte": a 48-month book life.
 * Panel defaults (`vida_util_nif`, `mes_completo`), bought on 2026-01-08, so
 * depreciation starts on 2026-01-01 and every month is whole.
 *
 *   the pickup, cost typed wrong   4,890,000.00 / 48 = 101,875.00 a month
 *   the pickup, as invoiced          489,000.00 / 48 =  10,187.50 a month
 *   after one right month            489,000.00 − 10,187.50 = 478,812.50
 *   the van and the truck             96,000.00 / 48 =   2,000.00 a month
 */

const REASON = 'Cost typed with one zero too many; the invoice says 489,000.00';
const HAS_ROWS = 'error.VALIDATION_ERROR.asset.edit_has_posted_months';

let f: Fixture;
let pickup: { id: string; asset_number: string };

async function register(name: string, cost: string): Promise<{ id: string; asset_number: string }> {
  const transport = await query<{ id: string }>(
    `SELECT id FROM asset_categories WHERE entity_id = $1 AND name = 'Equipo de Transporte'`,
    [f.entityId]
  );
  return crearActivo(
    f.entityId,
    {
      asset_name: name,
      category_id: transport.rows[0].id,
      acquisition_date: '2026-01-08',
      acquisition_cost: cost,
      contabilizacion: 'ya_contabilizado',
    },
    f.userId
  );
}

const edit = (asset: string, changes: AssetChanges, entityId = f.entityId) =>
  editAsset(entityId, asset, changes, REASON, f.userId);
const refusal = (asset: string, changes: AssetChanges, entityId = f.entityId) =>
  edit(asset, changes, entityId).catch((e: unknown) => e) as Promise<AppError>;

async function card(assetId: string) {
  const r = await query<Record<'cost' | 'accumulated' | 'book_value' | 'acquired' | 'start' | 'method' | 'status', string>>(
    `SELECT acquisition_cost::text AS cost, accumulated_depreciation::text AS accumulated,
            current_book_value::text AS book_value, acquisition_date::text AS acquired,
            depreciation_start_date::text AS start, depreciation_method AS method, status
       FROM fixed_assets WHERE id = $1 AND entity_id = $2`,
    [assetId, f.entityId]
  );
  return r.rows[0];
}

/** The LIVE rows of January: what the ledger still backs. */
async function january(assetId: string) {
  const r = await query<{ entry: string; number: string; expense: string }>(
    `SELECT je.id AS entry, je.entry_number AS number, ds.depreciation_expense::text AS expense
       FROM depreciation_schedules ds
       JOIN journal_entries je ON je.id = ds.journal_entry_id AND je.entity_id = $2
      WHERE ds.asset_id = $1 AND ds.fiscal_period_id = $3 AND je.reversed_by_entry_id IS NULL`,
    [assetId, f.entityId, f.periodos[1]]
  );
  return r.rows;
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-880 asset edit');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  enterTenant(f.tenantId);
  pickup = await register('Synthetic pickup', '4890000.00');
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe('a cost typed wrong, already posted', () => {
  it('posts 101,875.00 in January, and the edit is refused by key while that row is live', async () => {
    expect(await runMonthlyDepreciation(f.entityId, f.periodos[1], f.userId)).toMatchObject({ processed: 1, errors: [] });
    const [row] = await january(pickup.id);
    expect(row.expense).toBe('101875.0000');

    const err = await refusal(pickup.asset_number, { acquisition_cost: '489000.00' });
    expect(err.messageKey).toEqual({
      key: HAS_ROWS,
      params: { asset: pickup.asset_number, months: 1, entries: row.number, more: 0 },
    });
    expect(await card(pickup.id)).toMatchObject({ cost: '4890000.0000', accumulated: '101875.0000' });
  }, 120_000);

  it('once the month is reversed the edit goes through, keeps both values, and January posts 10,187.50', async () => {
    const [wrong] = await january(pickup.id);
    await reverseJournalEntry(wrong.entry, f.userId, { reason: 'Depreciation computed on a mistyped cost' });

    const done = await edit(pickup.asset_number, { acquisition_cost: '489000.00' });
    expect(done.changes).toEqual([{ field: 'acquisition_cost', before: '4890000.0000', after: '489000.0000' }]);
    expect(await card(pickup.id)).toMatchObject({ cost: '489000.0000', accumulated: '0.0000', book_value: '489000.0000' });

    const audit = await query<{ old_values: unknown; new_values: unknown; reason: string; user_id: string }>(
      `SELECT old_values, new_values, reason, user_id FROM audit_log
        WHERE entity_type = 'fixed_assets' AND entity_id = $1 AND legal_entity_id = $2 AND action = 'update'`,
      [pickup.id, f.entityId]
    );
    expect(audit.rows).toEqual([
      {
        old_values: { acquisition_cost: '4890000.0000' },
        new_values: { acquisition_cost: '489000.0000' },
        reason: REASON,
        user_id: f.userId,
      },
    ]);

    expect(await runMonthlyDepreciation(f.entityId, f.periodos[1], f.userId)).toMatchObject({ processed: 1, errors: [] });
    expect((await january(pickup.id)).map((r) => r.expense)).toEqual(['10187.5000']);
    expect(await card(pickup.id)).toMatchObject({ accumulated: '10187.5000', book_value: '478812.5000' });
  }, 120_000);
});

describe('the rules of registration hold on an edit', () => {
  let van: { id: string; asset_number: string };
  beforeAll(async () => {
    van = await register('Synthetic van', '96000.00');
  }, 60_000);

  it('refuses a change TO units of production with the key of registration, and changes nothing', async () => {
    const err = await refusal(van.id, { tax_depreciation_method: DepreciationMethod.UNITS_OF_PRODUCTION });
    expect(err.messageKey).toEqual({
      key: 'error.VALIDATION_ERROR.asset.units_of_production_unsupported',
      params: { book: 'tax' },
    });
    expect(await card(van.id)).toMatchObject({ method: 'straight_line' });
  });

  it('allows the change FROM units of production: the asset the run skipped posts 2,000.00', async () => {
    // An asset registered before registration refused the method (MNE-001-881).
    await query(
      `UPDATE fixed_assets SET depreciation_method = 'units_of_production', book_depreciation_method = 'units_of_production'
        WHERE id = $1 AND entity_id = $2`,
      [van.id, f.entityId]
    );
    const skipped = await runMonthlyDepreciation(f.entityId, f.periodos[1], f.userId);
    expect(skipped).toMatchObject({ processed: 0, skipped: [{ asset_number: van.asset_number }] });

    const done = await edit(van.asset_number, { book_depreciation_method: DepreciationMethod.STRAIGHT_LINE });
    expect(done.changes.map((c) => c.field)).toEqual(['depreciation_method', 'book_depreciation_method']);
    expect(await runMonthlyDepreciation(f.entityId, f.periodos[1], f.userId)).toMatchObject({ processed: 1, skipped: [] });
    expect((await january(van.id)).map((r) => r.expense)).toEqual(['2000.0000']);
  }, 120_000);

  it('refuses what registration refuses, on the merged values, and an edit that changes nothing', async () => {
    const truck = await register('Synthetic truck', '96000.00');
    const keyOf = async (changes: AssetChanges) => (await refusal(truck.id, changes)).messageKey?.key;
    expect(await keyOf({ salvage_value: '96000.00' })).toBe('error.VALIDATION_ERROR.asset.salvage_reaches_cost');
    expect(await keyOf({ useful_life_years: 5, useful_life_months: 48 })).toBe(
      'error.VALIDATION_ERROR.asset.life_years_months_mismatch'
    );
    expect(await keyOf({ depreciation_start_date: '2026-01-07' })).toBe('error.VALIDATION_ERROR.asset.start_before_acquisition');
    expect(await keyOf({ depreciation_expense_account_id: f.userId })).toBe('error.VALIDATION_ERROR.asset.accounts_rejected');
    expect(await keyOf({ acquisition_cost: '96000' })).toBe('error.VALIDATION_ERROR.asset.edit_no_change');

    // A corrected acquisition date takes the start with it, as registration
    // derives it, unless the start is typed too.
    const moved = await edit(truck.id, { acquisition_date: '2026-03-20', useful_life_months: 30 });
    expect(moved.startRederived).toBe(true);
    expect(await card(truck.id)).toMatchObject({ acquired: '2026-03-20', start: '2026-03-01' });
    expect(moved.changes.map((c) => c.field)).toEqual([
      'useful_life_years', 'useful_life_months', 'acquisition_date', 'depreciation_start_date',
    ]);
  }, 120_000);

  it("another entity's asset answers as a missing one, and one that left the register is not edited", async () => {
    const sister = await crearEntidadHermana(f, 'MNE-001-880 sister');
    const foreign = await refusal(pickup.id, { acquisition_cost: '1.00' }, sister.entityId);
    expect(foreign.code).toBe('RESOURCE_NOT_FOUND');
    expect(await card(pickup.id)).toMatchObject({ cost: '489000.0000' });

    const sold = await register('Synthetic trailer', '96000.00');
    await query(`UPDATE fixed_assets SET status = 'disposed' WHERE id = $1 AND entity_id = $2`, [sold.id, f.entityId]);
    const err = await refusal(sold.id, { acquisition_cost: '90000.00' });
    expect(err.messageKey).toEqual({
      key: 'error.VALIDATION_ERROR.asset.edit_not_in_register',
      params: { asset: sold.asset_number, status: 'disposed' },
    });
  }, 120_000);
});

describe('an edit and a run at the same time', () => {
  it('a run that read the asset before the edit committed posts nothing for it; the next run posts the edited figure', async () => {
    const crane = await register('Synthetic crane', '960000.00');
    let run!: ReturnType<typeof runMonthlyDepreciation>;
    await withTransaction(async (client) => {
      await editAsset(f.entityId, crane.id, { acquisition_cost: '96000.00' }, REASON, f.userId, { client });
      // The run reads 960,000.00 (the edit is not committed) and reaches the
      // asset while the edit still holds it: wait until it is seen waiting.
      run = runMonthlyDepreciation(f.entityId, f.periodos[1], f.userId);
      for (let i = 0; i < 300; i++) {
        const waiting = await client.query(
          `SELECT 1 FROM pg_stat_activity WHERE pg_backend_pid() = ANY(pg_blocking_pids(pid))`
        );
        if (waiting.rows.length > 0) break;
        await new Promise((r) => setTimeout(r, 50));
      }
    });
    const first = await run;
    expect(first.processed).toBe(0);
    expect(first.errors).toEqual([
      `Activo ${crane.asset_number}: it changed in the register while this run was posting: nothing was posted for it. Run the month again.`,
    ]);
    expect(await january(crane.id)).toEqual([]);

    expect(await runMonthlyDepreciation(f.entityId, f.periodos[1], f.userId)).toMatchObject({ processed: 1, errors: [] });
    expect((await january(crane.id)).map((r) => r.expense)).toEqual(['2000.0000']);
  }, 120_000);
});
