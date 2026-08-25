import { describe, it, expect, vi, beforeEach } from 'vitest';

// El camino con auditoría corre en transacción: el cambio y su rastro se
// confirman juntos. withTransaction entrega el cliente del arnés.
const { clienteTx } = vi.hoisted(() => ({ clienteTx: { query: vi.fn() } }));

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn(clienteTx)),
}));

import {
  listCustomers,
  getCustomerById,
  getCustomerBalance,
  listCustomerOpenInvoices,
  resolveCustomer,
  createCustomer,
  updateCustomer,
  archiveCustomer,
  restoreCustomer,
  customerLabel,
  OPEN_INVOICE_STATUSES,
  NEVER_RECEIVABLE_STATUSES,
  CUSTOMER_UPDATABLE_FIELDS,
} from '../../../src/services/ar/customer-service.js';
import { query } from '../../../src/database/connection.js';
import { NotFoundError, ValidationError, ConflictError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CUSTOMER = '11111111-2222-3333-4444-555555555555';
const USER = 'user-1';
const TENANT = 'tenant-1';

beforeEach(() => {
  mockQuery.mockReset();
  clienteTx.query.mockReset();
});

const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');
const params = (call: number) => mockQuery.mock.calls[call][1];

describe('listCustomers', () => {
  it('reports the true total so a caller can detect truncation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '318' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ customer_number: 'C-2026-00001' }] });
    const page = await listCustomers(ENTITY, { limit: 1 });
    expect(page.total).toBe(318);
    expect(page.rows).toHaveLength(1);
  });

  it('scopes every query to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listCustomers(ENTITY);
    expect(sql(0)).toMatch(/WHERE c\.entity_id = \$1/);
    expect(params(0)[0]).toBe(ENTITY);
    expect(params(1)[0]).toBe(ENTITY);
  });

  it('keeps the historical search columns exactly, so the REST contract does not widen', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listCustomers(ENTITY, { search: 'acme' });
    expect(sql(0)).toMatch(
      /\(c\.company_name ILIKE \$2 OR c\.customer_number ILIKE \$2 OR c\.first_name ILIKE \$2 OR c\.last_name ILIKE \$2\)/
    );
    expect(params(0)[1]).toBe('%acme%');
    // Not email, not tax_id: widening the match would change what the API returns.
    expect(sql(0)).not.toMatch(/email ILIKE/);
  });

  it('computes no balance by default, so the HTTP response keeps its columns', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listCustomers(ENTITY, { isActive: true });
    expect(sql(1)).not.toMatch(/LATERAL/);
    expect(sql(1)).toMatch(/SELECT c\.\* FROM customers c WHERE/);
  });

  it('joins the balance once, for the count and the page alike', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listCustomers(ENTITY, { withBalance: true });
    // Both statements carry the join: a filter on the balance has to be
    // countable, and Postgres rejects a bind with unreferenced parameters.
    expect(sql(0)).toMatch(/LEFT JOIN LATERAL/);
    expect(sql(1)).toMatch(/LEFT JOIN LATERAL/);
    expect(params(0)).toHaveLength(3);
    expect(params(0)[2]).toEqual([...OPEN_INVOICE_STATUSES]);
  });

  it('excludes drafts from what a customer owes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listCustomers(ENTITY, { withBalance: true });
    // A draft has not been issued and has not touched the ledger.
    expect(params(0)[2]).not.toContain('draft');
    expect(sql(0)).toMatch(/i\.status = ANY/);
  });

  it('reads the maintained amount_due for today, and rebuilds it for a past date', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listCustomers(ENTITY, { withBalance: true });
    expect(sql(0)).toMatch(/SELECT i\.amount_due AS amount/);

    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listCustomers(ENTITY, { withBalance: true, asOf: '2026-03-31' });
    expect(sql(0)).toMatch(/i\.total_amount - COALESCE/);
    expect(sql(0)).toMatch(/p\.payment_date <= \$\d+::date/);
    expect(sql(0)).toMatch(/i\.invoice_date <= \$\d+::date/);
    // A paid invoice may well have been open on the reference date.
    expect(params(0)[2]).toEqual([...NEVER_RECEIVABLE_STATUSES]);
  });

  it('filters on the computed balance, not on a stored column', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listCustomers(ENTITY, { overdueOnly: true, balanceGreaterThan: '1000' });
    expect(sql(0)).toMatch(/bal\.overdue_balance > 0/);
    expect(sql(0)).toMatch(/bal\.open_balance > \$\d+/);
    expect(params(0)).toContain('1000');
  });

  it('orders by the name a person would look under', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listCustomers(ENTITY);
    expect(sql(1)).toMatch(/ORDER BY COALESCE\(c\.company_name, c\.first_name\)/);
  });
});

