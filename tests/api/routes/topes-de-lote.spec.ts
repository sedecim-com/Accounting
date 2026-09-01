import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

// ============================================================
// LOS TOPES DE LOTE DE LA INGESTA.
//
// Los dos endpoints de lote de xml-ingestion recorren su arreglo con al menos
// un viaje a la base por elemento, y `bulk` con action:'process' POSTEA AL
// MAYOR en cada vuelta. El freno por petición no ve esa amplificación: una
// sola petición gasta 1 de las 1000 del bucket horario del inquilino y ata un
// worker y el pool durante tantas operaciones en serie como elementos traiga.
// Por eso el tope vive en el ESQUEMA, donde se rechaza antes de tocar nada.
//
// Esta suite existe porque los dos topes son una línea cada uno y nada los
// sostenía: `xml_contents` estaba acotado desde el principio y nadie lo
// probaba, e `ids` nació sin acotar y nadie lo notó hasta que una auditoría lo
// buscó a propósito. Un tope sin prueba se borra en una refactorización sin
// que nadie se entere, y lo que queda es este mismo agujero otra vez.
//
// Se afirma el par completo: en el tope se pasa, uno por encima se rechaza.
// Sólo la mitad de arriba dejaría pasar un tope de cero.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
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
}));

import xmlIngestionRouter from '../../../src/api/rest/routes/xml-ingestion.js';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';

/** El tope que declara xml-ingestion.ts para AMBOS lotes. */
const TOPE = 100;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  // Sustituye a `authenticate` con un operador comodín: así todo rechazo que
  // observemos viene del esquema, no de la puerta de permisos.
  app.use((req, _res, next) => {
    req.user = {
      user_id: 'u-1',
      tenant_id: 't-1',
      entities: ['e-1'],
      permissions: ['*'],
    } as never;
    req.tenantId = 't-1';
    req.entityId = 'e-1';
    next();
  });

  app.use('/v1', xmlIngestionRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function postear(path: string, body: unknown): Promise<number> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.status;
}

const idsDe = (n: number): string[] => Array.from({ length: n }, () => randomUUID());
const xmlsDe = (n: number): string[] => Array.from({ length: n }, (_, i) => `<x>${i}</x>`);

describe('los lotes de la ingesta están acotados en el esquema', () => {
  it(`bulk rechaza ${TOPE + 1} ids`, async () => {
    // El caso del hallazgo: sin tope, un lote de cientos de miles de ids
    // atravesaba la validación y el manejador los recorría uno a uno.
    expect(await postear('/v1/pre-registrations/bulk', { action: 'approve', ids: idsDe(TOPE + 1) })).toBe(422);
  });

  it(`bulk acepta ${TOPE} ids: el tope no está por debajo de lo que promete`, async () => {
    // No se afirma 2xx —el manejador habla con una base simulada—, sino que el
    // ESQUEMA no lo rechaza: un tope de cero también haría pasar la prueba de
    // arriba, y sería otra forma de romper el endpoint.
    expect(await postear('/v1/pre-registrations/bulk', { action: 'approve', ids: idsDe(TOPE) })).not.toBe(422);
  });

  it('bulk sigue exigiendo al menos un id', async () => {
    expect(await postear('/v1/pre-registrations/bulk', { action: 'approve', ids: [] })).toBe(422);
  });

  it(`upload rechaza ${TOPE + 1} xml, y acepta ${TOPE}`, async () => {
    // El tope hermano, el que sí existía y tampoco tenía quien lo sostuviera.
    expect(await postear('/v1/upload', { xml_contents: xmlsDe(TOPE + 1) })).toBe(422);
    expect(await postear('/v1/upload', { xml_contents: xmlsDe(TOPE) })).not.toBe(422);
  });
});
