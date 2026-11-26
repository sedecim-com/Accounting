/**
 * MNE-001-729 (#151), I9 by folder, part 6: the messages of src/api/rest that
 * reached the caller in Spanish prose are catalogue keys now. The Spanish twin
 * must print, byte for byte, what each site printed before (the strings below
 * are written by hand from those sites, with synthetic values), and the English
 * is the source each error's `message` is fixed in.
 *
 * A REST call with no Accept-Language reads es-MX, as before; one that asks
 * for English reads English. The requests go over `node:http`, not `fetch`:
 * Node's fetch adds `accept-language: *` to every request that sets none.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn(), getClient: vi.fn(), withTransaction: vi.fn() }));
vi.mock('../../src/api/rest/middleware/rate-limiter.js', () => ({
  preAuthRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import express from 'express';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Mock } from 'vitest';
import { withTransaction } from '../../src/database/connection.js';
import { negotiateLocale } from '../../src/api/rest/middleware/locale.js';
import { errorHandler } from '../../src/api/rest/middleware/error-handler.js';
import { requireEntityAccess } from '../../src/api/rest/middleware/auth.js';
import { bajoLlaveDeIdempotencia } from '../../src/api/rest/middleware/idempotencia.js';
import { tenantContext } from '../../src/api/rest/middleware/tenant-context.js';
import publicVerificationRouter from '../../src/api/rest/routes/public-verification.js';
import { resetLanguage, setLanguage, t, type MessageParams, type TranslationKey } from '../../src/i18n/index.js';
import { ForbiddenError, NotImplementedError, UnauthorizedError } from '../../src/utils/errors.js';

const mockWithTransaction = withTransaction as unknown as Mock;

/** The public router reads through one transaction: the role switch, then its SELECT. */
function publicRowsAre(rows: Array<Record<string, unknown>>): void {
  const client = { query: vi.fn((sql: string) => Promise.resolve(sql.startsWith('SET LOCAL') ? {} : { rows })) };
  mockWithTransaction.mockImplementation((fn: (c: typeof client) => Promise<unknown>) => fn(client));
}

type Case = readonly [TranslationKey, MessageParams, string];

const ENTITY_A = '11111111-1111-4111-8111-111111111111';
const ENTITY_B = '22222222-2222-4222-8222-222222222222';
const HASH = `0x${'a'.repeat(64)}`;

const NAMED_ES =
  `la cabecera x-entity-id: ${ENTITY_A}; el cuerpo: ${ENTITY_B}`;
const NAMED_EN = `the x-entity-id header: ${ENTITY_A}; the body: ${ENTITY_B}`;
const SEVERAL_ES =
  `La petición nombra 2 entidades distintas (${NAMED_ES}). Cada ruta usa la fuente que le corresponde y la ` +
  'bitácora registra la de la cabecera, así que con dos no se puede saber sobre cuál se trabajó. Manda una sola.';
const SEVERAL_EN =
  `The request names 2 different entities (${NAMED_EN}). Each route uses the source that belongs to it and the ` +
  "audit log records the header's, so with two there is no knowing which one was worked on. Send only one.";
const EMPTY_KEY_ES =
  'La cabecera idempotency-key viene vacía. Quítala, o manda una llave: una llave vacía no deduplica nada y hace creer que sí.';
const EMPTY_KEY_EN =
  'The idempotency-key header is empty. Remove it, or send a key: an empty key deduplicates nothing and makes it look as if it did.';
const NO_TENANT_ES = 'El token no identifica un inquilino: la petición no puede acotarse y se rechaza.';
const NO_TENANT_EN = 'The token does not identify a tenant: the request cannot be scoped and is refused.';
const SIMULATED_TAIL_ES =
  ' existe, pero su anclaje es SIMULADO: ningún hash se escribió en ninguna cadena, así que no hay nada que un ' +
  'tercero pueda comprobar. Este endpoint se niega a presentarlo como prueba. Volverá a responder cuando exista ' +
  'un adaptador de cadena real.';
const SIMULATED_TAIL_EN =
  ' exists, but its anchoring is SIMULATED: no hash was written to any chain, so there is nothing a third party ' +
  'can check. This endpoint refuses to present it as proof. It will answer again when a real chain adapter exists.';

