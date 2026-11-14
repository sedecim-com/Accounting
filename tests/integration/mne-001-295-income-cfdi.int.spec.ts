import { describe, it, expect, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, fechaEnPeriodo } from './helpers/tenant-fixture.js';
import { buildInvoiceCfdiXml } from '../../src/services/sat/cfdi40/income-cfdi-service.js';
import { NotFoundError, ValidationError } from '../../src/utils/errors.js';

/**
 * MNE-001-295 (#105): the CFDI 4.0 ingreso built from a real invoice row, its
 * lines, the issuing entity and the customer, and validated against the SAT's
 * official XSD.
 */

afterAll(async () => {
  await closeDatabase();
});

async function world(complete: boolean) {
  const f = await crearInquilino('MNE-001-295');
  await query(`UPDATE legal_entities SET tax_id = 'EKU9003173C9', tax_regime = $2, tax_postal_code = $3 WHERE id = $1`, [
    f.entityId, complete ? '601' : null, complete ? '06600' : null,
  ]);
  const customerId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, tax_id, tax_id_type, tax_regime,
       tax_postal_code, uso_cfdi, payment_terms, currency_code, created_by)
     VALUES ($1,$2,$3,'Cliente 295 & Hijos','URE180429TM6','rfc','601','65000','G03','Net 30','MXN',$4)`,
    [customerId, f.entityId, `C-295-${customerId.slice(0, 8)}`, f.userId]
  );
  const invoiceId = uuidv4();
  await query(
    `INSERT INTO invoices (id, entity_id, invoice_number, customer_id, subtotal, tax_amount, total_amount,
       amount_due, currency_code, invoice_date, due_date, status, created_by)
     VALUES ($1,$2,$3,$4,1000,160,1160,1160,'MXN',$5,$5,'sent',$6)`,
    [invoiceId, f.entityId, `INV-295-${invoiceId.slice(0, 6)}`, customerId, fechaEnPeriodo(), f.userId]
  );
  await query(
    `INSERT INTO invoice_lines (id, invoice_id, line_number, description, quantity, unit_price, revenue_account_id,
       tax_code, tax_rate, tax_amount, line_amount, total_amount, cfdi_product_code, cfdi_unit_code)
     VALUES ($1,$2,1,'Servicio mensual',1,1000,$3,'IVA16',16,160,1000,1160,'84111506','E48')`,
    [uuidv4(), invoiceId, f.cuentas['4100']]
  );
  return { f, invoiceId };
}

describe('MNE-001-295 CFDI 4.0 ingreso from the invoice', () => {
  it('builds the full document from the stored rows and it validates', async () => {
    const { f, invoiceId } = await world(true);
    const xml = await buildInvoiceCfdiXml(invoiceId, f.entityId, new Date('2026-09-30T18:00:00Z'));
    expect(xml).toContain('Fecha="2026-09-30T12:00:00"');
    expect(xml).toContain('Rfc="EKU9003173C9"');
    expect(xml).toContain('Nombre="Cliente 295 &amp; Hijos"');
    expect(xml).toContain('Total="1160.00"');
    expect(xml).toContain('LugarExpedicion="06600"');
  });

  it('refuses an entity without a declared regime, naming the gap', async () => {
    const { f, invoiceId } = await world(false);
    await expect(buildInvoiceCfdiXml(invoiceId, f.entityId)).rejects.toThrow(/issuer\.tax_regime/);
    await expect(buildInvoiceCfdiXml(invoiceId, f.entityId)).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not read an invoice of a sibling entity', async () => {
    const { f, invoiceId } = await world(true);
    const sister = await crearEntidadHermana(f);
    await expect(buildInvoiceCfdiXml(invoiceId, sister.entityId)).rejects.toBeInstanceOf(NotFoundError);
  });
});
