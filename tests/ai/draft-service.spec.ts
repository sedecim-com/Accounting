import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../src/services/accounting/posting.js', () => ({
  createJournalEntry: vi.fn(),
  attestEntryAsync: vi.fn(),
}));
vi.mock('../../src/ai/approval-policy.js', () => ({
  matchApproval: vi.fn(),
}));
// Se sustituyen SÓLO las dos preguntas que salen de la máquina —hay sesión
// guardada, y ¿este despliegue exige autenticar?—. `decidirSujeto`, que es la
// regla que este tramo añade, corre la de produccion: una copia de la regla en
// el banco de pruebas probaria la copia.
vi.mock('../../src/auth/sujeto-activo.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/auth/sujeto-activo.js')>();
  return {
    ...real,
    sujetoAutenticado: vi.fn(() => Promise.resolve(null)),
    autenticacionExigida: vi.fn(() => false),
  };
});

import {
  validateDraftPayload,
  createDraft,
  approveDraft,
  autoApproveDraftByPolicy,
  rejectDraft,
  resolveReviewer,
  resolvePolicyGrantor,
  canonicalDraftHash,
  DraftValidationError,
  type DraftPayload,
} from '../../src/ai/draft-service.js';
import {
  sujetoAutenticado,
  autenticacionExigida,
  reiniciarAvisoDeIdentidad,
  SuplantacionError,
  SesionNoVerificableError,
} from '../../src/auth/sujeto-activo.js';
import { query, withTransaction } from '../../src/database/connection.js';
import { createJournalEntry, attestEntryAsync } from '../../src/services/accounting/posting.js';
import { matchApproval } from '../../src/ai/approval-policy.js';
import type { AgentContext } from '../../src/ai/context.js';

const mockQuery = query as unknown as Mock;
const mockWithTransaction = withTransaction as unknown as Mock;
const mockCreateJE = createJournalEntry as unknown as Mock;
const mockAttest = attestEntryAsync as unknown as Mock;
const mockMatchApproval = matchApproval as unknown as Mock;
const mockSujeto = sujetoAutenticado as unknown as Mock;
const mockExige = autenticacionExigida as unknown as Mock;

/** La sesión que `mnemosine login` habría dejado en el llavero. */
const SESION = {
  subject: 'sub-ana-0001',
  email: 'ana@despacho.mx',
  issuer: 'https://idp.example.com',
};

const CTX: AgentContext = {
  entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  entityName: 'Acme MX',
  tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'AME010101AAA',
};

const OPEN_PERIOD = { rows: [{ id: 'fp-1' }] };
const GOOD_ACCOUNTS = {
  rows: [
    { id: 'acc-5201', code: '5201', is_active: true, is_header: false, allow_manual_entries: true },
    { id: 'acc-1101', code: '1101', is_active: true, is_header: false, allow_manual_entries: true },
  ],
};

const GOOD_PAYLOAD: DraftPayload = {
  entry_date: '2026-08-01',
  description: 'Renta de oficinas agosto',
  lines: [
    { account_code: '5201', debit: 10000, description: 'Renta agosto' },
    { account_code: '1101', credit: 10000 },
  ],
};

/** Queues the standard validation responses: open fiscal period + catalog. */
function mockValidationQueries(accounts = GOOD_ACCOUNTS, period = OPEN_PERIOD) {
  mockQuery.mockResolvedValueOnce(period); // fiscal_periods
  mockQuery.mockResolvedValueOnce(accounts); // accounts
}

