import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import { getPolicy } from '../policy/policy-service.js';
import {
  recordVendorPayment,
  recordCustomerPayment,
  type AplicacionPago,
} from '../payments/payment-service.js';
import type { PagoREP } from './cfdi-facts.js';

// ============================================================
// EL REP SE LIGA AL PAGO; NO POSTEA EFECTIVO POR SU CUENTA.
//
// Un CFDI tipo P documenta que un dinero se movió y contra qué facturas se
// aplicó. La tentación —y lo que el plan anterior especificaba— es que su
// ingesta postee el asiento directamente: cargo a proveedores, abono a
// bancos, más las líneas del traspaso de IVA. Eso produce dos daños a la vez.
//
// El primero: si el pago también se capturó por la puerta de pagos, el banco
// queda abonado DOS VECES, y el saldo del documento se decrementa por dos
// caminos que no se conocen entre sí.
//
// El segundo es peor porque no se ve. Si además se liberan las líneas de IVA,
// el impuesto se traspasa dos veces; pero `ivaStillParked` topa el exceso
// contra lo que queda aparcado y NO avisa, así que la póliza cuadra y la
// declaración mensual sale mal. Un número equivocado que cuadra no lo
// encuentra nadie.
//
// Por eso aquí el REP nunca escribe un asiento. Resuelve a qué pago
// corresponde y, si ese pago no existe, lo crea POR LA PUERTA DE PAGOS. Esa
// puerta ya libera el IVA —`ivaReclassLines` no lee el pago, lee las filas de
// aplicación—, así que el traspaso sale gratis, en la misma póliza y sin una
// sola línea de impuesto escrita aquí. La ligadura primero; el impuesto es su
// consecuencia, nunca al revés.
// ============================================================

export type AccionREP = 'ya_ligado' | 'casado' | 'creado' | 'revision';

export interface ResultadoREP {
  accion: AccionREP;
  paymentId?: string;
  /** Por qué se hizo lo que se hizo. Se guarda con el documento. */
  motivo: string;
  avisos: string[];
}

interface DocumentoResuelto {
  uuid: string;
  documentId: string;
  counterpartyId: string;
  currencyCode: string;
  /** IVA y total del documento original, para validar el IVA que el REP declara. */
  taxAmount: string;
  totalAmount: string;
  impPagado: number;
  ivaTrasladadoDR?: number;
}

/** Fecha del pago según el REP; si el complemento no la trae, la del CFDI. */
function fechaDelPago(pago: PagoREP, fechaCfdi: Date): Date {
  if (!pago.fechaPago) return fechaCfdi;
  const d = new Date(pago.fechaPago);
  return Number.isNaN(d.getTime()) ? fechaCfdi : d;
}

/**
 * c_FormaPago del SAT → el vocabulario de `payment_method` de las tablas.
 *
 * Los dos extremos no admiten los mismos valores (AP no tiene debit_card), así
 * que el mapa tiene que existir de todas formas. Todo lo que no esté cae en
 * 'other': es un dato descriptivo, no decide un peso.
 */
const FORMA_PAGO: Record<string, { ap: string; ar: string }> = {
  '01': { ap: 'cash', ar: 'cash' },
  '02': { ap: 'check', ar: 'check' },
  '03': { ap: 'spei', ar: 'spei' },
  '04': { ap: 'credit_card', ar: 'credit_card' },
  '28': { ap: 'other', ar: 'debit_card' },
};

function metodoDePago(forma: string | undefined, lado: 'ap' | 'ar'): string {
  const m = forma ? FORMA_PAGO[forma] : undefined;
  return m ? m[lado] : 'other';
}

/**
 * Liga un nodo `Pago` de un REP contra el pago que documenta.
 *
 * `indice` es la posición del nodo dentro del complemento: un REP puede
 * documentar varios movimientos de banco, y cada uno es una fila de pago.
 */
