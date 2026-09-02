import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import {
  LADO_DE,
  TIPOS_DE_PARTIDA,
  monto,
  tipoPorOmisionDeLibros,
  tipoPorOmisionDeMovimiento,
  type LadoDeLaConciliacion,
  type PartidaParaAritmetica,
  type TipoDePartida,
} from './reconciliation-math.js';

// ============================================================
// LAS PARTIDAS CONCILIATORIAS COMO FILAS (F05c · 053)
//
// La 003 las guardaba como CINCO ESCALARES en la sesión —`outstanding_checks`,
// `deposits_in_transit`, `bank_charges`, `bank_interest`,
// `other_adjustments`—, y un total no se persigue: un cheque de hace noventa
// días y uno de ayer suman igual y no significan lo mismo. El catálogo pide
// listarlas «con antigüedad, responsable, fecha esperada de liquidación y
// estado de escalamiento», y nada de eso cabe en un número. Aquí son filas.
//
// EL SIGNO VIVE EN EL DATO, Y ESTE ARCHIVO ES QUIEN LO ESCRIBE.
// `reconciliation-math.ts` suma sin un solo `if` por tipo porque confía en que
// `importe` llega FIRMADO POR SU APORTACIÓN a la conciliación. Esa confianza se
// paga aquí: si esta escritura invierte un signo, la aritmética de allá no
// tiene cómo notarlo —le llegará un número plausible— y la sesión descuadrará
// sin que nada lo señale. Por eso la regla se escribe una vez, abajo, y se
// prueba con los cuatro casos.
//
// LA REGLA. La aportación de una partida es el importe FIRMADO DE SU
// MOVIMIENTO DE ORIGEN, sin conversión ninguna:
//
//   · del extracto  → como lo firma el banco (cargo negativo, abono positivo);
//   · de libros     → como lo firma el mayor contra la cuenta de banco
//                     (débito positivo, crédito negativo).
//
// El TIPO no cambia ese signo: dice a cuál de los dos lados se suma. Y los
// lados van CRUZADOS, que es lo que hace que una conciliación bancaria no sea
// la resta de dos números —lo que los LIBROS saben y el banco todavía no
// corrige el saldo DEL BANCO, y viceversa—. `LADO_DE` lo dice entero.
//
// Comprobado con los cuatro casos, que son las cuatro pruebas de signo:
//
//   libros 100, banco 130, cheque de 30 sin cobrar (mayor: crédito −30)
//     → banco ajustado = 130 + (−30) = 100 = libros            ✓
//   libros 140, banco 100, depósito de 40 sin abonar (mayor: débito +40)
//     → banco ajustado = 100 + (+40) = 140 = libros            ✓
//   libros 100, banco  50, comisión de 50 sin registrar (extracto −50)
//     → libros ajustados = 100 + (−50) = 50 = banco            ✓
//   libros 100, banco 120, interés de 20 sin registrar (extracto +20)
//     → libros ajustados = 100 + (+20) = 120 = banco           ✓
//
// Que en los cuatro la aportación coincida con el signo del origen NO es una
// casualidad de la que aprovecharse en silencio: es la razón de que no haya
// aquí ningún `if (tipo === ...) negar(...)`. Guardar el signo del movimiento y
// dejar que cada lector aplique la regla por tipo es lo que descuadra sin
// ruido, porque un signo invertido no rompe nada —da una variación que parece
// un número—.
//
// CLASIFICAR ES PROPONER, NO DICTAMINAR. `clasificarPartidas` mira el signo y
// nada más; con el signo se distingue un cargo de un abono y un cheque de un
// depósito, y ahí se acaba lo que un signo puede decir. `error-del-banco` y
// `error-de-libros` no los propone NADIE automáticamente: un error es un juicio
// sobre quién se equivocó, y ningún número lo contiene. Por eso existe
// `reclasificarPartida`.
//
// LA FRONTERA. `reconciling_items` sí tiene `entity_id`, pero eso no basta:
// la sesión también la tiene, y las dos se exigen DENTRO del SQL. Un id de
// sesión ajena con una entidad propia no casa, y `bank_transactions` —que no
// tiene entidad— se acota por JOIN a `bank_accounts`, como en todo el módulo.
// ============================================================

/**
 * El estado de escalamiento del CHECK de la 053.
 *
 * Tres valores y ninguno es un número de días: ver `derivarEscalamiento`.
 */
export const ESCALAMIENTOS = ['ninguno', 'avisado', 'vencido'] as const;
export type Escalamiento = (typeof ESCALAMIENTOS)[number];

/** De dónde salió la partida: la trajo el extracto o la trajeron los libros. */
export type OrigenDePartida = 'extracto' | 'libros';

