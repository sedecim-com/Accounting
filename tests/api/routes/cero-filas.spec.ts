import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

// ============================================================
// EL ÉXITO SOBRE CERO FILAS.
//
// Un UPDATE que no encuentra nada termina igual de bien que uno que sí:
// `rowCount` es 0 y `await query(...)` no lanza. Donde nadie mira ese
// número, la ruta contesta 2xx y quien llamó se queda creyendo que cambió
// algo. El censo de este tramo encontró tres sitios así en la superficie
// que este frente puede tocar:
//
//   · DELETE /v1/admin/integrations/:provider → 204 «apagada» sobre una
//     integración que nunca estuvo conectada. Es el peor: lo que ese
//     endpoint promete es cortarle a un tercero el acceso a las
//     credenciales del cliente.
//   · POST /v1/processing-batches/:id/execute → 200 con
//     `{total:0, successful:0, failed:0}` sobre un lote inexistente,
//     indistinguible de un lote vacío que corrió bien.
//   · POST /v1/pre-registrations/bulk con approve|reject|set_batch →
//     `status: 'success'` por cada id, incluso los de otra entidad. En un
//     lote la mentira se multiplica por la longitud del lote.
//
// La base va simulada y devuelve SIEMPRE cero filas: es exactamente el
// estado en el que las tres mentían. El caso contrario —que con fila sí
// contesten éxito— lo sostiene tests/integration/g4a-llave-y-cero-filas.int.spec.ts
// contra Postgres, porque un 404 incondicional pasaría esta suite entera.
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
import integrationsRouter from '../../../src/api/rest/routes/integrations.js';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
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
  app.use('/v1/admin/integrations', integrationsRouter);
  app.use(errorHandler);

  await new Promise<void>((ok) => {
    server = app.listen(0, '127.0.0.1', ok);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
});

async function pedir(
  metodo: string,
  ruta: string,
  cuerpo?: unknown
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${baseUrl}${ruta}`, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  return { status: r.status, body: texto ? (JSON.parse(texto) as Record<string, unknown>) : {} };
}

describe('el UPDATE que no encuentra nada no contesta éxito', () => {
  it('apagar una integración que no existe es 404, no 204', async () => {
    const r = await pedir('DELETE', '/v1/admin/integrations/finkok');
    expect(r.status, 'un 204 aquí decía «cortado» sin cortar nada').toBe(404);
    expect(JSON.stringify(r.body)).toContain('finkok');
  });

  it('ejecutar un lote que no existe es 404, no un resumen en ceros', async () => {
    const id = randomUUID();
    const r = await pedir('POST', `/v1/processing-batches/${id}/execute`);
    expect(r.status).toBe(404);
    // Y NO la respuesta vieja, que era la de un lote vacío que corrió bien.
    expect(JSON.stringify(r.body)).not.toContain('"successful":0');
  });
});

describe('el lote no reporta success sobre ids que no tocó', () => {
  const ids = [randomUUID(), randomUUID()];

  it.each(['approve', 'reject', 'set_batch'])(
    'bulk %s marca error por id cuando el UPDATE no encontró fila',
    async (action) => {
      const r = await pedir('POST', '/v1/pre-registrations/bulk', {
        action,
        ids,
        params: { reason: 'x', batch_id: randomUUID() },
      });

      expect(r.status).toBe(200);
      const datos = r.body.data as { results: Array<{ id: string; status: string; error?: string }> };
      expect(datos.results).toHaveLength(2);
      for (const fila of datos.results) {
        expect(fila.status, `${action} decía success sobre cero filas`).toBe('error');
        // El mismo texto que da la ruta individual con 404: un id ajeno se
        // lee igual se pida suelto o dentro de un lote.
        expect(fila.error).toContain('not found');
        expect(fila.error).toContain(fila.id);
      }
    }
  );

  it('el lote sigue contestando 200: un id que falla no tumba a los demás', async () => {
    const r = await pedir('POST', '/v1/pre-registrations/bulk', { action: 'approve', ids });
    expect(r.status).toBe(200);
    expect((r.body.data as { total: number }).total).toBe(2);
  });
});
