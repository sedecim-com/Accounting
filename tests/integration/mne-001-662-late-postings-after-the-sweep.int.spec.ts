import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, acceptSealOverUnsealedMonths, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, reverseJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import {
  softClosePeriod, hardClosePeriod, getPeriodCloseStatus,
} from '../../src/services/accounting/period-close.js';
import { runLedgerChecks } from '../../src/services/accounting/ledger-checks.js';
import { explainCloseCheck } from '../../src/services/accounting/close-explain.js';
import { createFiscalYear, reopenClosedPeriod } from '../../src/services/accounting/fiscal-calendar-service.js';
import { AccountingError } from '../../src/utils/errors.js';
import { t } from '../../src/i18n/index.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// MNE-001-662 (#602) · WHAT IS POSTED TO A YEAR AFTER ITS SWEEP
//
// The order under test: the months are closed, the year's last period (13) is
// sealed, which sweeps the result into 3300, and then an income or an expense
// is posted to a month of that year that still takes entries. Nothing sweeps
// it: the sealed year's result no longer is the one in equity.
//
// Hand figures, the same year as MNE-001-661. March sale 10,000.00 (bank Dr /
// 4100 Cr); December cost 6,000.00 (5100 Dr / bank Cr). Result 4,000.00,
// swept to 3300 as a credit: 3300 = −4,000.00.
//   A (accept_unsealed): December stays soft-closed through the seal; a late
//     December sale of 1,500.00 (bank Dr / 4100 Cr). 4100 then carries
//     −1,500.00 in a sealed year. Its reversal brings it back to 0.
//   B (the default): every month hard-closed, the seal, then December is
//     reopened and takes a late cost of 800.00 (5100 Dr / bank Cr). Closing
//     period 13 again sweeps it: 5100 back to 0 and 3300 = −(4,000 − 800) =
//     −3,200.00.
//
// Fiscal year 2025 comes from `createFiscalYear` (thirteen periods); the
// fixture's 2026 follows it, so «Periodo 1/2026» is the period after the seal.
// ============================================================

const YEAR = 2025;
const CHECK = 'year-sweep';

interface Books {
  f: Fixture;
  periods: Map<number, string>;
  yearId: string;
  january: string;
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

/** 2025 booked and sealed. `december` says how December stands at the seal. */
async function sealedYear(name: string, december: 'soft' | 'hard'): Promise<Books> {
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
  if (december === 'soft') await acceptSealOverUnsealedMonths(f);
  await entry(f, `${YEAR}-03-10`, 'March sale', f.roles.banco, f.cuentas['4100'], '10000.0000');
  await entry(f, `${YEAR}-12-10`, 'December cost', f.cuentas['5100'], f.roles.banco, '6000.0000');
  for (let month = 1; month <= 12; month++) {
    await softClosePeriod(periods.get(month)!, f.entityId, f.userId);
    if (month < 12 || december === 'hard') await hardClosePeriod(periods.get(month)!, f.entityId, f.userId);
  }
  await softClosePeriod(periods.get(13)!, f.entityId, f.userId);
  await hardClosePeriod(periods.get(13)!, f.entityId, f.userId, 'annual close');
  return { f, periods, yearId: r.rows[0].fiscal_year_id, january: f.periodos[1] };
}

/** Debit minus credit of one account over the whole fiscal year. */
async function yearBalance(b: Books, accountId: string): Promise<number> {
  const { rows } = await query<{ s: string }>(
    `SELECT COALESCE(SUM(ab.debit_total - ab.credit_total), 0)::text AS s
       FROM account_balances ab
       JOIN fiscal_periods fp ON fp.id = ab.fiscal_period_id
      WHERE ab.account_id = $1 AND ab.entity_id = $2 AND fp.fiscal_year_id = $3`,
    [accountId, b.f.entityId, b.yearId]
  );
  return Number(rows[0].s);
}

async function refusalOf(p: Promise<unknown>): Promise<AccountingError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(AccountingError);
    return err as AccountingError;
  }
  throw new Error('expected a refusal');
}

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