/**
 * EL ESCALAMIENTO SE DERIVA DE `fecha_esperada`, Y DE NADA MÁS.
 *
 * No hay aquí ningún umbral de días inventado —ni «a los 30 se avisa», ni «a
 * los 90 vence»—, y la ausencia es deliberada: un umbral escrito en el código
 * es una política contable disfrazada de constante, y en este repositorio las
 * políticas se declaran, no se codifican. Lo único que una fecha puede decidir
 * es si ya pasó.
 *
 * De ahí el reparto de competencias, que es la parte que importa:
 *
 *   · 'vencido' lo dice EL CALENDARIO. Se venció el día DESPUÉS de la fecha
 *     esperada: una liquidación esperada para hoy no llega tarde hoy.
 *   · 'avisado' lo dice UNA PERSONA. Es el hecho de haber perseguido la
 *     partida, y ninguna fecha lo sabe ni lo contradice, así que se conserva.
 *   · 'ninguno' es el resto.
 *
 * Y por eso lo derivado GANA a lo guardado cuando se contradicen: un 'vencido'
 * escrito en la columna sobre una partida cuya fecha esperada se movió al
 * futuro es exactamente la clase de dato que envejece mintiendo. Es la misma
 * tesis del tramo —lo vivo manda, lo guardado es la aseveración que se hizo—
 * aplicada a un campo pequeño.
 *
 * SIN `fecha_esperada` NO HAY NADA CONTRA QUÉ MEDIR y se respeta lo escrito.
 * Que una partida abierta no la tenga no es inocuo: `calcularAritmetica` lo
 * levanta como el reparo `partida-sin-fechar`, porque una partida sin fecha no
 * se persigue, envejece.
 *
 * @param hoy Fecha de referencia YYYY-MM-DD. Se pasa en vez de leerse del reloj
 *   para que la regla sea una función y no un experimento con el calendario del
 *   que la ejecuta. La comparación es lexicográfica, que en ISO es la temporal.
 */
export function derivarEscalamiento(
  fechaEsperada: string | null,
  hoy: string,
  registrado: Escalamiento = 'ninguno'
): Escalamiento {
  if (fechaEsperada === null || fechaEsperada === '') return registrado;
  if (fechaEsperada < hoy) return 'vencido';
  return registrado === 'avisado' ? 'avisado' : 'ninguno';
}

/** La propuesta que sale de mirar un movimiento: qué es y cuánto aporta. */
export interface PropuestaDePartida {
  tipo: TipoDePartida;
  lado: LadoDeLaConciliacion;
  /** La aportación, FIRMADA. Es el importe del origen tal cual. */
  importe: string;
}

/**
 * La partida que le corresponde a un movimiento sin cotejar, por su signo.
 *
 * Devuelve `null` con importe cero: un movimiento de cero no es un cargo ni un
 * abono —no hay signo que mirar— y aporta cero a cualquier lado, así que
 * levantarlo como partida sólo añadiría una fila que nadie puede resolver.
 * `clasificarPartidas` lo omite EN VOZ ALTA en vez de tipificarlo a la fuerza.
 *
 * El tipo lo deciden `tipoPorOmisionDeMovimiento` y `tipoPorOmisionDeLibros`,
 * que viven junto a la aritmética que los consume; aquí se les añade lo que
 * este archivo tiene que ESCRIBIR: el lado y la aportación. Y la aportación es
 * el importe del origen SIN TOCARLO —ni un `abs()`, ni un `negated()`—: la
 * ausencia de conversión es el punto, no un descuido.
 */
export function proponerPartida(origen: OrigenDePartida, importeDelOrigen: string): PropuestaDePartida | null {
  let importe: Decimal;
  try {
    importe = new Decimal(importeDelOrigen);
  } catch {
    throw new ValidationError(`Importe ilegible al clasificar la partida: "${importeDelOrigen}".`);
  }
  if (!importe.isFinite()) {
    throw new ValidationError(`Importe no finito al clasificar la partida: "${importeDelOrigen}".`);
  }
  if (importe.isZero()) return null;

  const tipo =
    origen === 'extracto'
      ? tipoPorOmisionDeMovimiento(importeDelOrigen)
      : tipoPorOmisionDeLibros(importeDelOrigen);

  return { tipo, lado: LADO_DE[tipo], importe: monto(importe) };
}

// ============================================================
// LEER LAS PARTIDAS
// ============================================================

export interface PartidaConciliatoria {
  id: string;
  tipo: TipoDePartida;
  /** A qué lado de la conciliación se suma. Derivado del tipo, nunca guardado. */
  lado: LadoDeLaConciliacion;
  /** Dinero como CADENA, firmado por su aportación. */
  importe: string;
  fecha: string;
  /** Días desde `fecha`. Lo calcula Postgres, con el mismo reloj que `hoy`. */
  antiguedadDias: number;
  responsable: string | null;
  fechaEsperada: string | null;
  /** El escalamiento VIVO: derivado de la fecha esperada contra hoy. */
  escalamiento: Escalamiento;
  /**
   * Lo que la columna guarda. Se expone junto al vivo a propósito: cuando los
   * dos difieren, la diferencia es información —alguien marcó algo que el
   * calendario ya contradice— y esconderla detrás del derivado la perdería.
   */
  escalamientoRegistrado: Escalamiento;
  bankTransactionId: string | null;
  journalEntryLineId: string | null;
  notas: string | null;
  resuelta: boolean;
  resueltaEl: string | null;
}

export interface OpcionesDeListado {
  tipo?: string;
  /** Sólo las que lleven MÁS de estos días desde su fecha. */
  overDays?: number;
  /** Por omisión sólo las abiertas: una resuelta ya no se persigue. */
  incluirResueltas?: boolean;
}

interface FilaPartida {
  id: string;
  tipo: string;
  importe: string;
  fecha: string;
  antiguedad_dias: number;
  responsable: string | null;
  fecha_esperada: string | null;
  escalamiento: string;
  bank_transaction_id: string | null;
  journal_entry_line_id: string | null;
  notas: string | null;
  resuelta_at: string | null;
  hoy: string;
}

