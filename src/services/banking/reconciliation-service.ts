import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import { condicionDeAlcance, type Scope } from '../../database/scope.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import { getPolicy } from '../policy/policy-service.js';
import { correrCotejo, type ResultadoCorrida } from './match-service.js';
import {
  importarEstadoDeCuenta,
  resolverCuentaBancaria,
  type LeerExtracto,
  type ResultadoImportacion,
} from './bank-statement-service.js';
import {
  calcularAritmetica,
  monto,
  type Aritmetica,
  type Reparo,
  type TipoDePartida,
} from './reconciliation-math.js';
import {
  clasificarPartidas,
  listarPartidas,
  paraAritmetica,
  type PartidaConciliatoria,
  type ResultadoDeClasificacion,
} from './reconciling-items.js';
import { listarAjustes, type AjusteDeSesion } from './reconciliation-adjustments.js';

// ============================================================
// LA SESIÓN QUE CUADRA (F05c · 053)
//
// Éste es el tramo del que habla el comentario más largo del módulo, el del
// endpoint retirado: `POST /reconciliations/:id/complete` era un UPDATE
// poniendo `status = 'balanced'`. Nunca calculó el saldo de libros, nunca lo
// comparó con el del banco, nunca miró si quedaba un movimiento sin cotejar, y
// nunca contabilizó los ajustes que una conciliación existe para encontrar. Y
// `period-close.ts` lee `status IN ('balanced','approved','posted')` como la
// evidencia de que la cuenta se verificó, así que ese UPDATE incondicional se
// convertía en una afirmación firmada de que el efectivo estaba comprobado.
//
// LO QUE ESTE ARCHIVO HACE ES QUE `balanced` SIGNIFIQUE ALGO. Todo lo demás es
// secundario. Cinco decisiones lo sostienen:
//
// 1. LA ARITMÉTICA SE CALCULA VIVA, SIEMPRE. `status` la recalcula entera cada
//    vez y NUNCA lee `reconciliation_sessions.variance` como la respuesta. Las
//    seis columnas escalares de la 003 —variance, ending_balance_per_books,
//    outstanding_checks, deposits_in_transit, bank_charges, bank_interest—
//    pasan a ser el RESUMEN CONGELADO que se escribe AL CERRAR: la aseveración
//    que se hizo, no la respuesta. Contrastar una con la otra es lo que un día
//    permitirá descubrir que la sesión de marzo ya no dice la verdad.
//
// 2. EL CERO OBSERVADO Y EL CERO POR OMISIÓN NO SE PUEDEN CONFUNDIR. La resta
//    vive en `reconciliation-math.ts`, sin base de datos, y devuelve `null`
//    cuando un lado no se observó. Aquí eso pasa de verdad dos veces: cuando
//    la sesión no tiene `statement_id` (las que abrió la ruta REST, con
//    `beginning_balance` fijo en 0) y cuando la cuenta de mayor de la cuenta
//    bancaria pertenece al catálogo de OTRA entidad —ahí la suma de libros
//    daría cero por no encontrar filas, que es la peor forma de equivocarse
//    porque parece un saldo—.
//
// 3. `arithmetic_computed_at` SÓLO LO ESCRIBE `cerrarSesion`, en la misma
//    sentencia que mueve el estado a `balanced`. El CHECK
//    `sesion_balanceada_con_aritmetica` de la 053 es el guardia estructural: un
//    CHECK sobre `variance = 0` no habría cazado el defecto histórico, porque
//    la variación valía cero por DEFAULT, que es lo contrario de haberla
//    calculado.
//
// 4. LA FRONTERA VA DENTRO DEL SQL. `bank_transactions` no tiene `entity_id`:
//    cuelga de `bank_account_id` → `bank_accounts.entity_id`, así que se acota
//    por JOIN y nunca filtrando en JS después. Por esa fuga exacta entraron
//    movimientos en el extracto de otra entidad, y por ella se abrían sesiones
//    en los libros de otro, que es escribir en SU cierre. `reconciling_items` y
//    `reconciliation_adjustments` sí traen `entity_id` (053) y aun así se
//    acotan por él en cada lectura: la columna no acota sola.
//
// 5. LOS DOS CRITERIOS CONTABLES SE LEEN DEL PANEL, NO SE ELIGEN AQUÍ.
//    `conciliacion_tolerancia` decide si «cuadrar» admite residual, y
//    `linea_banco_sin_partida_al_cierre` decide qué pasa con el movimiento del
//    extracto que nadie explica. Ninguna de las dos se pregunta en la línea de
//    comandos ni se codifica: una bifurcación de criterio contable se añade al
//    panel y se lee con `getPolicy`.
//
// LO QUE ESTE ARCHIVO NO HACE, A PROPÓSITO: no aprueba, no contabiliza y no
// sella líneas. `approve` exige preparador ≠ aprobador y un snapshot firmado;
// `post` contabiliza los ajustes y sella el mayor. Son F05d, detrás de una
// firma. `run` se detiene SIEMPRE antes de los dos e imprime lo que falta.
// ============================================================

/** Estados del CHECK de `reconciliation_sessions.status` (003). */
export const ESTADOS_DE_SESION = ['in_progress', 'balanced', 'approved', 'posted'] as const;
export type EstadoDeSesionConciliacion = (typeof ESTADOS_DE_SESION)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;
const PERIODO_RE = /^(\d{4})-(\d{2})$/;

/** Tope de sesiones que devuelve `list`. La vista de despacho no se lee entera. */
const LIMITE_SESIONES = 500;

export interface ContextoSesion {
  userId: string;
  /** Recorre el camino real y lo revierte, como el resto de F03/F04/F05. */
  dryRun?: boolean;
}

/** Centinela: la única salida de una transacción con el trabajo hecho y deshecho. */
class EnsayoSesion<T> extends Error {
  constructor(readonly resultado: T) {
    super('dry run');
    this.name = 'EnsayoSesion';
  }
}

async function ejecutarActo<T>(correr: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    return await withTransaction(correr);
  } catch (e) {
    if (e instanceof EnsayoSesion) return e.resultado as T;
    throw e;
  }
}

/**
 * Abrir, cerrar y clasificar son actos SOBRE UNA ENTIDAD. `--all-entities` es
 * la vista de despacho de `list` y sólo de `list`: escribir con alcance de
 * inquilino significaría elegir por el operador en los libros de cuál de sus
 * entidades escribe.
 */
function exigirEntidad(scope: Scope): { tenantId: string; entityId: string } {
  if (scope.kind !== 'entity') {
    throw new ValidationError(
      'Esta operación escribe sobre una entidad concreta y el alcance recibido es de ' +
        'inquilino. `--all-entities` sólo existe para la vista de despacho de ' +
        '`bank reconciliation list`.'
    );
  }
  return { tenantId: scope.tenantId, entityId: scope.entityId };
}

/**
 * Un importe a Decimal, rechazando lo ilegible EN ESPAÑOL en vez de dejar
 * salir el error crudo de decimal.js. `new Decimal('')` lanza «[DecimalError]
 * Invalid argument», que no le dice nada a quien tecleó `--closing-balance`.
 */
function dec(valor: string, campo: string): Decimal {
  let d: Decimal;
  try {
    d = new Decimal(valor);
  } catch {
    throw new ValidationError(`Importe ilegible en ${campo}: "${valor}".`);
  }
  if (!d.isFinite()) throw new ValidationError(`Importe no finito en ${campo}: "${valor}".`);
  return d;
}

function assertFecha(valor: string, campo: string): string {
  if (!FECHA_RE.test(valor)) {
    throw new ValidationError(`Fecha ilegible en ${campo}: "${valor}". Se espera YYYY-MM-DD.`);
  }
  return valor;
}

/**
 * `--period 2026-08` a sus dos extremos, en UTC.
 *
 * El último día del mes se calcula con `Date.UTC(a, m, 0)` y no con una tabla
 * de longitudes: febrero de un año bisiesto es el caso que una tabla escrita a
 * mano se come, y un periodo que termina el 28 cuando el extracto llega al 29
 * deja un movimiento fuera de la conciliación sin que nada se queje.
 */
export function rangoDelPeriodo(periodo: string): { desde: string; hasta: string } {
  const m = PERIODO_RE.exec(periodo.trim());
  if (!m) {
    throw new ValidationError(`Periodo ilegible: "${periodo}". Se espera YYYY-MM (por ejemplo 2026-08).`);
  }
  const anio = Number(m[1]);
  const mes = Number(m[2]);
  if (mes < 1 || mes > 12) {
    throw new ValidationError(`Periodo ilegible: "${periodo}". El mes tiene que estar entre 01 y 12.`);
  }
  const fin = new Date(Date.UTC(anio, mes, 0));
  const dd = String(fin.getUTCDate()).padStart(2, '0');
  const mm = String(mes).padStart(2, '0');
  return { desde: `${m[1]}-${mm}-01`, hasta: `${m[1]}-${mm}-${dd}` };
}

