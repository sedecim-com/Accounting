import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { nextEntityNumber } from '../../utils/sequence.js';
import { postVendorPaymentEntry, postCustomerPaymentEntry } from '../accounting/ar-ap-posting.js';
import { NotFoundError, ValidationError, AccountingError } from '../../utils/errors.js';
import type { JournalEntry } from '../../types/index.js';
import { registrarAuditoria, tenantDe } from '../audit/audit-log.js';

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

function assertAplicaciones(entrada: EntradaPago): void {
  if (entrada.applications.length === 0) {
    throw new ValidationError(
      'Un pago sin aplicar a ningún documento no libera saldo ni acredita IVA: indica a qué se aplica.'
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

  // El descuento por pronto pago se insertaba en payment_applications y no
  // participaba en nada más: ni reducía el saldo ni entraba en el asiento. El
  // proveedor quedaba debiendo el descuento para siempre. Reconocerlo bien
  // exige una cuenta de ingreso por descuentos que la capa de roles todavía
  // no tiene, así que se rechaza en voz alta en vez de aceptarse y perderse.
  const conDescuento = entrada.applications.find(
    (a) => a.discountAmount !== undefined && new Decimal(a.discountAmount).greaterThan(0)
  );
  if (conDescuento) {
    throw new ValidationError(
      'El descuento por pronto pago todavía no se puede registrar: necesita una cuenta de ' +
        'ingreso por descuentos en la capa de roles, y sin ella el asiento no cuadraría. ' +
        'Registra el pago por el importe neto mientras tanto.'
    );
  }

  const total = entrada.applications.reduce(
    (s, a) => s.plus(a.amountApplied),
    new Decimal(0)
  );
  // Exacto, no «no más de». Aplicar de menos dejaba el asiento cargando el
  // importe COMPLETO del pago contra la cuenta de control mientras el
  // auxiliar sólo bajaba la parte aplicada: el resto quedaba en el aire. Un
  // pago a cuenta es otro concepto y todavía no existe.
  if (!total.equals(entrada.paymentAmount)) {
    throw new ValidationError(
      `Las aplicaciones suman ${total.toFixed(2)} y el pago es de ` +
        `${new Decimal(entrada.paymentAmount).toFixed(2)}. Tienen que coincidir: ` +
        (total.greaterThan(entrada.paymentAmount)
          ? 'no se puede aplicar más de lo que se pagó.'
          : 'lo que sobra quedaría cargado a la cuenta de control sin bajar de ningún auxiliar.')
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
  assertAplicaciones(entrada);

  const correr = async (client: pg.PoolClient): Promise<ResultadoPago> => {
    const documentos: DocumentoAplicado[] = [];

    // Las facturas se leen ACOTADAS POR ENTIDAD y con FOR UPDATE: sin el
    // filtro, conocer el UUID bastaría para pagar el gasto de otra entidad;
    // sin el candado, dos pagos simultáneos leerían el mismo saldo.
    for (const app of entrada.applications) {
      const r = await client.query<{
        id: string; bill_number: string; amount_due: string; vendor_id: string;
        status: string; currency_code: string;
      }>(
        `SELECT id, bill_number, amount_due, vendor_id, status, currency_code
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
      const saldo = new Decimal(bill.amount_due);
      if (aplicado.greaterThan(saldo)) {
        throw new ValidationError(
          `${bill.bill_number} debe ${saldo.toFixed(2)} y se intentan aplicar ${aplicado.toFixed(2)}.`
        );
      }
      const nuevo = saldo.minus(aplicado);
      const estado = nuevo.lessThanOrEqualTo(0) ? 'paid' : 'partially_paid';
      documentos.push({
        id: bill.id, numero: bill.bill_number,
        saldoAnterior: saldo.toFixed(2), saldoNuevo: nuevo.toFixed(2), estado,
        moneda: bill.currency_code,
      });
    }

    const vendorId = entrada.counterpartyId
      ?? (await client.query<{ vendor_id: string }>(
        `SELECT vendor_id FROM bills WHERE id = $1`, [entrada.applications[0].documentId]
      )).rows[0]?.vendor_id;
    if (!vendorId) throw new ValidationError('No se pudo determinar el proveedor del pago.');

    const paymentNumber = await nextEntityNumber(client, entrada.entityId, 'vendor_payment', 'VPMT');
    const paymentId = uuidv4();

    await client.query(
      // reference_number y currency_code faltaban del INSERT. Lo primero
      // perdía el NumOperacion del REP —la referencia bancaria que permite
      // conciliar—; lo segundo es peor: la columna tiene DEFAULT 'USD', así
      // que todo pago a proveedor en pesos quedaba registrado como dólares.
      // El lado AR siempre los escribió; éste no, y nadie lo leía.
      `INSERT INTO vendor_payments (
         id, entity_id, payment_number, vendor_id, payment_amount, currency_code,
         payment_method, reference_number, bank_account_id, payment_date, status, memo, created_by,
         cfdi_uuid, cfdi_pago_indice
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [paymentId, entrada.entityId, paymentNumber, vendorId, entrada.paymentAmount,
       monedaDe(documentos), entrada.paymentMethod, entrada.referenceNumber ?? null,
       entrada.bankAccountId ?? null, entrada.paymentDate,
       ESTADO, entrada.memo ?? null, userId,
       entrada.cfdiUuid ?? null, entrada.cfdiPagoIndice ?? null]
    );

    for (const app of entrada.applications) {
      await client.query(
        `INSERT INTO payment_applications (id, payment_id, bill_id, amount_applied, discount_amount)
         VALUES ($1,$2,$3,$4,$5)`,
        [uuidv4(), paymentId, app.documentId, app.amountApplied, app.discountAmount ?? 0]
      );
      await client.query(
        `UPDATE bills SET
           amount_paid = amount_paid + $1,
           amount_due  = amount_due - $1,
           status = CASE WHEN amount_due - $1 <= 0 THEN 'paid' ELSE 'partially_paid' END,
           last_payment_date = $2
         WHERE id = $3 AND entity_id = $4`,
        [app.amountApplied, entrada.paymentDate, app.documentId, entrada.entityId]
      );
    }

    // Aquí es donde se libera el IVA aparcado de los CFDI a crédito.
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
      userId
    );

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
      },
    });

    if (opts.dryRun) {
      throw new EnsayoTerminado({
        paymentId, paymentNumber, journalEntry: entry,
        attestation: entry ? { entityId: entrada.entityId, entryId: entry.id } : null,
        documentos,
      });
    }

    return {
      paymentId, paymentNumber, journalEntry: entry,
      attestation: entry ? { entityId: entrada.entityId, entryId: entry.id } : null,
      documentos,
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
  assertAplicaciones(entrada);

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

    const paymentNumber = await nextEntityNumber(client, entrada.entityId, 'customer_payment', 'PMT');
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
       monedaDe(documentos), entrada.paymentMethod, entrada.referenceNumber ?? null,
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
