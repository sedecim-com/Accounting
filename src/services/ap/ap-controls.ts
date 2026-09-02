import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { AccountingError, ValidationError } from '../../utils/errors.js';
import { PAYABLE_OPEN_STATUSES } from '../reporting/report-service.js';

// ============================================================
// EL CUADRE DE CxP (F04)
//
// Una sola pregunta con evidencia: lo que el SUBDIARIO dice que se debe a
// proveedores, ¿es lo mismo que la CUENTA DE CONTROL dice en el MAYOR?
//
// Y cuando no lo es, la respuesta útil no es el número de la diferencia —ése
// ya lo sabe cualquiera que reste dos saldos— sino su REPARTO: qué documento
// o qué asiento concreto la produce. Las partidas que este servicio sabe
// nombrar son tres, y están elegidas porque son las que de verdad ocurren:
//
//   1. `asiento-manual`  — alguien contabilizó directo contra el control sin
//      documento de CxP detrás. Es la causa número uno de un descuadre que
//      nadie encuentra, y la que el catálogo nombra explícitamente.
//   2. `gasto-sin-asiento` — el gasto pesa en el subdiario y su asiento no
//      existe, no está contabilizado, o quedó fuera del corte.
//   3. `asiento-sin-gasto` — el gasto dejó de pesar en el subdiario (se anuló,
//      se canceló, se saldó) y su asiento sigue vivo en el control.
//
// Y una cuarta que no es una partida sino la honestidad del instrumento:
//   4. `residuo` — lo que queda sin repartir. NO se disfraza. Un cuadre que
//      inventa una explicación para llegar a cero es peor que uno que dice
//      «esto no lo sé explicar»: el primero se cierra, el segundo se
//      investiga.
//
// EL SIGNO, que aquí no es un detalle. CxP es PASIVO: su saldo natural es
// acreedor. El espejo de CxC (`arReconcile`) resta débitos menos créditos
// porque su control es un activo; copiarlo tal cual habría devuelto el mayor
// en negativo y una diferencia con el signo invertido en cada partida. Aquí
// el mayor se lee como CRÉDITOS − DÉBITOS, de modo que un pasivo de mil pesos
// vale +1000, igual que el subdiario.
//
// La diferencia se define SIEMPRE como `subdiario − mayor`, y el `importe` de
// cada partida es su APORTACIÓN FIRMADA a esa resta. Por eso las partidas
// suman: `explicado` es su total y `sinExplicar` es lo que falta para la
// diferencia. Un lector puede auditar la aritmética con la vista.
// ============================================================

/**
 * Los `source_type` que SÍ vienen del subdiario de CxP. Un asiento con
 * cualquiera de ellos tiene documento detrás y no es conciliatorio.
 *
 * Cuando la fase 2 traiga `payment_run post` con su propio `source_type`,
 * hay que añadirlo AQUÍ el mismo día: si no, cada corrida de pagos aparecerá
 * como asiento manual sobre la cuenta de control y el informe se volverá
 * ruido que nadie lee. Lo mismo vale para cualquier flujo nuevo que toque el
 * 2110 (nómina y depreciación hoy no lo tocan).
 */
const ORIGENES_CXP = ['bill', 'vendor_payment', 'vendor_application'] as const;

/** Los orígenes que LIQUIDAN un pasivo ya reconocido (débito al control). */
const ORIGENES_LIQUIDACION = ['vendor_payment', 'vendor_application'] as const;

/**
 * Bajo este umbral la diferencia es ruido de redondeo de un DECIMAL(19,4)
 * presentado a dos decimales, no un descuadre. Un centavo es la unidad
 * mínima que un contador puede perseguir en una póliza.
 */
const TOLERANCIA = '0.01';

/**
 * Tope de filas ENUMERADAS por partida. Los totales de cada sonda se calculan
 * sobre TODAS las filas con una función de ventana, no sobre las que se
 * devuelven: si el tope recortara también la suma, `sinExplicar` engordaría
 * con lo que sí estaba explicado y el residuo mentiría. `omitidas` dice
 * cuántas se quedaron fuera del listado.
 */
