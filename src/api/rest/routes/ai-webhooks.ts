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
import { declararRiesgoRuta } from '../risk.js';

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
   * LLM wiring (RunAgentTurn pattern). When absent, the delivery is recorded
   * as 'received' and the payload is DROPPED — the HTTP path never fails open
   * into an unrestricted agent, but neither does it park the document
   * anywhere. See NO_RETENIDO: nothing reprocesses a 'received' row.
   */
  runReaderTurn?: RunReaderTurn;
}

// ============================================================
// LO QUE EL 200 NO PUEDE PROMETER
//
// El cuerpo se lee (express.raw), se le deriva la clave, se le
// pasa el escáner de sospecha… y se tira. ai_webhook_deliveries
// guarda la clave, las RAZONES de sospecha y los contadores; el
// payload no tiene columna. Nos quedamos con la acusación y no
// con la prueba.
//
// Y 'received' es un estado TERMINAL disfrazado de intermedio:
//   · processDelivery() tiene un solo llamador — esta petición.
//     No hay worker ni comando que retome un 'received' (`webhooks
//     deliveries` es de lectura).
//   · un reenvío del mismo documento choca contra
//     UNIQUE(token_id, document_key): recordDelivery lo devuelve
//     como duplicate y la ruta sale por esa rama SIN despertar al
//     lector. El reintento que arreglaría el fallo se traga.
// O sea que contestar 200 «received» a un banco promete una
// segunda oportunidad que no existe.
//
// Persistir el cuerpo antes del 200 exige columna o tabla nueva
// (migración) y retirar la superficie es decisión de producto:
// ninguna de las dos se toma aquí. Lo que sí se puede hacer sin
// decidir nada es dejar de prometerlo — quien reciba este 200 lee
// en la misma respuesta que no quedó guardado nada y que reenviar
// no lo arregla. El campo es aditivo: no rompe a ningún cliente.
// ============================================================

const NO_RETENIDO =
  'Delivery logged, but NOT processed and the payload was NOT stored: only the document ' +
  'key and the suspicion flags are kept. Nothing reprocesses it later, and re-sending the ' +
  'same document returns "duplicate" without processing it. Recover the document from the ' +
  'source system.';

function unauthorized(res: Response): void {
  res.status(401).json({ error: 'Unknown or disabled webhook token' });
}

export function createAiWebhooksRouter(deps: AiWebhooksRouterDeps = {}): Router {
  const router = Router();

  // Raw bytes, JSON content type only, hard 1MB cap.
  const rawParser = express.raw({ type: 'application/json', limit: MAX_BODY });

  router.post(
    '/:tokenName',
    declararRiesgoRuta({
      riesgo: 'escritura',
      escribe: 'webhook_deliveries: clave del documento y banderas de sospecha. El cuerpo NO se guarda.',
    }),
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
        // Un fallo del lector deja la fila en 'received' y ahí se queda: el
        // reenvío que la resucitaría sale antes por la rama duplicate. El 200
        // acusa recibo del AVISO, no del trabajo — lo dice NO_RETENIDO.
        return {
          status: processed.status === 'processed' ? ('processed' as const) : ('received' as const),
          deliveryId: processed.deliveryId,
        };
      });

      res.json({
        status: outcome.status,
        deliveryId: outcome.deliveryId,
        // 'processed' dejó borradores; 'duplicate' informa de una fila previa
        // real. 'received' es el único que no cumple nada: se avisa.
        ...(outcome.status === 'received' ? { warning: NO_RETENIDO } : {}),
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
