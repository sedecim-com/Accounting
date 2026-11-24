import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { query, withTransaction, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import {
  softClosePeriod,
  hardClosePeriod,
  getPeriodCloseStatus,
  staleOpenings,
} from '../../src/services/accounting/period-close.js';
import { createFiscalYear } from '../../src/services/accounting/fiscal-calendar-service.js';
import { runLedgerChecks } from '../../src/services/accounting/ledger-checks.js';
import { registerYearCommand } from '../../src/cli/period-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// MNE-001-645 · THE YEAR THAT WAS CREATED WITHOUT OPENING BALANCES (#594)
//
// Before MNE-001-644, a year created after its predecessor was sealed was
// born with no beginning balances, and its January could not close. 644 made
// the creation carry; this is the command for the database that already has
// such a year: `year carry-forward run <year>` runs the same carry on it.
// The leaf runs in-process against Postgres, as the binary would.
//
// The broken state is built here the way that code built it (the rows of the
// year, no carry), with a movement already posted in January. Figures by hand:
//
//   2027-03-10  sale   1111 10 000 Dr   4100 10 000 Cr
//   2027-06-15  cost   5100  4 000 Dr   2140  4 000 Cr      (profit 6 000 → 3300)
//   2028-01-10  move   1111    500 Dr   2140    500 Cr
//
// Ledger sign, debit positive. January 2028, broken and then repaired, as
// beginning / debit / credit / ending:
//
//   1111   0 / 500 / 0 /  500     →   10 000 / 500 / 0 / 10 500
//   2140   0 / 0 / 500 / −500     →   −4 000 / 0 / 500 / −4 500
//   3300   no row                 →   −6 000 / 0 / 0 /  −6 000
//
// The repaired January is compared, column by column, with the January of a
// second tenant whose 2028 was created after the seal by today's code.
// ============================================================

const SEALED = 2027;
const NEXT = 2028;
/** Both years are over on this date, so every period is born open. */
const NOW = new Date('2029-02-01T12:00:00Z');
const P13 = `Year-end adjustments ${SEALED}`;
const JANUARY = `January ${NEXT}`;

const CORRECTIONS = [
  { code: '1111', before: '0.0000', after: '10000.0000' },
  { code: '2140', before: '0.0000', after: '-4000.0000' },
  { code: '3300', before: '0.0000', after: '-6000.0000' },
];
const BROKEN = {
  '1111': ['0.0000', '500.0000', '0.0000', '500.0000'],
  '2140': ['0.0000', '0.0000', '500.0000', '-500.0000'],
};
const REPAIRED = {
  '1111': ['10000.0000', '500.0000', '0.0000', '10500.0000'],
  '2140': ['-4000.0000', '0.0000', '500.0000', '-4500.0000'],
  '3300': ['-6000.0000', '0.0000', '0.0000', '-6000.0000'],
};

const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

interface Ran {
  /** The exit code the binary would end with. */
  exit: number;
  /** The row of `--json`, or null when the command refused. */
  row: Record<string, unknown> | null;
  /** The refusal: its code and what the person reads. */
  refusal: { code: string | undefined; message: string } | null;
}

/** Runs `year carry-forward run <year> --json` as the binary would. */
async function carryForward(f: Fixture, year: number, flags: string[] = []): Promise<Ran> {
  const out: string[] = [];
  const errors: unknown[] = [];
  let exit = -1;
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    resetDeclarations();
    const program = new Command('mnemosine');
    registerYearCommand(program, {
      palette: plain,
      shutdown: (code: number) => { exit = code; },
      reportError: (e: unknown) => { errors.push(e); },
    });
    await program.parseAsync([
      'node', 'mnemosine', 'year', 'carry-forward', 'run', String(year),
      '-e', f.entityId, '-t', f.tenantId, '--json', ...flags,
    ]);
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
  const refused = errors[0] as
    | (Error & { code?: string; detail?: { code?: string }; localized?: () => string })
    | undefined;
  return {
    exit,
    row: refused ? null : (JSON.parse(out.join('')) as { rows: Record<string, unknown>[] }).rows[0],
    refusal: refused
      ? { code: refused.detail?.code ?? refused.code, message: refused.localized?.() ?? refused.message }
      : null,
  };
}

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

/** One period's balance rows by account code: beginning, debit, credit, ending. */
async function balances(f: Fixture, periodId: string): Promise<Record<string, string[]>> {
  const r = await query<{ code: string; b: string; d: string; c: string; e: string }>(
    `SELECT a.code, ab.beginning_balance::text AS b, ab.debit_total::text AS d,
            ab.credit_total::text AS c, ab.ending_balance::text AS e
       FROM account_balances ab JOIN accounts a ON a.id = ab.account_id
      WHERE ab.entity_id = $1 AND ab.fiscal_period_id = $2`,
    [f.entityId, periodId]
  );
  return Object.fromEntries(r.rows.map((x) => [x.code, [x.b, x.d, x.c, x.e]]));
}

/**
 * Everything the command could reach and must leave alone unless it says
 * otherwise: every balance row of the books with its timestamp, every period,
 * every entry and every line, and the audit rows of the fiscal periods.
 */
async function theBooks(f: Fixture): Promise<Record<string, unknown[]>> {
  enterTenant(f.tenantId);
  const rows = async (text: string) => (await query(text, [f.entityId])).rows;
  return {
    balances: await rows(
      `SELECT account_id, fiscal_period_id, beginning_balance::text, debit_total::text,
              credit_total::text, ending_balance::text, updated_at
         FROM account_balances WHERE entity_id = $1 ORDER BY fiscal_period_id, account_id`
    ),
    periods: await rows(
      'SELECT id, status, updated_at, hard_close_date FROM fiscal_periods WHERE entity_id = $1 ORDER BY id'
    ),
    entries: await rows(
      'SELECT id, status, entry_date, total_debits::text, created_at, posted_by FROM journal_entries WHERE entity_id = $1 ORDER BY id'
    ),
    lines: await rows(
      `SELECT jel.id, jel.account_id, jel.debit_amount::text, jel.credit_amount::text
         FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 ORDER BY jel.id`
    ),
    audit: await rows(
      `SELECT id FROM audit_log WHERE legal_entity_id = $1 AND entity_type = 'fiscal_period' ORDER BY id`
    ),
  };
}

async function bookAndSeal(f: Fixture): Promise<void> {
  await createFiscalYear(f.entityId, SEALED, NOW);
  await entry(f, `${SEALED}-03-10`, '1111', '4100', '10000.0000');
  await entry(f, `${SEALED}-06-15`, '5100', '2140', '4000.0000');
  const periods = await periodsOf(f, SEALED);
  for (let n = 1; n <= 13; n++) {
    await softClosePeriod(periods.get(n)!, f.entityId, f.userId);
    await hardClosePeriod(periods.get(n)!, f.entityId, f.userId, 'year-end close');
  }
}

/**
 * The year as the code before MNE-001-644 created it: its row and its
 * thirteen periods, every one open, and no carry from the sealed year.
 */
async function createYearWithoutCarry(f: Fixture, year: number): Promise<void> {
  await withTransaction(async (client) => {
    const fy = await client.query<{ id: string }>(
      `INSERT INTO fiscal_years (entity_id, year_number, start_date, end_date, is_calendar_year, status)
       VALUES ($1, $2, make_date($2, 1, 1), make_date($2, 12, 31), true, 'open') RETURNING id`,
      [f.entityId, year]
    );
    await client.query(
      `INSERT INTO fiscal_periods (entity_id, fiscal_year_id, period_number, period_name,
                                   start_date, end_date, period_type, status)
       SELECT $1::uuid, $2::uuid, m, trim(to_char(make_date($3, m, 1), 'Month')) || ' ' || $3::text,
              make_date($3, m, 1), (make_date($3, m, 1) + interval '1 month' - interval '1 day')::date, 'regular', 'open'
         FROM generate_series(1, 12) AS m
       UNION ALL
       SELECT $1::uuid, $2::uuid, 13, 'Year-end adjustments ' || $3::text,
              make_date($3, 12, 31), make_date($3, 12, 31), 'adjustment', 'open'`,
      [f.entityId, fy.rows[0].id, year]
    );
  });
}

async function setStatus(f: Fixture, periodId: string, status: string): Promise<void> {
  enterTenant(f.tenantId);
  await query('UPDATE fiscal_periods SET status = $3 WHERE id = $1 AND entity_id = $2', [periodId, f.entityId, status]);
}

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('a year created without opening balances, with a movement already posted in January', () => {
  let f: Fixture;
  let january: string;
  let february: string;
  let broken: Record<string, unknown[]>;
  let afterFirst: Record<string, unknown[]>;

  beforeAll(async () => {
    f = await crearInquilino('645 repaired');
    enterTenant(f.tenantId);
    await bookAndSeal(f);
    await createYearWithoutCarry(f, NEXT);
    await entry(f, `${NEXT}-01-10`, '1111', '2140', '500.0000');
    const next = await periodsOf(f, NEXT);
    january = next.get(1)!;
    february = next.get(2)!;
    broken = await theBooks(f);
  }, 300_000);

  it('the state is the broken one: January begins at zero and its own close is blocked', async () => {
    enterTenant(f.tenantId);
    expect(await balances(f, january)).toEqual(BROKEN);
    expect((await getPeriodCloseStatus(january, f.entityId)).can_close).toBe(false);
    expect(await staleOpenings(f.entityId, january)).toEqual([
      { code: '1111', carried: '0.0000', ledger: '10000.0000', difference: '-10000.0000' },
      { code: '2140', carried: '0.0000', ledger: '-4000.0000', difference: '4000.0000' },
      // 3300 has no row in January at all: the absence reads as a bare 0.
      { code: '3300', carried: '0', ledger: '-6000.0000', difference: '6000.0000' },
    ]);
  });

  it.each(['hard_close', 'locked'])('refuses while January is %s, naming it, and writes nothing', async (status) => {
    await setStatus(f, january, status);
    try {
      const sealed = await theBooks(f);
      for (const flags of [['--dry-run'], []]) {
        const ran = await carryForward(f, NEXT, flags);
        expect(ran.exit).toBe(5);
        expect(ran.refusal?.code).toBe('CARRY_TARGET_SEALED');
        expect(ran.refusal?.message).toContain(`${JANUARY} is '${status}'`);
      }
      // The cascade a hard-closed January sends into February went back with the rest.
      expect(await theBooks(f)).toEqual(sealed);
      expect(await balances(f, february)).toEqual({});
    } finally {
      await setStatus(f, january, 'open');
    }
  });

  it('--dry-run shows the three corrections and writes nothing, not even the audit row', async () => {
    const before = await theBooks(f);
    const ran = await carryForward(f, NEXT, ['--dry-run']);

    expect(ran).toEqual({
      exit: 0,
      refusal: null,
      row: {
        year_number: NEXT, period: JANUARY, carried_from: P13,
        status: 'would_correct', accounts: 3, corrections: CORRECTIONS,
      },
    });
    expect(await theBooks(f)).toEqual(before);
    expect(await balances(f, january)).toEqual(BROKEN);
  });

  it('the first run corrects the beginning of each account and moves its ending by the same difference', async () => {
    const ran = await carryForward(f, NEXT);
    afterFirst = await theBooks(f);

    expect(ran).toEqual({
      exit: 0,
      refusal: null,
      row: {
        year_number: NEXT, period: JANUARY, carried_from: P13,
        status: 'corrected', accounts: 3, corrections: CORRECTIONS,
      },
    });
    expect(await balances(f, january)).toEqual(REPAIRED);
    // Only January was written: the cascade stops at a period that is not sealed.
    expect(await balances(f, february)).toEqual({});
  });

  it('nothing posted was created or edited, and nothing of the sealed year changed', () => {
    expect(afterFirst.entries).toEqual(broken.entries);
    expect(afterFirst.lines).toEqual(broken.lines);
    expect(afterFirst.periods).toEqual(broken.periods);
    const outsideJanuary = (rows: unknown[]) =>
      rows.filter((row) => (row as { fiscal_period_id: string }).fiscal_period_id !== january);
    expect(outsideJanuary(afterFirst.balances)).toEqual(outsideJanuary(broken.balances));
  });

  it('it leaves one audit row: who, on which period, and each figure before and after', async () => {
    expect(afterFirst.audit).toHaveLength(broken.audit.length + 1);
    enterTenant(f.tenantId);
    const r = await query(
      `SELECT user_id, action, entity_id, old_values, new_values FROM audit_log
        WHERE legal_entity_id = $1 AND entity_type = 'fiscal_period' AND action = 'update'`,
      [f.entityId]
    );
    expect(r.rows).toEqual([{
      user_id: f.userId,
      action: 'update',
      entity_id: january,
      old_values: { beginning_balances: { '1111': '0.0000', '2140': '0.0000', '3300': '0.0000' } },
      new_values: {
        beginning_balances: { '1111': '10000.0000', '2140': '-4000.0000', '3300': '-6000.0000' },
        carried_from: P13,
        fiscal_year: NEXT,
      },
    }]);
  });

  it('a second run changes nothing and says so: no row is touched and no second audit row is written', async () => {
    const ran = await carryForward(f, NEXT);

    expect(ran).toEqual({
      exit: 0,
      refusal: null,
      row: { year_number: NEXT, period: JANUARY, carried_from: P13, status: 'unchanged', accounts: 0, corrections: [] },
    });
    // updated_at included: the run is rolled back, not rewritten with the same figures.
    expect(await theBooks(f)).toEqual(afterFirst);
  });

  it('January is what a year created after the seal has, account by account and column by column', async () => {
    const reference = await crearInquilino('645 created after the seal');
    enterTenant(reference.tenantId);
    await bookAndSeal(reference);
    await createFiscalYear(reference.entityId, NEXT, NOW);
    await entry(reference, `${NEXT}-01-10`, '1111', '2140', '500.0000');
    const born = await balances(reference, (await periodsOf(reference, NEXT)).get(1)!);

    enterTenant(f.tenantId);
    const repaired = await balances(f, january);
    expect(Object.keys(repaired).sort()).toEqual(Object.keys(born).sort());
    for (const [code, columns] of Object.entries(born)) expect(repaired[code], code).toEqual(columns);
  }, 300_000);

  it('January closes now, February opens at the hand figures, and a run on the sealed January has nothing to correct', async () => {
    enterTenant(f.tenantId);
    expect((await getPeriodCloseStatus(january, f.entityId)).blocking_issues).toEqual([]);
    await softClosePeriod(january, f.entityId, f.userId);
    await hardClosePeriod(january, f.entityId, f.userId, 'close');
    expect(await balances(f, february)).toEqual({
      '1111': ['10500.0000', '0.0000', '0.0000', '10500.0000'],
      '2140': ['-4500.0000', '0.0000', '0.0000', '-4500.0000'],
      '3300': ['-6000.0000', '0.0000', '0.0000', '-6000.0000'],
    });
    expect(await runLedgerChecks(f.entityId, ['balance'])).toEqual([]);

    const sealed = await theBooks(f);
    const ran = await carryForward(f, NEXT);
    expect(ran.exit).toBe(0);
    expect(ran.row).toMatchObject({ period: JANUARY, status: 'unchanged', accounts: 0 });
    expect(await theBooks(f)).toEqual(sealed);
  }, 120_000);
});

describe('refusals that need nothing sealed', () => {
  let f: Fixture;
  let before: Record<string, unknown[]>;

  beforeAll(async () => {
    f = await crearInquilino('645 nothing sealed');
    enterTenant(f.tenantId);
    await createFiscalYear(f.entityId, SEALED, NOW);
    await createFiscalYear(f.entityId, NEXT, NOW);
    await entry(f, `${SEALED}-03-10`, '1111', '4100', '10000.0000');
    before = await theBooks(f);
  }, 120_000);

  it('refuses when the year before is not sealed, naming its last period and its status', async () => {
    for (const flags of [['--dry-run'], []]) {
      const ran = await carryForward(f, NEXT, flags);
      expect(ran.exit).toBe(5);
      expect(ran.refusal?.code).toBe('CARRY_SOURCE_NOT_SEALED');
      expect(ran.refusal?.message).toContain(`${P13} is 'open'`);
    }
    expect(await theBooks(f)).toEqual(before);
  });

  it('refuses the first year of the books: there is no period before it to carry from', async () => {
    enterTenant(f.tenantId);
    // The fixture created its own year, so the earliest one of the books is asked for.
    const earliest = await query<{ year_number: number }>(
      'SELECT min(year_number)::int AS year_number FROM fiscal_years WHERE entity_id = $1',
      [f.entityId]
    );
    const ran = await carryForward(f, earliest.rows[0].year_number);
    expect(ran.exit).toBe(4);
    expect(ran.refusal?.code).toBe('CARRY_SOURCE_MISSING');
    expect(await theBooks(f)).toEqual(before);
  });

  it('a year that does not exist is not found', async () => {
    const ran = await carryForward(f, 2099);
    expect(ran.exit).toBe(3);
    expect(ran.refusal?.code).toBe('RESOURCE_NOT_FOUND');
  });
});