function exigirTipoDePartida(valor: string): TipoDePartida {
  if (!(TIPOS_DE_PARTIDA as readonly string[]).includes(valor)) {
    throw new ValidationError(
      `Tipo de partida conciliatoria desconocido "${valor}". ` +
        `Los admitidos son: ${TIPOS_DE_PARTIDA.join(', ')}.`
    );
  }
  return valor as TipoDePartida;
}

function comoEscalamiento(valor: string): Escalamiento {
  return (ESCALAMIENTOS as readonly string[]).includes(valor) ? (valor as Escalamiento) : 'ninguno';
}

function aPartida(f: FilaPartida): PartidaConciliatoria {
  const tipo = exigirTipoDePartida(f.tipo);
  const registrado = comoEscalamiento(f.escalamiento);
  return {
    id: f.id,
    tipo,
    lado: LADO_DE[tipo],
    // Se normaliza con `monto` y no con un `toFixed(2)`: la columna es
    // DECIMAL(19,4) y recortar a la salida lo que después se suma es el
    // defecto que F05a cazó tres veces.
    importe: monto(new Decimal(f.importe)),
    fecha: f.fecha,
    antiguedadDias: Number(f.antiguedad_dias),
    responsable: f.responsable,
    fechaEsperada: f.fecha_esperada,
    escalamiento: derivarEscalamiento(f.fecha_esperada, f.hoy, registrado),
    escalamientoRegistrado: registrado,
    bankTransactionId: f.bank_transaction_id,
    journalEntryLineId: f.journal_entry_line_id,
    notas: f.notas,
    resuelta: f.resuelta_at !== null,
    resueltaEl: f.resuelta_at,
  };
}

/**
 * Las partidas de una sesión, de la más vieja a la más nueva.
 *
 * El orden es por antigüedad y no por lo último capturado, por la misma razón
 * que en `listarPartidasDeLibros`: lo que se busca es lo que lleva más tiempo
 * sin explicarse. Un listado por fecha de captura pone arriba lo que menos
 * urge.
 *
 * `hoy` sale de Postgres en la misma consulta que la antigüedad, para que el
 * escalamiento y los días no se midan con dos relojes distintos.
 */
export async function listarPartidas(
  entityId: string,
  sessionId: string,
  opts: OpcionesDeListado = {}
): Promise<PartidaConciliatoria[]> {
  return listarPartidasCon(null, entityId, sessionId, opts);
}

/**
 * Lo mismo, por el CLIENTE de una transacción cuando hay una.
 *
 * Los dos escritores de más abajo la necesitan: leen la partida, la cambian y
 * la releen DENTRO de su transacción, y por el pool la relectura no vería su
 * propio UPDATE —devolvería el valor viejo y el llamador creería que no pasó
 * nada—. `listarPartidas` sigue yendo por el pool, que es lo que quieren
 * `status` y `bank reconciling-item list`.
 */
async function listarPartidasCon(
  client: pg.PoolClient | null,
  entityId: string,
  sessionId: string,
  opts: OpcionesDeListado = {}
): Promise<PartidaConciliatoria[]> {
  const condiciones: string[] = [];
  const params: unknown[] = [entityId, sessionId];

  if (opts.tipo !== undefined) {
    params.push(exigirTipoDePartida(opts.tipo));
    condiciones.push(`AND ri.tipo = $${params.length}`);
  }
  if (opts.overDays !== undefined) {
    if (!Number.isInteger(opts.overDays) || opts.overDays < 0) {
      throw new ValidationError(
        `\`overDays\` tiene que ser un número entero de días no negativo; llegó ${String(opts.overDays)}.`
      );
    }
    params.push(opts.overDays);
    condiciones.push(`AND (CURRENT_DATE - ri.fecha) > $${params.length}::int`);
  }
  if (!opts.incluirResueltas) {
    condiciones.push('AND ri.resuelta_at IS NULL');
  }

  const sql =
    // LAS DOS ENTIDADES, la de la partida y la de su sesión. La partida lleva
    // `entity_id` propio, así que exigir sólo ése dejaría pasar una partida
    // bien sellada colgada de una sesión ajena —y la sesión es la que se
    // cierra—. Con las dos, un id de sesión de otra entidad devuelve cero
    // filas, que es a la vez «no existe» y «no es tuya».
    `SELECT ri.id,
            ri.tipo,
            ri.importe::text                              AS importe,
            to_char(ri.fecha, 'YYYY-MM-DD')               AS fecha,
            (CURRENT_DATE - ri.fecha)::int                AS antiguedad_dias,
            ri.responsable,
            to_char(ri.fecha_esperada, 'YYYY-MM-DD')      AS fecha_esperada,
            ri.escalamiento,
            ri.bank_transaction_id,
            ri.journal_entry_line_id,
            ri.notas,
            to_char(ri.resuelta_at, 'YYYY-MM-DD"T"HH24:MI:SSOF') AS resuelta_at,
            to_char(CURRENT_DATE, 'YYYY-MM-DD')           AS hoy
       FROM reconciling_items ri
       JOIN reconciliation_sessions s ON s.id = ri.reconciliation_session_id
      WHERE ri.entity_id = $1
        AND s.entity_id = $1
        AND s.id = $2
        ${condiciones.join('\n        ')}
      ORDER BY ri.fecha ASC, ri.created_at ASC`;

  const r = client
    ? await client.query<FilaPartida>(sql, params)
    : await query<FilaPartida>(sql, params);

  return r.rows.map(aPartida);
}

