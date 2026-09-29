import { describe, it, expect, afterAll } from 'vitest';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import {
  getPeriodCloseStatus,
  hardClosePeriod,
  softClosePeriod,
} from '../../src/services/accounting/period-close.js';
import { explainCloseCheck } from '../../src/services/accounting/close-explain.js';
import {
  createFiscalYear,
  listFiscalYears,
  reopenClosedPeriod,
  restorePeriodStatus,
} from '../../src/services/accounting/fiscal-calendar-service.js';
import { runLedgerChecks } from '../../src/services/accounting/ledger-checks.js';
import { conductClose } from '../../src/services/accounting/closing-conductor.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { JournalEntryType } from '../../src/types/index.js';
import type { ClosablePeriod } from '../../src/ai/close-service.js';

// ============================================================
// MNE-001-049 · THE CLOSE TELLS THE TRUTH ABOUT ITSELF (#99)
//
// Four things the close said about itself that were not so: the
// trial-balance box could only ever pass, `closing explain` answered «nothing
// to explain» over a box the checklist had just marked ✘, a fiscal year
// sealed to its last period still read 'open', and `closing run` stopped at
// the soft close, so a month conducted to the end never carried its balances.
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

async function close(f: Fixture, periodId: string) {
  await softClosePeriod(periodId, f.entityId, f.userId);
  return hardClosePeriod(periodId, f.entityId, f.userId, 'close');
}

const box = (s: Awaited<ReturnType<typeof getPeriodCloseStatus>>, code: string) =>
  s.checklist.find((c) => c.codigo === code)!;

describe('the trial-balance box reads the beginnings the carry left', () => {
  it('a correction the carry did not reach blocks the next close while ledger-integrity stays green', async () => {
    const f = await crearInquilino('049 stale opening');
    enterTenant(f.tenantId);
    // 1111 against 2140: not control accounts, whose subledger a hand entry would break.
    await entry(f, '2026-05-10', f.cuentas['1111'], f.cuentas['2140'], '100000.0000');
    for (const m of [5, 6]) await close(f, f.periodos[m]);
    // May reopened and corrected, then closed again the old way: soft only.
    await reopenClosedPeriod(f.entityId, f.periodos[5], f.userId, 'part of the asset never existed');
    await entry(f, '2026-05-20', f.cuentas['2140'], f.cuentas['1111'], '3000.0000');
    await softClosePeriod(f.periodos[5], f.entityId, f.userId);

    const july = await getPeriodCloseStatus(f.periodos[7], f.entityId);
    expect(box(july, 'trial-balance')).toMatchObject({ is_complete: false, severity: 'blocking' });
    expect(box(july, 'trial-balance').details).toContain('1111 carried 100000.0000, ledger 97000.0000');
    expect(july.can_close).toBe(false);
    // The stale carry agrees with itself link by link: the chain check cannot see it.
    expect(box(july, 'ledger-integrity').is_complete).toBe(true);

    const explained = await explainCloseCheck(f.entityId, f.periodos[7], 'trial-balance');
    expect(explained.total).toBe(2);
    expect(explained.renglones).toContainEqual({
      account: '1111', carried_opening: '100000.0000', ledger_opening: '97000.0000', difference: '3000.0000',
    });
    expect(explained.remedio).toMatch(/^mnemosine close --period <period> --hard/);

    // Sealing May carries the correction down to July, and the box is green again.
    await hardClosePeriod(f.periodos[5], f.entityId, f.userId, 'sealed after the correction');
    expect(box(await getPeriodCloseStatus(f.periodos[7], f.entityId), 'trial-balance').is_complete).toBe(true);
    expect(await runLedgerChecks(f.entityId, ['balance'])).toEqual([]);
  });
});

describe('closing explain never says «nothing to explain» over a ✘', () => {
  it('every red box of an empty entity has at least one row, in the box’s own words', async () => {
    const f = await crearInquilino('049 vacuous boxes');
    enterTenant(f.tenantId);
    const status = await getPeriodCloseStatus(f.periodos[1], f.entityId);
    const red = status.checklist.filter((c) => !c.is_complete);
    // No fixed asset and no account with movement: the two boxes red by vacuity.
    expect(red.map((c) => c.codigo)).toEqual(expect.arrayContaining(['depreciation-posted', 'sat-agrupador-missing']));

    for (const c of red) {
      const explained = await explainCloseCheck(f.entityId, f.periodos[1], c.codigo);
      expect(explained.total, c.codigo).toBeGreaterThan(0);
      expect(explained.renglones, c.codigo).toEqual([{ finding: c.details }]);
    }
    const green = status.checklist.find((c) => c.is_complete)!;
    expect((await explainCloseCheck(f.entityId, f.periodos[1], green.codigo)).total).toBe(0);
  });
});

