import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// ============================================================
// The endpoints that were WITHDRAWN because they reported success
// for acts they never performed.
//
// Each of them used to answer 200. The old bodies were the whole
// problem: a submission_id from Date.now(), a folio, a status of
// 'accepted' or 'pending', a session marked 'balanced', a payment
// "scheduled". Nothing was transmitted, uploaded, reconciled or
// scheduled by any of them.
//
// This suite exists so a future hand cannot quietly restore that
// shape. It asserts three things per endpoint: the status is 501,
// the code is NOT_IMPLEMENTED, and the message NAMES the channel
// where the act actually happens. The third is not decoration —
// a refusal that does not say what to do instead gets worked
// around, and the way it gets worked around is by re-adding the
// lie.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) })
  ),
  withTenant: vi.fn(async (_t: string, fn: () => Promise<unknown>) => fn()),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
  getClient: vi.fn(),
  setTenantSchema: vi.fn(),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getPool: vi.fn(),
}));

import payrollRouter from '../../../src/api/rest/routes/payroll.js';
import billsRouter from '../../../src/api/rest/routes/bills.js';
import bankReconciliationRouter from '../../../src/api/rest/routes/bank-reconciliation.js';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  // Stand in for `authenticate`: a wildcard operator, so every refusal we
  // observe comes from the handler and not from the permission check.
  app.use((req, _res, next) => {
    req.user = {
      user_id: 'u-1',
      tenant_id: 't-1',
      entities: ['e-1'],
      permissions: ['*'],
    } as never;
    req.tenantId = 't-1';
    req.entityId = 'e-1';
    next();
  });

  app.use('/v1/payroll', payrollRouter);
  app.use('/v1/bills', billsRouter);
  app.use('/v1/bank-accounts', bankReconciliationRouter);
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as {
    errors?: Array<{ code: string; message: string }>;
    data?: unknown;
  } };
}

/** Every withdrawn endpoint, with the words its message must carry. */
const WITHDRAWN: Array<{
  what: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** Substrings the refusal must contain: the denial and the real channel. */
  mustSay: RegExp[];
}> = [
  {
    what: 'IRS e-file transmission (941/940)',
    method: 'POST',
    path: '/v1/payroll/irs-efile/00000000-0000-0000-0000-000000000001',
    body: { credentials: { efin: '123456', pin: '11111' } },
    mustSay: [/does not transmit to the IRS/i, /form-941|form-940/, /Nothing was sent/i],
  },
  {
    what: 'IRS acknowledgement polling',
    method: 'GET',
    path: '/v1/payroll/irs-efile/status/1234567890',
    mustSay: [/never transmitted/i],
  },
  {
    what: 'SSA BSO W-2 upload',
    method: 'POST',
    path: '/v1/payroll/ssa-bso/submit',
    body: { tax_year: 2026, credentials: { user_id: 'x', password: 'y' }, submitter: {} },
    mustSay: [/does not upload to the SSA/i, /efw2/i, /Nothing was uploaded/i],
  },
  {
    what: 'IMSS IDSE batch submission',
    method: 'POST',
    path: '/v1/payroll/imss-idse/submit',
    body: { batch_content: 'xxx', credentials: { cer_base64: 'a', key_base64: 'b', password: 'c' } },
    mustSay: [/does not transmit to IMSS/i, /idse\.imss\.gob\.mx/, /Nothing was sent/i],
  },
  {
    what: 'bill payment scheduling',
    method: 'POST',
    path: '/v1/bills/00000000-0000-0000-0000-000000000002/schedule-payment',
    body: { payment_date: '2026-09-15', payment_method: 'transfer' },
    mustSay: [/does not schedule payments/i, /v1\/bills\/payments/],
  },
  {
    what: 'bank reconciliation completion',
    method: 'POST',
    path: '/v1/bank-accounts/reconciliations/00000000-0000-0000-0000-000000000003/complete',
    mustSay: [/cannot complete a bank reconciliation/i, /period-close/i],
  },
];

describe('withdrawn endpoints refuse instead of reporting success', () => {
  for (const ep of WITHDRAWN) {
    it(`${ep.what} answers 501 NOT_IMPLEMENTED`, async () => {
      const { status, json } = await call(ep.method, ep.path, ep.body);
      expect(status, ep.what).toBe(501);
      expect(json.errors?.[0].code).toBe('NOT_IMPLEMENTED');
      expect(json.data, 'a refusal must not carry a success payload').toBeUndefined();
    });

    it(`${ep.what} says where the act really happens`, async () => {
      const { json } = await call(ep.method, ep.path, ep.body);
      const message = json.errors?.[0].message ?? '';
      for (const phrase of ep.mustSay) {
        expect(message, `${ep.what}: message must match ${phrase}`).toMatch(phrase);
      }
    });

    it(`${ep.what} never reports a status the caller could read as done`, async () => {
      const { json } = await call(ep.method, ep.path, ep.body);
      const body = JSON.stringify(json);
      // The exact vocabulary of the old success shapes.
      expect(body).not.toMatch(/"status"\s*:\s*"(accepted|pending|uploaded|balanced|submitted|scheduled)"/);
      expect(body).not.toMatch(/submission_id|wage_file_id|"folio"|scheduled_date/);
    });
  }
});

describe('the modules behind them no longer export a fake transmitter', () => {
  // Deleted, not disabled. A file kept around with its body commented out is
  // an invitation to uncomment it; there is nothing here to uncomment.
  it.each([
    'src/services/payroll/integrations/irs-efile-adapter.ts',
    'src/services/payroll/integrations/ssa-bso-adapter.ts',
    'src/services/mexico/cfdi.ts',
  ])('%s no longer exists', (relative) => {
    expect(existsSync(join(process.cwd(), relative))).toBe(false);
  });

  it('the IMSS adapter still generates the batch file but cannot submit it', async () => {
    const mod = await import('../../../src/services/payroll/integrations/imss-idse-adapter.js');
    expect(typeof mod.generateIdseBatch).toBe('function');
    expect((mod as Record<string, unknown>).submitIdseBatch).toBeUndefined();
  });

  it('the SAT catalogs survived the deletion of the module around them', async () => {
    const { SAT_CATALOGS } = await import('../../../src/services/xml-ingestion/sat-catalogs.js');
    expect(SAT_CATALOGS.REGIMEN_FISCAL['601']).toBe('General de Ley Personas Morales');
    // Rates are decimal STRINGS: a float rate is one multiplication away
    // from a lost centavo, and this repo does not put money through floats.
    for (const rate of Object.values(SAT_CATALOGS.IVA_RATES)) {
      expect(typeof rate).toBe('string');
    }
  });
});
