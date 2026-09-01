import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../../database/connection.js';
import { NotFoundError, ValidationError, AccountingError } from '../../utils/errors.js';
import { registrarAuditoria } from '../audit/audit-log.js';
import { createJournalEntry } from './posting.js';
import { validateJournalEntry } from './validation.js';
import { resolveAccount } from './account-service.js';
import type {
  JournalEntry,
  JournalEntryLine,
  ValidationResult,
} from '../../types/index.js';
import { JournalEntryType } from '../../types/index.js';

// ============================================================
// JOURNAL ENTRIES — domain service (reads, drafting, validation)
//
// Extracted from the Express handlers (routes/journal-entries.ts) and
// from the agent's read-only tools (ai/tools/ledger-tools.ts), which had
// grown two different answers to the same question — the route could
// filter by source and period, the agent tool by text, account and
// amount, and neither could do the other's job. One implementation now
// serves the REST API, the CLI and the agent.
//
// The LIFECYCLE (post / reverse / void) is NOT re-implemented here: it
// lives in posting.ts, which owns every physical write to the ledger and
// the invariants that hang off it (one reversal per entry, posted entries
// are never mutated, balances move inside the posting transaction). This
// module only ever creates DRAFTS.
//
// Rules the database can otherwise only express as raw constraint
// failures are named here instead:
//   - fewer than two lines dies on the posting CHECK much later, so a
//     draft that can never balance is refused at the door (NIF A-2);
//   - a line with both or neither of debit/credit violates the
//     journal_entry_lines CHECK: refused with the line number;
//   - a non-positive amount violates the two amount CHECKs.
// ============================================================

/** entry_type values the table's CHECK accepts (001_core_schema.sql:222, 025_ledger_hardening.sql:71). */
export const ENTRY_TYPES = [
  'standard', 'adjusting', 'closing', 'reversing', 'correction',
  'auto_invoice', 'auto_bill', 'auto_payment', 'auto_depreciation',
  'auto_reconciliation', 'payroll',
] as const;

/** status values the table's CHECK accepts (001_core_schema.sql:237). */
export const ENTRY_STATUSES = [
  'draft', 'pending_approval', 'approved', 'posted', 'void',
] as const;

/**
 * Entry types a human may type by hand. The automated ones are produced by
 * the document, payroll and closing engines and are excluded from `create`
 * on purpose: they carry a source document, and hand-minting one would make
 * `entry audit-population` unable to tell manual work from machine work.
 */
export const MANUAL_ENTRY_TYPES = ['standard', 'adjusting', 'correction'] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AMOUNT_RE = /^\d+(\.\d{1,4})?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface JournalEntryFilters {
  fiscalPeriodId?: string;
  /** One state, or several: several become `= ANY(...)`. */
  status?: string | string[];
  entryType?: string | string[];
  /** Inclusive bounds on entry_date (YYYY-MM-DD). */
  startDate?: string;
  endDate?: string;
  sourceType?: string;
  /** Free text over description and reference. */
  search?: string;
  /** Only entries with a line on this account code. */
  accountCode?: string;
  minAmount?: string | number;
  maxAmount?: string | number;
  limit?: number;
  offset?: number;
}

export interface JournalEntryPage {
  rows: JournalEntry[];
  /** Total matching rows before limit/offset, so truncation is never silent. */
  total: number;
}

