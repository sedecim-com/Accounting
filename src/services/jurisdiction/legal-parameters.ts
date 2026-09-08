import type pg from 'pg';
import { query } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';
import type { JurisdictionCode } from './jurisdiction.js';

// ============================================================
// LA LEY SE LEE EN LA FECHA DEL HECHO (J0.2)
//
// Lector de `legal_parameters`, la tabla que la 075 creó. El diseño vive en
// docs/jurisdicciones.md §3.4 y el porqué del modelo, entero, en la cabecera
// de la migración; aquí sólo lo que hay que tener presente para leer el
// código:
//
//   · NO HAY `effective_to`. El valor vigente en una fecha es LA FILA CON EL
//     MAYOR `effective_from <= esa fecha`. Por eso la consulta es un ORDER BY
//     descendente con LIMIT 1 y no un BETWEEN: el solape no está prohibido,
//     es irrepresentable, y entre dos vigencias no puede abrirse un hueco.
//   · `value IS NULL` significa DEROGADO. No es «no hay dato»: es «la ley
//     terminó y no hay sustituta», que es un hecho distinto y se distingue.
//
// ── POR QUÉ LA FECHA DEL HECHO Y NO `hoy` ──────────────────────────────
//
// Es toda la diferencia entre este módulo y las constantes que viene a
// sustituir. Un recálculo de mayo que se corre en septiembre tiene que leer
// la ley de MAYO: si lee la de hoy, reexpide con una UMA que no existía
// cuando el hecho ocurrió, y el resultado no cuadra con el CFDI que ya se
// timbró. Por eso `onDate` es obligatoria y no tiene valor por omisión —un
// `= hoy` de cortesía sería justo el defecto, escrito como comodidad.
//
// ── FALLA CERRADO, Y ES EL PUNTO DEL TRAMO ─────────────────────────────
//
// Sin fila vigente —o con una fila que no guarda una cifra— esto LANZA. No
// devuelve cero, ni un valor quemado, ni un
// `{}`. El informe normativo (docs/investigacion/2026-09-06-normas-y-motores/
// normas/fiscal-mx.md §«lo que falta») documenta el defecto contrario ya en
// producción: sin fila del año, `getTaxParameters` devuelve `{}` y el IMSS
// deja sus tasas en cero (`imss-calculator.ts`, `|| 0`) mientras el INFONAVIT
// aplica un 5 % quemado sobre una UMA quemada de 113.14. Nadie ve un error:
// se ve una nómina que cuadra con cifras inventadas. Sólo el ISR lanza, y por
// eso el ISR es el único de los tres en el que se puede confiar.
//
// El código de error propio —`PARAMETRO_LEGAL_SIN_VIGENCIA` de §3.4— lo pone
// J0.4 junto con la comprobación de `doctor`; aquí el fallo ya es cerrado y el
// mensaje ya nombra las tres cosas que hacen falta para arreglarlo: qué clave,
// qué jurisdicción y qué fecha.
//
// ── SIN INQUILINO, A PROPÓSITO ─────────────────────────────────────────
//
// Ninguna consulta de este módulo lleva `tenant_id` ni `entity_id`, y no es
// un descuido: `legal_parameters` no tiene esas columnas. La UMA vale lo
// mismo para todo despacho mexicano, igual que `exchange_rates`,
// `tax_parameters` o `sat_codigos_agrupadores` (F07a, misma excepción y por
// la misma razón). La frontera de inquilino sigue yendo DENTRO del SQL en
// todo lo demás; la excepción la sostiene la migración —que deja la tabla
// fuera de RLS con su COMMENT— y no el criterio de quien escribe la consulta.
// ============================================================