export async function ligarPagoREP(opts: {
  tenantId: string;
  entityId: string;
  userId: string;
  cfdiUuid: string;
  direction: 'emitido' | 'recibido';
  indice: number;
  pago: PagoREP;
  fechaCfdi: Date;
  monedaFuncional: string;
}): Promise<ResultadoREP> {
  const avisos: string[] = [];
  const lado = opts.direction === 'recibido' ? 'ap' : 'ar';
  const tabla = lado === 'ap' ? 'vendor_payments' : 'customer_payments';

  // ── Idempotencia, antes que nada ──
  // La llave (entidad, uuid, índice) la impone además un índice único parcial
  // en la base: esta consulta evita el error, no lo sustituye.
  const ya = await query<{ id: string }>(
    `SELECT id FROM ${tabla}
      WHERE entity_id = $1 AND cfdi_uuid = $2 AND cfdi_pago_indice = $3`,
    [opts.entityId, opts.cfdiUuid, opts.indice]
  );
  if (ya.rows.length > 0) {
    return {
      accion: 'ya_ligado',
      paymentId: ya.rows[0].id,
      motivo: 'Este nodo de pago del comprobante ya está ligado a un pago registrado.',
      avisos,
    };
  }

  const ctx = { tenantId: opts.tenantId, entityId: opts.entityId };

  // ── Moneda ──
  const monedaP = opts.pago.monedaP ?? opts.monedaFuncional;
  const hayMonedaExtranjera =
    monedaP !== opts.monedaFuncional ||
    opts.pago.docsRelacionados.some(
      (d) => d.monedaDR && d.monedaDR !== opts.monedaFuncional
    );
  if (hayMonedaExtranjera) {
    const pol = await getPolicy(ctx, 'rep_moneda_extranjera');
    if (pol.value !== 'tc_documento') {
      // Cualquier valor que no sea el explícito de casar se trata como no
      // casar: el vocabulario está cerrado al declarar y abierto al escribir,
      // así que un valor desconocido no puede acabar moviendo dinero.
      return {
        accion: 'revision',
        motivo:
          `El pago viene en ${monedaP} y la moneda funcional es ${opts.monedaFuncional}. ` +
          'La diferencia cambiaria no se calcula todavía —nada postea a las cuentas de ' +
          'utilidad o pérdida cambiaria— así que el comprobante queda para revisión en ' +
          'vez de casarse con un tipo de cambio inventado.',
        avisos,
      };
    }
    avisos.push(
      `Pago en ${monedaP} casado al tipo de cambio del documento: no se reconoce diferencia cambiaria.`
    );
  }

  // ── Los documentos que el REP relaciona ──
  const resueltos: DocumentoResuelto[] = [];
  const desconocidos: string[] = [];
  for (const dr of opts.pago.docsRelacionados) {
    const doc = await resolverDocumento(opts.entityId, dr.uuid, lado);
    if (!doc) {
      desconocidos.push(dr.uuid);
      continue;
    }
    resueltos.push({ ...doc, uuid: dr.uuid, impPagado: dr.impPagado, ivaTrasladadoDR: dr.ivaTrasladadoDR });
  }

  if (desconocidos.length > 0) {
    const pol = await getPolicy(ctx, 'rep_documento_desconocido');
    if (pol.value !== 'postear_sin_iva') {
      return {
        accion: 'revision',
        motivo:
          `El comprobante relaciona ${desconocidos.length} documento(s) que el sistema no tiene ` +
          `(${desconocidos[0]}${desconocidos.length > 1 ? ', …' : ''}). Sin la factura original no ` +
          'hay base contra la cual repartir el IVA de esa parcialidad, así que el impuesto se ' +
          'queda aparcado —que es donde la ley lo quiere hasta que haya documento que lo ampare—. ' +
          'Cuando esa factura se ingiera, reprocesa este comprobante: nada lo reintenta solo.',
        avisos,
      };
    }
    avisos.push(
      `Se ignoran ${desconocidos.length} documento(s) que el sistema no tiene: su IVA no se traspasa.`
    );
  }

  if (resueltos.length === 0) {
    return {
      accion: 'revision',
      motivo: 'Ningún documento del comprobante corresponde a una factura o gasto del sistema.',
      avisos,
    };
  }

  const contrapartes = new Set(resueltos.map((r) => r.counterpartyId));
  if (contrapartes.size > 1) {
    return {
      accion: 'revision',
      motivo:
        'El nodo de pago aplica a documentos de más de una contraparte. Un movimiento de banco ' +
        'tiene un solo tercero; repartirlo entre varios exige decidir a mano cuánto es de cada uno.',
      avisos,
    };
  }

  const fecha = fechaDelPago(opts.pago, opts.fechaCfdi);
  const tolerancia = new Decimal(
    (await getPolicy(ctx, 'rep_tolerancia_importe')).value || '0.01'
  );
  const ventana = Number((await getPolicy(ctx, 'rep_ventana_dias')).value || '3');

  // ── El IVA que el REP declara se COTEJA contra el del documento ──
  //
  // `ImpuestosDR` es la cifra del SAT para esta parcialidad. La liberación
  // del impuesto sale del prorrateo sobre el documento (ivaToReclassify), así
  // que si las dos cifras divergen más que la tolerancia, casar o crear
  // liberaría un importe distinto del que el comprobante ampara — y eso es
  // exactamente lo que LIVA art. 5 fracc. III no permite. Se detiene aquí,
  // con las dos cifras nombradas, en vez de elegir una en silencio.
  for (const r of resueltos) {
    if (r.ivaTrasladadoDR === undefined) continue;
    const total = new Decimal(r.totalAmount);
    if (total.isZero()) continue;
    const prorrateado = new Decimal(r.taxAmount)
      .times(new Decimal(r.impPagado).dividedBy(total))
      .toDecimalPlaces(2);
    const declarado = new Decimal(r.ivaTrasladadoDR);
    if (prorrateado.minus(declarado).abs().greaterThan(tolerancia)) {
      return {
        accion: 'revision',
        motivo:
          `El comprobante declara ${declarado.toFixed(2)} de IVA para el documento ${r.uuid} ` +
          `y el prorrateo sobre la factura da ${prorrateado.toFixed(2)}. Liberar cualquiera de ` +
          'las dos cifras contradiría a la otra: puede ser otra parcialidad, un documento ' +
          'corregido, o un error del emisor. Se revisa a mano.',
        avisos,
      };
    }
  }

  // El importe con el que se busca es EL MISMO con el que se crearía: la suma
  // de lo aplicado a documentos resueltos. La primera versión buscaba por el
  // `Monto` del nodo y creaba por la suma resuelta; cuando divergían —un DR
  // ignorado por política, una comisión del emisor— el pago capturado a mano
  // no se encontraba y se creaba el duplicado que este módulo existe para
  // impedir. Verificado con reproducción: banco abonado dos veces e IVA
  // liberado dos veces, con la póliza cuadrando.
  const importe = resueltos.reduce((s, r) => s.plus(r.impPagado), new Decimal(0));
  if (opts.pago.monto && !new Decimal(opts.pago.monto).minus(importe).abs().lessThanOrEqualTo(tolerancia)) {
    avisos.push(
      `El Monto del nodo de pago (${new Decimal(opts.pago.monto).toFixed(2)}) no coincide con la ` +
        `suma de sus parcialidades resueltas (${importe.toFixed(2)}); se opera por la suma resuelta.`
    );
  }

  const candidato = await buscarPagoExistente({
    tabla,
    lado,
    entityId: opts.entityId,
    counterpartyId: [...contrapartes][0],
    importe,
    tolerancia,
    fecha,
    ventana,
    documentIds: resueltos.map((r) => r.documentId),
  });

  if (candidato) {
    // Casar es ANOTAR, no volver a postear: el asiento del pago ya existe y ya
    // liberó su IVA cuando se registró. Escribir aquí una segunda póliza es
    // exactamente el doble abono que este módulo evita.
    await query(
      `UPDATE ${tabla} SET cfdi_uuid = $2, cfdi_pago_indice = $3 WHERE id = $1`,
      [candidato.id, opts.cfdiUuid, opts.indice]
    );
    return {
      accion: 'casado',
      paymentId: candidato.id,
      motivo:
        `El comprobante corresponde al pago ${candidato.numero}, ya registrado. Se anota la ` +
        'ligadura y no se postea nada: el asiento de ese pago ya movió el banco y ya liberó su IVA.',
      avisos,
    };
  }

  // ── No hay pago: decide la política ──
  const pol = await getPolicy(ctx, 'rep_pago_no_registrado');
  if (pol.value !== 'crear_pago') {
    return {
      accion: 'revision',
      motivo:
        'No hay ningún pago registrado que corresponda a este comprobante, y la política dice que ' +
        'la ingesta no cree pagos por su cuenta. Queda para que una persona lo confirme.',
      avisos,
    };
  }

  const aplicaciones: AplicacionPago[] = resueltos.map((r) => ({
    documentId: r.documentId,
    amountApplied: new Decimal(r.impPagado).toFixed(2),
  }));

  // La suma de las aplicaciones manda sobre el `Monto` del nodo: la puerta de
  // pagos exige que cuadren exactamente, y lo que se aplica a documentos es lo
  // que el propio comprobante reparte.
  const total = aplicaciones
    .reduce((s, a) => s.plus(a.amountApplied), new Decimal(0))
    .toFixed(2);
  if (!importe.minus(total).abs().lessThanOrEqualTo(tolerancia)) {
    avisos.push(
      `El importe del nodo de pago (${importe.toFixed(2)}) no coincide con la suma de sus ` +
        `parcialidades (${total}); se registra por la suma de las parcialidades.`
    );
  }

  const entrada = {
    entityId: opts.entityId,
    counterpartyId: [...contrapartes][0],
    paymentAmount: total,
    paymentDate: fecha,
    paymentMethod: metodoDePago(opts.pago.formaDePagoP, lado),
    referenceNumber: opts.pago.numOperacion ?? null,
    memo: `REP ${opts.cfdiUuid}`,
    applications: aplicaciones,
    currencyCode: resueltos[0].currencyCode,
    cfdiUuid: opts.cfdiUuid,
    cfdiPagoIndice: opts.indice,
  };

  // La puerta de pagos valida de verdad —que el documento admita pago, que la
  // suma cuadre, que la moneda coincida— y ésa es la razón de pasar por ella.
  // Su rechazo no es un fallo del sistema sino un hallazgo sobre este
  // comprobante: se convierte en revisión con el motivo, porque una ingesta es
  // un LOTE y un REP que no se puede registrar no debe tumbar los demás.
  let r: { paymentId: string };
  try {
    r =
      lado === 'ap'
        ? await recordVendorPayment(entrada, opts.userId)
        : await recordCustomerPayment(entrada, opts.userId);
  } catch (e) {
    return {
      accion: 'revision',
      motivo:
        'El comprobante no se pudo registrar como pago: ' + (e as Error).message,
      avisos,
    };
  }

  return {
    accion: 'creado',
    paymentId: r.paymentId,
    motivo:
      'No había pago registrado, así que se creó desde el comprobante y se aplicó a cada documento ' +
      'que relaciona. Al escribirlo por la puerta de pagos, el IVA aparcado se libera en la misma ' +
      'póliza, sin una línea de impuesto escrita a mano.',
    avisos,
  };
}

