/**
 * LA ENTIDAD DE UNA CORRIDA NO ES UNA COLUMNA: ES UN CAMINO (T9c · #96).
 *
 * `pay_runs`, `pay_periods` y `paychecks` no tienen `entity_id`. Sólo llevan
 * `tenant_id`, y por eso el ayudante genérico de la casa NO sirve aquí: medido,
 * `requireByIdInScope('pay_runs', <id de la sociedad B>, entityScope(A))`
 * DEVUELVE LA FILA AJENA, porque `columnaDeAlcance` deduce la columna del
 * esquema y cae a `tenant_id`. Una reparación escrita con él contestaría 404
 * sobre otro INQUILINO y 200 sobre la sociedad hermana: cerrada en el diff,
 * verde en CI, abierta en producción.
 *
 * Así que el camino se escribe, y se escribe UNA vez. Cada predicado se pega
 * dentro del WHERE de la consulta que ya existe —no en una comprobación
 * previa—, porque comprobar con un SELECT y escribir después reabre la ventana
 * entre mirar y escribir, que es la razón por la que existe
 * `condicionDeAlcance` en scope.ts.
 *
 * Los dos caminos de un recibo. `paychecks` llega a una entidad por DOS rutas:
 * su empleado y su corrida. Se usa la del EMPLEADO porque es la que decide de
 * quién es el dinero —el recibo es suyo— y porque `employees.entity_id` es
 * columna propia y no otro salto. Que las dos coincidan es una propiedad de los
 * datos que nadie garantiza hoy; si alguna vez divergen, la del empleado es la
 * que manda.
 */

import type { Scope } from '../../../database/scope.js';

/** Corrida → periodo → calendario → entidad. */
export const corridaEnEntidad = (columnaId: string, indice: number): string =>
  `EXISTS (
     SELECT 1 FROM pay_periods pp
       JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id
      WHERE pp.id = ${columnaId} AND ps.entity_id = $${indice}
   )`;

/**
 * Periodo → calendario → entidad.
 *
 * CADA SALTO SE ALIASA, incluido el primero. La primera redacción colgaba el
 * calendario de una subconsulta escalar `(SELECT pay_schedule_id FROM
 * pay_periods WHERE id = ${columnaId})`, y con `columnaId` valiendo
 * `pay_periods.id` —el caso real de la ruta— el nombre de dentro tapaba al de
 * fuera: la condición se leía «id = mi propio id», cierta para TODA fila, y la
 * subconsulta escalar devolvía la tabla entera. Con un solo periodo sembrado
 * daba la respuesta correcta por casualidad; con dos, «more than one row
 * returned by a subquery used as an expression», o sea 500 en una ruta de
 * creación. Lo destapó darle nómina propia a la sociedad que ataca.
 */
export const periodoEnEntidad = (columnaId: string, indice: number): string =>
  `EXISTS (
     SELECT 1 FROM pay_periods pp2
       JOIN pay_schedules ps2 ON ps2.id = pp2.pay_schedule_id
      WHERE pp2.id = ${columnaId} AND ps2.entity_id = $${indice}
   )`;

/** Recibo → empleado → entidad. */
export const reciboEnEntidad = (columnaId: string, indice: number): string =>
  `EXISTS (
     SELECT 1 FROM employees e2
      WHERE e2.id = ${columnaId} AND e2.entity_id = $${indice}
   )`;

/**
 * El predicado COMPLETO de una corrida —inquilino y, si el alcance lo trae,
 * entidad— listo para pegarse en un WHERE, con sus valores en orden.
 *
 * Los dos ejes juntos y no sólo el segundo: `tenant_id` sigue haciendo falta
 * porque el camino hasta la entidad pasa por tablas que un día podrían tener
 * una fila cruzada, y porque es el índice que la consulta ya usaba.
 *
 * Un alcance de inquilino NO añade el camino: `tenant_id = $n` ya significa
 * «todas las entidades de este inquilino», que es exactamente lo que
 * `predicadoDe` de scope.ts genera para ese caso. Que las dos formas coincidan
 * no es casualidad: es la razón de que esto no invente una tercera.
 */
export function alcanceDeCorrida(
  scope: Scope,
  columnaPeriodo: string,
  indice: number
): { sql: string; valores: string[] } {
  if (scope.kind === 'tenant') {
    return { sql: `tenant_id = $${indice}`, valores: [scope.tenantId] };
  }
  return {
    sql: `tenant_id = $${indice} AND ${corridaEnEntidad(columnaPeriodo, indice + 1)}`,
    valores: [scope.tenantId, scope.entityId],
  };
}
