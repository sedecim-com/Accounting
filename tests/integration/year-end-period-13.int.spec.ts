import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { softClosePeriod, hardClosePeriod } from '../../src/services/accounting/period-close.js';
import { createFiscalYear } from '../../src/services/accounting/fiscal-calendar-service.js';
import { generarBalanza } from '../../src/services/sat/anexo24/balanza-service.js';
import { registerEAccountingCommand } from '../../src/cli/e-accounting-command.js';
import { ExitCode } from '../../src/cli/kernel/index.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// D1b · PERIOD 13 AND THE YEAR-END BALANCE (#304 · MNE-001-046)
//
// Before this slice no entity had a period 13, so the Anexo 24 closing
// balance (month 13) refused for everyone. Here a fiscal year is created the
// way `year create` creates it, a year is booked and closed, and the closing
// balance is generated through the terminal: it has to exit 0 and declare the
// closing entries as the year's adjustments.
//
// The year is 2025, already over, so every period is born open. The expense
// is dated December 31 on purpose: that is the day December and period 13
// share, and the day on which a date-only cut of the ledger double counts.
// ============================================================

const YEAR = 2025;
let f: Fixture;
let tmpRoot: string;
let periods: Map<number, string>;

async function entry(date: string, description: string, debit: string, credit: string, amount: string) {
  return createJournalEntry(
    f.entityId, date, JournalEntryType.STANDARD, description,
    [
      { account_id: debit, debit_amount: amount, credit_amount: null, description },
      { account_id: credit, debit_amount: null, credit_amount: amount, description },
    ],
    f.userId, { autoPost: true }
  );
}

/** The `<BCE:Ctas>` node of one account in the XML. */
function node(xml: string, account: string): string {
  const m = new RegExp(`<BCE:Ctas NumCta="${account}"[^>]*/>`).exec(xml);
  return m ? m[0] : '';
}

const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

/** Runs `mnemosine e-accounting …` in process and returns what it printed and its exit code. */
async function run(argv: string[]) {
  let exitCode: number | undefined;
  const errs: unknown[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const stderrOriginal = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    err.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine');
    registerEAccountingCommand(p, {
      palette: plain,
      shutdown: (c: number) => {
        exitCode = c;
      },
      reportError: (e: unknown) => {
        errs.push(e);
      },
    });
    await p.parseAsync(['node', 'mnemosine', 'e-accounting', ...argv, '-e', f.entityId, '-t', f.tenantId]);
  } finally {
    process.stdout.write = stdoutOriginal;
    process.stderr.write = stderrOriginal;
  }
  return { exitCode, errs, out: out.join(''), err: err.join('') };
}

beforeAll(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'year-end-13-'));
  f = await crearInquilino('D1b period 13');
  enterTenant(f.tenantId);
  await createFiscalYear(f.entityId, YEAR, new Date('2026-09-28T12:00:00Z'));
  const r = await query<{ period_number: number; id: string }>(
    `SELECT fp.period_number, fp.id FROM fiscal_periods fp
       JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
      WHERE fp.entity_id = $1 AND fy.year_number = $2`,
    [f.entityId, YEAR]
  );
  periods = new Map(r.rows.map((p) => [p.period_number, p.id]));
}, 180_000);

afterAll(async () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  await drainAttestations(3000);
  await closeDatabase();
});

describe('a fiscal year is born with its period 13', () => {
  it('year create makes thirteen periods, the last one the adjustment period on December 31', async () => {
    const r = await query<{ period_type: string; start_date: string; end_date: string; status: string }>(
      `SELECT period_type, start_date::text AS start_date, end_date::text AS end_date, status
         FROM fiscal_periods WHERE id = $1`,
      [periods.get(13)]
    );
    expect(periods.size).toBe(13);
    expect(r.rows[0]).toEqual({
      period_type: 'adjustment', start_date: `${YEAR}-12-31`, end_date: `${YEAR}-12-31`, status: 'open',
    });
  });

  it('an ordinary entry dated December 31 still lands in December while December is open', async () => {
    const e = await entry(`${YEAR}-12-31`, 'December cost', f.cuentas['5100'], f.roles.banco, '6000.0000');
    expect(e.fiscal_period_id).toBe(periods.get(12));
  });
});

