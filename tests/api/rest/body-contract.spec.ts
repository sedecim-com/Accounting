import * as fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express, { type RequestHandler } from 'express';
import { z } from 'zod';

// ============================================================
// CONTRACT: the REST 422 body, and the parsed body behind it (#367).
// CONTRACT: the over-cap 422 diverges from the zod 3 recording by design since #407 / MNE-001-395, and the `overCapWithViolations` probes are post-migration additions.
// CONTRACT: since MNE-001-588 the over-cap line is a catalogue key: English here, and under es the Spanish every language read before (G6).
//
// Except for the over-cap 422 (#407), this file must pass UNCHANGED on zod 3.25.76 and on zod 4: the owner's
// decision on #367 is that the Zod 4 migration keeps every 422 byte-identical
// (code, prose, field paths, issue order) and every parsed body identical.
// The only exceptions are the tightenings listed in TIGHTENINGS below, which
// carry both expectations so the owner reviews them before the bump.
//
// CONTRACT: since MNE-001-152 (#151) the 422 of validateBody and validateQuery
// is written by catalog key. Its English stays byte for byte the zod 3 text
// every row here pins, and it is what a request reads unless it names a
// supported language: no header, `*` (what `fetch` sends below) and only
// unsupported languages all read English. Only `es` reads Spanish (G3).
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
import { negotiateLocale } from '../../../src/api/rest/middleware/locale.js';
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
// The cap's English since MNE-001-588; before it every language read the Spanish that es.ts keeps.
const CAP_LINE =
  'transactions: 5001 transactions arrived and 5000 fit in one request. Split the statement, or load it with `mnemosine bank statement import`, which inserts in batches.';
const INVALID = 'Invalid request body: ';

describe('G1 · every REST body probe answers what zod 3 answered (bar the #407 over-cap 422)', () => {
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
      `422 VALIDATION_ERROR ${INVALID}${CAP_LINE}`,
    ],
    [
      // CONTRACT (#407, MNE-001-395; frozen by #367 until then): a body past the
      // cap is refused before its elements are validated, so the element issue
      // that used to precede the cap line is no longer listed.
      'the array cap is reported alone, before the element issues',
      'POST /v1/bank-accounts/:account_id/import',
      { transactions: [movement({ bank_transaction_id: '' }), ...Array.from({ length: 5000 }, () => movement())] },
      `422 VALIDATION_ERROR ${INVALID}${CAP_LINE}`,
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
  // As src/index.ts mounts it: the 422 answers in the language the request named.
  app.use(negotiateLocale);
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
  interface Envelope {
    errors: Array<Record<string, unknown>>;
    meta: Record<string, unknown>;
  }
  const ENGLISH = `${INVALID}entity_id: Required; entry_date: Required; lines: Required`;
  const SPANISH = 'Cuerpo de la petición inválido: entity_id: Obligatorio; entry_date: Obligatorio; lines: Obligatorio';

  /** The envelope of every 422: one error with `code` and `message` only, and the v1 meta. */
  function expectEnvelope(json: Envelope, message: string, language: string): void {
    expect(json.errors).toHaveLength(1);
    const [error] = json.errors;
    expect(Object.keys(error ?? {}).sort()).toEqual(['code', 'message']);
    expect(error).toEqual({ code: 'VALIDATION_ERROR', message });
    expect(Object.keys(json.meta).sort()).toEqual(['language', 'request_id', 'timestamp', 'version']);
    expect(json.meta.request_id).toBe('req-367');
    expect(json.meta.version).toBe('v1');
    expect(json.meta.language).toBe(language);
  }

  /**
   * A POST through `node:http`, not `fetch`: fetch adds `accept-language: *`
   * to every request that does not set one, so with it the header-less case
   * would never leave the client without a header.
   */
  function postWithoutLanguage(key: string, raw: string) {
    const index = ROUTES.findIndex((r) => r.key === key);
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: Envelope }>(
      (resolve, reject) => {
        const req = httpRequest(
          `${baseUrl}/probe/${index}`,
          { method: 'POST', headers: { 'content-type': 'application/json', 'x-request-id': 'req-367' } },
          (res) => {
            let text = '';
            res.setEncoding('utf-8');
            res.on('data', (chunk: string) => (text += chunk));
            res.on('end', () => {
              try {
                resolve({ status: res.statusCode ?? 0, headers: res.headers, json: JSON.parse(text) as Envelope });
              } catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
              }
            });
          }
        );
        req.on('error', reject);
        req.end(raw);
      }
    );
  }

  it('Accept-Language: en reads the zod 3 English, and says so', async () => {
    const res = await post('POST /v1/journal-entries', '{}', { 'x-request-id': 'req-367', 'accept-language': 'en' });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-language')).toBe('en-US');
    expect((res.headers.get('vary') ?? '').toLowerCase()).toContain('accept-language');
    expectEnvelope((await res.json()) as Envelope, ENGLISH, 'en');
  });

  it('Accept-Language: es reads the same code in Spanish, and says so', async () => {
    const res = await post('POST /v1/journal-entries', '{}', { 'x-request-id': 'req-367', 'accept-language': 'es' });
    expect(res.status).toBe(422);
    expect(res.headers.get('content-language')).toBe('es-MX');
    expect((res.headers.get('vary') ?? '').toLowerCase()).toContain('accept-language');
    expectEnvelope((await res.json()) as Envelope, SPANISH, 'es');
  });

  it('without Accept-Language the 422 stays English, the one exception to DEFAULT_LOCALE', async () => {
    const res = await postWithoutLanguage('POST /v1/journal-entries', '{}');
    expect(res.status).toBe(422);
    expect(res.headers['content-language']).toBe('en-US');
    expectEnvelope(res.json, ENGLISH, 'en');
  });

  it('Accept-Language: * (what fetch sends) and only unsupported languages stay English too', async () => {
    for (const header of ['*', 'fr']) {
      const res = await post('POST /v1/journal-entries', '{}', { 'x-request-id': 'req-367', 'accept-language': header });
      expect(res.status).toBe(422);
      expect(res.headers.get('content-language'), header).toBe('en-US');
      expectEnvelope((await res.json()) as Envelope, ENGLISH, 'en');
    }
  });

  it('a message the schema writes itself reads Spanish after the Spanish frame (MNE-001-588)', async () => {
    const res = await post('PATCH /v1/accounts/:id', '{}', { 'x-request-id': 'req-367', 'accept-language': 'es' });
    expect(res.status).toBe(422);
    expectEnvelope(
      (await res.json()) as Envelope,
      'Cuerpo de la petición inválido: <root>: Debe enviarse al menos un campo',
      'es'
    );
  });
});

