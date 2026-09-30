import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));

import { arReconcile, runArChecks } from '../../../src/services/ar/ar-controls.js';
import { query } from '../../../src/database/connection.js';

const mockQuery = query as unknown as Mock;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');

beforeEach(() => mockQuery.mockReset());

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
      .mockResolvedValueOnce({ rows: [{ saldo: '0' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [{ net: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    await arReconcile(ENTITY);

    const manualSql = sql(5);
    expect(manualSql).toMatch(
      /NOT EXISTS \( SELECT 1 FROM journal_entries orig WHERE orig\.id = je\.reverses_entry_id AND orig\.entity_id = je\.entity_id AND orig\.source_type = ANY\(\$3::text\[\]\)\)/
    );
    expect(mockQuery.mock.calls[5][1]).toEqual([
      ENTITY,
      'acc-1',
      ['invoice', 'customer_payment', 'credit_note', 'receipt_application', 'receipt_unapplication', 'fx_revaluation'],
    ]);
  });
});

describe('arReconcile in a foreign currency (MNE-001-112)', () => {
  it('adds each currency at book value and the live revaluation to the subledger', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ account_id: 'acc-1', code: '1120', name: 'Clientes' }] })
      .mockResolvedValueOnce({ rows: [{ saldo: '20400' }] })
      .mockResolvedValueOnce({
        rows: [
          { currency: 'MXN', functional: true, foreign: '2200', book: '2200' },
          { currency: 'USD', functional: false, foreign: '1000', book: '17500' },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: '0' }] })
      .mockResolvedValueOnce({ rows: [{ net: '700' }] })
      .mockResolvedValueOnce({ rows: [] });

    const r = await arReconcile(ENTITY);

    expect(sql(2)).toMatch(/ROUND\(i\.amount_due \* i\.exchange_rate, 4\)/);
    expect(r).toMatchObject({
      open_invoices: '19700.00',
      fx_revaluation: '700.00',
      subledger_net: '20400.00',
      balanced: true,
      foreign_open: [{ currency: 'USD', foreign: '1000.00', book: '17500.00' }],
    });
  });
});
