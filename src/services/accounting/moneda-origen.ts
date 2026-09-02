import Decimal from 'decimal.js';
import type pg from 'pg';
import { getPolicy } from '../policy/policy-service.js';
import { AccountingError } from '../../utils/errors.js';

// ============================================================
// R4 · LA MONEDA EXTRANJERA, CONVERTIDA EN EL ORIGEN (NIF B-15)
//
// Este módulo es la aritmética de la fase REALIZADA de B-15: convertir un
// importe en moneda del documento a la moneda funcional con el tipo del
// documento, y medir la diferencia cambiaria que se REALIZA cuando el pago
// ocurre a otro tipo que el del registro. La fase NO realizada —revaluar
// saldos vivos al cierre— es fase 2 y no vive aquí.
//
// Todo es aritmética pura sobre strings con Decimal, sin tocar la base,
// por la misma razón que reconciliation-math.ts: el caso incómodo (el
// espejo utilidad/pérdida, el redondeo del décimo decimal) se prueba en
// cuatro líneas o no se prueba nunca.
// ============================================================

// El tipo de cambio lleva DIEZ decimales (DECIMAL(19,10)) y el importe
// cuatro (DECIMAL(19,4)): un producto exacto puede necesitar más dígitos
// significativos que los 20 por defecto de decimal.js. Se clona en vez de
// tocar la configuración global, que comparten módulos que no pidieron esto.
const D = Decimal.clone({ precision: 40 });

/** Decimales con los que viaja el dinero en el mayor (DECIMAL(19,4)). */
const ESCALA = 4;

/** importe (moneda del documento) × tasa → moneda funcional, a 4 decimales. */
export function convertirAFuncional(importe: string, tasa: string): string {
  return new D(importe).times(tasa).toFixed(ESCALA);
}

export interface DiferenciaCambiaria {
  /**
   * 'perdida': el efectivo en funcional costó MÁS que el pasivo histórico
   * (el peso se depreció entre registro y pago). 'utilidad': costó menos.
   */
  tipo: 'perdida' | 'utilidad' | 'ninguna';
  /** Valor absoluto, en moneda funcional, 4 decimales. */
  montoFuncional: string;
}

/**
 * La diferencia cambiaria REALIZADA al pagar: entre lo que el pasivo valía
 * en funcional al registrarse (importe × tasa histórica) y lo que costó
 * extinguirlo (importe × tasa del pago).
 *
 * Se redondea CADA producto a 4 decimales ANTES de restar, porque eso es lo
 * que de verdad se asienta en cada línea del mayor: la diferencia tiene que
 * ser exactamente la que deja el asiento cuadrado, no la teórica.
 */
export function diferenciaCambiariaRealizada(input: {
  /** Lo pagado, en la moneda del documento. */
  importePagado: string;
  /** Tipo de cambio al que nació el pasivo (bills.exchange_rate). */
  tasaHistorica: string;
  /** Tipo de cambio del día del pago. */
  tasaPago: string;
}): DiferenciaCambiaria {
  const historico = convertirAFuncional(input.importePagado, input.tasaHistorica);
  const efectivo = convertirAFuncional(input.importePagado, input.tasaPago);
  const delta = new D(efectivo).minus(historico);
  if (delta.isZero()) return { tipo: 'ninguna', montoFuncional: delta.abs().toFixed(ESCALA) };
  return {
    tipo: delta.greaterThan(0) ? 'perdida' : 'utilidad',
    montoFuncional: delta.abs().toFixed(ESCALA),
  };
}

export interface AplicacionCambiaria {
  billId: string;
  numero: string;
  /** Efectivo aplicado al documento, en su moneda. */
  aplicado: string;
  /** Descuento por pronto pago, en la moneda del documento. */
  descuento: string;
  /** Tipo de cambio al que se registró el pasivo (bills.exchange_rate). */
  tasaHistorica: string;
}

export interface ContextoCambiario {
  /** Moneda del pago y de todos sus documentos (assertMoneda la unificó). */
  moneda: string;
  monedaFuncional: string;
  /** Tipo de cambio del día del pago, DECIMAL(19,10) como string. */
  tasaPago: string;
  /** De dónde salió tasaPago: 'dof' | 'banco_mexico' | 'manual' | 'parametro'. */
  fuenteTasa: string;
  aplicaciones: AplicacionCambiaria[];
}

