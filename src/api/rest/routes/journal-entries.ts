import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../../database/connection.js';
import { requirePermission, requireEntityAccess, assertEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError } from '../../../utils/errors.js';
import {
  createJournalEntry,
  postJournalEntry,
  voidJournalEntry,
  reverseJournalEntry,
} from '../../../services/accounting/index.js';
import type { JournalEntry, JournalEntryLine, PaginationMeta } from '../../../types/index.js';
import { JournalEntryType } from '../../../types/index.js';

const router = Router();

/** Fetches the entry's entity and enforces the caller's membership. */
async function assertEntryAccess(req: Request, entryId: string): Promise<void> {
  const result = await query<{ entity_id: string }>(
    'SELECT entity_id FROM journal_entries WHERE id = $1',
    [entryId]
  );
  if (result.rows.length === 0) throw new NotFoundError('Journal Entry', entryId);
  assertEntityAccess(req.user!, result.rows[0].entity_id);
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
router.get('/', requirePermission('journal_entries:read'), requireEntityAccess, async (req: Request, res: Response) => {
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

  let whereClause = 'WHERE entity_id = $1';
  const params: unknown[] = [entityId];
  let paramIndex = 2;

  if (fiscal_period_id) {
    whereClause += ` AND fiscal_period_id = $${paramIndex++}`;
    params.push(fiscal_period_id);
  }
  if (status) {
    whereClause += ` AND status = $${paramIndex++}`;
    params.push(status);
  }
  if (entry_type) {
    whereClause += ` AND entry_type = $${paramIndex++}`;
    params.push(entry_type);
  }
  if (start_date) {
    whereClause += ` AND entry_date >= $${paramIndex++}`;
    params.push(start_date);
  }
  if (end_date) {
    whereClause += ` AND entry_date <= $${paramIndex++}`;
    params.push(end_date);
  }
  if (source_type) {
    whereClause += ` AND source_type = $${paramIndex++}`;
    params.push(source_type);
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM journal_entries ${whereClause}`,
    params
  );
  const totalCount = parseInt(countResult.rows[0].count, 10);

  const result = await query<JournalEntry>(
    `SELECT * FROM journal_entries ${whereClause}
     ORDER BY entry_date DESC, created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, perPage, offset]
  );

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
});

// GET /v1/journal-entries/:id
router.get('/:id', requirePermission('journal_entries:read'), async (req: Request, res: Response) => {
  const { include_lines = 'true' } = req.query;

  const entryResult = await query<JournalEntry>(
    'SELECT * FROM journal_entries WHERE id = $1',
    [req.params.id]
  );

  if (entryResult.rows.length === 0) {
    throw new NotFoundError('Journal Entry', req.params.id);
  }

  const entry = entryResult.rows[0] as JournalEntry & { lines?: JournalEntryLine[] };
  assertEntityAccess(req.user!, entry.entity_id);

  if (include_lines === 'true') {
    const linesResult = await query<JournalEntryLine & { account_code: string; account_name: string }>(
      `SELECT jel.*, a.code as account_code, a.name as account_name
       FROM journal_entry_lines jel
       JOIN accounts a ON a.id = jel.account_id
       WHERE jel.journal_entry_id = $1
       ORDER BY jel.line_number`,
      [req.params.id]
    );
    entry.lines = linesResult.rows;
  }

  res.json({
    data: entry,
    meta: {
      request_id: req.headers['x-request-id'],
      timestamp: new Date().toISOString(),
      version: 'v1',
    },
  });
});

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
