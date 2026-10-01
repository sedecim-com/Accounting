import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import { z } from 'zod';

// ============================================================
// CONTRACT: the REST 422 body, and the parsed body behind it (#367).
//
// This file must pass UNCHANGED on zod 3.25.76 and on zod 4: the owner's
// decision on #367 is that the Zod 4 migration keeps every 422 byte-identical
// (code, prose, field paths, issue order) and every parsed body identical.
// The only exceptions are the tightenings listed in TIGHTENINGS below, which
// carry both expectations so the owner reviews them before the bump.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
  withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) })
  ),
  withTenant: vi.fn(async (_t: string, fn: () => Promise<unknown>) => fn()),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
  getClient: vi.fn(),
  setTenantSchema: vi.fn(),
  initDatabase: vi.fn(),
  closeDatabase: vi.fn(),
  getPool: vi.fn(),
}));

import {
  REST_BODY_GOLDEN,
  UUID_SAMPLE as ID,
  outcomeOf,
  probedRoutes,
  recordRestBodyGolden,
} from '../golden/rest-body-probes.js';
import { errorHandler } from '../../../src/api/rest/middleware/error-handler.js';
import { AppError } from '../../../src/utils/errors.js';

/** True once `zod` resolves to a v4 runtime; the tightening rows pick their expectation with it. */
const ZOD4 = '_zod' in z.string();

const ROUTES = probedRoutes();
const HANDLERS = new Map(ROUTES.map((r) => [r.key, r.handler]));

function handlerFor(key: string): RequestHandler {
  const handler = HANDLERS.get(key);
  if (!handler) throw new Error(`no mounted route validates a body at ${key}`);
  return handler;
}

const line = (extra: Record<string, unknown> = {}) => ({ account_id: ID, debit_amount: '10', ...extra });
const movement = (extra: Record<string, unknown> = {}) => ({
  bank_transaction_id: 't',
  transaction_date: '2024-01-15',
  amount: '1',
  description: 'd',
  ...extra,
});
const CAP_EXIT = 'Parte el extracto, o cárgalo con `mnemosine bank statement import`, que inserta por lotes.';
const INVALID = 'Invalid request body: ';

describe('G1 · every REST body probe answers exactly what zod 3 answered', () => {
  it('matches tests/api/golden/rest-body.golden.json entry by entry', () => {
    const golden = JSON.parse(fs.readFileSync(REST_BODY_GOLDEN, 'utf8')) as Record<string, string>;
    const actual = recordRestBodyGolden();
    const missing = Object.keys(golden).filter((k) => !(k in actual));
    const stale = Object.keys(actual).filter((k) => !(k in golden));
    const differ = Object.keys(golden)
      .filter((k) => k in actual && actual[k] !== golden[k])
      .map((k) => `${k}\n    golden: ${golden[k]}\n    actual: ${actual[k]}`);
    const report = [
      ...missing.map((k) => `missing probe: ${k}`),
      ...stale.map((k) => `probe not in the golden: ${k}`),
      ...differ.slice(0, 20),
    ];
    // The golden was recorded on zod 3 and is the contract: on the Zod 4
    // branch of #367 a difference is fixed in src/utils/zod-client-errors.ts
    // or src/utils/zod-compat.ts, never by regenerating the golden.
    expect(report, `${differ.length} probe(s) differ; do not regenerate the golden in #367 branch 2`).toEqual([]);
  });

  it('probes every route that validates a body, and never crashes the validator', () => {
    expect(ROUTES.length).toBeGreaterThanOrEqual(45);
    const golden = JSON.parse(fs.readFileSync(REST_BODY_GOLDEN, 'utf8')) as Record<string, string>;
    expect(Object.values(golden).filter((v) => v.startsWith('THROW'))).toEqual([]);
  });

  it('labels as valid only the samples every route accepts', () => {
    // A refinement JSON Schema cannot express needs its fixup in
    // rest-body-probes.ts (SAMPLE_FIXUPS); a "valid" probe that answers 422
    // would pin a rejection under the name of an acceptance.
    const actual = recordRestBodyGolden();
    const refused = Object.entries(actual)
      .filter(([key, outcome]) => / · (minimal|full)Valid$/.test(key) && !outcome.startsWith('OK '))
      .map(([key, outcome]) => `${key}: ${outcome}`);
    expect(refused).toEqual([]);
  });
});

