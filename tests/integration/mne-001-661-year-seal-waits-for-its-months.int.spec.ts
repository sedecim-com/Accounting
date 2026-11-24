import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import {
  softClosePeriod, hardClosePeriod, getPeriodCloseStatus,
} from '../../src/services/accounting/period-close.js';
import { explainCloseCheck } from '../../src/services/accounting/close-explain.js';
import { createFiscalYear } from '../../src/services/accounting/fiscal-calendar-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { AccountingError } from '../../src/utils/errors.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// MNE-001-661 (#602) · THE ANNUAL SEAL WAITS FOR THE MONTHS OF ITS YEAR
//
// The order under test: the months are soft-closed, eleven of them are also
// hard-closed, and then the year's last period (13) is sealed. Sealing it
// posts the closing entries with what is posted at that moment, and a month
// that is only soft-closed still takes entries.
//
// Hand figures. March sale 10,000.00 (bank Dr / 4100 Cr); December cost
// 6,000.00 (5100 Dr / bank Cr). Result of the year: 10,000 − 6,000 = 4,000.00,
// swept to 3300 (the default destination) as a credit.
//
// The year is 2025, already over, so `createFiscalYear` gives thirteen open
// periods named «January 2025» … «December 2025» and «Year-end adjustments 2025».
// ============================================================

const YEAR = 2025;
const KEY = 'year_seal_with_unsealed_months';
const BOX = 'year-months-sealed';

interface BookedYear {
  f: Fixture;
  periods: Map<number, string>;
  yearId: string;
}

async function entry(f: Fixture, date: string, description: string, debit: string, credit: string, amount: string) {
  return createJournalEntry(
    f.entityId, date, JournalEntryType.STANDARD, description,
    [
      { account_id: debit, debit_amount: amount, credit_amount: null, description },
      { account_id: credit, debit_amount: null, credit_amount: amount, description },
    ],
    f.userId, { autoPost: true }
  );
}

/** A tenant with fiscal year 2025 booked, months 1–11 sealed, December and period 13 soft-closed. */
async function yearAtItsSeal(name: string, answer?: string): Promise<BookedYear> {
  const f = await crearInquilino(name);
  enterTenant(f.tenantId);
  await createFiscalYear(f.entityId, YEAR, new Date('2026-09-28T12:00:00Z'));
  const r = await query<{ period_number: number; id: string; fiscal_year_id: string }>(
    `SELECT fp.period_number, fp.id, fp.fiscal_year_id FROM fiscal_periods fp
       JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
      WHERE fp.entity_id = $1 AND fy.year_number = $2`,
    [f.entityId, YEAR]
  );
  const periods = new Map(r.rows.map((p) => [p.period_number, p.id]));
  if (answer !== undefined) {
    const ctx = { tenantId: f.tenantId, entityId: f.entityId };
    await seedPolicies(ctx);
    await resolvePolicy(ctx, KEY, answer, f.userId);
  }
  await entry(f, `${YEAR}-03-10`, 'March sale', f.roles.banco, f.cuentas['4100'], '10000.0000');
  await entry(f, `${YEAR}-12-10`, 'December cost', f.cuentas['5100'], f.roles.banco, '6000.0000');
  for (let month = 1; month <= 11; month++) {
    await softClosePeriod(periods.get(month)!, f.entityId, f.userId);
    await hardClosePeriod(periods.get(month)!, f.entityId, f.userId);
  }
  await softClosePeriod(periods.get(12)!, f.entityId, f.userId);
  await softClosePeriod(periods.get(13)!, f.entityId, f.userId);
  return { f, periods, yearId: r.rows[0].fiscal_year_id };
}

