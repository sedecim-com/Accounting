import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { requireByIdInScope, entityScope } from '../../../database/scope.js';
import {
  createJournalEntry,
  postJournalEntry,
  voidJournalEntry,
  reverseJournalEntry,
  listJournalEntries,
  listEntryLines,
} from '../../../services/accounting/index.js';
import type { JournalEntry, JournalEntryLine, PaginationMeta } from '../../../types/index.js';
import { JournalEntryType } from '../../../types/index.js';

const router = Router();

/**
 * Exige que el asiento sea de la entidad de la petición, o 404.
 *
 * Era la misma forma que se acaba de borrar en el servicio
 * (`assertEntryBelongsTo`): leer `WHERE id = $1` sin acotar y comparar
 * después. La usan `/:id/post`, `/:id/void` y `/:id/reverse` —las tres
 * escrituras que mueven el mayor por UUID—, y en las tres dejaba ventana entre
 * la comprobación y la escritura, y contestaba 403 sobre un asiento ajeno
 * existente frente a 404 sobre uno inventado.
 */
async function assertEntryAccess(req: Request, entryId: string): Promise<void> {
  await requireByIdInScope('journal_entries', entryId, entityScope(req.tenantId!, req.entityId!), {
    columns: 'id',
  });
}

// ─── Schemas ───
const decimalString = z.union([z.string(), z.number()]).transform((v) => String(v));

const journalLineSchema = z
  .object({
    account_id: z.string().uuid(),
    debit_amount: decimalString.nullable().optional(),
    credit_amount: decimalString.nullable().optional(),
    description: z.string().optional(),
    cost_center_id: z.string().uuid().optional(),
    project_id: z.string().uuid().optional(),
  })
  .refine(
    (l) => Boolean(l.debit_amount) !== Boolean(l.credit_amount),
    { message: 'Each line must have either debit_amount OR credit_amount, not both' }
  );

const createJournalEntrySchema = z.object({
  entity_id: z.string().uuid(),
  entry_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'YYYY-MM-DD'),
  entry_type: z
    .enum([
      'standard', 'adjusting', 'closing', 'reversing', 'correction',
      'auto_invoice', 'auto_bill', 'auto_payment', 'auto_depreciation', 'auto_reconciliation', 'payroll',
    ])
    .optional(),
  description: z.string().optional(),
  lines: z.array(journalLineSchema).min(2, 'At least 2 lines required'),
  auto_post: z.boolean().optional(),
  reference: z.string().optional(),
});

const voidJeSchema = z.object({
  reason: z.string().min(1, 'Reason is required for voiding'),
});

const reverseJeSchema = z.object({
  reversal_date: z.string().regex(/^\d{4}-\d{2}-\d{2}/).optional(),
});

// GET /v1/journal-entries
router.get('/', requirePermission('journal_entries:read'), requireEntityAccess, asyncHandler(async (req: Request, res: Response) => {
  const {
    entity_id,
    fiscal_period_id,
    status,
    entry_type,
    start_date,
    end_date,
    source_type,
    page = '1',
    per_page = '50',
  } = req.query;

  const entityId = entity_id as string || req.entityId;
  const pageNum = Math.max(1, parseInt(page as string, 10));
  const perPage = Math.min(100, Math.max(1, parseInt(per_page as string, 10)));
  const offset = (pageNum - 1) * perPage;

  // Filtering, counting and ordering moved verbatim into the domain service
  // so the CLI and the agent search the ledger the same way this route does.
  // `entityId` keeps the route's original nullability: without an entity in
  // scope the WHERE matched nothing, and it still does.
  const { rows, total: totalCount } = await listJournalEntries(entityId as string, {
    fiscalPeriodId: fiscal_period_id as string | undefined,
    status: status as string | undefined,
    entryType: entry_type as string | undefined,
    startDate: start_date as string | undefined,
    endDate: end_date as string | undefined,
    sourceType: source_type as string | undefined,
    limit: perPage,
    offset,
  });
  const result = { rows };

  const pagination: PaginationMeta = {
    page: pageNum,
    per_page: perPage,
    total_pages: Math.ceil(totalCount / perPage),
    total_count: totalCount,
    next_cursor: null,
    prev_cursor: null,
  };

  res.json({
    data: result.rows,
    pagination,
    meta: {
      request_id: req.headers['x-request-id'],
      timestamp: new Date().toISOString(),
      version: 'v1',
    },
  });
}));

