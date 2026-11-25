import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// ============================================================
// I8.9 · the ledger family speaks by key, part 2 (MNE-001-230, #271): fx,
// ledger, entry, period and year
//
// One row per key this part adds to the I8.9 block, through the real leaf
// over doubles (the services are mocked), in English (the test locale is
// en-US) and in es-MX, with a singular and a plural where «(s)» used to be.
// English that was printed before is the same byte for byte; Spanish reads
// word for word as before, except the plurals.
// ============================================================

const CTX = { tenantId: 'T1', entityId: 'E1', entityName: 'Entidad Sintetica SA', country: 'MX', currency: 'MXN' };

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  currentTenant: () => 'T1',
}));
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: vi.fn(async () => ({ userId: 'U1', email: 'contador@example.test' })),
}));
vi.mock('../../src/cli/kernel/entity-context.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveActiveEntity: vi.fn(async () => ({ ctx: CTX })),
  requireExplicitEntity: vi.fn(async () => CTX),
}));
vi.mock('../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));
vi.mock('../../src/services/fx/rate-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listarTipos: vi.fn(async () => []),
  verTipo: vi.fn(),
  fijarTipo: vi.fn(async () => ({ rate: '18.4231', id: 'R1' })),
}));
vi.mock('../../src/services/accounting/ledger-checks.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  runLedgerChecks: vi.fn(async () => []),
  listStaleDrafts: vi.fn(async () => []),
}));
vi.mock('../../src/services/reporting/report-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  getAuxiliaryView: vi.fn(),
}));
vi.mock('../../src/services/accounting/account-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveAccount: vi.fn(async (_e: string, code: string) => ({ id: 'A1', code, name: 'Bancos' })),
  getAccountBalanceByPeriod: vi.fn(async () => []),
}));
vi.mock('../../src/services/accounting/journal-entry-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  previewEntryPosting: vi.fn(),
  updateDraftEntry: vi.fn(async () => ({ entry_number: 'JE-0007' })),
  listEntriesWithLines: vi.fn(async () => []),
}));
vi.mock('../../src/services/accounting/entry-import-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  parseImportFile: vi.fn(),
  stageEntryImport: vi.fn(),
}));
vi.mock('../../src/services/accounting/fiscal-calendar-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listFiscalPeriods: vi.fn(async () => []),
  resolvePeriod: vi.fn(),
  getPeriodDetail: vi.fn(),
  openPeriod: vi.fn(),
  reopenClosedPeriod: vi.fn(),
  listFiscalYears: vi.fn(async () => []),
  getFiscalYear: vi.fn(),
  createFiscalYear: vi.fn(async () => ({ yearNumber: 2027, fiscalYearId: 'Y1', periods: 13 })),
  carryForwardIntoYear: vi.fn(),
}));
const keyStore = { repetido: false, resultado: undefined as unknown };
vi.mock('../../src/services/idempotency/idempotency-store.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  conLlave: vi.fn(async (_c: unknown, _k: unknown, fn: () => Promise<unknown>) =>
    keyStore.repetido ? { repetido: true, resultado: keyStore.resultado } : { repetido: false, resultado: await fn() }),
}));
const answer = { text: 'no' };
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: async () => answer.text, close: () => undefined }),
}));
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: vi.fn((p: string, ...rest: unknown[]) =>
      p === 'polizas.csv' ? 'fecha,cuenta,debe,haber\n' : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)),
  };
});

import { registerFxCommand } from '../../src/cli/fx-command.js';
import { registerLedgerCommand } from '../../src/cli/ledger-command.js';
import { registerEntryCommand } from '../../src/cli/entry-command.js';
import { registerPeriodCommand, registerYearCommand, reopenRemedy } from '../../src/cli/period-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import { AccountingError } from '../../src/utils/errors.js';
import { getPolicy } from '../../src/services/policy/policy-service.js';
import { verTipo } from '../../src/services/fx/rate-service.js';
import { listStaleDrafts, runLedgerChecks } from '../../src/services/accounting/ledger-checks.js';
import { getAuxiliaryView } from '../../src/services/reporting/report-service.js';
import { getAccountBalanceByPeriod } from '../../src/services/accounting/account-service.js';
import { listEntriesWithLines, previewEntryPosting } from '../../src/services/accounting/journal-entry-service.js';
import { parseImportFile, stageEntryImport } from '../../src/services/accounting/entry-import-service.js';
import {
  carryForwardIntoYear,
  createFiscalYear,
  getFiscalYear,
  getPeriodDetail,
  listFiscalYears,
  openPeriod,
  reopenClosedPeriod,
  resolvePeriod,
} from '../../src/services/accounting/fiscal-calendar-service.js';

type Localized = Error & { localized?: (l?: 'es' | 'en') => string };
const pass = (s: string) => s;
const palette = { dim: pass, bold: pass, cyan: pass, red: pass, green: pass, yellow: pass };

let out = '';
let err = '';
let tty: boolean | undefined;
beforeEach(() => {
  out = '';
  err = '';
  tty = process.stdin.isTTY;
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err += String(c); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetLanguage();
  (process.stdin as { isTTY?: boolean }).isTTY = tty;
});

// ---- the doubles ----------------------------------------------------------

const rate = (over: Record<string, unknown> = {}) => () => {
  vi.mocked(verTipo).mockResolvedValue({ rate: '18.4231', renglon: null, arrastradoDe: null, ...over } as never);
};
const policy = (value: string) => () => {
  vi.mocked(getPolicy).mockResolvedValue({ value } as never);
};
const findings = (blocking: number, warning: number) => () => {
  vi.mocked(runLedgerChecks).mockResolvedValue([
    ...Array.from({ length: blocking }, (_, i) => ({ check: 'balance', severity: 'blocking', referencia: `B${i}` })),
    ...Array.from({ length: warning }, (_, i) => ({ check: 'audit-trail', severity: 'warning', referencia: `W${i}` })),
  ] as never);
};
/** MNE-001-662: a `year-sweep` finding carries its text as a catalogue key, painted here at the edge. */
const lateAfterSweep = () => {
  vi.mocked(runLedgerChecks).mockResolvedValue([{
    check: 'year-sweep', severity: 'blocking', referencia: 'JE-2025-000009',
    detalle: 'posted to December 2025 on 2026-01-15, after … (English)',
    detail_key: 'ledger.check.year_sweep.found',
    detail_params: {
      period: 'December 2025', posted: '2026-01-15', sealed: 'Year-end adjustments 2025',
      sealed_at: '2026-01-10', accounts: '4100',
    },
  }] as never);
};
const drafts = (count: number) => () => {
  vi.mocked(listStaleDrafts).mockResolvedValue(
    Array.from({ length: count }, (_, i) => ({ entry_number: `JE-00${i}` })) as never
  );
};
const auxiliary = (over: Record<string, unknown> = {}) => () => {
  vi.mocked(getAuxiliaryView).mockResolvedValue({
    account_code: '1120', account_name: 'Bancos', period_name: 'July 2026', period_status: 'open',
    inicial: '1000.00', inicial_confiable: true, periodo_anterior: null,
    movimientos: [], total_movimientos: 0, cargos: '500.00', abonos: '200.00', final: '1300.00', final_calculado: '1300.00',
    ...over,
  } as never);
};
const parsed = (valid: number, invalid: number) => () => {
  vi.mocked(parseImportFile).mockReturnValue({
    validas: valid, invalidas: invalid,
    filas: Array.from({ length: invalid }, (_, i) => ({ row_number: i + 2, parse_error: 'fecha inválida' })),
  } as never);
};
const staged = (valid: number, invalid: number) => () => {
  parsed(valid, invalid)();
  vi.mocked(stageEntryImport).mockResolvedValue({ batchId: 'B7', validas: valid, invalidas: invalid } as never);
};
const PERIOD = { id: 'P7', period_name: 'July 2026', status: 'soft_close', start_date: '2026-07-01', end_date: '2026-07-31' };
const target = (over: Record<string, unknown> = {}) => () => {
  vi.mocked(resolvePeriod).mockResolvedValue({ ...PERIOD, ...over } as never);
};
const reopened = (previous: string) => () => {
  target({ status: previous })();
  vi.mocked(reopenClosedPeriod).mockResolvedValue({ period: { period_name: 'July 2026' }, previousStatus: previous } as never);
};
const detail = (over: Record<string, unknown> = {}) => () => {
  vi.mocked(getPeriodDetail).mockResolvedValue({
    ...PERIOD, period_number: 7, period_type: 'regular', year_number: 2026, overdue: true,
    soft_close_date: '2026-08-05T10:00:00.000Z', hard_close_date: '2026-08-10T10:00:00.000Z',
    closed_by_email: 'contador@example.test', entry_count: 0, entry_counts: {},
    close_checklist: [{ item: 'bank', is_complete: true }],
    ...over,
  } as never);
};
const existingYear = (periods: number) => () => {
  vi.mocked(listFiscalYears).mockResolvedValue([{ year_number: 2027, period_count: periods }] as never);
};

