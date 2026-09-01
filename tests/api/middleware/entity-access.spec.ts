import { describe, it, expect } from 'vitest';
import { assertEntityAccess, requireEntityAccess, ROLES } from '../../../src/api/rest/middleware/auth.js';
import { ForbiddenError, ValidationError } from '../../../src/utils/errors.js';

/**
 * PERMISO Y PERTENENCIA SON DOS EJES DISTINTOS.
 *
 * `journal_entries:post` dice QUÉ puedes hacer; accessible_entities dice
 * SOBRE QUÉ. Esta comprobación tenía la forma:
 *
 *     if (!user.entities.includes(entityId) && !user.permissions.includes('*'))
 *
 * y el rol `owner` es exactamente `['*']`. O sea que para cualquier owner la
 * función era un no-op y aceptaba el id de CUALQUIER entidad, de cualquier
 * inquilino. Lo único que quedaba en medio era RLS, que es inerte con un rol
 * de conexión que la ignora.
 *
 * Que las 1956 pruebas siguieran pasando al quitarlo dice algo por sí solo:
 * el agujero no estaba probado en ninguna de las dos direcciones.
 */

const MIA = '11111111-1111-1111-1111-111111111111';
const AJENA = '22222222-2222-2222-2222-222222222222';

describe('assertEntityAccess', () => {
  it('deja pasar una entidad que el usuario tiene concedida', () => {
    expect(() =>
      assertEntityAccess({ entities: [MIA], permissions: ['invoices:read'] }, MIA)
    ).not.toThrow();
  });

  it('rechaza una entidad que no tiene concedida', () => {
    expect(() =>
      assertEntityAccess({ entities: [MIA], permissions: ['invoices:read'] }, AJENA)
    ).toThrow(ForbiddenError);
  });

  it('el comodín de permisos NO abre entidades ajenas', () => {
    // Éste es el defecto. Un owner conserva todos sus verbos, pero sobre las
    // filas que tiene concedidas.
    expect(() =>
      assertEntityAccess({ entities: [MIA], permissions: ['*'] }, AJENA)
    ).toThrow(ForbiddenError);
  });

  it('un owner sigue entrando a lo suyo', () => {
    expect(() =>
      assertEntityAccess({ entities: [MIA], permissions: ['*'] }, MIA)
    ).not.toThrow();
  });

  it('sin entidades concedidas no se entra a ninguna, ni con comodín', () => {
    expect(() => assertEntityAccess({ entities: [], permissions: ['*'] }, MIA)).toThrow(
      ForbiddenError
    );
  });

  it('el rol owner sigue siendo comodín de PERMISOS: es el eje que sí abre', () => {
    // La corrección no toca la autorización por verbo, sólo la pertenencia.
    expect(ROLES.owner).toEqual(['*']);
  });
});

/**
 * LA GUARDA MIRA TODAS LAS FUENTES, NO LA PRIMERA.
 *
 * Era una cadena de `||`, y por eso no servía: `authenticate` asigna SIEMPRE
 * `req.entityId = x-entity-id || payload.entities[0]`, así que el primer
 * término nunca es falsy y la cadena jamás llegaba a los otros tres. La
 * guarda comprobaba la cabecera mientras el manejador leía su `?entity_id=`.
 *
 * El primer intento de arreglo fue AÑADIR `req.query` AL FINAL de la misma
 * cadena — inerte por la misma razón. Estas pruebas existen porque un
 * arreglo que no cambia nada pasa desapercibido con demasiada facilidad.
 */
describe('requireEntityAccess mira todas las fuentes', () => {
  const usuario = { entities: [MIA], permissions: ['invoices:read'] };
  const peticion = (extra: Record<string, unknown>) =>
    ({ user: usuario, entityId: MIA, params: {}, body: {}, query: {}, ...extra }) as never;

  it('deja pasar cuando todas las fuentes son suyas', () => {
    const next = () => undefined;
    expect(() =>
      requireEntityAccess(peticion({ query: { entity_id: MIA } }), {} as never, next as never)
    ).not.toThrow();
  });

  it('rechaza una entidad ajena en la QUERY, aunque la cabecera sea suya', () => {
    // Éste es el vector: req.entityId (de la cabecera) es válido, y el
    // manejador de una ruta de listado va a usar ?entity_id=.
    expect(() =>
      requireEntityAccess(peticion({ query: { entity_id: AJENA } }), {} as never, (() => undefined) as never)
    ).toThrow(ForbiddenError);
  });

  it('rechaza una entidad ajena en el CUERPO', () => {
    expect(() =>
      requireEntityAccess(peticion({ body: { entity_id: AJENA } }), {} as never, (() => undefined) as never)
    ).toThrow(ForbiddenError);
  });

  it('rechaza una entidad ajena en los PARÁMETROS de ruta', () => {
    expect(() =>
      requireEntityAccess(peticion({ params: { entity_id: AJENA } }), {} as never, (() => undefined) as never)
    ).toThrow(ForbiddenError);
  });

  it('sin ninguna entidad en la petición, no bloquea', () => {
    let llamado = false;
    requireEntityAccess(
      { user: usuario, params: {}, body: {}, query: {} } as never,
      {} as never,
      (() => { llamado = true; }) as never
    );
    expect(llamado).toBe(true);
  });
});