/** Una fila de `legal_parameters`, tal como se lee. */
export interface LegalParameter {
  jurisdiction: string;
  key: string;
  /**
   * EL VALOR, COMO CADENA. El dinero y las tasas de este sistema son cadena +
   * decimal.js a 4 decimales: convertirlo a `number` aquí perdería la
   * disciplina justo en la frontera donde entra el número de la ley.
   *
   * `null` = DEROGADO. Quien lo reciba tiene que decidir qué hace; lo que no
   * puede es confundirlo con cero.
   */
  value: string | null;
  /** En qué está expresado el valor ('rate', 'MXN'…). Sin esto, `value` es un
   *  número sin significado: 16 podría ser por ciento o pesos. */
  unit: string;
  /** Desde cuándo rige esta fila, 'YYYY-MM-DD'. Rige hasta que otra con fecha
   *  posterior la sustituya; que no haya `effective_to` es el modelo. */
  effectiveFrom: string;
  /** La fuente oficial. Es NOT NULL en la tabla, así que aquí tampoco es
   *  opcional: quien use la cifra tiene que poder decir de dónde salió sin
   *  volver a consultar. */
  sourceUrl: string;
  sourceNote: string | null;
}

/** Lo mismo, con la garantía de que hay valor: lo que devuelve el lector que
 *  falla cerrado. */
export type LegalParameterInForce = LegalParameter & { value: string };

/**
 * POR QUÉ NO HAY VALOR, que son cuatro hechos distintos y no uno.
 *
 * Colapsarlos en «no se pudo» sería repetir en el mensaje el error que el
 * módulo evita en la cifra: quien lee «falta la UMA de MX al 2026-01-15»
 * necesita saber si nadie la cargó nunca (hay que sembrarla), si la cargada
 * empieza más tarde (la ley no regía todavía ese día, y es la respuesta
 * correcta), si está derogada (la ley terminó y no hay sustituta), o si la
 * fila existe pero guarda algo que no es un número (alguien la dejó a medio
 * llenar). Las cuatro llevan a acciones opuestas.
 */
export type LegalParameterGap =
  /** Ninguna fila para esa jurisdicción y esa clave. Nadie la cargó. */
  | 'never_loaded'
  /** Hay filas, pero todas entran en vigor DESPUÉS de la fecha preguntada. */
  | 'not_yet_in_force'
  /** La fila vigente tiene `value` nulo: la ley terminó sin sustituta. */
  | 'repealed'
  /**
   * Hay fila y hay valor, pero el valor NO ES UNA CIFRA: cadena vacía, sólo
   * espacios, o texto.
   *
   * Es el cuarto hueco y se descubrió atacando al tercero. `value` es TEXT sin
   * CHECK en la 075 —la unicidad y la fuente sí están en el esquema, la forma
   * del número no—, así que una fila a medio llenar entra sin protestar. Y una
   * cadena vacía NO se comporta como «no hay dato» río abajo: `Number('')` y
   * `Number('   ')` valen CERO, que es exactamente la cifra inventada que
   * cuadra y que este módulo existe para no producir. (`'no aplica'` da NaN,
   * que al menos se ve, pero se cierra por el mismo sitio.)
   */
  | 'malformed';

/**
 * El fallo cerrado, con los datos dentro y no sólo en el texto.
 *
 * Extiende `Error` y no `AppError` a propósito: darle hoy un `statusCode` y un
 * `code` sería inventar la mitad de J0.4 —que es quien publica
 * `PARAMETRO_LEGAL_SIN_VIGENCIA` y la comprobación de `doctor`— y dejar dos
 * códigos compitiendo. Los campos sí van ya: un `catch` que quiera distinguir
 * «derogada» de «no cargada» no debería tener que leer el mensaje con un
 * regex.
 */
export class LegalParameterUnavailableError extends Error {
  constructor(
    readonly jurisdiction: string,
    readonly key: string,
    readonly onDate: string,
    readonly gap: LegalParameterGap,
    message: string
  ) {
    super(message);
    this.name = 'LegalParameterUnavailableError';
  }
}

/** Lo único que `$n::date` acepta sin que Postgres adivine. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * QUÉ FORMA TIENE UNA CIFRA DE LA LEY.
 *
 * Un parámetro legal es un número —una tasa o un importe— y su `unit` dice de
 * cuál de los dos se trata. Que `value` sea TEXT es la disciplina de la casa
 * (cadena + decimal.js a 4 decimales, nunca float), no un permiso para guardar
 * ahí una frase.
 *
 * El cero SÍ pasa, y tiene que pasar: la tasa del art. 2-A de la LIVA es 0 % de
 * verdad. Lo que no pasa es lo que PARECE cero sin serlo.
 */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/**
 * La proyección, con las fechas ya en 'YYYY-MM-DD'.
 *
 * `to_char` y no el `Date` del driver: `DATE` no lleva zona, pero `node-pg` lo
 * entrega como `Date` a medianoche LOCAL, y en cualquier huso al oeste de UTC
 * ese `toISOString().slice(0,10)` devuelve el día ANTERIOR. Una vigencia
 * corrida un día es una ley que empieza cuando no empezó.
 */
