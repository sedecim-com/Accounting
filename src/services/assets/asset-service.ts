import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { ConflictError, NotFoundError, ValidationError } from '../../utils/errors.js';
import { nextEntityNumber } from '../../utils/sequence.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import { getPolicy } from '../policy/policy-service.js';
import { DepreciationMethod } from '../../types/index.js';

// ============================================================
// EL ALTA DE ACTIVO (F06a · 056)
//
// El esquema de activos lleva desde la 003 —tres tablas, treinta y nueve
// columnas, cuatro índices— y NINGÚN escritor: no existe un solo
// `INSERT INTO fixed_assets` en todo `src/`. De ahí se sigue todo lo demás:
// `depreciation_schedules` está vacía, `runMonthlyDepreciation` no tiene qué
// depreciar, y la pantalla donde el usuario decide capitalizar un CFDI tiene
// que confesar que la deducción mensual «no la calcula el sistema».
//
// ESTE ARCHIVO ES EL PRIMER ESCRITOR, y por eso la mitad de su trabajo es
// negativo: decidir qué NO hace.
//
// 1. NO POSTEA. Ver el bloque «LA COMPRA YA ESTÁ EN EL MAYOR» más abajo. Dar
//    de alta el activo es registrar un BIEN, no registrar un HECHO nuevo: el
//    desembolso ya lo contabilizó quien lo capturó, y un asiento aquí sería el
//    mismo gasto contado dos veces. Como el mayor es inmutable (041), ese
//    duplicado no se edita después: se revierte, y quedan dos asientos donde
//    debía haber uno.
//
// 2. NO ELIGE CRITERIO CONTABLE. Dos bifurcaciones de este alta son del
//    despacho y se leen del panel con `getPolicy`, no se codifican aquí:
//    `base_depreciacion` decide cuál de los dos métodos —el contable de la NIF
//    C-6 o el fiscal de la LISR— es el que rige el gasto que llegará al mayor,
//    y `convencion_primer_mes` decide desde qué día arranca la corrida cuando
//    el llamador no lo fija.
//
// 3. NO CONFÍA EN LA FORÁNEA PARA LA FRONTERA. `fixed_assets` tiene cuatro
//    claves foráneas —categoría y tres cuentas— y NINGUNA de ellas acota por
//    entidad: `accounts(id)` acepta la cuenta de cualquier catálogo del
//    sistema. Un alta con la categoría de otra entidad deja un activo cuya
//    depreciación va a postear, mes tras mes, contra el mayor ajeno. Por eso
//    las cuatro se comprueban con el `entity_id` DENTRO del SQL, y no leyendo
//    primero para comparar después.
//
// 4. NO RECORTA A DOS DECIMALES. Las columnas de dinero son DECIMAL(19,4) y
//    el costo entra y sale como cadena por decimal.js. Un activo de 33,333.33
//    a 36 meses reparte 925.9258 al mes: redondear el costo a dos decimales al
//    darlo de alta mueve el error a cada uno de los 36 renglones.
// ============================================================

// ── LAS CATEGORÍAS, Y POR QUÉ TIENEN QUE EXISTIR ANTES QUE NADA ─────────
//
// `fixed_assets.category_id` es NOT NULL contra `asset_categories` (003:151) y
// esa tabla no la puebla nadie: sin categorías no se puede dar de alta ni un
// activo. Está en la lista RECLAMADAS de `src/plan/criterios.ts` con dueño
// escrito —«F06/DEP-2: el alta de activo la necesita»—, así que darle escritor
// es cumplir la promesa, no inventar alcance.
//
// LAS TASAS SON LAS DE LA LISR Y SON MÁXIMOS, no vidas útiles. El artículo 34
// dice «por cientos máximos autorizados»: el contribuyente puede deducir más
// despacio, nunca más rápido. De ahí sale la única regla de redondeo que este
// catálogo necesita —la vida por omisión es el TECHO de 100/tasa—: una vida
// más larga deduce por debajo del máximo y siempre es legal; una más corta lo
// excede. El 30 % del equipo de cómputo son 3 años y 4 meses, y por eso la
// categoría dice 4 años y no 3. Quien quiera los 40 meses exactos los pide en
// el alta: `useful_life_months` existe justo para eso.
//
// EL MÉTODO ES LÍNEA RECTA EN LAS SEIS. No es una preferencia: el artículo 31
// deduce las inversiones aplicando el por ciento sobre el MONTO ORIGINAL de la
// inversión, que es línea recta. Saldos decrecientes y MACRS viven en el CHECK
// del esquema porque el esquema es multipaís; en una deducción mexicana no
// tienen dónde apoyarse.
//
// LO QUE ESTE CATÁLOGO NO INTENTA: el artículo 35 fija la tasa de maquinaria
// POR ACTIVIDAD del contribuyente —hay fracciones para minería, restaurantes,
// construcción, transporte aéreo y una docena más— y esta siembra no puede
// saber a cuál pertenece la entidad. Se siembra la fracción residual, que es
// la única aplicable sin conocer el giro, y el despacho ajusta. Las tasas de
// las otras fracciones NO se transcriben aquí: media tasa recordada de memoria
// es peor que ninguna.

