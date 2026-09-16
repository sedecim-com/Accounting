import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { negotiateLocale } from '../../src/api/rest/middleware/locale.js';
import { errorHandler } from '../../src/api/rest/middleware/error-handler.js';
import { AccountingError, AppError } from '../../src/utils/errors.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';

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

  const app = express();
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
  app.use(errorHandler);

  await new Promise<void>((ok) => {
    server = app.listen(0, '127.0.0.1', ok);
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
  acceptLanguage?: string
): Promise<{ status: number; contentLanguage?: string; vary?: string; body: ErrorEnvelope }> {
  const headers: Record<string, string> = {};
  if (acceptLanguage !== undefined) headers['accept-language'] = acceptLanguage;
  return new Promise((resolve, reject) => {
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
