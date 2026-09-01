import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn() }));

import {
  grantApproval,
  revokeApproval,
  listApprovals,
  matchApproval,
  effectiveApprovalCap,
  type ApprovalCandidate,
  type ApprovalPolicyRow,
} from '../../src/ai/approval-policy.js';
import { FLOOR_MAX_AUTO_POST } from '../../src/ai/floor.js';
import { query } from '../../src/database/connection.js';
import type { AgentContext } from '../../src/ai/context.js';

const mockQuery = query as unknown as Mock;

const CTX: AgentContext = {
  entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  entityName: 'Acme MX',
  tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'AME010101AAA',
};

function policyRow(over: Partial<ApprovalPolicyRow> = {}): ApprovalPolicyRow {
  return {
    id: 'pol-1',
    entity_id: CTX.entityId,
    scope: 'draft',
    pattern: {},
    mode: 'always',
    session_id: null,
    created_by: 'admin@demo.com',
    created_at: new Date(),
    last_used_at: null,
    revoked_at: null,
    ...over,
  };
}

/** Queues the SELECT of live policies + the guarded touch/consume UPDATE. */
function mockPolicies(rows: ApprovalPolicyRow[], touchRowCount = 1) {
  mockQuery.mockResolvedValueOnce({ rows });
  mockQuery.mockResolvedValueOnce({ rowCount: touchRowCount, rows: [] });
}

beforeEach(() => mockQuery.mockReset());

describe('effectiveApprovalCap', () => {
  it('is the floor when no limit is provided', () => {
    expect(effectiveApprovalCap()).toBe(FLOOR_MAX_AUTO_POST);
    expect(effectiveApprovalCap(undefined, undefined)).toBe(FLOOR_MAX_AUTO_POST);
  });

  it('combines every limit with the floor via Math.min (strictest wins)', () => {
    expect(effectiveApprovalCap(25000)).toBe(25000);
    expect(effectiveApprovalCap(25000, 10000)).toBe(10000);
    expect(effectiveApprovalCap(10000, 25000)).toBe(10000);
    // Nothing raises the floor: a limit above it is clamped.
    expect(effectiveApprovalCap(FLOOR_MAX_AUTO_POST + 1)).toBe(FLOOR_MAX_AUTO_POST);
    expect(effectiveApprovalCap(1e12, 1e12)).toBe(FLOOR_MAX_AUTO_POST);
  });

  it('fails CLOSED (cap 0) on non-finite or negative limits', () => {
    expect(effectiveApprovalCap(Number.NaN)).toBe(0);
    expect(effectiveApprovalCap(Number.POSITIVE_INFINITY)).toBe(0);
    expect(effectiveApprovalCap(-1)).toBe(0);
    expect(effectiveApprovalCap(25000, Number.NaN)).toBe(0);
  });
});

describe('grantApproval', () => {
  it('inserts a policy scoped to tenant and entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const id = await grantApproval(CTX, {
      scope: 'draft',
      pattern: { kind: 'payroll', max_amount: '25000' },
      mode: 'always',
      grantedBy: 'admin@demo.com',
    });
    expect(id).toMatch(/[0-9a-f-]{36}/);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO ai_approval_policies/);
    expect(params[1]).toBe(CTX.tenantId);
    expect(params[2]).toBe(CTX.entityId);
    expect(params[3]).toBe('draft');
    expect(JSON.parse(params[4] as string)).toEqual({ kind: 'payroll', max_amount: '25000' });
    expect(params[5]).toBe('always');
    expect(params[6]).toBeNull(); // no session id outside 'session' mode
    expect(params[7]).toBe('admin@demo.com');
  });

  it("stores the granting session id for 'session' mode and requires it", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await grantApproval(CTX, {
      scope: 'external_op',
      pattern: { provider: 'contalink' },
      mode: 'session',
      grantedBy: 'admin@demo.com',
      sessionId: 'sess-1',
    });
    expect(mockQuery.mock.calls[0][1][6]).toBe('sess-1');

    await expect(
      grantApproval(CTX, {
        scope: 'external_op',
        pattern: { provider: 'contalink' },
        mode: 'session',
        grantedBy: 'admin@demo.com',
      })
    ).rejects.toThrow(/session id/);
    expect(mockQuery).toHaveBeenCalledTimes(1); // the invalid grant never inserted
  });

  it("rejects a session id on non-session modes instead of silently ignoring it", async () => {
    // Silently dropping --session would grant BROADER authority than asked
    // for (an 'always' policy valid in every session) — refuse loudly.
    for (const mode of ['once', 'always'] as const) {
      await expect(
        grantApproval(CTX, {
          scope: 'draft',
          pattern: { kind: 'journal_entry' },
          mode,
          grantedBy: 'admin@demo.com',
          sessionId: 'sess-1',
        })
      ).rejects.toThrow(/--session only applies to --mode session/);
    }
    expect(mockQuery).not.toHaveBeenCalled(); // nothing was ever inserted
  });

  it('rejects a non-numeric max_amount before inserting', async () => {
    await expect(
      grantApproval(CTX, {
        scope: 'draft',
        pattern: { max_amount: 'lots' },
        mode: 'once',
        grantedBy: 'admin@demo.com',
      })
    ).rejects.toThrow(/not a valid numeric string/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('revokeApproval', () => {
  it('revokes with a guarded UPDATE on revoked_at IS NULL', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await revokeApproval(CTX, 'pol-1');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/SET revoked_at = NOW\(\)/);
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(params).toEqual(['pol-1', CTX.entityId]);
  });

  it('throws when no active policy matches (rowCount 0)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(revokeApproval(CTX, 'pol-x')).rejects.toThrow(/No active approval policy/);
  });
});

