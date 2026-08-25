import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { asyncHandler, validateBody } from '../../../src/api/rest/middleware/async-handler.js';
import { ValidationError } from '../../../src/utils/errors.js';

function mockReqRes(body: unknown = {}) {
  const req = { body } as any;
  const res = {} as any;
  const next = vi.fn();
  return { req, res, next };
}

describe('asyncHandler', () => {
  it('forwards rejected promises to next()', async () => {
    const { req, res, next } = mockReqRes();
    const boom = new Error('boom');
    const wrapped = asyncHandler(async () => { throw boom; });
    await wrapped(req, res, next);
    // next is called with the error after the promise rejects
    await new Promise((r) => setImmediate(r));
    expect(next).toHaveBeenCalledWith(boom);
  });

  it('does not call next() on success', async () => {
    const { req, res, next } = mockReqRes();
    const wrapped = asyncHandler(async () => { /* ok */ });
    await wrapped(req, res, next);
    await new Promise((r) => setImmediate(r));
    expect(next).not.toHaveBeenCalled();
  });
});

describe('validateBody', () => {
  const schema = z.object({
    name: z.string().min(1),
    age: z.number().int().nonnegative(),
  });

  it('replaces req.body with parsed value on success', () => {
    const { req, res, next } = mockReqRes({ name: 'alice', age: 30 });
    validateBody(schema)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledWith(); // no error
    expect(req.body).toEqual({ name: 'alice', age: 30 });
  });

  it('forwards a ValidationError with field paths on failure', () => {
    const { req, res, next } = mockReqRes({ name: '', age: -5 });
    validateBody(schema)(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    const err = next.mock.calls[0][0] as Error;
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/name/);
    expect(err.message).toMatch(/age/);
  });

  it('rejects unknown top-level fields when schema is strict', () => {
    const strict = schema.strict();
    const { req, res, next } = mockReqRes({ name: 'alice', age: 30, extra: 'nope' });
    validateBody(strict)(req, res, next);
    const err = next.mock.calls[0][0] as Error | undefined;
    expect(err).toBeInstanceOf(ValidationError);
  });
});
