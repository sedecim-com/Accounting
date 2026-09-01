import { describe, it, expect, vi, beforeEach } from 'vitest';

const client = { query: vi.fn() };

vi.mock('../../../src/database/connection.js', () => ({
  // R1: tenantDe usa el contexto cuando existe; el arnés lo da fijo.
  currentTenant: () => 'tenant-1',
  query: vi.fn(),
  withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(client)),
}));
vi.mock('../../../src/services/accounting/ar-ap-posting.js', () => ({ postInvoiceEntry: vi.fn() }));
vi.mock('../../../src/services/accounting/posting.js', () => ({ voidJournalEntryInTx: vi.fn() }));
vi.mock('../../../src/utils/sequence.js', async (importActual) => ({
  // formatDocumentNumber real (R3: firma de tres argumentos, el año en medio);
  // un doble a mano aquí ya nos mintió una vez cuando la firma cambió.
  ...(await importActual<typeof import('../../../src/utils/sequence.js')>()),
  nextEntityNumber: vi.fn(async () => 'INV-2026-00007'),
}));

import {
  listInvoices,
  getInvoiceById,
  listInvoiceAllocations,
  resolveInvoice,
  createInvoice,
  issueInvoice,
  voidInvoice,
  listEntitySequences,
  SEQUENCE_PREFIXES,
} from '../../../src/services/ar/invoice-service.js';
import { query } from '../../../src/database/connection.js';
import { postInvoiceEntry } from '../../../src/services/accounting/ar-ap-posting.js';
import { voidJournalEntryInTx } from '../../../src/services/accounting/posting.js';
import { OPEN_INVOICE_STATUSES } from '../../../src/services/ar/customer-service.js';
import { NotFoundError, ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockPost = postInvoiceEntry as unknown as ReturnType<typeof vi.fn>;
const mockVoidJe = voidJournalEntryInTx as unknown as ReturnType<typeof vi.fn>;

const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const INVOICE = '11111111-2222-3333-4444-555555555555';
const CUSTOMER = '99999999-8888-7777-6666-555555555555';
const USER = 'user-1';

beforeEach(() => {
  mockQuery.mockReset();
  client.query.mockReset();
  mockPost.mockReset();
  mockVoidJe.mockReset();
});

const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');
const params = (call: number) => mockQuery.mock.calls[call][1];
const txSql = (call: number) => String(client.query.mock.calls[call][0]).replace(/\s+/g, ' ');

describe('listInvoices', () => {
  it('reports the true total so a caller can detect truncation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '87' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ invoice_number: 'INV-1' }] });
    const page = await listInvoices(ENTITY, { limit: 1 });
    expect(page.total).toBe(87);
    expect(page.rows).toHaveLength(1);
  });

  it('scopes both statements to the entity and joins the customer for the name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listInvoices(ENTITY);
    expect(sql(0)).toMatch(/WHERE i\.entity_id = \$1/);
    expect(sql(1)).toMatch(/LEFT JOIN customers c ON c\.id = i\.customer_id/);
    expect(params(0)[0]).toBe(ENTITY);
    expect(params(1)[0]).toBe(ENTITY);
  });

  it('binds the count with exactly the WHERE parameters', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // withAging adds a select-list parameter; binding it on the count too
    // makes Postgres reject the statement ("supplies N parameters…").
    await listInvoices(ENTITY, { withAging: true });
    expect(params(0)).toEqual([ENTITY]);
    expect(params(1).length).toBe(4); // entity + as-of + limit + offset
  });

  it('filters by document date by default, preserving the HTTP behaviour', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listInvoices(ENTITY, { since: '2026-01-01', until: '2026-03-31' });
    expect(sql(0)).toMatch(/i\.invoice_date >= \$2 AND i\.invoice_date <= \$3/);
    expect(sql(0)).not.toMatch(/journal_entries/);
  });

  it('filters by the ledger date when asked, and only then joins the entry', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listInvoices(ENTITY, { since: '2026-01-01', dateBasis: 'posting' });
    expect(sql(0)).toMatch(/LEFT JOIN journal_entries je ON je\.id = i\.journal_entry_id/);
    expect(sql(0)).toMatch(/je\.entry_date >= \$2/);
  });

  it('treats "overdue" as open, owing and past due — all three', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listInvoices(ENTITY, { overdueDays: 30 });
    expect(sql(0)).toMatch(/i\.due_date <= \(\$2::date - \$3::int\)/);
    expect(sql(0)).toMatch(/i\.amount_due > 0/);
    expect(sql(0)).toMatch(/i\.status = ANY\(\$4::text\[\]\)/);
    expect(params(0)[2]).toBe(30);
    expect(params(0)[3]).toEqual([...OPEN_INVOICE_STATUSES]);
  });

  it('reconstructs the as-of balance from the cash applied by that date', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listInvoices(ENTITY, { asOf: '2026-06-30', withAging: true });
    expect(sql(1)).toMatch(/amount_due_as_of/);
    expect(sql(1)).toMatch(/FROM payment_allocations pa/);
    expect(sql(1)).toMatch(/p\.payment_date <= \$\d+::date/);
    // A voided payment never happened.
    expect(sql(1)).toMatch(/p\.status <> 'void'/);
  });

  it('takes several statuses at once, which the single-status route could not', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listInvoices(ENTITY, { statuses: ['sent', 'partially_paid'] });
    expect(sql(0)).toMatch(/i\.status = ANY\(\$2::text\[\]\)/);
    expect(params(0)[1]).toEqual(['sent', 'partially_paid']);
  });

  it('orders newest first, as the route did', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listInvoices(ENTITY);
    expect(sql(1)).toMatch(/ORDER BY i\.invoice_date DESC/);
  });
});

