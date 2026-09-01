import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError, ValidationError, ConflictError, ForbiddenError } from '../../../utils/errors.js';
import { PreRegistrationService, DuplicateError } from '../../../services/xml-ingestion/pre-registration-service.js';
import { requireByIdInScope, entityScope } from '../../../database/scope.js';

const router = Router();
const service = new PreRegistrationService();

// ============================================================
// LOS PRE-REGISTROS SE DIRECCIONAN POR UUID Y NADIE LOS ACOTABA.
//
// Las seis rutas `/pre-registrations/:id` (y la de lote) tomaban el id de la
// URL y lo pasaban al SQL a secas. Ninguna lleva `requireEntityAccess`, y no
// serviría de nada si la llevara: ese middleware mira `req.entityId`, no el
// parámetro de ruta.
//
// La peor era `/:id/process`: carga la fila entera sin acotar y se la entrega
// a `processToAccounting`, que POSTEA AL MAYOR. Con el UUID de un pre-registro
// ajeno se contabilizaba el gasto de otra entidad en sus propios libros —el
// documento trae su entity_id, así que el asiento nace bien formado y va a
// parar al mayor de la víctima—.
//
// Las otras cinco no postean, pero mutan: aprobar, rechazar, reasignar
// proveedor o cuenta contable, cambiar las líneas. Cerrar sólo `/process` y
// dejar `/reject` abierta no cierra el camino, así que van las seis.
//
// `req.entityId` es de fiar desde que `authenticate` contrasta la cabecera
// x-entity-id contra las entidades del token.
// ============================================================
const alcance = (req: Request) => entityScope(req.tenantId!, req.entityId!);

/** Cuántos XML admite un solo POST. Ver el porqué en xml_contents. */
const MAX_XML_POR_LOTE = 100;

// ─── Schemas ───
const uploadXmlSchema = z.object({
  entity_id: z.string().uuid().optional(),
  xml_content: z.string().min(1).optional(),
  // TOPE DURO AL LOTE.
  //
  // El manejador itera este arreglo llamando a processXMLUpload por elemento:
  // cada vuelta parsea un XML y golpea la base. Sin tope, un cliente
  // autenticado ata un worker el tiempo que quiera con un solo POST —hasta los
  // 10 MB que admite el parser de JSON—. Es la `js/loop-bound-injection` que
  // CodeQL señala: iterar sobre un .length que viene del usuario.
  //
  // 100 es el lote grande razonable de un despacho; más que eso es un trabajo
  // por lotes, no una petición HTTP, y para eso está `mnemosine ingest`.
  xml_contents: z.array(z.string().min(1)).max(MAX_XML_POR_LOTE).optional(),
  source: z.string().optional(),
}).refine((o) => !!(o.xml_content || (o.xml_contents && o.xml_contents.length > 0)), {
  message: 'xml_content or xml_contents array is required',
});

const updatePreRegSchema = z.object({
  vendor_id: z.string().uuid().nullable().optional(),
  default_account_id: z.string().uuid().nullable().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).nullable().optional(),
  notes: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  lines: z.array(z.record(z.unknown())).optional(),
}).refine((o) => Object.keys(o).length > 0, { message: 'At least one field required' });

const rejectPreRegSchema = z.object({
  reason: z.string().min(1),
  notes: z.string().optional(),
});

const approvePreRegSchema = z.object({
  notes: z.string().optional(),
});

const bulkPreRegSchema = z.object({
  action: z.enum(['process', 'approve', 'reject', 'set_batch']),
  ids: z.array(z.string().uuid()).min(1),
  params: z.record(z.unknown()).optional(),
});

const createProcessingRuleSchema = z.object({
  entity_id: z.string().uuid().optional(),
  rule_name: z.string().min(1).max(255),
  rule_code: z.string().max(50).optional(),
  description: z.string().optional(),
  rule_type: z.string().min(1),
  priority: z.number().int().optional(),
  conditions: z.record(z.unknown()),
  actions: z.record(z.unknown()),
  applies_to_document_types: z.array(z.string()).optional(),
  is_active: z.boolean().optional(),
});