describe('validateDraftPayload', () => {
  beforeEach(() => mockQuery.mockReset());

  it('accepts a balanced draft with valid accounts and an open period', async () => {
    mockValidationQueries();
    const v = await validateDraftPayload(CTX.entityId, GOOD_PAYLOAD);
    expect(v.errors).toEqual([]);
    expect(v.totalDebits.toFixed(2)).toBe('10000.00');
    expect(v.totalCredits.toFixed(2)).toBe('10000.00');
    expect(v.accountIdByCode.get('5201')).toBe('acc-5201');
  });

  it('rejects when no open fiscal period covers the date', async () => {
    mockValidationQueries(GOOD_ACCOUNTS, { rows: [] });
    const v = await validateDraftPayload(CTX.entityId, GOOD_PAYLOAD);
    expect(v.errors.some((e) => e.includes('fiscal period'))).toBe(true);
  });

  it('rejects an unbalanced draft (exact equality, no tolerance)', async () => {
    mockValidationQueries();
    const v = await validateDraftPayload(CTX.entityId, {
      ...GOOD_PAYLOAD,
      lines: [
        { account_code: '5201', debit: 10.0 },
        { account_code: '1101', credit: 10.01 },
      ],
    });
    expect(v.errors.some((e) => e.includes('does not balance'))).toBe(true);
  });

  it('validates on 2-decimal rounded amounts (rounding drift is caught)', async () => {
    mockValidationQueries();
    // Pre-rounding: 4×1.004 = 4.016 vs 4.02 (diff 0.004). Post-rounding: 4.00 vs 4.02.
    const v = await validateDraftPayload(CTX.entityId, {
      ...GOOD_PAYLOAD,
      lines: [
        { account_code: '5201', debit: 1.004 },
        { account_code: '5201', debit: 1.004 },
        { account_code: '5201', debit: 1.004 },
        { account_code: '5201', debit: 1.004 },
        { account_code: '1101', credit: 4.02 },
      ],
    });
    expect(v.errors.some((e) => e.includes('does not balance'))).toBe(true);
  });

  it('rejects amounts that round to zero', async () => {
    mockValidationQueries();
    const v = await validateDraftPayload(CTX.entityId, {
      ...GOOD_PAYLOAD,
      lines: [
        { account_code: '5201', debit: 0.004 },
        { account_code: '1101', credit: 0.004 },
      ],
    });
    expect(v.errors.filter((e) => e.includes('positive'))).toHaveLength(2);
  });

  it('rejects a line with both debit and credit, and one with neither', async () => {
    mockValidationQueries();
    const v = await validateDraftPayload(CTX.entityId, {
      ...GOOD_PAYLOAD,
      lines: [
        { account_code: '5201', debit: 100, credit: 100 },
        { account_code: '1101' },
      ],
    });
    expect(v.errors.filter((e) => e.includes('exactly one'))).toHaveLength(2);
  });

  it('rejects missing account_code and non-numeric amounts defensively', async () => {
    mockValidationQueries();
    const v = await validateDraftPayload(CTX.entityId, {
      ...GOOD_PAYLOAD,
      lines: [
        { account_code: '', debit: 100 },
        { account_code: '1101', credit: '100' as unknown as number },
      ],
    });
    expect(v.errors.some((e) => e.includes('account_code is required'))).toBe(true);
    expect(v.errors.some((e) => e.includes('numeric'))).toBe(true);
  });

  it('rejects fewer than 2 lines', async () => {
    mockValidationQueries({ rows: [GOOD_ACCOUNTS.rows[0]] });
    const v = await validateDraftPayload(CTX.entityId, {
      ...GOOD_PAYLOAD,
      lines: [{ account_code: '5201', debit: 100 }],
    });
    expect(v.errors.some((e) => e.includes('at least 2'))).toBe(true);
  });

  it('rejects unknown, inactive, header and no-manual accounts', async () => {
    mockValidationQueries({
      rows: [
        { id: 'a1', code: '1101', is_active: false, is_header: false, allow_manual_entries: true },
        { id: 'a2', code: '1000', is_active: true, is_header: true, allow_manual_entries: true },
        { id: 'a3', code: '2101', is_active: true, is_header: false, allow_manual_entries: false },
      ],
    });
    const v = await validateDraftPayload(CTX.entityId, {
      ...GOOD_PAYLOAD,
      lines: [
        { account_code: '9999', debit: 100 },
        { account_code: '1101', credit: 25 },
        { account_code: '1000', credit: 25 },
        { account_code: '2101', credit: 50 },
      ],
    });
    expect(v.errors.some((e) => e.includes('9999') && e.includes('does not exist'))).toBe(true);
    expect(v.errors.some((e) => e.includes('1101') && e.includes('inactive'))).toBe(true);
    expect(v.errors.some((e) => e.includes('1000') && e.includes('header'))).toBe(true);
    expect(v.errors.some((e) => e.includes('2101') && e.includes('does not accept'))).toBe(true);
  });

  it('rejects a malformed date without querying fiscal periods', async () => {
    mockQuery.mockResolvedValueOnce(GOOD_ACCOUNTS); // only the accounts query runs
    const v = await validateDraftPayload(CTX.entityId, { ...GOOD_PAYLOAD, entry_date: '01/08/2026' });
    expect(v.errors.some((e) => e.includes('YYYY-MM-DD'))).toBe(true);
    expect(mockQuery.mock.calls).toHaveLength(1);
    expect(mockQuery.mock.calls[0][0]).toMatch(/FROM accounts/);
  });
});