describe('listApprovals', () => {
  it('lists live policies of the entity by default, optionally by scope', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [policyRow()] });
    const rows = await listApprovals(CTX, { scope: 'draft' });
    expect(rows).toHaveLength(1);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/entity_id = \$1/);
    expect(sql).toMatch(/scope = \$2/);
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(params).toEqual([CTX.entityId, 'draft']);
  });

  it('includes revoked policies only when asked', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listApprovals(CTX, { includeRevoked: true });
    expect(mockQuery.mock.calls[0][0]).not.toMatch(/revoked_at IS NULL/);
  });
});

describe('matchApproval — pattern semantics', () => {
  it('selects only live policies of the entity and scope', async () => {
    mockPolicies([policyRow()]);
    await matchApproval(CTX, 'draft', { kind: 'journal_entry', amount: '10.00' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM ai_approval_policies/);
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(params).toEqual([CTX.entityId, 'draft']);
  });

  it('an unspecified pattern field is a wildcard', async () => {
    // Pattern only pins the provider; kind/operation/amount are free.
    mockPolicies([policyRow({ scope: 'external_op', pattern: { provider: 'contalink' } })]);
    const match = await matchApproval(CTX, 'external_op', {
      provider: 'contalink',
      operation: 'create_policy',
      amount: '100.00',
    });
    expect(match?.id).toBe('pol-1');
  });

  it('rejects when a specified field differs or is missing on the candidate', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [policyRow({ pattern: { kind: 'payroll' } })],
    });
    expect(await matchApproval(CTX, 'draft', { kind: 'journal_entry', amount: '10.00' })).toBeNull();

    mockQuery.mockResolvedValueOnce({
      rows: [policyRow({ pattern: { kind: 'payroll' } })],
    });
    // Candidate lacks the field the pattern specifies: conservative mismatch.
    expect(await matchApproval(CTX, 'draft', { amount: '10.00' })).toBeNull();
  });

  it('compares string amounts numerically, not lexicographically', async () => {
    // Lexicographically '9999.99' > '25000'; numerically it is well under.
    mockPolicies([policyRow({ pattern: { max_amount: '25000' } })]);
    expect((await matchApproval(CTX, 'draft', { amount: '9999.99' }))?.id).toBe('pol-1');

    mockQuery.mockResolvedValueOnce({ rows: [policyRow({ pattern: { max_amount: '25000' } })] });
    expect(await matchApproval(CTX, 'draft', { amount: '25000.01' })).toBeNull();
  });

  it('fails closed on unparseable amounts', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [policyRow({ pattern: { max_amount: '25000' } })] });
    expect(await matchApproval(CTX, 'draft', { amount: 'a lot' })).toBeNull();
  });
});

