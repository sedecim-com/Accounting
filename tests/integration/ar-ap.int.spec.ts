import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { crearInquilino, fechaEnPeriodo, saldoDe, type Fixture } from './helpers/tenant-fixture.js';
import { query, withTransaction, closeDatabase } from '../../src/database/connection.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import {
  postInvoiceEntry,
  postBillEntry,
  postCustomerPaymentEntry,
  postVendorPaymentEntry,
} from '../../src/services/accounting/ar-ap-posting.js';
import type { Invoice, InvoiceLine, Bill, BillLine } from '../../src/types/index.js';

/**
 * Porta scripts/e2e-arap.ts. Diferencia esencial: los account_roles NO están
 * puestos a mano — los siembra el propio fixture llamando a
 * ensureEntityAccounting, que es justo lo que `mnemosine init` tenía que hacer
 * y no hacía. Si esa siembra se rompe, estas pruebas fallan con
 * MISSING_ROLE_ACCOUNT, que era el síntoma original.
 */
let f: Fixture;

beforeAll(async () => {
  f = await crearInquilino('Ciclo AR/AP');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function crearCliente(): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type,
      payment_terms, currency_code, created_by)
     VALUES ($1, $2, $3, 'Cliente de integración', 'XEXX010101000', 'rfc', 'Net 30', 'MXN', $4)`,
    [id, f.entityId, `C-IT-${id.slice(0, 8)}`, f.userId]
  );
  return id;
}

async function crearProveedor(): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type,
      payment_terms, currency_code, created_by)
     VALUES ($1, $2, $3, 'Proveedor de integración', 'XEXX010101000', 'rfc', 'Net 30', 'MXN', $4)`,
    [id, f.entityId, `V-IT-${id.slice(0, 8)}`, f.userId]
  );
  return id;
}