const SPANISH_AS_BEFORE: readonly Case[] = [
  ['error.FORBIDDEN.entity_header_repeated', {}, 'x-entity-id viene repetida: la petición actúa sobre una sola entidad'],
  ['error.VALIDATION_ERROR.entity.several_named', { count: 2, named: NAMED_ES }, SEVERAL_ES],
  ['error.VALIDATION_ERROR.entity.named_source', { source: 'header', value: ENTITY_A }, `la cabecera x-entity-id: ${ENTITY_A}`],
  ['error.VALIDATION_ERROR.entity.named_source', { source: 'route', value: ENTITY_A }, `la ruta (:entity_id): ${ENTITY_A}`],
  ['error.VALIDATION_ERROR.entity.named_source', { source: 'body', value: ENTITY_A }, `el cuerpo: ${ENTITY_A}`],
  ['error.VALIDATION_ERROR.entity.named_source', { source: 'query', value: ENTITY_A },
    `la cadena de consulta (?entity_id=): ${ENTITY_A}`],
  ['error.VALIDATION_ERROR.idempotency_key.repeated', { count: 2, header: 'idempotency-key' },
    'La petición trae 2 cabeceras idempotency-key. Manda exactamente una: con dos, cuál manda decidiría en ' +
      'silencio si este acto se repite o no.'],
  ['error.VALIDATION_ERROR.idempotency_key.empty', { header: 'idempotency-key' }, EMPTY_KEY_ES],
  ['error.VALIDATION_ERROR.idempotency_key.too_long', { length: 201, max: 200 },
    'La llave de idempotencia mide 201 caracteres y el máximo es 200.'],
  ['error.VALIDATION_ERROR.idempotency_key.malformed', { value: 'K-1, K-2' },
    'La llave de idempotencia "K-1, K-2" trae caracteres que no se admiten. Usa letras, dígitos y _ . : @ + / = - ' +
      '(un UUID sirve). La coma y el espacio quedan fuera a propósito: es como llegan DOS cabeceras unidas por el ' +
      'servidor, y una llave así no es la que mandó nadie — el reintento no casaría y el acto se repetiría en silencio.'],
  ['error.VALIDATION_ERROR.idempotency_key.no_tenant', { header: 'idempotency-key' },
    'No se puede honrar idempotency-key: la petición no identifica un inquilino, y las llaves consumadas se ' +
      'guardan por inquilino.'],
  ['error.UNAUTHORIZED.no_tenant', {}, NO_TENANT_ES],
  ['error.VALIDATION_ERROR.xml.batch_cap', { max: 100 }, 'xml_contents debe ser un arreglo de a lo más 100 documentos.'],
  ['error.FORBIDDEN.detail.issued_payment_receipt', {}, 'Un comprobante de pago emitido registra cobros de clientes.'],
  ['api.invoices.send_note', {},
    'La factura queda registrada como enviada; el sistema no transmite correo. El envío es del usuario.'],
  ['error.NOT_IMPLEMENTED.cfdi_cancellation', {},
    'mnemosine todavía no cancela CFDI ante el SAT. Cancela en el portal de tu PAC o en el del SAT, y después ' +
      'reversa el asiento con `mnemosine entry reverse <numero> --reason "CFDI cancelado, acuse <folio>"`. Cuando ' +
      'exista, la cancelación irá por pac-router con acuse archivado y reversa encadenada.'],
  ['api.blockchain.simulated_attestations', { simulated: 1, total: 2 },
    '1 de 2 atestaciones de esta página son SIMULADAS: su txHash, su número de bloque y su enlace al explorador ' +
      'están fabricados y no corresponden a ninguna transacción. No sirven como prueba ante un tercero.'],
  ['api.blockchain.simulated_anchors', { simulated: 3, total: 4 },
    '3 de 4 anclajes de esta página son SIMULADOS: su txid se fabricó localmente y no existe en Bitcoin. No los ' +
      'publiques como prueba ante un tercero ni compartas un enlace a un explorador con ellos.'],
  ['error.ATTESTATION_SIMULATED', { what: 'entry_attestation' }, `La atestación de ese asiento${SIMULATED_TAIL_ES}`],
  ['error.ATTESTATION_SIMULATED', { what: 'period_commitment' }, `El compromiso de ese periodo${SIMULATED_TAIL_ES}`],
  ['error.ATTESTATION_SIMULATED', { what: 'bitcoin_anchor' }, `Ese anclaje de Bitcoin${SIMULATED_TAIL_ES}`],
  ['error.ATTESTATION_SIMULATED', { what: 'anchor_proof' }, `La prueba de anclaje de ese asiento${SIMULATED_TAIL_ES}`],
  ['api.public_verification.bitcoin_simulated_step', {},
    '6. El anclaje de Bitcoin es SIMULADO: no hay OP_RETURN en la cadena que comprobar'],
];

