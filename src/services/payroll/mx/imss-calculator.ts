import type { ITaxCalculator, TaxInput, TaxOutput } from '../tax-engine/tax-engine.interface.js';
import { getTaxParameters, requiredParameter, requiredRates } from '../tax-engine/tax-tables.js';

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

function riesgoRate(rates: ImssEmployerRates, clase: string | undefined): number {
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
    const { tax_year, sbc_daily = 0, days_in_period = 15 } = input;
    if (sbc_daily <= 0) {
      return { jurisdiction: 'MX', tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    const params = await getTaxParameters('MX', tax_year);
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

    const breakdown: Record<string, number> = {};

    // Sickness and maternity (enfermedades y maternidad, employee): quota on the excess over 3 UMA
    breakdown.em_excedente = excedente3uma * ee.enfermedades_maternidad * days_in_period;
    // Cash benefits (prestaciones en dinero)
    breakdown.prestaciones_dinero = sbcCapped * ee.prestaciones_dinero * days_in_period;
    // Medical expenses for pensioners (gastos medicos pensionados)
    breakdown.gmp = sbcCapped * ee.gastos_medicos_pensionados * days_in_period;
    // Disability and life (invalidez y vida)
    breakdown.invalidez_vida = sbcCapped * ee.invalidez_vida * days_in_period;
    // Severance and old age (cesantia y vejez)
    breakdown.cesantia_vejez = sbcCapped * ee.cesantia_vejez * days_in_period;

    const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

    return {
      jurisdiction: 'MX',
      tax_type: this.taxType,
      tax_amount: Math.round(total * 100) / 100,
      taxable_wages_used: sbcCapped * days_in_period,
      breakdown,
      notes: `Daily SBC ${sbc_daily.toFixed(2)}, cap ${topeSbc.toFixed(2)}, days ${days_in_period}`,
    };
  }
}

// ============================================================
// Employer portion (patronal)
// ============================================================

export class MexicoImssEmployerCalculator implements ITaxCalculator {
  jurisdiction = 'MX';
  taxType = 'imss_employer';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { tax_year, sbc_daily = 0, days_in_period = 15, riesgo_puesto } = input;
    if (sbc_daily <= 0) {
      return { jurisdiction: 'MX', tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    const params = await getTaxParameters('MX', tax_year);
    const uma = requiredParameter(params, 'uma_daily', 'MX', tax_year);
    const topeSbc = uma * 25;
    const sbcCapped = Math.min(sbc_daily, topeSbc);
    const excedente3uma = Math.max(0, sbcCapped - 3 * uma);
    const er = (params.imss_employer as ImssEmployerRates) || ({} as ImssEmployerRates);

    const breakdown: Record<string, number> = {};

    // EM fixed daily quota (cuota fija): 20.4% of UMA * days
    breakdown.em_fija = uma * (er.enfermedades_maternidad_fija || 0) * days_in_period;
    // EM excess over 3 UMA
    breakdown.em_excedente = excedente3uma * (er.enfermedades_maternidad_excedente || 0) * days_in_period;
    // Cash benefits (prestaciones en dinero)
    breakdown.prestaciones_dinero = sbcCapped * (er.prestaciones_dinero || 0) * days_in_period;
    // GMP
    breakdown.gmp = sbcCapped * (er.gastos_medicos_pensionados || 0) * days_in_period;
    // Disability and life (invalidez y vida)
    breakdown.invalidez_vida = sbcCapped * (er.invalidez_vida || 0) * days_in_period;
    // Daycare and social benefits (guarderias y prestaciones sociales)
    breakdown.guarderias = sbcCapped * (er.guarderias || 0) * days_in_period;
    // Work risk (riesgo de trabajo)
    breakdown.riesgo_trabajo = sbcCapped * riesgoRate(er, riesgo_puesto) * days_in_period;
    // Severance and old age (cesantia y vejez)
    breakdown.cesantia_vejez = sbcCapped * (er.cesantia_vejez || 0) * days_in_period;
    // Retirement (SAR) — 2% paid directly to the AFORE
    breakdown.retiro = sbcCapped * (er.retiro || 0) * days_in_period;

    const total = Object.values(breakdown).reduce((a, b) => a + b, 0);

    return {
      jurisdiction: 'MX',
      tax_type: this.taxType,
      tax_amount: Math.round(total * 100) / 100,
      taxable_wages_used: sbcCapped * days_in_period,
      breakdown,
      notes: `Work risk class ${riesgo_puesto || '01'}`,
    };
  }
}
