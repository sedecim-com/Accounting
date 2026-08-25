import type { ITaxCalculator, TaxInput, TaxOutput } from '../tax-engine/tax-engine.interface.js';
import { getTaxParameters } from '../tax-engine/tax-tables.js';

// ============================================================
// MX — IMSS employer/employee contributions (cuotas obrero-patronales)
// Based on SBC (Salario Base de Cotizacion — contribution base salary) — daily amount.
// Cap (tope): 25 daily UMA. Excedente (excess): quota on the amount > 3 UMA.
// Employee (obrero) pays some ramos; employer (patronal) pays more.
// Reference: Ley del Seguro Social Arts. 25, 71, 106, 107, 146, 147, 168.
// ============================================================

interface ImssRates {
  enfermedades_maternidad: number;
  prestaciones_dinero: number;
  gastos_medicos_pensionados: number;
  invalidez_vida: number;
  cesantia_vejez: number;
}

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

export class MexicoImssEmployeeCalculator implements ITaxCalculator {
  jurisdiction = 'MX';
  taxType = 'imss_employee';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { tax_year, sbc_daily = 0, days_in_period = 15 } = input;
    if (sbc_daily <= 0) {
      return { jurisdiction: 'MX', tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    const params = await getTaxParameters('MX', tax_year);
    const uma = parseFloat(String(params.uma_daily || 113.14));
    const topeSbc = uma * 25;
    const sbcCapped = Math.min(sbc_daily, topeSbc);
    const excedente3uma = Math.max(0, sbcCapped - 3 * uma);

    const ee = (params.imss_employee as unknown as ImssRates) || ({} as ImssRates);

    const breakdown: Record<string, number> = {};

    // Sickness and maternity (enfermedades y maternidad, employee): quota on the excess over 3 UMA
    breakdown.em_excedente = excedente3uma * (ee.enfermedades_maternidad || 0) * days_in_period;
    // Cash benefits (prestaciones en dinero)
    breakdown.prestaciones_dinero = sbcCapped * (ee.prestaciones_dinero || 0) * days_in_period;
    // Medical expenses for pensioners (gastos medicos pensionados)
    breakdown.gmp = sbcCapped * (ee.gastos_medicos_pensionados || 0) * days_in_period;
    // Disability and life (invalidez y vida)
    breakdown.invalidez_vida = sbcCapped * (ee.invalidez_vida || 0) * days_in_period;
    // Severance and old age (cesantia y vejez)
    breakdown.cesantia_vejez = sbcCapped * (ee.cesantia_vejez || 0) * days_in_period;

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
    const uma = parseFloat(String(params.uma_daily || 113.14));
    const topeSbc = uma * 25;
    const sbcCapped = Math.min(sbc_daily, topeSbc);
    const excedente3uma = Math.max(0, sbcCapped - 3 * uma);
    const er = (params.imss_employer as unknown as ImssEmployerRates) || ({} as ImssEmployerRates);

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
