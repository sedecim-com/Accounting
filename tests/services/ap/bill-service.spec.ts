import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  // R1: tenantDe usa el contexto cuando existe; el arnés lo da fijo.
  currentTenant: () => 'tenant-1',
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('../../../src/utils/sequence.js', () => ({
  nextEntityNumber: vi.fn(async () => 'BILL-2026-00007'),
}));
vi.mock('../../../src/services/accounting/ar-ap-posting.js', () => ({
  postBillEntry: vi.fn(),
}));

import {
  listBills,
  getBillById,
  resolveBill,
  computeBill,
  createBill,
  setBillLine,
  approveBill,
  earlyPaymentDiscount,
  APPROVABLE_STATUSES,
} from '../../../src/services/ap/bill-service.js';
import { query, withTransaction } from '../../../src/database/connection.js';
import { postBillEntry } from '../../../src/services/accounting/ar-ap-posting.js';
import { NotFoundError, ValidationError, ConflictError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockTx = withTransaction as unknown as ReturnType<typeof vi.fn>;
const mockPost = postBillEntry as unknown as ReturnType<typeof vi.fn>;

const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER = 'user-1';
const BILL = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';

/** Records whether the transaction the service opened committed or rolled back. */
let committed: boolean;

beforeEach(() => {
  mockQuery.mockReset();
  mockPost.mockReset();
  committed = false;
  mockTx.mockReset();
  mockTx.mockImplementation(async (fn: (c: { query: unknown }) => Promise<unknown>) => {
    const result = await fn({ query: mockQuery });
    committed = true;
    return result;
  });
});

const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');
const params = (call: number) => mockQuery.mock.calls[call][1];

// ============================================================
// LIST
// ============================================================

describe('listBills', () => {
  it('reports the true total so a caller can detect truncation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '240' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'b1' }] });
    const page = await listBills(ENTITY, { limit: 1 });
    expect(page.total).toBe(240);
    expect(page.rows).toHaveLength(1);
  });

  it('scopes to the entity and joins the vendor for its name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listBills(ENTITY);
    expect(sql(0)).toMatch(/WHERE b\.entity_id = \$1/);
    expect(sql(1)).toMatch(/LEFT JOIN vendors v ON v\.id = b\.vendor_id/);
    expect(params(1)[0]).toBe(ENTITY);
  });

  it('accepts one status or several, always as an array parameter', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listBills(ENTITY, { status: 'draft' });
    expect(sql(0)).toMatch(/b\.status = ANY\(\$2\)/);
    expect(params(0)[1]).toEqual(['draft']);

    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listBills(ENTITY, { status: ['draft', 'approved'] });
    expect(params(0)[1]).toEqual(['draft', 'approved']);
  });

  it('filters the DOCUMENT date by default', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listBills(ENTITY, { startDate: '2026-01-01', endDate: '2026-01-31' });
    expect(sql(0)).toMatch(/b\.bill_date >= \$2 AND b\.bill_date <= \$3/);
    expect(sql(0)).not.toMatch(/journal_entries/);
  });

  it('filters the POSTING date against the journal entry when asked, without dropping unposted bills from other queries', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listBills(ENTITY, { startDate: '2026-01-01', dateBasis: 'posting' });
    expect(sql(0)).toMatch(/LEFT JOIN journal_entries je ON je\.id = b\.journal_entry_id/);
    expect(sql(0)).toMatch(/je\.entry_date >= \$2/);
  });

  it('answers the payment-run question with due_date, not bill_date', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listBills(ENTITY, { dueBefore: '2026-09-30' });
    expect(sql(0)).toMatch(/b\.due_date <= \$2/);
  });

  it('searches the three things a person actually holds', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listBills(ENTITY, { search: 'A-991' });
    expect(sql(0)).toMatch(
      /\(b\.bill_number ILIKE \$2 OR b\.vendor_invoice_number ILIKE \$2 OR v\.company_name ILIKE \$2\)/
    );
  });

  it('numbers every filter without collision', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listBills(ENTITY, {
      vendorId: 'v1', status: ['draft'], startDate: '2026-01-01',
      endDate: '2026-01-31', dueBefore: '2026-02-28', search: 'x',
    });
    expect(params(0)).toEqual([ENTITY, 'v1', ['draft'], '2026-01-01', '2026-01-31', '2026-02-28', '%x%']);
  });
});

