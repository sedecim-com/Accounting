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
import { render, type Row } from '../../src/cli/kernel/output.js';
import { resetLanguage, setLanguage, t, type Language } from '../../src/i18n/index.js';
import { reportCategoryLabel, reportSectionLabel } from '../../src/i18n/report-labels.js';
import { crudoDe } from '../../src/plan/criterios.js';
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
// The language is PINNED by each case that cares and handed back here.
// `vitest.config.ts` pins MNEMOSINE_LOCALE=en-US for this suite, so a case
// that forgets to say which language it wants is measuring English without
// admitting it — and a case that forgot to hand it back would decide the
// language of every case that runs after it.
afterEach(() => { resetDeclarations(); resetLanguage(); });

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

// ============================================================
// I11 · THE LABEL IS RENDERED AT THE EDGE, AND ONLY FOR A PERSON
//
// Every expected string below is typed out by hand. Calling the same labeller
// the code under test calls would compare a piece against itself and pass with
// the catalog deleted; the point of these cases is the CONTENT of the catalog
// reaching the surface, so the content is repeated here.
// ============================================================

/** A sink that answers `palette()` like a pipe and keeps what was written. */
function sink(): { stream: NodeJS.WriteStream; text: () => string } {
  let text = '';
  const stream = {
    isTTY: false,
    write(chunk: unknown): boolean { text += String(chunk); return true; },
  } as unknown as NodeJS.WriteStream;
  return { stream, text: () => text };
}

/**
 * The rows a balance sheet pushes, with the keys the command now puts in
 * `section` and `category`. Frozen here so every rendering below is
 * demonstrably the SAME row set: one fixture, six outputs, and only the two
 * human ones may move with the language.
 *
 * THE THREE SHAPES ARE ALL HERE ON PURPOSE. A fixture of `account` lines alone
 * cannot catch the defect this hook exists to prevent, because an account line
 * has no prose to leak — its `name` is the account's own name and is the same
 * in every language. The prose lives on the lines that have none of their own:
 * a `subtotal`, a section `total`, and the grand total whose `section` is
 * empty. Those three store `name: ''` and get their sentence composed at print
 * time; a fixture without them measures the easy half.
 */
const KEYED_ROWS: Row[] = [
  { section: 'assets', category: 'current_assets', code: '1110', name: 'Caja', amount: '1000.0000', line: 'account' },
  { section: 'assets', category: 'current_assets', code: '', name: '', amount: '1000.0000', line: 'subtotal' },
  { section: 'assets', category: 'non_current_assets', code: '1500', name: 'Equipo', amount: '2000.0000', line: 'account' },
  { section: 'assets', category: 'non_current_assets', code: '', name: '', amount: '2000.0000', line: 'subtotal' },
  { section: 'assets', category: '', code: '', name: '', amount: '3000.0000', line: 'total' },
  { section: 'equity', category: 'equity', code: '3000', name: 'Capital social', amount: '2500.0000', line: 'account' },
  { section: 'equity', category: 'ori', code: '3600', name: 'ORI', amount: '500.0000', line: 'account' },
  { section: 'equity', category: '', code: '', name: '', amount: '3000.0000', line: 'total' },
  { section: '', category: '', code: '', name: '', amount: '3000.0000', line: 'total' },
];

/**
 * A `name` labeller of the shape the balance sheet hands the kernel, written
 * out here instead of imported from `report-command.ts`.
 *
 * What this half of the file measures is the KERNEL's contract — which
 * formats call the hook and which must never call it — and it has to keep
 * measuring exactly that if the command's own composer is rewritten or moved.
 * The command's real composer is exercised through the CLI further down, where
 * the expected sentences are typed out by hand.
 *
 * It reads `line`, `category` and `section` off the row, which is the point of
 * the hook taking the row: a subtotal has no prose of its own to be handed.
 */
function composedName(value: string, row: Row): string {
  // `Row` is `Record<string, unknown>`, so the key is narrowed rather than
  // stringified: `String(someObject)` would hand the catalog «[object Object]»
  // and it would dutifully fall back to printing that at a reader.
  const keyAt = (column: string): string =>
    typeof row[column] === 'string' ? (row[column] as string) : '';

  if (row.line === 'subtotal') {
    return t('report.total_of', { name: reportCategoryLabel(keyAt('category')) });
  }
  if (row.line === 'total') {
    return keyAt('section') === ''
      ? t('report.total_liabilities_and_equity')
      : t('report.total_of', { name: reportSectionLabel(keyAt('section')) });
  }
  return value;
}

