import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTenant: vi.fn(async (tenantId: string, fn: () => Promise<unknown>) => {
    tenantsEntered.push(tenantId);
    return fn();
  }),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

// Hoisted-safe recorder for the withTenant mock above.
const tenantsEntered: string[] = [];

import { createAiWebhooksRouter } from '../../../src/api/rest/routes/ai-webhooks.js';
import { query } from '../../../src/database/connection.js';
import type { WebhookTokenRow } from '../../../src/ai/webhooks/intake.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

const RAW_TOKEN = 'raw-webhook-secret';
const sha256 = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

const TOKEN: WebhookTokenRow = {
  id: 'tok-1', tenant_id: 'tenant-a', entity_id: 'entity-1', name: 'bank-bbva',
  token_hash: sha256(RAW_TOKEN), source_kind: 'bank_notification', enabled: true,
  created_by: 'ops@acme.mx', created_at: new Date('2026-08-01T00:00:00Z'), last_used_at: null,
};

const DELIVERY = {
  id: 'del-1', token_id: 'tok-1', tenant_id: 'tenant-a', entity_id: 'entity-1',
  document_key: 'tx-777', received_at: new Date(), status: 'received', suspicion: null,
  drafts_created: 0,
};

let server: Server;
let baseUrl: string;
const runReaderTurn = vi.fn().mockResolvedValue(undefined);

beforeAll(async () => {
  const app = express();
  app.use('/v1/ai/webhooks', createAiWebhooksRouter({ runReaderTurn }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(() => {
  mockQuery.mockReset();
  runReaderTurn.mockClear();
  tenantsEntered.length = 0;
});

/**
 * Routes each SQL statement the handler issues to a canned response, so the
 * test controls the token row and the delivery insert outcome.
 */
function primeQueries(opts: {
  tokenRows?: WebhookTokenRow[];
  insertRows?: unknown[];
  priorRows?: unknown[];
}): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM ai_webhook_tokens') && sql.includes('token_hash = $1')) {
      return { rows: opts.tokenRows ?? [], rowCount: (opts.tokenRows ?? []).length };
    }
    if (sql.includes('UPDATE ai_webhook_tokens')) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO ai_webhook_deliveries')) {
      return { rows: opts.insertRows ?? [], rowCount: (opts.insertRows ?? []).length };
    }
    if (sql.includes('FROM ai_webhook_deliveries')) {
      return { rows: opts.priorRows ?? [], rowCount: (opts.priorRows ?? []).length };
    }
    if (sql.includes('UPDATE ai_webhook_deliveries')) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  });
}

