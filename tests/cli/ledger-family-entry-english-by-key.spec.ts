import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// ============================================================
// I8.9 · the ledger family speaks by key: entry's English (MNE-001-626, #271)
//
// The second part of MNE-001-230's split. `entry` printed its usage errors,
// refusals, questions, dry runs and receipts in English from the code, to
// every user. One row per key, through the real leaf over doubles (the
// services are mocked), in English (the test locale is en-US) and in es-MX.
// The English rows are the strings the code wrote at develop 4821e03b, byte
// for byte; the Spanish is new, with a singular and a plural where it counts.
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
vi.mock('../../src/services/policy/today.js', () => ({ todayFor: vi.fn(async () => '2026-08-01') }));
vi.mock('../../src/services/accounting/journal-entry-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  listJournalEntries: vi.fn(async () => ({ rows: [], total: 0 })),
  getJournalEntryDetail: vi.fn(),
  resolveJournalEntry: vi.fn(),
  createDraftEntry: vi.fn(),
  checkExistingEntry: vi.fn(),
  checkDraftDocument: vi.fn(),
}));
vi.mock('../../src/services/accounting/posting.js', () => ({
  postJournalEntry: vi.fn(async () => ({ entry_number: 'JE-0042', total_debits: '100.00', total_credits: '100.00' })),
  reverseJournalEntry: vi.fn(async () => ({ entry_number: 'JE-0043' })),
  voidJournalEntry: vi.fn(async () => ({ entry_number: 'JE-0042', status: 'void' })),
}));
const keyStore = { repetido: false, resultado: undefined as unknown };
vi.mock('../../src/services/idempotency/idempotency-store.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  conLlave: vi.fn(async (_c: unknown, _k: unknown, fn: () => Promise<unknown>) =>
    keyStore.repetido ? { repetido: true, resultado: keyStore.resultado } : { repetido: false, resultado: await fn() }),
}));

import { registerEntryCommand } from '../../src/cli/entry-command.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import {
  checkDraftDocument,
  checkExistingEntry,
  createDraftEntry,
  getJournalEntryDetail,
  resolveJournalEntry,
} from '../../src/services/accounting/journal-entry-service.js';
import { postJournalEntry } from '../../src/services/accounting/posting.js';

type Localized = Error & { localized?: (l?: 'es' | 'en') => string; key?: string; params?: Record<string, unknown> };
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

const verdict = (over: Record<string, unknown> = {}) => ({
  entry_number: 'JE-0042', entry_date: '2026-07-31', fiscal_period_id: 'P7',
  period_name: 'July 2026', period_status: 'open', line_count: 2,
  isValid: true, errors: [] as string[], warnings: [] as string[],
  ...over,
});
const drafting = (over: Record<string, unknown> = {}) => () => {
  vi.mocked(checkDraftDocument).mockResolvedValue(verdict({ entry_number: null, ...over }) as never);
};
const checked = (over: Record<string, unknown> = {}) => () => {
  vi.mocked(checkExistingEntry).mockResolvedValue(verdict(over) as never);
};
const created = () => {
  vi.mocked(createDraftEntry).mockResolvedValue({ entry_number: 'JE-0042', total_debits: '100.00', total_credits: '100.00' } as never);
};
const target = (over: Record<string, unknown> = {}) => () => {
  vi.mocked(resolveJournalEntry).mockResolvedValue({
    id: 'J42', entry_number: 'JE-0042', status: 'draft', posted_date: null,
    total_debits: '100.00', total_credits: '100.00', reversed_by_entry_id: null,
    ...over,
  } as never);
  checked()();
};
const posted = (over: Record<string, unknown> = {}) => target({ status: 'posted', posted_date: '2026-07-31', ...over });
const detailed = (over: Record<string, unknown> = {}) => () => {
  posted()();
  vi.mocked(getJournalEntryDetail).mockResolvedValue({
    id: 'J42', entry_number: 'JE-0042', entry_date: '2026-07-31', entry_type: 'standard', status: 'posted',
    description: 'Renta de julio', reference: null, total_debits: '100.00', total_credits: '100.00',
    posted_date: null, is_reversal: false, reverses_entry_number: null, reversed_by_entry_number: null,
    notes: null, lines: [],
    ...over,
  } as never);
};
const repeated = (recorded: Record<string, unknown>, setup: () => void) => () => {
  setup();
  keyStore.repetido = true;
  keyStore.resultado = recorded;
};