function renderKeyedRows(format: string, language: Language): string {
  setLanguage(language);
  const data = sink();
  const notes = sink();
  render(KEYED_ROWS, {
    format,
    idField: 'code',
    stdout: data.stream,
    stderr: notes.stream,
    labelled: {
      section: (v: string) => reportSectionLabel(v),
      category: (v: string) => reportCategoryLabel(v),
      name: composedName,
    },
  });
  return data.text();
}

describe('the same rows: the table is translated, the machine formats are not', () => {
  it('the table carries prose, and different prose in each language', () => {
    const es = renderKeyedRows('table', 'es');
    const en = renderKeyedRows('table', 'en');

    expect(es).toContain('Activo');
    expect(es).toContain('Activo circulante');
    expect(es).toContain('Activo no circulante');
    expect(es).toContain('Capital contable');
    expect(es).toContain('Capital contribuido');
    expect(es).toContain('Otros resultados integrales');

    expect(en).toContain('Assets');
    expect(en).toContain('Current assets');
    expect(en).toContain('Non-current assets');
    expect(en).toContain('Equity');
    expect(en).toContain('Contributed capital');
    expect(en).toContain('Other comprehensive income');

    // Not merely "different": the Spanish table must not be the English one.
    expect(es).not.toBe(en);
    expect(es).not.toContain('Current assets');
    expect(en).not.toContain('Activo circulante');

    // And no reader is shown an identifier. `\b` is not enough on its own —
    // `current_assets` contains `assets` — so each key is checked whole.
    for (const table of [es, en]) {
      expect(table).not.toMatch(/(^|\s)current_assets(\s|$)/m);
      expect(table).not.toMatch(/(^|\s)non_current_assets(\s|$)/m);
      expect(table).not.toMatch(/(^|\s)ori(\s|$)/m);
    }
  });

  it('the table composes the sentence the row does not store', () => {
    // The row went in with `name: ''`; the reader gets a whole phrase, and the
    // grand total gets its own sentence rather than «Total de » with nothing
    // after it — which is what a composer missing the empty-section branch
    // would print.
    const es = renderKeyedRows('table', 'es');
    expect(es).toContain('Total de Activo circulante');
    expect(es).toContain('Total de Activo no circulante');
    expect(es).toContain('Total de Activo');
    expect(es).toContain('Total de Capital contable');
    expect(es).toContain('Suma del pasivo y el capital contable');
    expect(es).not.toMatch(/Total de\s+3,000\.00/);

    const en = renderKeyedRows('table', 'en');
    expect(en).toContain('Total Current assets');
    expect(en).toContain('Total Assets');
    expect(en).toContain('Total liabilities and equity');
    expect(en).not.toMatch(/Total\s+3,000\.00/);
  });

  it('markdown is labelled too — it is the deliverable, not a machine format', () => {
    // `--format md -o` is what the wiki teaches as the monthly hand-off, and it
    // went a whole commit printing `assets` at a reader because only the
    // aligned table had a case. Every expected row is typed out whole.
    const es = renderKeyedRows('md', 'es');
    const en = renderKeyedRows('md', 'en');

    expect(es).toContain('| Activo | Activo circulante | 1110 | Caja | 1000.0000 | account |');
    expect(es).toContain('| Activo | Activo circulante |  | Total de Activo circulante | 1000.0000 | subtotal |');
    expect(es).toContain('| Activo |  |  | Total de Activo | 3000.0000 | total |');
    expect(es).toContain('| Capital contable | Otros resultados integrales | 3600 | ORI | 500.0000 | account |');
    expect(es).toContain('|  |  |  | Suma del pasivo y el capital contable | 3000.0000 | total |');

    expect(en).toContain('| Assets | Current assets | 1110 | Caja | 1000.0000 | account |');
    expect(en).toContain('| Assets | Current assets |  | Total Current assets | 1000.0000 | subtotal |');
    expect(en).toContain('| Assets |  |  | Total Assets | 3000.0000 | total |');
    expect(en).toContain('|  |  |  | Total liabilities and equity | 3000.0000 | total |');

    expect(es).not.toBe(en);
    // And no identifier reaches the page in either language.
    for (const markdown of [es, en]) {
      expect(markdown).not.toContain('current_assets');
      expect(markdown).not.toContain('non_current_assets');
      expect(markdown).not.toContain('| ori |');
    }
    // And it is not the machine branch wearing pipes: markdown labels, csv
    // does not, from the very same fixture.
    const csv = renderKeyedRows('csv', 'es');
    expect(es).not.toBe(csv);
    expect(csv).not.toContain('Activo circulante');
    expect(es).not.toContain('assets,current_assets');
  });

  it('csv, tsv, ndjson and json are byte for byte the same in both languages', () => {
    // The identity that a script depends on, measured over the rows that
    // actually carry composed prose: without the subtotal and total lines in
    // the fixture this passes with the sentence stored back inside `name`,
    // which is exactly the regression it is here to catch.
    for (const format of ['csv', 'tsv', 'ndjson', 'json']) {
      const es = renderKeyedRows(format, 'es');
      const en = renderKeyedRows(format, 'en');

      expect(es, `${format} moved with the reader's language`).toBe(en);
      // …and not by being empty of the rows in question.
      expect(es, `${format} lost the subtotal lines`).toContain('subtotal');
      // Neither catalog leaked in. Every one of these is prose that the two
      // human branches DO print for this same fixture.
      for (const prose of [
        'Total',
        'Activo',
        'Assets',
        'Current assets',
        'Otros resultados integrales',
        'Other comprehensive income',
        'Suma del pasivo',
      ]) {
        expect(es, `${format} carries the label "${prose}"`).not.toContain(prose);
      }
    }
  });

  it('csv keeps the keys, and a subtotal keeps the empty name it was stored with', () => {
    const csv = renderKeyedRows('csv', 'es');
    expect(csv).toContain('assets,current_assets,1110,Caja,1000.0000,account');
    expect(csv).toContain('equity,ori,3600,ORI,500.0000,account');
    // The three lines that have no prose of their own: two empty cells where
    // the code and the name would be, and the grand total with no section.
    expect(csv).toContain('assets,current_assets,,,1000.0000,subtotal');
    expect(csv).toContain('assets,,,,3000.0000,total');
    expect(csv).toContain(',,,,3000.0000,total');
  });

  it('json keeps the keys, and every composed line comes back with an empty name', () => {
    const es = renderKeyedRows('json', 'es');
    const payload = JSON.parse(es) as {
      rows: { section: string; category: string; name: string; line: string }[];
    };
    expect(payload.rows.map((r) => r.section)).toEqual([
      'assets', 'assets', 'assets', 'assets', 'assets', 'equity', 'equity', 'equity', '',
    ]);
    expect(payload.rows.map((r) => r.category)).toEqual([
      'current_assets', 'current_assets', 'non_current_assets', 'non_current_assets', '',
      'equity', 'ori', '', '',
    ]);
    // Five rows have no name stored; the ones that do are account names, which
    // are the entity's own prose and belong in the machine format.
    expect(payload.rows.filter((r) => r.line !== 'account').map((r) => r.name))
      .toEqual(['', '', '', '', '']);
    expect(payload.rows.filter((r) => r.line === 'account').map((r) => r.name))
      .toEqual(['Caja', 'Equipo', 'Capital social', 'ORI']);
  });

  it('the hook only fires on the columns it was given, and never on an empty cell', () => {
    // A section TOTAL row carries no category. `assets` is also a valid
    // `report.category.*`-shaped string in nobody's catalog, but the empty
    // string is: an unguarded labeller would print the fallback — the empty
    // string — either way, so what this pins is the column boundary. `name`
    // holds an account's own name and must survive untouched even when it
    // happens to read like a key.
    setLanguage('es');
    const data = sink();
    render(
      [{ section: 'assets', category: '', code: '', name: 'current_assets', amount: '3000.0000', line: 'total' }],
      {
        format: 'table',
        stdout: data.stream,
        stderr: sink().stream,
        labelled: { section: (v: string) => reportSectionLabel(v), category: (v: string) => reportCategoryLabel(v) },
      }
    );
    const table = data.text();
    expect(table).toContain('Activo');
    // The `name` column was not in `labelled`, so its value is printed raw.
    expect(table).toContain('current_assets');
    // …and the empty category stayed empty rather than becoming a label.
    expect(table).not.toContain('Activo circulante');
  });
});