/** El día siguiente a una fecha ISO, en UTC. Se usa para exigir continuidad sin huecos. */
function diaSiguiente(fecha: string): string {
  const d = new Date(`${fecha}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function rangoDe(opts: { periodo?: string; desde?: string; hasta?: string }): {
  desde: string;
  hasta: string;
} {
  if (opts.periodo) {
    if (opts.desde || opts.hasta) {
      throw new ValidationError(
        '`--period` y `--since/--until` dicen lo mismo de dos maneras: da una sola, o el ' +
          'rango que se use quedará a merced del orden en que se leyeron.'
      );
    }
    return rangoDelPeriodo(opts.periodo);
  }
  if (!opts.desde || !opts.hasta) {
    throw new ValidationError(
      'Falta el periodo de la sesión: da `--period YYYY-MM`, o `--since` y `--until` juntas.'
    );
  }
  const desde = assertFecha(opts.desde, '--since');
  const hasta = assertFecha(opts.hasta, '--until');
  if (hasta < desde) {
    throw new ValidationError(`El periodo termina (${hasta}) antes de empezar (${desde}).`);
  }
  return { desde, hasta };
}

// ============================================================
// LA CUENTA Y SU MARCO DE SIGNOS
// ============================================================

interface FilaCuenta {
  id: string;
  account_name: string;
  account_type: string;
  currency_code: string;
  gl_account_id: string;
  is_active: boolean;
  /** null cuando la cuenta de mayor NO pertenece a esta entidad. */
  gl_de_la_entidad: string | null;
}

async function cuentaDeLaEntidad(
  client: pg.PoolClient | null,
  entityId: string,
  bankAccountId: string
): Promise<FilaCuenta> {
  const sql = `SELECT b.id, b.account_name, b.account_type, b.currency_code,
                      b.gl_account_id, b.is_active,
                      a.id AS gl_de_la_entidad
                 FROM bank_accounts b
                 -- LEFT y con la entidad EN LA CONDICIÓN, igual que
                 -- bank-account-service: si un renglón heredado apunta al
                 -- catálogo de otra entidad, la cuenta se sigue viendo pero su
                 -- mapeo no, y aquí eso decide si el saldo de libros se pudo
                 -- observar o no. Sin esta comprobación la suma de más abajo
                 -- devolvería cero por no encontrar filas.
                 LEFT JOIN accounts a ON a.id = b.gl_account_id AND a.entity_id = b.entity_id
                WHERE b.id = $1 AND b.entity_id = $2`;
  const r = client
    ? await client.query<FilaCuenta>(sql, [bankAccountId, entityId])
    : await query<FilaCuenta>(sql, [bankAccountId, entityId]);
  if (r.rows.length === 0) throw new NotFoundError('Bank Account', bankAccountId);
  return r.rows[0];
}

/**
 * El saldo del extracto EN EL MARCO DEL MAYOR.
 *
 * Los dos lados de la conciliación tienen que hablar el mismo idioma de signos
 * o la resta compara dos cosas distintas. El mayor es el marco: contra la
 * cuenta de banco, un cargo (débito) es dinero que entró y un abono, dinero
 * que salió. Un extracto de cheques ya viene así.
 *
 * La TARJETA DE CRÉDITO no: es un PASIVO (051 lo dice en el CHECK de
 * `account_type`), su cuenta de mayor tiene saldo acreedor —negativo en el
 * marco débito-positivo— y el estado de cuenta publica lo que se DEBE como un
 * número positivo. Restar esos dos directamente produce una variación del
 * doble del saldo, todos los meses, sin que nada la explique. Se normaliza
 * aquí, en un solo punto y con nombre, y `EstadoDeSesion` publica los dos
 * números (`saldoBancoDeclarado` y `saldoBanco`) para que la conversión no sea
 * silenciosa: una corrección de signo invisible es peor que la diferencia que
 * corrige.
 */
export function enMarcoDelMayor(tipoDeCuenta: string, saldo: string): string {
  const d = new Decimal(saldo);
  return monto(tipoDeCuenta === 'credit-card' ? d.negated() : d);
}

// ============================================================
// EL EXTRACTO QUE SOSTIENE LA SESIÓN
// ============================================================

interface FilaExtracto {
  id: string;
  period_start: string;
  period_end: string;
  opening_balance: string;
  closing_balance: string;
  currency_code: string;
  statement_number: string | null;
}

const SELECT_EXTRACTO = `
  SELECT s.id, s.period_start::text AS period_start, s.period_end::text AS period_end,
         s.opening_balance::text AS opening_balance, s.closing_balance::text AS closing_balance,
         s.currency_code, s.statement_number
    FROM bank_statements s
    JOIN bank_accounts ba ON ba.id = s.bank_account_id AND ba.entity_id = s.entity_id`;

/**
 * Los extractos del periodo, en orden y CONTIGUOS.
 *
 * Un periodo mensual suele tener uno, pero un banco que publica semanalmente
 * tiene cuatro y la sesión sigue siendo del mes. En ese caso el saldo inicial
 * es el del PRIMERO y el final el del ÚLTIMO, y sólo vale si entre ellos no
 * falta ninguno: con un hueco, «saldo inicial del primero contra saldo final
 * del último» ignora en silencio los movimientos del extracto que no entró, y
 * la variación resultante parecería un descuadre de libros.
 */
async function extractosDelPeriodo(
  client: pg.PoolClient | null,
  entityId: string,
  bankAccountId: string,
  desde: string,
  hasta: string
): Promise<FilaExtracto[]> {
  const sql = `${SELECT_EXTRACTO}
      WHERE s.bank_account_id = $1 AND s.entity_id = $2
        AND s.period_start >= $3::date AND s.period_end <= $4::date
      ORDER BY s.period_start, s.period_end`;
  const params = [bankAccountId, entityId, desde, hasta];
  const r = client
    ? await client.query<FilaExtracto>(sql, params)
    : await query<FilaExtracto>(sql, params);
  return r.rows;
}

async function extractoPorId(
  client: pg.PoolClient | null,
  entityId: string,
  statementId: string
): Promise<FilaExtracto> {
  if (!UUID_RE.test(statementId)) throw new NotFoundError('Bank Statement', statementId);
  const sql = `${SELECT_EXTRACTO} WHERE s.id = $1 AND s.entity_id = $2`;
  const r = client
    ? await client.query<FilaExtracto>(sql, [statementId, entityId])
    : await query<FilaExtracto>(sql, [statementId, entityId]);
  if (r.rows.length === 0) throw new NotFoundError('Bank Statement', statementId);
  return r.rows[0];
}

// ============================================================
// `bank reconciliation open` — LA CONTINUIDAD, ASEVERADA
// ============================================================

export interface OpcionesApertura {
  /** Id o nombre de la cuenta bancaria, como los teclea un operador. */
  cuenta: string;
  periodo?: string;
  desde?: string;
  hasta?: string;
  /**
   * `--closing-balance`: el saldo final que el operador AFIRMA. No sustituye
   * al del extracto: se COMPARA con él, que es la defensa contra el archivo
   * truncado —un CSV cortado a la mitad parsea perfecto y da un extracto
   * plausible—. Es el mismo criterio que `bank statement import`.
   */
  saldoFinalDeclarado?: string;
  /** El extracto concreto, cuando el periodo tiene más de uno y no son contiguos. */
  statementId?: string;
  notas?: string;
}

export interface SesionAbierta {
  sesionId: string;
  cuenta: { id: string; nombre: string; tipo: string; moneda: string };
  desde: string;
  hasta: string;
  statementId: string;
  /** En el marco del mayor, ya normalizado. */
  saldoInicial: string;
  saldoFinalBanco: string;
  /** Tal como lo publica el extracto, antes de normalizar el signo. */
  saldoFinalDeclaradoPorElBanco: string;
  extractos: number;
  sesionAnterior: { id: string; hasta: string; saldoFinal: string } | null;
  avisos: string[];
  ensayo: boolean;
}

/**
 * `bank reconciliation open <account>`: abre la sesión del periodo ASEVERANDO
 * que el saldo inicial coincide exactamente con el cierre de la sesión
 * anterior, y rechazando huecos de fechas.
 *
 * Lo que había: `INSERT ... VALUES (..., 0, $6)` — `beginning_balance` FIJO EN
 * CERO (bank-reconciliation.ts:199), porque hasta la 051 no existía el
 * documento del que sacarlo. Ahora sale del extracto y la sesión queda atada a
 * él por `statement_id`; sin esa atadura la aritmética compara contra un cero
 * que significa «nadie restó nada».
 *
 * Las tres cosas que rechaza, y por qué ninguna es opcional:
 *   · TRASLAPE con otra sesión de la misma cuenta: el mismo movimiento
 *     quedaría explicado dos veces, cada vez en un cierre distinto.
 *   · HUECO respecto de la sesión anterior: un mes sin conciliar entre dos
 *     conciliados es dinero que nadie miró, y el tablero de cierre no lo
 *     distingue de un mes verificado.
 *   · DERIVA del saldo inicial: si el extracto abre con un saldo distinto del
 *     que la sesión anterior afirmó al cerrar, uno de los dos es falso. Cuál,
 *     no lo puede decidir este código.
 */
export async function abrirSesion(
  scope: Scope,
  opts: OpcionesApertura,
  ctx: ContextoSesion
): Promise<SesionAbierta> {
  const { entityId } = exigirEntidad(scope);
  const { desde, hasta } = rangoDe(opts);
  const referencia = await resolverCuentaBancaria(entityId, opts.cuenta);

  return ejecutarActo(async (client) => {
    const cuenta = await cuentaDeLaEntidad(client, entityId, referencia.id);
    if (!cuenta.is_active) {
      throw new ValidationError(
        `La cuenta ${cuenta.account_name} está archivada: no se abren sesiones de conciliación nuevas sobre ella.`
      );
    }

    const avisos: string[] = [];
    if (cuenta.account_type === 'petty-cash') {
      avisos.push(
        'Es una caja chica: se concilia contra ARQUEO, no contra extracto. La sesión se abre ' +
          'igual porque la maquinaria sirve, pero el saldo del "banco" será el que alguien contó.'
      );
    }
    if (cuenta.gl_de_la_entidad === null) {
      avisos.push(
        `La cuenta de mayor ${cuenta.gl_account_id} no pertenece al catálogo de esta entidad: ` +
          `el saldo de libros NO se podrá observar y la sesión no podrá cerrarse hasta que ` +
          `\`bank account set\` corrija el mapeo.`
      );
    }

    // ── El traslape, bajo candado sobre las sesiones de la cuenta ──
    const traslape = await client.query<{ id: string; start_date: string; end_date: string; status: string }>(
      `SELECT id, start_date::text AS start_date, end_date::text AS end_date, status
         FROM reconciliation_sessions
        WHERE bank_account_id = $1 AND entity_id = $2
          AND start_date <= $4::date AND end_date >= $3::date
        ORDER BY start_date
        FOR UPDATE`,
      [cuenta.id, entityId, desde, hasta]
    );
    if (traslape.rows.length > 0) {
      const t = traslape.rows[0];
      throw new ConflictError(
        `La cuenta ${cuenta.account_name} ya tiene la sesión ${t.id} (${t.start_date} → ` +
          `${t.end_date}, ${t.status}) traslapada con ${desde} → ${hasta}. Dos sesiones sobre ` +
          `las mismas fechas explican el mismo movimiento dos veces, cada una en un cierre distinto.`
      );
    }

    // ── La sesión anterior: continuidad de fechas y de saldo ──
    const anterior = await client.query<{
      id: string;
      end_date: string;
      ending_balance_per_bank: string;
      status: string;
    }>(
      `SELECT id, end_date::text AS end_date,
              ending_balance_per_bank::text AS ending_balance_per_bank, status
         FROM reconciliation_sessions
        WHERE bank_account_id = $1 AND entity_id = $2 AND end_date < $3::date
        ORDER BY end_date DESC
        LIMIT 1`,
      [cuenta.id, entityId, desde]
    );
    const previa = anterior.rows[0] ?? null;

    // ── El extracto del que salen los dos saldos ──
    const extractos = opts.statementId
      ? [await extractoPorId(client, entityId, opts.statementId)]
      : await extractosDelPeriodo(client, entityId, cuenta.id, desde, hasta);

    if (extractos.length === 0) {
      throw new ValidationError(
        `No hay ningún estado de cuenta importado para ${cuenta.account_name} entre ${desde} y ` +
          `${hasta}. La sesión saldría con el saldo inicial en cero —que es el defecto que este ` +
          `tramo vino a quitar—, así que no se abre: importa el extracto con ` +
          `\`bank statement import\` y vuelve.`
      );
    }
    for (let i = 1; i < extractos.length; i++) {
      const esperado = diaSiguiente(extractos[i - 1].period_end);
      if (extractos[i].period_start !== esperado) {
        throw new ConflictError(
          `Los estados de cuenta del periodo no son contiguos: el ${extractos[i - 1].id} termina ` +
            `el ${extractos[i - 1].period_end} y el siguiente empieza el ${extractos[i].period_start}, ` +
            `no el ${esperado}. Tomar el saldo inicial del primero y el final del último ignoraría ` +
            `en silencio los movimientos del extracto que falta.`
        );
      }
    }

    const primero = extractos[0];
    const ultimo = extractos[extractos.length - 1];
    if (ultimo.currency_code !== cuenta.currency_code) {
      throw new ValidationError(
        `El extracto ${ultimo.id} está en ${ultimo.currency_code} y la cuenta ` +
          `${cuenta.account_name} en ${cuenta.currency_code}: no se concilian dos monedas.`
      );
    }

    const saldoInicial = enMarcoDelMayor(cuenta.account_type, primero.opening_balance);
    const saldoFinal = enMarcoDelMayor(cuenta.account_type, ultimo.closing_balance);

    if (opts.saldoFinalDeclarado !== undefined) {
      const declarado = dec(opts.saldoFinalDeclarado, '--closing-balance');
      if (!declarado.equals(new Decimal(ultimo.closing_balance))) {
        throw new ValidationError(
          `El saldo final que afirmas (${monto(declarado)}) no es el que declara el extracto ` +
            `${ultimo.id} (${monto(new Decimal(ultimo.closing_balance))}). Uno de los dos está ` +
            `mal, y conciliar contra el equivocado produciría un cuadre falso.`
        );
      }
    }

    if (previa && !new Decimal(saldoInicial).equals(new Decimal(previa.ending_balance_per_bank))) {
      throw new ConflictError(
        `El extracto abre con ${saldoInicial} y la sesión anterior ${previa.id} cerró afirmando ` +
          `${monto(new Decimal(previa.ending_balance_per_bank))}: difieren en ` +
          `${monto(new Decimal(saldoInicial).minus(previa.ending_balance_per_bank))}. Uno de los ` +
          `dos números es falso, y cuál no lo puede decidir el programa: revisa el extracto ` +
          `anterior antes de abrir este mes.`
      );
    }
    if (previa && diaSiguiente(previa.end_date) !== desde) {
      throw new ConflictError(
        `La sesión anterior ${previa.id} termina el ${previa.end_date} y ésta empezaría el ` +
          `${desde}, no el ${diaSiguiente(previa.end_date)}. Un tramo sin conciliar entre dos ` +
          `conciliados es dinero que nadie miró, y el tablero de cierre no lo distingue de un ` +
          `mes verificado.`
      );
    }
    if (!previa) {
      avisos.push(
        'Es la primera sesión de esta cuenta: no hay cierre anterior contra el que aseverar la ' +
          'continuidad del saldo inicial. El saldo sale del extracto, y sólo de él.'
      );
    }

    const sesionId = uuidv4();
    await client.query(
      // `arithmetic_computed_at` se queda NULL a propósito: abrir no es
      // calcular. El CHECK `sesion_balanceada_con_aritmetica` de la 053 hace
      // que, con ese NULL, la fila no pueda llegar a 'balanced' por ninguna
      // puerta que no pase por `cerrarSesion`.
      `INSERT INTO reconciliation_sessions (
         id, bank_account_id, entity_id, start_date, end_date,
         beginning_balance, ending_balance_per_bank, statement_id, status, notes
       ) VALUES ($1, $2, $3, $4::date, $5::date, $6, $7, $8, 'in_progress', $9)`,
      [sesionId, cuenta.id, entityId, desde, hasta, saldoInicial, saldoFinal, ultimo.id, opts.notas ?? null]
    );

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      userId: ctx.userId,
      action: 'create',
      entityType: 'reconciliation_sessions',
      entityId: sesionId,
      newValues: {
        bank_account_id: cuenta.id,
        start_date: desde,
        end_date: hasta,
        beginning_balance: saldoInicial,
        ending_balance_per_bank: saldoFinal,
        statement_id: ultimo.id,
        sesion_anterior: previa?.id ?? null,
      },
      reason: opts.notas ?? null,
    });

    const resultado: SesionAbierta = {
      sesionId,
      cuenta: {
        id: cuenta.id,
        nombre: cuenta.account_name,
        tipo: cuenta.account_type,
        moneda: cuenta.currency_code,
      },
      desde,
      hasta,
      statementId: ultimo.id,
      saldoInicial,
      saldoFinalBanco: saldoFinal,
      saldoFinalDeclaradoPorElBanco: monto(new Decimal(ultimo.closing_balance)),
      extractos: extractos.length,
      sesionAnterior: previa
        ? {
            id: previa.id,
            hasta: previa.end_date,
            saldoFinal: monto(new Decimal(previa.ending_balance_per_bank)),
          }
        : null,
      avisos,
      ensayo: ctx.dryRun === true,
    };
    if (ctx.dryRun) throw new EnsayoSesion(resultado);
    return resultado;
  });
}

