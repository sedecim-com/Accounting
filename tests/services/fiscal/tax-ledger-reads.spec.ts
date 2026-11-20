import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ============================================================
// MNE-001-437 (#101) · THE TAX READINGS SUM THE LEDGER THROUGH REPORT-SERVICE
//
// The IVA paper's withholding per sale and its receipt ledger, and the DIOT's
// exempt revenue of the year, read their sums through report-service on the
// caller's transaction client. Hand figures; the report-service helpers are
// spied, and the client answers only the lookups that sum nothing.
// ============================================================

vi.mock('../../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/reporting/report-service.js')>();
  return { ...real, queryEntryMovementsOnAccount: vi.fn(), queryTrialBalanceRows: vi.fn() };
});

import { queryEntryMovementsOnAccount, queryTrialBalanceRows } from '../../../src/services/reporting/report-service.js';
import { receiptLedgerOfMonth, withheldPerSale } from '../../../src/services/fiscal/iva-workpaper.js';
import { exemptRevenueOfYear } from '../../../src/services/sat/diot/diot-service.js';

const ENTITY = 'entity-1';
const movements = queryEntryMovementsOnAccount as unknown as Mock;
const balances = queryTrialBalanceRows as unknown as Mock;

/** A client that answers each lookup by the first words that tell it apart, and nothing else. */
function clientAnswering(answers: Array<[RegExp, unknown[]]>) {
  return {
    query: vi.fn(async (sql: string) => {
      const hit = answers.find(([re]) => re.test(sql));
      if (!hit) throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      return { rows: hit[1] };
    }),
  };
}

const move = (entry: string, amount: string) => ({ journal_entry_id: entry, amount });

beforeEach(() => {
  movements.mockReset();
  balances.mockReset();
});

describe('withheldPerSale — each sale\'s own entry on iva_retenido_a_favor', () => {
  it('adds what the entry left on every account of the role, and leaves out a sale with no line there', async () => {
    const client = clientAnswering([[/FROM account_roles/, [{ account_id: 'r1' }, { account_id: 'r2' }]]]);
    movements
      .mockResolvedValueOnce([move('je-a', '1000.0000')])
      .mockResolvedValueOnce([move('je-a', '66.6700')]);
    const out = await withheldPerSale(client as never, ENTITY, [
      { id: 'A', journal_entry_id: 'je-a' },
      { id: 'B', journal_entry_id: 'je-b' },
      { id: 'A', journal_entry_id: 'je-a' },
    ]);
    expect(out).toEqual(new Map([['A', '1066.6700']]));
    expect(movements.mock.calls).toEqual([
      [ENTITY, 'r1', { entryIds: ['je-a', 'je-b'], client }],
      [ENTITY, 'r2', { entryIds: ['je-a', 'je-b'], client }],
    ]);
  });
});

describe('receiptLedgerOfMonth — each receipt entry of the month with what it moved in 2120', () => {
  it('keeps every touched entry, credit positive, and an entry with no 2120 line at zero', async () => {
    const touched = [
      { payment_id: 'p-1', entry_id: 'je-1', entry_number: 'JE-1', entry_date: '2026-05-10', mirror: false },
      { payment_id: 'p-1', entry_id: 'je-2', entry_number: 'JE-2', entry_date: '2026-05-20', mirror: true },
    ];
    const client = clientAnswering([
      [/WITH own AS/, touched],
      [/FROM account_roles/, [{ account_id: 't1' }]],
    ]);
    movements.mockResolvedValueOnce([move('je-1', '-160.0000')]);
    const rows = await receiptLedgerOfMonth(client as never, ENTITY, { desde: '2026-05-01', hasta: '2026-05-31' });
    expect(rows.map((r) => [r.entry_number, r.mirror, r.iva])).toEqual([['JE-1', false, '160.0000'], ['JE-2', true, '0.0000']]);
    expect(movements.mock.calls).toEqual([[ENTITY, 't1', { entryIds: ['je-1', 'je-2'], client }]]);
  });
});

describe('exemptRevenueOfYear — the DIOT\'s exempt revenue, January to the DIOT month', () => {
  it('sums credit − debit over the exempt grouping codes only, without the closing entries', async () => {
    const client = clientAnswering([[/FROM accounts/, [{ id: 'x1' }, { id: 'x2' }]]]);
    balances.mockResolvedValueOnce([
      { account_id: 'x1', credit_total: '1500.0000', debit_total: '500.0000' },
      { account_id: 'x2', credit_total: '0', debit_total: '0' },
      { account_id: 'y', credit_total: '9999.0000', debit_total: '0' },
    ]);
    expect(await exemptRevenueOfYear(client as never, ENTITY, 2026, '2026-12-31')).toBe('1000.0000');
    expect(balances.mock.calls).toEqual([[
      ENTITY,
      { sinceDate: '2026-01-01', untilDate: '2026-12-31', ignoreClosingPolicy: true, excludeClosingEntries: true },
      client,
    ]]);
  });
});
