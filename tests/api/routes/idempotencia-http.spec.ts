import { describe, it, expect, beforeEach, afterAll, beforeAll, vi } from 'vitest';
import express, { Router, type Request, type Response } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ============================================================
// `Idempotency-Key`, PROBADA POR CONDUCTA.
//
// El almacén existe desde la 039 y la terminal lo usa en nueve comandos.
// REST no lo mencionaba ni una vez, así que un reintento de red sobre
// POST /v1/bills/payments creaba un SEGUNDO pago con su póliza — nada en
// el dominio lo impide, porque dos pagos idénticos al mismo proveedor el
// mismo día son perfectamente legales.
//
// Lo que se afirma aquí es la conducta OBSERVABLE desde fuera, no la
// implementación: cuántas veces corrió el manejador, con qué código y con
// qué cuerpo se contestó, y qué pasa cuando la llave se reusa mal. La
// base se sustituye por un `idempotency_keys` en memoria —con la misma
// unicidad (inquilino, alcance, llave) y el mismo viaje por JSON que hace
// JSONB— para que el `conLlave` que corre sea el DE VERDAD y no un doble.
// El contrato del almacén contra Postgres ya lo fija
// tests/integration/idempotencia.int.spec.ts.
// ============================================================

const almacen = vi.hoisted(() => {
  const filas = new Map<string, { payload_hash: string; resultado: unknown }>();
  const sentencias: string[] = [];
  const k = (tenant: unknown, scope: unknown, clave: unknown): string =>
    `${String(tenant)}|${String(scope)}|${String(clave)}`;
  return { filas, sentencias, k };
});

vi.mock('../../../src/database/connection.js', () => {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    almacen.sentencias.push(sql);
    if (/FROM idempotency_keys/.test(sql)) {
      const fila = almacen.filas.get(almacen.k(params[0], params[1], params[2]));
      return { rows: fila ? [fila] : [], rowCount: fila ? 1 : 0 };
    }
    if (/INSERT INTO idempotency_keys/.test(sql)) {
      const clave = almacen.k(params[0], params[2], params[3]);
      // La restricción única de la migración 039, y el DO NOTHING de encima.
      if (almacen.filas.has(clave)) return { rows: [], rowCount: 0 };
      almacen.filas.set(clave, {
        payload_hash: String(params[4]),
        // JSONB va y vuelve por JSON: un `undefined` no sobrevive el viaje,
        // y eso es justo lo que hace que un 204 se relea sin cuerpo.
        resultado: JSON.parse(String(params[5])),
      });
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return {
    query,
    withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) =>
      fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) })
    ),
    withTenant: vi.fn(async (_t: string, fn: () => Promise<unknown>) => fn()),
    enterTenant: vi.fn(),
    currentTenant: vi.fn(),
    getClient: vi.fn(),
    setTenantSchema: vi.fn(),
    initDatabase: vi.fn(),
    closeDatabase: vi.fn(),
    getPool: vi.fn(),
  };
});

import { declararRiesgoRuta } from '../../../src/api/rest/risk.js';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';
import { asyncHandler } from '../../../src/api/rest/middleware/async-handler.js';
import { ValidationError } from '../../../src/utils/errors.js';