describe('the fiscal year closes with its last period', () => {
  it('twelve locked months and period 13 sealed: the year reads closed, and a reopen opens it again', async () => {
    const f = await crearInquilino('049 fiscal year closed');
    enterTenant(f.tenantId);
    await createFiscalYear(f.entityId, 2025, new Date('2026-09-29T12:00:00Z'));
    const r = await query<{ period_number: number; id: string }>(
      `SELECT fp.period_number, fp.id FROM fiscal_periods fp
         JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
        WHERE fp.entity_id = $1 AND fy.year_number = 2025`,
      [f.entityId]
    );
    const period13 = r.rows.find((x) => x.period_number === 13)!.id;
    await query(
      `UPDATE fiscal_periods SET status = 'locked' WHERE entity_id = $1 AND id <> $2
          AND fiscal_year_id = (SELECT fiscal_year_id FROM fiscal_periods WHERE id = $2)`,
      [f.entityId, period13]
    );
    const closedYears = async () => (await listFiscalYears(f.entityId, { status: 'closed' })).map((y) => y.year_number);
    expect(await closedYears()).toEqual([]);

    const sealed = await close(f, period13);
    expect(sealed.fiscal_year_closed).toBe(2025);
    expect(await closedYears()).toEqual([2025]);

    await reopenClosedPeriod(f.entityId, period13, f.userId, 'a late adjustment');
    expect(await closedYears()).toEqual([]);

    await restorePeriodStatus(f.entityId, period13, 'hard_close', f.userId, 'adjustment done');
    expect(await closedYears()).toEqual([2025]);
    const audit = await query<{ action: string; new_values: Record<string, unknown> }>(
      `SELECT action, new_values FROM audit_log
        WHERE entity_type = 'fiscal_period' AND entity_id = $1 ORDER BY timestamp`,
      [period13]
    );
    // soft close, hard close, reopen, restore: the year moves in the audit row of the act that moved it.
    expect(audit.rows.map((a) => [a.action, a.new_values.fiscal_year_closed ?? a.new_values.fiscal_year_reopened ?? null]))
      .toEqual([['close', null], ['close', 2025], ['reopen', 2025], ['close', 2025]]);
  });
});

describe('closing run ends with the hard close', () => {
  /** A tenant with its panel seeded, some months locked, and one month conducted to the end. */
  async function conductWith(name: string, locked: number[], month: number) {
    const f = await crearInquilino(name);
    enterTenant(f.tenantId);
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
    await query(`UPDATE fiscal_periods SET status = 'locked' WHERE id = ANY($1::uuid[])`, [locked.map((m) => f.periodos[m])]);
    const p = await query<ClosablePeriod>(
      `SELECT fp.id, fp.period_name, fp.period_number, fp.start_date::text, fp.end_date::text, fp.status,
              2026 AS year_number, false AS overdue
         FROM fiscal_periods fp WHERE fp.id = $1`,
      [f.periodos[month]]
    );
    const ctx = {
      entityId: f.entityId, entityName: name, tenantId: f.tenantId, currency: 'MXN',
      country: 'MX', accountingStandard: 'mx_nif', taxId: 'XAXX010101000',
    };
    const run = await conductClose(ctx as never, p.rows[0], { userId: f.userId });
    const status = await query<{ status: string }>('SELECT status FROM fiscal_periods WHERE id = $1', [f.periodos[month]]);
    return { f, run, seal: run.steps.find((x) => x.step === 'hard-close'), status: status.rows[0].status };
  }

  it('the last month of a year whose other months are locked: sealed, and the year closed', async () => {
    const { f, run, seal, status } = await conductWith('049 conductor seals the year', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 12);
    expect(run.status, JSON.stringify(run.steps, null, 2)).toBe('completed');
    expect(status).toBe('hard_close');
    expect(seal).toMatchObject({ status: 'done', processed: 1 });
    expect(seal?.detail).toBe('period hard-closed; balances carried into no period yet; fiscal year 2026 closed');
    expect((await listFiscalYears(f.entityId, { status: 'closed' })).map((y) => y.year_number)).toEqual([2026]);
  });

  it('a locked month after it stops the carry, and the step says so', async () => {
    const { run, seal, status } = await conductWith('049 conductor stops at locked', [12], 11);
    expect(run.status).toBe('completed');
    expect(status).toBe('hard_close');
    expect(seal?.detail).toBe(
      'period hard-closed; balances carried into no period yet; Periodo 12/2026 is locked and was NOT rewritten'
    );
  });
});
