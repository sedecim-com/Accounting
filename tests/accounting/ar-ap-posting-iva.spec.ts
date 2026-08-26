import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/services/accounting/posting.js', () => ({
  createJournalEntry: vi.fn(async () => ({ id: 'je-1' })),
}));

import type pg from 'pg';
import {
  postInvoiceEntry,
  postBillEntry,
  postCustomerPaymentEntry,
  postVendorPaymentEntry,
} from '../../src/services/accounting/ar-ap-posting.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { logger } from '../../src/utils/logger.js';
import type { Invoice, InvoiceLine, Bill, BillLine } from '../../src/types/index.js';

const mockCreate = createJournalEntry as unknown as ReturnType<typeof vi.fn>;
const mockWarn = logger.warn as unknown as ReturnType<typeof vi.fn>;

const ENTITY = 'e0000000-0000-0000-0000-000000000001';
const USER = 'u0000000-0000-0000-0000-000000000001';

/**
 * A pg client that answers by SQL shape. Account roles are echoed back as
 * `acct:<role>`, so an assertion on an account_id is an assertion on the
 * ROLE the engine chose — which is the whole point of these tests.
 */
interface FakeState {
  country: string;
  standard: string;
  /** metodo_pago the ingested CFDI reports, by invoice cfdi_uuid or bill id. */
  cfdiMetodo: Record<string, string | null>;
  /** Rows the allocation/application query returns. */
  applied: Array<Record<string, unknown>>;
  /**
   * IVA still sitting in the pending account per document. A document posted
   * BEFORE cash-basis IVA existed parked nothing, and the release must
   * therefore move nothing for it — so this defaults to "fully parked" for
   * the documents these tests post, and is set to '0' to model history.
   */
  parked?: Record<string, string>;
}

let state: FakeState;
let sqlLog: string[];

function fakeClient(): pg.PoolClient {
  const query = async (text: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const sql = String(text).replace(/\s+/g, ' ');
    sqlLog.push(sql);

    if (sql.includes('FROM legal_entities')) {
      return { rows: [{ incorporation_country: state.country, accounting_standard: state.standard }] };
    }
    if (sql.includes('FROM xml_documents WHERE cfdi_uuid')) {
      const uuid = String((params ?? [])[0]);
      const metodo = state.cfdiMetodo[uuid];
      return { rows: metodo === undefined ? [] : [{ metodo_pago: metodo }] };
    }
    if (sql.includes('FROM pre_registrations')) {
      const billId = String((params ?? [])[0]);
      const metodo = state.cfdiMetodo[billId];
      return { rows: metodo === undefined ? [] : [{ metodo_pago: metodo }] };
    }
    // The release cap: how much this document actually parked. Checked BEFORE
    // the generic account_roles branch because the query joins that table.
    if (sql.includes('AS parked')) {
      const documentId = String((params ?? [])[2]);
      const override = state.parked?.[documentId];
      if (override !== undefined) return { rows: [{ parked: override }] };
      // Default: whatever the applied row says the document's whole IVA is,
      // i.e. the document was posted under cash-basis rules and parked it all.
      const row = state.applied.find((r) => r.document_id === documentId);
      return { rows: [{ parked: String(row?.tax_amount ?? '0') }] };
    }
    if (sql.includes('FROM account_roles')) {
      const roles = ((params ?? [])[1] ?? []) as string[];
      return { rows: roles.map((role) => ({ role, account_id: `acct:${role}` })) };
    }
    if (sql.includes('FROM payment_allocations pa') || sql.includes('FROM payment_applications pa')) {
      return { rows: state.applied };
    }
    if (sql.includes('FROM bank_accounts')) {
      return { rows: [] };
    }
    return { rows: [] };
  };
  return { query } as unknown as pg.PoolClient;
}

beforeEach(() => {
  mockCreate.mockClear();
  mockWarn.mockClear();
  sqlLog = [];
  state = { country: 'MX', standard: 'mx_nif', cfdiMetodo: {}, applied: [] };
});

