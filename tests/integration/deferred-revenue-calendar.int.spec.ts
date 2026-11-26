import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { createJournalEntry, reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import { anticiposActivos, registrarPagoAnticipado } from '../../src/services/accruals/prepaid-service.js';
import { runMonthlyAmortization, runMonthlyDeferredRevenue } from '../../src/services/accruals/amortization-run.js';

// ============================================================
// MNE-001-299 (#111) · REVENUE COLLECTED IN ADVANCE, RECOGNIZED BY CALENDAR
//
// A synthetic entity bills and collects on 20 Mar 2026 an annual support
// contract: base 120 000.00 + IVA 19 200.00, service 20 Mar 2026 → 19 Mar 2027
// (365 days). The invoice credits the contract liability (2158).
//
// By days (the panel's default), 120 000 × days / 365, four decimals:
//   March 12 days      1 440 000 / 365 = 3 945.2055
//   30-day months      3 600 000 / 365 = 9 863.0137  (Apr, Jun, Sep, Nov)
//   31-day months      3 720 000 / 365 = 10 191.7808 (May, Jul, Aug, Oct, Dec)
//   2026: 3 945.2055 + 4 × 9 863.0137 + 5 × 10 191.7808 = 94 356.1643
//   liability at 31 Dec 2026: 120 000 − 94 356.1643 = 25 643.8357
// ============================================================

let f: Fixture;
let sister: Fixture;
let invoiceEntry: string;
let scheduleId: string;

const utc = (date: string): Date => new Date(`${date}T00:00:00`);

async function post(fx: Fixture, date: string, lines: Array<[string, string | null, string | null]>): Promise<string> {
  enterTenant(fx.tenantId);
  const je = await createJournalEntry(
    fx.entityId, utc(date), JournalEntryType.STANDARD, 'MNE-001-299',
    lines.map(([account_id, debit_amount, credit_amount]) => ({ account_id, debit_amount, credit_amount, description: 'x' })),
    fx.userId,
    { autoPost: true }
  );
  return je.id;
}

/** Credit-positive posted balance of an account. */
async function creditBalance(entityId: string, accountId: string): Promise<string> {
  const r = await query<{ b: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.credit_amount, 0) - COALESCE(jel.debit_amount, 0)), 0)::text AS b
       FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.entity_id = $1 AND jel.account_id = $2 AND je.status = 'posted'`,
    [entityId, accountId]
  );
  return new Decimal(r.rows[0].b).toFixed(4);
}

async function recognitionOf(periodId: string) {
  return query<{ id: string; amount: string; lines: string; source_type: string }>(
    `SELECT je.id, s.amortization_amount::text AS amount, je.source_type,
            (SELECT count(*) FROM journal_entry_lines l WHERE l.journal_entry_id = je.id)::text AS lines
       FROM prepaid_amortization_schedules s JOIN journal_entries je ON je.id = s.journal_entry_id
      WHERE s.prepaid_expense_id = $1 AND s.fiscal_period_id = $2
      ORDER BY je.created_at`,
    [scheduleId, periodId]
  );
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-299 ingreso diferido');
  sister = await crearEntidadHermana(f, 'MNE-001-299 hermana');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  await seedPolicies({ tenantId: sister.tenantId, entityId: sister.entityId });
  invoiceEntry = await post(f, '2026-03-20', [
    [f.roles.banco, '139200.00', null],
    [f.roles.ingreso_cobrado_por_anticipado, null, '120000.00'],
    [f.roles.iva_trasladado, null, '19200.00'],
  ]);
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

describe('deferred-revenue create adopts a credit on the contract liability', () => {
  it('seeds 2158 with its role in every entity', () => {
    expect(f.roles.ingreso_cobrado_por_anticipado).toBe(f.cuentas['2158']);
  });

  it('refuses a schedule larger than the unscheduled credit', async () => {
    enterTenant(f.tenantId);
    await expect(
      registrarPagoAnticipado({
        entityId: f.entityId, kind: 'deferred_revenue', descripcion: 'Too much', importe: '130000',
        inicio: '2026-03-20', fin: '2027-03-19', origen: 'manual', createdBy: f.userId,
      })
    ).rejects.toThrow(/No posted credit backs this schedule.*120000\.00/);
  });

  it('does not take a customer advance on 2150 as backing', async () => {
    await post(sister, '2026-03-01', [[sister.roles.banco, '5000.00', null], [sister.roles.anticipo_clientes, null, '5000.00']]);
    await expect(
      registrarPagoAnticipado({
        entityId: sister.entityId, kind: 'deferred_revenue', descripcion: 'Advance', importe: '5000',
        inicio: '2026-03-01', fin: '2026-12-31', origen: 'manual', createdBy: sister.userId,
      })
    ).rejects.toThrow(/No posted credit backs this schedule/);
  });

  it('registers thirteen rows by days, frozen with the deferred-revenue key', async () => {
    enterTenant(f.tenantId);
    const r = await registrarPagoAnticipado({
      entityId: f.entityId, kind: 'deferred_revenue', descripcion: 'Soporte anual', importe: '120000',
      inicio: '2026-03-20', fin: '2027-03-19', origen: 'cfdi', sourceJournalEntryId: invoiceEntry, createdBy: f.userId,
    });
    scheduleId = r.anticipo.id;
    expect(r.anticipo.kind).toBe('deferred_revenue');
    expect(r.anticipo.prepaid_account_id).toBe(f.roles.ingreso_cobrado_por_anticipado);
    expect(r.anticipo.expense_account_id).toBe(f.roles.ingreso);
    expect(r.anticipo.amortization_convention).toBe('proporcional_dias');
    expect(r.calendario).toHaveLength(13);
    expect(r.calendario[0].amortization_amount).toBe('3945.2055');
    expect(r.calendario[12].amortization_amount).toBe('6246.5754');
    // `prepaid list` reads prepaids only.
    expect((await anticiposActivos(f.entityId)).map((a) => a.id)).not.toContain(scheduleId);
  });
});

describe('the run recognizes the month, once', () => {
  it('March posts DR 2158 / CR revenue for 3 945.2055, with no IVA line', async () => {
    enterTenant(f.tenantId);
    const r = await runMonthlyDeferredRevenue(f.entityId, f.periodos[3], f.userId);
    expect(r).toMatchObject({ processed: 1, total: '3945.2055', errors: [] });
    const rows = await recognitionOf(f.periodos[3]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ amount: '3945.2055', lines: '2', source_type: 'deferred_revenue_recognition' });
    expect(await creditBalance(f.entityId, f.roles.ingreso)).toBe('3945.2055');
    expect(await creditBalance(f.entityId, f.roles.ingreso_cobrado_por_anticipado)).toBe('116054.7945');
  });

  it('a second run of March posts nothing, and the prepaid run does not touch it', async () => {
    enterTenant(f.tenantId);
    expect(await runMonthlyDeferredRevenue(f.entityId, f.periodos[3], f.userId)).toMatchObject({ processed: 0, skipped: 1 });
    expect(await runMonthlyAmortization(f.entityId, f.periodos[4], f.userId)).toMatchObject({ processed: 0, skipped: 0 });
    expect((await recognitionOf(f.periodos[3])).rows).toHaveLength(1);
    expect((await recognitionOf(f.periodos[4])).rows).toHaveLength(0);
  });

  it('April to December leave 25 643.8357 on the liability', async () => {
    enterTenant(f.tenantId);
    for (let m = 4; m <= 12; m++) {
      const r = await runMonthlyDeferredRevenue(f.entityId, f.periodos[m], f.userId);
      expect(r.errors).toEqual([]);
      expect(r.processed).toBe(1);
    }
    expect(await creditBalance(f.entityId, f.roles.ingreso)).toBe('94356.1643');
    expect(await creditBalance(f.entityId, f.roles.ingreso_cobrado_por_anticipado)).toBe('25643.8357');
    expect((await recognitionOf(f.periodos[4])).rows[0].amount).toBe('9863.0137');
    expect((await recognitionOf(f.periodos[5])).rows[0].amount).toBe('10191.7808');
  });

  it('a reversed month is recognized again', async () => {
    enterTenant(f.tenantId);
    const april = (await recognitionOf(f.periodos[4])).rows[0];
    await reverseJournalEntry(april.id, f.userId, { reason: 'test', reversalDate: utc('2026-04-30') });
    const r = await runMonthlyDeferredRevenue(f.entityId, f.periodos[4], f.userId);
    expect(r).toMatchObject({ processed: 1, total: '9863.0137' });
    expect(await creditBalance(f.entityId, f.roles.ingreso_cobrado_por_anticipado)).toBe('25643.8357');
  });
});
