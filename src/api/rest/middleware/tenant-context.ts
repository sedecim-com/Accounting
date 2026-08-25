import type { RequestHandler } from 'express';
import { withTenant } from '../../../database/connection.js';
import { UnauthorizedError } from '../../../utils/errors.js';

// ============================================================
// CONTEXTO DE INQUILINO POR PETICIÓN
//
// Las políticas de RLS (migración 014 + src/database/rls-policies.sql)
// filtran por app_current_tenant(), que lee el GUC `app.current_tenant`.
// Quien lo establece es la capa de conexión, pero solo cuando hay un
// contexto abierto: sin él, query() hace un viaje directo al pool y la
// consulta corre SIN inquilino.
//
// Hasta ahora solo dos de los diecisiete routers abrían contexto
// (ai.ts y ai-webhooks.ts). En los otros quince el aislamiento no
// dependía de nada: con el rol mnemosine_app la consulta habría
// devuelto cero filas, y con un rol dueño o superusuario —que ignora
// RLS— habría devuelto las filas de TODOS los inquilinos. La misma
// consulta, dos comportamientos opuestos según con qué rol se conectó
// el proceso. Eso es lo que este middleware quita de en medio.
//
// Va montado una sola vez, justo después de authenticate, para que
// ningún router pueda olvidarse de él.
// ============================================================

/**
 * Abre el contexto de inquilino para el resto de la petición.
 *
 * DEBE montarse DESPUÉS de `authenticate`: lee `req.tenantId`, que es lo
 * que aquel deja puesto desde el token.
 */
export const tenantContext: RequestHandler = (req, _res, next) => {
  const tenantId = req.tenantId;

  // Cierre en falso: un token autenticado pero sin inquilino no sigue.
  // La alternativa —dejarlo pasar sin contexto— es justamente el caso en
  // que un rol dueño ve el sistema entero.
  if (!tenantId) {
    next(
      new UnauthorizedError(
        'El token no identifica un inquilino: la petición no puede acotarse y se rechaza.'
      )
    );
    return;
  }

  // withTenant() usa AsyncLocalStorage. La promesa que devuelve se
  // resuelve en cuanto next() retorna —no cuando termina la petición—,
  // pero el contexto sobrevive igual: ALS lo propaga a toda continuación
  // asíncrona creada dentro de esa ejecución, que es la cadena entera de
  // middlewares y manejadores.
  //
  // enterTenant() sería lo incorrecto aquí: no acota, y el inquilino de
  // una petición se filtraría a la siguiente que tomara ese hilo.
  void withTenant(tenantId, async () => {
    next();
  });
};
