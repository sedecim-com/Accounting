import { describe, it, expect, vi } from 'vitest';
import { correlationIdMiddleware, enrichLogContextMiddleware } from '../../../src/api/rest/middleware/correlation.js';
import { logContext } from '../../../src/utils/logger.js';

function mockReqRes(headers: Record<string, string> = {}) {
  const req = { headers, originalUrl: '/v1/test', method: 'GET' } as any;
  const res = {
    _headers: {} as Record<string, string>,
    setHeader(key: string, val: string) { this._headers[key] = val; },
    on: vi.fn(),
    statusCode: 200,
  } as any;
  const next = vi.fn();
  return { req, res, next };
}

describe('correlationIdMiddleware', () => {
  it('generates a request id when none is provided', () => {
    const { req, res, next } = mockReqRes();
    correlationIdMiddleware(req, res, next);
    expect(typeof req.headers['x-request-id']).toBe('string');
    expect(req.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);
    expect(res._headers['X-Request-Id']).toBe(req.headers['x-request-id']);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('honors an inbound x-request-id header', () => {
    const { req, res, next } = mockReqRes({ 'x-request-id': 'custom-id-123' });
    correlationIdMiddleware(req, res, next);
    expect(req.headers['x-request-id']).toBe('custom-id-123');
    expect(res._headers['X-Request-Id']).toBe('custom-id-123');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('makes request_id available via logContext within the request scope', () => {
    const { req, res } = mockReqRes({ 'x-request-id': 'ctx-test' });
    let captured: string | undefined;
    correlationIdMiddleware(req, res, () => {
      captured = logContext.getStore()?.request_id;
    });
    expect(captured).toBe('ctx-test');
  });
});

describe('enrichLogContextMiddleware', () => {
  it('copies tenant/user/entity from req.user into logContext', () => {
    const req = { user: { tenant_id: 't1', user_id: 'u1' }, entityId: 'e1' } as any;
    const res = {} as any;
    let captured: any;

    logContext.run({ request_id: 'r1' }, () => {
      enrichLogContextMiddleware(req, res, () => {
        captured = logContext.getStore();
      });
    });

    expect(captured.request_id).toBe('r1');
    expect(captured.tenant_id).toBe('t1');
    expect(captured.user_id).toBe('u1');
    expect(captured.entity_id).toBe('e1');
  });

  it('is a no-op when req.user is absent', () => {
    const req = {} as any;
    const res = {} as any;
    const next = vi.fn();

    logContext.run({ request_id: 'r1' }, () => {
      enrichLogContextMiddleware(req, res, next);
      const ctx = logContext.getStore();
      expect(ctx?.tenant_id).toBeUndefined();
    });
    expect(next).toHaveBeenCalled();
  });
});
