import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { getPolicy } from '../policy/policy-service.js';
import { ValidationError } from '../../utils/errors.js';
import { DepreciationMethod } from '../../types/index.js';
import type { FixedAsset } from '../../types/index.js';
import {
  TIPO_DE_CALENDARIO,
  calculateDepreciation,
  esImporteCero,
  indiceDeCalendario,
  type BaseDepreciacion,
  type ConvencionPrimerMes,
  type DepreciationInput,
} from './depreciation-math.js';
import {
  criteriosDeLaCorrida,
  fechaDelAsiento,
  inquilinoDeLaEntidad,
  medianocheLocal,
  metodoDeLaBase,
  periodoDeLaEntidad,
} from './depreciation.js';

// ============================================================
// EL PLAN DE LA CORRIDA: LO QUE VA A PASAR, ANTES DE QUE PASE (F06a)
//
// `runMonthlyDepreciation` calcula y postea de golpe. No tiene ensayo, y por
// eso la única forma de saber qué iba a hacer era dejarla hacerlo. Este módulo
// es la mitad que faltaba: recorre los mismos activos, con los mismos
// criterios y la misma aritmética, y devuelve el resultado SIN ESCRIBIR NADA.
//
// LO QUE NO HACE, A PROPÓSITO: no recalcula el periodo, ni relee las
// políticas por su cuenta, ni decide qué método rige. Las cuatro puertas
// —`periodoDeLaEntidad`, `criteriosDeLaCorrida`, `metodoDeLaBase`,
// `fechaDelAsiento`— son las de `depreciation.ts`, exportadas para esto. Un
// plan que dedujera esas cosas por su cuenta sería una SEGUNDA implementación
// del acto viviendo en la capa de presentación, y el día que las dos
// divergieran la que miente sería justo la que el operador leyó antes de decir
// que sí.
//
// LO QUE SÍ DUPLICA, Y CÓMO SE CONTIENE. La lista de motivos por los que un
// activo no produce renglón —ya corrido, aún no en servicio, vida terminada,
// importe cero, unidades de producción— vive en el bucle de la corrida y no se
// puede llamar sin correrla. Se repite aquí, con los mismos predicados y en el
// mismo orden. La red que impide que se separen no es la disciplina: es que
// `depreciation post` COMPARA el plan que enseñó contra lo que la corrida hizo
// de verdad y acusa la diferencia. Una divergencia deja de ser silenciosa el
// primer mes que ocurra.
//
// TODA LECTURA ACOTADA POR ENTIDAD DENTRO DEL SQL. `depreciation_schedules` no
// tiene `entity_id`, así que el alcance entra por el JOIN contra
// `fixed_assets`; las cuentas se comprueban contra el catálogo de ESTA entidad
// y no por la foránea, que acepta la cuenta de cualquiera.
// ============================================================

/** Los decimales que guarda `DECIMAL(19,4)`. No se recorta a dos. */
const DECIMALES = 4;

export const MOTIVOS_DE_OMISION = [
  /** Ya tiene renglón de este periodo y este libro: la corrida lo salta. */
  'ya_corrido',
  /** El periodo es anterior a su entrada en servicio. */
  'aun_no_en_servicio',
  /** Su calendario ya terminó. */
  'vida_terminada',
  /** La cola de un activo agotado: un asiento de cero no dice nada. */
  'importe_cero',
  /** Se deprecia por unidades y la corrida mensual no sabe cuántas se hicieron. */
  'unidades_de_produccion',
  /** El calendario no se pudo armar (datos incompletos del activo). */
  'sin_calendario',
] as const;
export type MotivoDeOmision = (typeof MOTIVOS_DE_OMISION)[number];

/**
 * Los motivos que dejan al periodo DEBIENDO un renglón.
 *
 * «Aún no en servicio», «vida terminada» e «importe cero» no son deudas: el
 * activo no debe nada este mes. «Ya corrido» tampoco: está hecho. Los otros
 * dos sí — hay un gasto que el mes tendría que reconocer y no lo va a
 * reconocer—, y son los que la política `depreciacion_faltante_al_cierre`
 * cuenta.
 */