function buildWhere(entityId: string, f: JournalEntryFilters): { sql: string; params: unknown[]; next: number } {
  const where: string[] = ['je.entity_id = $1'];
  const params: unknown[] = [entityId];
  let i = 2;

  // The first six conditions keep the exact order the REST handler used, so
  // its generated SQL and parameter list are unchanged.
  if (f.fiscalPeriodId) {
    where.push(`je.fiscal_period_id = $${i++}`);
    params.push(f.fiscalPeriodId);
  }
  // Scalars are tested for TRUTH, not for `!== undefined`: the REST handler
  // used `if (status)`, so `?status=` (an empty value, which every form-driven
  // client sends for "no filter") meant NO filter. Testing `!== undefined`
  // here turned that into `status = ''`, i.e. zero rows.
  if (Array.isArray(f.status)) {
    where.push(`je.status = ANY($${i++})`);
    params.push(f.status);
  } else if (f.status) {
    where.push(`je.status = $${i++}`);
    params.push(f.status);
  }
  if (Array.isArray(f.entryType)) {
    where.push(`je.entry_type = ANY($${i++})`);
    params.push(f.entryType);
  } else if (f.entryType) {
    where.push(`je.entry_type = $${i++}`);
    params.push(f.entryType);
  }
  if (f.startDate) {
    where.push(`je.entry_date >= $${i++}`);
    params.push(f.startDate);
  }
  if (f.endDate) {
    where.push(`je.entry_date <= $${i++}`);
    params.push(f.endDate);
  }
  if (f.sourceType) {
    where.push(`je.source_type = $${i++}`);
    params.push(f.sourceType);
  }
  if (f.search) {
    where.push(`(je.description ILIKE $${i} OR je.reference ILIKE $${i})`);
    params.push(`%${f.search}%`);
    i++;
  }
  if (f.accountCode) {
    where.push(
      `EXISTS (SELECT 1 FROM journal_entry_lines jel
               JOIN accounts a ON a.id = jel.account_id
               WHERE jel.journal_entry_id = je.id AND a.code = $${i++} AND a.entity_id = je.entity_id)`
    );
    params.push(f.accountCode);
  }
  if (f.minAmount !== undefined) {
    where.push(`je.total_debits >= $${i++}`);
    params.push(String(f.minAmount));
  }
  if (f.maxAmount !== undefined) {
    where.push(`je.total_debits <= $${i++}`);
    params.push(String(f.maxAmount));
  }

  return { sql: `WHERE ${where.join(' AND ')}`, params, next: i };
}

