import { describe, it, expect, afterAll } from 'vitest';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { softClosePeriod, hardClosePeriod } from '../../src/services/accounting/period-close.js';
import {
  createFiscalYear,
  reopenClosedPeriod,
} from '../../src/services/accounting/fiscal-calendar-service.js';
import { runLedgerChecks } from '../../src/services/accounting/ledger-checks.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// MNE-001-048 · REOPEN, CORRECT, CLOSE AGAIN: THE CARRY GOES ALL THE WAY (#99)
//
// The carry-forward used to rewrite ONE period: re-closing June left July at
// the corrected figure and August, September and the rest still opening at
// the old one, while the chain check the close runs only looked at the link
// touching June. And its upsert had no guard on the target's status, so it
// rewrote a 'locked' period, whose figures have already left the system.
// ============================================================

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

async function entry(f: Fixture, date: string, debit: string, credit: string, amount: string) {
  return createJournalEntry(
    f.entityId, date, JournalEntryType.STANDARD, 'movement',
    [
      { account_id: debit, debit_amount: amount, credit_amount: null, description: 'debit' },
      { account_id: credit, debit_amount: null, credit_amount: amount, description: 'credit' },
    ],
    f.userId, { autoPost: true }
  );
}

async function beginning(accountId: string, periodId: string): Promise<string | null> {
  const r = await query<{ b: string }>(
    `SELECT beginning_balance::text AS b FROM account_balances
      WHERE account_id = $1 AND fiscal_period_id = $2`,
    [accountId, periodId]
  );
  return r.rows[0]?.b ?? null;
}

async function close(f: Fixture, periodId: string) {
  await softClosePeriod(periodId, f.entityId, f.userId);
  return hardClosePeriod(periodId, f.entityId, f.userId, 'close');
}

/**
 * June books an asset of 100 000 (1111 against 2140: not control accounts,
 * whose subledger a hand entry would break), and June, July and August are
 * hard closed in order. Then June is reopened and 3 000 of it is cancelled.
 */
async function juneCorrectedAfterAugust(name: string): Promise<Fixture> {
  const f = await crearInquilino(name);
  enterTenant(f.tenantId);
  await entry(f, '2026-06-10', f.cuentas['1111'], f.cuentas['2140'], '100000.0000');
  for (const m of [6, 7, 8]) await close(f, f.periodos[m]);
  expect(await beginning(f.cuentas['1111'], f.periodos[8])).toBe('100000.0000');

  const { previousStatus } = await reopenClosedPeriod(
    f.entityId, f.periodos[6], f.userId, 'part of the asset never existed'
  );
  expect(previousStatus).toBe('hard_close');
  await entry(f, '2026-06-20', f.cuentas['2140'], f.cuentas['1111'], '3000.0000');
  return f;
}

describe('re-closing June carries the correction down every hard-closed month', () => {
  it('July, August and the open September all open at 97 000, and the chain check is green', async () => {
    const f = await juneCorrectedAfterAugust('048 cascade');
    const closed = await close(f, f.periodos[6]);

    for (const m of [7, 8, 9]) {
      expect(await beginning(f.cuentas['1111'], f.periodos[m]), `period ${m}`).toBe('97000.0000');
      expect(await beginning(f.cuentas['2140'], f.periodos[m]), `period ${m}`).toBe('-97000.0000');
    }
    // September is open: its own close never carried, so October is not touched.
    expect(await beginning(f.cuentas['1111'], f.periodos[10])).toBeNull();
    expect(closed.carry_forward).toEqual({
      carried: 6,
      periods: ['Periodo 7/2026', 'Periodo 8/2026', 'Periodo 9/2026'],
      stopped_at_locked: null,
    });

    expect(await runLedgerChecks(f.entityId, ['balance'])).toEqual([]);
    // The bounded run the close itself uses, on the link it used to miss.
    expect(await runLedgerChecks(f.entityId, ['balance'], { period: 'Periodo 8/2026' })).toEqual([]);
  });
});

describe('a locked period stops the cascade', () => {
  it('is not rewritten, the close says so, and the chain check names the broken link', async () => {
    const f = await juneCorrectedAfterAugust('048 cascade stops at locked');
    // July is the very next period: the old upsert rewrote it without looking.
    await query(`UPDATE fiscal_periods SET status = 'locked' WHERE id = $1`, [f.periodos[7]]);

    const closed = await close(f, f.periodos[6]);

    expect(await beginning(f.cuentas['1111'], f.periodos[7])).toBe('100000.0000');
    expect(await beginning(f.cuentas['1111'], f.periodos[8])).toBe('100000.0000');
    expect(closed.carry_forward).toEqual({
      carried: 0,
      periods: [],
      stopped_at_locked: 'Periodo 7/2026',
    });

    const audit = await query<{ new_values: Record<string, unknown> }>(
      `SELECT new_values FROM audit_log
        WHERE entity_type = 'fiscal_period' AND entity_id = $1 AND action = 'close'
        ORDER BY timestamp DESC LIMIT 1`,
      [f.periodos[6]]
    );
    expect(audit.rows[0].new_values).toMatchObject({
      status: 'hard_close',
      carried_into: [],
      carry_stopped_at_locked: 'Periodo 7/2026',
    });

    const findings = await runLedgerChecks(f.entityId, ['balance'], { period: 'Periodo 7/2026' });
    expect(findings.map((x) => x.referencia)).toContain('1111 · Periodo 6/2026 → Periodo 7/2026');
  });
});

describe('the cascade follows the books order through period 13', () => {
  it('re-closing December reaches period 13 and the next January, and the chain is checked in that order', async () => {
    const f = await crearInquilino('048 cascade through period 13');
    enterTenant(f.tenantId);
    await createFiscalYear(f.entityId, 2025, new Date('2026-09-28T12:00:00Z'));
    const r = await query<{ period_number: number; id: string }>(
      `SELECT fp.period_number, fp.id FROM fiscal_periods fp
         JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
        WHERE fp.entity_id = $1 AND fy.year_number = 2025 AND fp.period_number IN (12, 13)`,
      [f.entityId]
    );
    const p = new Map(r.rows.map((x) => [x.period_number, x.id]));
    const december = p.get(12)!;
    const period13 = p.get(13)!;
    const january = f.periodos[1];

    await entry(f, '2025-12-10', f.cuentas['1111'], f.cuentas['2140'], '5000.0000');
    await close(f, december);
    // A year-end adjustment: with December sealed, December 31 lands in period 13.
    const adj = await entry(f, '2025-12-31', f.cuentas['1111'], f.cuentas['2140'], '200.0000');
    expect(adj.fiscal_period_id).toBe(period13);
    await close(f, period13);
    expect(await beginning(f.cuentas['1111'], january)).toBe('5200.0000');

    await reopenClosedPeriod(f.entityId, december, f.userId, 'December overstated the asset');
    await entry(f, '2025-12-15', f.cuentas['2140'], f.cuentas['1111'], '1000.0000');
    const closed = await close(f, december);

    expect(await beginning(f.cuentas['1111'], period13)).toBe('4000.0000');
    expect(await beginning(f.cuentas['1111'], january)).toBe('4200.0000');
    expect(closed.carry_forward?.periods).toHaveLength(2);
    // December closes at 4 000 and January opens at 4 200 on purpose: the
    // link to check runs through period 13, not straight to January.
    expect(await runLedgerChecks(f.entityId, ['balance'])).toEqual([]);
  });
});
