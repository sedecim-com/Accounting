import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, type Mock } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================
// GET /ready with the database down tells the caller nothing about the
// infrastructure (#315).
//
// /ready is mounted before authentication, for the orchestrator's probe and
// the load balancer. It used to put the driver's `err.message` in the 503
// body, and a Postgres error names the host, the port, the role or the
// database: infrastructure served to anyone who asks. The body now carries
// only the stable `db: 'error'`; the detail goes to the log, tied to the
// request's correlation id so an operator can still find it.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTenant: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

import { query } from '../../../src/database/connection.js';
import { readyHandler } from '../../../src/api/rest/readiness.js';
import { correlationIdMiddleware } from '../../../src/api/rest/middleware/correlation.js';
import { logger } from '../../../src/utils/logger.js';

const mockQuery = query as unknown as Mock;

// What node-postgres says when the server is unreachable, the role is refused, the database is missing.
const LEAKY_ERRORS = [
  'connect ECONNREFUSED 10.20.30.40:6543',
  'password authentication failed for user "mnemosine_owner"',
  'database "acme_prod_ledger" does not exist',
];

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(correlationIdMiddleware);
  app.get('/ready', readyHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

beforeEach(() => {
  mockQuery.mockReset();
  vi.restoreAllMocks();
});

describe('GET /ready', () => {
  it('200 with db ok when the database answers', async () => {
    mockQuery.mockResolvedValue({ rows: [{ '?column?': 1 }], rowCount: 1 });
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ready', db: 'ok' });
  });

  for (const leak of LEAKY_ERRORS) {
    it(`503 with db error and no driver text when the database fails: ${leak}`, async () => {
      mockQuery.mockRejectedValue(new Error(leak));
      const logged = vi.spyOn(logger, 'error').mockImplementation(() => logger);

      const res = await fetch(`${baseUrl}/ready`, { headers: { 'x-request-id': 'probe-315' } });

      expect(res.status).toBe(503);
      const raw = await res.text();
      const body = JSON.parse(raw) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['db', 'status', 'timestamp']);
      expect(body).toMatchObject({ status: 'not_ready', db: 'error' });
      // Not a single fragment of the driver's message reaches the client.
      for (const fragment of leak.split(/[\s:"]+/).filter((w) => w.length > 3)) {
        expect(raw).not.toContain(fragment);
      }

      // The detail is not lost: it is logged with the correlation id.
      expect(logged).toHaveBeenCalledWith(
        'ready_db_error',
        expect.objectContaining({ request_id: 'probe-315', error: leak })
      );
    });
  }

  it("the driver's code (SQLSTATE or errno) is logged, for an alert rule to branch on", async () => {
    mockQuery.mockRejectedValue(
      Object.assign(new Error('password authentication failed for user "owner"'), { code: '28P01' })
    );
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('28P01');
    expect(logged).toHaveBeenCalledWith('ready_db_error', expect.objectContaining({ code: '28P01' }));
  });

  it('a non-Error rejection is also kept out of the body and logged as text', async () => {
    mockQuery.mockRejectedValue('socket hang up at db.internal:5432');
    const logged = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const res = await fetch(`${baseUrl}/ready`);
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain('db.internal');
    expect(logged).toHaveBeenCalledWith(
      'ready_db_error',
      expect.objectContaining({ error: 'socket hang up at db.internal:5432' })
    );
  });
});

// ============================================================
// src/index.ts serves THIS handler on /ready, and serves it before authenticate.
//
// Everything above exercises readyHandler alone. Booting src/index.ts needs a
// database, so what pins the wiring is the source itself, read without its
// comments (the way tests/api/middleware/locale.spec.ts pins its mount order):
// if the old inline handler that leaked err.message came back, this goes red.
// ============================================================

const indexSource = readFileSync(join(__dirname, '..', '..', '..', 'src', 'index.ts'), 'utf-8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('src/index.ts mounts readyHandler on /ready', () => {
  it('as the one and only /ready route, at the top level of bootstrap', () => {
    expect(indexSource.match(/^ {2}app\.get\('\/ready', readyHandler\);$/gm) ?? []).toHaveLength(1);
    expect(indexSource.match(/['"`]\/ready['"`]/g) ?? []).toHaveLength(1);
  });

  it('before authenticate', () => {
    const ready = indexSource.indexOf("app.get('/ready', readyHandler);");
    const auth = indexSource.indexOf('app.use(apiPrefix, authenticate);');
    expect(ready).toBeGreaterThanOrEqual(0);
    expect(auth).toBeGreaterThan(0);
    expect(ready).toBeLessThan(auth);
  });
});