describe('A · accept_unsealed: a sale posted to a soft-closed December after the seal', () => {
  let b: Books;
  let lateNumber: string;
  let lateId: string;
  beforeAll(async () => {
    b = await sealedYear('MNE-001-662 A', 'soft');
    const late = await entry(b.f, `${YEAR}-12-20`, 'Late December sale', b.f.roles.banco, b.f.cuentas['4100'], '1500.0000');
    lateNumber = late.entry_number;
    lateId = late.id;
  }, 240_000);

  it('the seal swept 4,000.00, and the late sale left 4100 at −1,500.00 in the sealed year', async () => {
    expect(await yearBalance(b, b.f.cuentas['3300'])).toBe(-4000);
    expect(await yearBalance(b, b.f.cuentas['4100'])).toBe(-1500);
  });

  it('the ledger check names the late entry, blocking, with the account and the sealed period', async () => {
    enterTenant(b.f.tenantId);
    const found = (await runLedgerChecks(b.f.entityId, undefined)).filter((h) => h.check === CHECK);
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe('blocking');
    expect(found[0].referencia).toBe(lateNumber);
    expect(found[0].detalle).toContain('December 2025');
    expect(found[0].detalle).toContain('Year-end adjustments 2025');
    expect(found[0].detalle).toContain('4100');
    // The finding text is a catalogue key: the English the service carries is en.ts, and es.ts says it too.
    expect(found[0].detail_key).toBe('ledger.check.year_sweep.found');
    expect(found[0].detalle).toBe(t(found[0].detail_key!, found[0].detail_params, 'en'));
    const es = t(found[0].detail_key!, found[0].detail_params, 'es');
    expect(es).toContain('barrió el ejercicio');
    expect(es).toContain('4100');
    // Asked by name, the same answer.
    expect(await runLedgerChecks(b.f.entityId, [CHECK])).toEqual(found);
  });

  it('it does not hold back the hard close of December, which comes before the seal', async () => {
    enterTenant(b.f.tenantId);
    await hardClosePeriod(b.periods.get(12)!, b.f.entityId, b.f.userId);
    const st = await getPeriodCloseStatus(b.periods.get(12)!, b.f.entityId);
    expect(st.checklist.find((c) => c.codigo === 'ledger-integrity')?.is_complete).toBe(true);
  });

  it('the close of the next period waits, and names the entry', async () => {
    enterTenant(b.f.tenantId);
    const st = await getPeriodCloseStatus(b.january, b.f.entityId);
    const box = st.checklist.find((c) => c.codigo === 'ledger-integrity');
    expect(box?.is_complete).toBe(false);
    expect(box?.details).toContain(`${CHECK}: ${lateNumber}`);
    expect(st.can_close).toBe(false);
    const refusal = await refusalOf(softClosePeriod(b.january, b.f.entityId, b.f.userId));
    expect(refusal.code).toBe('CANNOT_CLOSE_PERIOD');
    const explained = await explainCloseCheck(b.f.entityId, b.january, 'ledger-integrity');
    expect(explained.renglones).toEqual([expect.objectContaining({ check: CHECK, referencia: lateNumber })]);
  });

  it('once the late sale is reversed the year is back to its sweep, and the next close goes through', async () => {
    enterTenant(b.f.tenantId);
    // December is hard-closed by now, and a reversal dated in 2026 would leave
    // 2025 unswept: December is reopened so the mirror lands in the same year.
    await reopenClosedPeriod(b.f.entityId, b.periods.get(12)!, b.f.userId, 'reverse the late sale');
    await reverseJournalEntry(lateId, b.f.userId, { reason: 'posted after the seal', reversalDate: `${YEAR}-12-21` });
    expect(await yearBalance(b, b.f.cuentas['4100'])).toBe(0);
    expect(await runLedgerChecks(b.f.entityId, [CHECK])).toEqual([]);
    const st = await getPeriodCloseStatus(b.january, b.f.entityId);
    expect(st.checklist.find((c) => c.codigo === 'ledger-integrity')?.is_complete).toBe(true);
  });
});

describe('B · the default: December reopened after the seal takes a late cost', () => {
  let b: Books;
  let lateNumber: string;
  beforeAll(async () => {
    b = await sealedYear('MNE-001-662 B', 'hard');
  }, 240_000);

  it('a sealed year without a late posting passes, and the next period may close', async () => {
    enterTenant(b.f.tenantId);
    expect(await yearBalance(b, b.f.cuentas['3300'])).toBe(-4000);
    expect(await runLedgerChecks(b.f.entityId, [CHECK])).toEqual([]);
    const st = await getPeriodCloseStatus(b.january, b.f.entityId);
    expect(st.checklist.find((c) => c.codigo === 'ledger-integrity')?.is_complete).toBe(true);
  });

  it('after December is reopened, posted to and closed again, the check names the cost and January waits', async () => {
    enterTenant(b.f.tenantId);
    await reopenClosedPeriod(b.f.entityId, b.periods.get(12)!, b.f.userId, 'a late supplier bill');
    const late = await entry(b.f, `${YEAR}-12-22`, 'Late December cost', b.f.cuentas['5100'], b.f.roles.banco, '800.0000');
    lateNumber = late.entry_number;
    await softClosePeriod(b.periods.get(12)!, b.f.entityId, b.f.userId);
    await hardClosePeriod(b.periods.get(12)!, b.f.entityId, b.f.userId);
    expect(await yearBalance(b, b.f.cuentas['5100'])).toBe(800);

    const found = await runLedgerChecks(b.f.entityId, [CHECK]);
    expect(found.map((h) => h.referencia)).toEqual([lateNumber]);
    expect(found[0].detalle).toContain('5100');
    const st = await getPeriodCloseStatus(b.january, b.f.entityId);
    expect(st.can_close).toBe(false);
    expect(st.checklist.find((c) => c.codigo === 'ledger-integrity')?.details).toContain(`${CHECK}: ${lateNumber}`);
  });

  it('closing period 13 again sweeps the cost (3300 = −3,200.00), and then January closes', async () => {
    enterTenant(b.f.tenantId);
    await reopenClosedPeriod(b.f.entityId, b.periods.get(13)!, b.f.userId, 'sweep the late cost');
    await softClosePeriod(b.periods.get(13)!, b.f.entityId, b.f.userId);
    await hardClosePeriod(b.periods.get(13)!, b.f.entityId, b.f.userId, 'annual close again');
    expect(await yearBalance(b, b.f.cuentas['5100'])).toBe(0);
    expect(await yearBalance(b, b.f.cuentas['3300'])).toBe(-3200);
    expect(await runLedgerChecks(b.f.entityId, [CHECK])).toEqual([]);
    const closed = await softClosePeriod(b.january, b.f.entityId, b.f.userId);
    expect(closed.status).toBe('soft_close');
  });
});