/**
 * Las partidas tal como las quiere `calcularAritmetica`.
 *
 * Existe para que ningún llamador vuelva a mapear a mano lo que ya está
 * mapeado: la conversión es de tres campos, y hacerla dos veces es cómo un
 * `importe` acaba entrando negado en un sitio y no en el otro.
 */
export function paraAritmetica(partidas: readonly PartidaConciliatoria[]): PartidaParaAritmetica[] {
  return partidas.map((p) => ({
    id: p.id,
    tipo: p.tipo,
    importe: p.importe,
    fechaEsperada: p.fechaEsperada,
    resuelta: p.resuelta,
  }));
}

// ============================================================
// DESCUBRIR LAS PARTIDAS
// ============================================================

/**
 * Cuántas partidas se levantan como máximo por lado en una pasada.
 *
 * Existe por lo mismo que `LIMITE_PROPUESTAS` en `match-service`: una cuenta
 * que nadie ha conciliado nunca puede tener decenas de miles de líneas de mayor
 * sin sellar, y `clasificarPartidas` escribe una fila por cada una. Lo que no
 * puede pasar es que el tope recorte EN SILENCIO —«se levantaron 1000» leído
 * como «no quedaba nada más»—, y por eso `topeAlcanzado` viaja en el resultado.
 */
export const LIMITE_DE_CLASIFICACION = 1000;

export interface PartidaLevantada {
  id: string;
  tipo: TipoDePartida;
  lado: LadoDeLaConciliacion;
  importe: string;
  fecha: string;
  origen: OrigenDePartida;
  origenId: string;
}

/** Por qué un candidato NO se levantó. Cerrado: una omisión se cuenta, no se lee. */
export const MOTIVOS_DE_OMISION = ['importe-cero'] as const;
export type MotivoDeOmision = (typeof MOTIVOS_DE_OMISION)[number];

export interface ResultadoDeClasificacion {
  levantadas: PartidaLevantada[];
  omitidas: Array<{ origen: OrigenDePartida; origenId: string; importe: string; motivo: MotivoDeOmision }>;
  /**
   * Cuántas nacen sin `fecha_esperada`, que es TODAS: nada en el extracto ni en
   * el mayor dice cuándo se espera que un cheque se cobre. Se cuenta aquí para
   * que la ausencia se vea al levantarlas y no meses después, cuando el
   * escalamiento de todas siga diciendo 'ninguno' porque no hay contra qué
   * medirlo. Quien la pone es una persona, con `asignarPartida`.
   */
  sinFechaEsperada: number;
  /**
   * Cuántas dejaron de explicar una diferencia porque su origen YA SE COTEJÓ.
   * Un cheque en circulación se resuelve solo el día que el banco lo enseña y
   * el cotejo lo empareja: esperar a que una persona lo cierre a mano sería
   * pedirle que confirme algo que el extracto ya dijo.
   */
  resueltas: number;
  topeAlcanzado: boolean;
}

interface FilaSesion {
  id: string;
  bank_account_id: string;
  end_date: string;
  status: string;
  closed_at: string | null;
}

interface FilaCandidataBanco {
  id: string;
  importe: string;
  fecha: string;
  descripcion: string | null;
}

interface FilaCandidataLibros {
  line_id: string;
  importe: string;
  fecha: string;
  descripcion: string | null;
}

/**
 * Levanta como partidas conciliatorias todo lo que ninguno de los dos lados
 * explica todavía, TIPIFICADO por su signo.
 *
 * Es la función que descubre. Un movimiento del extracto sin cotejo vivo es
 * candidato a cargo o abono del banco; una línea de mayor sin sellar es
 * candidata a cheque en circulación o depósito en tránsito. Lo que produce es
 * una PROPUESTA: quien clasifica de verdad es una persona, y por eso ninguna
 * partida sale de aquí como error —de nadie— y todas se pueden reclasificar.
 *
 * SIN LÍMITE INFERIOR DE FECHA, Y ES LO CORRECTO. Una partida conciliatoria
 * existe hasta que se resuelve: el cheque de enero que en marzo sigue sin
 * cobrarse es una partida de la conciliación de marzo, no un asunto cerrado de
 * enero. Acotar por `start_date` haría desaparecer exactamente las partidas
 * viejas, que son las únicas que importan. El límite superior sí está: nada
 * posterior al cierre del periodo entra en la sesión que lo concilia.
 *
 * IDEMPOTENTE POR ORIGEN, INCLUIDO LO YA RESUELTO. Se salta todo movimiento que
 * esta sesión ya levantó, esté abierto o no, y las dos mitades de esa frase
 * importan:
 *
 *   · abierto: una segunda pasada no duplica, y no resucita con su tipo
 *     original lo que alguien acababa de reclasificar;
 *   · RESUELTO: una partida resuelta es una que una persona cerró —el cheque se
 *     cobró, el depósito llegó—. Volver a levantarla porque su movimiento sigue
 *     sin cotejo reabriría en cada pasada lo que alguien ya explicó, y el
 *     desglose acumularía duplicados que nadie puede distinguir de los buenos.
 *     Filtrar aquí por `resuelta_at IS NULL` es exactamente ese error.
 *
 * Va sobre un `client` de transacción y no sobre el pool porque descubrir es
 * escribir: las dos lecturas y todos los INSERT tienen que ver el mismo mundo y
 * caer juntos. Media clasificación es un desglose que no suma.
 */
