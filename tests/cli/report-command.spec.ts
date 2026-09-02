import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// The CLI is exercised without a database: the service layer is where the SQL
// lives and it has its own spec. What is under test here is the SURFACE —
// names, aliases, flags, risk, and whether truncation reaches the user.
vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: vi.fn(),
  resolveEntity: vi.fn(async () => ({
    entityId: 'ent-1', entityName: 'Demo Corp MX', tenantId: 'ten-1',
    currency: 'MXN', country: 'MX', accountingStandard: 'NIF', taxId: 'X',
  })),
  listEntities: vi.fn(async () => [{ id: 'ent-1' }]),
}));

vi.mock('../../src/services/accounting/account-service.js', () => ({
  resolveAccount: vi.fn(async () => ({ id: 'acc-1', code: '1110' })),
}));

vi.mock('../../src/services/reporting/report-service.js', () => ({
  resolvePeriodRange: vi.fn(),
  getTrialBalance: vi.fn(),
  getBalanceSheet: vi.fn(),
  getIncomeStatement: vi.fn(),
  getGeneralLedger: vi.fn(),
  getAgedReceivables: vi.fn(),
  getAgedPayables: vi.fn(),
}));

vi.mock('../../src/services/reporting/materialized-view-service.js', () => ({
  REPORTING_VIEWS: ['mv_trial_balance', 'mv_account_balance_summary'],
  refreshReportingViews: vi.fn(async () => []),
  getReportingViewStatus: vi.fn(async () => []),
}));

import { registerReportCommand, bucketOf } from '../../src/cli/report-command.js';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { riskOf, resetDeclarations } from '../../src/cli/kernel/risk.js';
import { palette } from '../../src/cli/palette.js';
import * as reportService from '../../src/services/reporting/report-service.js';

const noColor = palette({ isTTY: false } as NodeJS.WriteStream);

function build(): { program: Command; exit: () => number | undefined; out: string; err: string } {
  resetDeclarations();
  const program = new Command('mnemosine');
  let code: number | undefined;
  registerReportCommand(program, {
    palette: noColor,
    shutdown: (c: number) => { code = c; },
    reportError: () => {},
  });
  return { program, exit: () => code, out: '', err: '' };
}

/** Runs one command with stdout/stderr captured, so the OUTPUT can be asserted. */
async function runCli(argv: string[]): Promise<{ code: number | undefined; out: string; err: string }> {
  resetDeclarations();
  const program = new Command('mnemosine');
  let code: number | undefined;
  registerReportCommand(program, {
    palette: noColor,
    shutdown: (c: number) => { code = c; },
    reportError: (e) => { process.stderr.write(`${(e as Error).message}\n`); },
  });

  let out = '';
  let err = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk); return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err += String(chunk); return true;
  });
  try {
    await program.parseAsync(['node', 'mnemosine', ...argv]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { code, out, err };
}

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { resetDeclarations(); });

// ============================================================
// THE SURFACE
// ============================================================

