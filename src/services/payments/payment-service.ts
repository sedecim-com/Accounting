import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import type pg from 'pg';
import { withTransaction } from '../../database/connection.js';
import { nextEntityNumber } from '../../utils/sequence.js';
import { postVendorPaymentEntry, postCustomerPaymentEntry } from '../accounting/ar-ap-posting.js';
import { NotFoundError, ValidationError, AccountingError } from '../../utils/errors.js';
import type { JournalEntry } from '../../types/index.js';

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
}

export interface ResultadoPago {
  paymentId: string;
  paymentNumber: string;
  journalEntry: JournalEntry | null;
  /** Para disparar la atestación DESPUÉS del commit. */
  attestation: { entityId: string; entryId: string } | null;
  documentos: Array<{ id: string; numero: string; saldoAnterior: string; saldoNuevo: string; estado: string }>;
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
  const total = entrada.applications.reduce(
    (s, a) => s.plus(a.amountApplied),
    new Decimal(0)
  );
  if (total.greaterThan(entrada.paymentAmount)) {
    throw new ValidationError(
      `Las aplicaciones suman ${total.toFixed(2)} y el pago es de ` +
        `${new Decimal(entrada.paymentAmount).toFixed(2)}: no se puede aplicar más de lo que se pagó.`
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
    const documentos: ResultadoPago['documentos'] = [];

    // Las facturas se leen ACOTADAS POR ENTIDAD y con FOR UPDATE: sin el
    // filtro, conocer el UUID bastaría para pagar el gasto de otra entidad;
    // sin el candado, dos pagos simultáneos leerían el mismo saldo.
    for (const app of entrada.applications) {
      const r = await client.query<{
        id: string; bill_number: string; amount_due: string; vendor_id: string; status: string;
      }>(
        `SELECT id, bill_number, amount_due, vendor_id, status
           FROM bills WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [app.documentId, entrada.entityId]
      );
      if (r.rows.length === 0) {
        throw new NotFoundError('Bill', app.documentId);
      }
      const bill = r.rows[0];
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
      `INSERT INTO vendor_payments (
         id, entity_id, payment_number, vendor_id, payment_amount,
         payment_method, bank_account_id, payment_date, status, memo, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [paymentId, entrada.entityId, paymentNumber, vendorId, entrada.paymentAmount,
       entrada.paymentMethod, entrada.bankAccountId ?? null, entrada.paymentDate,
       ESTADO, entrada.memo ?? null, userId]
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
    const documentos: ResultadoPago['documentos'] = [];

    for (const app of entrada.applications) {
      const r = await client.query<{
        id: string; invoice_number: string; amount_due: string; amount_paid: string;
        customer_id: string; currency_code: string;
      }>(
        `SELECT id, invoice_number, amount_due, amount_paid, customer_id, currency_code
           FROM invoices WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
        [app.documentId, entrada.entityId]
      );
      if (r.rows.length === 0) throw new NotFoundError('Invoice', app.documentId);

      const inv = r.rows[0];
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
      `INSERT INTO customer_payments (
         id, entity_id, payment_number, customer_id, payment_amount,
         payment_method, reference_number, bank_account_id, payment_date,
         status, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [paymentId, entrada.entityId, paymentNumber, customerId, entrada.paymentAmount,
       entrada.paymentMethod, entrada.referenceNumber ?? null, entrada.bankAccountId ?? null,
       entrada.paymentDate, ESTADO, userId]
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