const updateProcessingRuleSchema = z.object({
  rule_name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  priority: z.number().int().optional(),
  is_active: z.boolean().optional(),
  conditions: z.record(z.unknown()).optional(),
  actions: z.record(z.unknown()).optional(),
}).refine((o) => Object.keys(o).length > 0, { message: 'At least one field required' });

const createBatchSchema = z.object({
  entity_id: z.string().uuid().optional(),
  batch_name: z.string().max(255).optional(),
  description: z.string().optional(),
  scheduled_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
  scheduled_time: z.string().optional(),
  include_filters: z.record(z.unknown()).optional(),
  auto_post: z.boolean().optional(),
  notify_on_complete: z.boolean().optional(),
  notify_emails: z.array(z.string().email()).optional(),
});

// ============================================================
// XML UPLOAD
// ============================================================

// POST /v1/xml/upload - Upload XML content (JSON body with base64 or string)
router.post('/upload', requirePermission('bills:create'), requireEntityAccess, validateBody(uploadXmlSchema), asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, xml_content, xml_contents, source = 'api' } = req.body;
  const entityId = entity_id || req.entityId;

  if (!entityId) throw new ValidationError('entity_id is required');

  // Support single or batch upload
  const xmls: string[] = xml_contents || (xml_content ? [xml_content] : []);

  const results: Array<Record<string, unknown>> = [];
  const errors: Array<Record<string, unknown>> = [];

  for (let i = 0; i < xmls.length; i++) {
    try {
      const result = await service.processXMLUpload(entityId, xmls[i], source, req.user!.user_id);
      results.push({
        index: i,
        status: 'success',
        xml_document_id: result.xmlDocument.id,
        pre_registration_id: result.preRegistration.id,
        cfdi_uuid: result.xmlDocument.cfdi_uuid,
        processing_mode: result.preRegistration.processing_mode,
        was_auto_processed: result.autoProcessed,
        bill_id: result.bill?.id,
        journal_entry_id: result.journalEntry?.id,
        requires_review: result.preRegistration.processing_mode === 'manual',
      });
    } catch (err) {
      if (err instanceof DuplicateError) {
        errors.push({ index: i, status: 'duplicate', existing_id: err.existingId, error: err.message });
      } else {
        errors.push({ index: i, status: 'error', error: (err as Error).message });
      }
    }
  }

  res.status(201).json({
    data: {
      uploaded: xmls.length,
      processed: results.filter((r) => r.was_auto_processed).length,
      failed: errors.length,
      results,
      errors,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// ============================================================
// PRE-REGISTRATIONS
// ============================================================

// GET /v1/pre-registrations
router.get('/pre-registrations', requirePermission('bills:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const {
    entity_id, status, processing_mode, validation_status,
    requires_approval, vendor_id, date_from, date_to, search,
    page = '1', per_page = '50',
  } = req.query;
  const entityId = entity_id as string || req.entityId;

  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, parseInt(per_page as string, 10));

  let where = 'WHERE pr.entity_id = $1';
  const params: unknown[] = [entityId];
  let idx = 2;

  if (status) { where += ` AND pr.status = $${idx++}`; params.push(status); }
  if (processing_mode) { where += ` AND pr.processing_mode = $${idx++}`; params.push(processing_mode); }
  if (validation_status) { where += ` AND pr.validation_status = $${idx++}`; params.push(validation_status); }
  if (requires_approval !== undefined) { where += ` AND pr.requires_approval = $${idx++}`; params.push(requires_approval === 'true'); }
  if (vendor_id) { where += ` AND pr.vendor_id = $${idx++}`; params.push(vendor_id); }
  if (date_from) { where += ` AND pr.document_date >= $${idx++}`; params.push(date_from); }
  if (date_to) { where += ` AND pr.document_date <= $${idx++}`; params.push(date_to); }
  if (search) {
    where += ` AND (pr.external_reference ILIKE $${idx} OR xd.emisor_nombre ILIKE $${idx} OR xd.cfdi_uuid ILIKE $${idx})`;
    params.push(`%${search}%`);
    idx++;
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM pre_registrations pr
     LEFT JOIN xml_documents xd ON xd.id = pr.xml_document_id ${where}`,
    params
  );

  const result = await query(
    `SELECT pr.*, xd.cfdi_uuid, xd.emisor_rfc, xd.emisor_nombre, xd.cfdi_fecha,
            v.company_name as vendor_name, v.vendor_number
     FROM pre_registrations pr
     LEFT JOIN xml_documents xd ON xd.id = pr.xml_document_id
     LEFT JOIN vendors v ON v.id = pr.vendor_id
     ${where} ORDER BY pr.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    [...params, perPage, (pageNum - 1) * perPage]
  );

  res.json({
    data: result.rows,
    pagination: {
      page: pageNum, per_page: perPage,
      total_pages: Math.ceil(parseInt(countResult.rows[0].count, 10) / perPage),
      total_count: parseInt(countResult.rows[0].count, 10),
      next_cursor: null, prev_cursor: null,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/pre-registrations/stats
router.get('/pre-registrations/stats', requirePermission('bills:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, date_from, date_to } = req.query;
  const entityId = entity_id as string || req.entityId;

  let dateFilter = '';
  const params: unknown[] = [entityId];
  let idx = 2;
  if (date_from) { dateFilter += ` AND document_date >= $${idx++}`; params.push(date_from); }
  if (date_to) { dateFilter += ` AND document_date <= $${idx++}`; params.push(date_to); }

  const byStatus = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text as count FROM pre_registrations
     WHERE entity_id = $1 ${dateFilter} GROUP BY status`,
    params
  );

  const byMode = await query<{ processing_mode: string; count: string }>(
    `SELECT processing_mode, COUNT(*)::text as count FROM pre_registrations
     WHERE entity_id = $1 ${dateFilter} GROUP BY processing_mode`,
    params
  );

  const totals = await query<{ total: string; completed: string; pending_approval: string }>(
    `SELECT COUNT(*)::text as total,
            COUNT(*) FILTER (WHERE status = 'completed')::text as completed,
            COUNT(*) FILTER (WHERE requires_approval = true AND approval_status = 'pending')::text as pending_approval
     FROM pre_registrations WHERE entity_id = $1 ${dateFilter}`,
    params
  );

  const total = parseInt(totals.rows[0]?.total || '0', 10);
  const completed = parseInt(totals.rows[0]?.completed || '0', 10);

  res.json({
    data: {
      total,
      by_status: Object.fromEntries(byStatus.rows.map((r) => [r.status, parseInt(r.count, 10)])),
      by_processing_mode: Object.fromEntries(byMode.rows.map((r) => [r.processing_mode, parseInt(r.count, 10)])),
      auto_processing_rate: total > 0 ? completed / total : 0,
      pending_approval: parseInt(totals.rows[0]?.pending_approval || '0', 10),
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/pre-registrations/:id
//
// Va envuelto en asyncHandler, y no es cosmético: Express 4 no captura la
// promesa rechazada de un manejador asíncrono. Sin envolver, el 404 que ahora
// devuelve un id ajeno no llegaría al errorHandler — dejaría la petición
// colgada y el unhandledRejection de Node abortaría el proceso. Acotar sin
// envolver habría cambiado una fuga de datos por una caída del servidor.
//
// NOTA: quedan 61 manejadores `async` sin envolver en src/api/rest/routes/.
// Los que lanzan NotFoundError sobre un id inexistente son una negación de
// servicio de una petición. Está fuera del alcance de TEN-2 y anotado.
router.get('/pre-registrations/:id', requirePermission('bills:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const result = await query(
    `SELECT pr.*, xd.cfdi_uuid, xd.emisor_rfc, xd.emisor_nombre, xd.cfdi_fecha,
            xd.sat_validation_status, xd.sat_estado,
            v.company_name as vendor_name, v.vendor_number
     FROM pre_registrations pr
     LEFT JOIN xml_documents xd ON xd.id = pr.xml_document_id
     LEFT JOIN vendors v ON v.id = pr.vendor_id
     WHERE pr.id = $1 AND pr.entity_id = $2`,
    [req.params.id, req.entityId]
  );
  if (result.rows.length === 0) throw new NotFoundError('Pre-Registration', req.params.id);

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// PATCH /v1/pre-registrations/:id
router.patch('/pre-registrations/:id', requirePermission('bills:create'), requireEntityAccess, validateBody(updatePreRegSchema), asyncHandler(async (req: Request, res: Response) => {
  const { vendor_id, lines, due_date, notes, tags, default_account_id } = req.body;

  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (vendor_id !== undefined) { updates.push(`vendor_id = $${idx++}`); params.push(vendor_id); }
  if (default_account_id !== undefined) { updates.push(`default_account_id = $${idx++}`); params.push(default_account_id); }
  if (due_date !== undefined) { updates.push(`due_date = $${idx++}`); params.push(due_date); }
  if (notes !== undefined) { updates.push(`notes = $${idx++}`); params.push(notes); }
  if (tags !== undefined) { updates.push(`tags = $${idx++}::jsonb`); params.push(JSON.stringify(tags)); }
  if (lines !== undefined) { updates.push(`lines = $${idx++}::jsonb`); params.push(JSON.stringify(lines)); }

  if (updates.length === 0) throw new ValidationError('No valid fields to update');

  updates.push(`updated_at = NOW()`);
  params.push(req.params.id, req.entityId);

  const result = await query(
    `UPDATE pre_registrations SET ${updates.join(', ')}
      WHERE id = $${idx} AND entity_id = $${idx + 1} RETURNING *`,
    params
  );
  if (result.rows.length === 0) throw new NotFoundError('Pre-Registration', req.params.id);

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/pre-registrations/:id/process
router.post('/pre-registrations/:id/process', requirePermission('bills:create'), asyncHandler(async (req: Request, res: Response) => {
  // El filtro va DENTRO del SQL. Cero filas significa a la vez «no existe» y
  // «no es de tu entidad»: la respuesta es 404 en los dos casos y no hay rama
  // donde el programa pueda distinguirlos.
  const preReg = await requireByIdInScope<Record<string, unknown>>(
    'pre_registrations',
    req.params.id,
    alcance(req)
  );
  if (preReg.status === 'completed') throw new ConflictError('Pre-registration already processed');

  // Un pre-registro de PAGO registra cobros o pagos, no gastos: el permiso de
  // la ruta (`bills:create`) cubre el REP recibido —pagar a un proveedor exige
  // ese mismo permiso en POST /bills/payments— pero un REP EMITIDO registra
  // cobros de clientes, que en el resto de la superficie exigen
  // `invoices:create`. Antes del cableado esta rama no existía; al abrirse,
  // un usuario con permiso sólo de gastos habría podido registrar cobranzas.
  if (preReg.document_type === 'payment' && !req.user!.permissions.includes('*')) {
    const d = await query<{ emisor_rfc: string; tax_id: string }>(
      `SELECT x.emisor_rfc, le.tax_id
         FROM xml_documents x
         JOIN legal_entities le ON le.id = $2
        WHERE x.id = $1`,
      [preReg.xml_document_id, preReg.entity_id]
    );
    const emitido = d.rows[0] && d.rows[0].emisor_rfc === d.rows[0].tax_id;
    if (emitido && !req.user!.permissions.includes('invoices:create')) {
      throw new ForbiddenError('Insufficient permissions', {
        required: ['invoices:create'],
        detail: 'Un comprobante de pago emitido registra cobros de clientes.',
      });
    }
  }

  // El alta del emisor como proveedor es opt-in y por petición. Ésta es una
  // ruta INTERACTIVA —hay una persona autenticada detrás de cada llamada— así
  // que puede autorizarla, pero tiene que escribirlo: sin el campo, el
  // servicio rechaza y dice qué proveedor se iba a crear.
  const permitirProveedorNuevo =
    (req.body as { allow_new_vendor?: unknown } | undefined)?.allow_new_vendor === true;

  const result = await service.processToAccounting(preReg, req.user!.user_id, {
    permitirProveedorNuevo,
  });

  res.json({
    data: {
      pre_registration_id: req.params.id,
      status: 'completed',
      result: {
        // Un REP no genera póliza propia: casa con un pago existente o crea
        // uno, y la póliza es la de ese pago.
        type: result.bill ? 'bill' : result.paymentId ? 'payment' : 'journal_entry',
        bill_id: result.bill?.id,
        payment_id: result.paymentId,
        journal_entry_id: result.journalEntry?.id ?? null,
      },
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/pre-registrations/:id/reject
router.post('/pre-registrations/:id/reject', requirePermission('bills:void'), requireEntityAccess, validateBody(rejectPreRegSchema), asyncHandler(async (req: Request, res: Response) => {
  const { reason, notes } = req.body;

  const result = await query(
    `UPDATE pre_registrations SET status = 'rejected', notes = COALESCE(notes,'') || $1
      WHERE id = $2 AND entity_id = $3 RETURNING *`,
    [`\nRejected: ${reason}${notes ? ' - ' + notes : ''}`, req.params.id, req.entityId]
  );
  if (result.rows.length === 0) throw new NotFoundError('Pre-Registration', req.params.id);

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/pre-registrations/:id/approve
router.post('/pre-registrations/:id/approve', requirePermission('bills:approve'), requireEntityAccess, validateBody(approvePreRegSchema), asyncHandler(async (req: Request, res: Response) => {
  const { notes } = req.body;

  const result = await query(
    `UPDATE pre_registrations SET
      approval_status = 'approved', approved_by = $1, approved_at = NOW(),
      approval_notes = $2
     WHERE id = $3 AND entity_id = $4 AND requires_approval = true AND approval_status = 'pending'
     RETURNING *`,
    [req.user!.user_id, notes || null, req.params.id, req.entityId]
  );
  if (result.rows.length === 0) throw new NotFoundError('Pre-Registration pending approval', req.params.id);

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/pre-registrations/bulk
router.post('/pre-registrations/bulk', requirePermission('bills:create'), requireEntityAccess, validateBody(bulkPreRegSchema), asyncHandler(async (req: Request, res: Response) => {
  const { action, ids, params = {} } = req.body;

  const results: Array<{ id: string; status: string; error?: string }> = [];

  for (const id of ids) {
    try {
      switch (action) {
        case 'process': {
          // Antes: si la fila no aparecía se reportaba `success` igual. Un id
          // ajeno y un id inexistente daban la misma respuesta satisfactoria
          // que uno propio contabilizado, así que el lote mentía en las dos
          // direcciones. Ahora requireByIdInScope lanza y el catch de abajo lo
          // registra como error de ESE id, sin detener el resto.
          const preReg = await requireByIdInScope<Record<string, unknown>>(
            'pre_registrations',
            id,
            alcance(req)
          );
          // Igual que la ruta individual: interactiva, así que el alta de
          // proveedor puede autorizarse, pero hay que escribirla en
          // `params.allow_new_vendor`. Vale para TODO el lote porque el lote
          // es una sola orden de una sola persona; el que no la escribe no
          // crea contrapartes y recibe el motivo por id.
          await service.processToAccounting(preReg, req.user!.user_id, {
            permitirProveedorNuevo:
              (params as { allow_new_vendor?: unknown }).allow_new_vendor === true,
          });
          results.push({ id, status: 'success' });
          break;
        }
        case 'approve':
          await query(
            `UPDATE pre_registrations SET approval_status = 'approved', approved_by = $1, approved_at = NOW()
              WHERE id = $2 AND entity_id = $3`,
            [req.user!.user_id, id, req.entityId]
          );
          results.push({ id, status: 'success' });
          break;
        case 'reject':
          await query(
            `UPDATE pre_registrations SET status = 'rejected', notes = COALESCE(notes,'') || $1
              WHERE id = $2 AND entity_id = $3`,
            [`\nBulk reject: ${params.reason || 'No reason'}`, id, req.entityId]
          );
          results.push({ id, status: 'success' });
          break;
        case 'set_batch':
          await query(
            `UPDATE pre_registrations SET scheduled_batch_id = $1, processing_mode = 'batch'
              WHERE id = $2 AND entity_id = $3`,
            [params.batch_id, id, req.entityId]
          );
          results.push({ id, status: 'success' });
          break;
        default:
          results.push({ id, status: 'error', error: `Unknown action: ${action}` });
      }
    } catch (err) {
      results.push({ id, status: 'error', error: (err as Error).message });
    }
  }

  res.json({
    data: { action, total: ids.length, results },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// ============================================================
// PROCESSING RULES
// ============================================================

// GET /v1/processing-rules
router.get('/processing-rules', requirePermission('settings:manage'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, rule_type, is_active } = req.query;
  const entityId = entity_id as string || req.entityId;

  let where = 'WHERE entity_id = $1';
  const params: unknown[] = [entityId];
  let idx = 2;

  if (rule_type) { where += ` AND rule_type = $${idx++}`; params.push(rule_type); }
  if (is_active !== undefined) { where += ` AND is_active = $${idx++}`; params.push(is_active === 'true'); }

  const result = await query(
    `SELECT * FROM processing_rules ${where} ORDER BY priority ASC, created_at DESC`,
    params
  );

  res.json({
    data: result.rows,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/processing-rules
router.post('/processing-rules', requirePermission('settings:manage'), requireEntityAccess, validateBody(createProcessingRuleSchema), asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, rule_name, rule_code, rule_type, priority, conditions, actions, description, applies_to_document_types, is_active } = req.body;
  const entityId = entity_id || req.entityId;

  const result = await query(
    `INSERT INTO processing_rules (
      id, entity_id, rule_name, rule_code, description, rule_type,
      priority, conditions, actions, applies_to_document_types, is_active, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
    RETURNING *`,
    [
      uuidv4(), entityId, rule_name, rule_code || null, description || null, rule_type,
      priority || 100, JSON.stringify(conditions), JSON.stringify(actions),
      applies_to_document_types || null,
      is_active !== false,
      req.user!.user_id,
    ]
  );

  res.status(201).json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// PUT /v1/processing-rules/:id
router.put('/processing-rules/:id', requirePermission('settings:manage'), validateBody(updateProcessingRuleSchema), asyncHandler(async (req: Request, res: Response) => {
  const fields = ['rule_name', 'description', 'priority', 'is_active'];
  const updates: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = $${idx++}`); params.push(req.body[f]); }
  }
  if (req.body.conditions) { updates.push(`conditions = $${idx++}::jsonb`); params.push(JSON.stringify(req.body.conditions)); }
  if (req.body.actions) { updates.push(`actions = $${idx++}::jsonb`); params.push(JSON.stringify(req.body.actions)); }

  if (updates.length === 0) throw new ValidationError('No valid fields to update');

  updates.push(`updated_at = NOW()`);
  params.push(req.params.id);

  const result = await query(
    `UPDATE processing_rules SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
    params
  );
  if (result.rows.length === 0) throw new NotFoundError('Processing Rule', req.params.id);

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// DELETE /v1/processing-rules/:id
router.delete('/processing-rules/:id', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  const result = await query('DELETE FROM processing_rules WHERE id = $1', [req.params.id]);
  if (result.rowCount === 0) throw new NotFoundError('Processing Rule', req.params.id);
  res.status(204).send();
}));

// ============================================================
// PROCESSING BATCHES
// ============================================================

// GET /v1/processing-batches
router.get('/processing-batches', requirePermission('bills:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, status, scheduled_date } = req.query;
  const entityId = entity_id as string || req.entityId;

  let where = 'WHERE entity_id = $1';
  const params: unknown[] = [entityId];
  let idx = 2;

  if (status) { where += ` AND status = $${idx++}`; params.push(status); }
  if (scheduled_date) { where += ` AND scheduled_date = $${idx++}`; params.push(scheduled_date); }

  const result = await query(
    `SELECT * FROM processing_batches ${where} ORDER BY scheduled_date DESC, created_at DESC`,
    params
  );

  res.json({
    data: result.rows,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/processing-batches
router.post('/processing-batches', requirePermission('bills:create'), requireEntityAccess, validateBody(createBatchSchema), asyncHandler(async (req: Request, res: Response) => {
  const {
    entity_id, batch_name, description, scheduled_date, scheduled_time,
    include_filters, auto_post, notify_on_complete, notify_emails,
  } = req.body;
  const entityId = entity_id || req.entityId;

  const batchCount = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM processing_batches WHERE entity_id = $1`,
    [entityId]
  );
  const year = new Date().getFullYear();
  const batchNumber = `BATCH-${year}-${(parseInt(batchCount.rows[0].count, 10) + 1).toString().padStart(5, '0')}`;

  const result = await query(
    `INSERT INTO processing_batches (
      id, entity_id, batch_number, batch_name, description,
      scheduled_date, scheduled_time, include_filters,
      auto_post, notify_on_complete, notify_emails,
      status, created_by
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,'scheduled',$12)
    RETURNING *`,
    [
      uuidv4(), entityId, batchNumber, batch_name || batchNumber, description || null,
      scheduled_date || null, scheduled_time || null,
      include_filters ? JSON.stringify(include_filters) : null,
      auto_post !== false, notify_on_complete !== false,
      notify_emails || null, req.user!.user_id,
    ]
  );

  res.status(201).json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/processing-batches/:id/execute
router.post('/processing-batches/:id/execute', requirePermission('bills:create'), asyncHandler(async (req: Request, res: Response) => {
  const results = await service.processBatch(req.params.id, req.user!.user_id);

  res.json({
    data: results,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/processing-batches/:id/progress
router.get('/processing-batches/:id/progress', requirePermission('bills:read'), asyncHandler(async (req: Request, res: Response) => {
  const result = await query<Record<string, unknown>>(
    'SELECT * FROM processing_batches WHERE id = $1',
    [req.params.id]
  );
  if (result.rows.length === 0) throw new NotFoundError('Processing Batch', req.params.id);

  const b = result.rows[0];
  const total = Number(b.total_items) || 0;
  const processed = Number(b.processed_items) || 0;

  res.json({
    data: {
      status: b.status,
      total_items: total,
      processed_items: processed,
      successful_items: Number(b.successful_items) || 0,
      failed_items: Number(b.failed_items) || 0,
      percent_complete: total > 0 ? Math.round((processed / total) * 100) : 0,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/processing-batches/:id/cancel
router.post('/processing-batches/:id/cancel', requirePermission('bills:create'), asyncHandler(async (req: Request, res: Response) => {
  const result = await query(
    `UPDATE processing_batches SET status = 'cancelled' WHERE id = $1 AND status IN ('scheduled', 'running') RETURNING *`,
    [req.params.id]
  );
  if (result.rows.length === 0) throw new NotFoundError('Cancellable Batch', req.params.id);

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// ============================================================
// XML DOCUMENTS (read-only)
// ============================================================

// GET /v1/xml-documents
router.get('/xml-documents', requirePermission('bills:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const { entity_id, status, emisor_rfc, date_from, date_to, page = '1', per_page = '50' } = req.query;
  const entityId = entity_id as string || req.entityId;

  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, parseInt(per_page as string, 10));

  let where = 'WHERE entity_id = $1';
  const params: unknown[] = [entityId];
  let idx = 2;

  if (status) { where += ` AND processing_status = $${idx++}`; params.push(status); }
  if (emisor_rfc) { where += ` AND emisor_rfc = $${idx++}`; params.push(emisor_rfc); }
  if (date_from) { where += ` AND cfdi_fecha >= $${idx++}`; params.push(date_from); }
  if (date_to) { where += ` AND cfdi_fecha <= $${idx++}`; params.push(date_to); }

  const result = await query(
    `SELECT id, entity_id, document_type, cfdi_uuid, cfdi_serie, cfdi_folio, cfdi_fecha,
            emisor_rfc, emisor_nombre, receptor_rfc, total, moneda,
            sat_validation_status, processing_status, imported_at
     FROM xml_documents ${where}
     ORDER BY cfdi_fecha DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    [...params, perPage, (pageNum - 1) * perPage]
  );

  res.json({
    data: result.rows,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/xml-documents/:id
router.get('/xml-documents/:id', requirePermission('bills:read'), asyncHandler(async (req: Request, res: Response) => {
  const doc = await query('SELECT * FROM xml_documents WHERE id = $1', [req.params.id]);
  if (doc.rows.length === 0) throw new NotFoundError('XML Document', req.params.id);

  const lines = await query(
    'SELECT * FROM xml_document_lines WHERE xml_document_id = $1 ORDER BY line_number',
    [req.params.id]
  );

  res.json({
    data: { ...doc.rows[0], lines: lines.rows },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
