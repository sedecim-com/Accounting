import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/services/integrations/accounting/registry.js', () => ({
  getExternalAdapter: vi.fn(),
  listExternalSystems: vi.fn(() => ['contalink']),
}));
vi.mock('../../../src/ai/approval-policy.js', () => ({
  matchApproval: vi.fn(),
}));

import {
  diffTrialBalance,
  queueExternalOp,
  executeExternalOp,
  autoExecuteOpByPolicy,
  rejectExternalOp,
  recoverExecutingOp,
  canonicalOpHash,
} from '../../../src/ai/external-service.js';
import { FLOOR_MAX_OP_AGE_DAYS } from '../../../src/ai/floor.js';
import { query } from '../../../src/database/connection.js';
import { getExternalAdapter } from '../../../src/services/integrations/accounting/registry.js';
import { matchApproval } from '../../../src/ai/approval-policy.js';
import type { AgentContext } from '../../../src/ai/context.js';

const mockQuery = query as unknown as Mock;
const mockGetAdapter = getExternalAdapter as unknown as Mock;
const mockMatchApproval = matchApproval as unknown as Mock;

const CTX: AgentContext = {
  entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  entityName: 'Acme MX', tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA',
};

beforeEach(() => {
  mockQuery.mockReset();
  mockGetAdapter.mockReset();
  mockMatchApproval.mockReset();
});

describe('diffTrialBalance', () => {
  it('classifies differences, local-only and remote-only with 0.01 tolerance', async () => {
    mockGetAdapter.mockReturnValueOnce({
      getTrialBalance: vi.fn(async () => [
        { account_code: '1110', account_name: 'Bancos', period_debits: 0, period_credits: 0, ending_balance: 1000.5 },
        { account_code: '6100', account_name: 'Gastos', period_debits: 0, period_credits: 0, ending_balance: 500 },
        { account_code: '9999', account_name: 'Remote only', period_debits: 0, period_credits: 0, ending_balance: 77 },
        { account_code: '8888', account_name: 'Remote zeroed', period_debits: 0, period_credits: 0, ending_balance: 0 },
      ]),
    });
    mockQuery.mockResolvedValueOnce({
      rows: [
        { code: '1110', name: 'Bancos', balance: '1000.50' },   // equal (within tolerance)
        { code: '6100', name: 'Gastos', balance: '600.00' },    // differs +100
        { code: '7777', name: 'Local only', balance: '42.00' }, // not on the remote side
        { code: '5555', name: 'Local zeroed', balance: '0.00' }, // ignored
      ],
    });

    const diff = await diffTrialBalance(CTX, 'contalink', '2026-08-01', '2026-08-31');
    expect(diff.matched_equal).toBe(1);
    expect(diff.differences).toEqual([
      { account_code: '6100', local: '600.00', remote: '500.00', delta: '100.00' },
    ]);
    expect(diff.only_remote).toEqual([{ account_code: '9999', name: 'Remote only', balance: '77.00' }]);
    expect(diff.only_local).toEqual([{ account_code: '7777', name: 'Local only', balance: '42.00' }]);

    // The local trial balance is computed from posted entries at the cutoff
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/je\.status = 'posted'/);
    expect(params).toEqual([CTX.entityId, '2026-08-31']);
  });
});

