import type pg from 'pg';
import Decimal from 'decimal.js';
import { query } from '../../../database/connection.js';
import { AccountingError, ConflictError, ValidationError } from '../../../utils/errors.js';
import type { CheckLevel, CheckResult } from '../../../ai/doctor-service.js';
import {
  factorDeActualizacion,
  normalizarBase,
  type FactorDeActualizacion,
  type IndiceEnPeriodo,
  type OpcionesFactor,
} from './factor.js';
import type { FilaDeArchivo } from './parseo.js';
import {
  compararPeriodos,
  formatearPeriodo,
  nombrarPeriodo,
  periodosEntre,
  type Periodo,
} from './periodo.js';

// ============================================================
// F07c · LA SERIE DEL INPC: LECTOR Y ESCRITOR
//
// EL MOLDE ES R4 (src/services/fx/rate-service.ts) y la copia es deliberada:
// el tipo de cambio y el INPC son EL MISMO TIPO DE DATO —una serie publicada
// por una autoridad, con periodo de vigencia, que el sistema NO calcula sino
// consulta— y resolverlos de dos maneras distintas garantizaría que un día
// difieran. De R4 vienen las tres decisiones que importan:
//
//  1. LA RESOLUCIÓN FALLA CERRADO. Si no hay índice para el mes pedido, se
//     lanza NOMBRANDO EL MES, en vez de arrastrar el último conocido. R4 lo
//     razona sobre el criterio fiscal (DOF y FIX del mismo día son números
//     distintos); aquí es peor todavía: arrastrar el INPC de un mes al
//     siguiente produce un factor de 1.0000, y el catálogo escribió con
//     negritas que este cálculo «falla duro ante un mes faltante, nunca cae a
//     1.0». Un 1.0 arrastrado no se distingue de un 1.0 legítimo.
//  2. LA ESCRITURA EXIGE AUTOR. `inpc_serie.capturado_por` es NULLABLE en la
//     065 —al revés que `exchange_rates.created_by`—, así que la cota la pone
//     ESTE servicio: sin autor no se importa. La tabla es global y compartida
//     por todos los inquilinos; una carga sin firma es un dato que nadie
//     puede desandar.
//  3. LA FUENTE ES EXPLÍCITA. No hay omisión: quien importa dice si viene del
//     DOF, del INEGI o de una captura a mano.
//
// LA TABLA ES GLOBAL, SIN tenant_id (lo dice el COMMENT de la 065): el índice
// de un mes es un hecho del país, no del inquilino. Aquí, igual que en R4 y
// en el catálogo c_CodAgrup de F07a, NO hay entidad dentro del SQL, y es la
// excepción que la migración sostiene, no un descuido.
//
// LO QUE ESTE MÓDULO NO HACE, Y HAY QUE DECIRLO: no toca la depreciación. El
// art. 31 de la LISR actualiza el MOI con este factor, pero cablearlo es otro
// tramo —hay que leer `book_depreciation_method`/`tax_depreciation_method`,
// sustituir MACRS por la tabla del art. 34 y escribir `schedule_type='tax'`—
// y ninguno de esos tres pasos ocurre aquí.
// ============================================================

/** Las tres fuentes del CHECK de `inpc_serie.fuente` (065). */
export const FUENTES_INPC = ['dof', 'inegi', 'manual'] as const;
export type FuenteInpc = (typeof FUENTES_INPC)[number];

export function exigirFuenteInpc(fuente: string): FuenteInpc {
  if (!(FUENTES_INPC as readonly string[]).includes(fuente)) {
    throw new ValidationError(
      `Fuente "${fuente}" desconocida para el INPC. Las válidas son: ${FUENTES_INPC.join(', ')}.`
    );
  }
  return fuente as FuenteInpc;
}

/** Una fila de la serie tal como vive en la base. */
export interface RenglonInpc {
  anio: number;
  mes: number;
  valor: string;
  base: string;
  fuente: string;
  publicado_el: string | null;
  capturado_el: string;
  capturado_por: string | null;
}

const COLUMNAS =
  'anio, mes, valor::text AS valor, base, fuente, publicado_el::text AS publicado_el, ' +
  'capturado_el::text AS capturado_el, capturado_por';

