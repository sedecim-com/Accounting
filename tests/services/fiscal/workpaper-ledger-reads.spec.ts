import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ============================================================
// MNE-001-622 (#101) · THE MONTHLY PAPERS SUM THE LEDGER THROUGH REPORT-SERVICE
//
// The filing workpaper's entry trace (the entries that move a line's accounts,
// and the entries a builder chose) and the provisional ISR's withholding per
// entry read their sums through report-service, on the paper's own client.
// Hand figures. The three readers are spied, not replaced: their SQL still
// reaches the fake client, which answers each statement by the words that tell
// it apart; the pool is never asked.
// ============================================================

vi.mock('../../../src/database/connection.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/database/connection.js')>();
  return { ...real, query: vi.fn(), withTransaction: vi.fn() };
});
vi.mock('../../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/reporting/report-service.js')>();
  return {
    ...real,
    queryEntriesMovingAccounts: vi.fn(real.queryEntriesMovingAccounts),
    queryEntriesNetOnAccounts: vi.fn(real.queryEntriesNetOnAccounts),
    queryWithholdingNetByEntry: vi.fn(real.queryWithholdingNetByEntry),
    queryTrialBalanceRows: vi.fn(),
  };
});
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));
vi.mock('../../../src/services/accounting/iva-cash-basis.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/accounting/iva-cash-basis.js')>();
  return { ...real, entityUsesCashBasisIva: vi.fn(async () => true) };
});
vi.mock('../../../src/services/fiscal/provisional-income-tax-inputs.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/fiscal/provisional-income-tax-inputs.js')>();
  return { ...real, incomeTaxInputForPayment: vi.fn(), corporateIncomeTaxRateAt: vi.fn() };
});

import { query } from '../../../src/database/connection.js';
import {
  queryEntriesMovingAccounts,
  queryEntriesNetOnAccounts,
  queryTrialBalanceRows,
  queryWithholdingNetByEntry,
} from '../../../src/services/reporting/report-service.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import {
  corporateIncomeTaxRateAt,
  incomeTaxInputForPayment,
} from '../../../src/services/fiscal/provisional-income-tax-inputs.js';
import { entriesByIds, entriesMoving } from '../../../src/services/fiscal/filing-workpaper.js';
import { buildProvisionalIncomeTaxWorkpaper } from '../../../src/services/fiscal/provisional-income-tax.js';

const TENANT = 'a1b2c3d4-0000-4000-8000-000000000622';
const ENTITY = 'b2c3d4e5-0000-4000-8000-000000000622';
const pool = query as unknown as Mock;
const moving = queryEntriesMovingAccounts as unknown as Mock;
const byIds = queryEntriesNetOnAccounts as unknown as Mock;
const withheld = queryWithholdingNetByEntry as unknown as Mock;

/** A client that answers each statement by the first words that tell it apart, and nothing else. */
function clientAnswering(answers: Array<[RegExp, unknown[]]>) {
  return {
    query: vi.fn(async (sql: string) => {
      const hit = answers.find(([re]) => re.test(sql));
      if (!hit) throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      return { rows: hit[1] };
    }),
  };
}

const entry = (id: string, n: string, date: string, source: string | null, net: string) => ({
  id, entry_number: n, entry_date: date, source_type: source, description: null, net,
});

beforeEach(() => {
  pool.mockReset();
  moving.mockClear();
  byIds.mockClear();
  withheld.mockClear();
});

