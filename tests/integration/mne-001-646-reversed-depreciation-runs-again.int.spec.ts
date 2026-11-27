import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { reverseJournalEntry, voidJournalEntry } from '../../src/services/accounting/posting.js';
import { getPeriodCloseStatus } from '../../src/services/accounting/period-close.js';
import { explainCloseCheck } from '../../src/services/accounting/close-explain.js';
import { crearActivo } from '../../src/services/assets/asset-service.js';
import { runMonthlyDepreciation } from '../../src/services/assets/depreciation.js';
import { planDeDepreciacion } from '../../src/services/assets/depreciation-plan.js';

/**
 * MNE-001-646 (#595). A depreciation row counts while the ledger backs it:
 * once its entry is reversed or voided, the asset card, the plan, the close
 * box and the run all stop counting it, and the month posts again, once.
 *
 * THE FIGURES, BY HAND. Computer equipment deducts at 30 % a year, a 40-month
 * book life (12 / 0.30). The panel's defaults are `vida_util_nif` and
 * `mes_completo`, so every month is whole:
 *
 *   A · 36,000.00 / 40 = 900.00 a month
 *   B · 24,000.00 / 40 = 600.00 a month
 *
 * January and February posted for both: A carries 1,800.00, B 1,200.00, and
 * the accumulated-depreciation account 3,000.00.
 *
 *   C · 36,000.00 with 6,000.00 of salvage, on its own entity:
 *       book (36,000 − 6,000) / 40 = 750.00; tax 36,000 × 0.30 / 12 = 900.00
 *       (LISR art. 31: the rate applies to the original investment).
 */

let f: Fixture;
let a: string;
let b: string;

async function register(on: Fixture, name: string, cost: string, salvage?: string): Promise<string> {
  enterTenant(on.tenantId);
  const computers = await query<{ id: string }>(
    `SELECT id FROM asset_categories WHERE entity_id = $1 AND name = 'Equipo de Cómputo'`,
    [on.entityId]
  );
  const asset = await crearActivo(
    on.entityId,
    {
      asset_name: name,
      category_id: computers.rows[0].id,
      acquisition_date: '2026-01-01',
      acquisition_cost: cost,
      ...(salvage ? { salvage_value: salvage } : {}),
      contabilizacion: 'ya_contabilizado',
    },
    on.userId
  );
  expect(asset.useful_life_months).toBe(40);
  return asset.id;
}

async function card(on: Fixture, assetId: string) {
  const r = await query<{ accumulated: string; book_value: string; last: string | null }>(
    `SELECT accumulated_depreciation::text AS accumulated, current_book_value::text AS book_value,
            to_char(last_depreciation_date, 'YYYY-MM-DD') AS last
       FROM fixed_assets WHERE id = $1 AND entity_id = $2`,
    [assetId, on.entityId]
  );
  return r.rows[0];
}

/** The month's rows of one asset, with what the ledger says of each entry. */
async function rowsOf(on: Fixture, assetId: string, month: number) {
  const r = await query<{ entry: string; book: string; expense: string; reversed: boolean }>(
    `SELECT ds.journal_entry_id AS entry, ds.schedule_type AS book,
            ds.depreciation_expense::text AS expense,
            je.reversed_by_entry_id IS NOT NULL AS reversed
       FROM depreciation_schedules ds
       JOIN fixed_assets fa ON fa.id = ds.asset_id AND fa.entity_id = $2
       JOIN journal_entries je ON je.id = ds.journal_entry_id AND je.entity_id = $2
      WHERE ds.asset_id = $1 AND ds.fiscal_period_id = $3`,
    [assetId, on.entityId, on.periodos[month]]
  );
  return r.rows;
}

