import { Router, Response } from 'express';
import { z } from 'zod';
import { boundedString, emailString, uuidString } from '../../../utils/zod-compat.js';
import { schemaMessage } from '../../../utils/zod-client-errors.js';
import { query, withTransaction } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody, type RouteRequest as Request } from '../middleware/async-handler.js';
import { AppError, ConflictError, NotFoundError, ValidationError, NotImplementedError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { attestEntryAsync } from '../../../services/accounting/index.js';
import { recordCustomerPayment } from '../../../services/payments/payment-service.js';
import {
  listInvoices,
  getInvoiceById,
  createInvoice,
  issueInvoice,
  voidInvoice,
} from '../../../services/ar/invoice-service.js';
import { buildInvoiceCfdiXml } from '../../../services/sat/cfdi40/income-cfdi-service.js';
import { estadoParaPersistir } from '../../../services/integrations/mexico/pac/simulacion.js';
import { cfdiIsFreeToStamp, FREE_TO_STAMP } from '../../../services/integrations/mexico/pac/stamp-once.js';
import type { Invoice } from '../../../types/index.js';
import { declararRiesgoRuta } from '../risk.js';
import { arregloAcotado, MAX_RENGLONES_POR_DOCUMENTO } from '../topes.js';

// ============================================================
// /v1/invoices — HTTP surface over the AR invoice service.
// Listing, reading, creating, issuing and voiding live in
// services/ar/invoice-service.ts so the CLI and the agent reach the
// same behaviour. What stays here is request parsing, permissions,
// response shape — plus the payment and CFDI endpoints, which belong
// to the cash-application and fiscal families and are untouched.
// ============================================================

const router = Router();

// ─── Schemas ───
const numericLike = z.union([z.string(), z.number()]);
const invoiceLineSchema = z.object({
  item_id: uuidString().nullable().optional(),
  description: z.string().optional(),
  quantity: numericLike.optional(),
  unit_price: numericLike,
  revenue_account_id: uuidString(),
  tax_code: z.string().nullable().optional(),
  tax_rate: numericLike.nullable().optional(),
  cost_center_id: uuidString().nullable().optional(),
  project_id: uuidString().nullable().optional(),
  cfdi_product_code: z.string().nullable().optional(),
  cfdi_unit_code: z.string().nullable().optional(),
}).passthrough();

const createInvoiceSchema = z.object({
  entity_id: uuidString(),
  customer_id: uuidString(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  currency_code: boundedString({ length: 3 }).optional(),
  // Un renglón = un INSERT dentro de la transacción que crea la factura.
  // El porqué del número, en topes.ts.
  lines: arregloAcotado(invoiceLineSchema, {
    tope: MAX_RENGLONES_POR_DOCUMENTO,
    plural: 'renglones',
    salida: 'Parte la factura: un comprobante con más renglones que eso no lo timbra ningún PAC.',
    minimo: 1,
    mensajeMinimo: schemaMessage('error.VALIDATION_ERROR.schema.invoice_min_lines'),
  }),
  terms: z.string().optional(),
  memo: z.string().optional(),
  po_number: z.string().optional(),
});

// `to` is the whole of this endpoint's interest in email: it is stored on
// invoices.sent_to as the declared recipient. Nothing is transmitted -- see the
// note on POST /:id/send -- so cc, subject and message are deliberately absent.
// They used to be validated and then dropped on the floor, which is a promise
// of delivery the route has never been able to keep. z.object() strips unknown
// keys rather than rejecting them, so a client still sending them gets a 200,
// not a 422.
// cc / subject / message se retiraron: se validaban y se tiraban. No hay
// transporte de correo en el árbol (sendgrid-adapter.ts fabrica un messageId
// sin abrir conexión), así que cablearlos habría reportado una entrega que no
// ocurre. z.object() descarta claves desconocidas: un cliente que siga
// mandándolos recibe 200, no 422.
const sendInvoiceSchema = z.object({
  to: emailString().optional(),
});

const recordPaymentSchema = z.object({
  amount: numericLike,
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/),
  payment_method: z.string().optional(),
  bank_account_id: uuidString().optional(),
  reference: z.string().optional(),
  notes: z.string().optional(),
}).passthrough();

// Required, not optional: a void with no stated reason is the audit-trail gap.
// Enforcing it is an observable API change -- a body-less POST that used to
// succeed now gets 422 VALIDATION_ERROR from validateBody.
const voidInvoiceSchema = z.object({
  reason: boundedString({ min: 1 }, { min: schemaMessage('error.VALIDATION_ERROR.schema.void_reason_required') }),
});

const meta = (req: Request) => ({
  request_id: req.headers['x-request-id'],
  timestamp: new Date().toISOString(),
  version: 'v1',
});

// GET /v1/invoices
router.get('/', requirePermission('invoices:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const {
    entity_id, customer_id, status,
    start_date, end_date, search,
    page = '1', per_page = '50',
  } = req.query;

  const entityId = (entity_id as string) || req.entityId!;
  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, Math.max(1, parseInt(per_page as string, 10)));

  const { rows, total } = await listInvoices(entityId, {
    customerId: customer_id as string | undefined,
    statuses: status ? [status as string] : undefined,
    since: start_date as string | undefined,
    until: end_date as string | undefined,
    search: search as string | undefined,
    limit: perPage,
    offset: (pageNum - 1) * perPage,
  });

  res.json({
    data: rows,
    pagination: {
      page: pageNum, per_page: perPage,
      total_pages: Math.ceil(total / perPage),
      total_count: total, next_cursor: null, prev_cursor: null,
    },
    meta: meta(req),
  });
}));