const MOTIVOS_PENDIENTES: ReadonlySet<string> = new Set<MotivoDeOmision>([
  'unidades_de_produccion',
  'sin_calendario',
]);

export interface RenglonDelPlan {
  asset_id: string;
  asset_number: string;
  asset_name: string;
  categoria: string;
  metodo: DepreciationMethod;
  /** Meses de calendario desde la entrada en servicio. */
  indice: number;
  periodos: number;
  base_inicial: string;
  depreciacion: string;
  acumulada: string;
  valor_en_libros: string;
  cuenta_gasto: string;
  cuenta_gasto_id: string;
  cuenta_acumulada: string;
  cuenta_acumulada_id: string;
}

export interface OmisionDelPlan {
  asset_id: string;
  asset_number: string;
  asset_name: string;
  categoria: string;
  motivo: MotivoDeOmision;
  detalle: string;
  /** true cuando el periodo se queda debiendo el renglón de este activo. */
  pendiente: boolean;
}

export interface PlanDeDepreciacion {
  entity_id: string;
  fiscal_period_id: string;
  periodo: string;
  inicio: string;
  fin: string;
  /** La fecha con la que se fecharán los asientos: el último día del periodo. */
  fecha_del_asiento: string;
  base: BaseDepreciacion;
  base_definida: boolean;
  convencion: ConvencionPrimerMes;
  convencion_definida: boolean;
  tipo_calendario: 'book' | 'tax';
  renglones: RenglonDelPlan[];
  omitidos: OmisionDelPlan[];
  /** Suma de lo que se posteará, con los cuatro decimales de la columna. */
  total: string;
  /** Cuántos activos dejan al periodo debiendo su renglón. */
  pendientes: number;
  /** Qué dijo el panel sobre cerrar con depreciación pendiente. */
  faltante_al_cierre: { politica: string; definida: boolean };
  /**
   * Identidad corta del plan, para el ojo y la bitácora: dos corridas con la
   * misma huella postean exactamente lo mismo. La verificación de
   * `depreciation post --file` NO se apoya en ella —compara par por par, que
   * es lo que permite nombrar el activo que se movió—, pero un operador que ve
   * la misma huella en la pantalla y en el archivo aprobado ya sabe que no
   * hace falta leer las cincuenta filas.
   */
  huella: string;
}

interface FilaDeActivo extends FixedAsset {
  categoria: string | null;
  cuenta_gasto: string | null;
  gasto_es_encabezado: boolean | null;
  cuenta_acumulada: string | null;
  acumulada_es_encabezado: boolean | null;
}

function iso(fecha: Date): string {
  const mes = String(fecha.getMonth() + 1).padStart(2, '0');
  const dia = String(fecha.getDate()).padStart(2, '0');
  return `${fecha.getFullYear()}-${mes}-${dia}`;
}

/**
 * La huella del plan.
 *
 * Cubre lo que cambiaría el asiento —el periodo, el libro, los criterios y el
 * par (activo, importe)— y nada más. No cubre el nombre del activo ni el orden
 * de presentación: un plan aprobado no debe rechazarse porque alguien corrigió
 * una falta de ortografía en la ficha, y sí debe rechazarse si un importe se
 * movió un centavo.
 */
function huellaDelPlan(a: {
  entityId: string;
  fiscalPeriodId: string;
  tipoDeCalendario: string;
  base: string;
  convencion: string;
  renglones: RenglonDelPlan[];
}): string {
  const partes = [
    a.entityId,
    a.fiscalPeriodId,
    a.tipoDeCalendario,
    a.base,
    a.convencion,
    ...[...a.renglones]
      .sort((x, y) => (x.asset_id < y.asset_id ? -1 : x.asset_id > y.asset_id ? 1 : 0))
      .map((r) => `${r.asset_id}:${r.depreciacion}`),
  ];
  return createHash('sha256').update(partes.join('|')).digest('hex');
}

