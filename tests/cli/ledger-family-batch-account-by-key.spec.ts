import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// ============================================================
// I8.9 · the ledger family speaks by key (MNE-001-229, #271): batch, account
//
// One row per key this part adds to the I8.9 block, through the real leaf
// over doubles (the services are mocked), in English (the test locale is
// en-US) and in es-MX, with a singular and a plural where «(s)» used to be.
// English that was printed before is the same byte for byte; Spanish reads
// word for word as before, except the plurals. The `Examples:` of `account
// create` and the --json of post and reverse are checked at the end.
// ============================================================

const CTX = { tenantId: 'T1', entityId: 'E1', entityName: 'Entidad Sintetica SA', country: 'MX', currency: 'MXN' };
const B1 = 'aaaaaaaa-1111-2222-3333-444444444444';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  currentTenant: () => 'T1',
}));
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: vi.fn(async () => ({ userId: 'U1' })) }));
vi.mock('../../src/cli/kernel/entity-context.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveActiveEntity: vi.fn(async () => ({ ctx: CTX })),
  requireExplicitEntity: vi.fn(async () => CTX),
}));
vi.mock('../../src/services/policy/today.js', () => ({
  zoneFor: vi.fn(async () => 'America/Mexico_City'),
  dayOrToday: vi.fn(async (_c: unknown, day?: string) => day ?? '2026-06-30'),
}));
vi.mock('../../src/services/accounting/posting.js', () => ({ attestEntryAsync: vi.fn() }));
vi.mock('../../src/services/accounting/batch-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listBatches: vi.fn(),
  showBatch: vi.fn(),
  checkBatch: vi.fn(),
  postBatch: vi.fn(),
  reverseBatch: vi.fn(),
}));
vi.mock('../../src/services/accounting/account-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listAccounts: vi.fn(async () => ({ rows: [], total: 0 })),
  getAccountById: vi.fn(),
  resolveAccount: vi.fn(async (_e: string, code: string) => ({ id: 'A1', code, name: 'Bancos' })),
  createAccount: vi.fn(),
  updateAccount: vi.fn(async () => ({ code: '6150' })),
  deactivateAccount: vi.fn(),
  reactivateAccount: vi.fn(async () => ({ code: '6150' })),
  setAccountGovernance: vi.fn(),
  getAccountBalanceByPeriod: vi.fn(async () => []),
  setAccountMapping: vi.fn(),
  importAccountMappings: vi.fn(),
  checkMappingCoverageDetallada: vi.fn(),
}));
vi.mock('../../src/services/accounting/account-roles-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  setAccountRole: vi.fn(),
}));
vi.mock('../../src/services/xml-ingestion/account-roles-seed.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  seedAccountRoles: vi.fn(),
}));
vi.mock('../../src/services/accounting/withholding-accounts.js', () => ({
  censusWithholdingLayout: vi.fn(),
  describeWithholdingPlan: vi.fn(() => []),
  hasWork: vi.fn(() => false),
  applyWithholdingLayout: vi.fn(),
}));
const keyStore = { repetido: false, resultado: undefined as unknown };
vi.mock('../../src/services/idempotency/idempotency-store.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  conLlave: vi.fn(async (_c: unknown, _k: unknown, fn: () => Promise<unknown>) =>
    keyStore.repetido ? { repetido: true, resultado: keyStore.resultado } : { repetido: false, resultado: await fn() }),
}));
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: vi.fn((p: string, ...rest: unknown[]) => {
      if (p === 'vacio.csv') return 'codigo,valor\n';
      if (p === 'pares.csv') return '1130,118.01\n9999,1\n1120,\n';
      return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }),
  };
});

import { registerBatchCommand } from '../../src/cli/batch-command.js';
import { registerAccountCommand } from '../../src/cli/account-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import { checkBatch, listBatches, postBatch, reverseBatch, showBatch } from '../../src/services/accounting/batch-service.js';
import {
  checkMappingCoverageDetallada,
  deactivateAccount,
  getAccountBalanceByPeriod,
  getAccountById,
  importAccountMappings,
} from '../../src/services/accounting/account-service.js';
import { seedAccountRoles } from '../../src/services/xml-ingestion/account-roles-seed.js';
import { censusWithholdingLayout, describeWithholdingPlan, hasWork } from '../../src/services/accounting/withholding-accounts.js';

type Localized = Error & { localized?: (l?: 'es' | 'en') => string };
const pass = (s: string) => s;
const palette = { dim: pass, bold: pass, cyan: pass, red: pass, green: pass, yellow: pass };

let out = '';
let err = '';
beforeEach(() => {
  out = '';
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err += String(c); return true; });
});
afterEach(() => { vi.restoreAllMocks(); resetLanguage(); });

// ---- the batch doubles --------------------------------------------------

const summary = (over: Record<string, unknown> = {}) => ({
  id: B1, kind: 'import', layout: 'csv', file_name: 'polizas.csv', file_hash: 'ab'.repeat(32), status: 'staged',
  rows_total: 3, rows_invalid: 1, entries_posted: 0, created_by: 'U1', created_at: new Date('2026-08-01T12:00:00Z'),
  ...over,
});
const detail = (over: { batch?: Record<string, unknown>; rows?: unknown[] } = {}) => ({
  lote: summary(over.batch),
  filas: over.rows ?? [
    { row_number: 1, parse_error: null, categoria: null, date: '2026-08-01', lineas: 2, total_debe: '1000.0000', entry_number: 'P-001', entry_reversed: false },
    { row_number: 2, parse_error: 'fecha inválida', categoria: 'fecha', date: null, lineas: null, total_debe: null, entry_number: null, entry_reversed: false },
  ],
  errores_por_categoria: { fecha: 1 },
});
const okRow = (n: number) => ({ row_number: n, ok: true, categoria: null, errores: [], advertencias: [] });
const badRow = (n: number, category: string, error: string) => ({ row_number: n, ok: false, categoria: category, errores: [error], advertencias: [] });
const checked = (valid: number, invalid: number, rows: unknown[], status = 'staged') =>
  () => { vi.mocked(checkBatch).mockResolvedValue({ batchId: B1, status, validas: valid, invalidas: invalid, filas: rows } as never); };