// ---- the same thing, through the command the user actually types ----

/** A balanced statement with one account under each of four categories. */
function mockBalanceSheet(): void {
  vi.mocked(reportService.getBalanceSheet).mockResolvedValue({
    entity_id: 'ent-1',
    as_of_date: '2026-08-31',
    assets: {
      key: 'assets', name: 'Assets', total: '1000.0000',
      subsections: [{
        key: 'current_assets', name: 'Current Assets', total: '1000.0000',
        accounts: [{ id: 'a', code: '1110', name: 'Caja', balance: '1000.0000' }],
      }],
    },
    liabilities: {
      key: 'liabilities', name: 'Liabilities', total: '400.0000',
      subsections: [{
        key: 'current_liabilities', name: 'Current Liabilities', total: '400.0000',
        accounts: [{ id: 'b', code: '2110', name: 'Proveedores', balance: '400.0000' }],
      }],
    },
    equity: {
      key: 'equity', name: 'Equity', total: '600.0000',
      subsections: [
        {
          key: 'equity', name: 'Equity', total: '500.0000',
          accounts: [{ id: 'c', code: '3000', name: 'Capital social', balance: '500.0000' }],
        },
        {
          key: 'ori', name: 'Ori', total: '100.0000',
          accounts: [{ id: 'd', code: '3600', name: 'Otros Resultados Integrales', balance: '100.0000' }],
        },
      ],
    },
    total_liabilities_and_equity: '1000.0000',
    out_of_balance: '0.0000',
    is_balanced: true,
  });
}