type Where = 'error' | 'out' | 'err';
type Case = {
  key: string; argv: string[]; setup?: () => void; noEntity?: boolean;
  where: Where; en: string; es: string; prefix?: boolean;
};

async function run(c: Pick<Case, 'argv' | 'setup' | 'noEntity'>, lang: 'en' | 'es') {
  vi.clearAllMocks();
  keyStore.repetido = false;
  (process.stdin as { isTTY?: boolean }).isTTY = false;
  c.setup?.();
  if (lang === 'es') setLanguage('es');
  out = '';
  err = '';
  resetDeclarations();
  const state: { code?: number; error?: Localized } = {};
  const cli = new Command('mnemosine').exitOverride();
  registerEntryCommand(cli, {
    palette,
    home: '/tmp/mnemosine-tests-no-home',
    shutdown: (code: number) => { state.code = code; },
    reportError: (e: unknown) => { state.error = e as Localized; },
  });
  await cli.parseAsync(['node', 'mnemosine', ...c.argv, ...(c.noEntity ? [] : ['-e', 'E1'])]);
  return {
    code: state.code,
    raw: state.error,
    error: state.error?.localized ? state.error.localized() : (state.error?.message ?? ''),
    out,
    err,
  };
}

const TWO_LINES = ['--line', 'account=6120;debit=100.00', '--line', 'account=2110;credit=100.00'];
const REASON = ['--reason', 'Cuenta equivocada'];
const NO_TERMINAL_EN = ' — there is no terminal to ask on. Re-run with --yes once you are sure, or with --dry-run to see the effect first.';
const NO_TERMINAL_ES = ' — no hay terminal donde preguntar. Vuelve a correrlo con --yes cuando estés seguro, o con --dry-run para ver antes el efecto.';
const VOID_POSTED_EN =
  'JE-0042 is posted, so it will NOT change state: a linked mirror entry is created and posted, which is how a posted entry is annulled without making the trial balance disagree with the balances.';
const VOID_POSTED_ES =
  'JE-0042 está contabilizada, así que NO cambiará de estado: se crea y se contabiliza una póliza espejo ligada, que es como se anula una póliza contabilizada sin que la balanza de comprobación discrepe de los saldos.';
const VOID_DRAFT_EN = "JE-0042 is 'draft' and never reached the ledger, so it is marked void. Its number is kept and never reused.";
const VOID_DRAFT_ES = "JE-0042 está 'draft' y nunca llegó al mayor, así que se marca anulada. Su número se conserva y nunca se reutiliza.";