/** The lines the engine handed to createJournalEntry. */
function lines(): Array<{ account_id: string; debit_amount: string | null; credit_amount: string | null; description: string }> {
  return mockCreate.mock.calls[0][4];
}
function entryDescription(): string {
  return mockCreate.mock.calls[0][3];
}
function lineFor(accountId: string) {
  return lines().find((l) => l.account_id === accountId);
}

const invoice = (over: Partial<Invoice> = {}): Invoice =>
  ({
    id: 'inv-1',
    entity_id: ENTITY,
    invoice_number: 'INV-001',
    subtotal: '1000.0000',
    tax_amount: '160.0000',
    total_amount: '1160.0000',
    invoice_date: new Date('2026-08-15'),
    journal_entry_id: null,
    cfdi_uuid: null,
    terms: null,
    memo: null,
    ...over,
  }) as unknown as Invoice;

const invoiceLines = (): InvoiceLine[] =>
  [{ line_number: 1, description: 'Servicio', line_amount: '1000.0000', revenue_account_id: 'acct:revenue' }] as unknown as InvoiceLine[];

const bill = (over: Partial<Bill> = {}): Bill =>
  ({
    id: 'bill-1',
    entity_id: ENTITY,
    bill_number: 'BILL-001',
    subtotal: '500.0000',
    tax_amount: '80.0000',
    total_amount: '580.0000',
    bill_date: new Date('2026-08-15'),
    journal_entry_id: null,
    terms: null,
    memo: null,
    ...over,
  }) as unknown as Bill;

const billLines = (): BillLine[] =>
  [{ line_number: 1, description: 'Gasto', line_amount: '500.0000', account_id: 'acct:expense' }] as unknown as BillLine[];

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'pay-1',
  entity_id: ENTITY,
  payment_number: 'PMT-001',
  payment_amount: '1160.0000',
  payment_date: new Date('2026-09-10'),
  bank_account_id: null,
  journal_entry_id: null,
  ...over,
});

// ============================================================
// ISSUANCE — THE FOUR CASES
// ============================================================

describe('the four issuance cases land in the four accounts', () => {
  it('invoice PUE → CR iva_trasladado 160', async () => {
    state.cfdiMetodo = { 'UUID-1': 'PUE' };
    await postInvoiceEntry(fakeClient(), invoice({ cfdi_uuid: 'UUID-1' } as Partial<Invoice>), invoiceLines(), USER);

    const iva = lineFor('acct:iva_trasladado');
    expect(iva).toBeDefined();
    expect(iva!.credit_amount).toBe('160.0000');
    expect(iva!.debit_amount).toBeNull();
    expect(iva!.description).toMatch(/IVA PUE - Invoice INV-001/);
    expect(lineFor('acct:iva_trasladado_no_cobrado')).toBeUndefined();
  });

  it('invoice PPD → CR iva_trasladado_no_cobrado 160, nothing in iva_trasladado', async () => {
    state.cfdiMetodo = { 'UUID-2': 'PPD' };
    await postInvoiceEntry(fakeClient(), invoice({ cfdi_uuid: 'UUID-2' } as Partial<Invoice>), invoiceLines(), USER);

    const iva = lineFor('acct:iva_trasladado_no_cobrado');
    expect(iva).toBeDefined();
    expect(iva!.credit_amount).toBe('160.0000');
    expect(iva!.description).toMatch(/IVA PPD - Invoice INV-001 · IVA not yet due/);
    expect(lineFor('acct:iva_trasladado')).toBeUndefined();
  });

  it('bill PUE → DR iva_acreditable 80', async () => {
    state.cfdiMetodo = { 'bill-1': 'PUE' };
    await postBillEntry(fakeClient(), bill(), billLines(), USER);

    const iva = lineFor('acct:iva_acreditable');
    expect(iva).toBeDefined();
    expect(iva!.debit_amount).toBe('80.0000');
    expect(iva!.credit_amount).toBeNull();
    expect(lineFor('acct:iva_pendiente_acreditar')).toBeUndefined();
  });

  it('bill PPD → DR iva_pendiente_acreditar 80, nothing creditable yet', async () => {
    state.cfdiMetodo = { 'bill-1': 'PPD' };
    await postBillEntry(fakeClient(), bill(), billLines(), USER);

    const iva = lineFor('acct:iva_pendiente_acreditar');
    expect(iva).toBeDefined();
    expect(iva!.debit_amount).toBe('80.0000');
    expect(iva!.description).toMatch(/IVA PPD - Bill BILL-001 · IVA not yet creditable/);
    expect(lineFor('acct:iva_acreditable')).toBeUndefined();
  });

  it('the entry still balances in every case', async () => {
    state.cfdiMetodo = { 'UUID-3': 'PPD' };
    await postInvoiceEntry(fakeClient(), invoice({ cfdi_uuid: 'UUID-3' } as Partial<Invoice>), invoiceLines(), USER);

    const debits = lines().reduce((s, l) => s + Number(l.debit_amount ?? 0), 0);
    const credits = lines().reduce((s, l) => s + Number(l.credit_amount ?? 0), 0);
    expect(debits).toBeCloseTo(credits, 4);
  });
});