export async function clasificarPartidas(
  client: pg.PoolClient,
  entityId: string,
  sessionId: string,
  userId: string,
  opts: { limite?: number } = {}
): Promise<ResultadoDeClasificacion> {
  const limite = opts.limite ?? LIMITE_DE_CLASIFICACION;
  if (!Number.isInteger(limite) || limite < 1) {
    throw new ValidationError(`\`limite\` tiene que ser un entero positivo; llegó ${String(limite)}.`);
  }

  const ses = await client.query<FilaSesion>(
    `SELECT id, bank_account_id,
            to_char(end_date, 'YYYY-MM-DD') AS end_date,
            status,
            to_char(closed_at, 'YYYY-MM-DD') AS closed_at
       FROM reconciliation_sessions
      WHERE id = $1 AND entity_id = $2
      FOR UPDATE`,
    [sessionId, entityId]
  );
  if (ses.rows.length === 0) throw new NotFoundError('Reconciliation Session', sessionId);
  const sesion = ses.rows[0];

  // UNA SESIÓN CERRADA NO ADMITE PARTIDAS NUEVAS. Sus escalares son el resumen
  // CONGELADO —la aseveración que alguien firmó— y añadirle una partida
  // después haría que el desglose vivo dejara de coincidir con lo afirmado sin
  // que nadie hubiera reabierto nada. El descuadre aparecería en un informe
  // posterior, lejos de aquí y sin quién lo explique.
  if (sesion.status !== 'in_progress' || sesion.closed_at !== null) {
    throw new ConflictError(
      `La sesión ${sessionId} está en estado "${sesion.status}"${
        sesion.closed_at !== null ? ` y cerrada el ${sesion.closed_at}` : ''
      }: no admite partidas nuevas. Sus cifras son el resumen congelado al cerrar; ` +
        `para volver a clasificar hay que reabrirla.`
    );
  }

  const candidatosBanco = await client.query<FilaCandidataBanco>(
    // `bank_transactions` no tiene entidad: se acota por JOIN a
    // `bank_accounts`, como todo el módulo.
    //
    // «SIN COTEJO VIVO» SE PREGUNTA A LAS FILAS DE COTEJO, NO A `is_matched`.
    // La bandera es una caché que `match-service` mantiene; el hecho son las
    // filas de `reconciliation_matches` con `unapplied_at IS NULL`. Preguntar
    // por la caché haría que una bandera desincronizada escondiera un
    // movimiento del extracto —y un movimiento escondido es justo lo que la
    // conciliación existe para no dejar pasar—.
    `SELECT bt.id,
            bt.amount::text                         AS importe,
            to_char(bt.transaction_date,'YYYY-MM-DD') AS fecha,
            bt.description                          AS descripcion
       FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE ba.entity_id = $1
        AND ba.id = $2
        AND bt.transaction_date <= $3::date
        AND NOT EXISTS (SELECT 1 FROM reconciliation_matches rm
                         WHERE rm.bank_transaction_id = bt.id
                           AND rm.unapplied_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM reconciling_items ri
                         WHERE ri.bank_transaction_id = bt.id
                           AND ri.reconciliation_session_id = $4
                           AND ri.entity_id = $1)
      ORDER BY bt.transaction_date ASC, bt.id ASC
      LIMIT $5`,
    [entityId, sesion.bank_account_id, sesion.end_date, sessionId, limite + 1]
  );

  const candidatosLibros = await client.query<FilaCandidataLibros>(
    // LA ENTIDAD ACOTA LOS DOS EXTREMOS DEL JOIN, no uno, por lo mismo que en
    // `book-items.ts`: el vínculo entre la cuenta bancaria y el asiento es
    // `gl_account_id`, y una cuenta de mayor mal capturada —apuntando al plan
    // de otra entidad del mismo despacho— convertiría esto en una ventana a
    // los libros ajenos.
    `SELECT jel.id                                    AS line_id,
            (COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0))::text AS importe,
            to_char(je.entry_date,'YYYY-MM-DD')       AS fecha,
            COALESCE(NULLIF(jel.description,''), je.description) AS descripcion
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN bank_accounts ba   ON ba.gl_account_id = jel.account_id
      WHERE je.entity_id = $1
        AND ba.entity_id = $1
        AND ba.id = $2
        AND je.status = 'posted'
        AND jel.is_reconciled = false
        AND je.entry_date <= $3::date
        AND NOT EXISTS (SELECT 1 FROM reconciling_items ri
                         WHERE ri.journal_entry_line_id = jel.id
                           AND ri.reconciliation_session_id = $4
                           AND ri.entity_id = $1)
      ORDER BY je.entry_date ASC, jel.id ASC
      LIMIT $5`,
    [entityId, sesion.bank_account_id, sesion.end_date, sessionId, limite + 1]
  );

  const topeAlcanzado =
    candidatosBanco.rows.length > limite || candidatosLibros.rows.length > limite;

  const crudos: Array<{ origen: OrigenDePartida; origenId: string; importe: string; fecha: string; nota: string | null }> = [
    ...candidatosBanco.rows.slice(0, limite).map((f) => ({
      origen: 'extracto' as const,
      origenId: f.id,
      importe: f.importe,
      fecha: f.fecha,
      nota: f.descripcion,
    })),
    ...candidatosLibros.rows.slice(0, limite).map((f) => ({
      origen: 'libros' as const,
      origenId: f.line_id,
      importe: f.importe,
      fecha: f.fecha,
      nota: f.descripcion,
    })),
  ];

  // ── LAS QUE YA DEJARON DE EXPLICAR NADA ────────────────────────────
  //
  // `resuelta_at` se LEÍA en ocho sitios —la idempotencia de aquí, el filtro
  // del listado, la exclusión de la aritmética— y no lo escribía nadie. Una
  // columna leída y nunca escrita es peor que una sin usar: significa que esos
  // ocho lectores tienen una rama que jamás se ejecuta, y una rama que nunca
  // corre es una rama que nadie ha probado nunca de verdad.
  //
  // El escritor natural es éste, y no una persona. Un cheque en circulación se
  // resuelve solo el día que el banco lo enseña y el cotejo lo empareja; pedir
  // que alguien lo cierre a mano sería pedirle que confirme lo que el extracto
  // ya dijo. Se resuelve por el ORIGEN cotejado, nunca por el importe: dos
  // partidas del mismo importe no son la misma partida.
  const resueltasQ = await client.query<{ n: string }>(
    `UPDATE reconciling_items ri
        SET resuelta_at = NOW()
      WHERE ri.reconciliation_session_id = $1
        AND ri.entity_id = $2
        AND ri.resuelta_at IS NULL
        AND (
          EXISTS (
            SELECT 1 FROM reconciliation_matches rm
             WHERE rm.bank_transaction_id = ri.bank_transaction_id
               AND rm.unapplied_at IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM journal_entry_lines jel
             WHERE jel.id = ri.journal_entry_line_id
               AND jel.is_reconciled = true
          )
        )
      RETURNING 1`,
    [sessionId, entityId]
  );
  const resueltas = resueltasQ.rowCount ?? 0;

  const levantadas: PartidaLevantada[] = [];
  const omitidas: ResultadoDeClasificacion['omitidas'] = [];

  for (const c of crudos) {
    const propuesta = proponerPartida(c.origen, c.importe);
    if (propuesta === null) {
      omitidas.push({ origen: c.origen, origenId: c.origenId, importe: c.importe, motivo: 'importe-cero' });
      continue;
    }

    const id = uuidv4();
    await client.query(
      // El XOR de la 053: exactamente una de las dos referencias, nunca las
      // dos. Se pasan las dos columnas con un null explícito en vez de armar
      // el INSERT según el origen, para que el CHECK de la base sea quien
      // tenga la última palabra sobre la exclusividad y no una rama de aquí.
      //
      // `fecha_esperada` y `responsable` se quedan vacíos A PROPÓSITO: nadie
      // en el extracto ni en el mayor sabe cuándo se espera que un cheque se
      // cobre ni quién lo persigue. Inventarlos —«a treinta días»— sería
      // fabricar la fecha contra la que después se mide el escalamiento.
      `INSERT INTO reconciling_items
         (id, entity_id, reconciliation_session_id, tipo,
          bank_transaction_id, journal_entry_line_id,
          importe, fecha, notas, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::date,$9,$10)`,
      [
        id,
        entityId,
        sessionId,
        propuesta.tipo,
        c.origen === 'extracto' ? c.origenId : null,
        c.origen === 'libros' ? c.origenId : null,
        propuesta.importe,
        c.fecha,
        c.nota,
        userId,
      ]
    );

    levantadas.push({
      id,
      tipo: propuesta.tipo,
      lado: propuesta.lado,
      importe: propuesta.importe,
      fecha: c.fecha,
      origen: c.origen,
      origenId: c.origenId,
    });
  }

  return {
    levantadas,
    omitidas,
    sinFechaEsperada: levantadas.length,
    resueltas,
    topeAlcanzado,
  };
}

