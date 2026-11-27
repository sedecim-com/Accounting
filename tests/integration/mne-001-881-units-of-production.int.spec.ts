import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { createJournalEntry, postJournalEntry } from '../../src/services/accounting/posting.js';
import { getPeriodCloseStatus } from '../../src/services/accounting/period-close.js';
import { crearActivo, type DatosDeAlta } from '../../src/services/assets/asset-service.js';
import { conductClose } from '../../src/services/accounting/closing-conductor.js';
import type { ClosablePeriod } from '../../src/ai/close-service.js';
import type { AgentContext } from '../../src/ai/context.js';
import { DepreciationMethod } from '../../src/types/index.js';
import type { AppError } from '../../src/utils/errors.js';

/**
 * MNE-001-881 (#1069). An asset by units of production cannot be depreciated
 * by the monthly run: nothing captures the period's production.
 *
 * - `asset create` accepted the method, on the book or the tax side;
 * - the run reported that asset as an ERROR, a step with errors is `failed`,
 *   and a failed step ends `closing run`: one such asset stopped the close of
 *   the whole entity, every month, with no command to change it.
 *
 * THE FIGURES, BY HAND. Two assets of 36,000.00 each, bought on 2026-01-01,
 * in the class "Equipo de Cómputo" (30 % LISR maximum, a 40-month book life).
 * Under the panel's defaults (`vida_util_nif`, `mes_completo`) the laptop
 * pool depreciates 36,000 / 40 = 900.00 a month. The press is by units of
 * production: the run posts NOTHING for it, and its card keeps 0.00 of
 * accumulated depreciation and 36,000.00 of book value.
 */

const COST = '36000.0000';
const MONTHLY = '900.0000';
const REFUSAL = 'error.VALIDATION_ERROR.asset.units_of_production_unsupported';

let f: Fixture;
let categoryId: string;
let laptops: { id: string; asset_number: string };
let press: { id: string; asset_number: string };

const ctx = (): AgentContext => ({
  entityId: f.entityId,
  entityName: 'MNE-001-881',
  tenantId: f.tenantId,
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'XAXX010101000',
});

const asset = (name: string, extra: Partial<DatosDeAlta> = {}): DatosDeAlta => ({
  asset_name: name,
  category_id: categoryId,
  acquisition_date: '2026-01-01',
  acquisition_cost: COST,
  contabilizacion: 'ya_contabilizado',
  ...extra,
});

async function period(month: number): Promise<ClosablePeriod> {
  const r = await query<ClosablePeriod>(
    `SELECT fp.id, fp.period_name, fp.period_number,
            fp.start_date::text, fp.end_date::text, fp.status,
            fy.year_number, false AS overdue
       FROM fiscal_periods fp
       JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
      WHERE fp.id = $1 AND fp.entity_id = $2`,
    [f.periodos[month], f.entityId]
  );
  return r.rows[0];
}

/** What the run and the close say about the press, written by hand. */
const note = (): string =>
  `1 asset(s) skipped by units of production (unidades_de_produccion), nothing posted for them: ` +
  `${press.asset_number} Synthetic press. The period's production cannot be captured yet: ` +
  "book the month's charge by hand (entry create)";