/** `year create` on a year whose predecessor was sealed before it existed (#594). */
const bornOnSealedBooks = (accounts: number) => () => {
  vi.mocked(createFiscalYear).mockResolvedValueOnce({
    created: true, yearNumber: 2027, fiscalYearId: 'Y1', periods: 13,
    opening: {
      previous: { period_name: 'Year-end adjustments 2026', status: 'hard_close' },
      carry: { carried: accounts, periods: ['January 2027'], stopped_at_locked: null },
    },
  } as never);
};

/** `year carry-forward run 2028`: what the carry corrected in the year's first period (#594). */
const carried = (codes: string[], written: boolean) => () => {
  vi.mocked(carryForwardIntoYear).mockResolvedValueOnce({
    year_number: 2028,
    period: { id: 'P1', period_name: 'January 2028', status: 'open' },
    carried_from: 'Year-end adjustments 2027',
    corrections: codes.map((code) => ({ code, before: '0.0000', after: '10000.0000' })),
    written,
  } as never);
};
const carryRefused = (code: string, key: string, params: Record<string, unknown>) => () => {
  vi.mocked(carryForwardIntoYear).mockRejectedValueOnce(new AccountingError(code, { key, params } as never));
};
const CARRY = ['year', 'carry-forward', 'run', '2028'];
const CARRY_NAMES = { period: 'January 2028', previous: 'Year-end adjustments 2027', year: 2028 };

type Where = 'error' | 'out' | 'err';
type Case = {
  key: string; argv: string[]; setup?: () => void; tty?: boolean; noEntity?: boolean;
  where: Where; en: string; es: string; prefix?: boolean;
};

async function run(c: Pick<Case, 'argv' | 'setup' | 'tty' | 'noEntity'>, lang: 'en' | 'es') {
  vi.clearAllMocks();
  keyStore.repetido = false;
  (process.stdin as { isTTY?: boolean }).isTTY = c.tty ?? false;
  // The defaults, again: a setup of an earlier row must not leak into this one.
  vi.mocked(getPolicy).mockResolvedValue({ value: 'dof' } as never);
  vi.mocked(runLedgerChecks).mockResolvedValue([]);
  vi.mocked(listStaleDrafts).mockResolvedValue([]);
  vi.mocked(getAccountBalanceByPeriod).mockResolvedValue([]);
  vi.mocked(listEntriesWithLines).mockResolvedValue([]);
  vi.mocked(listFiscalYears).mockResolvedValue([]);
  c.setup?.();
  if (lang === 'es') setLanguage('es');
  out = '';
  err = '';
  resetDeclarations();
  const state: { code?: number; error?: Localized } = {};
  const deps = {
    palette,
    home: '/tmp/mnemosine-tests-no-home',
    shutdown: (code: number) => { state.code = code; },
    reportError: (e: unknown) => { state.error = e as Localized; },
  };
  const cli = new Command('mnemosine').exitOverride();
  registerFxCommand(cli, deps);
  registerLedgerCommand(cli, deps);
  registerEntryCommand(cli, deps);
  registerPeriodCommand(cli, deps);
  registerYearCommand(cli, deps);
  await cli.parseAsync(['node', 'mnemosine', ...c.argv, ...(c.noEntity ? [] : ['-e', 'E1'])]);
  return {
    code: state.code,
    error: state.error?.localized ? state.error.localized() : (state.error?.message ?? ''),
    out,
    err,
  };
}

const NO_CONNECTOR_EN =
  'The download connector does not exist yet: this project does not speak HTTP with third parties without a governed credential, and ';
const NO_CONNECTOR_ES =
  'No existe todavía el conector de descarga: este proyecto no habla HTTP con terceros sin una credencial gobernada, y ';