// ============================================================
// CORREGIR Y PERSEGUIR
// ============================================================

/**
 * LA SESIÓN, BAJO EL MISMO CANDADO QUE TOMA `clasificarPartidas`, Y EN CURSO.
 *
 * Las dos exigencias son una sola cosa vista desde dos sitios, y las dos se
 * pagaron:
 *
 *   · EL CANDADO. `cerrarSesion` lee las partidas y DESPUÉS escribe el estado,
 *     y lo que hace segura esa distancia es que nadie pueda mover una partida
 *     mientras sostiene la fila de la sesión `FOR UPDATE`. `clasificarPartidas`
 *     toma ese candado; estos dos escritores NO lo tomaban, y un
 *     `UPDATE ... FROM reconciliation_sessions s` no bloquea las filas del
 *     FROM —Postgres sólo asegura las de la tabla que actualiza—, así que
 *     reclasificar mientras `close` estaba a media firma no esperaba a nadie.
 *     Comprobado: con la sesión tomada `FOR UPDATE` desde otra conexión, la
 *     reclasificación entraba de inmediato. La aritmética que `close` acababa
 *     de leer quedaba obsoleta entre la lectura y el UPDATE, y la fila salía
 *     `balanced` afirmando una variación que ya no era la suya.
 *
 *   · EL ESTADO. Una sesión cerrada congeló su resumen. `clasificarPartidas` y
 *     `crearAjuste` ya lo exigían y `reclasificarPartida` también; sólo
 *     `asignarPartida` no, y por ahí se podía mover la fecha esperada —y con
 *     ella el escalamiento— de una partida cuya sesión ya estaba firmada. El
 *     desglose vivo se separaba de lo afirmado sin que nadie hubiera reabierto
 *     nada, que es el defecto que este módulo lleva pagando desde F05a.
 */
