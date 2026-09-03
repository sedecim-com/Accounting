import Decimal from 'decimal.js';
import type pg from 'pg';
import {
  ivaStillParked,
  resolveBillMetodoPago,
  type MetodoPagoDecision,
} from '../../accounting/iva-cash-basis.js';
import {
  acumuladoDelDocumento,
  porcionDelDocumento,
  DECIMALES_DIOT,
  type PorcionPagada,
  type RenglonDeGasto,
  type TipoFactor,
} from './desglose.js';
import type { Hallazgo } from './hallazgos.js';

// ============================================================
// F07c · EL HECHO QUE LA DIOT DECLARA: EL IVA EFECTIVAMENTE PAGADO
//
// La DIOT informa de operaciones PAGADAS, no devengadas. El generador que
// este repositorio tuvo y borró fallaba justo ahí —agregaba sobre `bills` por
// `bill_date`— y la nota de deuda lo dejó escrito para que no se repitiera.
//
// LOS DOS SUCESOS SON LOS DEL MAYOR, Y ESO ES LA TESIS DEL MÓDULO. La
// maquinaria de flujo (iva-cash-basis) ya decide cuándo el IVA de una compra
// es acreditable, y sólo hay dos momentos:
//
//   · PUE  → al contabilizar el gasto. El IVA fue directo a 1130.
//   · PPD  → al pagar. El IVA sale de 1135 y entra a 1130, en proporción.
//
// Construir la DIOT a partir de EXACTAMENTE esos dos sucesos hace que el
// amarre contra el movimiento de 1130 del mes —el paso 6 de la lista de
// comprobación, el que dice «nunca "casi cuadra"»— sea verdadero por
// construcción y no por coincidencia. Cualquier otra definición del hecho
// obliga a explicar la diferencia todos los meses.
//
// POR QUÉ NO SE LLAMA A `ivaReclassificationsFor` PAGO POR PAGO
//
// Era lo natural: recorrer los pagos del mes y sumar lo que cada uno libera.
// La primera versión de este comentario decía que eso inflaba la cifra,
// porque aquella función calcula el previo como «todo lo aplicado al
// documento MENOS lo de este pago» (iva-cash-basis:634) —correcto al
// CONTABILIZAR el pago, cuando los posteriores aún no existen, y sospechoso
// al preguntar en retrospectiva—. SE MIDIÓ CONTRA POSTGRES Y NO INFLA: el
// repartidor es lineal, así que Σᵢ [objetivo(A) − objetivo(A − pᵢ)] se
// telescopa solo y da objetivo(A) exacto. Dos parcialidades de 580 sobre un
// gasto de 1 160 dan 160 por las dos rutas y por el mayor.
//
// Las razones por las que aun así no se usa son otras tres, y ésas sí se
// sostienen:
//
//   1. DEJA FUERA LO QUE NO TIENE IVA. Descarta todo documento cuya
//      liberación sea cero (iva-cash-basis:644), así que un gasto EXENTO o
//      todo al 0 % pagado en el mes no aparecería nunca — y la DIOT declara
//      el VALOR DE LOS ACTOS, no sólo el impuesto. Sería un agujero
//      silencioso justo en el renglón que la migración 063 vino a rescatar.
//   2. LA PREGUNTA ES OTRA. La suya es «qué libera ESTE pago»; la de la DIOT
//      es «cuánto se liberó DURANTE el mes». Cuando coinciden es por la
//      linealidad, no por diseño, y apoyarse en eso es apoyarse en algo que
//      nadie prometió mantener.
//   3. UNA CONSULTA POR PAGO, y cada una vuelve a resolver el método y a leer
//      el mayor para el tope.
//
// Así que lo que se reusa es la pieza que sí responde a la segunda pregunta:
// el repartidor por diferencia de acumulados (`ivaToReclassify`, vía
// `acumuladoDelDocumento`) y el tope real contra lo aparcado
// (`ivaStillParked`). El mes se calcula como acumulado al cierre menos
// acumulado al cierre del mes anterior — que telescopa, y por tanto la suma
// de los doce meses reproduce exactamente el IVA del documento.
//
// ============================================================

/** Un documento y el tramo suyo que este mes declaró como pagado. */
export interface HechoPagado {
  billId: string;
  billNumber: string;
  vendorId: string;
  metodo: MetodoPagoDecision;
  /** `bills.tax_amount` en moneda del documento: la cabecera. */
  ivaCabecera: string;
  /** El IVA acreditable que el mes reconoció, en moneda funcional. */
  ivaPagado: string;
  /** El IVA retenido a este tercero en el tramo, en moneda funcional. */
  ivaRetenido: string;
  porcion: PorcionPagada;
  renglones: RenglonDeGasto[];
}