describe('the report family obeys the kernel rulebook', () => {
  it('produces no consistency violations', () => {
    const { program } = build();
    expect(auditProgram(program)).toEqual([]);
  });

  it('every leaf ends in a verb from the closed list and stays within three tokens', () => {
    const { program } = build();
    const report = program.commands.find((c) => c.name() === 'report')!;
    const leaves: string[] = [];
    for (const group of report.commands) {
      for (const leaf of group.commands) leaves.push(`report ${group.name()} ${leaf.name()}`);
    }
    expect(leaves.sort()).toEqual([
      'report aged-payable show',
      'report aged-receivable show',
      'report balance-sheet show',
      'report general-ledger show',
      'report income-statement show',
      'report trial-balance show',
      'report view show',
      'report view sync',
    ]);
  });

  it('carries a Spanish alias at every level, and no alias is claimed twice', () => {
    const { program } = build();
    const report = program.commands.find((c) => c.name() === 'report')!;
    expect(report.aliases()).toContain('reporte');

    const groups = Object.fromEntries(report.commands.map((c) => [c.name(), c.aliases()[0]]));
    expect(groups).toEqual({
      'trial-balance': 'balanza',
      'balance-sheet': 'balance',
      'income-statement': 'resultados',
      'general-ledger': 'mayor',
      'aged-receivable': 'antiguedad-cobrar',
      'aged-payable': 'antiguedad-pagar',
      view: 'vista',
    });
    const aliases = Object.values(groups);
    expect(new Set(aliases).size).toBe(aliases.length);

    for (const group of report.commands) {
      for (const leaf of group.commands) {
        expect(leaf.aliases()[0], `${group.name()} ${leaf.name()} has no Spanish alias`)
          .toBe(leaf.name() === 'sync' ? 'sincronizar' : 'ver');
      }
    }
  });

  it('every read is agent-invocable and the rebuild is not', () => {
    const { program } = build();
    const report = program.commands.find((c) => c.name() === 'report')!;
    for (const group of report.commands) {
      for (const leaf of group.commands) {
        const risk = riskOf(leaf);
        expect(risk, `${group.name()} ${leaf.name()} declares no risk`).toBeDefined();
        if (leaf.name() === 'sync') {
          // It takes locks and changes what every other reader sees.
          expect(risk!.risk).toBe('escritura');
          expect(risk!.agentAllowed).toBe(false);
        } else {
          expect(risk!.risk).toBe('lectura');
          expect(risk!.agentAllowed).toBe(true);
        }
      }
    }
  });

  it('every report can be paged and formatted, so none can truncate in silence', () => {
    const { program } = build();
    const report = program.commands.find((c) => c.name() === 'report')!;
    for (const group of report.commands) {
      for (const leaf of group.commands) {
        if (leaf.name() === 'sync') continue; // a rebuild returns two rows, not a report
        const longs = leaf.options.map((o) => o.long);
        expect(longs, `${group.name()} ${leaf.name()}`).toContain('--limit');
        expect(longs, `${group.name()} ${leaf.name()}`).toContain('--format');
        expect(longs, `${group.name()} ${leaf.name()}`).toContain('--json');
      }
    }
  });
});

// ============================================================
// THE PROPERTY THAT MATTERS: A SHORT REPORT SAYS SO
// ============================================================

