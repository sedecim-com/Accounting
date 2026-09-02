import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { getPolicy } from '../policy/policy-service.js';
import { AccountingError, ConflictError, ValidationError } from '../../utils/errors.js';

// ============================================================
// EL SERVICIO DE TIPOS DE CAMBIO (R4 · NIF B-15)
//
// `exchange_rates` es GLOBAL POR DISEÑO: no tiene tenant_id ni entity_id y
// vive fuera de RLS, porque el tipo que el DOF publicó un día es un hecho del
// mundo, no de un inquilino — dos despachos que guarden «el DOF del 3 de
// septiembre» deben guardar EL MISMO número, y duplicarlo por inquilino
// invitaría a que difieran. Aquí la entidad NO se acota dentro del SQL como
// en el resto del sistema; lo que se acota es la ESCRITURA, por permisos:
// `fijarTipo` exige un usuario resuelto (created_by NOT NULL) y sus comandos
// declaran riesgo `escritura`/`externo` con agente ✗, así que ningún agente
// escribe la tabla compartida y todo tipo fijado tiene autor en el rastro.
//
// LA POLÍTICA `fuente_tipo_cambio` es el criterio fiscal del despacho (DOF,
// el del art. 20 CFF | FIX de Banxico | manual) y tiene TRES lectores, no
// uno: `tipoParaConversion` (aquí, por el pool — hoy sólo lo consume la
// suite de integración), `resolverTipoCambio` (moneda-origen.ts, el gemelo
// TRANSACCIONAL que el pago usa de verdad: corre dentro de la transacción
// del acto y no puede salir al pool), y el marcador de fuente de
// `fx rate list`. Los dos resolutores son semánticamente idénticos a
// propósito y unificarlos es de fase 2 — si tocas la semántica de uno,
// toca la del otro o divergen (la lección de los gemelos de F04).
// Los tres FALLAN CERRADO: si la fuente elegida no publicó para esa fecha,
// se nombra fuente y fecha. Usar «el que haya» de otra fuente sería elegir
// criterio fiscal por el usuario — DOF y FIX del mismo día son números
// DISTINTOS, y la 057 los deja convivir precisamente para que nadie tenga
// que confundirlos.
// ============================================================

/**
 * Las fuentes del CHECK de `exchange_rates.source` tras la 057. No se copian
 * «por si acaso»: son el vocabulario del esquema, y una lista local que se
 * separe de él haría que una fuente imposible de insertar pareciera válida.
 */
export const FUENTES_DE_TIPO = [
  'manual', 'dof', 'banco_mexico', 'ecb', 'fed', 'xe', 'openexchangerates',
] as const;
export type FuenteDeTipo = (typeof FUENTES_DE_TIPO)[number];

/** Los cuatro tipos del CHECK de `exchange_rates.rate_type` (001). */
export const TIPOS_DE_TASA = ['spot', 'average', 'budget', 'historical'] as const;
export type TipoDeTasa = (typeof TIPOS_DE_TASA)[number];

/**
 * De valor de política a fuente del esquema. El FIX de Banxico se guarda como
 * 'banco_mexico' (la fuente que la 001 ya conocía); el DOF entra con la 057.
 * Se exporta para que la superficie (`fx rate list`) pueda SEÑALAR cuál de
 * las fuentes listadas es la que la política del despacho usa, sin duplicar
 * este mapeo — que es criterio fiscal y se decide en un solo sitio.
 */
export const FUENTE_DE_LA_POLITICA: Record<string, FuenteDeTipo> = {
  dof: 'dof',
  fix_banxico: 'banco_mexico',
  manual: 'manual',
};

export interface ParDeMonedas {
  de: string;
  a: string;
}

/**
 * Parsea "USD/MXN" (también acepta ':' o '-') a un par validado. Lanza con
 * mensaje legible: el par llega crudo de la terminal.
 */
export function exigirPar(par: string): ParDeMonedas {
  const partes = par.toUpperCase().split(/[/:.-]/);
  if (partes.length !== 2 || !partes.every((p) => /^[A-Z]{3}$/.test(p))) {
    throw new ValidationError(
      `El par "${par}" no se entiende: usa dos códigos ISO 4217 separados por "/", p. ej. USD/MXN.`
    );
  }
  const [de, a] = partes;
  if (de === a) {
    throw new ValidationError(`El par "${par}" convierte una moneda a sí misma; el tipo sería 1 por definición.`);
  }
  return { de, a };
}

export function exigirFuente(fuente: string): FuenteDeTipo {
  if (!(FUENTES_DE_TIPO as readonly string[]).includes(fuente)) {
    throw new ValidationError(
      `Fuente "${fuente}" desconocida. Las fuentes válidas son: ${FUENTES_DE_TIPO.join(', ')}.`
    );
  }
  return fuente as FuenteDeTipo;
}

