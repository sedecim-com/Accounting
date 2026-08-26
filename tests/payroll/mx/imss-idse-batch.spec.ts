import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ============================================================
// POST /v1/payroll/imss-idse/batch — the endpoint the withdrawn
// /imss-idse/submit points every caller at.
//
// Two things are pinned here, and the second is why this file
// exists at all.
//
// 1. THE SBC IS MONEY. It travels as a decimal string from the
//    employees column to the seven centavo digits of the record.
//    A float loses the half-centavo: 1.005 * 100 is
//    100.49999999999999 in IEEE-754, and Math.round makes that
//    100 — one centavo short, on a figure the IMSS cuota is
//    derived from for as long as the movement stands.
//
// 2. A MALFORMED SBC MUST ANSWER, NOT HANG. `new_sbc` comes
//    straight off req.body with no schema in front of it, so
//    "5,000.50" and "$5000.50" reach the adapter. Decimal throws
//    on those. This route was a bare `async (req, res)` handler,
//    and Express 4 does not forward a rejected promise from one —
//    the request hung until the client gave up. It is wrapped in
//    asyncHandler now; if anyone unwraps it, the 422 test below
//    stops passing by TIMING OUT, which is exactly the symptom.
//
//    The rest of payroll.ts still has the bare-handler pattern.
//    That is a known, separate defect; this route is fixed
//    because a refusal that redirects callers here cannot send
//    them somewhere that never replies.
// ============================================================

const EMPLOYEE = {
  id: 'emp-1', nss: '12345678901', rfc: 'AAA010101AAA', curp: 'AAAA010101HDFXXX01',
  first_name: 'Ana', last_name: 'Ruiz', second_last_name: 'Lara', sbc: '500.00',
};

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(async (sql: string) => {
    if (/FROM legal_entities/i.test(sql)) return { rows: [{ imss_registro_patronal: 'RP12345' }], rowCount: 1 };
    if (/FROM employees/i.test(sql)) return { rows: [EMPLOYEE], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
  withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) })
  ),
  withTenant: vi.fn(async (_t: string, fn: () => Promise<unknown>) => fn()),
  enterTenant: vi.fn(), currentTenant: vi.fn(), getClient: vi.fn(),
  setTenantSchema: vi.fn(), initDatabase: vi.fn(), closeDatabase: vi.fn(), getPool: vi.fn(),
}));

import { generateIdseBatch } from '../../../src/services/payroll/integrations/imss-idse-adapter.js';
import { ValidationError } from '../../../src/utils/errors.js';
import payrollRouter from '../../../src/api/rest/routes/payroll.js';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';

const ENTITY = '00000000-0000-0000-0000-0000000000e1';

/** Characters 135-141 of the fixed-width record: the SBC in centavos. */
const sbcField = (content: string) => content.split('\r\n')[0].slice(134, 141);

const movement = (new_sbc?: unknown) => ({
  employee_id: 'emp-1',
  movement_type: 'mod_salario' as const,
  effective_date: '2026-09-01',
  ...(new_sbc === undefined ? {} : { new_sbc: new_sbc as string }),
});

describe('generateIdseBatch — the SBC never becomes a float', () => {
  it('writes the centavos a decimal gives, not the ones a float gives', async () => {
    // 1.005 * 100 === 100.49999999999999 in IEEE-754, so Math.round said 100.
    const { content } = await generateIdseBatch('t-1', ENTITY, [movement('1.005')]);
    expect(sbcField(content)).toBe('0000101');
  });

  it('carries an ordinary salary through unchanged', async () => {
    const { content } = await generateIdseBatch('t-1', ENTITY, [movement('5000.50')]);
    expect(sbcField(content)).toBe('0500050');
  });

  it('falls back to the employee column when the movement carries no new_sbc', async () => {
    const { content } = await generateIdseBatch('t-1', ENTITY, [movement()]);
    expect(sbcField(content)).toBe('0050000');
  });

  it.each(['5,000.50', '$5000.50', ' 5000.50 ', 'abc', 'MXN 5000'])(
    'refuses %o instead of padding NaN into the record',
    async (bad) => {
      // The float path wrote `0000NaN` here and answered 200 with a
      // record_count that counted a batch the IMSS would reject.
      await expect(generateIdseBatch('t-1', ENTITY, [movement(bad)])).rejects.toBeInstanceOf(
        ValidationError
      );
    }
  );

  it('treats an empty new_sbc as absent, exactly as the route always did', async () => {
    // `''` is falsy, so it falls through to the employee column rather than
    // becoming an error — the same reading the original `mov.new_sbc ?` gave.
    const { content } = await generateIdseBatch('t-1', ENTITY, [movement('')]);
    expect(sbcField(content)).toBe('0050000');
  });

  it('refuses a non-finite SBC rather than writing "NaN" as digits', async () => {
    // 'NaN' is a value decimal.js accepts, so the constructor does not throw:
    // only the isFinite check stops it reaching the record.
    await expect(generateIdseBatch('t-1', ENTITY, [movement('NaN')])).rejects.toBeInstanceOf(ValidationError);
    await expect(generateIdseBatch('t-1', ENTITY, [movement('-1')])).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('POST /v1/payroll/imss-idse/batch answers when the SBC is malformed', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { user_id: 'u-1', tenant_id: 't-1', entities: [ENTITY], permissions: ['*'] } as never;
      req.tenantId = 't-1';
      req.entityId = ENTITY;
      next();
    });
    app.use('/v1/payroll', payrollRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

  async function post(body: unknown) {
    // A short abort: an unforwarded rejection produces no response at all, and
    // "no response" has to fail as a failure, not as a hung suite.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}/v1/payroll/imss-idse/batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      return { status: res.status, json: await res.json() as { errors?: Array<{ code: string; field?: string }>; data?: unknown } };
    } catch {
      return { status: 'NO RESPONSE' as const, json: {} as { errors?: Array<{ code: string; field?: string }>; data?: unknown } };
    } finally {
      clearTimeout(timer);
    }
  }

  it('answers 422, and does not leave the request hanging', async () => {
    const res = await post({ entity_id: ENTITY, movements: [movement('5,000.50')] });
    expect(res.status, 'a rejected promise from a bare Express 4 handler never answers').toBe(422);
    expect(res.json.errors?.[0].code).toBe('VALIDATION_ERROR');
    expect(res.json.errors?.[0].field).toBe('new_sbc');
    expect(res.json.data, 'a refusal must not carry a batch').toBeUndefined();
  }, 10000);

  it('still produces the batch for a well-formed movement', async () => {
    const res = await post({ entity_id: ENTITY, movements: [movement('5000.50')] });
    expect(res.status).toBe(200);
    expect((res.json.data as { record_count: number }).record_count).toBe(1);
  }, 10000);
});