describe('createDraft', () => {
  beforeEach(() => mockQuery.mockReset());

  it('inserts a pending_review draft with the payload as JSONB', async () => {
    mockValidationQueries();
    mockQuery.mockResolvedValueOnce({ rows: [] }); // insert
    const result = await createDraft(CTX, {
      payload: GOOD_PAYLOAD,
      confidence: 0.92,
      reasoning: 'Precedent JE-2026-00031',
      model: 'claude-opus-5',
      userRequest: 'registra la renta de agosto',
    });
    expect(result.totalDebits).toBe('10000.00');
    const [sql, params] = mockQuery.mock.calls[2];
    expect(sql).toMatch(/INSERT INTO ai_drafts/);
    expect(sql).toMatch(/'pending_review'/);
    expect(params[1]).toBe(CTX.tenantId);
    expect(params[2]).toBe(CTX.entityId);
    expect(JSON.parse(params[3] as string)).toEqual(GOOD_PAYLOAD);
    expect(params[4]).toBe('0.92');
    expect(params[7]).toBe('registra la renta de agosto');
  });

  it('throws DraftValidationError without inserting when invalid', async () => {
    mockValidationQueries();
    await expect(
      createDraft(CTX, {
        payload: { ...GOOD_PAYLOAD, lines: [{ account_code: '5201', debit: 1 }, { account_code: '1101', credit: 2 }] },
        confidence: 0.9,
        reasoning: 'x',
        model: 'claude-opus-5',
      })
    ).rejects.toBeInstanceOf(DraftValidationError);
    expect(mockQuery.mock.calls).toHaveLength(2); // only the validation queries
  });
});