export function exigirTipoDeTasa(tipo: string): TipoDeTasa {
  if (!(TIPOS_DE_TASA as readonly string[]).includes(tipo)) {
    throw new ValidationError(
      `Tipo de tasa "${tipo}" desconocido. Los tipos válidos son: ${TIPOS_DE_TASA.join(', ')}.`
    );
  }
  return tipo as TipoDeTasa;
}

export interface RenglonTipoDeCambio {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: string;
  inverse_rate: string;
  effective_date: string;
  effective_until: string | null;
  source: string;
  rate_type: string;
  created_at: string;
  created_by: string;
}

const COLUMNAS =
  `id, from_currency, to_currency, rate::text, inverse_rate::text, ` +
  `effective_date::text, effective_until::text, source, rate_type, created_at::text, created_by`;

export interface FiltrosDeLista {
  par?: ParDeMonedas;
  desde?: string;
  hasta?: string;
  rateType?: TipoDeTasa;
  fuente?: FuenteDeTipo;
}

/** Lista los tipos guardados. Lectura global: ver la cabecera del módulo. */
export async function listarTipos(filtros: FiltrosDeLista = {}): Promise<RenglonTipoDeCambio[]> {
  const condiciones: string[] = [];
  const params: unknown[] = [];
  const donde = (sql: string, valor: unknown): void => {
    params.push(valor);
    condiciones.push(sql.replace('?', `$${params.length}`));
  };

  if (filtros.par) {
    donde('from_currency = ?', filtros.par.de);
    donde('to_currency = ?', filtros.par.a);
  }
  if (filtros.desde) donde('effective_date >= ?', filtros.desde);
  if (filtros.hasta) donde('effective_date <= ?', filtros.hasta);
  if (filtros.rateType) donde('rate_type = ?', filtros.rateType);
  if (filtros.fuente) donde('source = ?', filtros.fuente);

  const r = await query<RenglonTipoDeCambio>(
    `SELECT ${COLUMNAS} FROM exchange_rates
     ${condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : ''}
     ORDER BY effective_date DESC, from_currency, to_currency, rate_type, source`,
    params
  );
  return r.rows;
}

export interface TipoResuelto {
  /** El tipo que resolvió get_exchange_rate(), o null si no hay camino. */
  rate: string | null;
  /** La fila directa más reciente aplicable, para enseñar fuente y fecha. */
  renglon: RenglonTipoDeCambio | null;
  /**
   * Fecha de la que se ARRASTRÓ el tipo cuando no hay uno del día pedido.
   * get_exchange_rate() toma el más reciente con effective_date <= fecha, y
   * ese arrastre era silencioso; aquí se devuelve para que la superficie lo
   * diga en voz alta.
   */
  arrastradoDe: string | null;
}

/**
 * Resuelve el tipo aplicable con el fallback de la 001: directo → inverso →
 * cruzado por USD (get_exchange_rate). NO lee la política: es la pregunta
 * «¿qué tipo resolvería el esquema?», no «¿cuál usa este despacho?» — esa
 * segunda es `tipoParaConversion`.
 */
export async function verTipo(
  par: ParDeMonedas,
  fecha: string,
  rateType: TipoDeTasa = 'spot'
): Promise<TipoResuelto> {
  const resuelto = await query<{ rate: string | null }>(
    'SELECT get_exchange_rate($1, $2, $3::date, $4)::text AS rate',
    [par.de, par.a, fecha, rateType]
  );
  const rate = resuelto.rows[0]?.rate ?? null;

  const directo = await query<RenglonTipoDeCambio>(
    `SELECT ${COLUMNAS} FROM exchange_rates
     WHERE from_currency = $1 AND to_currency = $2
       AND effective_date <= $3::date
       AND (effective_until IS NULL OR effective_until >= $3::date)
       AND rate_type = $4
     ORDER BY effective_date DESC
     LIMIT 1`,
    [par.de, par.a, fecha, rateType]
  );
  const renglon = directo.rows[0] ?? null;
  const arrastradoDe =
    renglon && renglon.effective_date < fecha ? renglon.effective_date : null;

  return { rate, renglon, arrastradoDe };
}

export interface EntradaFijar {
  par: ParDeMonedas;
  fecha: string;
  tasa: string;
  fuente: FuenteDeTipo;
  rateType?: TipoDeTasa;
  hasta?: string;
  /** Quien fija el tipo; created_by es NOT NULL y es la cota de escritura. */
  creadoPor: string;
}

