import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response } from 'express';
import { authenticate } from '../../../src/api/rest/middleware/auth.js';
import { config } from '../../../src/config/index.js';
import { ForbiddenError } from '../../../src/utils/errors.js';

/**
 * LA CABECERA x-entity-id ELIGE ENTRE LAS ENTIDADES DEL TOKEN; NO LAS AMPLÍA.
 *
 * Esto era `(req.headers['x-entity-id'] as string) || payload.entities[0]`, sin
 * contrastar la cabecera contra nada, y `req.entityId` es el alcance con el que
 * trabaja media API. Es decir: el alcance de la petición lo escribía el cliente.
 *
 * Y hacía SORTEABLE el primer tramo de TEN-1. Aquel acotó `voidInvoice` con un
 * `entityId` obligatorio, y `POST /v1/invoices/:id/void` se lo pasa como
 * `req.entityId!` sin llevar `requireEntityAccess`. Así que el `AND entity_id =
 * $2` recién añadido al SELECT ... FOR UPDATE recibía el valor de la cabecera:
 * mandar `x-entity-id: <entidad ajena>` bastaba para anular la factura de otro
 * y contraasentar su ingreso en el mayor de la víctima. El filtro estaba bien
 * escrito y comparaba contra un valor que elegía el atacante.
 */

const MIA = '11111111-1111-1111-1111-111111111111';
const OTRA = '22222222-2222-2222-2222-222222222222';
const AJENA = '33333333-3333-3333-3333-333333333333';

function token(entities: string[]): string {
  return jwt.sign(
    {
      user_id: 'u-1',
      tenant_id: 't-1',
      email: 'x@example.test',
      roles: ['owner'],
      permissions: ['*'],
      entities,
      session_id: 's-1',
    },
    config.jwt.secret,
    { expiresIn: '5m' }
  );
}

/** Corre `authenticate` de verdad y devuelve o el req resuelto o el error. */
async function autenticar(
  entities: string[],
  cabecera?: string | string[]
): Promise<{ req: Request; error: unknown }> {
  const req = {
    headers: {
      authorization: `Bearer ${token(entities)}`,
      ...(cabecera === undefined ? {} : { 'x-entity-id': cabecera }),
    },
  } as unknown as Request;

  return new Promise((resolve) => {
    authenticate(req, {} as Response, (err?: unknown) => resolve({ req, error: err }));
  });
}

describe('x-entity-id', () => {
  it('sin cabecera, la entidad por omisión del token', async () => {
    const { req, error } = await autenticar([MIA, OTRA]);
    expect(error).toBeUndefined();
    expect(req.entityId).toBe(MIA);
  });

  it('con una entidad que el token concede, la elige', async () => {
    // El caso de uso legítimo: un usuario con varias entidades cambia de una
    // a otra. Sigue funcionando igual.
    const { req, error } = await autenticar([MIA, OTRA], OTRA);
    expect(error).toBeUndefined();
    expect(req.entityId).toBe(OTRA);
  });

  it('con una entidad AJENA, se rechaza en vez de aceptarla', async () => {
    // Éste es el defecto: antes req.entityId salía valiendo AJENA y de ahí
    // pasaba a `AND entity_id = $2` de media API.
    const { req, error } = await autenticar([MIA], AJENA);
    expect(error).toBeInstanceOf(ForbiddenError);
    expect(req.entityId).toBeUndefined();
  });

  it('la cabecera no se cuela tampoco cuando el token no concede ninguna', async () => {
    const { error } = await autenticar([], AJENA);
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('repetida, no se elige una: se rechaza', async () => {
    // Express entrega una cabecera repetida como array. Adivinar cuál quiso
    // decir el cliente es justo lo que no debe hacer la autenticación.
    const { error } = await autenticar([MIA, OTRA], [MIA, OTRA]);
    expect(error).toBeInstanceOf(ForbiddenError);
  });

  it('vacía equivale a no mandarla', async () => {
    const { req, error } = await autenticar([MIA, OTRA], '   ');
    expect(error).toBeUndefined();
    expect(req.entityId).toBe(MIA);
  });

  it('el mensaje no distingue «no existe» de «existe y no es tuya»', async () => {
    // Aquí no se ha leído la base para saberlo, así que no hay nada que
    // delatar — y el mensaje tampoco lo insinúa.
    const { error } = await autenticar([MIA], AJENA);
    expect((error as Error).message).not.toMatch(/exist|otra entidad|another/i);
  });
});
