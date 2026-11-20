import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { negotiateLocale } from '../../src/api/rest/middleware/locale.js';
import { correlationIdMiddleware } from '../../src/api/rest/middleware/correlation.js';
import { errorHandler, routeNotFound } from '../../src/api/rest/middleware/error-handler.js';
import { AccountingError, AppError } from '../../src/utils/errors.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import { DEFAULT_LOCALE, languageOfLocale } from '../../src/i18n/locale.js';

// ============================================================
// API ERRORS BY LOCALE (I9 · issue #151)
//
// The `code` of an error is wire contract; the `message` is for a human. The
// same failing request asked for in Spanish and in English must come back with
// the same `code` and each message in its own language.
//
// The expected messages are LITERALS copied from src/i18n/es.ts and en.ts, not
// `t('error.PERIOD_ALREADY_OPEN', ...)`: an expectation built with the same
// piece the handler uses stays green when that piece is what broke.
// ============================================================

interface ErrorEnvelope {
  errors: Array<{ code: string; message: string; field?: string; details?: Record<string, unknown> }>;
  meta: { request_id?: string; timestamp: string; version: string; language?: string };
}

const PERIOD = '2026-03';
const SPANISH_MESSAGE = '2026-03 ya está abierto.';
const ENGLISH_MESSAGE = '2026-03 is already open.';
const PROSE_MESSAGE = 'Prose that was never migrated to a key.';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // Pin the PROCESS language to English. The response language has to come
  // from the request, so a handler that rendered with the process language
  // (`err.localized()` with no argument) would answer the Spanish and the
  // header-less requests in English and fail below. vitest.config.ts already
  // sets MNEMOSINE_LOCALE=en-US; the pin keeps this file from depending on it.
  setLanguage('en');

  // The order src/index.ts mounts: the correlation id, the negotiation, the
  // routes, the fallback for a path no route serves, the renderer.
  const app = express();
  app.use(correlationIdMiddleware);
  app.use(negotiateLocale);
  app.get('/keyed', () => {
    throw new AccountingError(
      'PERIOD_ALREADY_OPEN',
      { key: 'error.PERIOD_ALREADY_OPEN', params: { period: PERIOD } },
      { period: PERIOD }
    );
  });
  app.get('/prose', () => {
    throw new AppError(409, 'SOME_PROSE_ERROR', PROSE_MESSAGE, 'period');
  });
  app.use(routeNotFound);
  app.use(errorHandler);

  await new Promise<void>((ok) => {
    server = app.listen(0, '127.0.0.1', () => ok());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  resetLanguage();
  await new Promise<void>((ok) => server.close(() => ok()));
});

/**
 * Through `node:http`, NOT `fetch`: Node's fetch adds `accept-language: *` to
 * every request that does not set one, so the "no header" case below would
 * never leave the client without a header — measured on Node v22.
 */
