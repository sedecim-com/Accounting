import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// ============================================================
// THE S3 STUB IS RETIRED, NOT HIDDEN (#370 · MNE-001-105)
//
// The adapter kept each tenant's accessKeyId and secretAccessKey, answered
// `healthy: true` to POST /v1/admin/integrations/s3/test without calling AWS,
// and its upload() returned the URL of an object it never wrote. An accountant
// who configured it believed their files were backed up. Each case below pins
// one surface that made that promise.
//
// The database is mocked so that it HOLDS an S3 credential for the tenant:
// that is the state in which the stub reported healthy. Against an empty table
// the stub answered `healthy: false` too, and the probe case would pass with
// the adapter still registered.
// ============================================================

const db = vi.hoisted(() => ({ storedS3Credential: '', statements: [] as string[] }));

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    db.statements.push(sql);
    const provider = params?.[1];
    if (provider === 's3' && /SELECT credentials_encrypted/.test(sql)) {
      return { rows: [{ credentials_encrypted: db.storedS3Credential, expires_at: null }], rowCount: 1 };
    }
    // The insert succeeds, as it did in production: the stub's PUT answered 200.
    if (/INSERT INTO integration_credentials/.test(sql)) return { rows: [{ id: 'credential-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }),
}));

import { encrypt } from '../../src/utils/encryption.js';
import { config } from '../../src/config/index.js';
import integrationsRouter from '../../src/api/rest/routes/integrations.js';
import { integrationRegistry } from '../../src/services/integrations/index.js';
import { errorHandler } from '../../src/api/rest/middleware/error-handler.js';

// Synthetic, and shaped like nothing AWS would issue.
const SYNTHETIC_S3_CONFIG = {
  accessKeyId: 'SYNTHETIC-ACCESS-KEY-ID',
  secretAccessKey: 'synthetic-secret-access-key-not-real',
  region: 'us-east-1',
  bucket: 'synthetic-bucket',
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  db.storedS3Credential = encrypt(JSON.stringify(SYNTHETIC_S3_CONFIG));
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { user_id: 'u-1', tenant_id: 't-1', entities: ['e-1'], permissions: ['*'] } as never;
    next();
  });
  app.use('/v1/admin/integrations', integrationsRouter);
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
  db.statements.length = 0;
});

async function call(method: string, route: string, body?: unknown): Promise<{ status: number; text: string }> {
  const r = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, text: await r.text() };
}

function errorCodeOf(text: string): string | undefined {
  return (JSON.parse(text) as { errors?: Array<{ code?: string }> }).errors?.[0]?.code;
}

describe('the S3 stub is not offered while it is a stub', () => {
  it('the registry has no s3 provider and no storage adapter at all', () => {
    expect(integrationRegistry.list().map((a) => a.providerId)).not.toContain('s3');
    expect(integrationRegistry.getByCategory('storage')).toEqual([]);
  });

  it('GET /v1/admin/integrations does not list s3', async () => {
    const r = await call('GET', '/v1/admin/integrations');
    expect(r.status).toBe(200);
    const data = (JSON.parse(r.text) as {
      data: { byCategory: Record<string, number>; integrations: Array<{ providerId: string }> };
    }).data;
    expect(data.integrations.map((i) => i.providerId)).not.toContain('s3');
    expect(data.byCategory.storage).toBeUndefined();
  });
});

describe('the S3 health probe no longer answers healthy', () => {
  it('POST /v1/admin/integrations/s3/test is refused as an unknown provider, even with a key on file', async () => {
    const r = await call('POST', '/v1/admin/integrations/s3/test');
    expect(r.text, 'the stub said healthy without ever calling AWS').not.toContain('"healthy":true');
    expect(r.status).toBe(422);
    expect(errorCodeOf(r.text)).toBe('PROVIDER_NOT_FOUND');
  });
});

describe('no customer AWS key can be stored', () => {
  it('PUT /v1/admin/integrations/s3 is refused and writes nothing', async () => {
    const r = await call('PUT', '/v1/admin/integrations/s3', SYNTHETIC_S3_CONFIG);
    expect(
      db.statements.filter((sql) => /INSERT INTO integration_credentials/.test(sql)),
      'the stub encrypted the two keys into integration_credentials'
    ).toEqual([]);
    expect(r.status).toBe(422);
    expect(errorCodeOf(r.text)).toBe('PROVIDER_NOT_FOUND');
  });
});

describe('S3_BUCKET leaves the dead configuration', () => {
  it('no configuration field and no documented variable names a bucket that nothing writes to', () => {
    // SECURITY: a boolean, never `expect(config.aws)`: a failing matcher prints
    // the object it was given, and `config.aws` carries the AWS keys of the
    // environment the suite runs in.
    expect('s3Bucket' in config.aws).toBe(false);
    const example = readFileSync(path.join(__dirname, '..', '..', '.env.example'), 'utf8');
    expect(example).not.toMatch(/S3_BUCKET/);
  });
});
