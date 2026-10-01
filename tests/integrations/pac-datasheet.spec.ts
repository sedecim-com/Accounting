import { describe, it, expect, vi } from 'vitest';

// Postgres is mocked: the router only reads preferences through `query`.
const queryMock = vi.hoisted(() => vi.fn(async () => ({ rows: [] as unknown[] })));
vi.mock('../../src/database/connection.js', () => ({ query: queryMock }));

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