describe('entriesMoving — the entries that move a line\'s accounts in the month', () => {
  it('reads them through report-service on the paper\'s client, each net at four decimals', async () => {
    // By hand: invoice JE-0007 credits 2130 by 160.00; payment JE-0009 debits it by 40.00.
    const client = clientAnswering([[/AND l\.account_id = ANY\(\$4::uuid\[\]\)/, [
      entry('je-7', 'JE-0007', '2026-06-05', 'invoice', '-160'),
      entry('je-9', 'JE-0009', '2026-06-20', 'payment', '40'),
    ]]]);
    const out = await entriesMoving(client as never, ENTITY, ['acc-2130', 'acc-2131'], '2026-06-01', '2026-06-30');
    expect(out.map((e) => [e.entryNumber, e.entryDate, e.sourceType, e.net])).toEqual([
      ['JE-0007', '2026-06-05', 'invoice', '-160.0000'],
      ['JE-0009', '2026-06-20', 'payment', '40.0000'],
    ]);
    expect(moving.mock.calls).toEqual([[ENTITY, ['acc-2130', 'acc-2131'], '2026-06-01', '2026-06-30', client]]);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(pool).not.toHaveBeenCalled();
  });

  it('asks nothing for no account', async () => {
    const client = clientAnswering([]);
    expect(await entriesMoving(client as never, ENTITY, [], '2026-06-01', '2026-06-30')).toEqual([]);
    expect(moving).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('entriesByIds — the entries a builder chose, with what each nets on the line\'s accounts', () => {
  it('reads them through report-service on the paper\'s client; an entry with no line there nets zero', async () => {
    const client = clientAnswering([[/je\.id = ANY\(\$2::uuid\[\]\)/, [
      entry('je-7', 'JE-0007', '2026-06-05', 'invoice', '-160.0000'),
      entry('je-8', 'JE-0008', '2026-06-06', null, '0'),
    ]]]);
    const out = await entriesByIds(client as never, ENTITY, ['je-7', 'je-8', 'je-7'], ['acc-2130']);
    expect(out.map((e) => [e.entryId, e.net])).toEqual([['je-7', '-160.0000'], ['je-8', '0.0000']]);
    expect(byIds.mock.calls).toEqual([[ENTITY, ['je-7', 'je-8', 'je-7'], ['acc-2130'], client]]);
    // The ids reach the statement once each.
    expect((client.query.mock.calls[0] as unknown[])[1]).toEqual([ENTITY, ['je-7', 'je-8'], ['acc-2130']]);
    expect(pool).not.toHaveBeenCalled();
  });

  it('asks nothing for no entry', async () => {
    const client = clientAnswering([]);
    expect(await entriesByIds(client as never, ENTITY, [], ['acc-2130'])).toEqual([]);
    expect(byIds).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('the provisional ISR\'s withholding — read per entry through report-service', () => {
  // By hand, 1145 (isr_retenido_a_favor) from January to August 2026:
  //   the opening balance Dr 500.00          → last year's, never counts
  //   a May withholding Dr 100.00            → counts
  //   its June reversal mirror Cr 100.00     → takes it back
  //   an August withholding Dr 123.45        → counts
  //   an entry applying 50.00 against a tax  → does not undo it
  // Withheld: 100.00 − 100.00 + 123.45 = 123.45.
  const net = (entryId: string, source: string | null, reverses: string | null, amount: string) => ({
    entry_id: entryId, source_type: source, reverses_entry_id: reverses, code: '1145', net: amount,
  });
  const ledger = [
    net('je-open', 'opening_balance', null, '500.0000'),
    net('je-may', null, null, '100.0000'),
    net('je-jun', null, 'je-may', '-100.0000'),
    net('je-aug', null, null, '123.4500'),
    net('je-tax', 'tax_payment', null, '-50.0000'),
  ];

  it('withholds 123.4500 over the May, June and August entries, on the builder\'s own client', async () => {
    (getPolicy as unknown as Mock).mockImplementation(async (_ctx: unknown, key: string) =>
      key === 'provisional_isr_sales_returns'
        ? { value: 'deduction', defined: true }
        : { value: 'cada_renglon', defined: true });
    (incomeTaxInputForPayment as unknown as Mock).mockResolvedValue(null);
    (corporateIncomeTaxRateAt as unknown as Mock).mockResolvedValue({
      value: '0.3000', effectiveFrom: '2014-01-01', sourceUrl: 'https://example.invalid/lisr-9',
    });
    (queryTrialBalanceRows as unknown as Mock).mockResolvedValue([]);
    const client = clientAnswering([
      [/FROM legal_entities/, [{ tax_regime: '601' }]],
      [/FROM account_roles/, [{ account_id: 'acc-1145', role: 'isr_retenido_a_favor' }]],
      [/customer_credit_transfer/, []],
      [/je\.reverses_entry_id, a\.code/, ledger],
    ]);

    const wp = await buildProvisionalIncomeTaxWorkpaper({
      tenantId: TENANT, entityId: ENTITY, year: 2026, month: 8, client: client as never,
    });

    expect(wp.figures.withheldIncomeTax).toBe('123.4500');
    expect(wp.withholdingAccounts).toEqual([{ code: '1145', amount: '123.4500' }]);
    expect([...wp.withholdingEntryIds].sort()).toEqual(['je-aug', 'je-jun', 'je-may']);
    expect(withheld.mock.calls).toEqual([[ENTITY, ['acc-1145'], '2026-01-01', '2026-08-31', client]]);
    expect(pool).not.toHaveBeenCalled();
  });
});
