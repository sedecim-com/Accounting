import crypto from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import { getPolicy } from '../policy/policy-service.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { decrypt } from '../../utils/encryption.js';
import { STATEMENT_SOURCE_FORMATS } from '../../database/enums.js';
import type { ExtractoLeido } from './parsers/tipos.js';
import { classifyBankLine } from './transaction-classifier.js';
import {
  huellaDeCuenta,
  runStatementChecks,
  resolverChecks,
  type ContextoVerificacion,
  type CuentaVerificable,
  type HallazgoEstado,
  type LineaVerificable,
  type StatementCheckName,
  type VecinoEstado,
} from './statement-checks.js';

// ============================================================
// F05a · EL ESTADO DE CUENTA COMO DOCUMENTO
//
// Cuatro verbos del catálogo —import, list, show, check— sobre la tabla que la
// migración 051 acaba de crear. Lo que este servicio orquesta y lo que
// deliberadamente NO hace:
//
// NO CONTABILIZA NADA. El catálogo lo dice de la fila de `import` en negritas:
// deja el extracto en staging bancario y no toca el mayor. Un movimiento de
// banco no es un asiento —es la afirmación de un tercero sobre nuestro dinero—
// y volverlo asiento es el trabajo del cotejo y de la conciliación, que tienen
// sus propios verbos y su propia aprobación humana.
//
// EL HASH DEL ARCHIVO SE CALCULA SOBRE LOS BYTES ORIGINALES, antes de parsear.
// Es lo que hace que el dedupe de documento funcione aunque el perfil cambie:
// si se hasheara lo parseado, releer el mismo PDF con otro perfil daría un
// documento «nuevo» y el extracto entraría dos veces. Y es evidencia fiscal:
// quien audite tiene que poder demostrar que el archivo del banco y lo que
// entró al sistema son el mismo documento.
//
// EL DEDUPE ES DE DOS NIVELES, NINGUNO ES DE APLICACIÓN, Y YA SÓLO UNO
// DEDUPLICA DE VERDAD.
//   · Documento: UNIQUE(bank_account_id, file_sha256) sobre `bank_statements`.
//     El mismo archivo no entra dos veces, y el rechazo dice CUÁNDO entró la
//     primera vez. Éste es el dedupe real.
//   · Línea: UNIQUE(bank_account_id, bank_transaction_id) —el id nativo del
//     banco, 001_core_schema.sql— y nada más. `uq_bank_tx_contenido` YA NO
//     cuenta: la 072 lo suelta y pone `idx_bank_tx_contenido`, NO único,
//     porque la huella de contenido es una HUELLA y no una llave —dos
//     comisiones legítimamente idénticas el mismo día la comparten y las dos
//     son ciertas—. `insertarLineas` names that one conflict target and no
//     other (T25, #138), and every line it skips is named with its cause by
//     `nameSkippedLines`: the importer no longer reports a subtraction as the
//     bank's duplicates.
//   · Overlap: a quarterly that contains the monthly has different bytes and
//     lines without native ids, so neither guard above sees it. The
//     fingerprint, counted by multiplicity against the OTHER statements of
//     the account (`probeOverlaps`), finds the repeated lines, and the panel
//     key `bank_statement_overlap` decides: block, mark or warn. It is not
//     configurable that two identical lines of the SAME file both enter.
//   NUNCA se escribe `content_hash`: no es un campo de entrada, es una función
//   de la fila que calcula el disparador, y mandarlo devolvería al llamador la
//   capacidad de forjar la huella que la 051 le quitó.
//
// QUÉ RECHAZA EL IMPORT Y QUÉ SÓLO REPORTA. Las siete pruebas corren sobre el
// documento RECIÉN PARSEADO, antes de escribir. De sus hallazgos sólo dos
// abortan: `identidad` y `moneda`, porque significan «este archivo no es de
// esta cuenta» y guardarlo sería mezclar los movimientos de dos cuentas en
// una. El resto —cadena de saldos, continuidad, huecos, secuencia, reversos—
// se devuelve y no bloquea: el catálogo dice que import deja en STAGING, y es
// `check` quien sale 4. Un extracto que no cuadra es justamente el que hay que
// poder mirar.
//
// LA FRONTERA DE ENTIDAD VA DENTRO DEL SQL, siempre. `bank_transactions` no
// tiene entity_id: cuelga de `bank_account_id` → `bank_accounts.entity_id`, así
// que se acota por JOIN y nunca filtrando en JS después. Por esa fuga exacta
// entraron movimientos en el extracto de otra entidad hasta hace dos semanas
// (tests/integration/banco-frontera.int.spec.ts).
// ============================================================

/**
 * Lo que admite el CHECK de `bank_statements.source_format` (051), tomado del
 * censo de vocabularios y no copiado: la prueba de contrato vigila esa lista
 * contra el esquema, y una copia local se separaría de ella en silencio.
 */
const FORMATOS_VALIDOS = STATEMENT_SOURCE_FORMATS;

/** Lo que admite el CHECK de `bank_transactions.transaction_type` (003). */
const TIPOS_MOVIMIENTO = ['debit', 'credit', 'fee', 'interest', 'adjustment'] as const;

/** Filas por sentencia al insertar líneas. Un extracto de 3 000 líneas en 15 viajes. */
const LOTE_LINEAS = 200;

/** Tope de estados verificados en una corrida. `-a` sobre diez años no se lee. */
const MAX_ESTADOS = 200;

/**
 * Líneas que `check` carga por estado. Un extracto mensual no se acerca, pero
 * si alguna vez se rebasa, la cadena de saldos NO se corre sobre lo cargado:
 * sumar media población y compararla con el saldo final produciría un
 * descuadre inventado, que es peor que no verificar.
 */
const MAX_LINEAS_CHECK = 50_000;

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── El puerto del lector de formatos ────────────────────────────────────
//
// El parser vive en `./parsers/` y es una función pura de bytes a estructura.
// Entra por parámetro y no por importación directa para que el importador se
// pueda ejercitar entero —dedupe, transacción, ensayo, las siete pruebas—
// sobre un extracto de tres líneas escrito a mano, sin CSV de por medio.

export interface EntradaLectura {
  ruta: string;
  contenido: Buffer;
  formato?: string;
  perfil?: string;
}

export type LeerExtracto = (entrada: EntradaLectura) => Promise<ExtractoLeido> | ExtractoLeido;

export interface EntradaImportacion {
  entityId: string;
  userId: string;
  bankAccountId: string;
  /** Ruta del archivo tal como la escribió el operador: se guarda su basename. */
  ruta: string;
}

export interface OpcionesImportacion {
  /** `--format`: pista para el lector cuando el archivo no se autodescribe. */
  formato?: string;
  /** `--profile`: perfil de columnas para los formatos tabulares. */
  perfil?: string;
  /**
   * `--closing-balance`: el saldo final que el operador AFIRMA. Es la defensa
   * contra el archivo truncado, que es el fallo silencioso de este tramo: un
   * CSV cortado a la mitad parsea perfecto y da un extracto plausible.
   */
  saldoFinalEsperado?: string;
  /** Recorre TODO —incluido el rastro de auditoría— y revierte. */
  dryRun?: boolean;
  /** Ventana de la prueba de reversos, en días. */
  diasReverso?: number;
  leer: LeerExtracto;
}

