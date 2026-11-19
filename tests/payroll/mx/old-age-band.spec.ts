import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));
// Only the row lookup is replaced; `contributionMonths` and `requiredParameter` stay real.
const row = vi.hoisted(() => ({ at: (_day: string): Record<string, unknown> => ({}) }));
vi.mock('../../../src/services/payroll/tax-engine/tax-tables.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/payroll/tax-engine/tax-tables.js')>()),
  getTaxParameters: vi.fn(async (_j: string, _y: number, day: string) => row.at(day)),
}));

import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import {
  MexicoImssEmployeeCalculator,
  MexicoImssEmployerCalculator,
} from '../../../src/services/payroll/mx/imss-calculator.js';
import {
  placeOldAgeBand,
  readOldAgeBandEdge,
  readOldAgeMinimumWageArea,
  type OldAgeBandEdge,
  type OldAgeMinimumWageArea,
} from '../../../src/services/payroll/mx/old-age-band.js';

/**
 * EACH CONTRIBUTION DAY PAYS THE EMPLOYER OLD-AGE RATE OF ITS SBC BAND (#661, MNE-001-513).
 *
 * LSS art. 168 fr. II a): the quota is a table by SBC band, phased in by year
 * until 2030 (migration 330). Every amount below was computed by hand from the
 * 2026 and 2027 columns of that table, typed here in percent as the law prints
 * them, with the UMA (113.14 in January 2026, 117.31 from February) and the
 * general minimum wage (315.04) the migrations load. The 2027 minimum wage is
 * synthetic: CONASAMI has not published it.
 */
const BANDS = ['sm_1_00', 'uma_1_50', 'uma_2_00', 'uma_2_50', 'uma_3_00', 'uma_3_50', 'uma_4_00', 'uma_above_4_00'];
const PRINTED: Record<number, string[]> = {
  2026: ['3.150', '3.676', '4.851', '5.556', '6.026', '6.361', '6.613', '7.513'],
  2027: ['3.150', '3.807', '5.276', '6.157', '6.745', '7.164', '7.479', '8.603'],
};

// Every other employer rate is zero, so the total is the old-age line.
const EMPLOYER = {
  enfermedades_maternidad_fija: 0, enfermedades_maternidad_excedente: 0, prestaciones_dinero: 0,
  gastos_medicos_pensionados: 0, invalidez_vida: 0, guarderias: 0, riesgo_trabajo_clase_1: 0,
  riesgo_trabajo_clase_2: 0, riesgo_trabajo_clase_3: 0, riesgo_trabajo_clase_4: 0,
  riesgo_trabajo_clase_5: 0, retiro: 0,
};
const lawful = (day: string): Record<string, unknown> => ({
  uma_daily: day < '2026-02-01' ? 113.14 : 117.31,
  salario_minimo_general_diario: day < '2027-01-01' ? 315.04 : 340,
  salario_minimo_frontera_diario: 440.87,
  imss_employer: EMPLOYER,
});

/** The area of an entity that never declared its zone: the general minimum, said so (MNE-001-376). */
const UNDECLARED: OldAgeMinimumWageArea = { zone: 'general', rule: 'employer_registration_area', declared: false };
const BORDER: OldAgeMinimumWageArea = { zone: 'northern_border', rule: 'employer_registration_area', declared: true };
const GENERAL_ZONE: OldAgeMinimumWageArea = { zone: 'general', rule: 'general_zone', declared: true };

const quota = (
  sbc: number,
  start: string,
  end: string,
  edge: OldAgeBandEdge | null = 'above_upper_edge',
  area: OldAgeMinimumWageArea | null = UNDECLARED
) =>
  new MexicoImssEmployerCalculator().calculate({
    pay_frequency: 'quincenal', tax_year: Number(end.slice(0, 4)), taxable_wages: 0,
    sbc_daily: sbc, period_start: start, period_end: end, imss_old_age_band_edge: edge ?? undefined,
    imss_minimum_wage_area: area ?? undefined,
  });
const oldAge = async (...args: Parameters<typeof quota>): Promise<number | undefined> =>
  (await quota(...args)).breakdown?.cesantia_vejez;
const MARCH = ['2026-03-01', '2026-03-15'] as const;