// ============================================================
// LA SESIÓN, LEÍDA
// ============================================================

interface FilaSesion {
  id: string;
  bank_account_id: string;
  entity_id: string;
  start_date: string;
  end_date: string;
  beginning_balance: string;
  ending_balance_per_bank: string;
  ending_balance_per_books: string;
  outstanding_checks: string;
  deposits_in_transit: string;
  bank_charges: string;
  bank_interest: string;
  other_adjustments: string;
  variance: string;
  status: string;
  statement_id: string | null;
  arithmetic_computed_at: string | null;
  closed_at: string | null;
  closed_by: string | null;
  approved_by: string | null;
  notes: string | null;
  created_at: string;
  account_name: string;
  account_type: string;
  currency_code: string;
}

const SELECT_SESION = `
  SELECT s.id, s.bank_account_id, s.entity_id,
         s.start_date::text AS start_date, s.end_date::text AS end_date,
         s.beginning_balance::text AS beginning_balance,
         s.ending_balance_per_bank::text AS ending_balance_per_bank,
         s.ending_balance_per_books::text AS ending_balance_per_books,
         s.outstanding_checks::text AS outstanding_checks,
         s.deposits_in_transit::text AS deposits_in_transit,
         s.bank_charges::text AS bank_charges,
         s.bank_interest::text AS bank_interest,
         s.other_adjustments::text AS other_adjustments,
         s.variance::text AS variance,
         s.status, s.statement_id,
         s.arithmetic_computed_at::text AS arithmetic_computed_at,
         s.closed_at::text AS closed_at, s.closed_by, s.approved_by, s.notes,
         s.created_at::text AS created_at,
         ba.account_name, ba.account_type, ba.currency_code
    FROM reconciliation_sessions s
    JOIN bank_accounts ba ON ba.id = s.bank_account_id AND ba.entity_id = s.entity_id`;

/**
 * La sesión, acotada por entidad DENTRO del SQL. Cero filas significa a la vez
 * «no existe» y «no es tuya», y las dos devuelven lo mismo.
 */
async function sesionDeLaEntidad(
  client: pg.PoolClient | null,
  entityId: string,
  sesionId: string,
  forUpdate = false
): Promise<FilaSesion> {
  if (!UUID_RE.test(sesionId)) throw new NotFoundError('Reconciliation session', sesionId);
  const sql = `${SELECT_SESION} WHERE s.id = $1 AND s.entity_id = $2${forUpdate ? ' FOR UPDATE OF s' : ''}`;
  const r = client
    ? await client.query<FilaSesion>(sql, [sesionId, entityId])
    : await query<FilaSesion>(sql, [sesionId, entityId]);
  if (r.rows.length === 0) throw new NotFoundError('Reconciliation session', sesionId);
  return r.rows[0];
}

/** La sesión EN CURSO de una cuenta, que es lo que `status` sin argumento quiere decir. */
async function sesionEnCursoDeLaCuenta(
  entityId: string,
  bankAccountId: string
): Promise<FilaSesion> {
  const r = await query<FilaSesion>(
    `${SELECT_SESION}
      WHERE s.bank_account_id = $1 AND s.entity_id = $2 AND s.status = 'in_progress'
      ORDER BY s.end_date DESC
      LIMIT 2`,
    [bankAccountId, entityId]
  );
  if (r.rows.length === 0) {
    throw new NotFoundError('Reconciliation session (in_progress)', bankAccountId);
  }
  if (r.rows.length > 1) {
    throw new ValidationError(
      'Esa cuenta tiene más de una sesión en curso: nombra cuál con ' +
        '`bank reconciliation status <session>`.'
    );
  }
  return r.rows[0];
}

// ============================================================
// LAS PARTIDAS Y LOS AJUSTES — QUE SON DE OTROS ARCHIVOS
//
// `reconciling-items.ts` es el dueño de las partidas conciliatorias: las
// descubre, las tipifica por su signo, las lista con su antigüedad y su
// escalamiento, y las reclasifica. `reconciliation-adjustments.ts` es el dueño
// de los ajustes como borradores. Este archivo LEE los dos y no reimplementa
// ninguno.
//
// Hubo una versión de este servicio que traía su propio lector de partidas y
// su propio levantamiento, y estaba mal por una razón concreta y no por
// estética: el descubrimiento de allá pregunta «¿tiene cotejo VIVO?» a
// `reconciliation_matches`, y el de aquí preguntaba por la caché
// `bank_transactions.is_matched`. Con la bandera desincronizada, `status`
// habría contado un movimiento sin explicar que `clasificarPartidas` no
// levanta —o al revés—, y dos verbos contestando cosas distintas sobre el
// mismo movimiento es exactamente el defecto que F05a costó tres veces.
// `movimientosSinExplicar`, más abajo, usa el MISMO criterio que ellos.
// ============================================================