// ============================================================
// NO METODO DE PAGO — THE CONSERVATIVE DEFAULT
// ============================================================

describe('a document with no MetodoPago', () => {
  it('treats an invoice as PUE, says so in the entry, and logs it', async () => {
    await postInvoiceEntry(fakeClient(), invoice(), invoiceLines(), USER);

    expect(lineFor('acct:iva_trasladado')!.credit_amount).toBe('160.0000');
    expect(lineFor('acct:iva_trasladado')!.description).toMatch(/IVA PUE \(assumed\)/);
    expect(entryDescription()).toBe('Invoice INV-001 · MetodoPago missing: PUE assumed');
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][1]).toMatchObject({ document: 'invoice', metodo_pago_assumed: 'PUE' });
  });

  it('treats a bill as PPD, so an unpaid invoice can never inflate the crediting', async () => {
    await postBillEntry(fakeClient(), bill(), billLines(), USER);

    expect(lineFor('acct:iva_pendiente_acreditar')!.debit_amount).toBe('80.0000');
    expect(lineFor('acct:iva_acreditable')).toBeUndefined();
    expect(entryDescription()).toBe('Bill BILL-001 · MetodoPago missing: PPD assumed');
    expect(mockWarn.mock.calls[0][1]).toMatchObject({ document: 'bill', metodo_pago_assumed: 'PPD' });
  });

  it('reads an explicit code out of the terms rather than assuming', async () => {
    await postBillEntry(fakeClient(), bill({ terms: 'PUE - pagado al contado' }), billLines(), USER);

    expect(lineFor('acct:iva_acreditable')!.debit_amount).toBe('80.0000');
    expect(entryDescription()).toBe('Bill BILL-001');
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

// ============================================================
// NON-MEXICAN ENTITIES ARE UNTOUCHED
// ============================================================

describe('a US entity', () => {
  beforeEach(() => {
    state.country = 'US';
    state.standard = 'us_gaap';
  });

  it('keeps posting an invoice tax exactly where it always did', async () => {
    await postInvoiceEntry(fakeClient(), invoice(), invoiceLines(), USER);

    expect(lineFor('acct:iva_trasladado')!.credit_amount).toBe('160.0000');
    expect(lineFor('acct:iva_trasladado')!.description).toBe('Tax - Invoice INV-001');
    expect(entryDescription()).toBe('Invoice INV-001');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('keeps posting a bill tax to iva_acreditable — cash-basis IVA is LIVA, not GAAP', async () => {
    await postBillEntry(fakeClient(), bill(), billLines(), USER);

    expect(lineFor('acct:iva_acreditable')!.debit_amount).toBe('80.0000');
    expect(lineFor('acct:iva_pendiente_acreditar')).toBeUndefined();
    expect(sqlLog.some((s) => s.includes('FROM xml_documents'))).toBe(false);
  });
});

// ============================================================
// THE PAYMENT RELEASES THE IVA
// ============================================================

const appliedInvoice = (over: Record<string, unknown> = {}) => ({
  document_id: 'inv-1',
  document_number: 'INV-001',
  tax_amount: '160.0000',
  total_amount: '1160.0000',
  applied_now: '1160.0000',
  applied_total: '1160.0000',
  terms: null,
  memo: null,
  cfdi_uuid: 'UUID-PPD',
  ...over,
});

const appliedBill = (over: Record<string, unknown> = {}) => ({
  document_id: 'bill-1',
  document_number: 'BILL-001',
  tax_amount: '80.0000',
  total_amount: '580.0000',
  applied_now: '580.0000',
  applied_total: '580.0000',
  terms: null,
  memo: null,
  ...over,
});

describe('customer payment applied to a PPD invoice', () => {
  it('moves the collected IVA out of 2125 and into IVA trasladado', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    state.applied = [appliedInvoice()];

    await postCustomerPaymentEntry(fakeClient(), payment(), USER);

    expect(lineFor('acct:iva_trasladado_no_cobrado')).toMatchObject({
      debit_amount: '160.0000',
      credit_amount: null,
    });
    expect(lineFor('acct:iva_trasladado')).toMatchObject({
      debit_amount: null,
      credit_amount: '160.0000',
    });
    expect(entryDescription()).toBe('Customer payment PMT-001 · IVA caused on collection: INV-001');
  });

  it('leaves the entry balanced: cash and tax are one event', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    state.applied = [appliedInvoice()];

    await postCustomerPaymentEntry(fakeClient(), payment(), USER);

    const debits = lines().reduce((s, l) => s + Number(l.debit_amount ?? 0), 0);
    const credits = lines().reduce((s, l) => s + Number(l.credit_amount ?? 0), 0);
    expect(debits).toBeCloseTo(1320, 4); // 1160 bank + 160 IVA released
    expect(debits).toBeCloseTo(credits, 4);
  });

  it('releases only the collected share on a partial collection', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    state.applied = [appliedInvoice({ applied_now: '580.0000', applied_total: '580.0000' })];

    await postCustomerPaymentEntry(fakeClient(), payment({ payment_amount: '580.0000' }), USER);

    expect(lineFor('acct:iva_trasladado_no_cobrado')!.debit_amount).toBe('80.0000');
    expect(lineFor('acct:iva_trasladado')!.credit_amount).toBe('80.0000');
  });

  it('releases the exact remainder on the closing collection', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PPD' };
    // 333.33 was collected before; this payment settles the rest.
    state.applied = [appliedInvoice({ applied_now: '826.6700', applied_total: '1160.0000' })];

    await postCustomerPaymentEntry(fakeClient(), payment({ payment_amount: '826.6700' }), USER);

    expect(lineFor('acct:iva_trasladado_no_cobrado')!.debit_amount).toBe('114.0234');
  });

  it('moves nothing for a PUE invoice: its IVA was already due', async () => {
    state.cfdiMetodo = { 'UUID-PPD': 'PUE' };
    state.applied = [appliedInvoice()];

    await postCustomerPaymentEntry(fakeClient(), payment(), USER);

    expect(lines()).toHaveLength(2);
    expect(entryDescription()).toBe('Customer payment PMT-001');
  });

  it('moves nothing when the payment applies to no document at all', async () => {
    await postCustomerPaymentEntry(fakeClient(), payment(), USER);
    expect(lines()).toHaveLength(2);
  });
});

