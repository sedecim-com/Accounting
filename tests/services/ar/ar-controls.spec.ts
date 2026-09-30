import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
// Spied, not replaced: the real report-layer queries run against the mocked
// connection, and the spies prove the reconciliation reads them (T14 · #101).
vi.mock('../../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/reporting/report-service.js')>();
  return {
    ...real,
    queryAccountBalance: vi.fn(real.queryAccountBalance),
    queryEntryMovementsOnAccount: vi.fn(real.queryEntryMovementsOnAccount),
  };
});

import { arReconcile, runArChecks } from '../../../src/services/ar/ar-controls.js';
import { query } from '../../../src/database/connection.js';
import {
  queryAccountBalance,
  queryEntryMovementsOnAccount,
} from '../../../src/services/reporting/report-service.js';

const mockQuery = query as unknown as Mock;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');

beforeEach(() => {
  mockQuery.mockReset();
  vi.mocked(queryAccountBalance).mockClear();
  vi.mocked(queryEntryMovementsOnAccount).mockClear();
});

// The database-backed proof lives in tests/integration/ar-probes-honest.int.spec.ts;
// these pin the same two contracts where no Postgres is available.

describe('duplicate-invoice', () => {
  it('reports the window total, not the length of the five-row sample', async () => {
    const sample = Array.from({ length: 5 }, (_, i) => ({
      folios: `INV-${i}a, INV-${i}b`,
      total_amount: '100.00',
      total: 40,
    }));
    mockQuery.mockResolvedValueOnce({ rows: sample });

    const { results } = await runArChecks(ENTITY, { checks: ['duplicate-invoice'] });

    expect(sql(0)).toMatch(/COUNT\(\*\) OVER\(\)::int AS total/);
    expect(results[0].count).toBe(40);
    expect(results[0].level).toBe('warning');
    expect(results[0].sample).toEqual(sample.map((m) => `${m.folios} (100.00)`));
  });

  it('is clean when there are no duplicate groups', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const { results } = await runArChecks(ENTITY, { checks: ['duplicate-invoice'] });
    expect(results[0]).toMatchObject({ level: 'clean', count: 0, detail: 'ninguna' });
  });
});

describe('arReconcile manual entries', () => {
  it('excludes reversals whose original entry the AR engine posted', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ account_id: 'acc-1', code: '1120', name: 'Clientes' }] })
      .mockResolvedValueOnce({ rows: [{ account_id: 'acc-1', balance: '0' }] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    await arReconcile(ENTITY);

    const manualSql = sql(4);
    expect(manualSql).toMatch(
      /NOT EXISTS \( SELECT 1 FROM journal_entries orig WHERE orig\.id = je\.reverses_entry_id AND orig\.entity_id = je\.entity_id AND orig\.source_type = ANY\(\$3::text\[\]\)\)/
    );
    expect(mockQuery.mock.calls[4][1]).toEqual([
      ENTITY,
      'acc-1',
      ['invoice', 'customer_payment', 'credit_note', 'receipt_application', 'receipt_unapplication'],
      50,
    ]);
  });
});

describe('arReconcile reads the report layer', () => {
  it('takes the control balance and the manual entries from report-service, figures unchanged', async () => {
    // One layer (T14 · #101): a private copy of the ledger sum is how one
    // surface got fixed while the other kept publishing the old figure.
    mockQuery
      .mockResolvedValueOnce({ rows: [{ account_id: 'acc-1', code: '1120', name: 'Clientes' }] })
      .mockResolvedValueOnce({ rows: [{ account_id: 'acc-1', balance: '1500.0000' }] })
      .mockResolvedValueOnce({ rows: [{ total: '1300.0000' }] })
      .mockResolvedValueOnce({ rows: [{ total: '100.0000' }] })
      .mockResolvedValueOnce({
        rows: [
          { journal_entry_id: 'je-9', entry_number: 'JE-9', entry_date: new Date('2026-08-20'),
            description: 'Manual adjustment', amount: '300.0000' },
        ],
      });

    const r = await arReconcile(ENTITY);

    expect(queryAccountBalance).toHaveBeenCalledWith(ENTITY, 'acc-1');
    expect(queryEntryMovementsOnAccount).toHaveBeenCalledWith(ENTITY, 'acc-1', {
      excludeSourceTypes: ['invoice', 'customer_payment', 'credit_note', 'receipt_application', 'receipt_unapplication'],
      order: 'newest',
      limit: 50,
    });
    expect(r).toMatchObject({
      control_balance: '1500.00',
      open_invoices: '1300.00',
      unapplied_credit_notes: '100.00',
      subledger_net: '1200.00',
      delta: '300.00',
      balanced: false,
      manual_entries: [
        { entry_number: 'JE-9', entry_date: new Date('2026-08-20'), description: 'Manual adjustment', amount: '300.00' },
      ],
    });
    // The newest 50, entity- and account-scoped inside the SQL.
    expect(sql(4)).toMatch(/WHERE je\.entity_id = \$1 AND je\.status = 'posted' AND jel\.account_id = \$2/);
    expect(sql(4)).toMatch(/ORDER BY je\.entry_date DESC, je\.entry_number DESC LIMIT \$4/);
  });

  it('reads an account without posted lines as a zero control balance', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ account_id: 'acc-1', code: '1120', name: 'Clientes' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    const r = await arReconcile(ENTITY);

    expect(r).toMatchObject({ control_balance: '0.00', delta: '0.00', balanced: true, manual_entries: [] });
  });
});
