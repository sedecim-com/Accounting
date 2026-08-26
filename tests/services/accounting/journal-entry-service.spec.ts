import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/services/accounting/posting.js', () => ({ createJournalEntry: vi.fn() }));
vi.mock('../../../src/services/accounting/validation.js', () => ({ validateJournalEntry: vi.fn() }));

import {
  listJournalEntries,
  resolveJournalEntry,
  listEntryLines,
  getJournalEntryDetail,
  createDraftEntry,
  checkExistingEntry,
  checkDraftDocument,
  validateDraftShape,
  parseEntryDocument,
  parseLineFlag,
  assertEntryBelongsTo,
} from '../../../src/services/accounting/journal-entry-service.js';
import { query } from '../../../src/database/connection.js';
import { createJournalEntry } from '../../../src/services/accounting/posting.js';
import { validateJournalEntry } from '../../../src/services/accounting/validation.js';
import { NotFoundError, ValidationError, ConflictError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockCreate = createJournalEntry as unknown as ReturnType<typeof vi.fn>;
const mockValidate = validateJournalEntry as unknown as ReturnType<typeof vi.fn>;

const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER = 'user-1';

beforeEach(() => {
  mockQuery.mockReset();
  mockCreate.mockReset();
  mockValidate.mockReset();
  mockValidate.mockResolvedValue({ isValid: true, errors: [], warnings: [] });
});

const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');
const params = (call: number) => mockQuery.mock.calls[call][1];

describe('listJournalEntries', () => {
  it('reports the true total so truncation is never silent', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '317' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ entry_number: 'JE-1' }] });
    const page = await listJournalEntries(ENTITY, { limit: 1 });
    expect(page.total).toBe(317);
    expect(page.rows).toHaveLength(1);
  });

  it('keeps the REST handler’s filter order and parameters exactly', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listJournalEntries(ENTITY, {
      fiscalPeriodId: 'p1',
      status: 'posted',
      entryType: 'standard',
      startDate: '2026-01-01',
      endDate: '2026-01-31',
      sourceType: 'invoice',
    });
    expect(params(0)).toEqual([ENTITY, 'p1', 'posted', 'standard', '2026-01-01', '2026-01-31', 'invoice']);
    expect(sql(0)).toMatch(
      /je\.entity_id = \$1 AND je\.fiscal_period_id = \$2 AND je\.status = \$3 AND je\.entry_type = \$4 AND je\.entry_date >= \$5 AND je\.entry_date <= \$6 AND je\.source_type = \$7/
    );
  });

  it('orders newest first and pages after the filters', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '9' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listJournalEntries(ENTITY, { limit: 25, offset: 50 });
    expect(sql(1)).toMatch(/ORDER BY je\.entry_date DESC, je\.created_at DESC LIMIT \$2 OFFSET \$3/);
    expect(params(1)).toEqual([ENTITY, 25, 50]);
  });

  it('defaults the limit to the full result rather than dropping rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listJournalEntries(ENTITY);
    expect(params(1)[1]).toBe(7);
  });

  it('accepts several states at once without breaking the placeholders', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listJournalEntries(ENTITY, { status: ['draft', 'approved'], sourceType: 'manual' });
    expect(sql(0)).toMatch(/je\.status = ANY\(\$2\) AND je\.source_type = \$3/);
    expect(params(0)).toEqual([ENTITY, ['draft', 'approved'], 'manual']);
  });

  it('matches free text against description and reference with one placeholder', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listJournalEntries(ENTITY, { search: 'renta' });
    expect(sql(0)).toMatch(/\(je\.description ILIKE \$2 OR je\.reference ILIKE \$2\)/);
    expect(params(0)[1]).toBe('%renta%');
  });

  it('finds entries by account code without leaving the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listJournalEntries(ENTITY, { accountCode: '1110' });
    expect(sql(0)).toMatch(/EXISTS \(SELECT 1 FROM journal_entry_lines jel/);
    expect(sql(0)).toMatch(/a\.code = \$2 AND a\.entity_id = je\.entity_id/);
  });

  it('passes amounts as decimal STRINGS, never as floats', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listJournalEntries(ENTITY, { minAmount: 1000.5, maxAmount: '2000.00' });
    expect(params(0).slice(1)).toEqual(['1000.5', '2000.00']);
    expect(params(0).every((p: unknown) => typeof p !== 'number')).toBe(true);
  });
});