export async function listJournalEntries(
  entityId: string,
  filters: JournalEntryFilters = {}
): Promise<JournalEntryPage> {
  const { sql: whereClause, params, next } = buildWhere(entityId, filters);

  const counted = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM journal_entries je ${whereClause}`,
    params
  );
  const total = parseInt(counted.rows[0].count, 10);

  const limit = filters.limit ?? total;
  const offset = filters.offset ?? 0;
  let i = next;
  const rows = await query<JournalEntry>(
    `SELECT je.* FROM journal_entries je ${whereClause}
     ORDER BY je.entry_date DESC, je.created_at DESC
     LIMIT $${i++} OFFSET $${i}`,
    [...params, limit, offset]
  );

  return { rows: rows.rows, total };
}

/** The bare header, unscoped — the caller checks access (the REST route does). */
export async function getJournalEntryById(id: string): Promise<JournalEntry | null> {
  const result = await query<JournalEntry>('SELECT * FROM journal_entries WHERE id = $1', [id]);
  return result.rows[0] ?? null;
}

export type JournalEntryLineWithAccount = JournalEntryLine & {
  account_code: string;
  account_name: string;
};

/** Lines with the account code and name people actually read. */
export async function listEntryLines(entryId: string): Promise<JournalEntryLineWithAccount[]> {
  const result = await query<JournalEntryLineWithAccount>(
    `SELECT jel.*, a.code as account_code, a.name as account_name
     FROM journal_entry_lines jel
     JOIN accounts a ON a.id = jel.account_id
     WHERE jel.journal_entry_id = $1
     ORDER BY jel.line_number`,
    [entryId]
  );
  return result.rows;
}

/**
 * Resolves what a person types — an entry number (JE-2026-00042) or a uuid —
 * inside one entity. Entry numbers are unique per entity (001:251).
 */
export async function resolveJournalEntry(entityId: string, ref: string): Promise<JournalEntry> {
  const trimmed = ref.trim();
  const result = UUID_RE.test(trimmed)
    ? await query<JournalEntry>(
        'SELECT * FROM journal_entries WHERE id = $1 AND entity_id = $2',
        [trimmed, entityId]
      )
    : await query<JournalEntry>(
        'SELECT * FROM journal_entries WHERE UPPER(entry_number) = UPPER($1) AND entity_id = $2',
        [trimmed, entityId]
      );

  if (result.rows.length === 0) throw new NotFoundError('Journal Entry', trimmed);
  return result.rows[0];
}

export type JournalEntryDetail = Omit<JournalEntry, 'lines'> & {
  lines: JournalEntryLineWithAccount[];
  reverses_entry_number: string | null;
  reversed_by_entry_number: string | null;
};

/** Header + lines + the entries linked to it in either direction. */
export async function getJournalEntryDetail(
  entityId: string,
  ref: string
): Promise<JournalEntryDetail> {
  const entry = await resolveJournalEntry(entityId, ref);
  const lines = await listEntryLines(entry.id);

  // Entity-scoped like every other read here. The two ids come from an entry
  // already scoped to this entity, so the extra predicate changes no result —
  // it keeps the invariant ("no query in this module reads across entities")
  // true by inspection rather than by an argument about foreign keys.
  const linked = await query<{ id: string; entry_number: string }>(
    `SELECT id, entry_number FROM journal_entries WHERE id = ANY($1) AND entity_id = $2`,
    [[entry.reverses_entry_id, entry.reversed_by_entry_id].filter(Boolean), entityId]
  );
  const numberOf = (id: string | null) =>
    id ? linked.rows.find((r) => r.id === id)?.entry_number ?? null : null;

  return {
    ...entry,
    lines,
    reverses_entry_number: numberOf(entry.reverses_entry_id),
    reversed_by_entry_number: numberOf(entry.reversed_by_entry_id),
  };
}

// ---- Drafting ------------------------------------------------------

/** One line as a caller states it: an account CODE, and one of the two sides. */
export interface DraftLineInput {
  account: string;
  debit?: string | null;
  credit?: string | null;
  description?: string;
}

export interface DraftEntryInput {
  entityId: string;
  createdBy: string;
  date: string;
  type?: string;
  description?: string;
  reference?: string;
  lines: DraftLineInput[];
}

/**
 * Checks what the CHECK constraints would otherwise reject much later, and
 * says which line is wrong. Pure: no database, so it is the same answer in
 * `entry create --dry-run`, in `entry check --file` and at write time.
 */
export function validateDraftShape(input: DraftEntryInput): void {
  // Checked here rather than at the flag: an agent-written --file document and
  // a hand-typed --date must fail the same way, and an Invalid Date reaches
  // Postgres as a type error nobody can read.
  if (!DATE_RE.test(input.date) || Number.isNaN(new Date(`${input.date}T00:00:00`).getTime())) {
    throw new ValidationError(`"${input.date}" is not a date as YYYY-MM-DD.`);
  }
  if (!Array.isArray(input.lines) || input.lines.length < 2) {
    throw new ValidationError(
      'A journal entry needs at least two lines: one debit and one credit ' +
        '[NIF A-2, dualidad económica].'
    );
  }
  if (input.type && !(MANUAL_ENTRY_TYPES as readonly string[]).includes(input.type)) {
    throw new ValidationError(
      `Entry type "${input.type}" is produced by an automated flow and cannot be typed by hand. ` +
        `Use one of: ${MANUAL_ENTRY_TYPES.join(', ')}.`
    );
  }

  input.lines.forEach((line, index) => {
    const n = index + 1;
    if (!line.account || !String(line.account).trim()) {
      throw new ValidationError(`Line ${n}: an account code is required.`);
    }
    const hasDebit = line.debit !== undefined && line.debit !== null && line.debit !== '';
    const hasCredit = line.credit !== undefined && line.credit !== null && line.credit !== '';
    if (hasDebit === hasCredit) {
      throw new ValidationError(
        `Line ${n}: exactly one of debit or credit is required, never both and never neither.`
      );
    }
    const amount = String(hasDebit ? line.debit : line.credit);
    if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) {
      throw new ValidationError(
        `Line ${n}: "${amount}" is not a positive amount. Write it as digits with up to four decimals, e.g. 1500.00.`
      );
    }
  });
}

/** Turns account CODES into the account ids the posting engine expects. */
export async function resolveDraftLines(
  entityId: string,
  lines: DraftLineInput[]
): Promise<Array<{ account_id: string; debit_amount: string | null; credit_amount: string | null; description: string }>> {
  const resolved = [];
  for (const line of lines) {
    const account = await resolveAccount(entityId, line.account);
    resolved.push({
      account_id: account.id,
      debit_amount: line.debit ? String(line.debit) : null,
      credit_amount: line.credit ? String(line.credit) : null,
      description: line.description ?? '',
    });
  }
  return resolved;
}

/**
 * Creates a journal entry that is ALWAYS a draft.
 *
 * This is deliberately not a thin alias for createJournalEntry: that function
 * takes an `autoPost` option, and the whole safety property of the CLI (and of
 * the agent that drives it) is that nothing but an explicit human `entry post`
 * moves an entry into the ledger. The option is not reachable from here, so no
 * caller of this function can post by passing one more argument.
 */
export async function createDraftEntry(input: DraftEntryInput): Promise<JournalEntry> {
  validateDraftShape(input);
  const lines = await resolveDraftLines(input.entityId, input.lines);

  return createJournalEntry(
    input.entityId,
    // LOCAL midnight, not UTC midnight: node-postgres serialises a Date with
    // the process's offset, so `2026-08-10T00:00:00Z` lands in the DATE column
    // as 2026-08-09 anywhere west of Greenwich — an entry silently booked into
    // the previous day, and occasionally into the previous PERIOD.
    new Date(`${input.date}T00:00:00`),
    (input.type ?? 'standard') as JournalEntryType,
    input.description ?? '',
    lines,
    input.createdBy,
    { reference: input.reference }
  );
}

// ---- Validation (the seven NIF rules), without writing anything -----

export interface EntryCheckResult extends ValidationResult {
  entry_number: string | null;
  entry_date: string;
  fiscal_period_id: string;
  period_name: string;
  period_status: string;
  line_count: number;
}

/** Runs the seven rules over an entry that already exists, posted or not. */
export async function checkExistingEntry(
  entityId: string,
  ref: string
): Promise<EntryCheckResult> {
  const entry = await resolveJournalEntry(entityId, ref);
  const lines = await listEntryLines(entry.id);
  const result = await validateJournalEntry(entry, lines);
  const period = await query<{ period_name: string; status: string }>(
    'SELECT period_name, status FROM fiscal_periods WHERE id = $1',
    [entry.fiscal_period_id]
  );

  return {
    ...result,
    entry_number: entry.entry_number,
    entry_date: String(entry.entry_date instanceof Date ? entry.entry_date.toISOString().slice(0, 10) : entry.entry_date),
    fiscal_period_id: entry.fiscal_period_id,
    period_name: period.rows[0]?.period_name ?? '',
    period_status: period.rows[0]?.status ?? '',
    line_count: lines.length,
  };
}

/**
 * Runs the same seven rules over an entry that does NOT exist yet, so a
 * document can be checked before anything is written. The fiscal period is
 * resolved by date with the same query createJournalEntry uses (posting.ts:89)
 * — otherwise the period rule would have nothing to judge and the answer here
 * would disagree with the answer at post time.
 */
export async function checkDraftDocument(
  input: DraftEntryInput
): Promise<EntryCheckResult> {
  validateDraftShape(input);

  const period = await query<{ id: string; period_name: string; status: string }>(
    `SELECT id, period_name, status FROM fiscal_periods
     WHERE entity_id = $1
     AND start_date <= $2 AND end_date >= $2
     AND status NOT IN ('hard_close', 'locked')
     ORDER BY period_number ASC LIMIT 1`,
    [input.entityId, input.date]
  );
  if (period.rows.length === 0) {
    throw new ValidationError(
      `No open fiscal period covers ${input.date}. Open it with \`mnemosine period open\`, ` +
        'or create the fiscal year with `mnemosine year create`.'
    );
  }

  const lines = await resolveDraftLines(input.entityId, input.lines);
  const syntheticEntry = {
    id: '00000000-0000-0000-0000-000000000000',
    entry_number: null,
    entry_type: (input.type ?? 'standard') as JournalEntryType,
    entity_id: input.entityId,
    fiscal_period_id: period.rows[0].id,
    description: input.description ?? '',
    status: 'draft',
  } as unknown as JournalEntry;

  const syntheticLines = lines.map((line, index) => ({
    line_number: index + 1,
    account_id: line.account_id,
    debit_amount: line.debit_amount,
    credit_amount: line.credit_amount,
    description: line.description,
    currency_code: null,
  })) as unknown as JournalEntryLine[];

  const result = await validateJournalEntry(syntheticEntry, syntheticLines);
  return {
    ...result,
    entry_number: null,
    entry_date: input.date,
    fiscal_period_id: period.rows[0].id,
    period_name: period.rows[0].period_name,
    period_status: period.rows[0].status,
    line_count: syntheticLines.length,
  };
}

