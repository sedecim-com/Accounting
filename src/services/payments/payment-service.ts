import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import type pg from 'pg';
import { query, withTransaction } from '../../database/connection.js';
import { nextEntityNumber } from '../../utils/sequence.js';
import {
  postVendorPaymentEntry,
  postCustomerPaymentEntry,
  postReceiptApplicationEntry,
  postReceiptUnapplicationEntry,
  postVendorApplicationEntry,
  type AplicacionPosterior,
} from '../accounting/ar-ap-posting.js';
import { voidJournalEntryInTx } from '../accounting/posting.js';
import { earlyPaymentDiscount } from '../ap/bill-service.js';
import {
  desgloseCambiarioDelPago,
  monedaFuncionalDe,
  resolverTipoCambio,
  type AplicacionCambiaria,
  type ContextoCambiario,
  type DiferenciaCambiaria,
} from '../accounting/moneda-origen.js';
import { ivaToReclassify } from '../accounting/iva-cash-basis.js';
import { NotFoundError, ValidationError, AccountingError } from '../../utils/errors.js';
import type { JournalEntry } from '../../types/index.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';
import { getPolicy } from '../policy/policy-service.js';

// ============================================================
// REGISTRAR UN PAGO QUE YA OCURRIÓ.
//
// Una implementación para las tres superficies —REST, terminal y agente—,
// porque la que había vivía dentro del handler de Express y la terminal no
// tenía forma de llegar a ella. Eso importaba más de lo que parece: el pago
// es lo que LIBERA el IVA aparcado de un CFDI a crédito, así que quien
// operara por terminal nunca acreditaba el IVA que ya había pagado.
//
// EL ESTADO ES 'completed', Y ES UNA DECISIÓN, NO UN DESCUIDO.
// La columna admite draft/pending/processing/completed/failed/void y esta
// función sólo escribe 'completed'. La razón: registrar un pago es decir
// «esto ya salió de mi banco». Los otros cuatro estados pertenecen a un
// programador de pagos que NO EXISTE —el endpoint que decía programarlos se
// retiró por eso mismo— y un pago que aún no ocurrió no puede tocar el
// mayor: postearía dinero que no se ha movido. Cuando exista ese
// programador, será él quien escriba esos estados y quien decida cuándo
// pasa al mayor; hasta entonces, pedir otro estado se rechaza en voz alta
// en vez de aceptarse y no significar nada.
//
// La entidad se exige y se usa para acotar TODA lectura: un pago no puede
// aplicarse a la factura de otra entidad ni conociendo su UUID.
// ============================================================

/** Único estado que esta función escribe. Ver la nota de arriba. */
const ESTADO = 'completed';

export interface AplicacionPago {
  /** Id de la factura (cliente) o del gasto (proveedor). */
  documentId: string;
  amountApplied: string;
  discountAmount?: string;
}

export interface EntradaPago {
  entityId: string;
  /** vendor_id o customer_id según el lado. */
  counterpartyId?: string;
  paymentAmount: string;
  paymentDate: Date | string;
  paymentMethod: string;
  bankAccountId?: string | null;
  referenceNumber?: string | null;
  memo?: string | null;
  applications: AplicacionPago[];
  /** Cualquier valor distinto de 'completed' se rechaza. */
  status?: string;
  /**
   * R4 · Tipo de cambio del DÍA DEL PAGO, cuando el pago está en otra moneda
   * que la funcional de la entidad. Si se omite, se resuelve de
   * `exchange_rates` con la fuente que dicte la política
   * `fuente_tipo_cambio`; si esa fuente no tiene tasa para la fecha, el
   * registro SE DETIENE y lo dice — nunca toma otra fuente en silencio.
   * DECIMAL(19,10) como string, igual que todo tipo de cambio del sistema.
   */
  exchangeRate?: string;
  /** Moneda del pago. Si se omite, se toma la del documento y se exige que
   *  todos coincidan. */
  currencyCode?: string;
  /**
   * UUID del CFDI tipo P (REP) que documenta este pago, cuando el pago nace
   * de ingerir ese comprobante. Con el índice del nodo `Pago`, forma la
   * llave que impide contabilizar dos veces el mismo movimiento: el índice
   * único parcial de la migración 036 lo rechaza en la base, no en el código.
   */
  cfdiUuid?: string | null;
  cfdiPagoIndice?: number | null;
  /**
   * SOLO lado cliente (049): permite que las aplicaciones sumen MENOS que el
   * pago — el remanente queda a cuenta (CR anticipo_clientes, nunca colgado
   * de la cuenta de control) — e incluso que no haya ninguna (anticipo puro,
   * que entonces exige counterpartyId y moneda). El lado proveedor no lo
   * acepta: un pago nuestro sin aplicar es otra historia.
   */
  onAccount?: boolean;
}

interface DocumentoAplicado {
  id: string; numero: string; saldoAnterior: string; saldoNuevo: string;
  estado: string; moneda: string;
}

export interface ResultadoPago {
  paymentId: string;
  paymentNumber: string;
  journalEntry: JournalEntry | null;
  /** Para disparar la atestación DESPUÉS del commit. */
  attestation: { entityId: string; entryId: string } | null;
  documentos: DocumentoAplicado[];
  /**
   * R4 · sólo pagos en moneda extranjera (hoy, sólo lado proveedor): la
   * diferencia cambiaria REALIZADA que el pago asentó, y con qué tasa.
   */
  diferenciaCambiaria?: (DiferenciaCambiaria & { tasaPago: string; fuente: string }) | null;
}

export interface OpcionesPago {
  /** Corre todo y revierte: sirve para la vista previa de la terminal. */
  dryRun?: boolean;
  client?: pg.PoolClient;
}

function assertEstado(status: string | undefined): void {
  if (status !== undefined && status !== ESTADO) {
    throw new AccountingError(
      'PAYMENT_STATE_UNSUPPORTED',
      `Un pago sólo puede registrarse como '${ESTADO}': mnemosine registra pagos que YA ocurrieron. ` +
        `El estado '${status}' pertenece a un programador de pagos que no existe, y un pago que no ` +
        `ha salido del banco no puede tocar el mayor.`
    );
  }
}

// `lado` decide dos cosas y ninguna es cosmética: si el descuento por pronto
// pago se acepta o se manda a la nota de crédito, y de quién es el anticipo
// cuando sobra dinero. Antes era `permiteACuenta`, una bandera que después de
// F04 los dos llamadores pasaban en `true` — un parámetro que nadie puede
// poner en `false` no es una opción, es ruido con forma de opción.
function assertAplicaciones(entrada: EntradaPago, lado: 'cliente' | 'proveedor'): void {
  const aCuenta = entrada.onAccount === true;
  if (entrada.applications.length === 0 && !aCuenta) {
    throw new ValidationError(
      'Un pago sin aplicar a ningún documento no libera saldo ni acredita IVA: indica a qué se aplica.'
    );
  }
  if (entrada.applications.length === 0 && aCuenta && !entrada.counterpartyId) {
    throw new ValidationError(
      `Un anticipo sin documento necesita el ${lado} explícito: sin documento no hay de dónde deducirlo.`
    );
  }

  // Un documento repetido pasaba las dos validaciones y se restaba DOS veces.
  // El bucle que valida corre entero antes del que escribe, así que ambas
  // entradas comparaban contra el saldo original; el FOR UPDATE no lo impide
  // porque el candado es reentrante dentro de la misma transacción. Resultado
  // medido: amount_due en -1000, el gasto en 'paid', y el asiento cargando el
  // doble a la cuenta de control de proveedores.
  const vistos = new Set<string>();
  for (const a of entrada.applications) {
    if (vistos.has(a.documentId)) {
      throw new ValidationError(
        `El documento ${a.documentId} aparece dos veces en el mismo pago. ` +
          'Súmalas en una sola aplicación: repetirlo restaría su saldo dos veces.'
      );
    }
    vistos.add(a.documentId);
  }

  // EL DESCUENTO POR PRONTO PAGO, por fin cableado (F04).
  //
  // Se insertaba en payment_applications y no participaba en nada más: ni
  // reducía el saldo ni entraba en el asiento, así que el proveedor quedaba
  // debiendo el descuento para siempre. Se rechazaba en voz alta diciendo que
  // «necesita una cuenta de ingreso por descuentos en la capa de roles» — y la
  // cuenta existía desde la siembra: `devolucion_compras` (5200, contra-costo),
  // espejo exacto del 4400 con el que la nota de crédito reduce las ventas.
  // Lo que faltaba no era la cuenta: era atarla.
  //
  // Del lado CLIENTE sigue rechazado, y no por simetría perezosa: un descuento
  // que NOSOTROS concedemos a un cliente es una nota de crédito —documento
  // fiscal, con su CFDI de egreso— y no una línea suelta en el cobro. F03 le
  // construyó su camino propio.
  const conDescuento = entrada.applications.find(
    (a) => a.discountAmount !== undefined && new Decimal(a.discountAmount).greaterThan(0)
  );
  if (conDescuento && lado === 'cliente') {
    throw new ValidationError(
      'Un descuento concedido a un cliente no es una línea del cobro: es una NOTA DE CRÉDITO, ' +
        'con su documento y su CFDI de egreso. Emítela con `mnemosine credit-note create --type descuento` ' +
        'y aplícala a la factura.'
    );
  }

  // Sólo EFECTIVO: el descuento extingue pasivo pero no salió del banco, así
  // que comparar `amountApplied` contra el importe pagado sigue siendo la
  // igualdad correcta. Sumar el descuento aquí exigiría un pago mayor que el
  // que de verdad se hizo.
  const total = entrada.applications.reduce(
    (s, a) => s.plus(a.amountApplied),
    new Decimal(0)
  );
  // Exacto, no «no más de» — salvo a cuenta EXPLÍCITO (049), donde el
  // remanente va a anticipo_clientes en el asiento y no queda en el aire.
  // Aplicar de menos SIN pedirlo sigue rechazándose: el que suma mal debe
  // enterarse, no ganar un anticipo por accidente.
  if (total.greaterThan(entrada.paymentAmount)) {
    throw new ValidationError(
      `Las aplicaciones suman ${total.toFixed(2)} y el pago es de ` +
        `${new Decimal(entrada.paymentAmount).toFixed(2)}: no se puede aplicar más de lo que se pagó.`
    );
  }
  if (!total.equals(entrada.paymentAmount) && !aCuenta) {
    throw new ValidationError(
      `Las aplicaciones suman ${total.toFixed(2)} y el pago es de ` +
        `${new Decimal(entrada.paymentAmount).toFixed(2)}. Tienen que coincidir: lo que sobra ` +
        'quedaría cargado a la cuenta de control sin bajar de ningún auxiliar. Si el remanente ' +
        `es deliberado, dilo con onAccount (--on-account): quedará como anticipo ${
          lado === 'cliente' ? 'del cliente' : 'a proveedores'
        }.`
    );
  }
}