describe('getInvoiceById', () => {
  it('returns null instead of throwing, so callers choose the error', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getInvoiceById(INVOICE)).toBeNull();
  });

  it('reads the lines by default and nothing else', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: INVOICE }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ line_number: 1 }] });
    const invoice = await getInvoiceById(INVOICE);
    expect(invoice?.lines).toHaveLength(1);
    expect(mockQuery.mock.calls).toHaveLength(2);
    expect(sql(0)).not.toMatch(/journal_entries/);
  });

  it('adds the ledger entry and the cash applied only on request', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: INVOICE }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ payment_number: 'PMT-1' }] });
    const invoice = await getInvoiceById(INVOICE, { includeLedger: true, includeAllocations: true });
    expect(sql(0)).toMatch(/LEFT JOIN journal_entries je ON je\.id = i\.journal_entry_id/);
    expect(invoice?.payment_allocations).toHaveLength(1);
  });
});

describe('listInvoiceAllocations', () => {
  it('joins the payment so the caller sees when the cash actually moved', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listInvoiceAllocations(INVOICE);
    expect(sql(0)).toMatch(/JOIN customer_payments p ON p\.id = pa\.payment_id/);
    expect(sql(0)).toMatch(/WHERE pa\.invoice_id = \$1/);
  });
});

describe('resolveInvoice', () => {
  it('looks up a folio, scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: INVOICE }] });
    await resolveInvoice(ENTITY, 'INV-2026-00042');
    expect(sql(0)).toMatch(/WHERE invoice_number = \$1 AND entity_id = \$2/);
    expect(params(0)).toEqual(['INV-2026-00042', ENTITY]);
  });

  it('looks up a uuid by id, still scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: INVOICE }] });
    await resolveInvoice(ENTITY, INVOICE);
    expect(sql(0)).toMatch(/WHERE id = \$1 AND entity_id = \$2/);
  });

  it('throws NotFound naming what was looked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolveInvoice(ENTITY, 'INV-9')).rejects.toThrow(
      expect.objectContaining({ name: 'NotFoundError', message: expect.stringContaining('INV-9') })
    );
  });
});