describe('matchApproval — FAIL CLOSED on the candidate amount (both scopes)', () => {
  // No trustworthy amount, no authorization: matching is refused BEFORE
  // any policy is even read, so the FLOOR_MAX_AUTO_POST gate can never be
  // skipped by omitting, nesting, or garbling the amount.
  const cases: Array<[string, unknown]> = [
    ['missing amount', undefined],
    ['nested/object amount', { value: '10.00' }],
    ['array amount', ['10.00']],
    ['string junk amount', 'ten pesos'],
    ['negative amount', '-1'],
    ['NaN amount', Number.NaN],
    ['boolean amount', true],
  ];

  for (const scope of ['draft', 'external_op'] as const) {
    for (const [label, amount] of cases) {
      it(`refuses a candidate with ${label} without touching a policy (scope ${scope})`, async () => {
        const candidate: Record<string, unknown> = { kind: 'journal_entry' };
        if (amount !== undefined) candidate.amount = amount;
        expect(await matchApproval(CTX, scope, candidate as ApprovalCandidate)).toBeNull();
        // Fail closed at the door: no SELECT, no touch, no consume.
        expect(mockQuery).not.toHaveBeenCalled();
      });
    }
  }
});

describe('matchApproval — strictest wins (config vs policy vs floor)', () => {
  it('config lower than policy: the config cap decides', async () => {
    const policies = [policyRow({ pattern: { max_amount: '40000' } })];
    mockQuery.mockResolvedValueOnce({ rows: policies });
    expect(await matchApproval(CTX, 'draft', { amount: '500' }, { configuredMaxAmount: 100 })).toBeNull();

    mockPolicies(policies);
    expect(
      (await matchApproval(CTX, 'draft', { amount: '99' }, { configuredMaxAmount: 100 }))?.id
    ).toBe('pol-1');
  });

  it('policy lower than config: the policy cap decides', async () => {
    const policies = [policyRow({ pattern: { max_amount: '100' } })];
    mockQuery.mockResolvedValueOnce({ rows: policies });
    expect(
      await matchApproval(CTX, 'draft', { amount: '500' }, { configuredMaxAmount: 40000 })
    ).toBeNull();

    mockPolicies(policies);
    expect(
      (await matchApproval(CTX, 'draft', { amount: '100' }, { configuredMaxAmount: 40000 }))?.id
    ).toBe('pol-1');
  });

  it('the FLOOR always caps: even a permissive policy + config cannot authorize above it', async () => {
    const generous = [policyRow({ pattern: { max_amount: '1000000' } })];
    mockQuery.mockResolvedValueOnce({ rows: generous });
    expect(
      await matchApproval(
        CTX,
        'draft',
        { amount: String(FLOOR_MAX_AUTO_POST + 1) },
        { configuredMaxAmount: 1000000 }
      )
    ).toBeNull();

    mockPolicies(generous);
    expect(
      (
        await matchApproval(
          CTX,
          'draft',
          { amount: String(FLOOR_MAX_AUTO_POST) },
          { configuredMaxAmount: 1000000 }
        )
      )?.id
    ).toBe('pol-1');
  });

  it('a candidate amount is floor-capped even when the pattern has no max_amount', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [policyRow({ pattern: {} })] });
    expect(await matchApproval(CTX, 'draft', { amount: String(FLOOR_MAX_AUTO_POST + 1) })).toBeNull();
  });
});

