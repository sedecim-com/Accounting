import type pg from 'pg';
import { query } from './connection.js';
import { NotFoundError } from '../utils/errors.js';

// ============================================================
// LA FRONTERA, EN UNA SOLA FUNCIÓN.
//
// El sistema tenía 122 lecturas con la forma `WHERE id = $1` y ninguna
// frontera compartida. El patrón que se repetía era leer primero y comparar
// después, y falla de tres maneras a la vez:
//
//   · Deja una ventana entre la comprobación y la escritura.
//   · Obliga a que CADA llamador se acuerde. Basta uno que no, y hubo
//     varios: anular una factura por su UUID llegaba a crear y contabilizar
//     un asiento espejo en el mayor de otra entidad.
//   · Ramifica. Si el programa hace trabajo distinto cuando el recurso es
//     ajeno, la respuesta delata su existencia aunque el código HTTP sea el
//     mismo.
//
// Aquí el filtro va DENTRO del SQL. Cero filas significa a la vez «no
// existe» y «no es tuyo», y no hay ningún punto donde el programa pueda
// distinguirlos y contarlo.
//
// VIVE EN LA CAPA DE DATOS, no en un middleware, porque los cinco caminos
// que necesitan frontera —REST, GraphQL, la terminal, las herramientas del
// agente y los webhooks— no pueden importar de src/api/rest/middleware.
//
// RLS NO SUSTITUYE A ESTO. Acota por INQUILINO, y sólo si el proceso se
// conecta con un rol que no la ignora. Dentro de un inquilino con varias
// entidades legales no acota nada, y ese es justamente el eje que aquí se
// defiende.
// ============================================================

export type Scope =
  | { kind: 'entity'; tenantId: string; entityId: string }
  | { kind: 'tenant'; tenantId: string };

export const entityScope = (tenantId: string, entityId: string): Scope =>
  ({ kind: 'entity', tenantId, entityId });

export const tenantScope = (tenantId: string): Scope => ({ kind: 'tenant', tenantId });

/**
 * Qué columna acota cada tabla, deducida del esquema y no escrita a mano.
 *
 * Es el mismo criterio que usa src/database/rls-policies.sql para generar
 * las políticas: si la tabla tiene entity_id, acota por entidad; si tiene
 * tenant_id, por inquilino. Deducirlo importa — una tabla que nazca en una
 * migración futura entra sola en el mapa, en vez de nacer sin frontera, que
 * es exactamente como nació ai_external_ops.
 */
type Columna = 'entity_id' | 'tenant_id';
let mapa: Map<string, Columna> | null = null;

