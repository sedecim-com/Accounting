import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

const client = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

import {
  tenantSlug,
  normalizeTenantInput,
  createTenant,
  listTenants,
  TENANT_PLAN,
} from '../../../src/services/tenant/tenant-service.js';
import { query } from '../../../src/database/connection.js';
import { ConflictError, ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;

/** Answers client.query by a fragment of its SQL. */
function answer(rows: Record<string, unknown[]>): void {
  client.query.mockImplementation(async (sql: string) => {
    const key = Object.keys(rows).find((k) => sql.includes(k));
    return { rows: key ? rows[key] : [], rowCount: key ? rows[key].length : 0 };
  });
}

beforeEach(() => {
  client.query.mockReset();
  mockQuery.mockReset();
});

describe('tenantSlug', () => {
  it('folds accents instead of turning them into hyphens', () => {
    expect(tenantSlug('Despacho Pérez & Asociados, S.C.')).toBe('despacho-perez-asociados-s-c');
  });

  it('caps at 40 characters without a trailing hyphen', () => {
    expect(tenantSlug(`${'a'.repeat(39)} b`)).toBe('a'.repeat(39));
  });

  it('yields nothing from a name without letters or digits', () => {
    expect(tenantSlug('¿¡ !?')).toBe('');
  });
});

describe('normalizeTenantInput', () => {
  it('trims the name and derives the subdomain', () => {
    expect(normalizeTenantInput({ name: '  Norte Contadores ' })).toEqual({
      name: 'Norte Contadores',
      subdomain: 'norte-contadores',
    });
  });

  it('keeps an explicit subdomain, lowercased', () => {
    expect(normalizeTenantInput({ name: 'X', subdomain: ' Norte-2 ' }).subdomain).toBe('norte-2');
  });

  it('refuses an empty name', () => {
    expect(() => normalizeTenantInput({ name: '   ' })).toThrow(ValidationError);
  });

  it('refuses an explicit subdomain with characters a host name cannot carry', () => {
    expect(() => normalizeTenantInput({ name: 'X', subdomain: 'norte_2' })).toThrow(/not a valid subdomain/);
  });

  it('refuses a name longer than tenants.name holds, as a validation error', () => {
    expect(() => normalizeTenantInput({ name: 'n'.repeat(256), subdomain: 'norte' })).toThrow(ValidationError);
    expect(() => normalizeTenantInput({ name: 'n'.repeat(256), subdomain: 'norte' })).toThrow(/255/);
    expect(normalizeTenantInput({ name: 'ñ'.repeat(255), subdomain: 'norte' }).name).toHaveLength(255);
  });

  it('caps a subdomain at 63 characters, the most a DNS label carries', () => {
    expect(normalizeTenantInput({ name: 'X', subdomain: 'a'.repeat(63) }).subdomain).toHaveLength(63);
    expect(() => normalizeTenantInput({ name: 'X', subdomain: 'a'.repeat(64) })).toThrow(/up to 63/);
  });

  it('asks for --subdomain when the name yields none', () => {
    expect(() => normalizeTenantInput({ name: '¿¡!?' })).toThrow(/--subdomain/);
  });
});

describe('createTenant', () => {
  it('inserts with schema public, sets the new tenant for the audit row, and attributes to its system account', async () => {
    answer({
      'INSERT INTO public.tenants': [{ id: 't-new' }],
      'SELECT id FROM public.users': [],
      'INSERT INTO public.users': [{ id: 'u-system' }],
    });
    const r = await createTenant({ name: 'Norte Contadores' });
    expect(r).toEqual({
      tenantId: 't-new', name: 'Norte Contadores', subdomain: 'norte-contadores',
      plan: TENANT_PLAN, createdBy: 'u-system',
    });
    const calls = client.query.mock.calls as Array<[string, unknown[]]>;
    const insert = calls.find(([sql]) => sql.includes('INSERT INTO public.tenants'));
    expect(insert?.[0]).toContain("'public'");
    expect(insert?.[1]).toEqual(['Norte Contadores', 'norte-contadores', 'professional']);
    const setIdx = calls.findIndex(([sql]) => sql.includes('set_config'));
    const auditIdx = calls.findIndex(([sql]) => sql.includes('INSERT INTO audit_log'));
    expect(setIdx).toBeGreaterThan(-1);
    expect(calls[setIdx][1]).toEqual(['app.current_tenant', 't-new']);
    expect(auditIdx).toBeGreaterThan(setIdx);
    expect(calls[auditIdx][1]).toEqual(expect.arrayContaining(['u-system', 't-new', 'create', 'tenants']));
  });

  it('refuses a taken subdomain naming its owner, and writes nothing else', async () => {
    // Also what a concurrent create of the same firm sees: the UNIQUE decides,
    // ON CONFLICT turns it into no row instead of a raw 23505.
    answer({
      'INSERT INTO public.tenants': [],
      'SELECT id, name FROM public.tenants': [{ id: 't-old', name: 'Norte Viejo' }],
    });
    await expect(createTenant({ name: 'Norte Contadores' })).rejects.toThrow(ConflictError);
    await expect(createTenant({ name: 'Norte Contadores' })).rejects.toThrow(/Norte Viejo.*t-old/);
    const calls = client.query.mock.calls as Array<[string]>;
    expect(calls.find(([sql]) => sql.includes('INSERT INTO public.tenants'))?.[0]).toMatch(
      /ON CONFLICT \(subdomain\) DO NOTHING/
    );
    const otherWrites = calls.filter(([sql]) => /INSERT/.test(sql) && !sql.includes('public.tenants'));
    expect(otherWrites).toEqual([]);
  });
});

describe('listTenants', () => {
  it('reads every tenant, oldest first', async () => {
    mockQuery.mockResolvedValue({ rows: [{ id: 'a' }, { id: 'b' }] });
    expect(await listTenants()).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(mockQuery.mock.calls[0][0]).toMatch(/FROM public\.tenants\s+ORDER BY created_at ASC/);
  });
});