const SELECT_COLUMNS = `jurisdiction, key, value, unit,
          to_char(effective_from, 'YYYY-MM-DD') AS "effectiveFrom",
          source_url AS "sourceUrl", source_note AS "sourceNote"`;

/**
 * La fila vigente en la fecha del hecho, o `null` si no hay ninguna.
 *
 * NO juzga: devuelve la fila derogada (`value` nulo) igual que cualquier otra,
 * porque «la ley terminó» es una respuesta y quien la pide tiene derecho a
 * verla. Quien necesite una cifra usa `legalParameterAt`, que falla cerrado.
 *
 * @param onDate la fecha DEL HECHO en 'YYYY-MM-DD' (fecha del comprobante, de
 *               pago, del devengo). Nunca «hoy» por omisión: ver la cabecera.
 * @param client para leer DENTRO de la transacción del llamador. Sin él,
 *               `query` toma una segunda conexión del pool — el mismo motivo
 *               por el que `getPolicy` lo recibe (policy-service.ts).
 */
export async function findLegalParameterAt(
  jurisdiction: JurisdictionCode,
  key: string,
  onDate: string,
  client?: pg.PoolClient
): Promise<LegalParameter | null> {
  assertDate(onDate);
  const run = executor(client);

  // EL MODELO ENTERO ESTÁ EN ESTAS CUATRO LÍNEAS: la mayor fecha de entrada
  // que no sea posterior al hecho. Sin `effective_to` que mantener en dos
  // sitios, sin BETWEEN que pueda dejar un día sin cubrir, y sin que dos filas
  // puedan contestar a la vez.
  //
  // La clave se compara TAL CUAL —ni `lower`, ni `btrim`—: un `vat.Standard_Rate`
  // que se resolviera solo escondería una errata hasta que alguien sembrara la
  // clave de verdad y hubiera dos. Aquí una errata falla cerrado, que es lo
  // que tiene que hacer.
  const r = await run<LegalParameter>(
    `SELECT ${SELECT_COLUMNS}
       FROM legal_parameters
      WHERE jurisdiction = $1 AND key = $2 AND effective_from <= $3::date
      ORDER BY effective_from DESC
      LIMIT 1`,
    [jurisdiction, key, onDate]
  );
  return r.rows[0] ?? null;
}

/**
 * El valor vigente en la fecha del hecho. SIN FILA VIGENTE, LANZA.
 *
 * Es el lector que usan los motores: devuelve la cifra con su fecha de
 * entrada, su unidad y su fuente, de modo que quien la imprima pueda decir de
 * dónde salió sin volver a consultar.
 *
 * @throws {LegalParameterUnavailableError} si nadie cargó la clave, si la
 *   cargada aún no regía ese día, si está derogada, o si la fila guarda algo
 *   que no es una cifra. Las cuatro se distinguen por `gap` sin leer el
 *   mensaje.
 */