const CASES: Case[] = [
  // ---- --line, shared by create and edit ----
  { key: 'ledger.entry.line.no_account', argv: ['entry', 'create', '--line', 'debit=100.00'], where: 'error',
    en: 'Line "debit=100.00" has no account=<code>.', es: 'La línea "debit=100.00" no tiene account=<código>.' },
  { key: 'ledger.entry.line.one_side', argv: ['entry', 'create', '--line', 'account=6120'], where: 'error',
    en: 'Line "account=6120" needs exactly one of debit=<amount> or credit=<amount> (cargo=/abono=).',
    es: 'La línea "account=6120" necesita exactamente uno de debit=<importe> o credit=<importe> (cargo=/abono=).' },

  // ---- the notes every write shares ----
  { key: 'ledger.period.active_entity', argv: ['entry', 'create', ...TWO_LINES], where: 'err', noEntity: true, setup: created,
    en: '  → Entidad Sintetica SA (active entity; name another with --entity)\n',
    es: '  → Entidad Sintetica SA (entidad activa; nombra otra con --entity)\n' },
  { key: 'ledger.entry.idempotency_hit', argv: ['entry', 'post', 'JE-0042', '--yes', '--idempotency-key', 'K1'], where: 'err',
    setup: repeated({ entry_number: 'JE-0042', total_debits: '100.00' }, target()),
    en: '↩ Idempotency hit: key "K1" already completed this act — JE-0042 posted (100.00)\n  Nothing was executed again; this is the recorded result.\n',
    es: '↩ Idempotency hit: la llave "K1" ya consumó este acto — JE-0042 contabilizada (100.00)\n  Nada se ejecutó otra vez; esto es el resultado grabado.\n' },
  { key: 'ap.payment.confirm.no_terminal', argv: ['entry', 'post', 'JE-0042'], where: 'error', setup: target(),
    en: `Post JE-0042 (100.00) to the ledger? This cannot be undone.${NO_TERMINAL_EN}`,
    es: `¿Contabilizar JE-0042 (100.00) en el mayor? Esto no se puede deshacer.${NO_TERMINAL_ES}` },

  // ---- entry list ----
  { key: 'ledger.entry.list.as_of_unsupported', argv: ['entry', 'list', '--as-of', '2026-07-31'], where: 'error',
    en: '`entry list` filters a date RANGE: use --since and --until, not --as-of.',
    es: '`entry list` filtra un RANGO de fechas: usa --since y --until, no --as-of.' },
  { key: 'ledger.entry.list.date_basis_unavailable', argv: ['entry', 'list', '--date-basis', 'document'], where: 'error',
    en: '--date-basis document is not available: journal_entries stores one date (entry_date, the ledger date). Only --date-basis posting is supported.',
    es: '--date-basis document no está disponible: journal_entries guarda una sola fecha (entry_date, la fecha contable). Sólo se admite --date-basis posting.' },
  { key: 'ledger.period.status_unknown', argv: ['entry', 'list', '--status', 'borrador'], where: 'error',
    en: 'Unknown --status "borrador". Use one of: draft, pending_approval, approved, posted, void.',
    es: '--status "borrador" desconocido. Usa uno de: draft, pending_approval, approved, posted, void.' },
  { key: 'ledger.account.type_unknown', argv: ['entry', 'list', '--type', 'ajuste'], where: 'error',
    en: 'Unknown --type "ajuste". Use one of: standard, adjusting, closing, reversing, correction, auto_invoice, auto_bill, auto_payment, auto_depreciation, auto_reconciliation, payroll.',
    es: '--type "ajuste" no existe. Usa uno de: standard, adjusting, closing, reversing, correction, auto_invoice, auto_bill, auto_payment, auto_depreciation, auto_reconciliation, payroll.' },

  // ---- entry show: the card ----
  { key: 'ledger.entry.show.reference', argv: ['entry', 'show', 'JE-0042'], where: 'out', setup: detailed({ reference: 'ARR-11' }),
    en: '  reference: ARR-11\n', es: '  referencia: ARR-11\n' },
  { key: 'ledger.entry.show.reverses', argv: ['entry', 'show', 'JE-0042'], where: 'out', setup: detailed({ reverses_entry_number: 'JE-0040' }),
    en: '  reverses: JE-0040\n', es: '  reversa a: JE-0040\n' },
  { key: 'ledger.entry.show.reversed_by', argv: ['entry', 'show', 'JE-0042'], where: 'out', setup: detailed({ reversed_by_entry_number: 'JE-0043' }),
    en: '  reversed by: JE-0043 (this entry is annulled)\n', es: '  reversada por: JE-0043 (esta póliza está anulada)\n' },
  { key: 'ledger.entry.show.totals', argv: ['entry', 'show', 'JE-0042'], where: 'out', setup: detailed(),
    en: '  totals: 100.00 debit / 100.00 credit\n\n', es: '  totales: 100.00 cargos / 100.00 abonos\n\n' },

  // ---- entry create and edit ----
  { key: 'ledger.entry.lines_or_file', argv: ['entry', 'create', ...TWO_LINES, '--file', 'poliza.json'], where: 'error',
    en: 'Pass either --line flags or a --file document, not both.', es: 'Pasa banderas --line o un documento --file, no ambos.' },
  { key: 'ledger.entry.lines_or_file', argv: ['entry', 'edit', 'JE-0042', ...TWO_LINES, '--file', 'poliza.json'], where: 'error',
    en: 'Pass either --line flags or a --file document, not both.', es: 'Pasa banderas --line o un documento --file, no ambos.' },
  { key: 'ledger.entry.create.nothing_to_record', argv: ['entry', 'create'], where: 'error',
    en: 'Nothing to record. Give the lines with --line "account=<code>;debit=<amount>" (repeat it), or a JSON document with --file.',
    es: 'Nada que registrar. Da las líneas con --line "account=<código>;debit=<importe>" (repítela), o un documento JSON con --file.' },
  { key: 'ledger.entry.create.drafted', argv: ['entry', 'create', ...TWO_LINES], where: 'out', setup: created,
    en: '✔ JE-0042 drafted (2 lines, 100.00 / 100.00)\n', es: '✔ JE-0042 creada como borrador (2 líneas, 100.00 / 100.00)\n' },
  // English printed «1 lines» before, and the acceptance keeps it byte for byte.
  { key: 'ledger.entry.create.drafted_detail', argv: ['entry', 'create', '--line', 'account=6120;debit=100.00'], where: 'out', setup: created,
    en: '(1 lines, 100.00 / 100.00)\n', es: '(1 línea, 100.00 / 100.00)\n' },
  { key: 'ledger.entry.create.drafted_detail', argv: ['entry', 'create', ...TWO_LINES], where: 'out', setup: created,
    en: '(2 lines, 100.00 / 100.00)\n', es: '(2 líneas, 100.00 / 100.00)\n' },
  { key: 'ledger.entry.create.not_posted', argv: ['entry', 'create', ...TWO_LINES], where: 'out', setup: created,
    en: '  Nothing moved in the ledger. Post it with: mnemosine entry post JE-0042\n',
    es: '  Nada se movió en el mayor. Contabilízala con: mnemosine entry post JE-0042\n' },

  // ---- the verdict printCheck writes for create, check and post ----
  { key: 'ledger.entry.verdict.would_draft', argv: ['entry', 'create', ...TWO_LINES, '--dry-run'], where: 'out', setup: drafting(),
    en: '\nWould draft: (new entry)  ', es: '\nCrearía el borrador: (póliza nueva)  ' },
  { key: 'ledger.entry.verdict.new_entry', argv: ['entry', 'create', ...TWO_LINES, '--dry-run'], where: 'out', setup: drafting(),
    en: ': (new entry)', es: ': (póliza nueva)' },
  { key: 'ledger.entry.verdict.context', argv: ['entry', 'create', ...TWO_LINES, '--dry-run'], where: 'out', setup: drafting(),
    en: '  2026-07-31 · July 2026 (open) · 2 lines\n\n', es: '  2026-07-31 · July 2026 (open) · 2 líneas\n\n' },
  { key: 'ledger.entry.verdict.context', argv: ['entry', 'check', '--entry', 'JE-0042'], where: 'out', setup: checked({ line_count: 1 }),
    en: '  2026-07-31 · July 2026 (open) · 1 lines\n\n', es: '  2026-07-31 · July 2026 (open) · 1 línea\n\n' },
  { key: 'ledger.entry.verdict.all_rules_pass', argv: ['entry', 'create', ...TWO_LINES, '--dry-run'], where: 'out', setup: drafting(),
    en: '  ✔ All seven rules pass.\n\n', es: '  ✔ Pasan las siete reglas.\n\n' },
  { key: 'ledger.entry.verdict.checked', argv: ['entry', 'check', '--entry', 'JE-0042'], where: 'out', setup: checked(),
    en: '\nChecked: JE-0042  ', es: '\nVerificada: JE-0042  ' },
  { key: 'ledger.entry.verdict.no_blocking', argv: ['entry', 'check', '--entry', 'JE-0042'], where: 'out', setup: checked({ warnings: ['Sin referencia'] }),
    en: '  ! Sin referencia\n  ✔ No blocking errors.\n\n', es: '  ! Sin referencia\n  ✔ Sin errores bloqueantes.\n\n' },

  // ---- entry check ----
  { key: 'ledger.entry.check.nothing_to_check', argv: ['entry', 'check'], where: 'error',
    en: 'Nothing to check: pass --entry <number> or --file <path>.', es: 'Nada que verificar: pasa --entry <número> o --file <ruta>.' },
  { key: 'ledger.entry.check.one_at_a_time', argv: ['entry', 'check', '--entry', 'JE-0042', '--file', 'poliza.json'], where: 'error',
    en: 'Check one thing at a time: --entry or --file, not both.', es: 'Verifica una cosa a la vez: --entry o --file, no ambos.' },

  // ---- entry post ----
  { key: 'ledger.entry.post.already_posted', argv: ['entry', 'post', 'JE-0042', '--yes'], where: 'error', setup: posted(),
    en: 'JE-0042 is already posted (2026-07-31). Correct it with `entry reverse`, which leaves an audit trail.',
    es: 'JE-0042 ya está contabilizada (2026-07-31). Corrígela con `entry reverse`, que deja rastro de auditoría.' },
  { key: 'ledger.entry.post.void', argv: ['entry', 'post', 'JE-0042', '--yes'], where: 'error', setup: target({ status: 'void' }),
    en: 'JE-0042 is void and can never be posted.', es: 'JE-0042 está anulada y nunca podrá contabilizarse.' },
  { key: 'ledger.entry.verdict.would_post', argv: ['entry', 'post', 'JE-0042', '--dry-run'], where: 'out', setup: target(),
    en: '\nWould post: JE-0042  ', es: '\nContabilizaría: JE-0042  ' },
  { key: 'ledger.entry.verdict.cannot_post', argv: ['entry', 'post', 'JE-0042', '--yes'], where: 'out',
    setup: () => { target()(); checked({ isValid: false, errors: ['Descuadre de 1.00'] })(); },
    en: '\nCannot post: JE-0042  ', es: '\nNo se puede contabilizar: JE-0042  ' },
  { key: 'ledger.entry.post.invalid', argv: ['entry', 'post', 'JE-0042', '--yes'], where: 'error',
    setup: () => { target()(); checked({ isValid: false, errors: ['Descuadre de 1.00'] })(); },
    en: 'JE-0042 does not pass validation, so it was not posted.', es: 'JE-0042 no pasa la validación, así que no se contabilizó.' },
  { key: 'ledger.entry.post.question', argv: ['entry', 'post', 'JE-0042'], where: 'error', setup: target(), prefix: true,
    en: 'Post JE-0042 (100.00) to the ledger? This cannot be undone. — ', es: '¿Contabilizar JE-0042 (100.00) en el mayor? Esto no se puede deshacer. — ' },
  { key: 'ledger.entry.post.recorded', argv: ['entry', 'post', 'JE-0042', '--yes'], where: 'out', setup: target(),
    en: '✔ JE-0042 posted (100.00 / 100.00)\n', es: '✔ JE-0042 contabilizada (100.00 / 100.00)\n' },

  // ---- entry reverse ----
  { key: 'ledger.entry.reverse.not_posted', argv: ['entry', 'reverse', 'JE-0042', ...REASON, '--yes'], where: 'error', setup: target(),
    en: "JE-0042 is 'draft' and never touched the ledger, so there is nothing to mirror. Use `entry void` on a draft.",
    es: "JE-0042 está 'draft' y nunca tocó el mayor, así que no hay nada que reflejar. Usa `entry void` sobre un borrador." },
  { key: 'ledger.entry.reverse.already_reversed', argv: ['entry', 'reverse', 'JE-0042', ...REASON, '--yes'], where: 'error',
    setup: posted({ reversed_by_entry_id: 'J43' }),
    en: 'JE-0042 already has a reversal. A second mirror would double the correction.',
    es: 'JE-0042 ya tiene una reversa. Un segundo espejo duplicaría la corrección.' },
  { key: 'ledger.entry.reverse.would_mirror', argv: ['entry', 'reverse', 'JE-0042', ...REASON, '--dry-run'], where: 'out', setup: detailed(),
    en: '\nWould create the mirror of JE-0042 ', es: '\nCrearía el espejo de JE-0042 ' },
  { key: 'ledger.entry.reverse.would_mirror_detail', argv: ['entry', 'reverse', 'JE-0042', ...REASON, '--dry-run'], where: 'out', setup: detailed(),
    en: ' dated 2026-08-01, posted immediately\n\n', es: ' con fecha 2026-08-01, contabilizado de inmediato\n\n' },
  { key: 'ledger.entry.reverse.would_mirror_detail', argv: ['entry', 'reverse', 'JE-0042', ...REASON, '--date', '2026-07-31', '--dry-run'], where: 'out',
    setup: detailed(), en: ' dated 2026-07-31, posted immediately\n\n', es: ' con fecha 2026-07-31, contabilizado de inmediato\n\n' },
  { key: 'ledger.entry.reverse.stays_posted', argv: ['entry', 'reverse', 'JE-0042', ...REASON, '--dry-run'], where: 'out', setup: detailed(),
    en: '\n  JE-0042 stays posted and unchanged; the two are linked.\n',
    es: '\n  JE-0042 sigue contabilizada y sin cambios; las dos quedan ligadas.\n' },
  { key: 'ledger.entry.reverse.question', argv: ['entry', 'reverse', 'JE-0042', ...REASON], where: 'error', setup: posted(),
    en: `Reverse JE-0042 (100.00)? The mirror posts immediately.${NO_TERMINAL_EN}`,
    es: `¿Reversar JE-0042 (100.00)? El espejo se contabiliza de inmediato.${NO_TERMINAL_ES}` },
  { key: 'ledger.entry.reverse.recorded', argv: ['entry', 'reverse', 'JE-0042', ...REASON, '--yes'], where: 'out', setup: posted(),
    en: '✔ JE-0043 posted as the reversal of JE-0042.\n', es: '✔ JE-0043 contabilizada como reversa de JE-0042.\n' },
  { key: 'ledger.entry.reverse.recorded', argv: ['entry', 'reverse', 'JE-0042', ...REASON, '--yes', '--idempotency-key', 'K1'], where: 'err',
    setup: repeated({ entry_number: 'JE-0043', reversal_of: 'JE-0042' }, posted()),
    en: '— JE-0043 posted as the reversal of JE-0042\n', es: '— JE-0043 contabilizada como reversa de JE-0042\n' },
  { key: 'ledger.entry.reverse.linked', argv: ['entry', 'reverse', 'JE-0042', ...REASON, '--yes'], where: 'out', setup: posted(),
    en: '\n  JE-0042 is unchanged and now linked to its mirror.\n', es: '\n  JE-0042 queda sin cambios y ahora ligada a su espejo.\n' },

  // ---- entry void ----
  { key: 'ledger.entry.void.already_void', argv: ['entry', 'void', 'JE-0042', ...REASON, '--yes'], where: 'error', setup: target({ status: 'void' }),
    en: 'JE-0042 is already void.', es: 'JE-0042 ya está anulada.' },
  { key: 'ledger.entry.void.already_reversed', argv: ['entry', 'void', 'JE-0042', ...REASON, '--yes'], where: 'error',
    setup: posted({ reversed_by_entry_id: 'J43' }),
    en: 'JE-0042 was already annulled by its reversal. A second one would double the correction.',
    es: 'JE-0042 ya quedó anulada por su reversa. Una segunda duplicaría la corrección.' },
  { key: 'ledger.entry.void.would_void', argv: ['entry', 'void', 'JE-0042', ...REASON, '--dry-run'], where: 'out', setup: target(),
    en: '\nWould void JE-0042\n', es: '\nAnularía JE-0042\n' },
  { key: 'ledger.entry.void.effect_posted', argv: ['entry', 'void', 'JE-0042', ...REASON, '--dry-run'], where: 'out', setup: posted(),
    en: `\n  ${VOID_POSTED_EN}\n\n`, es: `\n  ${VOID_POSTED_ES}\n\n` },
  { key: 'ledger.entry.void.effect_draft', argv: ['entry', 'void', 'JE-0042', ...REASON, '--dry-run'], where: 'out', setup: target(),
    en: `\n  ${VOID_DRAFT_EN}\n\n`, es: `\n  ${VOID_DRAFT_ES}\n\n` },
  { key: 'ledger.entry.void.question', argv: ['entry', 'void', 'JE-0042', ...REASON], where: 'error', setup: target(),
    en: `Void JE-0042 (100.00)?${NO_TERMINAL_EN}`, es: `¿Anular JE-0042 (100.00)?${NO_TERMINAL_ES}` },
  { key: 'ledger.entry.void.recorded', argv: ['entry', 'void', 'JE-0042', ...REASON, '--yes'], where: 'out', setup: target(),
    en: `✔ JE-0042 annulled (now 'void')\n  ${VOID_DRAFT_EN}\n`, es: `✔ JE-0042 anulada (ahora 'void')\n  ${VOID_DRAFT_ES}\n` },
  { key: 'ledger.entry.void.state', argv: ['entry', 'void', 'JE-0042', ...REASON, '--yes', '--idempotency-key', 'K1'], where: 'err',
    setup: repeated({ entry_number: 'JE-0042', status: 'void' }, target()),
    en: "— JE-0042 annulled (now 'void')\n", es: "— JE-0042 anulada (ahora 'void')\n" },
];