export interface ResultadoImportacion {
  statementId: string;
  archivo: string;
  sha256: string;
  formato: string;
  perfil: string | null;
  cuenta: { id: string; nombre: string; moneda: string; tipo: string };
  numeroDeEstado: string | null;
  periodoInicio: string;
  periodoFin: string;
  saldoInicial: string;
  saldoFinal: string;
  moneda: string;
  /** Líneas que trae el documento. */
  lineasLeidas: number;
  /** Las que entraron. */
  importadas: number;
  /**
   * Las que no entraron porque su id nativo del banco ya está en la cuenta:
   * `skipped.length`, cada una nombrada ahí. Ya no es una resta (T25, #138).
   */
  duplicadas: number;
  /** Every line that did not enter, with its proven cause. */
  skipped: SkippedLine[];
  /** Lines already present in another statement of the account (`bank_statement_overlap`). */
  overlaps: OverlapLine[];
  /** What the panel said to do with them. */
  overlapPolicy: OverlapPolicy;
  /** Lo que el lector ignoró, adivinó o derivó, más lo que añade el importador. */
  avisos: string[];
  hallazgos: HallazgoEstado[];
  ensayo: boolean;
}

interface CuentaBancaria {
  id: string;
  account_name: string;
  currency_code: string;
  account_type: string;
  is_active: boolean;
  clabe_encrypted: string | null;
  clabe_last4: string | null;
  account_number_encrypted: string | null;
  account_number_last4: string | null;
  iban: string | null;
}

/**
 * El ensayo recorre el camino real y revierte, como los servicios de F03/F04.
 * Simular el import por otra rama sería probar un programa distinto del que
 * escribe: el dedupe, el disparador del hash y los CHECK de la tabla sólo
 * opinan cuando la sentencia se ejecuta de verdad.
 */
class EnsayoImportacion extends Error {
  constructor(public readonly resultado: ResultadoImportacion) {
    super('dry-run');
  }
}

// ── Lecturas acotadas por entidad ───────────────────────────────────────

async function cuentaDeLaEntidad(
  client: pg.PoolClient | null,
  entityId: string,
  bankAccountId: string
): Promise<CuentaBancaria> {
  const sql = `SELECT id, account_name, currency_code, account_type, is_active,
                      clabe_encrypted, clabe_last4,
                      account_number_encrypted, account_number_last4, iban
                 FROM bank_accounts
                WHERE id = $1 AND entity_id = $2`;
  const r = client
    ? await client.query<CuentaBancaria>(sql, [bankAccountId, entityId])
    : await query<CuentaBancaria>(sql, [bankAccountId, entityId]);
  // Cero filas significa a la vez «no existe» y «no es tuya», y el programa no
  // tiene ningún punto donde distinguirlas.
  if (r.rows.length === 0) throw new NotFoundError('Bank Account', bankAccountId);
  return r.rows[0];
}

function ambiguousBankAccount(needle: string): ValidationError {
  return new ValidationError(
    `"${needle}" nombra más de una cuenta bancaria. Usa el identificador que imprime 'bank account list'.`
  );
}

/**
 * Resuelve `--account` por id o por nombre. El nombre es lo que un operador
 * teclea; el uuid es lo que devuelve `list`. Ambos acotados por entidad DENTRO
 * del SQL, así que un uuid ajeno no resuelve.
 */
export async function resolverCuentaBancaria(
  entityId: string,
  aguja: string
): Promise<{ id: string; account_name: string }> {
  if (UUID_RE.test(aguja)) {
    const r = await query<{ id: string; account_name: string }>(
      'SELECT id, account_name FROM bank_accounts WHERE id = $1 AND entity_id = $2',
      [aguja, entityId]
    );
    if (r.rows.length === 0) throw new NotFoundError('Bank Account', aguja);
    return r.rows[0];
  }
  // The exact name wins before any substring: with 'BBVA' and 'BBVA USD' on the
  // same entity, `BBVA` names the first one and is not ambiguous (#327).
  const exact = await query<{ id: string; account_name: string }>(
    `SELECT id, account_name FROM bank_accounts
      WHERE entity_id = $1 AND lower(account_name) = lower($2)
      ORDER BY is_active DESC, account_name
      LIMIT 2`,
    [entityId, aguja]
  );
  if (exact.rows.length === 1) return exact.rows[0];
  if (exact.rows.length > 1) throw ambiguousBankAccount(aguja);
  // LIKE metacharacters in the needle are escaped: `--bank %` must not match
  // every account.
  const escapedNeedle = aguja.replace(/[\\%_]/g, '\\$&');
  const r = await query<{ id: string; account_name: string }>(
    `SELECT id, account_name FROM bank_accounts
      WHERE entity_id = $1 AND account_name ILIKE $2
      ORDER BY is_active DESC, account_name
      LIMIT 2`,
    [entityId, `%${escapedNeedle}%`]
  );
  if (r.rows.length === 0) throw new NotFoundError('Bank Account', aguja);
  if (r.rows.length > 1) throw ambiguousBankAccount(aguja);
  return r.rows[0];
}

/**
 * La cuenta, en la forma que la prueba de identidad puede comparar: últimos 4 y
 * HUELLA del identificador completo. Nunca el identificador — la CLABE se
 * guarda cifrada precisamente para que no viaje, y una comprobación no es
 * excusa para descifrarla hacia afuera.
 *
 * Si el descifrado falla (llave rotada, dato de otra época) la identidad no
 * revienta: degrada a los últimos 4 y la prueba lo dice en su hallazgo.
 */
function comoVerificable(c: CuentaBancaria): CuentaVerificable {
  let huella: string | null = null;
  const cifrado = c.clabe_encrypted ?? c.account_number_encrypted;
  if (cifrado) {
    try {
      huella = huellaDeCuenta(decrypt(cifrado));
    } catch {
      huella = null;
    }
  }
  if (!huella && c.iban) huella = huellaDeCuenta(c.iban);
  return {
    id: c.id,
    nombre: c.account_name,
    moneda: c.currency_code,
    tipo: c.account_type,
    ultimos4: c.clabe_last4 ?? c.account_number_last4 ?? null,
    huella,
  };
}

// ── Normalización de lo que devuelve el lector ──────────────────────────

function assertFecha(valor: string, campo: string): string {
  if (!FECHA_RE.test(valor)) {
    throw new ValidationError(`Fecha ilegible en ${campo}: "${valor}". Se espera YYYY-MM-DD.`);
  }
  return valor;
}

function dec(valor: string, campo: string): Decimal {
  try {
    return new Decimal(valor);
  } catch {
    throw new ValidationError(`Importe ilegible en ${campo}: "${valor}".`);
  }
}

/**
 * Pesos y centavos, SIN tirar los diezmilésimos que la columna sí guarda.
 *
 * `amount`, `opening_balance` y `closing_balance` son DECIMAL(19,4), y un
 * `toFixed(2)` sobre lo que sale de la base no es una decisión de formato: es
 * una PÉRDIDA que después se suma. Dos intereses de 0.1250 redondeados a la
 * salida son 0.13 + 0.13 = 0.26 contra un cierre de 0.25, y `cadena-de-saldos`
 * denuncia un centavo que no falta —el mismo documento que `bank statement
 * list`, que suma dentro del SQL, declara cuadrado—. Un tablero de integridad
 * que sale 4 sobre aritmética correcta enseña a ignorar el tablero.
 *
 * Los dos decimales se conservan como MÍNIMO porque un importe sin ellos no se
 * lee como dinero; los cuatro aparecen sólo cuando el dato de verdad los trae.
 */
function monto(valor: Decimal): string {
  return valor.toFixed(valor.decimalPlaces() > 2 ? 4 : 2);
}

/**
 * Qué referencias del archivo pueden ocupar `bank_transaction_id`.
 *
 * Esa columna lleva un UNIQUE por cuenta, así que meter ahí una referencia que
 * el banco repite —un número de cheque, un folio de comisión mensual— haría
 * que la segunda línea con esa referencia se dedujera contra la primera y
 * DESAPARECIERA sin que nadie se entere. Una referencia que aparece dos veces
 * en el mismo archivo demuestra que no es un id nativo: sólo se promueven las
 * que aparecen una sola vez. Las demás siguen en `raw_data` y deduplican por
 * hash de contenido, que es lo que la 051 dejó para eso.
 */
