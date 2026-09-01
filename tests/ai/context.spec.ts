import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

import { resolveEntity, listEntities, bootstrapTenant } from '../../src/ai/context.js';
import { query, enterTenant } from '../../src/database/connection.js';

const mockQuery = query as unknown as Mock;
const mockEnterTenant = enterTenant as unknown as Mock;

const ENTITY_ROW = {
  id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'Acme MX SA de CV',
  tenant_id: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  functional_currency: 'MXN',
  incorporation_country: 'MX',
  accounting_standard: 'mx_nif',
  tax_id: 'AME010101AAA',
};

describe('resolveEntity', () => {
  beforeEach(() => { mockQuery.mockReset(); mockEnterTenant.mockReset(); });

  it('resolves by UUID', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ENTITY_ROW] });
    const ctx = await resolveEntity(ENTITY_ROW.id);
    expect(ctx.entityId).toBe(ENTITY_ROW.id);
    expect(ctx.entityName).toBe('Acme MX SA de CV');
    expect(ctx.currency).toBe('MXN');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(params).toEqual([ENTITY_ROW.id]);
  });

  it('resolves by name fragment (single match)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ENTITY_ROW] });
    const ctx = await resolveEntity('acme');
    expect(ctx.entityId).toBe(ENTITY_ROW.id);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/name ILIKE \$1/);
    expect(params).toEqual(['%acme%', 'ACME']);
  });

  it('rejects an ambiguous name with the candidate list', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [ENTITY_ROW, { ...ENTITY_ROW, id: 'ffffffff-1111-2222-3333-444444444444', name: 'Acme USA Inc' }],
    });
    await expect(resolveEntity('acme')).rejects.toThrow(/ambiguous/);
  });

  it('rejects when no match', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolveEntity('nope')).rejects.toThrow(/No active entity matches/);
  });

  it('defaults to the single active entity when no argument', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ENTITY_ROW] });
    const ctx = await resolveEntity();
    expect(ctx.entityId).toBe(ENTITY_ROW.id);
  });

  it('rejects with a listing when multiple entities and no argument', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [ENTITY_ROW, { ...ENTITY_ROW, id: 'ffffffff-1111-2222-3333-444444444444', name: 'Acme USA Inc' }],
    });
    await expect(resolveEntity()).rejects.toThrow(/--entity/);
  });
});

describe('listEntities', () => {
  beforeEach(() => { mockQuery.mockReset(); mockEnterTenant.mockReset(); });

  it('returns active entities ordered by name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ENTITY_ROW] });
    const rows = await listEntities();
    expect(rows).toHaveLength(1);
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/is_active = true/);
    expect(sql).toMatch(/ORDER BY name/);
  });
});

describe('isolation: the tenant context is set automatically', () => {
  beforeEach(() => { mockQuery.mockReset(); mockEnterTenant.mockReset(); });

  it('resolveEntity enters the entity tenant context', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [ENTITY_ROW] });
    await resolveEntity(ENTITY_ROW.id);
    // Without this, every later query would run unscoped and RLS would not filter.
    expect(mockEnterTenant).toHaveBeenCalledWith(ENTITY_ROW.tenant_id);
  });

  it('bootstrapTenant prefers the flag over the environment variable', () => {
    process.env.MNEMOSINE_TENANT = 'from-env';
    bootstrapTenant('from-flag');
    expect(mockEnterTenant).toHaveBeenCalledWith('from-flag');
    delete process.env.MNEMOSINE_TENANT;
  });

  it('bootstrapTenant uses the environment variable when there is no flag', () => {
    process.env.MNEMOSINE_TENANT = 'from-env';
    bootstrapTenant(undefined);
    expect(mockEnterTenant).toHaveBeenCalledWith('from-env');
    delete process.env.MNEMOSINE_TENANT;
  });

  it('with neither flag nor env it sets nothing: resolveEntity will do it', () => {
    delete process.env.MNEMOSINE_TENANT;
    bootstrapTenant(undefined);
    expect(mockEnterTenant).not.toHaveBeenCalled();
  });
});