describe('resolveJournalEntry — what a person types vs what the table holds', () => {
  it('looks up an entry number case-insensitively, scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'e1' }] });
    await resolveJournalEntry(ENTITY, 'je-2026-00042');
    expect(sql(0)).toMatch(/WHERE UPPER\(entry_number\) = UPPER\(\$1\) AND entity_id = \$2/);
    expect(params(0)).toEqual(['je-2026-00042', ENTITY]);
  });

  it('looks up a uuid by id, still scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: ENTITY }] });
    await resolveJournalEntry(ENTITY, ENTITY);
    expect(sql(0)).toMatch(/WHERE id = \$1 AND entity_id = \$2/);
  });

  it('throws NotFound naming what was looked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolveJournalEntry(ENTITY, 'JE-9')).rejects.toThrow(
      expect.objectContaining({ name: 'NotFoundError', message: expect.stringContaining('JE-9') })
    );
  });
});

describe('reading one entry', () => {
  it('brings the lines with the account code and name, in line order', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listEntryLines('e1');
    expect(sql(0)).toMatch(/a\.code as account_code, a\.name as account_name/);
    expect(sql(0)).toMatch(/ORDER BY jel\.line_number/);
  });

  it('resolves the linked reversal in both directions', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'e1', entry_number: 'JE-1', reverses_entry_id: null, reversed_by_entry_id: 'e2' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ line_number: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'e2', entry_number: 'JE-2' }] });
    const detail = await getJournalEntryDetail(ENTITY, 'JE-1');
    expect(detail.reversed_by_entry_number).toBe('JE-2');
    expect(detail.reverses_entry_number).toBeNull();
  });
});

describe('validateDraftShape — the CHECK constraints, named', () => {
  const line = (over: Record<string, unknown> = {}) => ({ account: '1110', debit: '100.00', ...over });
  const input = (lines: unknown[], over: Record<string, unknown> = {}) =>
    ({ entityId: ENTITY, createdBy: USER, date: '2026-01-15', lines, ...over }) as never;

  it('refuses a single-sided entry before the database has to', () => {
    expect(() => validateDraftShape(input([line()]))).toThrow(/at least two lines/);
  });

  it('refuses a line with both sides, naming the line', () => {
    expect(() =>
      validateDraftShape(input([line(), line({ credit: '100.00' })]))
    ).toThrow(/Line 2: exactly one of debit or credit/);
  });

  it('refuses a line with neither side', () => {
    expect(() =>
      validateDraftShape(input([line(), { account: '2110' }]))
    ).toThrow(/Line 2: exactly one of debit or credit/);
  });

  it('refuses a non-positive or non-numeric amount', () => {
    expect(() => validateDraftShape(input([line({ debit: '0' }), line()]))).toThrow(/positive amount/);
    expect(() => validateDraftShape(input([line({ debit: 'mil' }), line()]))).toThrow(/positive amount/);
  });

  it('refuses an entry type that only an automated flow may mint', () => {
    expect(() =>
      validateDraftShape(input([line(), line({ credit: '100.00', account: '2110' })], { type: 'auto_invoice' }))
    ).toThrow(/automated flow/);
  });

  it('refuses a date that is not YYYY-MM-DD, whatever supplied it', () => {
    expect(() =>
      validateDraftShape(input([line(), { account: '2110', credit: '100.00' }], { date: '2026-8-1' }))
    ).toThrow(/not a date as YYYY-MM-DD/);
    expect(() =>
      validateDraftShape(input([line(), { account: '2110', credit: '100.00' }], { date: '2026-02-31' }))
    ).not.toThrow(); // Postgres, not us, rules on the 31st of February
  });

  it('accepts a balanced two-line entry', () => {
    expect(() =>
      validateDraftShape(input([line(), { account: '2110', credit: '100.00' }]))
    ).not.toThrow();
  });
});

