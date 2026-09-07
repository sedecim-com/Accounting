import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn(mockClient)),
}));

import {
  seedPayrollAccountMapping,
  chartFor,
  normalizarPais,
  REQUIRED_BUCKETS,
  MX_BUCKET_MAP,
  US_BUCKET_MAP,
  MX_PAYROLL_ACCOUNTS,
  US_PAYROLL_ACCOUNTS,
} from '../../../src/services/payroll/common/payroll-account-mapping-seed.js';
import { BASE_CHART_MX, ESTRATO_FISCAL_NEUTRO } from '../../../src/services/accounting/chart-seed.js';
import { REQUIRED_ACCOUNTS } from '../../../src/services/xml-ingestion/account-roles-seed.js';

// ============================================================
// payroll_account_mapping had a reader (gl-posting-service) and NO writer
// anywhere in the repository, so the first pay run of any entity died with
// "Missing payroll_account_mapping for bucket: wages_expense". These tests
// pin the two properties that matter: every bucket the posting engine can
// ask for is mapped, and re-running never overwrites a firm's own choice.
// ============================================================

const mockClient = { query: vi.fn() };
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TENANT = 'tttttttt-tttt-tttt-tttt-tttttttttttt';
const USER = 'user-1';

beforeEach(() => mockClient.query.mockReset());

/** Existing chart rows, then already-mapped buckets, then the writes. */
function arrange(existingCodes: string[], mappedBuckets: string[]) {
  mockClient.query.mockResolvedValueOnce({
    rows: existingCodes.map((code, i) => ({ code, id: `acct-${i}` })),
  });
  let inserts = 0;
  mockClient.query.mockImplementation(async (sql: string) => {
    if (/SELECT bucket FROM payroll_account_mapping/.test(sql)) {
      return { rows: mappedBuckets.map((bucket) => ({ bucket })) };
    }
    inserts++;
    return { rows: [], rowCount: 1 };
  });
  return () => inserts;
}

describe('every bucket the posting engine can ask for is mapped', () => {
  it('maps the three buckets postPayRunToGL treats as mandatory', () => {
    for (const bucket of REQUIRED_BUCKETS) {
      expect(MX_BUCKET_MAP, `MX is missing ${bucket}`).toHaveProperty(bucket);
      expect(US_BUCKET_MAP, `US is missing ${bucket}`).toHaveProperty(bucket);
    }
  });

  it('maps the Mexican withholding payables the engine credits', () => {
    for (const bucket of ['isr_payable', 'imss_payable', 'infonavit_payable']) {
      expect(MX_BUCKET_MAP).toHaveProperty(bucket);
    }
  });

  it('maps the US withholding payables the engine credits', () => {
    for (const bucket of ['fit_payable', 'fica_payable', 'futa_payable', 'suta_payable', 'state_tax_payable']) {
      expect(US_BUCKET_MAP).toHaveProperty(bucket);
    }
  });

  it('every mapped code is seeded here or by a seed that runs first', () => {
    // Las fuentes se IMPORTAN en vez de listarse a mano: la lista escrita a
    // mano decía ['1111','2130'] y quedó falsa en cuanto la nómina empezó a
    // reusar 2170 de account-roles-seed.
    const base = new Set(BASE_CHART_MX.map((a) => a.code));
    const roles = new Set(REQUIRED_ACCOUNTS.map((a) => a.code));
    const seeded = new Set(MX_PAYROLL_ACCOUNTS.map((a) => a.code));
    for (const code of Object.values(MX_BUCKET_MAP)) {
      expect(
        seeded.has(code) || base.has(code) || roles.has(code),
        `MX code ${code} has no source`
      ).toBe(true);
    }
    const seededUs = new Set(US_PAYROLL_ACCOUNTS.map((a) => a.code));
    const neutro = new Set(ESTRATO_FISCAL_NEUTRO.map((a) => a.code));
    for (const code of Object.values(US_BUCKET_MAP)) {
      // El banco se reusa en vez de declararse, igual que en México.
      // Pero es el del estrato NEUTRO (1115), no el 1111 mexicano: desde que
      // el catálogo base ramifica por país, una entidad estadounidense no
      // recibe una cuenta denominada en pesos.
      expect(
        seededUs.has(code) || neutro.has(code),
        `US code ${code} has no source`
      ).toBe(true);
    }
  });

  it('ninguna semilla reclama un código que otra ya declaró con otro nombre', () => {
    // La colisión no la ve el motor: la guarda de creación compara CÓDIGOS, y
    // dos nombres distintos bajo el mismo número hacen que la segunda semilla
    // herede la cuenta de la primera en silencio. `wages_expense` apuntó
    // durante meses a «Devoluciones y Descuentos sobre Compras» por esto.
    const porCodigo = new Map<string, Set<string>>();
    for (const a of [...BASE_CHART_MX, ...REQUIRED_ACCOUNTS, ...MX_PAYROLL_ACCOUNTS, ...US_PAYROLL_ACCOUNTS]) {
      porCodigo.set(a.code, (porCodigo.get(a.code) ?? new Set()).add(a.name));
    }
    const choques = [...porCodigo.entries()]
      .filter(([, nombres]) => nombres.size > 1)
      .map(([code, nombres]) => `${code}: ${[...nombres].join(' vs ')}`);
    expect(choques).toEqual([]);
  });
});