describe('report balance-sheet show: what a person reads, and what a script reads', () => {
  it('in Spanish the table and the footing are Spanish', async () => {
    mockBalanceSheet();
    setLanguage('es');
    const { code, out, err } = await runCli(['report', 'balance-sheet', 'show', '--entity', 'Demo']);
    expect(code).toBe(0);

    expect(out).toContain('Activo circulante');
    expect(out).toContain('Pasivo a corto plazo');
    expect(out).toContain('Capital contribuido');
    expect(out).toContain('Otros resultados integrales');
    expect(out).toContain('Total de Activo circulante');
    expect(out).toContain('Total de Activo');
    expect(out).toContain('Suma del pasivo y el capital contable');
    // The prettifier's two non-words are gone from the surface.
    expect(out).not.toMatch(/(^|\s)Ori(\s|$)/m);
    expect(out).not.toContain('Current Assets');

    expect(err).toContain('Activo 1000.0000 = Pasivo + Capital 1000.0000');
  });

  it('in English the table and the footing are English', async () => {
    mockBalanceSheet();
    setLanguage('en');
    const { code, out, err } = await runCli(['report', 'balance-sheet', 'show', '--entity', 'Demo']);
    expect(code).toBe(0);

    expect(out).toContain('Current assets');
    expect(out).toContain('Current liabilities');
    expect(out).toContain('Contributed capital');
    expect(out).toContain('Other comprehensive income');
    expect(out).toContain('Total Current assets');
    expect(out).toContain('Total liabilities and equity');
    expect(out).not.toMatch(/(^|\s)Ori(\s|$)/m);
    expect(out).not.toContain('Activo circulante');

    expect(err).toContain('Assets 1000.0000 = Liabilities + Equity 1000.0000');
  });

  /**
   * The csv this statement produces, EVERY column of it, written out by hand.
   *
   * Not just the identity columns: the defect that got here was in `name`, the
   * column an earlier version of this case deliberately skipped because the
   * command was composing «Total de Activo circulante» into the row and the
   * csv therefore changed with the reader. Asserting the whole file is what
   * would have caught it.
   */
  const BALANCE_SHEET_CSV = [
    'section,category,code,name,amount,line',
    'assets,current_assets,1110,Caja,1000.0000,account',
    'assets,current_assets,,,1000.0000,subtotal',
    'assets,,,,1000.0000,total',
    'liabilities,current_liabilities,2110,Proveedores,400.0000,account',
    'liabilities,current_liabilities,,,400.0000,subtotal',
    'liabilities,,,,400.0000,total',
    'equity,equity,3000,Capital social,500.0000,account',
    'equity,equity,,,500.0000,subtotal',
    'equity,ori,3600,Otros Resultados Integrales,100.0000,account',
    'equity,ori,,,100.0000,subtotal',
    'equity,,,,600.0000,total',
    ',,,,1000.0000,total',
    '',
  ].join('\n');

  async function statement(format: string, language: Language): Promise<string> {
    mockBalanceSheet();
    setLanguage(language);
    const { out } = await runCli([
      'report', 'balance-sheet', 'show', '--entity', 'Demo', '--format', format,
    ]);
    return out;
  }

  it('csv: the WHOLE file is the same bytes in both languages, subtotals included', async () => {
    const es = await statement('csv', 'es');
    const en = await statement('csv', 'en');

    expect(es).toBe(en);
    expect(es).toBe(BALANCE_SHEET_CSV);
    // Said once more from the other side: the sentences the table prints for
    // these same rows are nowhere in the file.
    for (const prose of [
      'Total de Activo circulante',
      'Total Current assets',
      'Suma del pasivo y el capital contable',
      'Total liabilities and equity',
    ]) {
      expect(es, `the csv carries "${prose}"`).not.toContain(prose);
    }
  });

  it('tsv and ndjson move with nobody either', async () => {
    for (const format of ['tsv', 'ndjson']) {
      const es = await statement(format, 'es');
      const en = await statement(format, 'en');
      expect(es, `${format} moved with the reader's language`).toBe(en);
      expect(es, `${format} lost its subtotal lines`).toContain('subtotal');
      expect(es, `${format} carries prose`).not.toContain('Total');
    }
  });

  it('json: the section and category of every row stay lowercase keys in both languages', async () => {
    mockBalanceSheet();

    const sections = async (language: Language): Promise<string[]> => {
      setLanguage(language);
      const { out } = await runCli(['report', 'balance-sheet', 'show', '--entity', 'Demo', '--json']);
      const payload = JSON.parse(out) as { rows: { section: string; category: string }[] };
      return payload.rows.map((r) => `${r.section}|${r.category}`);
    };

    const es = await sections('es');
    const en = await sections('en');
    expect(es).toEqual(en);
    expect(es).toContain('assets|current_assets');
    expect(es).toContain('equity|ori');
    for (const pair of es) {
      expect(pair, 'an identity column came back as prose').toBe(pair.toLowerCase());
    }
  });

  // ---- `--format md -o`: the file the wiki teaches as the monthly hand-off --

  /**
   * The Spanish markdown, row by row, typed out.
   *
   * Markdown is the one deliverable a person opens without a terminal, and it
   * spent a commit printing `assets` and `current_assets` at accountants
   * because only the aligned table had the hook wired. Asserting the whole
   * document rather than a phrase of it is what pins every cell: the two
   * identity columns, the composed subtotal, the section total, and the grand
   * total that has a sentence of its own.
   */
  const BALANCE_SHEET_MD_ES = [
    '| section | category | code | name | amount | line |',
    '|---|---|---|---|---|---|',
    '| Activo | Activo circulante | 1110 | Caja | 1000.0000 | account |',
    '| Activo | Activo circulante |  | Total de Activo circulante | 1000.0000 | subtotal |',
    '| Activo |  |  | Total de Activo | 1000.0000 | total |',
    '| Pasivo | Pasivo a corto plazo | 2110 | Proveedores | 400.0000 | account |',
    '| Pasivo | Pasivo a corto plazo |  | Total de Pasivo a corto plazo | 400.0000 | subtotal |',
    '| Pasivo |  |  | Total de Pasivo | 400.0000 | total |',
    '| Capital contable | Capital contribuido | 3000 | Capital social | 500.0000 | account |',
    '| Capital contable | Capital contribuido |  | Total de Capital contribuido | 500.0000 | subtotal |',
    '| Capital contable | Otros resultados integrales | 3600 | Otros Resultados Integrales | 100.0000 | account |',
    '| Capital contable | Otros resultados integrales |  | Total de Otros resultados integrales | 100.0000 | subtotal |',
    '| Capital contable |  |  | Total de Capital contable | 600.0000 | total |',
    '|  |  |  | Suma del pasivo y el capital contable | 1000.0000 | total |',
    '',
  ].join('\n');

  /** The same document in English, also typed out rather than derived. */
  const BALANCE_SHEET_MD_EN = [
    '| section | category | code | name | amount | line |',
    '|---|---|---|---|---|---|',
    '| Assets | Current assets | 1110 | Caja | 1000.0000 | account |',
    '| Assets | Current assets |  | Total Current assets | 1000.0000 | subtotal |',
    '| Assets |  |  | Total Assets | 1000.0000 | total |',
    '| Liabilities | Current liabilities | 2110 | Proveedores | 400.0000 | account |',
    '| Liabilities | Current liabilities |  | Total Current liabilities | 400.0000 | subtotal |',
    '| Liabilities |  |  | Total Liabilities | 400.0000 | total |',
    '| Equity | Contributed capital | 3000 | Capital social | 500.0000 | account |',
    '| Equity | Contributed capital |  | Total Contributed capital | 500.0000 | subtotal |',
    '| Equity | Other comprehensive income | 3600 | Otros Resultados Integrales | 100.0000 | account |',
    '| Equity | Other comprehensive income |  | Total Other comprehensive income | 100.0000 | subtotal |',
    '| Equity |  |  | Total Equity | 600.0000 | total |',
    '|  |  |  | Total liabilities and equity | 1000.0000 | total |',
    '',
  ].join('\n');

  it('md: the monthly deliverable is labelled and composed in Spanish', async () => {
    expect(await statement('md', 'es')).toBe(BALANCE_SHEET_MD_ES);
  });

  it('md: the monthly deliverable is labelled and composed in English', async () => {
    expect(await statement('md', 'en')).toBe(BALANCE_SHEET_MD_EN);
  });

  it('md is a HUMAN format: it differs by language, and it is not the csv', async () => {
    const md = await statement('md', 'es');
    const csv = await statement('csv', 'es');

    // The two branches that must NOT agree, from identical rows.
    expect(md).not.toBe(await statement('md', 'en'));
    expect(md).not.toBe(csv);
    // …and they disagree about the right thing: md has the labels, csv the keys.
    expect(md).toContain('Total de Activo circulante');
    expect(csv).not.toContain('Total de Activo circulante');
    expect(csv).toContain('assets,current_assets');
    expect(md).not.toContain('current_assets');
    expect(md).not.toContain('| ori |');
    expect(md).not.toContain('| assets |');
  });

  // ---- the row stores identity; the sentence is composed at print time ----

  it('a subtotal row stores no prose, and the reader still gets the whole sentence', async () => {
    mockBalanceSheet();
    setLanguage('es');

    const { out: machine } = await runCli([
      'report', 'balance-sheet', 'show', '--entity', 'Demo', '--json',
    ]);
    const payload = JSON.parse(machine) as {
      rows: { section: string; category: string; code: string; name: string; amount: string; line: string }[];
    };

    const subtotals = payload.rows.filter((r) => r.line === 'subtotal');
    expect(subtotals).toHaveLength(4);
    for (const row of subtotals) {
      expect(row.name, `the subtotal of ${row.category} stored prose`).toBe('');
    }
    // The section totals too, and the grand total, which is the last row and is
    // written out whole: no section, no category, no code, no name.
    expect(payload.rows.filter((r) => r.line === 'total').map((r) => r.name)).toEqual(['', '', '', '']);
    expect(payload.rows.at(-1)).toEqual({
      section: '', category: '', code: '', name: '', amount: '1000.0000', line: 'total',
    });

    // Same command, same rows, human format: the sentence appears.
    const { out: human } = await runCli(['report', 'balance-sheet', 'show', '--entity', 'Demo']);
    expect(human).toContain('Total de Activo circulante');
    expect(human).toContain('Total de Pasivo a corto plazo');
    expect(human).toContain('Total de Otros resultados integrales');
  });

  it('the grand total says its own sentence, not «Total de » with nothing after it', async () => {
    // `section: ''`, `line: 'total'` is the row the accounting identity foots
    // on. A composer that only knew `t('report.total_of', …)` would label it
    // with an empty name and print «Total de » at the reader.
    const es = await statement('table', 'es');
    expect(es).toContain('Suma del pasivo y el capital contable');
    expect(es).not.toMatch(/Total de\s+1,000\.00/);
    expect(es).not.toContain('Total de Suma');

    const en = await statement('table', 'en');
    expect(en).toContain('Total liabilities and equity');
    expect(en).not.toMatch(/Total\s+1,000\.00/);
  });
});

