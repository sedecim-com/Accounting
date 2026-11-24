import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { query, withTransaction, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import {
  softClosePeriod,
  hardClosePeriod,
  getPeriodCloseStatus,
  carryForwardBalances,
} from '../../src/services/accounting/period-close.js';
import {
  createFiscalYear,
  type EnsureFiscalYearResult,
} from '../../src/services/accounting/fiscal-calendar-service.js';
import { runLedgerChecks } from '../../src/services/accounting/ledger-checks.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// MNE-001-644 · A YEAR CREATED AFTER THE PREVIOUS ONE WAS SEALED (#594)
//
// The carry-forward ran from one side only: the hard close seeded the next
// period, and when the next year did not exist yet it seeded nothing. Creating
// the year afterwards did not carry either, so January opened with no
// beginning balances and its own close was blocked («1111 carried 0.0000,
// ledger 10000.0000»). Sealing December before creating the new year is the
// order of a firm that closes on time.
//
// Both orders are run here, each on its own tenant, and compared account by
// account. The figures are by hand:
//
//   2027-03-10  sale   1111 10 000 Dr   4100 10 000 Cr
//   2027-06-15  cost   5100  4 000 Dr   2140  4 000 Cr
//
// The year's result, 6 000 of profit, is swept by the annual close into 3300
// (the panel default). In the ledger's sign, debit positive, January 2028
// opens with 1111 at 10 000, 2140 at −4 000 and 3300 at −6 000, and with
// nothing else: 4100 and 5100 closed at zero and result accounts do not carry.
// ============================================================

const SEALED = 2027;
const NEXT = 2028;
/** Both years are over on this date, so every period is born open. */
const NOW = new Date('2029-02-01T12:00:00Z');

const OPENINGS = { '1111': '10000.0000', '2140': '-4000.0000', '3300': '-6000.0000' };

async function entry(f: Fixture, date: string, debit: string, credit: string, amount: string) {
  return createJournalEntry(
    f.entityId, date, JournalEntryType.STANDARD, 'movement',
    [
      { account_id: f.cuentas[debit], debit_amount: amount, credit_amount: null, description: 'debit' },
      { account_id: f.cuentas[credit], debit_amount: null, credit_amount: amount, description: 'credit' },
    ],
    f.userId, { autoPost: true }
  );
}

/** Period ids of one year by period number, 1 to 13. */
async function periodsOf(f: Fixture, year: number): Promise<Map<number, string>> {
  const r = await query<{ period_number: number; id: string }>(
    `SELECT fp.period_number, fp.id FROM fiscal_periods fp
       JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
      WHERE fp.entity_id = $1 AND fy.year_number = $2`,
    [f.entityId, year]
  );
  return new Map(r.rows.map((p) => [p.period_number, p.id]));
}

/** The beginning balances of one period, by account code. */
async function openings(f: Fixture, periodId: string): Promise<Record<string, string>> {
  const r = await query<{ code: string; b: string }>(
    `SELECT a.code, ab.beginning_balance::text AS b
       FROM account_balances ab JOIN accounts a ON a.id = ab.account_id
      WHERE ab.entity_id = $1 AND ab.fiscal_period_id = $2`,
    [f.entityId, periodId]
  );
  return Object.fromEntries(r.rows.map((x) => [x.code, x.b]));
}

async function bookTheYear(f: Fixture): Promise<void> {
  await entry(f, `${SEALED}-03-10`, '1111', '4100', '10000.0000');
  await entry(f, `${SEALED}-06-15`, '5100', '2140', '4000.0000');
}

/** Seals the thirteen periods in order: the year itself ends up 'closed'. */
async function sealTheYear(f: Fixture, periods: Map<number, string>): Promise<void> {
  for (let n = 1; n <= 13; n++) {
    await softClosePeriod(periods.get(n)!, f.entityId, f.userId);
    await hardClosePeriod(periods.get(n)!, f.entityId, f.userId, 'year-end close');
  }
  const y = await query<{ status: string }>(
    'SELECT status FROM fiscal_years WHERE entity_id = $1 AND year_number = $2',
    [f.entityId, SEALED]
  );
  expect(y.rows[0].status).toBe('closed');
}

/** Everything the sealed year holds: its periods and every balance row of them. */
async function sealedBooks(f: Fixture): Promise<unknown> {
  const periods = await query(
    `SELECT fp.id, fp.status, fp.updated_at, fp.hard_close_date FROM fiscal_periods fp
       JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
      WHERE fp.entity_id = $1 AND fy.year_number = $2 ORDER BY fp.period_number`,
    [f.entityId, SEALED]
  );
  const balances = await query(
    `SELECT ab.account_id, ab.fiscal_period_id, ab.beginning_balance::text, ab.debit_total::text,
            ab.credit_total::text, ab.ending_balance::text, ab.updated_at
       FROM account_balances ab
       JOIN fiscal_periods fp ON fp.id = ab.fiscal_period_id
       JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
      WHERE ab.entity_id = $1 AND fy.year_number = $2
      ORDER BY ab.fiscal_period_id, ab.account_id`,
    [f.entityId, SEALED]
  );
  const entries = await query<{ n: string }>(
    'SELECT count(*)::text AS n FROM journal_entries WHERE entity_id = $1',
    [f.entityId]
  );
  return { periods: periods.rows, balances: balances.rows, entries: entries.rows[0].n };
}

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

let sealedFirst: Fixture;
let createdFirst: Fixture;
let januaryOfSealedFirst: Record<string, string>;
let januaryOfCreatedFirst: Record<string, string>;

describe('seal the year, then create the next one', () => {
  let next: Map<number, string>;
  let before: unknown;
  let created: EnsureFiscalYearResult;

  beforeAll(async () => {
    sealedFirst = await crearInquilino('644 seal then create');
    enterTenant(sealedFirst.tenantId);
    await createFiscalYear(sealedFirst.entityId, SEALED, NOW);
    await bookTheYear(sealedFirst);
    await sealTheYear(sealedFirst, await periodsOf(sealedFirst, SEALED));
    before = await sealedBooks(sealedFirst);

    created = await createFiscalYear(sealedFirst.entityId, NEXT, NOW);
    next = await periodsOf(sealedFirst, NEXT);
    januaryOfSealedFirst = await openings(sealedFirst, next.get(1)!);
  }, 300_000);

  it('January opens with the balances the sealed year closed with, and only balance-sheet accounts', () => {
    expect(januaryOfSealedFirst).toEqual(OPENINGS);
  });

  it('year create reports what it carried and from where', () => {
    expect(created.opening).toEqual({
      previous: { period_name: `Year-end adjustments ${SEALED}`, status: 'hard_close' },
      carry: { carried: 3, periods: [`January ${NEXT}`], stopped_at_locked: null },
    });
  });

  it('the carry wrote opening balances only: no entry was created and nothing of the sealed year changed', async () => {
    enterTenant(sealedFirst.tenantId);
    expect(await sealedBooks(sealedFirst)).toEqual(before);
    // Only January was seeded: the cascade stops at a period that is not sealed.
    expect(await openings(sealedFirst, next.get(2)!)).toEqual({});
  });

  it('January books a movement and its own close is not blocked; February opens at the hand figures', async () => {
    enterTenant(sealedFirst.tenantId);
    await entry(sealedFirst, `${NEXT}-01-10`, '1111', '2140', '500.0000');
    const status = await getPeriodCloseStatus(next.get(1)!, sealedFirst.entityId);
    expect(status.blocking_issues).toEqual([]);

    await softClosePeriod(next.get(1)!, sealedFirst.entityId, sealedFirst.userId);
    await hardClosePeriod(next.get(1)!, sealedFirst.entityId, sealedFirst.userId, 'close');
    // 10 000 + 500 and −4 000 − 500; 3300 did not move.
    expect(await openings(sealedFirst, next.get(2)!)).toEqual({
      '1111': '10500.0000', '2140': '-4500.0000', '3300': '-6000.0000',
    });
    expect(await runLedgerChecks(sealedFirst.entityId, ['balance'])).toEqual([]);
  }, 120_000);
});

describe('create the next year, then seal: the order that already worked', () => {
  let created: EnsureFiscalYearResult;

  beforeAll(async () => {
    createdFirst = await crearInquilino('644 create then seal');
    enterTenant(createdFirst.tenantId);
    await createFiscalYear(createdFirst.entityId, SEALED, NOW);
    created = await createFiscalYear(createdFirst.entityId, NEXT, NOW);
    await bookTheYear(createdFirst);
    await sealTheYear(createdFirst, await periodsOf(createdFirst, SEALED));
    const next = await periodsOf(createdFirst, NEXT);
    januaryOfCreatedFirst = await openings(createdFirst, next.get(1)!);
  }, 300_000);

  it('creating a year whose predecessor is still open carries nothing: its hard close will', () => {
    expect(created.opening).toEqual({
      previous: { period_name: `Year-end adjustments ${SEALED}`, status: 'open' },
      carry: null,
    });
  });

  it('January opens with the same figures as today', () => {
    expect(januaryOfCreatedFirst).toEqual(OPENINGS);
  });
});

describe('both orders', () => {
  it('give the same opening balances, account by account', () => {
    expect(Object.keys(januaryOfSealedFirst).sort()).toEqual(Object.keys(januaryOfCreatedFirst).sort());
    for (const [code, beginning] of Object.entries(januaryOfCreatedFirst)) {
      expect(januaryOfSealedFirst[code], code).toBe(beginning);
    }
  });
});

describe('a year created while its predecessor is being sealed', () => {
  it('waits for the seal and then carries: neither of the two misses the other', async () => {
    const f = await crearInquilino('644 create during the seal');
    enterTenant(f.tenantId);
    await createFiscalYear(f.entityId, SEALED, NOW);
    const periods = await periodsOf(f, SEALED);
    const period13 = periods.get(13)!;
    await entry(f, `${SEALED}-12-10`, '1111', '2140', '700.0000');
    await softClosePeriod(periods.get(12)!, f.entityId, f.userId);
    await hardClosePeriod(periods.get(12)!, f.entityId, f.userId, 'close');

    // The seal of period 13, in flight: its row is locked, as the hard close
    // locks it from its first statement, its carry found no next period, and
    // it has not committed.
    let commitTheSeal!: () => void;
    const untilTold = new Promise<void>((resolve) => { commitTheSeal = resolve; });
    let sealIsInFlight!: () => void;
    const inFlight = new Promise<void>((resolve) => { sealIsInFlight = resolve; });
    const seal = withTransaction(async (client) => {
      await client.query(
        'SELECT id FROM fiscal_periods WHERE id = $1 AND entity_id = $2 FOR UPDATE',
        [period13, f.entityId]
      );
      expect((await carryForwardBalances(client, f.entityId, period13)).periods).toEqual([]);
      sealIsInFlight();
      await untilTold;
      await client.query(
        `UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1 AND entity_id = $2`,
        [period13, f.entityId]
      );
    });
    await inFlight;

    let born = false;
    const creation = createFiscalYear(f.entityId, NEXT, NOW).then((result) => {
      born = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    // Without the lock the year is born here, reads «open» and carries nothing.
    expect(born).toBe(false);

    commitTheSeal();
    await seal;
    const created = await creation;
    expect(created.opening).toEqual({
      previous: { period_name: `Year-end adjustments ${SEALED}`, status: 'hard_close' },
      carry: { carried: 2, periods: [`January ${NEXT}`], stopped_at_locked: null },
    });
    const january = (await periodsOf(f, NEXT)).get(1)!;
    expect(await openings(f, january)).toEqual({ '1111': '700.0000', '2140': '-700.0000' });
  }, 120_000);
});