// GET /v1/invoices/:id
router.get('/:id', requirePermission('invoices:read'), asyncHandler(async (req: Request, res: Response) => {
  const invoice = await getInvoiceById(req.params.id, { includeLines: true });
  if (!invoice) throw new NotFoundError('Invoice', req.params.id);
  res.json({ data: invoice, meta: meta(req) });
}));

// POST /v1/invoices
router.post('/', declararRiesgoRuta({ riesgo: 'escritura', escribe: 'invoices + invoice_lines (borrador)' }), requirePermission('invoices:create'), requireEntityAccess, validateBody(createInvoiceSchema), asyncHandler(async (req: Request, res: Response) => {
  const invoice = await createInvoice({ ...req.body, created_by: req.user!.user_id });
  res.status(201).json({ data: invoice, meta: meta(req) });
}));

// POST /v1/invoices/:id/send
// Sending is this endpoint's idea of issuance: the AR/revenue entry posts
// here, atomically with the delivery fields. `issueInvoice` owns both halves
// now — `markSent` is what separates delivering from merely issuing, and the
// CLI's `invoice issue` passes it as false.
// `irreversible` y no `externo`: el nombre dice enviar, pero lo que hace es
// EMITIR —la poliza de ingreso postea aqui— y marcar. No sale nada de la casa.
router.post('/:id/send', declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'journal_entries de ingreso y CxC POSTEADOS + invoices.status; NO transmite correo' }), requirePermission('invoices:send'), requireEntityAccess, validateBody(sendInvoiceSchema), asyncHandler(async (req: Request, res: Response) => {
  const { to } = req.body;

  const { attest } = await issueInvoice(req.params.id, req.user!.user_id, {
    entityId: req.entityId!,
    markSent: true,
    sentTo: to,
  });
  if (attest && req.tenantId) attestEntryAsync(req.tenantId, attest.entityId, attest.entryId);

  // Este endpoint MARCA, no envía: no hay integración de correo, y responder
  // `sent: true` con un TODO encima era reportar el éxito de un acto que no
  // ocurre — la clase exacta que CLI-5 purgó, en una variante que el criterio
  // de honestidad no veía porque su regex no reconocía «email service». La
  // marca es registro legítimo (el usuario envió la factura por su propio
  // correo); la respuesta ahora dice eso y nada más.
  res.json({
    data: {
      marked_sent: true,
      sent_to: to,
      transmitted: false,
      note: 'La factura queda registrada como enviada; el sistema no transmite correo. El envío es del usuario.',
    },
    meta: meta(req),
  });
}));