/** El índice resuelto: lo que el factor necesita más su procedencia. */
export interface IndiceResuelto extends IndiceEnPeriodo {
  fuente: string;
  publicadoEl: string | null;
}

function aIndice(r: RenglonInpc): IndiceResuelto {
  return {
    periodo: { anio: r.anio, mes: r.mes },
    valor: r.valor,
    base: r.base,
    fuente: r.fuente,
    publicadoEl: r.publicado_el,
  };
}

/** Las bases cargadas para un mes. Vacío = ese mes no está. */
export async function basesDelPeriodo(periodo: Periodo): Promise<string[]> {
  const r = await query<{ base: string }>(
    'SELECT base FROM inpc_serie WHERE anio = $1 AND mes = $2 ORDER BY base',
    [periodo.anio, periodo.mes]
  );
  return r.rows.map((f) => f.base);
}

export interface OpcionesResolucion {
  /** Base exigida. Sin ella, el mes debe tener una sola cargada. */
  base?: string;
}

/**
 * El índice de un mes. FALLA CERRADO en los dos sentidos:
 *
 *  · si el mes no está, se lanza nombrándolo —jamás se arrastra el anterior—;
 *  · si el mes está en VARIAS bases y la llamada no dijo cuál, se lanza
 *    nombrando las bases. Elegir una sería adivinar la serie, y la serie mal
 *    elegida no da error: da un factor plausible (ver factor.ts).
 *
 * Deliberadamente NO se busca «la base que ambas puntas comparten»: eso haría
 * que el resultado dependiera de qué más hay cargado en la instalación, que es
 * exactamente la clase de número que este frente existe para no producir.
 */
export async function resolverIndice(
  periodo: Periodo,
  opts: OpcionesResolucion = {}
): Promise<IndiceResuelto> {
  const base = opts.base === undefined ? null : normalizarBase(opts.base);
  const r = await query<RenglonInpc>(
    `SELECT ${COLUMNAS} FROM inpc_serie
      WHERE anio = $1 AND mes = $2 AND ($3::varchar IS NULL OR base = $3)
      ORDER BY base`,
    [periodo.anio, periodo.mes, base]
  );

  if (r.rows.length === 0) {
    const cargadas = base === null ? [] : await basesDelPeriodo(periodo);
    throw new AccountingError(
      'INPC_SIN_INDICE',
      `No hay INPC de ${nombrarPeriodo(periodo)}${base === null ? '' : ` en base "${base}"`}. ` +
        (cargadas.length > 0
          ? `Ese mes sí está cargado en ${cargadas.map((b) => `"${b}"`).join(', ')}. `
          : '') +
        'No uso el del mes anterior: arrastrarlo daría un factor de 1.0000 indistinguible de uno ' +
        'legítimo. Cárgalo con mnemosine inpc import --file <archivo>.',
      { periodo: formatearPeriodo(periodo), base, basesCargadas: cargadas }
    );
  }

  if (r.rows.length > 1) {
    const bases = r.rows.map((f) => f.base);
    throw new AccountingError(
      'INPC_BASE_AMBIGUA',
      `${nombrarPeriodo(periodo)} está cargado en ${bases.length} bases distintas ` +
        `(${bases.map((b) => `"${b}"`).join(', ')}) y no me dijiste cuál. No elijo serie por ti: ` +
        'índices de bases distintas no se dividen entre sí. Indica --base.',
      { periodo: formatearPeriodo(periodo), bases }
    );
  }

  return aIndice(r.rows[0]);
}

export interface FiltrosSerie {
  desde?: Periodo;
  hasta?: Periodo;
  base?: string;
  fuente?: FuenteInpc;
}