function call(
  path: string,
  acceptLanguage?: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<{
  status: number;
  contentLanguage?: string;
  contentType?: string;
  vary?: string;
  requestId?: string;
  raw: string;
  body: ErrorEnvelope;
}> {
  const headers: Record<string, string> = { ...options.headers };
  if (acceptLanguage !== undefined) headers['accept-language'] = acceptLanguage;
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method: options.method ?? 'GET', headers }, (res) => {
      let raw = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode ?? 0,
            contentLanguage: res.headers['content-language'],
            contentType: res.headers['content-type'],
            vary: res.headers['vary'],
            requestId: res.headers['x-request-id'] as string | undefined,
            raw,
            body: JSON.parse(raw) as ErrorEnvelope,
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

describe('an error written by catalog key', () => {
  it('keeps its code and changes its message with Accept-Language', async () => {
    const es = await call('/keyed', 'es');
    const en = await call('/keyed', 'en');

    expect(es.status).toBe(422);
    expect(en.status).toBe(422);
    expect(es.body.errors[0].code).toBe('PERIOD_ALREADY_OPEN');
    expect(en.body.errors[0].code).toBe('PERIOD_ALREADY_OPEN');

    expect(es.body.errors[0].message).toBe(SPANISH_MESSAGE);
    expect(en.body.errors[0].message).toBe(ENGLISH_MESSAGE);

    expect(es.contentLanguage).toBe('es-MX');
    expect(en.contentLanguage).toBe('en-US');
    expect(es.body.meta.language).toBe('es');
    expect(en.body.meta.language).toBe('en');
    // A rendered message depends on the header, so a cache has to key on it.
    expect((es.vary ?? '').toLowerCase()).toContain('accept-language');
  });

  it('follows the NEGOTIATED locale, not the bare header text', async () => {
    // `en-GB` is not a locale this product has; the negotiation resolves it to
    // en-US. A handler that branched on the raw header would answer Spanish
    // here while labelling the response en-US.
    const gb = await call('/keyed', 'en-GB');
    expect(gb.contentLanguage).toBe('en-US');
    expect(gb.body.meta.language).toBe('en');
    expect(gb.body.errors[0].message).toBe(ENGLISH_MESSAGE);

    const ar = await call('/keyed', 'es-AR');
    expect(ar.contentLanguage).toBe('es-MX');
    expect(ar.body.errors[0].message).toBe(SPANISH_MESSAGE);
  });

  it('leaves the rest of the envelope as it was', async () => {
    const { body } = await call('/keyed', 'es');
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].details).toEqual({ period: PERIOD });
    expect(body.meta.version).toBe('v1');
    expect(Number.isNaN(Date.parse(body.meta.timestamp))).toBe(false);
  });

  it('answers in es-MX when the request sends no Accept-Language', async () => {
    const none = await call('/keyed');
    expect(none.contentLanguage).toBe('es-MX');
    expect(none.body.meta.language).toBe('es');
    expect(none.body.errors[0].code).toBe('PERIOD_ALREADY_OPEN');
    expect(none.body.errors[0].message).toBe(SPANISH_MESSAGE);
  });
});

describe('an error still written as prose', () => {
  it('returns its prose unchanged and claims no language at all', async () => {
    // The envelope must not name a language for a message it did not render:
    // most messages are still prose today, and labelling an English 401 as
    // `es-MX` is a claim the body does not back.
    const es = await call('/prose', 'es');
    const en = await call('/prose', 'en');

    for (const r of [es, en]) {
      expect(r.status).toBe(409);
      expect(r.body.errors[0].code).toBe('SOME_PROSE_ERROR');
      expect(r.body.errors[0].message).toBe(PROSE_MESSAGE);
      expect(r.body.errors[0].field).toBe('period');
      expect(r.contentLanguage).toBeUndefined();
      expect(r.body.meta.language).toBeUndefined();
    }
  });
});

// ============================================================
// A PATH NO ROUTE SERVES (MNE-001-150 · issue #151)
//
// Express's own final handler answered it with an HTML page in English,
// «Cannot GET /v1/no-existe», with no code, no request id and no language.
// It now goes out in the envelope every other error uses, under its own code:
// ROUTE_NOT_FOUND says the URL is wrong, RESOURCE_NOT_FOUND says the route
// exists and the record does not.
// ============================================================

const ROUTE_SPANISH = 'No hay ninguna ruta para GET /v1/no-existe.';
const ROUTE_ENGLISH = 'No route matches GET /v1/no-existe.';

