import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import accountsRouter from '../../src/api/rest/routes/accounts.js';
import invoicesRouter from '../../src/api/rest/routes/invoices.js';
import xmlIngestionRouter from '../../src/api/rest/routes/xml-ingestion.js';

// ============================================================
// TEN-10 · LAS CUATRO RUTAS QUE NO ACOTABAN POR ENTIDAD (#188)
//
// RLS no cubre este eje: acota por INQUILINO, y las dos sociedades de un
// despacho lo comparten. `src/database/scope.ts` lo dice en su cabecera —
// «dentro de un inquilino con varias entidades legales no acota nada, y ese es
// justamente el eje que aquí se defiende».
//
// LAS TRES COSAS QUE CADA RUTA TIENE QUE CUMPLIR, y por eso cada una tiene tres
// pruebas y no una:
//
//   1. con el id de la HERMANA, 404;
//   2. el recurso ajeno queda INTACTO —un 404 que ya escribió no sirve de nada—;
//   3. y EL CONTRAPESO: con el id PROPIO sigue funcionando. Sin él, romper el
//      endpoint entero pasaría las dos primeras.
//
// Y una cuarta, transversal: el 404 del recurso ajeno es IDÉNTICO al de un UUID
// que no existe. Distinguirlos —por código o por prosa— reabre como oráculo lo
// que el SQL acaba de cerrar.
// ============================================================

let f: Fixture;
let hermana: Fixture;
let s: Servidor;

beforeAll(async () => {
  f = await crearInquilino('TEN-10 frontera');
  hermana = await crearEntidadHermana(f, 'TEN-10 la hermana');
  s = await levantar(
    [
      ['/v1/accounts', accountsRouter],
      ['/v1/invoices', invoicesRouter],
      ['/v1', xmlIngestionRouter],
    ],
    sesionDe(f)
  );
}, 120_000);

afterAll(async () => {
  await s.cerrar();
  await closeDatabase();
});