describe("I8.9 · entry's English speaks by key (MNE-001-626)", () => {
  describe.each(['en', 'es'] as const)('%s', (lang) => {
    it.each(CASES.map((c) => [c.key, c] as const))('%s', async (_key, c) => {
      const seen = await run(c, lang);
      const want = lang === 'en' ? c.en : c.es;
      if (c.where === 'error' && !c.prefix) expect(seen.error).toBe(want);
      else expect(seen[c.where]).toContain(want);
    });
  });

  it("every entry key outside 230's part has a row, and every row names a key of the catalogue", async () => {
    const { EN } = await import('../../src/i18n/en.js');
    // 230's spec owns preview, edit, export and import (MNE-001-230).
    const ours = /^ledger\.entry\.(?!(preview|edit|export|import)\.)/;
    const keys = Object.keys(EN).filter((k) => ours.test(k));
    expect(keys.length).toBeGreaterThan(0);
    expect(new Set(CASES.map((c) => c.key).filter((k) => ours.test(k)))).toEqual(new Set(keys));
    for (const c of CASES) expect(EN, c.key).toHaveProperty([c.key]);
  });

  it('a refusal keeps its message and params in English under es-MX, so the --json error envelope does not change', async () => {
    const seen = await run({ argv: ['entry', 'post', 'JE-0042'], setup: target() }, 'es');
    expect(seen.code).toBe(10);
    expect(seen.raw?.key).toBe('ap.payment.confirm.no_terminal');
    expect(seen.raw?.message).toBe(`Post JE-0042 (100.00) to the ledger? This cannot be undone.${NO_TERMINAL_EN}`);
    expect(seen.raw?.params).toEqual({ question: 'Post JE-0042 (100.00) to the ledger? This cannot be undone.' });
    expect(postJournalEntry).not.toHaveBeenCalled();
  });

  it('the exit codes stay as they were: usage 2, validation 4, blocked 5, aborted 10', async () => {
    expect((await run({ argv: ['entry', 'check'] }, 'es')).code).toBe(2);
    expect((await run({ argv: ['entry', 'post', 'JE-0042', '--yes'], setup: posted() }, 'es')).code).toBe(5);
    const invalid = await run({
      argv: ['entry', 'post', 'JE-0042', '--yes'],
      setup: () => { target()(); checked({ isValid: false, errors: ['Descuadre de 1.00'] })(); },
    }, 'es');
    expect(invalid.code).toBe(4);
    expect((invalid.raw as unknown as { detail?: unknown }).detail).toEqual({ errors: ['Descuadre de 1.00'] });
  });
});
