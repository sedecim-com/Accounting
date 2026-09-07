import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { levantar, pedir, sesionDe, type Servidor } from './helpers/servidor.js';
import journalEntriesRouter from '../../src/api/rest/routes/journal-entries.js';
import integrationsRouter from '../../src/api/rest/routes/integrations.js';
import xmlIngestionRouter from '../../src/api/rest/routes/xml-ingestion.js';

// ============================================================
// G4a · LO QUE SE REPITE Y LO QUE MIENTE, CONTRA POSTGRES.
//
// Dos garantías que sólo se pueden demostrar con filas de verdad:
//
// 1. `Idempotency-Key` en las rutas que el registro de riesgo declaró
//    IRREVERSIBLES. La medida no es el código de respuesta: es CUÁNTAS
//    FILAS quedan en journal_entries. Un reintento de red sobre una ruta
//    irreversible creaba una segunda póliza, y nada del dominio lo
//    impedía — dos pólizas idénticas el mismo día son un hecho legal.
//
// 2. El éxito sobre CERO filas. Tres rutas contestaban 2xx cuando su
//    UPDATE no encontraba nada. Aquí se afirma el PAR: sin fila, 404;
//    con fila, el éxito de siempre y el efecto en la base. Sólo la mitad
//    de arriba la pasaría también un 404 incondicional, que sería romper
//    el endpoint en vez de arreglarlo.
// ============================================================

let f: Fixture;
let s: Servidor;

beforeAll(async () => {
  f = await crearInquilino('G4a llave y cero filas');
  s = await levantar(
    [
      ['/v1/journal-entries', journalEntriesRouter],
      ['/v1/admin/integrations', integrationsRouter],
      ['/v1', xmlIngestionRouter],
    ],
    sesionDe(f)
  );
});

afterAll(async () => {
  await s.cerrar();
  await closeDatabase();
});

const contarPolizas = async (): Promise<number> => {
  const r = await query<{ n: string }>(
    `SELECT count(*) AS n FROM journal_entries WHERE entity_id = $1`,
    [f.entityId]
  );
  return Number(r.rows[0].n);
};

/** Una póliza cuadrada de dos renglones sobre cuentas ya sembradas. */
const poliza = (monto: string, descripcion: string): Record<string, unknown> => ({
  entity_id: f.entityId,
  entry_date: '2026-03-15',
  description: descripcion,
  lines: [
    { account_id: f.roles.banco, debit_amount: monto },
    { account_id: f.roles.cxc, credit_amount: monto },
  ],
});

describe('la llave de idempotencia, en una ruta irreversible de verdad', () => {
  it('el reintento con la misma llave NO crea una segunda póliza', async () => {
    const antes = await contarPolizas();
    const llave = `IT-${randomUUID()}`;
    const cuerpo = poliza('1500.00', 'la que no se duplica');

    const primera = await pedir(s, 'POST', '/v1/journal-entries', cuerpo, {
      'Idempotency-Key': llave,
    });
    expect(primera.status, JSON.stringify(primera.body)).toBe(201);
    expect(primera.repetida).toBe(false);

    const segunda = await pedir(s, 'POST', '/v1/journal-entries', cuerpo, {
      'Idempotency-Key': llave,
    });

    // La prueba de verdad: la BASE, no el código de respuesta.
    expect(await contarPolizas(), 'el reintento creó una segunda póliza').toBe(antes + 1);
    expect(segunda.status).toBe(201);
    expect(segunda.repetida, 'la respuesta repetida se anuncia').toBe(true);

    // Y es la MISMA póliza, con su mismo número: no una respuesta genérica.
    const uno = (primera.body.data as { id: string; entry_number: string }).entry_number;
    const dos = (segunda.body.data as { id: string; entry_number: string }).entry_number;
    expect(dos).toBe(uno);
  });

  it('sin llave, el mismo cuerpo dos veces SÍ crea dos pólizas', async () => {
    // El contrapeso. Sin esto, la prueba de arriba la pasaría también un
    // sistema que rechazara pólizas duplicadas por su cuenta — y no lo hace,
    // porque dos pólizas idénticas el mismo día son legítimas.
    const antes = await contarPolizas();
    const cuerpo = poliza('2500.00', 'la que sí se duplica');
    await pedir(s, 'POST', '/v1/journal-entries', cuerpo);
    await pedir(s, 'POST', '/v1/journal-entries', cuerpo);
    expect(await contarPolizas()).toBe(antes + 2);
  });

  it('la misma llave con OTRA carga es 409, y no escribe nada', async () => {
    const llave = `IT-${randomUUID()}`;
    await pedir(s, 'POST', '/v1/journal-entries', poliza('300.00', 'la primera carga'), {
      'Idempotency-Key': llave,
    });
    const antes = await contarPolizas();

    const otra = await pedir(s, 'POST', '/v1/journal-entries', poliza('30000.00', 'otra carga'), {
      'Idempotency-Key': llave,
    });

    expect(otra.status, 'reusar la llave con otra carga es conflicto').toBe(409);
    expect(await contarPolizas(), 'el conflicto no escribió').toBe(antes);
    // El motivo, no un silencio: quien recibe esto tiene que poder saber que
    // reusó una llave y no que su póliza estaba mal.
    expect(JSON.stringify(otra.body)).toMatch(/carga DISTINTA/);
  });

  it('cuando el cliente ve su respuesta, la llave YA está grabada', async () => {
    // Esta prueba es la que obligó a rehacer el middleware, y por eso importa
    // más de lo que parece. La primera versión grababa la llave escuchando
    // `finish`, o sea DESPUÉS de que la respuesta hubiera volado: entre el
    // 201 que lee el cliente y el INSERT quedaba una ventana en la que su
    // reintento no encontraba la llave y volvía a ejecutar el acto. Aquí se
    // consulta la base en cuanto vuelve la respuesta, sin esperar nada; que
    // la fila esté es lo que hace que la garantía sea una garantía y no una
    // probabilidad.
    const llave = `IT-${randomUUID()}`;
    await pedir(s, 'POST', '/v1/journal-entries', poliza('75.00', 'con alcance'), {
      'Idempotency-Key': llave,
    });

    const fila = await query<{ scope: string; entity_id: string | null }>(
      `SELECT scope, entity_id FROM idempotency_keys WHERE tenant_id = $1 AND clave = $2`,
      [f.tenantId, llave]
    );
    expect(fila.rows).toHaveLength(1);
    // El alcance es verbo + ruta REALES de Express, no una etiqueta escrita a
    // mano: es lo que hace que la misma llave en otra ruta no choque.
    expect(fila.rows[0].scope).toBe('POST /v1/journal-entries');
    expect(fila.rows[0].entity_id).toBe(f.entityId);
  });
});