// GET /v1/journal-entries/:id
//
// DOS DEFECTOS QUE SE TAPABAN EL UNO AL OTRO.
//
// El manejador es `async` y NO iba envuelto en `asyncHandler`. Express 4 no
// captura la promesa rechazada de un manejador asíncrono: no llega al
// errorHandler, no hay respuesta, y la petición queda colgada hasta que el
// unhandledRejection de Node —que desde la v15 aborta por omisión— tumba el
// proceso. O sea que el ForbiddenError de la línea siguiente no devolvía 403:
// mataba el servidor. Pedir en bucle asientos ajenos era una negación de
// servicio de una línea, y la disparaba precisamente el control de seguridad.
//
// Y ese control era la forma equivocada: leer sin acotar y comparar después.
// Aun capturado, respondía 403 —«existe, y no es tuyo»— cuando el asiento era
// de otra entidad, y 404 cuando no existía. Eso convierte la ruta en oráculo
// de existencia sobre el mayor ajeno.
//
// Con `requireByIdInScope` las dos cosas se van a la vez: el filtro entra en
// el SQL, los dos casos salen por el mismo 404, y `asyncHandler` lleva el
// error al pipeline en vez de al suelo.
router.get('/:id', requirePermission('journal_entries:read'), asyncHandler(async (req: Request, res: Response) => {
  const { include_lines = 'true' } = req.query;

  const entry = await requireByIdInScope<JournalEntry>(
    'journal_entries',
    req.params.id,
    entityScope(req.tenantId!, req.entityId!)
  ) as JournalEntry & { lines?: JournalEntryLine[] };

  if (include_lines === 'true') {
    entry.lines = await listEntryLines(req.params.id);
  }

  res.json({
    data: entry,
    meta: {
      request_id: req.headers['x-request-id'],
      timestamp: new Date().toISOString(),
      version: 'v1',
    },
  });
}));

// POST /v1/journal-entries
router.post(
  '/',
  requirePermission('journal_entries:create'),
  requireEntityAccess,
  validateBody(createJournalEntrySchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { entity_id, entry_date, entry_type, description, lines, auto_post, reference } = req.body;

    const entry = await createJournalEntry(
      entity_id,
      new Date(entry_date),
      (entry_type || 'standard') as JournalEntryType,
      description || '',
      lines.map((line: Record<string, unknown>) => ({
        account_id: line.account_id as string,
        debit_amount: line.debit_amount ? String(line.debit_amount) : null,
        credit_amount: line.credit_amount ? String(line.credit_amount) : null,
        description: (line.description as string) || '',
        cost_center_id: line.cost_center_id as string,
        project_id: line.project_id as string,
      })),
      req.user!.user_id,
      { autoPost: auto_post, reference }
    );

    res.status(201).json({
      data: entry,
      meta: {
        request_id: req.headers['x-request-id'],
        timestamp: new Date().toISOString(),
        version: 'v1',
      },
    });
  })
);

// POST /v1/journal-entries/:id/post
router.post(
  '/:id/post',
  requirePermission('journal_entries:post'),
  asyncHandler(async (req: Request, res: Response) => {
    await assertEntryAccess(req, req.params.id);
    const entry = await postJournalEntry(req.params.id, req.user!.user_id);
    res.json({
      data: entry,
      meta: {
        request_id: req.headers['x-request-id'],
        timestamp: new Date().toISOString(),
        version: 'v1',
      },
    });
  })
);

// POST /v1/journal-entries/:id/void
router.post(
  '/:id/void',
  requirePermission('journal_entries:void'),
  validateBody(voidJeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { reason } = req.body;
    await assertEntryAccess(req, req.params.id);
    const entry = await voidJournalEntry(req.params.id, req.user!.user_id, reason);
    res.json({
      data: entry,
      meta: {
        request_id: req.headers['x-request-id'],
        timestamp: new Date().toISOString(),
        version: 'v1',
      },
    });
  })
);

// POST /v1/journal-entries/:id/reverse
router.post(
  '/:id/reverse',
  requirePermission('journal_entries:create'),
  validateBody(reverseJeSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { reversal_date } = req.body;
    await assertEntryAccess(req, req.params.id);

    // reverseJournalEntry enforces the guards this route used to lack:
    // only posted entries, at most one reversal, atomic linkage.
    const reversalEntry = await reverseJournalEntry(req.params.id, req.user!.user_id, {
      reversalDate: reversal_date ? new Date(reversal_date) : undefined,
    });

    res.status(201).json({
      data: reversalEntry,
      meta: {
        request_id: req.headers['x-request-id'],
        timestamp: new Date().toISOString(),
        version: 'v1',
      },
    });
  })
);

export default router;
