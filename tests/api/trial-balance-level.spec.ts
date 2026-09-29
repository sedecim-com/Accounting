import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ============================================================
// GET /v1/reports/trial-balance · `account_level` (#100, MNE-001-050)
//
// The route used to default `account_level` to '5' and hand it to the
// service as a level FILTER, so a caller who asked for nothing got a trial
// balance with every account below level 5 silently gone. Now: no
// `account_level` means the full detail, the same as the CLI without
// `--level`; a level is validated and handed over as a roll-up cut, which the
// service applies after summing each subtree (report-service.spec.ts).
// ============================================================

const getTrialBalance = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('../../src/services/reporting/report-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/reporting/report-service.js')>()),
  getTrialBalance: (...args: unknown[]) => getTrialBalance(...args),
}));

import reportsRouter from '../../src/api/rest/routes/reports.js';
import { errorHandler } from '../../src/api/rest/middleware/error-handler.js';

const ENTITY = 'e-1';
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { user_id: 'u-1', tenant_id: 't-1', entities: [ENTITY], permissions: ['*'] } as never;
    req.tenantId = 't-1';
    req.entityId = ENTITY;
    next();
  });
  app.use('/v1/reports', reportsRouter);
  app.use(errorHandler);
  await new Promise<void>((ok) => {
    server = app.listen(0, '127.0.0.1', ok);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
});

beforeEach(() => {
  getTrialBalance.mockReset();
  getTrialBalance.mockResolvedValue({
    entity_id: ENTITY,
    rows: [],
    total: 0,
    totals: { total_debits: '0.0000', total_credits: '0.0000', is_balanced: true },
  });
});

const optionsSent = () => getTrialBalance.mock.calls[0][1] as Record<string, unknown>;

describe('GET /v1/reports/trial-balance — account_level', () => {
  it('without account_level it asks for every level: nothing is trimmed behind the caller', async () => {
    const res = await fetch(`${baseUrl}/v1/reports/trial-balance?entity_id=${ENTITY}`);
    expect(res.status).toBe(200);
    expect(optionsSent()).not.toHaveProperty('maxLevel');
  });

  it('with account_level it hands the service that level as the cut', async () => {
    const res = await fetch(`${baseUrl}/v1/reports/trial-balance?entity_id=${ENTITY}&account_level=3`);
    expect(res.status).toBe(200);
    expect(optionsSent().maxLevel).toBe(3);
  });

  it.each(['0', 'abc', '2.5', '-1', '3&account_level=4'])('rejects account_level=%s with a 422 instead of guessing', async (level) => {
    const res = await fetch(`${baseUrl}/v1/reports/trial-balance?entity_id=${ENTITY}&account_level=${level}`);
    expect(res.status).toBe(422);
    expect(getTrialBalance).not.toHaveBeenCalled();
  });
});