beforeEach(() => {
  row.at = lawful;
  vi.mocked(query).mockImplementation((async (sql: string, args: unknown[]) => {
    if (!sql.includes('FROM legal_parameters')) throw new Error(`unexpected query: ${sql}`);
    if (sql.includes('MIN(effective_from)')) return { rows: [{ effectiveFrom: '2023-01-01' }] };
    const [, key, day] = args as [string, string, string];
    const year = Number(day.slice(0, 4));
    const band = BANDS.indexOf(key.replace('imss.old_age.employer_rate.', ''));
    if (year < 2023 || band < 0) return { rows: [] };
    const value = (Number(PRINTED[year][band]) / 100).toFixed(5);
    return { rows: [{ key, value, unit: 'rate', effectiveFrom: `${year}-01-01`, sourceUrl: 'dof' }] };
  }) as unknown as typeof query);
});

describe('the band of the day, with the UMA and the table in force that day', () => {
  it('T1 · March 2026: SBC 400.00 is 3.41 UMA and pays 6.361 %; 1,000.00 pays the top band', async () => {
    expect(await oldAge(400, ...MARCH)).toBe(381.66); // not the flat 189.00
    expect(await oldAge(1000, ...MARCH)).toBe(1126.95); // not 472.50
    expect((await quota(400, ...MARCH)).tax_amount).toBe(381.66);
  });

  it('T2 · January 2026: the same SBC is 3.54 of the January UMA and pays 6.613 %', async () => {
    expect(await oldAge(400, '2026-01-01', '2026-01-15')).toBe(396.78);
  });

  it('T3 · January 2027 pays the 2027 column, and a week across the year pays each day its own', async () => {
    expect(await oldAge(400, '2027-01-01', '2027-01-15')).toBe(429.84);
    expect(await oldAge(1000, '2027-01-01', '2027-01-15')).toBe(1290.45);
    // Three days at 6.361 % (76.332) and four at 7.164 % (114.624).
    expect(await oldAge(400, '2026-12-29', '2027-01-04')).toBeCloseTo(76.332 + 114.624, 9);
  });

  it('T4 · one minimum wage pays 3.150 %, its integrated SBC pays its UMA band, and the cap pays the top one', async () => {
    expect(await oldAge(315.04, ...MARCH)).toBeCloseTo(148.8564, 9);
    expect(await oldAge(330.58, ...MARCH)).toBeCloseTo(298.811262, 9); // not 156.20
    const capped = await quota(5000, ...MARCH);
    expect(capped.taxable_wages_used).toBeCloseTo(2932.75 * 15, 6);
    expect(capped.tax_amount).toBe(3305.06);
  });
});

describe('the edge of a band is the policy imss_old_age_band_edge', () => {
  it('T5 · exactly 3.00 UMA stays in its band; one cent of UMA above pays the next one by default', async () => {
    expect((await quota(351.93, ...MARCH)).tax_amount).toBe(318.11);
    expect((await quota(352, ...MARCH)).tax_amount).toBe(335.86);
    expect((await quota(352, ...MARCH, 'truncated_to_hundredths')).tax_amount).toBe(318.17);
    expect((await quota(316, ...MARCH)).tax_amount).toBe(285.63);
    expect((await quota(316, ...MARCH, 'truncated_to_hundredths')).tax_amount).toBe(149.31);
  });

  it('T6 · every band is reached, the three that are empty in 2026 included', async () => {
    // Synthetic: with a wage of 1.20 UMA the bands below 2.50 UMA are not empty.
    row.at = () => ({ uma_daily: 100, salario_minimo_general_diario: 120, imss_employer: EMPLOYER });
    const sbcs = [120, 150, 151, 250, 300, 300.01, 400, 400.01];
    const bands = sbcs.map((sbc) => placeOldAgeBand({ sbc, uma: 100, minimumWage: 120, edge: 'above_upper_edge' }));
    expect(bands.map((b) => b.suffix)).toEqual(
      ['sm_1_00', 'uma_1_50', 'uma_2_00', 'uma_2_50', 'uma_3_00', 'uma_3_50', 'uma_4_00', 'uma_above_4_00']
    );
    for (const [i, sbc] of sbcs.entries()) {
      const expected = (sbc * 15 * Number(PRINTED[2026][i])) / 100;
      expect(await oldAge(sbc, ...MARCH), `SBC ${sbc}`).toBeCloseTo(expected, 6);
    }
    // Truncation reads «3.01» literally: 300.99 is still 3.00 UMA, 301.00 is not.
    const cut = (sbc: number) =>
      placeOldAgeBand({ sbc, uma: 100, minimumWage: 120, edge: 'truncated_to_hundredths' }).suffix;
    expect([cut(120.99), cut(121.2), cut(300.99), cut(301)]).toEqual(['sm_1_00', 'uma_1_50', 'uma_3_00', 'uma_3_50']);
  });
});