/** What the ledger carries on the accumulated-depreciation account: credits less debits. */
async function accumulatedInLedger(on: Fixture, assetId: string): Promise<string> {
  const r = await query<{ net: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)), 0)::text AS net
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id AND je.entity_id = $2
      WHERE je.status = 'posted'
        AND jel.account_id = (SELECT accumulated_depreciation_account_id FROM fixed_assets
                               WHERE id = $1 AND entity_id = $2)`,
    [assetId, on.entityId]
  );
  return r.rows[0].net;
}

async function box(on: Fixture, month: number) {
  const st = await getPeriodCloseStatus(on.periodos[month], on.entityId);
  return st.checklist.find((i) => i.codigo === 'depreciation-posted')!;
}

beforeAll(async () => {
  f = await crearInquilino('MNE-646 reversed depreciation');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  a = await register(f, 'Synthetic laptop pool', '36000.0000');
  b = await register(f, 'Synthetic server rack', '24000.0000');
  for (const month of [1, 2]) {
    const run = await runMonthlyDepreciation(f.entityId, f.periodos[month], f.userId);
    expect(run).toEqual({ processed: 2, errors: [], skipped: [] });
  }
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

describe('a reversed depreciation entry no longer counts', () => {
  it('two months posted: the cards and the ledger agree at 3,000.00', async () => {
    expect(await card(f, a)).toEqual({ accumulated: '1800.0000', book_value: '34200.0000', last: '2026-02-28' });
    expect(await card(f, b)).toEqual({ accumulated: '1200.0000', book_value: '22800.0000', last: '2026-02-28' });
    expect(await accumulatedInLedger(f, a)).toBe('3000.0000');
    expect((await box(f, 1)).is_complete).toBe(true);
  });

  it("after A's January entry is reversed, the card excludes that month before any new run", async () => {
    const [january] = await rowsOf(f, a, 1);
    await reverseJournalEntry(january.entry, f.userId, {
      reason: 'posted on the wrong cost',
      reversalDate: new Date('2026-01-31T12:00:00'),
    });

    expect(await card(f, a)).toEqual({ accumulated: '900.0000', book_value: '35100.0000', last: '2026-02-28' });
    expect(await card(f, b)).toEqual({ accumulated: '1200.0000', book_value: '22800.0000', last: '2026-02-28' });
    expect(await accumulatedInLedger(f, a)).toBe('2100.0000');
  });

  it('the plan of January shows A as owed and B as done', async () => {
    const plan = await planDeDepreciacion(f.entityId, f.periodos[1]);
    expect(plan.renglones.map((r) => [r.asset_id, r.depreciacion])).toEqual([[a, '900.0000']]);
    expect(plan.omitidos.map((o) => [o.asset_id, o.motivo])).toEqual([[b, 'ya_corrido']]);
    expect(plan.total).toBe('900.0000');
  });

  it('the close box of January is not satisfied, and its list names A', async () => {
    const january = await box(f, 1);
    expect(january.is_complete).toBe(false);
    expect(january.details).toBe('1 assets without depreciation');
    expect((await box(f, 2)).is_complete).toBe(true);

    const explained = await explainCloseCheck(f.entityId, f.periodos[1], 'depreciation-posted');
    expect(explained.renglones.map((r) => r.asset_name)).toEqual(['Synthetic laptop pool']);
  });

  it('January runs again for A only, and the card equals the ledger', async () => {
    const [dead] = await rowsOf(f, a, 1);
    expect(dead.reversed).toBe(true);

    const run = await runMonthlyDepreciation(f.entityId, f.periodos[1], f.userId);
    expect(run).toEqual({ processed: 1, errors: [], skipped: [] });

    const rows = await rowsOf(f, a, 1);
    expect(rows).toEqual([{ entry: expect.any(String), book: 'book', expense: '900.0000', reversed: false }]);
    expect(rows[0].entry).not.toBe(dead.entry);

    expect(await card(f, a)).toEqual({ accumulated: '1800.0000', book_value: '34200.0000', last: '2026-02-28' });
    expect(await accumulatedInLedger(f, a)).toBe('3000.0000');
    expect((await box(f, 1)).is_complete).toBe(true);
  });

  it('a third run of January posts nothing: the month is charged once', async () => {
    const run = await runMonthlyDepreciation(f.entityId, f.periodos[1], f.userId);
    expect(run).toEqual({ processed: 0, errors: [], skipped: [] });
    expect(await accumulatedInLedger(f, a)).toBe('3000.0000');
  });

  it('a voided entry counts the same as a reversed one', async () => {
    const [february] = await rowsOf(f, a, 2);
    await voidJournalEntry(february.entry, f.userId, 'posted before the invoice was corrected');

    expect(await card(f, a)).toEqual({ accumulated: '900.0000', book_value: '35100.0000', last: '2026-01-31' });
    expect((await box(f, 2)).is_complete).toBe(false);

    const run = await runMonthlyDepreciation(f.entityId, f.periodos[2], f.userId);
    expect(run).toEqual({ processed: 1, errors: [], skipped: [] });
    expect(await card(f, a)).toEqual({ accumulated: '1800.0000', book_value: '34200.0000', last: '2026-02-28' });
    expect(await accumulatedInLedger(f, a)).toBe('3000.0000');
    expect((await box(f, 2)).is_complete).toBe(true);
  });
});

describe('the basis lock follows the ledger too', () => {
  it('an asset whose only month was reversed runs that month on the other book', async () => {
    const g = await crearEntidadHermana(f, 'MNE-646 other basis');
    const ctx = { tenantId: g.tenantId, entityId: g.entityId };
    await seedPolicies(ctx);
    const c = await register(g, 'Synthetic plotter', '36000.0000', '6000.0000');

    expect(await runMonthlyDepreciation(g.entityId, g.periodos[1], g.userId)).toEqual({ processed: 1, errors: [], skipped: [] });
    const [onBook] = await rowsOf(g, c, 1);
    expect(onBook).toMatchObject({ book: 'book', expense: '750.0000' });

    await reverseJournalEntry(onBook.entry, g.userId, {
      reason: 'the firm deducts at the LISR rate',
      reversalDate: new Date('2026-01-31T12:00:00'),
    });
    await resolvePolicy(ctx, 'base_depreciacion', 'tasa_lisr', g.userId);

    const plan = await planDeDepreciacion(g.entityId, g.periodos[1]);
    expect(plan.renglones.map((r) => [r.asset_id, r.depreciacion])).toEqual([[c, '900.0000']]);

    expect(await runMonthlyDepreciation(g.entityId, g.periodos[1], g.userId)).toEqual({ processed: 1, errors: [], skipped: [] });
    expect(await rowsOf(g, c, 1)).toEqual([
      { entry: expect.any(String), book: 'tax', expense: '900.0000', reversed: false },
    ]);
    expect(await card(g, c)).toEqual({ accumulated: '900.0000', book_value: '35100.0000', last: '2026-01-31' });
    expect(await accumulatedInLedger(g, c)).toBe('900.0000');
  });
});