async function sesionEnCursoBajoCandado(
  client: pg.PoolClient,
  entityId: string,
  sessionId: string
): Promise<void> {
  const r = await client.query<{ status: string; closed_at: string | null }>(
    `SELECT status, to_char(closed_at, 'YYYY-MM-DD') AS closed_at
       FROM reconciliation_sessions
      WHERE id = $1 AND entity_id = $2
      FOR UPDATE`,
    [sessionId, entityId]
  );
  if (r.rows.length === 0) throw new NotFoundError('Reconciliation Session', sessionId);
  const s = r.rows[0];
  if (s.status !== 'in_progress' || s.closed_at !== null) {
    throw new ConflictError(
      `La sesión ${sessionId} está en estado "${s.status}"${
        s.closed_at !== null ? ` y cerrada el ${s.closed_at}` : ''
      }: sus partidas ya no se tocan. Sus cifras son el resumen congelado al ` +
        `cerrar, y mover una partida después las contradiría sin que nadie haya reabierto nada.`
    );
  }
}

export interface Reclasificacion {
  tipo: string;
  /**
   * La aportación nueva. Obligatoria cuando el tipo CAMBIA DE LADO: ver abajo.
   */
  importe?: string;
}

/**
 * Reclasifica una partida propuesta.
 *
 * `clasificarPartidas` sólo sabe leer un signo, y con un signo no se distingue
 * una comisión de un error del banco. Esta es la puerta por la que una persona
 * dice qué era de verdad.
 *
 * EL IMPORTE SE EXIGE CUANDO EL TIPO CAMBIA DE LADO, y es la parte sutil.
 * Dentro de un mismo lado la aportación no cambia: un `cargo-del-banco` que
 * resulta ser un `error-de-libros` sigue restando lo mismo al saldo de libros.
 * Pero moverla al otro lado sí cambia lo que la partida afirma —un cheque en
 * circulación corrige el saldo del BANCO por lo que los libros ya registraron;
 * el mismo importe visto como error de libros corrige el otro lado, y no tiene
 * por qué corregirlo ni por la misma cantidad ni en la misma dirección—. Nada
 * en el dato permite deducir la aportación nueva, así que se pide en vez de
 * conservar un número que dejó de significar lo que decía. Un signo heredado en
 * silencio a través de un cambio de lado descuadra sin dejar rastro.
 *
 * NO SE ATRIBUYE, Y NO ES UN OLVIDO: la 053 le da a `reconciling_items` un
 * `created_by` y ningún `updated_by`, así que el esquema no tiene dónde guardar
 * quién reclasificó. Se rehúsa recibir un `userId` que no iría a ninguna parte
 * —un parámetro que se ignora es peor que no tenerlo, porque el llamador cree
 * que dejó rastro—. Mientras tanto el porqué cabe en `notas`, con
 * `asignarPartida`.
 */
export async function reclasificarPartida(
  entityId: string,
  sessionId: string,
  partidaId: string,
  cambio: Reclasificacion
): Promise<PartidaConciliatoria> {
  const nuevo = exigirTipoDePartida(cambio.tipo);

  return withTransaction(async (client) => {
    await sesionEnCursoBajoCandado(client, entityId, sessionId);

    const actual = await listarPartidasCon(client, entityId, sessionId, { incluirResueltas: true });
    const partida = actual.find((p) => p.id === partidaId);
    if (!partida) throw new NotFoundError('Reconciling Item', partidaId);
    if (partida.resuelta) {
      throw new ConflictError(
        `La partida ${partidaId} ya está resuelta: dejó de explicar una diferencia y ` +
          `reclasificarla cambiaría una historia cerrada.`
      );
    }

    const cambiaDeLado = LADO_DE[nuevo] !== partida.lado;
    if (cambiaDeLado && cambio.importe === undefined) {
      throw new ValidationError(
        `Pasar la partida ${partidaId} de "${partida.tipo}" (lado ${partida.lado}) a "${nuevo}" ` +
          `(lado ${LADO_DE[nuevo]}) cambia a cuál de los dos saldos corrige, y su aportación de ` +
          `${partida.importe} dejaría de significar lo mismo. Indica el importe nuevo, FIRMADO por ` +
          `su aportación al lado de ${LADO_DE[nuevo]}.`
      );
    }

    let importe = partida.importe;
    if (cambio.importe !== undefined) {
      let d: Decimal;
      try {
        d = new Decimal(cambio.importe);
      } catch {
        throw new ValidationError(`Importe ilegible al reclasificar: "${cambio.importe}".`);
      }
      if (!d.isFinite() || d.isZero()) {
        throw new ValidationError(
          `El importe de una partida no puede ser cero ni ilegible; llegó "${cambio.importe}". ` +
            `Una partida que aporta cero no explica ninguna diferencia: resuélvela en vez de dejarla en cero.`
        );
      }
      importe = monto(d);
    }

    const r = await client.query(
      // La entidad y la sesión, otra vez las dos dentro del SQL: el id de la
      // partida solo no acota nada. `s.status` se repite aquí aunque el
      // candado de arriba ya lo comprobó: quien lea esta sentencia suelta
      // tiene que poder ver que no toca una sesión firmada.
      `UPDATE reconciling_items ri
          SET tipo = $1, importe = $2
         FROM reconciliation_sessions s
        WHERE ri.id = $3
          AND ri.entity_id = $4
          AND s.id = ri.reconciliation_session_id
          AND s.id = $5
          AND s.entity_id = $4
          AND ri.resuelta_at IS NULL
          AND s.status = 'in_progress'`,
      [nuevo, importe, partidaId, entityId, sessionId]
    );
    if (r.rowCount !== 1) {
      throw new ConflictError(
        `No se reclasificó la partida ${partidaId}: o su sesión ya no está en curso, o la partida ` +
          `se resolvió mientras tanto. Nada se cambió.`
      );
    }

    const despues = await listarPartidasCon(client, entityId, sessionId, { incluirResueltas: true });
    const resultado = despues.find((p) => p.id === partidaId);
    if (!resultado) throw new NotFoundError('Reconciling Item', partidaId);
    return resultado;
  });
}

