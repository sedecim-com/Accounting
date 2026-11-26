import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type pg from 'pg';

vi.mock('../../src/database/connection.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/database/connection.js')>();
  return { ...real, query: vi.fn() };
});
// MNE-001-618 · spied, not replaced: the real report-layer reads run against
// the fake transaction clients below, and the spies prove the four IEPS sums
// read them, on the caller's client.
vi.mock('../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/reporting/report-service.js')>();
  return {
    ...real,
    queryIepsParkedByInvoice: vi.fn(real.queryIepsParkedByInvoice),
    queryIepsMovedForInvoice: vi.fn(real.queryIepsMovedForInvoice),
    queryIepsKeptOnAccount: vi.fn(real.queryIepsKeptOnAccount),
    queryIepsTakenByRows: vi.fn(real.queryIepsTakenByRows),
  };
});

import {
  heldIepsShare,
  iepsCausedBy,
  iepsHeldForCashing,
  iepsKeptOnAccount,
  iepsMovedForInvoice,
  iepsMoveLines,
  iepsParkedByInvoice,
  iepsTakenByRows,
} from '../../src/services/accounting/ieps-cash-basis.js';
import { query } from '../../src/database/connection.js';
import {
  queryIepsKeptOnAccount,
  queryIepsMovedForInvoice,
  queryIepsParkedByInvoice,
  queryIepsTakenByRows,
} from '../../src/services/reporting/report-service.js';

// MNE-001-590 (#792) · the lines that keep an unapplied receipt's IEPS caused and
// net it on a later application, by hand. The ledger reads themselves are
// pinned against Postgres (tests/integration/mne-001-590-plain-unapply-keeps-ieps.int.spec.ts).

const ENTITY = 'e0000000-0000-0000-0000-000000000001';

function fakeClient(kept = '0'): pg.PoolClient & { sql: string[]; params: unknown[][] } {
  const sql: string[] = [];
  const params: unknown[][] = [];
  const query = async (text: string, p?: unknown[]): Promise<{ rows: unknown[] }> => {
    sql.push(String(text).replace(/\s+/g, ' '));
    params.push(p ?? []);
    if (/FROM account_roles WHERE/.test(sql.at(-1) as string)) {
      return { rows: ['ieps_trasladado_no_cobrado', 'ieps_por_pagar'].map((role) => ({ role, account_id: `acct:${role}` })) };
    }
    return { rows: [{ kept }] };
  };
  return { query, sql, params } as unknown as pg.PoolClient & { sql: string[]; params: unknown[][] };
}

const UNCOLLECTED = 'acct:ieps_trasladado_no_cobrado';
const DUE = 'acct:ieps_por_pagar';
const tags = (invoice: string) => ({ ieps_release: { invoice_id: invoice, payment_id: 'pay-1' } });
const amounts = (lines: { account_id: string; debit_amount: string | null; credit_amount: string | null }[]) =>
  lines.map((l) => [l.account_id, l.debit_amount, l.credit_amount]);

describe('iepsMoveLines · keep', () => {
  it('one line: the share back in 2181, tagged, and nothing out of 2180', async () => {
    const lines = await iepsMoveLines(fakeClient(), ENTITY, 'pay-1', [{ invoiceId: 'inv-a', invoiceNumber: 'A', amount: '80' }], 'keep', 'unapply');
    expect(amounts(lines)).toEqual([[UNCOLLECTED, null, '80.0000']]);
    expect(lines[0].tags).toEqual(tags('inv-a'));
    expect(lines[0].description).toBe(
      'IEPS back in ieps_trasladado_no_cobrado (unapply), kept caused in ieps_por_pagar on the cash back on account (LIEPS art. 10) - Invoice A'
    );
  });
});

