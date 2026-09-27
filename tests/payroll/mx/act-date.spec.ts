import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { query } from '../../../src/database/connection.js';
import { contributionMonths } from '../../../src/services/payroll/tax-engine/tax-tables.js';
import {
  MexicoImssEmployeeCalculator,
  MexicoImssEmployerCalculator,
} from '../../../src/services/payroll/mx/imss-calculator.js';
import { MexicoInfonavitEmployerCalculator } from '../../../src/services/payroll/mx/infonavit-calculator.js';
import { MexicoIsrCalculator, MexicoSubsidioEmpleoCalculator } from '../../../src/services/payroll/mx/isr-calculator.js';
import { computeNextPeriod } from '../../../src/services/payroll/common/pay-period-service.js';

/**
 * THE DATE OF THE ACT IN PAYROLL IS FIXED BY LAW (#242, MNE-001-067).
 *
 * ISR and subsidy go by the PAYMENT date; IMSS and INFONAVIT by the
 * contribution days of each month. Every figure below is synthetic: two UMAs a
 * month apart and two tariffs a year apart, chosen so that the wrong date gives
 * a different number.
 */

const UMA_JAN = 113.14;
const UMA_FEB = 117.31;
const RATE = 0.01;

function params(uma: number): Record<string, unknown> {
  return {
    uma_daily: uma,
    salario_minimo_general_diario: 315.04,
    infonavit_employer_rate: 0.05,
    imss_employee: {
      enfermedades_maternidad: RATE, prestaciones_dinero: RATE, gastos_medicos_pensionados: RATE,
      invalidez_vida: RATE, cesantia_vejez: RATE,
    },
    // Every employer rate, since a missing one throws (#296); zero is a value.
    imss_employer: {
      enfermedades_maternidad_fija: 0, enfermedades_maternidad_excedente: 0,
      prestaciones_dinero: RATE, gastos_medicos_pensionados: 0, invalidez_vida: 0,
      guarderias: 0, riesgo_trabajo_clase_1: 0, riesgo_trabajo_clase_2: 0,
      riesgo_trabajo_clase_3: 0, riesgo_trabajo_clase_4: 0, riesgo_trabajo_clase_5: 0,
      cesantia_vejez: 0, retiro: 0,
    },
  };
}

// A tariff per YEAR: 2025 withholds 10 %, 2026 withholds 20 %; the subsidy
// pays 100 in 2025 and 200 in 2026.
function bracketRow(taxType: string, year: number) {
  const isr = taxType === 'isr';
  return {
    bracket_order: 1, bracket_low: '0.01', bracket_high: null,
    rate: isr ? (year === 2026 ? '0.20' : '0.10') : '0',
    base_tax: isr ? '0' : year === 2026 ? '200' : '100',
    data: {},
  };
}

beforeAll(() => {
  // A clock in September: the old default ("today") would read February's UMA
  // for the whole week, whatever the week.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  vi.mocked(query).mockImplementation(((sql: string, args: unknown[]) => {
    if (sql.includes('FROM tax_parameters')) {
      const day = String(args[1]);
      return Promise.resolve({ rows: [{ params: params(day >= '2026-02-01' ? UMA_FEB : UMA_JAN) }] });
    }
    if (sql.includes('FROM tax_tables')) {
      return Promise.resolve({ rows: [bracketRow(String(args[1]), Number(args[2]))] });
    }
    throw new Error(`unexpected query: ${sql}`);
  }) as unknown as typeof query);
});

afterAll(() => {
  vi.useRealTimers();
});

// A week that straddles the UMA change: 3 days of January, 4 of February.
const straddling = {
  taxable_wages: 30000,
  pay_frequency: 'weekly' as const,
  tax_year: 2026,
  sbc_daily: 5000, // above 25 UMA in both months, so the cap shows the UMA used
  days_in_period: 7,
  period_start: '2026-01-29',
  period_end: '2026-02-04',
  pay_date: '2026-02-06',
};
const CAPPED_DAYS = 25 * UMA_JAN * 3 + 25 * UMA_FEB * 4;

describe('contributionMonths — the contribution days of each month', () => {
  it('splits a period that straddles two months, and two years', () => {
    expect(contributionMonths({ tax_year: 2026, period_start: '2025-12-16', period_end: '2026-01-15' }, 15)).toEqual([
      { tax_year: 2025, date: '2025-12-16', days: 16 },
      { tax_year: 2026, date: '2026-01-01', days: 15 },
    ]);
  });

  it('without the range, keeps the single undated stretch callers had before', () => {
    expect(contributionMonths({ tax_year: 2026, days_in_period: 7 }, 15)).toEqual([{ tax_year: 2026, days: 7 }]);
  });
});

describe('IMSS and INFONAVIT go by the contribution days of each month', () => {
  it('the employee quota caps January days at January UMA and February days at February UMA', async () => {
    const out = await new MexicoImssEmployeeCalculator().calculate(straddling);
    // Before: one lookup for "today" and 7 days at February's UMA (20 529.25).
    expect(out.taxable_wages_used).toBeCloseTo(CAPPED_DAYS, 6);
    expect(out.breakdown?.invalidez_vida).toBeCloseTo(CAPPED_DAYS * RATE, 6);
  });

  it('the employer quota too', async () => {
    const out = await new MexicoImssEmployerCalculator().calculate(straddling);
    expect(out.taxable_wages_used).toBeCloseTo(CAPPED_DAYS, 6);
    expect(out.breakdown?.prestaciones_dinero).toBeCloseTo(CAPPED_DAYS * RATE, 6);
  });

  it('and the INFONAVIT employer contribution', async () => {
    const out = await new MexicoInfonavitEmployerCalculator().calculate(straddling);
    expect(out.taxable_wages_used).toBeCloseTo(CAPPED_DAYS, 6);
    expect(out.tax_amount).toBeCloseTo(CAPPED_DAYS * 0.05, 2);
  });
});

describe('ISR and subsidy go by the payment date', () => {
  // Labelled 2025 by its end, paid on January 5th, 2026.
  const paidInJanuary = {
    taxable_wages: 10000,
    pay_frequency: 'monthly' as const,
    tax_year: 2025,
    pay_date: '2026-01-05',
  };

  it('ISR withholds with the tariff of the payment year', async () => {
    const out = await new MexicoIsrCalculator().calculate(paidInJanuary);
    expect(out.rate_applied).toBe(0.2);
    expect(out.tax_amount).toBeCloseTo((10000 - 0.01) * 0.2, 2);
  });

  it('the subsidy with the table of the payment year', async () => {
    const out = await new MexicoSubsidioEmpleoCalculator().calculate(paidInJanuary);
    expect(out.tax_amount).toBe(200);
  });

  it('and a generated period paid in the new year is labelled with the new year', () => {
    const p = computeNextPeriod('monthly', new Date(Date.UTC(2025, 10, 30)), 5);
    expect(p).toMatchObject({ period_end: '2025-12-31', pay_date: '2026-01-05', tax_year: 2026 });
  });
});