describe('approveDraft', () => {
  const mockClientQuery = vi.fn();
  const mockClient = { query: mockClientQuery };

  beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockCreateJE.mockReset();
    mockAttest.mockReset();
    mockWithTransaction.mockReset();
    mockWithTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(mockClient));
  });

  const DRAFT_ROW = {
    id: 'draft-1',
    entity_id: CTX.entityId,
    status: 'pending_review',
    payload: GOOD_PAYLOAD,
  };

  it('locks the draft, posts in the same transaction, and attests post-commit', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [DRAFT_ROW] }); // SELECT ... FOR UPDATE
    mockValidationQueries(); // pool queries for validation
    mockCreateJE.mockResolvedValueOnce({ id: 'je-1', entry_number: 'JE-2026-00099' });
    mockClientQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // guarded UPDATE

    const result = await approveDraft(CTX, 'draft-1', { userId: 'user-1', email: 'admin@demo.com' }, 'ok');
    expect(result.entryNumber).toBe('JE-2026-00099');

    // Row lock with entity scope
    const [lockSql, lockParams] = mockClientQuery.mock.calls[0];
    expect(lockSql).toMatch(/FOR UPDATE/);
    expect(lockParams).toEqual(['draft-1', CTX.entityId]);

    // Posting runs on the SAME transaction client
    const [, , entryType, , lines, createdBy, options] = mockCreateJE.mock.calls[0];
    expect(entryType).toBe('standard');
    expect(createdBy).toBe('user-1');
    expect(options).toMatchObject({ sourceType: 'ai_draft', sourceId: 'draft-1', autoPost: true });
    expect(options.client).toBe(mockClient);
    expect(lines[0]).toEqual({ account_id: 'acc-5201', debit_amount: '10000.00', credit_amount: null, description: 'Renta agosto' });

    // Guarded update, status still pending, content hash stored
    const [updateSql, updateParams] = mockClientQuery.mock.calls[1];
    expect(updateSql).toMatch(/status = 'pending_review'/);
    expect(updateSql).toMatch(/approved_content_hash/);
    expect(updateParams).toEqual([
      'je-1', 'admin@demo.com', 'ok', canonicalDraftHash(GOOD_PAYLOAD), 'draft-1', CTX.entityId,
    ]);

    // Attestation fired after the transaction resolved
    expect(mockAttest).toHaveBeenCalledWith(CTX.tenantId, CTX.entityId, 'je-1');
  });

  it('refuses to approve a draft that is not pending', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [{ ...DRAFT_ROW, status: 'rejected' }] });
    await expect(
      approveDraft(CTX, 'draft-1', { userId: 'u', email: 'e@x.com' })
    ).rejects.toThrow(/rejected/);
    expect(mockCreateJE).not.toHaveBeenCalled();
    expect(mockAttest).not.toHaveBeenCalled();
  });

  it('re-validates and refuses when the catalog changed', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [DRAFT_ROW] });
    mockValidationQueries({ rows: [] }); // accounts vanished
    await expect(
      approveDraft(CTX, 'draft-1', { userId: 'u', email: 'e@x.com' })
    ).rejects.toBeInstanceOf(DraftValidationError);
    expect(mockCreateJE).not.toHaveBeenCalled();
  });

  it('proceeds when the expected content hash matches the locked payload', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [DRAFT_ROW] });
    mockValidationQueries();
    mockCreateJE.mockResolvedValueOnce({ id: 'je-1', entry_number: 'JE-2026-00099' });
    mockClientQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const result = await approveDraft(
      CTX, 'draft-1', { userId: 'user-1', email: 'admin@demo.com' }, 'ok',
      canonicalDraftHash(GOOD_PAYLOAD)
    );
    expect(result.entryNumber).toBe('JE-2026-00099');
    expect(mockCreateJE).toHaveBeenCalledTimes(1);
  });

  it('invalidates the approval when the content drifted after review (hash mismatch)', async () => {
    // The reviewer approved a 10,000 rent entry; someone mutated the payload
    // to 90,000 before the approval landed. The hash of what was REVIEWED no
    // longer matches the payload read under the row lock.
    const reviewedHash = canonicalDraftHash(GOOD_PAYLOAD);
    const mutated = {
      ...GOOD_PAYLOAD,
      lines: [
        { account_code: '5201', debit: 90000 },
        { account_code: '1101', credit: 90000 },
      ],
    };
    mockClientQuery.mockResolvedValueOnce({ rows: [{ ...DRAFT_ROW, payload: mutated }] });

    await expect(
      approveDraft(CTX, 'draft-1', { userId: 'u', email: 'e@x.com' }, undefined, reviewedHash)
    ).rejects.toThrow(/Draft content changed after review; approval invalidated/);

    // Nothing posted, nothing updated: the check runs before validation/posting.
    expect(mockCreateJE).not.toHaveBeenCalled();
    expect(mockAttest).not.toHaveBeenCalled();
    expect(mockClientQuery.mock.calls).toHaveLength(1); // only the FOR UPDATE lock
  });

  it('rolls back (throws) if the guarded update matches no row', async () => {
    mockClientQuery.mockResolvedValueOnce({ rows: [DRAFT_ROW] });
    mockValidationQueries();
    mockCreateJE.mockResolvedValueOnce({ id: 'je-1', entry_number: 'JE-2026-00099' });
    mockClientQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(
      approveDraft(CTX, 'draft-1', { userId: 'u', email: 'e@x.com' })
    ).rejects.toThrow(/changed status/);
    expect(mockAttest).not.toHaveBeenCalled();
  });
});