describe('createInvoice', () => {
  const base = {
    entity_id: ENTITY,
    customer_id: CUSTOMER,
    invoice_date: '2026-08-01',
    due_date: '2026-08-31',
    created_by: USER,
    lines: [{ unit_price: '1500', quantity: '2', tax_rate: '16', revenue_account_id: 'acct-1' }],
  };

  it('refuses an invoice with no lines', async () => {
    await expect(createInvoice({ ...base, lines: [] })).rejects.toThrow(ValidationError);
  });

  it('computes subtotal, tax and total with decimals, never floats', async () => {
    client.query.mockResolvedValue({ rows: [{ id: 'new' }] });
    await createInvoice(base);
    const insert = client.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO invoices'))!;
    expect(insert[1][4]).toBe('3000.0000'); // subtotal
    expect(insert[1][5]).toBe('480.0000'); // tax
    expect(insert[1][6]).toBe('3480.0000'); // total
    expect(insert[1][7]).toBe('3480.0000'); // amount_due opens equal to the total
  });

  it('opens the document as a draft, never posted and never stamped', async () => {
    client.query.mockResolvedValue({ rows: [{ id: 'new' }] });
    await createInvoice(base);
    const insert = client.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO invoices'))!;
    expect(String(insert[0]).replace(/\s+/g, ' ')).toMatch(/\$11, 'draft'/);
    expect(String(insert[0])).not.toMatch(/cfdi_uuid|journal_entry_id/);
  });

  it('numbers the lines from one and carries the tax per line', async () => {
    client.query.mockResolvedValue({ rows: [{ id: 'new' }] });
    await createInvoice({
      ...base,
      lines: [
        { unit_price: '100', revenue_account_id: 'a' },
        { unit_price: '50', quantity: '3', tax_rate: '16', revenue_account_id: 'b' },
      ],
    });
    const lineInserts = client.query.mock.calls.filter((c) => String(c[0]).includes('INSERT INTO invoice_lines'));
    expect(lineInserts).toHaveLength(2);
    expect(lineInserts[0][1][2]).toBe(1);
    expect(lineInserts[1][1][2]).toBe(2);
    expect(lineInserts[1][1][10]).toBe('24.0000'); // 150 * 16%
    expect(lineInserts[0][1][5]).toBe('1.0000'); // quantity defaults to one
  });

  it('defaults the currency to USD, as the route did', async () => {
    client.query.mockResolvedValue({ rows: [{ id: 'new' }] });
    await createInvoice(base);
    const insert = client.query.mock.calls.find((c) => String(c[0]).includes('INSERT INTO invoices'))!;
    expect(insert[1][8]).toBe('USD');
  });
});