describe('el UPDATE que no encuentra nada, contra filas de verdad', () => {
  it('apagar una integración inexistente es 404; la que existe se apaga de verdad', async () => {
    const ausente = await pedir(s, 'DELETE', '/v1/admin/integrations/finkok');
    expect(ausente.status, 'un 204 aquí decía «cortado» sin cortar nada').toBe(404);

    await query(
      `INSERT INTO integration_credentials (tenant_id, provider, provider_account_id, credentials_encrypted, status)
       VALUES ($1, 'finkok', 'cuenta-1', 'cifrado-de-mentira', 'active')`,
      [f.tenantId]
    );

    const presente = await pedir(s, 'DELETE', '/v1/admin/integrations/finkok');
    expect(presente.status, 'la que sí existe se sigue apagando').toBe(204);

    const estado = await query<{ status: string }>(
      `SELECT status FROM integration_credentials WHERE tenant_id = $1 AND provider = 'finkok'`,
      [f.tenantId]
    );
    expect(estado.rows[0].status).toBe('inactive');
  });

  it('ejecutar un lote inexistente es 404; el que existe corre y queda marcado', async () => {
    const ausente = await pedir(s, 'POST', `/v1/processing-batches/${randomUUID()}/execute`);
    expect(ausente.status).toBe(404);
    // Y no el resumen en ceros de antes, que se leía como «corrió y no había nada».
    expect(JSON.stringify(ausente.body)).not.toContain('successful');

    const loteId = randomUUID();
    await query(
      `INSERT INTO processing_batches (id, entity_id, batch_number, batch_name, status)
       VALUES ($1, $2, $3, 'lote de prueba', 'scheduled')`,
      [loteId, f.entityId, `IT-${loteId.slice(0, 8)}`]
    );

    const presente = await pedir(s, 'POST', `/v1/processing-batches/${loteId}/execute`);
    expect(presente.status, 'el lote que sí existe sigue ejecutándose').toBe(200);
    expect((presente.body.data as { total: number }).total).toBe(0);

    // Y el efecto está en la base: el lote pasó por `running` y terminó.
    const estado = await query<{ status: string; started_at: Date | null }>(
      `SELECT status, started_at FROM processing_batches WHERE id = $1`,
      [loteId]
    );
    expect(estado.rows[0].started_at).not.toBeNull();
  });

  it('el lote de pre-registros distingue el id propio del que no tocó', async () => {
    const propio = randomUUID();
    await query(
      `INSERT INTO pre_registrations (
         id, entity_id, source_type, document_type, document_date,
         subtotal, total_amount, lines, requires_approval, approval_status
       ) VALUES ($1, $2, 'manual', 'bill', '2026-03-01', 100, 116, '[]'::jsonb, true, 'pending')`,
      [propio, f.entityId]
    );
    const ajeno = randomUUID();

    const r = await pedir(s, 'POST', '/v1/pre-registrations/bulk', {
      action: 'approve',
      ids: [propio, ajeno],
    });

    expect(r.status).toBe(200);
    const filas = (r.body.data as { results: Array<{ id: string; status: string; error?: string }> })
      .results;
    const porId = new Map(filas.map((x) => [x.id, x]));

    expect(porId.get(propio)?.status, 'el id propio se aprueba igual que antes').toBe('success');
    // Antes: `success` también aquí. Cien ids ajenos daban cien `success` y
    // ni una fila cambiada.
    expect(porId.get(ajeno)?.status).toBe('error');
    expect(porId.get(ajeno)?.error).toContain('not found');

    const aprobado = await query<{ approval_status: string }>(
      `SELECT approval_status FROM pre_registrations WHERE id = $1`,
      [propio]
    );
    expect(aprobado.rows[0].approval_status).toBe('approved');
  });
});