export function referenciasPromovibles(lineas: { referencia?: string }[]): Set<string> {
  const cuenta = new Map<string, number>();
  for (const l of lineas) {
    const r = l.referencia?.trim();
    if (r) cuenta.set(r, (cuenta.get(r) ?? 0) + 1);
  }
  const unicas = new Set<string>();
  for (const [r, n] of cuenta) if (n === 1) unicas.add(r);
  return unicas;
}

/**
 * El tipo del CHECK de 003, respetando el del banco sólo si coincide con uno.
 *
 * Before falling back to the sign, the bank code and the description get a
 * chance to name a fee or an interest line (`classifyBankLine`, #95): without
 * that, no native format could ever feed `bank fee post` or `bank interest post`.
 */
export function tipoDeMovimiento(importe: Decimal, tipoDeclarado?: string, description?: string): string {
  const t = tipoDeclarado?.trim().toLowerCase();
  if (t && (TIPOS_MOVIMIENTO as readonly string[]).includes(t)) return t;
  const kind = classifyBankLine(importe, tipoDeclarado, description);
  if (kind) return kind;
  if (importe.isZero()) return 'adjustment';
  return importe.isNegative() ? 'debit' : 'credit';
}

export interface EstadoNormalizado {
  formato: string;
  perfil: string | null;
  moneda: string;
  numeroDeEstado: string | null;
  periodoInicio: string;
  periodoFin: string;
  saldoInicial: string;
  saldoFinal: string;
  cuentaDeclarada: string | null;
  avisos: string[];
}

/**
 * Del extracto leído al documento que la tabla exige, diciendo en `avisos`
 * cada cosa que se dedujo. `opening_balance` y `closing_balance` son NOT NULL:
 * un formato que no los publica obliga a derivarlos, y derivarlos EN SILENCIO
 * es lo que convierte un cero de relleno en un saldo que alguien concilia.
 *
 * Recibe de la cuenta sólo los dos campos que la decisión usa, y no la fila
 * entera, para que se pueda ejercitar sin base detrás: la defensa contra el
 * archivo truncado se decide aquí y merece prueba propia.
 */
export function normalizarExtracto(
  leido: ExtractoLeido,
  cuenta: { currency_code: string; account_type: string },
  saldoFinalPrevio: string | null,
  opts: { perfil?: string; saldoFinalEsperado?: string }
): EstadoNormalizado {
  const avisos: string[] = [...(leido.avisos ?? [])];
  const formato = leido.formato;
  if (!(FORMATOS_VALIDOS as readonly string[]).includes(formato)) {
    throw new ValidationError(
      `El lector devolvió el formato "${formato}", que bank_statements.source_format no admite. ` +
        `Admitidos: ${FORMATOS_VALIDOS.join(', ')}.`
    );
  }

  const fechas = leido.lineas.map((l, i) => assertFecha(l.fecha, `línea ${i + 1}`)).sort();
  const periodoInicio = leido.periodoInicio
    ? assertFecha(leido.periodoInicio, 'periodo de inicio')
    : fechas[0];
  const periodoFin = leido.periodoFin ? assertFecha(leido.periodoFin, 'periodo de fin') : fechas[fechas.length - 1];
  if (!periodoInicio || !periodoFin) {
    throw new ValidationError(
      'El archivo no declara periodo y no trae ninguna línea de la que deducirlo: no hay estado de cuenta que guardar.'
    );
  }
  if (!leido.periodoInicio || !leido.periodoFin) {
    avisos.push(
      `el archivo no declara el periodo; se dedujo de las fechas de sus líneas: ${periodoInicio} a ${periodoFin}`
    );
  }
  if (periodoFin < periodoInicio) {
    throw new ValidationError(
      `El periodo termina el ${periodoFin}, antes de empezar el ${periodoInicio}.`
    );
  }

  const suma = leido.lineas.reduce(
    (acc, l, i) => acc.plus(dec(l.importe, `línea ${i + 1}`)),
    new Decimal(0)
  );

  // El saldo final DECLARADO por el archivo, contra el que se contrasta la
  // aseveración del operador. Si el archivo no lo trae, la aseveración PASA A
  // SER el saldo final y la cadena de saldos es la que descubre el truncado.
  const declarado = leido.saldoFinal ? dec(leido.saldoFinal, 'saldo final del archivo') : null;
  const afirmado = opts.saldoFinalEsperado
    ? dec(opts.saldoFinalEsperado, '--closing-balance')
    : null;
  if (afirmado && declarado && !afirmado.eq(declarado)) {
    throw new ConflictError(
      `El archivo cierra en ${declarado.toFixed(2)} y --closing-balance afirma ${afirmado.toFixed(2)}: ` +
        `no se importa nada. Si el archivo tiene razón, quita la bandera; si la tienes tú, el archivo está incompleto.`
    );
  }

  // Comparación contra `null` explícita y no por veracidad: hoy son objetos
  // Decimal, siempre verdaderos, y el día que alguno vuelva a ser un número un
  // saldo final de CERO se leería como «no lo hay».
  const finalConocido = afirmado ?? declarado;

  let saldoInicial: Decimal;
  if (leido.saldoInicial) {
    saldoInicial = dec(leido.saldoInicial, 'saldo inicial del archivo');
  } else if (saldoFinalPrevio !== null) {
    saldoInicial = dec(saldoFinalPrevio, 'saldo final del estado anterior');
    avisos.push(
      `el archivo no declara saldo inicial; se tomó el final del estado anterior de la cuenta (${saldoInicial.toFixed(2)})`
    );
  } else if (finalConocido !== null) {
    saldoInicial = finalConocido.minus(suma);
    avisos.push(
      `el archivo no declara saldo inicial y no hay estado anterior; se dedujo del final menos las líneas (${saldoInicial.toFixed(2)})`
    );
  } else {
    throw new ValidationError(
      'El archivo no trae saldo inicial ni final, y la cuenta no tiene un estado anterior del que arrastrar el saldo. ' +
        'Afirma el saldo final con --closing-balance: sin uno de los dos saldos, el estado no sirve para conciliar.'
    );
  }

  const saldoFinal = finalConocido ?? saldoInicial.plus(suma);
  if (finalConocido === null) {
    avisos.push(
      `el archivo no declara saldo final; se dedujo como inicial + líneas (${saldoFinal.toFixed(2)}), ` +
        `así que la cadena de saldos cuadrará por construcción y no prueba nada`
    );
  } else if (afirmado && !declarado) {
    avisos.push(
      `el saldo final (${saldoFinal.toFixed(2)}) lo afirma --closing-balance y no el archivo: ` +
        `si la cadena de saldos no cierra, el archivo está incompleto`
    );
  }

  const moneda = (leido.moneda ?? cuenta.currency_code).toUpperCase();
  if (!leido.moneda) {
    avisos.push(`el archivo no declara moneda; se asumió la de la cuenta (${moneda})`);
  }
  if (cuenta.account_type === 'petty-cash') {
    avisos.push(
      'la cuenta es de caja chica: se concilia contra arqueo y no contra extracto, así que este documento no cierra por sí solo'
    );
  }

  return {
    formato,
    perfil: opts.perfil ?? leido.perfil ?? null,
    moneda,
    numeroDeEstado: leido.numeroDeEstado ?? null,
    periodoInicio,
    periodoFin,
    saldoInicial: saldoInicial.toFixed(4),
    saldoFinal: saldoFinal.toFixed(4),
    cuentaDeclarada: leido.cuentaDeclarada ?? null,
    avisos,
  };
}

// ── IMPORT ──────────────────────────────────────────────────────────────

/**
 * Importa UN archivo. Todo dentro de una transacción: el estado y sus líneas
 * entran juntos o no entra nada. Un estado sin líneas es un documento que
 * afirma dos saldos que nada sostiene, y líneas sin estado son exactamente lo
 * que la 051 vino a arreglar.
 */