/** Una cuenta nueva de la entidad que se le pase, con su código propio. */
async function cuentaDe(fx: Fixture, code: string, name: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO accounts (id, entity_id, code, name, account_type, normal_balance,
       account_level, is_active, created_by)
     VALUES ($1, $2, $3, $4, 'expense', 'debit', 1, true, $5)`,
    [id, fx.entityId, code, name, fx.userId]
  );
  return id;
}

describe('1 · el catálogo de cuentas', () => {
  it('GET no lee la cuenta de la hermana —ni su saldo—, y el 404 es el del UUID inexistente', async () => {
    const ajena = await cuentaDe(hermana, 'TEN10-A', 'Cuenta de la hermana');

    const conSaldo = await pedir(s, 'GET', `/v1/accounts/${ajena}?include_balance=true`);
    expect(conSaldo.status, JSON.stringify(conSaldo.body)).toBe(404);

    // NI UN ORÁCULO: el cuerpo tiene que ser el mismo que el de un id que no
    // existe en ninguna parte. Si difieren, el 404 sigue diciendo «existe pero
    // no es tuya», que es justo lo que la tarjeta prohíbe.
    const fantasmaId = randomUUID();
    const fantasma = await pedir(s, 'GET', `/v1/accounts/${fantasmaId}?include_balance=true`);
    expect(fantasma.status).toBe(404);
    // Se compara el cuerpo con el id NORMALIZADO: el mensaje lleva dentro el
    // UUID que pidió quien llama —que él ya conoce— y eso no es información de
    // la otra entidad. Lo que no puede diferir es nada más.
    const sinId = (b: unknown, id: string): string => JSON.stringify(b).split(id).join('<id>');
    expect(
      sinId(conSaldo.body.errors, ajena),
      'el 404 de la cuenta ajena no dice lo mismo que el de una que no existe'
    ).toBe(sinId(fantasma.body.errors, fantasmaId));
  });

  it('PATCH no renombra la cuenta de la hermana, y la fila ajena queda intacta', async () => {
    const ajena = await cuentaDe(hermana, 'TEN10-B', 'No me toques');

    const r = await pedir(s, 'PATCH', `/v1/accounts/${ajena}`, { name: 'secuestrada' });
    expect(r.status, JSON.stringify(r.body)).toBe(404);

    const fila = await query<{ name: string }>('SELECT name FROM accounts WHERE id = $1', [ajena]);
    expect(fila.rows[0].name, 'el PATCH ajeno escribió de todas formas').toBe('No me toques');
  });

  it('PATCH tampoco la archiva por la puerta de atrás de is_active', async () => {
    // `UPDATABLE_FIELDS` incluye `is_active`, así que el PATCH ajeno no sólo
    // renombraba: archivaba la cuenta de la hermana saltándose los guardianes
    // de `deactivateAccount` —el de historia y el de saldo vivo—.
    const ajena = await cuentaDe(hermana, 'TEN10-C', 'Sigo activa');

    const r = await pedir(s, 'PATCH', `/v1/accounts/${ajena}`, { is_active: false });
    expect(r.status).toBe(404);

    const fila = await query<{ is_active: boolean }>(
      'SELECT is_active FROM accounts WHERE id = $1',
      [ajena]
    );
    expect(fila.rows[0].is_active, 'la cuenta ajena quedó archivada').toBe(true);
  });

  it('DELETE no da de baja la cuenta de la hermana', async () => {
    const ajena = await cuentaDe(hermana, 'TEN10-D', 'Tampoco me archives');

    const r = await pedir(s, 'DELETE', `/v1/accounts/${ajena}`);
    expect(r.status, JSON.stringify(r.body)).toBe(404);

    const fila = await query<{ is_active: boolean }>(
      'SELECT is_active FROM accounts WHERE id = $1',
      [ajena]
    );
    expect(fila.rows[0].is_active, 'el DELETE ajeno archivó de todas formas').toBe(true);
  });

  it('EL CONTRAPESO: con la cuenta PROPIA, las tres siguen funcionando', async () => {
    // Sin esto, romper el endpoint entero —devolver 404 siempre— pasaría las
    // cuatro pruebas de arriba y habría destruido la funcionalidad en vez de
    // acotarla.
    const propia = await cuentaDe(f, 'TEN10-P', 'Mía');

    const leida = await pedir(s, 'GET', `/v1/accounts/${propia}?include_balance=true`);
    expect(leida.status, JSON.stringify(leida.body)).toBe(200);

    const editada = await pedir(s, 'PATCH', `/v1/accounts/${propia}`, { name: 'Mía, renombrada' });
    expect(editada.status, JSON.stringify(editada.body)).toBe(200);
    expect((editada.body.data as { name: string }).name).toBe('Mía, renombrada');

    const borrada = await pedir(s, 'DELETE', `/v1/accounts/${propia}`);
    expect(borrada.status, JSON.stringify(borrada.body)).toBe(204);
    const fila = await query<{ is_active: boolean }>(
      'SELECT is_active FROM accounts WHERE id = $1',
      [propia]
    );
    expect(fila.rows[0].is_active).toBe(false);
  });
});

describe('2 · el avance del lote de ingesta', () => {
  async function loteDe(fx: Fixture): Promise<string> {
    const id = uuidv4();
    await query(
      `INSERT INTO processing_batches (id, entity_id, batch_name, status, total_items, processed_items)
       VALUES ($1, $2, 'TEN-10', 'running', 10, 3)`,
      [id, fx.entityId]
    );
    return id;
  }

  it('no enseña el avance del lote de la hermana', async () => {
    const ajeno = await loteDe(hermana);
    const r = await pedir(s, 'GET', `/v1/processing-batches/${ajeno}/progress`);
    expect(r.status, JSON.stringify(r.body)).toBe(404);
  });

  it('EL CONTRAPESO: el lote propio sí se ve', async () => {
    const propio = await loteDe(f);
    const r = await pedir(s, 'GET', `/v1/processing-batches/${propio}/progress`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body.data as { total_items: number }).total_items).toBe(10);
  });
});