/**
 * Los movimientos del extracto que NADIE explica: sin cotejo y sin partida que
 * los levante.
 *
 * ACUMULADO HASTA EL CIERRE DEL PERIODO, no sólo lo del periodo, y eso parece
 * un error hasta que se mira contra qué se compara. El saldo del banco es
 * acumulado y el de libros también, así que las dos correcciones tienen que
 * serlo: un cargo de marzo que en abril sigue sin registrarse ESTÁ dentro del
 * saldo que el banco publica en abril y NO está en los libros. Acotado al
 * periodo, ese movimiento desaparecería de las partidas y reaparecería como
 * una variación que nada explica —y el mes siguiente igual, cada vez más
 * grande—. El lado de libros ya es acumulado por la misma razón:
 * `listarPartidasDeLibros` devuelve el cheque de hace noventa días.
 *
 * `bank_transactions` no tiene entity_id, así que la frontera es el JOIN a
 * `bank_accounts` y va dentro del SQL. La suma se calcula aquí también porque
 * el conteo solo no dice nada: tres movimientos sin explicar de un peso y tres
 * de cien mil se cuentan igual.
 */
async function movimientosSinExplicar(
  client: pg.PoolClient | null,
  entityId: string,
  sesion: FilaSesion
): Promise<{ cuantos: number; importe: string }> {
  const sql = `SELECT COUNT(*)::text AS cuantos,
                      COALESCE(SUM(bt.amount), 0)::text AS importe
                 FROM bank_transactions bt
                 JOIN bank_accounts ba ON ba.id = bt.bank_account_id
                WHERE bt.bank_account_id = $1 AND ba.entity_id = $2
                  AND bt.transaction_date <= $3::date
                  -- «SIN COTEJO VIVO» SE LE PREGUNTA A LAS FILAS DE COTEJO, NO
                  -- A is_matched. La bandera es una caché que mantiene
                  -- match-service; el hecho son las filas con
                  -- unapplied_at IS NULL. Es el mismo criterio, literal, que
                  -- usa clasificarPartidas para decidir qué levanta: si aquí
                  -- se preguntara por la caché, status podría contar un
                  -- movimiento sin explicar que la clasificación no levanta, y
                  -- dos verbos contestando distinto sobre el mismo movimiento
                  -- es el defecto que este módulo ya pagó tres veces.
                  AND NOT EXISTS (
                        SELECT 1 FROM reconciliation_matches rm
                         WHERE rm.bank_transaction_id = bt.id
                           AND rm.unapplied_at IS NULL)
                  AND NOT EXISTS (
                        SELECT 1 FROM reconciling_items ri
                         WHERE ri.bank_transaction_id = bt.id
                           AND ri.reconciliation_session_id = $4
                           AND ri.entity_id = $2)`;
  const params = [sesion.bank_account_id, entityId, sesion.end_date, sesion.id];
  const r = client
    ? await client.query<{ cuantos: string; importe: string }>(sql, params)
    : await query<{ cuantos: string; importe: string }>(sql, params);
  return {
    cuantos: parseInt(r.rows[0].cuantos, 10),
    importe: monto(new Decimal(r.rows[0].importe)),
  };
}

/**
 * El SALDO DE LIBROS: Σ de las líneas POSTEADAS contra la cuenta de mayor de
 * la cuenta bancaria, hasta el cierre del periodo.
 *
 * Acumulado y no del periodo, porque el saldo del banco también lo es: sumar
 * sólo los movimientos del mes contra un saldo acumulado compararía una
 * variación con un stock.
 *
 * Devuelve `null` —y no cero— cuando la cuenta de mayor no pertenece a esta
 * entidad. Ahí la suma daría cero por no encontrar filas, y un cero que
 * significa «no hay dónde mirar» presentado como saldo es exactamente el
 * defecto que este tramo existe para impedir.
 *
 * `COALESCE` POR LADO y no sobre la resta: la 001 deja `debit_amount` y
 * `credit_amount` mutuamente excluyentes por CHECK, así que `debit − credit`
 * sobre una línea acreedora es NULL, que SUM ignora.
 */
async function saldoDeLibros(
  client: pg.PoolClient | null,
  entityId: string,
  cuenta: { id: string; gl_de_la_entidad: string | null },
  hasta: string
): Promise<string | null> {
  if (cuenta.gl_de_la_entidad === null) return null;
  const sql = `SELECT COALESCE(SUM(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)), 0)::text AS saldo
                 FROM journal_entry_lines l
                 JOIN journal_entries j ON j.id = l.journal_entry_id
                 -- Los DOS extremos acotados por la entidad, como en
                 -- book-items: el vínculo entre la cuenta bancaria y el mayor
                 -- es gl_account_id, y un mapeo mal capturado convertiría
                 -- esta suma en una ventana a los libros ajenos.
                 JOIN bank_accounts ba ON ba.gl_account_id = l.account_id
                WHERE ba.id = $1 AND ba.entity_id = $2 AND j.entity_id = $2
                  AND j.status = 'posted'
                  AND j.entry_date <= $3::date`;
  const params = [cuenta.id, entityId, hasta];
  const r = client
    ? await client.query<{ saldo: string }>(sql, params)
    : await query<{ saldo: string }>(sql, params);
  return monto(new Decimal(r.rows[0].saldo));
}

// ============================================================
// LOS DOS CRITERIOS DEL PANEL
// ============================================================

export interface CriteriosDeCierre {
  tolerancia: { valor: string; definido: boolean; tolerancia: string };
  lineaSinPartida: { valor: string; definido: boolean };
}

/**
 * Los dos lectores obligatorios de este tramo.
 *
 * `conciliacion_tolerancia` dice si «cuadrar» admite residual, y
 * `linea_banco_sin_partida_al_cierre` qué hacer con el movimiento del extracto
 * que nadie explica. Ninguna se pregunta en la línea de comandos: una
 * bifurcación de criterio contable se añade al panel y se lee de él.
 *
 * LA MAGNITUD DE LA TOLERANCIA NO ESTÁ EN EL PANEL, y no se inventa aquí. Con
 * `cero_exacto` la tolerancia es cero y `--tolerance` se RECHAZA —una bandera
 * no puede aflojar un criterio que el despacho ya fijó—. Con
 * `tolerancia_con_residual` el criterio existe pero nadie ha dicho cuánto, así
 * que la magnitud la aporta quien cierra, explícitamente, y sigue siendo cero
 * si no la aporta. Elegir un número por omisión aquí sería exactamente lo que
 * el panel existe para evitar.
 */
export async function criteriosDeCierre(
  tenantId: string,
  entityId: string,
  toleranciaPedida?: string
): Promise<CriteriosDeCierre> {
  const [tol, linea] = await Promise.all([
    getPolicy({ tenantId, entityId }, 'conciliacion_tolerancia'),
    getPolicy({ tenantId, entityId }, 'linea_banco_sin_partida_al_cierre'),
  ]);

  let tolerancia = '0';
  if (toleranciaPedida !== undefined) {
    if (tol.value !== 'tolerancia_con_residual') {
      throw new ValidationError(
        `La política \`conciliacion_tolerancia\` de este despacho está en "${tol.value}": la ` +
          `conciliación cierra con variación EXACTAMENTE cero y \`--tolerance\` no la afloja. ` +
          `Si el criterio tiene que cambiar, cámbialo donde vive: ` +
          `\`mnemosine pending resolve conciliacion_tolerancia\`.`
      );
    }
    const t = dec(toleranciaPedida, '--tolerance');
    if (t.isNegative()) {
      throw new ValidationError(
        `Tolerancia ilegible: "${toleranciaPedida}". Se espera un importe no negativo.`
      );
    }
    tolerancia = t.toFixed(4);
  }

  return {
    tolerancia: { valor: tol.value, definido: tol.defined, tolerancia },
    lineaSinPartida: { valor: linea.value, definido: linea.defined },
  };
}

// ============================================================
// `bank reconciliation status` — LA VARIACIÓN VIVA
// ============================================================

/**
 * Los reparos de la ARITMÉTICA más el único que es de la SESIÓN y no de la
 * resta: que el extracto haya cambiado bajo los pies de la sesión.
 *
 * Vive aquí y no en `reconciliation-math.ts` porque ese módulo no tiene —ni
 * debe tener— idea de que existe una tabla de extractos. Un módulo puro que
 * conociera el nombre de un documento habría dejado de serlo por la puerta de
 * atrás.
 */
export type CodigoDeReparoDeSesion = Reparo['codigo'] | 'deriva-del-extracto';

export interface ReparoDeSesion {
  codigo: CodigoDeReparoDeSesion;
  detalle: string;
}

export interface ResumenCongelado {
  variance: string;
  saldoLibros: string;
  chequesEnCirculacion: string;
  depositosEnTransito: string;
  cargosDelBanco: string;
  abonosDelBanco: string;
  otrosAjustes: string;
  /** Cuándo se hizo la aritmética que estas columnas congelan. `null` = nunca. */
  aritmeticaCalculadaEl: string | null;
}

export interface EstadoDeSesion {
  sesion: {
    id: string;
    cuenta: { id: string; nombre: string; tipo: string; moneda: string };
    desde: string;
    hasta: string;
    estado: EstadoDeSesionConciliacion;
    statementId: string | null;
    saldoInicial: string;
    cerradaEl: string | null;
    cerradaPor: string | null;
    aprobadaPor: string | null;
    notas: string | null;
  };
  aritmetica: Aritmetica;
  /** El saldo final tal como lo publica el extracto, antes de normalizar el signo. */
  saldoBancoDeclarado: string | null;
  partidas: PartidaConciliatoria[];
  /** Los ajustes que explican la sesión, como borradores. Se leen; no se crean aquí. */
  ajustes: AjusteDeSesion[];
  movimientosSinExplicar: { cuantos: number; importe: string };
  criterios: CriteriosDeCierre;
  /**
   * El RESUMEN CONGELADO de la fila, para contrastarlo con la aritmética viva
   * de arriba. Nunca es la respuesta: es la aseveración que se hizo.
   */
  congelado: ResumenCongelado;
  /**
   * Los reparos que, CON ESTAS POLÍTICAS, impiden cerrar. Es lo que `close`
   * comprueba, calculado en el mismo sitio para que `status` no pueda decir
   * «lista» sobre una sesión que `close` va a rechazar.
   */
  bloqueantes: ReparoDeSesion[];
  listaParaCerrar: boolean;
}