describe('getCustomerBalance', () => {
  it('is one query, and never reads a stored balance column', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ open_balance: '11600.0000', overdue_balance: '0', open_documents: 1, oldest_due_date: null }],
    });
    const balance = await getCustomerBalance(CUSTOMER);
    expect(balance.open_balance).toBe('11600.0000');
    expect(mockQuery.mock.calls).toHaveLength(1);
    expect(sql(0)).not.toMatch(/customers\.balance|c\.balance/);
  });

  it('counts as past due only what was already due at the reference date', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ open_balance: '0' }] });
    await getCustomerBalance(CUSTOMER, '2026-06-30');
    expect(sql(0)).toMatch(/CASE WHEN i\.due_date < \$2::date/);
    expect(params(0)[1]).toBe('2026-06-30');
  });
});

describe('listCustomerOpenInvoices', () => {
  it('shows the same documents the balance is made of', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listCustomerOpenInvoices(CUSTOMER);
    expect(sql(0)).toMatch(/d\.amount > 0/);
    expect(params(0)[2]).toEqual([...OPEN_INVOICE_STATUSES]);
    expect(sql(0)).toMatch(/ORDER BY i\.due_date ASC/);
  });
});

describe('resolveCustomer — what a person types vs what the tables hold', () => {
  it('takes a uuid by id, scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: CUSTOMER }] });
    await resolveCustomer(ENTITY, CUSTOMER);
    expect(sql(0)).toMatch(/WHERE id = \$1 AND entity_id = \$2/);
    expect(params(0)).toEqual([CUSTOMER, ENTITY]);
  });

  it('prefers the customer number over a name match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: CUSTOMER, customer_number: 'C-2026-00001' }] });
    const found = await resolveCustomer(ENTITY, 'C-2026-00001');
    expect(found.id).toBe(CUSTOMER);
    expect(mockQuery.mock.calls).toHaveLength(1);
  });

  it('refuses an ambiguous name instead of silently picking the first row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // not a customer number
    mockQuery.mockResolvedValueOnce({
      rows: [
        { customer_number: 'C-1', company_name: 'ACME Norte' },
        { customer_number: 'C-2', company_name: 'ACME Sur' },
      ],
    });
    await expect(resolveCustomer(ENTITY, 'ACME')).rejects.toThrow(
      expect.objectContaining({ name: 'ConflictError', message: expect.stringContaining('C-1') })
    );
  });

  it('throws NotFound naming what was looked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolveCustomer(ENTITY, 'nobody')).rejects.toThrow(
      expect.objectContaining({ name: 'NotFoundError', message: expect.stringContaining('nobody') })
    );
  });
});

describe('createCustomer', () => {
  const base = { entity_id: ENTITY, created_by: USER, company_name: 'ACME SA' };

  it('needs a name of some kind', async () => {
    await expect(createCustomer({ entity_id: ENTITY, created_by: USER })).rejects.toThrow(ValidationError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('keeps the historical defaults: Net 30 and USD', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '4' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new' }] });
    await createCustomer(base);
    expect(params(1)[12]).toBe('Net 30');
    expect(params(1)[14]).toBe('USD');
  });

  it('draws the customer number from the count, as it always did', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '4' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new' }] });
    await createCustomer(base);
    expect(String(params(1)[2])).toMatch(/^C-\d{4}-00005$/);
  });

  it('serialises the addresses as JSON, matching the JSONB columns', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new' }] });
    await createCustomer({ ...base, billing_address: { city: 'CDMX' } });
    expect(params(1)[10]).toBe('{"city":"CDMX"}');
  });

  it('turns the unique violation into a conflict, not a raw 500', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '4' }] });
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: '23505' }));
    await expect(createCustomer(base)).rejects.toThrow(
      expect.objectContaining({ name: 'ConflictError', message: expect.stringContaining('retry') })
    );
  });

  it('lets any other database error through untouched', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockRejectedValueOnce(Object.assign(new Error('connection lost'), { code: '08006' }));
    await expect(createCustomer(base)).rejects.toThrow('connection lost');
  });
});