const ENGLISH: readonly Case[] = [
  ['error.FORBIDDEN.entity_header_repeated', {}, 'x-entity-id is repeated: a request acts on a single entity'],
  ['error.VALIDATION_ERROR.entity.several_named', { count: 2, named: NAMED_EN }, SEVERAL_EN],
  ['error.VALIDATION_ERROR.entity.named_source', { source: 'route', value: ENTITY_A }, `the route (:entity_id): ${ENTITY_A}`],
  ['error.VALIDATION_ERROR.entity.named_source', { source: 'query', value: ENTITY_A },
    `the query string (?entity_id=): ${ENTITY_A}`],
  ['error.VALIDATION_ERROR.idempotency_key.repeated', { count: 2, header: 'idempotency-key' },
    'The request carries 2 idempotency-key headers. Send exactly one: with two, which one wins would silently ' +
      'decide whether this act is repeated or not.'],
  ['error.VALIDATION_ERROR.idempotency_key.empty', { header: 'idempotency-key' }, EMPTY_KEY_EN],
  ['error.VALIDATION_ERROR.idempotency_key.too_long', { length: 201, max: 200 },
    'The idempotency key is 201 characters long and the maximum is 200.'],
  ['error.VALIDATION_ERROR.idempotency_key.no_tenant', { header: 'idempotency-key' },
    'Cannot honour idempotency-key: the request does not identify a tenant, and consumed keys are kept per tenant.'],
  ['error.UNAUTHORIZED.no_tenant', {}, NO_TENANT_EN],
  ['error.VALIDATION_ERROR.xml.batch_cap', { max: 100 }, 'xml_contents must be an array of at most 100 documents.'],
  ['error.FORBIDDEN.detail.issued_payment_receipt', {}, 'An issued payment receipt records customer collections.'],
  ['api.invoices.send_note', {},
    'The invoice is recorded as sent; the system does not transmit email. Sending it is up to the user.'],
  ['error.NOT_IMPLEMENTED.cfdi_cancellation', {},
    "mnemosine does not cancel CFDIs before the SAT yet. Cancel in your PAC's portal or in the SAT's, then reverse " +
      'the entry with `mnemosine entry reverse <number> --reason "CFDI cancelled, acknowledgment <folio>"`. When it ' +
      'exists, cancellation will go through pac-router with the acknowledgment archived and a chained reversal.'],
  ['api.blockchain.simulated_attestations', { simulated: 1, total: 2 },
    '1 of 2 attestations on this page are SIMULATED: their txHash, block number and explorer link are fabricated ' +
      'and match no transaction. They are no proof before a third party.'],
  ['api.blockchain.simulated_anchors', { simulated: 3, total: 4 },
    '3 of 4 anchors on this page are SIMULATED: their txid was made up locally and does not exist on Bitcoin. Do ' +
      'not publish them as proof before a third party, nor share an explorer link to them.'],
  ['error.ATTESTATION_SIMULATED', { what: 'period_commitment' }, `The commitment of that period${SIMULATED_TAIL_EN}`],
  ['error.ATTESTATION_SIMULATED', { what: 'anchor_proof' }, `The anchor proof of that entry${SIMULATED_TAIL_EN}`],
  ['api.public_verification.bitcoin_simulated_step', {},
    '6. The Bitcoin anchor is SIMULATED: there is no OP_RETURN on the chain to check'],
];

describe('the catalogue keys of src/api/rest', () => {
  it.each(SPANISH_AS_BEFORE)('%s renders in es what the site printed', (key, params, spanish) => {
    expect(t(key, params, 'es')).toBe(spanish);
  });

  it.each(ENGLISH)('%s renders in en', (key, params, english) => {
    expect(t(key, params, 'en')).toBe(english);
  });

  it('the constructors that took prose take a key, with an English message and the code unchanged', () => {
    const forbidden = new ForbiddenError({ key: 'error.FORBIDDEN.entity_header_repeated' });
    expect(forbidden.code).toBe('FORBIDDEN');
    expect(forbidden.message).toBe('x-entity-id is repeated: a request acts on a single entity');
    expect(forbidden.localized('es')).toBe('x-entity-id viene repetida: la petición actúa sobre una sola entidad');

    const unauthorized = new UnauthorizedError({ key: 'error.UNAUTHORIZED.no_tenant' });
    expect([unauthorized.statusCode, unauthorized.code, unauthorized.message]).toEqual([401, 'UNAUTHORIZED', NO_TENANT_EN]);

    const notImplemented = new NotImplementedError({ key: 'error.NOT_IMPLEMENTED.cfdi_cancellation' }, { invoice_id: 'x' });
    expect([notImplemented.statusCode, notImplemented.code, notImplemented.details]).toEqual([501, 'NOT_IMPLEMENTED', { invoice_id: 'x' }]);
    expect(new UnauthorizedError().message).toBe('Unauthorized');
    expect(new ForbiddenError().message).toBe('Forbidden');
  });
});

