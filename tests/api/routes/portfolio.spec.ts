import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ============================================================
// W1 · GET /v1/portfolio, wired as the server wires it, database mocked.
//
// What this spec pins is the route's side of the boundary: which values reach
// the statement, and what the request can and cannot change about them. The
// statement itself, against Postgres and with a sibling entity and a foreign
// tenant in play, is proven by tests/integration/portfolio-boundary.int.spec.ts
// and by the conduct criterion portfolio-rows-are-token-entities-within-tenant.
//
// The authenticated app runs the REAL `authenticate` with an HS256 token, so
// `x-entity-id` goes through the same resolution it goes through in the
// server: a header naming a granted entity is accepted and must still not
// narrow the set.
// ============================================================

const calls: Array<{ text: string; params: unknown[] }> = [];

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    return {
      rows: [
        {
          as_of_date: '2026-09-15',
          entity_id: '11111111-1111-4111-8111-111111111111',
          name: 'Alpha SA de CV',
          is_active: true,
          current_period_id: '99999999-9999-4999-8999-999999999999',
          current_period_name: 'Periodo 9/2026',
          current_period_status: 'open',
          current_period_start: '2026-09-01',
          current_period_end: '2026-09-30',
          ended_open_periods: 2,
          pending_drafts: 3,
          pending_questions: 1,
        },
      ],
      rowCount: 1,
    };
  }),
  withTransaction: vi.fn(),
  withTenant: vi.fn(async (_t: string, fn: () => Promise<unknown>) => fn()),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
  getClient: vi.fn(),
  setTenantSchema: vi.fn(),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getPool: vi.fn(),
}));

import portfolioRouter from '../../../src/api/rest/routes/portfolio.js';
import { authenticate } from '../../../src/api/rest/middleware/auth.js';
import { preAuthRateLimiter } from '../../../src/api/rest/middleware/rate-limiter.js';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';
import { config } from '../../../src/config/index.js';

const TENANT = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const ALPHA = '11111111-1111-4111-8111-111111111111';
const BETA = '22222222-2222-4222-8222-222222222222';

let authenticated: { server: Server; url: string };
let bare: { server: Server; url: string };

async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

beforeAll(async () => {
  const withAuth = express();
  // Before authenticate, as src/index.ts mounts it: verifying a signature is
  // CPU, and free CPU for whoever has no credentials is what the limiter is for.
  withAuth.use(preAuthRateLimiter);
  withAuth.use(authenticate);
  withAuth.use('/v1/portfolio', portfolioRouter);
  withAuth.use(errorHandler);
  authenticated = await listen(withAuth);

  // No authenticate at all: the route's own guard is what answers.
  const withoutAuth = express();
  withoutAuth.use('/v1/portfolio', portfolioRouter);
  withoutAuth.use(errorHandler);
  bare = await listen(withoutAuth);
});

afterAll(async () => {
  for (const s of [authenticated, bare]) {
    await new Promise<void>((resolve) => s.server.close(() => resolve()));
  }
});

beforeEach(() => {
  calls.length = 0;
});

function tokenFor(entities: unknown[], permissions: string[] = ['accounts:read', 'journal_entries:read']): string {
  return jwt.sign(
    {
      user_id: 'u-1',
      tenant_id: TENANT,
      email: 'reader@example.test',
      roles: ['viewer'],
      permissions,
      entities,
      session_id: 's-1',
    },
    config.jwt.secret,
    { expiresIn: '5m' }
  );
}

