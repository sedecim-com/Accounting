import type pg from 'pg';
import { vi } from 'vitest';

/**
 * Arnés de cliente pg para probar código que corre sobre un PoolClient
 * recibido de withTransaction (posting.ts, period-close.ts), que no se puede
 * probar mockeando el helper global `query`.
 *
 * Principio: ante SQL no previsto LANZA. Un `{ rows: [] }` por defecto haría
 * pasar pruebas contra consultas que ya cambiaron, que es exactamente la clase
 * de defecto que esta suite existe para atrapar.
 */

export interface RegistroConsulta {
  sql: string;
  params: unknown[];
}

export interface RespuestaConsulta {
  rows?: unknown[];
  rowCount?: number;
}

export interface ReglaConsulta {
  cuando: RegExp;
  responde: RespuestaConsulta | ((sql: string, params: unknown[]) => RespuestaConsulta);
  /** La regla se consume al primer uso: permite que la misma SELECT responda
   *  distinto la segunda vez (createJournalEntry relee el asiento tras el UPDATE). */
  unaVez?: boolean;
}

export interface ClienteFalso {
  client: pg.PoolClient;
  consultas: RegistroConsulta[];
  coincidencias(re: RegExp): RegistroConsulta[];
}

function normaliza(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

export function clienteFalso(reglas: ReglaConsulta[]): ClienteFalso {
  const pendientes = reglas.map((r) => ({ ...r, usada: false }));
  const consultas: RegistroConsulta[] = [];

  const query = vi.fn((texto: unknown, params?: unknown[]) => {
    const sql = normaliza(typeof texto === 'string' ? texto : String((texto as { text?: string })?.text ?? ''));
    consultas.push({ sql, params: params ?? [] });

    const regla = pendientes.find((r) => !(r.unaVez && r.usada) && r.cuando.test(sql));
    if (!regla) {
      throw new Error(`Consulta no esperada por el arnés: ${sql}`);
    }
    regla.usada = true;

    const res = typeof regla.responde === 'function' ? regla.responde(sql, params ?? []) : regla.responde;
    return Promise.resolve({
      rows: res.rows ?? [],
      rowCount: res.rowCount ?? (res.rows?.length ?? 0),
      command: '',
      oid: 0,
      fields: [],
    });
  });

  const client = { query, release: vi.fn() } as unknown as pg.PoolClient;

  return {
    client,
    consultas,
    coincidencias: (re: RegExp) => consultas.filter((c) => re.test(c.sql)),
  };
}

/**
 * withTransaction falso: entrega el cliente del arnés al callback y registra
 * si hubo commit o rollback, sin abrir conexión alguna.
 */
export function transaccionFalsa(cf: ClienteFalso) {
  const estado = { commits: 0, rollbacks: 0 };
  const run = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
    try {
      const r = await fn(cf.client);
      estado.commits++;
      return r;
    } catch (err) {
      estado.rollbacks++;
      throw err;
    }
  };
  return { run, estado };
}