/** Cuántas veces corrió CADA manejador. Es la única medida que importa. */
const corridas: Record<string, number> = {};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // El doble de `authenticate`: deja puestos inquilino y entidad igual que él.
  app.use((req, _res, next) => {
    req.user = { user_id: 'u-1', tenant_id: 't-1', permissions: ['*'] } as never;
    req.tenantId = 't-1';
    req.entityId = (req.headers['x-entity-id'] as string) || 'e-1';
    next();
  });

  const r = Router();

  // Una ruta irreversible cualquiera: la clase es lo que trae la llave.
  r.post(
    '/pagos',
    declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'un pago de mentira' }),
    asyncHandler(async (req: Request, res: Response) => {
      corridas.pagos = (corridas.pagos ?? 0) + 1;
      res.status(201).json({
        data: { folio: `PAGO-${corridas.pagos}`, monto: (req.body as { monto?: unknown }).monto },
      });
    })
  );

  // Un 204: lo contestan DELETE /v1/webhooks/:id y DELETE
  // /v1/xml/processing-rules/:id, las dos irreversibles.
  r.delete(
    '/suscripciones/:id',
    declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'borrado duro de mentira' }),
    asyncHandler(async (_req: Request, res: Response) => {
      corridas.suscripciones = (corridas.suscripciones ?? 0) + 1;
      res.status(204).send();
    })
  );

  // Una que falla: el fallo NO puede consumar la llave.
  r.post(
    '/rechaza',
    declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'nada: siempre falla' }),
    asyncHandler(async () => {
      corridas.rechaza = (corridas.rechaza ?? 0) + 1;
      throw new ValidationError('no hoy');
    })
  );

  // Una ESCRITURA: la clase no exige llave, así que la cabecera no aplica.
  r.post(
    '/borradores',
    declararRiesgoRuta({ riesgo: 'escritura', escribe: 'un borrador de mentira' }),
    asyncHandler(async (_req: Request, res: Response) => {
      corridas.borradores = (corridas.borradores ?? 0) + 1;
      res.status(201).json({ data: { n: corridas.borradores } });
    })
  );

  app.use('/v1', r);
  app.use(errorHandler);

  await new Promise<void>((ok) => {
    server = app.listen(0, '127.0.0.1', ok);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
});

beforeEach(() => {
  almacen.filas.clear();
  almacen.sentencias.length = 0;
  for (const k of Object.keys(corridas)) delete corridas[k];
});

interface Resp {
  status: number;
  body: unknown;
  repetida: boolean;
}

async function pedir(
  metodo: string,
  ruta: string,
  opciones: { cuerpo?: unknown; llave?: string | string[]; entidad?: string } = {}
): Promise<Resp> {
  const headers: string[][] = [['content-type', 'application/json']];
  if (Array.isArray(opciones.llave)) {
    for (const l of opciones.llave) headers.push(['idempotency-key', l]);
  } else if (opciones.llave !== undefined) {
    headers.push(['idempotency-key', opciones.llave]);
  }
  if (opciones.entidad) headers.push(['x-entity-id', opciones.entidad]);

  const r = await fetch(`${baseUrl}${ruta}`, {
    method: metodo,
    headers,
    body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo),
  });
  const texto = await r.text();
  return {
    status: r.status,
    body: texto ? JSON.parse(texto) : undefined,
    repetida: r.headers.get('idempotency-replayed') === 'true',
  };
}

const tocoElAlmacen = (): boolean => almacen.sentencias.some((s) => /idempotency_keys/.test(s));