/** Lista la serie cargada. Lectura global: ver la cabecera del módulo. */
export async function listarSerie(filtros: FiltrosSerie = {}): Promise<RenglonInpc[]> {
  const condiciones: string[] = [];
  const params: unknown[] = [];

  // (anio, mes) se comparan como PAR ORDENADO. Filtrar el año y el mes por
  // separado dejaría fuera «de julio de 2023 a marzo de 2024»: pediría mes
  // entre 7 y 3, que no es ningún mes.
  if (filtros.desde) {
    params.push(filtros.desde.anio, filtros.desde.mes);
    condiciones.push(`(anio, mes) >= ($${params.length - 1}::smallint, $${params.length}::smallint)`);
  }
  if (filtros.hasta) {
    params.push(filtros.hasta.anio, filtros.hasta.mes);
    condiciones.push(`(anio, mes) <= ($${params.length - 1}::smallint, $${params.length}::smallint)`);
  }
  if (filtros.base !== undefined) {
    params.push(normalizarBase(filtros.base));
    condiciones.push(`base = $${params.length}`);
  }
  if (filtros.fuente !== undefined) {
    params.push(filtros.fuente);
    condiciones.push(`fuente = $${params.length}`);
  }

  const r = await query<RenglonInpc>(
    `SELECT ${COLUMNAS} FROM inpc_serie
     ${condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : ''}
     ORDER BY anio, mes, base`,
    params
  );
  return r.rows;
}

export interface EntradaImportacion {
  filas: FilaDeArchivo[];
  /** DOF, INEGI o captura a mano. Sin omisión: ver la cabecera. */
  fuente: FuenteInpc;
  /** Quién carga. La 065 lo deja NULL; este servicio no. */
  capturadoPor: string;
  /** Cuenta qué pasaría sin escribir nada. */
  dryRun?: boolean;
  client?: pg.PoolClient;
}

export interface ResultadoImportacion {
  ofrecidas: number;
  insertadas: number;
  /** Ya estaban con el MISMO valor: la carga es idempotente por mes y base. */
  yaEstaban: number;
  dryRun: boolean;
  bases: string[];
  primero: string | null;
  ultimo: string | null;
}

/**
 * Carga la serie. Idempotente por (anio, mes, base), que es la llave primaria
 * de la 065: repetir el mismo archivo no duplica ni pisa.
 *
 * Un mes que YA ESTÁ con OTRO valor no se pisa ni se ignora: se acusa. Un
 * índice publicado no cambia, así que la discrepancia significa que uno de los
 * dos archivos está mal, y decidir cuál no es trabajo de un importador —el
 * DO NOTHING silencioso dejaría el número viejo dentro de todos los factores
 * ya calculados sin que nadie lo supiera.
 */