describe('updateCustomer', () => {
  it('writes only whitelisted fields, in the historical order', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: CUSTOMER }] });
    await updateCustomer(CUSTOMER, { email: 'a@b.com', phone: '555' });
    expect(sql(0)).toMatch(/SET email = \$1, phone = \$2, updated_at = NOW\(\) WHERE id = \$3/);
  });

  it('refuses a patch with nothing in it', async () => {
    await expect(updateCustomer(CUSTOMER, {})).rejects.toThrow(ValidationError);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('ignores fields outside the whitelist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: CUSTOMER }] });
    await updateCustomer(CUSTOMER, { email: 'a@b.com', tax_id: 'HACK' } as never);
    expect(sql(0)).not.toMatch(/tax_id/);
    expect(CUSTOMER_UPDATABLE_FIELDS).not.toContain('tax_id' as never);
  });

  it('makes exactly one round trip when nobody asked for an audit row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: CUSTOMER }] });
    await updateCustomer(CUSTOMER, { phone: '555' });
    expect(mockQuery.mock.calls).toHaveLength(1);
  });

  it('records the reason and the previous values when an audit context is given', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: CUSTOMER, phone: null }] }); // read before
    clienteTx.query.mockResolvedValueOnce({ rows: [{ id: CUSTOMER, phone: '555' }] }); // update
    clienteTx.query.mockResolvedValueOnce({ rows: [] }); // audit insert
    await updateCustomer(CUSTOMER, { phone: '555' }, {
      audit: { userId: USER, tenantId: TENANT, reason: 'confirmed by the customer' },
    });

    // Ambas sentencias en el MISMO cliente: si el rastro no entra, el
    // cambio no queda.
    const tx = clienteTx.query.mock.calls;
    expect(String(tx[0][0])).toMatch(/UPDATE customers/);
    const rastro = tx[1];
    expect(String(rastro[0]).replace(/\s+/g, ' ')).toMatch(/INSERT INTO audit_log/);
    expect(rastro[1][3]).toBe('update');
    expect(rastro[1][4]).toBe('customers');
    expect(rastro[1][5]).toBe(CUSTOMER);
    expect(rastro[1][6]).toBe('{"phone":null}');
    expect(rastro[1][7]).toBe('{"phone":"555"}');
    expect(rastro[1][8]).toBe('confirmed by the customer');
  });

  it('throws NotFound when the row does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(updateCustomer('gone', { phone: '5' })).rejects.toThrow(NotFoundError);
  });
});

describe('archiveCustomer — archiving is not collecting', () => {
  it('refuses while the customer still owes something', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ open_balance: '11600.0000', overdue_balance: '0', open_documents: 1, oldest_due_date: null }],
    });
    await expect(archiveCustomer(CUSTOMER)).rejects.toThrow(
      expect.objectContaining({ name: 'ValidationError', message: expect.stringContaining('11600.0000') })
    );
    // Nothing was written.
    expect(mockQuery.mock.calls).toHaveLength(1);
  });

  it('allows it when the caller can justify itself, and reports what is left', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ open_balance: '500.0000', overdue_balance: '0', open_documents: 2, oldest_due_date: null }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: CUSTOMER }] });
    const result = await archiveCustomer(CUSTOMER, { allowWithBalance: true });
    expect(result.balance.open_documents).toBe(2);
    expect(sql(1)).toMatch(/SET is_active = \$1/);
    expect(params(1)[0]).toBe(false);
  });

  it('never issues a DELETE — the history has to survive', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ open_balance: '0', overdue_balance: '0', open_documents: 0, oldest_due_date: null }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: CUSTOMER }] });
    await archiveCustomer(CUSTOMER);
    expect(sql(1)).not.toMatch(/DELETE/i);
  });
});

describe('restoreCustomer', () => {
  it('flips the same flag back', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: CUSTOMER }] });
    await restoreCustomer(CUSTOMER);
    expect(sql(0)).toMatch(/SET is_active = \$1/);
    expect(params(0)[0]).toBe(true);
  });
});

describe('customerLabel', () => {
  it('prefers the company, falls back to the person', () => {
    expect(customerLabel({ company_name: 'ACME SA' })).toBe('ACME SA');
    expect(customerLabel({ first_name: 'Ada', last_name: 'Lovelace' })).toBe('Ada Lovelace');
    expect(customerLabel({ first_name: 'Ada' })).toBe('Ada');
    expect(customerLabel({})).toBe('');
  });
});

describe('getCustomerById', () => {
  it('returns null instead of throwing, so callers choose the error', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getCustomerById(CUSTOMER)).toBeNull();
  });

  it('reads the row alone unless the balance or the documents were asked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: CUSTOMER }] });
    await getCustomerById(CUSTOMER);
    expect(mockQuery.mock.calls).toHaveLength(1);
    expect(sql(0)).toBe('SELECT * FROM customers WHERE id = $1');
  });

  it('attaches the balance, the open documents and the recent payments on request', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: CUSTOMER }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ open_balance: '10', overdue_balance: '0', open_documents: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ invoice_number: 'INV-1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ payment_number: 'PMT-1' }] });
    const card = await getCustomerById(CUSTOMER, { includeDocuments: true });
    expect(card?.open_balance).toBe('10');
    expect(card?.open_invoices).toHaveLength(1);
    expect(card?.recent_payments).toHaveLength(1);
    expect(sql(3)).toMatch(/FROM customer_payments/);
  });
});
