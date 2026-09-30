import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice, listInvoices, listInvoiceAllocations } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment,
  applyCustomerPayment,
  unapplyCustomerPayment,
  reverseCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { arReconcile, runArChecks } from '../../src/services/ar/ar-controls.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { ValidationError } from '../../src/utils/errors.js';
import type { Invoice } from '../../src/types/index.js';

/**
 * MNE-001-113 (#309) · A COLLECTION WITH WITHHOLDING IS APPLIED.
 *
 * A legal entity that pays an individual for fees withholds 10 % ISR and two
 * thirds of the VAT and pays the rest. On the issuer's books the invoice is
 * settled in full: the cash leaves on-account, the withholding goes to the
 * roles isr_retenido_a_favor (1145) and iva_retenido_a_favor (1146), and the
 * receivable closes. Unapplying and reversing reopen exactly what was closed.
 */

let f: Fixture;
let customerId: string;

const day = (): string => {
  const d = fechaEnPeriodo();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Fees of 10 000 plus 16 % VAT, issued and posted. */
async function feesInvoice(terms: string | null = null): Promise<Invoice> {
  const draft = await createInvoice({
    entity_id: f.entityId,
    customer_id: customerId,
    invoice_date: day(),
    due_date: day(),
    currency_code: 'MXN',
    terms,
    lines: [
      {
        revenue_account_id: f.cuentas['4100'],
        description: 'Professional fees',
        quantity: '1',
        unit_price: '10000.00',
        tax_rate: '16.0000',
      },
    ],
    created_by: f.userId,
  });
  return (await issueInvoice(draft.id, f.userId, { entityId: f.entityId })).invoice;
}

/** The net the customer transfers, recorded as cash on account. */
async function netOnAccount(amount: string): Promise<string> {
  const r = await recordCustomerPayment(
    {
      entityId: f.entityId,
      counterpartyId: customerId,
      paymentAmount: amount,
      paymentDate: day(),
      paymentMethod: 'spei',
      applications: [],
      onAccount: true,
    },
    f.userId
  );
  return r.paymentId;
}

async function linesOf(entryId: string): Promise<Record<string, { debit: number; credit: number }>> {
  const r = await query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, COALESCE(SUM(l.debit_amount), 0)::text AS debit, COALESCE(SUM(l.credit_amount), 0)::text AS credit
       FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
      WHERE l.journal_entry_id = $1 GROUP BY a.code`,
    [entryId]
  );
  return Object.fromEntries(r.rows.map((l) => [l.code, { debit: Number(l.debit), credit: Number(l.credit) }]));
}

async function balance(code: string): Promise<number> {
  const r = await query<{ b: string }>(
    `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::text AS b
       FROM journal_entry_lines l
       JOIN journal_entries je ON je.id = l.journal_entry_id AND je.status = 'posted'
       JOIN accounts a ON a.id = l.account_id
      WHERE a.entity_id = $1 AND a.code = $2`,
    [f.entityId, code]
  );
  return Number(r.rows[0].b);
}

async function invoiceRow(id: string) {
  const r = await query<{ status: string; amount_due: string; amount_paid: string }>(
    'SELECT status, amount_due, amount_paid FROM invoices WHERE id = $1', [id]
  );
  return { status: r.rows[0].status, due: Number(r.rows[0].amount_due), paid: Number(r.rows[0].amount_paid) };
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-113 withholding on collection');
  customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1, $2, 'C-113-001', 'Synthetic Payer SA', 'MXN', $3)`,
    [customerId, f.entityId, f.userId]
  );
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('receipt apply with the customer withholding', () => {
  let invoice: Invoice;
  let paymentId: string;

  it('settles the invoice in full and books the withholding on its role accounts', async () => {
    invoice = await feesInvoice();
    paymentId = await netOnAccount('9533.33');
    const isrBefore = await balance('1145');

    const r = await applyCustomerPayment(
      f.entityId, paymentId,
      [{ documentId: invoice.id, amountApplied: '9533.33', withholdingIsr: '1000.00', withholdingIva: '1066.67' }],
      f.userId
    );

    expect(r.remanenteAnterior).toBe('9533.33');
    expect(r.remanenteNuevo).toBe('0.00');
    expect(r.documentos[0]).toMatchObject({ saldoAnterior: '11600.00', saldoNuevo: '0.00', estado: 'paid' });

    const lines = await linesOf(r.journalEntry!.id);
    expect(lines['2150'].debit).toBeCloseTo(9533.33); // the cash leaves on-account
    expect(lines['1145'].debit).toBeCloseTo(1000); // ISR withheld by the customer
    expect(lines['1146'].debit).toBeCloseTo(1066.67); // VAT withheld by the customer
    expect(lines['1120'].credit).toBeCloseTo(11600); // the whole receivable closes

    expect(await invoiceRow(invoice.id)).toEqual({ status: 'paid', due: 0, paid: 11600 });
    // The role account's balance is the sum of what customers withheld.
    expect(await balance('1145')).toBeCloseTo(isrBefore + 1000);

    const alloc = await query<{ isr: string; iva: string; cash: string }>(
      `SELECT withholding_isr_amount::text AS isr, withholding_iva_amount::text AS iva, amount_applied::text AS cash
         FROM payment_allocations WHERE payment_id = $1 AND unapplied_at IS NULL`,
      [paymentId]
    );
    expect(alloc.rows).toEqual([{ isr: '1000.0000', iva: '1066.6700', cash: '9533.3300' }]);
    // `invoice show` reads the same row: its allocations add up to amount_paid.
    expect(await listInvoiceAllocations(invoice.id)).toEqual([
      expect.objectContaining({
        amount_applied: '9533.3300', withholding_isr_amount: '1000.0000', withholding_iva_amount: '1066.6700',
      }),
    ]);

    // The as-of balance agrees with amount_due: a withheld peso is not owed.
    const { rows } = await listInvoices(f.entityId, { customerId, asOf: '2026-12-31', dateBasis: 'posting', withAging: true });
    const asOf = rows.find((x) => x.invoice_number === invoice.invoice_number) as unknown as { amount_due_as_of: string };
    expect(Number(asOf.amount_due_as_of)).toBeCloseTo(0);
  });

  it('unapplying reopens the cash and the withholding, and takes the withholding off its accounts', async () => {
    const isrBefore = await balance('1145');
    const ivaBefore = await balance('1146');
    const r = await unapplyCustomerPayment(
      f.entityId, paymentId, { invoiceId: invoice.id, reason: 'wrong invoice' }, f.userId
    );

    expect(r.desaplicado).toBe('9533.33');
    // The withholding it takes back is reported, not just the cash.
    expect(r.documento).toMatchObject({ withholdingIsr: '1000.00', withholdingIva: '1066.67' });
    expect(r.documento.saldoNuevo).toBe('11600.00');
    expect(await invoiceRow(invoice.id)).toEqual({ status: 'sent', due: 11600, paid: 0 });
    const lines = await linesOf(r.journalEntry.id);
    expect(lines['1120'].debit).toBeCloseTo(11600);
    expect(lines['2150'].credit).toBeCloseTo(9533.33);
    expect(lines['1145'].credit).toBeCloseTo(1000);
    expect(lines['1146'].credit).toBeCloseTo(1066.67);
    expect(await balance('1145')).toBeCloseTo(isrBefore - 1000);
    expect(await balance('1146')).toBeCloseTo(ivaBefore - 1066.67);
  });

  it('an NSF reversal reopens the whole settlement, withholding included', async () => {
    const other = await feesInvoice();
    const pid = await netOnAccount('9533.33');
    const isrBefore = await balance('1145');
    const ivaBefore = await balance('1146');
    await applyCustomerPayment(
      f.entityId, pid,
      [{ documentId: other.id, amountApplied: '9533.33', withholdingIsr: '1000.00', withholdingIva: '1066.67' }],
      f.userId
    );
    const r = await reverseCustomerPayment(f.entityId, pid, { reason: 'bounced' }, f.userId);
    expect(r.documentosReabiertos[0].saldoNuevo).toBe('11600.00');
    expect(await invoiceRow(other.id)).toEqual({ status: 'sent', due: 11600, paid: 0 });
    // The mirror took the withholding off its role accounts, and no live
    // allocation keeps it.
    expect(await balance('1145')).toBeCloseTo(isrBefore);
    expect(await balance('1146')).toBeCloseTo(ivaBefore);
    const live = await query('SELECT 1 FROM payment_allocations WHERE payment_id = $1 AND unapplied_at IS NULL', [pid]);
    expect(live.rowCount).toBe(0);
  });

  it('on a PPD invoice the whole VAT is caused: the withheld part was collected too', async () => {
    const ppd = await feesInvoice('PPD');
    const pid = await netOnAccount('9533.33');
    const r = await applyCustomerPayment(
      f.entityId, pid,
      [{ documentId: ppd.id, amountApplied: '9533.33', withholdingIsr: '1000.00', withholdingIva: '1066.67' }],
      f.userId
    );
    const lines = await linesOf(r.journalEntry!.id);
    expect(lines['2125'].debit).toBeCloseTo(1600);
    expect(lines['2120'].credit).toBeCloseTo(1600);
  });

  it('refuses a withholding the invoice cannot carry', async () => {
    const inv = await feesInvoice();
    const pid = await netOnAccount('9533.33');
    const apply = (isr: string, iva: string, cash = '9533.33') =>
      applyCustomerPayment(
        f.entityId, pid, [{ documentId: inv.id, amountApplied: cash, withholdingIsr: isr, withholdingIva: iva }], f.userId
      );
    // More than the invoice owes, once the cash is counted.
    await expect(apply('1000.00', '1100.00')).rejects.toThrow(/11600\.00/);
    // More VAT than the invoice transferred.
    await expect(apply('0', '1600.01', '100.00')).rejects.toThrow(/1600\.00/);
    // More ISR than the invoice's subtotal.
    await expect(apply('10000.01', '0', '100.00')).rejects.toThrow(/10000\.00/);
    await expect(apply('-1', '0')).rejects.toThrow(/negative/);
    // A withholding rides on cash: alone it is refused before Postgres sees it.
    const alone = apply('1000.00', '0', '0');
    await expect(alone).rejects.toBeInstanceOf(ValidationError);
    await expect(alone).rejects.toThrow(/greater than zero/);
    expect(await invoiceRow(inv.id)).toEqual({ status: 'sent', due: 11600, paid: 0 });
  });

  it('unapply refuses when the invoice no longer shows what the collection settled', async () => {
    const inv = await feesInvoice();
    const pid = await netOnAccount('9533.33');
    await applyCustomerPayment(
      f.entityId, pid,
      [{ documentId: inv.id, amountApplied: '9533.33', withholdingIsr: '1000.00', withholdingIva: '1066.67' }],
      f.userId
    );
    // Someone else took 5000 off amount_paid meanwhile: reopening 11600
    // would leave it negative, so the guarded UPDATE matches no row.
    await query('UPDATE invoices SET amount_paid = amount_paid - 5000 WHERE id = $1', [inv.id]);
    try {
      await expect(
        unapplyCustomerPayment(f.entityId, pid, { invoiceId: inv.id, reason: 'race' }, f.userId)
      ).rejects.toThrow(/less paid than this collection settled/);
      const live = await query('SELECT 1 FROM payment_allocations WHERE payment_id = $1 AND unapplied_at IS NULL', [pid]);
      expect(live.rowCount).toBe(1);
    } finally {
      await query('UPDATE invoices SET amount_paid = amount_paid + 5000 WHERE id = $1', [inv.id]);
    }
  });

  it('over-application counts the withholding, not just the cash', async () => {
    const inv = await feesInvoice();
    const pid = await netOnAccount('9533.33');
    await applyCustomerPayment(
      f.entityId, pid,
      [{ documentId: inv.id, amountApplied: '9533.33', withholdingIsr: '1000.00', withholdingIva: '1066.67' }],
      f.userId
    );
    const probe = async () =>
      (await runArChecks(f.entityId, { checks: ['over-application'] })).results[0];
    // Cash plus withholding equals the total: a settled invoice, not an excess.
    expect((await probe()).count).toBe(0);
    // A row that promises 100 more than the invoice (as a hand edit would):
    // the cash alone (9533.33) is still below 11600, only the withholding
    // tells the probe the subledger promises more than was invoiced.
    await query(
      `UPDATE payment_allocations SET withholding_iva_amount = withholding_iva_amount + 100
        WHERE payment_id = $1 AND invoice_id = $2 AND unapplied_at IS NULL`,
      [pid, inv.id]
    );
    try {
      const r = await probe();
      expect(r.count).toBe(1);
      expect(r.sample[0]).toContain(`${inv.invoice_number}: 11700.00`);
    } finally {
      await query(
        `UPDATE payment_allocations SET withholding_iva_amount = withholding_iva_amount - 100
          WHERE payment_id = $1 AND invoice_id = $2 AND unapplied_at IS NULL`,
        [pid, inv.id]
      );
    }
  });

  it('after all of it the subledger still ties to the control account', async () => {
    const r = await arReconcile(f.entityId);
    expect(r.balanced, `delta ${r.delta}`).toBe(true);
    expect(new Decimal(await balance('1146')).toFixed(2)).toBe('3200.01');
  });
});

describe('an invoice whose receivable was booked net of the withholding', () => {
  /**
   * The shape issued-invoice-approval.ts gives an invoice born from an issued
   * CFDI with retenciones: total and amount_due are the CFDI's net total, and
   * the issuance entry already debited 1145/1146 for what the customer
   * withholds.
   */
  async function netBookedInvoice(): Promise<{ id: string; number: string }> {
    const id = uuidv4();
    const number = `INV-113-NET-${id.slice(0, 8)}`;
    await query(
      `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
                             amount_due, amount_paid, currency_code, invoice_date, due_date, status,
                             cfdi_uuid, cfdi_status, created_by)
       VALUES ($1, $2, $3, $4, 10000, 1600, 9533.33, 9533.33, 0, 'MXN', $5, $5, 'sent', $6, 'stamped', $7)`,
      [id, f.entityId, number, customerId, day(), uuidv4(), f.userId]
    );
    const entry = await createJournalEntry(
      f.entityId, day(), 'auto_invoice' as never, `CFDI issued ${number}`,
      [
        { account_id: f.roles.cxc, debit_amount: '9533.33', credit_amount: null, description: 'AR net' },
        { account_id: f.roles.isr_retenido_a_favor, debit_amount: '1000.00', credit_amount: null, description: 'ISR withheld' },
        { account_id: f.roles.iva_retenido_a_favor, debit_amount: '1066.67', credit_amount: null, description: 'VAT withheld' },
        { account_id: f.cuentas['4100'], debit_amount: null, credit_amount: '10000.00', description: 'fees' },
        { account_id: f.roles.iva_trasladado, debit_amount: null, credit_amount: '1600.00', description: 'VAT' },
      ] as never,
      f.userId,
      { autoPost: true, sourceType: 'invoice', sourceId: id }
    );
    await query('UPDATE invoices SET journal_entry_id = $1 WHERE id = $2 AND entity_id = $3', [entry.id, id, f.entityId]);
    return { id, number };
  }

  it('refuses a second withholding: it would count the same ISR and VAT twice', async () => {
    const inv = await netBookedInvoice();
    const pid = await netOnAccount('5000.00');
    const isrBefore = await balance('1145');
    await expect(
      applyCustomerPayment(
        f.entityId, pid,
        [{ documentId: inv.id, amountApplied: '5000.00', withholdingIsr: '500.00', withholdingIva: '533.33' }],
        f.userId
      )
    ).rejects.toThrow(new RegExp(`${inv.number} already booked the customer's withholding \\(2066\\.67\\)`));
    expect(await invoiceRow(inv.id)).toEqual({ status: 'sent', due: 9533.33, paid: 0 });
    expect(await balance('1145')).toBeCloseTo(isrBefore);

    // The cash alone is what it takes: the receivable is already the net.
    const r = await applyCustomerPayment(
      f.entityId, pid, [{ documentId: inv.id, amountApplied: '5000.00' }], f.userId
    );
    expect(r.documentos[0]).toMatchObject({ saldoAnterior: '9533.33', saldoNuevo: '4533.33' });
  });
});
