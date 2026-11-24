import Decimal from 'decimal.js';
import type { ITaxCalculator, TaxInput, TaxOutput } from '../tax-engine/tax-engine.interface.js';
import { legalParameterAt } from '../../jurisdiction/legal-parameters.js';
import {
  OLD_AGE_BAND_EDGE_POLICY,
  OLD_AGE_EMPLOYER_RATE_PREFIX,
  OLD_AGE_MINIMUM_WAGE_AREA_POLICY,
  describeMinimumWageArea,
  placeOldAgeBand,
} from './old-age-band.js';
import { MINIMUM_WAGE_PARAMETER_OF } from './minimum-wage-zone.js';
import { contributionMonths, getTaxParameters, requiredParameter, requiredRates } from '../tax-engine/tax-tables.js';

// ============================================================
// MX — IMSS employer/employee contributions (cuotas obrero-patronales)
// Based on SBC (Salario Base de Cotizacion — contribution base salary) — daily amount.
// Cap (tope): 25 daily UMA. Excedente (excess): quota on the amount > 3 UMA.
// Employee (obrero) pays some ramos; employer (patronal) pays more.
// Reference: Ley del Seguro Social Arts. 25, 71, 106, 107, 146, 147, 168.
//
// The EMPLOYER quota for cesantía en edad avanzada y vejez is not one rate
// (#661): LSS art. 168 fr. II a) sets it by SBC band and year. Each
// contribution day pays the rate of its band, read from `legal_parameters` on
// its date (migration 330); the band is placed by `old-age-band.ts`. The flat
// `imss_employer.cesantia_vejez` of `tax_parameters` is the 2022 rate and has
// no reader. The employee's 1.125 % is one rate and stays in its block.
// ============================================================

interface ImssEmployerRates {
  enfermedades_maternidad_fija: number;
  enfermedades_maternidad_excedente: number;
  prestaciones_dinero: number;
  gastos_medicos_pensionados: number;
  invalidez_vida: number;
  guarderias: number;
  riesgo_trabajo_clase_1: number;
  riesgo_trabajo_clase_2: number;
  riesgo_trabajo_clase_3: number;
  riesgo_trabajo_clase_4: number;
  riesgo_trabajo_clase_5: number;
  retiro: number;
}

function riesgoRate(rates: Record<string, number>, clase: string | undefined): number {
  switch (clase) {
    case '01': return rates.riesgo_trabajo_clase_1;
    case '02': return rates.riesgo_trabajo_clase_2;
    case '03': return rates.riesgo_trabajo_clase_3;
    case '04': return rates.riesgo_trabajo_clase_4;
    case '05': return rates.riesgo_trabajo_clase_5;
    default:   return rates.riesgo_trabajo_clase_1;
  }
}

// ============================================================
// Employee portion (obrero)
// ============================================================

/** Los cinco ramos de la cuota OBRERA que la LSS exige (arts. 25, 106, 107, 147, 168). */
const RAMOS_OBRERO = [
  'enfermedades_maternidad',
  'prestaciones_dinero',
  'gastos_medicos_pensionados',
  'invalidez_vida',
  'cesantia_vejez',
] as const;

