import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/services/accounting/posting.js', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-1' })),
}));
// The IEPS arithmetic and its ledger reads are pinned against Postgres
// (tests/integration/mne-001-504-ppd-ieps-release.int.spec.ts); here only the
// wiring: which entry carries the lines, and what its description says.
vi.mock('../../src/services/accounting/ieps-cash-basis.js', () => ({
  iepsCausedByReceipt: vi.fn(async () => [{ invoiceId: 'inv-1', invoiceNumber: 'INV-1', amount: '40.0000' }]),
  iepsCausedBy: vi.fn(async () => '40.0000'),
  iepsMoveLines: vi.fn(async (_c: unknown, _e: string, _p: string, moves: { amount: string }[], direction: string) =>
    moves.flatMap((m) => [
      { account_id: direction === 'release' ? 'acct:2181' : 'acct:2180', debit_amount: m.amount, credit_amount: null, description: 'IEPS out', tags: { t: 1 } },
      { account_id: direction === 'release' ? 'acct:2180' : 'acct:2181', debit_amount: null, credit_amount: m.amount, description: 'IEPS in', tags: { t: 1 } },
    ])),
}));

import type pg from 'pg';
import {
  postCustomerPaymentEntry,
  postReceiptApplicationEntry,
  postReceiptUnapplicationEntry,
} from '../../src/services/accounting/ar-ap-posting.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { iepsCausedBy, iepsCausedByReceipt } from '../../src/services/accounting/ieps-cash-basis.js';

const mockCreate = createJournalEntry as unknown as Mock;
const ENTITY = 'e0000000-0000-0000-0000-000000000001';

let country = 'MX';

function fakeClient(): pg.PoolClient {
  const query = async (text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number }> => {
    const sql = String(text).replace(/\s+/g, ' ');
    if (/^UPDATE /.test(sql.trim())) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM legal_entities')) return { rows: [{ incorporation_country: country, accounting_standard: country === 'MX' ? 'mx_nif' : 'us_gaap' }] };
    if (sql.includes('AS aplicado')) return { rows: [{ aplicado: '626.40' }] };
    if (sql.includes('FROM account_roles')) {
      const roles = ((params ?? [])[1] ?? []) as string[];
      return { rows: roles.map((role) => ({ role, account_id: `acct:${role}` })) };
    }
    return { rows: [] };
  };
  return { query } as unknown as pg.PoolClient;
}

const payment = {
  id: 'pay-1', entity_id: ENTITY, payment_number: 'PMT-1', payment_amount: '626.40',
  payment_date: '2026-08-15', bank_account_id: null, journal_entry_id: null,
};

type Line = { account_id: string; debit_amount: string | null; credit_amount: string | null; tags?: unknown };
const posted = (): { description: string; lines: Line[] } => {
  const call = mockCreate.mock.calls.at(-1) as unknown[];
  return { description: call[3] as string, lines: call[4] as Line[] };
};
const iepsOf = (lines: Line[]): Line[] => lines.filter((l) => l.account_id === 'acct:2181' || l.account_id === 'acct:2180');

beforeEach(() => {
  mockCreate.mockClear();
  (iepsCausedByReceipt as Mock).mockClear();
  (iepsCausedBy as Mock).mockClear();
  country = 'MX';
});

describe('MNE-001-504 · the IEPS move rides on the entry that moves the VAT', () => {
  it('a collection carries the tagged pair and names the invoice in its description', async () => {
    await postCustomerPaymentEntry(fakeClient(), payment, 'u1');
    const { description, lines } = posted();
    expect(iepsOf(lines)).toEqual([
      expect.objectContaining({ account_id: 'acct:2181', debit_amount: '40.0000', tags: { t: 1 } }),
      expect.objectContaining({ account_id: 'acct:2180', credit_amount: '40.0000', tags: { t: 1 } }),
    ]);
    expect(description).toBe('Customer payment PMT-1 · IEPS caused on collection: INV-1');
  });

  it('a held cheque and an entity off Mexican books ask nothing of the IEPS module', async () => {
    await postCustomerPaymentEntry(fakeClient(), { ...payment, holdsIvaUntilCashed: true }, 'u1');
    country = 'US';
    await postCustomerPaymentEntry(fakeClient(), payment, 'u1');
    expect(iepsCausedByReceipt).not.toHaveBeenCalled();
    expect(iepsOf(posted().lines)).toEqual([]);
  });

  it('a later application carries the pair for each invoice whose IEPS it causes', async () => {
    await postReceiptApplicationEntry(fakeClient(), payment, [{
      invoiceId: 'inv-1', invoiceNumber: 'INV-1', amount: '626.40', priorApplied: '0',
      taxAmount: '172.80', totalAmount: '1252.80', cfdiUuid: null, terms: null, memo: null,
    }], 'u1');
    const { description, lines } = posted();
    expect(iepsCausedBy).toHaveBeenCalledWith(expect.anything(), ENTITY, {
      invoiceId: 'inv-1', totalAmount: '1252.80', priorApplied: '0', appliedNow: '626.4000',
    });
    expect(iepsOf(lines)).toHaveLength(2);
    expect(description).toBe('Application of PMT-1 · IEPS caused on collection: INV-1');
  });

  it('an unapply gives back the figure it is handed, and writes nothing without one', async () => {
    const app = { invoiceNumber: 'INV-1', amount: '626.40', ivaReclass: '0', ivaEstimado: '0' };
    await postReceiptUnapplicationEntry(fakeClient(), payment, {
      ...app, ieps: { invoiceId: 'inv-1', invoiceNumber: 'INV-1', amount: '40.0000' },
    }, 'u1');
    expect(iepsOf(posted().lines)).toEqual([
      expect.objectContaining({ account_id: 'acct:2180', debit_amount: '40.0000' }),
      expect.objectContaining({ account_id: 'acct:2181', credit_amount: '40.0000' }),
    ]);
    await postReceiptUnapplicationEntry(fakeClient(), payment, app, 'u1');
    expect(iepsOf(posted().lines)).toEqual([]);
  });
});
