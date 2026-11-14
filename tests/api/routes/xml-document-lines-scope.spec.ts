import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ============================================================
// #588 · THE LINES QUERY CARRIES ITS OWN ENTITY SCOPE
//
// GET /v1/xml-documents/:id reads the document through requireByIdInScope and
// then its lines. Over HTTP a foreign id already leaves by the 404 of the first
// read, so the integration spec cannot see whether the lines query is scoped
// by itself. Invariant 4 asks every query to carry the entity in its SQL, so
// this spec looks at the statement the route sends: with the database mocked,
// the document read always finds a row and the lines read is recorded.
// ============================================================

// vi.mock is hoisted above every declaration, so the log is hoisted with it.
const calls = vi.hoisted(() => [] as Array<{ sql: string; params: unknown[] }>);

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    // scope.ts deduces each table's scope column from the catalogue.
    if (/information_schema\.columns/.test(sql)) {
      return { rows: [{ table_name: 'xml_documents', column_name: 'entity_id' }], rowCount: 1 };
    }
    calls.push({ sql, params });
    return /FROM\s+xml_documents\b/.test(sql) && !/xml_document_lines/.test(sql)
      ? { rows: [{ id: params[0], entity_id: 'e-1' }], rowCount: 1 }
      : { rows: [], rowCount: 0 };
  }),
  withTransaction: vi.fn(),
  withTenant: vi.fn(async (_t: string, fn: () => Promise<unknown>) => fn()),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
  getClient: vi.fn(),
  setTenantSchema: vi.fn(),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getPool: vi.fn(),
}));

import xmlIngestionRouter from '../../../src/api/rest/routes/xml-ingestion.js';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    req.user = { user_id: 'u-1', tenant_id: 't-1', entities: ['e-1'], permissions: ['*'] } as never;
    req.tenantId = 't-1';
    req.entityId = 'e-1';
    next();
  });
  app.use('/v1', xmlIngestionRouter);
  app.use(errorHandler);
  await new Promise<void>((ok) => {
    server = app.listen(0, '127.0.0.1', ok);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
});

describe('#588 · the lines of an XML document are read inside the caller entity', () => {
  it('binds the caller entity to an entity_id predicate in the lines query', async () => {
    calls.length = 0;
    const r = await fetch(`${baseUrl}/v1/xml-documents/d-1`);
    expect(r.status).toBe(200);

    const lines = calls.find((c) => /xml_document_lines/.test(c.sql));
    expect(lines, 'the route never read the lines').toBeDefined();
    const sqlOnly = lines!.sql.replace(/--[^\n]*/g, '');
    const predicate = /\b(?:\w+\.)?entity_id\s*=\s*\$(\d+)/.exec(sqlOnly);
    expect(predicate, `the lines query has no entity predicate: ${sqlOnly}`).not.toBeNull();
    expect(lines!.params[Number(predicate![1]) - 1]).toBe('e-1');
  });
});