export class MexicoImssEmployeeCalculator implements ITaxCalculator {
  jurisdiction = 'MX';
  taxType = 'imss_employee';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { sbc_daily = 0 } = input;
    if (sbc_daily <= 0) {
      return { jurisdiction: 'MX', tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    const breakdown: Record<string, number> = {};
    const add = (k: string, v: number): void => { breakdown[k] = (breakdown[k] ?? 0) + v; };
    let taxableUsed = 0;
    const notes: string[] = [];

    // Each month's days with that month's UMA (#242): see `contributionMonths`.
    for (const { tax_year, date, days } of contributionMonths(input, 15)) {
      const params = await getTaxParameters('MX', tax_year, date);
      const uma = requiredParameter(params, 'uma_daily', 'MX', tax_year);
      const topeSbc = uma * 25;
      const sbcCapped = Math.min(sbc_daily, topeSbc);
      const excedente3uma = Math.max(0, sbcCapped - 3 * uma);

      // LAS CINCO CUOTAS OBRERAS, TODAS OBLIGATORIAS (T20 punto 1 · #127).
      //
      // Cada una llevaba `|| 0`, así que una fila sin sembrar producía una
      // retención de CERO con `days_worked` correctos: un recibo creíble y
      // falso. Ahora falta una y no hay cuota: se nombra cuál.
      const ee = requiredRates(params, 'imss_employee', RAMOS_OBRERO, tax_year);

      // Sickness and maternity (enfermedades y maternidad, employee): quota on the excess over 3 UMA
      add('em_excedente', excedente3uma * ee.enfermedades_maternidad * days);
      // Cash benefits (prestaciones en dinero)
      add('prestaciones_dinero', sbcCapped * ee.prestaciones_dinero * days);
      // Medical expenses for pensioners (gastos medicos pensionados)
      add('gmp', sbcCapped * ee.gastos_medicos_pensionados * days);
      // Disability and life (invalidez y vida)
      add('invalidez_vida', sbcCapped * ee.invalidez_vida * days);
      // Severance and old age (cesantia y vejez)
      add('cesantia_vejez', sbcCapped * ee.cesantia_vejez * days);

      taxableUsed += sbcCapped * days;
      notes.push(`Daily SBC ${sbc_daily.toFixed(2)}, cap ${topeSbc.toFixed(2)}, days ${days}`);
    }

    const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

    return {
      jurisdiction: 'MX',
      tax_type: this.taxType,
      tax_amount: Math.round(total * 100) / 100,
      taxable_wages_used: taxableUsed,
      breakdown,
      notes: notes.join('; '),
    };
  }
}

// ============================================================
// Employer portion (patronal)
// ============================================================

/**
 * Every employer rate the calculation reads, all five work-risk classes
 * included: `riesgoRate` picks one of them per employee (#296).
 */
const EMPLOYER_RATE_KEYS = [
  'enfermedades_maternidad_fija',
  'enfermedades_maternidad_excedente',
  'prestaciones_dinero',
  'gastos_medicos_pensionados',
  'invalidez_vida',
  'guarderias',
  'riesgo_trabajo_clase_1',
  'riesgo_trabajo_clase_2',
  'riesgo_trabajo_clase_3',
  'riesgo_trabajo_clase_4',
  'riesgo_trabajo_clase_5',
  'retiro',
] as const satisfies readonly (keyof ImssEmployerRates)[];

export class MexicoImssEmployerCalculator implements ITaxCalculator {
  jurisdiction = 'MX';
  taxType = 'imss_employer';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { sbc_daily = 0, riesgo_puesto } = input;
    if (sbc_daily <= 0) {
      return { jurisdiction: 'MX', tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    const breakdown: Record<string, number> = {};
    const add = (k: string, v: number): void => { breakdown[k] = (breakdown[k] ?? 0) + v; };
    let taxableUsed = 0;
    const notes = [`Work risk class ${riesgo_puesto || '01'}`];

    // Each month's days with that month's UMA (#242): see `contributionMonths`.
    for (const { tax_year, date, days } of contributionMonths(input, 15)) {
      const params = await getTaxParameters('MX', tax_year, date);
      const uma = requiredParameter(params, 'uma_daily', 'MX', tax_year);
      const topeSbc = uma * 25;
      const sbcCapped = Math.min(sbc_daily, topeSbc);
      const excedente3uma = Math.max(0, sbcCapped - 3 * uma);
      // NOTE(#296): an absent block or rate throws, as the employee side does
      // since #200. `|| {}` plus `|| 0` per rate gave an employer quota of 0.00
      // that reached the journal entry and the SUA as if it were the obligation.
      const er = requiredRates(params, 'imss_employer', EMPLOYER_RATE_KEYS, tax_year);

      // EM fixed daily quota (cuota fija): 20.4% of UMA * days
      add('em_fija', uma * er.enfermedades_maternidad_fija * days);
      // EM excess over 3 UMA
      add('em_excedente', excedente3uma * er.enfermedades_maternidad_excedente * days);
      // Cash benefits (prestaciones en dinero)
      add('prestaciones_dinero', sbcCapped * er.prestaciones_dinero * days);
      // GMP
      add('gmp', sbcCapped * er.gastos_medicos_pensionados * days);
      // Disability and life (invalidez y vida)
      add('invalidez_vida', sbcCapped * er.invalidez_vida * days);
      // Daycare and social benefits (guarderias y prestaciones sociales)
      add('guarderias', sbcCapped * er.guarderias * days);
      // Work risk (riesgo de trabajo)
      add('riesgo_trabajo', sbcCapped * riesgoRate(er, riesgo_puesto) * days);
      // Severance and old age (cesantia y vejez): the rate of the SBC band, on
      // the date of the stretch (#661). Nothing here falls back to a figure: a
      // missing rule, date, minimum wage or table row is named.
      const edge = input.imss_old_age_band_edge;
      if (!edge) {
        throw new Error(
          `The employer old-age quota needs the policy ${OLD_AGE_BAND_EDGE_POLICY}: LSS art. 168 writes its ` +
            'bands to two decimals with no rounding rule, so the entity decides how an SBC meets an edge, ' +
            'not this calculator. Read it with readOldAgeBandEdge and pass it in the input.'
        );
      }
      if (!date) {
        throw new Error(
          'The employer old-age quota needs period_start and period_end: its rate depends on the SBC band ' +
            'and on the year of each contribution day (LSS art. 168 fr. II a), and the year cannot be taken from today.'
        );
      }
      const area = input.imss_minimum_wage_area;
      if (!area) {
        throw new Error(
          `The employer old-age quota needs the policy ${OLD_AGE_MINIMUM_WAGE_AREA_POLICY}: the «1.00 SM» band is ` +
            'measured with the minimum wage of an area, and the entity decides which. Read it with ' +
            'readOldAgeMinimumWageArea and pass it in the input.'
        );
      }
      const minimumWage = requiredParameter(params, MINIMUM_WAGE_PARAMETER_OF[area.zone], 'MX', tax_year);
      const band = placeOldAgeBand({ sbc: sbcCapped, uma, minimumWage, edge });
      const oldAge = await legalParameterAt('MX', OLD_AGE_EMPLOYER_RATE_PREFIX + band.suffix, date);
      add('cesantia_vejez', new Decimal(sbcCapped).times(oldAge.value).times(days).toNumber());
      notes.push(
        `Old age (cesantía y vejez) from ${date}, ${days} days: band «${band.asPrinted}» at ` +
          `${new Decimal(oldAge.value).times(100).toFixed(3)} %, UMA ${uma.toFixed(2)}, ` +
          `minimum wage ${minimumWage.toFixed(2)} (${describeMinimumWageArea(area)}), edge rule ${edge}`
      );
      // Retirement (SAR) — 2% paid directly to the AFORE
      add('retiro', sbcCapped * er.retiro * days);

      taxableUsed += sbcCapped * days;
    }

    const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

    return {
      jurisdiction: 'MX',
      tax_type: this.taxType,
      tax_amount: Math.round(total * 100) / 100,
      taxable_wages_used: taxableUsed,
      breakdown,
      notes: notes.join('; '),
    };
  }
}