// POST /v1/invoices/:id/payments
router.post('/:id/payments', declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'customer_payments + payment_allocations + invoices.amount_due + journal_entries' }), requirePermission('invoices:create'), requireEntityAccess, validateBody(recordPaymentSchema.extend({
  // payment_amount y payment_method se habían caído del esquema al extraer
  // el servicio, y el manejador los seguía leyendo: llegaban sin validar.
  payment_amount: numericLike,
  payment_method: z.string(),
  bank_account_id: uuidString().optional(),
  reference_number: z.string().optional(),
}).partial({ amount: true, reference: true })), asyncHandler(async (req: Request, res: Response) => {
  const { payment_date, payment_amount, payment_method, reference_number, bank_account_id } = req.body;

  // Una sola implementación, compartida con `mnemosine invoice collect`.
  // El servicio lee la factura ACOTADA POR ENTIDAD: antes esta ruta hacía
  // `SELECT * FROM invoices WHERE id = $1` sin filtro, así que conocer un
  // UUID bastaba para aplicar un cobro —y su asiento— a la factura de otra
  // entidad.
  const result = await recordCustomerPayment(
    {
      entityId: req.entityId!,
      paymentAmount: String(payment_amount),
      paymentDate: payment_date,
      paymentMethod: payment_method,
      referenceNumber: reference_number || null,
      bankAccountId: bank_account_id || null,
      applications: [{ documentId: req.params.id, amountApplied: String(payment_amount) }],
    },
    req.user!.user_id
  );

  if (result.attestation && req.tenantId) {
    attestEntryAsync(req.tenantId, result.attestation.entityId, result.attestation.entryId);
  }

  res.status(201).json({
    data: {
      recorded: true,
      payment_number: result.paymentNumber,
      journal_entry_id: result.journalEntry?.id ?? null,
      applied: result.documentos,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/invoices/:id/void
// NIF B-1: the invoice's GL entry is annulled by a linked reversal, in the
// same transaction as the status change. The stamped-CFDI and applied-cash
// guards the service states are opted out of here on purpose: this endpoint
// has never enforced them and its contract is unchanged.
//
// The reason IS required, and is not cosmetic: voidInvoice persists it in the
// reversal's description, in the original entry's notes and in the audit
// record, so it is the only account of WHY revenue was annulled. Same rule as
// POST /v1/journal-entries/:id/void.
router.post('/:id/void', declararRiesgoRuta({ riesgo: 'irreversible', escribe: 'invoices.status + una poliza de reversa' }), requirePermission('invoices:void'), requireEntityAccess, validateBody(voidInvoiceSchema), asyncHandler(async (req: Request, res: Response) => {
  const { reason } = req.body as { reason: string };
  const { invoice, attest } = await voidInvoice(req.params.id, req.user!.user_id, {
    entityId: req.entityId!,
    allowStamped: true,
    allowApplied: true,
    reason,
  });
  if (attest && req.tenantId) attestEntryAsync(req.tenantId, attest.entityId, attest.entryId);

  res.json({ data: invoice, meta: meta(req) });
}));

/** What the PAC answered, kept outside the transaction that writes it down. */
interface IssuedCfdi {
  cfdi?: { uuid: string; provider: string };
}

/**
 * The PAC issued a CFDI and the invoice does not carry its UUID: the write
 * failed, or the transaction was lost while the PAC worked. The UUID is said
 * here, in the answer and in the log, because nothing else remembers it.
 */
function stampNotRecorded(invoiceId: string, cfdi: { uuid: string; provider: string }, cause: unknown): AppError {
  logger.error('invoice_cfdi_stamped_not_recorded', {
    invoiceId,
    cfdiUuid: cfdi.uuid,
    provider: cfdi.provider,
    error: cause instanceof Error ? cause.message : 'the write of the UUID touched no row',
  });
  return new AppError(500, 'INVOICE_CFDI_NOT_RECORDED', {
    key: 'ar.invoice.cfdi.stamped_not_recorded',
    params: { id: invoiceId, uuid: cfdi.uuid, provider: cfdi.provider },
  });
}

// POST /v1/invoices/:id/cfdi/stamp (Mexico)
router.post('/:id/cfdi/stamp', declararRiesgoRuta({ riesgo: 'externo', escribe: 'invoices.cfdi_uuid/cfdi_status; TIMBRA ante un PAC' }), requirePermission('invoices:create'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { pacRouter } = await import('../../../services/integrations/mexico/pac/pac-router.js');
  const invoiceId = req.params.id;
  const entityId = req.entityId!;

  // ONE TRANSACTION, AND THE INVOICE'S ROW HELD FROM THE READ TO THE WRITE
  // (MNE-001-763, #696; the rule of MNE-001-736). Two stamps of one invoice at
  // once both read it unstamped and both reached the PAC, and a second stamp
  // overwrote the folio of the first. The lock is released by the COMMIT, or by
  // Postgres if the process dies, so no marker is left that someone has to
  // clear; the price is one pooled connection and one row for as long as the
  // PAC takes. The other stamp waits for it, bounded by the pool's
  // `lock_timeout`, and then reads the row as the first one left it.
  const issued: IssuedCfdi = {};
  const stamped = await withTransaction(async (tx) => {
    // LA FRONTERA VA AQUÍ, Y NO MÁS ABAJO (TEN-10).
    //
    // A partir de `pacRouter.stamp` el comprobante EXISTE ante el SAT y ya no hay
    // 404 que lo deshaga: si el alcance se comprobara después, el acto externo e
    // irreversible ya habría ocurrido sobre la factura de la sociedad hermana.
    // RLS no lo tapa —acota por INQUILINO, y las dos sociedades son del mismo
    // despacho—, que es exactamente el eje que `scope.ts` existe para defender:
    // el predicado es el que `requireByIdInScope` escribe para una entidad.
    //
    // Cero filas significa a la vez «no existe» y «no es tuya», y las dos salen
    // por el mismo 404 con el mismo cuerpo: distinguirlas reabriría por prosa el
    // oráculo que el SQL acaba de cerrar.
    //
    // FOR NO KEY UPDATE, not FOR UPDATE: while the PAC answers, an insert that
    // only references the invoice (an application of a collection) is not held.
    const { rows } = await tx.query<{
      id: string;
      cfdi_uuid: string | null;
      cfdi_status: string | null;
      stamped_at: Date | null;
    }>(
      `SELECT i.id, i.cfdi_uuid, i.cfdi_status, i.stamped_at
         FROM invoices i
        WHERE i.id = $1 AND i.entity_id = $2
          FOR NO KEY UPDATE OF i`,
      [invoiceId, entityId]
    ).catch((error: unknown) => {
      // 55P03 lock_not_available: `lock_timeout` ran out while another stamp, or
      // another writer of the invoice, held the row. This attempt sent nothing.
      if ((error as { code?: string }).code === '55P03') {
        throw new ConflictError({ key: 'ar.invoice.cfdi.stamp_in_progress', params: { id: invoiceId } });
      }
      throw error;
    });
    const factura = rows[0];
    if (!factura) throw new NotFoundError('Invoice', invoiceId);

    // THE INVOICE'S OWN CFDI, READ UNDER THE LOCK ABOVE, before anything is
    // built or sent. A stamp that waited for another one reads the row as that
    // one left it.
    if (!cfdiIsFreeToStamp(factura.cfdi_status)) {
      throw new ConflictError({
        key: 'ar.invoice.cfdi.already_stamped',
        params: {
          id: invoiceId,
          uuid: factura.cfdi_uuid ?? '-',
          status: factura.cfdi_status ?? '-',
          stamped_at: factura.stamped_at?.toISOString() ?? '-',
        },
      });
    }

    // The whole CFDI 4.0 ingreso (Emisor, Receptor, Conceptos, Impuestos), valid
    // against the SAT's XSD. It carries no Sello yet: sealing is MNE-001-296, and
    // until then a PAC that requires a sealed document rejects it. Read on the
    // held client: a second connection per stamp would let a burst of stamps
    // starve the pool, each holding one and waiting for another.
    const xml = await buildInvoiceCfdiXml(factura.id, entityId, undefined, tx);

    // Stamp via multi-PAC router with automatic failover.
    //
    // The transaction is open and idle while the PAC works. `pg` hands the loss
    // of a connection somebody holds to its `error` event, and with nobody
    // listening Node ends the process: the listener is what lets the write below
    // fail and say which UUID it could not record. A lost connection keeps it,
    // because the driver reports the loss twice and is then dropped by the pool.
    let lost = false;
    const connectionLost = (): void => {
      lost = true;
    };
    tx.on('error', connectionLost);
    const result = await pacRouter
      .stamp(xml, { tenantId: req.user!.tenant_id, userId: req.user!.user_id })
      .finally(() => {
        if (!lost) tx.off('error', connectionLost);
      });
    issued.cfdi = { uuid: result.uuid, provider: result.provider_used };

    // Un folio fabricado por un adaptador simulado NUNCA se guarda como
    // 'stamped': quedaría indistinguible de uno emitido por el SAT.
    const { cfdi_status, nota } = estadoParaPersistir(result);

    // The write names its invoice by the scope and by the state it was read in.
    // The lock makes any other count unreachable; it is checked all the same,
    // because a UUID that is not written down is a CFDI nobody can cancel.
    const written = await tx.query(
      `UPDATE invoices SET
        cfdi_uuid = $1, cfdi_status = $2,
        pac_provider = $3, stamped_at = NOW(),
        memo = CASE WHEN $4::text IS NULL THEN memo
                    ELSE COALESCE(memo, '') || E'\n' || $4::text END
       WHERE id = $5 AND entity_id = $6
         AND (cfdi_status IS NULL OR cfdi_status = ANY($7::text[]))`,
      [result.uuid, cfdi_status, result.provider_used, nota, invoiceId, entityId, FREE_TO_STAMP]
    );
    if (written.rowCount !== 1) throw stampNotRecorded(invoiceId, issued.cfdi, undefined);
    return { result, cfdi_status, nota };
  }).catch((error: unknown) => {
    // Nothing reached the PAC, or the refusal is already the one above.
    if (!issued.cfdi || (error instanceof AppError && error.code === 'INVOICE_CFDI_NOT_RECORDED')) throw error;
    throw stampNotRecorded(invoiceId, issued.cfdi, error);
  });
  const { result, cfdi_status, nota } = stamped;

  res.json({
    data: {
      cfdi_uuid: result.uuid,
      cfdi_status,
      simulado: result.simulado,
      aviso: nota,
      provider_used: result.provider_used,
      fecha_timbrado: result.fecha_timbrado,
      no_certificado_sat: result.no_certificado_sat,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/invoices/:id/cfdi/cancel (Mexico)
router.post('/:id/cfdi/cancel', declararRiesgoRuta({ riesgo: 'externo', escribe: 'cancela el CFDI ante el PAC y el SAT' }), requirePermission('invoices:void'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { cancellation_reason, replacement_uuid } = req.body;

  if (!cancellation_reason) {
    throw new ValidationError('cancellation_reason is required');
  }

  // ACOTADA AUNQUE HOY NO CANCELE (TEN-10).
  //
  // Esta ruta termina en un 501 incondicional —cancelar de verdad son cuatro
  // cosas que todavía no existen— así que lo que se cerraba aquí no era una
  // cancelación ajena: era un ORÁCULO DE EXISTENCIA. Con el UUID de la
  // sociedad hermana, un 501 contestaba «esa factura existe y está timbrada» y
  // un 404 que no, y eso ya es información de otra entidad. El SELECT se acota
  // por lo mismo que los demás, y por si el 501 se retira algún día: la
  // frontera no puede depender de que la ruta siga sin implementarse.
  const invoiceResult = await query<Invoice>(
    'SELECT * FROM invoices WHERE id = $1 AND entity_id = $2 AND cfdi_status = \'stamped\'',
    [req.params.id, req.entityId!]
  );

  if (invoiceResult.rows.length === 0) {
    throw new NotFoundError('Stamped Invoice', req.params.id);
  }

  // SAT cancellation reason codes:
  // 01 - Invoice issued with errors, with a related replacement
  // 02 - Invoice issued with errors, no related replacement
  // 03 - The transaction did not take place
  // 04 - Nominative transaction related in the global invoice
  const validReasons = ['01', '02', '03', '04'];
  if (!validReasons.includes(cancellation_reason)) {
    throw new ValidationError(`Invalid cancellation reason. Must be one of: ${validReasons.join(', ')}`);
  }

  if (cancellation_reason === '01' && !replacement_uuid) {
    throw new ValidationError('replacement_uuid is required for reason 01');
  }

  // Cancelar ante el SAT es irreversible y este endpoint NUNCA lo hizo: marcaba
  // la factura como cancelada en la base y devolvía 200. El resultado es la
  // peor forma del defecto que el cerrojo antisimulación existe para impedir —
  // el mayor cree cancelado un CFDI que el SAT sigue considerando vigente, y
  // nadie se entera hasta que llega el requerimiento.
  //
  // Se retira en vez de completarse porque cancelar de verdad son cuatro cosas
  // que no existen todavía: llamar al PAC por pac-router (que ya tiene la
  // guarda), esperar el acuse, archivarlo por bytes, y encadenar la reversa del
  // asiento contable. Media cancelación es peor que ninguna.
  throw new NotImplementedError(
    'mnemosine todavía no cancela CFDI ante el SAT. Cancela en el portal de tu PAC ' +
      'o en el del SAT, y después reversa el asiento con `mnemosine entry reverse ' +
      '<numero> --reason "CFDI cancelado, acuse <folio>"`. Cuando exista, la ' +
      'cancelación irá por pac-router con acuse archivado y reversa encadenada.',
    { invoice_id: req.params.id, cancellation_reason, replacement_uuid: replacement_uuid ?? null }
  );

  res.json({
    data: {
      cfdi_uuid: invoiceResult.rows[0].cfdi_uuid,
      cfdi_status: 'cancelled',
      cancellation_reason,
      replacement_uuid: replacement_uuid || null,
      cancelled_at: new Date().toISOString(),
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