async function rowsOf(assetId: string, month: number): Promise<string[]> {
  const r = await query<{ expense: string }>(
    `SELECT ds.depreciation_expense::text AS expense
       FROM depreciation_schedules ds
       JOIN fixed_assets fa ON fa.id = ds.asset_id AND fa.entity_id = $2
      WHERE ds.asset_id = $1 AND ds.fiscal_period_id = $3 AND ds.is_posted = true`,
    [assetId, f.entityId, f.periodos[month]]
  );
  return r.rows.map((x) => x.expense);
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-881 units of production');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  enterTenant(f.tenantId);
  const purchase = await createJournalEntry(
    f.entityId,
    new Date('2026-01-01T12:00:00'),
    'standard' as never,
    'Two machines bought from the bank',
    [
      { account_id: f.cuentas['1220'], debit_amount: '72000.0000', credit_amount: null, description: 'equipment' },
      { account_id: f.cuentas['1110'], debit_amount: null, credit_amount: '72000.0000', description: 'bank' },
    ] as never,
    f.userId
  );
  await postJournalEntry(purchase.id, f.userId);
  const computers = await query<{ id: string }>(
    `SELECT id FROM asset_categories WHERE entity_id = $1 AND name = 'Equipo de Cómputo'`,
    [f.entityId]
  );
  categoryId = computers.rows[0].id;
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe('registration refuses units of production while nothing captures production', () => {
  it.each([
    ['book', { book_depreciation_method: DepreciationMethod.UNITS_OF_PRODUCTION }, 'book_depreciation_method'],
    ['tax', { tax_depreciation_method: DepreciationMethod.UNITS_OF_PRODUCTION }, 'tax_depreciation_method'],
  ] as const)('on the %s side, by key, and nothing is registered', async (book, extra, field) => {
    const err = (await crearActivo(f.entityId, asset('Synthetic refused press', extra), f.userId).catch(
      (e: unknown) => e
    )) as AppError;
    expect(err.messageKey).toEqual({ key: REFUSAL, params: { book } });
    expect(err.field).toBe(field);
    expect(err.code).toBe('VALIDATION_ERROR');
    const registered = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM fixed_assets WHERE entity_id = $1`,
      [f.entityId]
    );
    expect(registered.rows[0].n).toBe('0');
  });
});

describe('an asset already registered by units of production no longer stops the close', () => {
  beforeAll(async () => {
    laptops = await crearActivo(f.entityId, asset('Synthetic laptop pool'), f.userId);
    press = await crearActivo(f.entityId, asset('Synthetic press'), f.userId);
    // The press stands for an asset registered BEFORE the refusal existed:
    // the method is written as that registration wrote it.
    const changed = await query(
      `UPDATE fixed_assets
          SET depreciation_method = 'units_of_production', book_depreciation_method = 'units_of_production'
        WHERE id = $1 AND entity_id = $2`,
      [press.id, f.entityId]
    );
    expect(changed.rowCount).toBe(1);
  }, 120_000);

  it('closing run completes January: 900.00 for the laptops, nothing for the press, and both places say so', async () => {
    const run = await conductClose(ctx(), await period(1), { userId: f.userId });
    const step = run.steps.find((s) => s.step === 'depreciate-assets')!;
    expect(step, JSON.stringify(run.steps)).toMatchObject({ status: 'done', processed: 1 });
    expect(step.detail).toBe(`1 asset(s) depreciated; ${note()}`);
    expect(run.status, JSON.stringify(run.steps)).toBe('completed');

    expect(await rowsOf(laptops.id, 1)).toEqual([MONTHLY]);
    // No row, no entry and no figure for the press.
    expect(await rowsOf(press.id, 1)).toEqual([]);
    const card = await query<{ accumulated: string; book: string }>(
      `SELECT accumulated_depreciation::text AS accumulated, current_book_value::text AS book
         FROM fixed_assets WHERE id = $1 AND entity_id = $2`,
      [press.id, f.entityId]
    );
    expect(card.rows[0]).toEqual({ accumulated: '0.0000', book: COST });

    const st = await getPeriodCloseStatus(f.periodos[1], f.entityId);
    const box = st.checklist.find((i) => i.codigo === 'depreciation-posted')!;
    expect(box).toMatchObject({ is_complete: false, severity: 'warning' });
    expect(box.details).toBe(`1 assets without depreciation; ${note()}`);
    expect(st.warnings).toContain('1 assets without depreciation posted');
    expect(st.warnings).toContain(note());
  }, 180_000);

  it("under 'bloquear' the firm's own policy stops February at the checklist, with the asset named, not the engine", async () => {
    await resolvePolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'depreciacion_faltante_al_cierre', 'bloquear', f.userId);
    const run = await conductClose(ctx(), await period(2), { userId: f.userId });
    const step = run.steps.find((s) => s.step === 'depreciate-assets')!;
    expect(step, JSON.stringify(run.steps)).toMatchObject({ status: 'done', processed: 1 });
    expect(await rowsOf(laptops.id, 2)).toEqual([MONTHLY]);
    expect(run).toMatchObject({ status: 'blocked', haltedAtStep: 'verify-checklist' });
    expect(run.steps.find((s) => s.step === 'verify-checklist')!.detail).toBe(
      `blocking: 1 assets without depreciation posted; ${note()}`
    );
  }, 180_000);
});