describe('iepsMoveLines · a release that nets the IEPS the cash carries', () => {
  it('r 80 against e 80: 2181 Dr 80 and no 2180 line (P1, P4)', async () => {
    const lines = await iepsMoveLines(fakeClient(), ENTITY, 'pay-1', [{ invoiceId: 'inv-b', invoiceNumber: 'B', amount: '80', take: '80' }], 'release', 'collection');
    expect(amounts(lines)).toEqual([[UNCOLLECTED, '80.0000', null]]);
    expect(lines[0].tags).toEqual(tags('inv-b'));
  });

  it('r 0 against e 74.0741: 2180 Dr 74.0741 alone, tagged with the invoice that releases none (P3)', async () => {
    const lines = await iepsMoveLines(fakeClient(), ENTITY, 'pay-1', [{ invoiceId: 'inv-c', invoiceNumber: 'C', amount: '0', take: '74.0741' }], 'release', 'collection');
    expect(amounts(lines)).toEqual([[DUE, '74.0741', null]]);
    expect(lines[0].tags).toEqual(tags('inv-c'));
    expect(lines[0].description).toBe(
      'IEPS the cash on account carried (caused when collected) taken on collection: 74.0741, net of 0.0000 released - Invoice C'
    );
  });

  it('r 80 against e 30: 2181 Dr 80 and 2180 Cr 50', async () => {
    const lines = await iepsMoveLines(fakeClient(), ENTITY, 'pay-1', [{ invoiceId: 'inv-d', invoiceNumber: 'D', amount: '80', take: '30' }], 'release', 'collection');
    expect(amounts(lines)).toEqual([[UNCOLLECTED, '80.0000', null], [DUE, null, '50.0000']]);
    expect(lines[1].description).toBe(
      'IEPS now in ieps_por_pagar (caused on collection, LIEPS art. 10) - Invoice D, net of 30.0000 the cash on account carried, caused when collected'
    );
  });

  it('with no take the pair is as before, and nothing to move reads no role', async () => {
    const lines = await iepsMoveLines(fakeClient(), ENTITY, 'pay-1', [{ invoiceId: 'inv-e', invoiceNumber: 'E', amount: '40' }], 'release', 'collection');
    expect(amounts(lines)).toEqual([[UNCOLLECTED, '40.0000', null], [DUE, null, '40.0000']]);
    const client = fakeClient();
    expect(await iepsMoveLines(client, ENTITY, 'pay-1', [{ invoiceId: 'inv-f', invoiceNumber: 'F', amount: '0', take: '0' }], 'release', 'collection')).toEqual([]);
    expect(client.sql).toEqual([]);
  });
});

describe('iepsKeptOnAccount', () => {
  it('sums credit − debit over both IEPS roles on the receipt\'s tagged lines, never below 0', async () => {
    const client = fakeClient('80');
    expect(await iepsKeptOnAccount(client, ENTITY, 'pay-1')).toBe('80.0000');
    expect(client.params[0]).toEqual([ENTITY, ['ieps_trasladado_no_cobrado', 'ieps_por_pagar'], 'pay-1']);
    expect(client.sql[0]).toContain("l.tags -> 'ieps_release' ->> 'payment_id' = $3");
    expect(client.sql[0]).toContain('je.reversed_by_entry_id IS NULL AND je.is_reversal = false');
    expect(await iepsKeptOnAccount(fakeClient('-0.0001'), ENTITY, 'pay-1')).toBe('0.0000');
  });
});

// MNE-001-608 (#792, risk 3 of #891) · the IEPS a held cheque's cash back on account carries for its cashing, read
// from the rows' IVA marker by the invoice's own proportion, and the 2180 line that causes it. By hand.
describe('heldIepsShare', () => {
  it('the whole marker is the whole parked IEPS: 80 × 172.80 / 172.80 = 80.0000', () => {
    expect(heldIepsShare({ parked: '80', marked: '172.80', tax: '172.80' })).toBe('80.0000');
  });

  it('half the marker is half the IEPS, and an odd share rounds half up: 80 × 57.60 / 172.80 = 26.6667', () => {
    expect(heldIepsShare({ parked: '80', marked: '86.40', tax: '172.80' })).toBe('40.0000');
    expect(heldIepsShare({ parked: '80', marked: '57.60', tax: '172.80' })).toBe('26.6667');
  });

  it('never more than parked, and nothing with no IVA, no marker or nothing parked', () => {
    expect(heldIepsShare({ parked: '80', marked: '200', tax: '172.80' })).toBe('80.0000');
    expect(heldIepsShare({ parked: '80', marked: '172.80', tax: '0' })).toBe('0.0000');
    expect(heldIepsShare({ parked: '80', marked: '0', tax: '172.80' })).toBe('0.0000');
    expect(heldIepsShare({ parked: '0', marked: '172.80', tax: '172.80' })).toBe('0.0000');
  });
});

