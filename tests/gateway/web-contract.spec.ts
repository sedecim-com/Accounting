import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_OPERATIONS,
  buildGetRequest,
  isCanonicalUuid,
  REQUEST_MARKER_HEADER,
  SIGN_IN_PATH,
  SIGN_OUT_PATH,
  type ApiOperation,
} from '../../src/gateway/app/contract.js';
import { GATEWAY_ROUTES, PROXY_PREFIX } from '../../src/gateway/routes.js';

// ============================================================
// W1 · the browser's contract with the API, at run time.
//
// Criterion web-client-reads-only-contracted-paths reads the table on its
// syntax tree; this spec runs it: every operation is a GET of the committed
// docs/openapi.json, every request carries what the gateway's CSRF guard
// demands and nothing that follows a redirect or reads a cache, and an entity
// id that is not a canonical UUID never reaches a header.
// ============================================================

const ENTITY = '3f1c2b7a-9d4e-4c1b-8a2f-5e6d7c8b9a01';

const contract = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'openapi.json'), 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};

describe('API_OPERATIONS', () => {
  it('is only reads, each a GET the committed contract declares, under the proxied prefix', () => {
    const entries = Object.entries(API_OPERATIONS);
    expect(entries.length).toBeGreaterThan(0);
    expect(Object.keys(API_OPERATIONS)).toContain('portfolio');
    for (const [name, operation] of entries) {
      expect(operation.method, name).toBe('GET');
      expect(operation.path.startsWith(`${PROXY_PREFIX}/`), name).toBe(true);
      expect(contract.paths[operation.path]?.get, `${name}: GET ${operation.path} is not in docs/openapi.json`).toBeDefined();
    }
  });

  it("the sign-in and sign-out paths are the gateway's own routes, not the API's", () => {
    const own = GATEWAY_ROUTES.map(([method, route]) => `${method} ${route}`);
    expect(own).toContain(`GET ${SIGN_IN_PATH}`);
    expect(own).toContain(`POST ${SIGN_OUT_PATH}`);
  });
});

describe('buildGetRequest', () => {
  it('the portfolio: the marker header, same-origin credentials, no redirect, no cache, no parameter', () => {
    expect(buildGetRequest('portfolio')).toEqual({
      url: '/v1/portfolio',
      init: {
        method: 'GET',
        credentials: 'same-origin',
        redirect: 'error',
        cache: 'no-store',
        headers: { [REQUEST_MARKER_HEADER]: '1', accept: 'application/json' },
      },
    });
    expect(REQUEST_MARKER_HEADER.toLowerCase()).toBe('x-mnemosine-request');
  });

  it('an entity read carries x-entity-id and an encoded status filter', () => {
    const request = buildGetRequest('drafts', { entityId: ENTITY, status: 'pending_review' });
    expect(request.url).toBe('/v1/ai/drafts?status=pending_review');
    expect(request.init.headers['x-entity-id']).toBe(ENTITY);
    expect(buildGetRequest('questions', { entityId: ENTITY, status: 'a&b=c' }).url).toBe('/v1/ai/questions?status=a%26b%3Dc');
    expect(buildGetRequest('periods', { entityId: ENTITY }).url).toBe('/v1/fiscal-periods');
  });

  it('an entity id that is not a canonical UUID never reaches the header', () => {
    const bad = ['', 'not-a-uuid', ENTITY.toUpperCase(), `${ENTITY}\r\nx-evil: 1`, `${ENTITY},${ENTITY}`, ` ${ENTITY}`];
    for (const operation of ['drafts', 'questions', 'periods'] as ApiOperation[]) {
      expect(() => buildGetRequest(operation), operation).toThrow(/canonical entity id/);
      for (const entityId of bad) {
        expect(() => buildGetRequest(operation, { entityId }), `${operation} ${JSON.stringify(entityId)}`).toThrow(/canonical entity id/);
      }
    }
  });

  it('the portfolio refuses an entity or a filter: the API chooses its set from the token', () => {
    expect(() => buildGetRequest('portfolio', { entityId: ENTITY })).toThrow(/takes no entity/);
    expect(() => buildGetRequest('portfolio', { status: 'open' })).toThrow(/takes no entity/);
  });

  it('isCanonicalUuid accepts only lowercase hyphenated UUIDs', () => {
    expect(isCanonicalUuid(ENTITY)).toBe(true);
    expect(isCanonicalUuid(ENTITY.toUpperCase())).toBe(false);
    expect(isCanonicalUuid(ENTITY.replace(/-/g, ''))).toBe(false);
  });
});
