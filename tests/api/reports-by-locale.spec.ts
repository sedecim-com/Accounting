import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// ============================================================
// REPORT LABELS BY LOCALE (I11 · issue #153)
//
// `key` is the identity and `name` the rendered label. The same statement
// asked for in Spanish and in English must come back with THE SAME keys and
// each label in its own language — and it must say which language it picked,
// in the header and in the envelope, because a body that carries prose a
// caller will print is useless to a cache that cannot tell the two apart.
//
// This is the contract I9 wrote for errors (tests/api/errors-by-locale.spec.ts,
// whose shape this file copies), applied where the declaration is
// unconditional: there a message declares a language only when it really came
// from a catalog key, here EVERY section label does.
//
// THE EXPECTED LABELS BELOW ARE LITERALS copied by hand out of src/i18n/es.ts
// and en.ts. Building them with `reportSectionLabel(...)` would be asking the
// piece under test to grade itself: it would stay green with the catalog
// wired to the wrong language, which is the whole defect this commit closes.
//
// WHAT THE ENGLISH SIDE PROVES, and why it is not a tautology. The service
// coins its own English `name` by prettifying the stored `fs_category`
// (report-service.ts:947), so for the sections alone the catalog and the
// service agree — `Assets` either way — and dropping the localization would
// still answer English requests correctly. The SUBSECTIONS are where they
// part: `Current Assets` vs `Current assets`, `Ori` vs
// `Other comprehensive income`, `Result Of The Period` vs
// `Profit (loss) for the period`. Those three are asserted on purpose.
// ============================================================

vi.mock('../../src/services/reporting/report-service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/reporting/report-service.js')>()),
  // Only the two DB-backed entry points are replaced. The assembly below is
  // the real one, so the keys the route localizes are the keys the service
  // really coins — a fixture with hand-typed keys would pass over a rename.
  getBalanceSheet: vi.fn(async () => balanceSheetFixture()),
  getIncomeStatement: vi.fn(async () => incomeStatementFixture()),
}));

import reportsRouter from '../../src/api/rest/routes/reports.js';
import { negotiateLocale } from '../../src/api/rest/middleware/locale.js';
import { errorHandler } from '../../src/api/rest/middleware/error-handler.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import {
  buildBalanceSheetSection,
  buildIncomeStatementSection,
  type BalanceSheetQueryRow,
  type BalanceSheetReport,
  type IncomeStatementQueryRow,
  type IncomeStatementReport,
} from '../../src/services/reporting/report-service.js';

// ------------------------------------------------------------
// The statement the endpoint renders
// ------------------------------------------------------------

const ENTITY = 'e-1';
const AS_OF = '2026-03-31';
const SINCE = '2026-01-01';
const UNTIL = '2026-03-31';

/**
 * Account names are DATA, not labels: `Bancos` is what the bookkeeper typed
 * and it must survive an English request untouched. Asserted below.
 */
const BALANCE_ROWS: BalanceSheetQueryRow[] = [
  { id: 'a-1', code: '1100', name: 'Bancos', account_type: 'asset', fs_category: 'current_assets', balance: '1500.0000' },
  { id: 'a-2', code: '1500', name: 'Equipo de oficina', account_type: 'asset', fs_category: 'non_current_assets', balance: '500.0000' },
  { id: 'l-1', code: '2100', name: 'Proveedores', account_type: 'liability', fs_category: 'current_liabilities', balance: '-800.0000' },
  { id: 'q-1', code: '3200', name: 'Superávit por revaluación', account_type: 'equity', fs_category: 'ori', balance: '-1200.0000' },
];

const INCOME_ROWS: IncomeStatementQueryRow[] = [
  { id: 'r-1', code: '4100', name: 'Ventas', account_type: 'revenue', fs_category: 'revenue', debit_total: '0.0000', credit_total: '900.0000' },
  { id: 'x-1', code: '6100', name: 'Sueldos', account_type: 'expense', fs_category: 'operating_expenses', debit_total: '400.0000', credit_total: '0.0000' },
];

