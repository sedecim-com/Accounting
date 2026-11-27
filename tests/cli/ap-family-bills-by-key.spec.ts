import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// ============================================================
// I8.8 · the ap family speaks by key (MNE-001-614, #270): bill
//
// One row per key this part adds to the I8.8 block, through the real leaf
// over doubles (the services are mocked; `query` answers the inbox SQL), in
// English (the test locale is en-US) and in es-MX, with a singular and a
// plural where «(s)» used to be, the selects, the nested statuses key and the
// `detail` column of `bill inbox run`, which follows the person's language.
// Prepaid's are in ap-family-by-key.spec.ts; reconcile, vendor and payment's
// in ap-family-payables-by-key.spec.ts.
// ============================================================

const CTX = { tenantId: 't1', entityId: 'e1', entityName: 'Entidad Sintetica SA', country: 'MX', currency: 'MXN' };
const ID = '11111111-1111-1111-1111-111111111111';

type Resp = { rows: unknown[]; rowCount: number };
let responder: (text: string, params: unknown[]) => Resp = () => ({ rows: [], rowCount: 0 });

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(async (text: string, params: unknown[] = []) => responder(text, params)),
  currentTenant: () => 't1',
}));
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: vi.fn(async () => ({ userId: 'u1' })) }));
vi.mock('../../src/cli/kernel/entity-context.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveActiveEntity: vi.fn(async () => ({ ctx: CTX })),
  requireExplicitEntity: vi.fn(async () => CTX),
}));
vi.mock('../../src/services/ap/bill-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listBills: vi.fn(async () => ({ rows: [], total: 0 })),
  getBillById: vi.fn(),
  resolveBill: vi.fn(),
  createBill: vi.fn(),
  setBillLine: vi.fn(),
  approveBill: vi.fn(),
  voidBill: vi.fn(),
}));
vi.mock('../../src/services/ap/vendor-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveVendor: vi.fn(async () => ({ id: 'v1', company_name: 'Papeleria Sintetica', payment_terms: 'Net 30', currency_code: 'MXN' })),
}));
vi.mock('../../src/services/accounting/account-service.js', () => ({ resolveAccount: vi.fn(async () => ({ id: 'a1' })) }));
vi.mock('../../src/services/xml-ingestion/expense-line-account.js', () => ({
  eligibleSuggestions: vi.fn(async () => new Map()),
  uncodedLines: vi.fn(() => []),
}));
vi.mock('../../src/services/xml-ingestion/pre-registration-coding.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  codePreRegistration: vi.fn(async () => ({ lines: [], default_account_id: 'a1', document_type: 'bill' })),
}));
const processSpy = vi.fn();
vi.mock('../../src/services/xml-ingestion/pre-registration-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  PreRegistrationService: class { processToAccounting(...a: unknown[]) { return processSpy(...a) as unknown; } },
}));
const keyStore = { repetido: false, resultado: undefined as unknown };
vi.mock('../../src/services/idempotency/idempotency-store.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  conLlave: vi.fn(async (_c: unknown, _k: unknown, fn: () => Promise<unknown>) =>
    keyStore.repetido ? { repetido: true, resultado: keyStore.resultado } : { repetido: false, resultado: await fn() }),
}));
vi.mock('../../src/services/policy/today.js', () => ({ todayFor: vi.fn(async () => '2026-07-31') }));
vi.mock('../../src/services/accounting/posting.js', () => ({ attestEntryAsync: vi.fn() }));
vi.mock('../../src/services/reporting/report-service.js', () => ({ resolvePeriodRange: vi.fn() }));
vi.mock('../../src/cli/bill-rule-command.js', () => ({ registerBillRuleCommands: vi.fn() }));
vi.mock('node:fs', async (original) => {
  const real = await original<typeof import('node:fs')>();
  return {
    ...real,
    readFileSync: vi.fn((p: string, ...rest: unknown[]) => {
      if (p === 'no-such.json') throw new Error('ENOENT');
      if (p === 'bad.json') return '{nope';
      if (p === 'array.json') return '[]';
      return (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    }),
  };
});

import { legacyTaxKeyWarning, registerBillCommand } from '../../src/cli/bill-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import { AccountingError } from '../../src/utils/errors.js';
import { approveBill, createBill, getBillById, resolveBill, setBillLine, voidBill } from '../../src/services/ap/bill-service.js';
import { uncodedLines } from '../../src/services/xml-ingestion/expense-line-account.js';
import { codePreRegistration } from '../../src/services/xml-ingestion/pre-registration-coding.js';

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

function row(over: Record<string, unknown> = {}) {
  return {
    id: ID, external_reference: 'A-1', document_date: '2026-07-01', total_amount: '1160.0000', currency_code: 'MXN',
    status: 'ready', processing_mode: 'manual', requires_approval: false, approval_status: null,
    validation_status: 'valid', is_new_vendor: false, document_type: 'bill', error_message: null,
    vendor_name: 'Proveedor Sintetico SA', suggested_vendor_name: null, emisor_rfc: 'XAXX010101000', emisor_nombre: 'Proveedor Sintetico SA',
    ...over,
  };
}
const inbox = (rows: unknown[], o: { waiting?: number; update?: number; raw?: Record<string, unknown>; batch?: boolean; uuid?: string | null } = {}) =>
  (text: string): Resp => {
    const raw = { document_type: 'bill', requires_approval: false, ...(rows[0] as object ?? {}), ...(o.raw ?? {}), entity_id: 'e1' };
    if (/status = 'draft' AND validation_status/.test(text)) return { rows: [{ n: String(o.waiting ?? 0) }], rowCount: 1 };
    if (/COUNT\(\*\) AS n/.test(text)) return { rows: [{ n: String(rows.length) }], rowCount: 1 };
    if (/FROM pre_registrations pr/.test(text)) return { rows, rowCount: rows.length };
    if (/^\s*SELECT \* FROM pre_registrations/.test(text)) return { rows: o.raw === null ? [] : [raw], rowCount: 1 };
    if (/UPDATE pre_registrations/.test(text)) return { rows: [], rowCount: o.update ?? 1 };
    if (/FROM processing_batches/.test(text)) return o.batch === false ? { rows: [], rowCount: 0 } : { rows: [{ id: 'B1' }], rowCount: 1 };
    if (/FROM xml_documents/.test(text)) return { rows: [{ cfdi_uuid: o.uuid ?? null }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };

const BILL = { id: 'b1', bill_number: 'BILL-2026-00007', status: 'draft', total_amount: '1160.00', currency_code: 'MXN', journal_entry_id: null };
const ENTRY = { entry: { entry_number: 'JE-2026-00042', entry_date: '2026-07-08' }, entryLines: [], deductibilityFindings: [] };

type Where = 'error' | 'out' | 'err' | 'asked';
type Case = {
  key: string;
  argv: string[];
  setup?: () => void;
  confirm?: boolean;
  where: Where;
  en: string;
  es: string;
  /** The error ends with the parser's own words, which vary by Node version. */
  prefix?: boolean;
};

async function run(c: Pick<Case, 'argv' | 'setup' | 'confirm'>, lang: 'en' | 'es') {
  vi.clearAllMocks();
  processSpy.mockReset();
  keyStore.repetido = false;
  responder = inbox([]);
  vi.mocked(uncodedLines).mockReturnValue([] as never);
  vi.mocked(codePreRegistration).mockResolvedValue({ lines: [], default_account_id: 'a1', document_type: 'bill' } as never);
  c.setup?.();
  if (lang === 'es') setLanguage('es');
  out = '';
  err = '';
  resetDeclarations();
  const state: { code?: number; error?: Localized; asked: string[] } = { asked: [] };
  const cli = new Command('mnemosine').exitOverride();
  registerBillCommand(cli, {
    palette,
    home: '/tmp/mnemosine-tests-no-home',
    shutdown: (code: number) => { state.code = code; },
    reportError: (e: unknown) => { state.error = e as Localized; },
    ...(c.confirm ? { confirm: async (q: string) => { state.asked.push(q); return true; } } : {}),
  });
  await cli.parseAsync(['node', 'mnemosine', ...c.argv, '-e', 'e1']);
  return {
    code: state.code,
    error: state.error?.localized ? state.error.localized() : (state.error?.message ?? ''),
    asked: state.asked.join('\n'),
    out,
    err,
  };
}

const RUN = ['bill', 'inbox', 'run'];
const VOID = ['bill', 'void', 'BILL-9', '--reason', 'CFDI cancelled by the vendor'];
const MIRROR = { id: 'm1', entryNumber: 'JE-2026-00043', date: '2026-07-31', posted: true, datedBy: 'void_date' as string | null };
const voiding = (mirror: typeof MIRROR | null) => () => {
  vi.mocked(resolveBill).mockResolvedValue({ ...BILL, status: 'approved' } as never);
  vi.mocked(voidBill).mockResolvedValue({ bill: { ...BILL, status: 'void' }, mirror, mirrorLines: [], attestation: null, dryRun: false } as never);
};
const withBill = (over: Record<string, unknown> = {}) => () => { vi.mocked(resolveBill).mockResolvedValue({ ...BILL, ...over } as never); };
const approving = (value: unknown, over: Record<string, unknown> = {}) => () => {
  withBill(over)();
  if (value instanceof Error) vi.mocked(approveBill).mockRejectedValue(value);
  else vi.mocked(approveBill).mockResolvedValue(value as never);
};
const ROW2 = '22222222-2222-2222-2222-222222222222';

const CASES: Case[] = [
  // ---- bill list / show / create / line set ----
  { key: 'ap.bill.date_invalid', argv: ['bill', 'list', '--due-before', '2026-13-45'], where: 'error',
    en: '--due-before must be a date as YYYY-MM-DD; got "2026-13-45".', es: '--due-before debe ser una fecha AAAA-MM-DD; llegó "2026-13-45".' },
  { key: 'ap.bill.list.as_of_unsupported', argv: ['bill', 'list', '--as-of', '2026-07-31'], where: 'error',
    en: '--as-of asks what was open on a date, which is an aging question this command cannot answer (it needs the payment history joined per bill). Use --until for the document date.',
    es: '--as-of pregunta qué estaba abierto en una fecha, que es una pregunta de antigüedad que este comando no puede contestar (necesita la historia de pagos cruzada por factura). Usa --until para la fecha del documento.' },
  { key: 'ap.bill.list.date_basis_invalid', argv: ['bill', 'list', '--date-basis', 'cash'], where: 'error',
    en: '--date-basis cash is not defined for a bill: a bill has a document date and, once approved, a posting date. Use document or posting.',
    es: '--date-basis cash no está definido para una factura: una factura tiene fecha de documento y, una vez aprobada, fecha de contabilización. Usa document o posting.' },
  { key: 'ap.bill.show.disappeared', argv: ['bill', 'show', 'BILL-9'], where: 'error',
    setup: () => { withBill()(); vi.mocked(getBillById).mockResolvedValue(null as never); },
    en: 'Bill BILL-9 disappeared while reading it.', es: 'La factura BILL-9 desapareció mientras se leía.' },
  ...(['ap.bill.show.lines_title', 'ap.bill.show.journal_title', 'ap.bill.show.no_cfdi'] as const).map((key, i): Case => ({
    key, argv: ['bill', 'show', 'BILL-9', '--journal', '--cfdi'], where: 'err',
    setup: () => {
      withBill()();
      vi.mocked(getBillById).mockResolvedValue({ bill_number: 'BILL-9', lines: [{ line_number: 1 }], journal_entry: { lines: [{ line_number: 1 }] }, cfdi: [] } as never);
    },
    en: ['\nLines\n', '\nJournal entry\n', '\n  None: this bill was not captured from an XML.\n'][i],
    es: ['\nLíneas\n', '\nPóliza\n', '\n  Ninguno: esta factura no se capturó desde un XML.\n'][i],
  })),
  { key: 'ap.bill.create.vendor_missing', argv: ['bill', 'create'], where: 'error',
    en: 'Which vendor? Pass it as the argument or with --vendor.', es: '¿Qué proveedor? Pásalo como argumento o con --vendor.' },
  { key: 'ap.bill.create.lines_missing', argv: ['bill', 'create', 'V1'], where: 'error',
    en: 'A bill needs at least one line: --line "account=5100;qty=1;price=1000;tax-amount=160".',
    es: 'Una factura necesita al menos una línea: --line "account=5100;qty=1;price=1000;tax-amount=160".' },
  { key: 'ap.bill.create.line_without_account', argv: ['bill', 'create', 'V1', '--line', 'price=1'], where: 'error',
    en: 'Every line needs account=<code>: a line with no account cannot be posted.',
    es: 'Cada línea necesita account=<código>: una línea sin cuenta no se puede contabilizar.' },
  { key: 'ap.bill.create.line_without_price', argv: ['bill', 'create', 'V1', '--line', 'account=6100'], where: 'error',
    en: 'Line "account=6100" has no price=<amount>.', es: 'La línea "account=6100" no trae price=<importe>.' },
  { key: 'ap.bill.create.no_due_date', argv: ['bill', 'create', 'V1', '--line', 'account=6100;price=1', '--terms', 'cuando se pueda'], where: 'error',
    en: 'No due date, and "cuando se pueda" implies none. Pass --due-date, or set terms a due date can be computed from with `vendor terms set`.',
    es: 'No hay fecha de vencimiento, y "cuando se pueda" no implica ninguna. Pasa --due-date, o fija con `vendor terms set` unas condiciones de las que se pueda calcular.' },
  ...(['ap.bill.create.legacy_tax_key', 'ap.bill.create.done', 'ap.bill.create.draft_note'] as const).map((key, i): Case => ({
    key, argv: ['bill', 'create', 'V1', '--line', 'account=6100;price=1000;tax=160', '--bill-date', '2026-07-08'],
    where: i === 1 ? 'out' : 'err',
    setup: () => { vi.mocked(createBill).mockResolvedValue({ bill_number: 'BILL-2026-00008', currency_code: 'MXN' } as never); },
    en: [
      '  tax= is the AMOUNT of the IVA of the line, not the rate; use tax-amount= so that it is explicit. tax= stops being accepted in version 2.0.0.\n',
      '✔ BILL-2026-00008 Papeleria Sintetica · 1000.0000 + 160.0000 tax = 1160.0000 MXN · due 2026-08-07\n',
      '  Status draft: nothing is in the ledger until `bill approve`.\n',
    ][i],
    es: [
      '  tax= es el MONTO del IVA de la línea, no la tasa; usa tax-amount= para que quede explícito. tax= deja de aceptarse en la versión 2.0.0.\n',
      '✔ BILL-2026-00008 Papeleria Sintetica · 1000.0000 + 160.0000 IVA = 1160.0000 MXN · vence 2026-08-07\n',
      '  Estado draft: nada está en el mayor hasta `bill approve`.\n',
    ][i],
  })),
  { key: 'ap.bill.create.file_unreadable', argv: ['bill', 'create', 'V1', '--from-file', '@no-such.json'], where: 'error',
    en: 'Cannot read --from-file "no-such.json".', es: 'No se puede leer --from-file "no-such.json".' },
  { key: 'ap.bill.create.file_not_json', argv: ['bill', 'create', 'V1', '--from-file', 'bad.json'], where: 'error',
    en: '--from-file "bad.json" is not valid JSON: ', es: '--from-file "bad.json" no es JSON válido: ', prefix: true },
  { key: 'ap.bill.create.file_not_object', argv: ['bill', 'create', 'V1', '--from-file', 'array.json'], where: 'error',
    en: '--from-file "array.json" must contain a JSON object with a "lines" array.',
    es: '--from-file "array.json" debe contener un objeto JSON con un arreglo "lines".' },
  { key: 'ap.bill.line_number_invalid', argv: ['bill', 'line', 'set', 'BILL-9', '--line', 'x'], where: 'error',
    en: '--line must be a line number; got "x".', es: '--line debe ser un número de línea; llegó "x".' },
  { key: 'ap.bill.line.set.done', argv: ['bill', 'line', 'set', 'BILL-9', '--line', '2', '--account', '6130'], where: 'out',
    setup: () => { withBill()(); vi.mocked(setBillLine).mockResolvedValue({ line: { line_number: 2, total_amount: '116.00' } } as never); },
    en: '✔ BILL-2026-00007 line 2 recoded (116.00)\n', es: '✔ BILL-2026-00007 línea 2 recodificada (116.00)\n' },

  // ---- bill approve ----
  { key: 'ap.bill.approve.not_approvable', argv: ['bill', 'approve', 'BILL-9'], where: 'error', setup: withBill({ status: 'posted', journal_entry_id: 'je' }),
    en: 'Bill BILL-2026-00007 is "posted", not draft or pending_approval. It is already in the ledger; reversing it is `bill reverse`, which has no backend yet.',
    es: 'La factura BILL-2026-00007 está en "posted", no en draft o pending_approval. Ya está en el mayor; reversarla es `bill reverse`, que todavía no tiene backend.' },
  { key: 'ap.bill.approve.statuses', argv: ['bill', 'approve', 'BILL-9'], where: 'error', setup: withBill({ status: 'void' }),
    en: 'Bill BILL-2026-00007 is "void", not draft or pending_approval. Only a bill still being worked on can be approved.',
    es: 'La factura BILL-2026-00007 está en "void", no en draft o pending_approval. Sólo se aprueba una factura que todavía se está trabajando.' },
  { key: 'ap.bill.approve.period_closed', argv: ['bill', 'approve', 'BILL-9', '--dry-run'], where: 'error',
    setup: approving(Object.assign(new Error('Period 2026-07 is closed'), { code: 'PERIOD_CLOSED' })),
    en: 'BILL-2026-00007 cannot be posted: Period 2026-07 is closed. Its bill date falls in a period that is closed or locked. Reopen the period, or post it in an open one once `bill edit` exists to move the date.',
    es: 'BILL-2026-00007 no se puede contabilizar: Period 2026-07 is closed. Su fecha cae en un periodo cerrado o bloqueado. Reabre el periodo, o contabilízala en uno abierto cuando exista `bill edit` para mover la fecha.' },
  { key: 'ap.bill.approve.missing_role', argv: ['bill', 'approve', 'BILL-9', '--dry-run'], where: 'error',
    setup: approving(Object.assign(new Error('no ap_control role'), { code: 'MISSING_ROLE_ACCOUNT' })),
    en: 'BILL-2026-00007 cannot be posted: no ap_control role', es: 'BILL-2026-00007 no se puede contabilizar: no ap_control role' },
  // MNE-001-154: a refusal the ledger wrote by key renders in the sentence's language, not in its English message.
  { key: 'ap.bill.approve.missing_role', argv: ['bill', 'approve', 'BILL-9', '--dry-run'], where: 'error',
    setup: approving(new AccountingError('MISSING_ROLE_ACCOUNT', { key: 'error.MISSING_ROLE_ACCOUNT.unmapped', params: { role: 'cxp' } })),
    en: 'BILL-2026-00007 cannot be posted: No account is mapped to the role "cxp" on this entity. Seed the books with: mnemosine init --section identity (or check what is missing with: mnemosine doctor)',
    es: 'BILL-2026-00007 no se puede contabilizar: No hay cuenta mapeada al rol "cxp" en esta entidad. Siembra la contabilidad con: mnemosine init --section identity (o revisa qué falta con: mnemosine doctor)' },
  ...(['ap.bill.approve.entry_title', 'ap.bill.dry_run'] as const).map((key, i): Case => ({
    key, argv: ['bill', 'approve', 'BILL-9', '--dry-run'], where: 'err', setup: approving(ENTRY),
    en: ['\nEntry JE-2026-00042 · 2026-07-08\n', '\nDry run: nothing was written.\n'][i],
    es: ['\nAsiento JE-2026-00042 · 2026-07-08\n', '\nEnsayo: no se escribió nada.\n'][i],
  })),
  { key: 'ap.bill.approve.no_entry', argv: ['bill', 'approve', 'BILL-9', '--dry-run'], where: 'err', setup: approving({ ...ENTRY, entry: null }),
    en: 'BILL-2026-00007 produces no journal entry (already posted, or a zero total).\n',
    es: 'BILL-2026-00007 no produce asiento (ya estaba contabilizada, o su total es cero).\n' },
  { key: 'ap.bill.approve.no_terminal', argv: ['bill', 'approve', 'BILL-9'], where: 'error', setup: approving(ENTRY),
    en: 'This posts to the ledger and there is no terminal to confirm at. Re-run with --yes when you mean it, or with --dry-run to see the entry.',
    es: 'Esto contabiliza en el mayor y no hay terminal donde confirmar. Re-ejecuta con --yes cuando lo tengas decidido, o con --dry-run para ver el asiento.' },
  ...(['ap.bill.approve.confirm', 'ap.bill.approve.done', 'ap.bill.approve.key_not_needed'] as const).map((key, i): Case => ({
    key, argv: ['bill', 'approve', 'BILL-9', '--idempotency-key', 'k1'], confirm: true, setup: approving(ENTRY),
    where: (['asked', 'out', 'err'] as const)[i],
    en: [
      'Post BILL-2026-00007 (1160.00 MXN) to the ledger of Entidad Sintetica SA? This cannot be undone.',
      '✔ BILL-2026-00007 approved · entry JE-2026-00042 posted 2026-07-08\n',
      '  --idempotency-key was not needed: approval is idempotent behind the bill status and its journal_entry_id.\n',
    ][i],
    es: [
      '¿Contabilizar BILL-2026-00007 (1160.00 MXN) en el mayor de Entidad Sintetica SA? Esto no se deshace.',
      '✔ BILL-2026-00007 aprobada · asiento JE-2026-00042 contabilizado el 2026-07-08\n',
      '  No hacía falta --idempotency-key: la aprobación ya es idempotente por el estado de la factura y su journal_entry_id.\n',
    ][i],
  })),
  { key: 'ap.bill.approve.done', argv: ['bill', 'approve', 'BILL-9', '--yes'], where: 'out', setup: approving({ ...ENTRY, entry: null }),
    en: '✔ BILL-2026-00007 approved · no entry: it was already posted\n', es: '✔ BILL-2026-00007 aprobada · sin asiento: ya estaba contabilizada\n' },

  // ---- bill void (MNE-001-947) ----
  { key: 'ap.bill.void.no_terminal', argv: [...VOID], where: 'error', setup: voiding(MIRROR),
    en: 'This voids a bill and there is no terminal to confirm at. Re-run with --yes when you mean it, or with --dry-run to see the mirror.',
    es: 'Esto anula un gasto y no hay terminal donde confirmar. Re-ejecuta con --yes cuando lo tengas decidido, o con --dry-run para ver el espejo.' },
  ...(['ap.bill.void.confirm', 'ap.bill.void.result', 'ap.bill.void.key_not_needed'] as const).map((key, i): Case => ({
    key, argv: [...VOID, '--idempotency-key', 'k1'], confirm: true, setup: voiding(MIRROR),
    where: (['asked', 'out', 'err'] as const)[i],
    en: [
      'Void BILL-2026-00007 (1160.00 MXN) of Entidad Sintetica SA? The mirror of its entry is posted on 2026-07-31. This cannot be undone.',
      '✔ BILL-2026-00007 voided · mirror JE-2026-00043 dated 2026-07-31 by bill_void_mirror_date = void_date\n',
      '  --idempotency-key was not needed: a bill that is already void is not voided again.\n',
    ][i],
    es: [
      '¿Anular BILL-2026-00007 (1160.00 MXN) de Entidad Sintetica SA? El espejo de su póliza se postea con fecha 2026-07-31. Esto no se deshace.',
      '✔ BILL-2026-00007 anulado · espejo JE-2026-00043 con fecha 2026-07-31 por bill_void_mirror_date = void_date\n',
      '  No hacía falta --idempotency-key: un gasto que ya está anulado no se anula otra vez.\n',
    ][i],
  })),
  { key: 'ap.bill.void.result', argv: [...VOID, '--dry-run'], where: 'out', setup: voiding({ ...MIRROR, datedBy: 'closed_period' }),
    en: 'Would void BILL-2026-00007 · mirror JE-2026-00043 dated 2026-07-31 by bill_void_mirror_date = bill_date and cfdi_periodo_cerrado = periodo_actual, its period not being open\n',
    es: 'Se anularía BILL-2026-00007 · espejo JE-2026-00043 con fecha 2026-07-31 por bill_void_mirror_date = bill_date y cfdi_periodo_cerrado = periodo_actual, porque su periodo no está abierto\n' },
  { key: 'ap.bill.void.result', argv: [...VOID, '--yes'], where: 'out', setup: voiding({ ...MIRROR, datedBy: 'bill_date' }),
    en: 'by bill_void_mirror_date = bill_date\n', es: 'por bill_void_mirror_date = bill_date\n' },
  ...(['ap.bill.void.confirm', 'ap.bill.void.result'] as const).map((key, i): Case => ({
    key, argv: [...VOID], confirm: true, setup: voiding({ ...MIRROR, posted: false, datedBy: null }), where: (['asked', 'out'] as const)[i],
    en: ['Its entry already has the mirror JE-2026-00043: none is posted. This cannot be undone.',
      '✔ BILL-2026-00007 voided · its entry already had the mirror JE-2026-00043 of 2026-07-31; none was posted\n'][i],
    es: ['Su póliza ya tiene el espejo JE-2026-00043: no se postea ninguno. Esto no se deshace.',
      '✔ BILL-2026-00007 anulado · su póliza ya tenía el espejo JE-2026-00043 del 2026-07-31; no se posteó ninguno\n'][i],
  })),
  ...(['ap.bill.void.confirm', 'ap.bill.void.result'] as const).map((key, i): Case => ({
    key, argv: [...VOID], confirm: true, setup: voiding(null), where: (['asked', 'out'] as const)[i],
    en: ['It never reached the ledger: nothing is posted. This cannot be undone.', '✔ BILL-2026-00007 voided · it had never reached the ledger\n'][i],
    es: ['Nunca llegó al mayor: no se postea nada. Esto no se deshace.', '✔ BILL-2026-00007 anulado · nunca había llegado al mayor\n'][i],
  })),

  // ---- bill inbox list / edit ----
  ...(['ap.bill.inbox.list.new_vendors', 'ap.bill.inbox.list.new_vendors_note', 'ap.bill.inbox.unnamed_issuer'] as const).map((key, i): Case => ({
    key, argv: ['bill', 'inbox', 'list'], where: i === 2 ? 'out' : 'err',
    setup: () => { responder = inbox([row({ vendor_name: null, is_new_vendor: true, suggested_vendor_name: null, emisor_nombre: null }), row()]); },
    en: [
      '\n1 of 2 comes from a vendor that is NOT in the catalog (marked «⚠ nuevo:»).\n',
      '  Posting them would create the counterparty with the name and the RFC of the XML.\n  `bill inbox run` refuses them unless it carries --allow-new-vendor; the other way out\n  is to create them by hand with `vendor create`.\n',
      '⚠ nuevo: unnamed issuer',
    ][i],
    es: [
      '\n1 de 2 traen un proveedor que NO está en el catálogo (marcados «⚠ nuevo:»).\n',
      '  Contabilizarlos daría de alta la contraparte con el nombre y el RFC del XML.\n  `bill inbox run` los rechaza salvo que lleve --allow-new-vendor; la otra salida\n  es darlos de alta a mano con `vendor create`.\n',
      '⚠ nuevo: emisor sin nombre',
    ][i],
  })),
  { key: 'ap.bill.inbox.list.new_vendors', argv: ['bill', 'inbox', 'list'], where: 'err',
    setup: () => { responder = inbox([row({ vendor_name: null, is_new_vendor: true }), row({ vendor_name: null, is_new_vendor: true })]); },
    en: '\n2 of 2 come from a vendor', es: '\n2 de 2 traen un proveedor' },
  { key: 'ap.bill.inbox.value_unknown', argv: ['bill', 'inbox', 'list', '--status', 'listo'], where: 'error',
    en: '--status "listo" does not exist. The possible values are: draft, validating, ready, queued, processing, completed, rejected, error, duplicate.',
    es: '--status "listo" no existe. Los valores posibles son: draft, validating, ready, queued, processing, completed, rejected, error, duplicate.' },
  { key: 'ap.bill.inbox.id_invalid', argv: ['bill', 'inbox', 'edit', 'abc'], where: 'error',
    en: '"abc" is not a pre-registration id (uuid). Take it from `bill inbox list`.', es: '"abc" no es el id de un pre-registro (uuid). Sácalo de `bill inbox list`.' },
  { key: 'ap.bill.inbox.edit.cost_center_needs_line', argv: ['bill', 'inbox', 'edit', ID, '--cost-center', 'x'], where: 'error',
    en: '--cost-center codes one line: pass --line <n> too.', es: '--cost-center codifica una línea: pasa también --line <n>.' },
  { key: 'ap.bill.inbox.edit.cost_center_invalid', argv: ['bill', 'inbox', 'edit', ID, '--line', '1', '--cost-center', 'x'], where: 'error',
    en: '--cost-center must be a cost center id (uuid); got "x".', es: '--cost-center debe ser el id de un centro de costo (uuid); llegó "x".' },
  { key: 'ap.bill.inbox.edit.nothing_to_code', argv: ['bill', 'inbox', 'edit', ID], where: 'error',
    en: 'Nothing to code: pass --account, or --line with --account or --cost-center.', es: 'Nada que codificar: pasa --account, o --line con --account o --cost-center.' },
  ...(['ap.bill.inbox.edit.done', 'ap.bill.inbox.edit.post_with'] as const).map((key, i): Case => ({
    key, argv: ['bill', 'inbox', 'edit', ID, '--account', '6130'], where: i === 0 ? 'out' : 'err',
    en: ['✔ 11111111 default account set · 0 lines still without an account\n', `  Post it with \`mnemosine bill inbox run ${ID}\`.\n`][i],
    es: ['✔ 11111111 cuenta por omisión fijada · 0 líneas siguen sin cuenta\n', `  Contabilízalo con \`mnemosine bill inbox run ${ID}\`.\n`][i],
  })),
  ...([1, 2] as const).map((n): Case => ({
    key: 'ap.bill.inbox.edit.uncoded', argv: ['bill', 'inbox', 'edit', ID, '--line', '1', '--account', '6130'], where: 'out',
    setup: () => { vi.mocked(uncodedLines).mockReturnValue(Array.from({ length: n }, () => ({})) as never); },
    en: n === 1 ? '✔ 11111111 line 1 coded · 1 line still without an account\n' : '✔ 11111111 line 1 coded · 2 lines still without an account\n',
    es: n === 1 ? '✔ 11111111 línea 1 codificada · 1 línea sigue sin cuenta\n' : '✔ 11111111 línea 1 codificada · 2 líneas siguen sin cuenta\n',
  })),

  // ---- bill inbox run: flags and selection ----
  { key: 'ap.bill.inbox.run.reason_missing', argv: [...RUN, ID, '--action', 'reject'], where: 'error',
    en: '--action reject discards a document: it requires --reason "<why>".', es: '--action reject descarta un documento: exige --reason "<por qué>".' },
  { key: 'ap.bill.inbox.run.batch_missing', argv: [...RUN, ID, '--action', 'set-batch'], where: 'error',
    en: '--action set-batch needs --batch <batch id or number>.', es: '--action set-batch necesita --batch <id o número de lote>.' },
  { key: 'ap.bill.inbox.run.action_unknown', argv: [...RUN, ID, '--action', 'borrar'], where: 'error',
    en: '--action "borrar" does not exist. Use one of: process, approve, reject, set-batch.', es: '--action "borrar" no existe. Usa una de: process, approve, reject, set-batch.' },
  { key: 'ap.bill.inbox.run.id_and_bulk', argv: [...RUN, ID, '--bulk'], where: 'error',
    en: 'Pass an id, or --bulk with --query. The two together mean nothing.', es: 'Pasa un id, o --bulk con --query. Los dos a la vez no significan nada.' },
  { key: 'ap.bill.inbox.id_invalid', argv: [...RUN, 'abc'], where: 'error',
    en: '"abc" is not a pre-registration id (uuid). Take it from `bill inbox list`.', es: '"abc" no es el id de un pre-registro (uuid). Sácalo de `bill inbox list`.' },
  { key: 'ap.bill.inbox.run.nothing_selected', argv: [...RUN], where: 'error',
    en: 'On what? Pass the id of a pre-registration, or --bulk with --query "status=ready".', es: '¿Sobre qué? Pasa el id de un pre-registro, o --bulk con --query "status=ready".' },
  { key: 'ap.bill.inbox.run.bulk_without_query', argv: [...RUN, '--bulk'], where: 'error',
    en: '--bulk without --query would act on the WHOLE inbox. Name the selection: --query "status=ready,mode=manual" (keys: status, mode, requires-approval, vendor, since, until, search).',
    es: '--bulk sin --query actuaría sobre TODA la bandeja. Nombra la selección: --query "status=ready,mode=manual" (claves: status, mode, requires-approval, vendor, since, until, search).' },
  { key: 'ap.bill.inbox.run.query_unparsable', argv: [...RUN, '--bulk', '--query', 'ready'], where: 'error',
    en: 'Cannot read --query "ready". Each part is key=value separated by commas: --query "status=ready,mode=manual". Keys: status, mode, requires-approval, vendor, since, until, search.',
    es: 'No se entiende --query "ready". Cada parte es clave=valor separada por comas: --query "status=ready,mode=manual". Claves: status, mode, requires-approval, vendor, since, until, search.' },
  { key: 'ap.bill.inbox.run.query_keys_unknown', argv: [...RUN, '--bulk', '--query', 'estado=ready'], where: 'error',
    en: 'Key that --query does not know: estado. Keys: status, mode, requires-approval, vendor, since, until, search.',
    es: 'Clave que --query no conoce: estado. Claves: status, mode, requires-approval, vendor, since, until, search.' },
  { key: 'ap.bill.inbox.run.query_keys_unknown', argv: [...RUN, '--bulk', '--query', 'estado=ready,modo=x'], where: 'error',
    en: 'Keys that --query does not know: estado, modo. Keys: status, mode, requires-approval, vendor, since, until, search.',
    es: 'Claves que --query no conoce: estado, modo. Claves: status, mode, requires-approval, vendor, since, until, search.' },
  { key: 'ap.bill.inbox.run.requires_approval_invalid', argv: [...RUN, '--bulk', '--query', 'requires-approval=quiza'], where: 'error',
    en: 'requires-approval only takes true or false; got "quiza".', es: 'requires-approval sólo admite true o false; llegó "quiza".' },
  { key: 'ap.bill.inbox.run.query_narrows_nothing', argv: [...RUN, '--bulk', '--query', 'status='], where: 'error',
    en: '--query "status=" narrows nothing. Name at least one criterion.', es: '--query "status=" no acota nada. Nombra al menos un criterio.' },
  { key: 'ap.bill.inbox.run.not_in_inbox', argv: [...RUN, ID], where: 'error',
    en: `Pre-registration ${ID} is not in the inbox of Entidad Sintetica SA.`, es: `El pre-registro ${ID} no está en la bandeja de Entidad Sintetica SA.` },
  { key: 'ap.bill.inbox.run.over_cap', argv: [...RUN, '--bulk', '--query', 'status=ready'], where: 'error',
    setup: () => { responder = inbox(Array.from({ length: 201 }, () => row())); },
    en: 'The selection goes over 200 pre-registrations. A batch bigger than that is not an order someone has reviewed: narrow it with --query (status, mode, since, until, vendor).',
    es: 'La selección pasa de 200 pre-registros. Un lote más grande que eso no es una orden que alguien haya revisado: acota con --query (status, mode, since, until, vendor).' },
  { key: 'ap.bill.inbox.run.query_selects_none', argv: [...RUN, '--bulk', '--query', 'status=ready'], where: 'err',
    en: 'The query "status=ready" selects no pre-registration. Nothing to do.\n', es: 'La consulta "status=ready" no selecciona ningún pre-registro. Nada que hacer.\n' },
  ...([1, 3] as const).map((n): Case => ({
    key: 'ap.bill.inbox.run.waiting', argv: [...RUN, '--bulk', '--query', 'status=ready'], where: 'err',
    setup: () => { responder = inbox([], { waiting: n }); },
    en: n === 1
      ? '  There is 1 pre-registration waiting for a human decision, which this query does not reach.\n'
      : '  There are 3 pre-registrations waiting for a human decision, which this query does not reach.\n',
    es: n === 1
      ? '  Hay 1 pre-registro esperando una decisión humana, que esta consulta no alcanza.\n'
      : '  Hay 3 pre-registros esperando una decisión humana, que esta consulta no alcanza.\n',
  })),
  { key: 'ap.bill.inbox.run.waiting_note', argv: [...RUN, '--bulk', '--query', 'status=ready'], where: 'err',
    setup: () => { responder = inbox([], { waiting: 1 }); },
    en: '  They are seen with `bill inbox list --status draft`, and there are the ones that stopped\n  because they came with a new vendor: repeat them with --query "status=draft".\n',
    es: '  Se ven con `bill inbox list --status draft`, y ahí están los que se pararon\n  por traer proveedor nuevo: repítelos con --query "status=draft".\n' },
  { key: 'ap.bill.inbox.run.batch_not_found', argv: [...RUN, ID, '--action', 'set-batch', '--batch', 'LOTE-8'], where: 'error',
    setup: () => { responder = inbox([row()], { batch: false }); },
    en: 'There is no processing batch "LOTE-8" in this entity.', es: 'No hay un lote de proceso "LOTE-8" en esta entidad.' },

  // ---- bill inbox run: the dry run, the question, the result ----
  ...(['ap.bill.inbox.run.summary', 'ap.bill.inbox.run.new_vendors', 'ap.bill.inbox.no_rfc', 'ap.bill.inbox.run.new_vendor_refused', 'ap.bill.dry_run'] as const).map((key, i): Case => ({
    key, argv: [...RUN, ID, '--dry-run'], where: 'err',
    setup: () => { responder = inbox([row({ vendor_name: null, is_new_vendor: true, emisor_rfc: null })]); },
    en: [
      '\nprocess: 1 pre-registration · 1160.00 MXN\n',
      '  1 would create a NEW VENDOR: Proveedor Sintetico SA (no RFC)\n',
      '(no RFC)',
      '  Without --allow-new-vendor they are refused one by one, with the reason, and the rest goes on.\n',
      'Dry run: nothing was written.\n',
    ][i],
    es: [
      '\nprocess: 1 pre-registro · 1160.00 MXN\n',
      '  1 crearía un PROVEEDOR NUEVO: Proveedor Sintetico SA (sin RFC)\n',
      '(sin RFC)',
      '  Sin --allow-new-vendor se rechazan uno a uno, con el motivo, y el resto sigue.\n',
      'Ensayo: no se escribió nada.\n',
    ][i],
  })),
  ...(['ap.bill.inbox.run.summary', 'ap.bill.inbox.run.already_posted', 'ap.bill.inbox.run.new_vendors', 'ap.bill.inbox.run.new_vendor_allowed'] as const).map((key, i): Case => ({
    key, argv: [...RUN, '--bulk', '--query', 'status=ready', '--dry-run', '--allow-new-vendor'], where: 'err',
    setup: () => {
      responder = inbox([
        row({ status: 'completed' }),
        row({ status: 'completed', vendor_name: null, is_new_vendor: true, suggested_vendor_name: 'Nuevo Sintetico SC' }),
        row({ vendor_name: null, is_new_vendor: true, currency_code: 'USD' }),
      ]);
    },
    en: [
      '\nprocess: 3 pre-registrations · 2320.00 MXN + 1160.00 USD\n',
      '  2 are already posted and will be skipped.\n',
      '  2 would create NEW VENDORS: Nuevo Sintetico SC (XAXX010101000); Proveedor Sintetico SA (XAXX010101000)\n',
      '  --allow-new-vendor is set: they will be created with the name and the RFC of the XML.\n',
    ][i],
    es: [
      '\nprocess: 3 pre-registros · 2320.00 MXN + 1160.00 USD\n',
      '  2 ya están contabilizados y se saltarán.\n',
      '  2 crearían un PROVEEDOR NUEVO: Nuevo Sintetico SC (XAXX010101000); Proveedor Sintetico SA (XAXX010101000)\n',
      '  --allow-new-vendor está puesto: se darán de alta con el nombre y el RFC del XML.\n',
    ][i],
  })),
  { key: 'ap.bill.inbox.run.already_posted', argv: [...RUN, ID, '--dry-run'], where: 'err',
    setup: () => { responder = inbox([row({ status: 'completed' })]); },
    en: '  1 is already posted and will be skipped.\n', es: '  1 ya está contabilizado y se saltará.\n' },
  { key: 'ap.bill.inbox.run.no_terminal', argv: [...RUN, ID], where: 'error', setup: () => { responder = inbox([row()]); },
    en: 'There is no terminal to confirm at. Re-run with --yes once you have decided, or with --dry-run to see what it would do.',
    es: 'No hay terminal donde confirmar. Re-ejecuta con --yes cuando lo tengas decidido, o con --dry-run para ver lo que haría.' },
  { key: 'ap.bill.inbox.run.confirm', argv: [...RUN, ID], where: 'asked', confirm: true,
    setup: () => { responder = inbox([row()]); processSpy.mockResolvedValue({}); },
    en: 'Post 1 pre-registration to the books of Entidad Sintetica SA? Each one is born as a POSTED bill with its entry. This cannot be undone.',
    es: '¿Contabilizar 1 pre-registro en los libros de Entidad Sintetica SA? Cada uno nace como factura POSTEADA con su póliza. Esto no se deshace.' },
  { key: 'ap.bill.inbox.run.confirm', argv: [...RUN, '--bulk', '--query', 'status=ready', '--action', 'approve'], where: 'asked', confirm: true,
    setup: () => { responder = inbox([row(), row()]); },
    en: 'Apply "approve" to 2 pre-registrations of Entidad Sintetica SA?', es: '¿Aplicar "approve" a 2 pre-registros de Entidad Sintetica SA?' },
  ...(['ap.bill.inbox.run.detail.bill', 'ap.bill.inbox.run.detail.entry', 'ap.bill.inbox.run.detail.payment', 'ap.bill.inbox.run.done'] as const).map((key, i): Case => ({
    key, argv: [...RUN, ID, '--yes'], where: 'out',
    setup: () => { responder = inbox([row()]); processSpy.mockResolvedValue({ bill: { bill_number: 'BILL-2026-00009' }, journalEntry: { entry_number: 'JE-2026-00043' }, paymentId: 'p1' }); },
    en: ['  bill BILL-2026-00009 ·', '· entry JE-2026-00043 ·', '· payment p1  ', '\n✔ process: 1 of 1\n'][i],
    es: ['  factura BILL-2026-00009 ·', '· póliza JE-2026-00043 ·', '· pago p1  ', '\n✔ process: 1 de 1\n'][i],
  })),
  { key: 'ap.bill.inbox.run.detail.posted', argv: [...RUN, ID, '--yes'], where: 'out',
    setup: () => { responder = inbox([row()]); processSpy.mockResolvedValue({}); },
    en: '  ok      posted  ', es: '  ok      contabilizado  ' },
  ...(['ap.bill.inbox.run.detail.already_posted', 'ap.bill.inbox.run.skipped', 'ap.bill.inbox.run.failed'] as const).map((key, i): Case => ({
    key, argv: [...RUN, '--bulk', '--query', 'status=ready', '--yes'], where: 'out',
    setup: () => { responder = inbox([row({ status: 'completed' }), row({ id: ROW2 })]); processSpy.mockRejectedValue(new Error('svc boom')); },
    en: ['  skipped  already posted  ', '\n! process: 0 of 2 · 1 already done', ' · 1 not done\n'][i],
    es: ['  skipped  ya estaba contabilizado  ', '\n! process: 0 de 2 · 1 ya estaba', ' · 1 sin hacer\n'][i],
  })),
  { key: 'ap.bill.inbox.run.vanished', argv: [...RUN, ID, '--yes'], where: 'out',
    setup: () => { responder = inbox([row()], { raw: null as never }); },
    en: '  error   it disappeared from the inbox while it was being processed  ', es: '  error   desapareció de la bandeja mientras se procesaba  ' },
  { key: 'ap.bill.inbox.run.not_a_bill', argv: [...RUN, ID, '--yes'], where: 'out',
    setup: () => { responder = inbox([row()], { raw: { document_type: 'payment' } }); },
    en: 'it is a pre-registration of type "payment", not a vendor bill nor its credit note. `bill inbox run` only posts expenses and the notes that lower them; an issued payment complement would record CUSTOMER RECEIPTS, which is not what this command says it does.',
    es: 'es un pre-registro de tipo "payment", no una factura de proveedor ni su nota de crédito. `bill inbox run` sólo contabiliza gastos y las notas que los bajan; un complemento de pago emitido registraría COBROS DE CLIENTES, que no es lo que este comando dice hacer.' },
  { key: 'ap.bill.inbox.run.type_unknown', argv: [...RUN, ID, '--yes'], where: 'out',
    setup: () => { responder = inbox([row()], { raw: { document_type: '' } }); },
    en: 'it is a pre-registration of type "unknown",', es: 'es un pre-registro de tipo "desconocido",' },
  { key: 'ap.bill.inbox.run.needs_approval', argv: [...RUN, ID, '--yes'], where: 'out',
    setup: () => { responder = inbox([row()], { raw: { requires_approval: true, approval_status: null } }); },
    en: 'it requires a prior approval and is at "pending". Approve it first: `bill inbox run <id> --action approve`.',
    es: 'requiere aprobación previa y está en "pending". Apruébalo primero: `bill inbox run <id> --action approve`.' },
  { key: 'ap.bill.inbox.run.detail.approved', argv: [...RUN, ID, '--action', 'approve'], where: 'out', setup: () => { responder = inbox([row()]); },
    en: '  ok      approved  ', es: '  ok      aprobado  ' },
  { key: 'ap.bill.inbox.run.not_pending', argv: [...RUN, ID, '--action', 'approve'], where: 'out', setup: () => { responder = inbox([row()], { update: 0 }); },
    en: 'it was not pending approval (or it needs no approval, or it was already rejected)',
    es: 'no estaba pendiente de aprobación (o no requiere aprobación, o ya se rechazó)' },
  { key: 'ap.bill.inbox.run.detail.rejected', argv: [...RUN, ID, '--action', 'reject', '--reason', 'otro RFC'], where: 'out', setup: () => { responder = inbox([row()]); },
    en: '  ok      rejected  ', es: '  ok      rechazado  ' },
  { key: 'ap.bill.inbox.run.not_rejectable', argv: [...RUN, ID, '--action', 'reject', '--reason', 'otro RFC'], where: 'out',
    setup: () => { responder = inbox([row()], { update: 0 }); },
    en: 'it is already posted or was already rejected: what is posted is not rejected, it is reversed',
    es: 'ya está contabilizado o ya estaba rechazado: lo contabilizado no se rechaza, se reversa' },
  { key: 'ap.bill.inbox.run.detail.scheduled', argv: [...RUN, ID, '--action', 'set-batch', '--batch', 'LOTE-7'], where: 'out',
    setup: () => { responder = inbox([row()]); }, en: '  ok      scheduled in batch B1  ', es: '  ok      programado en el lote B1  ' },
  { key: 'ap.bill.inbox.run.not_schedulable', argv: [...RUN, ID, '--action', 'set-batch', '--batch', 'LOTE-7'], where: 'out',
    setup: () => { responder = inbox([row()], { update: 0 }); },
    en: 'it is completed or rejected: it is no longer scheduled', es: 'está completado o rechazado: ya no se programa' },
  { key: 'ap.bill.inbox.run.idempotency_hit', argv: [...RUN, ID, '--action', 'approve', '--idempotency-key', 'k7'], where: 'err',
    setup: () => {
      responder = inbox([row()]);
      keyStore.repetido = true;
      keyStore.resultado = { action: 'approve', total: 1, ok: 1, skipped: 0, failed: 0, needsHuman: 0, results: [] };
    },
    en: '↩ Idempotency hit: key "k7" already completed this act — 1/1 approve\n  Nothing was executed again; this is the recorded result.\n',
    es: '↩ Idempotency hit: la llave "k7" ya completó este acto — 1/1 approve\n  No se ejecutó nada otra vez; éste es el resultado registrado.\n' },
];

describe('I8.8 · bill speaks by key', () => {
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
    const keys = Object.keys(EN).filter((k) => k.startsWith('ap.bill.'));
    expect(new Set(CASES.map((c) => c.key))).toEqual(new Set(keys));
  });

  it('bill void: no --reason is a usage error before anything is read; --json carries the receipt and no table', async () => {
    const bare = await run({ argv: ['bill', 'void', 'BILL-9', '--yes'], setup: voiding(MIRROR) }, 'en');
    expect(bare.code).toBe(2);
    expect(vi.mocked(resolveBill)).not.toHaveBeenCalled();
    const json = await run({ argv: [...VOID, '--yes', '--json'], setup: voiding(MIRROR) }, 'en');
    expect((JSON.parse(json.out) as { rows: unknown[] }).rows).toEqual([
      { bill: 'BILL-2026-00007', status: 'void', dry_run: false, mirror_entry: 'JE-2026-00043', mirror_date: '2026-07-31',
        mirror_posted: true, dated_by: 'void_date', mirror_lines: [] },
    ]);
    // The rehearsal first, then the act: the same service call, twice.
    expect(vi.mocked(voidBill).mock.calls.map((c) => c[2])).toEqual([
      { entityId: 'e1', reason: 'CFDI cancelled by the vendor', dryRun: true },
      { entityId: 'e1', reason: 'CFDI cancelled by the vendor', dryRun: false },
    ]);
  });

  it('the legacy tax= warning is resolved when called, in the active language', () => {
    expect(legacyTaxKeyWarning()).toMatch(/^tax= is the AMOUNT of the IVA of the line, not the rate/);
    setLanguage('es');
    expect(legacyTaxKeyWarning()).toMatch(/^tax= es el MONTO del IVA de la línea, no la tasa/);
  });

  it('--json keeps its shape and its codes; only the detail prose follows the language', async () => {
    const c = { argv: [...RUN, ID, '--action', 'approve', '--json'], setup: () => { responder = inbox([row()], { update: 0 }); } };
    const en = JSON.parse((await run(c, 'en')).out) as { rows: Array<{ results: Array<Record<string, string>> }> };
    const es = JSON.parse((await run(c, 'es')).out) as typeof en;
    const strip = (r: Record<string, string>) => ({ ...r, detail: undefined });
    expect(en.rows[0].results.map(strip)).toEqual(es.rows[0].results.map(strip));
    expect(en.rows[0].results[0]).toMatchObject({ ref: '11111111', status: 'error', id: ID });
    expect(en.rows[0].results[0].detail).toMatch(/^it was not pending approval/);
    expect(es.rows[0].results[0].detail).toMatch(/^no estaba pendiente de aprobación/);
  });
});