describe('el reintento con la misma llave no duplica el acto', () => {
  it('el manejador corre UNA vez y la segunda respuesta es la grabada', async () => {
    const cuerpo = { monto: '1500.00' };
    const primera = await pedir('POST', '/v1/pagos', { cuerpo, llave: 'K-1' });
    const segunda = await pedir('POST', '/v1/pagos', { cuerpo, llave: 'K-1' });

    expect(corridas.pagos, 'el reintento no vuelve a ejecutar').toBe(1);
    // Mismo código y mismo cuerpo, no un 200 genérico: el cliente no puede
    // distinguir el reintento de la respuesta original salvo por la marca.
    expect(segunda.status).toBe(primera.status);
    expect(segunda.status).toBe(201);
    expect(segunda.body).toEqual(primera.body);
    expect(segunda.body).toEqual({ data: { folio: 'PAGO-1', monto: '1500.00' } });
    expect(primera.repetida, 'la primera no es una repetición').toBe(false);
    expect(segunda.repetida, 'la segunda se anuncia como repetición').toBe(true);
  });

  it('el orden de las claves del cuerpo no cuenta como otra carga', async () => {
    // Un cliente que reconstruye el JSON desde un objeto no garantiza el
    // orden, y un cambio de orden no es un cambio de acto: acusarlo como
    // reuso de llave sería un falso conflicto en mitad de un reintento.
    await pedir('POST', '/v1/pagos', { cuerpo: { a: 1, b: 2 }, llave: 'K-2' });
    const segunda = await pedir('POST', '/v1/pagos', { cuerpo: { b: 2, a: 1 }, llave: 'K-2' });

    expect(segunda.status).toBe(201);
    expect(segunda.repetida).toBe(true);
    expect(corridas.pagos).toBe(1);
  });

  it('un 204 se repite como 204 y SIN cuerpo inventado', async () => {
    const primera = await pedir('DELETE', '/v1/suscripciones/s-9', { llave: 'K-3' });
    const segunda = await pedir('DELETE', '/v1/suscripciones/s-9', { llave: 'K-3' });

    expect(primera.status).toBe(204);
    expect(segunda.status).toBe(204);
    expect(segunda.body, 'un 204 grabado no puede volver con cuerpo').toBeUndefined();
    expect(segunda.repetida).toBe(true);
    expect(corridas.suscripciones).toBe(1);
  });

  it('llaves distintas son actos distintos', async () => {
    await pedir('POST', '/v1/pagos', { cuerpo: { monto: '1' }, llave: 'K-4' });
    await pedir('POST', '/v1/pagos', { cuerpo: { monto: '1' }, llave: 'K-5' });
    // Dos corridas legítimamente idénticas NO se deduplican solas: es el
    // mismo criterio por el que el almacén no hashea la carga por su cuenta.
    expect(corridas.pagos).toBe(2);
  });
});

describe('la misma llave con OTRA carga falla, y lo dice', () => {
  it('contesta 409 y no ejecuta', async () => {
    await pedir('POST', '/v1/pagos', { cuerpo: { monto: '1500.00' }, llave: 'K-6' });
    const otra = await pedir('POST', '/v1/pagos', { cuerpo: { monto: '15000.00' }, llave: 'K-6' });

    expect(otra.status, 'reuso de llave es conflicto, no acierto').toBe(409);
    expect(corridas.pagos, 'la carga distinta no se ejecuta').toBe(1);
    // Y nunca la respuesta de la OTRA carga: devolver PAGO-1 aquí sería
    // confirmarle al cliente un pago de 15 000 que nadie hizo.
    expect(JSON.stringify(otra.body)).not.toContain('PAGO-1');
  });

  it('el motivo va en el cuerpo, no un silencio', async () => {
    await pedir('POST', '/v1/pagos', { cuerpo: { monto: '1' }, llave: 'K-7' });
    const otra = await pedir('POST', '/v1/pagos', { cuerpo: { monto: '2' }, llave: 'K-7' });

    const mensaje = JSON.stringify(otra.body);
    expect(mensaje).toContain('K-7');
    expect(mensaje).toMatch(/carga DISTINTA/);
  });

  it('la misma llave con OTRA entidad es conflicto, no la respuesta de la primera', async () => {
    // La unicidad del almacén es por (inquilino, alcance, llave) y NO por
    // entidad. Sin la entidad dentro del hash, esta segunda llamada sería un
    // acierto y devolvería el resultado grabado de la entidad e-1: servirle a
    // una entidad la respuesta de otra.
    await pedir('POST', '/v1/pagos', { cuerpo: { monto: '1' }, llave: 'K-8', entidad: 'e-1' });
    const otra = await pedir('POST', '/v1/pagos', { cuerpo: { monto: '1' }, llave: 'K-8', entidad: 'e-2' });

    expect(otra.status).toBe(409);
    expect(JSON.stringify(otra.body)).not.toContain('PAGO-1');
  });

  it('la ruta también es parte del alcance: la misma llave en otra ruta no choca', async () => {
    await pedir('POST', '/v1/pagos', { cuerpo: { monto: '1' }, llave: 'K-9' });
    const otra = await pedir('DELETE', '/v1/suscripciones/s-1', { llave: 'K-9' });
    expect(otra.status).toBe(204);
  });
});