describe('autoApproveDraftByPolicy', () => {
  const mockClientQuery = vi.fn();
  const mockClient = { query: mockClientQuery };

  const POLICY = {
    id: 'pol-1',
    entity_id: CTX.entityId,
    scope: 'draft',
    pattern: { max_amount: '25000' },
    mode: 'always',
    session_id: null,
    created_by: 'admin@demo.com',
    created_at: new Date(),
    last_used_at: null,
    revoked_at: null,
  };

  const DRAFT_ROW = {
    id: 'draft-1',
    entity_id: CTX.entityId,
    status: 'pending_review',
    payload: GOOD_PAYLOAD,
  };

  beforeEach(() => {
    mockQuery.mockReset();
    mockClientQuery.mockReset();
    mockCreateJE.mockReset();
    mockAttest.mockReset();
    mockMatchApproval.mockReset();
    mockWithTransaction.mockReset();
    mockWithTransaction.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(mockClient));
  });

  it('matches the policy on the posted-total candidate and approves as policy:<id>', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [DRAFT_ROW] }); // getDraft
    mockMatchApproval.mockResolvedValueOnce(POLICY);
    // The posting user is the human who GRANTED the policy.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-1', email: 'admin@demo.com' }] }); // resolveReviewer
    mockClientQuery.mockResolvedValueOnce({ rows: [DRAFT_ROW] }); // FOR UPDATE
    mockValidationQueries();
    mockCreateJE.mockResolvedValueOnce({ id: 'je-1', entry_number: 'JE-2026-00099' });
    mockClientQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // guarded UPDATE

    const result = await autoApproveDraftByPolicy(CTX, 'draft-1', { sessionId: 'sess-1' });
    expect(result).toEqual({ entryId: 'je-1', entryNumber: 'JE-2026-00099', policyId: 'pol-1' });

    // Conservative candidate: kind + total debits as they will post.
    expect(mockMatchApproval).toHaveBeenCalledWith(
      CTX, 'draft', { kind: 'journal_entry', amount: '10000.00' }, { sessionId: 'sess-1' }
    );

    // The posted entry is attributed to the grantor's real user id.
    const [, , , , , createdBy] = mockCreateJE.mock.calls[0];
    expect(createdBy).toBe('user-1');

    // reviewed_by records WHICH policy authorized it; the approval is
    // hash-bound to the payload the policy matched.
    const [updateSql, updateParams] = mockClientQuery.mock.calls[1];
    expect(updateSql).toMatch(/status = 'pending_review'/);
    expect(updateParams[1]).toBe('policy:pol-1');
    expect(updateParams[2]).toMatch(/auto-approved by policy pol-1/);
    expect(updateParams[3]).toBe(canonicalDraftHash(GOOD_PAYLOAD));
    expect(mockAttest).toHaveBeenCalledWith(CTX.tenantId, CTX.entityId, 'je-1');
  });

  it("derives the candidate kind from the payload's kind field (a --kind payroll policy can match)", async () => {
    const payrollPayload = { ...GOOD_PAYLOAD, kind: 'payroll' } as unknown as DraftPayload;
    mockQuery.mockResolvedValueOnce({ rows: [{ ...DRAFT_ROW, payload: payrollPayload }] }); // getDraft
    mockMatchApproval.mockResolvedValueOnce(null); // stop after the match call
    await expect(autoApproveDraftByPolicy(CTX, 'draft-1')).rejects.toThrow(/No approval policy/);
    expect(mockMatchApproval).toHaveBeenCalledWith(
      CTX, 'draft', { kind: 'payroll', amount: '10000.00' }, undefined
    );
  });

  it('falls back to entry_type, then to journal_entry, for the candidate kind', async () => {
    const entryTypePayload = { ...GOOD_PAYLOAD, entry_type: 'payroll' } as unknown as DraftPayload;
    mockQuery.mockResolvedValueOnce({ rows: [{ ...DRAFT_ROW, payload: entryTypePayload }] });
    mockMatchApproval.mockResolvedValueOnce(null);
    await expect(autoApproveDraftByPolicy(CTX, 'draft-1')).rejects.toThrow(/No approval policy/);
    expect(mockMatchApproval.mock.calls[0][2]).toEqual({ kind: 'payroll', amount: '10000.00' });

    // Blank/non-string kinds are ignored, not trusted.
    const blankKindPayload = { ...GOOD_PAYLOAD, kind: '  ', entry_type: 42 } as unknown as DraftPayload;
    mockQuery.mockResolvedValueOnce({ rows: [{ ...DRAFT_ROW, payload: blankKindPayload }] });
    mockMatchApproval.mockResolvedValueOnce(null);
    await expect(autoApproveDraftByPolicy(CTX, 'draft-1')).rejects.toThrow(/No approval policy/);
    expect(mockMatchApproval.mock.calls[1][2]).toEqual({ kind: 'journal_entry', amount: '10000.00' });
  });

  it('FAIL CLOSED: refuses to auto-approve when no trustworthy amount can be derived', async () => {
    // The payload is AI-written JSONB — any malformed line means the code
    // cannot vouch for the amount, and no policy may auto-approve it.
    const badPayloads: Array<[string, unknown]> = [
      ['empty lines', { ...GOOD_PAYLOAD, lines: [] }],
      ['lines not an array', { ...GOOD_PAYLOAD, lines: 'nope' }],
      ['string debit', {
        ...GOOD_PAYLOAD,
        lines: [{ account_code: '5201', debit: '10000' }, { account_code: '1101', credit: 10000 }],
      }],
      ['line with neither side', {
        ...GOOD_PAYLOAD,
        lines: [{ account_code: '5201', debit: 100 }, { account_code: '1101' }],
      }],
      ['line with both sides', {
        ...GOOD_PAYLOAD,
        lines: [{ account_code: '5201', debit: 100, credit: 100 }, { account_code: '1101', credit: 100 }],
      }],
      ['negative debit', {
        ...GOOD_PAYLOAD,
        lines: [{ account_code: '5201', debit: -100 }, { account_code: '1101', credit: 100 }],
      }],
      ['non-finite debit', {
        ...GOOD_PAYLOAD,
        lines: [{ account_code: '5201', debit: Number.NaN }, { account_code: '1101', credit: 100 }],
      }],
    ];
    for (const [, payload] of badPayloads) {
      mockQuery.mockResolvedValueOnce({ rows: [{ ...DRAFT_ROW, payload }] }); // getDraft
      await expect(autoApproveDraftByPolicy(CTX, 'draft-1')).rejects.toThrow(
        /No trustworthy amount can be derived/
      );
    }
    // The refusal happens BEFORE matching: no policy is read, touched or consumed.
    expect(mockMatchApproval).not.toHaveBeenCalled();
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockCreateJE).not.toHaveBeenCalled();
  });

  it('throws and posts nothing when no policy authorizes the draft', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [DRAFT_ROW] }); // getDraft
    mockMatchApproval.mockResolvedValueOnce(null);
    await expect(autoApproveDraftByPolicy(CTX, 'draft-1')).rejects.toThrow(/No approval policy/);
    expect(mockWithTransaction).not.toHaveBeenCalled();
    expect(mockCreateJE).not.toHaveBeenCalled();
  });

  it('refuses a draft that is not pending, before even matching', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...DRAFT_ROW, status: 'approved' }] });
    await expect(autoApproveDraftByPolicy(CTX, 'draft-1')).rejects.toThrow(/not pending review/);
    expect(mockMatchApproval).not.toHaveBeenCalled();
  });

  it('invalidates the approval when the payload drifts between match and row lock', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [DRAFT_ROW] }); // getDraft (matched content)
    mockMatchApproval.mockResolvedValueOnce(POLICY);
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-1', email: 'admin@demo.com' }] }); // resolveReviewer
    const mutated = {
      ...GOOD_PAYLOAD,
      lines: [
        { account_code: '5201', debit: 90000 },
        { account_code: '1101', credit: 90000 },
      ],
    };
    mockClientQuery.mockResolvedValueOnce({ rows: [{ ...DRAFT_ROW, payload: mutated }] }); // FOR UPDATE

    await expect(autoApproveDraftByPolicy(CTX, 'draft-1')).rejects.toThrow(
      /Draft content changed after review; approval invalidated/
    );
    expect(mockCreateJE).not.toHaveBeenCalled();
    expect(mockAttest).not.toHaveBeenCalled();
  });
});