// ============================================================
// SHOW
// ============================================================

describe('getBillById', () => {
  it('returns null instead of throwing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getBillById(BILL)).toBeNull();
  });

  it('reads the lines exactly as stored unless the account names were asked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: BILL }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getBillById(BILL, { includeLines: true });
    expect(sql(1)).toBe('SELECT * FROM bill_lines WHERE bill_id = $1 ORDER BY line_number');

    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: BILL }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getBillById(BILL, { includeLines: true, includeLineAccounts: true });
    expect(sql(1)).toMatch(/a\.code AS account_code/);
  });

  it('follows journal_entry_id, the FK nothing ever read back', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: BILL, journal_entry_id: 'je1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'je1', entry_number: 'JE-1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ line_number: 1 }] });
    const bill = await getBillById(BILL, { includeJournal: true });
    expect((bill?.journal_entry as { entry_number: string }).entry_number).toBe('JE-1');
    expect(params(1)).toEqual(['je1']);
  });

  it('does not look for an entry that is not there', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: BILL, journal_entry_id: null }] });
    await getBillById(BILL, { includeJournal: true });
    expect(mockQuery.mock.calls).toHaveLength(1);
  });

  it('reaches the CFDI through pre_registrations, the only link that exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: BILL }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ cfdi_uuid: 'u1' }] });
    const bill = await getBillById(BILL, { includeCfdi: true });
    expect(sql(1)).toMatch(/FROM pre_registrations p JOIN xml_documents x ON x\.id = p\.xml_document_id/);
    expect((bill?.cfdi as unknown[])).toHaveLength(1);
  });
});

describe('resolveBill', () => {
  it('accepts a bill number or the vendor folio, scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: BILL }] });
    await resolveBill(ENTITY, 'BILL-2026-00007');
    expect(sql(0)).toMatch(/upper\(bill_number\) = upper\(\$2\) OR upper\(vendor_invoice_number\) = upper\(\$2\)/);
    expect(params(0)).toEqual([ENTITY, 'BILL-2026-00007']);
  });

  it('refuses to choose between two bills carrying the same vendor folio', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'b1', bill_number: 'BILL-1', total_amount: '100', bill_date: '2026-01-01' },
        { id: 'b2', bill_number: 'BILL-2', total_amount: '100', bill_date: '2026-02-01' },
      ],
    });
    const error = await resolveBill(ENTITY, 'A-1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as Error).message).toMatch(/matches 2 bills/);
  });

  it('throws NotFound naming what was looked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolveBill(ENTITY, 'BILL-9')).rejects.toThrow(
      expect.objectContaining({ name: 'NotFoundError', message: expect.stringContaining('BILL-9') })
    );
  });
});

// ============================================================
// ARITHMETIC
// ============================================================

describe('computeBill', () => {
  it('is qty × price per line, tax additive, header as the sum', () => {
    const c = computeBill([
      { account_id: 'a1', quantity: '2', unit_price: '250', tax_amount: '80' },
      { account_id: 'a2', unit_price: '1000', tax_amount: '160' },
    ]);
    expect(c.subtotal).toBe('1500.0000');
    expect(c.tax_amount).toBe('240.0000');
    expect(c.total_amount).toBe('1740.0000');
    expect(c.lines[0].total_amount).toBe('580.0000');
    expect(c.lines[1].line_number).toBe(2);
  });

  it('defaults quantity to 1 and tax to 0, like the route did', () => {
    const c = computeBill([{ account_id: 'a1', unit_price: '99.99' }]);
    expect(c.lines[0].quantity).toBe('1.0000');
    expect(c.lines[0].tax_amount).toBe('0.0000');
    expect(c.total_amount).toBe('99.9900');
  });

  it('does the arithmetic in decimal, not in floating point', () => {
    // 0.1 + 0.2 in a float is 0.30000000000000004, and a cent that nobody can
    // find is how a trial balance stops balancing.
    const c = computeBill([
      { account_id: 'a1', unit_price: '0.10' },
      { account_id: 'a1', unit_price: '0.20' },
    ]);
    expect(c.subtotal).toBe('0.3000');
  });

  it('refuses a bill with no lines', () => {
    expect(() => computeBill([])).toThrow(ValidationError);
  });
});