export async function importarEstadoDeCuenta(
  entrada: EntradaImportacion,
  opts: OpcionesImportacion
): Promise<ResultadoImportacion> {
  const contenido = await readFile(entrada.ruta);
  // Sobre los BYTES ORIGINALES, antes de parsear: es lo que hace el dedupe de
  // documento independiente del perfil con el que se lea.
  const sha256 = crypto.createHash('sha256').update(contenido).digest('hex');
  const archivo = path.basename(entrada.ruta);

  const correr = async (client: pg.PoolClient): Promise<ResultadoImportacion> => {
    const cuenta = await cuentaDeLaEntidad(client, entrada.entityId, entrada.bankAccountId);
    if (!cuenta.is_active) {
      throw new ValidationError(
        `La cuenta ${cuenta.account_name} está archivada: no admite estados de cuenta nuevos.`
      );
    }

    // Dedupe de documento ANTES de parsear: es barato y da el mensaje bueno.
    // El UNIQUE de la tabla sigue siendo el guardia real —dos importaciones
    // simultáneas del mismo archivo pasan las dos por aquí— y su violación se
    // traduce abajo al mismo rechazo.
    const previo = await client.query<{ id: string; file_name: string | null; line_count: number; imported_at: string }>(
      `SELECT id, file_name, line_count, imported_at::text AS imported_at
         FROM bank_statements
        WHERE bank_account_id = $1 AND file_sha256 = $2 AND entity_id = $3`,
      [cuenta.id, sha256, entrada.entityId]
    );
    if (previo.rows.length > 0) {
      const p = previo.rows[0];
      throw new ConflictError(
        `Este archivo ya se importó a ${cuenta.account_name}: entró el ${p.imported_at} ` +
          `como ${p.file_name ?? 'archivo sin nombre'} con ${p.line_count} línea(s) (estado ${p.id}). ` +
          `El mismo documento no entra dos veces.`
      );
    }

    const leido = await opts.leer({
      ruta: entrada.ruta,
      contenido,
      ...(opts.formato === undefined ? {} : { formato: opts.formato }),
      ...(opts.perfil === undefined ? {} : { perfil: opts.perfil }),
    });

    const anterior = await client.query<{ closing_balance: string }>(
      `SELECT closing_balance::text AS closing_balance
         FROM bank_statements
        WHERE bank_account_id = $1 AND entity_id = $2
        ORDER BY period_end DESC, period_start DESC
        LIMIT 1`,
      [cuenta.id, entrada.entityId]
    );
    const norm = normalizarExtracto(leido, cuenta, anterior.rows[0]?.closing_balance ?? null, opts);

    // Las siete pruebas sobre el CANDIDATO, con el id todavía sin asignar: el
    // contexto es el mismo que usará `check` después, y por eso la respuesta
    // del import y la del check sobre el mismo documento no se contradicen.
    const statementId = uuidv4();
    const vecinos = await vecinosDeLaCuenta(client, entrada.entityId, cuenta.id);
    const hallazgos = runStatementChecks(
      {
        cuenta: comoVerificable(cuenta),
        estado: {
          id: statementId,
          numeroDeEstado: norm.numeroDeEstado,
          periodoInicio: norm.periodoInicio,
          periodoFin: norm.periodoFin,
          saldoInicial: norm.saldoInicial,
          saldoFinal: norm.saldoFinal,
          moneda: norm.moneda,
          cuentaDeclarada: norm.cuentaDeclarada,
          lineas: leido.lineas.map((l) => ({
            fecha: l.fecha,
            importe: l.importe,
            descripcion: l.descripcion,
            referencia: l.referencia ?? null,
          })),
          lineasDeclaradas: leido.lineas.length,
        },
        vecinos,
      },
      undefined,
      opts.diasReverso === undefined ? {} : { diasReverso: opts.diasReverso }
    );

    // Sólo estas dos abortan: significan «este archivo no es de esta cuenta».
    const impiden = hallazgos.filter(
      (h) => h.severity === 'blocking' && (h.check === 'identidad' || h.check === 'moneda')
    );
    if (impiden.length > 0) {
      throw new ConflictError(
        `El archivo no corresponde a ${cuenta.account_name} y no se importó: ` +
          impiden.map((h) => `${h.check} — ${h.detalle}`).join('; ')
      );
    }

    await client.query(
      `INSERT INTO bank_statements (
         id, entity_id, bank_account_id, period_start, period_end,
         opening_balance, closing_balance, currency_code, statement_number,
         source_format, profile, file_name, file_sha256, line_count, imported_by
       ) VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        statementId, entrada.entityId, cuenta.id, norm.periodoInicio, norm.periodoFin,
        norm.saldoInicial, norm.saldoFinal, norm.moneda, norm.numeroDeEstado,
        norm.formato, norm.perfil, archivo, sha256, leido.lineas.length, entrada.userId,
      ]
    );

    const entered = await insertarLineas(client, cuenta.id, statementId, leido);
    const importadas = entered.length;
    const skipped = await nameSkippedLines(client, entrada.entityId, cuenta.id, leido, entered);
    const duplicadas = skipped.length;

    const avisos = [...norm.avisos];
    if (skipped.length > 0) {
      avisos.push(
        `${skipped.length} línea(s) no entraron porque su id nativo del banco ya está en la cuenta: ` +
          skipped
            .map((s) => `línea ${s.line} (${s.reference}, ya en ${s.existingStatementId ?? 'un movimiento sin estado de cuenta'})`)
            .join('; ')
      );
    }

    // T25 (#138) · THE OVERLAPPING STATEMENT. Probed AFTER the lines are
    // written and BEFORE the transaction commits, on purpose: the fingerprint
    // is computed by the database trigger and has ONE recipe (051, watched by
    // E0.3). Recomputing it here to probe earlier would be a second recipe
    // that drifts in silence. Inside the transaction "block" still means
    // nothing of the file ever becomes visible.
    const tenantId = await tenantDe(client, entrada.entityId);
    const overlaps = await probeOverlaps(client, entrada.entityId, cuenta.id, statementId, leido, entered);
    const overlapPolicy = await readOverlapPolicy(client, tenantId, entrada.entityId);
    if (overlaps.length > 0) {
      const listed = describeOverlaps(overlaps);
      if (overlapPolicy === 'block') {
        throw new ConflictError(
          `${listed}. La política \`bank_statement_overlap\` está en "block": el archivo no se importó. ` +
            `Recorta el archivo a lo que falta, o cambia la política si este despacho importa el ` +
            `traslape y lo resuelve después.`
        );
      }
      if (overlapPolicy === 'mark') await markOverlaps(client, entrada.entityId, cuenta.id, statementId, overlaps);
      avisos.push(
        `${listed}. Entraron DOS veces en la cuenta (política \`bank_statement_overlap\` = "${overlapPolicy}")` +
          (overlapPolicy === 'mark' ? '; cada una lleva la marca del estado con el que se traslapa' : '')
      );
    }

    await registrarAuditoria(client, {
      tenantId,
      legalEntityId: entrada.entityId,
      userId: entrada.userId,
      action: 'create',
      entityType: 'bank_statements',
      entityId: statementId,
      newValues: {
        bank_account_id: cuenta.id,
        file_name: archivo,
        file_sha256: sha256,
        period: `${norm.periodoInicio}…${norm.periodoFin}`,
        opening_balance: norm.saldoInicial,
        closing_balance: norm.saldoFinal,
        line_count: leido.lineas.length,
        importadas,
        duplicadas,
        overlaps: overlaps.length,
        overlap_policy: overlapPolicy,
        dry_run: opts.dryRun === true,
      },
    });

    const salida: ResultadoImportacion = {
      statementId,
      archivo,
      sha256,
      formato: norm.formato,
      perfil: norm.perfil,
      cuenta: {
        id: cuenta.id,
        nombre: cuenta.account_name,
        moneda: cuenta.currency_code,
        tipo: cuenta.account_type,
      },
      numeroDeEstado: norm.numeroDeEstado,
      periodoInicio: norm.periodoInicio,
      periodoFin: norm.periodoFin,
      saldoInicial: norm.saldoInicial,
      saldoFinal: norm.saldoFinal,
      moneda: norm.moneda,
      lineasLeidas: leido.lineas.length,
      importadas,
      duplicadas,
      skipped,
      overlaps,
      overlapPolicy,
      avisos,
      hallazgos,
      ensayo: opts.dryRun === true,
    };
    if (opts.dryRun) throw new EnsayoImportacion(salida);
    return salida;
  };

  try {
    return await withTransaction(correr);
  } catch (e) {
    if (e instanceof EnsayoImportacion) return e.resultado;
    // El UNIQUE(bank_account_id, file_sha256) es el guardia de verdad; su
    // violación se cuenta como lo que es y no como un error de base.
    if (esViolacionUnica(e, 'bank_statements_bank_account_id_file_sha256_key')) {
      throw new ConflictError(
        `Este archivo ya se importó a esa cuenta (sha256 ${sha256.slice(0, 12)}…). El mismo documento no entra dos veces.`
      );
    }
    throw e;
  }
}

