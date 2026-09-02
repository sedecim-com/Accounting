import { GraphQLError, type GraphQLFormattedError } from 'graphql';
import { AppError } from '../../utils/errors.js';

/**
 * UNA DENEGACIÓN NO ES UNA CAÍDA, Y NO PUEDE PARECERLO.
 *
 * Sin esto, un `ForbiddenError` lanzado por la puerta de permisos sale como
 * `extensions.code = 'INTERNAL_SERVER_ERROR'`, sin `required/missing/current` y
 * —fuera de producción y de las pruebas— con el stacktrace del servidor y las
 * rutas absolutas del disco dentro. Para el cliente, y para cualquier alerta
 * enganchada a INTERNAL_SERVER_ERROR, una negativa legítima de permiso era
 * indistinguible de un servidor roto. Y la puerta acaba de convertir esta
 * superficie en una que deniega en cada llamada de un rol restringido, que es
 * justo lo que existe para producir.
 *
 * Traduce el MISMO `AppError` que traduce el manejador de REST
 * (middleware/error-handler.ts), con el mismo `code` y los mismos `details`,
 * para que las dos puertas contesten lo mismo ante lo mismo. Lo que NO es un
 * AppError no se reinterpreta: se le quita el rastro de pila y se deja pasar
 * como error del servidor, porque inventarle un código a lo que no se entiende
 * es cómo se esconde un fallo.
 */
export function formatearError(
  formateado: GraphQLFormattedError,
  crudo: unknown
): GraphQLFormattedError {
  const original = crudo instanceof GraphQLError ? crudo.originalError : crudo;
  if (original instanceof AppError) {
    return {
      message: original.message,
      path: formateado.path,
      locations: formateado.locations,
      extensions: {
        code: original.code,
        status: original.statusCode,
        field: original.field,
        details: original.details,
      },
    };
  }
  const { stacktrace: _fuera, ...resto } = (formateado.extensions ?? {}) as Record<string, unknown>;
  return { ...formateado, extensions: resto };
}