const CASES: Case[] = [
  // ---- fx rate list ----
  { key: 'ledger.fx.list.status_unsupported', argv: ['fx', 'rate', 'list', '--status', 'open'], where: 'error',
    en: '--status does not apply here: a published exchange rate has no lifecycle state. Filter with --pair, --source, --rate-type, --since or --until.',
    es: '--status no aplica aquí: un tipo de cambio publicado no tiene estado de ciclo de vida. Filtra con --pair, --source, --rate-type, --since o --until.' },
  { key: 'cli.flag.error_not_date', argv: ['fx', 'rate', 'list', '--since', '2026-13-45'], where: 'error',
    en: '--since must be a date as YYYY-MM-DD; got "2026-13-45".', es: '--since tiene que ser una fecha AAAA-MM-DD; llegó "2026-13-45".' },
  { key: 'ledger.fx.list.policy', argv: ['fx', 'rate', 'list'], where: 'err', setup: policy('dof'),
    en: 'The fuente_tipo_cambio policy of this firm is "dof" → source \'dof\' (policy column: ✓).\n',
    es: 'La política fuente_tipo_cambio de este despacho es "dof" → source \'dof\' (columna policy: ✓).\n' },
  { key: 'ledger.fx.list.policy', argv: ['fx', 'rate', 'list'], where: 'err', setup: policy('OTRA'),
    en: 'The fuente_tipo_cambio policy of this firm is "OTRA", which this reader maps to no source.\n',
    es: 'La política fuente_tipo_cambio de este despacho es "OTRA", que este lector no mapea a ninguna fuente.\n' },
  { key: 'ledger.fx.list.no_entity', argv: ['fx', 'rate', 'list'], where: 'err',
    setup: () => { vi.mocked(getPolicy).mockRejectedValue(new Error('no entity')); },
    en: 'No active entity could be resolved: the source the firm policy uses could not be marked.\n',
    es: 'Sin entidad activa resoluble: no se pudo señalar la fuente que la política del despacho usa.\n' },

  // ---- fx rate show ----
  { key: 'ledger.fx.show.not_found', argv: ['fx', 'rate', 'show', 'USD/MXN', '2026-07-08'], where: 'error', setup: rate({ rate: null }),
    en: 'No USD/MXN rate (spot) can be resolved for 2026-07-08: not direct, not inverse, not crossed through USD. Capture it with fx rate set.',
    es: 'No hay tipo USD/MXN (spot) resoluble para 2026-07-08: ni directo, ni inverso, ni cruzado por USD. Captúralo con fx rate set.' },
  { key: 'ledger.fx.show.derived', argv: ['fx', 'rate', 'show', 'USD/MXN', '2026-07-08'], where: 'out', setup: rate(),
    en: 'USD/MXN 2026-07-08 = 18.4231000000 (spot, derived from the inverse or a cross)\n',
    es: 'USD/MXN 2026-07-08 = 18.4231000000 (spot, derivado del inverso o cruzado)\n' },
  { key: 'ledger.fx.show.inverse', argv: ['fx', 'rate', 'show', 'USD/MXN', '2026-07-08'], where: 'out',
    setup: rate({ renglon: { source: 'dof', inverse_rate: '0.0542796' } }),
    en: '  inverse MXN/USD = 0.0542796000\n', es: '  inverso MXN/USD = 0.0542796000\n' },
  { key: 'ledger.fx.show.inverse_derived', argv: ['fx', 'rate', 'show', 'USD/MXN', '2026-07-08'], where: 'out', setup: rate({ rate: '20' }),
    en: '  inverse MXN/USD = 0.0500000000 (derived)\n', es: '  inverso MXN/USD = 0.0500000000 (derivado)\n' },
  { key: 'ledger.fx.show.carried', argv: ['fx', 'rate', 'show', 'USD/MXN', '2026-07-08'], where: 'out', setup: rate({ arrastradoDe: '2026-07-07' }),
    en: "  ⚠ carried from 2026-07-07: there is no rate for the day asked. If you need that day's rate, capture it with fx rate set.\n",
    es: '  ⚠ arrastrado de 2026-07-07: no hay tipo del día pedido. Si necesitas el del día, captúralo con fx rate set.\n' },

  // ---- fx rate set ----
  { key: 'ledger.fx.set.source_required', argv: ['fx', 'rate', 'set', 'USD/MXN', '2026-07-08', '18.4231'], where: 'error', prefix: true,
    en: '--source is required: say who published the rate (', es: '--source es obligatoria: di quién publicó el tipo (' },
  { key: 'ledger.fx.set.would_set', argv: ['fx', 'rate', 'set', 'USD/MXN', '2026-07-08', '18.4231', '--source', 'dof', '--dry-run'], where: 'out',
    en: '\nWould set USD/MXN 2026-07-08 = 18.4231 (dof, spot)\n\n', es: '\nFijaría USD/MXN 2026-07-08 = 18.4231 (dof, spot)\n\n' },
  { key: 'ledger.fx.set.until', argv: ['fx', 'rate', 'set', 'USD/MXN', '2026-07-08', '18.4231', '--source', 'dof', '--until', '2026-07-09', '--dry-run'], where: 'out',
    en: '(dof, spot, until 2026-07-09)\n', es: '(dof, spot, hasta 2026-07-09)\n' },
  { key: 'ledger.fx.set.done', argv: ['fx', 'rate', 'set', 'USD/MXN', '2026-07-08', '18.4231', '--source', 'dof'], where: 'out',
    en: 'USD/MXN 2026-07-08 = 18.4231 (dof, spot)\n✔ set as 18.4231000000 · R1\n', es: 'USD/MXN 2026-07-08 = 18.4231 (dof, spot)\n✔ fijado como 18.4231000000 · R1\n' },

  // ---- fx rate download ----
  { key: 'ledger.fx.download.source_required', argv: ['fx', 'rate', 'download', '--dry-run'], where: 'error',
    en: '--source is required: dof, banxico-fix, fed, ecb.', es: '--source es obligatoria: dof, banxico-fix, fed, ecb.' },
  { key: 'ledger.fx.download.source_unknown', argv: ['fx', 'rate', 'download', '--source', 'boe', '--dry-run'], where: 'error',
    en: 'Unknown --source "boe". Use one of: dof, banxico-fix, fed, ecb.', es: '--source "boe" desconocida. Usa una de: dof, banxico-fix, fed, ecb.' },
  { key: 'ledger.fx.download.range_twice', argv: ['fx', 'rate', 'download', '--source', 'dof', '--as-of', '2026-07-08', '--since', '2026-07-01', '--dry-run'], where: 'error',
    en: '--as-of and --since/--until are two ways of saying the range; use one.', es: '--as-of y --since/--until son dos maneras de decir el rango; usa una.' },
  { key: 'ledger.fx.download.retry_calls_again', argv: ['fx', 'rate', 'download', '--source', 'dof', '--idempotency-key', 'K1'], where: 'error', prefix: true,
    en: 'a retry calls the exchange-rate provider again', es: 'un reintento vuelve a llamar al proveedor de tipos de cambio' },
  { key: 'ledger.fx.download.would_download', argv: ['fx', 'rate', 'download', '--source', 'fed', '--dry-run'], where: 'out',
    en: '\nWould download from Federal Reserve H.10\n', es: '\nDescargaría de Reserva Federal, H.10\n' },
  { key: 'ledger.fx.publisher.fed', argv: ['fx', 'rate', 'download', '--source', 'fed', '--dry-run'], where: 'out',
    en: 'from Federal Reserve H.10\n', es: 'de Reserva Federal, H.10\n' },
  { key: 'ledger.fx.publisher.ecb', argv: ['fx', 'rate', 'download', '--source', 'ecb', '--dry-run'], where: 'out',
    en: 'from European Central Bank, reference rates\n', es: 'de Banco Central Europeo, tipos de referencia\n' },
  { key: 'ledger.fx.publisher.dof', argv: ['fx', 'rate', 'download', '--source', 'dof', '--dry-run'], where: 'out',
    en: 'from the Federation Official Gazette (DOF; the tax rate of art. 20 CFF, and an operation takes the one published the business day before)\n',
    es: 'de Diario Oficial de la Federación (el fiscal del art. 20 CFF; para una operación rige el publicado el día hábil anterior)\n' },
  { key: 'ledger.fx.publisher.banxico_fix', argv: ['fx', 'rate', 'download', '--source', 'banxico-fix', '--dry-run'], where: 'out',
    en: 'from Banxico FIX through the SIE (needs a SIE API token)\n', es: 'de Banxico FIX vía SIE (requiere token del API SIE)\n' },
  { key: 'ledger.fx.download.dates', argv: ['fx', 'rate', 'download', '--source', 'dof', '--since', '2026-07-01', '--until', '2026-07-31', '--dry-run'], where: 'out',
    en: '  dates: 2026-07-01 → 2026-07-31\n', es: '  fechas: 2026-07-01 → 2026-07-31\n' },
  { key: 'ledger.fx.download.today', argv: ['fx', 'rate', 'download', '--source', 'dof', '--dry-run'], where: 'out',
    en: '  dates: (today)\n', es: '  fechas: (hoy)\n' },
  { key: 'ledger.fx.download.target', argv: ['fx', 'rate', 'download', '--source', 'dof', '--dry-run'], where: 'out',
    en: "  target: exchange_rates with source='dof' (057 lets DOF and FIX of the same day live side by side)\n",
    es: "  destino: exchange_rates con source='dof' (la 057 deja convivir DOF y FIX del mismo día)\n" },
  { key: 'ledger.fx.download.will_fail', argv: ['fx', 'rate', 'download', '--source', 'banxico-fix', '--dry-run'], where: 'out',
    en: `  ⚠ running it will fail: ${NO_CONNECTOR_EN}the Banxico SIE requires a token that no credential store of the system governs yet.`,
    es: `  ⚠ ejecutar fallará: ${NO_CONNECTOR_ES}el SIE de Banxico exige un token que ningún almacén de credenciales del sistema gobierna aún.` },
  { key: 'ledger.fx.download.no_connector', argv: ['fx', 'rate', 'download', '--source', 'ecb', '--yes'], where: 'error',
    en: `${NO_CONNECTOR_EN}there is no client declared for that source. Making up the rate would be the very fault the anti-simulation lock of the PACs prevents. Today the honest paths are: fx rate set <pair> <date> <rate> --source ecb with the published value, or fx rate import (phase 2) from a file.`,
    es: `${NO_CONNECTOR_ES}no hay cliente declarado para esa fuente. Fabricar el tipo sería el mismo pecado que el cerrojo antisimulación de los PAC impide. Hoy los caminos honestos son: fx rate set <par> <fecha> <tasa> --source ecb con el valor publicado, o fx rate import (fase 2) desde un archivo.` },

  // ---- ledger check ----
  { key: 'ledger.account.map.check.available', argv: ['ledger', 'check', '--check', ''], where: 'out',
    en: 'Available checks: ', es: 'Verificaciones disponibles: ' },
  { key: 'ledger.ledger.check.passes', argv: ['ledger', 'check', '--check', 'balance'], where: 'err',
    en: '✔ the ledger passes balance\n', es: '✔ el mayor pasa balance\n' },
  { key: 'ledger.ledger.check.blocking_checks', argv: ['ledger', 'check'], where: 'err',
    en: '✔ the ledger passes the blocking checks\n', es: '✔ el mayor pasa las verificaciones bloqueantes\n' },
  { key: 'ledger.ledger.check.findings', argv: ['ledger', 'check'], where: 'err', setup: findings(1, 1),
    en: '1 blocking finding, 1 warning\n', es: '1 hallazgo bloqueante, 1 advertencia\n' },
  { key: 'ledger.ledger.check.findings', argv: ['ledger', 'check'], where: 'err', setup: findings(2, 3),
    en: '2 blocking findings, 3 warnings\n', es: '2 hallazgos bloqueantes, 3 advertencias\n' },
  { key: 'ledger.check.year_sweep.found', argv: ['ledger', 'check', '--json'], where: 'out', setup: lateAfterSweep,
    en: 'posted to December 2025 on 2026-01-15, after Year-end adjustments 2025 swept the fiscal year on 2026-01-10: 4100 no longer agree with that sweep. Close Year-end adjustments 2025 again (period reopen, then close twice), or reverse the entry',
    es: 'posteada en December 2025 el 2026-01-15, después de que Year-end adjustments 2025 barrió el ejercicio el 2026-01-10: 4100 ya no cuadran con ese barrido. Cierra Year-end adjustments 2025 otra vez (period reopen y después close dos veces), o reversa la póliza' },

  // ---- ledger stale-draft list ----
  { key: 'ledger.ledger.stale_draft.days_unreadable', argv: ['ledger', 'stale-draft', 'list', '--days', 'x'], where: 'error',
    en: 'Unreadable --days: "x".', es: '--days ilegible: "x".' },
  { key: 'ledger.ledger.stale_draft.found', argv: ['ledger', 'stale-draft', 'list', '--days', '1'], where: 'err', setup: drafts(1),
    en: '1 draft older than 1 day. Post them with entry post, or withdraw them.\n', es: '1 borrador con más de 1 día. Se aplican con entry post, o se retiran.\n' },
  { key: 'ledger.ledger.stale_draft.found', argv: ['ledger', 'stale-draft', 'list'], where: 'err', setup: drafts(2),
    en: '2 drafts older than 30 days.', es: '2 borradores con más de 30 días.' },

  // ---- ledger auxiliary show ----
  { key: 'ledger.ledger.auxiliary.heading', argv: ['ledger', 'auxiliary', 'show', '--account', '1120', '--period', '2026-07'], where: 'err', setup: auxiliary(),
    en: '1120 Bancos · July 2026 (open) · beginning 1000.00\n', es: '1120 Bancos · July 2026 (open) · inicial 1000.00\n' },
  { key: 'ledger.ledger.auxiliary.no_carry', argv: ['ledger', 'auxiliary', 'show', '--account', '1120', '--period', '2026-07'], where: 'err',
    setup: auxiliary({ inicial_confiable: false, periodo_anterior: { period_name: 'June 2026', status: 'soft_close' } }),
    en: "· beginning 1000.00 (no carry-forward: June 2026 is 'soft_close')\n", es: "· inicial 1000.00 (sin arrastre: June 2026 está 'soft_close')\n" },
  { key: 'ledger.ledger.auxiliary.no_previous', argv: ['ledger', 'auxiliary', 'show', '--account', '1120', '--period', '2026-07'], where: 'err',
    setup: auxiliary({ inicial_confiable: false }),
    en: '(no previous period: there is no cumulative balance to carry)\n', es: '(sin periodo anterior: no hay acumulado que arrastrar)\n' },
  { key: 'ledger.ledger.auxiliary.totals', argv: ['ledger', 'auxiliary', 'show', '--account', '1120', '--period', '2026-07'], where: 'err', setup: auxiliary(),
    en: 'debits 500.00 · credits 200.00 · ending 1300.00\n', es: 'cargos 500.00 · abonos 200.00 · final 1300.00\n' },
  { key: 'ledger.ledger.auxiliary.drift', argv: ['ledger', 'auxiliary', 'show', '--account', '1120', '--period', '2026-07'], where: 'err',
    setup: auxiliary({ final_calculado: '1299.00' }),
    en: 'ending 1300.00 (computed 1299.00: there is drift — run ledger check)\n', es: 'final 1300.00 (calculado 1299.00: hay deriva — corre ledger check)\n' },

  // ---- ledger balance show ----
  { key: 'ledger.ledger.balance.dim_unavailable', argv: ['ledger', 'balance', 'show', '--account', '1111', '--dim', 'cc'], where: 'error',
    en: '--dim is not available yet: dimensions have no master record yet (dimension family).',
    es: '--dim aún no está disponible: las dimensiones no tienen maestro todavía (familia dimension).' },
  { key: 'ledger.account.balance.open_period_note', argv: ['ledger', 'balance', 'show', '--account', '1111'], where: 'err',
    setup: () => { vi.mocked(getAccountBalanceByPeriod).mockResolvedValue([{ period_name: 'July 2026', period_status: 'open' }] as never); },
    en: 'Note: beginning_balance is only seeded at the hard close; in open periods it reads the activity, not the cumulative balance.\n',
    es: 'Nota: beginning_balance solo se siembra en el cierre duro; en periodos abiertos lee la actividad, no el acumulado.\n' },

  // ---- entry ----
  { key: 'ledger.entry.preview.heading', argv: ['entry', 'preview', 'JE-0007'], where: 'err',
    setup: () => { vi.mocked(previewEntryPosting).mockResolvedValue({ entry_number: 'JE-0007', status: 'draft', period_name: 'July 2026', deltas: [], advertencias: [] } as never); },
    en: 'JE-0007 (draft) · July 2026 · delta by account if it were posted:\n', es: 'JE-0007 (draft) · July 2026 · delta por cuenta si se aplicara:\n' },
  { key: 'ledger.entry.preview.no_period', argv: ['entry', 'preview', 'JE-0007'], where: 'err',
    setup: () => { vi.mocked(previewEntryPosting).mockResolvedValue({ entry_number: 'JE-0007', status: 'draft', period_name: null, deltas: [], advertencias: [] } as never); },
    en: 'JE-0007 (draft) · no period · delta', es: 'JE-0007 (draft) · sin periodo · delta' },
  { key: 'ledger.entry.edit.done', argv: ['entry', 'edit', 'JE-0007', '--description', 'Renta de julio'], where: 'out',
    en: '✔ JE-0007 edited (still a draft; post it with entry post).\n', es: '✔ JE-0007 editada (sigue en borrador; se aplica con entry post).\n' },
  { key: 'ledger.entry.export.done', argv: ['entry', 'export'], where: 'err',
    setup: () => { vi.mocked(listEntriesWithLines).mockResolvedValue([{ entry_number: 'JE-0007' }] as never); },
    en: '1 line exported. No XLSX yet: use --format csv and open it in the spreadsheet.\n',
    es: '1 línea exportada. XLSX aún no: usa --format csv y ábrelo en la hoja de cálculo.\n' },
  { key: 'ledger.entry.export.done', argv: ['entry', 'export'], where: 'err', en: '0 lines exported.', es: '0 líneas exportadas.' },
  { key: 'ledger.entry.import.dry_run', argv: ['entry', 'import', 'polizas.csv', '--dry-run'], where: 'out', setup: parsed(1, 0),
    en: '1 readable entry, 0 with errors (dry-run: nothing was staged)\n', es: '1 póliza legible, 0 con error (dry-run: nada se preparó)\n' },
  { key: 'ledger.entry.import.dry_run', argv: ['entry', 'import', 'polizas.csv', '--dry-run'], where: 'out', setup: parsed(2, 1),
    en: '2 readable entries, 1 with errors', es: '2 pólizas legibles, 1 con error' },
  { key: 'ledger.batch.row', argv: ['entry', 'import', 'polizas.csv', '--dry-run'], where: 'err', setup: parsed(2, 1),
    en: '  · row 2: fecha inválida\n', es: '  · fila 2: fecha inválida\n' },
  { key: 'ledger.entry.import.done', argv: ['entry', 'import', 'polizas.csv'], where: 'out', setup: staged(1, 0),
    en: '✔ batch B7: 1 entry staged, 0 with errors\n', es: '✔ lote B7: 1 póliza preparada, 0 con error\n' },
  { key: 'ledger.entry.import.done', argv: ['entry', 'import', 'polizas.csv'], where: 'out', setup: staged(3, 2),
    en: '✔ batch B7: 3 entries staged, 2 with errors\n', es: '✔ lote B7: 3 pólizas preparadas, 2 con error\n' },
  { key: 'ledger.entry.import.repeated', argv: ['entry', 'import', 'polizas.csv', '--idempotency-key', 'K1'], where: 'out',
    setup: () => { parsed(1, 0)(); keyStore.repetido = true; keyStore.resultado = { batchId: 'B7', validas: 1, invalidas: 0 }; },
    en: ', 0 with errors [repeated: the batch of the first run]\n', es: ', 0 con error [repetido: lote de la primera corrida]\n' },
  { key: 'ledger.entry.import.not_in_ledger', argv: ['entry', 'import', 'polizas.csv'], where: 'err', setup: staged(1, 0),
    en: 'The batch did NOT touch the ledger: it is checked and posted with the batch family (check/post); meanwhile, it can be inspected by batch_id.\n',
    es: 'El lote NO tocó el mayor: se valida y aplica con la familia batch (check/post); mientras, es inspeccionable por batch_id.\n' },

  // ---- period ----
  { key: 'ledger.period.active_entity', argv: ['period', 'open', 'July 2026', '--dry-run'], noEntity: true, where: 'err', setup: target({ status: 'future' }),
    en: '  → Entidad Sintetica SA (active entity; name another with --entity)\n', es: '  → Entidad Sintetica SA (entidad activa; nombra otra con --entity)\n' },
  { key: 'ledger.period.status_unknown', argv: ['period', 'list', '--status', 'pending'], where: 'error', prefix: true,
    en: 'Unknown --status "pending". Use one of: ', es: '--status "pending" desconocido. Usa uno de: ' },
  { key: 'ledger.period.year_invalid', argv: ['period', 'list', '--year', 'dos mil'], where: 'error',
    en: '--year "dos mil" is not a four-digit year.', es: '--year "dos mil" no es un año de cuatro dígitos.' },
  { key: 'ledger.period.show.overdue', argv: ['period', 'show', 'July 2026'], where: 'out', setup: detail(),
    en: '\nJuly 2026  2026-07-01 → 2026-07-31 · soft_close · overdue\n', es: '\nJuly 2026  2026-07-01 → 2026-07-31 · soft_close · vencido\n' },
  { key: 'ledger.period.show.position', argv: ['period', 'show', 'July 2026'], where: 'out', setup: detail(),
    en: '  period 7 of fiscal year 2026 · regular\n', es: '  periodo 7 del ejercicio 2026 · regular\n' },
  { key: 'ledger.period.show.soft_closed', argv: ['period', 'show', 'July 2026'], where: 'out', setup: detail({ closed_by_email: null }),
    en: '  soft closed 2026-08-05T10:00:00.000Z\n', es: '  cierre suave el 2026-08-05T10:00:00.000Z\n' },
  { key: 'ledger.period.show.by', argv: ['period', 'show', 'July 2026'], where: 'out', setup: detail(),
    en: '  soft closed 2026-08-05T10:00:00.000Z by contador@example.test\n', es: '  cierre suave el 2026-08-05T10:00:00.000Z por contador@example.test\n' },
  { key: 'ledger.period.show.hard_closed', argv: ['period', 'show', 'July 2026'], where: 'out', setup: detail(),
    en: '  hard closed 2026-08-10T10:00:00.000Z\n', es: '  cierre duro el 2026-08-10T10:00:00.000Z\n' },
  { key: 'ledger.period.show.entries', argv: ['period', 'show', 'July 2026'], where: 'out', setup: detail({ entry_count: 3, entry_counts: { posted: 3 } }),
    en: '\n  Entries (3 total)\n    posted               3\n', es: '\n  Pólizas (3 en total)\n    posted               3\n' },
  { key: 'ledger.period.show.entries_total', argv: ['period', 'show', 'July 2026'], where: 'out', setup: detail(),
    en: 'Entries (0 total)\n', es: 'Pólizas (0 en total)\n' },
  { key: 'ledger.period.show.none', argv: ['period', 'show', 'July 2026'], where: 'out', setup: detail(),
    en: '(0 total)\n    none\n', es: '(0 en total)\n    ninguna\n' },
  { key: 'ledger.period.show.checklist', argv: ['period', 'show', 'July 2026'], where: 'out', setup: detail(),
    en: '\n  Checklist saved at close\n    ✔ bank\n', es: '\n  Lista de verificación guardada al cerrar\n    ✔ bank\n' },
  { key: 'ledger.period.open.would_open', argv: ['period', 'open', 'January 2027', '--dry-run'], where: 'out', setup: target({ status: 'future' }),
    en: '\nWould open July 2026 (future → open, 2026-07-01 → 2026-07-31)\n\n', es: '\nAbriría July 2026 (future → open, 2026-07-01 → 2026-07-31)\n\n' },
  { key: 'ledger.period.open.done', argv: ['period', 'open', 'July 2026'], where: 'out',
    setup: () => { target({ status: 'future' })(); vi.mocked(openPeriod).mockResolvedValue(PERIOD as never); },
    en: '✔ July 2026 is open (2026-07-01 → 2026-07-31)\n', es: '✔ July 2026 está abierto (2026-07-01 → 2026-07-31)\n' },

  // ---- period reopen ----
  { key: 'ledger.period.reopen.locked', argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste', '--dry-run'], where: 'error', setup: target({ status: 'locked' }),
    en: "July 2026 is 'locked': its information already left the system and it is not reopened — not even with --force. The correction goes in the nearest open period.",
    es: "July 2026 está 'locked': su información ya salió del sistema y no se reabre — ni con --force. La corrección va en el periodo abierto más próximo." },
  { key: 'ledger.period.reopen.not_closed', argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste', '--dry-run'], where: 'error', setup: target({ status: 'future' }),
    en: "July 2026 is 'future': reopening is only for closed periods.", es: "July 2026 está 'future': reabrir es sólo para periodos cerrados." },
  { key: 'ledger.period.reopen.hard_close', argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste', '--dry-run'], where: 'error', setup: target({ status: 'hard_close' }),
    en: 'July 2026 is in hard_close: its closing entries and the carry-forward of balances stay standing when it reopens (the ledger is not touched). If you really want to reopen it, repeat with --force --reason "<why>".',
    es: 'July 2026 está en hard_close: sus asientos de cierre y el arrastre de saldos quedan en pie al reabrir (el mayor no se toca). Si de verdad quieres reabrirlo, repite con --force --reason "<por qué>".' },
  { key: 'ledger.period.reopen.would_reopen', argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste', '--dry-run'], where: 'out', setup: target(),
    en: '\nWould reopen July 2026 (soft_close → open, 2026-07-01 → 2026-07-31)\n', es: '\nReabriría July 2026 (soft_close → open, 2026-07-01 → 2026-07-31)\n' },
  { key: 'ledger.period.reopen.dry_run', argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste', '--dry-run'], where: 'out', setup: target(),
    en: '  (dry-run: nothing was written; the reopen would be recorded in the audit trail)\n\n',
    es: '  (dry-run: nada se escribió; la reapertura quedaría en el rastro de auditoría)\n\n' },
  { key: 'ledger.period.reopen.question', argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste'], where: 'error', setup: target(),
    en: 'Reopen July 2026 (soft_close → open)? — there is no terminal to ask on. Re-run with --yes once you are sure, or with --dry-run to see the effect first.',
    es: '¿Reabrir July 2026 (soft_close → open)? — no hay terminal donde preguntar. Vuelve a correrlo con --yes cuando estés seguro, o con --dry-run para ver antes el efecto.' },
  { key: 'ledger.period.reopen.cancelled', argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste'], where: 'out', setup: target(), tty: true,
    en: 'Cancelled.\n', es: 'Cancelado.\n' },
  { key: 'ledger.period.reopen.idempotency_hit', argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste', '--yes', '--idempotency-key', 'K1'], where: 'out',
    setup: () => { target()(); keyStore.repetido = true; keyStore.resultado = { period_name: 'July 2026', previous_status: 'soft_close' }; },
    en: '↩ Idempotency hit: key "K1" already reopened July 2026 (was soft_close). Nothing was executed again.\n',
    es: '↩ Idempotency hit: la llave "K1" ya reabrió July 2026 (estaba soft_close). Nada se ejecutó otra vez.\n' },
  { key: 'ledger.period.reopen.done', argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste', '--yes'], where: 'out', setup: reopened('soft_close'),
    en: '✔ July 2026 is open again (was soft_close, by contador@example.test; reason recorded)\n',
    es: '✔ July 2026 está abierto otra vez (estaba soft_close, por contador@example.test; motivo registrado)\n' },
  { key: 'ledger.period.reopen.done_detail', argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste', '--yes'], where: 'out', setup: reopened('soft_close'),
    en: '(was soft_close, by contador@example.test; reason recorded)', es: '(estaba soft_close, por contador@example.test; motivo registrado)' },
  { key: 'ledger.period.reopen.stale', argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste', '--yes'], where: 'out', setup: reopened('soft_close'),
    en: '  Statements or filings derived from this period are now stale: regenerate them after re-closing.\n',
    es: '  Los estados financieros o declaraciones derivados de este periodo quedaron desactualizados: regéneralos después de volver a cerrarlo.\n' },
  { key: 'ledger.period.remedy.close_again', argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste', '--yes'], where: 'out', setup: reopened('soft_close'),
    en: 'regenerate them after re-closing.\n  Close it again with: mnemosine close --period "July 2026"\n',
    es: 'volver a cerrarlo.\n  Vuelve a cerrarlo con: mnemosine close --period "July 2026"\n' },
  { key: 'ledger.period.remedy.seal', argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste', '--yes', '--force'], where: 'out', setup: reopened('hard_close'),
    en: '    then seal it, which redoes its carry-forward: mnemosine close --period "July 2026" --hard\n',
    es: '    y luego séllalo, que rehace su arrastre: mnemosine close --period "July 2026" --hard\n' },

  // ---- year ----
  { key: 'ledger.period.year.status_unknown', argv: ['year', 'list', '--status', 'future'], where: 'error',
    en: "Unknown --status \"future\". A fiscal year is 'open' or 'closed'.", es: "--status \"future\" desconocido. Un ejercicio está 'open' o 'closed'." },
  { key: 'ledger.period.year.one_status', argv: ['year', 'list', '--status', 'open', 'closed'], where: 'error',
    en: "A fiscal year is either 'open' or 'closed': pass one --status, or none.", es: "Un ejercicio está 'open' o 'closed': pasa un --status, o ninguno." },
  { key: 'ledger.period.year.not_a_year', argv: ['year', 'show', 'dos-mil'], where: 'error',
    en: '"dos-mil" is not a four-digit year.', es: '"dos-mil" no es un año de cuatro dígitos.' },
  { key: 'ledger.period.year.title', argv: ['year', 'show', '2026'], where: 'out',
    setup: () => { vi.mocked(getFiscalYear).mockResolvedValue({ year: { year_number: 2026, start_date: '2026-01-01', end_date: '2026-12-31', status: 'open', is_calendar_year: false }, periods: [] } as never); },
    en: '\nFiscal year 2026  2026-01-01 → 2026-12-31 · open\n\n', es: '\nEjercicio 2026  2026-01-01 → 2026-12-31 · open\n\n' },
  { key: 'ledger.period.year.calendar', argv: ['year', 'show', '2026'], where: 'out',
    setup: () => { vi.mocked(getFiscalYear).mockResolvedValue({ year: { year_number: 2026, start_date: '2026-01-01', end_date: '2026-12-31', status: 'open', is_calendar_year: true }, periods: [] } as never); },
    en: '· open · calendar year\n', es: '· open · año calendario\n' },
  { key: 'ledger.period.year.exists', argv: ['year', 'create', '2027', '--dry-run'], where: 'error', setup: existingYear(13),
    en: 'Fiscal year 2027 already exists for Entidad Sintetica SA with 13 periods. Nothing would be created.',
    es: 'El ejercicio 2027 ya existe para Entidad Sintetica SA con 13 periodos. No se crearía nada.' },
  { key: 'ledger.period.year.exists', argv: ['year', 'create', '2027', '--dry-run'], where: 'error', setup: existingYear(1), prefix: true,
    en: 'Fiscal year 2027 already exists for Entidad Sintetica SA with 1 period.', es: 'El ejercicio 2027 ya existe para Entidad Sintetica SA con 1 periodo.' },
  { key: 'ledger.period.year.would_create', argv: ['year', 'create', '2027', '--dry-run'], where: 'out',
    en: '\nWould create fiscal year 2027 with', es: '\nCrearía el ejercicio 2027 con' },
  { key: 'ledger.period.year.would_create_detail', argv: ['year', 'create', '2027', '--dry-run'], where: 'out',
    en: ' with 12 monthly periods (calendar year) and the year-end adjustment period (13); months already past and the current one open, the rest future\n\n',
    es: ' con 12 periodos mensuales (año calendario) y el periodo de ajuste de fin de ejercicio (13); los meses ya pasados y el corriente abiertos, el resto future\n\n' },
  { key: 'ledger.period.year.created', argv: ['year', 'create', '2027'], where: 'out',
    en: '✔ Fiscal year 2027 created with', es: '✔ Ejercicio 2027 creado con' },
  { key: 'ledger.period.year.created_detail', argv: ['year', 'create', '2027'], where: 'out',
    en: ' with 12 monthly periods and the year-end adjustment period (13)\n', es: ' con 12 periodos mensuales y el periodo de ajuste de fin de ejercicio (13)\n' },
  { key: 'ledger.period.year.carried', argv: ['year', 'create', '2027'], where: 'out', setup: bornOnSealedBooks(3),
    en: '(13)\n  Opening balances carried from Year-end adjustments 2026: 3 accounts\n  Open a future month',
    es: '(13)\n  Saldos iniciales arrastrados desde Year-end adjustments 2026: 3 cuentas\n  Abre un mes futuro' },
  { key: 'ledger.period.year.carried', argv: ['year', 'create', '2027'], where: 'out', setup: bornOnSealedBooks(1),
    en: 'Year-end adjustments 2026: 1 account\n', es: 'Year-end adjustments 2026: 1 cuenta\n' },
  { key: 'ledger.period.year.open_hint', argv: ['year', 'create', '2027'], where: 'out',
    en: '  Open a future month with: mnemosine period open <name>\n', es: '  Abre un mes futuro con: mnemosine period open <nombre>\n' },

  // ---- year carry-forward run (MNE-001-645, #594) ----
  { key: 'ledger.period.year.carry.corrected', argv: CARRY, where: 'out', setup: carried(['1111', '2140', '3300'], true),
    en: '✔ Opening balances of January 2028 corrected from Year-end adjustments 2027: 3 accounts\n',
    es: '✔ Saldos iniciales de January 2028 corregidos desde Year-end adjustments 2027: 3 cuentas\n' },
  { key: 'ledger.period.year.carry.corrected', argv: CARRY, where: 'out', setup: carried(['1111'], true),
    en: 'Year-end adjustments 2027: 1 account\n', es: 'Year-end adjustments 2027: 1 cuenta\n' },
  { key: 'ledger.period.year.carry.corrected_detail', argv: CARRY, where: 'out', setup: carried(['1111'], true),
    en: '  No entry was created or edited; the correction is in the audit trail, by contador@example.test.\n',
    es: '  No se creó ni se editó ninguna póliza; la corrección queda en el rastro de auditoría, por contador@example.test.\n' },
  { key: 'ledger.period.year.carry.would_correct', argv: [...CARRY, '--dry-run'], where: 'out', setup: carried(['1111', '2140'], false),
    en: '\nWould correct the opening balances of January 2028 from Year-end adjustments 2027: 2 accounts\n',
    es: '\nCorregiría los saldos iniciales de January 2028 desde Year-end adjustments 2027: 2 cuentas\n' },
  { key: 'ledger.period.year.carry.dry_run', argv: [...CARRY, '--dry-run'], where: 'out', setup: carried(['1111'], false),
    en: '  Dry run: the carry really ran and was rolled back; nothing was written.\n',
    es: '  Ensayo: el arrastre sí corrió y se deshizo; no se escribió nada.\n' },
  { key: 'ledger.period.year.carry.unchanged', argv: CARRY, where: 'out', setup: carried([], false),
    en: 'The opening balances of January 2028 already are the closing balances of Year-end adjustments 2027: nothing to correct, and nothing was written.\n',
    es: 'Los saldos iniciales de January 2028 ya son los saldos finales de Year-end adjustments 2027: no hay nada que corregir y no se escribió nada.\n' },
  { key: 'error.CARRY_SOURCE_NOT_SEALED', argv: CARRY, where: 'error',
    setup: carryRefused('CARRY_SOURCE_NOT_SEALED', 'error.CARRY_SOURCE_NOT_SEALED', { ...CARRY_NAMES, status: 'open' }),
    en: "Year-end adjustments 2027 is 'open': the year before 2028 is not sealed, so there is nothing to carry yet. Its hard close will carry into January 2028.",
    es: "Year-end adjustments 2027 está 'open': el ejercicio anterior a 2028 no está sellado, así que todavía no hay nada que arrastrar. Su cierre duro arrastrará a January 2028." },
  { key: 'error.CARRY_SOURCE_MISSING', argv: CARRY, where: 'error',
    setup: carryRefused('CARRY_SOURCE_MISSING', 'error.CARRY_SOURCE_MISSING', CARRY_NAMES),
    en: 'Fiscal year 2028 is the first one of these books: there is no period before January 2028 to carry from. A first year opens with: mnemosine opening-balance import',
    es: 'El ejercicio 2028 es el primero de estos libros: no hay un periodo anterior a January 2028 del cual arrastrar. Un primer ejercicio abre con: mnemosine opening-balance import' },
  { key: 'error.CARRY_TARGET_SEALED.locked', argv: CARRY, where: 'error',
    setup: carryRefused('CARRY_TARGET_SEALED', 'error.CARRY_TARGET_SEALED.locked', CARRY_NAMES),
    en: "January 2028 is 'locked': its figures already left the system and its opening balances are not rewritten.",
    es: "January 2028 está 'locked': sus cifras ya salieron del sistema y sus saldos iniciales no se reescriben." },
  { key: 'error.CARRY_TARGET_SEALED.hard_close', argv: CARRY, where: 'error',
    setup: carryRefused('CARRY_TARGET_SEALED', 'error.CARRY_TARGET_SEALED.hard_close', { ...CARRY_NAMES, count: 3 }),
    en: 'January 2028 is \'hard_close\' and 3 of its opening balances differ from the closing balances of Year-end adjustments 2027. A closed period does not change without being reopened: mnemosine period reopen "January 2028" --force --reason <text>, run this again, then close it and seal it (mnemosine close --period "January 2028", and again with --hard), which redoes the carry of the months after it.',
    es: 'January 2028 está \'hard_close\' y 3 de sus saldos iniciales difieren de los saldos finales de Year-end adjustments 2027. Un periodo cerrado no cambia sin reabrirse: mnemosine period reopen "January 2028" --force --reason <texto>, corre esto otra vez, y luego ciérralo y séllalo (mnemosine close --period "January 2028", y otra vez con --hard), que rehace el arrastre de los meses siguientes.' },
  { key: 'error.CARRY_TARGET_SEALED.hard_close', argv: CARRY, where: 'error', prefix: true,
    setup: carryRefused('CARRY_TARGET_SEALED', 'error.CARRY_TARGET_SEALED.hard_close', { ...CARRY_NAMES, count: 1 }),
    en: "January 2028 is 'hard_close' and 1 of its opening balances differs from", es: "January 2028 está 'hard_close' y 1 de sus saldos iniciales difiere de" },
];