describe('what is missing is named, never 3.150 %, zero or 315.04', () => {
  it('T7 · a day before the table, no minimum wage, no dates, no edge rule', async () => {
    row.at = () => lawful('2026-03-01');
    await expect(quota(400, '2022-12-17', '2022-12-31')).rejects.toMatchObject({
      gap: 'not_yet_in_force', key: 'imss.old_age.employer_rate.uma_3_50', onDate: '2022-12-17',
    });
    row.at = () => ({ uma_daily: 117.31, imss_employer: EMPLOYER });
    await expect(quota(400, ...MARCH)).rejects.toThrow(/salario_minimo_general_diario/);
    row.at = lawful;
    await expect(
      new MexicoImssEmployerCalculator().calculate({
        pay_frequency: 'quincenal', tax_year: 2026, taxable_wages: 0, sbc_daily: 400, days_in_period: 15,
        imss_old_age_band_edge: 'above_upper_edge', imss_minimum_wage_area: UNDECLARED,
      })
    ).rejects.toThrow(/period_start/);
    await expect(quota(400, ...MARCH, null)).rejects.toThrow(/imss_old_age_band_edge/);
  });

  it('T8 · the flat rate of 009 decides nothing, and the employee quota is what it was', async () => {
    row.at = (day) => ({ ...lawful(day), imss_employer: { ...EMPLOYER, cesantia_vejez: 0.99 } });
    expect(await oldAge(400, ...MARCH)).toBe(381.66);
    row.at = (day) => ({
      ...lawful(day),
      imss_employee: {
        enfermedades_maternidad: 0, prestaciones_dinero: 0, gastos_medicos_pensionados: 0,
        invalidez_vida: 0, cesantia_vejez: 0.01125,
      },
    });
    expect(await oldAge(400, ...MARCH)).toBe(381.66);
    const employee = await new MexicoImssEmployeeCalculator().calculate({
      pay_frequency: 'quincenal', tax_year: 2026, taxable_wages: 0, sbc_daily: 400,
      period_start: MARCH[0], period_end: MARCH[1],
    });
    expect(employee.tax_amount).toBe(67.5);
  });
});

describe('the notes say how the rate was reached', () => {
  it('T9 · band, rate, UMA, minimum wage with its area, edge rule and days of each stretch', async () => {
    const { notes } = await quota(400, '2026-12-29', '2027-01-04');
    expect(notes).toMatch(/^Work risk class 01; /);
    expect(notes).toContain(
      'from 2026-12-29, 3 days: band «3.01 a 3.50 UMA» at 6.361 %, UMA 117.31, ' +
        'minimum wage 315.04 (general: the entity has not declared its zone), edge rule above_upper_edge'
    );
    expect(notes).toContain('from 2027-01-01, 4 days: band «3.01 a 3.50 UMA» at 7.164 %, UMA 117.31, minimum wage 340.00');
  });
});

describe('readOldAgeBandEdge', () => {
  const answer = (value: string): void => {
    vi.mocked(getPolicy).mockResolvedValue({ key: 'imss_old_age_band_edge', value } as never);
  };

  it('T10 · returns the entity value, and refuses one it does not know', async () => {
    answer('truncated_to_hundredths');
    expect(await readOldAgeBandEdge({ tenantId: 't', entityId: 'e' })).toBe('truncated_to_hundredths');
    expect(getPolicy).toHaveBeenCalledWith({ tenantId: 't', entityId: 'e' }, 'imss_old_age_band_edge', undefined);
    answer('rounded_half_up');
    await expect(readOldAgeBandEdge({ tenantId: 't' })).rejects.toMatchObject({
      code: 'IMSS_OLD_AGE_BAND_EDGE_UNKNOWN',
    });
  });

  it('T10 · the catalog default is the reading that never computes less', async () => {
    const { getPolicySpec } = await import('../../../src/services/policy/pending-catalog.js');
    const spec = getPolicySpec('imss_old_age_band_edge');
    expect(spec?.defaultValue).toBe('above_upper_edge');
    expect(spec?.options.map((o) => o.value)).toEqual(['above_upper_edge', 'truncated_to_hundredths']);
  });
});