const MAX_FILAS = 200;

export interface CuentaControlAP {
  id: string;
  code: string;
  name: string;
}

export type TipoPartidaAP =
  | 'asiento-manual'
  | 'gasto-sin-asiento'
  | 'asiento-sin-gasto'
  | 'residuo';

export interface PartidaConciliatoria {
  tipo: TipoPartidaAP;
  /** Folio del asiento o número del gasto: con qué se busca en el sistema. */
  referencia: string;
  /** YYYY-MM-DD. Nunca un Date: una fecha de calendario con hora es una zona horaria esperando a equivocarse. */
  fecha: string | null;
  /** Aportación FIRMADA a `subdiario − mayor`. La suma de todas es `explicado`. */
  importe: string;
  /** El porqué, en español. Con `explain` es prosa completa; sin él, una línea. */
  detalle: string;
}

export interface ResultadoConciliacionAP {
  /** La fecha de corte efectiva, YYYY-MM-DD. */
  asOf: string;
  cuentaControl: CuentaControlAP;
  /** Σ saldos abiertos de gasto a la fecha de corte. */
  subdiario: string;
  /** Saldo acreedor de la cuenta de control en el mayor a la fecha de corte. */
  mayor: string;
  /** `subdiario − mayor`. */
  diferencia: string;
  cuadra: boolean;
  partidas: PartidaConciliatoria[];
  /** Σ de los importes de las partidas nombradas (sin el residuo). */
  explicado: string;
  /** `diferencia − explicado`. Si no es cero, hay descuadre sin dueño. */
  sinExplicar: string;
  /** Partidas que existen y no se enumeraron por el tope de filas. */
  omitidas: number;
  /** El sesgo del corte retroactivo, dicho en voz alta. `null` cuando el corte es hoy. */
  advertenciaAsOf: string | null;
}

export interface OpcionesConciliacionAP {
  /** Fecha de corte. Sin ella, hoy. */
  asOf?: Date | string;
  /**
   * Redacta el `detalle` de cada partida como prosa completa en lugar de una
   * línea. Vive aquí y no en el CLI a propósito: por qué una partida mueve la
   * diferencia —y en qué dirección— es conocimiento del dominio, no una
   * decisión de presentación, y duplicarlo en cada superficie que lo imprima
   * es garantizar que las dos versiones se contradigan.
   */
  explain?: boolean;
}

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Hoy, en la zona horaria de quien ejecuta.
 *
 * NO se usa `toISOString().slice(0,10)`: eso da la fecha UTC, y en México
 * (UTC−6) las últimas seis horas de cada día ya son "mañana" en UTC. Un
 * cuadre lanzado a las siete de la tarde habría incluido los asientos del día
 * siguiente y devuelto una diferencia distinta a la del mismo comando lanzado
 * media hora antes.
 */
