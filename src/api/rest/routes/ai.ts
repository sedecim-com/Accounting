import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { boundedString } from '../../../utils/zod-compat.js';
import { requirePermission, requireEntityAccess } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { ValidationError } from '../../../utils/errors.js';
import { parseForClient } from '../../../utils/zod-client-errors.js';
import { withTenant } from '../../../database/connection.js';
import { resolveEntity } from '../../../ai/context.js';
import {
  listDrafts, approveDraft, rejectDraft, DraftValidationError,
} from '../../../ai/draft-service.js';
import {
  listQuestions, answerQuestion, dismissQuestion, searchPrecedents,
} from '../../../ai/question-service.js';
import type { AgentContext } from '../../../ai/context.js';
import { declararRiesgoRuta } from '../risk.js';

const router = Router();

// ============================================================
// /v1/ai — the surface the CLI was missing to stop being a
// database client.
//
// The eleven READ tools already had endpoints (accounts,
// customers, vendors, journal-entries and the six reports). Here go
// the ones that did not: drafts, questions and precedents.
//
// Each request runs inside withTenant() — the form that SCOPES, not
// enterWith() — because a server handles many tenants in the same
// process and the context must not outlive the request.
// ============================================================

/**
 * The context the services expect, built from the token.
 * The entity comes from the x-entity-id header already validated by
 * requireEntityAccess: the model never chooses it.
 */
async function contextFrom(req: Request): Promise<AgentContext> {
  const entityId = req.entityId;
  if (!entityId) throw new ValidationError('Missing entity: send x-entity-id');
  return resolveEntity(entityId);
}

/** Wraps the handler in the token's tenant. */
function scoped(fn: (req: Request, res: Response, ctx: AgentContext) => Promise<void>) {
  return asyncHandler(async (req: Request, res: Response) => {
    const tenantId = req.tenantId;
    if (!tenantId) throw new ValidationError('The token carries no tenant');
    await withTenant(tenantId, async () => {
      const ctx = await contextFrom(req);
      await fn(req, res, ctx);
    });
  });
}

const meta = (req: Request) => ({
  request_id: req.headers['x-request-id'],
  timestamp: new Date().toISOString(),
  version: 'v1',
});

// ─── Schemas ───
const reviewNotesSchema = z.object({ notes: boundedString({ max: 2000 }).optional() });
const rejectSchema = z.object({ reason: boundedString({ min: 1, max: 2000 }) });
const answerSchema = z.object({
  answer: boundedString({ min: 1, max: 4000 }),
  is_precedent: z.boolean().optional(),
});
const draftStatus = z.enum(['pending_review', 'approved', 'rejected']);

/**
 * Validates one query-string parameter. A bare `.parse()` threw a ZodError,
 * which is not an AppError, so errorHandler answered 500 to a client typo
 * (#315). This answers what `validateBody` answers for a bad body: 422
 * VALIDATION_ERROR in the API error envelope, worded by the same
 * zod-client-errors module, with the parameter named in `field`.
 */
function parseQuery<T>(schema: z.ZodType<T>, req: Request, name: string): T {
  const parsed = parseForClient<T>(schema, req.query[name]);
  if (!parsed.success) {
    const details = parsed.issues.map((issue) => issue.message).join('; ');
    throw new ValidationError(`Invalid query parameter: ${name}: ${details}`, name);
  }
  return parsed.data;
}
const questionStatus = z.enum(['pending', 'answered', 'dismissed']);

// ─── Drafts ───

router.get('/drafts', requirePermission('journal_entries:read'), requireEntityAccess,
  scoped(async (req, res, ctx) => {
    const status = parseQuery(draftStatus.optional(), req, 'status');
    const drafts = await listDrafts(ctx, status, { limit: 100, newestFirst: true });
    res.json({ data: drafts, meta: meta(req) });
  })
);

// LA PUERTA DE LOS CUATRO OJOS, y por eso `agente: false` esta escrito
// aunque sea el valor por omision: esta ruta aprueba lo que el agente
// propuso, y si el agente pudiera llamarla proponer y disponer serian el
// mismo acto. `declararRiesgoRuta` ya lo impediria —irreversible y agente
// juntos no compilan— pero la razon merece leerse aqui.
router.post('/drafts/:id/approve', declararRiesgoRuta({ riesgo: 'irreversible', agente: false, escribe: 'journal_entries + journal_entry_lines POSTEADOS al aprobar el borrador; ai_drafts.status; bills + bill_lines + pre_registrations cuando el borrador viene de un CFDI recibido (#318)' }), requirePermission('journal_entries:create'), requireEntityAccess,
  validateBody(reviewNotesSchema),
  scoped(async (req, res, ctx) => {
    // The reviewer is the token's subject, not "the first active user": the
    // journal entry has to be attributed to whoever actually approved it.
    const reviewer = { userId: req.user!.user_id, email: req.user!.email };
    try {
      const posted = await approveDraft(ctx, req.params.id, reviewer, req.body.notes);
      res.json({ data: posted, meta: meta(req) });
    } catch (err) {
      if (err instanceof DraftValidationError) {
        throw new ValidationError(err.message, undefined, { errors: err.errors });
      }
      throw err;
    }
  })
);

router.post('/drafts/:id/reject', declararRiesgoRuta({ riesgo: 'escritura', agente: false, escribe: 'ai_drafts.status + el motivo del revisor' }), requirePermission('journal_entries:create'), requireEntityAccess,
  validateBody(rejectSchema),
  scoped(async (req, res, ctx) => {
    const reviewer = { userId: req.user!.user_id, email: req.user!.email };
    await rejectDraft(ctx, req.params.id, reviewer, req.body.reason);
    res.json({ data: { rejected: true }, meta: meta(req) });
  })
);

// ─── Questions and precedents ───

router.get('/questions', requirePermission('journal_entries:read'), requireEntityAccess,
  scoped(async (req, res, ctx) => {
    const status = parseQuery(questionStatus.optional(), req, 'status');
    const questions = await listQuestions(ctx, status);
    res.json({ data: questions, meta: meta(req) });
  })
);

router.post('/questions/:id/answer', declararRiesgoRuta({ riesgo: 'escritura', agente: false, escribe: 'ai_questions.answer + precedentes' }), requirePermission('journal_entries:create'), requireEntityAccess,
  validateBody(answerSchema),
  scoped(async (req, res, ctx) => {
    await answerQuestion(ctx, req.params.id, req.body.answer, req.user!.email, req.body.is_precedent ?? true);
    res.json({ data: { answered: true }, meta: meta(req) });
  })
);

router.post('/questions/:id/dismiss', declararRiesgoRuta({ riesgo: 'escritura', agente: false, escribe: 'ai_questions.status' }), requirePermission('journal_entries:create'), requireEntityAccess,
  scoped(async (req, res, ctx) => {
    await dismissQuestion(ctx, req.params.id, req.user!.email);
    res.json({ data: { dismissed: true }, meta: meta(req) });
  })
);

router.get('/precedents', requirePermission('journal_entries:read'), requireEntityAccess,
  scoped(async (req, res, ctx) => {
    const search = parseQuery(boundedString({ min: 1 }), req, 'search');
    const precedents = await searchPrecedents(ctx, search);
    res.json({ data: precedents, meta: meta(req) });
  })
);

export default router;