/**
 * Lo que la corrida haría en este periodo, sin tocar una sola fila.
 *
 * Falla ENTERA —no por activo— cuando algún activo que la corrida tocaría no
 * resuelve sus cuentas contra el catálogo de esta entidad. Es lo que el
 * catálogo promete para `depreciation run`, y la razón es de frontera y no de
 * comodidad: `depreciation_expense_account_id` es una foránea a `accounts(id)`
 * sin filtro de entidad, así que un activo puede apuntar perfectamente a la
 * cuenta de gasto de OTRA empresa y depreciar contra su mayor todos los meses.
 * Postear veinte activos buenos y dejar ese fuera enterraría el hallazgo en un
 * renglón de avisos.
 */
export async function planDeDepreciacion(
  entityId: string,
  fiscalPeriodId: string
): Promise<PlanDeDepreciacion> {
  const periodo = await periodoDeLaEntidad(entityId, fiscalPeriodId);
  const tenantId = await inquilinoDeLaEntidad(entityId);
  const criterios = await criteriosDeLaCorrida(tenantId, entityId);
  const tipoDeCalendario = TIPO_DE_CALENDARIO[criterios.base];

  // LA TERCERA POLÍTICA DE F06a. Su casilla natural es el checklist de cierre
  // (`period-close.ts` ya cuenta los activos sin depreciar), y aquí gobierna la
  // misma pregunta un paso antes: si el despacho eligió `bloquear`, la corrida
  // no se contabiliza mientras queden activos debiendo su renglón. Se lee en el
  // plan y no en cada hoja para que `run` y `post` no puedan contestarla
  // distinto.
  const faltante = await getPolicy({ tenantId, entityId }, 'depreciacion_faltante_al_cierre');

  const assets = await query<FilaDeActivo>(
    `SELECT fa.*,
            ac.name  AS categoria,
            cg.code  AS cuenta_gasto,
            cg.is_header    AS gasto_es_encabezado,
            ca.code  AS cuenta_acumulada,
            ca.is_header    AS acumulada_es_encabezado
       FROM fixed_assets fa
       LEFT JOIN asset_categories ac
              ON ac.id = fa.category_id AND ac.entity_id = fa.entity_id
       LEFT JOIN accounts cg
              ON cg.id = fa.depreciation_expense_account_id AND cg.entity_id = fa.entity_id
       LEFT JOIN accounts ca
              ON ca.id = fa.accumulated_depreciation_account_id AND ca.entity_id = fa.entity_id
      WHERE fa.entity_id = $1 AND fa.status = 'active'
      ORDER BY fa.asset_number`,
    [entityId]
  );

  // LOS QUE YA NO PRODUCEN RENGLÓN, CON EL MISMO PREDICADO QUE LA CORRIDA.
  //
  // No es «este periodo y este libro»: es «este periodo y el mayor». Un
  // renglón POSTEADO de cualquier libro ya cargó el gasto del mes —la corrida
  // debita `depreciation_expense_account_id` sin mirar de qué libro salió el
  // número—, y uno del MISMO libro cierra además la UNIQUE del esquema. Si el
  // plan preguntara sólo por el tipo, prometería un renglón que la corrida ya
  // no hace, y `post` acusaría su propia diferencia todos los meses en que
  // alguien cambiara `base_depreciacion`.
  const corridos = await query<{ asset_id: string; schedule_type: string; is_posted: boolean }>(
    `SELECT ds.asset_id, ds.schedule_type, ds.is_posted
       FROM depreciation_schedules ds
       JOIN fixed_assets fa ON fa.id = ds.asset_id
      WHERE ds.fiscal_period_id = $1 AND fa.entity_id = $3
        AND (ds.is_posted = true OR ds.schedule_type = $2)`,
    [periodo.id, tipoDeCalendario, entityId]
  );
  const yaCorridos = new Map(
    corridos.rows.map((r) => [
      r.asset_id,
      r.is_posted && r.schedule_type !== tipoDeCalendario
        ? `su gasto de ${periodo.nombre} ya está en el mayor por el libro ${r.schedule_type}`
        : `ya tiene renglón ${tipoDeCalendario} de ${periodo.nombre}`,
    ])
  );

  const renglones: RenglonDelPlan[] = [];
  const omitidos: OmisionDelPlan[] = [];
  const sinCuenta: string[] = [];

  const omitir = (a: FilaDeActivo, motivo: MotivoDeOmision, detalle: string): void => {
    omitidos.push({
      asset_id: a.id,
      asset_number: a.asset_number,
      asset_name: a.asset_name,
      categoria: a.categoria ?? '',
      motivo,
      detalle,
      pendiente: MOTIVOS_PENDIENTES.has(motivo),
    });
  };

  for (const asset of assets.rows) {
    const yaHecho = yaCorridos.get(asset.id);
    if (yaHecho !== undefined) {
      omitir(asset, 'ya_corrido', yaHecho);
      continue;
    }

    const metodo = metodoDeLaBase(asset, criterios.base);
    if (metodo === DepreciationMethod.UNITS_OF_PRODUCTION) {
      omitir(
        asset,
        'unidades_de_produccion',
        'se deprecia por unidades y la corrida mensual no tiene de dónde leer la producción del periodo'
      );
      continue;
    }

    const inicioServicio = medianocheLocal(asset.depreciation_start_date);
    const entrada: DepreciationInput = {
      asset_id: asset.id,
      acquisition_cost: asset.acquisition_cost,
      salvage_value: asset.salvage_value,
      useful_life_months: asset.useful_life_months,
      depreciation_start_date: inicioServicio,
      method: metodo,
      macrs_class: asset.macrs_class ?? undefined,
      convencion: criterios.convencion,
    };

    let calendario;
    try {
      calendario = calculateDepreciation(entrada);
    } catch (err) {
      omitir(asset, 'sin_calendario', (err as Error).message);
      continue;
    }

    const indice = indiceDeCalendario(inicioServicio, periodo.inicio);
    if (indice < 0) {
      omitir(
        asset,
        'aun_no_en_servicio',
        `entra en servicio el ${iso(inicioServicio)}, después de ${periodo.nombre}`
      );
      continue;
    }
    const fila = calendario[indice];
    if (!fila) {
      omitir(
        asset,
        'vida_terminada',
        `mes ${indice + 1} de una vida de ${calendario.length} mes(es)`
      );
      continue;
    }
    if (esImporteCero(fila.depreciation_expense)) {
      omitir(asset, 'importe_cero', 'el renglón del calendario vale cero: no hay asiento que hacer');
      continue;
    }

    // Las cuentas se juzgan aquí y no antes: un activo cuya vida terminó hace
    // tres años no debe bloquear la corrida por una cuenta que ya nadie usa.
    // Lo que sí bloquea es una cuenta irresoluble en un activo QUE SE VA A
    // POSTEAR.
    if (asset.cuenta_gasto === null || asset.gasto_es_encabezado === true) {
      sinCuenta.push(
        `${asset.asset_number}: la cuenta de gasto por depreciación ${
          asset.cuenta_gasto === null
            ? 'no está en el catálogo de esta entidad'
            : `(${asset.cuenta_gasto}) es de encabezado y no admite movimientos`
        }`
      );
      continue;
    }
    if (asset.cuenta_acumulada === null || asset.acumulada_es_encabezado === true) {
      sinCuenta.push(
        `${asset.asset_number}: la cuenta de depreciación acumulada ${
          asset.cuenta_acumulada === null
            ? 'no está en el catálogo de esta entidad'
            : `(${asset.cuenta_acumulada}) es de encabezado y no admite movimientos`
        }`
      );
      continue;
    }

    renglones.push({
      asset_id: asset.id,
      asset_number: asset.asset_number,
      asset_name: asset.asset_name,
      categoria: asset.categoria ?? '',
      metodo,
      indice,
      periodos: calendario.length,
      base_inicial: fila.beginning_book_value,
      depreciacion: fila.depreciation_expense,
      acumulada: fila.accumulated_depreciation,
      valor_en_libros: fila.ending_book_value,
      cuenta_gasto: asset.cuenta_gasto,
      cuenta_gasto_id: asset.depreciation_expense_account_id,
      cuenta_acumulada: asset.cuenta_acumulada,
      cuenta_acumulada_id: asset.accumulated_depreciation_account_id,
    });
  }

  if (sinCuenta.length > 0) {
    throw new ValidationError(
      `${sinCuenta.length} activo(s) de esta corrida no resuelven sus cuentas contra el catálogo ` +
        `de esta entidad, así que la corrida entera se detiene: postear los demás enterraría el ` +
        `hallazgo en un renglón de avisos. ${sinCuenta.join('; ')}.`
    );
  }

  const total = renglones
    .reduce((suma, r) => suma.plus(r.depreciacion), new Decimal(0))
    .toFixed(DECIMALES);

  return {
    entity_id: entityId,
    fiscal_period_id: periodo.id,
    periodo: periodo.nombre,
    inicio: iso(periodo.inicio),
    fin: iso(periodo.fin),
    fecha_del_asiento: iso(fechaDelAsiento(periodo)),
    base: criterios.base,
    base_definida: criterios.baseDefinida,
    convencion: criterios.convencion,
    convencion_definida: criterios.convencionDefinida,
    tipo_calendario: tipoDeCalendario,
    renglones,
    omitidos,
    total,
    pendientes: omitidos.filter((o) => o.pendiente).length,
    faltante_al_cierre: { politica: faltante.value, definida: faltante.defined },
    huella: huellaDelPlan({
      entityId,
      fiscalPeriodId: periodo.id,
      tipoDeCalendario,
      base: criterios.base,
      convencion: criterios.convencion,
      renglones,
    }),
  };
}


