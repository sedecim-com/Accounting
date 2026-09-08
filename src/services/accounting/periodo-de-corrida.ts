import { query } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';

// ============================================================
// EL PERIODO QUE SE ESTÁ CORRIENDO, ACOTADO POR ENTIDAD (D1)
//
// Este archivo no es un refactor de conveniencia: lo pidió por escrito el
// código que sustituye. `amortization-run.ts:86-93` dice, sobre su propia
// copia de esta consulta:
//
//   «La sustancia es idéntica y no puede divergir —una consulta de dos
//    columnas contra una tabla—; si aparece un TERCER motor periódico, lo que
//    toca es subir este ayudante a un módulo común con el nombre del llamador
//    como parámetro, no una tercera copia.»
//
// El motor de provisiones de prestaciones ES el tercer motor periódico. Así
// que sube aquí, con el nombre del motor como parámetro, que es lo único que
// separaba a las dos copias: un operador que corre el devengo de nómina no
// puede leer que le habla la depreciación.
//
// LO QUE LA CONSULTA DEFIENDE, y por lo que no se puede simplificar a
// `WHERE id = $1`: con el id de un periodo de OTRA entidad, la corrida fecharía
// y numeraría los asientos de ésta contra el calendario de aquélla. Que la
// corrida ya filtre sus propias filas por entidad no cubre esto — el periodo es
// el otro extremo del par, y la frontera de entidad va DENTRO del SQL.
// ============================================================

export interface PeriodoDeCorrida {
  id: string;
  inicio: Date;
  fin: Date;
  nombre: string;
  /** 1..13. El 13 es el de ajustes anuales, no un mes de operación. */
  numero: number;
  /** 'regular' | 'adjustment' | 'closing' (CHECK de la 001). */
  tipo: string;
}

/**
 * MEDIANOCHE LOCAL, NUNCA UTC.
 *
 * `new Date('2026-12-01T00:00:00Z')` es medianoche UTC, que en México es el 30
 * de noviembre a las 18:00: el asiento se fecharía en el mes anterior —y
 * colgaría del periodo fiscal anterior— cuadrando igual de bien.
 *
 * Es la misma función que `depreciation.ts` y `prepaid-service.ts` exportan
 * para sus propios usos, y se repite aquí a propósito en vez de importarse:
 * un módulo de `accounting/` que importara de `assets/` invertiría la
 * dependencia, y traerse las ochocientas líneas de `prepaid-service` por dos
 * líneas de fecha ataría este ayudante al tramo equivocado. Lo que sí queda en
 * un solo sitio es lo que importaba —la consulta acotada por entidad—; una
 * normalización de fecha de dos líneas no es donde reaparecen los defectos de
 * este proyecto, y la de la consulta sí.
 */
function medianocheLocal(valor: Date | string): Date {
  if (typeof valor === 'string') return new Date(`${valor.slice(0, 10)}T00:00:00`);
  return new Date(valor.getFullYear(), valor.getMonth(), valor.getDate());
}

/**
 * @param motor Cómo se llama la corrida EN EL MENSAJE DE ERROR. Es todo lo que
 *   distinguía a las dos copias anteriores, y no es cosmético: el mensaje lo
 *   lee un operador que está corriendo un cierre, y decirle que «la corrida de
 *   depreciación no cruza entidades» cuando está devengando la nómina lo manda
 *   a buscar el defecto al módulo equivocado.
 */
export async function periodoDeLaCorrida(
  entityId: string,
  fiscalPeriodId: string,
  motor: string
): Promise<PeriodoDeCorrida> {
  const r = await query<{
    id: string;
    start_date: Date;
    end_date: Date;
    period_name: string;
    period_number: number;
    period_type: string;
  }>(
    `SELECT id, start_date, end_date, period_name, period_number, period_type
       FROM fiscal_periods
      WHERE id = $1 AND entity_id = $2`,
    [fiscalPeriodId, entityId]
  );
  const fila = r.rows[0];
  if (!fila) {
    throw new ValidationError(
      `El periodo fiscal ${fiscalPeriodId} no existe o no es de esta entidad. La corrida de ` +
        `${motor} no cruza entidades.`
    );
  }
  return {
    id: fila.id,
    inicio: medianocheLocal(fila.start_date),
    fin: medianocheLocal(fila.end_date),
    nombre: fila.period_name,
    numero: fila.period_number,
    tipo: fila.period_type,
  };
}