/** Debit minus credit of one account over the whole fiscal year. */
async function yearBalance(y: BookedYear, accountId: string): Promise<number> {
  const { rows } = await query<{ s: string }>(
    `SELECT COALESCE(SUM(ab.debit_total - ab.credit_total), 0)::text AS s
       FROM account_balances ab
       JOIN fiscal_periods fp ON fp.id = ab.fiscal_period_id
      WHERE ab.account_id = $1 AND ab.entity_id = $2 AND fp.fiscal_year_id = $3`,
    [accountId, y.f.entityId, y.yearId]
  );
  return Number(rows[0].s);
}

async function closingEntries(y: BookedYear): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM journal_entries
      WHERE entity_id = $1 AND entry_type = 'closing' AND status = 'posted'`,
    [y.f.entityId]
  );
  return Number(rows[0].n);
}

async function statusOf(y: BookedYear, periodNumber: number): Promise<string> {
  const { rows } = await query<{ status: string }>(
    'SELECT status FROM fiscal_periods WHERE id = $1 AND entity_id = $2',
    [y.periods.get(periodNumber), y.f.entityId]
  );
  return rows[0].status;
}

async function yearStatus(y: BookedYear): Promise<string> {
  const { rows } = await query<{ status: string }>(
    'SELECT status FROM fiscal_years WHERE id = $1 AND entity_id = $2',
    [y.yearId, y.f.entityId]
  );
  return rows[0].status;
}

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('with the default, the annual seal is refused while a month is only soft-closed', () => {
  let y: BookedYear;
  beforeAll(async () => {
    y = await yearAtItsSeal('MNE-001-661 default');
  }, 180_000);

  it('the soft close of period 13 went through: only the seal waits', async () => {
    expect(await statusOf(y, 13)).toBe('soft_close');
    expect(await statusOf(y, 12)).toBe('soft_close');
    expect(await statusOf(y, 11)).toBe('hard_close');
  });

  it('the checklist of period 13 carries the box, blocking, and names December', async () => {
    enterTenant(y.f.tenantId);
    const st = await getPeriodCloseStatus(y.periods.get(13)!, y.f.entityId);
    const box = st.checklist.find((c) => c.codigo === BOX);
    expect(box).toBeDefined();
    expect(box!.is_complete).toBe(false);
    expect(box!.severity).toBe('blocking');
    expect(box!.details).toContain('December 2025 (soft_close)');
    expect(st.can_close).toBe(false);
    expect(st.blocking_issues).toEqual([box!.details]);
    expect(st.unsealed_periods).toEqual([{ period_name: 'December 2025', status: 'soft_close' }]);
  });

  it('a month does not carry the box: it is the year\'s last period that sweeps', async () => {
    enterTenant(y.f.tenantId);
    const st = await getPeriodCloseStatus(y.periods.get(12)!, y.f.entityId);
    expect(st.checklist.some((c) => c.codigo === BOX)).toBe(false);
    expect(st.unsealed_periods).toBeUndefined();
  });

  it('`closing explain` lists the month with its status, and nothing on a monthly period', async () => {
    enterTenant(y.f.tenantId);
    const e = await explainCloseCheck(y.f.entityId, y.periods.get(13)!, BOX);
    expect(e.total).toBe(1);
    expect(e.renglones).toEqual([{ period_name: 'December 2025', status: 'soft_close' }]);
    expect(e.remedio).toMatch(/close --period .* --hard/);
    const month = await explainCloseCheck(y.f.entityId, y.periods.get(12)!, BOX);
    expect(month.total).toBe(0);
  });

  it('sealing period 13 is refused by key and names the month, in both languages', async () => {
    enterTenant(y.f.tenantId);
    let refusal: unknown;
    try {
      await hardClosePeriod(y.periods.get(13)!, y.f.entityId, y.f.userId, 'annual close');
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(AccountingError);
    const err = refusal as AccountingError;
    expect(err.code).toBe('YEAR_MONTHS_NOT_SEALED');
    expect(err.messageKey?.key).toBe('error.YEAR_MONTHS_NOT_SEALED');
    expect(err.message).toContain('December 2025 (soft_close)');
    expect(err.message).toContain(KEY);
    expect(err.localized('es')).toContain('December 2025 (soft_close)');
    expect(err.localized('es')).toContain('cierre duro');
    expect(err.details).toEqual({ unsealed_periods: [{ period_name: 'December 2025', status: 'soft_close' }] });
  });

  it('and nothing was sealed: period 13 is still soft-closed and the year is unswept', async () => {
    expect(await statusOf(y, 13)).toBe('soft_close');
    expect(await closingEntries(y)).toBe(0);
    expect(await yearBalance(y, y.f.cuentas['4100'])).toBe(-10000);
    expect(await yearBalance(y, y.f.cuentas['5100'])).toBe(6000);
    expect(await yearStatus(y)).toBe('open');
  });

  it('once December is hard-closed the seal goes through and sweeps 4,000.00 to 3300', async () => {
    enterTenant(y.f.tenantId);
    await hardClosePeriod(y.periods.get(12)!, y.f.entityId, y.f.userId);
    const sealed = await hardClosePeriod(y.periods.get(13)!, y.f.entityId, y.f.userId, 'annual close');
    expect(sealed.status).toBe('hard_close');
    expect(sealed.fiscal_year_closed).toBe(YEAR);
    expect(await yearBalance(y, y.f.cuentas['4100'])).toBe(0);
    expect(await yearBalance(y, y.f.cuentas['5100'])).toBe(0);
    expect(await yearBalance(y, y.f.cuentas['3300'])).toBe(-4000);
    expect(await yearStatus(y)).toBe('closed');
  });
});

describe('with accept_unsealed, the year is sealed as before and the checklist names the month', () => {
  let y: BookedYear;
  beforeAll(async () => {
    y = await yearAtItsSeal('MNE-001-661 accept', 'accept_unsealed');
  }, 180_000);

  it('the box is a warning that names December, and the checklist lets the seal through', async () => {
    enterTenant(y.f.tenantId);
    const st = await getPeriodCloseStatus(y.periods.get(13)!, y.f.entityId);
    const box = st.checklist.find((c) => c.codigo === BOX);
    expect(box).toBeDefined();
    expect(box!.is_complete).toBe(false);
    expect(box!.severity).toBe('warning');
    expect(box!.details).toContain('December 2025 (soft_close)');
    expect(st.can_close).toBe(true);
    expect(st.warnings.some((w) => w.includes('December 2025 (soft_close)'))).toBe(true);
  });

  it('sealing period 13 with December soft-closed goes through and sweeps 4,000.00 to 3300', async () => {
    enterTenant(y.f.tenantId);
    const sealed = await hardClosePeriod(y.periods.get(13)!, y.f.entityId, y.f.userId, 'annual close');
    expect(sealed.status).toBe('hard_close');
    expect(await closingEntries(y)).toBeGreaterThan(0);
    expect(await yearBalance(y, y.f.cuentas['4100'])).toBe(0);
    expect(await yearBalance(y, y.f.cuentas['5100'])).toBe(0);
    expect(await yearBalance(y, y.f.cuentas['3300'])).toBe(-4000);
    // December is not sealed, so the fiscal year does not read closed: as before.
    expect(sealed.fiscal_year_closed).toBeNull();
    expect(await statusOf(y, 12)).toBe('soft_close');
    expect(await yearStatus(y)).toBe('open');
  });
});

describe('the explicit default answers like no answer at all', () => {
  it('require_hard_close refuses the seal over a soft-closed December', async () => {
    const y = await yearAtItsSeal('MNE-001-661 explicit default', 'require_hard_close');
    await expect(hardClosePeriod(y.periods.get(13)!, y.f.entityId, y.f.userId, 'annual close'))
      .rejects.toMatchObject({ code: 'YEAR_MONTHS_NOT_SEALED' });
    expect(await closingEntries(y)).toBe(0);
  }, 180_000);
});