describe('the annual close posts into period 13 and the closing balance can be generated', () => {
  beforeAll(async () => {
    await entry(`${YEAR}-03-10`, 'March sale', f.roles.banco, f.cuentas['4100'], '10000.0000');
    // December is only soft closed: posting may still reach it, which is
    // exactly when a closing entry dated December 31 would fall into it.
    await softClosePeriod(periods.get(12)!, f.entityId, f.userId);
    await softClosePeriod(periods.get(13)!, f.entityId, f.userId);
    await hardClosePeriod(periods.get(13)!, f.entityId, f.userId, 'year-end close');
  }, 180_000);

  it('every closing entry lands in period 13, none in December', async () => {
    const r = await query<{ fiscal_period_id: string }>(
      `SELECT fiscal_period_id FROM journal_entries WHERE entity_id = $1 AND entry_type = 'closing'`,
      [f.entityId]
    );
    expect(r.rows.length).toBeGreaterThan(0);
    expect(new Set(r.rows.map((e) => e.fiscal_period_id))).toEqual(new Set([periods.get(13)]));
  });

  it('`balance generate --period <year> --closing` exits 0 and the XML declares the closing adjustments', async () => {
    const file = path.join(tmpRoot, 'closing.xml');
    const r = await run(['balance', 'generate', '--period', String(YEAR), '--closing', '-o', file, '--yes']);
    expect(r.errs, r.err).toEqual([]);
    expect(r.exitCode, r.err).toBe(ExitCode.OK);

    const xml = fs.readFileSync(file, 'utf-8');
    expect(xml).toContain('Mes="13"');
    expect(xml).toContain(`Anio="${YEAR}"`);
    // The year's result is swept in period 13: revenue opens at 10 000 and is
    // debited to zero, the December 31 cost opens at 6 000 and is credited.
    expect(node(xml, '4100')).toContain('SaldoIni="10000.00" Debe="10000.00" Haber="0.00" SaldoFin="0.00"');
    expect(node(xml, '5100')).toContain('SaldoIni="6000.00" Debe="0.00" Haber="6000.00" SaldoFin="0.00"');
  });

  it('and December, generated again after the close, still balances without the closing entries', async () => {
    const b = await generarBalanza(f.entityId, { periodo: `${YEAR}-12`, dryRun: true });
    expect(b.meta.mes).toBe('12');
    expect(b.inicial.descuadres).toEqual([]);
    expect(node(b.xml, '4100')).toContain('SaldoFin="10000.00"');
  });
});

describe('closing December carries its balances into period 13, not past it', () => {
  it('period 13 opens with what December closed with', async () => {
    const g = await crearInquilino('D1b carry into period 13');
    enterTenant(g.tenantId);
    await createFiscalYear(g.entityId, YEAR, new Date('2026-09-28T12:00:00Z'));
    const r = await query<{ period_number: number; id: string }>(
      `SELECT fp.period_number, fp.id FROM fiscal_periods fp
         JOIN fiscal_years fy ON fy.id = fp.fiscal_year_id
        WHERE fp.entity_id = $1 AND fy.year_number = $2 AND fp.period_number IN (12, 13)`,
      [g.entityId, YEAR]
    );
    const byNumber = new Map(r.rows.map((p) => [p.period_number, p.id]));
    await createJournalEntry(
      g.entityId, `${YEAR}-12-10`, JournalEntryType.STANDARD, 'December sale',
      [
        { account_id: g.roles.banco, debit_amount: '2500.0000', credit_amount: null, description: 'sale' },
        { account_id: g.cuentas['4100'], debit_amount: null, credit_amount: '2500.0000', description: 'sale' },
      ],
      g.userId, { autoPost: true }
    );
    await softClosePeriod(byNumber.get(12)!, g.entityId, g.userId);
    await hardClosePeriod(byNumber.get(12)!, g.entityId, g.userId);

    // Before, the carry skipped to the first period starting after December
    // 31: period 13 opened empty, and the closing balance under
    // 'exigir_cierre_duro' had no SaldoIni to declare.
    const seeded = await query<{ beginning_balance: string }>(
      `SELECT beginning_balance::text AS beginning_balance FROM account_balances
        WHERE account_id = $1 AND fiscal_period_id = $2`,
      [g.roles.banco, byNumber.get(13)]
    );
    expect(Number(seeded.rows[0]?.beginning_balance)).toBe(2500);
  });
});