export interface RangoDelMes {
  /** 'AAAA-MM-01'. */
  desde: string;
  /** Último día del mes, 'AAAA-MM-DD'. */
  hasta: string;
}

interface FilaGasto {
  id: string;
  bill_number: string;
  vendor_id: string;
  tax_amount: string;
  total_amount: string;
  exchange_rate: string;
  amount_paid: string;
  terms: string | null;
  memo: string | null;
  cfdi_uuid: string | null;
  aplicado_hasta_fin?: string;
  aplicado_hasta_inicio?: string;
}

const q = (d: Decimal): string => d.toDecimalPlaces(DECIMALES_DIOT).toFixed(DECIMALES_DIOT);

/** Primer y último día del mes, como los espera Postgres. */
export function rangoDelMes(anio: number, mes: number): RangoDelMes {
  const dosDigitos = String(mes).padStart(2, '0');
  const ultimo = new Date(Date.UTC(anio, mes, 0)).toISOString().slice(0, 10);
  return { desde: `${anio}-${dosDigitos}-01`, hasta: ultimo };
}

/**
 * Los gastos PUE contabilizados en el mes.
 *
 * `journal_entry_id IS NOT NULL` y no `status`: es la marca que
 * `postBillEntry` escribe y la llave de su idempotencia, así que es la única
 * que responde a la pregunta que importa —si este gasto movió el mayor— sin
 * depender de que alguien mantenga el `status` al día.
 */
async function gastosPueDelMes(
  client: pg.PoolClient,
  entityId: string,
  rango: RangoDelMes
): Promise<FilaGasto[]> {
  const { rows } = await client.query<FilaGasto>(
    `SELECT b.id, b.bill_number, b.vendor_id,
            b.tax_amount::text, b.total_amount::text, b.exchange_rate::text,
            b.amount_paid::text, b.terms, b.memo, b.cfdi_uuid
       FROM bills b
      WHERE b.entity_id = $1
        AND b.bill_date >= $2::date AND b.bill_date <= $3::date
        AND b.journal_entry_id IS NOT NULL
        AND b.status NOT IN ('void', 'cancelled')
      ORDER BY b.bill_number`,
    [entityId, rango.desde, rango.hasta]
  );
  return rows;
}

/**
 * Los gastos a los que un pago del mes les aplicó dinero, con lo acumulado al
 * cierre del mes y al cierre del mes ANTERIOR.
 *
 * LA ENTIDAD SE ACOTA DOS VECES A PROPÓSITO. `payment_applications` no tiene
 * `entity_id` —es la tabla puente—, así que la frontera tiene que venir de
 * sus dos extremos. Fijar sólo `bills` dejaría entrar el pago de otra
 * entidad aplicado al mismo gasto, y fijar sólo `vendor_payments` dejaría
 * entrar el gasto ajeno: es la octava aparición de la frontera de entidad en
 * este proyecto y la primera en la que el cruce no filtra datos, los declara.
 */
async function gastosPagadosEnElMes(
  client: pg.PoolClient,
  entityId: string,
  rango: RangoDelMes
): Promise<FilaGasto[]> {
  const { rows } = await client.query<FilaGasto>(
    `SELECT b.id, b.bill_number, b.vendor_id,
            b.tax_amount::text, b.total_amount::text, b.exchange_rate::text,
            b.amount_paid::text, b.terms, b.memo, b.cfdi_uuid,
            COALESCE(SUM(pa.amount_applied)
              FILTER (WHERE vp.payment_date <= $3::date), 0)::text AS aplicado_hasta_fin,
            COALESCE(SUM(pa.amount_applied)
              FILTER (WHERE vp.payment_date < $2::date), 0)::text AS aplicado_hasta_inicio
       FROM bills b
       JOIN payment_applications pa ON pa.bill_id = b.id
       JOIN vendor_payments vp ON vp.id = pa.payment_id
      WHERE b.entity_id = $1
        AND vp.entity_id = $1
        AND vp.journal_entry_id IS NOT NULL
        AND vp.status <> 'void'
        AND vp.payment_date <= $3::date
        AND b.status NOT IN ('void', 'cancelled')
      GROUP BY b.id, b.bill_number, b.vendor_id, b.tax_amount, b.total_amount,
               b.exchange_rate, b.amount_paid, b.terms, b.memo, b.cfdi_uuid
     HAVING COALESCE(SUM(pa.amount_applied) FILTER (WHERE vp.payment_date <= $3::date), 0)
          > COALESCE(SUM(pa.amount_applied) FILTER (WHERE vp.payment_date <  $2::date), 0)
      ORDER BY b.bill_number`,
    [entityId, rango.desde, rango.hasta]
  );
  return rows;
}