describe('seedPayrollAccountMapping', () => {
  it('creates only the accounts the chart lacks', async () => {
    arrange(['1111', '2130'], []);
    const result = await seedPayrollAccountMapping(ENTITY, TENANT, 'MX', USER, { client: mockClient as never });
    // 1111 y 2130 ya estaban; las seis cuentas de nómina no. La 6118 nació en
    // F08a para el subsidio al empleo entregado que un despacho decide
    // absorber en vez de acreditar.
    expect(result.accountsCreated).toEqual(['2165', '2175', '2185', '6110', '6115', '6118']);
  });

  it('creates nothing when the chart already carries every account', async () => {
    arrange([...new Set(Object.values(MX_BUCKET_MAP))], []);
    const result = await seedPayrollAccountMapping(ENTITY, TENANT, 'MX', USER, { client: mockClient as never });
    expect(result.accountsCreated).toEqual([]);
  });

  it('never overwrites a bucket a firm already mapped itself', async () => {
    arrange([...new Set(Object.values(MX_BUCKET_MAP))], ['wages_expense', 'cash_payroll']);
    const result = await seedPayrollAccountMapping(ENTITY, TENANT, 'MX', USER, { client: mockClient as never });
    expect(result.bucketsAlreadyMapped).toEqual(['wages_expense', 'cash_payroll']);
    expect(result.bucketsMapped).not.toContain('wages_expense');
    expect(result.bucketsMapped).not.toContain('cash_payroll');
  });

  it('is idempotent: a second run maps nothing new', async () => {
    arrange([...new Set(Object.values(MX_BUCKET_MAP))], Object.keys(MX_BUCKET_MAP));
    const result = await seedPayrollAccountMapping(ENTITY, TENANT, 'MX', USER, { client: mockClient as never });
    expect(result.bucketsMapped).toEqual([]);
    expect(result.accountsCreated).toEqual([]);
  });

  it('routes by country and reports which chart it used', async () => {
    arrange([], []);
    const us = await seedPayrollAccountMapping(ENTITY, TENANT, 'USA', USER, { client: mockClient as never });
    expect(us.country).toBe('USA');
    expect(us.bucketsMapped).toContain('futa_payable');
    expect(us.bucketsMapped).not.toContain('imss_payable');
  });

  it('treats an unknown country as Mexico, the product default', () => {
    expect(chartFor('CA').buckets).toBe(MX_BUCKET_MAP);
    expect(chartFor('MX').buckets).toBe(MX_BUCKET_MAP);
    expect(chartFor('USA').buckets).toBe(US_BUCKET_MAP);
    // El alfa-2 que la columna CHAR(2) guarda de verdad.
    expect(chartFor('US').buckets).toBe(US_BUCKET_MAP);
  });

  it('scopes both writes to the entity and the tenant', async () => {
    arrange([...new Set(Object.values(MX_BUCKET_MAP))], []);
    await seedPayrollAccountMapping(ENTITY, TENANT, 'MX', USER, { client: mockClient as never });
    const mapInserts = mockClient.query.mock.calls.filter(
      ([sql]) => typeof sql === 'string' && /INSERT INTO payroll_account_mapping/.test(sql)
    );
    expect(mapInserts.length).toBe(Object.keys(MX_BUCKET_MAP).length);
    for (const [, params] of mapInserts) {
      expect(params[1]).toBe(TENANT);
      expect(params[2]).toBe(ENTITY);
    }
  });

  it('reports what it could not map instead of refusing to seed anything', async () => {
    // The onboarded-chart case: the firm keeps its own chart, so the two
    // codes this seeder REUSES rather than creates (1111 the bank, 2130 ISR)
    // may simply be absent. Blocking the whole mapping over a bank account
    // the firm must choose anyway would be worse than reporting it.
    arrange([], []);
    const result = await seedPayrollAccountMapping(ENTITY, TENANT, 'MX', USER, { client: mockClient as never });

    // Tres códigos se REUSAN en vez de crearse: 1111 y 2130 del catálogo base,
    // y 2170 «IMSS por Pagar» de account-roles-seed. Los tres pueden faltar en
    // una llamada suelta como ésta; en el alta real no faltan, porque
    // ensureEntityAccounting corre las dos semillas antes que ésta.
    expect(result.bucketsUnmappable.map((b) => b.bucket).sort())
      .toEqual(['cash_payroll', 'imss_payable', 'isr_payable']);
    expect(result.bucketsUnmappable.find((b) => b.bucket === 'cash_payroll')?.code).toBe('1111');
    expect(result.bucketsUnmappable.find((b) => b.bucket === 'imss_payable')?.code).toBe('2170');
    // Everything this seeder creates itself still got mapped.
    expect(result.bucketsMapped).toContain('wages_expense');
    expect(result.bucketsMapped).toContain('infonavit_payable');
  });

  it('leaves nothing unmappable on a chart that has the reused codes', async () => {
    arrange(['1111', '2130', '2170'], []);
    const result = await seedPayrollAccountMapping(ENTITY, TENANT, 'MX', USER, { client: mockClient as never });
    expect(result.bucketsUnmappable).toEqual([]);
    expect(result.bucketsMapped.sort()).toEqual(Object.keys(MX_BUCKET_MAP).sort());
  });
});