describe('truncation is announced and the footing is not truncated with it', () => {
  it('trial balance: --limit shows a page, reports the true total, foots over all of it', async () => {
    vi.mocked(reportService.getTrialBalance).mockResolvedValue({
      entity_id: 'ent-1',
      rows: [{
        account_id: 'a', account_code: '1110', account_name: 'Caja',
        account_type: 'asset', debit_total: '0', credit_total: '2469.1200',
        ending_balance: '-2469.1200',
      }],
      total: 53,
      totals: { total_debits: '18477.1200', total_credits: '18477.1200', is_balanced: true },
    });

    const { code, out, err } = await runCli(['report', 'trial-balance', 'show', '--entity', 'Demo']);
    expect(code).toBe(0);
    expect(err).toMatch(/Showing 1 of 53 rows/);
    // The footing covers 53 accounts even though one row was printed.
    expect(err).toMatch(/Debits 18477\.1200\s+Credits 18477\.1200\s+\(53 accounts\)\s+balanced/);
    // La tabla es para humanos: el importe sale vestido es-MX (miles y dos
    // decimales); la cadena de almacenamiento sigue siendo el contrato de
    // json/csv y eso lo vigila tests/cli/kernel/presentation.spec.ts.
    expect(out).toMatch(/-2,469\.12/);
  });

  it('trial balance: an out-of-balance footing is a warning, not a rounding note', async () => {
    vi.mocked(reportService.getTrialBalance).mockResolvedValue({
      entity_id: 'ent-1',
      rows: [],
      total: 0,
      totals: { total_debits: '100.0000', total_credits: '90.0000', is_balanced: false },
    });
    const { err } = await runCli(['report', 'trial-balance', 'show', '--entity', 'Demo']);
    expect(err).toMatch(/OUT OF BALANCE by 10\.0000/);
  });

  it('trial balance: --json keeps every amount a string and never a JSON number', async () => {
    vi.mocked(reportService.getTrialBalance).mockResolvedValue({
      entity_id: 'ent-1',
      rows: [{
        account_id: 'a', account_code: '1110', account_name: 'Caja', account_type: 'asset',
        debit_total: '0', credit_total: '2469.1200', ending_balance: '-2469.1200',
      }],
      total: 1,
      totals: { total_debits: '0.0000', total_credits: '2469.1200', is_balanced: false },
    });
    const { out } = await runCli(['report', 'trial-balance', 'show', '--entity', 'Demo', '--json']);
    const payload = JSON.parse(out);
    for (const field of ['debit_total', 'credit_total', 'ending_balance']) {
      expect(typeof payload.rows[0][field]).toBe('string');
    }
    // "0" from an untouched account is normalised for the eye, not parsed.
    expect(payload.rows[0].debit_total).toBe('0.0000');
  });

  it('general ledger: the page total and the true total are both reported', async () => {
    vi.mocked(reportService.getGeneralLedger).mockResolvedValue({
      rows: [{
        account_id: 'a', account_code: '1110', account_name: 'Caja',
        journal_entry_id: 'je-1', entry_number: 'JE-1', entry_date: new Date(2026, 7, 23),
        entry_type: 'standard', entry_description: 'x', line_number: 1,
        debit_amount: null, credit_amount: '1234.5600', line_description: 'Pago',
        cost_center_id: null, project_id: null,
      }],
      total: 16,
      period_debits: '0.0000',
      period_credits: '1234.5600',
    });
    const { out, err } = await runCli(['report', 'general-ledger', 'show', '--entity', 'Demo', '--limit', '1']);
    expect(err).toMatch(/Showing 1 of 16 rows/);
    expect(err).toMatch(/\(1 of 16 movements\)/);
    // A DATE is printed as the day Postgres stored, not shifted by a timezone.
    expect(out).toMatch(/2026-08-23/);
  });

  it('general ledger: --limit is what the caller asked for, --all removes the default', async () => {
    vi.mocked(reportService.getGeneralLedger).mockResolvedValue({
      rows: [], total: 0, period_debits: '0.0000', period_credits: '0.0000',
    });
    await runCli(['report', 'general-ledger', 'show', '--entity', 'Demo']);
    expect(vi.mocked(reportService.getGeneralLedger).mock.calls[0][1].limit).toBe(100);

    await runCli(['report', 'general-ledger', 'show', '--entity', 'Demo', '--limit', '7']);
    expect(vi.mocked(reportService.getGeneralLedger).mock.calls[1][1].limit).toBe(7);

    await runCli(['report', 'general-ledger', 'show', '--entity', 'Demo', '--all']);
    expect(vi.mocked(reportService.getGeneralLedger).mock.calls[2][1].limit).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('a statement carries NO default limit: cutting one silently is the bug', async () => {
    vi.mocked(reportService.getTrialBalance).mockResolvedValue({
      entity_id: 'ent-1', rows: [], total: 0,
      totals: { total_debits: '0.0000', total_credits: '0.0000', is_balanced: true },
    });
    await runCli(['report', 'trial-balance', 'show', '--entity', 'Demo']);
    expect(vi.mocked(reportService.getTrialBalance).mock.calls[0][1]!.limit).toBeUndefined();
  });

  it('ageing: the total due covers every open document, not the page', async () => {
    vi.mocked(reportService.getAgedPayables).mockResolvedValue({
      entity_id: 'ent-1',
      as_of_date: '2026-08-25',
      rows: [{
        vendor_id: 'v', vendor_name: 'Proveedor', vendor_number: 'V-1',
        bill_id: 'b', bill_number: 'BILL-1', bill_date: new Date(2026, 3, 10),
        due_date: new Date(2026, 4, 10), total_amount: '1160.0000',
        amount_due: '1160.0000', days_overdue: 107,
      }],
      total: 6,
      total_due: '12528.0000',
    });
    const { out, err } = await runCli(['report', 'aged-payable', 'show', '--entity', 'Demo', '--limit', '1']);
    expect(err).toMatch(/Total due 12528\.0000 across 6 open bill\(s\)/);
    expect(err).toMatch(/Showing 1 of 6 rows/);
    expect(out).toMatch(/90\+/);
  });
});

// ============================================================
// WHAT THE COMMANDS REFUSE
// ============================================================

describe('the family refuses rather than guessing', () => {
  it('an income statement without a period is a usage error, not an empty range', async () => {
    const { code, err } = await runCli(['report', 'income-statement', 'show', '--entity', 'Demo']);
    expect(code).toBe(2);
    expect(err).toMatch(/An income statement covers a period/);
    expect(reportService.getIncomeStatement).not.toHaveBeenCalled();
  });

  it('--status is rejected instead of being silently ignored', async () => {
    const { code, err } = await runCli(['report', 'trial-balance', 'show', '--entity', 'Demo', '--status', 'open']);
    expect(code).toBe(2);
    expect(err).toMatch(/--status does not apply/);
  });

  it('--level must be a whole number of at least 1', async () => {
    const { code, err } = await runCli(['report', 'trial-balance', 'show', '--entity', 'Demo', '--level', '0']);
    expect(code).toBe(2);
    expect(err).toMatch(/--level must be a whole number/);
  });

  it('an aged report reached with a past cutoff says what the cutoff does NOT do', async () => {
    vi.mocked(reportService.getAgedReceivables).mockResolvedValue({
      entity_id: 'ent-1', as_of_date: '2020-12-31', rows: [], total: 0, total_due: '0.0000',
    });
    const { err } = await runCli([
      'report', 'aged-receivable', 'show', '--entity', 'Demo', '--as-of', '2020-12-31',
    ]);
    expect(err).toMatch(/ages the due dates only/);
    expect(err).toMatch(/not the balances as they stood on that date/);
  });
});

describe('period selection', () => {
  it('a matched fiscal period is passed by id, which is the strict reading', async () => {
    vi.mocked(reportService.resolvePeriodRange).mockResolvedValue({
      start_date: '2026-08-01', end_date: '2026-08-31',
      period_name: 'August 2026', fiscal_period_id: 'fp-8', matched_fiscal_period: true,
    });
    vi.mocked(reportService.getTrialBalance).mockResolvedValue({
      entity_id: 'ent-1', rows: [], total: 0,
      totals: { total_debits: '0.0000', total_credits: '0.0000', is_balanced: true },
    });
    const { err } = await runCli([
      'report', 'trial-balance', 'show', '--entity', 'Demo', '--period', 'August 2026',
    ]);
    const passed = vi.mocked(reportService.getTrialBalance).mock.calls[0][1]!;
    expect(passed.fiscalPeriodId).toBe('fp-8');
    expect(passed.sinceDate).toBeUndefined();
    expect(err).not.toMatch(/matched no single fiscal period/);
  });

  it('a calendar fallback is used but ANNOUNCED, so nobody mistakes it for the period', async () => {
    vi.mocked(reportService.resolvePeriodRange).mockResolvedValue({
      start_date: '2026-01-01', end_date: '2026-12-31',
      period_name: 'FY2026', matched_fiscal_period: false,
    });
    vi.mocked(reportService.getTrialBalance).mockResolvedValue({
      entity_id: 'ent-1', rows: [], total: 0,
      totals: { total_debits: '0.0000', total_credits: '0.0000', is_balanced: true },
    });
    const { err } = await runCli([
      'report', 'trial-balance', 'show', '--entity', 'Demo', '--period', 'FY2026',
    ]);
    expect(err).toMatch(/matched no single fiscal period; using the calendar range 2026-01-01 → 2026-12-31/);
    const passed = vi.mocked(reportService.getTrialBalance).mock.calls[0][1]!;
    expect(passed.sinceDate).toBe('2026-01-01');
    expect(passed.untilDate).toBe('2026-12-31');
    expect(passed.fiscalPeriodId).toBeUndefined();
  });
});

describe('bucketOf', () => {
  it('buckets by the ageing of the due date', () => {
    expect(bucketOf(-20)).toBe('current');
    expect(bucketOf(0)).toBe('current');
    expect(bucketOf(1)).toBe('1-30');
    expect(bucketOf(30)).toBe('1-30');
    expect(bucketOf(31)).toBe('31-60');
    expect(bucketOf(90)).toBe('61-90');
    expect(bucketOf(91)).toBe('90+');
  });
});
