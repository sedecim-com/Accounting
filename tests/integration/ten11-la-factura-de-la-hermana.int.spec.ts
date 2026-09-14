import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import billsRouter from '../../src/api/rest/routes/bills.js';

// ============================================================
// TEN-11 · APROBAR LA FACTURA DE PROVEEDOR DE LA SOCIEDAD HERMANA
//
// `POST /v1/bills/:id/approve` es irreversible: reconoce el pasivo y el IVA
// acreditable con una póliza POSTEADA. La ruta no monta `requireEntityAccess`
// y llama a `approveBill(id, userId)` sin opciones, así que el UPDATE queda
// `WHERE id = $2 AND status IN (...)` — ni entidad ni inquilino. La póliza se
// escribe en la entidad DE LA FACTURA, no en la de quien aprueba.
//
// Es la anatomía de T9a (`post-to-gl`), y es invisible para
// `route-entity-access-verified`: la ruta no nombra `req.entityId`, así que el
// criterio no la considera una ruta que acota por entidad.
//
// Y una prueba unitaria lo fija como contrato: «does not scope by entity when
// no entity was given — the REST contract», justo encima de la que protege a
// la CLI.
// ============================================================

let f: Fixture;
let hermana: Fixture;
let s: Servidor;

beforeAll(async () => {
  f = await crearInquilino('TEN-11 frontera');
  hermana = await crearEntidadHermana(f, 'TEN-11 la hermana');
  s = await levantar([['/v1/bills', billsRouter]], sesionDe(f));
}, 120_000);

afterAll(async () => {
  await s.cerrar();
  await closeDatabase();
});

/** Una factura de proveedor en borrador, con su línea, en la entidad dada. */
async function facturaEnBorrador(fx: Fixture): Promise<string> {
  const billId = uuidv4();
  const vendorId = uuidv4();
  const marca = uuidv4().slice(0, 8);
  const fecha = fechaEnPeriodo();
  await query(
    `INSERT INTO vendors (id, entity_id, vendor_number, company_name, tax_id, tax_id_type, currency_code, created_by)
     VALUES ($1,$2,$3,'Proveedor TEN-11','CCC030303CC3','rfc','MXN',$4)`,
    [vendorId, fx.entityId, `V-${marca}`, fx.userId]
  );
  await query(
    `INSERT INTO bills (
       id, entity_id, bill_number, vendor_id, vendor_invoice_number,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, bill_date, due_date, status, created_by, terms
     ) VALUES ($1,$2,$3,$4,$5,'1000.00','160.00','1160.00','1160.00',0,'MXN',$6,$6,'draft',$7,'PPD')`,
    [billId, fx.entityId, `BILL-${marca}`, vendorId, `CFDI-${marca}`, fecha, fx.userId]
  );
  await query(
    `INSERT INTO bill_lines (id, bill_id, line_number, account_id, description, quantity, unit_price, line_amount, tax_amount, total_amount)
     VALUES ($1,$2,1,$3,'Servicio',1,'1000.00','1000.00','160.00','1160.00')`,
    [uuidv4(), billId, fx.cuentas['6100']]
  );
  return billId;
}

const estadoDe = async (billId: string): Promise<{ status: string; journal_entry_id: string | null }> => {
  const { rows } = await query<{ status: string; journal_entry_id: string | null }>(
    'SELECT status, journal_entry_id FROM bills WHERE id = $1',
    [billId]
  );
  return rows[0];
};

const polizasDe = async (entityId: string): Promise<number> => {
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM journal_entries WHERE entity_id = $1`,
    [entityId]
  );
  return Number(rows[0].n);
};

describe('aprobar la factura de la hermana', () => {
  it('contesta 404', async () => {
    const ajena = await facturaEnBorrador(hermana);
    const r = await pedir(s, 'POST', `/v1/bills/${ajena}/approve`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(404);
  });

  it('y la factura ajena queda en borrador, sin póliza en el mayor de la hermana', async () => {
    const ajena = await facturaEnBorrador(hermana);
    const antes = await polizasDe(hermana.entityId);
    await pedir(s, 'POST', `/v1/bills/${ajena}/approve`, {});
    const despues = await estadoDe(ajena);
    expect(despues.status, 'la factura ajena quedó aprobada').toBe('draft');
    expect(despues.journal_entry_id, 'la factura ajena tiene póliza').toBeNull();
    expect(await polizasDe(hermana.entityId), 'se escribió una póliza en el mayor de la hermana').toBe(antes);
  });

  it('el 404 es idéntico al de un UUID que no existe', async () => {
    const ajena = await facturaEnBorrador(hermana);
    const deLaHermana = await pedir(s, 'POST', `/v1/bills/${ajena}/approve`, {});
    const fantasmaId = randomUUID();
    const fantasma = await pedir(s, 'POST', `/v1/bills/${fantasmaId}/approve`, {});
    expect(fantasma.status).toBe(404);
    const normalizar = (b: unknown, id: string): string => JSON.stringify(b).split(id).join('<id>');
    expect(normalizar(deLaHermana.body, ajena)).toBe(normalizar(fantasma.body, fantasmaId));
  });

  it('EL CONTRAPESO: la factura propia sí se aprueba, con su póliza', async () => {
    const propia = await facturaEnBorrador(f);
    const r = await pedir(s, 'POST', `/v1/bills/${propia}/approve`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const despues = await estadoDe(propia);
    expect(despues.status).toBe('approved');
    expect(despues.journal_entry_id).not.toBeNull();
  });
});