describe('canonicalDraftHash', () => {
  it('is a 64-char sha256 hex, deterministic for the same content', () => {
    const h = canonicalDraftHash(GOOD_PAYLOAD);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalDraftHash({ ...GOOD_PAYLOAD })).toBe(h);
  });

  it('ignores property insertion order (stable key order)', () => {
    const reordered: DraftPayload = {
      lines: [
        { description: 'Renta agosto', debit: 10000, account_code: '5201' },
        { credit: 10000, account_code: '1101' },
      ],
      description: 'Renta de oficinas agosto',
      entry_date: '2026-08-01',
    };
    expect(canonicalDraftHash(reordered)).toBe(canonicalDraftHash(GOOD_PAYLOAD));
  });

  it('normalizes amounts to 2-decimal strings (what will post is what is hashed)', () => {
    const sloppy: DraftPayload = {
      ...GOOD_PAYLOAD,
      lines: [
        { account_code: '5201', debit: 10000.0001, description: 'Renta agosto' },
        { account_code: '1101', credit: 10000 },
      ],
    };
    expect(canonicalDraftHash(sloppy)).toBe(canonicalDraftHash(GOOD_PAYLOAD));
  });

  it('changes when any material field changes', () => {
    const base = canonicalDraftHash(GOOD_PAYLOAD);
    expect(canonicalDraftHash({ ...GOOD_PAYLOAD, entry_date: '2026-08-02' })).not.toBe(base);
    expect(canonicalDraftHash({ ...GOOD_PAYLOAD, reference: 'F-77' })).not.toBe(base);
    expect(
      canonicalDraftHash({
        ...GOOD_PAYLOAD,
        lines: [
          { account_code: '5201', debit: 10000.01, description: 'Renta agosto' },
          { account_code: '1101', credit: 10000.01 },
        ],
      })
    ).not.toBe(base);
  });
});