describe('vendor payment applied to a PPD bill', () => {
  it('makes the paid IVA creditable — LIVA art. 5: on payment, not on receipt', async () => {
    state.cfdiMetodo = { 'bill-1': 'PPD' };
    state.applied = [appliedBill()];

    await postVendorPaymentEntry(fakeClient(), payment({ payment_number: 'VPMT-001', payment_amount: '580.0000' }), USER);

    expect(lineFor('acct:iva_acreditable')).toMatchObject({
      debit_amount: '80.0000',
      credit_amount: null,
    });
    expect(lineFor('acct:iva_pendiente_acreditar')).toMatchObject({
      debit_amount: null,
      credit_amount: '80.0000',
    });
    expect(entryDescription()).toBe('Vendor payment VPMT-001 · IVA creditable on payment: BILL-001');
  });

  it('moves nothing for a PUE bill', async () => {
    state.cfdiMetodo = { 'bill-1': 'PUE' };
    state.applied = [appliedBill()];

    await postVendorPaymentEntry(fakeClient(), payment({ payment_amount: '580.0000' }), USER);
    expect(lines()).toHaveLength(2);
  });

  it('does not touch the IVA of a US entity even when a bill was applied', async () => {
    state.country = 'US';
    state.standard = 'us_gaap';
    state.applied = [appliedBill()];

    await postVendorPaymentEntry(fakeClient(), payment({ payment_amount: '580.0000' }), USER);
    expect(lines()).toHaveLength(2);
  });
});