function fechaLocal(d: Date): string {
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/**
 * Valida la fecha por IDA Y VUELTA, no sólo con la expresión regular: JS
 * acepta `2026-02-31` y lo desplaza calladamente al 3 de marzo. Comparar el
 * texto reconstruido contra el original es lo único que rechaza un día que no
 * existe, y una fecha de corte desplazada devuelve un cuadre de otro mes.
 */
function esFechaReal(texto: string): boolean {
  const d = new Date(`${texto}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}

function normalizarAsOf(valor: Date | string | undefined): string {
  if (valor === undefined) return fechaLocal(new Date());
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) {
      throw new ValidationError('La fecha de corte no es una fecha válida.', 'asOf');
    }
    return fechaLocal(valor);
  }
  const texto = valor.trim();
  if (!FECHA_RE.test(texto) || !esFechaReal(texto)) {
    throw new ValidationError(
      `La fecha de corte debe venir como YYYY-MM-DD y existir en el calendario; llegó "${valor}".`,
      'asOf'
    );
  }
  return texto;
}

function dec(valor: string | null | undefined): Decimal {
  return new Decimal(valor ?? '0');
}

/** Dos decimales en todo lo que sale, igual que `arReconcile`: los dos cuadres hablan en pesos y centavos. */
function pesos(d: Decimal): string {
  return d.toFixed(2);
}

async function cuentaDeControl(entityId: string): Promise<CuentaControlAP> {
  // El JOIN acota la cuenta a la MISMA entidad además del rol. Un rol que
  // apuntara al catálogo de otra entidad no debe filtrar aquí ni su código ni
  // su nombre: se lee como «no hay cuenta», que es la verdad operativa —esta
  // entidad no tiene control de proveedores utilizable— y manda a sembrarla.
  const rol = await query<{ id: string; code: string; name: string }>(
    `SELECT ar.account_id AS id, a.code, a.name
       FROM account_roles ar
       JOIN accounts a ON a.id = ar.account_id AND a.entity_id = $1
      WHERE ar.entity_id = $1 AND ar.role = 'cxp' AND ar.qualifier IS NULL`,
    [entityId]
  );
  if (rol.rows.length === 0) {
    throw new AccountingError(
      'MISSING_ROLE_ACCOUNT',
      'No hay cuenta mapeada al rol "cxp" en esta entidad: sin cuenta de control no hay nada ' +
        'contra qué cuadrar el subdiario de proveedores. Siembra la contabilidad con: ' +
        'mnemosine init --section identity'
    );
  }
  return rol.rows[0];
}

interface FilaManual {
  entry_number: string;
  fecha: string;
  description: string | null;
  creado_por: string;
  neto: string;
  neto_total: string;
  grupos: number;
}

interface FilaGastoSinAsiento {
  bill_number: string;
  fecha: string;
  status: string;
  proveedor: string | null;
  saldo: string;
  estado_asiento: string;
  total: string;
  grupos: number;
}

interface FilaAsientoSinGasto {
  bill_number: string;
  fecha: string;
  status: string;
  proveedor: string | null;
  entry_number: string;
  fecha_asiento: string;
  neto: string;
  total: string;
  grupos: number;
}

/**
 * El cuadre del subdiario de proveedores contra su cuenta de control.
 *
 * LO QUE `asOf` PUEDE Y LO QUE NO. El corte se aplica DENTRO del SQL en los
 * dos lados —`je.entry_date <= $n` en el mayor, `b.bill_date <= $n` en el
 * subdiario— y no en JS después, porque filtrar en JS rompería la frontera de
 * entidad y además obligaría a traer el mayor entero a memoria.
 *
 * Pero el lado del subdiario NO se puede reconstruir de verdad: `amount_due`
 * es el saldo de HOY, y ninguna tabla guarda el saldo que ese gasto tenía en
 * una fecha pasada. El corte por `bill_date` excluye los gastos POSTERIORES a
 * la fecha; no devuelve al gasto anterior el saldo que aún no había pagado.
 * Es la misma limitación que el informe de antigüedad declara, y la razón por
 * la que `arReconcile` prefirió no aceptar fecha.
 *
 * Aquí se acepta —el catálogo la promete en esta fila— y se declara: con
 * `asOf` anterior a hoy el resultado trae `advertenciaAsOf` poblada, y el
 * comando la imprime. Ofrecer la fecha en silencio, con el subdiario mintiendo
 * a favor del presente, sería exactamente el error que la ficha del aged
 * payables lleva documentado.
 */
export async function apReconcile(
  entityId: string,
  opts: OpcionesConciliacionAP = {}
): Promise<ResultadoConciliacionAP> {
  const asOf = normalizarAsOf(opts.asOf);
  const explain = opts.explain === true;
  const cuenta = await cuentaDeControl(entityId);
  const abiertos = [...PAYABLE_OPEN_STATUSES];
  const origenes = [...ORIGENES_CXP];

  const mayorQ = await query<{ saldo: string }>(
    // Créditos − débitos: el pasivo sale POSITIVO. Se calcula sobre las
    // líneas y no sobre `account_balances`, que sólo el cierre duro siembra
    // y que `ledger check --check balance` audita CONTRA las líneas: no es
    // fuente de verdad, es lo auditado.
    `SELECT COALESCE(SUM(COALESCE(jel.credit_amount,0) - COALESCE(jel.debit_amount,0)), 0)::text AS saldo
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.entity_id = $1
        AND je.status = 'posted'
        AND jel.account_id = $2
        AND je.entry_date <= $3::date`,
    [entityId, cuenta.id, asOf]
  );

  const subdiarioQ = await query<{ total: string }>(
    // El mismo conjunto que publica la antigüedad de saldos
    // (`PAYABLE_OPEN_STATUSES`), importado y no copiado: el catálogo promete
    // cuadrar «la antigüedad» contra el control, y dos listas de estados que
    // se puedan separar son dos informes que un día dirán cosas distintas.
    `SELECT COALESCE(SUM(b.amount_due), 0)::text AS total
       FROM bills b
      WHERE b.entity_id = $1
        AND b.status = ANY($2::text[])
        AND b.amount_due > 0
        AND b.bill_date <= $3::date`,
    [entityId, abiertos, asOf]
  );

  const manualesQ = await query<FilaManual>(
    // La reversión de un asiento de CxP nace con `source_type` NULO
    // (`reverseWithinTransaction` no le pasa origen) y con `is_reversal`. Sin
    // el NOT EXISTS, anular un gasto por el camino correcto —reversión, NIF
    // B-1— habría producido un falso «asiento manual sobre el control» por
    // cada anulación limpia del sistema. El espejo de CxC no lo filtra.
    `SELECT je.entry_number,
            to_char(je.entry_date, 'YYYY-MM-DD') AS fecha,
            je.description,
            COALESCE(u.email, je.created_by::text) AS creado_por,
            SUM(COALESCE(jel.credit_amount,0) - COALESCE(jel.debit_amount,0))::text AS neto,
            (SUM(SUM(COALESCE(jel.credit_amount,0) - COALESCE(jel.debit_amount,0))) OVER ())::text AS neto_total,
            (COUNT(*) OVER ())::int AS grupos
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       LEFT JOIN users u ON u.id = je.created_by
      WHERE je.entity_id = $1
        AND je.status = 'posted'
        AND jel.account_id = $2
        AND je.entry_date <= $3::date
        AND (je.source_type IS NULL OR NOT (je.source_type = ANY($4::text[])))
        AND NOT EXISTS (
              SELECT 1
                FROM journal_entries orig
               WHERE orig.id = je.reverses_entry_id
                 AND orig.entity_id = je.entity_id
                 AND orig.source_type = ANY($4::text[]))
      GROUP BY je.id, je.entry_number, je.entry_date, je.description, u.email, je.created_by
      ORDER BY je.entry_date DESC, je.entry_number DESC
      LIMIT $5`,
    [entityId, cuenta.id, asOf, origenes, MAX_FILAS]
  );

  const sinAsientoQ = await query<FilaGastoSinAsiento>(
    // El gasto pesa en el subdiario y el mayor no lo tiene: ni asiento, ni
    // asiento contabilizado, ni asiento dentro del corte. Su aportación es el
    // saldo ENTERO porque un gasto sin asiento contabilizado tampoco tiene
    // pagos contabilizados detrás — no se paga lo que no se aprobó, y aprobar
    // es justo lo que contabiliza. Si algún día se pudiera pagar un gasto sin
    // aprobarlo, esta partida sobrestimaría y el residuo lo delataría.
    `SELECT b.bill_number,
            to_char(b.bill_date, 'YYYY-MM-DD') AS fecha,
            b.status,
            v.company_name AS proveedor,
            b.amount_due::text AS saldo,
            COALESCE(je.status, 'sin asiento') AS estado_asiento,
            (SUM(b.amount_due) OVER ())::text AS total,
            (COUNT(*) OVER ())::int AS grupos
       FROM bills b
       JOIN vendors v ON v.id = b.vendor_id AND v.entity_id = b.entity_id
       LEFT JOIN journal_entries je ON je.id = b.journal_entry_id AND je.entity_id = b.entity_id
      WHERE b.entity_id = $1
        AND b.status = ANY($2::text[])
        AND b.amount_due > 0
        AND b.bill_date <= $3::date
        AND (je.id IS NULL OR je.status <> 'posted' OR je.entry_date > $3::date)
      ORDER BY b.bill_date DESC, b.bill_number
      LIMIT $4`,
    [entityId, abiertos, asOf, MAX_FILAS]
  );

  const sinGastoQ = await query<FilaAsientoSinGasto>(
    // El reverso: el subdiario ya no lo cuenta y el control sigue cargando su
    // crédito. Se exige que el gasto NO tenga ninguna liquidación
    // contabilizada, y esa restricción es deliberada.
    //
    // El débito que un pago deja en el 2110 vale `aplicado + descuento +
    // condonado`, y la condonación NO se guarda por gasto en ninguna columna
    // (la 050 explica por qué `payment_applications` es tan estrecha). Repartir
    // el débito del pago entre sus gastos con lo que sí está en la tabla
    // dejaría fuera la condonación y fabricaría una partida falsa del tamaño
    // exacto de lo condonado en cada pago corto. Así que esta sonda sólo
    // reclama los casos que sabe medir enteros —el crédito íntegro que quedó
    // vivo, típicamente un gasto anulado cuyo asiento nadie reversó— y lo que
    // no sabe repartir se queda en `sinExplicar`, con nombre. Un residuo
    // honesto vale más que una partida inventada.
    `SELECT b.bill_number,
            to_char(b.bill_date, 'YYYY-MM-DD') AS fecha,
            b.status,
            v.company_name AS proveedor,
            je.entry_number,
            to_char(je.entry_date, 'YYYY-MM-DD') AS fecha_asiento,
            vivo.neto::text AS neto,
            (SUM(vivo.neto) OVER ())::text AS total,
            (COUNT(*) OVER ())::int AS grupos
       FROM bills b
       JOIN vendors v ON v.id = b.vendor_id AND v.entity_id = b.entity_id
       JOIN journal_entries je ON je.id = b.journal_entry_id AND je.entity_id = b.entity_id
       JOIN LATERAL (
              SELECT COALESCE(SUM(COALESCE(jel.credit_amount,0) - COALESCE(jel.debit_amount,0)), 0) AS neto
                FROM journal_entry_lines jel
               WHERE jel.journal_entry_id = je.id AND jel.account_id = $2
            ) vivo ON true
      WHERE b.entity_id = $1
        AND NOT (b.status = ANY($4::text[]) AND b.amount_due > 0 AND b.bill_date <= $3::date)
        AND je.status = 'posted'
        AND je.entry_date <= $3::date
        AND je.reversed_by_entry_id IS NULL
        AND ABS(vivo.neto) > 0.005
        AND NOT EXISTS (
              SELECT 1
                FROM payment_applications pa
                JOIN vendor_payments vp ON vp.id = pa.payment_id AND vp.entity_id = b.entity_id
               WHERE pa.bill_id = b.id
                 AND EXISTS (
                       SELECT 1
                         FROM journal_entries jp
                        WHERE jp.entity_id = b.entity_id
                          AND jp.status = 'posted'
                          AND jp.entry_date <= $3::date
                          AND jp.source_id = vp.id
                          AND jp.source_type = ANY($5::text[])))
      ORDER BY b.bill_date DESC, b.bill_number
      LIMIT $6`,
    [entityId, cuenta.id, asOf, abiertos, [...ORIGENES_LIQUIDACION], MAX_FILAS]
  );

  const mayor = dec(mayorQ.rows[0]?.saldo);
  const subdiario = dec(subdiarioQ.rows[0]?.total);
  const diferencia = subdiario.minus(mayor);

  // Totales sobre TODAS las filas de cada sonda (ventana), no sobre las
  // enumeradas. Un tope que recortara también la suma inflaría el residuo.
  const netoManuales = dec(manualesQ.rows[0]?.neto_total);
  const netoSinAsiento = dec(sinAsientoQ.rows[0]?.total);
  const netoSinGasto = dec(sinGastoQ.rows[0]?.total);

  // La aportación a `subdiario − mayor`: lo que sólo engorda el mayor entra
  // con signo negativo, lo que sólo engorda el subdiario con signo positivo.
  const explicado = netoSinAsiento.minus(netoManuales).minus(netoSinGasto);
  const sinExplicar = diferencia.minus(explicado);

  const partidas: PartidaConciliatoria[] = [
    // Los asientos manuales se listan SIEMPRE, cuadre o no cuadre. Un asiento
    // contabilizado a mano sobre la cuenta de control es un hecho reportable
    // por sí mismo: significa que alguien movió el pasivo de proveedores sin
    // pasar por un gasto ni por un pago, y que hoy cuadre sólo quiere decir
    // que algo lo compensa —muchas veces un segundo asiento manual igual de
    // opaco—. Callarlo mientras el total salga a cero convertiría este
    // comando en un semáforo verde que oculta justo lo que hay que mirar.
    ...manualesQ.rows.map((m) => partidaManual(m, explain)),
    ...sinAsientoQ.rows.map((g) => partidaGastoSinAsiento(g, explain)),
    ...sinGastoQ.rows.map((a) => partidaAsientoSinGasto(a, explain)),
  ];

  if (sinExplicar.abs().greaterThanOrEqualTo(TOLERANCIA)) {
    partidas.push(partidaResiduo(sinExplicar, explain));
  }

  const omitidas =
    Math.max(0, (manualesQ.rows[0]?.grupos ?? 0) - manualesQ.rows.length) +
    Math.max(0, (sinAsientoQ.rows[0]?.grupos ?? 0) - sinAsientoQ.rows.length) +
    Math.max(0, (sinGastoQ.rows[0]?.grupos ?? 0) - sinGastoQ.rows.length);

  return {
    asOf,
    cuentaControl: cuenta,
    subdiario: pesos(subdiario),
    mayor: pesos(mayor),
    diferencia: pesos(diferencia),
    cuadra: diferencia.abs().lessThan(TOLERANCIA),
    partidas,
    explicado: pesos(explicado),
    sinExplicar: pesos(sinExplicar),
    omitidas,
    advertenciaAsOf: advertenciaDeCorte(asOf),
  };
}

/**
 * El sesgo del corte retroactivo. Se calcula contra HOY local, no contra la
 * fecha del servidor de base de datos: la advertencia es para quien lee.
 */
function advertenciaDeCorte(asOf: string): string | null {
  if (asOf >= fechaLocal(new Date())) return null;
  return (
    `El corte al ${asOf} envejece los dos lados, pero no reconstruye el pasado: el mayor sí queda ` +
    'cortado a esa fecha, mientras que el saldo de cada gasto es el de HOY. Un gasto anterior al ' +
    'corte que se pagó después aparece ya rebajado en el subdiario y todavía entero en el mayor, ' +
    'y esa parte de la diferencia es del instrumento, no de los libros. Para un cuadre exigible ' +
    'ante un auditor, córtalo el mismo día.'
  );
}

function partidaManual(m: FilaManual, explain: boolean): PartidaConciliatoria {
  const neto = dec(m.neto);
  const aporte = neto.negated();
  const descripcion = (m.description ?? '').trim();
  const detalle = explain
    ? `Asiento contabilizado directo contra la cuenta de control sin documento de CxP detrás. ` +
      (neto.isZero()
        ? 'Cargó y abonó el control por el mismo importe, así que no mueve la diferencia; ' +
          'aun así alguien tocó el pasivo de proveedores a mano.'
        : neto.greaterThan(0)
          ? `Abonó ${pesos(neto)} al control —subió el pasivo del mayor— sin que ningún gasto lo ` +
            `respalde en el subdiario, de modo que resta ${pesos(neto)} a la diferencia.`
          : `Cargó ${pesos(neto.abs())} al control —bajó el pasivo del mayor— sin que ningún pago lo ` +
            `respalde en el subdiario, de modo que suma ${pesos(neto.abs())} a la diferencia.`) +
      ` Lo creó ${m.creado_por}.` +
      (descripcion ? ` Descripción: «${descripcion}».` : '')
    : `asiento manual sobre el control · ${m.creado_por}` + (descripcion ? ` · ${descripcion}` : '');
  return {
    tipo: 'asiento-manual',
    referencia: m.entry_number,
    fecha: m.fecha,
    importe: pesos(aporte),
    detalle,
  };
}

function partidaGastoSinAsiento(g: FilaGastoSinAsiento, explain: boolean): PartidaConciliatoria {
  const saldo = dec(g.saldo);
  const proveedor = g.proveedor ?? 'proveedor sin nombre';
  const detalle = explain
    ? `El gasto debe ${pesos(saldo)} a ${proveedor} y el subdiario lo cuenta, pero el mayor no: su ` +
      `asiento está «${g.estado_asiento}». Mientras no se contabilice dentro del corte, el ` +
      `subdiario va ${pesos(saldo)} por encima del control. El pasivo existe y la contabilidad no ` +
      `lo reconoce: se corrige aprobando el gasto, no ajustando el mayor.`
    : `${proveedor} · saldo ${pesos(saldo)} · asiento «${g.estado_asiento}»`;
  return {
    tipo: 'gasto-sin-asiento',
    referencia: g.bill_number,
    fecha: g.fecha,
    importe: pesos(saldo),
    detalle,
  };
}

function partidaAsientoSinGasto(a: FilaAsientoSinGasto, explain: boolean): PartidaConciliatoria {
  const neto = dec(a.neto);
  const aporte = neto.negated();
  const proveedor = a.proveedor ?? 'proveedor sin nombre';
  const detalle = explain
    ? `El gasto está en «${a.status}» y ya no pesa en el subdiario, pero su asiento ` +
      `${a.entry_number} (${a.fecha_asiento}) sigue contabilizado y sin reversar, dejando ` +
      `${pesos(neto)} vivos en la cuenta de control a favor de ${proveedor}. Ningún pago ` +
      `contabilizado lo liquidó. El mayor sigue reconociendo un pasivo que el subdiario dio por ` +
      `muerto: se corrige reversando el asiento (NIF B-1), nunca borrándolo.`
    : `${proveedor} · gasto en «${a.status}» · asiento ${a.entry_number} vivo por ${pesos(neto)}`;
  return {
    tipo: 'asiento-sin-gasto',
    referencia: a.bill_number,
    fecha: a.fecha,
    importe: pesos(aporte),
    detalle,
  };
}

function partidaResiduo(sinExplicar: Decimal, explain: boolean): PartidaConciliatoria {
  const detalle = explain
    ? `Lo que ninguna de las sondas sabe atribuir: ${pesos(sinExplicar)}. Los sospechosos ` +
      `habituales son un pago corto cuya condonación no se guarda por gasto, un asiento de CxP ` +
      `con líneas repartidas entre varias cuentas de control, o un movimiento al 2110 desde un ` +
      `flujo cuyo origen todavía no está en la lista de orígenes de CxP. Es el número que hay que ` +
      `perseguir a mano: el instrumento ya dijo todo lo que sabe.`
    : 'diferencia que ninguna sonda sabe atribuir';
  return {
    tipo: 'residuo',
    referencia: 'sin explicar',
    fecha: null,
    importe: pesos(sinExplicar),
    detalle,
  };
}
