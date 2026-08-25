import { describe, it, expect, vi } from 'vitest';
import { tenantContext } from '../../../src/api/rest/middleware/tenant-context.js';
import { currentTenant } from '../../../src/database/connection.js';
import { UnauthorizedError } from '../../../src/utils/errors.js';

const INQUILINO = '11111111-1111-1111-1111-111111111111';

function peticion(tenantId?: string) {
  const req = { tenantId, headers: {} } as any;
  const res = {} as any;
  return { req, res };
}

/** Espera a que la cadena que next() arrancó termine. */
const siguienteTick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('tenantContext', () => {
  it('abre el contexto con el inquilino del token', async () => {
    const { req, res } = peticion(INQUILINO);
    let visto: string | undefined = 'sin ejecutar';
    tenantContext(req, res, () => {
      visto = currentTenant();
    });
    await siguienteTick();
    expect(visto).toBe(INQUILINO);
  });

  it('el contexto sobrevive a un await del manejador', async () => {
    const { req, res } = peticion(INQUILINO);
    let visto: string | undefined;
    let terminado: () => void;
    const listo = new Promise<void>((r) => { terminado = r; });

    tenantContext(req, res, () => {
      // Un manejador real hace await antes de tocar la base: si ALS no
      // propagara el contexto a la continuación, aquí sería undefined y
      // la consulta correría sin inquilino.
      void (async () => {
        await new Promise((r) => setTimeout(r, 5));
        visto = currentTenant();
        terminado();
      })();
    });

    await listo;
    expect(visto).toBe(INQUILINO);
  });

  it('sin inquilino rechaza la petición en vez de dejarla pasar sin acotar', async () => {
    const { req, res } = peticion(undefined);
    const next = vi.fn();
    tenantContext(req, res, next);
    await siguienteTick();

    expect(next).toHaveBeenCalledTimes(1);
    const arg = next.mock.calls[0][0];
    expect(arg).toBeInstanceOf(UnauthorizedError);
    expect((arg as Error).message).toMatch(/no identifica un inquilino/);
  });

  it('fuera del contexto no hay inquilino: el estado no se filtra', async () => {
    const { req, res } = peticion(INQUILINO);
    tenantContext(req, res, () => undefined);
    await siguienteTick();
    // Si se hubiera usado enterTenant(), aquí seguiría puesto y la
    // siguiente petición heredaría el inquilino de esta.
    expect(currentTenant()).toBeUndefined();
  });

  it('dos peticiones concurrentes no se mezclan', async () => {
    const A = '22222222-2222-2222-2222-222222222222';
    const B = '33333333-3333-3333-3333-333333333333';
    const vistos: Record<string, string | undefined> = {};

    const correr = (id: string, demora: number): Promise<void> =>
      new Promise((resolve) => {
        const { req, res } = peticion(id);
        tenantContext(req, res, () => {
          void (async () => {
            await new Promise((r) => setTimeout(r, demora));
            vistos[id] = currentTenant();
            resolve();
          })();
        });
      });

    // La petición A tarda más: si el contexto fuera de proceso y no de
    // ejecución, B se lo habría pisado antes de que A leyera el suyo.
    await Promise.all([correr(A, 20), correr(B, 1)]);
    expect(vistos[A]).toBe(A);
    expect(vistos[B]).toBe(B);
  });
});