// ============================================================
// Composing with history. Every bill posted before cash-basis IVA existed
// sent its tax straight to 1130 and parked nothing. A payment applying such
// a bill must move NO IVA: crediting 1130 again would credit tax that was
// never deferred, and drive 1135 negative — the tell that the monthly
// return is wrong.
// ============================================================

describe('a document posted before the cutover releases nothing', () => {
  it('moves no IVA for a bill whose tax never reached the pending account', async () => {
    state.country = 'MX';
    state.applied = [
      {
        document_id: 'bill-old', document_number: 'B-OLD',
        tax_amount: '160.0000', total_amount: '1160.0000',
        applied_now: '1160.0000', applied_total: '1160.0000',
        terms: null, memo: null,
      },
    ];
    // The ledger says nothing is parked for it: it predates the change.
    state.parked = { 'bill-old': '0' };

    await postVendorPaymentEntry(fakeClient(), payment({ payment_number: 'VPMT-OLD', payment_amount: '1160.0000' }), USER);

    expect(lineFor('acct:iva_acreditable')).toBeUndefined();
    expect(lineFor('acct:iva_pendiente_acreditar')).toBeUndefined();
    // Cash and the payable still post: only the IVA leg is absent.
    expect(lines().length).toBe(2);
  });

  it('still releases for a bill that DID park, in the same shape as before', async () => {
    state.country = 'MX';
    state.applied = [
      {
        document_id: 'bill-new', document_number: 'B-NEW',
        tax_amount: '160.0000', total_amount: '1160.0000',
        applied_now: '1160.0000', applied_total: '1160.0000',
        terms: 'PPD', memo: null,
      },
    ];
    state.parked = { 'bill-new': '160.0000' };

    await postVendorPaymentEntry(fakeClient(), payment({ payment_number: 'VPMT-NEW', payment_amount: '1160.0000' }), USER);

    expect(lineFor('acct:iva_acreditable')).toMatchObject({ debit_amount: '160.0000', credit_amount: null });
    expect(lineFor('acct:iva_pendiente_acreditar')).toMatchObject({ debit_amount: null, credit_amount: '160.0000' });
  });

  it('caps a release at what is left when a prior payment already took some', async () => {
    state.country = 'MX';
    state.applied = [
      {
        document_id: 'bill-part', document_number: 'B-PART',
        tax_amount: '160.0000', total_amount: '1160.0000',
        applied_now: '1160.0000', applied_total: '1160.0000',
        terms: 'PPD', memo: null,
      },
    ];
    // 100 of the 160 was released by an earlier payment.
    state.parked = { 'bill-part': '60.0000' };

    await postVendorPaymentEntry(fakeClient(), payment({ payment_number: 'VPMT-PART', payment_amount: '1160.0000' }), USER);

    expect(lineFor('acct:iva_acreditable')).toMatchObject({ debit_amount: '60.0000' });
  });
});