export interface LineaCambiaria {
  billId: string;
  numero: string;
  /** Importe en la moneda del documento. */
  extranjero: string;
  tasa: string;
  montoFuncional: string;
}

export interface DesgloseCambiario {
  /** DR cxp por documento: (aplicado + descuento) × tasa HISTÓRICA. */
  pasivos: LineaCambiaria[];
  /** CR devolucion_compras por documento: descuento × tasa HISTÓRICA. */
  descuentos: LineaCambiaria[];
  /** Efectivo que no se aplicó a nada: queda de anticipo, a tasa del PAGO. */
  anticipoExtranjero: string;
  anticipoFuncional: string;
  /** CR banco: efectivo × tasa del PAGO — lo que de verdad salió, hoy. */
  bancoFuncional: string;
  /** Lo que separa los DR de los CR: la diferencia realizada del pago. */
  diferencia: DiferenciaCambiaria;
}

/**
 * El pago en moneda extranjera, desglosado en las líneas funcionales que el
 * asiento necesita. Cada pasivo se extingue al tipo al que NACIÓ (por eso el
 * desglose es por documento: cada gasto trae su tasa) y el efectivo sale al
 * tipo de HOY; la brecha entre ambos mundos es la diferencia realizada, y se
 * calcula como resta exacta de los importes YA redondeados a 4 decimales —
 * la única definición con la que el asiento cuadra siempre.
 */
export function desgloseCambiarioDelPago(
  efectivo: string,
  ctx: ContextoCambiario
): DesgloseCambiario {
  const pasivos: LineaCambiaria[] = [];
  const descuentos: LineaCambiaria[] = [];
  let aplicadoTotal = new D(0);
  let debitos = new D(0);
  let creditos = new D(0);

  for (const app of ctx.aplicaciones) {
    const extingue = new D(app.aplicado).plus(app.descuento);
    aplicadoTotal = aplicadoTotal.plus(app.aplicado);
    if (extingue.greaterThan(0)) {
      const monto = convertirAFuncional(extingue.toFixed(ESCALA), app.tasaHistorica);
      pasivos.push({
        billId: app.billId,
        numero: app.numero,
        extranjero: extingue.toFixed(ESCALA),
        tasa: app.tasaHistorica,
        montoFuncional: monto,
      });
      debitos = debitos.plus(monto);
    }
    if (new D(app.descuento).greaterThan(0)) {
      const monto = convertirAFuncional(app.descuento, app.tasaHistorica);
      descuentos.push({
        billId: app.billId,
        numero: app.numero,
        extranjero: new D(app.descuento).toFixed(ESCALA),
        tasa: app.tasaHistorica,
        montoFuncional: monto,
      });
      creditos = creditos.plus(monto);
    }
  }

  const anticipo = new D(efectivo).minus(aplicadoTotal);
  const anticipoFuncional = anticipo.greaterThan(0)
    ? convertirAFuncional(anticipo.toFixed(ESCALA), ctx.tasaPago)
    : new D(0).toFixed(ESCALA);
  if (anticipo.greaterThan(0)) debitos = debitos.plus(anticipoFuncional);

  const bancoFuncional = convertirAFuncional(efectivo, ctx.tasaPago);
  creditos = creditos.plus(bancoFuncional);

  // creditos > debitos: salió más funcional del que extinguía pasivo —
  // pérdida (se carga a 6320 para cuadrar). Al revés, utilidad (abono a 4320).
  const delta = creditos.minus(debitos);
  const diferencia: DiferenciaCambiaria = delta.isZero()
    ? { tipo: 'ninguna', montoFuncional: delta.abs().toFixed(ESCALA) }
    : { tipo: delta.greaterThan(0) ? 'perdida' : 'utilidad', montoFuncional: delta.abs().toFixed(ESCALA) };

  return {
    pasivos,
    descuentos,
    anticipoExtranjero: D.max(anticipo, 0).toFixed(ESCALA),
    anticipoFuncional,
    bancoFuncional,
    diferencia,
  };
}

/** La moneda en la que la entidad lleva sus libros. */
export async function monedaFuncionalDe(
  client: pg.PoolClient,
  entityId: string
): Promise<string> {
  const r = await client.query<{ functional_currency: string }>(
    `SELECT functional_currency FROM legal_entities WHERE id = $1`,
    [entityId]
  );
  if (!r.rows[0]) {
    throw new AccountingError(
      'ENTITY_NOT_FOUND',
      `No existe la entidad ${entityId}: sin su moneda funcional no se puede convertir nada.`
    );
  }
  return r.rows[0].functional_currency;
}

