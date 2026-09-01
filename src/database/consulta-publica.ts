import type pg from 'pg';
import { withTransaction } from './connection.js';

// ============================================================
// LA CONSULTA PÚBLICA ASUME EL ROL VERIFICADOR (R2, migración 042).
// (ver la 042 para el porqué completo)
// /public/v1 corre sin contexto de inquilino, y bajo RLS forzada eso era
// cero filas con mnemosine_app — el feature empujaba a conectar con un rol
// que ignora RLS. Este helper ejecuta cada consulta pública dentro de una
// transacción que asume mnemosine_verifier con SET LOCAL ROLE: el rol de
// MENOS privilegios (SELECT enumerado + políticas del predicado público),
// y el rol de conexión vuelve solo al cerrar la transacción.
// ============================================================

export async function consultaPublica<T extends pg.QueryResultRow = Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<pg.QueryResult<T>> {
  return withTransaction(async (client) => {
    try {
      await client.query('SET LOCAL ROLE mnemosine_verifier');
    } catch (err) {
      throw new Error(
        'No se pudo asumir mnemosine_verifier para la consulta pública. El rol lo crea la ' +
          'migración 042; si el rol de conexión no es miembro, corre las migraciones (el GRANT ' +
          'viaja ahí). Nunca conectes el proceso con un rol que ignore RLS para "arreglar" esto. ' +
          `Causa: ${(err as Error).message}`
      );
    }
    return client.query<T>(sql, params);
  });
}