describe('iepsHeldForCashing', () => {
  /** The closed rows' marker by invoice, then each invoice's parked IEPS. */
  function heldClient(rows: { invoice_id: string; invoice_number: string; tax: string; marked: string }[], parked: Record<string, string>) {
    const sql: string[] = [];
    const params: unknown[][] = [];
    const query = async (text: string, p?: unknown[]): Promise<{ rows: unknown[] }> => {
      sql.push(String(text).replace(/\s+/g, ' '));
      params.push(p ?? []);
      if (/unapply_kept_iva_amount/.test(sql.at(-1) as string)) return { rows };
      return { rows: [{ ieps_parked: parked[String((p ?? [])[1])] ?? '0' }] };
    };
    return { query, sql, params } as unknown as pg.PoolClient & { sql: string[]; params: unknown[][] };
  }

  it('reads the receipt\'s closed rows with a marker, entity-scoped, and gives each invoice its share; one with none is left out', async () => {
    const client = heldClient(
      [
        { invoice_id: 'inv-a', invoice_number: 'A', tax: '172.80', marked: '172.8000' },
        { invoice_id: 'inv-c', invoice_number: 'C', tax: '160.00', marked: '160.0000' },
      ],
      { 'inv-a': '80.0000' }
    );
    expect(await iepsHeldForCashing(client, ENTITY, 'pay-1')).toEqual([{ invoiceId: 'inv-a', invoiceNumber: 'A', amount: '80.0000' }]);
    expect(client.params[0]).toEqual([ENTITY, 'pay-1']);
    expect(client.sql[0]).toContain('pa.unapplied_at IS NOT NULL AND pa.unapply_kept_iva_amount > 0');
    expect(client.sql[0]).toContain('JOIN customer_payments cp ON cp.id = pa.payment_id AND cp.entity_id = $1');
    expect(client.sql[0]).toContain('JOIN invoices i ON i.id = pa.invoice_id AND i.entity_id = $1');
    expect(client.params.slice(1).map((p) => p[1])).toEqual(['inv-a', 'inv-c']);
  });
});

describe('iepsMoveLines · cause', () => {
  it('one line: 2180 credited, tagged with the invoice and the cheque, and nothing out of 2181 (H1)', async () => {
    const lines = await iepsMoveLines(fakeClient(), ENTITY, 'pay-1', [{ invoiceId: 'inv-a', invoiceNumber: 'A', amount: '80' }], 'cause', 'cheque CHQ-608 cashed 2026-06-01');
    expect(amounts(lines)).toEqual([[DUE, null, '80.0000']]);
    expect(lines[0].tags).toEqual(tags('inv-a'));
    expect(lines[0].description).toBe(
      'IEPS now in ieps_por_pagar (caused on cheque CHQ-608 cashed 2026-06-01, LIEPS art. 10) on the cash back on account, ' +
        'kept for the cashing when it was unapplied - Invoice A'
    );
  });
});