/** La moneda del documento tiene que ser la del pago. */
function assertMoneda(numero: string, delDocumento: string, delPago: string | undefined): void {
  const pago = delPago ?? delDocumento;
  if (delDocumento !== pago) {
    throw new ValidationError(
      `${numero} está en ${delDocumento} y el pago en ${pago}. Un importe en otra moneda ` +
        'se restaría crudo del saldo y se asentaría crudo, sin tipo de cambio.'
    );
  }
}

// ── Proveedores ──

export async function recordVendorPayment(
  entrada: EntradaPago,
  userId: string,
  opts: OpcionesPago = {}
): Promise<ResultadoPago> {
  assertEstado(entrada.status);
  // F04: el lado proveedor admite pago a cuenta (anticipo, 1150) y descuento
  // por pronto pago (contra-costo, 5200) — las dos cosas que el catálogo
  // promete en `payment create --vendor` y `payment apply --discount`.
  assertAplicaciones(entrada, 'proveedor');

  const correr = async (client: pg.PoolClient): Promise<ResultadoPago> => {
    const documentos: DocumentoAplicado[] = [];
    // R4 · lo que el desglose cambiario necesita de cada gasto: su tasa
    // histórica viaja junto a lo aplicado, porque cada pasivo se extingue
    // al tipo al que nació.
    const fxApps: AplicacionCambiaria[] = [];

    // Las facturas se leen ACOTADAS POR ENTIDAD y con FOR UPDATE: sin el
    // filtro, conocer el UUID bastaría para pagar el gasto de otra entidad;
    // sin el candado, dos pagos simultáneos leerían el mismo saldo.
    for (const app of entrada.applications) {
      const r = await client.query<{
        id: string; bill_number: string; amount_due: string; vendor_id: string;
        status: string; currency_code: string; exchange_rate: string;
      }>(
        `SELECT id, bill_number, amount_due, vendor_id, status, currency_code,
                exchange_rate::text AS exchange_rate
           FROM bills WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [app.documentId, entrada.entityId]
      );
      if (r.rows.length === 0) {
        throw new NotFoundError('Bill', app.documentId);
      }
      const bill = r.rows[0];

      // El pasivo tiene que estar en el mayor antes de pagarlo. La guarda
      // vivía sólo en el comando de la terminal, así que por REST se pagaba
      // un borrador: se restaba su saldo y se posteaba el asiento de pago
      // contra un pasivo que nadie había reconocido.
      if (!PAGABLES.includes(bill.status as (typeof PAGABLES)[number])) {
        throw new ValidationError(
          `${bill.bill_number} está en "${bill.status}" y sólo se puede pagar un gasto ` +
            `${PAGABLES.join(', ')}: su pasivo tiene que estar en el mayor primero.`
        );
      }
      assertMoneda(bill.bill_number, bill.currency_code, entrada.currencyCode);
      if (entrada.counterpartyId && entrada.counterpartyId !== bill.vendor_id) {
        throw new ValidationError(
          `${bill.bill_number} es del proveedor ${bill.vendor_id} y el pago se atribuye a ` +
            `${entrada.counterpartyId}: el pago quedaría en el auxiliar equivocado.`
        );
      }
      const aplicado = new Decimal(app.amountApplied);
      const descuento = new Decimal(app.discountAmount ?? '0');
      const saldo = new Decimal(bill.amount_due);
      // El descuento EXTINGUE pasivo igual que el efectivo: lo que el
      // proveedor deja de tener derecho a cobrar es la suma de los dos.
      const extingue = aplicado.plus(descuento);
      if (extingue.greaterThan(saldo)) {
        throw new ValidationError(
          `${bill.bill_number} debe ${saldo.toFixed(2)} y se intentan extinguir ${extingue.toFixed(2)} ` +
            `(${aplicado.toFixed(2)} de efectivo + ${descuento.toFixed(2)} de descuento).`
        );
      }
      const nuevo = saldo.minus(extingue);
      const estado = nuevo.lessThanOrEqualTo(0) ? 'paid' : 'partially_paid';
      documentos.push({
        id: bill.id, numero: bill.bill_number,
        saldoAnterior: saldo.toFixed(2), saldoNuevo: nuevo.toFixed(2), estado,
        moneda: bill.currency_code,
      });
      fxApps.push({
        billId: bill.id,
        numero: bill.bill_number,
        aplicado: aplicado.toFixed(4),
        descuento: descuento.toFixed(4),
        tasaHistorica: bill.exchange_rate,
      });
    }

    // ── R4 · ¿EL PAGO ESTÁ EN OTRA MONEDA QUE LOS LIBROS? ──────────────
    //
    // assertMoneda ya garantizó que pago y documentos comparten moneda; lo
    // que falta saber es si esa moneda es la funcional. Si no lo es, el
    // asiento necesita la tasa del DÍA DEL PAGO: explícita del llamador, o
    // resuelta de exchange_rates con la fuente que dicta la política
    // `fuente_tipo_cambio` (su primer lector real).
    let fx: ContextoCambiario | null = null;
    if (documentos.length > 0) {
      const funcional = await monedaFuncionalDe(client, entrada.entityId);
      const moneda = monedaDe(documentos);
      if (moneda !== funcional) {
        for (const a of fxApps) {
          const th = new Decimal(a.tasaHistorica || '0');
          // Un gasto extranjero con tasa 1.0 (el default de captura) o nula
          // se asentó sin convertir — anterior a R4 o capturado a medias.
          // Pagarlo por este camino fabricaría una «diferencia cambiaria»
          // que es en realidad la conversión que nunca ocurrió.
          if (!th.greaterThan(0) || th.equals(1)) {
            throw new ValidationError(
              `${a.numero} está en ${moneda} pero su exchange_rate es ` +
                `${a.tasaHistorica} (el default de captura): su pasivo se asentó sin ` +
                `convertir. Corrige el documento antes de pagarlo — la diferencia ` +
                `cambiaria se mide contra la tasa a la que el pasivo nació (NIF B-15).`
            );
          }
        }
        let tasaPago: string;
        let fuenteTasa: string;
        if (entrada.exchangeRate !== undefined) {
          if (!new Decimal(entrada.exchangeRate).greaterThan(0)) {
            throw new ValidationError(
              `El tipo de cambio del pago (${entrada.exchangeRate}) tiene que ser mayor que cero.`
            );
          }
          tasaPago = entrada.exchangeRate;
          fuenteTasa = 'parametro';
        } else {
          const resuelto = await resolverTipoCambio(
            client,
            { tenantId: await tenantDe(client, entrada.entityId), entityId: entrada.entityId },
            { de: moneda, a: funcional, fecha: entrada.paymentDate }
          );
          tasaPago = resuelto.tasa;
          fuenteTasa = resuelto.fuente;
        }
        fx = { moneda, monedaFuncional: funcional, tasaPago, fuenteTasa, aplicaciones: fxApps };
      }
    }

    const vendorId = entrada.counterpartyId
      ?? (await client.query<{ vendor_id: string }>(
        `SELECT vendor_id FROM bills WHERE id = $1`, [entrada.applications[0].documentId]
      )).rows[0]?.vendor_id;
    if (!vendorId) throw new ValidationError('No se pudo determinar el proveedor del pago.');

    const paymentNumber = await nextEntityNumber(client, entrada.entityId, 'vendor_payment', 'VPMT', entrada.paymentDate);
    const paymentId = uuidv4();

    await client.query(
      // reference_number y currency_code faltaban del INSERT. Lo primero
      // perdía el NumOperacion del REP —la referencia bancaria que permite
      // conciliar—; lo segundo es peor: la columna tiene DEFAULT 'USD', así
      // que todo pago a proveedor en pesos quedaba registrado como dólares.
      // El lado AR siempre los escribió; éste no, y nadie lo leía.
      // R4: exchange_rate se escribe SIEMPRE — la tasa del día en extranjera,
      // 1.0 explícito en funcional. Dejarlo al DEFAULT era indistinguible de
      // «nadie lo pensó», que es exactamente lo que era.
      `INSERT INTO vendor_payments (
         id, entity_id, payment_number, vendor_id, payment_amount, currency_code,
         payment_method, reference_number, bank_account_id, payment_date, status, memo, created_by,
         cfdi_uuid, cfdi_pago_indice, exchange_rate
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [paymentId, entrada.entityId, paymentNumber, vendorId, entrada.paymentAmount,
       monedaDe(documentos), entrada.paymentMethod, entrada.referenceNumber ?? null,
       entrada.bankAccountId ?? null, entrada.paymentDate,
       ESTADO, entrada.memo ?? null, userId,
       entrada.cfdiUuid ?? null, entrada.cfdiPagoIndice ?? null,
       fx?.tasaPago ?? '1.0']
    );

    for (const app of entrada.applications) {
      await client.query(
        `INSERT INTO payment_applications (id, payment_id, bill_id, amount_applied, discount_amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [uuidv4(), paymentId, app.documentId, app.amountApplied, app.discountAmount ?? 0]
      );
      // amount_paid recibe SÓLO el efectivo; el saldo baja por los dos. Un
      // descuento no es dinero cobrado: contarlo como pagado inflaría lo que
      // el proveedor recibió y descuadraría cualquier conciliación de banco.
      await client.query(
        `UPDATE bills SET
           amount_paid = amount_paid + $1,
           amount_due  = amount_due - $2,
           status = CASE WHEN amount_due - $2 <= 0 THEN 'paid' ELSE 'partially_paid' END,
           last_payment_date = $3
         WHERE id = $4 AND entity_id = $5`,
        [
          app.amountApplied,
          new Decimal(app.amountApplied).plus(app.discountAmount ?? '0').toFixed(4),
          entrada.paymentDate, app.documentId, entrada.entityId,
        ]
      );
    }

    // Aquí es donde se libera el IVA aparcado de los CFDI a crédito — y,
    // desde R4, donde la diferencia cambiaria realizada encuentra su cuenta.
    const entry = await postVendorPaymentEntry(
      client,
      {
        id: paymentId,
        entity_id: entrada.entityId,
        payment_number: paymentNumber,
        payment_amount: entrada.paymentAmount,
        payment_date: entrada.paymentDate,
        bank_account_id: entrada.bankAccountId ?? null,
        journal_entry_id: null,
      },
      userId,
      fx ?? undefined
    );

    // La misma aritmética pura que usó el asiento: determinista, así que
    // bitácora y mayor no pueden contar historias distintas.
    const diferencia = fx
      ? {
          ...desgloseCambiarioDelPago(entrada.paymentAmount, fx).diferencia,
          tasaPago: fx.tasaPago,
          fuente: fx.fuenteTasa,
        }
      : null;

    // R1: el pago deja su rastro propio — antes sólo el asiento derivado
    // quedaba auditado, y «quién registró el pago» no estaba en el rastro.
    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entrada.entityId),
      userId,
      action: 'create',
      entityType: 'vendor_payments',
      entityId: paymentId,
      newValues: {
        payment_number: paymentNumber,
        payment_amount: entrada.paymentAmount,
        journal_entry_id: entry?.id ?? null,
        documentos: documentos.length,
        // R4 · el pago en extranjera deja en su rastro la diferencia que
        // realizó y la tasa con la que la midió: es la única huella de por
        // qué el efectivo en funcional no coincide con el pasivo extinguido.
        ...(fx && diferencia
          ? {
              moneda: fx.moneda,
              tipo_cambio_pago: fx.tasaPago,
              fuente_tipo_cambio: fx.fuenteTasa,
              diferencia_cambiaria: diferencia.montoFuncional,
              diferencia_cambiaria_tipo: diferencia.tipo,
            }
          : {}),
      },
    });

    if (opts.dryRun) {
      throw new EnsayoTerminado({
        paymentId, paymentNumber, journalEntry: entry,
        attestation: entry ? { entityId: entrada.entityId, entryId: entry.id } : null,
        documentos,
        diferenciaCambiaria: diferencia,
      });
    }

    return {
      paymentId, paymentNumber, journalEntry: entry,
      attestation: entry ? { entityId: entrada.entityId, entryId: entry.id } : null,
      documentos,
      diferenciaCambiaria: diferencia,
    };
  };

  return ejecutar(correr, opts);
}

// ── Clientes ──

export async function recordCustomerPayment(
  entrada: EntradaPago,
  userId: string,
  opts: OpcionesPago = {}
): Promise<ResultadoPago> {
  assertEstado(entrada.status);
  assertAplicaciones(entrada, 'cliente');

  const correr = async (client: pg.PoolClient): Promise<ResultadoPago> => {
    const documentos: DocumentoAplicado[] = [];

    for (const app of entrada.applications) {
      const r = await client.query<{
        id: string; invoice_number: string; amount_due: string; amount_paid: string;
        customer_id: string; currency_code: string; status: string;
      }>(
        `SELECT id, invoice_number, amount_due, amount_paid, customer_id, currency_code, status
           FROM invoices WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [app.documentId, entrada.entityId]
      );
      if (r.rows.length === 0) throw new NotFoundError('Invoice', app.documentId);

      const inv = r.rows[0];
      if (!COBRABLES.includes(inv.status as (typeof COBRABLES)[number])) {
        throw new ValidationError(
          `${inv.invoice_number} está en "${inv.status}" y sólo se puede cobrar una factura ` +
            `${COBRABLES.join(', ')}: su ingreso tiene que estar en el mayor primero.`
        );
      }
      assertMoneda(inv.invoice_number, inv.currency_code, entrada.currencyCode);
      if (entrada.counterpartyId && entrada.counterpartyId !== inv.customer_id) {
        throw new ValidationError(
          `${inv.invoice_number} es del cliente ${inv.customer_id} y el cobro se atribuye a ` +
            `${entrada.counterpartyId}: quedaría en el auxiliar equivocado.`
        );
      }
      const aplicado = new Decimal(app.amountApplied);
      const saldo = new Decimal(inv.amount_due);
      if (aplicado.greaterThan(saldo)) {
        throw new ValidationError(
          `${inv.invoice_number} debe ${saldo.toFixed(2)} y se intentan aplicar ${aplicado.toFixed(2)}.`
        );
      }
      const nuevo = saldo.minus(aplicado);
      documentos.push({
        id: inv.id, numero: inv.invoice_number,
        saldoAnterior: saldo.toFixed(2), saldoNuevo: nuevo.toFixed(2),
        estado: nuevo.lessThanOrEqualTo(0) ? 'paid' : 'partially_paid',
        moneda: inv.currency_code,
      });
    }

    const customerId = entrada.counterpartyId
      ?? (await client.query<{ customer_id: string }>(
        `SELECT customer_id FROM invoices WHERE id = $1`, [entrada.applications[0].documentId]
      )).rows[0]?.customer_id;
    if (!customerId) throw new ValidationError('No se pudo determinar el cliente del cobro.');

    // Anticipo puro (049): sin documento no hay moneda de referencia — se
    // toma la del cliente, verificando de paso que existe EN ESTA entidad.
    let monedaAnticipo: string | null = null;
    if (entrada.applications.length === 0) {
      const c = await client.query<{ currency_code: string }>(
        `SELECT currency_code FROM customers WHERE id = $1 AND entity_id = $2`,
        [customerId, entrada.entityId]
      );
      if (c.rows.length === 0) throw new NotFoundError('Customer', customerId);
      monedaAnticipo = entrada.currencyCode ?? c.rows[0].currency_code;
    }

    const paymentNumber = await nextEntityNumber(client, entrada.entityId, 'customer_payment', 'PMT', entrada.paymentDate);
    const paymentId = uuidv4();

    await client.query(
      // currency_code se omitía y la columna tiene DEFAULT 'USD': un cobro en
      // pesos quedaba registrado como dólares. Regresión de la extracción.
      `INSERT INTO customer_payments (
         id, entity_id, payment_number, customer_id, payment_amount, currency_code,
         payment_method, reference_number, bank_account_id, payment_date,
         status, created_by, cfdi_uuid, cfdi_pago_indice
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [paymentId, entrada.entityId, paymentNumber, customerId, entrada.paymentAmount,
       monedaAnticipo ?? monedaDe(documentos), entrada.paymentMethod, entrada.referenceNumber ?? null,
       entrada.bankAccountId ?? null, entrada.paymentDate, ESTADO, userId,
       entrada.cfdiUuid ?? null, entrada.cfdiPagoIndice ?? null]
    );

    for (const app of entrada.applications) {
      await client.query(
        `INSERT INTO payment_allocations (id, payment_id, invoice_id, amount_applied)
         VALUES ($1,$2,$3,$4)`,
        [uuidv4(), paymentId, app.documentId, app.amountApplied]
      );
      await client.query(
        `UPDATE invoices SET
           amount_paid = amount_paid + $1,
           amount_due  = amount_due - $1,
           status = CASE WHEN amount_due - $1 <= 0 THEN 'paid' ELSE 'partially_paid' END,
           last_payment_date = $2
         WHERE id = $3 AND entity_id = $4`,
        [app.amountApplied, entrada.paymentDate, app.documentId, entrada.entityId]
      );
    }

    const entry = await postCustomerPaymentEntry(
      client,
      {
        id: paymentId,
        entity_id: entrada.entityId,
        payment_number: paymentNumber,
        payment_amount: entrada.paymentAmount,
        payment_date: entrada.paymentDate,
        bank_account_id: entrada.bankAccountId ?? null,
        journal_entry_id: null,
      },
      userId
    );

    // R1: mismo rastro que el pago a proveedor, del lado del cobro.
    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entrada.entityId),
      userId,
      action: 'create',
      entityType: 'customer_payments',
      entityId: paymentId,
      newValues: {
        payment_number: paymentNumber,
        payment_amount: entrada.paymentAmount,
        journal_entry_id: entry?.id ?? null,
        documentos: documentos.length,
      },
    });

    const salida: ResultadoPago = {
      paymentId, paymentNumber, journalEntry: entry,
      attestation: entry ? { entityId: entrada.entityId, entryId: entry.id } : null,
      documentos,
    };
    if (opts.dryRun) throw new EnsayoTerminado(salida);
    return salida;
  };

  return ejecutar(correr, opts);
}

// ── Ensayo ──

/**
 * La vista previa corre EL MISMO camino y revierte al final. Lanzar es lo
 * que garantiza el ROLLBACK: si devolviera normalmente, la transacción se
 * confirmaría y el «ensayo» habría escrito.
 */
class EnsayoTerminado extends Error {
  constructor(public readonly resultado: ResultadoPago) {
    super('dry-run');
  }
}

async function ejecutar(
  correr: (client: pg.PoolClient) => Promise<ResultadoPago>,
  opts: OpcionesPago
): Promise<ResultadoPago> {
  if (opts.client) return correr(opts.client);
  try {
    return await withTransaction(correr);
  } catch (e) {
    if (e instanceof EnsayoTerminado) return e.resultado;
    throw e;
  }
}

/** Un gasto se paga cuando su pasivo ya está en el mayor. */
const PAGABLES = ['approved', 'posted', 'partially_paid'] as const;
/** Una factura se cobra cuando ya salió al cliente y su ingreso está contabilizado. */
const COBRABLES = ['sent', 'viewed', 'partially_paid', 'overdue'] as const;

/** assertMoneda ya garantizó que son todas la misma. */
function monedaDe(documentos: DocumentoAplicado[]): string {
  return documentos[0]?.moneda ?? 'MXN';
}

// ============================================================
// EL COBRO COMO HISTORIA (049 · F03)
//
// Registrar era el único evento; ahora hay cuatro: aplicar el saldo a
// cuenta (el anticipo encuentra su factura), desaplicar (la aplicación se
// clausura como evento nuevo, jamás se borra), y reversar (el cheque
// rebotó: TODO se deshace por espejo NIF B-1 y el cobro queda 'reversed' —
// ocurrió y se deshizo, que no es lo mismo que 'void').
//
// Las mismas fronteras que el registro: entidad DENTRO del SQL, FOR UPDATE
// antes de leer saldos, y el ensayo recorre el camino real y revierte.
// ============================================================

class EnsayoEvento extends Error {
  constructor(public readonly resultado: unknown) {
    super('dry-run');
  }
}

async function ejecutarEvento<T>(
  correr: (client: pg.PoolClient) => Promise<T>,
  opts: OpcionesPago
): Promise<T> {
  if (opts.client) return correr(opts.client);
  try {
    return await withTransaction(correr);
  } catch (e) {
    if (e instanceof EnsayoEvento) return e.resultado as T;
    throw e;
  }
}

interface PagoVivo {
  id: string;
  payment_number: string;
  customer_id: string;
  payment_amount: string;
  currency_code: string;
  payment_date: Date;
  bank_account_id: string | null;
  journal_entry_id: string | null;
  status: string;
  cfdi_uuid: string | null;
}

/** El cobro, acotado por entidad y con candado: la base de los tres eventos. */
async function cobroParaEscribir(
  client: pg.PoolClient,
  entityId: string,
  paymentId: string
): Promise<PagoVivo> {
  const r = await client.query<PagoVivo>(
    `SELECT id, payment_number, customer_id, payment_amount, currency_code,
            payment_date, bank_account_id, journal_entry_id, status, cfdi_uuid
       FROM customer_payments WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
    [paymentId, entityId]
  );
  if (r.rows.length === 0) throw new NotFoundError('Customer payment', paymentId);
  const pago = r.rows[0];
  if (pago.status !== ESTADO) {
    throw new ValidationError(
      `El cobro ${pago.payment_number} está en '${pago.status}': sólo un cobro 'completed' admite este evento.`
    );
  }
  return pago;
}

async function remanenteDe(client: pg.PoolClient, paymentId: string, paymentAmount: string): Promise<Decimal> {
  const r = await client.query<{ aplicado: string }>(
    `SELECT COALESCE(SUM(amount_applied), 0)::text AS aplicado
       FROM payment_allocations WHERE payment_id = $1 AND unapplied_at IS NULL`,
    [paymentId]
  );
  return new Decimal(paymentAmount).minus(r.rows[0]?.aplicado ?? '0');
}

export interface ResultadoAplicacion {
  paymentId: string;
  paymentNumber: string;
  journalEntry: JournalEntry | null;
  attestation: { entityId: string; entryId: string } | null;
  documentos: DocumentoAplicado[];
  remanenteAnterior: string;
  remanenteNuevo: string;
}

/** Aplicar saldo a cuenta de un cobro existente a una o varias facturas. */
export async function applyCustomerPayment(
  entityId: string,
  paymentId: string,
  aplicaciones: AplicacionPago[],
  userId: string,
  opts: OpcionesPago = {}
): Promise<ResultadoAplicacion> {
  if (aplicaciones.length === 0) {
    throw new ValidationError('Indica a qué factura(s) se aplica el saldo a cuenta.');
  }
  const vistos = new Set<string>();
  for (const a of aplicaciones) {
    if (vistos.has(a.documentId)) {
      throw new ValidationError(
        `El documento ${a.documentId} aparece dos veces en la misma aplicación: súmalas en una.`
      );
    }
    vistos.add(a.documentId);
  }

  const correr = async (client: pg.PoolClient): Promise<ResultadoAplicacion> => {
    const pago = await cobroParaEscribir(client, entityId, paymentId);
    const remanente = await remanenteDe(client, paymentId, pago.payment_amount);
    const total = aplicaciones.reduce((s, a) => s.plus(a.amountApplied), new Decimal(0));
    if (total.greaterThan(remanente)) {
      throw new ValidationError(
        `El cobro ${pago.payment_number} tiene ${remanente.toFixed(2)} sin aplicar y se intentan ` +
          `aplicar ${total.toFixed(2)}: el saldo a cuenta no alcanza.`
      );
    }

    const documentos: DocumentoAplicado[] = [];
    const posteriores: AplicacionPosterior[] = [];
    const filas: { allocId: string; invoiceId: string }[] = [];

    for (const app of aplicaciones) {
      const r = await client.query<{
        id: string; invoice_number: string; amount_due: string; status: string;
        currency_code: string; tax_amount: string; total_amount: string;
        cfdi_uuid: string | null; terms: string | null; memo: string | null;
      }>(
        `SELECT id, invoice_number, amount_due, status, currency_code,
                tax_amount, total_amount, cfdi_uuid, terms, memo
           FROM invoices WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [app.documentId, entityId]
      );
      if (r.rows.length === 0) throw new NotFoundError('Invoice', app.documentId);
      const inv = r.rows[0];
      if (!COBRABLES.includes(inv.status as (typeof COBRABLES)[number])) {
        throw new ValidationError(
          `${inv.invoice_number} está en "${inv.status}" y sólo se puede aplicar a una factura ` +
            `${COBRABLES.join(', ')}.`
        );
      }
      assertMoneda(inv.invoice_number, inv.currency_code, pago.currency_code);
      const aplicado = new Decimal(app.amountApplied);
      const saldo = new Decimal(inv.amount_due);
      if (aplicado.greaterThan(saldo)) {
        throw new ValidationError(
          `${inv.invoice_number} debe ${saldo.toFixed(2)} y se intentan aplicar ${aplicado.toFixed(2)}.`
        );
      }

      // Lo aplicado (vivo) a la factura ANTES de este evento: la base del
      // objetivo acumulado del IVA, para que las parciales no deriven.
      const prev = await client.query<{ aplicado: string }>(
        `SELECT COALESCE(SUM(amount_applied), 0)::text AS aplicado
           FROM payment_allocations WHERE invoice_id = $1 AND unapplied_at IS NULL`,
        [app.documentId]
      );

      const allocId = uuidv4();
      await client.query(
        `INSERT INTO payment_allocations (id, payment_id, invoice_id, amount_applied)
         VALUES ($1,$2,$3,$4)`,
        [allocId, paymentId, app.documentId, app.amountApplied]
      );
      await client.query(
        `UPDATE invoices SET
           amount_paid = amount_paid + $1,
           amount_due  = amount_due - $1,
           status = CASE WHEN amount_due - $1 <= 0 THEN 'paid' ELSE 'partially_paid' END,
           last_payment_date = $2
         WHERE id = $3 AND entity_id = $4`,
        [app.amountApplied, new Date(), app.documentId, entityId]
      );

      const nuevo = saldo.minus(aplicado);
      documentos.push({
        id: inv.id, numero: inv.invoice_number,
        saldoAnterior: saldo.toFixed(2), saldoNuevo: nuevo.toFixed(2),
        estado: nuevo.lessThanOrEqualTo(0) ? 'paid' : 'partially_paid',
        moneda: inv.currency_code,
      });
      posteriores.push({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number,
        amount: aplicado.toFixed(4),
        priorApplied: prev.rows[0]?.aplicado ?? '0',
        taxAmount: inv.tax_amount,
        totalAmount: inv.total_amount,
        cfdiUuid: inv.cfdi_uuid,
        terms: inv.terms,
        memo: inv.memo,
      });
      filas.push({ allocId, invoiceId: inv.id });
    }

    const { entry, ivaPorFactura } = await postReceiptApplicationEntry(
      client,
      {
        id: pago.id, entity_id: entityId, payment_number: pago.payment_number,
        payment_amount: pago.payment_amount, payment_date: pago.payment_date,
        bank_account_id: pago.bank_account_id, journal_entry_id: null,
      },
      posteriores,
      userId
    );
    for (const fila of filas) {
      const iva = ivaPorFactura.get(fila.invoiceId);
      if (iva) {
        await client.query(
          `UPDATE payment_allocations SET iva_reclass_amount = $1 WHERE id = $2`,
          [iva, fila.allocId]
        );
      }
    }

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      userId,
      action: 'update',
      entityType: 'customer_payments',
      entityId: paymentId,
      newValues: {
        evento: 'apply',
        aplicado: total.toFixed(2),
        documentos: documentos.length,
        journal_entry_id: entry.id,
      },
    });

    const salida: ResultadoAplicacion = {
      paymentId, paymentNumber: pago.payment_number, journalEntry: entry,
      attestation: { entityId, entryId: entry.id },
      documentos,
      remanenteAnterior: remanente.toFixed(2),
      remanenteNuevo: remanente.minus(total).toFixed(2),
    };
    if (opts.dryRun) throw new EnsayoEvento(salida);
    return salida;
  };

  return ejecutarEvento(correr, opts);
}

export interface ResultadoDesaplicacion {
  paymentId: string;
  paymentNumber: string;
  journalEntry: JournalEntry;
  attestation: { entityId: string; entryId: string };
  documento: DocumentoAplicado;
  desaplicado: string;
  ivaReAparcado: string;
  ivaEstimado: boolean;
}

/**
 * Desaplicar un cobro de una factura: la aplicación se CLAUSURA (nunca se
 * borra), la factura reabre y el crédito vuelve a estar a cuenta. El IVA que
 * la aplicación liberó se re-aparca por el importe exacto que guardó su fila.
 */
export async function unapplyCustomerPayment(
  entityId: string,
  paymentId: string,
  args: { invoiceId: string; reason: string },
  userId: string,
  opts: OpcionesPago = {}
): Promise<ResultadoDesaplicacion> {
  const correr = async (client: pg.PoolClient): Promise<ResultadoDesaplicacion> => {
    const pago = await cobroParaEscribir(client, entityId, paymentId);

    const inv = await client.query<{
      id: string; invoice_number: string; amount_due: string; amount_paid: string;
      currency_code: string; tax_amount: string; total_amount: string;
    }>(
      `SELECT id, invoice_number, amount_due, amount_paid, currency_code, tax_amount, total_amount
         FROM invoices WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
      [args.invoiceId, entityId]
    );
    if (inv.rows.length === 0) throw new NotFoundError('Invoice', args.invoiceId);
    const factura = inv.rows[0];

    const vivas = await client.query<{ id: string; amount_applied: string; iva_reclass_amount: string | null }>(
      `SELECT id, amount_applied::text, iva_reclass_amount::text
         FROM payment_allocations
        WHERE payment_id = $1 AND invoice_id = $2 AND unapplied_at IS NULL
        FOR UPDATE`,
      [paymentId, args.invoiceId]
    );
    if (vivas.rows.length === 0) {
      throw new ValidationError(
        `El cobro ${pago.payment_number} no tiene ninguna aplicación viva sobre ${factura.invoice_number}: ` +
          'no hay qué desaplicar.'
      );
    }

    const total = vivas.rows.reduce((s, r) => s.plus(r.amount_applied), new Decimal(0));
    const conIva = vivas.rows.filter((r) => r.iva_reclass_amount !== null);
    const sinIva = vivas.rows.filter((r) => r.iva_reclass_amount === null);
    const ivaExacto = conIva.reduce((s, r) => s.plus(r.iva_reclass_amount as string), new Decimal(0));
    // Filas pre-049 no guardaron su IVA: se estima pro-rata y el asiento lo dice.
    const montoSinIva = sinIva.reduce((s, r) => s.plus(r.amount_applied), new Decimal(0));
    const ivaEstimadoParte = montoSinIva.greaterThan(0)
      ? new Decimal(
          ivaToReclassify({
            ivaTotal: factura.tax_amount,
            documentTotal: factura.total_amount,
            priorApplied: '0',
            appliedNow: montoSinIva.toFixed(4),
          })
        )
      : new Decimal(0);
    const estimado = sinIva.length > 0 && ivaEstimadoParte.greaterThan(0);

    await client.query(
      `UPDATE payment_allocations
          SET unapplied_at = NOW(), unapplied_by = $1, unapply_reason = $2
        WHERE payment_id = $3 AND invoice_id = $4 AND unapplied_at IS NULL`,
      [userId, args.reason, paymentId, args.invoiceId]
    );
    await client.query(
      `UPDATE invoices SET
         amount_paid = amount_paid - $1,
         amount_due  = amount_due + $1,
         status = CASE WHEN amount_paid - $1 <= 0 THEN 'sent' ELSE 'partially_paid' END
       WHERE id = $2 AND entity_id = $3`,
      [total.toFixed(4), args.invoiceId, entityId]
    );

    const entry = await postReceiptUnapplicationEntry(
      client,
      {
        id: pago.id, entity_id: entityId, payment_number: pago.payment_number,
        payment_amount: pago.payment_amount, payment_date: pago.payment_date,
        bank_account_id: pago.bank_account_id, journal_entry_id: null,
      },
      {
        invoiceNumber: factura.invoice_number,
        amount: total.toFixed(4),
        ivaReclass: estimado ? null : ivaExacto.toFixed(4),
        ivaEstimado: ivaExacto.plus(ivaEstimadoParte).toFixed(4),
      },
      userId
    );

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      userId,
      action: 'update',
      entityType: 'customer_payments',
      entityId: paymentId,
      newValues: {
        evento: 'unapply',
        invoice: factura.invoice_number,
        desaplicado: total.toFixed(2),
        journal_entry_id: entry.id,
      },
      reason: args.reason,
    });

    const salida: ResultadoDesaplicacion = {
      paymentId, paymentNumber: pago.payment_number, journalEntry: entry,
      attestation: { entityId, entryId: entry.id },
      documento: {
        id: factura.id, numero: factura.invoice_number,
        saldoAnterior: new Decimal(factura.amount_due).toFixed(2),
        saldoNuevo: new Decimal(factura.amount_due).plus(total).toFixed(2),
        estado: new Decimal(factura.amount_paid).minus(total).lessThanOrEqualTo(0) ? 'sent' : 'partially_paid',
        moneda: factura.currency_code,
      },
      desaplicado: total.toFixed(2),
      ivaReAparcado: ivaExacto.plus(ivaEstimadoParte).toFixed(4),
      ivaEstimado: estimado,
    };
    if (opts.dryRun) throw new EnsayoEvento(salida);
    return salida;
  };

  return ejecutarEvento(correr, opts);
}

export interface ResultadoReversa {
  paymentId: string;
  paymentNumber: string;
  reversals: { entryNumber: string; of: string }[];
  attestations: { entityId: string; entryId: string }[];
  documentosReabiertos: DocumentoAplicado[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CobroDetalle {
  id: string;
  payment_number: string;
  customer_id: string;
  customer_name: string | null;
  payment_amount: string;
  currency_code: string;
  payment_date: Date;
  payment_method: string;
  reference_number: string | null;
  status: string;
  journal_entry_number: string | null;
  /** REP: el UUID del CFDI tipo P que documenta este cobro, si ya se ligó. */
  cfdi_uuid: string | null;
  cfdi_pago_indice: number | null;
  reversed_at: Date | null;
  unapplied_amount: string;
  aplicaciones: {
    invoice_number: string;
    amount_applied: string;
    iva_reclass_amount: string | null;
    viva: boolean;
    unapplied_at: Date | null;
    unapply_reason: string | null;
  }[];
}

/** El cobro por folio o id, con sus aplicaciones (vivas e historia) y su REP. */
export async function getCustomerPayment(entityId: string, ref: string): Promise<CobroDetalle> {
  const trimmed = ref.trim();
  if (!trimmed) throw new ValidationError('A receipt reference is required.');
  const porId = UUID_RE.test(trimmed);
  const base = await query<{
    id: string; payment_number: string; customer_id: string; customer_name: string | null;
    payment_amount: string; currency_code: string; payment_date: Date; payment_method: string;
    reference_number: string | null; status: string; journal_entry_number: string | null;
    cfdi_uuid: string | null; cfdi_pago_indice: number | null; reversed_at: Date | null;
  }>(
    `SELECT cp.id, cp.payment_number, cp.customer_id, COALESCE(cu.company_name, NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), '')) AS customer_name,
            cp.payment_amount::text, cp.currency_code, cp.payment_date, cp.payment_method,
            cp.reference_number, cp.status, je.entry_number AS journal_entry_number,
            cp.cfdi_uuid, cp.cfdi_pago_indice, cp.reversed_at
       FROM customer_payments cp
       LEFT JOIN customers cu ON cu.id = cp.customer_id
       LEFT JOIN journal_entries je ON je.id = cp.journal_entry_id
      WHERE cp.${porId ? 'id' : 'payment_number'} = $1 AND cp.entity_id = $2`,
    [trimmed, entityId]
  );
  if (base.rows.length === 0) throw new NotFoundError('Customer payment', trimmed);
  const pago = base.rows[0];

  const apps = await query<{
    invoice_number: string; amount_applied: string; iva_reclass_amount: string | null;
    unapplied_at: Date | null; unapply_reason: string | null;
  }>(
    `SELECT i.invoice_number, pa.amount_applied::text, pa.iva_reclass_amount::text,
            pa.unapplied_at, pa.unapply_reason
       FROM payment_allocations pa
       JOIN invoices i ON i.id = pa.invoice_id AND i.entity_id = $2
      WHERE pa.payment_id = $1
      ORDER BY pa.created_at`,
    [pago.id, entityId]
  );

  const vivas = apps.rows.filter((a) => a.unapplied_at === null);
  const aplicado = vivas.reduce((s: Decimal, a) => s.plus(a.amount_applied), new Decimal(0));

  return {
    id: pago.id,
    payment_number: pago.payment_number,
    customer_id: pago.customer_id,
    customer_name: pago.customer_name,
    payment_amount: new Decimal(pago.payment_amount).toFixed(2),
    currency_code: pago.currency_code,
    payment_date: pago.payment_date,
    payment_method: pago.payment_method,
    reference_number: pago.reference_number,
    status: pago.status,
    journal_entry_number: pago.journal_entry_number,
    cfdi_uuid: pago.cfdi_uuid,
    cfdi_pago_indice: pago.cfdi_pago_indice,
    reversed_at: pago.reversed_at,
    unapplied_amount:
      pago.status === ESTADO ? new Decimal(pago.payment_amount).minus(aplicado).toFixed(2) : '0.00',
    aplicaciones: apps.rows.map((a) => ({
      invoice_number: a.invoice_number,
      amount_applied: new Decimal(a.amount_applied).toFixed(2),
      iva_reclass_amount: a.iva_reclass_amount,
      viva: a.unapplied_at === null,
      unapplied_at: a.unapplied_at,
      unapply_reason: a.unapply_reason,
    })),
  };
}

export interface FiltroCobros {
  customerId?: string;
  since?: string;
  until?: string;
  /** Sólo cobros con saldo sin aplicar. */
  unapplied?: boolean;
  /** Sólo cobros completados sin REP ligado (obligación fiscal propia). */
  needsRep?: boolean;
  limit?: number;
  offset?: number;
}

export interface CobroResumen {
  id: string;
  payment_number: string;
  customer_name: string | null;
  payment_date: Date;
  payment_amount: string;
  applied_amount: string;
  unapplied_amount: string;
  currency_code: string;
  status: string;
  has_rep: boolean;
}

export async function listCustomerPayments(
  entityId: string,
  filtro: FiltroCobros = {}
): Promise<{ rows: CobroResumen[]; total: number }> {
  const params: unknown[] = [entityId];
  const where: string[] = ['cp.entity_id = $1'];
  if (filtro.customerId) {
    params.push(filtro.customerId);
    where.push(`cp.customer_id = $${params.length}`);
  }
  if (filtro.since) {
    params.push(filtro.since);
    where.push(`cp.payment_date >= $${params.length}`);
  }
  if (filtro.until) {
    params.push(filtro.until);
    where.push(`cp.payment_date <= $${params.length}`);
  }
  if (filtro.needsRep) {
    where.push(`cp.cfdi_uuid IS NULL AND cp.status = 'completed'`);
  }
  if (filtro.unapplied) {
    where.push(`cp.status = 'completed' AND cp.payment_amount > COALESCE(ap.aplicado, 0)`);
  }

  const sql = `
    SELECT cp.id, cp.payment_number, COALESCE(cu.company_name, NULLIF(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), '')) AS customer_name, cp.payment_date,
           cp.payment_amount::text, COALESCE(ap.aplicado, 0)::text AS applied_amount,
           cp.currency_code, cp.status, (cp.cfdi_uuid IS NOT NULL) AS has_rep,
           COUNT(*) OVER()::int AS total
      FROM customer_payments cp
      LEFT JOIN customers cu ON cu.id = cp.customer_id
      LEFT JOIN LATERAL (
        SELECT SUM(amount_applied) AS aplicado
          FROM payment_allocations pa
         WHERE pa.payment_id = cp.id AND pa.unapplied_at IS NULL
      ) ap ON true
     WHERE ${where.join(' AND ')}
     ORDER BY cp.payment_date DESC, cp.payment_number DESC
     LIMIT ${Math.max(1, Math.min(filtro.limit ?? 50, 500))} OFFSET ${Math.max(0, filtro.offset ?? 0)}`;

  const r = await query<{
    id: string; payment_number: string; customer_name: string | null; payment_date: Date;
    payment_amount: string; applied_amount: string; currency_code: string; status: string;
    has_rep: boolean; total: number;
  }>(sql, params);
  return {
    total: r.rows[0]?.total ?? 0,
    rows: r.rows.map((row) => ({
      id: row.id,
      payment_number: row.payment_number,
      customer_name: row.customer_name,
      payment_date: row.payment_date,
      payment_amount: new Decimal(row.payment_amount).toFixed(2),
      applied_amount: new Decimal(row.applied_amount).toFixed(2),
      unapplied_amount:
        row.status === ESTADO
          ? new Decimal(row.payment_amount).minus(row.applied_amount).toFixed(2)
          : '0.00',
      currency_code: row.currency_code,
      status: row.status,
      has_rep: row.has_rep,
    })),
  };
}

/**
 * Reversa de un cobro devuelto (NSF): cada asiento del cobro —el original y
 * los de aplicación/desaplicación posteriores— recibe su espejo NIF B-1, las
 * facturas reabren, las aplicaciones vivas se clausuran con el motivo, y el
 * cobro queda 'reversed': ocurrió y rebotó, que no es 'void'.
 */
export async function reverseCustomerPayment(
  entityId: string,
  paymentId: string,
  args: { reason: string; feeAmount?: string },
  userId: string,
  opts: OpcionesPago = {}
): Promise<ResultadoReversa> {
  if (args.feeAmount !== undefined && new Decimal(args.feeAmount).greaterThan(0)) {
    // El mismo trato que el descuento por pronto pago: reconocer la comisión
    // exige una cuenta con rol que la capa semántica aún no tiene, y sin
    // ella el cargo iría a una cuenta adivinada. Se rechaza en voz alta.
    throw new ValidationError(
      'La comisión por devolución todavía no se puede registrar: necesita una cuenta con rol de ' +
        'comisiones bancarias en la capa semántica. Reversa el cobro sin --fee y registra la ' +
        'comisión como asiento manual mientras tanto.'
    );
  }

  const correr = async (client: pg.PoolClient): Promise<ResultadoReversa> => {
    const pago = await cobroParaEscribir(client, entityId, paymentId);

    // Todos los asientos posteados del cobro: el original y los eventos.
    const asientos = await client.query<{ id: string; entry_number: string; source_type: string }>(
      `SELECT id, entry_number, source_type FROM journal_entries
        WHERE entity_id = $1 AND status = 'posted' AND reversed_by_entry_id IS NULL
          AND ((source_type = 'customer_payment' AND source_id = $2)
            OR (source_type IN ('receipt_application', 'receipt_unapplication') AND source_id = $2))
        ORDER BY created_at`,
      [entityId, paymentId]
    );

    const reversals: ResultadoReversa['reversals'] = [];
    const attestations: ResultadoReversa['attestations'] = [];
    for (const je of asientos.rows) {
      const { reversal } = await voidJournalEntryInTx(client, je.id, userId, `NSF: ${args.reason}`);
      if (reversal) {
        reversals.push({ entryNumber: reversal.entry_number, of: je.entry_number });
        attestations.push({ entityId, entryId: reversal.id });
      }
    }

    // Las facturas reabren por lo VIVO que este cobro les tenía aplicado.
    const vivas = await client.query<{ invoice_id: string; total: string }>(
      `SELECT invoice_id, SUM(amount_applied)::text AS total
         FROM payment_allocations
        WHERE payment_id = $1 AND unapplied_at IS NULL
        GROUP BY invoice_id`,
      [paymentId]
    );
    const documentosReabiertos: DocumentoAplicado[] = [];
    for (const fila of vivas.rows) {
      const inv = await client.query<{
        id: string; invoice_number: string; amount_due: string; amount_paid: string; currency_code: string;
      }>(
        `SELECT id, invoice_number, amount_due, amount_paid, currency_code
           FROM invoices WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [fila.invoice_id, entityId]
      );
      if (inv.rows.length === 0) continue;
      const factura = inv.rows[0];
      await client.query(
        `UPDATE invoices SET
           amount_paid = amount_paid - $1,
           amount_due  = amount_due + $1,
           status = CASE WHEN amount_paid - $1 <= 0 THEN 'sent' ELSE 'partially_paid' END
         WHERE id = $2 AND entity_id = $3`,
        [fila.total, fila.invoice_id, entityId]
      );
      documentosReabiertos.push({
        id: factura.id, numero: factura.invoice_number,
        saldoAnterior: new Decimal(factura.amount_due).toFixed(2),
        saldoNuevo: new Decimal(factura.amount_due).plus(fila.total).toFixed(2),
        estado: new Decimal(factura.amount_paid).minus(fila.total).lessThanOrEqualTo(0) ? 'sent' : 'partially_paid',
        moneda: factura.currency_code,
      });
    }
    await client.query(
      `UPDATE payment_allocations
          SET unapplied_at = NOW(), unapplied_by = $1, unapply_reason = $2
        WHERE payment_id = $3 AND unapplied_at IS NULL`,
      [userId, `NSF: ${args.reason}`, paymentId]
    );

    await client.query(
      `UPDATE customer_payments SET status = 'reversed', reversed_at = NOW() WHERE id = $1`,
      [paymentId]
    );

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      userId,
      action: 'update',
      entityType: 'customer_payments',
      entityId: paymentId,
      oldValues: { status: ESTADO },
      newValues: {
        evento: 'reverse',
        status: 'reversed',
        asientos_reversados: reversals.length,
        facturas_reabiertas: documentosReabiertos.length,
      },
      reason: args.reason,
    });

    const salida: ResultadoReversa = {
      paymentId, paymentNumber: pago.payment_number, reversals, attestations, documentosReabiertos,
    };
    if (opts.dryRun) throw new EnsayoEvento(salida);
    return salida;
  };

  return ejecutarEvento(correr, opts);
}

// ============================================================
// APLICAR UN PAGO YA HECHO (050 · F04)
//
// El espejo de `applyCustomerPayment`, y la fila del catálogo que decía
// «Aplica un pago existente a facturas concretas, con parcial, residual o
// pago corto documentado». Hasta hoy el único momento en que un pago podía
// tocar un gasto era el de registrarlo: si el dinero salía antes de saber a
// qué gasto iba —una transferencia global a un proveedor con seis facturas
// abiertas, lo normal en una tesorería real— no había forma de repartirlo
// después. El remanente vivía como anticipo a proveedores y ahí se quedaba.
//
// LO QUE SE MUEVE Y LO QUE NO. El efectivo NO se toca: ya salió del banco
// cuando se registró el pago, y volver a acreditar el banco lo contaría dos
// veces. Lo que se mueve es el DERECHO: del anticipo (1150) a la cuenta de
// control de proveedores (2110), más el IVA acreditable que cada gasto PPD
// libera por la parte que este evento paga.
// ============================================================

interface PagoProveedorVivo {
  id: string;
  payment_number: string;
  vendor_id: string;
  payment_amount: string;
  currency_code: string;
  payment_date: Date;
  bank_account_id: string | null;
  journal_entry_id: string | null;
  status: string;
}

/** El pago, acotado por entidad y con candado. */
async function pagoProveedorParaEscribir(
  client: pg.PoolClient,
  entityId: string,
  paymentId: string
): Promise<PagoProveedorVivo> {
  const r = await client.query<PagoProveedorVivo>(
    `SELECT id, payment_number, vendor_id, payment_amount, currency_code,
            payment_date, bank_account_id, journal_entry_id, status
       FROM vendor_payments WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
    [paymentId, entityId]
  );
  if (r.rows.length === 0) throw new NotFoundError('Vendor payment', paymentId);
  const pago = r.rows[0];
  if (pago.status !== ESTADO) {
    throw new ValidationError(
      `El pago ${pago.payment_number} está en '${pago.status}': sólo un pago 'completed' admite este evento.`
    );
  }
  return pago;
}

/**
 * Lo que queda del pago sin repartir.
 *
 * NO filtra por `unapplied_at IS NULL` porque esa columna no existe todavía:
 * `payment unapply` es de la fase 2 y la 050 explica por qué no adelantó la
 * columna. El día que exista, este filtro y el de postVendorPaymentEntry
 * tienen que añadirse JUNTOS — si sólo uno de los dos cuenta las aplicaciones
 * clausuradas, el remanente y el asiento dejarán de hablar del mismo pago.
 */
async function remanenteDeVendorPago(
  client: pg.PoolClient,
  paymentId: string,
  paymentAmount: string
): Promise<Decimal> {
  const r = await client.query<{ aplicado: string }>(
    `SELECT COALESCE(SUM(amount_applied), 0)::text AS aplicado
       FROM payment_applications WHERE payment_id = $1`,
    [paymentId]
  );
  return new Decimal(paymentAmount).minus(r.rows[0]?.aplicado ?? '0');
}

export interface OpcionesAplicacionProveedor extends OpcionesPago {
  /**
   * `partial` (omisión): se aplica de menos y el gasto SIGUE ABIERTO por la
   * diferencia. `residual`: el gasto se cierra aunque se pague de menos, y lo
   * que queda deja de deberse — un pago corto.
   */
  modo?: 'partial' | 'residual';
  /** Obligatorio con `residual`: por qué se renuncia a cobrar el resto. */
  shortPayReason?: string;
}

export interface ResultadoAplicacionProveedor extends ResultadoAplicacion {
  /** Saldo que dejó de deberse por pago corto, y a qué cuenta fue. */
  condonado: string;
  cuentaCondonacion: 'devolucion_compras' | 'otros_ingresos' | null;
  /** IVA que salió de 1135 sin llegar a acreditarse. Cero salvo PPD condonado. */
  ivaNoAcreditable: string;
  politicaDefinida: boolean;
  /**
   * Gastos en los que se tomó un descuento que sus CONDICIONES no otorgaban
   * —sin términos de pronto pago, o fuera de la ventana—. No es un error: un
   * proveedor concede deducciones fuera de contrato todos los días. Pero es
   * otra cosa que un `2/10 net 30` ejercido en plazo, y quien firma los libros
   * merece saber cuál de las dos está viendo.
   */
  descuentosFueraDeTerminos: string[];
}

/** Aplicar el saldo a cuenta de un pago existente a uno o varios gastos. */
export async function applyVendorPayment(
  entityId: string,
  paymentId: string,
  aplicaciones: AplicacionPago[],
  userId: string,
  opts: OpcionesAplicacionProveedor = {}
): Promise<ResultadoAplicacionProveedor> {
  if (aplicaciones.length === 0) {
    throw new ValidationError('Indica a qué gasto(s) se aplica el saldo a cuenta.');
  }
  const vistos = new Set<string>();
  for (const a of aplicaciones) {
    if (vistos.has(a.documentId)) {
      throw new ValidationError(
        `El documento ${a.documentId} aparece dos veces en la misma aplicación: súmalas en una.`
      );
    }
    vistos.add(a.documentId);
  }

  const residual = opts.modo === 'residual';
  if (residual && !opts.shortPayReason?.trim()) {
    throw new ValidationError(
      'Cerrar un gasto pagando de menos borra un pasivo que sí se debía: di por qué ' +
        'con --short-pay-reason. Sin motivo escrito, el auditor sólo ve un saldo que ' +
        'desapareció.'
    );
  }

  const correr = async (client: pg.PoolClient): Promise<ResultadoAplicacionProveedor> => {
    const pago = await pagoProveedorParaEscribir(client, entityId, paymentId);
    const remanente = await remanenteDeVendorPago(client, paymentId, pago.payment_amount);

    // LA CUENTA DEL PAGO CORTO NO LA ELIGE ESTE CÓDIGO. A dónde va el saldo
    // que deja de deberse es criterio del despacho —menos costo, u otro
    // ingreso— y hasta puede estar prohibido. Se lee del panel; mientras
    // nadie lo defina, rige el defecto declarado y se dice que es el defecto.
    const tenantId = await tenantDe(client, entityId);
    const politica = residual
      ? await getPolicy({ tenantId, entityId }, 'pago_corto_residual')
      : null;
    if (politica?.value === 'prohibir') {
      throw new ValidationError(
        'La política `pago_corto_residual` de este despacho está en "prohibir": ningún gasto ' +
          'se cierra pagando de menos. Pide al proveedor la nota de crédito y aplícala, o ' +
          'cambia la política con `mnemosine pending resolve pago_corto_residual`.'
      );
    }
    const cuentaCondonacion =
      politica === null
        ? null
        : politica.value === 'otros_ingresos'
          ? ('otros_ingresos' as const)
          : ('devolucion_compras' as const);
    // Sólo el EFECTIVO consume remanente. El descuento extingue pasivo sin
    // salir del banco, así que un pago de 980 puede saldar un gasto de 1000
    // con 20 de descuento: lo que no puede es repartir 1000 de efectivo.
    const total = aplicaciones.reduce((s, a) => s.plus(a.amountApplied), new Decimal(0));
    if (total.greaterThan(remanente)) {
      throw new ValidationError(
        `El pago ${pago.payment_number} tiene ${remanente.toFixed(2)} sin aplicar y se intentan ` +
          `aplicar ${total.toFixed(2)}: el saldo a cuenta no alcanza.`
      );
    }

    const documentos: DocumentoAplicado[] = [];
    const posteriores: AplicacionPosterior[] = [];
    const filas: { allocId: string; billId: string }[] = [];
    let condonadoTotal = new Decimal(0);
    const fueraDeTerminos: string[] = [];

    for (const app of aplicaciones) {
      const r = await client.query<{
        id: string; bill_number: string; amount_due: string; status: string;
        currency_code: string; tax_amount: string; total_amount: string;
        cfdi_uuid: string | null; terms: string | null; memo: string | null;
        bill_date: Date;
      }>(
        `SELECT id, bill_number, amount_due, status, currency_code,
                tax_amount, total_amount, cfdi_uuid, terms, memo, bill_date
           FROM bills WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [app.documentId, entityId]
      );
      if (r.rows.length === 0) throw new NotFoundError('Bill', app.documentId);
      const bill = r.rows[0];
      if (!PAGABLES.includes(bill.status as (typeof PAGABLES)[number])) {
        throw new ValidationError(
          `${bill.bill_number} está en "${bill.status}" y sólo se puede aplicar a un gasto ` +
            `${PAGABLES.join(', ')}.`
        );
      }
      assertMoneda(bill.bill_number, bill.currency_code, pago.currency_code);

      const aplicado = new Decimal(app.amountApplied);
      const descuento = new Decimal(app.discountAmount ?? '0');
      const extingue = aplicado.plus(descuento);
      const saldo = new Decimal(bill.amount_due);
      if (extingue.greaterThan(saldo)) {
        throw new ValidationError(
          `${bill.bill_number} debe ${saldo.toFixed(2)} y se intentan extinguir ${extingue.toFixed(2)} ` +
            `(${aplicado.toFixed(2)} de efectivo + ${descuento.toFixed(2)} de descuento).`
        );
      }
      // ── EL DESCUENTO, CONTRA LO QUE LAS CONDICIONES OTORGAN ──────────
      //
      // `earlyPaymentDiscount` sabe leer un `2/10 net 30` y decir cuánto da
      // derecho a descontar quien paga en tal fecha. Llevaba desde que se
      // retiró el programador de pagos sin un solo llamador —la deuda que el
      // plan mandaba «cablear o retirar»— mientras el descuento se aceptaba
      // a ojo. Aquí es donde vuelve a servir: tomar MÁS de lo que las
      // condiciones conceden no es un descuento, es pagar de menos, y para
      // eso está `--mode residual`, que exige motivo escrito.
      if (descuento.greaterThan(0)) {
        const derecho = earlyPaymentDiscount(
          { amount_due: bill.amount_due, bill_date: bill.bill_date, terms: bill.terms },
          new Date(pago.payment_date).toISOString().slice(0, 10)
        );
        if (derecho.applied && descuento.greaterThan(derecho.discountAmount)) {
          throw new ValidationError(
            `${bill.bill_number} concede ${new Decimal(derecho.discountAmount).toFixed(2)} de ` +
              `descuento por pronto pago ("${bill.terms}") y se están tomando ` +
              `${descuento.toFixed(2)}. La diferencia no es descuento: es pagar de menos. ` +
              'Si es deliberado, dilo con --mode residual --short-pay-reason.'
          );
        }
        // Sin condiciones de pronto pago, o fuera de la ventana, el descuento
        // es una deducción NEGOCIADA. Se admite y se reporta como tal.
        if (!derecho.applied) fueraDeTerminos.push(bill.bill_number);
      }

      // Lo que sobra tras el efectivo y el descuento. En modo `residual` deja
      // de deberse aquí mismo; en `partial` sigue vivo y el gasto queda abierto.
      const condonado = residual ? saldo.minus(extingue) : new Decimal(0);
      const baja = extingue.plus(condonado);
      condonadoTotal = condonadoTotal.plus(condonado);

      // Lo aplicado al gasto ANTES de este evento: la base del objetivo
      // acumulado del IVA, para que las parciales no deriven.
      const prev = await client.query<{ aplicado: string }>(
        `SELECT COALESCE(SUM(amount_applied), 0)::text AS aplicado
           FROM payment_applications WHERE bill_id = $1`,
        [app.documentId]
      );

      const allocId = uuidv4();
      await client.query(
        `INSERT INTO payment_applications (id, payment_id, bill_id, amount_applied, discount_amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [allocId, paymentId, app.documentId, app.amountApplied, descuento.toFixed(4)]
      );
      // amount_paid recibe SÓLO el efectivo; el saldo baja por los tres —
      // efectivo, descuento y condonación. Un descuento no es dinero cobrado
      // y una condonación menos aún: contarlos como pagados inflaría lo que
      // el proveedor recibió y descuadraría la conciliación de banco.
      await client.query(
        `UPDATE bills SET
           amount_paid = amount_paid + $1,
           amount_due  = amount_due - $2,
           status = CASE WHEN amount_due - $2 <= 0 THEN 'paid' ELSE 'partially_paid' END,
           last_payment_date = $3
         WHERE id = $4 AND entity_id = $5`,
        [app.amountApplied, baja.toFixed(4), new Date(), app.documentId, entityId]
      );

      const nuevo = saldo.minus(baja);
      documentos.push({
        id: bill.id, numero: bill.bill_number,
        saldoAnterior: saldo.toFixed(2), saldoNuevo: nuevo.toFixed(2),
        estado: nuevo.lessThanOrEqualTo(0) ? 'paid' : 'partially_paid',
        moneda: bill.currency_code,
      });
      posteriores.push({
        invoiceId: bill.id,
        invoiceNumber: bill.bill_number,
        amount: aplicado.toFixed(4),
        discount: descuento.toFixed(4),
        writeOff: condonado.toFixed(4),
        priorApplied: prev.rows[0]?.aplicado ?? '0',
        taxAmount: bill.tax_amount,
        totalAmount: bill.total_amount,
        cfdiUuid: bill.cfdi_uuid,
        terms: bill.terms,
        memo: bill.memo,
      });
      filas.push({ allocId, billId: bill.id });
    }

    const { entry, ivaPorGasto, ivaNoAcreditablePorGasto } = await postVendorApplicationEntry(
      client,
      {
        id: pago.id, entity_id: entityId, payment_number: pago.payment_number,
        payment_amount: pago.payment_amount, payment_date: pago.payment_date,
        bank_account_id: pago.bank_account_id, journal_entry_id: null,
      },
      posteriores,
      userId,
      cuentaCondonacion ?? undefined
    );
    for (const fila of filas) {
      const iva = ivaPorGasto.get(fila.billId);
      if (iva) {
        await client.query(
          `UPDATE payment_applications SET iva_reclass_amount = $1 WHERE id = $2`,
          [iva, fila.allocId]
        );
      }
    }

    await registrarAuditoria(client, {
      tenantId: await tenantDe(client, entityId),
      userId,
      action: 'update',
      entityType: 'vendor_payments',
      entityId: paymentId,
      newValues: {
        evento: 'apply',
        aplicado: total.toFixed(2),
        documentos: documentos.length,
        journal_entry_id: entry.id,
        // El pago corto se anota en la bitácora CON SU MOTIVO: es la única
        // huella de por qué un pasivo dejó de existir sin haberse pagado.
        ...(condonadoTotal.greaterThan(0)
          ? {
              condonado: condonadoTotal.toFixed(2),
              cuenta_condonacion: cuentaCondonacion,
              short_pay_reason: opts.shortPayReason,
              politica_definida: politica?.defined ?? false,
            }
          : {}),
      },
    });

    const salida: ResultadoAplicacionProveedor = {
      paymentId, paymentNumber: pago.payment_number, journalEntry: entry,
      attestation: { entityId, entryId: entry.id },
      documentos,
      remanenteAnterior: remanente.toFixed(2),
      remanenteNuevo: remanente.minus(total).toFixed(2),
      condonado: condonadoTotal.toFixed(2),
      cuentaCondonacion: condonadoTotal.greaterThan(0) ? cuentaCondonacion : null,
      ivaNoAcreditable: [...ivaNoAcreditablePorGasto.values()]
        .reduce((s2, v) => s2.plus(v), new Decimal(0))
        .toFixed(2),
      politicaDefinida: politica?.defined ?? false,
      descuentosFueraDeTerminos: fueraDeTerminos,
    };
    if (opts.dryRun) throw new EnsayoEvento(salida);
    return salida;
  };

  return ejecutarEvento(correr, opts);
}