// ============================================================
// EL PLAN APROBADO, DE VUELTA (`depreciation post --file`)
//
// El catálogo promete que `post` contabiliza «contra el plan aprobado,
// verificando que los datos no se movieron». No hay tabla `depreciation_runs`
// donde guardar una corrida —el propio catálogo la nombra como trabajo
// pendiente—, así que el plan aprobado es un ARCHIVO: el que salió de
// `depreciation run --format json -o plan.json`, revisado por quien firma.
//
// LO QUE SE COMPARA ES EL PAR (ACTIVO, IMPORTE), y no una huella opaca. Una
// huella distinta sólo puede decir «algo cambió»; los pares dicen QUÉ activo se
// movió y de cuánto a cuánto, que es lo único accionable a las diez de la noche
// de un cierre. El periodo y el libro no hacen falta en el archivo porque
// vienen en la orden (`--period`, `--book`) y ya se comprobaron contra el panel.
// ============================================================

/** Un renglón tal como salió de `depreciation run`, releído del archivo. */
export interface RenglonAprobado {
  asset_id: string;
  asset_number: string;
  depreciacion: string;
}

interface RenglonCrudo {
  asset_id?: unknown;
  asset_number?: unknown;
  depreciacion?: unknown;
  estado?: unknown;
}

/**
 * Los renglones de un plan guardado en disco.
 *
 * Admite las tres formas que `render` puede haber escrito: el sobre versionado
 * de `--format json` (`{schema, count, rows}`), un arreglo pelado, y ndjson
 * —un objeto por línea—. No admite csv ni tsv, y lo dice: reconstruir dinero
 * desde un csv exige decidir qué hacer con las comillas y los separadores
 * decimales, y equivocarse ahí es postear otro importe.
 */
