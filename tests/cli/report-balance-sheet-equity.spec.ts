import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Command } from 'commander';

// ============================================================
// MNE-001-652 (#597) · WHAT THE BALANCE SHEET PRINTS FOR EQUITY
//
// The REAL service and the REAL command, with only the SQL replaced: the two
// queries of `getBalanceSheet` answer the hand figures below. So the order of
// the lines and the earned-capital total are the ones a person would read,
// not the ones a fixture typed.
//
// NIF B-6 presents capital contable as contributed plus earned capital; NIF
// C-11 (migration 346's header) puts the reserves, the accumulated results and
// the ORI in earned capital, and the result of the period is an accumulated
// result not yet swept.
//
// Hand figures: bank 3,800.00 = share capital 2,500.00 + legal reserve 100.00
// + prior years' results 400.00 + ORI 500.00 + result of the period 300.00.
// Contributed 2,500.00; earned 1,300.00; equity 3,800.00. All data synthetic.
// ============================================================

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: vi.fn(),
  resolveEntity: vi.fn(async () => ({
    entityId: 'ent-1', entityName: 'Demo Corp MX', tenantId: 'ten-1',
    currency: 'MXN', country: 'MX', accountingStandard: 'NIF', taxId: 'X',
  })),
  listEntities: vi.fn(async () => [{ id: 'ent-1' }]),
}));

vi.mock('../../src/database/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/database/connection.js')>()),
  query: vi.fn(),
}));

import { registerReportCommand } from '../../src/cli/report-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { palette } from '../../src/cli/palette.js';
import { resetLanguage, setLanguage, type Language } from '../../src/i18n/index.js';
import { query } from '../../src/database/connection.js';

const mockQuery = query as unknown as Mock;
const noColor = palette({ isTTY: false } as NodeJS.WriteStream);

/** The rows `queryBalanceSheetRows` hands back, debit-positive, in code order. */
const STATEMENT_ROWS = [
  { id: 'a', code: '1110', name: 'Bancos', account_type: 'asset', fs_category: 'current_assets', balance: '3800.0000' },
  { id: 'c', code: '3100', name: 'Capital social', account_type: 'equity', fs_category: 'equity', balance: '-2500.0000' },
  { id: 'r', code: '3150', name: 'Reserva legal', account_type: 'equity', fs_category: 'earned_capital', balance: '-100.0000' },
  { id: 'p', code: '3200', name: 'Resultado de ejercicios anteriores', account_type: 'equity', fs_category: 'earned_capital', balance: '-400.0000' },
  { id: 'o', code: '3600', name: 'Otros resultados integrales', account_type: 'equity', fs_category: 'ori', balance: '-500.0000' },
];

async function balanceSheet(language: Language, ...format: string[]): Promise<{ code: number | undefined; out: string }> {
  mockQuery.mockResolvedValueOnce({ rows: STATEMENT_ROWS });
  // Revenue 500.00 credit, expense 200.00 debit: a debit-positive net of -300.00.
  mockQuery.mockResolvedValueOnce({ rows: [{ balance: '-300.0000' }] });
  setLanguage(language);

  resetDeclarations();
  const program = new Command('mnemosine');
  let code: number | undefined;
  registerReportCommand(program, {
    palette: noColor,
    shutdown: (c: number) => { code = c; },
    reportError: (e) => { process.stderr.write(`${(e as Error).message}\n`); },
  });
  let out = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk); return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    await program.parseAsync([
      'node', 'mnemosine', 'report', 'balance-sheet', 'show', '--entity', 'Demo', '--as-of', '2026-12-31', ...format,
    ]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { code, out };
}

beforeEach(() => { mockQuery.mockReset(); });
afterEach(() => { resetDeclarations(); resetLanguage(); });

/** Equity, as the Spanish markdown prints it: every cell typed by hand. */
const EQUITY_MD_ES = [
  '| Capital contable | Capital contribuido | 3100 | Capital social | 2500.0000 | account |',
  '| Capital contable | Capital contribuido |  | Total de Capital contribuido | 2500.0000 | subtotal |',
  '| Capital contable | Reservas y resultados acumulados | 3150 | Reserva legal | 100.0000 | account |',
  '| Capital contable | Reservas y resultados acumulados | 3200 | Resultado de ejercicios anteriores | 400.0000 | account |',
  '| Capital contable | Reservas y resultados acumulados |  | Total de Reservas y resultados acumulados | 500.0000 | subtotal |',
  '| Capital contable | Utilidad (pérdida) del ejercicio |  | Total de Utilidad (pérdida) del ejercicio | 300.0000 | subtotal |',
  '| Capital contable | Otros resultados integrales | 3600 | Otros resultados integrales | 500.0000 | account |',
  '| Capital contable | Otros resultados integrales |  | Total de Otros resultados integrales | 500.0000 | subtotal |',
  '| Capital contable | Capital ganado |  | Total de Capital ganado | 1300.0000 | group |',
  '| Capital contable |  |  | Total de Capital contable | 3800.0000 | total |',
  '|  |  |  | Suma del pasivo y el capital contable | 3800.0000 | total |',
];