// MNE-001-604 (#792) · an unapply gives back what its rows took from the cash on account, read by row. By hand.
describe('iepsMoveLines · keep with back', () => {
  it('U1: r 0 and back 74.0741 is one 2180 credit, tagged with the invoice and the receipt', async () => {
    const lines = await iepsMoveLines(fakeClient(), ENTITY, 'pay-1', [{ invoiceId: 'inv-c', invoiceNumber: 'C', amount: '0', back: '74.0741' }], 'keep', 'unapply');
    expect(amounts(lines)).toEqual([[DUE, null, '74.0741']]);
    expect(lines[0].tags).toEqual(tags('inv-c'));
    expect(lines[0].description).toBe(
      'IEPS the cash on account carried, taken on its application, back with it (unapply; caused when collected, LIEPS art. 10) - Invoice C'
    );
  });

  it('U2: r 40 and back 37.0370 is 2181 Cr 40 and 2180 Cr 37.0370; a negative back is a 2180 debit; zero adds nothing', async () => {
    const two = await iepsMoveLines(fakeClient(), ENTITY, 'pay-1', [{ invoiceId: 'inv-d', invoiceNumber: 'D', amount: '40', back: '37.0370' }], 'keep', 'unapply');
    expect(amounts(two)).toEqual([[UNCOLLECTED, null, '40.0000'], [DUE, null, '37.0370']]);
    const debit = await iepsMoveLines(fakeClient(), ENTITY, 'pay-1', [{ invoiceId: 'inv-d', invoiceNumber: 'D', amount: '80', back: '-80' }], 'keep', 'unapply');
    expect(amounts(debit)).toEqual([[UNCOLLECTED, null, '80.0000'], [DUE, '80.0000', null]]);
    expect(debit[1].description).toBe('IEPS released on cash from on account undone (unapply), net of what it carried - Invoice D');
    const none = await iepsMoveLines(fakeClient(), ENTITY, 'pay-1', [{ invoiceId: 'inv-d', invoiceNumber: 'D', amount: '80', back: '0' }], 'keep', 'unapply');
    expect(amounts(none)).toEqual([[UNCOLLECTED, null, '80.0000']]);
  });

  it('a release tags its allocation row beside the invoice and the receipt', async () => {
    const lines = await iepsMoveLines(fakeClient(), ENTITY, 'pay-1', [{ invoiceId: 'inv-c', invoiceNumber: 'C', amount: '0', take: '74.0741', allocationId: 'row-1' }], 'release', 'collection');
    expect(lines[0].tags).toEqual({ ieps_release: { invoice_id: 'inv-c', payment_id: 'pay-1', allocation_id: 'row-1' } });
  });
});

describe('iepsTakenByRows', () => {
  it('one entity-scoped query over both roles, by row, unreversed; no rows reads nothing', async () => {
    const sql: string[] = [];
    const params: unknown[][] = [];
    const client = {
      query: async (text: string, p?: unknown[]) => {
        sql.push(String(text).replace(/\s+/g, ' '));
        params.push(p ?? []);
        return { rows: [{ allocation_id: 'row-1', released: '0', taken: '74.0741' }] };
      },
    } as unknown as pg.PoolClient;
    const read = await iepsTakenByRows(client, ENTITY, ['row-1', 'row-2']);
    expect([...read.entries()]).toEqual([['row-1', { released: '0.0000', taken: '74.0741' }]]);
    expect(params[0]).toEqual([ENTITY, 'ieps_trasladado_no_cobrado', ['ieps_trasladado_no_cobrado', 'ieps_por_pagar'], ['row-1', 'row-2']]);
    expect(sql[0]).toContain("l.tags -> 'ieps_release' ->> 'allocation_id' = ANY($4::text[])");
    expect(sql[0]).toContain('je.entity_id = $1 AND je.status = \'posted\' AND je.reversed_by_entry_id IS NULL AND je.is_reversal = false');
    expect(await iepsTakenByRows(client, ENTITY, [])).toEqual(new Map());
    expect(sql).toHaveLength(1);
  });
});

