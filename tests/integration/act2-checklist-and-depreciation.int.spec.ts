import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { createJournalEntry, postJournalEntry } from '../../src/services/accounting/posting.js';
import { getPeriodCloseStatus } from '../../src/services/accounting/period-close.js';
import { crearActivo } from '../../src/services/assets/asset-service.js';
import { conductClose } from '../../src/services/accounting/closing-conductor.js';
import type { ClosablePeriod } from '../../src/ai/close-service.js';

/**
 * ACT-2 (#322, MNE-001-021). Two halves of the same hole:
 *
 * - the depreciation box said nothing — no warning, no finding — about an
 *   entity whose ledger carries computer equipment while its register holds
 *   no asset at all. "Nothing to depreciate" with fixed assets on the balance
 *   sheet is a finding, not a pass;
 * - once the asset is registered, the month's depreciation must be posted by
 *   the real close (`conductClose`, what `closing run` drives), not by a
 *   fixture that inserts a posted schedule row.
 *
 * THE FIGURES, BY HAND. Computer equipment bought on 2026-01-01 for
 * 36,000.00 and paid from the bank: 1220 Dr / 1110 Cr. Its class carries a
 * 30 % LISR maximum, i.e. a 40-month book life (12 / 0.30). The panel's
 * defaults are `vida_util_nif` and `mes_completo`, so January is a whole
 * month: 36,000 / 40 = 900.00, posted 6140 Dr / 1290 Cr.
 */

const COST = '36000.0000';
const JANUARY_DEPRECIATION = '900.0000';

let f: Fixture;

async function january(): Promise<ClosablePeriod> {
  const r = await query<ClosablePeriod>(
    `SELECT fp.id, fp.period_name, fp.period_number,
            fp.start_date::text, fp.end_date::text, fp.status,
            fy.year_number, false AS overdue
       FROM fiscal_periods fp
       JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
      WHERE fp.id = $1 AND fp.entity_id = $2`,
    [f.periodos[1], f.entityId]
  );
  return r.rows[0];
}

async function depreciationBox() {
  const st = await getPeriodCloseStatus(f.periodos[1], f.entityId);
  const box = st.checklist.find((i) => i.codigo === 'depreciation-posted')!;
  return { box, warnings: st.warnings, canClose: st.can_close };
}

beforeAll(async () => {
  f = await crearInquilino('ACT-2 fixed assets without a register');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  const purchase = await createJournalEntry(
    f.entityId,
    new Date('2026-01-01T12:00:00'),
    'standard' as never,
    'Computer equipment bought from the bank',
    [
      { account_id: f.cuentas['1220'], debit_amount: COST, credit_amount: null, description: 'equipment' },
      { account_id: f.cuentas['1110'], debit_amount: null, credit_amount: COST, description: 'bank' },
    ] as never,
    f.userId
  );
  await postJournalEntry(purchase.id, f.userId);
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe('the checklist sees fixed assets on the books and none in the register', () => {
  it('the depreciation box is a finding that names the balance, and it warns without blocking', async () => {
    const { box, warnings, canClose } = await depreciationBox();
    expect(box.is_complete).toBe(false);
    expect(box.severity).toBe('warning');
    expect(box.details).toBe(
      '0 fixed assets registered, but the fixed-asset accounts carry 36000.00 at 2026-01-31: ' +
        'register them (asset create) so the month can be depreciated'
    );
    expect(warnings).toContain(
      'Fixed-asset accounts carry 36000.00 and no fixed asset is registered: nothing was depreciated'
    );
    expect(canClose).toBe(true);
  });

  it('an imported chart without the fixed_asset subtype is still seen through the asset class', async () => {
    const tag = (subtype: string | null) =>
      query(`UPDATE accounts SET account_subtype = $3 WHERE id = $1 AND entity_id = $2`, [
        f.cuentas['1220'],
        f.entityId,
        subtype,
      ]);
    await tag(null);
    try {
      expect((await depreciationBox()).box.details).toMatch(/^0 fixed assets registered, but .* 36000\.00 /);
    } finally {
      await tag('fixed_asset');
    }
  });
});

describe('the close run posts the depreciation of the registered asset', () => {
  it('conductClose posts 900.00 to 6140 / 1290 for January, and the box turns complete', async () => {
    enterTenant(f.tenantId);
    const computers = await query<{ id: string }>(
      `SELECT id FROM asset_categories WHERE entity_id = $1 AND name = 'Equipo de Cómputo'`,
      [f.entityId]
    );
    const asset = await crearActivo(
      f.entityId,
      {
        asset_name: 'Synthetic laptop pool',
        category_id: computers.rows[0].id,
        acquisition_date: '2026-01-01',
        acquisition_cost: COST,
        contabilizacion: 'ya_contabilizado',
      },
      f.userId
    );
    expect(asset.useful_life_months).toBe(40);

    const run = await conductClose(
      {
        entityId: f.entityId,
        entityName: 'ACT-2',
        tenantId: f.tenantId,
        currency: 'MXN',
        country: 'MX',
        accountingStandard: 'mx_nif',
        taxId: 'XAXX010101000',
      },
      await january(),
      { userId: f.userId }
    );
    const step = run.steps.find((s) => s.step === 'depreciate-assets')!;
    expect(step, JSON.stringify(run.steps)).toMatchObject({ status: 'done', processed: 1 });
    expect(run.status, JSON.stringify(run.steps)).toBe('completed');

    const lines = await query<{ code: string; debit: string | null; credit: string | null }>(
      `SELECT a.code, jel.debit_amount::text AS debit, jel.credit_amount::text AS credit
         FROM depreciation_schedules ds
         JOIN journal_entries je ON je.id = ds.journal_entry_id AND je.entity_id = $2
         JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
         JOIN accounts a ON a.id = jel.account_id AND a.entity_id = $2
        WHERE ds.asset_id = $1 AND ds.fiscal_period_id = $3 AND ds.is_posted = true
          AND je.status = 'posted'
        ORDER BY a.code`,
      [asset.id, f.entityId, f.periodos[1]]
    );
    expect(lines.rows).toEqual([
      { code: '1290', debit: null, credit: JANUARY_DEPRECIATION },
      { code: '6140', debit: JANUARY_DEPRECIATION, credit: null },
    ]);

    const { box, warnings } = await depreciationBox();
    expect(box.is_complete).toBe(true);
    expect(box.details).toBeUndefined();
    expect(warnings.some((w) => /fixed-asset|depreciation/i.test(w))).toBe(false);
  });
});