function esViolacionUnica(e: unknown, restriccion: string): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; constraint?: unknown };
  return err.code === '23505' && err.constraint === restriccion;
}

/** A file line that entered, by its 0-based position. */
interface EnteredLine {
  index: number;
  id: string;
}

async function insertarLineas(
  client: pg.PoolClient,
  bankAccountId: string,
  statementId: string,
  leido: ExtractoLeido
): Promise<EnteredLine[]> {
  const promovibles = referenciasPromovibles(leido.lineas);
  const entered: EnteredLine[] = [];

  for (let desde = 0; desde < leido.lineas.length; desde += LOTE_LINEAS) {
    const indexById = new Map<string, number>();
    const lote = leido.lineas.slice(desde, desde + LOTE_LINEAS);
    const valores: unknown[] = [];
    const filas: string[] = [];
    lote.forEach((l, i) => {
      const importe = dec(l.importe, `línea ${desde + i + 1}`);
      const ref = l.referencia?.trim();
      const b = i * 11;
      filas.push(
        `($${b + 1}::uuid, $${b + 2}::uuid, $${b + 3}::uuid, $${b + 4}, $${b + 5}::date, ` +
          `$${b + 6}::date, $${b + 7}::decimal, $${b + 8}, $${b + 9}, $${b + 10}::jsonb, $${b + 11}::uuid)`
      );
      const id = uuidv4();
      indexById.set(id, desde + i);
      valores.push(
        id,
        bankAccountId,
        statementId,
        ref && promovibles.has(ref) ? ref : null,
        assertFecha(l.fecha, `línea ${desde + i + 1}`),
        l.fechaValor ? assertFecha(l.fechaValor, `fecha valor de la línea ${desde + i + 1}`) : null,
        importe.toFixed(4),
        tipoDeMovimiento(importe, l.tipo, l.descripcion),
        l.descripcion ?? '',
        // Envoltura y no volcado plano: `crudo` es la fila del banco tal cual y
        // tiene que poder releerse sin adivinar qué claves puso el importador.
        JSON.stringify({
          crudo: l.crudo ?? {},
          referencia: ref ?? null,
          tipo: l.tipo ?? null,
          fecha_valor: l.fechaValor ?? null,
        }),
        // `import_batch_id` llevaba desde la 003 un uuid sin tabla detrás.
        // Ahora esa tabla existe y es la misma que el lote: son el mismo hecho.
        statementId
      );
    });

    // THE CONFLICT TARGET IS NAMED (T25, #138). It used to be a bare
    // `ON CONFLICT DO NOTHING`, which swallowed ANY unique violation and let
    // the caller report the gap as "duplicates" by subtraction — blaming the
    // bank for rows the system dropped. Now the only row that may be skipped
    // is one whose native bank id is already in the account, and
    // `nameSkippedLines` proves that cause line by line; any other violation
    // raises. The content fingerprint is NOT a key (T1, #136: two identical
    // fees on one day are two fees), so it is never a conflict target.
    // `content_hash` NO va en la lista de columnas: lo pone el disparador.
    const r = await client.query<{ id: string }>(
      `INSERT INTO bank_transactions (
         id, bank_account_id, statement_id, bank_transaction_id, transaction_date,
         posted_date, amount, transaction_type, description, raw_data, import_batch_id
       ) VALUES ${filas.join(', ')}
       ON CONFLICT (bank_account_id, bank_transaction_id) DO NOTHING
       RETURNING id`,
      valores
    );
    for (const row of r.rows) {
      entered.push({ index: indexById.get(row.id) as number, id: row.id });
    }
  }

  return entered.sort((x, y) => x.index - y.index);
}

/** Why a line of the file did not enter. Proven per line, never inferred by subtraction. */
export type SkipCause = 'native-id-already-in-account';

export interface SkippedLine {
  /** 1-based position in the file. */
  line: number;
  date: string;
  amount: string;
  description: string;
  reference: string | null;
  cause: SkipCause;
  /** Statement the existing line hangs from; null when it entered without one (REST). */
  existingStatementId: string | null;
}

/** A line of the new file whose fingerprint is already in ANOTHER statement of the account. */
export interface OverlapLine {
  /** 1-based position in the file. */
  line: number;
  date: string;
  amount: string;
  description: string;
  /** The new row in `bank_transactions` (the one "mark" marks). */
  transactionId: string;
  existingStatementId: string;
  existingFile: string | null;
}

const OVERLAP_POLICY_KEY = 'bank_statement_overlap';
export type OverlapPolicy = 'block' | 'mark' | 'warn';
const OVERLAP_POLICIES: readonly OverlapPolicy[] = ['block', 'mark', 'warn'];

/**
 * Names every line that did not enter, with its cause. The only conflict the
 * INSERT tolerates is the native bank id, so each skipped line must have one
 * already in the account; if it does not, the import aborts instead of
 * guessing — an unexplained missing row is exactly what #138 forbids.
 */
async function nameSkippedLines(
  client: pg.PoolClient,
  entityId: string,
  bankAccountId: string,
  leido: ExtractoLeido,
  entered: EnteredLine[]
): Promise<SkippedLine[]> {
  const done = new Set(entered.map((e) => e.index));
  const missing = leido.lineas.map((l, index) => ({ l, index })).filter((x) => !done.has(x.index));
  if (missing.length === 0) return [];

  const refs = missing.map((m) => m.l.referencia?.trim() ?? '');
  const existing = await client.query<{ bank_transaction_id: string; statement_id: string | null }>(
    `SELECT bt.bank_transaction_id, bt.statement_id
       FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE bt.bank_account_id = $1 AND ba.entity_id = $2
        AND bt.bank_transaction_id = ANY($3::text[])`,
    [bankAccountId, entityId, refs]
  );
  const statementOf = new Map(existing.rows.map((x) => [x.bank_transaction_id, x.statement_id]));

  return missing.map(({ l, index }, k) => {
    if (!statementOf.has(refs[k])) {
      throw new Error(
        `La línea ${index + 1} del archivo no entró y su id nativo no está en la cuenta: la causa no ` +
          `se conoce, así que no se importa nada. Esto es un defecto del importador, no del banco.`
      );
    }
    return {
      line: index + 1,
      date: l.fecha,
      amount: monto(dec(l.importe, `línea ${index + 1}`)),
      description: l.descripcion ?? '',
      reference: refs[k],
      cause: 'native-id-already-in-account' as const,
      existingStatementId: statementOf.get(refs[k]) ?? null,
    };
  });
}

