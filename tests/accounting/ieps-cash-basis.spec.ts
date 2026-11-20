import { describe, it, expect } from 'vitest';
import type pg from 'pg';
import { iepsKeptOnAccount, iepsMoveLines } from '../../src/services/accounting/ieps-cash-basis.js';

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
