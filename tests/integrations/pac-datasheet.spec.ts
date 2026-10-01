import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Postgres is mocked: the router only reads preferences through `query`.
const queryMock = vi.hoisted(() => vi.fn(async () => ({ rows: [] as unknown[] })));
vi.mock('../../src/database/connection.js', () => ({ query: queryMock }));
const loadCredentials = vi.hoisted(() => vi.fn());
vi.mock('../../src/services/integrations/base/registry.js', () => ({
  integrationRegistry: { register: vi.fn(), loadCredentials },
}));
vi.mock('../../src/services/integrations/base/circuit-breaker.js', () => ({
  circuitBreaker: {
    canAttempt: vi.fn(async () => true),
    execute: vi.fn(async (_t: string, _p: string, fn: () => Promise<unknown>) => fn()),
  },
  CircuitBreakerOpenError: class extends Error {},
}));

import type { IPacAdapter, PacDatasheet } from '../../src/services/integrations/base/adapter.interface.js';
import {
  PAC_ADAPTERS,
  DEFAULT_PAC_ORDER,
  pacRouter,
} from '../../src/services/integrations/mexico/pac/pac-router.js';

describe('every PAC adapter carries a pre-sealed datasheet (vault rule as a type)', () => {
  it('each registered adapter declares timbradoPresellado = true and a sandbox field', () => {
    for (const [id, adapter] of Object.entries(PAC_ADAPTERS)) {
      expect(adapter.datasheet.timbradoPresellado, id).toBe(true);
      expect(adapter.datasheet.provider, id).toBeTruthy();
      expect(adapter.datasheet.sandbox, id).toHaveProperty('url');
      // Nobody has checked these by hand in the SAT portal yet: never claim it.
      expect(adapter.datasheet.satAuthorization.verified, id).toBe(false);
    }
  });

  it('Sovos carries its documented SAT authorization number', () => {
    expect(PAC_ADAPTERS.sovos_reachcore.datasheet.satAuthorization.number).toBe('55267');
  });

  it('the datasheet type refuses timbradoPresellado: false or a missing field (compile-time)', () => {
    const base = {
      provider: 'x',
      satAuthorization: { number: null, verified: false },
      sandbox: { url: null },
    } as const;
    // @ts-expect-error timbradoPresellado must be the literal true
    const notPresealed: PacDatasheet = { ...base, timbradoPresellado: false };
    // @ts-expect-error timbradoPresellado is required
    const missingField: PacDatasheet = { ...base };
    const ok: PacDatasheet = { ...base, timbradoPresellado: true };
    expect([notPresealed, missingField, ok]).toHaveLength(3);
  });

  it('an adapter without datasheet does not satisfy IPacAdapter (compile-time)', () => {
    const { datasheet: omitted, ...withoutDatasheet } = PAC_ADAPTERS.finkok;
    expect(omitted.timbradoPresellado).toBe(true);
    // @ts-expect-error missing datasheet
    const broken: IPacAdapter = withoutDatasheet;
    expect(broken).toBeDefined();
  });
});

describe('default PAC order', () => {
  it('is sw_sapien -> prodigia -> solucion_factible -> finkok', () => {
    expect([...DEFAULT_PAC_ORDER]).toEqual(['sw_sapien', 'prodigia', 'solucion_factible', 'finkok']);
  });

  it('a tenant with no saved preferences gets that order as its first three slots', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const prefs = await pacRouter.getPreferences('t1');
    expect(prefs).toEqual({
      pac_primary: 'sw_sapien',
      pac_secondary: 'prodigia',
      pac_tertiary: 'solucion_factible',
      auto_failover: true,
    });
  });

  it('a tenant with saved preferences keeps its own order', async () => {
    const saved = { pac_primary: 'finkok', pac_secondary: null, pac_tertiary: null, auto_failover: false };
    queryMock.mockResolvedValueOnce({ rows: [saved] });
    expect(await pacRouter.getPreferences('t2')).toEqual(saved);
  });
});

describe('router chain and partial saves', () => {
  beforeEach(() => {
    queryMock.mockReset();
    queryMock.mockResolvedValue({ rows: [] });
    loadCredentials.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  const ctx = { tenantId: 't1', userId: 'u1' };

  it('selectPac reaches finkok, the fourth default slot, skipping ids with no adapter', async () => {
    loadCredentials.mockImplementation(async (_t: string, id: string) => (id === 'finkok' ? {} : null));
    const { providerId } = await pacRouter.selectPac(ctx);
    expect(providerId).toBe('finkok');
    expect(loadCredentials.mock.calls.map((c: unknown[]) => c[1])).toEqual(['sw_sapien', 'finkok']);
  });

  it('stamp tries the default chain in order, ending at finkok', async () => {
    const tried: string[] = [];
    for (const id of ['sw_sapien', 'finkok']) {
      vi.spyOn(PAC_ADAPTERS[id], 'stamp').mockImplementation(async () => {
        tried.push(id);
        if (id === 'sw_sapien') throw new Error('down');
        return { uuid: 'u' } as never;
      });
      vi.spyOn(PAC_ADAPTERS[id], 'simulado', 'get').mockReturnValue(false);
    }
    const out = await pacRouter.stamp('<x/>', ctx);
    expect(tried).toEqual(['sw_sapien', 'finkok']);
    expect(out.provider_used).toBe('finkok');
  });

  it('a partial save never writes an id without adapter and passes NULL for unsent slots', async () => {
    await pacRouter.savePreferences('t1', { pac_primary: 'finkok' });
    const [sql, params] = queryMock.mock.calls[0] as unknown as [string, unknown[]];
    expect(params.slice(0, 5)).toEqual(['t1', 'finkok', null, null, null]);
    for (const fallback of params.slice(5)) {
      if (fallback !== null) expect(Object.keys(PAC_ADAPTERS)).toContain(fallback);
    }
    expect(JSON.stringify(params)).not.toMatch(/prodigia|solucion_factible/);
    expect(sql).toContain('COALESCE($3::varchar, pac_preferences.pac_secondary)');
    expect(sql).toContain('COALESCE($4::varchar, pac_preferences.pac_tertiary)');
  });
});
