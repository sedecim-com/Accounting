import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  dailyMinimumWageFor,
  minimumWageZoneOf,
  parseMinimumWageZone,
  setEntityMinimumWageZone,
} from '../../../src/services/payroll/mx/minimum-wage-zone.js';
import { query, withTransaction } from '../../../src/database/connection.js';
import { NotFoundError, ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;
const mockClient = { query: vi.fn() };
(withTransaction as unknown as Mock).mockImplementation(async (fn: (c: unknown) => unknown) => fn(mockClient));
const CTX = { tenantId: 't1', entityId: 'e1' };

// MNE-001-377 (#196). The zone is a datum of the entity, with an optional
// override per employee (LFT art. 486: the area of the place of work). With
// none declared, the general minimum applies and the answer says so
// (decision MNE-001-376).
describe('which zone', () => {
  beforeEach(() => mockQuery.mockReset());
  const row = (r: Record<string, unknown>) => mockQuery.mockResolvedValueOnce({ rows: [r] });

  it('the employee\'s override wins over the entity', async () => {
    row({ entity_zone: 'general', entity_declared: true, employee_zone: 'northern_border' });
    expect(await minimumWageZoneOf(CTX, 'emp1')).toEqual({ zone: 'northern_border', declaredBy: 'employee' });
  });

  it('then the entity\'s declared zone', async () => {
    row({ entity_zone: 'northern_border', entity_declared: true, employee_zone: null });
    expect(await minimumWageZoneOf(CTX, 'emp1')).toEqual({ zone: 'northern_border', declaredBy: 'entity' });
  });

  it('an entity that never declared reads general, and says nobody declared it', async () => {
    row({ entity_zone: 'general', entity_declared: false, employee_zone: null });
    expect(await minimumWageZoneOf(CTX)).toEqual({ zone: 'general', declaredBy: null });
  });

  it('the query stays inside the tenant and the entity', async () => {
    row({ entity_zone: 'general', entity_declared: false, employee_zone: null });
    await minimumWageZoneOf(CTX, 'emp1');
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/le\.tenant_id = \$2/);
    expect(params).toEqual(['e1', 't1', 'emp1']);
  });

  it('with no entity at all it is the undeclared general zone, and nothing is read', async () => {
    expect(await minimumWageZoneOf({ tenantId: 't1' })).toEqual({ zone: 'general', declaredBy: null });
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('which minimum', () => {
  const PARAMS = { salario_minimo_general_diario: 315.04, salario_minimo_frontera_diario: 440.87 };

  it('the border zone reads the border minimum, the general zone the general one', () => {
    expect(dailyMinimumWageFor(PARAMS, 'northern_border')).toBe('440.87');
    expect(dailyMinimumWageFor(PARAMS, 'general')).toBe('315.04');
  });

  it('a year without the border figure has none: it is never replaced by the general one', () => {
    expect(dailyMinimumWageFor({ salario_minimo_general_diario: 315.04 }, 'northern_border')).toBeUndefined();
  });

  it('only the two zones exist, and an unknown one is refused naming them', () => {
    expect(parseMinimumWageZone(' northern_border ')).toBe('northern_border');
    expect(() => parseMinimumWageZone('frontera')).toThrow(ValidationError);
    expect(() => parseMinimumWageZone('frontera')).toThrow(/general, northern_border/);
  });
});

describe('declaring the entity\'s zone', () => {
  const AUDIT = { userId: 'u1', tenantId: 't1', reason: 'registro patronal en Tijuana' };
  beforeEach(() => mockClient.query.mockReset());
  function db(found = true) {
    mockClient.query.mockImplementation(async (sql: string) => {
      if (/FOR UPDATE/.test(sql)) return { rows: found ? [{ minimum_wage_zone: 'general', minimum_wage_zone_declared_at: null }] : [] };
      if (/UPDATE legal_entities/.test(sql)) return { rows: [{ declared_at: '2026-11-19T00:00:00.000Z' }], rowCount: 1 };
      return { rows: [] };
    });
  }

  it('writes the zone and stamps the declaration, inside the tenant, audited', async () => {
    db();
    const r = await setEntityMinimumWageZone('e1', 't1', 'northern_border', AUDIT);
    expect(r).toEqual({ minimum_wage_zone: 'northern_border', minimum_wage_zone_declared_at: '2026-11-19T00:00:00.000Z' });
    const calls = mockClient.query.mock.calls as Array<[string, unknown[]]>;
    const update = calls.find((c) => /UPDATE legal_entities/.test(c[0]))!;
    expect(update[0]).toMatch(/minimum_wage_zone_declared_at = NOW\(\)/);
    expect(update[0]).toMatch(/tenant_id = \$2/);
    expect(update[1]).toEqual(['e1', 't1', 'northern_border']);
    const audit = calls.find((c) => /INSERT INTO audit_log/.test(c[0]));
    expect(audit?.[1]).toContain('legal_entities');
  });

  it('an entity outside the tenant is a 404, and an unknown zone never reaches the database', async () => {
    db(false);
    await expect(setEntityMinimumWageZone('e1', 't1', 'general', AUDIT)).rejects.toThrow(NotFoundError);
    mockClient.query.mockReset();
    await expect(setEntityMinimumWageZone('e1', 't1', 'frontera', AUDIT)).rejects.toThrow(ValidationError);
    expect(mockClient.query).not.toHaveBeenCalled();
  });
});