/**
 * The lines of the new file already present in OTHER statements of the same
 * account, by the fingerprint the database computed (`idx_bank_tx_contenido`
 * makes the probe an index lookup). Counted by MULTIPLICITY: if the monthly
 * holds two identical fees and the quarterly three, two overlap and the third
 * is a new charge. Presence alone would call the third a repeat, which is #88
 * again from the other side.
 */
async function probeOverlaps(
  client: pg.PoolClient,
  entityId: string,
  bankAccountId: string,
  statementId: string,
  leido: ExtractoLeido,
  entered: EnteredLine[]
): Promise<OverlapLine[]> {
  if (entered.length === 0) return [];
  // The fingerprints are READ back after the INSERT, never sent with it.
  const mine = await client.query<{ id: string; content_hash: string }>(
    `SELECT bt.id, bt.content_hash FROM bank_transactions bt
       JOIN bank_accounts ba ON ba.id = bt.bank_account_id
      WHERE bt.statement_id = $1 AND bt.bank_account_id = $2 AND ba.entity_id = $3`,
    [statementId, bankAccountId, entityId]
  );
  const hashOf = new Map(mine.rows.map((x) => [x.id, x.content_hash]));
  const r = await client.query<{ content_hash: string; statement_id: string; file_name: string | null; n: number }>(
    `SELECT bt.content_hash, bt.statement_id, s.file_name, COUNT(*)::int AS n
       FROM bank_transactions bt
       JOIN bank_statements s ON s.id = bt.statement_id
      WHERE bt.bank_account_id = $1 AND s.bank_account_id = $1 AND s.entity_id = $2
        AND bt.statement_id <> $3
        AND bt.content_hash = ANY($4::text[])
      GROUP BY bt.content_hash, bt.statement_id, s.file_name, s.period_start
      ORDER BY s.period_start, bt.statement_id`,
    [bankAccountId, entityId, statementId, [...new Set(hashOf.values())]]
  );
  const pool = new Map<string, Array<{ statementId: string; file: string | null; left: number }>>();
  for (const x of r.rows) {
    const q = pool.get(x.content_hash) ?? [];
    q.push({ statementId: x.statement_id, file: x.file_name, left: x.n });
    pool.set(x.content_hash, q);
  }

  const overlaps: OverlapLine[] = [];
  for (const e of entered) {
    const source = pool.get(hashOf.get(e.id) ?? '')?.find((s) => s.left > 0);
    if (!source) continue;
    source.left -= 1;
    const l = leido.lineas[e.index];
    overlaps.push({
      line: e.index + 1,
      date: l.fecha,
      amount: monto(dec(l.importe, `línea ${e.index + 1}`)),
      description: l.descripcion ?? '',
      transactionId: e.id,
      existingStatementId: source.statementId,
      existingFile: source.file,
    });
  }
  return overlaps;
}

/** Reader of `bank_statement_overlap`. A value outside the catalog reads as the strictest. */
async function readOverlapPolicy(
  client: pg.PoolClient,
  tenantId: string,
  entityId: string
): Promise<OverlapPolicy> {
  const p = await getPolicy({ tenantId, entityId }, OVERLAP_POLICY_KEY, client);
  return (OVERLAP_POLICIES as readonly string[]).includes(p.value) ? (p.value as OverlapPolicy) : 'block';
}

function describeOverlaps(overlaps: OverlapLine[]): string {
  const files = [...new Set(overlaps.map((o) => o.existingFile ?? o.existingStatementId))];
  return (
    `${overlaps.length} línea(s) de este archivo ya están en otro estado de cuenta de la cuenta ` +
    `(${files.join(', ')}): ` +
    overlaps
      .map((o) => `línea ${o.line} · ${o.date} · ${o.amount} · ${o.description} (en ${o.existingFile ?? o.existingStatementId})`)
      .join('; ')
  );
}

/**
 * "mark": the mark lives in the importer's own envelope in `raw_data`, next to
 * `referencia` and `tipo` and apart from `crudo` (the bank's row), so no new
 * column is needed and a bank file cannot forge it. Guarded UPDATE: the new
 * statement, its account, the entity, an unmatched line (nothing has used it
 * yet), and the row count checked.
 */
async function markOverlaps(
  client: pg.PoolClient,
  entityId: string,
  bankAccountId: string,
  statementId: string,
  overlaps: OverlapLine[]
): Promise<void> {
  const r = await client.query(
    `UPDATE bank_transactions bt
        SET raw_data = COALESCE(bt.raw_data, '{}'::jsonb) ||
                       jsonb_build_object('overlap', jsonb_build_object('statement_id', m.statement_id::text))
       FROM unnest($1::uuid[], $2::uuid[]) AS m(id, statement_id)
      WHERE bt.id = m.id AND bt.statement_id = $3 AND bt.bank_account_id = $4
        AND bt.is_matched = false
        AND bt.bank_account_id IN (SELECT id FROM bank_accounts WHERE entity_id = $5)`,
    [
      overlaps.map((o) => o.transactionId),
      overlaps.map((o) => o.existingStatementId),
      statementId,
      bankAccountId,
      entityId,
    ]
  );
  if (r.rowCount !== overlaps.length) {
    throw new Error(
      `Se iban a marcar ${overlaps.length} línea(s) traslapadas y se marcaron ${r.rowCount ?? 0}: no se importa nada.`
    );
  }
}

export interface ResultadoLote {
  resultados: ResultadoImportacion[];
  /** Un archivo malo no tumba a los buenos: cada documento es su transacción. */
  fallidos: { archivo: string; error: string }[];
}

// ── LIST y SHOW ─────────────────────────────────────────────────────────

export interface FiltrosEstados {
  /** Id o fragmento del nombre de la cuenta. */
  account?: string;
  /** Estados cuyo periodo termina en o después de esta fecha. */
  since?: string;
  /** Estados cuyo periodo empieza en o antes de esta fecha. */
  until?: string;
  limit?: number;
}

export interface CadenaDeSaldos {
  cuadra: boolean;
  /** Σ de las líneas que la base atribuye al estado. */
  suma: string;
  /** saldo inicial + Σ. */
  esperado: string;
  /** Lo que declara el documento. */
  declarado: string;
  diferencia: string;
}

export interface ResumenEstadoDeCuenta {
  id: string;
  bankAccountId: string;
  cuenta: string;
  moneda: string;
  numeroDeEstado: string | null;
  periodoInicio: string;
  periodoFin: string;
  saldoInicial: string;
  saldoFinal: string;
  /** Las que trae el documento. */
  lineCount: number;
  /** Las que la base le atribuye hoy. Menos, si hubo dedupe contra otro estado. */
  lineasEnBase: number;
  formato: string;
  perfil: string | null;
  importadoEl: string;
  /**
   * «Resultado de la última verificación» de la fila 1163. Se CALCULA al leer y
   * no se lee de una columna: `bank_statements` no guarda ningún veredicto, y
   * un veredicto guardado envejece —las líneas cambian de estado con cada
   * import— así que sería peor que no tenerlo.
   */
  cadenaDeSaldos: CadenaDeSaldos;
}

interface FilaEstado {
  id: string;
  bank_account_id: string;
  entity_id: string;
  account_name: string;
  currency_code: string;
  statement_number: string | null;
  period_start: string;
  period_end: string;
  opening_balance: string;
  closing_balance: string;
  line_count: number;
  source_format: string;
  profile: string | null;
  file_name: string | null;
  file_sha256: string;
  imported_at: string;
  imported_by: string;
  lineas_en_base: string;
  suma_lineas: string;
}