async function get(
  base: string,
  path: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}${path}`, { headers });
  const text = await r.text();
  return { status: r.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

const firstErrorCode = (body: Record<string, unknown>): string | undefined =>
  (body.errors as Array<{ code: string }> | undefined)?.[0]?.code;

describe('GET /v1/portfolio', () => {
  it('answers 200 with the rows and the meta the board reads', async () => {
    const r = await get(authenticated.url, '/v1/portfolio', {
      authorization: `Bearer ${tokenFor([ALPHA])}`,
      'x-request-id': 'req-1',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual([
      {
        entity_id: ALPHA,
        name: 'Alpha SA de CV',
        is_active: true,
        current_period: {
          id: '99999999-9999-4999-8999-999999999999',
          name: 'Periodo 9/2026',
          status: 'open',
          start_date: '2026-09-01',
          end_date: '2026-09-30',
        },
        ended_open_periods: 2,
        pending_drafts: 3,
        pending_questions: 1,
      },
    ]);
    const meta = r.body.meta as Record<string, unknown>;
    expect(meta.request_id).toBe('req-1');
    expect(typeof meta.timestamp).toBe('string');
    expect(meta.version).toBe('v1');
    expect(meta.as_of_date).toBe('2026-09-15');
    expect(meta.omitted).toEqual({ unresolved: 0 });
    expect(meta.not_evaluated).toEqual(['close_readiness']);
  });

  it('binds exactly the token entities and the token tenant, in one statement', async () => {
    const r = await get(authenticated.url, '/v1/portfolio', {
      authorization: `Bearer ${tokenFor([ALPHA, BETA, 'not-a-uuid'])}`,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].params).toEqual([[ALPHA, BETA], TENANT]);
    expect(calls[0].text).toContain('e.id = ANY($1::uuid[]) AND e.tenant_id = $2');
    // Two valid ids resolved into one row, plus the malformed one.
    expect((r.body.meta as { omitted: unknown }).omitted).toEqual({ unresolved: 2 });
  });

  it('a granted x-entity-id does not narrow the set', async () => {
    const r = await get(authenticated.url, '/v1/portfolio', {
      authorization: `Bearer ${tokenFor([ALPHA, BETA])}`,
      'x-entity-id': BETA,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(calls[0].params).toEqual([[ALPHA, BETA], TENANT]);
  });

  it('an x-entity-id the token does not grant is refused before the handler runs', async () => {
    const r = await get(authenticated.url, '/v1/portfolio', {
      authorization: `Bearer ${tokenFor([ALPHA])}`,
      'x-entity-id': BETA,
    });
    expect(r.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("the '*' permission authorises the read but adds no entity", async () => {
    const r = await get(authenticated.url, '/v1/portfolio', {
      authorization: `Bearer ${tokenFor([ALPHA], ['*'])}`,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(calls[0].params).toEqual([[ALPHA], TENANT]);
  });

  it('duplicate and differently cased ids reach the statement once', async () => {
    const r = await get(authenticated.url, '/v1/portfolio', {
      authorization: `Bearer ${tokenFor([ALPHA, ALPHA.toUpperCase()])}`,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(calls[0].params).toEqual([[ALPHA], TENANT]);
    expect((r.body.meta as { omitted: unknown }).omitted).toEqual({ unresolved: 0 });
  });

  it.each(['?entity_id=22222222-2222-4222-8222-222222222222', '?foo=bar', '?status=open'])(
    'a query string (%s) is a 422 and never reaches the database',
    async (search) => {
      const r = await get(authenticated.url, `/v1/portfolio${search}`, {
        authorization: `Bearer ${tokenFor([ALPHA])}`,
      });
      expect(r.status, JSON.stringify(r.body)).toBe(422);
      expect(firstErrorCode(r.body)).toBe('VALIDATION_ERROR');
      expect(calls).toHaveLength(0);
    }
  );

  it.each([[['accounts:read']], [['journal_entries:read']]])(
    'with only %j it is a 403 FORBIDDEN: the permission is a conjunction',
    async (permissions) => {
      const r = await get(authenticated.url, '/v1/portfolio', {
        authorization: `Bearer ${tokenFor([ALPHA], permissions)}`,
      });
      expect(r.status).toBe(403);
      expect(firstErrorCode(r.body)).toBe('FORBIDDEN');
      expect(calls).toHaveLength(0);
    }
  );

  it('with no user on the request it is a 401', async () => {
    const r = await get(bare.url, '/v1/portfolio');
    expect(r.status).toBe(401);
    expect(firstErrorCode(r.body)).toBe('UNAUTHORIZED');
    expect(calls).toHaveLength(0);
  });

  it('a token whose tenant is not a UUID is a 401, not a statement', async () => {
    const token = jwt.sign(
      {
        user_id: 'u-1',
        tenant_id: 't-1',
        email: 'reader@example.test',
        roles: ['viewer'],
        permissions: ['*'],
        entities: [ALPHA],
        session_id: 's-1',
      },
      config.jwt.secret,
      { expiresIn: '5m' }
    );
    const r = await get(authenticated.url, '/v1/portfolio', { authorization: `Bearer ${token}` });
    expect(r.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});