describe('G2 · targeted rows on real routes', () => {
  const rows: Array<[string, string, unknown, string]> = [
    ['a refine message at the root', 'PATCH /v1/accounts/:id', {}, `422 VALIDATION_ERROR ${INVALID}<root>: At least one field must be provided`],
    [
      'a custom array minimum',
      'POST /v1/journal-entries',
      { entity_id: ID, entry_date: '2024-01-15', lines: [line()] },
      `422 VALIDATION_ERROR ${INVALID}lines: At least 2 lines required`,
    ],
    [
      'a refine message on an array element',
      'POST /v1/journal-entries',
      { entity_id: ID, entry_date: '2024-01-15', lines: [line({ credit_amount: '1' }), line()] },
      `422 VALIDATION_ERROR ${INVALID}lines.0: Each line must have either debit_amount OR credit_amount, not both`,
    ],
    [
      'decimalString turns a number into a string',
      'POST /v1/journal-entries',
      { entity_id: ID, entry_date: '2024-01-15', lines: [line({ debit_amount: 12.5 }), { account_id: ID, credit_amount: 12.5 }] },
      `OK {"entity_id":"${ID}","entry_date":"2024-01-15","lines":[{"account_id":"${ID}","debit_amount":"12.5"},{"account_id":"${ID}","credit_amount":"12.5"}]}`,
    ],
    ['a custom string minimum (invoices)', 'POST /v1/invoices/:id/void', { reason: '' }, `422 VALIDATION_ERROR ${INVALID}reason: Reason is required for voiding`],
    ['a custom string minimum (journal entries)', 'POST /v1/journal-entries/:id/void', { reason: '' }, `422 VALIDATION_ERROR ${INVALID}reason: Reason is required for voiding`],
    ['an either-or refine', 'POST /v1/upload', {}, `422 VALIDATION_ERROR ${INVALID}<root>: xml_content or xml_contents array is required`],
    [
      'the array cap names what arrived and where to go',
      'POST /v1/bank-accounts/:account_id/import',
      { transactions: Array.from({ length: 5001 }, () => movement()) },
      `422 VALIDATION_ERROR ${INVALID}transactions: llegaron 5001 movimientos y caben 5000 por petición. ${CAP_EXIT}`,
    ],
    [
      // CONTRACT (#407, MNE-001-395; frozen by #367 until then): a body past the
      // cap is refused before its elements are validated, so the element issue
      // that used to precede the cap line is no longer listed.
      'the array cap is reported alone, before the element issues',
      'POST /v1/bank-accounts/:account_id/import',
      { transactions: [movement({ bank_transaction_id: '' }), ...Array.from({ length: 5000 }, () => movement())] },
      `422 VALIDATION_ERROR ${INVALID}transactions: llegaron 5001 movimientos y caben 5000 por petición. ${CAP_EXIT}`,
    ],
    [
      'passthrough keeps an unknown key',
      'POST /v1/bank-accounts/:account_id/import',
      { transactions: [movement({ memo: 'kept' })] },
      'OK {"transactions":[{"bank_transaction_id":"t","transaction_date":"2024-01-15","amount":"1","description":"d","memo":"kept"}]}',
    ],
    ['an enum default', 'POST /v1/payroll/pay-runs', { pay_period_id: ID }, `OK {"pay_period_id":"${ID}","run_type":"regular"}`],
    ['a boolean default', 'POST /v1/payroll/benefit-plans', { plan_name: 'p', plan_type: 'hsa' }, 'OK {"plan_name":"p","plan_type":"hsa","is_pre_tax":true}'],
    [
      'strip drops an unknown key',
      'POST /v1/payroll/pay-schedules/:id/generate-periods',
      { count: 2, extra: 1 },
      'OK {"count":2}',
    ],
    [
      'strict rejects unknown keys, in order',
      'POST /v1/payroll/finiquito',
      { employee_id: ID, termination_date: '2024-01-15', last_paid_through: '2024-01-15', termination_reason: 'renuncia', x: 1, y: 2 },
      `422 VALIDATION_ERROR ${INVALID}<root>: Unrecognized key(s) in object: 'x', 'y'`,
    ],
    ['a body record rejects an array', 'PUT /v1/admin/integrations/:provider', [], `422 VALIDATION_ERROR ${INVALID}<root>: Expected object, received array`],
    ['a body record rejects null', 'PUT /v1/admin/integrations/:provider', null, `422 VALIDATION_ERROR ${INVALID}<root>: Expected object, received null`],
    ['a body record accepts {}', 'PUT /v1/admin/integrations/:provider', {}, 'OK {}'],
    [
      'a record value keeps its type',
      'PUT /v1/admin/blockchain/disclosure-config',
      { category_disclosure: { x: '1' } },
      `422 VALIDATION_ERROR ${INVALID}category_disclosure.x: Expected number, received string`,
    ],
    ['an array minimum', 'POST /v1/webhooks', { url: 'https://a.com', events: [] }, `422 VALIDATION_ERROR ${INVALID}events: Array must contain at least 1 element(s)`],
    [
      'an integer check does not stop the bounds after it',
      'POST /v1/payroll/pay-schedules/:id/generate-periods',
      { count: 0.5 },
      `422 VALIDATION_ERROR ${INVALID}count: Expected integer, received float; count: Number must be greater than or equal to 1`,
    ],
    [
      'a missing enum is Required',
      'POST /v1/payroll/finiquito',
      { employee_id: ID, termination_date: '2024-01-15', last_paid_through: '2024-01-15' },
      `422 VALIDATION_ERROR ${INVALID}termination_reason: Required`,
    ],
    [
      'a custom regex message',
      'POST /v1/payroll/finiquito',
      { employee_id: ID, termination_date: 'x', last_paid_through: '2024-01-15', termination_reason: 'renuncia' },
      `422 VALIDATION_ERROR ${INVALID}termination_date: YYYY-MM-DD`,
    ],
    [
      'a non-RFC id is a valid id',
      'POST /v1/payroll/pay-runs',
      { pay_period_id: '00000000-0000-0000-0000-000000000001' },
      'OK {"pay_period_id":"00000000-0000-0000-0000-000000000001","run_type":"regular"}',
    ],
    [
      'lengths count UTF-16 units',
      'POST /v1/payroll/employees',
      { first_name: '\u{1F600}'.repeat(51), last_name: 'l', country_code: 'MX', hire_date: '2024-01-15' },
      `422 VALIDATION_ERROR ${INVALID}first_name: String must contain at most 100 character(s)`,
    ],
  ];

  it.each(rows)('%s', (_label, key, body, expected) => {
    expect(outcomeOf(handlerFor(key), body)).toBe(expected);
  });
});

