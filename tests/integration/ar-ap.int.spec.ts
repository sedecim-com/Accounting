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
    for (const rol of [
      'cxc', 'cxp', 'banco', 'ingreso', 'gasto', 'iva_trasladado', 'iva_acreditable',
      // El IVA es de flujo de efectivo: sin estas dos, una factura PPD no
      // tiene dónde esperar a que el dinero se mueva.
      'iva_trasladado_no_cobrado', 'iva_pendiente_acreditar',
    ]) {
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
    // La factura no trae MetodoPago: se asume PUE, que es el trato que NUNCA
    // difiere el entero del impuesto, y el asiento lo dice.
    expect(await saldoDe(f.roles.iva_trasladado, f.periodos[8])).toBeCloseTo(-160, 4);
    expect(await saldoDe(f.roles.iva_trasladado_no_cobrado, f.periodos[8])).toBeCloseTo(0, 4);
    expect(entry!.description).toMatch(/MetodoPago missing: PUE assumed/);

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

  /**
   * CAMBIO DELIBERADO DE CONDUCTA. Esta prueba fijaba el IVA de TODA factura
   * de proveedor en «IVA Acreditable», que es el devengado: México acredita
   * el IVA al PAGAR (LIVA art. 5 fr. III). Sin MetodoPago en el documento se
   * aplica el trato conservador —PPD— y el IVA espera en 1135.
   */
  it('factura de proveedor sin MetodoPago → CR CxP, DR Gasto, DR IVA pendiente de acreditar', async () => {
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
    expect(await saldoDe(f.roles.iva_pendiente_acreditar, f.periodos[8])).toBeCloseTo(80, 4);
    expect(await saldoDe(f.roles.iva_acreditable, f.periodos[8])).toBeCloseTo(0, 4);
    expect(entry!.description).toMatch(/MetodoPago missing: PPD assumed/);
  });

  it('factura de proveedor PUE → el IVA sí es acreditable de inmediato', async () => {
    const vendorId = await crearProveedor();
    const billId = uuidv4();
    await query(
      `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount,
        total_amount, amount_due, currency_code, bill_date, due_date, status, terms, created_by)
       VALUES ($1,$2,$3,$4,500,80,580,580,'MXN',$5,$6,'approved','PUE',$7)`,
      [billId, f.entityId, `BILL-PUE-${billId.slice(0, 6)}`, vendorId,
       fechaEnPeriodo(), fechaEnPeriodo(9), f.userId]
    );
    await query(
      `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity,
        unit_price, line_amount, tax_amount, total_amount)
       VALUES ($1,$2,1,$3,'Gasto',1,500,500,80,580)`,
      [uuidv4(), billId, f.roles.gasto]
    );

    const acreditableAntes = await saldoDe(f.roles.iva_acreditable, f.periodos[8]);
    const pendienteAntes = await saldoDe(f.roles.iva_pendiente_acreditar, f.periodos[8]);

    await withTransaction(async (client) => {
      const bill = (await client.query<Bill>('SELECT * FROM bills WHERE id = $1 FOR UPDATE', [billId])).rows[0];
      const lineas = (await client.query<BillLine>('SELECT * FROM bill_lines WHERE bill_id = $1', [billId])).rows;
      return postBillEntry(client, bill, lineas, f.userId);
    });

    expect(await saldoDe(f.roles.iva_acreditable, f.periodos[8])).toBeCloseTo(acreditableAntes + 80, 4);
    expect(await saldoDe(f.roles.iva_pendiente_acreditar, f.periodos[8])).toBeCloseTo(pendienteAntes, 4);
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

/**
 * EL IVA SE CAUSA Y SE ACREDITA CUANDO EL DINERO SE MUEVE.
 *
 * Un CFDI PPD no causa IVA al emitirse: espera en 2125 (emitido) o en 1135
 * (recibido) y sale de ahí con el pago. Estas pruebas recorren el ciclo
 * completo contra la base real y comprueban los dos saldos en cada paso,
 * porque el error que persiguen —acreditar o enterar el IVA un mes antes de
 * tiempo— sólo se ve mirando las dos cuentas a la vez.
 */
describe('IVA de flujo: el ciclo PPD completo', () => {
  it('venta PPD: el IVA espera en 2125 y pasa a IVA trasladado al cobrar', async () => {
    const customerId = await crearCliente();
    const invId = uuidv4();
    const numero = `INV-PPD-${invId.slice(0, 6)}`;
    await query(
      `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount,
        total_amount, amount_due, currency_code, invoice_date, due_date, status, terms, created_by)
       VALUES ($1,$2,$3,$4,1000,160,1160,1160,'MXN',$5,$6,'sent','PPD - 30 dias',$7)`,
      [invId, f.entityId, numero, customerId, fechaEnPeriodo(), fechaEnPeriodo(9), f.userId]
    );
    await query(
      `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price,
        revenue_account_id, tax_amount, line_amount, total_amount)
       VALUES ($1,$2,1,'Servicio a credito',1,1000,$3,160,1000,1160)`,
      [uuidv4(), invId, f.roles.ingreso]
    );

    const trasladadoAntes = await saldoDe(f.roles.iva_trasladado, f.periodos[8]);
    const noCobradoAntes = await saldoDe(f.roles.iva_trasladado_no_cobrado, f.periodos[8]);

    await withTransaction(async (client) => {
      const inv = (await client.query<Invoice>('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invId])).rows[0];
      const lineas = (await client.query<InvoiceLine>('SELECT * FROM invoice_lines WHERE invoice_id = $1', [invId])).rows;
      return postInvoiceEntry(client, inv, lineas, f.userId);
    });

    // Al emitir: el IVA NO se causó todavía.
    expect(await saldoDe(f.roles.iva_trasladado_no_cobrado, f.periodos[8])).toBeCloseTo(noCobradoAntes - 160, 4);
    expect(await saldoDe(f.roles.iva_trasladado, f.periodos[8])).toBeCloseTo(trasladadoAntes, 4);

    // Cobro total, con su aplicación: es lo que dispara la reclasificación.
    const payId = uuidv4();
    const payNum = `PMT-PPD-${payId.slice(0, 6)}`;
    await query(
      `INSERT INTO customer_payments (id, entity_id, payment_number, customer_id, payment_amount,
        payment_method, payment_date, status, created_by)
       VALUES ($1,$2,$3,$4,1160,'spei',$5,'completed',$6)`,
      [payId, f.entityId, payNum, customerId, fechaEnPeriodo(9), f.userId]
    );
    await query(
      `INSERT INTO payment_allocations (id, payment_id, invoice_id, amount_applied)
       VALUES ($1,$2,$3,1160)`,
      [uuidv4(), payId, invId]
    );

    const entry = await withTransaction((client) =>
      postCustomerPaymentEntry(client, {
        id: payId, entity_id: f.entityId, payment_number: payNum,
        payment_amount: '1160.0000', payment_date: fechaEnPeriodo(9),
        bank_account_id: null, journal_entry_id: null,
      }, f.userId)
    );

    expect(entry!.description).toContain(numero);
    // Al cobrar: 2125 queda en cero y el IVA ya es exigible.
    expect(await saldoDe(f.roles.iva_trasladado_no_cobrado, f.periodos[9])).toBeCloseTo(160, 4);
    expect(await saldoDe(f.roles.iva_trasladado, f.periodos[9])).toBeCloseTo(-160, 4);
    // Y el asiento del cobro sigue cuadrando: 1160 de banco + 160 de IVA.
    expect(Number(entry!.total_debits)).toBeCloseTo(1320, 4);
    expect(Number(entry!.total_debits)).toBeCloseTo(Number(entry!.total_credits), 4);
  });

  it('compra PPD: el IVA espera en 1135 y se acredita al pagar, a prorrata', async () => {
    const vendorId = await crearProveedor();
    const billId = uuidv4();
    const numero = `BILL-PPD-${billId.slice(0, 6)}`;
    await query(
      `INSERT INTO bills (id, entity_id, bill_number, vendor_id, subtotal, tax_amount,
        total_amount, amount_due, currency_code, bill_date, due_date, status, terms, created_by)
       VALUES ($1,$2,$3,$4,1000,160,1160,1160,'MXN',$5,$6,'approved','PPD',$7)`,
      [billId, f.entityId, numero, vendorId, fechaEnPeriodo(), fechaEnPeriodo(9), f.userId]
    );
    await query(
      `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity,
        unit_price, line_amount, tax_amount, total_amount)
       VALUES ($1,$2,1,$3,'Compra a credito',1,1000,1000,160,1160)`,
      [uuidv4(), billId, f.roles.gasto]
    );

    const acreditableAntes = await saldoDe(f.roles.iva_acreditable, f.periodos[8]);
    const pendienteAntes = await saldoDe(f.roles.iva_pendiente_acreditar, f.periodos[8]);

    await withTransaction(async (client) => {
      const bill = (await client.query<Bill>('SELECT * FROM bills WHERE id = $1 FOR UPDATE', [billId])).rows[0];
      const lineas = (await client.query<BillLine>('SELECT * FROM bill_lines WHERE bill_id = $1', [billId])).rows;
      return postBillEntry(client, bill, lineas, f.userId);
    });

    expect(await saldoDe(f.roles.iva_pendiente_acreditar, f.periodos[8])).toBeCloseTo(pendienteAntes + 160, 4);
    expect(await saldoDe(f.roles.iva_acreditable, f.periodos[8])).toBeCloseTo(acreditableAntes, 4);

    // Primer pago: la mitad. Sólo la mitad del IVA se vuelve acreditable.
    const pago = async (numeroPago: string, importe: string): Promise<void> => {
      const payId = uuidv4();
      await query(
        `INSERT INTO vendor_payments (id, entity_id, payment_number, vendor_id, payment_amount,
          payment_method, payment_date, status, created_by)
         VALUES ($1,$2,$3,$4,$5,'spei',$6,'completed',$7)`,
        [payId, f.entityId, numeroPago, vendorId, importe, fechaEnPeriodo(9), f.userId]
      );
      await query(
        `INSERT INTO payment_applications (id, payment_id, bill_id, amount_applied)
         VALUES ($1,$2,$3,$4)`,
        [uuidv4(), payId, billId, importe]
      );
      await withTransaction((client) =>
        postVendorPaymentEntry(client, {
          id: payId, entity_id: f.entityId, payment_number: numeroPago,
          payment_amount: importe, payment_date: fechaEnPeriodo(9),
          bank_account_id: null, journal_entry_id: null,
        }, f.userId)
      );
    };

    await pago(`VPMT-A-${billId.slice(0, 6)}`, '580.0000');
    expect(await saldoDe(f.roles.iva_acreditable, f.periodos[9])).toBeCloseTo(80, 4);
    expect(await saldoDe(f.roles.iva_pendiente_acreditar, f.periodos[9])).toBeCloseTo(-80, 4);

    // Segundo pago: el resto. 1135 queda exactamente en cero sobre el periodo.
    await pago(`VPMT-B-${billId.slice(0, 6)}`, '580.0000');
    expect(await saldoDe(f.roles.iva_acreditable, f.periodos[9])).toBeCloseTo(160, 4);
    expect(await saldoDe(f.roles.iva_pendiente_acreditar, f.periodos[9])).toBeCloseTo(-160, 4);
  });
});
