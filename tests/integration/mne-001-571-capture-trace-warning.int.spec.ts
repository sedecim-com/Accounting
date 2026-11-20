import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { approveBill } from '../../src/services/ap/bill-service.js';
import { createInvoice, issueInvoice } from '../../src/services/ar/invoice-service.js';
import { recordCustomerPayment, recordVendorPayment, type EntradaPago } from '../../src/services/payments/payment-service.js';
import { generarPolizas } from '../../src/services/sat/anexo24/polizas-service.js';
import { untracedPaymentFinding } from '../../src/services/sat/anexo24/untraced-payment-finding.js';
import { warnUntracedPayment } from '../../src/cli/trace-completion-output.js';
import { encrypt } from '../../src/utils/encryption.js';

// ============================================================
// MNE-001-571 (#612, part 4/4) · THE CAPTURE WARNING IS THE GENERATOR'S
// FINDING, AGAINST POSTGRES. What `payment create` and `receipt record` say
// after writing is what `voucher generate` will say of that voucher, word for
// word, so the two can never disagree about what is missing or how to
// complete it. Every party is synthetic.
// ============================================================

const CLABE = '012180001234567895';
const TO_ACCOUNT = '002180001122334455';
const REQUEST = { tipo: 'AF' as const, numOrden: 'ABC1234567/26' };
const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

let f: Fixture;
let vendorId: string;
let customerId: string;
let operativaId: string;
let uncodedId: string;

async function vendorPayment(date: string, extra: Partial<EntradaPago>): Promise<{ id: string; entry: string }> {
  const billId = uuidv4();
  const tag = billId.slice(0, 8);
  await query(
    `INSERT INTO bills (id, entity_id, bill_number, vendor_id, vendor_invoice_number, subtotal, tax_amount, total_amount,
       amount_due, amount_paid, currency_code, bill_date, due_date, status, created_by, terms, cfdi_uuid)
     VALUES ($1,$2,$3,$4,$5,100.00,16.00,116.00,116.00,0,'MXN',$6,$6,'draft',$7,'PPD',$8)`,
    [billId, f.entityId, `BILL-${tag}`, vendorId, `CFDI-${tag}`, date, f.userId, uuidv4()]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio a crédito',1,100.00,100.00,16.00,116.00)`,
    [uuidv4(), billId, f.cuentas['6100']]
  );
  await approveBill(billId, f.userId, { entityId: f.entityId });
  const r = await recordVendorPayment(
    {
      entityId: f.entityId, paymentAmount: '116.00', paymentDate: date, paymentMethod: 'spei',
      applications: [{ documentId: billId, amountApplied: '116.00' }], ...extra,
    },
    f.userId
  );
  return { id: r.paymentId, entry: r.journalEntry?.entry_number ?? '' };
}

async function receipt(date: string, extra: Partial<EntradaPago>): Promise<{ id: string; entry: string }> {
  const revenue = (await query<{ id: string }>(`SELECT id FROM accounts WHERE entity_id = $1 AND code = '4100'`, [f.entityId])).rows[0].id;
  const draft = await createInvoice({
    entity_id: f.entityId, customer_id: customerId, invoice_date: date, due_date: date, currency_code: 'MXN',
    lines: [{ revenue_account_id: revenue, description: 'Servicio', quantity: '1', unit_price: '100.00', tax_rate: '16.0000' }],
    created_by: f.userId,
  });
  const issued = await issueInvoice(draft.id, f.userId, { entityId: f.entityId });
  const total = new Decimal('100.00').times('1.16').toFixed(2);
  const r = await recordCustomerPayment(
    {
      entityId: f.entityId, paymentAmount: total, paymentDate: date, paymentMethod: 'spei',
      applications: [{ documentId: issued.invoice.id, amountApplied: total }], ...extra,
    },
    f.userId
  );
  return { id: r.paymentId, entry: r.journalEntry?.entry_number ?? '' };
}

/** What the CLI writes to stderr after recording, with nothing else around it. */
async function warned(side: 'vendor' | 'customer', id: string, json = false): Promise<string> {
  const err: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    await warnUntracedPayment(side, f.entityId, id, { palette: plain, json });
  } finally {
    process.stderr.write = original;
  }
  return err.join('');
}

/** The finding `voucher generate` makes of that entry, as the accountant reads it in the file's report. */
async function voucherFinding(month: string, entry: string): Promise<string> {
  const r = await generarPolizas(f.entityId, { periodo: `2026-${month}`, solicitud: REQUEST });
  const hs = r.hallazgos.filter((h) => h.check === 'poliza-con-dinero-sin-rastro' && h.referencia === entry);
  expect(hs).toHaveLength(1);
  return hs[0].detalle;
}