/**
 * Del UUID fiscal al documento del sistema.
 *
 * Las facturas emitidas llevan su UUID en la propia tabla. Los gastos no: el
 * puente es el pre-registro que los creó, que sí guarda el documento XML. Es
 * el mismo rodeo que ya usan el IVA sobre flujo y el servicio de gastos.
 */
async function resolverDocumento(
  entityId: string,
  uuid: string,
  lado: 'ap' | 'ar'
): Promise<Omit<DocumentoResuelto, 'uuid' | 'impPagado'> | null> {
  if (lado === 'ar') {
    // La primera versión consultaba `balance_due`, columna que no existe —la
    // tabla se creó con `amount_due`— así que TODO REP emitido moría con un
    // 42703 de Postgres y el pre-registro caía en 'error'. Nadie lo vio
    // porque la suite sólo cubría el lado de proveedores: una rama sin
    // prueba no está «casi lista», está sin ejecutar.
    const r = await query<{
      id: string; customer_id: string; currency_code: string;
      tax_amount: string; total_amount: string;
    }>(
      `SELECT id, customer_id, currency_code,
              tax_amount::text AS tax_amount, total_amount::text AS total_amount
         FROM invoices WHERE entity_id = $1 AND cfdi_uuid = $2
        ORDER BY created_at LIMIT 1`,
      [entityId, uuid]
    );
    const row = r.rows[0];
    return row
      ? {
          documentId: row.id, counterpartyId: row.customer_id, currencyCode: row.currency_code,
          taxAmount: row.tax_amount, totalAmount: row.total_amount,
        }
      : null;
  }
  const r = await query<{
    id: string; vendor_id: string; currency_code: string;
    tax_amount: string; total_amount: string;
  }>(
    `SELECT b.id, b.vendor_id, b.currency_code,
            b.tax_amount::text AS tax_amount, b.total_amount::text AS total_amount
       FROM pre_registrations p
       JOIN xml_documents x ON x.id = p.xml_document_id
       JOIN bills b ON b.id = p.bill_id
      WHERE p.entity_id = $1 AND x.cfdi_uuid = $2 AND p.bill_id IS NOT NULL
      ORDER BY p.created_at LIMIT 1`,
    [entityId, uuid]
  );
  const row = r.rows[0];
  return row
    ? {
        documentId: row.id, counterpartyId: row.vendor_id, currencyCode: row.currency_code,
        taxAmount: row.tax_amount, totalAmount: row.total_amount,
      }
    : null;
}