// ============================================================
// MNE-001-578 (#196): the «1.00 SM» band is measured with the general minimum
// of the area of the employer registration, the entity's zone (#661, LFT art.
// 92, LSS arts. 28, 39 and 168 fr. II a); the policy can take the centre-zone
// minimum for everyone instead. March 2026, 15 days, 1.00 SM = 315.04 general
// or 440.87 at the border; 3.50 UMA = 410.585, 4.00 UMA = 469.24.
// ============================================================
describe('the minimum wage of the «1.00 SM» band is the area of the employer registration', () => {
  it('T11 · six figures by hand', async () => {
    // The total is the old-age line (every other rate is zero), rounded to the cent.
    const line = async (...args: Parameters<typeof quota>): Promise<number> => (await quota(...args)).tax_amount;
    // 400.00 × 3.150 % × 15
    expect(await line(400, ...MARCH, 'above_upper_edge', BORDER)).toBe(189);
    // 400.00 × 6.361 % × 15, as in #757
    expect(await line(400, ...MARCH, 'above_upper_edge', GENERAL_ZONE)).toBe(381.66);
    // 440.87 × 3.150 % × 15 = 208.311075
    expect(await line(440.87, ...MARCH, 'above_upper_edge', BORDER)).toBe(208.31);
    // 440.87 × 6.613 % × 15 = 437.3209965
    expect(await line(440.87, ...MARCH, 'above_upper_edge', GENERAL_ZONE)).toBe(437.32);
    // 440.88 × 6.613 % × 15 = 437.330916
    expect(await line(440.88, ...MARCH, 'above_upper_edge', BORDER)).toBe(437.33);
    // never declared: the general minimum, and the note says so
    expect(await line(400, ...MARCH, 'above_upper_edge', UNDECLARED)).toBe(381.66);
  });

  it('T12 · the note names the area and who decided it', async () => {
    expect((await quota(400, ...MARCH, 'above_upper_edge', BORDER)).notes).toContain(
      "band «1.00 SM» at 3.150 %, UMA 117.31, minimum wage 440.87 (northern_border, the employer registration's area)"
    );
    expect((await quota(400, ...MARCH, 'above_upper_edge', GENERAL_ZONE)).notes).toContain(
      'minimum wage 315.04 (general zone for every worker, policy general_zone)'
    );
  });

  it('T13 · without the area, or without the border minimum of the day, it stops and names what is missing', async () => {
    await expect(quota(400, ...MARCH, 'above_upper_edge', null)).rejects.toThrow(/imss_old_age_minimum_wage_area/);
    row.at = (day) => ({ ...lawful(day), salario_minimo_frontera_diario: undefined });
    await expect(quota(400, ...MARCH, 'above_upper_edge', BORDER)).rejects.toThrow(/salario_minimo_frontera_diario/);
  });
});

describe('readOldAgeMinimumWageArea', () => {
  const answer = (value: string): void => {
    vi.mocked(getPolicy).mockResolvedValue({ key: 'imss_old_age_minimum_wage_area', value } as never);
  };
  const zoneRow = (r: Record<string, unknown>): void => {
    vi.mocked(query).mockResolvedValue({ rows: [r] } as never);
  };

  it('T14 · employer_registration_area reads the entity\'s zone, declared or not', async () => {
    answer('employer_registration_area');
    zoneRow({ entity_zone: 'northern_border', entity_declared: true, employee_zone: null });
    expect(await readOldAgeMinimumWageArea({ tenantId: 't', entityId: 'e' })).toEqual(BORDER);
    zoneRow({ entity_zone: 'general', entity_declared: false, employee_zone: null });
    expect(await readOldAgeMinimumWageArea({ tenantId: 't', entityId: 'e' })).toEqual(UNDECLARED);
  });

  it('T14 · general_zone takes the centre-zone minimum without reading the entity, and an unknown value is refused', async () => {
    answer('general_zone');
    vi.mocked(query).mockClear();
    expect(await readOldAgeMinimumWageArea({ tenantId: 't', entityId: 'e' })).toEqual(GENERAL_ZONE);
    expect(query).not.toHaveBeenCalled();
    answer('frontera');
    await expect(readOldAgeMinimumWageArea({ tenantId: 't', entityId: 'e' })).rejects.toMatchObject({
      code: 'IMSS_OLD_AGE_MINIMUM_WAGE_AREA_UNKNOWN',
    });
  });

  it('T14 · the catalog default is the area of the employer registration', async () => {
    const { getPolicySpec } = await import('../../../src/services/policy/pending-catalog.js');
    const spec = getPolicySpec('imss_old_age_minimum_wage_area');
    expect(spec?.defaultValue).toBe('employer_registration_area');
    expect(spec?.options.map((o) => o.value)).toEqual(['employer_registration_area', 'general_zone']);
  });
});