describe('rejectDraft', () => {
  beforeEach(() => mockQuery.mockReset());

  it('marks a pending draft rejected with the reason', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await rejectDraft(CTX, 'draft-1', { userId: 'u', email: 'admin@demo.com' }, 'Wrong account');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET status = 'rejected'/);
    expect(sql).toMatch(/status = 'pending_review'/);
    expect(params).toEqual(['admin@demo.com', 'Wrong account', 'draft-1', CTX.entityId]);
  });

  it('throws when no pending draft matches', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(rejectDraft(CTX, 'nope', { userId: 'u', email: 'e' }, 'x')).rejects.toThrow(/No pending draft/);
  });
});

describe('resolveReviewer', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSujeto.mockReset().mockResolvedValue(null);
    mockExige.mockReset().mockReturnValue(false);
    reiniciarAvisoDeIdentidad();
  });

  it('auto-picks only when the tenant has exactly one active user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-1', email: 'admin@demo.com' }] });
    const r = await resolveReviewer(CTX.tenantId);
    expect(r).toEqual({ userId: 'user-1', email: 'admin@demo.com' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/is_active = true/);
    expect(sql).toMatch(/LIMIT 2/);
    expect(params).toEqual([CTX.tenantId]);
  });

  it('demands an explicit --user when the tenant has several active users', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'user-1', email: 'a@demo.com' },
        { id: 'user-2', email: 'b@demo.com' },
      ],
    });
    await expect(resolveReviewer(CTX.tenantId)).rejects.toThrow(/--user/);
  });

  it('resolves by email and errors when not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-2', email: 'contadora@demo.com' }] });
    const r = await resolveReviewer(CTX.tenantId, 'contadora@demo.com');
    expect(r.userId).toBe('user-2');

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolveReviewer(CTX.tenantId, 'nadie@x.com')).rejects.toThrow(/nadie@x\.com/);
  });

  // ── G3 · LA IDENTIDAD QUE AHORA SÍ SE COMPRUEBA ─────────────────────
  //
  // Las tres pruebas de arriba corren SIN sesión y SIN proveedor
  // configurado, que es el despliegue de hoy: siguen verdes a propósito
  // —el cambio no puede romper a quien no tiene OIDC—. Lo que sigue fija
  // la verdad nueva.

  it('sin sesión no se calla: la bandera queda marcada como declarada', async () => {
    const escrito: string[] = [];
    const espia = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array) => {
        escrito.push(String(chunk));
        return true;
      });
    try {
      mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-2', email: 'beto@despacho.mx' }] });
      const r = await resolveReviewer(CTX.tenantId, 'beto@despacho.mx');
      expect(r.userId).toBe('user-2');
    } finally {
      espia.mockRestore();
    }
    expect(escrito.join('')).toMatch(/no lo comprobó nadie/);
  });

  it('con sesión, un --user que nombra a OTRO se rechaza antes de tocar la base', async () => {
    mockSujeto.mockResolvedValue(SESION);

    await expect(resolveReviewer(CTX.tenantId, 'beto@despacho.mx')).rejects.toThrow(
      SuplantacionError
    );
    await expect(resolveReviewer(CTX.tenantId, 'beto@despacho.mx')).rejects.toThrow(
      /ana@despacho\.mx.*--user dice beto@despacho\.mx/s
    );
    // No se consultó nada: la suplantación se niega por regla, no por la
    // suerte de que el usuario nombrado no exista.
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('con sesión, nombrarte a ti mismo es un no-op admitido (caja y espacios aparte)', async () => {
    mockSujeto.mockResolvedValue(SESION);
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-ana', email: 'ana@despacho.mx' }] });

    const r = await resolveReviewer(CTX.tenantId, '  ANA@Despacho.MX ');
    expect(r).toEqual({ userId: 'user-ana', email: 'ana@despacho.mx' });
  });

  it('la atribución sale del sujeto AUTENTICADO, atada al sub y no al correo', async () => {
    mockSujeto.mockResolvedValue(SESION);
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-ana', email: 'ana@despacho.mx' }] });

    const r = await resolveReviewer(CTX.tenantId);
    expect(r).toEqual({ userId: 'user-ana', email: 'ana@despacho.mx' });

    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM identities i/);
    expect(sql).toMatch(/u\.is_active = true/);
    expect(params).toEqual(['oidc', 'sub-ana-0001', CTX.tenantId]);
  });

  it('con la identidad aún sin vincular cae al correo verificado, en ese orden', async () => {
    mockSujeto.mockResolvedValue(SESION);
    mockQuery.mockResolvedValueOnce({ rows: [] }); // identities: nada vinculado
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-ana', email: 'ana@despacho.mx' }] });

    const r = await resolveReviewer(CTX.tenantId);
    expect(r.userId).toBe('user-ana');
    expect(mockQuery.mock.calls[1][1]).toEqual([CTX.tenantId, 'ana@despacho.mx']);
  });

  it('con sesión verificada sin usuario en el inquilino, el error no manda a buscar un tecleo', async () => {
    mockSujeto.mockResolvedValue(SESION);
    mockQuery.mockResolvedValueOnce({ rows: [] }); // identities
    mockQuery.mockResolvedValueOnce({ rows: [] }); // users por correo

    await expect(resolveReviewer(CTX.tenantId)).rejects.toThrow(
      /verificada pero no corresponde a ningún usuario activo/
    );
  });

  it('con proveedor configurado y sin sesión se rechaza en vez de creerle a --user', async () => {
    mockExige.mockReturnValue(true);
    mockSujeto.mockResolvedValue(null);

    await expect(resolveReviewer(CTX.tenantId, 'beto@despacho.mx')).rejects.toThrow(
      SesionNoVerificableError
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('resolvePolicyGrantor', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockSujeto.mockReset().mockResolvedValue(SESION);
    mockExige.mockReset().mockReturnValue(true);
  });

  it('no pasa por la sesión: el otorgante no es quien está en la terminal', async () => {
    // Con la regla de `--user` aplicada aquí, una sesión abierta de Ana
    // impediría ejecutar cualquier política concedida por otra persona.
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'user-2', email: 'beto@despacho.mx' }] });
    const r = await resolvePolicyGrantor(CTX.tenantId, 'beto@despacho.mx');
    expect(r).toEqual({ userId: 'user-2', email: 'beto@despacho.mx' });
    expect(mockSujeto).not.toHaveBeenCalled();
  });
});