/**
 * Un pago ya capturado que sea el mismo hecho económico.
 *
 * Mismo tercero, importe dentro de la tolerancia y fecha dentro de la ventana.
 * Sólo se consideran pagos SIN comprobante ligado: uno que ya tiene el suyo es
 * otro movimiento, y tomarlo produciría precisamente el duplicado que se busca
 * evitar. Se ordena por cercanía de fecha para que, con varios candidatos,
 * gane el más plausible y no el primero que devuelva el índice.
 */
async function buscarPagoExistente(p: {
  tabla: string;
  lado: 'ap' | 'ar';
  entityId: string;
  counterpartyId: string;
  importe: Decimal;
  tolerancia: Decimal;
  fecha: Date;
  ventana: number;
  /** Los documentos que el REP relaciona, ya resueltos a ids del sistema. */
  documentIds: string[];
}): Promise<{ id: string; numero: string } | null> {
  const col = p.lado === 'ap' ? 'vendor_id' : 'customer_id';
  // El candidato tiene que estar APLICADO a alguno de los documentos que el
  // REP relaciona. Tercero, importe y fecha no bastan: dos pagos iguales al
  // mismo proveedor en la misma semana —una renta quincenal, una iguala— se
  // cruzarían, y el gasto equivocado quedaría «con comprobante» mientras el
  // del REP se queda sin pago y con su IVA aparcado. La aplicación es lo que
  // dice de qué hecho económico es el dinero.
  const apps = p.lado === 'ap'
    ? `SELECT 1 FROM payment_applications pa WHERE pa.payment_id = t.id AND pa.bill_id = ANY($7::uuid[])`
    : `SELECT 1 FROM payment_allocations pa WHERE pa.payment_id = t.id AND pa.invoice_id = ANY($7::uuid[])`;
  const r = await query<{ id: string; numero: string }>(
    `SELECT t.id, t.payment_number AS numero
       FROM ${p.tabla} t
      WHERE t.entity_id = $1
        AND t.${col} = $2
        AND t.cfdi_uuid IS NULL
        AND t.status = 'completed'
        AND ABS(t.payment_amount - $3::numeric) <= $4::numeric
        AND t.payment_date BETWEEN $5::date - $6::int AND $5::date + $6::int
        AND EXISTS (${apps})
      ORDER BY ABS(t.payment_date - $5::date), t.payment_number
      LIMIT 1`,
    [
      p.entityId,
      p.counterpartyId,
      p.importe.toFixed(2),
      p.tolerancia.toFixed(2),
      p.fecha,
      p.ventana,
      p.documentIds,
    ]
  );
  return r.rows[0] ?? null;
}
