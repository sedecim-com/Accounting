import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createInvoice, issueInvoice, listInvoices } from '../../src/services/ar/invoice-service.js';
import {
  recordCustomerPayment,
  applyCustomerPayment,
  unapplyCustomerPayment,
  reverseCustomerPayment,
} from '../../src/services/payments/payment-service.js';
import { arReconcile } from '../../src/services/ar/ar-controls.js';
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
    await applyCustomerPayment(
      f.entityId, pid,
      [{ documentId: other.id, amountApplied: '9533.33', withholdingIsr: '1000.00', withholdingIva: '1066.67' }],
      f.userId
    );
    const r = await reverseCustomerPayment(f.entityId, pid, { reason: 'bounced' }, f.userId);
    expect(r.documentosReabiertos[0].saldoNuevo).toBe('11600.00');
    expect(await invoiceRow(other.id)).toEqual({ status: 'sent', due: 11600, paid: 0 });
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
    expect(await invoiceRow(inv.id)).toEqual({ status: 'sent', due: 11600, paid: 0 });
  });

  it('after all of it the subledger still ties to the control account', async () => {
    const r = await arReconcile(f.entityId);
    expect(r.balanced, `delta ${r.delta}`).toBe(true);
    expect(new Decimal(await balance('1146')).toFixed(2)).toBe('1066.67');
  });
});