// ─── over HTTP: express.json, the real validator and the real errorHandler ───

let baseUrl = '';
let close: () => Promise<void> = async () => {};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  for (const [i, route] of ROUTES.entries()) {
    app.post(`/probe/${i}`, route.handler, (req, res) => {
      res.json({ ok: true, body: req.body as unknown });
    });
  }
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    const server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      close = () => new Promise((done) => server.close(() => done()));
      resolve();
    });
  });
});

afterAll(async () => {
  await close();
});

async function post(key: string, raw: string, headers: Record<string, string> = {}): Promise<Response> {
  const index = ROUTES.findIndex((r) => r.key === key);
  if (index < 0) throw new Error(`no mounted route validates a body at ${key}`);
  return fetch(`${baseUrl}/probe/${index}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw,
  });
}

/** One line per HTTP outcome, in the same grammar as the golden. */
async function httpOutcome(key: string, raw: string): Promise<string> {
  const res = await post(key, raw);
  const json = (await res.json()) as { body?: unknown; errors?: Array<{ code: string; message: string }> };
  const first = json.errors?.[0];
  return first ? `${res.status} ${first.code} ${first.message}` : `OK ${JSON.stringify(json.body)}`;
}

describe('T1/T2 · the only deliberate tightenings of the Zod 4 migration', () => {
  // Each row states what zod 3 does and what zod 4 does. Everything else in
  // this file is identical on both. JSON 1e999 parses to Infinity, which zod 3
  // accepted as a number (journal entries stored the string 'Infinity') unless
  // a check of the field refused it: there, and on any field that is not a
  // number, the 422 is still zod 3's (the rows marked "as before", and every
  // Infinity probe of the golden). An integer beyond 2^53 - 1 cannot be
  // carried exactly by JSON.
  const TIGHTENINGS: Array<[string, string, string, string, string]> = [
    [
      'T1 · 1e999 as a journal amount',
      'POST /v1/journal-entries',
      `{"entity_id":"${ID}","entry_date":"2024-01-15","lines":[{"account_id":"${ID}","debit_amount":1e999},{"account_id":"${ID}","credit_amount":"1"}]}`,
      `OK {"entity_id":"${ID}","entry_date":"2024-01-15","lines":[{"account_id":"${ID}","debit_amount":"Infinity"},{"account_id":"${ID}","credit_amount":"1"}]}`,
      `422 VALIDATION_ERROR ${INVALID}lines.0.debit_amount: Invalid input`,
    ],
    [
      'T1 · 1e999 as a disclosure weight',
      'PUT /v1/admin/blockchain/disclosure-config',
      '{"category_disclosure":{"x":1e999}}',
      'OK {"category_disclosure":{"x":null}}',
      `422 VALIDATION_ERROR ${INVALID}category_disclosure.x: Number must be finite`,
    ],
    [
      'T1 · 1e999 under a lower bound it does not break',
      'PUT /v1/admin/blockchain/disclosure-config',
      '{"round_to_nearest":1e999}',
      'OK {"round_to_nearest":null}',
      `422 VALIDATION_ERROR ${INVALID}round_to_nearest: Number must be finite`,
    ],
    [
      'T1 · -1e999 under a lower bound it breaks answers as before',
      'PUT /v1/admin/blockchain/disclosure-config',
      '{"round_to_nearest":-1e999}',
      `422 VALIDATION_ERROR ${INVALID}round_to_nearest: Number must be greater than 0`,
      `422 VALIDATION_ERROR ${INVALID}round_to_nearest: Number must be greater than 0`,
    ],
    [
      'T1 · 1e999 on a bounded integer answers as before',
      'POST /v1/payroll/pay-schedules/:id/generate-periods',
      '{"count":1e999}',
      `422 VALIDATION_ERROR ${INVALID}count: Expected integer, received float; count: Number must be less than or equal to 208`,
      `422 VALIDATION_ERROR ${INVALID}count: Expected integer, received float; count: Number must be less than or equal to 208`,
    ],
    [
      'T1 · 1e999 on a string field answers as before',
      'POST /v1/accounts',
      `{"code":1e999,"name":"a","account_type":"asset","entity_id":"${ID}","normal_balance":"debit"}`,
      `422 VALIDATION_ERROR ${INVALID}code: Expected string, received number`,
      `422 VALIDATION_ERROR ${INVALID}code: Expected string, received number`,
    ],
    [
      'T2 · 2^53 as a rule priority',
      'POST /v1/processing-rules',
      '{"rule_name":"r","rule_type":"t","priority":9007199254740992,"conditions":{},"actions":{}}',
      'OK {"rule_name":"r","rule_type":"t","priority":9007199254740992,"conditions":{},"actions":{}}',
      `422 VALIDATION_ERROR ${INVALID}priority: Number must be less than or equal to 9007199254740991`,
    ],
    [
      'T2 · 2^53 under a tighter bound answers as before',
      'POST /v1/payroll/pay-schedules/:id/generate-periods',
      '{"count":9007199254740992}',
      `422 VALIDATION_ERROR ${INVALID}count: Number must be less than or equal to 208`,
      `422 VALIDATION_ERROR ${INVALID}count: Number must be less than or equal to 208`,
    ],
  ];

  it.each(TIGHTENINGS)('%s', async (_label, key, raw, onZod3, onZod4) => {
    expect(await httpOutcome(key, raw)).toBe(ZOD4 ? onZod4 : onZod3);
  });
});

describe('G4 · a record entry keyed __proto__, as express.json delivers it', () => {
  // JSON.parse keeps `__proto__` as an own key. zod 3 validated that entry in
  // key order and left it out of the parsed body; zod 4's record skips it
  // unless it is built with recordOf (src/utils/zod-compat.ts).
  const key = 'PUT /v1/admin/blockchain/disclosure-config';
  const rows: Array<[string, string, string]> = [
    [
      'a wrong value is reported',
      '{"category_disclosure":{"__proto__":"x","retail":1}}',
      `422 VALIDATION_ERROR ${INVALID}category_disclosure.__proto__: Expected number, received string`,
    ],
    [
      'in key order',
      '{"category_disclosure":{"a":"y","__proto__":{"polluted":true},"b":"z"}}',
      `422 VALIDATION_ERROR ${INVALID}category_disclosure.a: Expected number, received string; ` +
        'category_disclosure.__proto__: Expected number, received object; ' +
        'category_disclosure.b: Expected number, received string',
    ],
    ['a valid value is left out of the body', '{"category_disclosure":{"__proto__":1,"retail":2}}', 'OK {"category_disclosure":{"retail":2}}'],
  ];

  it.each(rows)('%s', async (_label, raw, expected) => {
    expect(await httpOutcome(key, raw)).toBe(expected);
  });
});

describe('G5 · a URL field accepts an IDN host however warm the process is', () => {
  // zod 3 ran `new URL`. Node 22's URL.canParse turns false for a Latin-1 URL
  // with a non-ASCII host once V8 optimizes the call, so a cold golden alone
  // cannot tell the two apart: warm each route first, then probe it.
  const IDN = ['https://señal.mx/hook', 'https://müller.de', 'https://ñ.com'];
  const rows: Array<[string, (url: string) => unknown]> = [
    ['POST /v1/webhooks', (url) => ({ url, events: ['invoice.created'] })],
    ['PUT /v1/admin/bitcoin/config', (url) => ({ ots_calendars: [url] })],
  ];

  it.each(rows)('%s', (key, body) => {
    const handler = handlerFor(key);
    for (let i = 0; i < 20_000; i++) outcomeOf(handler, JSON.parse(JSON.stringify(body(`https://a${i % 7}.com/x`))));
    for (const url of IDN) expect(outcomeOf(handler, body(url))).toBe(`OK ${JSON.stringify(body(url))}`);
  });
});

