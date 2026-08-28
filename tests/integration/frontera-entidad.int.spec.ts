import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query, closeDatabase, withTenant } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import {
  findByIdInScope,
  requireByIdInScope,
  entityScope,
  tenantScope,
  olvidarAlcances,
} from '../../src/database/scope.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { voidInvoice } from '../../src/services/ar/invoice-service.js';
import { resolveEntity } from '../../src/ai/context.js';
import { NotFoundError } from '../../src/utils/errors.js';

/**
 * LA FRONTERA DE ENTIDAD, CONTRA POSTGRES REAL.
 *
 * RLS acota por INQUILINO, y sólo si el proceso se conecta con un rol que no
 * la ignora. Dentro de un inquilino con varias entidades legales no acota
 * nada — y ese es el eje que aquí se defiende.
 *
 * Estas pruebas corren como SUPERUSUARIO, con RLS inerte a propósito: lo que
 * demuestran es la frontera del CÓDIGO, no la de la base. Si pasan aquí,
 * pasan también con RLS activa.
 */

let a: Fixture;   // dos entidades del MISMO inquilino: el caso que RLS no cubre
let b: Fixture;

beforeAll(async () => {
  olvidarAlcances();
  a = await crearInquilino('Frontera A');
  b = await crearInquilino('Frontera B');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function facturaEmitida(f: Fixture): Promise<string> {
  const id = uuidv4();
  const marca = uuidv4().slice(0, 8);
  const clienteId = uuidv4();
  await query(
    `INSERT INTO customers (id, entity_id, customer_number, company_name, currency_code, created_by)
     VALUES ($1,$2,$3,'Cliente','MXN',$4)`,
    [clienteId, f.entityId, `C-${marca}`, f.userId]
  );
  await query(
    `INSERT INTO invoices (
       id, entity_id, invoice_number, customer_id, invoice_date, due_date,
       subtotal, tax_amount, total_amount, amount_due, amount_paid,
       currency_code, status, created_by
     ) VALUES ($1,$2,$3,$4,$5,$5,1000,160,1160,1160,0,'MXN','sent',$6)`,
    [id, f.entityId, `INV-${marca}`, clienteId, fechaEnPeriodo(), f.userId]
  );
  return id;
}

describe('findByIdInScope', () => {
  it('encuentra lo propio', async () => {
    const id = await facturaEmitida(a);
    const fila = await findByIdInScope('invoices', id, entityScope(a.tenantId, a.entityId));
    expect(fila).not.toBeNull();
  });

  it('devuelve null para lo de otra entidad, igual que para lo inexistente', async () => {
    const ajena = await facturaEmitida(b);
    const deOtra = await findByIdInScope('invoices', ajena, entityScope(a.tenantId, a.entityId));
    const inexistente = await findByIdInScope('invoices', uuidv4(), entityScope(a.tenantId, a.entityId));
    // Indistinguibles a propósito: es lo que impide usar el endpoint como
    // oráculo de existencia.
    expect(deOtra).toBe(inexistente);
    expect(deOtra).toBeNull();
  });

  it('un alcance de inquilino alcanza a todas sus entidades', async () => {
    const deA = await facturaEmitida(a);
    expect(await findByIdInScope('invoices', deA, tenantScope(a.tenantId))).not.toBeNull();
    // ...y no a las de otro inquilino.
    const deB = await facturaEmitida(b);
    expect(await findByIdInScope('invoices', deB, tenantScope(a.tenantId))).toBeNull();
  });

  it('sabe qué columna acota cada tabla sin que se lo digan', async () => {
    // legal_entities cuelga de tenant_id; invoices de entity_id. El mapa se
    // deduce del esquema, así que una tabla futura nace con frontera.
    const entidad = await findByIdInScope('legal_entities', a.entityId, tenantScope(a.tenantId));
    expect(entidad).not.toBeNull();
    expect(
      await findByIdInScope('legal_entities', a.entityId, tenantScope(b.tenantId))
    ).toBeNull();
  });

  it('una tabla sin columna de alcance se rechaza en vez de devolverse suelta', async () => {
    await expect(
      findByIdInScope('migrations', '1', tenantScope(a.tenantId), { idColumn: 'id' })
    ).rejects.toThrow(/no tiene columna de alcance/);
  });

  it('el nombre de tabla no se interpola a ciegas', async () => {
    await expect(
      findByIdInScope('invoices; DROP TABLE users', uuidv4(), tenantScope(a.tenantId))
    ).rejects.toThrow(/Nombre de tabla inválido/);
  });
});

describe('requireByIdInScope', () => {
  it('lanza NotFound —nunca Forbidden— para lo de otra entidad', async () => {
    const ajena = await facturaEmitida(b);
    // 403 diría «existe, y no es tuyo». La primera mitad no debe salir del
    // sistema: aquí los identificadores circulan.
    await expect(
      requireByIdInScope('invoices', ajena, entityScope(a.tenantId, a.entityId))
    ).rejects.toThrow(NotFoundError);
  });

  it('el mensaje no delata a quién pertenece', async () => {
    const ajena = await facturaEmitida(b);
    try {
      await requireByIdInScope('invoices', ajena, entityScope(a.tenantId, a.entityId));
      throw new Error('debió lanzar');
    } catch (e) {
      const m = (e as Error).message;
      expect(m).not.toMatch(/otra entidad|another entity|Frontera B/i);
      expect(m).toMatch(/Invoice/);
    }
  });
});

describe('anular una factura ajena ya no es posible', () => {
  it('conocer el UUID no basta: la anulación se acota por entidad', async () => {
    const ajena = await facturaEmitida(b);

    // Éste era el camino: POST /v1/invoices/:id/void pasaba req.params.id
    // crudo, y la anulación llegaba a crear y contabilizar un asiento espejo
    // en el mayor de la otra entidad.
    await expect(
      voidInvoice(ajena, a.userId, {
        entityId: a.entityId,
        allowStamped: true,
        allowApplied: true,
      })
    ).rejects.toThrow(NotFoundError);

    const bd = await query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [ajena]);
    expect(bd.rows[0].status, 'la factura ajena debe seguir viva').toBe('sent');
  });

  it('su dueño sí puede anularla', async () => {
    const propia = await facturaEmitida(b);
    const r = await voidInvoice(propia, b.userId, {
      entityId: b.entityId,
      allowStamped: true,
      allowApplied: true,
    });
    expect(r.invoice.status).toBe('void');
  });
});

describe('el contexto de inquilino del servidor no se reemplaza', () => {
  it('resolver una entidad de otro inquilino con contexto abierto se rechaza', async () => {
    // En el servidor la petición abre su contexto con el inquilino del token.
    // resolveEntity llamaba a enterTenant() y lo SUSTITUÍA por el de la fila
    // que designa la cabecera x-entity-id: a partir de ahí el inquilino
    // efectivo lo elegía quien mandaba la cabecera.
    await expect(
      withTenant(a.tenantId, () => resolveEntity(b.entityId))
    ).rejects.toThrow(/otro inquilino/);
  });

  it('con el contexto correcto resuelve como siempre', async () => {
    const ctx = await withTenant(a.tenantId, () => resolveEntity(a.entityId));
    expect(ctx.entityId).toBe(a.entityId);
    expect(ctx.tenantId).toBe(a.tenantId);
  });
});