describe('outbox', () => {
  it('queueExternalOp validates the provider BEFORE inserting', async () => {
    mockGetAdapter.mockImplementationOnce(() => {
      throw new Error('requires the CONTALINK_API_KEY environment variable');
    });
    await expect(
      queueExternalOp(CTX, {
        provider: 'contalink', operation: 'create_policy', payload: {},
        reasoning: 'x', model: 'm',
      })
    ).rejects.toThrow(/CONTALINK_API_KEY/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('queues with tenant/entity and reasoning', async () => {
    mockGetAdapter.mockReturnValueOnce({});
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const id = await queueExternalOp(CTX, {
      provider: 'contalink', operation: 'create_policy',
      payload: { record_date: '2026-08-24' }, reasoning: 'mirror of JE-6', model: 'm',
    });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_external_ops/);
    expect(params[1]).toBe(CTX.tenantId);
    expect(params[2]).toBe(CTX.entityId);
    expect(params[6]).toBe('mirror of JE-6');
  });

  it('executeExternalOp claims pending→executing atomically and stores the result', async () => {
    const createManualPolicy = vi.fn(async () => ({ status: 1, policy_data: { id: 55 } }));
    mockGetAdapter.mockReturnValueOnce({ createManualPolicy });
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        id: 'op-1', provider: 'contalink', operation: 'create_policy',
        payload: { record_date: '2026-08-24', description: 'x', records: [] },
        status: 'executing', ai_reasoning: 'r', result: null, error: null, created_at: new Date(),
      }],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const { result } = await executeExternalOp(CTX, 'op-1', 'admin@demo.com');
    expect(result.policy_data).toEqual({ id: 55 });

    const [claimSql, claimParams] = mockQuery.mock.calls[0];
    expect(claimSql).toMatch(/SET status = 'executing'/);
    expect(claimSql).toMatch(/AND status = 'pending'/);
    expect(claimParams).toEqual(['admin@demo.com', 'op-1', CTX.entityId]);
    const [doneSql, doneParams] = mockQuery.mock.calls[1];
    expect(doneSql).toMatch(/SET status = 'executed'/);
    // House guarded-UPDATE pattern: status predicate + entity scoping.
    expect(doneSql).toMatch(/AND status = 'executing'/);
    expect(doneSql).toMatch(/entity_id = \$4/);
    expect(doneParams.slice(2)).toEqual(['op-1', CTX.entityId]);
    // The executed row records the canonical hash of what actually ran.
    expect(doneSql).toMatch(/approved_content_hash/);
    expect(doneParams[1]).toBe(
      canonicalOpHash('contalink', 'create_policy', { record_date: '2026-08-24', description: 'x', records: [] })
    );
  });

  it("guard miss on the 'executed' transition (rowCount 0): logs, throws, never overwrites", async () => {
    // The adapter call succeeded, but `mnemosine outbox` concurrently
    // recovered the row out of 'executing' — the recovered status must
    // survive and the operator must hear about it (log-and-throw, never silent).
    const createManualPolicy = vi.fn(async () => ({ status: 1 }));
    mockGetAdapter.mockReturnValueOnce({ createManualPolicy });
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        id: 'op-1', provider: 'contalink', operation: 'create_policy',
        payload: {}, status: 'executing', ai_reasoning: 'r', result: null, error: null, created_at: new Date(),
      }],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // guard misses
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(executeExternalOp(CTX, 'op-1', 'admin@demo.com')).rejects.toThrow(
      /concurrently recovered.*reconcile the operation manually/s
    );
    expect(createManualPolicy).toHaveBeenCalledTimes(1); // the external write DID land
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledTimes(2); // claim + the missed guarded update, nothing else
    consoleError.mockRestore();
  });

  it("guard miss on the 'failed' transition (rowCount 0): logs, rethrows, leaves the recovery intact", async () => {
    mockGetAdapter.mockReturnValueOnce({
      createManualPolicy: vi.fn(async () => { throw new Error('Contalink rejected the operation'); }),
    });
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{
        id: 'op-1', provider: 'contalink', operation: 'create_policy',
        payload: {}, status: 'executing', ai_reasoning: 'r', result: null, error: null, created_at: new Date(),
      }],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // guard misses
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(executeExternalOp(CTX, 'op-1', 'admin@demo.com')).rejects.toThrow(
      /failed against contalink: Contalink rejected/
    );
    // The failed UPDATE follows the house guarded pattern too.
    const [failSql] = mockQuery.mock.calls[1];
    expect(failSql).toMatch(/SET status = 'failed'/);
    expect(failSql).toMatch(/AND status = 'executing'/);
    expect(failSql).toMatch(/entity_id = \$3/);
    expect(consoleError).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('if the claim loses (already executed by another session), it throws without calling the adapter', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(executeExternalOp(CTX, 'op-1', 'e')).rejects.toThrow(/already executed/);
    expect(mockGetAdapter).not.toHaveBeenCalled();
  });

  it('if the external system fails, marks failed with the error and rethrows', async () => {
    mockGetAdapter.mockReturnValueOnce({
      createManualPolicy: vi.fn(async () => { throw new Error('Contalink rejected the operation'); }),
    });
    mockQuery.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 'op-1', provider: 'contalink', operation: 'create_policy', payload: {}, status: 'executing', ai_reasoning: 'r', result: null, error: null, created_at: new Date() }],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(executeExternalOp(CTX, 'op-1', 'e')).rejects.toThrow(/failed against contalink/);
    const [failSql, failParams] = mockQuery.mock.calls[1];
    expect(failSql).toMatch(/SET status = 'failed'/);
    expect(failParams[0]).toMatch(/rejected/);
  });

  it('rejectExternalOp only rejects pending ops', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(rejectExternalOp(CTX, 'op-9', 'e', 'not applicable')).rejects.toThrow(/pending/);
  });

  const OP_ROW = {
    id: 'op-1', provider: 'contalink', operation: 'create_policy',
    payload: { record_date: '2026-08-24', description: 'x', records: [] },
    status: 'executing', ai_reasoning: 'r', result: null, error: null, created_at: new Date(),
  };

  it('executes when the expected content hash matches the claimed row', async () => {
    const createManualPolicy = vi.fn(async () => ({ status: 1 }));
    mockGetAdapter.mockReturnValueOnce({ createManualPolicy });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [OP_ROW] }); // claim
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // executed

    const expected = canonicalOpHash(OP_ROW.provider, OP_ROW.operation, OP_ROW.payload);
    const { result } = await executeExternalOp(CTX, 'op-1', 'admin@demo.com', expected);
    expect(result).toEqual({ status: 1 });
    expect(createManualPolicy).toHaveBeenCalledTimes(1);
  });

  it('on hash mismatch, reverts the claim to pending and never calls the adapter', async () => {
    // The human reviewed a $100 policy; the row now carries a different payload.
    const reviewedHash = canonicalOpHash('contalink', 'create_policy', { amount: '100.00' });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [OP_ROW] }); // claim
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // revert

    await expect(
      executeExternalOp(CTX, 'op-1', 'admin@demo.com', reviewedHash)
    ).rejects.toThrow(/Operation content changed after review; execution invalidated/);

    expect(mockGetAdapter).not.toHaveBeenCalled();
    // The revert is guarded on OUR executing claim and clears the review stamp.
    const [revertSql, revertParams] = mockQuery.mock.calls[1];
    expect(revertSql).toMatch(/SET status = 'pending'/);
    expect(revertSql).toMatch(/reviewed_by = NULL/);
    expect(revertSql).toMatch(/AND status = 'executing'/);
    expect(revertParams).toEqual(['op-1', CTX.entityId]);
  });

  it('FLOOR: refuses an op queued more than the max age ago (stale approval)', async () => {
    const staleCreatedAt = new Date(Date.now() - (FLOOR_MAX_OP_AGE_DAYS + 1) * 24 * 60 * 60 * 1000);
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...OP_ROW, created_at: staleCreatedAt }] }); // claim
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // reject

    await expect(executeExternalOp(CTX, 'op-1', 'admin@demo.com')).rejects.toThrow(/re-queue/);

    expect(mockGetAdapter).not.toHaveBeenCalled();
    const [rejectSql, rejectParams] = mockQuery.mock.calls[1];
    expect(rejectSql).toMatch(/SET status = 'rejected'/);
    expect(rejectSql).toMatch(/AND status = 'executing'/);
    expect(rejectParams[0]).toMatch(new RegExp(`${FLOOR_MAX_OP_AGE_DAYS} days`));
    expect(rejectParams.slice(1)).toEqual(['op-1', CTX.entityId]);
  });

  it('recoverExecutingOp marks a stranded op failed with a verify note, guarded on executing', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await recoverExecutingOp(CTX, 'op-1', 'admin@demo.com', 'failed');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET status = 'failed'/);
    expect(sql).toMatch(/AND status = 'executing'/);
    expect(params).toEqual([
      'admin@demo.com',
      'interrupted mid-execution; verify in the external system manually',
      'op-1',
      CTX.entityId,
    ]);
  });

  it('recoverExecutingOp returns a stranded op to pending, clearing the review stamp', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await recoverExecutingOp(CTX, 'op-1', 'admin@demo.com', 'pending');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET status = 'pending'/);
    expect(sql).toMatch(/reviewed_by = NULL/);
    expect(sql).toMatch(/reviewed_at = NULL/);
    expect(sql).toMatch(/AND status = 'executing'/);
    expect(params).toEqual(['op-1', CTX.entityId]);
  });

  it('recoverExecutingOp throws when the row is not in executing status', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(recoverExecutingOp(CTX, 'op-9', 'e', 'failed')).rejects.toThrow(/executing/);
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(recoverExecutingOp(CTX, 'op-9', 'e', 'pending')).rejects.toThrow(/executing/);
  });

  it('an op at the age limit still executes (strictly-older-than semantics)', async () => {
    const boundaryCreatedAt = new Date(Date.now() - (FLOOR_MAX_OP_AGE_DAYS - 1) * 24 * 60 * 60 * 1000);
    const createManualPolicy = vi.fn(async () => ({ status: 1 }));
    mockGetAdapter.mockReturnValueOnce({ createManualPolicy });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...OP_ROW, created_at: boundaryCreatedAt }] });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await expect(executeExternalOp(CTX, 'op-1', 'admin@demo.com')).resolves.toBeTruthy();
    expect(createManualPolicy).toHaveBeenCalledTimes(1);
  });
});