export function leerPlanAprobado(contenido: string, origen: string): RenglonAprobado[] {
  const texto = contenido.trim();
  if (texto.length === 0) {
    throw new ValidationError(`${origen} está vacío: no hay plan que verificar.`);
  }

  let crudas: unknown[];
  if (texto.startsWith('{') || texto.startsWith('[')) {
    let documento: unknown;
    try {
      documento = JSON.parse(texto);
    } catch {
      // Un JSON que no parsea de una pieza puede ser ndjson cuyo primer
      // renglón empieza por `{`. Se intenta antes de rendirse.
      crudas = lineasNdjson(texto, origen);
      return normalizar(crudas, origen);
    }
    crudas = Array.isArray(documento)
      ? documento
      : Array.isArray((documento as { rows?: unknown }).rows)
        ? ((documento as { rows: unknown[] }).rows)
        : [];
    if (crudas.length === 0 && !Array.isArray(documento)) {
      throw new ValidationError(
        `${origen} no tiene forma de plan: se esperaba el sobre \`{ "rows": [...] }\` que ` +
          'escribe `mnemosine depreciation run --format json`, o un arreglo de renglones.'
      );
    }
  } else {
    crudas = lineasNdjson(texto, origen);
  }
  return normalizar(crudas, origen);
}

function lineasNdjson(texto: string, origen: string): unknown[] {
  return texto
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((linea, i): unknown => {
      try {
        return JSON.parse(linea) as unknown;
      } catch {
        throw new ValidationError(
          `${origen}: la línea ${i + 1} no es JSON. Si el archivo es csv o tsv, vuelve a ` +
            'generarlo con `--format json`: reconstruir importes desde un csv es decidir a ojo ' +
            'qué es separador y qué es decimal.'
        );
      }
    });
}