interface FilaRenglon {
  bill_id: string;
  tipo_factor: string;
  tax_rate: string | null;
  valor_actos: string | null;
  line_amount: string;
  tax_amount: string;
}

async function renglonesDe(
  client: pg.PoolClient,
  entityId: string,
  billIds: readonly string[]
): Promise<Map<string, RenglonDeGasto[]>> {
  const porGasto = new Map<string, RenglonDeGasto[]>();
  if (billIds.length === 0) return porGasto;
  const { rows } = await client.query<FilaRenglon>(
    `SELECT bl.bill_id, bl.tipo_factor, bl.tax_rate::text, bl.valor_actos::text,
            bl.line_amount::text, bl.tax_amount::text
       FROM bill_lines bl
       JOIN bills b ON b.id = bl.bill_id
      WHERE b.entity_id = $1 AND bl.bill_id = ANY($2::uuid[])
      ORDER BY bl.bill_id, bl.line_number`,
    [entityId, [...billIds]]
  );
  for (const r of rows) {
    const lista = porGasto.get(r.bill_id) ?? [];
    lista.push({
      tipoFactor: r.tipo_factor as TipoFactor,
      tasa: r.tax_rate,
      valorActos: r.valor_actos,
      importe: r.line_amount,
      iva: r.tax_amount,
    });
    porGasto.set(r.bill_id, lista);
  }
  return porGasto;
}

/**
 * El IVA retenido de cada gasto, del CFDI que lo originó.
 *
 * NO HAY COLUMNA DE RETENCIÓN EN `bill_lines`: la 063 añadió la tasa, el tipo
 * de factor y el valor de los actos, no la retención. El único sitio donde el
 * dato está guardado es `xml_documents.total_iva_retenido`, y se llega por
 * `bills.cfdi_uuid` (la 037). Un gasto capturado a mano sin comprobante no
 * tiene ese puente y declara cero retenido, que es lo correcto: no consta.
 *
 * Se acota también por entidad en el JOIN porque un mismo CFDI puede estar
 * ingerido dos veces dentro del mismo inquilino cuando las dos partes son
 * entidades del grupo — el mismo motivo por el que `cfdiMetodoPagoByUuid` lo
 * hace en iva-cash-basis.
 */
async function retencionesDe(
  client: pg.PoolClient,
  entityId: string,
  billIds: readonly string[]
): Promise<Map<string, string>> {
  const porGasto = new Map<string, string>();
  if (billIds.length === 0) return porGasto;
  const { rows } = await client.query<{ bill_id: string; retenido: string }>(
    `SELECT b.id AS bill_id, COALESCE(x.total_iva_retenido, 0)::text AS retenido
       FROM bills b
       JOIN xml_documents x ON x.cfdi_uuid = b.cfdi_uuid AND x.entity_id = b.entity_id
      WHERE b.entity_id = $1 AND b.id = ANY($2::uuid[]) AND b.cfdi_uuid IS NOT NULL`,
    [entityId, [...billIds]]
  );
  for (const r of rows) porGasto.set(r.bill_id, r.retenido);
  return porGasto;
}

/**
 * Todo lo que el mes declara, documento por documento.
 *
 * Los avisos que salen de aquí son los que sólo se ven con la base delante:
 * el PUE sin un peso aplicado y el gasto cuyo tope aparcado deja el IVA por
 * debajo de lo que la proporción pedía.
 */