interface EspecieDeActivo {
  /** Nombre de la categoría. Es la clave de idempotencia de la siembra. */
  nombre: string;
  /** Por ciento máximo anual. Cadena porque es una tasa legal, no un flotante. */
  tasaMaximaLisr: string;
  /** De dónde sale la tasa, para que se pueda cotejar contra la ley. */
  fundamento: string;
  /** Techo de 100 / tasa. Ver el comentario del redondeo. */
  vidaAnios: number;
  /** Cuenta de activo del catálogo base, o null si el catálogo base no la trae. */
  codigoCuentaActivo: string | null;
}

/** Cuenta donde se acumula la depreciación (contra-activo) en el catálogo base. */
const CODIGO_DEPRECIACION_ACUMULADA = '1290';
/** Cuenta del gasto por depreciación en el catálogo base. */
const CODIGO_GASTO_DEPRECIACION = '6140';

export const CATALOGO_LISR: readonly EspecieDeActivo[] = [
  {
    nombre: 'Edificios y Construcciones',
    tasaMaximaLisr: '5',
    fundamento: 'LISR art. 34, fr. I, inciso b) — construcciones, los demás casos',
    vidaAnios: 20,
    // El catálogo base no trae cuenta de edificios: el 1200 «Activo Fijo» es
    // encabezado y no admite movimientos. Se siembra la categoría igual —una
    // entidad que compra un edificio necesita su tasa— y el alta exigirá la
    // cuenta explícita mientras el despacho no la abra.
    codigoCuentaActivo: null,
  },
  {
    nombre: 'Mobiliario y Equipo de Oficina',
    tasaMaximaLisr: '10',
    fundamento: 'LISR art. 34, fr. III',
    vidaAnios: 10,
    codigoCuentaActivo: '1210',
  },
  {
    nombre: 'Equipo de Cómputo',
    tasaMaximaLisr: '30',
    fundamento:
      'LISR art. 34, fr. VII — computadoras de escritorio y portátiles, servidores, ' +
      'impresoras, lectores ópticos, digitalizadores y concentradores de red',
    // 100/30 = 3.33 años. Cuatro, no tres, por el redondeo hacia arriba.
    vidaAnios: 4,
    codigoCuentaActivo: '1220',
  },
  {
    nombre: 'Equipo de Transporte',
    tasaMaximaLisr: '25',
    fundamento:
      'LISR art. 34, fr. VI — automóviles, autobuses, camiones de carga, ' +
      'tractocamiones, montacargas y remolques',
    vidaAnios: 4,
    codigoCuentaActivo: '1230',
  },
  {
    nombre: 'Maquinaria y Equipo',
    tasaMaximaLisr: '10',
    fundamento: 'LISR art. 35, fr. XIV — otras actividades no especificadas',
    vidaAnios: 10,
    codigoCuentaActivo: null,
  },
  {
    nombre: 'Herramientas, Dados, Troqueles, Moldes y Matrices',
    tasaMaximaLisr: '35',
    fundamento: 'LISR art. 34, fr. VIII',
    // 100/35 = 2.86 años.
    vidaAnios: 3,
    codigoCuentaActivo: null,
  },
];

export interface ResultadoSiembraCategorias {
  creadas: string[];
  yaExistian: string[];
  /** Sembradas sin cuenta de activo: el catálogo de la entidad no la trae. */
  sinCuentaDeActivo: string[];
  /** Códigos que la depreciación va a necesitar y no están en el catálogo. */
  cuentasFaltantes: string[];
}