const application = (over: Record<string, unknown> = {}) => ({
  batchId: B1, status: 'posted',
  posteadas: [{ row_number: 1, entry_id: 'JE1', entry_number: 'P-001' }, { row_number: 2, entry_id: 'JE2', entry_number: 'P-002' }],
  ya_posteadas: 0, invalidas: [], total_debe: '2500.0000', attestations: [], dryRun: true,
  ...over,
});
const posting = (over: Record<string, unknown> = {}) => () => { vi.mocked(postBatch).mockResolvedValue(application(over) as never); };
const reversal = (over: Record<string, unknown> = {}) => ({
  batchId: B1, status: 'posted',
  espejos: [{ original: 'P-001', espejo: 'R-001', espejo_id: 'JR1' }, { original: 'P-002', espejo: 'R-002', espejo_id: 'JR2' }],
  attestations: [], dryRun: true,
  ...over,
});
const reversing = (over: Record<string, unknown> = {}) => () => { vi.mocked(reverseBatch).mockResolvedValue(reversal(over) as never); };
const recorded = (value: unknown) => () => { keyStore.repetido = true; keyStore.resultado = { v: value }; };

// ---- the account doubles --------------------------------------------------

const coverage = (population: number, gaps: number, chosen = false) => () => {
  vi.mocked(checkMappingCoverageDetallada).mockResolvedValue({
    alcance: 'cuentas_con_movimientos', alcanceElegido: chosen, poblacion: population,
    huecos: Array.from({ length: gaps }, (_, i) => ({ code: `11${i}0`, name: 'Cuenta' })),
  } as never);
};
const plan = (lines: string[], work: boolean) => () => {
  vi.mocked(censusWithholdingLayout).mockResolvedValue([{ entityName: 'Entidad Sintetica SA', layout: 'grouped', blocked: false }] as never);
  vi.mocked(describeWithholdingPlan).mockReturnValue(lines);
  vi.mocked(hasWork).mockReturnValue(work);
};
const IMPORTED = [
  { code: '1130', resultado: 'aplicado' },
  { code: '9999', resultado: 'sin_cuenta' },
  { code: '1120', resultado: 'valor_vacio' },
];

type Where = 'error' | 'out' | 'err' | 'asked';
type Case = { key: string; argv: string[]; setup?: () => void; confirm?: boolean; where: Where; en: string; es: string; prefix?: boolean };

async function run(c: Pick<Case, 'argv' | 'setup' | 'confirm'>, lang: 'en' | 'es') {
  vi.clearAllMocks();
  keyStore.repetido = false;
  vi.mocked(listBatches).mockResolvedValue([summary()] as never);
  vi.mocked(showBatch).mockResolvedValue(detail() as never);
  c.setup?.();
  if (lang === 'es') setLanguage('es');
  out = '';
  err = '';
  resetDeclarations();
  const state: { code?: number; error?: Localized; asked: string[] } = { asked: [] };
  const deps = {
    palette,
    home: '/tmp/mnemosine-tests-no-home',
    shutdown: (code: number) => { state.code = code; },
    reportError: (e: unknown) => { state.error = e as Localized; },
  };
  const cli = new Command('mnemosine').exitOverride();
  registerBatchCommand(cli, { ...deps, confirm: async (q: string) => { state.asked.push(q); return c.confirm !== false; } });
  registerAccountCommand(cli, deps);
  await cli.parseAsync(['node', 'mnemosine', ...c.argv, '-e', 'E1']);
  return {
    code: state.code,
    error: state.error?.localized ? state.error.localized() : (state.error?.message ?? ''),
    asked: state.asked.join('\n'),
    out,
    err,
  };
}

const TYPES = 'asset, liability, equity, revenue, expense, contra_asset, contra_liability, contra_equity';