describe('report income-statement show: the sections and the result, in both languages', () => {
  function mockIncomeStatement(): void {
    vi.mocked(reportService.getIncomeStatement).mockResolvedValue({
      entity_id: 'ent-1',
      start_date: '2026-08-01',
      end_date: '2026-08-31',
      revenue: {
        key: 'revenue', name: 'Revenue', total: '5000.0000',
        accounts: [{ id: 'r', code: '4100', name: 'Ventas', amount: '5000.0000' }],
      },
      expenses: {
        key: 'expenses', name: 'Expenses', total: '3000.0000',
        accounts: [{ id: 'e', code: '5100', name: 'Sueldos', amount: '3000.0000' }],
      },
      net_income: '2000.0000',
    });
  }

  const argv = [
    'report', 'income-statement', 'show', '--entity', 'Demo',
    '--since', '2026-08-01', '--until', '2026-08-31',
  ];

  it('Spanish', async () => {
    mockIncomeStatement();
    setLanguage('es');
    const { code, out, err } = await runCli(argv);
    expect(code).toBe(0);
    expect(out).toContain('Ingresos');
    expect(out).toContain('Gastos');
    expect(out).toContain('Total de Ingresos');
    expect(out).toContain('Total de Gastos');
    expect(out).toContain('Utilidad neta');
    expect(out).not.toContain('Net income');
    expect(err).toContain('Ingresos 5000.0000   Gastos 3000.0000   Utilidad neta 2000.0000');
  });

  it('English', async () => {
    mockIncomeStatement();
    setLanguage('en');
    const { code, out, err } = await runCli(argv);
    expect(code).toBe(0);
    expect(out).toContain('Total Revenue');
    expect(out).toContain('Total Expenses');
    expect(out).toContain('Net income');
    expect(out).not.toContain('Utilidad neta');
    expect(err).toContain('Revenue 5000.0000   Expenses 3000.0000   Net income 2000.0000');
  });

  it('csv: the section column is the key, identical in both languages', async () => {
    mockIncomeStatement();

    setLanguage('es');
    const es = await runCli([...argv, '--format', 'csv']);
    setLanguage('en');
    const en = await runCli([...argv, '--format', 'csv']);

    const firstColumn = (csv: string): string[] =>
      csv.trim().split('\n').map((line) => line.split(',')[0]);

    expect(firstColumn(es.out)).toEqual(firstColumn(en.out));
    // Written out rather than derived: these are the two section keys and the
    // empty one of the net-income row. A labeller moved onto the row would
    // show up here as «Ingresos» / «Revenue» instead.
    expect(firstColumn(es.out)).toEqual([
      'section', 'revenue', 'revenue', 'expenses', 'expenses', '',
    ]);
  });

  it('csv: the WHOLE file is the same bytes in both languages, the bottom line included', async () => {
    mockIncomeStatement();
    setLanguage('es');
    const es = await runCli([...argv, '--format', 'csv']);
    setLanguage('en');
    const en = await runCli([...argv, '--format', 'csv']);

    expect(es.out).toBe(en.out);
    expect(es.out).toBe(
      [
        'section,code,name,amount,line',
        'revenue,4100,Ventas,5000.0000,account',
        'revenue,,,5000.0000,total',
        'expenses,5100,Sueldos,3000.0000,account',
        'expenses,,,3000.0000,total',
        ',,,2000.0000,total',
        '',
      ].join('\n')
    );
    // The bottom line is the row that used to store «Net income» in the file.
    expect(es.out).not.toContain('Net income');
    expect(es.out).not.toContain('Utilidad neta');
  });

  async function markdown(language: Language): Promise<string> {
    mockIncomeStatement();
    setLanguage(language);
    const { out } = await runCli([...argv, '--format', 'md']);
    return out;
  }

  it('md: Spanish, labelled and composed down to the bottom line', async () => {
    expect(await markdown('es')).toBe(
      [
        '| section | code | name | amount | line |',
        '|---|---|---|---|---|',
        '| Ingresos | 4100 | Ventas | 5000.0000 | account |',
        '| Ingresos |  | Total de Ingresos | 5000.0000 | total |',
        '| Gastos | 5100 | Sueldos | 3000.0000 | account |',
        '| Gastos |  | Total de Gastos | 3000.0000 | total |',
        '|  |  | Utilidad neta | 2000.0000 | total |',
        '',
      ].join('\n')
    );
  });

  it('md: English, labelled and composed down to the bottom line', async () => {
    expect(await markdown('en')).toBe(
      [
        '| section | code | name | amount | line |',
        '|---|---|---|---|---|',
        '| Revenue | 4100 | Ventas | 5000.0000 | account |',
        '| Revenue |  | Total Revenue | 5000.0000 | total |',
        '| Expenses | 5100 | Sueldos | 3000.0000 | account |',
        '| Expenses |  | Total Expenses | 3000.0000 | total |',
        '|  |  | Net income | 2000.0000 | total |',
        '',
      ].join('\n')
    );
  });

  it('the bottom line is «Utilidad neta», not «Total de » with nothing after it', async () => {
    // `section: ''` on the last row of an income statement means the result of
    // the period, which has a name of its own. A composer that fell through to
    // `report.total_of` would hand the reader a dangling preposition.
    const md = await markdown('es');
    expect(md).toContain('| Utilidad neta |');
    expect(md).not.toContain('| Total de  |');
    expect(md).not.toContain('|  |  | Total de ');
  });
});