async function columnaDeAlcance(tabla: string): Promise<Columna | null> {
  if (!mapa) {
    const r = await query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name IN ('entity_id', 'tenant_id')`
    );
    const m = new Map<string, Columna>();
    for (const fila of r.rows) {
      const t = fila.table_name.toLowerCase();
      // entity_id gana: es la frontera más estrecha, y toda tabla con
      // entity_id llega a su inquilino a través de legal_entities.
      if (fila.column_name === 'entity_id') m.set(t, 'entity_id');
      else if (!m.has(t)) m.set(t, 'tenant_id');
    }
    mapa = m;
  }
  return mapa.get(tabla.toLowerCase()) ?? null;
}

/** Sólo para pruebas: olvida el mapa deducido. */
export function olvidarAlcances(): void {
  mapa = null;
}

/** Identificadores validados a mano: nada de esto viene de una petición. */
const NOMBRE_SQL = /^[a-z_][a-z0-9_]*$/;

interface OpcionesAlcance {
  /** Columnas a devolver. Por omisión, todas. */
  columns?: string;
  /** Bloquea la fila en la MISMA sentencia que comprueba la pertenencia. */
  forUpdate?: boolean;
  client?: pg.PoolClient;
  /** Nombre de la columna de id, cuando no es `id`. */
  idColumn?: string;
}

/**
 * La fila, si el alcance la alcanza. null si no existe O no es del alcance:
 * los dos casos son indistinguibles a propósito.
 */
export async function findByIdInScope<T extends pg.QueryResultRow = Record<string, unknown>>(
  tabla: string,
  id: string,
  scope: Scope,
  opts: OpcionesAlcance = {}
): Promise<T | null> {
  if (!NOMBRE_SQL.test(tabla)) throw new Error(`Nombre de tabla inválido: ${tabla}`);
  const idCol = opts.idColumn ?? 'id';
  if (!NOMBRE_SQL.test(idCol)) throw new Error(`Nombre de columna inválido: ${idCol}`);

  const columna = await columnaDeAlcance(tabla);
  if (columna === null) {
    // Una tabla sin entity_id ni tenant_id no tiene frontera que aplicar —
    // catálogos del SAT, migraciones. Se rechaza en vez de devolverla sin
    // acotar: si alguien la pide por aquí, o la tabla necesita alcance o la
    // llamada está mal, y ninguna de las dos debe pasar en silencio.
    throw new Error(
      `La tabla "${tabla}" no tiene columna de alcance (entity_id ni tenant_id): ` +
        `no se puede acotar. Si debe tenerla, es una migración; si es un catálogo global, ` +
        `consúltala directamente y documenta por qué no lleva frontera.`
    );
  }

  const { predicado, valor } = predicadoDe(columna, scope);
  const sql =
    `SELECT ${opts.columns ?? '*'} FROM ${tabla} ` +
    `WHERE ${idCol} = $1 AND ${predicado}` +
    (opts.forUpdate ? ' FOR UPDATE' : '');

  const r = opts.client
    ? await opts.client.query<T>(sql, [id, valor])
    : await query<T>(sql, [id, valor]);
  return r.rows[0] ?? null;
}

/**
 * Igual, pero exige la fila. Lanza NotFoundError — nunca ForbiddenError.
 *
 * 403 dice dos cosas: «existe» y «no es tuyo». La primera no debe salir del
 * sistema, porque aquí los identificadores CIRCULAN: /public/v1 devuelve
 * entityId sin autenticar, y las respuestas arrastran claves foráneas de
 * recursos que no se pidieron. Frente a un id ya conocido, la pregunta del
 * atacante no es «cuál» sino «sigue vivo», y un 403 se lo contesta.
 *
 * 403 se reserva para lo que no filtra nada: permiso ausente sobre un
 * recurso cuya pertenencia YA se probó.
 */
export async function requireByIdInScope<T extends pg.QueryResultRow = Record<string, unknown>>(
  tabla: string,
  id: string,
  scope: Scope,
  opts: OpcionesAlcance = {}
): Promise<T> {
  const fila = await findByIdInScope<T>(tabla, id, scope, opts);
  if (!fila) {
    // El mensaje no distingue tampoco: ni «de otra entidad» ni el nombre de
    // quién la tiene.
    throw new NotFoundError(nombreLegible(tabla), id);
  }
  return fila;
}

function predicadoDe(columna: Columna, scope: Scope): { predicado: string; valor: string } {
  if (columna === 'tenant_id') {
    // Un alcance de entidad SIEMPRE lleva su inquilino, así que sirve para
    // las dos formas.
    return { predicado: 'tenant_id = $2', valor: scope.tenantId };
  }
  if (scope.kind === 'entity') {
    return { predicado: 'entity_id = $2', valor: scope.entityId };
  }
  // Alcance de inquilino sobre una tabla por entidad: exactamente el mismo
  // predicado que genera rls-policies.sql, para que el comportamiento no
  // dependa de si RLS está activo.
  return {
    predicado: 'entity_id IN (SELECT id FROM legal_entities WHERE tenant_id = $2)',
    valor: scope.tenantId,
  };
}

/** `journal_entries` → `Journal entry`, para el mensaje de error. */
function nombreLegible(tabla: string): string {
  const singular = tabla.endsWith('ies')
    ? `${tabla.slice(0, -3)}y`
    : tabla.endsWith('s')
      ? tabla.slice(0, -1)
      : tabla;
  const palabras = singular.replace(/_/g, ' ');
  return palabras.charAt(0).toUpperCase() + palabras.slice(1);
}