// ---- Documents a person or an agent hands us ------------------------

/**
 * Parses the JSON entry document accepted by `--file`. Kept here rather than
 * in the CLI so the shape has one definition: the agent writes these files,
 * and a shape that drifts between the writer and the reader is a class of
 * silent data loss (a mistyped "lines" key becoming an empty entry).
 */
export function parseEntryDocument(raw: string): Omit<DraftEntryInput, 'entityId' | 'createdBy'> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ValidationError(`The entry document is not valid JSON: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('The entry document must be a JSON object with a "lines" array.');
  }
  const doc = parsed as Record<string, unknown>;

  const date = doc.date ?? doc.entry_date;
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    throw new ValidationError('The entry document needs a "date" as YYYY-MM-DD.');
  }
  if (!Array.isArray(doc.lines)) {
    throw new ValidationError('The entry document needs a "lines" array.');
  }

  const lines: DraftLineInput[] = doc.lines.map((line, index) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) {
      throw new ValidationError(`Line ${index + 1} of the document is not an object.`);
    }
    const l = line as Record<string, unknown>;
    const account = l.account ?? l.account_code ?? l.code;
    if (typeof account !== 'string') {
      throw new ValidationError(`Line ${index + 1}: "account" must be the account code, as a string.`);
    }
    const side = (value: unknown): string | undefined =>
      value === undefined || value === null || value === '' ? undefined : String(value);
    return {
      account,
      debit: side(l.debit ?? l.debit_amount),
      credit: side(l.credit ?? l.credit_amount),
      description: typeof l.description === 'string' ? l.description : undefined,
    };
  });

  return {
    date,
    type: typeof doc.type === 'string' ? doc.type : typeof doc.entry_type === 'string' ? doc.entry_type : undefined,
    description: typeof doc.description === 'string' ? doc.description : undefined,
    reference: typeof doc.reference === 'string' ? doc.reference : undefined,
    lines,
  };
}

/**
 * Parses a repeatable `--line <code>:<debit|credit>:<amount>[:description]`.
 * The description may contain colons; nothing else may.
 */
export function parseLineFlag(spec: string): DraftLineInput {
  const parts = spec.split(':');
  if (parts.length < 3) {
    throw new ValidationError(
      `--line "${spec}" is not in the form <account>:<debit|credit>:<amount>[:description].`
    );
  }
  const [account, sideRaw, amount, ...rest] = parts;
  const side = sideRaw.trim().toLowerCase();
  if (side !== 'debit' && side !== 'credit') {
    throw new ValidationError(
      `--line "${spec}": the side must be "debit" or "credit", not "${sideRaw}".`
    );
  }
  return {
    account: account.trim(),
    debit: side === 'debit' ? amount.trim() : undefined,
    credit: side === 'credit' ? amount.trim() : undefined,
    description: rest.length ? rest.join(':').trim() : undefined,
  };
}

// assertEntryBelongsTo VIVIÓ AQUÍ Y SE BORRA.
//
// Se escribió exactamente para esto y nunca tuvo un solo llamador en
// producción: sólo la exportaba services/accounting/index.ts y sólo la
// ejercitaban sus propias pruebas. Una frontera que nadie invoca no es una
// frontera, es documentación de una intención.
//
// Y su forma era la equivocada, la misma que database/scope.ts existe para
// sustituir: leía `WHERE id = $1` SIN ACOTAR y comparaba después, dejando
// ventana entre la comprobación y la escritura; y ramificaba —NotFoundError si
// no existía, ConflictError si era de otro—, con lo que la respuesta delataba
// la existencia de asientos ajenos aunque no dejara tocarlos. Justo el oráculo
// que el 404-siempre viene a cerrar.
//
// Quien la necesitaba ahora usa `requireByIdInScope('journal_entries', ...)`,
// que filtra dentro del SQL y no distingue los dos casos.

// ---- F01 · Preview, edición de borrador y exportación --------------

export interface DeltaPorCuenta {
  account_code: string;
  account_name: string;
  cargo: string;
  abono: string;
  saldo_antes: string;
  saldo_despues: string;
}

export interface EntryPreview {
  entry_number: string;
  status: string;
  period_name: string | null;
  deltas: DeltaPorCuenta[];
  advertencias: string[];
}

/**
 * El delta exacto de account_balances que produciría aplicar la póliza, en
 * SOLO LECTURA: la misma aritmética del upsert de postJournalEntry, calculada
 * fuera de toda transacción de escritura (nada de FOR UPDATE aquí — es un
 * espejo, no una reserva). Rechaza posted/void: no hay nada que previsualizar.
 */
export async function previewEntryPosting(entityId: string, ref: string): Promise<EntryPreview> {
  const entry = await resolveJournalEntry(entityId, ref);
  if (entry.status === 'posted') {
    throw new AccountingError('ALREADY_POSTED', `${entry.entry_number} ya está aplicada: no hay delta que previsualizar.`);
  }
  if (entry.status === 'void') {
    throw new AccountingError('ENTRY_VOID', `${entry.entry_number} está anulada y jamás se aplicará.`);
  }
  const lines = await listEntryLines(entry.id);

  const porCuenta = new Map<string, { code: string; name: string; d: Decimal; c: Decimal }>();
  for (const l of lines) {
    const acc = porCuenta.get(l.account_id) ?? {
      code: l.account_code, name: l.account_name, d: new Decimal(0), c: new Decimal(0),
    };
    acc.d = acc.d.plus(l.debit_amount ?? 0);
    acc.c = acc.c.plus(l.credit_amount ?? 0);
    porCuenta.set(l.account_id, acc);
  }

  const saldos = await query<{ account_id: string; ending: string }>(
    `SELECT account_id, ending_balance::text AS ending
       FROM account_balances
      WHERE fiscal_period_id = $1 AND account_id = ANY($2)`,
    [entry.fiscal_period_id, [...porCuenta.keys()]]
  );
  const endingDe = new Map(saldos.rows.map((r) => [r.account_id, r.ending]));

  const periodo = await query<{ period_name: string; status: string }>(
    `SELECT period_name, status FROM fiscal_periods WHERE id = $1 AND entity_id = $2`,
    [entry.fiscal_period_id, entityId]
  );

  const advertencias: string[] = [];
  const estadoPeriodo = periodo.rows[0]?.status;
  // La MISMA regla que bloquearPeriodoParaPostear: solo hard_close/locked
  // rechazan el posteo — avisar «fallará» sobre un periodo future sería
  // prometer un candado que el motor no tiene.
  if (estadoPeriodo === 'hard_close' || estadoPeriodo === 'locked') {
    advertencias.push(`el periodo está ${estadoPeriodo}: aplicar fallará`);
  }
  const totalD = [...porCuenta.values()].reduce((s, a) => s.plus(a.d), new Decimal(0));
  const totalC = [...porCuenta.values()].reduce((s, a) => s.plus(a.c), new Decimal(0));
  if (!totalD.equals(totalC)) {
    advertencias.push(`la póliza no cuadra (${totalD.toFixed(4)} vs ${totalC.toFixed(4)}): aplicar fallará`);
  }

  const deltas: DeltaPorCuenta[] = [...porCuenta.entries()]
    .map(([accountId, a]) => {
      const antes = new Decimal(endingDe.get(accountId) ?? 0);
      return {
        account_code: a.code,
        account_name: a.name,
        cargo: a.d.toFixed(4),
        abono: a.c.toFixed(4),
        saldo_antes: antes.toFixed(4),
        saldo_despues: antes.plus(a.d).minus(a.c).toFixed(4),
      };
    })
    .sort((x, y) => x.account_code.localeCompare(y.account_code));

  return {
    entry_number: entry.entry_number,
    status: entry.status,
    period_name: periodo.rows[0]?.period_name ?? null,
    deltas,
    advertencias,
  };
}

export interface DraftPatch {
  description?: string;
  reference?: string | null;
  notes?: string | null;
  /** Reemplaza TODAS las líneas (misma forma que el alta); undefined las deja. */
  lines?: DraftLineInput[];
  date?: string;
}

/**
 * Edita una póliza SOLO mientras es borrador. Una aplicada es inmutable (eso
 * lo sostiene el mayor, 041) y una pending_approval ya salió de las manos de
 * su autor: editarla invalidaría lo que el aprobador cree estar aprobando.
 * Las líneas se reemplazan enteras (DELETE + INSERT) y los totales los
 * recalcula el trigger update_je_totals — escribirlos a mano sería tener dos
 * relojes. La auditoría viaja EN LA MISMA transacción.
 */
export async function updateDraftEntry(
  entityId: string,
  ref: string,
  patch: DraftPatch,
  userId: string
): Promise<JournalEntry> {
  if (
    patch.description === undefined && patch.reference === undefined &&
    patch.notes === undefined && patch.lines === undefined && patch.date === undefined
  ) {
    throw new ValidationError('Nada que cambiar: pasa --description, --reference, --note, --date, --line o --file.');
  }
  if (patch.lines !== undefined) {
    // Solo la forma de fecha+líneas: entityId/createdBy no participan en la
    // validación pura y aquí aún no se conocen bajo el candado.
    validateDraftShape({
      entityId: '', createdBy: '',
      date: patch.date ?? '1970-01-01',
      lines: patch.lines,
    });
  }

  return withTransaction(async (client) => {
    const bloqueada = await client.query<JournalEntry>(
      `SELECT * FROM journal_entries WHERE entity_id = $1
        AND (id::text = $2 OR UPPER(entry_number) = UPPER($2))
        FOR UPDATE`,
      [entityId, ref.trim()]
    );
    if (bloqueada.rows.length === 0) {
      throw new AccountingError('ENTRY_NOT_FOUND', `Journal entry ${ref} not found`);
    }
    const entry = bloqueada.rows[0];
    if (entry.status === 'posted') {
      throw new AccountingError('ALREADY_POSTED', `${entry.entry_number} ya está aplicada: una póliza en el mayor es inmutable.`);
    }
    if (entry.status === 'void') {
      throw new AccountingError('ENTRY_VOID', `${entry.entry_number} está anulada.`);
    }
    if (entry.status !== 'draft') {
      throw new AccountingError(
        'ENTRY_NOT_EDITABLE',
        `${entry.entry_number} está en ${entry.status}: solo un borrador se edita.`
      );
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (patch.description !== undefined) { sets.push(`description = $${i++}`); params.push(patch.description); }
    if (patch.reference !== undefined) { sets.push(`reference = $${i++}`); params.push(patch.reference); }
    if (patch.notes !== undefined) { sets.push(`notes = $${i++}`); params.push(patch.notes); }
    if (patch.date !== undefined) {
      if (!DATE_RE.test(patch.date)) throw new ValidationError(`"${patch.date}" is not a date as YYYY-MM-DD.`);
      sets.push(`entry_date = $${i++}`);
      params.push(patch.date);
    }
    if (sets.length > 0) {
      // journal_entries no lleva updated_at (001): el rastro temporal de la
      // edición es la fila de auditoría de más abajo, no una columna.
      params.push(entry.id);
      await client.query(`UPDATE journal_entries SET ${sets.join(', ')} WHERE id = $${i}`, params);
    }

    if (patch.lines !== undefined) {
      const resueltas = await resolveDraftLines(entityId, patch.lines);
      await client.query('DELETE FROM journal_entry_lines WHERE journal_entry_id = $1', [entry.id]);
      for (const [idx, linea] of resueltas.entries()) {
        await client.query(
          `INSERT INTO journal_entry_lines (
            id, journal_entry_id, line_number, account_id, debit_amount, credit_amount, description
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [uuidv4(), entry.id, idx + 1, linea.account_id, linea.debit_amount, linea.credit_amount, linea.description]
        );
      }
    }

    // journal_entries no lleva tenant_id: el inquilino se resuelve por la
    // entidad, dentro de la MISMA transacción (el molde de posting.ts).
    const tenantRow = await client.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM legal_entities WHERE id = $1', [entityId]
    );
    await registrarAuditoria(client, {
      tenantId: tenantRow.rows[0].tenant_id,
      userId,
      action: 'update',
      entityType: 'journal_entries',
      entityId: entry.id,
      oldValues: { description: entry.description, reference: entry.reference },
      newValues: {
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.reference !== undefined ? { reference: patch.reference } : {}),
        ...(patch.lines !== undefined ? { lines_replaced: patch.lines.length } : {}),
        ...(patch.date !== undefined ? { entry_date: patch.date } : {}),
      },
    });

    const releida = await client.query<JournalEntry>('SELECT * FROM journal_entries WHERE id = $1', [entry.id]);
    return releida.rows[0];
  });
}