export interface OpcionesEstado {
  /** La sesión. Sin ella, la sesión EN CURSO de `cuenta`. */
  sesionId?: string;
  cuenta?: string;
  /** Sólo válida con la política de tolerancia en `tolerancia_con_residual`. */
  tolerancia?: string;
}

/**
 * `bank reconciliation status [<session>]`: la variación VIVA y el desglose de
 * la aritmética de dos lados.
 *
 * RECALCULA SIEMPRE. No lee `reconciliation_sessions.variance` como respuesta
 * —lo devuelve aparte, en `congelado`, para que se pueda contrastar—. Ésa es
 * la diferencia entera con lo que había: la ruta REST proyectaba la columna
 * tal cual y su propio comentario avisaba de que valía su DEFAULT 0.
 */
export async function estadoDeSesion(
  scope: Scope,
  opts: OpcionesEstado = {}
): Promise<EstadoDeSesion> {
  const { tenantId, entityId } = exigirEntidad(scope);

  let sesion: FilaSesion;
  if (opts.sesionId) {
    sesion = await sesionDeLaEntidad(null, entityId, opts.sesionId);
  } else if (opts.cuenta) {
    const ref = await resolverCuentaBancaria(entityId, opts.cuenta);
    sesion = await sesionEnCursoDeLaCuenta(entityId, ref.id);
  } else {
    throw new ValidationError(
      'Di qué sesión: `bank reconciliation status <session>`, o `--account` para la que esté en curso.'
    );
  }

  const criterios = await criteriosDeCierre(tenantId, entityId, opts.tolerancia);
  return leerEstado(null, entityId, sesion, criterios);
}

/**
 * El cuerpo compartido por `status` y `close`. Los dos tienen que ver
 * EXACTAMENTE lo mismo: si `status` calculara por un camino y `close` por
 * otro, la superficie diría «lista para cerrar» sobre una sesión que el cierre
 * rechaza, y nadie sabría cuál de las dos miente.
 */
async function leerEstado(
  client: pg.PoolClient | null,
  entityId: string,
  sesion: FilaSesion,
  criterios: CriteriosDeCierre
): Promise<EstadoDeSesion> {
  const cuenta = await cuentaDeLaEntidad(client, entityId, sesion.bank_account_id);

  // EL SALDO DEL BANCO SALE DEL EXTRACTO, VIVO, y no de la columna de la
  // sesión. Sin `statement_id` no hay de dónde sacarlo, y ahí `null` es la
  // respuesta honesta: las sesiones que abrió la ruta REST no tienen extracto
  // atado y su `beginning_balance` estaba fijo en cero.
  let saldoBancoDeclarado: string | null = null;
  let saldoBanco: string | null = null;
  const derivas: string[] = [];
  if (sesion.statement_id) {
    const extracto = await extractoPorId(client, entityId, sesion.statement_id);
    saldoBancoDeclarado = monto(new Decimal(extracto.closing_balance));
    saldoBanco = enMarcoDelMayor(cuenta.account_type, extracto.closing_balance);
    // LA DERIVA: el extracto pudo reimportarse después de abrir la sesión. Si
    // el saldo cambió, lo que la sesión afirma y lo que el documento dice ya
    // no son lo mismo, y conciliar contra el viejo sería conciliar contra algo
    // que ya no existe.
    if (!new Decimal(saldoBanco).equals(new Decimal(sesion.ending_balance_per_bank))) {
      derivas.push(
        `El extracto ${extracto.id} cierra hoy en ${saldoBanco} y la sesión se abrió afirmando ` +
          `${monto(new Decimal(sesion.ending_balance_per_bank))}. La aritmética de abajo usa el ` +
          `documento, que es la evidencia; la diferencia hay que explicarla antes de cerrar.`
      );
    }
  }

  const saldoLibros = await saldoDeLibros(client, entityId, cuenta, sesion.end_date);
  // LAS PARTIDAS Y LOS AJUSTES SE LEEN POR EL POOL AUNQUE HAYA TRANSACCIÓN, y
  // es seguro por el candado y no por suerte: el único llamador transaccional
  // es `close`, que tiene la fila de la sesión tomada `FOR UPDATE`, y
  // `clasificarPartidas` toma ese mismo candado antes de escribir una sola
  // partida. Mientras `close` lo sostiene, nadie puede confirmar partidas
  // nuevas de esta sesión, así que la lectura por el pool ve el mismo mundo
  // que la del cliente. Y `close` no escribe partidas —sólo verifica—, así que
  // tampoco hay escritura propia que la lectura pudiera no ver.
  const partidas = await listarPartidas(entityId, sesion.id, { incluirResueltas: true });
  const ajustes = await listarAjustes(entityId, sesion.id);
  const sinExplicar = await movimientosSinExplicar(client, entityId, sesion);

  const aritmetica = calcularAritmetica({
    saldoBanco,
    saldoLibros,
    partidas: paraAritmetica(partidas),
    movimientosSinExplicar: sinExplicar.cuantos,
    tolerancia: criterios.tolerancia.tolerancia,
  });

  const bloqueantes = reparosQueBloquean(aritmetica, criterios, derivas);

  return {
    sesion: {
      id: sesion.id,
      cuenta: {
        id: cuenta.id,
        nombre: cuenta.account_name,
        tipo: cuenta.account_type,
        moneda: cuenta.currency_code,
      },
      desde: sesion.start_date,
      hasta: sesion.end_date,
      estado: sesion.status as EstadoDeSesionConciliacion,
      statementId: sesion.statement_id,
      saldoInicial: monto(new Decimal(sesion.beginning_balance)),
      cerradaEl: sesion.closed_at,
      cerradaPor: sesion.closed_by,
      aprobadaPor: sesion.approved_by,
      notas: sesion.notes,
    },
    aritmetica,
    saldoBancoDeclarado,
    partidas,
    ajustes,
    movimientosSinExplicar: sinExplicar,
    criterios,
    congelado: {
      variance: monto(new Decimal(sesion.variance)),
      saldoLibros: monto(new Decimal(sesion.ending_balance_per_books)),
      chequesEnCirculacion: monto(new Decimal(sesion.outstanding_checks)),
      depositosEnTransito: monto(new Decimal(sesion.deposits_in_transit)),
      cargosDelBanco: monto(new Decimal(sesion.bank_charges)),
      abonosDelBanco: monto(new Decimal(sesion.bank_interest)),
      otrosAjustes: monto(new Decimal(sesion.other_adjustments)),
      aritmeticaCalculadaEl: sesion.arithmetic_computed_at,
    },
    bloqueantes,
    listaParaCerrar: bloqueantes.length === 0,
  };
}

/**
 * De HECHOS a VEREDICTO: qué reparos impiden cerrar bajo estas políticas.
 *
 * La aritmética levanta reparos y no decide; el veredicto es de aquí, porque
 * depende del panel. El único reparo que una política puede indultar es
 * `linea-de-banco-sin-explicar`, y sólo para que la línea se ARRASTRE como
 * partida conciliatoria —lo que, al no tener fecha esperada, la deja
 * bloqueando por `partida-sin-fechar` hasta que alguien la asuma—. Ni la
 * variación ni las partidas sin clasificar se indultan por política: la fila
 * 1247 del catálogo pide variación exactamente cero y toda partida clasificada
 * y fechada, y la tolerancia ya entró antes, dentro de la aritmética.
 */
function reparosQueBloquean(
  aritmetica: Aritmetica,
  criterios: CriteriosDeCierre,
  derivas: string[]
): ReparoDeSesion[] {
  const bloqueantes: ReparoDeSesion[] = [];
  for (const r of aritmetica.reparos) {
    if (r.codigo === 'linea-de-banco-sin-explicar') {
      if (criterios.lineaSinPartida.valor === 'partida_conciliatoria') {
        // LO QUE LA POLÍTICA AHORRA Y LO QUE NO. Con este criterio la línea no
        // necesita que una persona diga qué es: `clasificarPartidas` la
        // tipifica por su signo —cargo o abono del banco— y ahí está el ahorro
        // frente a `bloquear_cierre`. Lo que ningún programa puede hacer es
        // FECHARLA: la fecha esperada es la promesa de alguien, y una promesa
        // que puso el programa no la cumple nadie. La fila 1247 pide toda
        // partida clasificada Y FECHADA, así que la línea sigue impidiendo el
        // cierre —primero por no estar levantada, después por no estar
        // fechada—, y en los dos casos lo que falta se nombra.
        bloqueantes.push({
          codigo: r.codigo,
          detalle:
            `${r.detalle} Con "partida_conciliatoria" no hace falta que nadie diga qué son: ` +
            `\`bank reconciliation run\` las levanta y las tipifica por su signo. Lo que sí hace ` +
            `falta después es fecharlas y asignarles responsable, y eso no lo puede inventar el ` +
            `programa.`,
        });
        continue;
      }
      if (criterios.lineaSinPartida.valor === 'suspenso') {
        bloqueantes.push({
          codigo: r.codigo,
          detalle:
            `${r.detalle} La política de este despacho es "suspenso", y llevar una línea a una ` +
            `cuenta puente exige CONTABILIZAR, que es F05d (\`bank reconciliation post\`). ` +
            `Mientras tanto no se cierra: parkear la diferencia sin asiento la escondería detrás ` +
            `de un saldo sin dejar rastro.`,
        });
        continue;
      }
    }
    bloqueantes.push(r);
  }
  // La deriva del extracto bloquea SIEMPRE y no la indulta ninguna política:
  // si el documento cambió después de abrir la sesión, lo que la sesión afirma
  // y lo que la evidencia dice ya no son lo mismo, y ninguna tolerancia cubre
  // eso.
  for (const deriva of derivas) {
    bloqueantes.push({ codigo: 'deriva-del-extracto', detalle: deriva });
  }
  return bloqueantes;
}

// ============================================================
// `bank reconciliation list`
// ============================================================

export interface FiltrosSesiones {
  cuenta?: string;
  estado?: EstadoDeSesionConciliacion;
  periodo?: string;
  desde?: string;
  hasta?: string;
  limit?: number;
}

