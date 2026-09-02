import type pg from 'pg';
import { query } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';

// ============================================================
// EL OTRO LADO DEL COTEJO (F05b)
//
// El motor de `matching.ts` sabía buscar facturas y gastos: documentos que
// esperan cobro o pago. Ése es UN lado. El otro —el que este archivo trae— es
// el de LIBROS: las líneas de póliza contabilizadas contra la cuenta de mayor
// del banco que nadie ha sellado todavía.
//
// La diferencia no es de forma, es de qué pregunta contesta cada lado. Un
// candidato de factura contesta «este depósito, ¿de quién es?». Una partida de
// libros contesta la pregunta inversa y mucho más incómoda: «este cheque que
// registré hace ochenta días, ¿por qué el banco nunca lo mostró?». Un cheque
// que se expidió y no se cobró, un depósito en tránsito que no llegó, un pago
// duplicado en libros — todos viven en este lado y ninguno aparece jamás
// mirando el extracto, porque el extracto no los tiene. Ese es justo el punto.
//
// EL SELLO NUNCA SE HABÍA ESCRITO. `journal_entry_lines.is_reconciled` existe
// desde la 001 y la 041 —la del mayor inviolable— le reserva a él y a sus dos
// acompañantes el ÚNICO hueco de escritura que admite una línea posteada:
//
//     permitidas text[] := ARRAY['is_reconciled', 'reconciled_at', 'reconciliation_id'];
//
// El esquema llevaba un año guardando ese hueco y ningún código lo usaba. La
// consecuencia práctica es que el matcher LEE `is_reconciled = false` para no
// reproponer lo ya conciliado, y como nadie lo ponía en true, la misma partida
// se proponía para siempre. Aquí se escribe, y se escribe COMPLETO: la 052
// añadió el CHECK `jel_sello_coherente`, que no admite término medio —o las
// tres columnas puestas, o las tres vacías—. Por eso `sellarPartidas` y
// `liberarPartidas` tocan las tres en una sola sentencia y no existe ninguna
// función que ponga sólo el booleano.
// ============================================================

/**
 * Una línea de póliza contra la cuenta de mayor del banco, con su antigüedad.
 *
 * `importe` va FIRMADO —débito positivo, crédito negativo— y no en valor
 * absoluto, porque el signo es la mitad de la información: contra la cuenta de
 * banco un débito es dinero que ENTRÓ según los libros y un crédito, dinero
 * que SALIÓ. Una lista de valores absolutos no distingue un depósito en
 * tránsito de un cheque en circulación, que son los dos hallazgos que este
 * lector existe para producir.
 */
export interface PartidaDeLibros {
  lineId: string;
  entryId: string;
  entryNumber: string;
  fecha: string;
  /** Débito positivo, crédito negativo. Cadena con los 4 decimales que guarda la columna. */
  importe: string;
  descripcion: string;
  antiguedadDias: number;
  sellada: boolean;
}

interface FilaPartida {
  line_id: string;
  entry_id: string;
  entry_number: string;
  fecha: string;
  importe: string;
  descripcion: string;
  antiguedad_dias: number;
  sellada: boolean;
}

export interface OpcionesPartidasDeLibros {
  /** Fecha de asiento mínima, inclusive (YYYY-MM-DD). */
  since?: string;
  /** Fecha de asiento máxima, inclusive (YYYY-MM-DD). */
  until?: string;
  /** Sólo lo que lleve MÁS de estos días sin aparecer en el banco. */
  overDays?: number;
}

/**
 * Las partidas de libros sin sellar contra la cuenta de mayor de una cuenta
 * bancaria, de la más vieja a la más nueva.
 *
 * El orden es descendente por antigüedad y no por fecha reciente a propósito:
 * lo que se busca aquí es lo que lleva más tiempo sin explicarse, no lo último
 * que se registró.
 */