describe('matchApproval — modes and races', () => {
  it("consumes a 'once' policy atomically (guarded UPDATE setting revoked_at)", async () => {
    mockPolicies([policyRow({ mode: 'once' })]);
    const match = await matchApproval(CTX, 'draft', { amount: '10.00' });
    expect(match?.id).toBe('pol-1');
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).toMatch(/SET revoked_at = NOW\(\), last_used_at = NOW\(\)/);
    expect(sql).toMatch(/revoked_at IS NULL/);
    expect(params).toEqual(['pol-1', CTX.entityId]);
  });

  it("a lost 'once' race (rowCount 0) is NOT a match", async () => {
    // Another session consumed the policy between our read and the update.
    mockPolicies([policyRow({ mode: 'once' })], 0);
    expect(await matchApproval(CTX, 'draft', { amount: '10.00' })).toBeNull();
  });

  it("touches last_used_at on 'always' matches, still guarded on revoked_at", async () => {
    mockPolicies([policyRow({ mode: 'always' })]);
    await matchApproval(CTX, 'draft', { amount: '10.00' });
    const [sql] = mockQuery.mock.calls[1];
    expect(sql).toMatch(/SET last_used_at = NOW\(\)/);
    expect(sql).not.toMatch(/SET revoked_at/);
    expect(sql).toMatch(/revoked_at IS NULL/);
  });

  it('a concurrently revoked winner (rowCount 0 on the touch) is NOT a match', async () => {
    mockPolicies([policyRow({ mode: 'always' })], 0);
    expect(await matchApproval(CTX, 'draft', { amount: '10.00' })).toBeNull();
  });

  it("a 'session' policy matches only its own session", async () => {
    const sessionPolicy = [policyRow({ mode: 'session', session_id: 'sess-1' })];
    mockQuery.mockResolvedValueOnce({ rows: sessionPolicy });
    expect(await matchApproval(CTX, 'draft', { amount: '10' })).toBeNull(); // no session at all

    mockQuery.mockResolvedValueOnce({ rows: sessionPolicy });
    expect(await matchApproval(CTX, 'draft', { amount: '10' }, { sessionId: 'sess-2' })).toBeNull();

    mockPolicies(sessionPolicy);
    expect((await matchApproval(CTX, 'draft', { amount: '10' }, { sessionId: 'sess-1' }))?.id).toBe('pol-1');
  });

  it("prefers a non-consuming 'always' over an older 'once' (the one-shot is not spent)", async () => {
    const older = new Date('2026-01-01');
    const newer = new Date('2026-06-01');
    mockQuery.mockResolvedValueOnce({
      rows: [
        policyRow({ id: 'pol-once', mode: 'once', created_at: older }),
        policyRow({ id: 'pol-always', mode: 'always', created_at: newer }),
      ],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // touch of pol-always
    const match = await matchApproval(CTX, 'draft', { amount: '10.00' });
    expect(match?.id).toBe('pol-always');
    // The winner is only TOUCHED — the 'once' grant survives for the
    // narrow candidate it was meant for.
    const [sql, params] = mockQuery.mock.calls[1];
    expect(sql).not.toMatch(/SET revoked_at/);
    expect(params[0]).toBe('pol-always');
  });

  it("prefers 'session' (own session) over an older 'once'", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        policyRow({ id: 'pol-once', mode: 'once', created_at: new Date('2026-01-01') }),
        policyRow({
          id: 'pol-session', mode: 'session', session_id: 'sess-1', created_at: new Date('2026-06-01'),
        }),
      ],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const match = await matchApproval(CTX, 'draft', { amount: '10.00' }, { sessionId: 'sess-1' });
    expect(match?.id).toBe('pol-session');
    expect(mockQuery.mock.calls[1][0]).not.toMatch(/SET revoked_at/);
  });

  it("prefers 'always' over 'session' when both match", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        policyRow({
          id: 'pol-session', mode: 'session', session_id: 'sess-1', created_at: new Date('2026-01-01'),
        }),
        policyRow({ id: 'pol-always', mode: 'always', created_at: new Date('2026-06-01') }),
      ],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const match = await matchApproval(CTX, 'draft', { amount: '10.00' }, { sessionId: 'sess-1' });
    expect(match?.id).toBe('pol-always');
  });

  it("falls through to a 'once' only when no standing policy covers the candidate", async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        policyRow({ id: 'pol-once', mode: 'once', created_at: new Date('2026-01-01') }),
        policyRow({
          id: 'pol-always-narrow', mode: 'always',
          pattern: { kind: 'payroll' }, created_at: new Date('2026-06-01'),
        }),
      ],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // consume of pol-once
    const match = await matchApproval(CTX, 'draft', { kind: 'journal_entry', amount: '10.00' });
    expect(match?.id).toBe('pol-once');
    expect(mockQuery.mock.calls[1][0]).toMatch(/SET revoked_at = NOW\(\)/);
  });

  it('within the same mode, the OLDEST policy wins (created_at ASC)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        policyRow({ id: 'pol-new', mode: 'once', created_at: new Date('2026-06-01') }),
        policyRow({ id: 'pol-old', mode: 'once', created_at: new Date('2026-01-01') }),
      ],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const match = await matchApproval(CTX, 'draft', { amount: '10.00' });
    expect(match?.id).toBe('pol-old');
  });

  it('a losing policy does not stop the search: the next one can still match', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        policyRow({ id: 'pol-strict', pattern: { max_amount: '5' } }),
        policyRow({ id: 'pol-open', pattern: { max_amount: '25000' } }),
      ],
    });
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // touch of pol-open
    const match = await matchApproval(CTX, 'draft', { amount: '100.00' });
    expect(match?.id).toBe('pol-open');
    expect(mockQuery.mock.calls[1][1][0]).toBe('pol-open');
  });
});