export interface RenglonSesion {
  id: string;
  entityId: string;
  cuenta: string;
  cuentaId: string;
  moneda: string;
  desde: string;
  hasta: string;
  estado: EstadoDeSesionConciliacion;
  saldoInicial: string;
  saldoFinalBanco: string;
  /** El CONGELADO, con su etiqueta: `null` mientras nadie haya hecho la aritmética. */
  varianceCongelada: string | null;
  aritmeticaCalculadaEl: string | null;
  partidasAbiertas: number;
  creadaEl: string;
}

/**
 * `bank reconciliation list`: sesiones por cuenta, estado y periodo. Con
 * alcance de inquilino —`--all-entities`— es la vista de despacho.
 *
 * `varianceCongelada` sale `null` cuando `arithmetic_computed_at` es NULL, y
 * ése es el punto entero: la columna vale 0 en toda sesión que nadie calculó,
 * y proyectar ese cero en una lista es cómo «no verificado» se lee como
 * «cuadra». Un listado no tiene sitio para un párrafo de contexto; tiene sitio
 * para un hueco.
 */
export async function listarSesiones(
  scope: Scope,
  filtros: FiltrosSesiones = {}
): Promise<RenglonSesion[]> {
  const alcance = await condicionDeAlcance('reconciliation_sessions', scope, 1);
  const cond = [alcance.sql.replace(/\bentity_id\b/, 's.entity_id')];
  const params: unknown[] = [alcance.valor];
  let i = 2;

  if (filtros.cuenta) {
    if (scope.kind !== 'entity') {
      throw new ValidationError(
        '`--account` resuelve un nombre dentro de UNA entidad y el alcance es de inquilino: ' +
          'dos entidades pueden llamar igual a su cuenta operativa. Usa el identificador, o quita `--all-entities`.'
      );
    }
    const ref = await resolverCuentaBancaria(scope.entityId, filtros.cuenta);
    cond.push(`s.bank_account_id = $${i++}`);
    params.push(ref.id);
  }
  if (filtros.estado) {
    if (!(ESTADOS_DE_SESION as readonly string[]).includes(filtros.estado)) {
      throw new ValidationError(
        `Estado desconocido: "${filtros.estado}". Los admitidos son: ${ESTADOS_DE_SESION.join(', ')}.`
      );
    }
    cond.push(`s.status = $${i++}`);
    params.push(filtros.estado);
  }
  const rango = filtros.periodo
    ? rangoDelPeriodo(filtros.periodo)
    : {
        desde: filtros.desde ? assertFecha(filtros.desde, '--since') : null,
        hasta: filtros.hasta ? assertFecha(filtros.hasta, '--until') : null,
      };
  if (rango.desde) {
    cond.push(`s.end_date >= $${i++}::date`);
    params.push(rango.desde);
  }
  if (rango.hasta) {
    cond.push(`s.start_date <= $${i++}::date`);
    params.push(rango.hasta);
  }

  const limite = Math.min(Math.max(filtros.limit ?? 50, 1), LIMITE_SESIONES);
  params.push(limite);

  const r = await query<FilaSesion & { partidas_abiertas: string }>(
    // El conteo de partidas abiertas va por LATERAL con la ENTIDAD REPETIDA en
    // la condición (`ri.entity_id = x.entity_id`): con alcance de inquilino la
    // consulta atraviesa varias entidades a la vez, y un conteo que sólo
    // casara por `reconciliation_session_id` contaría bien por accidente —
    // porque el id es único— en vez de por construcción.
    `SELECT x.*, COALESCE(p.n, 0)::text AS partidas_abiertas
       FROM (${SELECT_SESION}
              WHERE ${cond.join(' AND ')}) x
       LEFT JOIN LATERAL (
         SELECT COUNT(*) AS n
           FROM reconciling_items ri
          WHERE ri.reconciliation_session_id = x.id
            AND ri.entity_id = x.entity_id
            AND ri.resuelta_at IS NULL
       ) p ON TRUE
      ORDER BY x.account_name, x.start_date DESC
      LIMIT $${i}`,
    params
  );

  return r.rows.map((f) => ({
    id: f.id,
    entityId: f.entity_id,
    cuenta: f.account_name,
    cuentaId: f.bank_account_id,
    moneda: f.currency_code,
    desde: f.start_date,
    hasta: f.end_date,
    estado: f.status as EstadoDeSesionConciliacion,
    saldoInicial: monto(new Decimal(f.beginning_balance)),
    saldoFinalBanco: monto(new Decimal(f.ending_balance_per_bank)),
    varianceCongelada: f.arithmetic_computed_at ? monto(new Decimal(f.variance)) : null,
    aritmeticaCalculadaEl: f.arithmetic_computed_at,
    partidasAbiertas: parseInt(f.partidas_abiertas, 10),
    creadaEl: f.created_at,
  }));
}

// ============================================================
// CLASIFICAR — UN PASO DE `run`, PRESTADO ENTERO
//
// `clasificarPartidas` vive en `reconciling-items.ts` y va sobre el CLIENTE de
// una transacción, no sobre el pool, porque descubrir es escribir: sus dos
// lecturas y todos sus INSERT tienen que ver el mismo mundo y caer juntos.
// Aquí sólo se le pone alrededor lo que este archivo aporta —el alcance de
// entidad, la transacción y el ensayo— sin tocar lo que decide.
// ============================================================

/**
 * NO DEVUELVE LA LISTA COMPLETA DE PARTIDAS, y no es un olvido. Leerla aquí
 * exigiría releer dentro de la transacción —por el pool no vería sus propios
 * INSERT, que aún no están confirmados— y eso obligaría a duplicar el SELECT
 * que `reconciling-items` ya tiene. Quien quiera la lista la pide después con
 * `bank reconciling-item list` o `status`, que es lo que hace `run`.
 */
export interface ResultadoClasificacion extends ResultadoDeClasificacion {
  ensayo: boolean;
}

/**
 * El paso `partidas` del pase guiado, como verbo propio para que `run` no sea
 * la única forma de ejercitarlo.
 */
export async function clasificarPartidasDeSesion(
  scope: Scope,
  sesionId: string,
  ctx: ContextoSesion
): Promise<ResultadoClasificacion> {
  const { entityId } = exigirEntidad(scope);

  return ejecutarActo(async (client) => {
    const clasificacion = await clasificarPartidas(client, entityId, sesionId, ctx.userId);

    if (clasificacion.levantadas.length > 0) {
      await registrarAuditoria(client, {
        tenantId: await tenantDe(client, entityId),
        userId: ctx.userId,
        action: 'update',
        entityType: 'reconciliation_sessions',
        entityId: sesionId,
        newValues: {
          levantadas: clasificacion.levantadas.length,
          sin_fecha_esperada: clasificacion.sinFechaEsperada,
          tope_alcanzado: clasificacion.topeAlcanzado,
        },
        reason: 'clasificación de partidas conciliatorias',
      });
    }

    const resultado: ResultadoClasificacion = {
      ...clasificacion,
      ensayo: ctx.dryRun === true,
    };
    if (ctx.dryRun) throw new EnsayoSesion(resultado);
    return resultado;
  });
}

// ============================================================
// `bank reconciliation close` — DONDE `balanced` EMPIEZA A SIGNIFICAR ALGO
// ============================================================

export interface OpcionesCierre {
  /** Sólo admisible con `conciliacion_tolerancia` en `tolerancia_con_residual`. */
  tolerancia?: string;
  notas?: string;
}

export interface ResultadoCierre {
  sesionId: string;
  estado: EstadoDeSesionConciliacion;
  aritmetica: Aritmetica;
  /** Lo que se escribió en las columnas escalares. La aseveración, no la respuesta. */
  congelado: ResumenCongelado;
  criterios: CriteriosDeCierre;
  ensayo: boolean;
}

/**
 * `bank reconciliation close <session>`: recalcula la aritmética completa y
 * mueve la sesión a `balanced` SÓLO si la variación es exactamente cero (o cabe
 * en la tolerancia que el panel admita) y toda partida está clasificada y
 * fechada.
 *
 * Lo que había era un UPDATE incondicional. Lo que hay ahora, en orden:
 *
 *   1. Se toma la fila BAJO CANDADO y se exige que esté `in_progress`. Cerrar
 *      dos veces no es idempotente: la segunda escribiría un resumen distinto
 *      sobre una aseveración ya firmada.
 *   2. Se leen los dos criterios del panel. Deciden QUÉ SE EXIGE, no qué se
 *      hace: `close` verifica y no descubre, así que ninguna política le da
 *      permiso para levantar partidas por su cuenta. Eso es de `run`.
 *   3. Se recalcula la aritmética ENTERA con el mismo código que `status`.
 *   4. Si queda un solo reparo bloqueante, se rehúsa NOMBRÁNDOLOS TODOS. Un
 *      rechazo que sólo dice «no cuadra» obliga a rehacer la resta a mano.
 *   5. Se escribe `arithmetic_computed_at` EN LA MISMA SENTENCIA que mueve el
 *      estado. El CHECK `sesion_balanceada_con_aritmetica` de la 053 exige esa
 *      compañía, así que ninguna otra puerta puede dejar la fila en `balanced`
 *      sin que alguien haya hecho la aritmética.
 *   6. Se congela el resumen en las seis columnas escalares de la 003 —FIRMADO,
 *      igual que las filas de las que sale— y `variance` guarda el residual
 *      REAL, nunca un cero de cortesía.
 */
