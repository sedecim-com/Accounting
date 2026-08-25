import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError, ValidationError, ConflictError } from '../../../utils/errors.js';
import { PreRegistrationService, DuplicateError } from '../../../services/xml-ingestion/pre-registration-service.js';

const router = Router();
const service = new PreRegistrationService();

// ─── Schemas ───
const uploadXmlSchema = z.object({
  entity_id: z.string().uuid().optional(),
  xml_content: z.string().min(1).optional(),
  xml_contents: z.array(z.string().min(1)).optional(),
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
router.get('/pre-registrations', requirePermission('bills:read'), requireEntityAccess, async (req: Request, res: Response) => {
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
});

// GET /v1/pre-registrations/stats
router.get('/pre-registrations/stats', requirePermission('bills:read'), requireEntityAccess, async (req: Request, res: Response) => {
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
});

// GET /v1/pre-registrations/:id
router.get('/pre-registrations/:id', requirePermission('bills:read'), async (req: Request, res: Response) => {
  const result = await query(
    `SELECT pr.*, xd.cfdi_uuid, xd.emisor_rfc, xd.emisor_nombre, xd.cfdi_fecha,
            xd.sat_validation_status, xd.sat_estado,
            v.company_name as vendor_name, v.vendor_number
     FROM pre_registrations pr
     LEFT JOIN xml_documents xd ON xd.id = pr.xml_document_id
     LEFT JOIN vendors v ON v.id = pr.vendor_id
     WHERE pr.id = $1`,
    [req.params.id]
  );
  if (result.rows.length === 0) throw new NotFoundError('Pre-Registration', req.params.id);

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
});

// PATCH /v1/pre-registrations/:id
router.patch('/pre-registrations/:id', requirePermission('bills:create'), validateBody(updatePreRegSchema), asyncHandler(async (req: Request, res: Response) => {
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
  params.push(req.params.id);

  const result = await query(
    `UPDATE pre_registrations SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
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
  const preReg = await query<Record<string, unknown>>(
    'SELECT * FROM pre_registrations WHERE id = $1',
    [req.params.id]
  );
  if (preReg.rows.length === 0) throw new NotFoundError('Pre-Registration', req.params.id);
  if (preReg.rows[0].status === 'completed') throw new ConflictError('Pre-registration already processed');

  const result = await service.processToAccounting(preReg.rows[0], req.user!.user_id);

  res.json({
    data: {
      pre_registration_id: req.params.id,
      status: 'completed',
      result: {
        type: result.bill ? 'bill' : 'journal_entry',
        bill_id: result.bill?.id,
        journal_entry_id: result.journalEntry.id,
      },
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/pre-registrations/:id/reject
router.post('/pre-registrations/:id/reject', requirePermission('bills:void'), validateBody(rejectPreRegSchema), asyncHandler(async (req: Request, res: Response) => {
  const { reason, notes } = req.body;

  const result = await query(
    `UPDATE pre_registrations SET status = 'rejected', notes = COALESCE(notes,'') || $1 WHERE id = $2 RETURNING *`,
    [`\nRejected: ${reason}${notes ? ' - ' + notes : ''}`, req.params.id]
  );
  if (result.rows.length === 0) throw new NotFoundError('Pre-Registration', req.params.id);

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/pre-registrations/:id/approve
router.post('/pre-registrations/:id/approve', requirePermission('bills:approve'), validateBody(approvePreRegSchema), asyncHandler(async (req: Request, res: Response) => {
  const { notes } = req.body;

  const result = await query(
    `UPDATE pre_registrations SET
      approval_status = 'approved', approved_by = $1, approved_at = NOW(),
      approval_notes = $2
     WHERE id = $3 AND requires_approval = true AND approval_status = 'pending'
     RETURNING *`,
    [req.user!.user_id, notes || null, req.params.id]
  );
  if (result.rows.length === 0) throw new NotFoundError('Pre-Registration pending approval', req.params.id);

  res.json({
    data: result.rows[0],
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// POST /v1/pre-registrations/bulk
router.post('/pre-registrations/bulk', requirePermission('bills:create'), validateBody(bulkPreRegSchema), asyncHandler(async (req: Request, res: Response) => {
  const { action, ids, params = {} } = req.body;

  const results: Array<{ id: string; status: string; error?: string }> = [];

  for (const id of ids) {
    try {
      switch (action) {
        case 'process': {
          const preReg = await query('SELECT * FROM pre_registrations WHERE id = $1', [id]);
          if (preReg.rows.length > 0) {
            await service.processToAccounting(preReg.rows[0] as Record<string, unknown>, req.user!.user_id);
          }
          results.push({ id, status: 'success' });
          break;
        }
        case 'approve':
          await query(
            `UPDATE pre_registrations SET approval_status = 'approved', approved_by = $1, approved_at = NOW() WHERE id = $2`,
            [req.user!.user_id, id]
          );
          results.push({ id, status: 'success' });
          break;
        case 'reject':
          await query(
            `UPDATE pre_registrations SET status = 'rejected', notes = COALESCE(notes,'') || $1 WHERE id = $2`,
            [`\nBulk reject: ${params.reason || 'No reason'}`, id]
          );
          results.push({ id, status: 'success' });
          break;
        case 'set_batch':
          await query(
            `UPDATE pre_registrations SET scheduled_batch_id = $1, processing_mode = 'batch' WHERE id = $2`,
            [params.batch_id, id]
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
router.get('/processing-rules', requirePermission('settings:manage'), requireEntityAccess, async (req: Request, res: Response) => {
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
});

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
router.get('/processing-batches', requirePermission('bills:read'), requireEntityAccess, async (req: Request, res: Response) => {
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
});

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
router.get('/processing-batches/:id/progress', requirePermission('bills:read'), async (req: Request, res: Response) => {
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
});

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
router.get('/xml-documents', requirePermission('bills:read'), requireEntityAccess, async (req: Request, res: Response) => {
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
});

// GET /v1/xml-documents/:id
router.get('/xml-documents/:id', requirePermission('bills:read'), async (req: Request, res: Response) => {
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
});

export default router;