/**
 * Siembra las categorías de activo de la entidad.
 *
 * Idempotente con la misma forma que `seedAccountRoles`: lee lo que ya hay,
 * crea SÓLO lo que falta y no pisa nunca una elección manual. Aquí la clave de
 * idempotencia es el nombre y no un código, porque `asset_categories` no tiene
 * más identificador natural (003 no le puso UNIQUE): una categoría renombrada
 * a mano se vuelve a sembrar con el nombre original, y eso es preferible a que
 * una segunda corrida sobrescriba la vida útil que el despacho ajustó.
 */
export async function sembrarCategoriasDeActivo(
  entityId: string,
  /** Corre dentro de la transacción del llamador: el alta de entidad siembra
   *  catálogo, roles y categorías en un solo acto. */
  opts?: { client?: pg.PoolClient }
): Promise<ResultadoSiembraCategorias> {
  const correr = async (client: pg.PoolClient): Promise<ResultadoSiembraCategorias> => {
    const existentes = await client.query<{ name: string }>(
      'SELECT name FROM asset_categories WHERE entity_id = $1',
      [entityId]
    );
    const yaHay = new Set(existentes.rows.map((r) => r.name));

    // Las cuentas se resuelven POR CÓDIGO y acotadas por entidad en el mismo
    // SELECT. Los encabezados se excluyen aquí y no después: el CHECK de la
    // 001 les prohíbe movimientos manuales, así que una categoría que apunte a
    // uno produce un activo que no se puede depreciar nunca.
    const codigos = [
      ...new Set(
        [
          ...CATALOGO_LISR.map((e) => e.codigoCuentaActivo),
          CODIGO_DEPRECIACION_ACUMULADA,
          CODIGO_GASTO_DEPRECIACION,
        ].filter((c): c is string => c !== null)
      ),
    ];
    const cuentas = await client.query<{ code: string; id: string }>(
      `SELECT code, id FROM accounts
        WHERE entity_id = $1 AND is_header = false AND code = ANY($2::text[])`,
      [entityId, codigos]
    );
    const idPorCodigo = new Map(cuentas.rows.map((r) => [r.code, r.id]));

    const creadas: string[] = [];
    const yaExistian: string[] = [];
    const sinCuentaDeActivo: string[] = [];

    for (const especie of CATALOGO_LISR) {
      if (yaHay.has(especie.nombre)) {
        yaExistian.push(especie.nombre);
        continue;
      }
      const cuentaActivo =
        especie.codigoCuentaActivo === null
          ? null
          : (idPorCodigo.get(especie.codigoCuentaActivo) ?? null);
      if (cuentaActivo === null) sinCuentaDeActivo.push(especie.nombre);

      await client.query(
        // Las tres columnas de cuenta de `asset_categories` tienen nombres que
        // no dicen cuál es cuál. El orden de `fixed_assets` las desambigua
        // —asset, accumulated, expense— y es el que se sigue:
        // default_depreciation_account_id es la ACUMULADA (contra-activo 1290)
        // y default_expense_account_id es el GASTO (6140).
        `INSERT INTO asset_categories (
           entity_id, name, default_useful_life_years, default_depreciation_method,
           default_asset_account_id, default_depreciation_account_id, default_expense_account_id
         ) VALUES ($1, $2, $3, 'straight_line', $4, $5, $6)`,
        [
          entityId,
          especie.nombre,
          especie.vidaAnios,
          cuentaActivo,
          idPorCodigo.get(CODIGO_DEPRECIACION_ACUMULADA) ?? null,
          idPorCodigo.get(CODIGO_GASTO_DEPRECIACION) ?? null,
        ]
      );
      creadas.push(`${especie.nombre} (${especie.tasaMaximaLisr}% — ${especie.fundamento})`);
    }

    const cuentasFaltantes = [CODIGO_DEPRECIACION_ACUMULADA, CODIGO_GASTO_DEPRECIACION].filter(
      (c) => !idPorCodigo.has(c)
    );

    return { creadas, yaExistian, sinCuentaDeActivo, cuentasFaltantes };
  };

  return opts?.client ? correr(opts.client) : withTransaction(correr);
}