describe('a path no route serves', () => {
  it('answers 404 ROUTE_NOT_FOUND in the envelope, its message in the negotiated language', async () => {
    const es = await call('/v1/no-existe', 'es');
    const en = await call('/v1/no-existe', 'en');

    for (const r of [es, en]) {
      expect(r.status).toBe(404);
      expect(r.contentType ?? '').toMatch(/^application\/json/);
      expect(r.body.errors).toHaveLength(1);
      expect(r.body.errors[0].code).toBe('ROUTE_NOT_FOUND');
      expect(r.body.meta.version).toBe('v1');
      expect(Number.isNaN(Date.parse(r.body.meta.timestamp))).toBe(false);
      expect((r.vary ?? '').toLowerCase()).toContain('accept-language');
    }
    expect(es.body.errors[0].message).toBe(ROUTE_SPANISH);
    expect(en.body.errors[0].message).toBe(ROUTE_ENGLISH);
    expect(es.contentLanguage).toBe('es-MX');
    expect(en.contentLanguage).toBe('en-US');
    expect(es.body.meta.language).toBe('es');
    expect(en.body.meta.language).toBe('en');
  });

  it('carries the request id, the one sent or the one generated', async () => {
    const sent = await call('/v1/no-existe', 'en', { headers: { 'x-request-id': 'req-150' } });
    expect(sent.body.meta.request_id).toBe('req-150');

    const generated = await call('/v1/no-existe', 'en');
    expect(typeof generated.body.meta.request_id).toBe('string');
    expect(generated.body.meta.request_id).not.toBe('');
    expect(generated.body.meta.request_id).toBe(generated.requestId);
  });

  it('without Accept-Language answers in the default locale', async () => {
    // Read from the default, not written down: when DEFAULT_LOCALE moves, this
    // case moves with it instead of being rewritten.
    const none = await call('/v1/no-existe');
    expect(none.contentLanguage).toBe(DEFAULT_LOCALE);
    expect(none.body.meta.language).toBe(languageOfLocale(DEFAULT_LOCALE));
    expect(none.body.errors[0].message).toBe(languageOfLocale(DEFAULT_LOCALE) === 'es' ? ROUTE_SPANISH : ROUTE_ENGLISH);
  });

  it('names the method it was asked with', async () => {
    const post = await call('/v1/no-existe', 'en', { method: 'POST' });
    expect(post.status).toBe(404);
    expect(post.body.errors[0].code).toBe('ROUTE_NOT_FOUND');
    expect(post.body.errors[0].message).toBe('No route matches POST /v1/no-existe.');
  });

  it('a path that exists for another method is still a 404, not that route', async () => {
    const wrongMethod = await call('/keyed', 'en', { method: 'DELETE' });
    expect(wrongMethod.status).toBe(404);
    expect(wrongMethod.body.errors[0].code).toBe('ROUTE_NOT_FOUND');
    expect(wrongMethod.body.errors[0].message).toBe('No route matches DELETE /keyed.');
  });

  it('never echoes the query string, which is where a token or an RFC travels', async () => {
    const r = await call('/v1/no-existe?token=s3cr3t&rfc=XAXX010101000', 'en');
    expect(r.body.errors[0].message).toBe(ROUTE_ENGLISH);
    expect(r.raw).not.toContain('s3cr3t');
    expect(r.raw).not.toContain('XAXX010101000');
  });

  it('covers paths outside /v1 too', async () => {
    const root = await call('/', 'en');
    expect(root.status).toBe(404);
    expect(root.body.errors[0].code).toBe('ROUTE_NOT_FOUND');
    expect(root.body.errors[0].message).toBe('No route matches GET /.');
  });

  it('routeNotFound hands an English, keyed AppError to the renderer', () => {
    setLanguage('es');
    try {
      const next = vi.fn();
      routeNotFound({ method: 'GET', path: '/v1/x' } as express.Request, {} as express.Response, next);
      expect(next).toHaveBeenCalledTimes(1);
      const err = next.mock.calls[0][0] as AppError;
      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe('ROUTE_NOT_FOUND');
      expect(err.messageKey?.key).toBe('error.ROUTE_NOT_FOUND');
      // The log language is English whatever the process speaks (errors.ts).
      expect(err.message).toBe('No route matches GET /v1/x.');
    } finally {
      setLanguage('en');
    }
  });
});

// ============================================================
// THE MOUNT IN src/index.ts
// ============================================================

const ROOT = join(__dirname, '..', '..');

/** The source without comments: the comment over the mount names errorHandler too. */
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

describe('src/index.ts mounts routeNotFound after every router and before the renderer', () => {
  const mount = () => onlyOffsetOf('app.use(routeNotFound);');

  it('once, at the top level of bootstrap', () => {
    expect(mount()).toBeGreaterThanOrEqual(0);
    expect(indexSource.match(/^ {2}app\.use\(routeNotFound\);$/gm) ?? []).toHaveLength(1);
  });

  it('after the /v1 routers and the AI webhooks', () => {
    expect(mount()).toBeGreaterThan(onlyOffsetOf('for (const [sufijo, router] of MONTAJES_V1)'));
    expect(mount()).toBeGreaterThan(onlyOffsetOf("app.use('/v1/ai/webhooks'"));
  });

  it('before errorHandler', () => {
    expect(mount()).toBeLessThan(onlyOffsetOf('app.use(errorHandler);'));
  });
});
