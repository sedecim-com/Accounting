import { describe, it, expect } from 'vitest';
import { assertEntityAccess, ROLES } from '../../../src/api/rest/middleware/auth.js';
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