// ── LA COMPRA YA ESTÁ EN EL MAYOR ───────────────────────────────────────
//
// Un activo llega por dos caminos y en LOS DOS el desembolso ya se contabilizó
// antes de que exista la ficha del activo:
//
//   · DESDE UN CFDI. Cuando el usuario contesta `gasto_vs_activo` con
//     `activo_fijo`, `cfdi-posting-plan.ts` arma el asiento con el rol
//     `activo_fijo`, que `ROLE_MAP` manda a la 1210. El importe YA ESTÁ en la
//     cuenta de activo fijo; lo que falta es la ficha y la corrida, no el
//     cargo. La etiqueta de esa opción lo dice literalmente: «capitalized;
//     depreciation NOT computed by the system yet».
//   · DESDE UNA FACTURA DE PROVEEDOR capturada a mano, cuyo renglón se mapeó a
//     una cuenta de activo fijo. Mismo resultado por otra puerta.
//
// Queda un tercer caso, y es el que obliga a preguntar en vez de suponer: el
// activo que NO está en libros —una aportación en especie, un saldo inicial de
// migración, un bien comprado antes de que la entidad usara el sistema—.
//
// POR ESO `contabilizacion` ES OBLIGATORIA Y NO TIENE VALOR POR OMISIÓN. Un
// defecto silencioso aquí se paga dos veces: si el defecto fuera «ya está
// contabilizado», el activo aportado nunca entraría al balance; si fuera «no
// está», cada CFDI capitalizado generaría el cargo por segunda vez. Con el
// mayor inmutable (041) el segundo no se corrige editando: se revierte.
//
// Y AUN CUANDO LA RESPUESTA ES `sin_contabilizar`, ESTE MÓDULO NO POSTEA. El
// cargo se sabe —la cuenta de activo—, pero el ABONO no: puede ser el banco,
// una cuenta por pagar, o capital social si fue aportación. Eso no lo puede
// deducir el alta, y adivinarlo es exactamente lo que la casa prohíbe. Se
// devuelve un aviso que nombra el cargo y deja el abono a quien sabe cómo se
// pagó, y la ficha queda marcada para que el pendiente sea visible.

export type ContabilizacionDelAlta = 'ya_contabilizado' | 'sin_contabilizar';

export interface DatosDeAlta {
  asset_name: string;
  category_id: string;
  /** 'YYYY-MM-DD'. Cadena y no Date: `new Date('2026-03-01')` es medianoche
   *  UTC y al oeste de Greenwich retrocede un día. */
  acquisition_date: string;
  /** Decimal como cadena. Nunca number: la columna guarda cuatro decimales. */
  acquisition_cost: string;
  /** Dónde está ya el costo. Sin valor por omisión a propósito. */
  contabilizacion: ContabilizacionDelAlta;
  asset_number?: string;
  description?: string | null;
  salvage_value?: string;
  useful_life_years?: number;
  useful_life_months?: number;
  depreciation_start_date?: string;
  book_depreciation_method?: DepreciationMethod;
  tax_depreciation_method?: DepreciationMethod;
  asset_account_id?: string;
  accumulated_depreciation_account_id?: string;
  depreciation_expense_account_id?: string;
  vendor_id?: string | null;
  serial_number?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  location?: string | null;
  notes?: string | null;
  /** El asiento donde ya está el costo, cuando se conoce. */
  asiento_de_origen_id?: string | null;
}

export interface ResultadoDeAlta {
  id: string;
  asset_number: string;
  asset_name: string;
  acquisition_cost: string;
  current_book_value: string;
  useful_life_years: number;
  useful_life_months: number;
  depreciation_method: DepreciationMethod;
  depreciation_start_date: string;
  /** Qué decidió el panel, para que la respuesta lo pueda decir. */
  politicas: { base_depreciacion: string; convencion_primer_mes: string };
  avisos: string[];
}

const FECHA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Fecha en 'YYYY-MM-DD' o error que nombra el campo. */
function exigirFecha(valor: string, campo: string): string {
  const texto = valor.trim();
  if (!FECHA_ISO.test(texto)) {
    throw new ValidationError(
      `La fecha de ${campo} tiene que venir como "YYYY-MM-DD"; llegó "${valor}".`,
      campo
    );
  }
  return texto;
}