describe('G3 · the 422 envelope', () => {
  it('answers 422 with a prose error and the v1 meta, and declares no language', async () => {
    const res = await post('POST /v1/journal-entries', '{}', { 'x-request-id': 'req-367' });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-language')).toBeNull();
    expect(res.headers.get('vary')).toBeNull();
    const json = (await res.json()) as {
      errors: Array<Record<string, unknown>>;
      meta: Record<string, unknown>;
    };
    expect(json.errors).toHaveLength(1);
    const [error] = json.errors;
    expect(Object.keys(error ?? {}).sort()).toEqual(['code', 'message']);
    expect(error).toEqual({
      code: 'VALIDATION_ERROR',
      message: `${INVALID}entity_id: Required; entry_date: Required; lines: Required`,
    });
    expect(Object.keys(json.meta).every((k) => ['request_id', 'timestamp', 'version'].includes(k))).toBe(true);
    expect(json.meta.request_id).toBe('req-367');
    expect(json.meta.version).toBe('v1');
    expect(json.meta).not.toHaveProperty('language');
  });
});

describe('never a 500 · every mounted body schema, hostile bodies', () => {
  const HOSTILE: unknown[] = [
    null,
    [],
    'x',
    0,
    true,
    {},
    JSON.parse('{"__proto__":{"x":1}}'),
    { lines: 'x' },
    { lines: [null] },
  ];

  it('calls next exactly once, with nothing or with a 422', () => {
    const failures: string[] = [];
    for (const route of ROUTES) {
      for (const body of HOSTILE) {
        const calls: unknown[][] = [];
        try {
          void route.handler(
            { body } as express.Request,
            {} as express.Response,
            (...args: unknown[]) => {
              calls.push(args);
            }
          );
        } catch (err) {
          failures.push(`${route.key} ${JSON.stringify(body)}: threw ${String(err)}`);
          continue;
        }
        const err = calls[0]?.[0];
        const is422 = err instanceof AppError && err.statusCode === 422 && err.code === 'VALIDATION_ERROR';
        if (calls.length !== 1 || (err !== undefined && !is422)) {
          failures.push(`${route.key} ${JSON.stringify(body)}: next called ${calls.length} time(s) with ${String(err)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