export async function cerrarSesion(
  scope: Scope,
  sesionId: string,
  opts: OpcionesCierre,
  ctx: ContextoSesion
): Promise<ResultadoCierre> {
  const { tenantId, entityId } = exigirEntidad(scope);

  return ejecutarActo(async (client) => {
    const sesion = await sesionDeLaEntidad(client, entityId, sesionId, true);
    if (sesion.status !== 'in_progress') {
      throw new ConflictError(
        `La sesión ${sesionId} ya está en '${sesion.status}': cerrarla otra vez escribiría un ` +
          `resumen distinto encima de una aseveración ya hecha. Para rehacerla hace falta ` +
          `reabrirla, que deja constancia del delta.`
      );
    }

    // LOS CRITERIOS SE LEEN UNA VEZ y se pasan al lector de estado. Leerlos
    // dos veces abriría una ventana —minúscula, pero real— en la que `close`
    // decide levantar partidas con una política y juzga el resultado con otra,
    // si alguien resuelve el panel justo en medio.
    // `close` VERIFICA; NO DESCUBRE.
    //
    // Hubo una versión que levantaba aquí mismo las líneas sin explicar cuando
    // la política decía `partida_conciliatoria`, y era mala idea por dos
    // razones que apuntan al mismo sitio. La primera es de forma: el verbo que
    // firma la aseveración no puede ser también el que decide qué es cada
    // línea, o la aseveración se está firmando a sí misma. La segunda es de
    // fondo: `close` juzga con la aritmética que acaba de leer, y una
    // clasificación hecha en la misma transacción obligaría a releer dentro de
    // ella para verse a sí misma. Descubrir es de `run`. Aquí la política sólo
    // decide QUÉ SE EXIGE.
    const criterios = await criteriosDeCierre(tenantId, entityId, opts.tolerancia);
    const estado = await leerEstado(client, entityId, sesion, criterios);
    const a = estado.aritmetica;

    if (estado.bloqueantes.length > 0) {
      throw new ValidationError(
        `La sesión ${sesionId} no cierra. ` +
          `Banco ajustado ${a.banco.ajustado ?? 'sin observar'} contra libros ajustado ` +
          `${a.libros.ajustado ?? 'sin observar'}; variación ` +
          `${a.variacion ?? 'NO CALCULADA (no es cero: es que falta un lado)'}.\n` +
          estado.bloqueantes.map((r) => `  · [${r.codigo}] ${r.detalle}`).join('\n') +
          `\nMarcarla "balanced" con esto abierto le diría al tablero de cierre que el efectivo ` +
          `de esta cuenta está verificado contra el banco.`
      );
    }
    // Cinturón sobre tirantes: `bloqueantes` ya lo cubre, pero el CHECK de la
    // 053 y esta guarda dicen lo mismo desde dos capas, y la afirmación que se
    // está a punto de firmar la lee `period-close.ts` como evidencia.
    if (a.variacion === null || !a.cuadra) {
      throw new ValidationError(
        `La sesión ${sesionId} no cierra: la variación es ` +
          `${a.variacion ?? 'NO CALCULADA'} y la tolerancia vigente es ${a.tolerancia}.`
      );
    }

    const congelado = congelar(a, sesion);
    const escrito = await client.query<{ arithmetic_computed_at: string }>(
      // `arithmetic_computed_at` y `status` en la MISMA sentencia: el CHECK de
      // la 053 no admite lo uno sin lo otro, y separarlos abriría una ventana
      // en la que la fila diría 'balanced' sin aritmética.
      //
      // `status = 'in_progress'` en el WHERE hace la escritura segura frente a
      // dos cierres concurrentes: el segundo actualiza cero filas.
      `UPDATE reconciliation_sessions
          SET status = 'balanced',
              arithmetic_computed_at = NOW(),
              closed_at = NOW(),
              closed_by = $2,
              completed_at = NOW(),
              completed_by = $2,
              ending_balance_per_books = $3,
              outstanding_checks = $4,
              deposits_in_transit = $5,
              bank_charges = $6,
              bank_interest = $7,
              other_adjustments = $8,
              variance = $9,
              notes = COALESCE($10, notes),
              updated_at = NOW()
        WHERE id = $1 AND entity_id = $11 AND status = 'in_progress'
        RETURNING arithmetic_computed_at::text AS arithmetic_computed_at`,
      [
        sesionId,
        ctx.userId,
        congelado.saldoLibros,
        congelado.chequesEnCirculacion,
        congelado.depositosEnTransito,
        congelado.cargosDelBanco,
        congelado.abonosDelBanco,
        congelado.otrosAjustes,
        congelado.variance,
        opts.notas ?? null,
        entityId,
      ]
    );
    if (escrito.rowCount !== 1) {
      // El candado de arriba lo hace improbable, pero «improbable» no es una
      // garantía y esta fila la lee `period-close.ts` como evidencia: si el
      // UPDATE no tocó exactamente una fila, alguien cerró en paralelo y este
      // camino no puede afirmar nada.
      throw new ConflictError(
        `La sesión ${sesionId} cambió de estado mientras se cerraba: el cierre no escribió ` +
          `ninguna fila. Vuelve a mirarla con \`bank reconciliation status\` antes de reintentar.`
      );
    }

    await registrarAuditoria(client, {
      tenantId,
      userId: ctx.userId,
      action: 'close',
      entityType: 'reconciliation_sessions',
      entityId: sesionId,
      oldValues: { status: sesion.status, variance: sesion.variance },
      newValues: {
        status: 'balanced',
        variance: congelado.variance,
        ending_balance_per_books: congelado.saldoLibros,
        saldo_banco_ajustado: a.banco.ajustado,
        saldo_libros_ajustado: a.libros.ajustado,
        tolerancia: a.tolerancia,
        politica_tolerancia: criterios.tolerancia.valor,
        politica_linea_sin_partida: criterios.lineaSinPartida.valor,
      },
      reason: opts.notas ?? null,
    });

    const resultado: ResultadoCierre = {
      sesionId,
      estado: 'balanced',
      aritmetica: a,
      // La marca que salió DE LA BASE, no una que este proceso invente: es la
      // que el CHECK de la 053 acaba de aceptar.
      congelado: { ...congelado, aritmeticaCalculadaEl: escrito.rows[0].arithmetic_computed_at },
      criterios: estado.criterios,
      ensayo: ctx.dryRun === true,
    };
    if (ctx.dryRun) throw new EnsayoSesion(resultado);
    return resultado;
  });
}

/**
 * El resumen que se congela en las seis columnas escalares de la 003.
 *
 * VA FIRMADO, igual que las filas de las que sale. Guardar magnitudes
 * obligaría a cada lector futuro a recordar que «cheques en circulación resta»
 * — que es exactamente la regla que la 053 sacó de los lectores y metió en el
 * dato. Un informe que sume estas seis columnas y el saldo tiene que poder
 * reconstruir la variación sin saber nada de conciliaciones:
 *
 *   variance = (ending_balance_per_bank + outstanding_checks + deposits_in_transit)
 *            − (ending_balance_per_books + bank_charges + bank_interest)
 *            + other_adjustments
 *
 * LOS DOS ERRORES CABEN EN UNA SOLA COLUMNA, PERO NO SUMADOS. `other_adjustments`
 * es el único hueco que queda para los dos tipos de error, y los dos van a
 * lados CONTRARIOS: `error-del-banco` corrige el saldo del banco y
 * `error-de-libros` el de libros, así que en la resta uno entra con `+` y el
 * otro con `−`. Sumarlos —que es lo que hacía este cuerpo— produce un escalar
 * que NO reconstruye nada: con un error del banco de +100 y uno de libros de
 * +100 la variación es exactamente cero y la columna decía 200, un número que
 * ningún lector futuro puede repartir entre los dos lados porque la columna ya
 * perdió de cuál venía cada mitad. Se guarda la APORTACIÓN NETA a la variación,
 * que es lo mismo que hace `reconciling_items.importe` con el signo: la regla
 * vive en el dato y no en la cabeza del que lo lea.
 */
function congelar(a: Aritmetica, sesion: FilaSesion): ResumenCongelado {
  const de = (tipo: TipoDePartida): string => {
    const banco = a.banco.partidas.find((p) => p.tipo === tipo);
    const libros = a.libros.partidas.find((p) => p.tipo === tipo);
    return (banco ?? libros)?.importe ?? '0.00';
  };
  const errores = new Decimal(de('error-del-banco')).minus(de('error-de-libros'));
  return {
    variance: a.variacion ?? monto(new Decimal(sesion.variance)),
    saldoLibros: a.libros.saldo ?? monto(new Decimal(sesion.ending_balance_per_books)),
    chequesEnCirculacion: de('cheque-en-circulacion'),
    depositosEnTransito: de('deposito-en-transito'),
    cargosDelBanco: de('cargo-del-banco'),
    abonosDelBanco: de('abono-del-banco'),
    otrosAjustes: monto(errores),
    aritmeticaCalculadaEl: null,
  };
}

// ============================================================
// `bank reconciliation run` — EL PASE GUIADO QUE SE DETIENE A TIEMPO
// ============================================================

export const PASOS_DE_CORRIDA = ['extracto', 'cotejo', 'sesion', 'partidas', 'estado'] as const;
export type PasoDeCorrida = (typeof PASOS_DE_CORRIDA)[number];

export interface ResultadoPaso {
  paso: PasoDeCorrida;
  hecho: boolean;
  /** En español: qué pasó, o por qué no se pudo. */
  detalle: string;
}

export interface OpcionesCorridaGuiada {
  cuenta: string;
  periodo?: string;
  desde?: string;
  hasta?: string;
  /** `--file`: importa el extracto. Sin él, se toma el que ya esté importado. */
  archivo?: string;
  formato?: string;
  perfil?: string;
  minConfianza?: number;
  maxMonto?: string;
  /** `--stop-at`: hasta dónde llegar. Nunca más allá de `estado`. */
  detenerEn?: PasoDeCorrida;
  /** `--resume`: reutiliza la sesión en curso del periodo en vez de exigir una nueva. */
  reanudar?: boolean;
  /** El puerto del lector de formatos. Obligatorio sólo si hay `--file`. */
  leer?: LeerExtracto;
  notas?: string;
}

export interface ResultadoCorridaGuiada {
  cuenta: { id: string; nombre: string };
  desde: string;
  hasta: string;
  pasos: ResultadoPaso[];
  importacion: ResultadoImportacion | null;
  cotejo: ResultadoCorrida | null;
  sesionId: string | null;
  clasificacion: ResultadoClasificacion | null;
  estado: EstadoDeSesion | null;
  /** Lo que falta para poder cerrar, en español y con los números dentro. */
  loQueFalta: string[];
  /**
   * SIEMPRE cierto. Se devuelve como dato y no sólo como texto para que
   * ninguna superficie —ni un agente— pueda leer esta corrida como si hubiera
   * aprobado o contabilizado algo.
   */
  detenidaAntesDeAprobar: true;
  ensayo: boolean;
}