describe('G6 · every message a schema sets itself is a catalogue key (MNE-001-588)', () => {
  // One row per message: its English is the text the schema always wrote
  // (G1 pins it against the golden), and Spanish now renders it too. Every
  // literal is written by hand.
  const SPANISH_FRAME = 'Cuerpo de la petición inválido: ';
  const match = (extra: Record<string, unknown>) => ({ matched_entity_type: 'journal_entry_line', matched_entity_id: ID, ...extra });
  const severance = { employee_id: ID, termination_date: 'x', last_paid_through: '2024-01-15', termination_reason: 'renuncia' };
  const rows: Array<[string, string, unknown, string, string]> = [
    ['an empty PATCH (accounts)', 'PATCH /v1/accounts/:id', {}, '<root>: At least one field must be provided', '<root>: Debe enviarse al menos un campo'],
    ['an empty PATCH (pre-registrations)', 'PATCH /v1/pre-registrations/:id', {}, '<root>: At least one field required', '<root>: Hace falta al menos un campo'],
    ['an upload with no XML', 'POST /v1/upload', {}, '<root>: xml_content or xml_contents array is required', '<root>: Hace falta xml_content o el arreglo xml_contents'],
    ['a customer with no name', 'POST /v1/customers', { entity_id: ID }, '<root>: company_name or first_name is required', '<root>: Hace falta company_name o first_name'],
    [
      'a line with both amounts',
      'POST /v1/journal-entries',
      { entity_id: ID, entry_date: '2024-01-15', lines: [line({ credit_amount: '1' }), line()] },
      'lines.0: Each line must have either debit_amount OR credit_amount, not both',
      'lines.0: Cada renglón lleva debit_amount O credit_amount, no los dos',
    ],
    ['an unknown PAC', 'PUT /v1/admin/integrations/pac/preferences/all', { pac_primary: 'nope' }, 'pac_primary: Unknown PAC provider', 'pac_primary: Proveedor de PAC desconocido'],
    ['a matched amount of the wrong type', 'POST /v1/bank-accounts/transactions/:id/match', match({ matched_amount: true }), 'matched_amount: matched_amount must be a positive decimal', 'matched_amount: matched_amount debe ser un decimal positivo'],
    ['a matched amount left out', 'POST /v1/bank-accounts/transactions/:id/match', match({}), 'matched_amount: Required', 'matched_amount: Obligatorio'],
    [
      'a matched amount with five decimals',
      'POST /v1/bank-accounts/transactions/:id/match',
      match({ matched_amount: '1.00001' }),
      'matched_amount: matched_amount must be a positive decimal with at most 4 fractional digits',
      'matched_amount: matched_amount debe ser un decimal positivo con 4 decimales como máximo',
    ],
    ['an invoice with no lines', 'POST /v1/invoices', { entity_id: ID, customer_id: ID, invoice_date: '2024-01-15', due_date: '2024-01-15', lines: [] }, 'lines: At least 1 line required', 'lines: Hace falta al menos 1 renglón'],
    ['a journal entry with one line', 'POST /v1/journal-entries', { entity_id: ID, entry_date: '2024-01-15', lines: [line()] }, 'lines: At least 2 lines required', 'lines: Hacen falta al menos 2 renglones'],
    ['a void with no reason', 'POST /v1/invoices/:id/void', { reason: '' }, 'reason: Reason is required for voiding', 'reason: Para anular hace falta un motivo'],
    ['a date that is not one', 'POST /v1/payroll/finiquito', severance, 'termination_date: YYYY-MM-DD', 'termination_date: AAAA-MM-DD'],
  ];

  /** The error `validateBody` hands to `next` for `body`. */
  function refusalOf(key: string, body: unknown): AppError {
    let caught: unknown;
    void handlerFor(key)({ body } as express.Request, {} as express.Response, (err?: unknown) => {
      caught = err;
    });
    if (!(caught instanceof AppError)) throw new Error(`${key} did not refuse the body`);
    return caught;
  }

  it.each(rows)('%s', (_label, key, body, english, spanish) => {
    const err = refusalOf(key, body);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.message).toBe(`${INVALID}${english}`);
    expect(err.localized('en')).toBe(`${INVALID}${english}`);
    expect(err.localized('es')).toBe(`${SPANISH_FRAME}${spanish}`);
  });

  // An array past its cap, whatever else the body carries: the cap line is
  // English under en and, in Spanish, the text every cap answered with before.
  const over = (n: number): unknown[] => Array.from({ length: n }, () => null);
  const caps: Array<[string, string, unknown, string, string]> = [
    [
      'the bank statement import',
      'POST /v1/bank-accounts/:account_id/import',
      { transactions: over(5001) },
      'transactions: 5001 transactions arrived and 5000 fit in one request. Split the statement, or load it with `mnemosine bank statement import`, which inserts in batches.',
      'transactions: llegaron 5001 movimientos y caben 5000 por petición. Parte el extracto, o cárgalo con `mnemosine bank statement import`, que inserta por lotes.',
    ],
    [
      'the lines of a vendor bill',
      'POST /v1/bills',
      { lines: over(1001) },
      'lines: 1001 lines arrived and 1000 fit in one request. Split the voucher: with more lines than that, what you have is an import.',
      'lines: llegaron 1001 renglones y caben 1000 por petición. Parte el comprobante: con más renglones que eso lo que hay es una importación.',
    ],
    [
      'the applications of a vendor payment',
      'POST /v1/bills/payments',
      { applications: over(501) },
      'applications: 501 applications arrived and 500 fit in one request. A payment against more documents than that is a remittance: record it as several payments.',
      'applications: llegaron 501 aplicaciones y caben 500 por petición. Un pago contra más documentos que eso es una remesa: regístrala como varios pagos.',
    ],
    [
      'the lines of an invoice',
      'POST /v1/invoices',
      { lines: over(1001) },
      'lines: 1001 lines arrived and 1000 fit in one request. Split the invoice: no PAC stamps a voucher with more lines than that.',
      'lines: llegaron 1001 renglones y caben 1000 por petición. Parte la factura: un comprobante con más renglones que eso no lo timbra ningún PAC.',
    ],
    [
      'the lines of a journal entry',
      'POST /v1/journal-entries',
      { lines: over(1001) },
      'lines: 1001 lines arrived and 1000 fit in one request. A journal entry longer than that is an import: split it, or use `mnemosine entry import`.',
      'lines: llegaron 1001 renglones y caben 1000 por petición. Una póliza más larga que eso es una importación: pártela, o usa `mnemosine entry import`.',
    ],
    [
      'the ids of a bulk pre-registration action',
      'POST /v1/pre-registrations/bulk',
      { ids: over(101) },
      'ids: 101 ids arrived and 100 fit in one request. Split the batch into several requests.',
      'ids: llegaron 101 ids y caben 100 por petición. Parte el lote en varias peticiones.',
    ],
    [
      'the XML documents of an upload',
      'POST /v1/upload',
      { xml_contents: over(101) },
      'xml_contents: 101 documents arrived and 100 fit in one request. Split the batch, or load it with `mnemosine ingest`, which processes one file at a time.',
      'xml_contents: llegaron 101 documentos y caben 100 por petición. Parte el lote, o cárgalo con `mnemosine ingest`, que procesa por archivo.',
    ],
  ];

  it.each(caps)('the cap of %s', (_label, key, body, english, spanish) => {
    const err = refusalOf(key, body);
    expect(err.message.startsWith(INVALID)).toBe(true);
    expect(err.message.slice(INVALID.length).split('; ')).toContain(english);
    expect(err.localized('en')).toBe(err.message);
    const es = err.localized('es');
    expect(es.startsWith(SPANISH_FRAME)).toBe(true);
    expect(es.slice(SPANISH_FRAME.length).split('; ')).toContain(spanish);
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
