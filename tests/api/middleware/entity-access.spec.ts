import { describe, it, expect } from 'vitest';
import { assertEntityAccess, requireEntityAccess, ROLES } from '../../../src/api/rest/middleware/auth.js';
import { ForbiddenError } from '../../../src/utils/errors.js';

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
