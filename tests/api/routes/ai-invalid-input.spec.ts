import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ============================================================
// /v1/ai answers invalid input with a 4xx in the API error envelope (#315).
//
// The three GET routes validated their query string with Zod's `.parse()`
// inside the handler. A ZodError is not an AppError, so the error handler
// rendered it as a 500 INTERNAL_SERVER_ERROR: the client was told the server
// had failed when the request was the problem, and the metrics counted a
// typo as an outage. The POST routes validate with `validateBody`, which
// already answers 422; they are pinned here too, one case per route, so the
// whole router keeps a single answer to bad input.
//
// Authentication, the tenant scope and the services are stubbed: what is
// under test is only how the router turns invalid input into a response.
// ============================================================

vi.mock('../../../src/api/rest/middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/rest/middleware/auth.js')>()),
  requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
  requireEntityAccess: (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTenant: vi.fn(async (_tenantId: string, fn: () => Promise<unknown>) => fn()),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

vi.mock('../../../src/ai/context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ai/context.js')>()),
  resolveEntity: vi.fn(async (id: string) => ({ entityId: id, entityName: 'Acme', tenantId: 'tenant-a' })),
}));

vi.mock('../../../src/ai/draft-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ai/draft-service.js')>()),
  listDrafts: vi.fn(async () => []),
  approveDraft: vi.fn(async () => ({})),
  rejectDraft: vi.fn(async () => undefined),
}));

vi.mock('../../../src/ai/question-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/ai/question-service.js')>()),
  listQuestions: vi.fn(async () => []),
  answerQuestion: vi.fn(async () => undefined),
  dismissQuestion: vi.fn(async () => undefined),
  searchPrecedents: vi.fn(async () => []),
}));

import aiRouter from '../../../src/api/rest/routes/ai.js';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';
import { listDrafts, approveDraft, rejectDraft } from '../../../src/ai/draft-service.js';
import { listQuestions, answerQuestion, searchPrecedents } from '../../../src/ai/question-service.js';

interface Envelope {
  errors?: Array<{ code: string; message: string; field?: string }>;
  meta?: { request_id?: string; version?: string };
  data?: unknown;
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.headers['x-request-id'] = 'req-315';
    req.tenantId = 'tenant-a';
    req.entityId = 'entity-1';
    req.user = { user_id: 'u-1', email: 'ops@acme.mx' } as express.Request['user'];
    next();
  });
  app.use('/v1/ai', aiRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<{ status: number; json: Envelope }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Envelope };
}

/** The API error envelope: one error with a stable code, and the request's meta. */
function expectValidationEnvelope(json: Envelope, messagePattern: RegExp): void {
  expect(json.errors).toHaveLength(1);
  expect(json.errors?.[0].code).toBe('VALIDATION_ERROR');
  expect(json.errors?.[0].message).toMatch(messagePattern);
  expect(json.meta?.request_id).toBe('req-315');
  expect(json.meta?.version).toBe('v1');
}

describe('/v1/ai query strings: invalid input is a 422 in the envelope, not a 500', () => {
  it('GET /drafts?status=bogus answers 422 and never reaches the service', async () => {
    const { status, json } = await call('GET', '/v1/ai/drafts?status=bogus');
    expect(status).toBe(422);
    expectValidationEnvelope(json, /^Invalid query parameter: status: /);
    expect(json.errors?.[0].field).toBe('status');
    expect(listDrafts).not.toHaveBeenCalled();
  });

  it('GET /questions?status=bogus answers 422 and never reaches the service', async () => {
    const { status, json } = await call('GET', '/v1/ai/questions?status=bogus');
    expect(status).toBe(422);
    expectValidationEnvelope(json, /^Invalid query parameter: status: /);
    expect(listQuestions).not.toHaveBeenCalled();
  });

  it('GET /precedents without search answers 422 and never reaches the service', async () => {
    const { status, json } = await call('GET', '/v1/ai/precedents');
    expect(status).toBe(422);
    expectValidationEnvelope(json, /^Invalid query parameter: search: /);
    expect(json.errors?.[0].field).toBe('search');
    expect(searchPrecedents).not.toHaveBeenCalled();
  });

  it('a repeated query key (an array, not a string) is also a 422', async () => {
    const { status, json } = await call('GET', '/v1/ai/precedents?search=a&search=b');
    expect(status).toBe(422);
    expectValidationEnvelope(json, /^Invalid query parameter: search: /);
  });

  it('valid query strings still reach the services', async () => {
    expect((await call('GET', '/v1/ai/drafts?status=approved')).status).toBe(200);
    expect(listDrafts).toHaveBeenCalledWith(expect.anything(), 'approved', expect.anything());
    expect((await call('GET', '/v1/ai/questions')).status).toBe(200);
    expect(listQuestions).toHaveBeenCalledWith(expect.anything(), undefined);
    expect((await call('GET', '/v1/ai/precedents?search=rent')).status).toBe(200);
    expect(searchPrecedents).toHaveBeenCalledWith(expect.anything(), 'rent');
  });
});

describe('/v1/ai bodies: invalid input is a 422 in the envelope', () => {
  it('POST /drafts/:id/approve with a non-string note', async () => {
    const { status, json } = await call('POST', '/v1/ai/drafts/d-1/approve', { notes: 42 });
    expect(status).toBe(422);
    expectValidationEnvelope(json, /^Invalid request body: notes: /);
    expect(approveDraft).not.toHaveBeenCalled();
  });

  it('POST /drafts/:id/reject without a reason', async () => {
    const { status, json } = await call('POST', '/v1/ai/drafts/d-1/reject', {});
    expect(status).toBe(422);
    expectValidationEnvelope(json, /^Invalid request body: reason: /);
    expect(rejectDraft).not.toHaveBeenCalled();
  });

  it('POST /questions/:id/answer with a non-boolean is_precedent', async () => {
    const { status, json } = await call('POST', '/v1/ai/questions/q-1/answer', { answer: 'yes', is_precedent: 'yes' });
    expect(status).toBe(422);
    expectValidationEnvelope(json, /^Invalid request body: is_precedent: /);
    expect(answerQuestion).not.toHaveBeenCalled();
  });
});