describe('lo que NO consuma la llave', () => {
  it('un fallo no la quema: el reintento vuelve a intentarlo', async () => {
    const primera = await pedir('POST', '/v1/rechaza', { cuerpo: { x: 1 }, llave: 'K-10' });
    const segunda = await pedir('POST', '/v1/rechaza', { cuerpo: { x: 1 }, llave: 'K-10' });

    expect(primera.status).toBe(422);
    // Si el 422 se hubiera grabado, este segundo intento recibiría el fallo
    // para siempre — y con él, la imposibilidad de reintentar tras arreglar
    // lo que fallara del otro lado.
    expect(segunda.status).toBe(422);
    expect(corridas.rechaza).toBe(2);
    expect(almacen.filas.size).toBe(0);
  });

  it('sin cabecera no se toca el almacén, y el acto se repite', async () => {
    await pedir('POST', '/v1/pagos', { cuerpo: { monto: '1' } });
    await pedir('POST', '/v1/pagos', { cuerpo: { monto: '1' } });

    expect(corridas.pagos, 'sin llave nada deduplica').toBe(2);
    expect(tocoElAlmacen(), 'una petición sin llave no paga ni un viaje').toBe(false);
  });

  it('una ruta de ESCRITURA ignora la cabecera: la clase es la que manda', async () => {
    // `exigeLlaveDeIdempotencia` es cierto en irreversible y externo. Una
    // escritura reversible no la exige, y mandarla no la inventa.
    await pedir('POST', '/v1/borradores', { cuerpo: { x: 1 }, llave: 'K-11' });
    await pedir('POST', '/v1/borradores', { cuerpo: { x: 1 }, llave: 'K-11' });

    expect(corridas.borradores).toBe(2);
    expect(tocoElAlmacen()).toBe(false);
  });
});

describe('una llave que no se puede honrar se rechaza, no se ignora', () => {
  it('dos cabeceras: 422, porque la llave unida no es la de nadie', async () => {
    // Node no entrega arreglo: une las dos con «, » y da UNA cadena. Sin la
    // comprobación de forma, el acto correría bajo la llave `K-A, K-B` —que
    // el cliente no conoce— y su reintento, con una sola cabecera, no
    // casaría con nada y volvería a ejecutar.
    const r = await pedir('POST', '/v1/pagos', { cuerpo: { monto: '1' }, llave: ['K-A', 'K-B'] });
    expect(r.status).toBe(422);
    expect(corridas.pagos ?? 0, 'no se ejecuta con la llave sin resolver').toBe(0);
  });

  it('un UUID pasa sin tocar nada: la forma no estorba a una llave de verdad', async () => {
    // El contrapeso de la prueba de arriba: un tope de forma demasiado
    // estrecho rechazaría lo que los clientes usan de verdad.
    const r = await pedir('POST', '/v1/pagos', {
      cuerpo: { monto: '1' },
      llave: '3f0c1b2a-9d4e-4a11-8c73-2b6de5f0a917',
    });
    expect(r.status).toBe(201);
  });

  it('llave vacía: 422, no «sin llave»', async () => {
    const r = await pedir('POST', '/v1/pagos', { cuerpo: { monto: '1' }, llave: '   ' });
    expect(r.status).toBe(422);
    expect(corridas.pagos ?? 0).toBe(0);
  });

  it('llave más larga que la columna: 422 nombrando el máximo', async () => {
    const r = await pedir('POST', '/v1/pagos', { cuerpo: { monto: '1' }, llave: 'x'.repeat(201) });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body)).toContain('200');
    expect(corridas.pagos ?? 0).toBe(0);
  });
});