// ============================================================
// CREATE
// ============================================================

describe('createBill', () => {
  const input = {
    entity_id: ENTITY, vendor_id: 'v1', created_by: USER,
    bill_date: '2026-08-10', due_date: '2026-09-09',
    lines: [{ account_id: 'a1', unit_price: '3000', tax_amount: '480' }],
  };

  it('writes the header and its lines in ONE transaction', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'new' }] });
    await createBill(input);
    expect(mockTx).toHaveBeenCalledTimes(1);
    expect(committed).toBe(true);
    expect(sql(0)).toMatch(/INSERT INTO bills/);
    expect(sql(1)).toMatch(/INSERT INTO bill_lines/);
  });

  it('opens the bill as a draft, with amount_due equal to the total', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'new' }] });
    await createBill(input);
    expect(sql(0)).toMatch(/'draft'/);
    const p = params(0);
    expect(p[7]).toBe('3480.0000'); // total_amount
    expect(p[8]).toBe('3480.0000'); // amount_due
  });

  it('draws the number from the atomic per-entity counter, not COUNT(*)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'new' }] });
    await createBill(input);
    expect(params(0)[2]).toBe('BILL-2026-00007');
  });

  it('rejects a bill with no lines before opening a transaction', async () => {
    await expect(createBill({ ...input, lines: [] })).rejects.toThrow(ValidationError);
    expect(mockTx).not.toHaveBeenCalled();
  });
});

// ============================================================
// LINE CODING
// ============================================================

describe('setBillLine', () => {
  it('re-codes a draft line and locks the header while doing it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: BILL, status: 'draft', bill_number: 'BILL-7' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ line_number: 1 }] });
    await setBillLine(BILL, 1, { account_id: 'a2' });
    expect(sql(0)).toMatch(/FOR UPDATE/);
    expect(sql(1)).toMatch(/UPDATE bill_lines SET account_id = \$1 WHERE bill_id = \$2 AND line_number = \$3/);
    expect(params(1)).toEqual(['a2', BILL, 1]);
  });

  it('refuses to re-code a bill that is already in the ledger', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: BILL, status: 'posted', bill_number: 'BILL-7' }] });
    await expect(setBillLine(BILL, 1, { account_id: 'a2' })).rejects.toThrow(/already in the ledger/);
    expect(mockQuery.mock.calls).toHaveLength(1);
  });

  it('never changes an amount: coding is ours, the amount is the vendor’s', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: BILL, status: 'draft', bill_number: 'BILL-7' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ line_number: 1 }] });
    await setBillLine(BILL, 1, { account_id: 'a2', unit_price: '1' } as never);
    expect(sql(1)).not.toMatch(/unit_price|line_amount|total_amount/);
  });

  it('names the missing line rather than reporting success on zero rows', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: BILL, status: 'draft', bill_number: 'BILL-7' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(setBillLine(BILL, 9, { account_id: 'a2' })).rejects.toThrow(
      expect.objectContaining({ name: 'NotFoundError', message: expect.stringContaining('line 9') })
    );
  });

  it('refuses an empty patch', async () => {
    await expect(setBillLine(BILL, 1, {})).rejects.toThrow(ValidationError);
    expect(mockTx).not.toHaveBeenCalled();
  });
});

// ============================================================
// APPROVAL — the ledger boundary
// ============================================================

