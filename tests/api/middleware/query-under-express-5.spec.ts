import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';
import { emptyBodyAsObject, validateBody, validateQuery } from '../../../src/api/rest/middleware/async-handler.js';

// ============================================================
// THE QUERY STRING AND THE BODY UNDER EXPRESS 5
//
// Express 5 turned `req.query` into a getter that parses the URL again on each
// read, and changed the default parser from 'extended' to 'simple'. Both are
// silent: nothing throws, the handler just sees another value. body-parser 2
// leaves `req.body` undefined where body-parser 1 left `{}`. These cases pin
// what the API had under Express 4.
// ============================================================

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.set('query parser', 'extended');
  app.get(
    '/echo',
    validateQuery('search', z.string().transform((s) => s.trim().toUpperCase())),
    (req, res) => {
      res.json({ first: req.query, second: req.query });
    }
  );
  app.use(express.json());
  app.use(emptyBodyAsObject);
  app.post('/raw', (req, res) => {
    res.json({ body: req.body as unknown });
  });
  app.post('/validated', validateBody(z.object({ name: z.string() })), (_req, res) => {
    res.json({});
  });
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('the query string and the body under Express 5', () => {
  it('the value validateQuery parsed is the one the handler reads, on every read', async () => {
    const res = await fetch(`${baseUrl}/echo?search=%20abc%20&other=1&nested[key]=v`);
    const expected = { search: 'ABC', other: '1', nested: { key: 'v' } };
    expect(await res.json()).toEqual({ first: expected, second: expected });
  });

  it('a request without a body reaches the handler as {}, and is validated as {}', async () => {
    const raw = await fetch(`${baseUrl}/raw`, { method: 'POST' });
    expect(await raw.json()).toEqual({ body: {} });
    const text = await fetch(`${baseUrl}/raw`, { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } });
    expect(await text.json()).toEqual({ body: {} });

    const validated = await fetch(`${baseUrl}/validated`, { method: 'POST' });
    expect(validated.status).toBe(422);
    const answer = (await validated.json()) as { errors: Array<{ message: string }> };
    expect(answer.errors[0].message).toBe('Invalid request body: name: Required');
  });

  it('src/index.ts keeps the extended parser and the empty-object body the API has always had', () => {
    // Booting src/index.ts needs a database, so the setting is read from the source.
    const source = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
    expect(source).toContain("app.set('query parser', 'extended');");
    expect(source).toContain('app.use(emptyBodyAsObject);');
  });
});