export interface Seguimiento {
  responsable?: string | null;
  fechaEsperada?: string | null;
  escalamiento?: Escalamiento;
  notas?: string | null;
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Pone (o quita) responsable, fecha esperada y notas: lo que convierte una
 * partida en algo que se persigue y no sólo se cuenta.
 *
 * Sin esta puerta el escalamiento sería decorativo. `clasificarPartidas` levanta
 * las partidas SIN fecha esperada porque no hay de dónde sacarla, y
 * `derivarEscalamiento` sin fecha esperada no puede decidir nada: todas dirían
 * 'ninguno' para siempre. La fecha la pone quien sabe cuándo espera que el
 * cheque se cobre, que es una persona.
 *
 * `escalamiento` sólo admite 'ninguno' y 'avisado' —el hecho humano—. 'vencido'
 * no se escribe a mano: lo dice el calendario en `derivarEscalamiento`, y
 * dejarlo escribir aquí crearía un segundo origen de verdad que envejecería
 * contradiciendo al primero.
 */
export async function asignarPartida(
  entityId: string,
  sessionId: string,
  partidaId: string,
  seguimiento: Seguimiento
): Promise<PartidaConciliatoria> {
  const campos: string[] = [];
  const params: unknown[] = [];

  if (seguimiento.responsable !== undefined) {
    params.push(seguimiento.responsable);
    campos.push(`responsable = $${params.length}`);
  }
  if (seguimiento.fechaEsperada !== undefined) {
    if (seguimiento.fechaEsperada !== null && !FECHA_RE.test(seguimiento.fechaEsperada)) {
      throw new ValidationError(
        `\`fechaEsperada\` tiene que venir como YYYY-MM-DD; llegó "${seguimiento.fechaEsperada}".`
      );
    }
    params.push(seguimiento.fechaEsperada);
    campos.push(`fecha_esperada = $${params.length}::date`);
  }
  if (seguimiento.escalamiento !== undefined) {
    if (seguimiento.escalamiento === 'vencido') {
      throw new ValidationError(
        `"vencido" no se marca a mano: lo decide la fecha esperada contra el día de hoy. ` +
          `Si la partida ya venció, ajusta su \`fechaEsperada\`; si sólo se persiguió, márcala "avisado".`
      );
    }
    if (!(ESCALAMIENTOS as readonly string[]).includes(seguimiento.escalamiento)) {
      throw new ValidationError(
        `Escalamiento desconocido "${String(seguimiento.escalamiento)}". Admitidos aquí: ninguno, avisado.`
      );
    }
    params.push(seguimiento.escalamiento);
    campos.push(`escalamiento = $${params.length}`);
  }
  if (seguimiento.notas !== undefined) {
    params.push(seguimiento.notas);
    campos.push(`notas = $${params.length}`);
  }

  if (campos.length === 0) {
    throw new ValidationError(
      'No se indicó nada que asignar: responsable, fechaEsperada, escalamiento o notas.'
    );
  }

  params.push(partidaId, entityId, sessionId);
  return withTransaction(async (client) => {
    // EL MISMO CANDADO Y LA MISMA EXIGENCIA DE ESTADO QUE LOS DEMÁS
    // ESCRITORES. Esta hoja es la que pone `fecha_esperada`, y la fecha
    // esperada es una de las dos cosas que `close` verifica antes de firmar:
    // moverla sin el candado la deja cambiar entre la lectura de `close` y su
    // UPDATE, y moverla sobre una sesión ya cerrada separa el desglose vivo de
    // lo que se afirmó.
    await sesionEnCursoBajoCandado(client, entityId, sessionId);

    const r = await client.query(
      `UPDATE reconciling_items ri
          SET ${campos.join(', ')}
         FROM reconciliation_sessions s
        WHERE ri.id = $${params.length - 2}
          AND ri.entity_id = $${params.length - 1}
          AND s.id = ri.reconciliation_session_id
          AND s.id = $${params.length}
          AND s.entity_id = $${params.length - 1}
          AND ri.resuelta_at IS NULL
          AND s.status = 'in_progress'`,
      params
    );
    if (r.rowCount !== 1) {
      throw new NotFoundError('Reconciling Item', partidaId);
    }

    const despues = await listarPartidasCon(client, entityId, sessionId);
    const resultado = despues.find((p) => p.id === partidaId);
    if (!resultado) throw new NotFoundError('Reconciling Item', partidaId);
    return resultado;
  });
}
