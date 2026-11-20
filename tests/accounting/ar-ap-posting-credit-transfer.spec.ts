import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/services/accounting/posting.js', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-trf-1' })),
}));

import type pg from 'pg';
import { postCustomerCreditTransferEntry } from '../../src/services/accounting/ar-ap-posting.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { AccountingError } from '../../src/utils/errors.js';

const mockCreate = createJournalEntry as unknown as ReturnType<typeof vi.fn>;

const ENTITY = 'e0000000-0000-0000-0000-000000000001';
const USER = 'u0000000-0000-0000-0000-000000000001';

// ============================================================
// MNE-001-498 · THE ENTRY OF A CUSTOMER CREDIT TRANSFER, UNIT.
//
// The integration spec drives it through Postgres; here a fake client that
// answers by the SHAPE of the SQL pins what the entry is and that it is
// linked to B's row by a guarded UPDATE (invariant 3). Accounts come back as
// `acct:<role>`, so asserting an account_id asserts the role the engine chose.
// ============================================================

let linkRows: number;
let writes: Array<{ sql: string; params: unknown[] }>;

function fakeClient(): pg.PoolClient {
  const query = async (text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount?: number }> => {
    const sql = String(text).replace(/\s+/g, ' ').trim();
    const p = params ?? [];
    if (/^UPDATE customer_payments/.test(sql)) {
      writes.push({ sql, params: p });
      return { rows: [], rowCount: linkRows };
    }
    if (sql.includes('FROM account_roles')) {
      const roles = (p[1] ?? []) as string[];
      return { rows: roles.map((role) => ({ role, account_id: `acct:${role}` })) };
    }
    return { rows: [] };
  };
  return { query } as unknown as pg.PoolClient;
}

const transfer = {
  id: 'trf-1', entity_id: ENTITY, transfer_number: 'TRF-2026-00001', source_number: 'PMT-2026-00007',
  from_customer: 'Cliente A', to_customer: 'Cliente B', amount: '1160.00', date: '2026-06-15',
};

beforeEach(() => {
  mockCreate.mockClear();
  linkRows = 1;
  writes = [];
});

describe('postCustomerCreditTransferEntry (MNE-001-498)', () => {
  it('posts DR 2150 / CR 2150 for the amount, on the agreed day, with no bank, revenue or IVA line, and links it to B\'s row', async () => {
    const entry = await postCustomerCreditTransferEntry(fakeClient(), transfer, USER);

    expect(entry.id).toBe('je-trf-1');
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const [entityId, date, , description, lines, userId, opts] = mockCreate.mock.calls[0] as [
      string, string, unknown, string,
      Array<{ account_id: string; debit_amount: string | null; credit_amount: string | null; description: string }>,
      string, Record<string, unknown>,
    ];
    expect(entityId).toBe(ENTITY);
    expect(date).toBe('2026-06-15');
    expect(userId).toBe(USER);
    expect(description).toContain('TRF-2026-00001');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.account_id)).toEqual(['acct:anticipo_clientes', 'acct:anticipo_clientes']);
    expect(lines[0]).toMatchObject({ debit_amount: '1160.0000', credit_amount: null });
    expect(lines[1]).toMatchObject({ debit_amount: null, credit_amount: '1160.0000' });
    expect(lines[0].description).toContain('Cliente A');
    expect(lines[1].description).toContain('Cliente B');
    expect(opts).toMatchObject({
      autoPost: true, sourceType: 'customer_credit_transfer', sourceId: 'trf-1', reference: 'TRF-2026-00001',
    });

    expect(writes).toHaveLength(1);
    expect(writes[0].sql).toContain('journal_entry_id IS NULL');
    expect(writes[0].sql).toContain("payment_method = 'balance_transfer'");
    expect(writes[0].params).toEqual(['je-trf-1', 'trf-1', ENTITY]);
  });

  it('refuses when the guarded link finds no row: the transfer already has an entry or is not this entity\'s', async () => {
    linkRows = 0;
    const e = await postCustomerCreditTransferEntry(fakeClient(), transfer, USER).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AccountingError);
    expect((e as AccountingError).message).toContain('TRF-2026-00001');
    expect((e as { code?: string }).code).toBe('PAYMENT_ALREADY_POSTED');
  });
});