/**
 * DOS ENTIDADES DISTINTAS EN UNA PETICIÓN SE RECHAZAN, AUNQUE LAS DOS SEAN
 * SUYAS.
 *
 * Comprobar que ambas pertenecen al usuario cierra el hueco de ACCESO y deja
 * abierto el que importa en un sistema contable. Cada ruta lee la fuente que
 * le corresponde —unas la cabecera, otras `?entity_id=`— y el contexto de la
 * bitácora se arma siempre con `req.entityId` (middleware/correlation.ts).
 * Con cabecera A y query B, el trabajo ocurre sobre B y TODO lo registrado
 * dice A. No es una fuga: es una atribución falsa, y no se repara después
 * porque el rastro ya se escribió así.
 *
 * La otra mitad de la misma regla: cuando la petición nombra UNA entidad y la
 * cabecera no venía, esa entidad manda sobre la de relleno del token, para
 * que la bitácora registre aquélla sobre la que de verdad se trabajó.
 */
describe('requireEntityAccess ante fuentes que se contradicen', () => {
  const OTRA_MIA = '33333333-3333-3333-3333-333333333333';
  const usuario = { entities: [MIA, OTRA_MIA], permissions: ['invoices:read'] };
  const nada = (() => undefined) as never;
  const peticion = (extra: Record<string, unknown>) =>
    ({ user: usuario, entityId: MIA, headers: {}, params: {}, body: {}, query: {}, ...extra }) as never;

  it('rechaza cabecera A y query B aunque las dos sean del usuario', () => {
    expect(() =>
      requireEntityAccess(
        peticion({ headers: { 'x-entity-id': MIA }, query: { entity_id: OTRA_MIA } }),
        {} as never,
        nada
      )
    ).toThrow(ValidationError);
  });

  it('el mensaje nombra las dos fuentes y los dos valores, para poder actuar', () => {
    try {
      requireEntityAccess(
        peticion({ headers: { 'x-entity-id': MIA }, body: { entity_id: OTRA_MIA } }),
        {} as never,
        nada
      );
      throw new Error('debió rechazar');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('cabecera');
      expect(msg).toContain('cuerpo');
      expect(msg).toContain(MIA);
      expect(msg).toContain(OTRA_MIA);
    }
  });

  it('no rechaza cuando las dos fuentes dicen LA MISMA entidad', () => {
    expect(() =>
      requireEntityAccess(
        peticion({ headers: { 'x-entity-id': MIA }, query: { entity_id: MIA } }),
        {} as never,
        nada
      )
    ).not.toThrow();
  });

  it('?entity_id=a&entity_id=a repetido no es una contradicción', () => {
    expect(() =>
      requireEntityAccess(peticion({ query: { entity_id: [MIA, MIA] } }), {} as never, nada)
    ).not.toThrow();
  });

  it('?entity_id=a&entity_id=b sí lo es, aunque llegue por una sola fuente', () => {
    expect(() =>
      requireEntityAccess(peticion({ query: { entity_id: [MIA, OTRA_MIA] } }), {} as never, nada)
    ).toThrow(ValidationError);
  });

  it('la entidad nombrada manda sobre la de relleno, para que la bitácora no mienta', () => {
    // Sin cabecera, `authenticate` deja req.entityId = payload.entities[0].
    // El manejador va a trabajar sobre la de la query; el registro tiene que
    // decir esa misma.
    const req = peticion({ entityId: MIA, query: { entity_id: OTRA_MIA } }) as unknown as {
      entityId: string;
    };
    requireEntityAccess(req as never, {} as never, nada);
    expect(req.entityId).toBe(OTRA_MIA);
  });

  it('sin nada nombrado, la de relleno se queda como está', () => {
    const req = peticion({ entityId: MIA }) as unknown as { entityId: string };
    requireEntityAccess(req as never, {} as never, nada);
    expect(req.entityId).toBe(MIA);
  });

  it('una contradicción se rechaza ANTES de mirar la pertenencia: no filtra si la ajena existe', () => {
    // Un 422 y un 403 distinguen «te contradijiste» de «esa entidad no es
    // tuya». Si la contradicción se evaluara después, el atacante aprendería
    // por el código de estado si la entidad ajena que probó es válida.
    expect(() =>
      requireEntityAccess(
        peticion({ headers: { 'x-entity-id': MIA }, query: { entity_id: AJENA } }),
        {} as never,
        nada
      )
    ).toThrow(ValidationError);
  });
});