/** Inserta un tipo. La unicidad (par, fecha, tipo, fuente) viene de la 057. */
export async function fijarTipo(entrada: EntradaFijar): Promise<RenglonTipoDeCambio> {
  let tasa: Decimal;
  try {
    tasa = new Decimal(entrada.tasa);
  } catch {
    throw new ValidationError(`El tipo de cambio "${entrada.tasa}" no es un número.`);
  }
  if (!tasa.isFinite() || tasa.lte(0)) {
    throw new ValidationError(`El tipo de cambio "${entrada.tasa}" debe ser un número positivo.`);
  }
  // DECIMAL(19,10): más decimales se rechazan en vez de dejarse redondear en
  // silencio — la conversión del mayor se verifica contra la tasa GUARDADA.
  if (tasa.decimalPlaces() > 10) {
    throw new ValidationError(
      `El tipo de cambio "${entrada.tasa}" trae más de 10 decimales; la columna es DECIMAL(19,10).`
    );
  }

  const rateType = entrada.rateType ?? 'spot';
  const id = uuidv4();
  try {
    const r = await query<RenglonTipoDeCambio>(
      `INSERT INTO exchange_rates
         (id, from_currency, to_currency, rate, effective_date, effective_until,
          source, rate_type, created_by)
       VALUES ($1, $2, $3, $4::numeric, $5::date, $6::date, $7, $8, $9)
       RETURNING ${COLUMNAS}`,
      [
        id, entrada.par.de, entrada.par.a, tasa.toString(), entrada.fecha,
        entrada.hasta ?? null, entrada.fuente, rateType, entrada.creadoPor,
      ]
    );
    return r.rows[0];
  } catch (err) {
    // unique_violation de la 057: la fila ya existe. Sustituir un tipo NO es
    // volver a fijarlo: `fx rate correct` (fase 3) es el camino con rastro.
    if ((err as { code?: string }).code === '23505') {
      throw new ConflictError(
        `Ya hay un tipo ${entrada.par.de}/${entrada.par.a} de la fuente ${entrada.fuente} ` +
          `(${rateType}) para ${entrada.fecha}. Un tipo publicado no se pisa; si es un error, ` +
          'el camino con rastro es fx rate correct (fase 3).'
      );
    }
    throw err;
  }
}

export interface TipoParaConversion {
  /** La tasa de la fuente que la política eligió, para esa fecha exacta. */
  tasa: string;
  fuente: FuenteDeTipo;
  /** Valor crudo de la política ('dof' | 'fix_banxico' | 'manual'). */
  politica: string;
  /** true cuando la tasa salió del par inverso (misma fuente, misma fecha). */
  invertida: boolean;
}

/**
 * El tipo que ESTE despacho usa para convertir en una fecha. Lee la política
 * `fuente_tipo_cambio` (única puerta al criterio) y busca el tipo de ESA
 * fuente para ESA fecha exacta — directo o, siendo el mismo hecho publicado,
 * el inverso de la misma fuente y fecha. Sin arrastre de fechas y sin caer a
 * otra fuente: si falta, FALLA CERRADO nombrando fuente y fecha, porque
 * «el que haya» es un criterio fiscal que nadie eligió.
 */
export async function tipoParaConversion(
  tenantId: string,
  entityId: string,
  fecha: string,
  par: ParDeMonedas
): Promise<TipoParaConversion> {
  const politica = await getPolicy({ tenantId, entityId }, 'fuente_tipo_cambio');
  const fuente = FUENTE_DE_LA_POLITICA[politica.value];
  if (!fuente) {
    // Cerrado al declarar: un valor de política que este lector no conoce no
    // se adivina — se acusa, igual que una fuente sin tipo.
    throw new AccountingError(
      'FX_POLITICA_DESCONOCIDA',
      `La política fuente_tipo_cambio vale "${politica.value}" y este lector solo entiende ` +
        `${Object.keys(FUENTE_DE_LA_POLITICA).join(', ')}. Corrige la política en mnemosine pending.`
    );
  }

  const directo = await query<{ rate: string }>(
    `SELECT rate::text AS rate FROM exchange_rates
     WHERE from_currency = $1 AND to_currency = $2
       AND effective_date = $3::date AND source = $4 AND rate_type = 'spot'
     LIMIT 1`,
    [par.de, par.a, fecha, fuente]
  );
  if (directo.rows.length > 0) {
    return { tasa: directo.rows[0].rate, fuente, politica: politica.value, invertida: false };
  }

  const inverso = await query<{ inverse_rate: string }>(
    `SELECT inverse_rate::text AS inverse_rate FROM exchange_rates
     WHERE from_currency = $2 AND to_currency = $1
       AND effective_date = $3::date AND source = $4 AND rate_type = 'spot'
     LIMIT 1`,
    [par.de, par.a, fecha, fuente]
  );
  if (inverso.rows.length > 0) {
    return { tasa: inverso.rows[0].inverse_rate, fuente, politica: politica.value, invertida: true };
  }

  throw new AccountingError(
    'FX_SIN_TIPO_DE_LA_FUENTE',
    `No hay tipo ${par.de}/${par.a} de la fuente ${fuente} para ${fecha}, y la política ` +
      `fuente_tipo_cambio de este despacho dice ${politica.value}. No uso el de otra fuente ni ` +
      `el de otra fecha: sería elegir criterio fiscal por ti. Captúralo con ` +
      `fx rate set ${par.de}/${par.a} ${fecha} <tasa> --source ${fuente}, o cambia la política.`,
    { par: `${par.de}/${par.a}`, fecha, fuente, politica: politica.value }
  );
}
