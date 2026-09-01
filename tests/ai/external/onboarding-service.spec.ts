import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/services/integrations/accounting/registry.js', () => ({
  getExternalAdapter: vi.fn(),
}));
vi.mock('../../../src/ai/draft-service.js', async (orig) => {
  const real = await orig<typeof import('../../../src/ai/draft-service.js')>();
  return { ...real, createDraft: vi.fn(), approveDraft: vi.fn() };
});

import { inferAccountType, planOnboarding, executeOnboarding } from '../../../src/ai/onboarding-service.js';
import { query } from '../../../src/database/connection.js';
import { getExternalAdapter } from '../../../src/services/integrations/accounting/registry.js';
import { createDraft, approveDraft } from '../../../src/ai/draft-service.js';
import type { AgentContext } from '../../../src/ai/context.js';

const mockQuery = query as unknown as Mock;
const mockAdapter = getExternalAdapter as unknown as Mock;
const mockCreateDraft = createDraft as unknown as Mock;
const mockApprove = approveDraft as unknown as Mock;

const CTX: AgentContext = {
  entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  entityName: 'Cliente Nuevo SA', tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'CNU010101AAA',
};
const REVIEWER = { userId: 'user-1', email: 'admin@demo.com' };

beforeEach(() => {
  mockQuery.mockReset();
  mockAdapter.mockReset();
  mockCreateDraft.mockReset();
  mockApprove.mockReset();
});

describe('inferAccountType (MX grouping code)', () => {
  it('maps the first digit to type/normal balance', () => {
    expect(inferAccountType('102-01')).toEqual({ account_type: 'asset', normal_balance: 'debit', confident: true });
    expect(inferAccountType('201-01')).toEqual({ account_type: 'liability', normal_balance: 'credit', confident: true });
    expect(inferAccountType('3200')).toEqual({ account_type: 'equity', normal_balance: 'credit', confident: true });
    expect(inferAccountType('401')).toEqual({ account_type: 'revenue', normal_balance: 'credit', confident: true });
    expect(inferAccountType('601-84')).toEqual({ account_type: 'expense', normal_balance: 'debit', confident: true });
    expect(inferAccountType('702-99').confident).toBe(false);
    expect(inferAccountType('XYZ').confident).toBe(false);
  });
});

describe('planOnboarding', () => {
  const REMOTE = [
    { account_code: '102-01', account_name: 'Bancos', period_debits: 0, period_credits: 0, ending_balance: 1000.505 },
    { account_code: '201-01', account_name: 'Proveedores', period_debits: 0, period_credits: 0, ending_balance: -400 },
    { account_code: '601-84', account_name: 'Gastos', period_debits: 0, period_credits: 0, ending_balance: 0 }, // zeroed
    { account_code: '102-01', account_name: 'Duplicada', period_debits: 0, period_credits: 0, ending_balance: 99 }, // dup
  ];

  it('classifies accounts to create, builds the opening balance with signs and detects imbalance', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '0' }] }); // idempotency (posted entries)
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '0' }] }); // idempotency (pending drafts)
    mockAdapter.mockReturnValueOnce({ getTrialBalance: vi.fn(async () => REMOTE) });
    mockQuery.mockResolvedValueOnce({ rows: [{ code: '201-01' }] }); // local chart of accounts

    const plan = await planOnboarding(CTX, 'contalink', '2026-01-01', '2026-07-31');
    expect(plan.reference).toBe('onboarding:contalink:2026-07-31');
    expect(plan.accountsToCreate.map((a) => a.code)).toEqual(['102-01', '601-84']);
    expect(plan.existingAccounts).toBe(1);
    // debit balance → debit (rounded to 2), credit balance → credit; zeros and duplicates excluded
    expect(plan.openingLines).toEqual([
      { account_code: '102-01', debit: 1000.51, description: 'Opening balance Bancos' },
      { account_code: '201-01', credit: 400, description: 'Opening balance Proveedores' },
    ]);
    expect(plan.totals).toEqual({ debits: '1000.51', credits: '400.00', imbalance: '600.51' });
    expect(plan.needsBalancingAccount).toBe(true);
  });

  it('rejects re-importing if the opening balance already exists (idempotency by reference)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '1' }] });
    await expect(planOnboarding(CTX, 'contalink', '2026-01-01', '2026-07-31')).rejects.toThrow(/already exists/);
    expect(mockAdapter).not.toHaveBeenCalled();
  });

  it('rejects re-importing while an opening-balance draft is pending review', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '0' }] }); // no posted entry yet
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '1' }] }); // but a draft awaits review
    await expect(planOnboarding(CTX, 'contalink', '2026-01-01', '2026-07-31'))
      .rejects.toThrow(/pending review/);
    expect(mockAdapter).not.toHaveBeenCalled();
    // the draft check matches on the payload reference, scoped to the entity
    const [sql, params] = mockQuery.mock.calls[1];
    expect(String(sql)).toMatch(/payload->>'reference'/);
    expect(params).toEqual([CTX.entityId, 'onboarding:contalink:2026-07-31']);
  });
});