export interface FilaExportacion {
  entry_number: string;
  entry_date: string;
  entry_type: string;
  status: string;
  description: string;
  reference: string | null;
  line_number: number;
  account_code: string;
  account_name: string;
  debit_amount: string | null;
  credit_amount: string | null;
  line_description: string | null;
}

/**
 * Pólizas CON sus líneas en un solo JOIN, para exportar sin N+1 y sin el tope
 * de página del REST: la CLI llama al servicio y el servicio no pagina — la
 * verdad completa o el filtro que pidas.
 */
export async function listEntriesWithLines(
  entityId: string,
  filtros: { since?: string; until?: string; fiscalPeriodId?: string; status?: string } = {}
): Promise<FilaExportacion[]> {
  const cond: string[] = ['je.entity_id = $1'];
  const params: unknown[] = [entityId];
  let i = 2;
  if (filtros.since) { cond.push(`je.entry_date >= $${i++}`); params.push(filtros.since); }
  if (filtros.until) { cond.push(`je.entry_date <= $${i++}`); params.push(filtros.until); }
  if (filtros.fiscalPeriodId) { cond.push(`je.fiscal_period_id = $${i++}`); params.push(filtros.fiscalPeriodId); }
  if (filtros.status) { cond.push(`je.status = $${i++}`); params.push(filtros.status); }

  const result = await query<FilaExportacion>(
    `SELECT je.entry_number, je.entry_date::text AS entry_date, je.entry_type, je.status,
            je.description, je.reference,
            jel.line_number, a.code AS account_code, a.name AS account_name,
            jel.debit_amount::text AS debit_amount, jel.credit_amount::text AS credit_amount,
            jel.description AS line_description
       FROM journal_entries je
       JOIN journal_entry_lines jel ON jel.journal_entry_id = je.id
       JOIN accounts a ON a.id = jel.account_id
      WHERE ${cond.join(' AND ')}
      ORDER BY je.entry_date, je.entry_number, jel.line_number`,
    params
  );
  return result.rows;
}
