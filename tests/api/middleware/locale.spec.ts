import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { negotiateLocale } from '../../../src/api/rest/middleware/locale.js';
import { authenticate } from '../../../src/api/rest/middleware/auth.js';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';

// ============================================================
// THE LANGUAGE OF AN HTTP RESPONSE (I9 · issue #151)
//
// Two things are asserted here, and they fail independently:
//
//   1. What `negotiateLocale` records for a given Accept-Language, read back
//      through a route that echoes `res.locals`. The middleware announces
//      nothing to the client: the error handler is what sends
//      `Content-Language`, and only for a message it rendered from a key.
//   2. That src/index.ts mounts it BEFORE `authenticate` and every public
//      surface. Booting src/index.ts needs a database, so the order is read
//      from the source, the way tests/api/superficie-graphql-retirada.spec.ts
//      reads it.
//
// The vitest config pins MNEMOSINE_LOCALE=en-US. That variable belongs to the
// CLI resolver and must not reach the HTTP negotiation: the cases that fall back
// to es-MX (no header, only unsupported languages) are what catch it leaking in.
// ============================================================

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(negotiateLocale);
  app.get('/ok', (_req, res) => {
    res.json({ language: res.locals.language as unknown, locale: res.locals.locale as unknown });
  });
  // The real `authenticate` and error handler: a request with no token is
  // rejected with a 401 before any route, which is the case the mount order
  // in src/index.ts exists for.
  app.use('/v1', authenticate);
  app.get('/v1/anything', (_req, res) => {
    res.json({ reached: true });
  });
  app.use(errorHandler);

  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * A GET through `node:http`, NOT `fetch`: Node's fetch adds `accept-language: *`
 * to every request that does not set one, so with it the "no header" case
 * would never leave the client without a header.
 */
function get(path: string, acceptLanguage?: string) {
  const headers: Record<string, string> = {};
  if (acceptLanguage !== undefined) headers['accept-language'] = acceptLanguage;
  return new Promise<{
    status: number;
    contentLanguage: string | undefined;
    vary: string | undefined;
    body: Record<string, unknown>;
  }>((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method: 'GET', headers }, (res) => {
      let raw = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode ?? 0,
            contentLanguage: res.headers['content-language'],
            vary: res.headers['vary'],
            body: JSON.parse(raw) as Record<string, unknown>,
          });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('negotiateLocale on the wire', () => {
  it('without Accept-Language answers es-MX, the product default', async () => {
    const r = await get('/ok');
    expect(r.body).toEqual({ language: 'es', locale: 'es-MX' });
  });

  it('Accept-Language: * (what Node fetch sends by default) is answered in es-MX', async () => {
    const r = await get('/ok', '*');
    expect(r.body).toEqual({ language: 'es', locale: 'es-MX' });
  });

  it('en-GB is answered in en-US', async () => {
    const r = await get('/ok', 'en-GB');
    expect(r.body).toEqual({ language: 'en', locale: 'en-US' });
  });

  it('an unsupported first choice falls through to the next acceptable one', async () => {
    const r = await get('/ok', 'fr, en;q=0.5');
    expect(r.body).toEqual({ language: 'en', locale: 'en-US' });
  });

  it('only unsupported languages fall back to es-MX', async () => {
    const r = await get('/ok', 'fr');
    expect(r.body).toEqual({ language: 'es', locale: 'es-MX' });
  });

  it('announces nothing by itself: no Content-Language, no Vary', async () => {
    // The header would be a claim about the body, and this middleware has not
    // seen the body. Only the error handler sends it, and only for a message it
    // rendered from a catalog key.
    const r = await get('/ok', 'en-US');
    expect(r.contentLanguage).toBeUndefined();
    expect((r.vary ?? '').toLowerCase()).not.toContain('accept-language');
  });

  it('a 401 from authenticate does not claim a language its message is not in', async () => {
    // `authenticate` still answers with prose written in English. An earlier
    // version of this middleware labelled that response `es-MX` for a
    // Spanish-speaking client, which is the lie this contract removes.
    const r = await get('/v1/anything', 'es-MX');
    expect(r.status).toBe(401);
    expect(r.contentLanguage).toBeUndefined();
    const body = r.body as { errors: Array<{ code: string }>; meta: Record<string, unknown> };
    expect(body.errors[0]?.code).toBe('UNAUTHORIZED');
    expect(body.meta.language).toBeUndefined();
  });
});

// ============================================================
// THE MOUNT ORDER IN src/index.ts
// ============================================================

const ROOT = join(__dirname, '..', '..', '..');

/** The source without comments: the comment next to the mount names `authenticate` too. */
const withoutComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const indexSource = withoutComments(readFileSync(join(ROOT, 'src', 'index.ts'), 'utf-8'));

/** Offset of the only occurrence of `needle`; fails the test if it is missing or repeated. */
function onlyOffsetOf(needle: string): number {
  const first = indexSource.indexOf(needle);
  expect(first, `${needle} is not in src/index.ts`).toBeGreaterThanOrEqual(0);
  expect(indexSource.indexOf(needle, first + 1), `${needle} appears twice in src/index.ts`).toBe(-1);
  return first;
}

describe('src/index.ts mounts negotiateLocale before anything that can answer', () => {
  const locale = () => onlyOffsetOf('app.use(negotiateLocale);');

  it('mounts it once, for every path and unconditionally', () => {
    expect(locale()).toBeGreaterThanOrEqual(0);
    // At the top level of bootstrap, not inside an `if`: a conditional mount
    // with the same text would satisfy the ordering checks below.
    const topLevel = indexSource.match(/^ {2}app\.use\(negotiateLocale\);$/gm) ?? [];
    expect(topLevel).toHaveLength(1);
  });

  it('after the correlation id', () => {
    expect(locale()).toBeGreaterThan(onlyOffsetOf('app.use(correlationIdMiddleware);'));
  });

  it('before authenticate', () => {
    expect(locale()).toBeLessThan(onlyOffsetOf('app.use(apiPrefix, authenticate);'));
  });

  it('before the health probes, the public router and the AI webhooks', () => {
    expect(locale()).toBeLessThan(onlyOffsetOf("app.get('/live'"));
    expect(locale()).toBeLessThan(onlyOffsetOf("app.use('/public/v1'"));
    expect(locale()).toBeLessThan(onlyOffsetOf("app.use('/v1/ai/webhooks'"));
  });
});
