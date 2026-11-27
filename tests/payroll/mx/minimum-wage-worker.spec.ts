import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import Decimal from 'decimal.js';

// ============================================================
// THE WORKER WHO EARNS THE MINIMUM WAGE OF THEIR AREA (MNE-001-923, #1076)
//
// One test of who earns it, read by the overtime exemption (LISR art. 93
// fr. I), by the ISR withholding (art. 96, first paragraph: «No se efectuará
// retención a las personas que en el mes únicamente perciban un salario mínimo
// general correspondiente al área geográfica del contribuyente») and, next, by
// the worker's IMSS quota (LSS art. 36, MNE-001-924).
//
// 2026: 315.04 a day in the general zone, 440.87 at the border.
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));

import {
  MINIMUM_WAGE_ISR_POLICY,
  baseForTariff,
  earnsTheMinimumWage,
  minimumWageIsr,
  minimumWageIsrDetail,
  minimumWageIsrNote,
  minimumWageOfPeriod,
  type MinimumWageContext,
} from '../../../src/services/payroll/mx/minimum-wage-worker.js';
import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';

const mockQuery = query as unknown as Mock;
const mockPolicy = getPolicy as unknown as Mock;

const PARAMS = { salario_minimo_general_diario: 315.04, salario_minimo_frontera_diario: '440.87' };
type ZoneRow = { entity_zone: string; entity_declared: boolean; employee_zone: string | null };
const GENERAL: ZoneRow = { entity_zone: 'general', entity_declared: false, employee_zone: null };

/** The database as the module reads it: the zone row and the year's parameters. */
function database(zone: ZoneRow = GENERAL, params: Record<string, unknown> = PARAMS): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/FROM legal_entities/.test(sql)) return { rows: [zone] };
    if (/FROM tax_parameters/.test(sql)) return { rows: [{ params }] };
    throw new Error(`unexpected query: ${sql.slice(0, 60)}`);
  });
}
const zoneReads = (): number => mockQuery.mock.calls.filter(([s]) => /FROM legal_entities/.test(String(s))).length;

/** A worker paid `daily` a day by contract, in a fortnight of 15 days paid on 15 November 2026. */
const worker = (daily: string | null, over: Partial<MinimumWageContext> = {}): MinimumWageContext => ({
  tenantId: 't-1', entityId: 'n-1', employeeId: 'e-1', payDate: '2026-11-15', periodDays: 15,
  annualSalary: daily === null ? null : new Decimal(daily).times(365).toFixed(2), ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  database();
});

describe('earnsTheMinimumWage: the one test of who earns the minimum of their zone', () => {
  it('at the general minimum, zone never declared: yes, with the minimum it was measured against', async () => {
    expect(await earnsTheMinimumWage(worker('315.04'), PARAMS)).toEqual({ zone: 'general', declaredBy: null, daily: '315.04' });
    const [sql, values] = mockQuery.mock.calls[0] as [string, unknown[]];
    // The zone is read inside the tenant and the entity.
    expect(sql).toMatch(/le\.id = \$1 AND le\.tenant_id = \$2/);
    expect(values).toEqual(['n-1', 't-1', 'e-1']);
  });

  it('below the minimum counts as the minimum; one cent above it does not', async () => {
    expect(await earnsTheMinimumWage(worker('300.00'), PARAMS)).toMatchObject({ daily: '315.04' });
    expect(await earnsTheMinimumWage(worker('315.05'), PARAMS)).toBeNull();
  });

  it('the border minimum is earned in the border zone, of the employee or of the entity, and not in the general one', async () => {
    database({ entity_zone: 'general', entity_declared: true, employee_zone: 'northern_border' });
    expect(await earnsTheMinimumWage(worker('440.87'), PARAMS)).toEqual({ zone: 'northern_border', declaredBy: 'employee', daily: '440.87' });
    database({ entity_zone: 'northern_border', entity_declared: true, employee_zone: null });
    expect(await earnsTheMinimumWage(worker('440.87'), PARAMS)).toMatchObject({ zone: 'northern_border', declaredBy: 'entity' });
    database();
    expect(await earnsTheMinimumWage(worker('440.87'), PARAMS)).toBeNull();
  });

  it('each unknown answers no: no annual salary, or a zone whose minimum is not loaded', async () => {
    expect(await earnsTheMinimumWage(worker(null), PARAMS)).toBeNull();
    database({ entity_zone: 'northern_border', entity_declared: true, employee_zone: null });
    expect(await earnsTheMinimumWage(worker('315.04'), { salario_minimo_general_diario: 315.04 })).toBeNull();
  });

  it('cost: above every minimum, or with no salary, the zone is not read; two readers of one paycheck read it once', async () => {
    await earnsTheMinimumWage(worker('500.00'), PARAMS);
    await earnsTheMinimumWage(worker(null), PARAMS);
    expect(zoneReads()).toBe(0);
    const paycheck = worker('315.04');
    await Promise.all([earnsTheMinimumWage(paycheck, PARAMS), earnsTheMinimumWage(paycheck, PARAMS)]);
    expect(zoneReads()).toBe(1);
  });
});