describe('executeOnboarding', () => {
  const PLAN = {
    provider: 'contalink', startDate: '2026-01-01', cutoffDate: '2026-07-31',
    reference: 'onboarding:contalink:2026-07-31',
    remoteAccounts: 2, existingAccounts: 0,
    accountsToCreate: [
      { code: '102-01', name: 'Bancos', account_type: 'asset', normal_balance: 'debit' as const, confident: true },
    ],
    openingLines: [
      { account_code: '102-01', debit: 1000.5, description: 'Opening balance Bancos' },
      { account_code: '201-01', credit: 400, description: 'Opening balance Proveedores' },
    ],
    totals: { debits: '1000.50', credits: '400.00', imbalance: '600.50' },
    needsBalancingAccount: true,
  };

  it('requires a balancing account when there is an imbalance', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // account insert
    await expect(executeOnboarding(CTX, PLAN, REVIEWER, {})).rejects.toThrow(/--balance-account/);
    expect(mockCreateDraft).not.toHaveBeenCalled();
  });

  it('creates missing accounts, adds the balancing line on the correct side and leaves a draft', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // remote account
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // balancing account (fresh entity)
    mockCreateDraft.mockResolvedValueOnce({ id: 'draft-9', totalDebits: '1000.50', totalCredits: '1000.50' });

    const result = await executeOnboarding(CTX, PLAN, REVIEWER, { balanceAccountCode: '3200' });
    expect(result).toEqual({ accountsCreated: 2, draftId: 'draft-9' });
    expect(mockApprove).not.toHaveBeenCalled();

    // Account created with inferred type and attribution
    const [insertSql, insertParams] = mockQuery.mock.calls[0];
    expect(insertSql).toMatch(/INSERT INTO accounts/);
    expect(insertSql).toMatch(/WHERE NOT EXISTS/);
    expect(insertParams.slice(1, 6)).toEqual(['102-01', 'Bancos', 'asset', 'debit', CTX.entityId]);
    expect(insertParams[6]).toBe(REVIEWER.userId);

    // Debit imbalance (600.50) → CREDIT to the balancing account
    const payload = mockCreateDraft.mock.calls[0][1].payload;
    expect(payload.reference).toBe(PLAN.reference);
    expect(payload.lines[2]).toEqual({
      account_code: '3200', credit: 600.5, description: 'Opening balancing (contalink)',
    });
    expect(mockCreateDraft.mock.calls[0][1].confidence).toBe(1);
  });

  it('with postNow approves the draft via the single path (approveDraft)', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // account already existed (race)
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] }); // balancing account already existed
    mockCreateDraft.mockResolvedValueOnce({ id: 'draft-9', totalDebits: 'x', totalCredits: 'x' });
    mockApprove.mockResolvedValueOnce({ entryId: 'je-1', entryNumber: 'JE-2026-00100' });

    const result = await executeOnboarding(CTX, PLAN, REVIEWER, { balanceAccountCode: '3200', postNow: true });
    expect(result.accountsCreated).toBe(0);
    expect(result.entryNumber).toBe('JE-2026-00100');
    expect(mockApprove).toHaveBeenCalledWith(CTX, 'draft-9', REVIEWER, expect.stringMatching(/onboarding/));
  });
});