beforeAll(async () => {
  f = await crearInquilino('MNE-001-571 capture warning');
  await query(`UPDATE legal_entities SET name = 'Entidad de Prueba SA', tax_id = 'EPR010101AB1' WHERE id = $1`, [f.entityId]);
  vendorId = uuidv4();
  customerId = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,'V-571','Proveedor Puntual SA','PPU010101AB1','rfc','MXN',$3)`,
    [vendorId, f.entityId, f.userId]
  );
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, currency_code, created_by)
     VALUES ($1,$2,'C-571','Cliente Puntual SA','CPU010101AB1','MXN',$3)`,
    [customerId, f.entityId, f.userId]
  );
  operativaId = uuidv4();
  uncodedId = uuidv4();
  await query(
    `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id,
       currency_code, sat_bank_code, clabe_encrypted, clabe_last4, is_active)
     VALUES ($1,$2,'Operativa BBVA','BBVA México',$3,'MXN','012',$4,$5,true),
            ($6,$2,'Cuenta sin clave SAT','Banco Sin Clave',$7,'MXN',NULL,$4,$5,true)`,
    [operativaId, f.entityId, f.cuentas['1111'], encrypt(CLABE), CLABE.slice(-4), uncodedId, f.cuentas['1112']]
  );
}, 180_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('W1 · `payment create --method spei` with no --to-account', () => {
  it('warns with the voucher finding of its entry, word for word, naming the leaf that completes it', async () => {
    const p = await vendorPayment('2026-11-05', { bankAccountId: operativaId });
    const err = await warned('vendor', p.id);
    const detail = await voucherFinding('11', p.entry);
    expect(err).toContain(detail);
    expect(detail).toContain('payment trace record');
    expect(err).toContain('`mnemosine e-accounting voucher generate`');
    expect(err).toContain(p.entry);
  }, 60_000);
});

describe('causes the old hand list did not see are warned too', () => {
  it.each<[string, string, Partial<EntradaPago>, string]>([
    ['a payment with no bank account linked', '10', { cuentaDestino: TO_ACCOUNT, bancoDestinoSat: '002' }, '--bank <cuenta>'],
    ['a payment from a bank account with no c_Banco code', '09', { cuentaDestino: TO_ACCOUNT, bancoDestinoSat: '002' }, '--sat-bank-code'],
  ])('%s', async (_case, month, extra, remedy) => {
    const p = await vendorPayment(`2026-${month}-05`, { ...extra, ...(month === '09' ? { bankAccountId: uncodedId } : {}) });
    const err = await warned('vendor', p.id);
    expect(err).toContain(await voucherFinding(month, p.entry));
    expect(err).toContain(remedy);
  }, 60_000);

  it('a receipt with no payer bank names `receipt trace record`', async () => {
    const r = await receipt('2026-08-12', { bankAccountId: operativaId });
    const err = await warned('customer', r.id);
    expect(err).toContain(await voucherFinding('08', r.entry));
    expect(err).toContain('receipt trace record');
  }, 60_000);
});

describe('nothing is said when there is nothing to say', () => {
  it('a payment whose voucher carries its node, a cash payment, and --json', async () => {
    const traced = await vendorPayment('2026-07-05', { bankAccountId: operativaId, cuentaDestino: TO_ACCOUNT, bancoDestinoSat: '002' });
    expect(await untracedPaymentFinding(f.entityId, 'vendor', traced.id)).toBeNull();
    expect(await warned('vendor', traced.id)).toBe('');
    const cash = await vendorPayment('2026-07-06', { paymentMethod: 'cash' });
    expect(await warned('vendor', cash.id)).toBe('');
    const untraced = await vendorPayment('2026-07-07', { bankAccountId: operativaId });
    expect(await warned('vendor', untraced.id, true)).toBe('');
  }, 60_000);

  it('an entity that files no Anexo 24 (no RFC) is not warned', async () => {
    const p = await vendorPayment('2026-06-05', { bankAccountId: operativaId });
    await query(`UPDATE legal_entities SET tax_id_type = 'ein', tax_id = '12-3456789' WHERE id = $1`, [f.entityId]);
    try {
      expect(await untracedPaymentFinding(f.entityId, 'vendor', p.id)).toBeNull();
    } finally {
      await query(`UPDATE legal_entities SET tax_id_type = 'rfc', tax_id = 'EPR010101AB1' WHERE id = $1`, [f.entityId]);
    }
  }, 60_000);
});