export async function legalParameterAt(
  jurisdiction: JurisdictionCode,
  key: string,
  onDate: string,
  client?: pg.PoolClient
): Promise<LegalParameterInForce> {
  const row = await findLegalParameterAt(jurisdiction, key, onDate, client);

  if (row === null) {
    // La segunda consulta corre SÓLO cuando ya se falló, y compra el único
    // dato que separa «nadie la cargó» de «todavía no regía»: si existe
    // alguna fila de esa clave, y desde cuándo. Un mensaje que no lo diga
    // manda a sembrar una clave que ya está sembrada.
    const first = await earliestEffectiveFrom(jurisdiction, key, client);
    if (first === null) {
      throw new LegalParameterUnavailableError(
        jurisdiction,
        key,
        onDate,
        'never_loaded',
        `No hay ningún parámetro legal "${key}" cargado para ${jurisdiction}: la consulta era por ` +
          `la fecha ${onDate}. No se supone un valor por omisión — una tasa inventada cuadra igual ` +
          `que la de la ley y nadie lo nota. Siémbrala con su fecha de entrada y su fuente oficial.`
      );
    }
    throw new LegalParameterUnavailableError(
      jurisdiction,
      key,
      onDate,
      'not_yet_in_force',
      `El parámetro legal "${key}" de ${jurisdiction} no regía el ${onDate}: la vigencia más ` +
        `antigua que hay empieza el ${first}. O el hecho es anterior a lo que se cargó —y falta ` +
        `sembrar la ley que sí regía ese día—, o la fecha del hecho está mal.`
    );
  }

  if (row.value === null) {
    throw new LegalParameterUnavailableError(
      jurisdiction,
      key,
      onDate,
      'repealed',
      `El parámetro legal "${key}" de ${jurisdiction} está DEROGADO desde el ${row.effectiveFrom} ` +
        `y la consulta era por el ${onDate}: la ley terminó sin sustituta (${row.sourceUrl}). ` +
        `Derogado no es cero: quien haga el cálculo tiene que decidir qué pone en su lugar.`
    );
  }

  // Y LA ÚLTIMA PUERTA, QUE ES LA MÁS BARATA DE OLVIDAR.
  //
  // Hasta aquí el módulo sólo había mirado si HABÍA valor. Un valor en blanco
  // —'' o espacios— pasa las dos comprobaciones anteriores y sale por la
  // rendija que este tramo entero venía a tapar: `Number('')` es CERO, y un
  // cero de IVA o de UMA no rompe ningún cálculo, sólo lo deja mal. La 075 no
  // puede impedirlo (`value` es TEXT sin CHECK, y no se toca), así que lo
  // impide el lector, que es quien tiene el contrato de devolver una cifra.
  if (!DECIMAL_RE.test(row.value)) {
    throw new LegalParameterUnavailableError(
      jurisdiction,
      key,
      onDate,
      'malformed',
      `El parámetro legal "${key}" de ${jurisdiction} vigente desde el ${row.effectiveFrom} no ` +
        `guarda una cifra sino ${JSON.stringify(row.value)} (${row.sourceUrl}). No se convierte ni ` +
        `se aproxima: una cadena vacía vale CERO en cuanto alguien la pasa por Number(), y un cero ` +
        `de tasa o de importe cuadra igual que el bueno. Corrige la fila con su fuente.`
    );
  }

  return row as LegalParameterInForce;
}

/** La fecha de entrada más antigua que hay de esa clave, o null si no hay
 *  ninguna fila. Sólo alimenta el mensaje del fallo. */
async function earliestEffectiveFrom(
  jurisdiction: JurisdictionCode,
  key: string,
  client?: pg.PoolClient
): Promise<string | null> {
  const r = await executor(client)<{ effectiveFrom: string }>(
    `SELECT to_char(MIN(effective_from), 'YYYY-MM-DD') AS "effectiveFrom"
       FROM legal_parameters
      WHERE jurisdiction = $1 AND key = $2`,
    [jurisdiction, key]
  );
  // MIN sobre cero filas devuelve UNA fila con NULL, no cero filas: sin este
  // `?? null` el "no hay ninguna" se leería como la cadena 'null'.
  return r.rows[0]?.effectiveFrom ?? null;
}

/** El mismo conmutador `client ?? pool` que usa `getPolicy`, en un sitio. */
function executor(client?: pg.PoolClient) {
  return client
    ? <T extends pg.QueryResultRow>(sql: string, params: unknown[]) => client.query<T>(sql, params)
    : query;
}

/**
 * La fecha se valida ANTES de llegar al `::date`.
 *
 * Sin esto, un 'hoy' o un ISO con hora acaba en un error de sintaxis de
 * Postgres que no nombra ni la clave ni el parámetro que venía mal. Un
 * '2026-02-30' sí pasa el regex y lo rechaza Postgres: son formas distintas de
 * fallar cerrado y ninguna inventa una fecha.
 */
function assertDate(onDate: string): void {
  if (!DATE_RE.test(onDate)) {
    throw new ValidationError(
      `"${onDate}" no es una fecha YYYY-MM-DD. La ley se lee en la fecha DEL HECHO ` +
        '(la del comprobante, la del pago, la del devengo), no en la de hoy.',
      'onDate'
    );
  }
}