/**
 * `bank reconciliation run <account>`: el pase guiado del mes.
 *
 * ORQUESTA, NO REIMPLEMENTA. Cada paso es un servicio que ya existe y que ya
 * tiene sus propias guardas: `importarEstadoDeCuenta` (F05a) deduplica por hash
 * de documento y de línea y corre las siete pruebas; `correrCotejo` (F05b)
 * comprueba Σbanco = Σlibros + Σajustes antes de escribir y respeta el piso de
 * confianza; `abrirSesion` asevera la continuidad. Reescribir cualquiera de
 * los tres aquí habría duplicado sus invariantes en un sitio donde envejecen.
 *
 * NO ES UNA TRANSACCIÓN, y no puede serlo: cada paso es atómico por su cuenta
 * —el import abre la suya, el cotejo propone fuera y aplica dentro— y un mes
 * entero bajo un solo candado retendría la cuenta durante toda la corrida. Por
 * eso existe `--resume`: si un paso falla, lo hecho hasta ahí está hecho y la
 * corrida se retoma, en vez de deshacer un import de tres mil líneas porque el
 * cotejo tropezó.
 *
 * SE DETIENE SIEMPRE ANTES DE `approve` Y DE `post`. No es una omisión ni un
 * pendiente: aprobar exige que el aprobador no sea el preparador y contabilizar
 * mueve el mayor. Ninguna de las dos cosas la hace un pase automático, y por
 * eso `detenidaAntesDeAprobar` viaja en el resultado como dato.
 */
export async function correrConciliacion(
  scope: Scope,
  opts: OpcionesCorridaGuiada,
  ctx: ContextoSesion
): Promise<ResultadoCorridaGuiada> {
  const { tenantId, entityId } = exigirEntidad(scope);
  const { desde, hasta } = rangoDe(opts);
  const cuenta = await resolverCuentaBancaria(entityId, opts.cuenta);
  const hastaDonde = opts.detenerEn ?? 'estado';
  const alcanza = (paso: PasoDeCorrida): boolean =>
    PASOS_DE_CORRIDA.indexOf(paso) <= PASOS_DE_CORRIDA.indexOf(hastaDonde);

  const pasos: ResultadoPaso[] = [];
  const loQueFalta: string[] = [];
  let importacion: ResultadoImportacion | null = null;
  let cotejo: ResultadoCorrida | null = null;
  let sesionId: string | null = null;
  let clasificacion: ResultadoClasificacion | null = null;
  let estado: EstadoDeSesion | null = null;

  // ── 1. EL EXTRACTO ──
  if (alcanza('extracto')) {
    if (opts.archivo) {
      if (!opts.leer) {
        throw new ValidationError(
          'Para importar un extracto hace falta el lector de formatos: `run` no lo elige por su ' +
            'cuenta, lo recibe, igual que `bank statement import`.'
        );
      }
      importacion = await importarEstadoDeCuenta(
        { entityId, userId: ctx.userId, bankAccountId: cuenta.id, ruta: opts.archivo },
        {
          ...(opts.formato === undefined ? {} : { formato: opts.formato }),
          ...(opts.perfil === undefined ? {} : { perfil: opts.perfil }),
          ...(ctx.dryRun === undefined ? {} : { dryRun: ctx.dryRun }),
          leer: opts.leer,
        }
      );
      pasos.push({
        paso: 'extracto',
        hecho: true,
        detalle:
          `Importado ${importacion.archivo}: ${importacion.importadas} línea(s) nuevas, ` +
          `${importacion.duplicadas} ya estaban. Cierre declarado ${importacion.saldoFinal}.`,
      });
    } else {
      const existentes = await extractosDelPeriodo(null, entityId, cuenta.id, desde, hasta);
      const hecho = existentes.length > 0;
      pasos.push({
        paso: 'extracto',
        hecho,
        detalle: hecho
          ? `Se toma el extracto ya importado (${existentes.length} documento(s), cierre ` +
            `${monto(new Decimal(existentes[existentes.length - 1].closing_balance))}).`
          : `No hay extracto importado entre ${desde} y ${hasta}. Da \`--file\` o corre ` +
            `\`bank statement import\` antes: sin documento no hay saldo de banco que conciliar.`,
      });
      if (!hecho) {
        loQueFalta.push('Importar el estado de cuenta del periodo.');
        return cerrarCorrida();
      }
    }
  }

  // ── 2. EL COTEJO ──
  if (alcanza('cotejo')) {
    cotejo = await correrCotejo(
      scope,
      {
        cuentaId: cuenta.id,
        desde,
        hasta,
        ...(opts.minConfianza === undefined ? {} : { minConfianza: opts.minConfianza }),
        ...(opts.maxMonto === undefined ? {} : { maxMonto: opts.maxMonto }),
      },
      { userId: ctx.userId, ...(ctx.dryRun === undefined ? {} : { dryRun: ctx.dryRun }) }
    );
    pasos.push({
      paso: 'cotejo',
      hecho: true,
      detalle:
        `${cotejo.aplicados.length} cotejo(s) aplicados de ${cotejo.evaluados} movimiento(s) ` +
        `evaluados; ${cotejo.omitidos.length} omitido(s)` +
        (cotejo.truncado ? '. La corrida alcanzó su tope: quedan movimientos sin evaluar.' : '.'),
    });
    if (cotejo.truncado) {
      loQueFalta.push('Volver a correr el cotejo: la corrida alcanzó su tope y quedaron movimientos sin evaluar.');
    }
  }

  // ── 3. LA SESIÓN ──
  if (alcanza('sesion')) {
    const enCurso = await query<{ id: string }>(
      `SELECT s.id FROM reconciliation_sessions s
        WHERE s.bank_account_id = $1 AND s.entity_id = $2
          AND s.start_date = $3::date AND s.end_date = $4::date`,
      [cuenta.id, entityId, desde, hasta]
    );
    if (enCurso.rows.length > 0) {
      if (!opts.reanudar) {
        throw new ConflictError(
          `La cuenta ${cuenta.account_name} ya tiene la sesión ${enCurso.rows[0].id} para ` +
            `${desde} → ${hasta}. Usa \`--resume\` para continuar donde se detuvo; abrir otra ` +
            `explicaría el mismo movimiento dos veces.`
        );
      }
      sesionId = enCurso.rows[0].id;
      pasos.push({ paso: 'sesion', hecho: true, detalle: `Se reanuda la sesión ${sesionId}.` });
    } else if (ctx.dryRun) {
      // En ensayo la apertura se revierte, así que no hay id con el que
      // seguir. Se dice, en vez de continuar sobre una sesión que no existe.
      const ensayo = await abrirSesion(
        scope,
        { cuenta: cuenta.id, desde, hasta, ...(opts.notas === undefined ? {} : { notas: opts.notas }) },
        ctx
      );
      pasos.push({
        paso: 'sesion',
        hecho: true,
        detalle:
          `Ensayo: la sesión abriría con saldo inicial ${ensayo.saldoInicial} y cierre de banco ` +
          `${ensayo.saldoFinalBanco}. Los pasos siguientes necesitan una sesión real.`,
      });
      loQueFalta.push('Repetir sin `--dry-run` para clasificar partidas y ver el estado.');
      return cerrarCorrida();
    } else {
      const abierta = await abrirSesion(
        scope,
        { cuenta: cuenta.id, desde, hasta, ...(opts.notas === undefined ? {} : { notas: opts.notas }) },
        ctx
      );
      sesionId = abierta.sesionId;
      pasos.push({
        paso: 'sesion',
        hecho: true,
        detalle:
          `Sesión ${sesionId} abierta: saldo inicial ${abierta.saldoInicial}, cierre de banco ` +
          `${abierta.saldoFinalBanco}, extracto ${abierta.statementId}.` +
          (abierta.avisos.length > 0 ? ` Avisos: ${abierta.avisos.join(' ')}` : ''),
      });
    }
  }

  // ── 4. LAS PARTIDAS ──
  if (alcanza('partidas') && sesionId) {
    clasificacion = await clasificarPartidasDeSesion(scope, sesionId, ctx);
    const porLado = (lado: 'banco' | 'libros'): number =>
      clasificacion === null ? 0 : clasificacion.levantadas.filter((p) => p.lado === lado).length;
    pasos.push({
      paso: 'partidas',
      hecho: true,
      detalle:
        `${clasificacion.levantadas.length} partida(s) levantadas ` +
        `(${porLado('banco')} que corrigen el saldo del banco, ${porLado('libros')} el de libros); ` +
        `${clasificacion.sinFechaEsperada} nacen sin fecha esperada, que es lo que una persona ` +
        `tiene que poner.` +
        (clasificacion.topeAlcanzado
          ? ' La pasada alcanzó su tope: quedan candidatos sin levantar.'
          : ''),
    });
    if (clasificacion.topeAlcanzado) {
      loQueFalta.push('Volver a clasificar: la pasada alcanzó su tope y quedaron candidatos sin levantar.');
    }
  }

  // ── 5. EL ESTADO, QUE ES DONDE LA CORRIDA SE DETIENE ──
  if (alcanza('estado') && sesionId) {
    const fila = await sesionDeLaEntidad(null, entityId, sesionId);
    const criterios = await criteriosDeCierre(tenantId, entityId);
    estado = await leerEstado(null, entityId, fila, criterios);
    pasos.push({
      paso: 'estado',
      hecho: true,
      detalle: estado.listaParaCerrar
        ? `Variación ${estado.aritmetica.variacion ?? 'sin calcular'}: la sesión está lista para ` +
          `\`bank reconciliation close\`.`
        : `Variación ${estado.aritmetica.variacion ?? 'SIN CALCULAR'} con ` +
          `${estado.bloqueantes.length} reparo(s) abiertos.`,
    });
    for (const r of estado.bloqueantes) loQueFalta.push(`[${r.codigo}] ${r.detalle}`);
    if (estado.listaParaCerrar) {
      loQueFalta.push('Cerrar con `bank reconciliation close`, que es un acto de una persona.');
    }
  }

  return cerrarCorrida();

  function cerrarCorrida(): ResultadoCorridaGuiada {
    // El pase NUNCA llega a `approve` ni a `post`, y lo dice aunque todo lo
    // demás haya salido bien: una corrida que termina en verde sin esta línea
    // se lee como una conciliación terminada.
    loQueFalta.push(
      'Después de cerrar: `bank reconciliation approve` (el aprobador no puede ser el ' +
        'preparador) y `bank reconciliation post`. `run` no hace ninguna de las dos.'
    );
    return {
      cuenta: { id: cuenta.id, nombre: cuenta.account_name },
      desde,
      hasta,
      pasos,
      importacion,
      cotejo,
      sesionId,
      clasificacion,
      estado,
      loQueFalta,
      detenidaAntesDeAprobar: true,
      ensayo: ctx.dryRun === true,
    };
  }
}