function balanceSheetFixture(): BalanceSheetReport {
  const assets = buildBalanceSheetSection(BALANCE_ROWS, ['asset', 'contra_asset'], { key: 'assets', name: 'Assets' }, 1);
  const liabilities = buildBalanceSheetSection(BALANCE_ROWS, ['liability', 'contra_liability'], { key: 'liabilities', name: 'Liabilities' }, -1);
  const equity = buildBalanceSheetSection(BALANCE_ROWS, ['equity', 'contra_equity'], { key: 'equity', name: 'Equity' }, -1);
  // The unclosed result, as report-service.ts:1023-1028 appends it: a
  // subsection of equity that is named like a section, which is the reason
  // the label lookup tries the section table first.
  equity.subsections.push({ key: 'result_of_the_period', name: 'Result Of The Period', total: '300.0000', accounts: [] });
  return {
    entity_id: ENTITY,
    as_of_date: AS_OF,
    assets,
    liabilities,
    equity,
    total_liabilities_and_equity: '2000.0000',
    out_of_balance: '0.0000',
    is_balanced: true,
  };
}

function incomeStatementFixture(): IncomeStatementReport {
  // Neither section has `subsections`; the balance sheet's do. Both branches
  // of the renderer are therefore on the wire in this file.
  return {
    entity_id: ENTITY,
    start_date: SINCE,
    end_date: UNTIL,
    revenue: buildIncomeStatementSection(INCOME_ROWS, 'revenue'),
    expenses: buildIncomeStatementSection(INCOME_ROWS, 'expense'),
    net_income: '500.0000',
  };
}

// ------------------------------------------------------------
// The labels, by hand, from the catalog
// ------------------------------------------------------------

const ES = {
  assets: 'Activo',
  current_assets: 'Activo circulante',
  non_current_assets: 'Activo no circulante',
  liabilities: 'Pasivo',
  current_liabilities: 'Pasivo a corto plazo',
  equity: 'Capital contable',
  ori: 'Otros resultados integrales',
  result_of_the_period: 'Utilidad (pérdida) del ejercicio',
  revenue: 'Ingresos',
  expenses: 'Gastos',
} as const;

const EN = {
  assets: 'Assets',
  current_assets: 'Current assets',
  non_current_assets: 'Non-current assets',
  liabilities: 'Liabilities',
  current_liabilities: 'Current liabilities',
  equity: 'Equity',
  ori: 'Other comprehensive income',
  result_of_the_period: 'Profit (loss) for the period',
  revenue: 'Revenue',
  expenses: 'Expenses',
} as const;

// ------------------------------------------------------------
// Wire
// ------------------------------------------------------------

interface Section {
  key: string;
  name: string;
  total: string;
  accounts?: Array<{ id: string; code: string; name: string }>;
  subsections?: Section[];
}

interface ReportEnvelope {
  data: Record<string, unknown> & { assets?: Section; liabilities?: Section; equity?: Section; revenue?: Section; expenses?: Section };
  meta: { timestamp: string; version: string; language?: string };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  // Pin the PROCESS language to English. The language on the wire has to come
  // from the request: a route that rendered with `getLanguage()` would answer
  // the Spanish and the header-less requests in English and fail below.
  // vitest.config.ts already sets MNEMOSINE_LOCALE=en-US; this pin keeps the
  // file from depending on that.
  setLanguage('en');

