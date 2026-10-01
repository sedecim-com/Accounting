import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn(), currentTenant: vi.fn() }));
vi.mock('../../src/ai/shadow-verdicts.js', () => ({ concordanciaSombra: vi.fn() }));

import { calendarDateIn, assertTimeZone } from '../../src/utils/calendar-date.js';
import { todayFor, dayOrToday, todayForEntity, todayForCustomer } from '../../src/services/policy/today.js';
import { resolvePolicy } from '../../src/services/policy/policy-service.js';
import { getPolicySpec } from '../../src/services/policy/pending-catalog.js';
import { getTaxParameters } from '../../src/services/payroll/tax-engine/tax-tables.js';
import { query, currentTenant } from '../../src/database/connection.js';
import { ValidationError } from '../../src/utils/errors.js';

// ============================================================
// "TODAY" IS THE DAY IN `zona_horaria`, NOT THE UTC DAY (#242).
//
// 20:00 on October 31st in Mexico City is 02:00 on November 1st in UTC. A
// date cut from `toISOString()` is the 1st; the process's local fields are
// the 1st too on a server that runs in UTC; a bare CURRENT_DATE is the
// database session's day. The day a document is dated is the 31st.
//
// The clock is fixed, and the process zone is moved to the three places that
// matter: UTC (CI, where the UTC-day defect is invisible only by accident of
// the hour), the east and the west.
// ============================================================

const EVENING_IN_MEXICO_CITY = new Date('2026-11-01T02:00:00Z'); // Oct 31, 20:00 CDMX
const MORNING_IN_TOKYO = new Date('2026-10-31T16:00:00Z'); // Nov 1, 01:00 Tokyo

const mockQuery = query as unknown as Mock;
const originalTz = process.env.TZ;

beforeEach(() => {
  mockQuery.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = originalTz;
});

describe('calendarDateIn: the day in a zone, whatever the process zone is', () => {
  it.each(['UTC', 'Asia/Tokyo', 'America/Mexico_City'])(
    'with the process in %s, 20:00 in Mexico City is still the 31st',
    (tz) => {
      process.env.TZ = tz;
      expect(calendarDateIn('America/Mexico_City', EVENING_IN_MEXICO_CITY)).toBe('2026-10-31');
      // The same instant is already tomorrow in UTC: this is the defect.
      expect(EVENING_IN_MEXICO_CITY.toISOString().slice(0, 10)).toBe('2026-11-01');
      expect(calendarDateIn('Asia/Tokyo', MORNING_IN_TOKYO)).toBe('2026-11-01');
    }
  );

  it('the default "now" is the clock, so a fixed system time is honoured', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EVENING_IN_MEXICO_CITY);
    expect(calendarDateIn('America/Mexico_City')).toBe('2026-10-31');
  });

  it('a zone the runtime does not list is refused, not read as another clock', () => {
    expect(() => calendarDateIn('America/Mexico City', EVENING_IN_MEXICO_CITY)).toThrow(ValidationError);
    expect(() => assertTimeZone('Mars/Olympus_Mons')).toThrow(/not a time zone/);
    expect(() => assertTimeZone('')).toThrow(ValidationError);
    expect(() => assertTimeZone('America/Hermosillo')).not.toThrow();
  });

  it('the catalog default and every option are zones the runtime knows', () => {
    const spec = getPolicySpec('zona_horaria');
    expect(spec?.defaultValue).toBe('America/Mexico_City');
    for (const zone of [spec!.defaultValue, ...spec!.options.map((o) => o.value)]) {
      expect(() => assertTimeZone(zone)).not.toThrow();
    }
  });
});