/** The same lines in English, typed out rather than derived. */
const EQUITY_MD_EN = [
  '| Equity | Contributed capital | 3100 | Capital social | 2500.0000 | account |',
  '| Equity | Contributed capital |  | Total Contributed capital | 2500.0000 | subtotal |',
  '| Equity | Reserves and retained earnings | 3150 | Reserva legal | 100.0000 | account |',
  '| Equity | Reserves and retained earnings | 3200 | Resultado de ejercicios anteriores | 400.0000 | account |',
  '| Equity | Reserves and retained earnings |  | Total Reserves and retained earnings | 500.0000 | subtotal |',
  '| Equity | Profit (loss) for the period |  | Total Profit (loss) for the period | 300.0000 | subtotal |',
  '| Equity | Other comprehensive income | 3600 | Otros resultados integrales | 500.0000 | account |',
  '| Equity | Other comprehensive income |  | Total Other comprehensive income | 500.0000 | subtotal |',
  '| Equity | Earned capital |  | Total Earned capital | 1300.0000 | group |',
  '| Equity |  |  | Total Equity | 3800.0000 | total |',
  '|  |  |  | Total liabilities and equity | 3800.0000 | total |',
];

/** The equity lines of the csv: keys only, the same bytes in both languages. */
const EQUITY_CSV = [
  'equity,equity,3100,Capital social,2500.0000,account',
  'equity,equity,,,2500.0000,subtotal',
  'equity,earned_capital,3150,Reserva legal,100.0000,account',
  'equity,earned_capital,3200,Resultado de ejercicios anteriores,400.0000,account',
  'equity,earned_capital,,,500.0000,subtotal',
  'equity,result_of_the_period,,,300.0000,subtotal',
  'equity,ori,3600,Otros resultados integrales,500.0000,account',
  'equity,ori,,,500.0000,subtotal',
  'equity,earned_capital,,,1300.0000,group',
  'equity,,,,3800.0000,total',
  ',,,,3800.0000,total',
];

const equityLines = (out: string, first: RegExp): string[] => {
  const lines = out.split('\n');
  return lines.slice(lines.findIndex((l) => first.test(l))).filter((l) => l !== '');
};

describe('report balance-sheet show: contributed capital, then earned capital (MNE-001-652)', () => {
  it('es: contributed capital, then the components of earned capital and their total', async () => {
    const { code, out } = await balanceSheet('es', '--format', 'md');
    expect(code).toBe(0);
    expect(equityLines(out, /^\| Capital contable/)).toEqual(EQUITY_MD_ES);
  });

  it('en: the same lines, labelled in English', async () => {
    const { out } = await balanceSheet('en', '--format', 'md');
    expect(equityLines(out, /^\| Equity/)).toEqual(EQUITY_MD_EN);
  });

  it('the aligned table says «Total de Capital ganado» once, over the 1,300.00', async () => {
    const { out } = await balanceSheet('es');
    expect(out.match(/Total de Capital ganado/g)).toHaveLength(1);
    expect(out).toMatch(/Total de Capital ganado\s.*1,300\.00/);
    // No earned-capital account under a label that says «contribuido».
    for (const line of out.split('\n').filter((l) => /contribuido/.test(l))) {
      expect(line).not.toMatch(/3150|3200|3600|Utilidad/);
    }
  });

  it('csv: the keys, the same bytes in both languages', async () => {
    const es = (await balanceSheet('es', '--format', 'csv')).out;
    const en = (await balanceSheet('en', '--format', 'csv')).out;
    expect(es).toBe(en);
    expect(equityLines(es, /^equity,/)).toEqual(EQUITY_CSV);
  });

  it('json: the group row carries the key and the amount, and no prose', async () => {
    const { out } = await balanceSheet('es', '--json');
    const payload = JSON.parse(out) as { rows: { section: string; category: string; code: string; name: string; amount: string; line: string }[] };
    expect(payload.rows.filter((r) => r.line === 'group')).toEqual([
      { section: 'equity', category: 'earned_capital', code: '', name: '', amount: '1300.0000', line: 'group' },
    ]);
    expect(payload.rows.filter((r) => r.section === 'equity' && r.line !== 'account').map((r) => r.category)).toEqual([
      'equity', 'earned_capital', 'result_of_the_period', 'ori', 'earned_capital', '',
    ]);
  });
});