export async function listarPartidasDeLibros(
  entityId: string,
  bankAccountId: string,
  opts: OpcionesPartidasDeLibros = {}
): Promise<PartidaDeLibros[]> {
  const condiciones: string[] = [];
  const params: unknown[] = [entityId, bankAccountId];

  if (opts.since) {
    params.push(opts.since);
    condiciones.push(`AND je.entry_date >= $${params.length}::date`);
  }
  if (opts.until) {
    params.push(opts.until);
    condiciones.push(`AND je.entry_date <= $${params.length}::date`);
  }
  if (opts.overDays !== undefined) {
    if (!Number.isInteger(opts.overDays) || opts.overDays < 0) {
      throw new ValidationError(
        `\`overDays\` tiene que ser un número entero de días no negativo; llegó ${String(opts.overDays)}.`
      );
    }
    params.push(opts.overDays);
    condiciones.push(`AND (CURRENT_DATE - je.entry_date) > $${params.length}::int`);
  }

  const r = await query<FilaPartida>(
    // LA ENTIDAD ACOTA LOS DOS EXTREMOS DEL JOIN, no uno.
    //
    // `bank_accounts` sí tiene entity_id, así que la cuenta se acota directo;
    // el asiento también. Se exigen las DOS porque el vínculo entre ellas es
    // `gl_account_id`, y una cuenta de mayor mal capturada —apuntando al plan
    // de otra entidad del mismo despacho— convertiría este lector en una
    // ventana a los libros ajenos. Con `ba.entity_id = je.entity_id` esa
    // captura errónea devuelve cero filas en vez de las de la víctima.
    //
    // `is_reconciled = false` es la definición misma de lo que se pide: la
    // fila 1209 del catálogo pide las partidas que el banco nunca mostró, y
    // una sellada ya se explicó.
    `SELECT jel.id                                        AS line_id,
            je.id                                         AS entry_id,
            je.entry_number,
            to_char(je.entry_date, 'YYYY-MM-DD')          AS fecha,
            (COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0))::text AS importe,
            COALESCE(NULLIF(jel.description, ''), je.description, '') AS descripcion,
            (CURRENT_DATE - je.entry_date)::int           AS antiguedad_dias,
            jel.is_reconciled                             AS sellada
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN bank_accounts ba   ON ba.gl_account_id = jel.account_id
      WHERE je.entity_id = $1
        AND ba.entity_id = $1
        AND ba.id = $2
        AND je.status = 'posted'
        AND jel.is_reconciled = false
        ${condiciones.join('\n        ')}
      ORDER BY je.entry_date ASC, je.entry_number ASC, jel.line_number ASC`,
    params
  );

  return r.rows.map((f) => ({
    lineId: f.line_id,
    entryId: f.entry_id,
    entryNumber: f.entry_number,
    fecha: f.fecha,
    importe: f.importe,
    descripcion: f.descripcion,
    antiguedadDias: Number(f.antiguedad_dias),
    // Se PROYECTA de la columna en vez de escribir `false` a mano. Hoy el
    // filtro de arriba hace que siempre valga false, pero el sello es un hecho
    // de tres columnas y el día que este lector admita listar también lo
    // sellado, el campo ya dirá la verdad en vez de mentir por constante.
    sellada: f.sellada,
  }));
}

/**
 * Pone el sello de conciliación sobre las líneas indicadas, atribuido al grupo
 * que lo justifica. Devuelve cuántas selló.
 *
 * Va sobre un client de transacción y no sobre el pool porque sellar la línea
 * de libros es la mitad de un cotejo: la otra mitad —las filas de
 * `reconciliation_matches` y el propio grupo— tiene que caer o quedarse con
 * ella. Un sello sin cotejo deja la partida invisible para siempre, que es
 * peor que no haberla sellado.
 */