describe('createDraftEntry — the entry the agent is allowed to write', () => {
  const input = {
    entityId: ENTITY,
    createdBy: USER,
    date: '2026-01-15',
    description: 'Renta enero',
    reference: 'F-1',
    lines: [
      { account: '6100', debit: '1000.00', description: 'renta' },
      { account: '1110', credit: '1000.00' },
    ],
  };

  it('NEVER asks the posting engine to post', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'acc-6100', code: '6100' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'acc-1110', code: '1110' }] });
    mockCreate.mockResolvedValueOnce({ id: 'e1', entry_number: 'JE-1' });

    await createDraftEntry(input);

    const options = mockCreate.mock.calls[0][6];
    expect(options.autoPost).toBeUndefined();
    // Belt and braces: nothing in the options may enable posting.
    expect(JSON.stringify(options)).not.toMatch(/autoPost|auto_post/);
  });

  it('turns account codes into ids, in line order, and keeps amounts as strings', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'acc-6100', code: '6100' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'acc-1110', code: '1110' }] });
    mockCreate.mockResolvedValueOnce({ id: 'e1' });

    await createDraftEntry(input);

    expect(mockCreate.mock.calls[0][4]).toEqual([
      { account_id: 'acc-6100', debit_amount: '1000.00', credit_amount: null, description: 'renta' },
      { account_id: 'acc-1110', debit_amount: null, credit_amount: '1000.00', description: '' },
    ]);
  });

  it('refuses an unbalanced shape before opening a transaction', async () => {
    await expect(createDraftEntry({ ...input, lines: [input.lines[0]] })).rejects.toThrow(ValidationError);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('reports an unknown account code as NotFound, not as a foreign-key error', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(createDraftEntry(input)).rejects.toThrow(NotFoundError);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe('checking without writing', () => {
  it('runs the rules over an existing entry with its real lines', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'e1', entry_number: 'JE-1', fiscal_period_id: 'p1', entry_date: '2026-01-15' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ line_number: 1 }, { line_number: 2 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ period_name: 'January 2026', status: 'open' }] });
    mockValidate.mockResolvedValueOnce({ isValid: false, errors: ['Debits must equal credits'], warnings: [] });

    const result = await checkExistingEntry(ENTITY, 'JE-1');
    expect(result.isValid).toBe(false);
    expect(result.line_count).toBe(2);
    expect(result.period_name).toBe('January 2026');
    expect(mockValidate.mock.calls[0][1]).toHaveLength(2);
  });

  it('resolves the period by date exactly as the posting engine does', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'p1', period_name: 'January 2026', status: 'open' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'acc-1', code: '6100' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'acc-2', code: '1110' }] });

    await checkDraftDocument({
      entityId: ENTITY,
      createdBy: USER,
      date: '2026-01-15',
      lines: [
        { account: '6100', debit: '10.00' },
        { account: '1110', credit: '10.00' },
      ],
    });

    expect(sql(0)).toMatch(/start_date <= \$2 AND end_date >= \$2/);
    expect(sql(0)).toMatch(/status NOT IN \('hard_close', 'locked'\)/);
    // The synthetic entry carries the period, so the period rule has something
    // to judge and the answer matches what posting would say.
    expect(mockValidate.mock.calls[0][0].fiscal_period_id).toBe('p1');
  });

  it('says so when no open period covers the date, instead of validating nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      checkDraftDocument({
        entityId: ENTITY,
        createdBy: USER,
        date: '2030-01-15',
        lines: [
          { account: '6100', debit: '10.00' },
          { account: '1110', credit: '10.00' },
        ],
      })
    ).rejects.toThrow(/No open fiscal period covers 2030-01-15/);
    expect(mockValidate).not.toHaveBeenCalled();
  });
});

describe('documents a person or an agent hands us', () => {
  it('parses the line flag, description and all', () => {
    expect(parseLineFlag('1110:debit:1500.00:Depósito: cliente A')).toEqual({
      account: '1110',
      debit: '1500.00',
      credit: undefined,
      description: 'Depósito: cliente A',
    });
  });

  it('rejects a side that is neither debit nor credit', () => {
    expect(() => parseLineFlag('1110:cargo:100')).toThrow(/debit.*credit/);
  });

  it('rejects a line flag that is missing a field', () => {
    expect(() => parseLineFlag('1110:debit')).toThrow(/<account>:<debit\|credit>:<amount>/);
  });

  it('reads a JSON document, accepting both spellings of each key', () => {
    const doc = parseEntryDocument(
      JSON.stringify({
        entry_date: '2026-02-01',
        entry_type: 'adjusting',
        description: 'Devengo',
        lines: [
          { account_code: '6100', debit_amount: 500 },
          { account: '2110', credit: '500' },
        ],
      })
    );
    expect(doc.date).toBe('2026-02-01');
    expect(doc.type).toBe('adjusting');
    expect(doc.lines).toEqual([
      { account: '6100', debit: '500', credit: undefined, description: undefined },
      { account: '2110', debit: undefined, credit: '500', description: undefined },
    ]);
  });

  it('refuses a document without a date or without lines', () => {
    expect(() => parseEntryDocument('{"lines":[]}')).toThrow(/"date" as YYYY-MM-DD/);
    expect(() => parseEntryDocument('{"date":"2026-02-01"}')).toThrow(/"lines" array/);
  });

  it('refuses malformed JSON with the parser’s reason', () => {
    expect(() => parseEntryDocument('{nope}')).toThrow(ValidationError);
  });
});

describe('assertEntryBelongsTo — the guard the id-taking engine cannot do itself', () => {
  it('accepts an entry of this entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ entity_id: ENTITY }] });
    await expect(assertEntryBelongsTo(ENTITY, 'e1')).resolves.toBeUndefined();
  });

  it('refuses an entry of another entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ entity_id: OTHER }] });
    await expect(assertEntryBelongsTo(ENTITY, 'e1')).rejects.toThrow(ConflictError);
  });

  it('reports a missing entry as NotFound', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(assertEntryBelongsTo(ENTITY, 'e1')).rejects.toThrow(NotFoundError);
  });
});