/**
 * Los años y los meses de vida útil, coherentes entre sí.
 *
 * Las dos columnas son NOT NULL y el esquema no las relaciona, así que nada
 * impide guardar 5 años y 12 meses: el motor lee los MESES y el reporte fiscal
 * lee los AÑOS, y el activo se depreciaría en un año diciendo que dura cinco.
 *
 * La regla es que los años sean el TECHO de los meses entre doce, y no la
 * igualdad `meses = años * 12`, porque las tasas de la LISR no dan años
 * enteros: el 30 % del equipo de cómputo son 40 meses, y una regla de igualdad
 * obligaría a redondear a 48 y a perder cuatro meses de deducción.
 */
export function vidaUtilCoherente(
  anios: number | undefined,
  meses: number | undefined,
  porOmisionAnios: number | null
): { anios: number; meses: number } {
  const entero = (n: number, campo: string): number => {
    if (!Number.isInteger(n) || n <= 0) {
      throw new ValidationError(
        `La vida útil en ${campo} tiene que ser un entero mayor que cero; llegó ${n}.`,
        campo
      );
    }
    return n;
  };

  if (anios === undefined && meses === undefined) {
    if (porOmisionAnios === null) {
      throw new ValidationError(
        'Ni el alta ni la categoría dicen cuánto dura el activo. Indica ' +
          '`useful_life_years` o `useful_life_months`, o dale a la categoría su ' +
          'vida por omisión.',
        'useful_life_years'
      );
    }
    const a = entero(porOmisionAnios, 'useful_life_years');
    return { anios: a, meses: a * 12 };
  }
  if (meses === undefined) {
    const a = entero(anios as number, 'useful_life_years');
    return { anios: a, meses: a * 12 };
  }
  const m = entero(meses, 'useful_life_months');
  const derivados = Math.ceil(m / 12);
  if (anios === undefined) return { anios: derivados, meses: m };

  const a = entero(anios, 'useful_life_years');
  if (a !== derivados) {
    throw new ValidationError(
      `Los años y los meses de vida útil no casan: ${m} meses caben en ${derivados} ` +
        `año(s) y se declararon ${a}. Los años son el techo de los meses entre doce ` +
        `—40 meses son 4 años—; corrige uno de los dos u omite los años y se derivan.`,
      'useful_life_years'
    );
  }
  return { anios: a, meses: m };
}

/**
 * Costo y valor de salvamento, ya validados y con los cuatro decimales de la
 * columna.
 *
 * El CHECK del esquema es ESTRICTO (`acquisition_cost > salvage_value`), no
 * `>=`: un activo cuyo salvamento iguala el costo tiene base depreciable cero
 * y no es un activo depreciable, es una ficha que nunca va a producir un
 * renglón. Se rechaza aquí con el motivo, en vez de dejar que reviente el
 * CHECK con un mensaje de Postgres.
 */
export function montosDelAlta(
  costo: string,
  salvamento: string | undefined
): { costo: string; salvamento: string } {
  const leer = (valor: string, campo: string): Decimal => {
    let d: Decimal;
    try {
      d = new Decimal(valor);
    } catch {
      throw new ValidationError(`El importe de ${campo} no es un número: "${valor}".`, campo);
    }
    if (!d.isFinite()) {
      throw new ValidationError(`El importe de ${campo} no es finito: "${valor}".`, campo);
    }
    return d;
  };

  const c = leer(costo, 'acquisition_cost');
  if (c.lessThanOrEqualTo(0)) {
    throw new ValidationError(
      `El costo de adquisición tiene que ser mayor que cero; llegó ${c.toFixed(4)}.`,
      'acquisition_cost'
    );
  }
  const s = salvamento === undefined ? new Decimal(0) : leer(salvamento, 'salvage_value');
  if (s.isNegative()) {
    throw new ValidationError(
      `El valor de salvamento no puede ser negativo; llegó ${s.toFixed(4)}.`,
      'salvage_value'
    );
  }
  if (s.greaterThanOrEqualTo(c)) {
    throw new ValidationError(
      `El valor de salvamento (${s.toFixed(4)}) no puede alcanzar ni superar el costo ` +
        `de adquisición (${c.toFixed(4)}): la base depreciable sería cero o negativa y ` +
        `el activo no produciría un solo renglón de depreciación.`,
      'salvage_value'
    );
  }
  return { costo: c.toFixed(4), salvamento: s.toFixed(4) };
}