/**
 * Se quedan sólo los renglones que POSTEAN. Un archivo de `run` trae también
 * los omitidos —con su motivo y sin importe—, y compararlos exigiría decidir
 * si «ya corrido» del martes sigue valiendo el jueves: no vale, porque el
 * jueves ya está corrido de verdad.
 */
function normalizar(crudas: unknown[], origen: string): RenglonAprobado[] {
  const renglones: RenglonAprobado[] = [];
  for (const cruda of crudas) {
    const r = cruda as RenglonCrudo;
    if (typeof r?.asset_id !== 'string') continue;
    if (typeof r.depreciacion !== 'string' || r.depreciacion.trim() === '') continue;
    if (r.estado !== undefined && r.estado !== 'entra') continue;
    renglones.push({
      asset_id: r.asset_id,
      asset_number: typeof r.asset_number === 'string' ? r.asset_number : r.asset_id,
      depreciacion: r.depreciacion,
    });
  }
  if (renglones.length === 0) {
    throw new ValidationError(
      `${origen} no trae un solo renglón con activo e importe. Un plan sin renglones no aprueba ` +
        'nada: si la corrida de ese periodo no tenía nada que postear, no hace falta contabilizarla.'
    );
  }
  return renglones;
}

/**
 * En qué se movieron los datos entre el plan aprobado y la realidad de ahora.
 *
 * Devuelve prosa y no un booleano a propósito: «el plan ya no corresponde» sin
 * decir en qué obliga a comparar dos archivos a ojo, y quien contabiliza tiene
 * derecho a saber si lo que cambió fue un centavo de redondeo o un activo
 * entero que alguien dio de alta después de la revisión.
 */
export function diferenciasContraPlan(
  aprobado: RenglonAprobado[],
  actual: PlanDeDepreciacion
): string[] {
  const diferencias: string[] = [];
  const antes = new Map(aprobado.map((r) => [r.asset_id, r]));
  const ahora = new Map(actual.renglones.map((r) => [r.asset_id, r]));

  for (const [id, r] of antes) {
    const hoy = ahora.get(id);
    if (!hoy) {
      diferencias.push(`${r.asset_number} estaba en el plan aprobado y ya no entra en la corrida`);
      continue;
    }
    // Con Decimal y no con `===`: '100.5000' y '100.50' son el mismo dinero
    // escrito de dos maneras, y un archivo releído no tiene por qué conservar
    // la grafía. Comparar cadenas rechazaría planes idénticos.
    if (!new Decimal(hoy.depreciacion).equals(r.depreciacion)) {
      diferencias.push(
        `${hoy.asset_number}: el plan decía ${r.depreciacion} y ahora sale ${hoy.depreciacion}`
      );
    }
  }
  for (const [id, r] of ahora) {
    if (!antes.has(id)) {
      diferencias.push(`${r.asset_number} (${r.depreciacion}) no estaba en el plan aprobado`);
    }
  }
  return diferencias;
}
