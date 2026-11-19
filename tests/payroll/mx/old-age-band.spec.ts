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
  type OldAgeBandEdge,
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
  imss_employer: EMPLOYER,
});

const quota = (
  sbc: number,
  start: string,
  end: string,
  edge: OldAgeBandEdge | null = 'above_upper_edge'
) =>
  new MexicoImssEmployerCalculator().calculate({
    pay_frequency: 'quincenal', tax_year: Number(end.slice(0, 4)), taxable_wages: 0,
    sbc_daily: sbc, period_start: start, period_end: end, imss_old_age_band_edge: edge ?? undefined,
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
        imss_old_age_band_edge: 'above_upper_edge',
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
        'minimum wage 315.04 (ZSMG until #196), edge rule above_upper_edge'
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
