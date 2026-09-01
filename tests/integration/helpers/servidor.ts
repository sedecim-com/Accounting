import express, { type Router, type Request, type Response, type NextFunction } from 'express';
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';
import { tenantContext } from '../../../src/api/rest/middleware/tenant-context.js';
import type { Fixture } from './tenant-fixture.js';

/**
 * UN SERVIDOR DE VERDAD PARA PROBAR RUTAS DE VERDAD.
 *
 * Las fronteras que cierra TEN-2 viven en los MANEJADORES: qué alcance arma la
 * ruta y con qué se lo pasa al servicio. Una prueba que llame al servicio
 * directamente demuestra el servicio y da por bueno justo lo que se está
 * arreglando — que la ruta le pase el alcance correcto—. Así que aquí se monta
 * el router real, con el errorHandler real, y se le habla por HTTP.
 *
 * No hace falta supertest: `fetch` viene en Node y el servidor escucha en un
 * puerto efímero.
 *
 * `authenticate` se sustituye por un doble porque lo que se prueba aquí no es
 * la validación del token —eso está en tests/api/middleware/entity-header.spec.ts,
 * contra el authenticate real— sino qué hace la ruta con el alcance ya
 * resuelto. El doble deja req.user/tenantId/entityId exactamente como los deja
 * authenticate tras aceptar la cabecera.
 */
export interface Sesion {
  tenantId: string;
  entityId: string;
  userId: string;
  /** Entidades que concede el token. Por omisión, sólo la activa. */
  entities?: string[];
  permissions?: string[];
}

export const sesionDe = (f: Fixture, entities?: string[]): Sesion => ({
  tenantId: f.tenantId,
  entityId: f.entityId,
  userId: f.userId,
  entities: entities ?? [f.entityId],
});

export interface Servidor {
  url: string;
  cerrar: () => Promise<void>;
}

export async function levantar(monturas: Array<[string, Router]>, sesion: Sesion): Promise<Servidor> {
  const app = express();
  app.use(express.json());

  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      user_id: sesion.userId,
      tenant_id: sesion.tenantId,
      email: 'prueba@example.test',
      roles: ['owner'],
      permissions: sesion.permissions ?? ['*'],
      entities: sesion.entities ?? [sesion.entityId],
      session_id: 's-1',
      iat: 0,
      exp: 0,
    };
    req.tenantId = sesion.tenantId;
    req.entityId = sesion.entityId;
    next();
  });

  // El mismo que monta src/index.ts justo después de authenticate.
  app.use(tenantContext);

  for (const [ruta, router] of monturas) app.use(ruta, router);
  app.use(errorHandler);

  const server: Server = createServer(app);
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    cerrar: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

export interface Respuesta {
  status: number;
  body: Record<string, unknown>;
}

export async function pedir(
  s: Servidor,
  metodo: string,
  ruta: string,
  cuerpo?: unknown
): Promise<Respuesta> {
  const r = await fetch(`${s.url}${ruta}`, {
    method: metodo,
    headers: { 'content-type': 'application/json' },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });
  const texto = await r.text();
  return { status: r.status, body: texto ? JSON.parse(texto) : {} };
}