// ---- Through the wire --------------------------------------------------

interface Envelope {
  errors: Array<{ code: string; message: string; field?: string }>;
  meta: { language?: string };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // The process language is pinned to English: the response language has to
  // come from the request, not from the process.
  setLanguage('en');
  const app = express();
  app.use(express.json());
  app.use(negotiateLocale);
  app.post('/entity', (req, _res, next) => {
    req.user = { entities: [ENTITY_A, ENTITY_B], permissions: [], tenant_id: 't-1' } as never;
    next();
  }, requireEntityAccess, (_req, res) => { res.json({ ok: true }); });
  app.post('/idempotent', bajoLlaveDeIdempotencia(), (_req, res) => { res.json({ ok: true }); });
  app.get('/tenant', tenantContext, (_req, res) => { res.json({ ok: true }); });
  app.use('/public/v1', publicVerificationRouter);
  app.use(errorHandler);
  await new Promise<void>((ok) => { server = app.listen(0, '127.0.0.1', () => ok()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  resetLanguage();
  await new Promise<void>((ok) => server.close(() => ok()));
});

function call(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: unknown
): Promise<{ status: number; vary?: string; contentLanguage?: string; body: Envelope }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const all = payload === undefined ? headers : { ...headers, 'content-type': 'application/json' };
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method, headers: all }, (res) => {
      let raw = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => (raw += chunk));
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        vary: res.headers['vary'],
        contentLanguage: res.headers['content-language'],
        body: JSON.parse(raw) as Envelope,
      }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

describe('the refusals reach the caller in the negotiated language', () => {
  it('two entities in one request: the Spanish of before with no header, English when asked', async () => {
    const request_ = (lang?: Record<string, string>) =>
      call('POST', '/entity', { 'x-entity-id': ENTITY_A, ...lang }, { entity_id: ENTITY_B });
    const none = await request_();
    const en = await request_({ 'accept-language': 'en' });
    for (const r of [none, en]) {
      expect(r.status).toBe(422);
      expect(r.body.errors[0].code).toBe('VALIDATION_ERROR');
      expect(r.body.errors[0].field).toBe('entity_id');
    }
    expect(none.body.errors[0].message).toBe(SEVERAL_ES);
    expect(none.contentLanguage).toBe('es-MX');
    expect(en.body.errors[0].message).toBe(SEVERAL_EN);
  });

  it('an empty idempotency key', async () => {
    const none = await call('POST', '/idempotent', { 'idempotency-key': ' ' }, {});
    const en = await call('POST', '/idempotent', { 'idempotency-key': ' ', 'accept-language': 'en-US' }, {});
    expect([none.status, en.status]).toEqual([422, 422]);
    expect(none.body.errors[0].message).toBe(EMPTY_KEY_ES);
    expect(en.body.errors[0].message).toBe(EMPTY_KEY_EN);
  });

  it('a token with no tenant', async () => {
    const none = await call('GET', '/tenant', {});
    const en = await call('GET', '/tenant', { 'accept-language': 'en' });
    expect([none.status, en.status]).toEqual([401, 401]);
    expect([none.body.errors[0].code, en.body.errors[0].code]).toEqual(['UNAUTHORIZED', 'UNAUTHORIZED']);
    expect(none.body.errors[0].message).toBe(NO_TENANT_ES);
    expect(en.body.errors[0].message).toBe(NO_TENANT_EN);
  });

  it('a simulated attestation on the public router, with Vary and the envelope of before', async () => {
    publicRowsAre([{ id: 'a-1', is_simulated: true, chain_attestations: [] }]);
    const none = await call('GET', `/public/v1/verify/${HASH}`, {});
    const en = await call('GET', `/public/v1/verify/${HASH}`, { 'accept-language': 'en' });
    for (const r of [none, en]) {
      expect(r.status).toBe(501);
      expect(r.body.errors[0].code).toBe('ATTESTATION_SIMULATED');
      expect((r.vary ?? '').toLowerCase()).toContain('accept-language');
      expect(r.body.meta.language).toBeUndefined();
    }
    expect(none.body.errors[0].message).toBe(`La atestación de ese asiento${SIMULATED_TAIL_ES}`);
    expect(en.body.errors[0].message).toBe(`The attestation of that entry${SIMULATED_TAIL_EN}`);
  });
});