/**
 * Desde qué día corre la depreciación cuando el llamador no lo fija.
 *
 * Bajo `mes_completo` el arranque se normaliza al día 1 del mes de
 * adquisición: eso es literalmente lo que significa la convención —la LISR
 * cuenta meses completos— y deja al motor un calendario de meses enteros sin
 * un caso especial para el primero. Bajo `proporcional_dias` el arranque es el
 * día de la compra, que es lo que el motor necesita para prorratear.
 */
export function inicioDeDepreciacion(adquisicion: string, convencion: string): string {
  return convencion === 'proporcional_dias' ? adquisicion : `${adquisicion.slice(0, 7)}-01`;
}

interface FilaCategoria {
  id: string;
  name: string;
  is_active: boolean;
  default_useful_life_years: number | null;
  default_depreciation_method: DepreciationMethod | null;
  default_asset_account_id: string | null;
  default_depreciation_account_id: string | null;
  default_expense_account_id: string | null;
}

interface FilaActivo {
  id: string;
  asset_number: string;
}

/**
 * Da de alta un activo fijo. NO postea: ver el bloque «LA COMPRA YA ESTÁ EN EL
 * MAYOR».
 */
export async function crearActivo(
  entityId: string,
  datos: DatosDeAlta,
  userId: string,
  opts?: { client?: pg.PoolClient }
): Promise<ResultadoDeAlta> {
  const correr = async (client: pg.PoolClient): Promise<ResultadoDeAlta> => {
    const tenantId = await tenantDe(client, entityId);
    const avisos: string[] = [];

    const nombre = datos.asset_name?.trim() ?? '';
    if (nombre.length === 0) {
      throw new ValidationError('El activo necesita nombre: `asset_name` llegó vacío.', 'asset_name');
    }

    const adquisicion = exigirFecha(datos.acquisition_date, 'acquisition_date');
    const { costo, salvamento } = montosDelAlta(datos.acquisition_cost, datos.salvage_value);

    // LA CATEGORÍA, ACOTADA POR ENTIDAD DENTRO DEL SQL. La foránea
    // `category_id → asset_categories(id)` acepta la categoría de cualquier
    // entidad del sistema, y con ella entrarían las tres cuentas por omisión
    // del catálogo AJENO. Cero filas significa a la vez «no existe» y «no es
    // tuya», y no hay ningún punto donde el programa pueda distinguirlas.
    const cat = await client.query<FilaCategoria>(
      `SELECT id, name, is_active, default_useful_life_years, default_depreciation_method,
              default_asset_account_id, default_depreciation_account_id, default_expense_account_id
         FROM asset_categories
        WHERE id = $1 AND entity_id = $2`,
      [datos.category_id, entityId]
    );
    const categoria = cat.rows[0];
    if (!categoria) throw new NotFoundError('Asset Category', datos.category_id);
    if (!categoria.is_active) {
      throw new ValidationError(
        `La categoría "${categoria.name}" está dada de baja: no admite altas nuevas. ` +
          'Reactívala o elige otra.',
        'category_id'
      );
    }

    const vida = vidaUtilCoherente(
      datos.useful_life_years,
      datos.useful_life_months,
      categoria.default_useful_life_years
    );

    // ── LOS DOS CRITERIOS QUE NO ELIGE ESTE CÓDIGO ─────────────────────
    //
    // Un activo lleva DOS métodos a propósito (la 056 lo explica): el contable
    // sigue la vida útil de la NIF C-6 y el fiscal las tasas máximas de la
    // LISR, y son números distintos sobre el mismo bien. `depreciation_method`
    // es el que el motor lee y por tanto el que llega al mayor, así que cuál
    // de los dos ocupa esa columna es la decisión del despacho, no una
    // constante. Mientras nadie la conteste rige el defecto declarado.
    const base = await getPolicy({ tenantId, entityId }, 'base_depreciacion', client);
    const metodoContable =
      datos.book_depreciation_method ??
      categoria.default_depreciation_method ??
      DepreciationMethod.STRAIGHT_LINE;
    // La LISR art. 31 deduce aplicando el por ciento sobre el monto ORIGINAL
    // de la inversión: eso es línea recta y no admite otra cosa. El campo
    // sigue siendo parametrizable porque el esquema es multipaís.
    const metodoFiscal = datos.tax_depreciation_method ?? DepreciationMethod.STRAIGHT_LINE;
    const metodoQueRige = base.value === 'tasa_lisr' ? metodoFiscal : metodoContable;

    // La convención decide desde qué día corre la primera cuota; ver
    // `inicioDeDepreciacion`.
    const convencion = await getPolicy({ tenantId, entityId }, 'convencion_primer_mes', client);
    const inicio =
      datos.depreciation_start_date === undefined
        ? inicioDeDepreciacion(adquisicion, convencion.value)
        : exigirFecha(datos.depreciation_start_date, 'depreciation_start_date');

    // La comprobación es sobre la fecha EXPLÍCITA. La derivada puede caer
    // antes de la compra —del 20 de marzo se va al 1 de marzo— y eso no es un
    // error: es la convención de mes completo. Lo que no se admite es que el
    // usuario fije a mano un arranque anterior al día en que el bien existió.
    if (datos.depreciation_start_date !== undefined && inicio < adquisicion) {
      throw new ValidationError(
        `La depreciación no puede arrancar el ${inicio}, antes de la adquisición ` +
          `(${adquisicion}). Si lo que buscas es la convención de mes completo, omite ` +
          '`depreciation_start_date` y el sistema la deriva del panel.',
        'depreciation_start_date'
      );
    }

    // ── LAS TRES CUENTAS ───────────────────────────────────────────────
    const cuentaActivo = datos.asset_account_id ?? categoria.default_asset_account_id;
    const cuentaAcumulada =
      datos.accumulated_depreciation_account_id ?? categoria.default_depreciation_account_id;
    const cuentaGasto =
      datos.depreciation_expense_account_id ?? categoria.default_expense_account_id;

    const faltantes = [
      cuentaActivo === null || cuentaActivo === undefined ? 'asset_account_id' : null,
      cuentaAcumulada === null || cuentaAcumulada === undefined
        ? 'accumulated_depreciation_account_id'
        : null,
      cuentaGasto === null || cuentaGasto === undefined
        ? 'depreciation_expense_account_id'
        : null,
    ].filter((c): c is string => c !== null);
    if (faltantes.length > 0) {
      throw new ValidationError(
        `Faltan cuentas para el activo (${faltantes.join(', ')}) y la categoría ` +
          `"${categoria.name}" no las trae por omisión. Pásalas en el alta o ` +
          'complétale las cuentas a la categoría.',
        faltantes[0]
      );
    }

    // Las tres, acotadas por entidad EN EL SQL y en un solo viaje. La foránea
    // `accounts(id)` no mira el catálogo: sin esto, un activo puede quedar
    // apuntando a la cuenta de gasto de otra entidad y depreciar contra su
    // mayor todos los meses. Los encabezados se excluyen por el mismo SELECT:
    // el CHECK de la 001 les prohíbe movimientos, así que un activo colgado de
    // uno no se puede depreciar nunca.
    const pedidas = [cuentaActivo, cuentaAcumulada, cuentaGasto] as string[];
    const halladas = await client.query<{ id: string }>(
      `SELECT id FROM accounts
        WHERE entity_id = $1 AND is_header = false AND id = ANY($2::uuid[])`,
      [entityId, [...new Set(pedidas)]]
    );
    const validas = new Set(halladas.rows.map((r) => r.id));
    const rechazadas = [
      validas.has(cuentaActivo as string) ? null : 'asset_account_id',
      validas.has(cuentaAcumulada as string) ? null : 'accumulated_depreciation_account_id',
      validas.has(cuentaGasto as string) ? null : 'depreciation_expense_account_id',
    ].filter((c): c is string => c !== null);
    if (rechazadas.length > 0) {
      throw new ValidationError(
        `Estas cuentas no están en el catálogo de esta entidad, o son de encabezado y ` +
          `no admiten movimientos: ${rechazadas.join(', ')}.`,
        rechazadas[0]
      );
    }

    // El proveedor también: `vendors(id)` es otra foránea sin frontera.
    if (datos.vendor_id !== undefined && datos.vendor_id !== null) {
      const v = await client.query<{ id: string }>(
        'SELECT id FROM vendors WHERE id = $1 AND entity_id = $2',
        [datos.vendor_id, entityId]
      );
      if (v.rows.length === 0) throw new NotFoundError('Vendor', datos.vendor_id);
    }

    const folio =
      datos.asset_number?.trim() ??
      (await nextEntityNumber(client, entityId, 'fixed_asset', 'AF', adquisicion));

    // El estado contable del costo no tiene columna: `fixed_assets` nació sin
    // ella y la 056 no la añade. Va en `tags` —JSONB libre— para que el hecho
    // quede escrito y consultable mientras no exista una columna propia. Es
    // deuda declarada, no un lugar elegido.
    const tags = {
      contabilizacion: {
        estado: datos.contabilizacion,
        asiento_de_origen_id: datos.asiento_de_origen_id ?? null,
      },
      depreciacion: {
        base: base.value,
        convencion_primer_mes: convencion.value,
        metodo_contable: metodoContable,
        metodo_fiscal: metodoFiscal,
      },
    };

    let creado: FilaActivo;
    try {
      const ins = await client.query<FilaActivo>(
        `INSERT INTO fixed_assets (
           entity_id, asset_number, asset_name, description, category_id,
           acquisition_date, acquisition_cost, vendor_id, salvage_value,
           useful_life_years, useful_life_months,
           depreciation_method, book_depreciation_method, tax_depreciation_method,
           depreciation_start_date, current_book_value, accumulated_depreciation,
           asset_account_id, accumulated_depreciation_account_id,
           depreciation_expense_account_id,
           serial_number, manufacturer, model, location, notes, tags,
           status, created_by
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11,
           $12, $13, $14,
           $15, $16, 0,
           $17, $18,
           $19,
           $20, $21, $22, $23, $24, $25,
           'active', $26
         )
         RETURNING id, asset_number`,
        [
          entityId,
          folio,
          nombre,
          datos.description ?? null,
          categoria.id,
          adquisicion,
          costo,
          datos.vendor_id ?? null,
          salvamento,
          vida.anios,
          vida.meses,
          metodoQueRige,
          metodoContable,
          metodoFiscal,
          inicio,
          // El valor en libros arranca en el costo: todavía no se ha
          // depreciado un solo peso, y la acumulada arranca en cero.
          costo,
          cuentaActivo,
          cuentaAcumulada,
          cuentaGasto,
          datos.serial_number ?? null,
          datos.manufacturer ?? null,
          datos.model ?? null,
          datos.location ?? null,
          datos.notes ?? null,
          JSON.stringify(tags),
          userId,
        ]
      );
      creado = ins.rows[0];
    } catch (err) {
      // 23505 es la UNIQUE(asset_number, entity_id). Se traduce porque el
      // mensaje de Postgres nombra el índice y no el problema.
      if ((err as { code?: string }).code === '23505') {
        throw new ConflictError(
          `Ya hay un activo con el número "${folio}" en esta entidad.`
        );
      }
      throw err;
    }

    await registrarAuditoria(client, {
      tenantId,
      userId,
      action: 'create',
      entityType: 'fixed_assets',
      entityId: creado.id,
      newValues: {
        asset_number: creado.asset_number,
        asset_name: nombre,
        acquisition_cost: costo,
        depreciation_method: metodoQueRige,
        useful_life_months: vida.meses,
        contabilizacion: datos.contabilizacion,
      },
      reason: `Alta de activo fijo (${categoria.name})`,
    });

    if (datos.contabilizacion === 'sin_contabilizar') {
      avisos.push(
        `El costo de este activo NO está en el mayor: el alta registra el bien y no ` +
          `postea. Falta el cargo de ${costo} a la cuenta de activo; el abono depende ` +
          `de cómo se pagó (banco, cuentas por pagar o capital si fue aportación) y esa ` +
          `es una decisión que el alta no puede tomar por ti.`
      );
    }
    if (!base.defined) {
      avisos.push(
        `Rige la depreciación ${base.value} porque nadie ha contestado ` +
          '`base_depreciacion`: es el defecto declarado, no una elección del despacho.'
      );
    }
    if (!convencion.defined) {
      avisos.push(
        `El arranque se fijó en ${inicio} por la convención ${convencion.value}, que es ` +
          'el defecto de `convencion_primer_mes` y no una elección del despacho.'
      );
    }

    return {
      id: creado.id,
      asset_number: creado.asset_number,
      asset_name: nombre,
      acquisition_cost: costo,
      current_book_value: costo,
      useful_life_years: vida.anios,
      useful_life_months: vida.meses,
      depreciation_method: metodoQueRige,
      depreciation_start_date: inicio,
      politicas: { base_depreciacion: base.value, convencion_primer_mes: convencion.value },
      avisos,
    };
  };

  return opts?.client ? correr(opts.client) : withTransaction(correr);
}