describe('approveBill', () => {
  const approved = { id: BILL, entity_id: ENTITY, bill_number: 'BILL-7', total_amount: '3480.0000' };

  function primeApproval(entry: { id: string; entry_number: string } | null): void {
    mockQuery.mockResolvedValueOnce({ rows: [approved] });      // UPDATE ... RETURNING
    mockQuery.mockResolvedValueOnce({ rows: [{ line_number: 1 }] }); // bill_lines
    mockPost.mockResolvedValueOnce(entry);
    if (entry) mockQuery.mockResolvedValueOnce({ rows: [{ line_number: 1 }] }); // entry lines
  }

  it('only moves a bill that is still approvable, and says so in the SQL', async () => {
    primeApproval({ id: 'je1', entry_number: 'JE-1' });
    await approveBill(BILL, USER);
    expect(sql(0)).toMatch(/UPDATE bills SET status = 'approved', approved_by = \$1, approved_at = NOW\(\)/);
    expect(sql(0)).toMatch(/AND status IN \('draft', 'pending_approval'\)/);
    expect(APPROVABLE_STATUSES).toEqual(['draft', 'pending_approval']);
  });

  it('does not scope by entity when no entity was given — the REST contract', async () => {
    primeApproval({ id: 'je1', entry_number: 'JE-1' });
    await approveBill(BILL, USER);
    expect(sql(0)).not.toMatch(/entity_id/);
    expect(params(0)).toEqual([USER, BILL]);
  });

  it('scopes by entity when one is given, so a CLI cannot approve another company’s bill', async () => {
    primeApproval({ id: 'je1', entry_number: 'JE-1' });
    await approveBill(BILL, USER, { entityId: ENTITY });
    expect(sql(0)).toMatch(/WHERE id = \$2 AND entity_id = \$3 AND status IN/);
    expect(params(0)).toEqual([USER, BILL, ENTITY]);
  });

  it('posts through postBillEntry on the SAME client, so the entry and the status commit together', async () => {
    primeApproval({ id: 'je1', entry_number: 'JE-1' });
    const result = await approveBill(BILL, USER);
    expect(mockPost).toHaveBeenCalledWith({ query: mockQuery }, approved, [{ line_number: 1 }], USER);
    expect(result.attestation).toEqual({ entityId: ENTITY, entryId: 'je1' });
    expect(committed).toBe(true);
  });

  it('reports no attestation when nothing was posted (already posted, or a zero total)', async () => {
    primeApproval(null);
    const result = await approveBill(BILL, USER);
    expect(result.entry).toBeNull();
    expect(result.attestation).toBeNull();
  });

  it('throws NotFound when the bill does not exist or has moved on', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(approveBill(BILL, USER)).rejects.toThrow(NotFoundError);
  });

  // The property the whole preview rests on:
  it('DRY RUN runs the real posting and then leaves the transaction unfinished', async () => {
    primeApproval({ id: 'je1', entry_number: 'JE-1' });
    const result = await approveBill(BILL, USER, { dryRun: true });

    // It really ran: the same UPDATE, the same postBillEntry.
    expect(sql(0)).toMatch(/UPDATE bills SET status = 'approved'/);
    expect(mockPost).toHaveBeenCalledTimes(1);
    // And it really did not commit — the callback threw, so withTransaction
    // rolls back and nothing above ever reached the database.
    expect(committed).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.entry).toEqual({ id: 'je1', entry_number: 'JE-1' });
  });

  it('does not swallow a real failure as if it were a dry run', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [approved] });
    mockQuery.mockResolvedValueOnce({ rows: [{ line_number: 1 }] });
    mockPost.mockRejectedValueOnce(new Error('MISSING_ROLE_ACCOUNT'));
    await expect(approveBill(BILL, USER, { dryRun: true })).rejects.toThrow('MISSING_ROLE_ACCOUNT');
  });
});

// ============================================================
// EARLY PAYMENT DISCOUNT
// ============================================================

describe('earlyPaymentDiscount', () => {
  const bill = { amount_due: '1000.0000', bill_date: '2026-08-01', terms: '2/10 Net 30' };

  it('applies the discount inside the window', () => {
    expect(earlyPaymentDiscount(bill, '2026-08-05')).toEqual({
      discountAmount: '20.0000', paymentAmount: '980.0000', applied: true,
    });
  });

  it('applies it on the last day of the window, not the day before', () => {
    expect(earlyPaymentDiscount(bill, '2026-08-11').applied).toBe(true);
  });

  it('does not apply it after the window', () => {
    expect(earlyPaymentDiscount(bill, '2026-08-20')).toEqual({
      discountAmount: '0.0000', paymentAmount: '1000.0000', applied: false,
    });
  });

  it('leaves the amount alone when the terms carry no discount', () => {
    expect(earlyPaymentDiscount({ ...bill, terms: 'Net 30' }, '2026-08-02').applied).toBe(false);
    expect(earlyPaymentDiscount({ ...bill, terms: null }, '2026-08-02').paymentAmount).toBe('1000.0000');
  });
});