export async function hechosDelMes(
  client: pg.PoolClient,
  entityId: string,
  anio: number,
  mes: number
): Promise<{ hechos: HechoPagado[]; hallazgos: Hallazgo[] }> {
  const rango = rangoDelMes(anio, mes);
  const hallazgos: Hallazgo[] = [];
  const hechos: HechoPagado[] = [];

  const candidatosPue = await gastosPueDelMes(client, entityId, rango);
  const candidatosPpd = await gastosPagadosEnElMes(client, entityId, rango);

  const pue: FilaGasto[] = [];
  const ppd: FilaGasto[] = [];
  const clasificado = new Map<string, MetodoPagoDecision>();

  const metodoDe = async (g: FilaGasto): Promise<MetodoPagoDecision> => {
    const ya = clasificado.get(g.id);
    if (ya) return ya;
    const d = await resolveBillMetodoPago(client, {
      id: g.id,
      entity_id: entityId,
      bill_number: g.bill_number,
      terms: g.terms,
      memo: g.memo,
    });
    clasificado.set(g.id, d);
    return d;
  };

  for (const g of candidatosPue) {
    if ((await metodoDe(g)).metodo === 'PUE') pue.push(g);
  }
  for (const g of candidatosPpd) {
    if ((await metodoDe(g)).metodo === 'PPD') ppd.push(g);
  }

  const ids = [...pue.map((g) => g.id), ...ppd.map((g) => g.id)];
  const renglones = await renglonesDe(client, entityId, ids);
  const retenciones = await retencionesDe(client, entityId, ids);

  const arma = (
    g: FilaGasto,
    metodo: MetodoPagoDecision,
    porcion: PorcionPagada,
    ivaPagado: string
  ): HechoPagado => ({
    billId: g.id,
    billNumber: g.bill_number,
    vendorId: g.vendor_id,
    metodo,
    ivaCabecera: g.tax_amount,
    ivaPagado,
    ivaRetenido: porcionDelDocumento(retenciones.get(g.id) ?? '0', porcion),
    porcion,
    renglones: renglones.get(g.id) ?? [],
  });

  // ── PUE: el mes del gasto, entero ──────────────────────────────────────
  for (const g of pue) {
    const metodo = clasificado.get(g.id)!;
    const porcion: PorcionPagada = {
      aplicadoPrevio: '0',
      aplicadoAhora: g.total_amount,
      totalDocumento: g.total_amount,
      tasaCambio: g.exchange_rate,
    };
    const ivaPagado = acumuladoDelDocumento(
      g.tax_amount,
      g.total_amount,
      g.total_amount,
      g.exchange_rate
    );

    // El PUE declara «pagado en una sola exhibición», y el mayor le creyó:
    // el IVA fue directo a 1130 al contabilizar. Si además resulta que no se
    // le ha aplicado un peso, la declaración y la caja dicen cosas distintas
    // y quien firma tiene derecho a saberlo antes de firmar.
    if (new Decimal(g.amount_paid || '0').lessThanOrEqualTo(0)) {
      hallazgos.push({
        codigo: 'DIOT-PUE-SIN-PAGO',
        severidad: 'aviso',
        documentId: g.id,
        documentNumber: g.bill_number,
        mensaje:
          `El gasto ${g.bill_number} se declara como PUE (método leído de: ${metodo.origin}) ` +
          `y entra completo en la DIOT del mes, pero no tiene ningún pago aplicado. Si en ` +
          `realidad se paga en parcialidades, su método está mal capturado y el IVA se está ` +
          `acreditando antes de tiempo.`,
      });
    }
    hechos.push(arma(g, metodo, porcion, ivaPagado));
  }

  // ── PPD: el incremento del mes, con el tope de lo aparcado ─────────────
  for (const g of ppd) {
    const hastaFin = g.aplicado_hasta_fin ?? '0';
    const hastaInicio = g.aplicado_hasta_inicio ?? '0';
    const porcion: PorcionPagada = {
      aplicadoPrevio: hastaInicio,
      aplicadoAhora: q(new Decimal(hastaFin).minus(hastaInicio)),
      totalDocumento: g.total_amount,
      tasaCambio: g.exchange_rate,
    };

    // El tope de lo que este documento APARCÓ. Un gasto contabilizado antes
    // de que existiera el IVA en flujo mandó su IVA directo a 1130 y no
    // aparcó nada: su tope es cero y su pago no acredita nada por segunda vez.
    const aparcado = new Decimal(await ivaStillParked(client, 'received', entityId, g.id));

    // Se topan los ACUMULADOS y se restan después, no al revés: topar el
    // tramo dejaría que la suma de los meses superase lo aparcado.
    const acumFin = Decimal.min(
      new Decimal(acumuladoDelDocumento(g.tax_amount, hastaFin, g.total_amount, g.exchange_rate)),
      aparcado
    );
    const acumInicio = Decimal.min(
      new Decimal(
        acumuladoDelDocumento(g.tax_amount, hastaInicio, g.total_amount, g.exchange_rate)
      ),
      aparcado
    );
    const ivaPagado = Decimal.max(acumFin.minus(acumInicio), new Decimal(0));

    const sinTope = new Decimal(porcionDelDocumento(g.tax_amount, porcion));
    if (sinTope.greaterThan(ivaPagado)) {
      hallazgos.push({
        codigo: 'DIOT-TOPE-APARCADO',
        severidad: 'aviso',
        documentId: g.id,
        documentNumber: g.bill_number,
        mensaje:
          `El gasto ${g.bill_number} pagó una proporción que valdría ${q(sinTope)} de IVA ` +
          `acreditable, pero sólo tiene ${q(aparcado)} aparcado en 1135 y el mes declara ` +
          `${q(ivaPagado)}. Suele significar que el gasto se contabilizó antes de que el IVA ` +
          `en flujo existiera: su IVA ya se acreditó cuando llegó la factura.`,
      });
    }

    hechos.push(arma(g, clasificado.get(g.id)!, porcion, q(ivaPagado)));
  }

  return { hechos, hallazgos };
}