// MNE-001-618 (#101) · the four IEPS sums read through report-service, on the
// caller's transaction client, and the consumers give back what they gave
// before: the same clamps, scales and empty answers. By hand.
describe('MNE-001-618 · the IEPS sums read report-service, on the caller\'s client', () => {
  const mockQuery = query as unknown as Mock;

  /** A transaction client that answers each sum by its column, and refuses any other statement. */
  function ledgerClient(answers: { ieps_parked?: string; moved?: string; kept?: string; taken?: unknown[] }) {
    const q = vi.fn(async (text: string) => {
      const s = String(text);
      if (s.includes('AS ieps_parked')) return { rows: [{ ieps_parked: answers.ieps_parked }] };
      if (s.includes('AS moved')) return { rows: [{ moved: answers.moved }] };
      if (s.includes('AS kept')) return { rows: [{ kept: answers.kept }] };
      if (s.includes('AS taken')) return { rows: answers.taken ?? [] };
      throw new Error(`unexpected statement: ${s.slice(0, 80)}`);
    });
    return { client: { query: q } as unknown as pg.PoolClient, q };
  }

  beforeEach(() => {
    mockQuery.mockReset();
    vi.mocked(queryIepsParkedByInvoice).mockClear();
    vi.mocked(queryIepsMovedForInvoice).mockClear();
    vi.mocked(queryIepsKeptOnAccount).mockClear();
    vi.mocked(queryIepsTakenByRows).mockClear();
  });

  it('parked: asked once on the client; 80.0000 stays 80, and a negative read is 0', async () => {
    const { client, q } = ledgerClient({ ieps_parked: '80.0000' });
    expect((await iepsParkedByInvoice(client, ENTITY, 'inv-a')).toFixed(4)).toBe('80.0000');
    expect(vi.mocked(queryIepsParkedByInvoice).mock.calls).toEqual([[ENTITY, 'inv-a', client]]);
    expect(q).toHaveBeenCalledTimes(1);
    expect((await iepsParkedByInvoice(ledgerClient({ ieps_parked: '-0.0001' }).client, ENTITY, 'inv-a')).toFixed(4)).toBe('0.0000');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('moved: by one receipt or by every one (a null receipt), on the client, signed as read', async () => {
    const { client } = ledgerClient({ moved: '40.0000' });
    expect((await iepsMovedForInvoice(client, ENTITY, 'inv-a', 'pay-1')).toFixed(4)).toBe('40.0000');
    // An unapply that re-parked more than this receipt moved reads below zero, and is not clamped.
    const { client: other } = ledgerClient({ moved: '-12.5000' });
    expect((await iepsMovedForInvoice(other, ENTITY, 'inv-a')).toFixed(4)).toBe('-12.5000');
    expect(vi.mocked(queryIepsMovedForInvoice).mock.calls).toEqual([
      [ENTITY, 'inv-a', 'pay-1', client],
      [ENTITY, 'inv-a', null, other],
    ]);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('one collection of half the invoice causes 80.0000 × 580 / 1 160 = 40.0000, less nothing moved; parked and moved on the same client', async () => {
    const { client, q } = ledgerClient({ ieps_parked: '80.0000', moved: '0' });
    const doc = { invoiceId: 'inv-a', totalAmount: '1160.00', priorApplied: '0.0000', appliedNow: '580.0000' };
    expect(await iepsCausedBy(client, ENTITY, doc)).toBe('40.0000');
    // By hand: with 50.0000 already moved only 30.0000 is still parked, so the share stops there.
    expect(await iepsCausedBy(ledgerClient({ ieps_parked: '80.0000', moved: '50.0000' }).client, ENTITY, doc)).toBe('30.0000');
    expect(vi.mocked(queryIepsParkedByInvoice).mock.calls[0]).toEqual([ENTITY, 'inv-a', client]);
    expect(vi.mocked(queryIepsMovedForInvoice).mock.calls[0]).toEqual([ENTITY, 'inv-a', null, client]);
    expect(q).toHaveBeenCalledTimes(2);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('kept: asked once on the client, at four decimals, never below 0', async () => {
    const { client } = ledgerClient({ kept: '80' });
    expect(await iepsKeptOnAccount(client, ENTITY, 'pay-1')).toBe('80.0000');
    expect(vi.mocked(queryIepsKeptOnAccount).mock.calls).toEqual([[ENTITY, 'pay-1', client]]);
    expect(await iepsKeptOnAccount(ledgerClient({ kept: '-0.0001' }).client, ENTITY, 'pay-1')).toBe('0.0000');
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('taken: one read for the rows on the client, by row at four decimals; no rows asks nothing', async () => {
    // By hand: row-1 released nothing and took 80 × 1 000 / 1 080 = 74.0741; row-2 released 40 and took 40.
    const { client, q } = ledgerClient({
      taken: [
        { allocation_id: 'row-1', released: '0', taken: '74.0741' },
        { allocation_id: 'row-2', released: '40', taken: '40.00000' },
      ],
    });
    const read = await iepsTakenByRows(client, ENTITY, ['row-1', 'row-2']);
    expect([...read.entries()]).toEqual([
      ['row-1', { released: '0.0000', taken: '74.0741' }],
      ['row-2', { released: '40.0000', taken: '40.0000' }],
    ]);
    expect(vi.mocked(queryIepsTakenByRows).mock.calls).toEqual([[ENTITY, ['row-1', 'row-2'], client]]);
    expect(q).toHaveBeenCalledTimes(1);
    expect(await iepsTakenByRows(client, ENTITY, [])).toEqual(new Map());
    expect(queryIepsTakenByRows).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