describe('minimumWageOfPeriod: the daily minimum times the days the period pays', () => {
  const of = (frequency: 'weekly' | 'quincenal' | 'monthly', calendarDays: number, daily = '315.04') => {
    const { days, amount } = minimumWageOfPeriod(daily, frequency, calendarDays);
    return `${days.toString()} × = ${amount.toFixed(2)}`;
  };

  it('a fortnight of 15 days: 15 × 315.04 = 4 725.60; at the border, 6 613.05', () => {
    expect(of('quincenal', 15)).toBe('15 × = 4725.60');
    expect(of('quincenal', 15, '440.87')).toBe('15 × = 6613.05');
  });

  it('16 to 28 February has 13 days and is measured by the 15 of its tariff; 16 to 31, by its 16 days', () => {
    expect(of('quincenal', 13)).toBe('15 × = 4725.60');
    expect(of('quincenal', 16)).toBe('16 × = 5040.64');
  });

  it('a week counts its seventh day: 7 × 315.04 = 2 205.28', () => {
    expect(of('weekly', 7)).toBe('7 × = 2205.28');
  });

  it('a month is the 30.4 days of its tariff, to the cent down (9 577.216), or its 31 calendar days', () => {
    expect(of('monthly', 28)).toBe('30.4 × = 9577.21');
    expect(of('monthly', 31)).toBe('31 × = 9766.24');
  });

  it('a period with no tariff is refused, as the subsidy refuses it', () => {
    expect(() => minimumWageOfPeriod('315.04', 'biweekly', 14)).toThrow(
      expect.objectContaining({ code: 'EMPLOYMENT_SUBSIDY_PERIOD_UNSUPPORTED' })
    );
  });
});