function aResumen(f: FilaEstado): ResumenEstadoDeCuenta {
  const inicial = new Decimal(f.opening_balance);
  const suma = new Decimal(f.suma_lineas);
  const esperado = inicial.plus(suma);
  const declarado = new Decimal(f.closing_balance);
  return {
    id: f.id,
    bankAccountId: f.bank_account_id,
    cuenta: f.account_name,
    moneda: f.currency_code,
    numeroDeEstado: f.statement_number,
    periodoInicio: f.period_start,
    periodoFin: f.period_end,
    saldoInicial: monto(inicial),
    saldoFinal: monto(declarado),
    lineCount: f.line_count,
    lineasEnBase: Number(f.lineas_en_base),
    formato: f.source_format,
    perfil: f.profile,
    importadoEl: f.imported_at,
    cadenaDeSaldos: {
      // `cuadra` se decide sobre los Decimal ENTEROS y no sobre lo formateado:
      // la comparación es la respuesta, el texto sólo la cuenta.
      cuadra: esperado.eq(declarado),
      suma: monto(suma),
      esperado: monto(esperado),
      declarado: monto(declarado),
      diferencia: monto(declarado.minus(esperado)),
    },
  };
}

/**
 * El SELECT compartido por list y show.
 *
 * La suma de líneas va por LATERAL con la cuenta REPETIDA en la condición
 * (`bt.bank_account_id = s.bank_account_id`): `bank_transactions` no tiene
 * entity_id y su única frontera es la cuenta, así que se escribe donde se lee y
 * no se deja implícita en el JOIN de arriba.
 */
const SELECT_ESTADO = `
  SELECT s.id, s.bank_account_id, s.entity_id, ba.account_name, s.currency_code,
         s.statement_number, s.period_start::text AS period_start, s.period_end::text AS period_end,
         s.opening_balance::text AS opening_balance, s.closing_balance::text AS closing_balance,
         s.line_count, s.source_format, s.profile, s.file_name, s.file_sha256,
         s.imported_at::text AS imported_at, s.imported_by,
         COALESCE(l.n, 0)::text AS lineas_en_base,
         COALESCE(l.suma, 0)::text AS suma_lineas
    FROM bank_statements s
    JOIN bank_accounts ba ON ba.id = s.bank_account_id AND ba.entity_id = $1
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS n, SUM(bt.amount) AS suma
        FROM bank_transactions bt
       WHERE bt.statement_id = s.id AND bt.bank_account_id = s.bank_account_id
    ) l ON TRUE`;

export async function listarEstadosDeCuenta(
  entityId: string,
  filtros: FiltrosEstados = {}
): Promise<ResumenEstadoDeCuenta[]> {
  const cond = ['s.entity_id = $1'];
  const params: unknown[] = [entityId];
  let i = 2;
  if (filtros.account) {
    const cuenta = await resolverCuentaBancaria(entityId, filtros.account);
    cond.push(`s.bank_account_id = $${i++}`);
    params.push(cuenta.id);
  }
  if (filtros.since) {
    cond.push(`s.period_end >= $${i++}::date`);
    params.push(assertFecha(filtros.since, '--since'));
  }
  if (filtros.until) {
    cond.push(`s.period_start <= $${i++}::date`);
    params.push(assertFecha(filtros.until, '--until'));
  }
  const limite = Math.min(Math.max(filtros.limit ?? 50, 1), 500);
  params.push(limite);

  const r = await query<FilaEstado>(
    `${SELECT_ESTADO}
      WHERE ${cond.join(' AND ')}
      ORDER BY ba.account_name, s.period_start DESC, s.period_end DESC
      LIMIT $${i}`,
    params
  );
  return r.rows.map(aResumen);
}

export interface LineaDeEstado {
  id: string;
  fecha: string;
  fechaValor: string | null;
  importe: string;
  tipo: string;
  descripcion: string | null;
  /** Id nativo del banco, cuando el archivo publicó uno utilizable. */
  referencia: string | null;
  /** El hash del disparador: es el que decide si una línea ya estaba. */
  contentHash: string;
  cotejada: boolean;
  /**
   * With `bank_statement_overlap` = "mark": the statement this line was
   * already in when it was imported. Null for every other line.
   */
  overlap: string | null;
}

export interface DetalleEstadoDeCuenta extends ResumenEstadoDeCuenta {
  entityId: string;
  archivo: string | null;
  /** sha256 de los bytes originales: la prueba de que es el mismo documento. */
  sha256: string;
  importadoPor: string;
  /** Sólo con `--lines`. */
  lineas: LineaDeEstado[] | null;
  /** Cuántas quedaron fuera del listado por el tope. */
  lineasOmitidas: number;
}

export async function obtenerEstadoDeCuenta(
  entityId: string,
  statementId: string,
  opts: { lineas?: boolean; limiteLineas?: number } = {}
): Promise<DetalleEstadoDeCuenta> {
  const r = await query<FilaEstado>(`${SELECT_ESTADO} WHERE s.entity_id = $1 AND s.id = $2`, [
    entityId,
    statementId,
  ]);
  if (r.rows.length === 0) throw new NotFoundError('Bank Statement', statementId);
  const f = r.rows[0];
  const base = aResumen(f);

  let lineas: LineaDeEstado[] | null = null;
  let omitidas = 0;
  if (opts.lineas) {
    const tope = Math.min(Math.max(opts.limiteLineas ?? 500, 1), MAX_LINEAS_CHECK);
    const l = await query<{
      id: string; transaction_date: string; posted_date: string | null; amount: string;
      transaction_type: string; description: string | null; bank_transaction_id: string | null;
      content_hash: string; is_matched: boolean; overlap: string | null;
    }>(
      // La entidad entra por JOIN porque bank_transactions no la lleva.
      `SELECT bt.id, bt.transaction_date::text AS transaction_date,
              bt.posted_date::text AS posted_date, bt.amount::text AS amount,
              bt.transaction_type, bt.description, bt.bank_transaction_id,
              bt.content_hash, bt.is_matched,
              bt.raw_data->'overlap'->>'statement_id' AS overlap
         FROM bank_transactions bt
         JOIN bank_accounts ba ON ba.id = bt.bank_account_id
        WHERE bt.statement_id = $1 AND ba.entity_id = $2
        ORDER BY bt.transaction_date, bt.amount, bt.id
        LIMIT $3`,
      [statementId, entityId, tope]
    );
    lineas = l.rows.map((x) => ({
      id: x.id,
      fecha: x.transaction_date,
      fechaValor: x.posted_date,
      // Estas líneas NO son sólo pantalla: `check` las suma para la cadena de
      // saldos, así que redondearlas aquí es descuadrar el estado allá.
      importe: monto(new Decimal(x.amount)),
      tipo: x.transaction_type,
      descripcion: x.description,
      referencia: x.bank_transaction_id,
      contentHash: x.content_hash,
      cotejada: x.is_matched,
      overlap: x.overlap,
    }));
    omitidas = Math.max(base.lineasEnBase - lineas.length, 0);
  }

  return {
    ...base,
    entityId: f.entity_id,
    archivo: f.file_name,
    sha256: f.file_sha256,
    importadoPor: f.imported_by,
    lineas,
    lineasOmitidas: omitidas,
  };
}

// ── CHECK ───────────────────────────────────────────────────────────────

export interface OpcionesCheck {
  /** `--check a,b`. Sin nombres corren las siete. */
  checks?: string[];
  /** `--account`: verifica todos los estados de una cuenta. */
  account?: string;
  /** `--since`: sólo los que terminan en o después de esta fecha. */
  since?: string;
  /** `-a/--all`: todos los estados de la entidad, no sólo el último por cuenta. */
  all?: boolean;
  diasReverso?: number;
}

export interface EstadoVerificado {
  id: string;
  numeroDeEstado: string | null;
  bankAccountId: string;
  cuenta: string;
  periodoInicio: string;
  periodoFin: string;
  hallazgos: HallazgoEstado[];
}

