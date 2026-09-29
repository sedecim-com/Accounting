import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy, reopenPolicy } from '../../src/services/policy/policy-service.js';
import { createJournalEntry, postJournalEntry } from '../../src/services/accounting/posting.js';
import { getPeriodCloseStatus } from '../../src/services/accounting/period-close.js';
import { explainCloseCheck } from '../../src/services/accounting/close-explain.js';
import { crearActivo } from '../../src/services/assets/asset-service.js';

/**
 * MNE-001-129 (#128): the close checklist follows the two accrual policies
 * the panel says govern it.
 *
 * - `depreciacion_faltante_al_cierre` promised to govern the
 *   "Depreciation calculated and posted" box, and the box carried a literal
 *   'warning': answering 'bloquear' changed nothing at close.
 * - `amortizacion_faltante_al_cierre` promised that "the checklist item goes
 *   red", and the checklist had no prepaid item at all.
 *
 * January of one tenant carries one active fixed asset with no depreciation
 * posted and one prepaid schedule that covers January and was never run.
 */

let f: Fixture;
const ctx = () => ({ tenantId: f.tenantId, entityId: f.entityId });

async function januaryStatus() {
  const st = await getPeriodCloseStatus(f.periodos[1], f.entityId);
  return {
    depreciation: st.checklist.find((i) => i.codigo === 'depreciation-posted')!,
    prepaid: st.checklist.find((i) => i.codigo === 'prepaid-amortized')!,
    st,
  };
}

/** Answers a policy; an answered one is reopened first, as `pending reopen` does. */
async function answer(key: string, value: string) {
  const row = await query<{ status: string }>(
    `SELECT status FROM policy_decisions WHERE tenant_id = $1 AND entity_id = $2 AND key = $3`,
    [f.tenantId, f.entityId, key]
  );
  if (row.rows[0]?.status !== 'pending') await reopenPolicy(ctx(), key);
  await resolvePolicy(ctx(), key, value, f.userId);
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-129 accrual policies at close');
  await seedPolicies(ctx());
  enterTenant(f.tenantId);

  const purchase = await createJournalEntry(
    f.entityId,
    new Date('2026-01-01T12:00:00'),
    'standard' as never,
    'Computer equipment bought from the bank',
    [
      { account_id: f.cuentas['1220'], debit_amount: '36000.0000', credit_amount: null, description: 'equipment' },
      { account_id: f.cuentas['1110'], debit_amount: null, credit_amount: '36000.0000', description: 'bank' },
    ] as never,
    f.userId
  );
  await postJournalEntry(purchase.id, f.userId);
  const computers = await query<{ id: string }>(
    `SELECT id FROM asset_categories WHERE entity_id = $1 AND name = 'Equipo de Cómputo'`,
    [f.entityId]
  );
  await crearActivo(
    f.entityId,
    {
      asset_name: 'Synthetic laptop pool',
      category_id: computers.rows[0].id,
      acquisition_date: '2026-01-01',
      acquisition_cost: '36000.0000',
      contabilizacion: 'ya_contabilizado',
    },
    f.userId
  );

  await query(
    `INSERT INTO prepaid_expenses
       (entity_id, description, total_amount, coverage_start_date, coverage_end_date,
        prepaid_account_id, expense_account_id, amortization_convention, origin, created_by)
     VALUES ($1, 'Synthetic fleet insurance', 12000, '2026-01-01', '2026-12-31',
             $2, $3, 'meses_completos', 'manual', $4)`,
    [f.entityId, f.roles.gasto_anticipado, f.cuentas['6140'], f.userId]
  );
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe('depreciation-posted takes its severity from depreciacion_faltante_al_cierre', () => {
  it("'avisar' warns and lets the month close; 'bloquear' blocks the same box and the close refuses", async () => {
    const before = await januaryStatus();
    expect(before.depreciation).toMatchObject({ is_complete: false, severity: 'warning' });
    expect(before.st.warnings).toContain('1 assets without depreciation posted');
    expect(before.st.blocking_issues.some((b) => /depreciation/.test(b))).toBe(false);

    await answer('depreciacion_faltante_al_cierre', 'bloquear');
    try {
      const { depreciation, st } = await januaryStatus();
      expect(depreciation).toMatchObject({ is_complete: false, severity: 'blocking' });
      expect(st.blocking_issues).toContain('1 assets without depreciation posted');
      expect(st.warnings).not.toContain('1 assets without depreciation posted');
      expect(st.can_close).toBe(false);

      // An empty register is "could not check", not pending depreciation:
      // the policy speaks of assets whose run is missing, so it still warns.
      await query(`UPDATE fixed_assets SET status = 'fully_depreciated' WHERE entity_id = $1`, [f.entityId]);
      try {
        expect((await januaryStatus()).depreciation).toMatchObject({ is_complete: false, severity: 'warning' });
      } finally {
        await query(`UPDATE fixed_assets SET status = 'active' WHERE entity_id = $1`, [f.entityId]);
      }
    } finally {
      await answer('depreciacion_faltante_al_cierre', 'avisar');
    }
  });
});

describe('prepaid-amortized follows amortizacion_faltante_al_cierre', () => {
  it("under the default 'avisar' the unrun schedule is a red box that only warns", async () => {
    const { prepaid, st } = await januaryStatus();
    expect(prepaid).toMatchObject({ is_complete: false, severity: 'warning' });
    expect(prepaid.details).toMatch(/^1 prepaid schedule\(s\) not amortized in /);
    expect(st.warnings.some((w) => w.startsWith('Prepaid expenses amortized for the period'))).toBe(true);
  });

  it("answered 'bloquear', the prepaid box stops the close", async () => {
    await answer('amortizacion_faltante_al_cierre', 'bloquear');
    try {
      const { prepaid, st } = await januaryStatus();
      expect(prepaid).toMatchObject({ is_complete: false, severity: 'blocking' });
      expect(st.blocking_issues.some((b) => b.startsWith('Prepaid expenses amortized for the period'))).toBe(true);
      expect(st.can_close).toBe(false);
    } finally {
      await answer('amortizacion_faltante_al_cierre', 'avisar');
    }
  });

  it('closing explain lists the unrun schedule with the prepaid run as its remedy', async () => {
    const e = await explainCloseCheck(f.entityId, f.periodos[1], 'prepaid-amortized');
    expect(e.total).toBe(1);
    expect(e.renglones[0]).toMatchObject({ description: 'Synthetic fleet insurance', remaining_amount: '12000.0000' });
    expect(e.remedio).toMatch(/^mnemosine prepaid run --period/);
  });

  it('a cancelled schedule is not pending: the box turns green', async () => {
    await query(`UPDATE prepaid_expenses SET status = 'cancelled' WHERE entity_id = $1`, [f.entityId]);
    try {
      const { prepaid } = await januaryStatus();
      expect(prepaid.is_complete).toBe(true);
      expect(prepaid.details).toBeUndefined();
    } finally {
      await query(`UPDATE prepaid_expenses SET status = 'active' WHERE entity_id = $1`, [f.entityId]);
    }
  });
});