describe('minimumWageIsr: LISR art. 96, first paragraph, for one paycheck', () => {
  const answer = (value: string): void => {
    mockPolicy.mockResolvedValue({ key: MINIMUM_WAGE_ISR_POLICY, value, defined: false });
  };
  const read = (daily: string | null, taxable: string, over: Partial<MinimumWageContext> = {}) =>
    minimumWageIsr({ who: worker(daily, over), frequency: 'quincenal', taxableOfPeriod: new Decimal(taxable) });

  it('ACCEPTANCE: 4 725.60 is within the minimum of the period: not withheld, and the panel key is not read', async () => {
    const m = await read('315.04', '4725.60');
    expect(m).toMatchObject({ treatment: 'not_withheld', policy: null });
    expect(m?.minimum.toFixed(2)).toBe('4725.60');
    expect(mockPolicy).not.toHaveBeenCalled();
  });

  it('ACCEPTANCE: 4 725.61 is over it, and the default answer applies the tariff to the whole base', async () => {
    answer('only_minimum_wage_paid');
    expect(await read('315.04', '4725.61')).toMatchObject({ treatment: 'tariff_on_whole_base', policy: 'only_minimum_wage_paid' });
    expect(mockPolicy).toHaveBeenCalledWith({ tenantId: 't-1', entityId: 'n-1' }, MINIMUM_WAGE_ISR_POLICY, undefined);
  });

  it('minimum_wage_part_never_taxed applies it to the excess', async () => {
    answer('minimum_wage_part_never_taxed');
    expect(await read('315.04', '5825.60')).toMatchObject({ treatment: 'tariff_on_excess' });
  });

  it('a value this reader does not know is named, never read as the default', async () => {
    answer('something_else');
    await expect(read('315.04', '5825.60')).rejects.toMatchObject({
      code: 'MINIMUM_WAGE_ISR_EXEMPTION_UNKNOWN',
      messageKey: {
        key: 'error.POLICY_VALUE_UNKNOWN.payroll_reader',
        params: { policy: MINIMUM_WAGE_ISR_POLICY, value: 'something_else', known: 'only_minimum_wage_paid, minimum_wage_part_never_taxed' },
      },
    });
  });

  it('whoever does not earn the minimum, or has no salary loaded or no taxed base, gets null and costs no statement', async () => {
    // 315.05 is over the general minimum (the zone is read to know it is not a border worker); 500.00 is over both.
    expect(await read('315.05', '4725.60')).toBeNull();
    expect(zoneReads()).toBe(1);
    expect(await read('500.00', '4725.60')).toBeNull();
    expect(zoneReads()).toBe(1);
    mockQuery.mockClear();
    expect(await read(null, '4725.60')).toBeNull();
    expect(await read('315.04', '0')).toBeNull();
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('what the paycheck does with the answer', () => {
  const measure = {
    earned: { zone: 'general' as const, declaredBy: null, daily: '315.04' },
    days: new Decimal(15), minimum: new Decimal('4725.60'),
  };
  const excess = { ...measure, treatment: 'tariff_on_excess' as const, policy: 'minimum_wage_part_never_taxed' as const, taxableOfPeriod: new Decimal('5825.60') };
  const spared = { ...measure, treatment: 'not_withheld' as const, policy: null, taxableOfPeriod: new Decimal('4725.60') };

  it('baseForTariff: only tariff_on_excess takes the minimum out, and once in the period', () => {
    expect(baseForTariff(null, '5825.60')).toBe(5825.6);
    expect(baseForTariff({ ...excess, treatment: 'tariff_on_whole_base', policy: 'only_minimum_wage_paid' }, '5825.60')).toBe(5825.6);
    expect(baseForTariff(excess, '5825.60')).toBe(1100);
    // A bonus of 1 100.00 paid apart, after a fortnight that already counted 4 725.60: none of the minimum is left.
    expect(baseForTariff(excess, '1100', '4725.60')).toBe(1100);
    // The other order: the bonus first counted 1 100.00, so the fortnight takes out the 3 625.60 that are left.
    expect(baseForTariff(excess, '4725.60', '1100')).toBe(1100);
    expect(baseForTariff(excess, '3000', '0')).toBe(0);
  });

  it('the record and the note name the article, the measure and the tariff figure not withheld', () => {
    expect(minimumWageIsrDetail(spared, 337.05)).toEqual({
      treatment: 'not_withheld', policy: null, zone: 'general', zone_declared_by: null, daily_minimum: '315.04',
      days: 15, minimum_of_period: '4725.60', taxable_of_period: '4725.60', tariff_isr_not_withheld: '337.05',
    });
    expect(minimumWageIsrNote(spared, 337.05)).toBe(
      'not withheld, LISR art. 96, first paragraph: the worker earns only the minimum wage of the area · ' +
        'ISR base of the period 4725.60, minimum wage of the period 4725.60 (15 days at 315.04, zone general) · the tariff gives 337.05'
    );
    expect(minimumWageIsrDetail(excess, 51.68)).not.toHaveProperty('tariff_isr_not_withheld');
    expect(minimumWageIsrNote(excess, 51.68)).toContain('the tariff applies to the excess');
    expect(minimumWageIsrNote(excess, 51.68)).toContain('[minimum_wage_part_never_taxed]');
  });
});
