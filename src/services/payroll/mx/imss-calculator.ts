import type { ITaxCalculator, TaxInput, TaxOutput } from '../tax-engine/tax-engine.interface.js';
import { contributionMonths, getTaxParameters, requiredParameter, requiredRates } from '../tax-engine/tax-tables.js';

// ============================================================
// MX — IMSS employer/employee contributions (cuotas obrero-patronales)
// Based on SBC (Salario Base de Cotizacion — contribution base salary) — daily amount.
// Cap (tope): 25 daily UMA. Excedente (excess): quota on the amount > 3 UMA.
// Employee (obrero) pays some ramos; employer (patronal) pays more.
// Reference: Ley del Seguro Social Arts. 25, 71, 106, 107, 146, 147, 168.
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
  cesantia_vejez: number;
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
  'cesantia_vejez',
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
      // Severance and old age (cesantia y vejez)
      add('cesantia_vejez', sbcCapped * er.cesantia_vejez * days);
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
      notes: `Work risk class ${riesgo_puesto || '01'}`,
    };
  }
}
