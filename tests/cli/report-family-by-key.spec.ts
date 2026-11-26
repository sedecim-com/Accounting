import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';

// I8b · the report family speaks by key (MNE-001-807, #150). Under es-MX the refusals, headings, notes and
// verdicts of `cashflow`, `cashflow reconcile` and `report` are Spanish from the catalogue, written here by hand
// before the code; commands, policy keys, periods, dates and amounts pass through untranslated, and the machine
// formats keep the English row labels. The English was compared by a dump.

const CTX = { tenantId: 't1', entityId: 'e1', entityName: 'Entidad Sintetica SA', country: 'MX', currency: 'MXN', accountingStandard: 'mx_nif' };
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/cli/kernel/entity-context.js', async (o) => ({ ...(await o<Record<string, unknown>>()),
  resolveActiveEntity: vi.fn(async () => ({ ctx: CTX })), requireExplicitEntity: vi.fn(async () => CTX) }));
vi.mock('../../src/database/connection.js', async (o) => ({ ...(await o<Record<string, unknown>>()), query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));
vi.mock('../../src/services/reporting/report-service.js', async (o) => ({ ...(await o<Record<string, unknown>>()),
  resolvePeriodRange: vi.fn(), getTrialBalance: vi.fn(), getBalanceSheet: vi.fn(), getGeneralLedger: vi.fn(), getAgedPayables: vi.fn() }));
vi.mock('../../src/services/reporting/materialized-view-service.js', async (o) => ({ ...(await o<Record<string, unknown>>()), refreshReportingViews: vi.fn(), getReportingViewStatus: vi.fn() }));
vi.mock('../../src/services/reporting/cash-flow-service.js', async (o) => ({ ...(await o<Record<string, unknown>>()), getCashFlowStatement: vi.fn() }));
vi.mock('../../src/services/accounting/account-service.js', async (o) => ({ ...(await o<Record<string, unknown>>()), resolveAccount: vi.fn() }));
vi.mock('../../src/services/reporting/cash-flow-reconcile.js', async (o) => ({ ...(await o<Record<string, unknown>>()), movimientoRealDeEfectivo: vi.fn(), conciliarFlujoDeEfectivo: vi.fn() }));

import { registerCashFlowCommand, rotuloDelMetodo } from '../../src/cli/cashflow-command.js';
import { registerReportCommand } from '../../src/cli/report-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import { englishUserStrings } from '../../scripts/language/lanes/cli-strings.js';
import * as rs from '../../src/services/reporting/report-service.js';
import * as mv from '../../src/services/reporting/materialized-view-service.js';
import * as cf from '../../src/services/reporting/cash-flow-service.js';
import * as cr from '../../src/services/reporting/cash-flow-reconcile.js';
import * as acc from '../../src/services/accounting/account-service.js';

const m = (f: unknown) => vi.mocked(f as (...a: unknown[]) => unknown);
const pass = (s: string) => s, palette = { dim: pass, bold: pass, cyan: pass, red: pass, green: pass, yellow: pass };
afterEach(() => { resetLanguage(); });

function build(): Command {
  resetDeclarations();
  const program = new Command('mnemosine').exitOverride();
  const deps = { palette, home: '/tmp/mnemosine-tests-no-home', shutdown: () => undefined, reportError: (e: unknown) => { process.stderr.write((e as { localized: () => string }).localized()); } };
  for (const register of [registerCashFlowCommand, registerReportCommand]) register(program, deps as never);
  return program;
}
async function es(...argv: string[]): Promise<string> {
  setLanguage('es');
  let out = '';
  const spies = [process.stdout, process.stderr].map((st) => vi.spyOn(st, 'write').mockImplementation((c: unknown) => { out += String(c); return true; }));
  await build().parseAsync(['node', 'mnemosine', ...argv]).catch(() => undefined);
  for (const s of spies) s.mockRestore();
  return out.replace(/[ \t]+/g, ' ');
}
const sec = (total: string, lines: unknown[] = []) => ({ total, lines });
const line = (code: string, name: string, amount: string) => ({ account_id: `a-${code}`, code, name, renglon: 'capital_de_trabajo', neto: amount, amount });
const statement = (over: Record<string, unknown> = {}) => ({ method: 'indirect', policies: { metodo: 'indirecto', cuentasDeEfectivo: 'rol', descuadre: 'avisar', sinClasificar: 'avisar' },
  operating_activities: { net_income: '30000.0000', non_cash: sec('0.0000'), working_capital: sec('-2000.0000', [line('1120', 'Clientes', '-2000.0000')]), total: '28000.0000' },
  investing_activities: sec('0.0000'), financing_activities: sec('0.0000'), unclassified: sec('0.0000'), net_cash_flow: '28000.0000', non_cash_transactions: [],
  cash_accounts: [{ code: '1110' }], self_check: { all_classified: true, note: '' }, ...over });
const cash = (moved = '28000.0000') => ({ saldo_inicial: '100000.0000', saldo_final: '128000.0000', variacion: moved });
const range = (matched: boolean) => ({ period_name: '2026-07', fiscal_period_id: matched ? 'fp1' : null, matched_fiscal_period: matched, start_date: '2026-07-01', end_date: '2026-07-31' });
const tb = (over: Record<string, unknown> = {}) => ({ rows: [], total: 2, totals: { total_debits: '10.0000', total_credits: '10.0000', is_balanced: true }, closing: null, inicial: null, ...over });

describe('under es-MX, cashflow and cashflow reconcile speak Spanish', () => {
  it('the refusals, the heading, the table in Spanish while csv keeps English, and the tie', async () => {
    expect(await es('cashflow', 'generate', '--method', 'lateral')).toContain('--method tiene que ser uno de: indirect, direct (indirecto, directo); llegó "lateral". El método no es cosmético');
    expect(await es('cashflow', 'generate')).toContain('cashflow generate necesita un periodo: pasa --period (2026-07, 2026-Q3, FY2026) o --since y --until juntos.');
    expect(await es('cashflow', 'reconcile')).toContain('cashflow reconcile necesita un periodo:');
    m(rs.resolvePeriodRange).mockResolvedValue(range(false));
    m(cf.getCashFlowStatement).mockResolvedValue(statement({ non_cash_transactions: [{ entry_number: 'PD-1', entry_date: '2026-07-09', amount: '8000.0000' }] }));
    m(cr.movimientoRealDeEfectivo).mockResolvedValue(cash());
    const out = await es('cashflow', 'generate', '--period', '2026-13');
    expect(out).toContain('"2026-13" no coincide con un solo periodo fiscal; se usa el rango de calendario 2026-07-01 → 2026-07-31.');
    expect(out).toContain('Estado de flujos de efectivo · Entidad Sintetica SA · MXN · 2026-07-01 → 2026-07-31');
    expect(out).toContain('método: indirect (política `flujo_efectivo_metodo` · indirecto)');
    expect(out).toContain('Efectivo y equivalentes: 1110 (criterio «rol»)');
    for (const label of ['Utilidad neta', 'Total del cambio en el capital de trabajo', 'Flujo neto de actividades de operación', 'Cambio neto en el efectivo',
      'Efectivo y equivalentes, saldo inicial', 'Efectivo y equivalentes, movimiento en el mayor', 'Residuo (neto del estado − movimiento en el mayor)']) expect(out).toContain(label);
    expect(out).toContain(' 1120 Clientes ');
    expect(out).toContain('1 operación de inversión o financiamiento que no movió efectivo, excluida del estado y revelada aquí: PD-1 (2026-07-09) 8000.0000');
    expect(out).toContain('Amarra: el neto del estado es igual al movimiento del efectivo y equivalentes en el mayor.');
    const csv = await es('cashflow', 'generate', '--period', '2026-07', '--format', 'csv');
    expect(csv).toContain('operating,account,,Net income,30000.0000');
    expect(csv).toContain('cash,residue,,Residue (statement net − ledger movement),0.0000');
    expect(rotuloDelMetodo(statement() as never, 'directo')).toBe('método: indirect (--method · indirecto)');
    m(cr.conciliarFlujoDeEfectivo).mockResolvedValue({ method: 'indirect', efectivo: { ...cash(), cuentas: [{ code: '1110' }], criterio: 'rol', criterio_definido: true },
      residuo: { derivado: '1', real: '1', importe: '0', cuadra: true }, aviso: null, hallazgos: { blocking: 0, warning: 0 } });
    expect(await es('cashflow', 'reconcile', '--period', '2026-13')).toContain('Conciliación del flujo de efectivo · Entidad Sintetica SA · MXN · 2026-07-01 → 2026-07-31');
  });
  it('the residue under each answer of flujo_efectivo_descuadre, and a net that ties unclassified', async () => {
    m(rs.resolvePeriodRange).mockResolvedValue(range(true));
    m(cr.movimientoRealDeEfectivo).mockResolvedValue(cash('25000.0000'));
    const untied = 'El estado no amarra con el efectivo: declara un neto de 28000.0000 y el efectivo y equivalentes se movieron 25000.0000 en el mayor. Residuo de 3000.0000, impreso arriba y sin absorberse en ningún renglón. Corre `mnemosine cashflow reconcile --show-candidates`.';
    const said = async (answer: string) => {
      m(cf.getCashFlowStatement).mockResolvedValue(statement({ policies: { metodo: 'indirecto', cuentasDeEfectivo: 'rol', descuadre: answer, sinClasificar: 'avisar' } }));
      return es('cashflow', 'generate', '--period', '2026-07');
    };
    expect(await said('avisar')).toContain(untied);
    expect(await said('bloquear')).toContain(`${untied} La política \`flujo_efectivo_descuadre\` es «bloquear»: el estado no se sostiene.`);
    expect(await said('silencio')).toContain(`${untied} La política \`flujo_efectivo_descuadre\` es «silencio»: se informa como nota, no como hallazgo.`);
    m(cr.movimientoRealDeEfectivo).mockResolvedValue(cash());
    m(cf.getCashFlowStatement).mockResolvedValue(statement({ unclassified: sec('0.0000', [line('9999', 'Huerfana', '5.0000'), line('9998', 'Otra', '-5.0000')]), self_check: { all_classified: false, note: 'Dos cuentas sin sección.' } }));
    const out = await es('cashflow', 'generate', '--period', '2026-07');
    expect(out).toContain('Total sin clasificar (fuera de toda sección, y fuera del neto de arriba)');
    expect(out).toContain('El neto del estado amarra con el efectivo (28000.0000), pero no está clasificado: Dos cuentas sin sección. Los subtotales de arriba no se sostienen; el neto sí.');
  });
});

describe('under es-MX, report speaks Spanish', () => {
  it('the trial balance: refusals, scopes, the SAT recomputation and the footing', async () => {
    m(rs.getTrialBalance).mockResolvedValue(tb({ totals: { total_debits: '10.0000', total_credits: '9.5000', is_balanced: false } }));
    expect(await es('report', 'trial-balance', 'show', '--status', 'posted')).toContain('--status no aplica a "report trial-balance show": informa saldos contabilizados, no un estado del ciclo de vida.');
    expect(await es('report', 'trial-balance', 'show', '--level', '0')).toContain('--level tiene que ser un número entero de 1 o más; llegó "0".');
    const asOf = await es('report', 'trial-balance', 'show', '--as-of', '2026-07-31');
    expect(asOf).toContain('Balanza de comprobación · Entidad Sintetica SA · MXN · acumulado al 2026-07-31');
    expect(asOf).toContain('Cargos 10.0000 Abonos 9.5000 (2 cuentas) DESCUADRADA por 0.5000');
    m(rs.resolvePeriodRange).mockResolvedValue(range(true));
    m(rs.getTrialBalance).mockResolvedValue(tb({ total: 1, inicial: { note: 'nota', descuadres: ['1', '2', '3', '4', '5', '6'].map((d) => ({ account_code: `11${d}0`, diferencia: `${d}.00` })) } }));
    const period = await es('report', 'trial-balance', 'show', '--period', '2026-07');
    expect(period).toContain('Balanza de comprobación · Entidad Sintetica SA · MXN · periodo 2026-07');
    expect(period).toContain('SaldoIni + Debe - Haber no da SaldoFin en 6 cuentas: 1110 (1.00), 1120 (2.00), 1130 (3.00), 1140 (4.00), 1150 (5.00) (+1)');
    expect(period).toContain('Cargos 10.0000 Abonos 10.0000 (1 cuenta) cuadra');
    m(rs.getTrialBalance).mockResolvedValue(tb());
    expect(await es('report', 'trial-balance', 'show', '--since', '2026-01-01')).toContain('· 2026-01-01 → hoy');
    expect(await es('report', 'trial-balance', 'show', '--until', '2026-06-30')).toContain('· inicio → 2026-06-30');
    expect(await es('report', 'trial-balance', 'show')).toContain('· todo lo contabilizado');
  });
  it('the statements, the ledger, the aging and the views', async () => {
    m(rs.getBalanceSheet).mockResolvedValue({ assets: { key: 'assets', total: '100.0000', subsections: [] }, liabilities: { key: 'liabilities', total: '60.0000', subsections: [] },
      equity: { key: 'equity', total: '30.0000', subsections: [] }, earned_capital: { key: 'earned_capital', total: '0', subsections: [] }, total_liabilities_and_equity: '90.0000', is_balanced: false, out_of_balance: '10.0000' });
    const sheet = await es('report', 'balance-sheet', 'show', '--as-of', '2026-07-31');
    expect(sheet).toContain('Balance general · Entidad Sintetica SA · MXN · al 2026-07-31');
    expect(sheet).toContain('El balance general no cuadra: activo 100.0000 contra pasivo más capital 90.0000, una diferencia de 10.0000. El propio mayor es inconsistente a esta fecha; corre `mnemosine entry check`');
    expect(await es('report', 'income-statement', 'show')).toContain('Un estado de resultados cubre un periodo. Pasa --period <expr>, o --since y --until juntos.');
    m(acc.resolveAccount).mockResolvedValue({ id: 'a1', code: '1110' });
    m(rs.getGeneralLedger).mockResolvedValue({ rows: [], total: 3, period_debits: '5.0000', period_credits: '5.0000' });
    const ledger = await es('report', 'general-ledger', 'show', '--as-of', '2026-07-31', '--account', '1110');
    expect(ledger).toContain('Libro mayor · Entidad Sintetica SA · MXN · acumulado al 2026-07-31 · cuenta 1110');
    expect(ledger).toContain('Cargos de la página 5.0000 abonos de la página 5.0000 (0 de 3 movimientos)');
    m(rs.getAgedPayables).mockResolvedValue({ rows: [], total: 0, totals_by_currency: [], total_book_amount_due: '0.0000', balance_basis: 'current' });
    const aging = await es('report', 'aged-payable', 'show', '--as-of', '2020-01-31');
    expect(aging).toContain('Antigüedad de saldos por pagar · Entidad Sintetica SA · MXN · al 2020-01-31');
    expect(aging).toContain('--as-of 2020-01-31 sólo envejece los vencimientos. Los importes son los saldos abiertos de hoy, no los saldos como estaban en esa fecha.');
    m(mv.getReportingViewStatus).mockResolvedValue([{ view: 'mv_trial_balance', is_stale: true }]);
    const stale = await es('report', 'view', 'show');
    expect(stale).toContain('Vistas de informes · Entidad Sintetica SA · MXN · totales de cada vista contra el mayor vivo');
    expect(stale).toContain('Al menos una vista ya no coincide con el mayor.');
    expect(stale).toContain('Reconstrúyelas con `mnemosine report view sync`.');
    m(mv.getReportingViewStatus).mockResolvedValue([{ view: 'mv_trial_balance', is_stale: false }]);
    expect(await es('report', 'view', 'show')).toContain('Todas las vistas de informes coinciden con el mayor.');
    m(mv.refreshReportingViews).mockResolvedValue([]);
    expect(await es('report', 'view', 'sync')).toContain('Vistas de informes reconstruidas para todas las entidades de esta instalación.');
  });
});

describe('the lane', () => {
  it('counts no English string without a key in the three files', () => {
    for (const f of ['cashflow-command', 'report-command', 'cashflow-reconcile-command']) {
      const rel = `src/cli/${f}.ts`;
      expect(englishUserStrings(fs.readFileSync(path.resolve(rel), 'utf8'), rel), rel).toEqual([]);
    }
  });
});