// ============================================================
// EL PAÍS QUE SE INFORMA Y EL CATÁLOGO QUE SE USA SALEN DE LA MISMA CUENTA
//
// Lo que legal_entities.incorporation_country guarda es 'US': la columna es
// CHAR(2) y COUNTRY_PROFILES.USA.iso2 === 'US'. `chartFor` lo aceptaba, pero
// el `country` del resultado se recalculaba aparte con `=== 'USA'`, así que
// una entidad estadounidense recibía el catálogo estadounidense CORRECTO y se
// declaraba mexicana. No reventaba nada: sólo mentía — y salía al mundo,
// porque `entity create --json` vuelca el resultado entero.
//
// Estas pruebas no fijan un valor: fijan que las dos respuestas no puedan
// volver a discrepar, que es lo que el arreglo hizo estructuralmente.
// ============================================================
describe('el país informado no puede discrepar del catálogo usado', () => {
  it('acepta el alfa-2 que la columna guarda y la clave que el asistente usa', () => {
    expect(normalizarPais('US')).toBe('USA');
    expect(normalizarPais('USA')).toBe('USA');
    expect(normalizarPais('  us  ')).toBe('USA');
    expect(normalizarPais('MX')).toBe('MX');
    expect(normalizarPais('CA')).toBe('MX');
    expect(normalizarPais(null)).toBe('MX');
    expect(normalizarPais(undefined)).toBe('MX');
  });

  it("informa 'USA' para el 'US' que la base de datos entrega", async () => {
    arrange([], []);
    const result = await seedPayrollAccountMapping(ENTITY, TENANT, 'US', USER, {
      client: mockClient as never,
    });
    expect(result.country).toBe('USA');
    // Y no es que informe bien y siembre mal: el catálogo es el de EE. UU.
    expect(result.bucketsMapped).toContain('futa_payable');
    expect(result.bucketsMapped).not.toContain('infonavit_payable');
  });

  it('venga como venga el país, la etiqueta describe el catálogo sembrado', async () => {
    for (const entrada of ['US', 'USA', 'us', ' Us ', 'MX', 'mx', 'CA', '']) {
      mockClient.query.mockReset();
      arrange([], []);
      const result = await seedPayrollAccountMapping(ENTITY, TENANT, entrada, USER, {
        client: mockClient as never,
      });
      const { pais, buckets } = chartFor(entrada);
      expect(result.country, entrada).toBe(pais);
      // Un bucket que SÓLO existe en el catálogo de ese país, y que esta
      // semilla crea ella misma (así se mapea aunque el catálogo esté vacío).
      const propio = pais === 'USA' ? 'futa_payable' : 'infonavit_payable';
      const ajeno = pais === 'USA' ? 'infonavit_payable' : 'futa_payable';
      expect(Object.keys(buckets), entrada).toContain(propio);
      expect(Object.keys(buckets), entrada).not.toContain(ajeno);
      expect(result.bucketsMapped, entrada).toContain(propio);
      expect(result.bucketsMapped, entrada).not.toContain(ajeno);
    }
  });
});