/** Qué valor de la política `fuente_tipo_cambio` corresponde a qué `source`. */
const FUENTE_POR_POLITICA: Record<string, string> = {
  dof: 'dof',
  fix_banxico: 'banco_mexico',
  manual: 'manual',
};

export interface TipoCambioResuelto {
  tasa: string;
  fuente: string;
  fecha: string;
}

/**
 * El tipo de cambio del día, leído de la fuente que la política
 * `fuente_tipo_cambio` dicta, DENTRO de la transacción del llamador.
 *
 * Es deliberadamente el gemelo transaccional de `tipoParaConversion`
 * (src/services/fx/rate-service.ts) y comparte sus tres reglas: la fecha
 * exacta o nada (sin arrastre), el par inverso de la MISMA fuente y fecha
 * cuenta (es el mismo hecho publicado), y ante fuente sin tipo o política
 * desconocida FALLA CERRADO. Existe aparte porque aquél lee por el pool y
 * este camino corre dentro de la transacción del pago: una segunda conexión
 * aquí es el interbloqueo que policy-service documenta.
 *
 * `exchange_rates` es GLOBAL por diseño —no tiene entity_id: el DOF publica
 * un solo número para todos—, así que aquí no hay frontera de entidad que
 * meter al SQL; lo que se acota por entidad es la POLÍTICA que elige la
 * fuente, y la ESCRITURA de tasas se acota por permisos en quien escribe
 * (`fx rate set` / `download`), no por filas.
 */
export async function resolverTipoCambio(
  client: pg.PoolClient,
  ctx: { tenantId: string; entityId: string },
  args: { de: string; a: string; fecha: Date | string }
): Promise<TipoCambioResuelto> {
  const politica = await getPolicy(
    { tenantId: ctx.tenantId, entityId: ctx.entityId },
    'fuente_tipo_cambio',
    client
  );
  const fuente = FUENTE_POR_POLITICA[politica.value];
  if (!fuente) {
    // Cerrado al declarar: un valor de política que este lector no conoce
    // no se adivina — se acusa, igual que una fuente sin tipo.
    throw new AccountingError(
      'FX_POLITICA_DESCONOCIDA',
      `La política fuente_tipo_cambio vale "${politica.value}" y este lector solo entiende ` +
        `${Object.keys(FUENTE_POR_POLITICA).join(', ')}. Corrige la política en mnemosine pending.`
    );
  }
  const fecha =
    args.fecha instanceof Date
      ? args.fecha.toISOString().slice(0, 10)
      : String(args.fecha).slice(0, 10);

  const directo = await client.query<{ rate: string }>(
    `SELECT rate::text AS rate
       FROM exchange_rates
      WHERE from_currency = $1 AND to_currency = $2
        AND effective_date = $3::date AND source = $4 AND rate_type = 'spot'
      LIMIT 1`,
    [args.de, args.a, fecha, fuente]
  );
  if (directo.rows[0]?.rate) {
    return { tasa: directo.rows[0].rate, fuente, fecha };
  }

  // El par inverso de la MISMA fuente y fecha es el mismo hecho publicado,
  // no otra fuente: inverse_rate es columna generada (1/rate) en la 001.
  const inverso = await client.query<{ inverse_rate: string }>(
    `SELECT inverse_rate::text AS inverse_rate
       FROM exchange_rates
      WHERE from_currency = $2 AND to_currency = $1
        AND effective_date = $3::date AND source = $4 AND rate_type = 'spot'
      LIMIT 1`,
    [args.de, args.a, fecha, fuente]
  );
  if (inverso.rows[0]?.inverse_rate) {
    return { tasa: inverso.rows[0].inverse_rate, fuente, fecha };
  }

  throw new AccountingError(
    'FX_RATE_MISSING',
    `No hay tipo de cambio ${args.de}→${args.a} de la fuente '${fuente}' para ${fecha}. ` +
      `Captúralo con: mnemosine fx rate set ${args.de}/${args.a} ${fecha} <tasa> --source ${fuente} ` +
      `— o descárgalo con: mnemosine fx rate download. No se toma otra fuente ni otra fecha en ` +
      `silencio: la política fuente_tipo_cambio (${politica.value}) es un criterio fiscal del ` +
      `despacho, no una preferencia de esta función.`
  );
}