export async function sellarPartidas(
  client: pg.PoolClient,
  lineIds: string[],
  groupId: string
): Promise<number> {
  if (lineIds.length === 0) return 0;

  const r = await client.query(
    // LAS TRES COLUMNAS JUNTAS, que es lo que el CHECK `jel_sello_coherente`
    // de la 052 exige: sellada implica con fecha y con dueño, o las tres
    // vacías. No hay término medio, y por eso no hay aquí ninguna variante
    // que ponga sólo el booleano.
    //
    // LA FRONTERA VA DENTRO DEL SQL Y SIN PARÁMETRO DE ENTIDAD. El grupo ya
    // sabe de quién es (`reconciliation_match_groups.entity_id`, 052:33) y el
    // asiento también; exigir que coincidan acota la escritura sin depender de
    // que el llamador se acuerde de pasar el alcance. Un id de línea ajena
    // simplemente no casa la condición y no se actualiza.
    //
    // `is_reconciled = false` hace la sentencia idempotente por el lado que
    // importa: reintentar no re-sella lo ya sellado, y el conteo de abajo
    // delata al que lo intente.
    `UPDATE journal_entry_lines jel
        SET is_reconciled = true,
            reconciled_at = NOW(),
            reconciliation_id = g.id
       FROM journal_entries je,
            reconciliation_match_groups g
      WHERE jel.id = ANY($1::uuid[])
        AND je.id = jel.journal_entry_id
        AND g.id = $2::uuid
        AND je.entity_id = g.entity_id
        AND je.status = 'posted'
        AND jel.is_reconciled = false`,
    [lineIds, groupId]
  );

  const selladas = r.rowCount ?? 0;
  if (selladas !== lineIds.length) {
    // Se rehúsa el cotejo entero en vez de sellar lo que se pudo. Un grupo
    // que cuadra Σbanco = Σlibros + Σajustes con una partida de menos no
    // cuadra: descuadraría en silencio y el descuadre aparecería en la sesión,
    // lejos de aquí y sin quién lo explique.
    throw new ValidationError(
      `El sello de conciliación alcanzó ${selladas} de ${lineIds.length} partida(s). ` +
        `Las que faltan ya estaban selladas, pertenecen a un asiento no contabilizado, ` +
        `o no son de la misma entidad que el grupo ${groupId}. No se sella nada a medias: ` +
        `revisa la lista con \`bank book-item list\` y vuelve a armar el grupo.`
    );
  }
  return selladas;
}

/**
 * Levanta el sello de las líneas indicadas. Devuelve cuántas liberó.
 *
 * Es lo que necesita `bank match unapply`: desaplicar CLAUSURA el cotejo —la
 * fila se marca, no se borra— pero la partida de libros sí tiene que volver a
 * estar disponible, o el movimiento quedaría sin poder cotejarse nunca más.
 */
export async function liberarPartidas(
  client: pg.PoolClient,
  lineIds: string[]
): Promise<number> {
  if (lineIds.length === 0) return 0;

  const r = await client.query(
    // Las tres columnas se vacían JUNTAS, por el mismo CHECK que las llena
    // juntas.
    //
    // El EXISTS no es adorno: sólo libera una línea el grupo de su MISMA
    // entidad. `reconciliation_id` no tiene FK a propósito (la 052 la deja
    // genérica para la certificación de cuentas de F05e, que no es bancaria),
    // así que la coherencia que la base no puede exigir se exige aquí. Una
    // línea sellada por un grupo de otra entidad no se libera desde este
    // camino, y el conteo de abajo lo dice en voz alta.
    `UPDATE journal_entry_lines jel
        SET is_reconciled = false,
            reconciled_at = NULL,
            reconciliation_id = NULL
       FROM journal_entries je
      WHERE jel.id = ANY($1::uuid[])
        AND je.id = jel.journal_entry_id
        AND jel.is_reconciled = true
        AND EXISTS (
              SELECT 1
                FROM reconciliation_match_groups g
               WHERE g.id = jel.reconciliation_id
                 AND g.entity_id = je.entity_id)`,
    [lineIds]
  );

  const liberadas = r.rowCount ?? 0;
  if (liberadas !== lineIds.length) {
    throw new ValidationError(
      `Se liberaron ${liberadas} de ${lineIds.length} partida(s). Las que faltan no estaban ` +
        `selladas, o su sello lo puso algo que no es un grupo de cotejo bancario de esta ` +
        `entidad —la certificación de cuentas usa la misma columna— y no se levanta desde aquí.`
    );
  }
  return liberadas;
}