describe('issueInvoice — issuing is not sending', () => {
  const invoiceRow = {
    id: INVOICE, entity_id: ENTITY, invoice_number: 'INV-2026-00002',
    status: 'draft', total_amount: '3480.0000', journal_entry_id: null,
  };

  function arrangeIssue(entry: { id: string; entry_number: string } | null) {
    client.query.mockImplementation(async (text: string) => {
      const t = String(text);
      if (t.includes('FOR UPDATE')) return { rows: [invoiceRow] };
      if (t.includes('FROM invoice_lines')) return { rows: [{ line_number: 1 }] };
      if (t.includes('journal_entry_lines')) return { rows: [{ line_number: 1, account_code: '1120' }] };
      if (t.includes('SELECT * FROM invoices')) return { rows: [{ ...invoiceRow, status: 'sent' }] };
      return { rows: [] };
    });
    mockPost.mockResolvedValue(entry);
  }

  it('does not touch the delivery fields when it is only issuing', async () => {
    arrangeIssue({ id: 'je-1', entry_number: 'JE-2026-00006' });
    await issueInvoice(INVOICE, USER, { entityId: ENTITY });
    const update = client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE invoices SET status'))!;
    expect(String(update[0])).toMatch(/SET status = 'sent'/);
    expect(String(update[0])).not.toMatch(/sent_at|sent_to/);
  });

  it('stamps the delivery fields for the caller that really delivered', async () => {
    arrangeIssue({ id: 'je-1', entry_number: 'JE-1' });
    await issueInvoice(INVOICE, USER, { entityId: ENTITY, markSent: true, sentTo: 'ap@acme.com' });
    const update = client.query.mock.calls.find((c) => String(c[0]).includes('UPDATE invoices SET status'))!;
    expect(String(update[0])).toMatch(/sent_at = NOW\(\), sent_to = \$1/);
    expect(update[1][0]).toBe('ap@acme.com');
  });

  it('posts through the single AR path and hands back what to attest', async () => {
    arrangeIssue({ id: 'je-1', entry_number: 'JE-1' });
    const result = await issueInvoice(INVOICE, USER, { entityId: ENTITY });
    expect(mockPost).toHaveBeenCalledOnce();
    expect(result.attest).toEqual({ entityId: ENTITY, entryId: 'je-1' });
    expect(result.entryLines).toHaveLength(1);
  });

  it('reports an already-posted invoice instead of posting twice', async () => {
    client.query.mockImplementation(async (text: string) => {
      const t = String(text);
      if (t.includes('FOR UPDATE')) return { rows: [{ ...invoiceRow, journal_entry_id: 'je-old' }] };
      return { rows: [{ ...invoiceRow, journal_entry_id: 'je-old' }] };
    });
    mockPost.mockResolvedValue(null); // idempotent: it refuses to post again
    const result = await issueInvoice(INVOICE, USER, { entityId: ENTITY });
    expect(result.alreadyPosted).toBe(true);
    expect(result.entry).toBeNull();
    expect(result.attest).toBeNull();
  });

  it('refuses a void invoice when the caller asked for the guard', async () => {
    client.query.mockResolvedValue({ rows: [{ ...invoiceRow, status: 'void' }] });
    await expect(issueInvoice(INVOICE, USER, { entityId: ENTITY, enforceStatusGuard: true })).rejects.toThrow(ValidationError);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('leaves the historical HTTP path unguarded, so /send behaves as before', async () => {
    arrangeIssue({ id: 'je-1', entry_number: 'JE-1' });
    client.query.mockImplementation(async (text: string) => {
      const t = String(text);
      if (t.includes('FOR UPDATE')) return { rows: [{ ...invoiceRow, status: 'void' }] };
      if (t.includes('FROM invoice_lines')) return { rows: [] };
      if (t.includes('journal_entry_lines')) return { rows: [] };
      return { rows: [invoiceRow] };
    });
    await expect(issueInvoice(INVOICE, USER, { entityId: ENTITY, markSent: true })).resolves.toBeDefined();
  });

  it('throws NotFound when the invoice is gone', async () => {
    client.query.mockResolvedValue({ rows: [] });
    await expect(issueInvoice(INVOICE, USER, { entityId: ENTITY })).rejects.toThrow(NotFoundError);
  });

  it('computes the whole effect and returns it, for --dry-run', async () => {
    arrangeIssue({ id: 'je-1', entry_number: 'JE-2026-00006' });
    const result = await issueInvoice(INVOICE, USER, { entityId: ENTITY, dryRun: true });
    // The work really happened — the transaction is what gets thrown away.
    expect(mockPost).toHaveBeenCalledOnce();
    expect(result.dryRun).toBe(true);
    expect(result.entry?.entry_number).toBe('JE-2026-00006');
  });

  it('lets a real failure out instead of swallowing it as a dry run', async () => {
    client.query.mockImplementation(async (text: string) => {
      if (String(text).includes('FOR UPDATE')) return { rows: [invoiceRow] };
      return { rows: [] };
    });
    mockPost.mockRejectedValue(new Error('No hay cuenta mapeada al rol "cxc"'));
    await expect(issueInvoice(INVOICE, USER, { entityId: ENTITY, dryRun: true })).rejects.toThrow(/cxc/);
  });
});

describe('voidInvoice', () => {
  const voided = {
    id: INVOICE, entity_id: ENTITY, invoice_number: 'INV-2026-00002',
    status: 'void', journal_entry_id: 'je-1',
  };

  it('refuses a stamped invoice and points at the cancellation that is real', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ cfdi_uuid: 'UUID-1', cfdi_status: 'stamped', applied: '0' }],
    });
    await expect(voidInvoice(INVOICE, USER, { entityId: ENTITY })).rejects.toThrow(
      expect.objectContaining({ name: 'ConflictError', message: expect.stringContaining('SAT') })
    );
    expect(client.query).not.toHaveBeenCalled();
  });

  it('refuses an invoice with cash applied to it', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ cfdi_uuid: null, cfdi_status: null, applied: '500.0000' }],
    });
    await expect(voidInvoice(INVOICE, USER, { entityId: ENTITY })).rejects.toThrow(
      expect.objectContaining({ name: 'ConflictError', message: expect.stringContaining('500.0000') })
    );
  });

  it('skips the guard entirely for the HTTP surface, which never had one', async () => {
    client.query.mockResolvedValue({ rows: [voided] });
    mockVoidJe.mockResolvedValue({ entry: {}, reversal: { id: 'rev-1' } });
    await voidInvoice(INVOICE, USER, { entityId: ENTITY, allowStamped: true, allowApplied: true });
    expect(mockQuery).not.toHaveBeenCalled(); // no pre-flight read at all
  });

  it('annuls the ledger entry with a linked reversal, in the same transaction', async () => {
    client.query.mockResolvedValue({ rows: [voided] });
    mockVoidJe.mockResolvedValue({ entry: {}, reversal: { id: 'rev-1' } });
    const result = await voidInvoice(INVOICE, USER, { entityId: ENTITY, allowStamped: true, allowApplied: true });
    expect(mockVoidJe).toHaveBeenCalledWith(client, 'je-1', USER, 'Invoice INV-2026-00002 voided');
    expect(result.reversalEntryId).toBe('rev-1');
    expect(result.attest).toEqual({ entityId: ENTITY, entryId: 'rev-1' });
  });

  it('carries the reason into the reversal when one was given', async () => {
    client.query.mockResolvedValue({ rows: [voided] });
    mockVoidJe.mockResolvedValue({ entry: {}, reversal: { id: 'rev-1' } });
    await voidInvoice(INVOICE, USER, { entityId: ENTITY, allowStamped: true, allowApplied: true, reason: 'billed twice' });
    expect(mockVoidJe).toHaveBeenCalledWith(
      client, 'je-1', USER, 'Invoice INV-2026-00002 voided: billed twice'
    );
  });

  it('keeps the historical guard in SQL: a paid or void invoice is not found', async () => {
    client.query.mockResolvedValue({ rows: [] });
    await expect(
      voidInvoice(INVOICE, USER, { entityId: ENTITY, allowStamped: true, allowApplied: true })
    ).rejects.toThrow(NotFoundError);
    expect(txSql(0)).toMatch(/status NOT IN \('paid', 'void'\)/);
  });

  it('does nothing to the ledger for an invoice that never reached it', async () => {
    client.query.mockResolvedValue({ rows: [{ ...voided, journal_entry_id: null }] });
    const result = await voidInvoice(INVOICE, USER, { entityId: ENTITY, allowStamped: true, allowApplied: true });
    expect(mockVoidJe).not.toHaveBeenCalled();
    expect(result.reversalEntryId).toBeNull();
  });

  it('computes the reversal and throws it away, for --dry-run', async () => {
    client.query.mockResolvedValue({ rows: [voided] });
    mockVoidJe.mockResolvedValue({ entry: {}, reversal: { id: 'rev-1' } });
    const result = await voidInvoice(INVOICE, USER, {
      entityId: ENTITY, allowStamped: true, allowApplied: true, dryRun: true,
    });
    expect(result.dryRun).toBe(true);
    expect(result.reversalEntryId).toBe('rev-1');
  });

  it('throws NotFound when the guard cannot find the invoice at all', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(voidInvoice(INVOICE, USER, { entityId: ENTITY })).rejects.toThrow(NotFoundError);
  });
});

describe('listEntitySequences', () => {
  it('turns a counter into the last folio issued and the next one', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ name: 'invoice', value: '4', updated_at: null }],
    });
    const rows = await listEntitySequences(ENTITY);
    expect(rows[0]).toMatchObject({
      document_type: 'invoice',
      issued: 4,
      last_number: 'INV-2026-00004',
      next_number: 'INV-2026-00005',
    });
  });

  it('says nothing was issued rather than inventing folio zero', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ name: 'invoice', value: '0', updated_at: null }] });
    const rows = await listEntitySequences(ENTITY);
    expect(rows[0].last_number).toBeNull();
    expect(rows[0].next_number).toBe('INV-2026-00001');
  });

  it('knows the prefixes the code actually draws with', () => {
    expect(SEQUENCE_PREFIXES.invoice).toBe('INV');
    expect(SEQUENCE_PREFIXES.customer_payment).toBe('PMT');
    expect(SEQUENCE_PREFIXES.journal_entry).toBe('JE');
  });

  it('scopes to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listEntitySequences(ENTITY);
    expect(sql(0)).toMatch(/WHERE entity_id = \$1/);
    expect(params(0)).toEqual([ENTITY]);
  });
});