export interface ResultadoCheck {
  /** Qué pruebas corrieron, en orden. */
  checks: StatementCheckName[];
  estados: EstadoVerificado[];
  hallazgos: HallazgoEstado[];
  bloqueantes: number;
  advertencias: number;
  /** Falso si hay un solo hallazgo bloqueante: es lo que hace salir 4. */
  cuadra: boolean;
  /** Estados que cumplían el filtro y no se verificaron por el tope. */
  omitidos: number;
}

async function vecinosDeLaCuenta(
  client: pg.PoolClient | null,
  entityId: string,
  bankAccountId: string
): Promise<VecinoEstado[]> {
  const sql = `SELECT id, statement_number,
                      period_start::text AS period_start, period_end::text AS period_end,
                      opening_balance::text AS opening_balance,
                      closing_balance::text AS closing_balance
                 FROM bank_statements
                WHERE bank_account_id = $1 AND entity_id = $2
                ORDER BY period_start, period_end`;
  type Fila = {
    id: string; statement_number: string | null; period_start: string; period_end: string;
    opening_balance: string; closing_balance: string;
  };
  const r = client
    ? await client.query<Fila>(sql, [bankAccountId, entityId])
    : await query<Fila>(sql, [bankAccountId, entityId]);
  return r.rows.map((x) => ({
    id: x.id,
    numeroDeEstado: x.statement_number,
    periodoInicio: x.period_start,
    periodoFin: x.period_end,
    saldoInicial: x.opening_balance,
    saldoFinal: x.closing_balance,
  }));
}

/**
 * `bank statement check [<id>]`.
 *
 * Sin id y sin `--all` verifica EL ÚLTIMO estado de cada cuenta: es la pregunta
 * que se hace justo después de importar, y correr las siete pruebas sobre diez
 * años de historia para responderla sería cobrarle al operador la curiosidad.
 * `--all` es la barrida completa y existe para el cierre.
 */
export async function verificarEstadosDeCuenta(
  entityId: string,
  statementId?: string,
  opts: OpcionesCheck = {}
): Promise<ResultadoCheck> {
  const checks = resolverChecks(opts.checks);

  const cond = ['s.entity_id = $1'];
  const params: unknown[] = [entityId];
  let i = 2;
  if (statementId) {
    cond.push(`s.id = $${i++}`);
    params.push(statementId);
  }
  if (opts.account) {
    const cuenta = await resolverCuentaBancaria(entityId, opts.account);
    cond.push(`s.bank_account_id = $${i++}`);
    params.push(cuenta.id);
  }
  if (opts.since) {
    cond.push(`s.period_end >= $${i++}::date`);
    params.push(assertFecha(opts.since, '--since'));
  }
  // Sin id, sin --all y sin --account: el último de cada cuenta.
  const ultimoPorCuenta =
    !statementId && !opts.all && !opts.account
      ? ` AND s.id = (SELECT s2.id FROM bank_statements s2
                       WHERE s2.bank_account_id = s.bank_account_id AND s2.entity_id = $1
                       ORDER BY s2.period_end DESC, s2.period_start DESC, s2.id
                       LIMIT 1)`
      : '';

  const objetivo = await query<{ id: string; bank_account_id: string }>(
    `SELECT s.id, s.bank_account_id
       FROM bank_statements s
       JOIN bank_accounts ba ON ba.id = s.bank_account_id AND ba.entity_id = $1
      WHERE ${cond.join(' AND ')}${ultimoPorCuenta}
      ORDER BY ba.account_name, s.period_start
      LIMIT ${MAX_ESTADOS + 1}`,
    params
  );
  if (objetivo.rows.length === 0) {
    if (statementId) throw new NotFoundError('Bank Statement', statementId);
    return {
      checks, estados: [], hallazgos: [], bloqueantes: 0, advertencias: 0,
      cuadra: true, omitidos: 0,
    };
  }
  const omitidos = Math.max(objetivo.rows.length - MAX_ESTADOS, 0);
  const filas = objetivo.rows.slice(0, MAX_ESTADOS);

  const cuentas = new Map<string, CuentaVerificable>();
  const vecinos = new Map<string, VecinoEstado[]>();
  for (const id of new Set(filas.map((f) => f.bank_account_id))) {
    cuentas.set(id, comoVerificable(await cuentaDeLaEntidad(null, entityId, id)));
    vecinos.set(id, await vecinosDeLaCuenta(null, entityId, id));
  }

  const estados: EstadoVerificado[] = [];
  const todos: HallazgoEstado[] = [];
  for (const fila of filas) {
    const detalle = await obtenerEstadoDeCuenta(entityId, fila.id, {
      lineas: true,
      limiteLineas: MAX_LINEAS_CHECK,
    });
    const cuenta = cuentas.get(fila.bank_account_id);
    if (!cuenta) continue;
    const ctx: ContextoVerificacion = {
      cuenta,
      estado: {
        id: detalle.id,
        numeroDeEstado: detalle.numeroDeEstado,
        periodoInicio: detalle.periodoInicio,
        periodoFin: detalle.periodoFin,
        saldoInicial: detalle.saldoInicial,
        saldoFinal: detalle.saldoFinal,
        moneda: detalle.moneda,
        // El archivo declaró una cuenta y bank_statements no la conserva: la
        // prueba de identidad lo dice en vez de callarse.
        cuentaDeclarada: null,
        lineas: (detalle.lineas ?? []).map(
          (l): LineaVerificable => ({
            fecha: l.fecha,
            importe: l.importe,
            descripcion: l.descripcion ?? '',
            referencia: l.referencia,
          })
        ),
        lineasDeclaradas: detalle.lineCount,
      },
      vecinos: vecinos.get(fila.bank_account_id) ?? [],
    };
    // Con el tope rebasado, las dos pruebas que leen LÍNEA POR LÍNEA se
    // callan y lo dicen: un descuadre calculado sobre media población es un
    // hallazgo falso, y un hallazgo falso en un tablero de integridad enseña
    // al operador a ignorar el tablero.
    const truncado = detalle.lineasOmitidas > 0;
    const efectivos = truncado
      ? checks.filter((c) => c !== 'cadena-de-saldos' && c !== 'reversos')
      : checks;
    // La lista vacía se corta AQUÍ y no se delega: `resolverChecks` entiende
    // «ninguna» como «no me dijeron» y correría las siete, que es justo lo
    // contrario de lo que este filtro acaba de decidir.
    const hallazgos =
      efectivos.length === 0
        ? []
        : runStatementChecks(
            ctx,
            efectivos,
            opts.diasReverso === undefined ? {} : { diasReverso: opts.diasReverso }
          );
    if (truncado) {
      hallazgos.unshift({
        check: 'cadena-de-saldos',
        severity: 'warning',
        referencia: detalle.numeroDeEstado ?? detalle.id,
        detalle:
          `el estado tiene ${detalle.lineasEnBase} líneas y la verificación carga ${MAX_LINEAS_CHECK}: ` +
          `cadena-de-saldos y reversos no se corrieron. La aritmética del documento sigue disponible en ` +
          `'bank statement list', que la calcula sobre el total dentro del SQL`,
      });
    }
    estados.push({
      id: detalle.id,
      numeroDeEstado: detalle.numeroDeEstado,
      bankAccountId: detalle.bankAccountId,
      cuenta: detalle.cuenta,
      periodoInicio: detalle.periodoInicio,
      periodoFin: detalle.periodoFin,
      hallazgos,
    });
    todos.push(...hallazgos);
  }

  const bloqueantes = todos.filter((h) => h.severity === 'blocking').length;
  return {
    checks,
    estados,
    hallazgos: todos,
    bloqueantes,
    advertencias: todos.length - bloqueantes,
    cuadra: bloqueantes === 0,
    omitidos,
  };
}

export type { HallazgoEstado, StatementCheckName } from './statement-checks.js';
export { STATEMENT_CHECK_NAMES } from './statement-checks.js';
