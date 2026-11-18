import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ============================================================
// CASH FINDINGS BY LOCALE (MNE-001-466 · issue #654)
//
// `messageKey` and `messageParams` are the finding's identity; `message` is
// for a human, in the language the RESPONSE negotiated and never in the
// server process's. The shape is tests/api/errors-by-locale.spec.ts's; the
// two findings are synthetic literals kept inline, next to what they produce.
//
// THE EXPECTED MESSAGES ARE LITERALS copied by hand out of src/i18n/es.ts
// and en.ts: built with `t()`, the piece under test would grade itself.
// ============================================================

vi.mock('../../src/database/connection.js', () => ({
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

// Only the two calls that would touch the ledger are replaced; the router,
// its guards and the renderer are the real ones.
vi.mock('../../src/services/ap/bill-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/ap/bill-service.js')>()),
  approveBill: vi.fn(async () => ({
    bill: { id: BILL_ID, entity_id: ENTITY, bill_number: 'B-TEST-1', status: 'approved' },
    entry: null, entryLines: [], attestation: null, deductibilityFindings: [APPROVE_FINDING], dryRun: false,
  })),
}));
vi.mock('../../src/services/payments/payment-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/payments/payment-service.js')>()),
  recordVendorPayment: vi.fn(async () => ({
    paymentId: 'p-test-1', paymentNumber: 'VP-TEST-1', journalEntry: null, attestation: null,
    documentos: [], deductibilityFindings: [PAYMENT_FINDING],
  })),
}));

import billsRouter from '../../src/api/rest/routes/bills.js';
import { negotiateLocale } from '../../src/api/rest/middleware/locale.js';
import { errorHandler } from '../../src/api/rest/middleware/error-handler.js';
import { resetLanguage, setLanguage, type Language } from '../../src/i18n/index.js';
import { DEFAULT_LOCALE, languageOfLocale, type Locale } from '../../src/i18n/locale.js';
import type { CashDeductibilityFinding } from '../../src/services/ap/cash-deductibility.js';

const ENTITY = '11111111-1111-4111-8111-111111111111';
const BILL_ID = '22222222-2222-4222-8222-222222222222';
const VENDOR = '33333333-3333-4333-8333-333333333333';

// As `cashLimitFinding` builds them (src/services/ap/cash-deductibility.ts:138-147).
const APPROVE_FINDING: CashDeductibilityFinding = {
  code: 'cash_over_limit_deductibility_at_risk',
  billNumber: 'B-TEST-1', amount: '4321.00', limit: '2000.00', onDate: '2026-03-15',
  sourceUrl: null, source: 'bill_approve', draftIds: [],
  messageKey: 'cash_limit.finding.at_approve',
  messageParams: { bill: 'B-TEST-1', amount: '4321.00', date: '2026-03-15', limit: '2000.00' },
};
// The payment's finding carries a note: it must come in its message's language.
const PAYMENT_FINDING: CashDeductibilityFinding = {
  ...APPROVE_FINDING,
  source: 'vendor_payment',
  draftIds: ['44444444-4444-4444-8444-444444444444'],
  messageKey: 'cash_limit.finding.at_payment',
  noteKey: 'cash_limit.finding.draft_proposed',
  noteParams: { count: '1' },
};

const MESSAGES = {
  approve: {
    es: 'B-TEST-1: el CFDI declara pago en efectivo por 4321.00 MXN (con fecha 2026-03-15), por encima del límite de 2000.00 de la LISR art. 27 fr. III: la deducción y el acreditamiento del IVA (LIVA art. 5 fr. I) están en riesgo si de verdad se pagó en efectivo. No se reclasificó nada.',
    en: 'B-TEST-1: the CFDI declares payment in cash for 4321.00 MXN (dated 2026-03-15), above the 2000.00 limit of LISR art. 27 fr. III: the deduction and the IVA credit (LIVA art. 5 fr. I) are at risk if it was really paid in cash. Nothing was reclassified.',
  },
  payment: {
    es: 'B-TEST-1: 4321.00 MXN pagados en efectivo el 2026-03-15 superan el límite de 2000.00 de la LISR art. 27 fr. III: la deducción y el acreditamiento del IVA (LIVA art. 5 fr. I) están en riesgo. No se reclasificó nada. Se dejó un borrador de reclasificación en la cola de revisión (1).',
    en: 'B-TEST-1: 4321.00 MXN paid in cash on 2026-03-15 exceeds the 2000.00 limit of LISR art. 27 fr. III: the deduction and the IVA credit (LIVA art. 5 fr. I) are at risk. Nothing was reclassified. A reclassification draft was left in the review queue (1).',
  },
} as const;

interface Route {
  name: 'approve' | 'payment';
  path: string;
  body?: Record<string, unknown>;
  status: number;
  fixture: CashDeductibilityFinding;
  findings: (body: Record<string, { deductibility_findings?: unknown[] }>) => unknown[] | undefined;
}