  const app = express();
  app.use(negotiateLocale);
  app.use((req, _res, next) => {
    req.user = { user_id: 'u-1', tenant_id: 't-1', entities: [ENTITY], permissions: ['*'] } as never;
    req.tenantId = 't-1';
    req.entityId = ENTITY;
    next();
  });
  app.use('/v1/reports', reportsRouter);
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
 * never leave the client without a header — measured on Node v22, and the
 * reason tests/api/errors-by-locale.spec.ts does the same.
 */
function call(
  path: string,
  acceptLanguage?: string
): Promise<{ status: number; contentLanguage?: string; vary?: string; body: ReportEnvelope }> {
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
            body: JSON.parse(raw) as ReportEnvelope,
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

const BALANCE_SHEET = `/v1/reports/balance-sheet?entity_id=${ENTITY}&as_of_date=${AS_OF}`;
const INCOME_STATEMENT = `/v1/reports/income-statement?entity_id=${ENTITY}&start_date=${SINCE}&end_date=${UNTIL}`;

/** Every key in a section, parents and children, in the order published. */
function keysOf(section: Section): string[] {
  return [section.key, ...(section.subsections ?? []).map((s) => s.key)];
}

function subsection(section: Section, key: string): Section {
  const found = (section.subsections ?? []).find((s) => s.key === key);
  if (found === undefined) throw new Error(`no subsection ${key} in ${section.key}`);
  return found;
}

describe('the balance sheet, asked for in two languages', () => {
  it('returns the same keys and each label in its own language', async () => {
    const es = await call(BALANCE_SHEET, 'es');
    const en = await call(BALANCE_SHEET, 'en');

    expect(es.status).toBe(200);
    expect(en.status).toBe(200);

    expect(es.body.data.assets!.name).toBe(ES.assets);
    expect(en.body.data.assets!.name).toBe(EN.assets);
    expect(es.body.data.liabilities!.name).toBe(ES.liabilities);
    expect(en.body.data.liabilities!.name).toBe(EN.liabilities);
    expect(es.body.data.equity!.name).toBe(ES.equity);
    expect(en.body.data.equity!.name).toBe(EN.equity);

    // The subsections are where the catalog and the service's own prettifier
    // disagree, so this is the half that a missing localization cannot fake.
    expect(subsection(es.body.data.assets!, 'current_assets').name).toBe(ES.current_assets);
    expect(subsection(en.body.data.assets!, 'current_assets').name).toBe(EN.current_assets);
    expect(subsection(es.body.data.assets!, 'non_current_assets').name).toBe(ES.non_current_assets);
    expect(subsection(en.body.data.assets!, 'non_current_assets').name).toBe(EN.non_current_assets);
    expect(subsection(es.body.data.liabilities!, 'current_liabilities').name).toBe(ES.current_liabilities);
    expect(subsection(en.body.data.liabilities!, 'current_liabilities').name).toBe(EN.current_liabilities);
    expect(subsection(es.body.data.equity!, 'ori').name).toBe(ES.ori);
    expect(subsection(en.body.data.equity!, 'ori').name).toBe(EN.ori);
    expect(subsection(es.body.data.equity!, 'result_of_the_period').name).toBe(ES.result_of_the_period);
    expect(subsection(en.body.data.equity!, 'result_of_the_period').name).toBe(EN.result_of_the_period);
  });

  it('does NOT change a single key with the language', async () => {
    // What #253 bought: the identity a dashboard, a script or the agent keys
    // off cannot move because a reader asked in another language. Compared as
    // whole ordered lists, so a key that appeared or vanished also shows up.
    const es = await call(BALANCE_SHEET, 'es');
    const en = await call(BALANCE_SHEET, 'en');

    for (const part of ['assets', 'liabilities', 'equity'] as const) {
      expect(keysOf(es.body.data[part]!)).toEqual(keysOf(en.body.data[part]!));
    }
    expect(keysOf(es.body.data.assets!)).toEqual(['assets', 'current_assets', 'non_current_assets']);
    expect(keysOf(es.body.data.equity!)).toEqual(['equity', 'ori', 'result_of_the_period']);
  });

  it('declares the negotiated locale in the header and in the envelope', async () => {
    const es = await call(BALANCE_SHEET, 'es');
    const en = await call(BALANCE_SHEET, 'en');

    expect(es.contentLanguage).toBe('es-MX');
    expect(en.contentLanguage).toBe('en-US');
    expect(es.body.meta.language).toBe('es');
    expect(en.body.meta.language).toBe('en');
    // A rendered label depends on the header, so a cache has to key on it.
    expect((es.vary ?? '').toLowerCase()).toContain('accept-language');
    expect((en.vary ?? '').toLowerCase()).toContain('accept-language');
  });

  it('declares the language it actually painted', async () => {
    // `meta.language` and the labels are two statements about one thing; a
    // response that renders Spanish while announcing `en` is worse than one
    // that renders the wrong language honestly, because nothing downstream
    // can detect it.
    for (const header of ['es', 'en', 'es-AR', 'en-GB', undefined]) {
      const r = await call(BALANCE_SHEET, header);
      const spoken = r.body.meta.language === 'es' ? ES : EN;
      expect(r.body.data.assets!.name).toBe(spoken.assets);
      expect(subsection(r.body.data.assets!, 'current_assets').name).toBe(spoken.current_assets);
      expect(r.contentLanguage).toBe(r.body.meta.language === 'es' ? 'es-MX' : 'en-US');
    }
  });

  it('follows the NEGOTIATED locale, not the bare header text', async () => {
    // `en-GB` and `es-AR` are not locales this product has; the negotiation
    // resolves them to en-US and es-MX. A route that branched on the raw
    // header would answer Spanish to `en-GB` while labelling it en-US.
    const gb = await call(BALANCE_SHEET, 'en-GB');
    expect(gb.contentLanguage).toBe('en-US');
    expect(gb.body.meta.language).toBe('en');
    expect(gb.body.data.assets!.name).toBe(EN.assets);
    expect(subsection(gb.body.data.equity!, 'ori').name).toBe(EN.ori);

    const ar = await call(BALANCE_SHEET, 'es-AR');
    expect(ar.contentLanguage).toBe('es-MX');
    expect(ar.body.meta.language).toBe('es');
    expect(ar.body.data.assets!.name).toBe(ES.assets);
    expect(subsection(ar.body.data.equity!, 'ori').name).toBe(ES.ori);
  });

  it('answers in es-MX when the request sends no Accept-Language', async () => {
    const none = await call(BALANCE_SHEET);
    expect(none.contentLanguage).toBe('es-MX');
    expect(none.body.meta.language).toBe('es');
    expect(none.body.data.assets!.name).toBe(ES.assets);
    expect(subsection(none.body.data.assets!, 'current_assets').name).toBe(ES.current_assets);
  });

  it('translates labels and nothing else', async () => {
    const es = await call(BALANCE_SHEET, 'es');
    const en = await call(BALANCE_SHEET, 'en');

    // Account names are the bookkeeper's data. A renderer that reached into
    // them would be rewriting the chart of accounts.
    const esAccounts = subsection(es.body.data.assets!, 'current_assets').accounts!;
    const enAccounts = subsection(en.body.data.assets!, 'current_assets').accounts!;
    expect(esAccounts).toEqual(enAccounts);
    expect(esAccounts.map((a) => a.name)).toEqual(['Bancos']);

    // And the figures do not move with the reader.
    expect(es.body.data.assets!.total).toBe(en.body.data.assets!.total);
    expect(es.body.data.assets!.total).toMatch(/^2000\.0+$/);
    expect(subsection(es.body.data.equity!, 'result_of_the_period').total).toBe('300.0000');
    expect(es.body.data.out_of_balance).toEqual(en.body.data.out_of_balance);
    expect(es.body.data.is_balanced).toBe(true);
    expect(es.body.meta.version).toBe('v1');
    expect(Number.isNaN(Date.parse(es.body.meta.timestamp))).toBe(false);
  });
});

describe('the income statement, asked for in two languages', () => {
  it('returns the same keys and each label in its own language', async () => {
    const es = await call(INCOME_STATEMENT, 'es');
    const en = await call(INCOME_STATEMENT, 'en');

    expect(es.status).toBe(200);
    expect(en.status).toBe(200);

    expect(es.body.data.revenue!.name).toBe(ES.revenue);
    expect(en.body.data.revenue!.name).toBe(EN.revenue);
    expect(es.body.data.expenses!.name).toBe(ES.expenses);
    expect(en.body.data.expenses!.name).toBe(EN.expenses);

    expect(es.body.data.revenue!.key).toBe('revenue');
    expect(en.body.data.revenue!.key).toBe('revenue');
    expect(es.body.data.expenses!.key).toBe('expenses');
    expect(en.body.data.expenses!.key).toBe('expenses');

    // These two sections carry no `subsections`, and the renderer has to hand
    // them back without inventing the field.
    expect('subsections' in es.body.data.revenue!).toBe(false);
  });

  it('declares the negotiated locale exactly like the balance sheet', async () => {
    const es = await call(INCOME_STATEMENT, 'es');
    const gb = await call(INCOME_STATEMENT, 'en-GB');
    const none = await call(INCOME_STATEMENT);

    expect(es.contentLanguage).toBe('es-MX');
    expect(es.body.meta.language).toBe('es');
    expect((es.vary ?? '').toLowerCase()).toContain('accept-language');

    expect(gb.contentLanguage).toBe('en-US');
    expect(gb.body.meta.language).toBe('en');
    expect(gb.body.data.expenses!.name).toBe(EN.expenses);

    expect(none.contentLanguage).toBe('es-MX');
    expect(none.body.meta.language).toBe('es');
    expect(none.body.data.expenses!.name).toBe(ES.expenses);
  });

  it('translates labels and nothing else', async () => {
    const es = await call(INCOME_STATEMENT, 'es');
    const en = await call(INCOME_STATEMENT, 'en');

    expect(es.body.data.revenue!.accounts).toEqual(en.body.data.revenue!.accounts);
    expect(es.body.data.revenue!.accounts!.map((a) => a.name)).toEqual(['Ventas']);
    expect(es.body.data.net_income).toEqual(en.body.data.net_income);
    expect(es.body.data.revenue!.total).toBe(en.body.data.revenue!.total);
    expect(es.body.data.revenue!.total).toMatch(/^900\.0+$/);
  });
});
