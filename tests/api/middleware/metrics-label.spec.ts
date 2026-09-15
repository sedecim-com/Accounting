import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  UNMATCHED_ROUTE_LABEL,
  httpRequestsTotal,
  metricsMiddleware,
} from '../../../src/api/rest/middleware/metrics.js';

// ============================================================
// W0 · the route label of an unmatched request is bounded.
//
// `/metrics` is served without credentials and prom-client keeps every label
// set for the life of the process. While the fallback label was the literal
// request path, each random path minted a permanent series: anyone could grow
// the scrape and the heap one request at a time. This spec drives a real
// Express app over a socket, so the label is the one the middleware computes
// on 'finish', not one a test hands to the counter.
// ============================================================

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(metricsMiddleware);
  const employees = express.Router();
  employees.get('/:id', (req, res) => {
    res.json({ id: req.params.id });
  });
  app.use('/v1/employees', employees);
  // Stand in for `authenticate`: it answers 401 before any router runs, so the
  // request never has a `req.route`. That is the shape the audit reproduced
  // (docs/auditorias/2026-09-01-integral-iii/superficies-no-cli.md, finding 12).
  app.use('/v1/private', (_req, res) => {
    res.status(401).json({ errors: [{ code: 'UNAUTHORIZED' }] });
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function seriesOf(): Promise<Array<{ labels: Record<string, string | number>; value: number }>> {
  const metric = await httpRequestsTotal.get();
  return metric.values.map((v) => ({ labels: v.labels as Record<string, string | number>, value: v.value }));
}

describe('metricsMiddleware route label', () => {
  it('exports the bounded label as a constant', () => {
    expect(UNMATCHED_ROUTE_LABEL).toBe('unmatched');
  });

  it('two different unmatched paths share one series instead of minting two', async () => {
    const first = `/v1/${randomUUID()}`;
    const second = `/wp-admin/${randomUUID()}/setup.php`;

    const before = (await seriesOf()).find(
      (s) => s.labels.route === UNMATCHED_ROUTE_LABEL && s.labels.method === 'GET' && s.labels.status === '404'
    )?.value ?? 0;

    for (const p of [first, second]) {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(404);
      await res.arrayBuffer();
    }

    // 'finish' fires as the response is handed to the socket; wait for the
    // counter rather than assume the ordering.
    await vi.waitFor(async () => {
      const unmatched = (await seriesOf()).find(
        (s) => s.labels.route === UNMATCHED_ROUTE_LABEL && s.labels.method === 'GET' && s.labels.status === '404'
      );
      expect(unmatched?.value).toBe(before + 2);
    });

    const routes = (await seriesOf()).map((s) => String(s.labels.route));
    expect(routes.some((r) => r.includes(first) || r.includes(second))).toBe(false);
    expect(routes.some((r) => r.startsWith('/wp-admin') || /[0-9a-f]{8}-[0-9a-f]{4}-/.test(r))).toBe(false);
  });

  it('a request refused before routing (401) is labelled unmatched, not with the path it asked for', async () => {
    const asked = `/v1/private/%3Cscript%3E${randomUUID()}`;
    const before = (await seriesOf()).find(
      (s) => s.labels.route === UNMATCHED_ROUTE_LABEL && s.labels.method === 'GET' && s.labels.status === '401'
    )?.value ?? 0;

    const res = await fetch(`${baseUrl}${asked}`);
    expect(res.status).toBe(401);
    await res.arrayBuffer();

    await vi.waitFor(async () => {
      const refused = (await seriesOf()).find(
        (s) => s.labels.route === UNMATCHED_ROUTE_LABEL && s.labels.method === 'GET' && s.labels.status === '401'
      );
      expect(refused?.value).toBe(before + 1);
    });
    const routes = (await seriesOf()).map((s) => String(s.labels.route));
    expect(routes.some((r) => r.includes('private') || r.includes('script'))).toBe(false);
  });

  it('a matched route keeps its pattern, baseUrl plus route.path, not the id it was called with', async () => {
    const id = randomUUID();
    const res = await fetch(`${baseUrl}/v1/employees/${id}`);
    expect(res.status).toBe(200);
    await res.arrayBuffer();

    await vi.waitFor(async () => {
      const matched = (await seriesOf()).find(
        (s) => s.labels.route === '/v1/employees/:id' && s.labels.method === 'GET' && s.labels.status === '200'
      );
      expect(matched?.value).toBeGreaterThanOrEqual(1);
    });
    const routes = (await seriesOf()).map((s) => String(s.labels.route));
    expect(routes.some((r) => r.includes(id))).toBe(false);
  });
});