function post(path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

/** The JSON body this router returns, on both the success and the error path. */
interface WebhookResponseBody {
  status?: string;
  deliveryId?: string;
  error?: string;
  meta?: { request_id?: string; timestamp?: string; version?: string };
}

/** fetch's `.json()` is `unknown`; the router's JSON shape is known right here. */
async function readBody(res: Response): Promise<WebhookResponseBody> {
  return (await res.json()) as WebhookResponseBody;
}

const AUTH = { authorization: `Bearer ${RAW_TOKEN}` };

describe('POST /v1/ai/webhooks/:tokenName', () => {
  it('401 without an Authorization header', async () => {
    const res = await post('/v1/ai/webhooks/bank-bbva', '{}');
    expect(res.status).toBe(401);
    expect(runReaderTurn).not.toHaveBeenCalled();
  });

  it('401 for an unknown token name', async () => {
    primeQueries({ tokenRows: [] });
    const res = await post('/v1/ai/webhooks/ghost', '{}', AUTH);
    expect(res.status).toBe(401);
  });

  it('401 for a wrong secret (same body as unknown: nothing is confirmed)', async () => {
    primeQueries({ tokenRows: [TOKEN] });
    const res = await post('/v1/ai/webhooks/bank-bbva', '{}', {
      authorization: 'Bearer wrong-secret',
    });
    expect(res.status).toBe(401);
    const wrong = await res.json();

    primeQueries({ tokenRows: [] });
    const res2 = await post('/v1/ai/webhooks/definitely-unknown', '{}', AUTH);
    expect(res2.status).toBe(401);
    expect(await res2.json()).toEqual(wrong);
    expect(runReaderTurn).not.toHaveBeenCalled();
  });

  it('disabled tokens never reach the handler logic (the lookup filters enabled = true)', async () => {
    primeQueries({ tokenRows: [] }); // what the enabled-only SQL returns for a disabled token
    const res = await post('/v1/ai/webhooks/bank-bbva', '{"transaction_id":"tx-1"}', AUTH);
    expect(res.status).toBe(401);
    expect(tenantsEntered).toEqual([]);
  });

  it('200 {status: processed} for a fresh delivery, scoped to the TOKEN tenant', async () => {
    primeQueries({ tokenRows: [TOKEN], insertRows: [DELIVERY] });
    const res = await post(
      '/v1/ai/webhooks/bank-bbva',
      JSON.stringify({ transaction_id: 'tx-777', amount: 100 }),
      AUTH
    );
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.status).toBe('processed');
    expect(body.deliveryId).toBe('del-1');
    // Tenant scoping: everything after auth ran inside withTenant(tenant-a).
    expect(tenantsEntered).toEqual(['tenant-a']);
    expect(runReaderTurn).toHaveBeenCalledTimes(1);
    expect(runReaderTurn.mock.calls[0][0].sessionKey).toBe('webhook:tx-777');
  });

  it('200 {status: duplicate} on replay and the reader is NOT woken again', async () => {
    primeQueries({
      tokenRows: [TOKEN],
      insertRows: [], // ON CONFLICT DO NOTHING
      priorRows: [{ ...DELIVERY, status: 'processed', drafts_created: 1 }],
    });
    const res = await post(
      '/v1/ai/webhooks/bank-bbva',
      JSON.stringify({ transaction_id: 'tx-777', amount: 100 }),
      AUTH
    );
    expect(res.status).toBe(200);
    const body = await readBody(res);
    expect(body.status).toBe('duplicate');
    expect(body.deliveryId).toBe('del-1');
    expect(runReaderTurn).not.toHaveBeenCalled();
  });

  it('415 for a non-JSON content type', async () => {
    primeQueries({ tokenRows: [TOKEN] });
    const res = await post('/v1/ai/webhooks/bank-bbva', 'hello', {
      ...AUTH,
      'content-type': 'text/plain',
    });
    expect(res.status).toBe(415);
    expect(runReaderTurn).not.toHaveBeenCalled();
  });

  it('400 for malformed JSON', async () => {
    primeQueries({ tokenRows: [TOKEN] });
    const res = await post('/v1/ai/webhooks/bank-bbva', '{not json', AUTH);
    expect(res.status).toBe(400);
    expect(runReaderTurn).not.toHaveBeenCalled();
  });

  it('413 for bodies over the 1MB cap', async () => {
    primeQueries({ tokenRows: [TOKEN] });
    const huge = JSON.stringify({ blob: 'x'.repeat(1_100_000) });
    const res = await post('/v1/ai/webhooks/bank-bbva', huge, AUTH);
    expect(res.status).toBe(413);
    expect(runReaderTurn).not.toHaveBeenCalled();
  });

  // ─── App-level integration: body parser exclusion (#15) ───

  it('a real JSON POST through the app stack reaches the handler (200, not 415)', async () => {
    // Reproduces src/index.ts: a GLOBAL json parser that EXCLUDES the webhook
    // path, so the router's own express.raw sees a Buffer instead of an
    // already-parsed body. Without the exclusion every delivery 415s.
    const app = express();
    const jsonParser = express.json({ limit: '10mb' });
    app.use((req, res, next) =>
      req.path.startsWith('/v1/ai/webhooks') ? next() : jsonParser(req, res, next)
    );
    app.use('/v1/ai/webhooks', createAiWebhooksRouter({ runReaderTurn }));
    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = srv.address() as AddressInfo;
      primeQueries({ tokenRows: [TOKEN], insertRows: [DELIVERY] });
      const res = await fetch(`http://127.0.0.1:${port}/v1/ai/webhooks/bank-bbva`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ transaction_id: 'tx-777', amount: 100 }),
      });
      expect(res.status).toBe(200);
      expect((await readBody(res)).status).toBe('processed');
    } finally {
      await new Promise<void>((resolve, reject) =>
        srv.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });

  it('regression: a naive global json parser (no exclusion) would 415 the delivery', async () => {
    // Documents the bug the exclusion fixes: when the global json parser
    // consumes the webhook request, req.body is a parsed object, the router's
    // Buffer.isBuffer check fails, and the delivery is rejected 415.
    const app = express();
    app.use(express.json({ limit: '10mb' }));
    app.use('/v1/ai/webhooks', createAiWebhooksRouter({ runReaderTurn }));
    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = srv.address() as AddressInfo;
      primeQueries({ tokenRows: [TOKEN], insertRows: [DELIVERY] });
      const res = await fetch(`http://127.0.0.1:${port}/v1/ai/webhooks/bank-bbva`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ transaction_id: 'tx-777' }),
      });
      expect(res.status).toBe(415);
    } finally {
      await new Promise<void>((resolve, reject) =>
        srv.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });

  // ─── App-level integration: rate limiter on the mount (#17) ───

  it('a limiter mounted before the router throttles the webhook (429, handler not reached)', async () => {
    // src/index.ts mounts the router as `app.use(path, rateLimiter, router)`,
    // BEFORE the JWT authenticate. A blocking limiter must short-circuit the
    // request before the handler ever queries a token.
    const app = express();
    const blockingLimiter = vi.fn((_req: express.Request, res: express.Response) => {
      res.status(429).json({ error: 'rate limited' });
    });
    app.use('/v1/ai/webhooks', blockingLimiter, createAiWebhooksRouter({ runReaderTurn }));
    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = srv.address() as AddressInfo;
      primeQueries({ tokenRows: [TOKEN], insertRows: [DELIVERY] });
      const res = await fetch(`http://127.0.0.1:${port}/v1/ai/webhooks/bank-bbva`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ transaction_id: 'tx-777' }),
      });
      expect(res.status).toBe(429);
      expect(blockingLimiter).toHaveBeenCalledTimes(1);
      expect(runReaderTurn).not.toHaveBeenCalled();
      // The limiter ran ahead of auth: no token lookup happened.
      expect(mockQuery).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) =>
        srv.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });

  it('a passing limiter lets the delivery through to the handler (200)', async () => {
    const app = express();
    const passLimiter = vi.fn(
      (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
    );
    const jsonParser = express.json({ limit: '10mb' });
    app.use((req, res, next) =>
      req.path.startsWith('/v1/ai/webhooks') ? next() : jsonParser(req, res, next)
    );
    app.use('/v1/ai/webhooks', passLimiter, createAiWebhooksRouter({ runReaderTurn }));
    const srv = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = srv.address() as AddressInfo;
      primeQueries({ tokenRows: [TOKEN], insertRows: [DELIVERY] });
      const res = await fetch(`http://127.0.0.1:${port}/v1/ai/webhooks/bank-bbva`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ transaction_id: 'tx-777' }),
      });
      expect(res.status).toBe(200);
      expect(passLimiter).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        srv.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });

  it('records the delivery as received when no reader is wired', async () => {
    const app = express();
    app.use('/v1/ai/webhooks', createAiWebhooksRouter({}));
    const bare = await new Promise<Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const { port } = bare.address() as AddressInfo;
      primeQueries({ tokenRows: [TOKEN], insertRows: [DELIVERY] });
      const res = await fetch(`http://127.0.0.1:${port}/v1/ai/webhooks/bank-bbva`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...AUTH },
        body: JSON.stringify({ transaction_id: 'tx-777' }),
      });
      expect(res.status).toBe(200);
      expect((await readBody(res)).status).toBe('received');
      expect(runReaderTurn).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) =>
        bare.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});