describe('todayFor: the one resolver reads zona_horaria', () => {
  function policyRow(value: string) {
    return {
      rows: [{
        key: 'zona_horaria', status: 'resolved', resolved_value: value,
        question: '', impact: '', options: [], default_rationale: null,
        resolution_notes: null, entity_id: 'e1', jurisdiction: null,
      }],
      rowCount: 1,
    };
  }

  it('with no answer in the panel it is Mexico City\'s day', async () => {
    process.env.TZ = 'UTC';
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EVENING_IN_MEXICO_CITY);
    await expect(todayFor({ tenantId: 't1', entityId: 'e1' })).resolves.toBe('2026-10-31');
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM policy_decisions/);
    expect(params).toEqual(['t1', 'zona_horaria', 'e1', null]);
  });

  it('the answer on the row wins: an entity in Tokyo is already on the 1st', async () => {
    mockQuery.mockResolvedValue(policyRow('Asia/Tokyo'));
    await expect(
      todayFor({ tenantId: 't1', entityId: 'e1' }, { now: MORNING_IN_TOKYO })
    ).resolves.toBe('2026-11-01');
  });

  it('it reads inside the caller\'s transaction when given its client', async () => {
    const client = { query: vi.fn().mockResolvedValue(policyRow('America/Mexico_City')) };
    await expect(
      todayFor({ tenantId: 't1', entityId: 'e1' }, { client: client as never, now: EVENING_IN_MEXICO_CITY })
    ).resolves.toBe('2026-10-31');
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('a zone already stored misspelt is refused on read', async () => {
    mockQuery.mockResolvedValue(policyRow('Mexico/CDMX'));
    await expect(
      todayFor({ tenantId: 't1', entityId: 'e1' }, { now: EVENING_IN_MEXICO_CITY })
    ).rejects.toThrow(/not a time zone/);
  });

  it('dayOrToday: a named day wins without asking the resolver; otherwise the entity day (MNE-001-379)', async () => {
    process.env.TZ = 'UTC';
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EVENING_IN_MEXICO_CITY);
    const ctx = { tenantId: 't1', entityId: 'e1' };
    await expect(dayOrToday(ctx, '2025-12-31')).resolves.toBe('2025-12-31');
    expect(mockQuery).not.toHaveBeenCalled();
    await expect(dayOrToday(ctx)).resolves.toBe('2026-10-31');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('with no entity in hand it answers with the panel\'s declared default', async () => {
    await expect(todayFor(null, { now: EVENING_IN_MEXICO_CITY })).resolves.toBe('2026-10-31');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('the readers that hold only an entity or a customer (MNE-001-111)', () => {
  const noAnswer = { rows: [], rowCount: 0 };
  const mockTenant = currentTenant as unknown as Mock;

  beforeEach(() => {
    mockTenant.mockReset();
  });

  it("todayForEntity asks the panel with the request's tenant when there is one", async () => {
    mockTenant.mockReturnValue('t-ctx');
    mockQuery.mockResolvedValueOnce(noAnswer);
    await expect(todayForEntity('e1', { now: EVENING_IN_MEXICO_CITY })).resolves.toBe('2026-10-31');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect((mockQuery.mock.calls[0] as [string, unknown[]])[1]).toEqual(['t-ctx', 'zona_horaria', 'e1', null]);
  });

  it('todayForEntity finds the tenant from the entity when the request has none', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ tenant_id: 't-row' }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          key: 'zona_horaria', status: 'resolved', resolved_value: 'Asia/Tokyo',
          question: '', impact: '', options: [], default_rationale: null,
          resolution_notes: null, entity_id: 'e1', jurisdiction: null,
        }],
        rowCount: 1,
      });
    await expect(todayForEntity('e1', { now: MORNING_IN_TOKYO })).resolves.toBe('2026-11-01');
    expect((mockQuery.mock.calls[0] as [string, unknown[]])[0]).toMatch(/FROM legal_entities WHERE id = \$1/);
    expect((mockQuery.mock.calls[1] as [string, unknown[]])[1]).toEqual(['t-row', 'zona_horaria', 'e1', null]);
  });

  it('an entity nobody has gets the panel default, never the UTC day', async () => {
    mockQuery.mockResolvedValueOnce(noAnswer);
    await expect(todayForEntity('ghost', { now: EVENING_IN_MEXICO_CITY })).resolves.toBe('2026-10-31');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it("todayForCustomer reads the zone of the customer's entity", async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ entity_id: 'e1', tenant_id: 't1' }], rowCount: 1 })
      .mockResolvedValueOnce(noAnswer);
    await expect(todayForCustomer('c1', { now: EVENING_IN_MEXICO_CITY })).resolves.toBe('2026-10-31');
    expect((mockQuery.mock.calls[0] as [string, unknown[]])[1]).toEqual(['c1']);
    expect((mockQuery.mock.calls[1] as [string, unknown[]])[1]).toEqual(['t1', 'zona_horaria', 'e1', null]);
  });

  it('a customer nobody has gets the panel default too', async () => {
    mockQuery.mockResolvedValueOnce(noAnswer);
    await expect(todayForCustomer('ghost', { now: EVENING_IN_MEXICO_CITY })).resolves.toBe('2026-10-31');
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('the panel refuses an unknown zone at the keyboard', () => {
  it('resolvePolicy does not file a misspelt zone as the firm\'s answer', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(
      resolvePolicy({ tenantId: 't1', entityId: 'e1' }, 'zona_horaria', 'America/Mexico City', 'u@test')
    ).rejects.toThrow(/not a time zone/);
    expect(mockQuery).not.toHaveBeenCalled();
    await expect(
      resolvePolicy({ tenantId: 't1', entityId: 'e1' }, 'zona_horaria', 'America/Tijuana', 'u@test')
    ).resolves.toEqual([]);
  });
});

describe('the "today" fallback of getTaxParameters goes through the resolver', () => {
  it('with no act date, the evening of Oct 31 in Mexico City asks for the 31st', async () => {
    process.env.TZ = 'UTC';
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(EVENING_IN_MEXICO_CITY);
    mockQuery.mockResolvedValue({ rows: [{ params: { uma_daily: 117.31 } }], rowCount: 1 });
    await getTaxParameters('MX-TZ-TEST', 2026);
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['MX-TZ-TEST', '2026-10-31']);
  });
});
