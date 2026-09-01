import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (fn: (c: unknown) => unknown) => fn(mockClient)),
}));

import {
  seedPayrollAccountMapping,
  chartFor,
  REQUIRED_BUCKETS,
  MX_BUCKET_MAP,
  US_BUCKET_MAP,
  MX_PAYROLL_ACCOUNTS,
  US_PAYROLL_ACCOUNTS,
} from '../../../src/services/payroll/common/payroll-account-mapping-seed.js';

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

  it('every mapped code is either seeded here or is a base-chart code', () => {
    // 1111 and 2130 come from chart-seed's BASE_CHART_MX and are reused
    // deliberately rather than duplicated under a second code.
    const BASE_CHART_MX_CODES = ['1111', '2130'];
    const seeded = new Set(MX_PAYROLL_ACCOUNTS.map((a) => a.code));
    for (const code of Object.values(MX_BUCKET_MAP)) {
      expect(seeded.has(code) || BASE_CHART_MX_CODES.includes(code), `MX code ${code} has no source`).toBe(true);
    }
    const seededUs = new Set(US_PAYROLL_ACCOUNTS.map((a) => a.code));
    for (const code of Object.values(US_BUCKET_MAP)) {
      // There is no US base chart, so every US code must be seeded here.
      expect(seededUs.has(code), `US code ${code} is not seeded and there is no US base chart`).toBe(true);
    }
  });
});

describe('seedPayrollAccountMapping', () => {
  it('creates only the accounts the chart lacks', async () => {
    arrange(['1111', '2130'], []);
    const result = await seedPayrollAccountMapping(ENTITY, TENANT, 'MX', USER, { client: mockClient as never });
    // 1111 and 2130 already existed; the six MX payroll accounts did not.
    expect(result.accountsCreated).toEqual(['5200', '5210', '2150', '2160', '2170', '2180']);
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

    expect(result.bucketsUnmappable.map((b) => b.bucket).sort()).toEqual(['cash_payroll', 'isr_payable']);
    expect(result.bucketsUnmappable.find((b) => b.bucket === 'cash_payroll')?.code).toBe('1111');
    // Everything this seeder creates itself still got mapped.
    expect(result.bucketsMapped).toContain('wages_expense');
    expect(result.bucketsMapped).toContain('imss_payable');
  });

  it('leaves nothing unmappable on a chart that has the reused codes', async () => {
    arrange(['1111', '2130'], []);
    const result = await seedPayrollAccountMapping(ENTITY, TENANT, 'MX', USER, { client: mockClient as never });
    expect(result.bucketsUnmappable).toEqual([]);
    expect(result.bucketsMapped.sort()).toEqual(Object.keys(MX_BUCKET_MAP).sort());
  });
});