export async function importarSerie(entrada: EntradaImportacion): Promise<ResultadoImportacion> {
  const { filas, dryRun = false } = entrada;
  const fuente = exigirFuenteInpc(entrada.fuente);
  if (typeof entrada.capturadoPor !== 'string' || entrada.capturadoPor.trim() === '') {
    throw new ValidationError(
      'La carga del INPC exige autor: la tabla es global y una carga sin firma no se puede ' +
        'desandar. (La columna admite NULL; este servicio no.)'
    );
  }
  if (filas.length === 0) {
    throw new ValidationError('No hay filas que importar.');
  }

  const ejecutar = entrada.client
    ? <T extends pg.QueryResultRow>(sql: string, params: unknown[]) =>
        entrada.client!.query<T>(sql, params)
    : query;

  const anios = filas.map((f) => f.periodo.anio);
  const meses = filas.map((f) => f.periodo.mes);
  const bases = filas.map((f) => f.base);

  const existentes = await ejecutar<{ anio: number; mes: number; base: string; valor: string }>(
    `SELECT anio, mes, base, valor::text AS valor FROM inpc_serie
      WHERE (anio, mes, base) IN (
        SELECT * FROM UNNEST($1::smallint[], $2::smallint[], $3::varchar[])
      )`,
    [anios, meses, bases]
  );

  const yaEnBase = new Map<string, string>();
  for (const f of existentes.rows) {
    yaEnBase.set(`${f.anio}|${f.mes}|${f.base}`, f.valor);
  }

  const discrepantes: string[] = [];
  const nuevas: FilaDeArchivo[] = [];
  let yaEstaban = 0;
  for (const fila of filas) {
    const guardado = yaEnBase.get(`${fila.periodo.anio}|${fila.periodo.mes}|${fila.base}`);
    if (guardado === undefined) {
      nuevas.push(fila);
      continue;
    }
    // DECIMAL(12,6) vuelve como «133.555000»; la comparación es numérica.
    if (new Decimal(guardado).equals(new Decimal(fila.valor))) {
      yaEstaban++;
      continue;
    }
    discrepantes.push(
      `línea ${fila.linea}: ${formatearPeriodo(fila.periodo)} base "${fila.base}" está ` +
        `guardado en ${guardado} y el archivo trae ${fila.valor}`
    );
  }

  if (discrepantes.length > 0) {
    const muestra = discrepantes.slice(0, 5);
    throw new ConflictError(
      `El archivo contradice ${discrepantes.length} mes(es) ya cargados y no los piso: ` +
        `${muestra.join('; ')}${discrepantes.length > muestra.length ? '; …' : ''}. ` +
        'Un índice publicado no cambia; corrige el archivo o el dato guardado antes de reintentar.'
    );
  }

  let insertadas = 0;
  if (!dryRun && nuevas.length > 0) {
    const r = await ejecutar(
      `INSERT INTO inpc_serie (anio, mes, valor, base, publicado_el, fuente, capturado_por)
       SELECT t.anio, t.mes, t.valor, t.base, t.publicado_el, $6, $7::uuid
         FROM UNNEST(
           $1::smallint[], $2::smallint[], $3::numeric[], $4::varchar[], $5::date[]
         ) AS t(anio, mes, valor, base, publicado_el)
       ON CONFLICT (anio, mes, base) DO NOTHING`,
      [
        nuevas.map((f) => f.periodo.anio),
        nuevas.map((f) => f.periodo.mes),
        nuevas.map((f) => f.valor),
        nuevas.map((f) => f.base),
        nuevas.map((f) => f.publicadoEl),
        fuente,
        entrada.capturadoPor,
      ]
    );
    insertadas = r.rowCount ?? 0;
  } else if (dryRun) {
    insertadas = nuevas.length;
  }

  const ordenadas = [...filas].sort((a, b) => compararPeriodos(a.periodo, b.periodo));
  return {
    ofrecidas: filas.length,
    insertadas,
    yaEstaban,
    dryRun,
    bases: [...new Set(bases)].sort(),
    primero: ordenadas.length > 0 ? formatearPeriodo(ordenadas[0].periodo) : null,
    ultimo: ordenadas.length > 0 ? formatearPeriodo(ordenadas[ordenadas.length - 1].periodo) : null,
  };
}

export interface OpcionesVerificacion {
  /** Hasta qué mes tiene que llegar la serie para la corrida que viene. */
  hasta: Periodo;
  /** Desde dónde exigir continuidad. Por omisión, el primer mes cargado. */
  desde?: Periodo;
  base?: string;
}

/** Cuántos meses faltantes se nombran antes de resumir. */
const MUESTRA_DE_HUECOS = 12;

/**
 * Los hallazgos de `inpc check`. La forma es la de `CheckResult` de doctor
 * —importada como TIPO, sin arrastrar el módulo— para que la superficie los
 * pinte con el renderizador que ya existe en vez de inventar otro.
 *
 * Un mes faltante es `fail` y no `warn`: es justamente el que una corrida
 * fiscal necesitaría, y el catálogo lo declara hallazgo bloqueante.
 */
