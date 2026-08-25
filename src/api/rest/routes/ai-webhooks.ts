import express, { Router, Request, Response } from 'express';
import { withTenant } from '../../../database/connection.js';
import { asyncHandler } from '../middleware/async-handler.js';
import {
  verifyWebhookToken,
  touchWebhookToken,
  deriveDocumentKey,
  recordDelivery,
} from '../../../ai/webhooks/intake.js';
import {
  processDelivery,
  type RunReaderTurn,
  type ProcessDeliveryOutcome,
} from '../../../ai/webhooks/reader-agent.js';
import { scanImportedText } from '../../../ai/ingest-service.js';

// ============================================================
// INBOUND AI WEBHOOKS (item 22)
// POST /v1/ai/webhooks/:tokenName — authenticated by a DEDICATED
// bearer token (ai_webhook_tokens, sha256-hashed), never a user
// JWT: this router must be mounted BEFORE the /v1 authenticate
// middleware (like the public verification routes).
//
// The handler: verify token (constant-time) → enter the token's
// tenant (withTenant — enterTenant would leak across requests in
// a server) → record the delivery idempotently → wake the
// RESTRICTED reader only for first-seen documents. Duplicates
// return the prior delivery and never re-wake the agent.
//
// Body: JSON only, 1MB cap. Read raw (express.raw) so the
// idempotency fallback hashes the exact bytes on the wire.
// ============================================================

const MAX_BODY = '1mb';

export interface AiWebhooksRouterDeps {
  /**
   * LLM wiring (RunAgentTurn pattern). When absent, deliveries are recorded
   * as 'received' and left for a worker/CLI to process — the HTTP path never
   * fails open into an unrestricted agent.
   */
  runReaderTurn?: RunReaderTurn;
}

function unauthorized(res: Response): void {
  res.status(401).json({ error: 'Unknown or disabled webhook token' });
}

export function createAiWebhooksRouter(deps: AiWebhooksRouterDeps = {}): Router {
  const router = Router();

  // Raw bytes, JSON content type only, hard 1MB cap.
  const rawParser = express.raw({ type: 'application/json', limit: MAX_BODY });

  router.post(
    '/:tokenName',
    // Own the parser's failure modes here: a body over the cap would otherwise
    // reach the global error handler as an unmapped 500. An oversized body is
    // 413, an unreadable one 400 — neither confirms whether the token exists.
    (req: Request, res: Response, next) =>
      rawParser(req, res, (err: unknown) => {
        if (!err) return next();
        const status = (err as { status?: number }).status === 413 ? 413 : 400;
        return res.status(status).json({
          error: status === 413 ? 'Body exceeds the 1MB limit' : 'Malformed request body',
        });
      }),
    asyncHandler(async (req: Request, res: Response) => {
      const header = req.headers.authorization ?? '';
      const [scheme, rawToken] = header.split(' ');
      if (scheme !== 'Bearer' || !rawToken) {
        return unauthorized(res);
      }

      const token = await verifyWebhookToken(rawToken, req.params.tokenName);
      if (!token) {
        // Same response for unknown name, disabled token and bad secret:
        // the endpoint confirms nothing to a prober.
        return unauthorized(res);
      }

      // express.raw only populates a Buffer for matching content types.
      if (!Buffer.isBuffer(req.body)) {
        return res.status(415).json({ error: 'Content-Type must be application/json' });
      }
      const rawBody = req.body.toString('utf8');
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return res.status(400).json({ error: 'Body must be valid JSON' });
      }

      // Everything past authentication is scoped to the TOKEN's tenant.
      const outcome = await withTenant(token.tenant_id, async () => {
        await touchWebhookToken(token);

        const documentKey = deriveDocumentKey(token.source_kind, body, rawBody);
        const scan = scanImportedText(rawBody);
        const recorded = await recordDelivery(token, {
          documentKey,
          suspicion: scan.reasons,
        });

        if (recorded.duplicate) {
          // Idempotent replay: prior delivery, agent NOT woken.
          return { status: 'duplicate' as const, deliveryId: recorded.delivery.id };
        }

        if (!deps.runReaderTurn) {
          return { status: 'received' as const, deliveryId: recorded.delivery.id };
        }

        const processed: ProcessDeliveryOutcome = await processDelivery({
          token,
          delivery: recorded.delivery,
          rawBody,
          runReaderTurn: deps.runReaderTurn,
        });
        // An agent error still acknowledges receipt: the delivery is stored
        // ('received') and a retry resumes the same session transcript.
        return {
          status: processed.status === 'processed' ? ('processed' as const) : ('received' as const),
          deliveryId: processed.deliveryId,
        };
      });

      res.json({
        status: outcome.status,
        deliveryId: outcome.deliveryId,
        meta: {
          request_id: req.headers['x-request-id'],
          timestamp: new Date().toISOString(),
          version: 'v1',
        },
      });
    })
  );

  return router;
}

export default createAiWebhooksRouter();