// ============================================================
// NO ENGLISH LABEL COMES BACK INTO THE COMMAND
//
// Read by the SEAM (`crudoDe`), never by importing the module under judgement:
// an assertion that `import`ed report-command.ts could not tell a source that
// still holds the literal from one that does not, because what it would see is
// the evaluated module and not its text.
// ============================================================

/**
 * The source with its WHOLE-LINE comments dropped.
 *
 * `sinComentarios` is blind in a file this size and this full of backticks, so
 * the filtering happens here and stays deliberately timid: only a line that
 * BEGINS a comment is removed, which cannot eat a string literal, and is
 * enough — every anchor below is code, and the prose that mentions «net
 * income» in this file lives in comments and in `--help` examples.
 */
function sourceWithoutWholeLineComments(...relativePath: string[]): string {
  return crudoDe(...relativePath)
    .split('\n')
    .filter((line) => {
      const start = line.trimStart();
      return !(start.startsWith('//') || start.startsWith('*') || start.startsWith('/*'));
    })
    .join('\n');
}

describe('report-command.ts coins no report label of its own', () => {
  const source = (): string => sourceWithoutWholeLineComments('src/cli/report-command.ts');

  it('the three English labels that lived in its shadow are gone', () => {
    const text = source();
    // Each of these was printed at every reader in every language, and none of
    // them had a single assertion — which is why deleting them broke nothing.
    expect(text).not.toContain("'Total Liabilities and Equity'");
    expect(text).not.toContain("'Net income'");
    expect(text).not.toContain('= Liabilities + Equity');
  });

  it('no label is built by pasting the word Total onto another one', () => {
    const text = source();
    // `Total ${…}` does not survive translation: Spanish needs «Total de …».
    expect(text).not.toContain('`Total ${');
    expect(text).not.toContain('Total ' + '${section.name}');
    expect(text).not.toContain('Total ' + '${sub.name}');
  });

  it('the row carries the key and the catalog carries the prose', () => {
    const text = source();
    expect(text).toContain('section: section.key');
    expect(text).toContain('category: sub.key');
    expect(text).not.toContain('section: section.name');
    expect(text).not.toContain('category: sub.name');

    expect(text).toContain("t('report.total_of'");
    expect(text).toContain("t('report.total_liabilities_and_equity')");
    expect(text).toContain("t('report.net_income')");
    expect(text).toContain("t('report.balance_check'");
    expect(text).toContain("t('report.income_summary'");
  });

  it('both statements hand the kernel their labellers, so the table can render them', () => {
    const text = source();
    expect(text).toContain('labelled: { section: sectionOf, category: categoryOf, name: balanceSheetName }');
    expect(text).toContain('labelled: { section: sectionOf, name: incomeStatementName }');
  });

  it('the service is not the one translating: it never reaches for the catalog', () => {
    // The invariant the edge exists to protect. A service that called
    // `getLanguage()` would answer every HTTP request in the language of the
    // PROCESS and ignore Accept-Language, which is the defect I9 just closed.
    const service = sourceWithoutWholeLineComments('src/services/reporting/report-service.ts');
    expect(service).not.toMatch(/from '\.\.\/\.\.\/i18n\//);
    expect(service).not.toContain('getLanguage(');
  });

  it('the kernel hands the labeller to BOTH human branches and to no other', () => {
    // Read by the seam for the same reason as everything above it. The two
    // calls below are the whole split: markdown was left out of it for a
    // commit, and `--format md` — the hand-off the wiki teaches — printed
    // `assets` where the aligned table printed «Activo».
    const kernel = sourceWithoutWholeLineComments('src/cli/kernel/output.ts');
    expect(kernel).toContain('toTable(rows, cols, numeric, p, opts.jurisdiction, opts.labelled)');
    expect(kernel).toContain('toMarkdown(rows, cols, opts.labelled)');
    // And the machine branches compose from `rows` and `cols` alone.
    expect(kernel).toContain("toDelimited(rows, cols, format === 'csv' ? ',' : '\\t')");
    expect(kernel).not.toMatch(/toDelimited\([^)]*labelled/);
  });
});