const ROUTES: Route[] = [
  { name: 'approve', path: `/v1/bills/${BILL_ID}/approve`, status: 200, fixture: APPROVE_FINDING,
    findings: (b) => b.meta?.deductibility_findings },
  // Its entity_id is the token's: any other one answers 403 in requireEntityAccess.
  { name: 'payment', path: '/v1/bills/payments', status: 201, fixture: PAYMENT_FINDING,
    body: { entity_id: ENTITY, vendor_id: VENDOR, payment_amount: '4321.00', payment_method: 'cash', payment_date: '2026-03-15' },
    findings: (b) => b.data?.deductibility_findings },
];

const LOCALE_OF: Record<Language, Locale> = { es: 'es-MX', en: 'en-US' };
const OTHER: Record<Language, Language> = { es: 'en', en: 'es' };
const savedLocaleEnv = process.env.MNEMOSINE_LOCALE;

/** What a step after `negotiateLocale` records, as #656's entity step will; null records nothing. */
let recordedRung: Locale | null = null;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(negotiateLocale);
  // In place of `authenticate` (src/api/rest/middleware/auth.ts:61-63).
  app.use((req, _res, next) => {
    req.user = { user_id: 'u-1', tenant_id: 't-1', entities: [ENTITY], permissions: ['*'] } as never;
    req.tenantId = 't-1';
    req.entityId = ENTITY;
    next();
  });
  app.use((_req, res, next) => {
    if (recordedRung !== null) {
      res.locals.locale = recordedRung;
      res.locals.language = languageOfLocale(recordedRung);
    }
    next();
  });
  app.use('/v1/bills', billsRouter);
  app.use(errorHandler);

  await new Promise<void>((ok) => {
    server = app.listen(0, '127.0.0.1', () => ok());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  recordedRung = null;
  resetLanguage();
  if (savedLocaleEnv === undefined) delete process.env.MNEMOSINE_LOCALE;
  else process.env.MNEMOSINE_LOCALE = savedLocaleEnv;
});

afterAll(async () => {
  await new Promise<void>((ok) => server.close(() => ok()));
});

type ProcessPin = 'setLanguage' | 'MNEMOSINE_LOCALE';

/** The server process in `language`: pinned, or unpinned and started with that locale. */
function pinProcess(language: Language, how: ProcessPin = 'setLanguage'): void {
  if (how === 'setLanguage') {
    setLanguage(language);
    return;
  }
  resetLanguage();
  process.env.MNEMOSINE_LOCALE = LOCALE_OF[language];
}

/**
 * Through `node:http`, NOT `fetch`: Node's fetch adds `accept-language: *` to
 * every request that does not set one, so the "no header" cases would never
 * leave the client without a header.
 */
function post(path: string, body: unknown, acceptLanguage?: string): Promise<{ status: number; body: Record<string, never> }> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (acceptLanguage !== undefined) headers['accept-language'] = acceptLanguage;
  return new Promise((resolve, reject) => {
    const req = request(`${baseUrl}${path}`, { method: 'POST', headers }, (res) => {
      let raw = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk: string) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Record<string, never> });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** The status first, then exactly one finding: a crash fails as a crash, never as a language. */
async function findingOf(route: Route, acceptLanguage?: string): Promise<Record<string, unknown>> {
  const res = await post(route.path, route.body, acceptLanguage);
  expect(res.status, JSON.stringify(res.body)).toBe(route.status);
  const findings = route.findings(res.body);
  expect(findings).toHaveLength(1);
  return findings![0] as Record<string, unknown>;
}

function identityOf(f: Record<string, unknown> | CashDeductibilityFinding) {
  return { messageKey: f.messageKey, messageParams: f.messageParams, noteKey: f.noteKey, noteParams: f.noteParams };
}

describe.each(ROUTES)('$name: deductibility_findings[].message', (route) => {
  it.each<ProcessPin>(['setLanguage', 'MNEMOSINE_LOCALE'])(
    'follows Accept-Language, not the process language (process set by %s)',
    async (how) => {
      pinProcess('en', how);
      const es = await findingOf(route, 'es-MX');
      pinProcess('es', how);
      const en = await findingOf(route, 'en-US');

      expect(es.message).toBe(MESSAGES[route.name].es);
      expect(en.message).toBe(MESSAGES[route.name].en);
      expect(identityOf(es)).toEqual(identityOf(route.fixture));
      expect(identityOf(en)).toEqual(identityOf(es));
    }
  );

  it('falls back to the default locale when the request sends no Accept-Language', async () => {
    const fallback = languageOfLocale(DEFAULT_LOCALE);
    pinProcess(OTHER[fallback]);
    const f = await findingOf(route);
    expect(f.message).toBe(MESSAGES[route.name][fallback]);
  });

  it.each<Locale>(['en-US', 'es-MX'])('follows the language a later step recorded (%s)', async (locale) => {
    const language = languageOfLocale(locale);
    recordedRung = locale;
    pinProcess(OTHER[language]);
    const f = await findingOf(route);
    expect(f.message).toBe(MESSAGES[route.name][language]);
  });

  it('negotiates `fr, en;q=0.5` to English on a Spanish process', async () => {
    pinProcess('es');
    const f = await findingOf(route, 'fr, en;q=0.5');
    expect(f.message).toBe(MESSAGES[route.name].en);
  });
});