describe('autoExecuteOpByPolicy', () => {
  const POLICY = {
    id: 'pol-9',
    entity_id: CTX.entityId,
    scope: 'external_op',
    pattern: { provider: 'contalink', operation: 'create_policy' },
    mode: 'session',
    session_id: 'sess-1',
    created_by: 'admin@demo.com',
    created_at: new Date(),
    last_used_at: null,
    revoked_at: null,
  };

  const PENDING_ROW = {
    id: 'op-1', provider: 'contalink', operation: 'create_policy',
    payload: {
      record_date: '2026-08-24', description: 'x',
      records: [
        { account_code: '5201', debit: 1200, credit: 0 },
        { account_code: '1101', debit: 0, credit: 1200 },
      ],
    },
    status: 'pending', ai_reasoning: 'r', result: null, error: null, created_at: new Date(),
  };

  it('matches on provider/operation/amount and executes via the atomic claim as policy:<id>', async () => {
    const createManualPolicy = vi.fn(async () => ({ status: 1 }));
    mockGetAdapter.mockReturnValueOnce({ createManualPolicy });
    mockQuery.mockResolvedValueOnce({ rows: [PENDING_ROW] }); // pending read
    mockMatchApproval.mockResolvedValueOnce(POLICY);
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...PENDING_ROW, status: 'executing' }] }); // claim
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // executed

    const out = await autoExecuteOpByPolicy(CTX, 'op-1', { sessionId: 'sess-1' });
    expect(out.policyId).toBe('pol-9');
    expect(out.result).toEqual({ status: 1 });

    // The candidate amount is DERIVED from the schema-guaranteed records
    // (max of total debits/credits), never from a free-form payload key.
    expect(mockMatchApproval).toHaveBeenCalledWith(
      CTX, 'external_op',
      { provider: 'contalink', operation: 'create_policy', amount: '1200.00' },
      { sessionId: 'sess-1' }
    );

    // Same atomic pending→executing claim as the human path, attributed
    // to the authorizing policy.
    const [claimSql, claimParams] = mockQuery.mock.calls[1];
    expect(claimSql).toMatch(/SET status = 'executing'/);
    expect(claimSql).toMatch(/AND status = 'pending'/);
    expect(claimParams).toEqual(['policy:pol-9', 'op-1', CTX.entityId]);

    // Hash-bound to the content the policy matched.
    const [doneSql, doneParams] = mockQuery.mock.calls[2];
    expect(doneSql).toMatch(/approved_content_hash/);
    expect(doneParams[1]).toBe(
      canonicalOpHash(PENDING_ROW.provider, PENDING_ROW.operation, PENDING_ROW.payload)
    );
  });

  it('IGNORES an AI-planted top-level amount: the derived amount is what gets matched', async () => {
    // The model claims '1.00' via a free-form payload key while the records
    // move 1200 — the candidate must carry the schema-derived 1200.00.
    const lying = { ...PENDING_ROW, payload: { ...PENDING_ROW.payload, amount: '1.00' } };
    mockQuery.mockResolvedValueOnce({ rows: [lying] }); // pending read
    mockMatchApproval.mockResolvedValueOnce(null);
    await expect(autoExecuteOpByPolicy(CTX, 'op-1')).rejects.toThrow(/No approval policy/);
    expect(mockMatchApproval.mock.calls[0][2]).toEqual({
      provider: 'contalink', operation: 'create_policy', amount: '1200.00',
    });
  });

  it('FAIL CLOSED: refuses auto-approval when no trustworthy amount can be derived', async () => {
    const underivable = [
      // create_policy with empty records — even with a primitive top-level
      // amount planted by the AI (the old bypass), it must be refused.
      { ...PENDING_ROW, payload: { record_date: '2026-08-24', description: 'x', records: [], amount: '1.00' } },
      // records missing entirely, amount nested where the old code ignored it
      { ...PENDING_ROW, payload: { record_date: '2026-08-24', nested: { amount: '1.00' } } },
      // record with a string debit: not schema-trustworthy
      {
        ...PENDING_ROW,
        payload: { records: [{ account_code: '5201', debit: '1200', credit: 0 }] },
      },
      // record with a negative debit
      {
        ...PENDING_ROW,
        payload: { records: [{ account_code: '5201', debit: -5, credit: 0 }] },
      },
      // upload_xml has no monetary schema at all
      { ...PENDING_ROW, operation: 'upload_xml', payload: { xml_base64: 'AAAA', amount: '1.00' } },
      // bank_transaction missing withdrawal
      { ...PENDING_ROW, operation: 'bank_transaction', payload: { bank: 'BBVA', date: '2026-08-24', deposit: 100 } },
      // reconcile_invoice with a string amount (schema says number)
      { ...PENDING_ROW, operation: 'reconcile_invoice', payload: { invoice_id: 'F-1', amount: '250.00' } },
    ];
    for (const row of underivable) {
      mockQuery.mockResolvedValueOnce({ rows: [row] }); // pending read
      await expect(autoExecuteOpByPolicy(CTX, 'op-1')).rejects.toThrow(
        /No trustworthy amount can be derived/
      );
    }
    // Refused BEFORE matching: no policy read/consumed, no claim, no adapter.
    expect(mockMatchApproval).not.toHaveBeenCalled();
    expect(mockGetAdapter).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(underivable.length); // pending reads only
  });

  it('derives bank_transaction amounts from deposit + withdrawal', async () => {
    const row = {
      ...PENDING_ROW, operation: 'bank_transaction',
      payload: { bank: 'BBVA', date: '2026-08-24', deposit: 500.25, withdrawal: 0, reference: 'ref-1' },
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    mockMatchApproval.mockResolvedValueOnce(null);
    await expect(autoExecuteOpByPolicy(CTX, 'op-1')).rejects.toThrow(/No approval policy/);
    expect(mockMatchApproval.mock.calls[0][2]).toEqual({
      provider: 'contalink', operation: 'bank_transaction', amount: '500.25',
    });
  });

  it('derives reconcile_invoice amounts from the schema-typed numeric amount field', async () => {
    const row = {
      ...PENDING_ROW, operation: 'reconcile_invoice',
      payload: { invoice_id: 'F-1', amount: 250.5, bank_account: 'x', payment_date: '2026-08-24', payment_form: '03' },
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    mockMatchApproval.mockResolvedValueOnce(null);
    await expect(autoExecuteOpByPolicy(CTX, 'op-1')).rejects.toThrow(/No approval policy/);
    expect(mockMatchApproval.mock.calls[0][2]).toEqual({
      provider: 'contalink', operation: 'reconcile_invoice', amount: '250.50',
    });
  });

  it('throws without claiming when no policy authorizes the operation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [PENDING_ROW] }); // pending read
    mockMatchApproval.mockResolvedValueOnce(null);
    await expect(autoExecuteOpByPolicy(CTX, 'op-1')).rejects.toThrow(/No approval policy/);
    expect(mockGetAdapter).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1); // only the pending read, no claim
  });

  it('throws when the operation is not pending, before matching', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(autoExecuteOpByPolicy(CTX, 'op-9')).rejects.toThrow(/No pending operation/);
    expect(mockMatchApproval).not.toHaveBeenCalled();
  });

  it('reverts the claim when the row drifted after the policy matched (hash binding)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [PENDING_ROW] }); // pending read (matched content)
    mockMatchApproval.mockResolvedValueOnce(POLICY);
    const drifted = { ...PENDING_ROW, payload: { ...PENDING_ROW.payload, amount: '99999.00' } };
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ ...drifted, status: 'executing' }] }); // claim
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // revert

    await expect(autoExecuteOpByPolicy(CTX, 'op-1')).rejects.toThrow(
      /Operation content changed after review; execution invalidated/
    );
    expect(mockGetAdapter).not.toHaveBeenCalled();
    const [revertSql] = mockQuery.mock.calls[2];
    expect(revertSql).toMatch(/SET status = 'pending'/);
  });
});

describe('canonicalOpHash', () => {
  it('is a 64-char sha256 hex, independent of key insertion order (nested too)', () => {
    const a = canonicalOpHash('contalink', 'create_policy', {
      record_date: '2026-08-24', records: [{ debit: '100.00', account: '5201' }],
    });
    const b = canonicalOpHash('contalink', 'create_policy', {
      records: [{ account: '5201', debit: '100.00' }], record_date: '2026-08-24',
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('changes when provider, operation or payload change', () => {
    const base = canonicalOpHash('contalink', 'create_policy', { x: 1 });
    expect(canonicalOpHash('other', 'create_policy', { x: 1 })).not.toBe(base);
    expect(canonicalOpHash('contalink', 'update_policy', { x: 1 })).not.toBe(base);
    expect(canonicalOpHash('contalink', 'create_policy', { x: 2 })).not.toBe(base);
  });

  it('array order stays material (journal records are ordered)', () => {
    const ab = canonicalOpHash('c', 'create_policy', { records: ['a', 'b'] });
    const ba = canonicalOpHash('c', 'create_policy', { records: ['b', 'a'] });
    expect(ab).not.toBe(ba);
  });
});