describe('I8.9 · fx, ledger, entry, period and year speak by key', () => {
  describe.each(['en', 'es'] as const)('%s', (lang) => {
    it.each(CASES.map((c) => [c.key, c] as const))('%s', async (_key, c) => {
      const seen = await run(c, lang);
      const want = lang === 'en' ? c.en : c.es;
      if (c.where === 'error' && !c.prefix) expect(seen.error).toBe(want);
      else expect(seen[c.where]).toContain(want);
    });
  });

  it('every key of this part has a row, and every row names a key of the catalogue', async () => {
    const { EN } = await import('../../src/i18n/en.js');
    const ours = /^ledger\.(fx|ledger|entry|period)\./;
    const keys = Object.keys(EN).filter((k) => ours.test(k));
    expect(new Set(CASES.map((c) => c.key).filter((k) => ours.test(k)))).toEqual(new Set(keys));
    for (const c of CASES) expect(EN, c.key).toHaveProperty([c.key]);
  });

  it('an answer that is neither yes nor no is taken as a no, in the bank words', async () => {
    answer.text = 'quizá';
    try {
      const seen = await run({ argv: ['period', 'reopen', 'July 2026', '--reason', 'ajuste'], setup: target(), tty: true }, 'es');
      expect(seen.err).toMatch(/; lo tomo como no\.\n/);
      expect(seen.out).toContain('Cancelado.\n');
      expect(reopenClosedPeriod).not.toHaveBeenCalled();
    } finally {
      answer.text = 'no';
    }
  });

  it('the --json error of fx rate download names the publisher in English, whatever the locale', async () => {
    const detailOf = async (lang: 'en' | 'es') => {
      vi.clearAllMocks();
      if (lang === 'es') setLanguage('es');
      resetDeclarations();
      let caught: { detail?: unknown } | undefined;
      const cli = new Command('mnemosine').exitOverride();
      registerFxCommand(cli, { palette, shutdown: () => undefined, reportError: (e) => { caught = e as { detail?: unknown }; } });
      await cli.parseAsync(['node', 'mnemosine', 'fx', 'rate', 'download', '--source', 'fed', '--yes']);
      return caught?.detail;
    };
    const en = await detailOf('en');
    resetLanguage();
    expect(await detailOf('es')).toEqual(en);
    expect(en).toEqual({ fuente: 'fed', editor: 'Federal Reserve H.10' });
  });

  describe('year carry-forward run (MNE-001-645, #594)', () => {
    it('runs the repair on the year given, as the reviewer, and lists each account before and after', async () => {
      const seen = await run({ argv: CARRY, setup: carried(['1111', '2140'], true) }, 'en');
      expect(carryForwardIntoYear).toHaveBeenCalledWith('E1', 2028, 'U1', { dryRun: false });
      expect(seen.code).toBe(0);
      expect(seen.out).toMatch(/account\s+before\s+after/);
      expect(seen.out).toMatch(/1111\s+0\.0000\s+10000\.0000/);
      expect(seen.out).toMatch(/2140\s+0\.0000\s+10000\.0000/);
    });

    it('--dry-run is passed to the service, which rolls its own run back', async () => {
      const seen = await run({ argv: [...CARRY, '--dry-run'], setup: carried(['1111'], false) }, 'en');
      expect(carryForwardIntoYear).toHaveBeenCalledWith('E1', 2028, 'U1', { dryRun: true });
      expect(seen.code).toBe(0);
      expect(seen.out).toMatch(/1111\s+0\.0000\s+10000\.0000/);
    });

    it('a second run exits 0 and prints no table: there is nothing to list', async () => {
      const seen = await run({ argv: CARRY, setup: carried([], false) }, 'en');
      expect(seen.code).toBe(0);
      expect(seen.out).not.toMatch(/before/);
    });

    it.each([
      ['corrected', ['1111'], true, []],
      ['would_correct', ['1111'], false, ['--dry-run']],
      ['unchanged', [], false, []],
    ] as const)('--json says %s, with the period, its source and each correction', async (status, codes, written, flags) => {
      const seen = await run({ argv: [...CARRY, ...flags, '--json'], setup: carried([...codes], written) }, 'en');
      const printed = JSON.parse(seen.out) as { schema: number; count: number; rows: unknown[] };
      expect(printed).toMatchObject({ schema: 1, count: 1 });
      expect(printed.rows).toEqual([{
        year_number: 2028,
        period: 'January 2028',
        carried_from: 'Year-end adjustments 2027',
        status,
        accounts: codes.length,
        corrections: codes.map((code) => ({ code, before: '0.0000', after: '10000.0000' })),
      }]);
    });

    it.each([
      ['CARRY_SOURCE_NOT_SEALED', 'error.CARRY_SOURCE_NOT_SEALED', 5],
      ['CARRY_TARGET_SEALED', 'error.CARRY_TARGET_SEALED.locked', 5],
      ['CARRY_SOURCE_MISSING', 'error.CARRY_SOURCE_MISSING', 4],
    ] as const)('%s exits %s… as a state that blocks, or a year with nothing before it', async (code, key, exit) => {
      const seen = await run({ argv: CARRY, setup: carryRefused(code, key, { ...CARRY_NAMES, status: 'open' }) }, 'en');
      expect(seen.code).toBe(exit);
      expect(seen.out).toBe('');
    });

    it('something that is not a year is a usage error, before any query', async () => {
      const seen = await run({ argv: ['year', 'carry-forward', 'run', 'dos-mil'] }, 'en');
      expect(seen.error).toBe('"dos-mil" is not a four-digit year.');
      expect(carryForwardIntoYear).not.toHaveBeenCalled();
    });
  });

  it('reopenRemedy speaks the active language', () => {
    expect(reopenRemedy('July 2026', 'soft_close')).toEqual(['Close it again with: mnemosine close --period "July 2026"']);
    setLanguage('es');
    expect(reopenRemedy('July 2026', 'hard_close')).toEqual([
      'Vuelve a cerrarlo con: mnemosine close --period "July 2026"',
      '  y luego séllalo, que rehace su arrastre: mnemosine close --period "July 2026" --hard',
    ]);
  });
});
