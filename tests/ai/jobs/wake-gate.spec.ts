import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(), enterTenant: vi.fn(), currentTenant: vi.fn(),
}));

import { checkForWork } from '../../../src/ai/jobs/wake-gate.js';
import { query } from '../../../src/database/connection.js';
import type { AgentContext } from '../../../src/ai/context.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

const CTX: AgentContext = {
  entityId: 'entity-1', entityName: 'Acme', tenantId: 'tenant-a',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA',
};

beforeEach(() => {
  mockQuery.mockReset();
});

describe('checkForWork · close_verification', () => {
  it('scopes every detection query to the entity, counts with count(*) and suppresses already-drafted entries', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await checkForWork(CTX, 'close_verification');
    // count + sample for unbalanced entries, count + sample for overdue periods
    expect(mockQuery).toHaveBeenCalledTimes(4);
    for (const [sql, params] of mockQuery.mock.calls) {
      expect(sql).toMatch(/entity_id = \$1/);
      expect(params).toEqual(['entity-1']);
    }
    const [entriesCountSql] = mockQuery.mock.calls[0];
    expect(entriesCountSql).toMatch(/count\(\*\)::text AS total/);
    expect(entriesCountSql).toMatch(/total_debits <> total_credits/);
    expect(entriesCountSql).toMatch(/status IN \('draft', 'pending_approval'\)/);
    expect(entriesCountSql).not.toMatch(/LIMIT/); // the total is never sample-capped
    // Already-staged suppression: entries whose entry_number appears in a
    // pending_review draft reference must not wake the agent again.
    expect(entriesCountSql).toMatch(/NOT EXISTS/);
    expect(entriesCountSql).toMatch(/FROM ai_drafts d/);
    expect(entriesCountSql).toMatch(/d\.status = 'pending_review'/);
    expect(entriesCountSql).toMatch(/position\(journal_entries\.entry_number IN COALESCE\(d\.payload->>'reference', ''\)\) > 0/);

    const [entriesSampleSql] = mockQuery.mock.calls[1];
    expect(entriesSampleSql).toMatch(/LIMIT 5/); // LIMIT only caps the sample ids
    expect(entriesSampleSql).toMatch(/NOT EXISTS/); // same predicate as the count

    const [periodsCountSql] = mockQuery.mock.calls[2];
    expect(periodsCountSql).toMatch(/count\(\*\)::text AS total/);
    expect(periodsCountSql).toMatch(/end_date < CURRENT_DATE/);
    expect(periodsCountSql).toMatch(/status IN \('open', 'soft_close'\)/);
    expect(periodsCountSql).not.toMatch(/LIMIT/);
    const [periodsSampleSql] = mockQuery.mock.calls[3];
    expect(periodsSampleSql).toMatch(/LIMIT 5/);
  });

  it('no findings → hasWork false', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const gate = await checkForWork(CTX, 'close_verification');
    expect(gate.hasWork).toBe(false);
    expect(gate.counts).toEqual({ unbalanced_entries: 0, overdue_open_periods: 0 });
  });

  it('findings → hasWork true with counts and sample ids in the context', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'je-1', entry_number: 'JE-001' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'fp-1', period_name: 'July 2026' }] });
    const gate = await checkForWork(CTX, 'close_verification');
    expect(gate.hasWork).toBe(true);
    expect(gate.context).toMatch(/1 unbalanced non-posted journal entries/);
    expect(gate.context).toMatch(/JE-001/);
    expect(gate.context).toMatch(/July 2026/);
    expect(gate.sampleIds).toEqual(['je-1', 'fp-1']);
  });

  it('reports totals from count(*), not the sample-capped row count', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '42' }] }); // real total
    mockQuery.mockResolvedValueOnce({
      rows: Array.from({ length: 5 }, (_, i) => ({ id: `je-${i}`, entry_number: `JE-00${i}` })),
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const gate = await checkForWork(CTX, 'close_verification');
    expect(gate.counts.unbalanced_entries).toBe(42); // not 5
    expect(gate.context).toMatch(/42 unbalanced non-posted journal entries/);
    expect(gate.sampleIds).toHaveLength(5);
  });
});

describe('checkForWork · cfdi_reconciliation', () => {
  it('counts xml_documents without a journal entry, entity-scoped', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '3' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'xd-1', cfdi_uuid: 'AAAA-1111' }, { id: 'xd-2', cfdi_uuid: 'BBBB-2222' }],
    });
    const gate = await checkForWork(CTX, 'cfdi_reconciliation');
    expect(gate.hasWork).toBe(true);
    expect(gate.counts).toEqual({ unreconciled_cfdis: 3 });
    expect(gate.context).toMatch(/3 CFDI XML documents without a matching journal entry/);
    expect(gate.context).toMatch(/AAAA-1111/);
    const [countSql, countParams] = mockQuery.mock.calls[0];
    expect(countSql).toMatch(/FROM xml_documents xd/);
    expect(countSql).toMatch(/LEFT JOIN pre_registrations pr ON pr\.xml_document_id = xd\.id/);
    expect(countSql).toMatch(/xd\.entity_id = \$1/);
    expect(countSql).toMatch(/pr\.journal_entry_id IS NULL/);
    expect(countParams).toEqual(['entity-1']);
  });

  it('excludes terminally-rejected documents and documents with a pending staged draft', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await checkForWork(CTX, 'cfdi_reconciliation');
    for (const [sql] of mockQuery.mock.calls) {
      // Pipeline-terminal statuses can never reconcile — never wake for them.
      expect(sql).toMatch(/xd\.processing_status NOT IN \('rejected', 'error'\)/);
      // Already-staged suppression: a pending_review draft whose reference
      // carries this CFDI UUID means the work is already staged for review.
      expect(sql).toMatch(/NOT EXISTS/);
      expect(sql).toMatch(/FROM ai_drafts d/);
      expect(sql).toMatch(/d\.status = 'pending_review'/);
      expect(sql).toMatch(/position\(xd\.cfdi_uuid IN COALESCE\(d\.payload->>'reference', ''\)\) > 0/);
    }
  });

  it('everything reconciled → hasWork false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const gate = await checkForWork(CTX, 'cfdi_reconciliation');
    expect(gate.hasWork).toBe(false);
    expect(gate.counts.unreconciled_cfdis).toBe(0);
  });
});

describe('checkForWork · ar_reminders', () => {
  it('counts overdue open-balance invoices, entity-scoped', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '2', amount: '15000.0000' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'inv-1', invoice_number: 'F-100' }, { id: 'inv-2', invoice_number: 'F-101' }],
    });
    const gate = await checkForWork(CTX, 'ar_reminders');
    expect(gate.hasWork).toBe(true);
    expect(gate.counts).toEqual({ overdue_invoices: 2 });
    expect(gate.context).toMatch(/2 overdue AR invoices/);
    expect(gate.context).toMatch(/15000.0000 MXN/);
    expect(gate.context).toMatch(/F-100/);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/FROM invoices/);
    expect(sql).toMatch(/entity_id = \$1/);
    expect(sql).toMatch(/due_date < CURRENT_DATE/);
    expect(sql).toMatch(/amount_due > 0/);
    expect(sql).toMatch(/status IN \('pending', 'sent', 'viewed', 'partially_paid', 'overdue'\)/);
    expect(params).toEqual(['entity-1']);
  });

  it('nothing overdue → hasWork false', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0', amount: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const gate = await checkForWork(CTX, 'ar_reminders');
    expect(gate.hasWork).toBe(false);
  });
});