describe('la entidad recién sembrada puede contabilizar sin SQL a mano', () => {
  it('la siembra dejó los roles que AR/AP necesita', () => {
    for (const rol of ['cxc', 'cxp', 'banco', 'ingreso', 'gasto', 'iva_trasladado', 'iva_acreditable']) {
      expect(f.roles[rol], `falta el rol ${rol}`).toBeTruthy();
    }
  });

  it('factura de venta → DR CxC, CR Ingresos, CR IVA trasladado', async () => {
    const customerId = await crearCliente();
    const invId = uuidv4();
    await query(
      `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount,
        total_amount, amount_due, currency_code, invoice_date, due_date, status, created_by)
       VALUES ($1,$2,$3,$4,1000,160,1160,1160,'MXN',$5,$6,'sent',$7)`,
      [invId, f.entityId, `INV-IT-${invId.slice(0, 6)}`, customerId,
       fechaEnPeriodo(), fechaEnPeriodo(9), f.userId]
    );
    await query(
      `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price,
        revenue_account_id, tax_amount, line_amount, total_amount)
       VALUES ($1,$2,1,'Servicio',1,1000,$3,160,1000,1160)`,
      [uuidv4(), invId, f.roles.ingreso]
    );

    const cxcAntes = await saldoDe(f.roles.cxc, f.periodos[8]);
    const entry = await withTransaction(async (client) => {
      const inv = (await client.query<Invoice>('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invId])).rows[0];
      const lineas = (await client.query<InvoiceLine>('SELECT * FROM invoice_lines WHERE invoice_id = $1', [invId])).rows;
      return postInvoiceEntry(client, inv, lineas, f.userId);
    });

    expect(entry).not.toBeNull();
    expect(entry!.entry_type).toBe('auto_invoice');
    expect(await saldoDe(f.roles.cxc, f.periodos[8])).toBeCloseTo(cxcAntes + 1160, 4);
    expect(await saldoDe(f.roles.iva_trasladado, f.periodos[8])).toBeCloseTo(-160, 4);

    const { rows } = await query<{ journal_entry_id: string }>(
      'SELECT journal_entry_id FROM invoices WHERE id = $1', [invId]
    );
    expect(rows[0].journal_entry_id).toBe(entry!.id);

    // Idempotencia: el segundo intento no crea un segundo asiento.
    const otra = await withTransaction(async (client) => {
      const inv = (await client.query<Invoice>('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invId])).rows[0];
      return postInvoiceEntry(client, inv, [], f.userId);
    });
    expect(otra).toBeNull();
    expect(await saldoDe(f.roles.cxc, f.periodos[8])).toBeCloseTo(cxcAntes + 1160, 4);
  });

  it('factura de proveedor → CR CxP, DR Gasto, DR IVA acreditable', async () => {
    const vendorId = await crearProveedor();
    const billId = uuidv4();
    await query(
      `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount,
        total_amount, amount_due, currency_code, bill_date, due_date, status, created_by)
       VALUES ($1,$2,$3,$4,500,80,580,580,'MXN',$5,$6,'approved',$7)`,
      [billId, f.entityId, `BILL-IT-${billId.slice(0, 6)}`, vendorId,
       fechaEnPeriodo(), fechaEnPeriodo(9), f.userId]
    );
    await query(
      `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity,
        unit_price, line_amount, tax_amount, total_amount)
       VALUES ($1,$2,1,$3,'Gasto',1,500,500,80,580)`,
      [uuidv4(), billId, f.roles.gasto]
    );

    const entry = await withTransaction(async (client) => {
      const bill = (await client.query<Bill>('SELECT * FROM bills WHERE id = $1 FOR UPDATE', [billId])).rows[0];
      const lineas = (await client.query<BillLine>('SELECT * FROM bill_lines WHERE bill_id = $1', [billId])).rows;
      return postBillEntry(client, bill, lineas, f.userId);
    });

    expect(entry!.entry_type).toBe('auto_bill');
    expect(await saldoDe(f.roles.cxp, f.periodos[8])).toBeCloseTo(-580, 4);
    expect(await saldoDe(f.roles.iva_acreditable, f.periodos[8])).toBeCloseTo(80, 4);
  });

  it('cobro de cliente → DR Banco, CR CxC', async () => {
    const customerId = await crearCliente();
    const payId = uuidv4();
    await query(
      `INSERT INTO customer_payments (id, entity_id, payment_number, customer_id, payment_amount,
        payment_method, payment_date, status, created_by)
       VALUES ($1,$2,$3,$4,1160,'spei',$5,'completed',$6)`,
      [payId, f.entityId, `PMT-IT-${payId.slice(0, 6)}`, customerId, fechaEnPeriodo(), f.userId]
    );

    const bancoAntes = await saldoDe(f.roles.banco, f.periodos[8]);
    const entry = await withTransaction((client) =>
      postCustomerPaymentEntry(client, {
        id: payId, entity_id: f.entityId, payment_number: `PMT-IT-${payId.slice(0, 6)}`,
        payment_amount: '1160.0000', payment_date: fechaEnPeriodo(),
        bank_account_id: null, journal_entry_id: null,
      }, f.userId)
    );

    expect(entry!.entry_type).toBe('auto_payment');
    expect(await saldoDe(f.roles.banco, f.periodos[8])).toBeCloseTo(bancoAntes + 1160, 4);
  });

  it('pago a proveedor → DR CxP, CR Banco', async () => {
    const vendorId = await crearProveedor();
    const payId = uuidv4();
    await query(
      `INSERT INTO vendor_payments (id, entity_id, payment_number, vendor_id, payment_amount,
        payment_method, payment_date, status, created_by)
       VALUES ($1,$2,$3,$4,580,'spei',$5,'completed',$6)`,
      [payId, f.entityId, `VPMT-IT-${payId.slice(0, 6)}`, vendorId, fechaEnPeriodo(), f.userId]
    );

    const cxpAntes = await saldoDe(f.roles.cxp, f.periodos[8]);
    const entry = await withTransaction((client) =>
      postVendorPaymentEntry(client, {
        id: payId, entity_id: f.entityId, payment_number: `VPMT-IT-${payId.slice(0, 6)}`,
        payment_amount: '580.0000', payment_date: fechaEnPeriodo(),
        bank_account_id: null, journal_entry_id: null,
      }, f.userId)
    );

    expect(entry).not.toBeNull();
    expect(await saldoDe(f.roles.cxp, f.periodos[8])).toBeCloseTo(cxpAntes + 580, 4);
  });

  it('el índice único por documento impide dos asientos para la misma factura', async () => {
    const customerId = await crearCliente();
    const invId = uuidv4();
    await query(
      `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount,
        total_amount, amount_due, currency_code, invoice_date, due_date, status, created_by)
       VALUES ($1,$2,$3,$4,100,0,100,100,'MXN',$5,$6,'sent',$7)`,
      [invId, f.entityId, `INV-DUP-${invId.slice(0, 6)}`, customerId,
       fechaEnPeriodo(), fechaEnPeriodo(9), f.userId]
    );
    await query(
      `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price,
        revenue_account_id, tax_amount, line_amount, total_amount)
       VALUES ($1,$2,1,'x',1,100,$3,0,100,100)`,
      [uuidv4(), invId, f.roles.ingreso]
    );

    const inv = (await query<Invoice>('SELECT * FROM invoices WHERE id = $1', [invId])).rows[0];
    const lineas = (await query<InvoiceLine>('SELECT * FROM invoice_lines WHERE invoice_id = $1', [invId])).rows;
    await withTransaction((c) => postInvoiceEntry(c, inv, lineas, f.userId));

    // Forzar el camino que el guard de journal_entry_id no ve: el índice
    // parcial uq_je_document_source es la última línea de defensa.
    await expect(
      withTransaction((c) => postInvoiceEntry(c, { ...inv, journal_entry_id: null } as Invoice, lineas, f.userId))
    ).rejects.toThrow(/uq_je_document_source|duplicate key/);
  });
});