export async function verificarSerie(opts: OpcionesVerificacion): Promise<{
  checks: CheckResult[];
  peor: CheckLevel;
}> {
  const base = opts.base === undefined ? undefined : normalizarBase(opts.base);
  const checks: CheckResult[] = [];

  const cargada = await listarSerie({ base, hasta: opts.hasta });
  if (cargada.length === 0) {
    checks.push({
      name: 'inpc-serie',
      level: 'fail',
      detail: `No hay ningún INPC cargado${base ? ` en base "${base}"` : ''} hasta ` +
        `${formatearPeriodo(opts.hasta)}. Sin serie no hay factor de actualización, y sin factor ` +
        'no hay deducción de inversiones del art. 31 ni ajuste anual por inflación.',
      fix: 'mnemosine inpc import --file <archivo> --source dof',
    });
    return { checks, peor: 'fail' };
  }

  // Los meses PRESENTES, no las filas: un mes cargado en dos bases son dos
  // filas y un solo mes, y contar filas anunciaría una cobertura que no hay.
  const presentes = new Set(cargada.map((f) => formatearPeriodo({ anio: f.anio, mes: f.mes })));

  checks.push({
    name: 'inpc-serie',
    level: 'ok',
    detail: `${presentes.size} mes(es) cargados en ${cargada.length} fila(s), de ` +
      `${formatearPeriodo({ anio: cargada[0].anio, mes: cargada[0].mes })} a ` +
      `${formatearPeriodo({ anio: cargada[cargada.length - 1].anio, mes: cargada[cargada.length - 1].mes })}.`,
  });
  const desde = opts.desde ?? { anio: cargada[0].anio, mes: cargada[0].mes };
  const faltantes = periodosEntre(desde, opts.hasta)
    .map(formatearPeriodo)
    .filter((p) => !presentes.has(p));

  if (faltantes.length === 0) {
    checks.push({
      name: 'inpc-huecos',
      level: 'ok',
      detail: `Sin huecos entre ${formatearPeriodo(desde)} y ${formatearPeriodo(opts.hasta)}.`,
    });
  } else {
    const muestra = faltantes.slice(0, MUESTRA_DE_HUECOS);
    checks.push({
      name: 'inpc-huecos',
      level: 'fail',
      detail: `Faltan ${faltantes.length} mes(es) entre ${formatearPeriodo(desde)} y ` +
        `${formatearPeriodo(opts.hasta)}: ${muestra.join(', ')}` +
        `${faltantes.length > muestra.length ? ', …' : ''}. Cualquier factor que los cruce ` +
        'se rechaza, no se estima.',
      fix: 'mnemosine inpc import --file <archivo> --source dof',
    });
  }

  // Un mes en dos bases NO es un error de datos —el INEGI republica la serie
  // completa cuando rebasa— pero vuelve AMBIGUA la resolución sin --base, así
  // que se avisa. Con --base la ambigüedad no existe y el aviso no aparece.
  if (base === undefined) {
    const porMes = new Map<string, Set<string>>();
    for (const f of cargada) {
      const k = formatearPeriodo({ anio: f.anio, mes: f.mes });
      const s = porMes.get(k) ?? new Set<string>();
      s.add(f.base);
      porMes.set(k, s);
    }
    const ambiguos = [...porMes.entries()].filter(([, s]) => s.size > 1).map(([k]) => k);
    checks.push(
      ambiguos.length === 0
        ? { name: 'inpc-bases', level: 'ok', detail: 'Cada mes cargado tiene una sola base.' }
        : {
            name: 'inpc-bases',
            level: 'warn',
            detail: `${ambiguos.length} mes(es) están cargados en más de una base ` +
              `(${ambiguos.slice(0, MUESTRA_DE_HUECOS).join(', ')}). No es un error —el INEGI ` +
              'republica la serie al rebasar— pero resolverlos exige decir --base.',
            fix: 'mnemosine inpc factor calculate <acq-month> <period> --base "<base>"',
          }
    );
  }

  const peor: CheckLevel = checks.some((c) => c.level === 'fail')
    ? 'fail'
    : checks.some((c) => c.level === 'warn')
      ? 'warn'
      : 'ok';
  return { checks, peor };
}

export interface OpcionesFactorEntrePeriodos extends OpcionesFactor, OpcionesResolucion {}

/**
 * El factor entre dos meses leyendo la serie guardada. Resuelve cada punta por
 * separado —cada una puede faltar, y el mensaje debe decir CUÁL falta— y
 * delega la aritmética y la guarda de bases en `factorDeActualizacion`, que es
 * pura y está probada sin base de datos.
 */
export async function factorEntrePeriodos(
  antiguo: Periodo,
  reciente: Periodo,
  opts: OpcionesFactorEntrePeriodos = {}
): Promise<FactorDeActualizacion & { fuentes: { antiguo: string; reciente: string } }> {
  const iAntiguo = await resolverIndice(antiguo, { base: opts.base });
  const iReciente = await resolverIndice(reciente, { base: opts.base });
  return {
    ...factorDeActualizacion(iAntiguo, iReciente, { decimales: opts.decimales }),
    fuentes: { antiguo: iAntiguo.fuente, reciente: iReciente.fuente },
  };
}