const CASES: Case[] = [
  // ---- batch: the usage errors ----
  { key: 'ledger.batch.status.one_at_a_time', argv: ['batch', 'list', '--status', 'staged', 'posted'], where: 'error',
    en: 'One status at a time: the batch flow is short (staged → checked → posted) and a multiple filter answers no question that two runs do not answer better.',
    es: 'Un estado a la vez: el flujo del lote es corto (staged → checked → posted) y un filtro múltiple no responde ninguna pregunta que dos corridas no respondan mejor.' },
  { key: 'ledger.batch.status.unknown', argv: ['batch', 'list', '--status', 'pending'], where: 'error',
    en: '--status "pending" does not exist in the batch flow. The real statuses (045): staged, checked, posted, discarded. The pending|running|completed|failed|cancelled vocabulary does not belong to this table.',
    es: '--status "pending" no existe en el flujo del lote. Los estados reales (045): staged, checked, posted, discarded. El vocabulario pending|running|completed|failed|cancelled no corresponde a esta tabla.' },
  { key: 'ledger.batch.check.categories_unknown', argv: ['batch', 'check', B1, '--check', 'saldo'], where: 'error',
    en: '--check does not recognize: saldo. The closed categories are parse, forma, cuenta, periodo, validacion. The whole battery always runs; the filter only narrows the report.',
    es: '--check no reconoce: saldo. Las categorías cerradas son parse, forma, cuenta, periodo, validacion. La batería completa corre siempre; el filtro sólo acota el informe.' },
  { key: 'ledger.batch.list.flag_unsupported', argv: ['batch', 'list', '--until', '2026-08-31'], where: 'error',
    en: '--until does not apply to batches: a batch is filtered by when it was prepared, with --since (created_at >= date). There is no upper bound and no date basis to choose.',
    es: '--until no aplica a los lotes: un lote se filtra por cuándo se preparó, con --since (created_at >= fecha). No hay rango superior ni base de fecha que elegir.' },
  { key: 'ledger.batch.list.offset_unsupported', argv: ['batch', 'list', '--offset', '5'], where: 'error',
    en: '--offset is not implemented in this family: the query orders by created_at and caps with --limit, with no stable cursor. Narrow with --since or raise --limit.',
    es: '--offset no está implementado en esta familia: la consulta ordena por created_at y acota con --limit, sin cursor estable. Acota con --since o sube --limit.' },
  { key: 'ledger.batch.list.capped', argv: ['batch', 'list', '-n', '1'], where: 'err',
    en: '1 batch was listed, which is the --limit cap: there may be more. Raise --limit or narrow with --since.\n',
    es: 'Se listó 1 lote, que es el tope de --limit: puede haber más. Sube --limit o acota con --since.\n' },
  { key: 'ledger.batch.list.capped', argv: ['batch', 'list', '-n', '2'], where: 'err',
    setup: () => { vi.mocked(listBatches).mockResolvedValue([summary(), summary({ id: 'b2' })] as never); },
    en: '2 batches were listed, which is the --limit cap', es: 'Se listaron 2 lotes, que es el tope de --limit' },

  // ---- batch show ----
  { key: 'ledger.batch.title', argv: ['batch', 'show', B1], where: 'out',
    en: `\nBATCH ${B1} · staged · import/csv\n`, es: `\nLOTE ${B1} · staged · import/csv\n` },
  { key: 'ledger.batch.show.file_label', argv: ['batch', 'show', B1], where: 'out',
    en: '  file        polizas.csv · sha256 abababababab…\n', es: '  archivo     polizas.csv · sha256 abababababab…\n' },
  { key: 'ledger.batch.show.unnamed', argv: ['batch', 'show', B1], where: 'out',
    setup: () => { vi.mocked(showBatch).mockResolvedValue(detail({ batch: { file_name: null } }) as never); },
    en: '  file        (no name) · sha256', es: '  archivo     (sin nombre) · sha256' },
  { key: 'ledger.batch.show.rows_label', argv: ['batch', 'show', B1], where: 'out',
    en: '  rows        3 total · 1 invalid · 0 entries in the ledger\n', es: '  filas       3 total · 1 inválida · 0 pólizas en el mayor\n' },
  { key: 'ledger.batch.show.rows', argv: ['batch', 'show', B1], where: 'out',
    setup: () => { vi.mocked(showBatch).mockResolvedValue(detail({ batch: { rows_invalid: 2, entries_posted: 1 } }) as never); },
    en: '3 total · 2 invalid · 1 entry in the ledger\n', es: '3 total · 2 inválidas · 1 póliza en el mayor\n' },
  { key: 'ledger.batch.show.prepared_label', argv: ['batch', 'show', B1], where: 'out',
    en: '  prepared    2026-08-01 by U1\n', es: '  preparado   2026-08-01 por U1\n' },
  { key: 'ledger.batch.show.prepared', argv: ['batch', 'show', B1], where: 'out', en: '2026-08-01 by U1', es: '2026-08-01 por U1' },
  { key: 'ledger.batch.show.rows_title', argv: ['batch', 'show', B1], where: 'out', en: '\nROWS (2)\n', es: '\nFILAS (2)\n' },
  { key: 'ledger.batch.show.empty', argv: ['batch', 'show', B1], where: 'out',
    setup: () => { vi.mocked(showBatch).mockResolvedValue(detail({ rows: [] }) as never); },
    en: '  the batch is empty\n', es: '  el lote está vacío\n' },
  { key: 'ledger.batch.show.no_parse_errors', argv: ['batch', 'show', B1, '--errors-only'], where: 'out',
    setup: () => { vi.mocked(showBatch).mockResolvedValue(detail({ rows: [detail().filas[0]] }) as never); },
    en: '  no row with a parse error\n', es: '  ninguna fila con error de parseo\n' },
  { key: 'ledger.batch.show.errors_by_category', argv: ['batch', 'show', B1], where: 'out',
    en: '\n  parse errors by category: fecha=1\n', es: '\n  errores de parseo por categoría: fecha=1\n' },

  // ---- batch check ----
  { key: 'ledger.batch.check.rows_checked', argv: ['batch', 'check', B1], where: 'out',
    setup: checked(1, 1, [okRow(1), badRow(2, 'cuenta', 'Account with id 9999 not found')]),
    en: `\nBATCH ${B1} · 2 rows checked\n\n`, es: `\nLOTE ${B1} · 2 filas verificadas\n\n` },
  { key: 'ledger.batch.check.rows_checked', argv: ['batch', 'check', B1], where: 'out', setup: checked(1, 0, [okRow(1)], 'checked'),
    en: ' · 1 row checked\n', es: ' · 1 fila verificada\n' },
  { key: 'ledger.batch.check.strict', argv: ['batch', 'check', B1, '--strict'], where: 'out', setup: checked(1, 0, [okRow(1)], 'checked'),
    en: '1 row checked · strict\n', es: '1 fila verificada · estricto\n' },
  { key: 'ledger.batch.check.narrowed', argv: ['batch', 'check', B1, '--check', 'cuenta'], where: 'out', setup: checked(1, 0, [okRow(1)], 'checked'),
    en: '1 row checked · report narrowed to cuenta\n', es: '1 fila verificada · informe acotado a cuenta\n' },
  { key: 'ledger.batch.row', argv: ['batch', 'check', B1], where: 'out',
    setup: checked(1, 1, [okRow(1), badRow(2, 'cuenta', 'Account with id 9999 not found')]),
    en: '  ✘ row 2 [cuenta] — Account with id 9999 not found\n', es: '  ✘ fila 2 [cuenta] — Account with id 9999 not found\n' },
  { key: 'ledger.batch.check.nothing_to_show', argv: ['batch', 'check', B1], where: 'out', setup: checked(2, 0, [okRow(1), okRow(2)], 'checked'),
    en: '  no finding to show\n', es: '  ningún hallazgo que enseñar\n' },
  { key: 'ledger.batch.check.all_valid', argv: ['batch', 'check', B1], where: 'out', setup: checked(2, 0, [okRow(1), okRow(2)], 'checked'),
    en: "\n✔ 2 valid rows: the batch stays 'checked'.\n", es: "\n✔ 2 filas válidas: el lote queda 'checked'.\n" },
  { key: 'ledger.batch.check.all_valid', argv: ['batch', 'check', B1], where: 'out', setup: checked(1, 0, [okRow(1)], 'checked'),
    en: "\n✔ 1 valid row: the batch stays 'checked'.\n", es: "\n✔ 1 fila válida: el lote queda 'checked'.\n" },
  { key: 'ledger.batch.check.some_invalid', argv: ['batch', 'check', B1], where: 'out',
    setup: checked(1, 1, [okRow(1), badRow(2, 'cuenta', 'sin cuenta')]),
    en: "\n✘ 1 invalid and 1 valid: the batch stays 'staged'. Fix the file and import it again, or apply what is valid with `batch post --partial`.\n",
    es: "\n✘ 1 inválida y 1 válida: el lote se queda 'staged'. Corrige el archivo y reimporta, o aplica lo válido con `batch post --partial`.\n" },
  { key: 'ledger.batch.check.some_invalid', argv: ['batch', 'check', B1], where: 'out',
    setup: checked(0, 2, [badRow(1, 'cuenta', 'sin cuenta'), badRow(2, 'cuenta', 'sin cuenta')]),
    en: "\n✘ 2 invalid and 0 valid: the batch stays 'staged'.", es: "\n✘ 2 inválidas y 0 válidas: el lote se queda 'staged'." },
  { key: 'ledger.batch.check.hidden_blocking', argv: ['batch', 'check', B1, '--check', 'periodo'], where: 'err',
    setup: checked(0, 2, [badRow(2, 'cuenta', 'sin cuenta'), badRow(3, 'periodo', 'periodo sin abrir')]),
    en: '1 blocking finding was left out of the report by --check; the exit code counts them all the same.\n',
    es: '1 hallazgo bloqueante quedó fuera del informe por --check; el código de salida los cuenta igual.\n' },
  { key: 'ledger.batch.check.hidden_blocking', argv: ['batch', 'check', B1, '--check', 'periodo'], where: 'err',
    setup: checked(0, 3, [badRow(1, 'cuenta', 'x'), badRow(2, 'cuenta', 'x'), badRow(3, 'periodo', 'y')]),
    en: '2 blocking findings were left out of the report by --check;', es: '2 hallazgos bloqueantes quedaron fuera del informe por --check;' },

  // ---- batch post ----
  { key: 'ledger.batch.post.preview', argv: ['batch', 'post', B1, '--dry-run'], where: 'out', setup: posting(),
    en: `\nBATCH ${B1} · 2 entries · Debit 2500.0000\n    row 1 → P-001\n    row 2 → P-002\n`,
    es: `\nLOTE ${B1} · 2 pólizas · Debe 2500.0000\n    fila 1 → P-001\n    fila 2 → P-002\n` },
  { key: 'ledger.batch.post.already', argv: ['batch', 'post', B1, '--dry-run'], where: 'out',
    setup: posting({ posteadas: [{ row_number: 2, entry_id: 'JE2', entry_number: 'P-002' }], ya_posteadas: 1 }),
    en: '· 1 entry · Debit 2500.0000 · 1 was already there\n', es: '· 1 póliza · Debe 2500.0000 · 1 ya estaba\n' },
  { key: 'ledger.batch.post.already', argv: ['batch', 'post', B1, '--dry-run'], where: 'out', setup: posting({ ya_posteadas: 2 }),
    en: ' · 2 were already there\n', es: ' · 2 ya estaban\n' },
  { key: 'ledger.batch.post.left_staged', argv: ['batch', 'post', B1, '--dry-run', '--partial'], where: 'out',
    setup: posting({ status: 'staged', invalidas: [badRow(3, 'periodo', 'periodo sin abrir')] }),
    en: '\n  1 row stays in staging:\n    ✘ row 3 [periodo] — periodo sin abrir\n', es: '\n  1 fila queda en staging:\n    ✘ fila 3 [periodo] — periodo sin abrir\n' },
  { key: 'ledger.batch.post.left_staged', argv: ['batch', 'post', B1, '--dry-run', '--partial'], where: 'out',
    setup: posting({ status: 'staged', invalidas: [badRow(3, 'periodo', 'x'), badRow(4, 'periodo', 'x')] }),
    en: '\n  2 rows stay in staging:\n', es: '\n  2 filas quedan en staging:\n' },
  { key: 'ledger.batch.receipt_title', argv: ['batch', 'post', B1, '--dry-run'], where: 'out', setup: posting(),
    en: `◑ batch ${B1} → 'posted' · 2 posted · 0 already there · 0 in staging · Debit 2500.0000\n`,
    es: `◑ lote ${B1} → 'posted' · 2 contabilizadas · 0 ya estaban · 0 en staging · Debe 2500.0000\n` },
  { key: 'ledger.batch.post.receipt', argv: ['batch', 'post', B1, '--dry-run'], where: 'out',
    setup: posting({ posteadas: [{ row_number: 2, entry_id: 'JE2', entry_number: 'P-002' }], ya_posteadas: 1, invalidas: [badRow(3, 'periodo', 'x')] }),
    en: "→ 'posted' · 1 posted · 1 already there · 1 in staging · Debit 2500.0000\n",
    es: "→ 'posted' · 1 contabilizada · 1 ya estaba · 1 en staging · Debe 2500.0000\n" },
  { key: 'ledger.batch.post.dry_run', argv: ['batch', 'post', B1, '--dry-run'], where: 'err', setup: posting(),
    en: 'Dry run: it was posted for real and rolled back; the folios shown were not reserved.\n',
    es: 'Ensayo: se contabilizó de verdad y se deshizo; los folios mostrados no quedaron reservados.\n' },
  { key: 'ledger.batch.post.confirm', argv: ['batch', 'post', B1], where: 'asked', setup: posting(),
    en: `You are about to POST 2 entries of batch ${B1} for 2500.0000 (Debit). The ledger is immutable: this is only corrected by a reversal. Continue?`,
    es: `Vas a CONTABILIZAR 2 pólizas del lote ${B1} por 2500.0000 (Debe). El mayor es inmutable: esto sólo se corrige por reversa. ¿Continuar?` },
  { key: 'ledger.batch.post.confirm_left', argv: ['batch', 'post', B1, '--partial'], where: 'asked',
    setup: posting({ posteadas: [{ row_number: 1, entry_id: 'JE1', entry_number: 'P-001' }], invalidas: [badRow(3, 'periodo', 'x')] }),
    en: `You are about to POST 1 entry of batch ${B1} for 2500.0000 (Debit), leaving 1 row in staging. The ledger`,
    es: `Vas a CONTABILIZAR 1 póliza del lote ${B1} por 2500.0000 (Debe), dejando 1 fila en staging. El mayor` },
  { key: 'ledger.batch.post.recorded', argv: ['batch', 'post', B1, '-y', '--idempotency-key', 'K1'], where: 'err',
    setup: recorded(application({ dryRun: false })),
    en: `↩ Idempotency hit: key "K1" already completed this act — 2 entries of batch ${B1}. Nothing was executed again; this is the recorded result.\n`,
    es: `↩ Idempotency hit: la llave "K1" ya consumó este acto — 2 pólizas del lote ${B1}. Nada se ejecutó otra vez; esto es el resultado grabado.\n` },
  { key: 'ledger.batch.idempotency_hit', argv: ['batch', 'post', B1, '-y', '--idempotency-key', 'K1'], where: 'err',
    setup: recorded(application({ dryRun: false, posteadas: [{ row_number: 1, entry_id: 'JE1', entry_number: 'P-001' }] })),
    en: '— 1 entry of batch', es: '— 1 póliza del lote' },

  // ---- batch reverse ----
  { key: 'ledger.batch.reverse.preview', argv: ['batch', 'reverse', B1, '--dry-run'], where: 'out', setup: reversing(),
    en: `\nBATCH ${B1} · 2 mirrors\n    P-001 → R-001\n    P-002 → R-002\n`, es: `\nLOTE ${B1} · 2 espejos\n    P-001 → R-001\n    P-002 → R-002\n` },
  { key: 'ledger.batch.reverse.dated', argv: ['batch', 'reverse', B1, '--dry-run', '--as-of', '2026-08-31'], where: 'out',
    setup: reversing({ espejos: [{ original: 'P-001', espejo: 'R-001', espejo_id: 'JR1' }] }),
    en: `\nBATCH ${B1} · 1 mirror dated 2026-08-31\n`, es: `\nLOTE ${B1} · 1 espejo con fecha 2026-08-31\n` },
  { key: 'ledger.batch.reverse.receipt', argv: ['batch', 'reverse', B1, '--dry-run'], where: 'out', setup: reversing(),
    en: `◑ batch ${B1} · 2 mirrors · the batch stays 'posted': the truth of the reversal lives in reversed_by_entry_id of each entry\n`,
    es: `◑ lote ${B1} · 2 espejos · el lote sigue 'posted': la verdad de la reversa vive en reversed_by_entry_id de cada póliza\n` },
  { key: 'ledger.batch.reverse.dry_run', argv: ['batch', 'reverse', B1, '--dry-run'], where: 'err', setup: reversing(),
    en: 'Dry run: the mirrors were created for real and rolled back; nothing was written.\n',
    es: 'Ensayo: los espejos se crearon de verdad y se deshicieron; nada quedó escrito.\n' },
  { key: 'ledger.batch.reverse.confirm', argv: ['batch', 'reverse', B1, '--reason', 'lote duplicado'], where: 'asked', setup: reversing(),
    en: `You are about to REVERSE batch ${B1}: 2 posted mirrors, one per entry, in a single transaction. Each entry admits ONE reversal (041). Continue?`,
    es: `Vas a REVERSAR el lote ${B1}: 2 espejos posteados, uno por póliza, en una sola transacción. Cada póliza admite UNA reversa (041). ¿Continuar?` },
  { key: 'ledger.batch.reverse.confirm', argv: ['batch', 'reverse', B1, '--reason', 'lote duplicado'], where: 'asked',
    setup: reversing({ espejos: [{ original: 'P-001', espejo: 'R-001', espejo_id: 'JR1' }] }),
    en: `batch ${B1}: 1 posted mirror, one per entry`, es: `el lote ${B1}: 1 espejo posteado, uno por póliza` },
  { key: 'ledger.batch.reverse.recorded', argv: ['batch', 'reverse', B1, '-y', '--reason', 'x', '--idempotency-key', 'K2'], where: 'err',
    setup: recorded(reversal({ dryRun: false })),
    en: `— 2 mirrors of batch ${B1}. Nothing was executed again`, es: `— 2 espejos del lote ${B1}. Nada se ejecutó otra vez` },

  // ---- account: the usage errors ----
  { key: 'ledger.account.type_unknown', argv: ['account', 'list', '--type', 'gasto'], where: 'error',
    en: `Unknown --type "gasto". Use one of: ${TYPES}.`, es: `--type "gasto" no existe. Usa uno de: ${TYPES}.` },
  { key: 'ledger.account.normal_balance_unknown', argv: ['account', 'create', '6150', 'Mantenimiento', '--type', 'expense', '--normal-balance', 'haber'], where: 'error',
    en: 'Unknown --normal-balance "haber". Use debit or credit.', es: '--normal-balance "haber" no existe. Usa debit o credit.' },
  { key: 'ledger.account.show.disappeared', argv: ['account', 'show', '6150'], where: 'error',
    setup: () => { vi.mocked(getAccountById).mockResolvedValue(null as never); },
    en: 'Account 6150 disappeared while reading it.', es: 'La cuenta 6150 desapareció mientras se leía.' },
  { key: 'ledger.account.edit.nothing_to_change', argv: ['account', 'edit', '6150'], where: 'error',
    en: 'Nothing to change. Pass --name, --description, --subtype or --fs-category.', es: 'Nada que cambiar. Pasa --name, --description, --subtype o --fs-category.' },
  { key: 'ledger.account.edit.done', argv: ['account', 'edit', '6150', '--name', 'Mantenimiento y conservacion'], where: 'out',
    en: '✔ 6150 updated.\n', es: '✔ 6150 actualizada.\n' },

  // ---- account archive / set / balance ----
  { key: 'ledger.account.archive.would_archive', argv: ['account', 'archive', '6150', '--dry-run'], where: 'out',
    setup: () => { vi.mocked(deactivateAccount).mockResolvedValue({ hadHistory: false, balance: '0.00' } as never); },
    en: '6150 would be archived. Lifetime balance: 0.00. (dry-run: nothing was written)\n', es: '6150 se archivaría. Saldo de por vida: 0.00. (dry-run: nada se escribió)\n' },
  { key: 'ledger.account.archive.would_keep_history', argv: ['account', 'archive', '6150', '--dry-run'], where: 'out',
    setup: () => { vi.mocked(deactivateAccount).mockResolvedValue({ hadHistory: true, balance: '0.00' } as never); },
    en: 'Lifetime balance: 0.00. It has posted history, which would stay intact. (dry-run: nothing was written)\n',
    es: 'Saldo de por vida: 0.00. Tiene historia posteada, que quedaría intacta. (dry-run: nada se escribió)\n' },
  { key: 'ledger.account.dry_run_note', argv: ['account', 'set', '1120', 'header=true', '--dry-run'], where: 'out',
    en: '1120 would set: {"is_header":true} (dry-run: nothing was written)\n', es: '1120 fijaría: {"is_header":true} (dry-run: nada se escribió)\n' },
  { key: 'ledger.account.archive.done', argv: ['account', 'archive', '6150', '--reason', 'duplicada'], where: 'out',
    setup: () => { vi.mocked(deactivateAccount).mockResolvedValue({ hadHistory: false, balance: '0.00' } as never); },
    en: '✔ 6150 archived. Reason: duplicada\n', es: '✔ 6150 archivada. Motivo: duplicada\n' },
  { key: 'ledger.account.archive.forced', argv: ['account', 'archive', '6150', '--reason', 'duplicada', '--force'], where: 'out',
    setup: () => { vi.mocked(deactivateAccount).mockResolvedValue({ hadHistory: true, balance: '150.00' } as never); },
    en: '✔ 6150 archived. Reason: duplicada (with a live balance of 150.00, forced) Posted history stays intact.\n',
    es: '✔ 6150 archivada. Motivo: duplicada (con saldo vivo 150.00, forzado) La historia posteada queda intacta.\n' },
  { key: 'ledger.account.archive.history_intact', argv: ['account', 'archive', '6150', '--reason', 'duplicada'], where: 'out',
    setup: () => { vi.mocked(deactivateAccount).mockResolvedValue({ hadHistory: true, balance: '0.00' } as never); },
    en: 'Reason: duplicada Posted history stays intact.\n', es: 'Motivo: duplicada La historia posteada queda intacta.\n' },
  { key: 'ledger.account.set.would_set', argv: ['account', 'set', '1112', 'currency=usd', '--dry-run'], where: 'out',
    en: '1112 would set: {"currency_code":"USD"}', es: '1112 fijaría: {"currency_code":"USD"}' },
  { key: 'ledger.account.set.pair_unreadable', argv: ['account', 'set', '1120', 'header'], where: 'error',
    en: 'Unreadable pair "header": key=value is expected.', es: 'Par ilegible "header": se espera clave=valor.' },
  { key: 'ledger.account.set.key_unknown', argv: ['account', 'set', '1120', 'color=rojo'], where: 'error',
    en: 'Unknown key "color". Valid: allow-manual, header, control-account, require-subsidiary, currency.',
    es: 'Clave desconocida "color". Válidas: allow-manual, header, control-account, require-subsidiary, currency.' },
  { key: 'ledger.account.set.value_unreadable', argv: ['account', 'set', '1120', 'header=yes'], where: 'error',
    en: 'Unreadable value "yes" for header: use true or false.', es: 'Valor ilegible "yes" para header: usa true o false.' },
  { key: 'ledger.account.balance.open_period_note', argv: ['account', 'balance', 'show', '1111'], where: 'err',
    setup: () => { vi.mocked(getAccountBalanceByPeriod).mockResolvedValue([{ period_name: '2026-07', period_status: 'open' }] as never); },
    en: 'Note: beginning_balance is only seeded at the hard close; in open periods it reads the activity, not the cumulative balance.\n',
    es: 'Nota: beginning_balance solo se siembra en el cierre duro; en periodos abiertos lee la actividad, no el acumulado.\n' },

  // ---- account role ----
  { key: 'ledger.account.role.set.would_point', argv: ['account', 'role', 'set', 'banco', '1111', '--qualifier', 'MXN', '--dry-run'], where: 'out',
    en: 'The role banco[MXN] would point to 1111 Bancos (dry-run: nothing was written)\n', es: 'El rol banco[MXN] apuntaría a 1111 Bancos (dry-run: nada se escribió)\n' },
  { key: 'ledger.account.role.seed.done', argv: ['account', 'role', 'seed'], where: 'out',
    setup: () => { vi.mocked(seedAccountRoles).mockResolvedValue({ rolesMapped: 1, accountsCreated: ['1111', '2110'], unmapped: [] } as never); },
    en: '✔ 1 role mapped, 2 base accounts created\n', es: '✔ 1 rol mapeado, 2 cuentas base creadas\n' },
  { key: 'ledger.account.role.seed.done', argv: ['account', 'role', 'seed'], where: 'out',
    setup: () => { vi.mocked(seedAccountRoles).mockResolvedValue({ rolesMapped: 3, accountsCreated: ['1111'], unmapped: [] } as never); },
    en: '✔ 3 roles mapped, 1 base account created\n', es: '✔ 3 roles mapeados, 1 cuenta base creada\n' },
  { key: 'ledger.account.role.seed.unmapped', argv: ['account', 'role', 'seed'], where: 'out',
    setup: () => { vi.mocked(seedAccountRoles).mockResolvedValue({ rolesMapped: 0, accountsCreated: [], unmapped: [{ role: 'iva_retenido' }] } as never); },
    en: '✔ 0 roles mapped, 0 base accounts created — unmapped: iva_retenido\n', es: '✔ 0 roles mapeados, 0 cuentas base creadas — sin mapear: iva_retenido\n' },
  { key: 'ledger.account.role.sync.not_mexican', argv: ['account', 'role', 'sync'], where: 'error',
    setup: () => { vi.mocked(censusWithholdingLayout).mockResolvedValue([] as never); },
    en: 'This entity does not keep Mexican books: it has no withholding roles.', es: 'Esta entidad no lleva libros mexicanos: no tiene roles de retención.' },
  { key: 'ledger.account.role.sync.nothing', argv: ['account', 'role', 'sync'], where: 'out', setup: plan([], false),
    en: 'Entidad Sintetica SA · withholding_accounts_layout = grouped\n  Nothing to change.\n',
    es: 'Entidad Sintetica SA · withholding_accounts_layout = grouped\n  Nada que cambiar.\n' },
  { key: 'ledger.account.role.sync.done', argv: ['account', 'role', 'sync'], where: 'out', setup: plan(['2160 → 2161'], true),
    en: '✔ applied and audited; no entry was posted.\n', es: '✔ aplicado y auditado; no se contabilizó ninguna póliza.\n' },

  // ---- account map ----
  { key: 'ledger.account.map.year_invalid', argv: ['account', 'map', 'set', '1130', '--scheme', 'sat-agrupador', '--value', '118.01', '--year', '26'], where: 'error',
    en: '--year must be a four-digit fiscal year; got "26".', es: '--year tiene que ser un ejercicio de cuatro dígitos; llegó "26".' },
  { key: 'ledger.account.map.set.dry_run', argv: ['account', 'map', 'set', '1130', '--scheme', 'ifrs', '--value', 'IAS-7', '--dry-run'], where: 'out',
    en: '1130: ifrs would be IAS-7 (dry-run)\n', es: '1130: ifrs sería IAS-7 (dry-run)\n' },
  { key: 'ledger.account.map.set.dry_run', argv: ['account', 'map', 'set', '1130', '--scheme', 'sat-agrupador', '--value', '', '--dry-run'], where: 'out',
    en: '1130: sat-agrupador would be cleared (dry-run)\n', es: '1130: sat-agrupador se limpiaría (dry-run)\n' },
  { key: 'ledger.account.map.import.no_pairs', argv: ['account', 'map', 'import', 'vacio.csv', '--scheme', 'sat-agrupador'], where: 'error',
    en: 'The file vacio.csv has no readable code,value pairs.', es: 'El archivo vacio.csv no trae pares código,valor legibles.' },
  { key: 'ledger.account.map.import.done', argv: ['account', 'map', 'import', 'pares.csv', '--scheme', 'sat-agrupador', '--dry-run'], where: 'out',
    setup: () => { vi.mocked(importAccountMappings).mockResolvedValue(IMPORTED as never); },
    en: '✔ 1/3 mappings applicable (sat-agrupador) (dry-run: nothing was written)\n', es: '✔ 1/3 mapeos aplicables (sat-agrupador) (dry-run: nada se escribió)\n' },
  { key: 'ledger.account.map.import.repeated', argv: ['account', 'map', 'import', 'pares.csv', '--scheme', 'sat-agrupador'], where: 'out',
    setup: () => { keyStore.repetido = true; keyStore.resultado = { resultados: IMPORTED }; },
    en: '✔ 1/3 mappings applied (sat-agrupador) [repeated: the result of the first run]\n', es: '✔ 1/3 mapeos aplicados (sat-agrupador) [repetido: resultado de la primera corrida]\n' },
  { key: 'ledger.account.map.import.no_account', argv: ['account', 'map', 'import', 'pares.csv', '--scheme', 'sat-agrupador', '--dry-run'], where: 'err',
    setup: () => { vi.mocked(importAccountMappings).mockResolvedValue(IMPORTED as never); },
    en: '  · 9999: does not exist in the chart\n', es: '  · 9999: no existe en el catálogo\n' },
  { key: 'ledger.account.map.import.empty_value', argv: ['account', 'map', 'import', 'pares.csv', '--scheme', 'sat-agrupador', '--dry-run'], where: 'err',
    setup: () => { vi.mocked(importAccountMappings).mockResolvedValue(IMPORTED as never); },
    en: '  · 1120: empty value, skipped\n', es: '  · 1120: valor vacío, omitido\n' },
  { key: 'ledger.account.map.check.available', argv: ['account', 'map', 'check', '--check', ','], where: 'out',
    en: 'Available checks: coverage\n', es: 'Verificaciones disponibles: coverage\n' },
  { key: 'ledger.account.map.check.unknown', argv: ['account', 'map', 'check', '--check', 'saldo'], where: 'error',
    en: 'Unknown check: saldo. Available: coverage.', es: 'Verificación desconocida: saldo. Disponibles: coverage.' },
  { key: 'ledger.account.map.check.level_retired', argv: ['account', 'map', 'check', '--level', '3'], where: 'error', prefix: true,
    en: '--level no longer applies: the gate measured by account level and that was the defect (43 gaps on a real entity, 42 of them accounts without a single movement, and the moved account without an agrupador left off the list for being at level 3). Today the population is set by the agrupador_alcance_de_la_compuerta policy; it is changed with `mnemosine pending reopen agrupador_alcance_de_la_compuerta`',
    es: '--level ya no aplica: la compuerta medía por nivel de cuenta y ése era el defecto (43 huecos sobre una entidad real, 42 de ellos cuentas sin un solo movimiento, y la cuenta movida sin agrupador fuera de la lista por estar en nivel 3). Hoy la población la fija la política agrupador_alcance_de_la_compuerta; se cambia con `mnemosine pending reopen agrupador_alcance_de_la_compuerta`' },
  { key: 'ledger.account.map.check.empty', argv: ['account', 'map', 'check'], where: 'err', setup: coverage(0, 0),
    en: '0 accounts in the scope "cuentas_con_movimientos", by default: nothing was checked\n',
    es: '0 cuentas en el alcance "cuentas_con_movimientos", por omisión: no se comprobó nada\n' },
  { key: 'ledger.account.map.check.scope', argv: ['account', 'map', 'check'], where: 'err', setup: coverage(5, 0, true),
    en: '(scope "cuentas_con_movimientos", chosen in the panel)\n', es: '(alcance "cuentas_con_movimientos", elegido en el panel)\n' },
  { key: 'ledger.account.map.check.complete', argv: ['account', 'map', 'check'], where: 'err', setup: coverage(5, 0),
    en: '✔ full coverage: 5 accounts with sat-agrupador (scope "cuentas_con_movimientos", by default)\n',
    es: '✔ cobertura completa: 5 cuentas con sat-agrupador (alcance "cuentas_con_movimientos", por omisión)\n' },
  { key: 'ledger.account.map.check.complete', argv: ['account', 'map', 'check'], where: 'err', setup: coverage(1, 0),
    en: '✔ full coverage: 1 account with sat-agrupador', es: '✔ cobertura completa: 1 cuenta con sat-agrupador' },
  { key: 'ledger.account.map.check.gaps', argv: ['account', 'map', 'check'], where: 'err', setup: coverage(5, 2),
    en: '2 of 5 accounts without sat-agrupador (scope "cuentas_con_movimientos", by default): the catalog XML would come out incomplete\n',
    es: '2 de 5 cuentas sin sat-agrupador (alcance "cuentas_con_movimientos", por omisión): el XML de catálogo saldría incompleto\n' },
  { key: 'ledger.account.map.check.gaps', argv: ['account', 'map', 'check'], where: 'err', setup: coverage(1, 1),
    en: '1 of 1 account without sat-agrupador', es: '1 de 1 cuenta sin sat-agrupador' },
  { key: 'ledger.account.restore.done', argv: ['account', 'restore', '6150'], where: 'out',
    en: '✔ 6150 is active again.\n', es: '✔ 6150 vuelve a estar activa.\n' },
];

describe('I8.9 · batch and account speak by key', () => {
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
    const keys = Object.keys(EN).filter((k) => k.startsWith('ledger.batch.') || k.startsWith('ledger.account.'));
    expect(new Set(CASES.map((c) => c.key))).toEqual(new Set(keys));
  });

  it('the Examples of account create: English byte for byte, Spanish with the same command lines', async () => {
    const help = async (lang: 'en' | 'es') => {
      if (lang === 'es') setLanguage('es');
      resetDeclarations();
      const cli = new Command('mnemosine').exitOverride();
      registerAccountCommand(cli, { palette, shutdown: () => undefined, reportError: () => undefined });
      const create = cli.commands.find((c) => c.name() === 'account')!.commands.find((c) => c.name() === 'create')!;
      const chunks: string[] = [];
      (create as unknown as { emit(e: string, c: unknown): boolean }).emit('afterHelp', {
        error: false, command: create, write: (s: string) => { chunks.push(s); },
      });
      return chunks.join('');
    };
    // Commander ends every help text with its own newline, as it did for the literal.
    const lines = [
      '  mnemosine account create 6150 "Mantenimiento de oficina" --type expense --parent 6100\n',
      '  mnemosine account create 1250 "Activo Intangible" --type asset --parent 1200 --header\n',
    ];
    expect(await help('en')).toBe(
      '\nExamples:\n  # A new expense account hanging off Gastos de Administracion (6100).\n' + lines[0] +
        '  # A grouping node: --header means it accepts no manual entries.\n' + lines[1] + '\n'
    );
    expect(await help('es')).toBe(
      '\nEjemplos:\n  # Una cuenta de gasto nueva que cuelga de Gastos de Administracion (6100).\n' + lines[0] +
        '  # Un nodo de agrupación: --header quiere decir que no acepta pólizas manuales.\n' + lines[1] + '\n'
    );
  });

  it('--json of post and reverse is the same document in the two languages', async () => {
    for (const c of [
      { argv: ['batch', 'post', B1, '--dry-run', '--json'], setup: posting() },
      { argv: ['batch', 'reverse', B1, '--dry-run', '--json'], setup: reversing() },
    ]) {
      const en = (await run(c, 'en')).out;
      resetLanguage();
      const es = (await run(c, 'es')).out;
      expect(JSON.parse(es)).toEqual(JSON.parse(en));
      expect(en).toContain(B1);
    }
  });

  it('a refused confirmation leaves the ledger untouched, in the kernel words, in both languages', async () => {
    const c = { argv: ['batch', 'post', B1], setup: posting(), confirm: false };
    expect((await run(c, 'en')).error).toMatch(/^No changes: there is no terminal to confirm at\. Add -y so `batch post` runs/);
    resetLanguage();
    expect((await run(c, 'es')).error).toMatch(/^Sin cambios: no hay terminal donde confirmar\. Añade -y para que `batch post` corra/);
  });
});
