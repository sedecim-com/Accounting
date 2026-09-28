import type { ITaxCalculator, TaxInput, TaxOutput, PayFrequency } from '../tax-engine/tax-engine.interface.js';
import Decimal from 'decimal.js';
import { getBrackets, applyBrackets, paymentYear, periodsPerYear } from '../tax-engine/tax-tables.js';
import { legalParameterAt } from '../../jurisdiction/legal-parameters.js';
import { toCalendarDate } from '../../../utils/calendar-date.js';
import {
  EMPLOYMENT_SUBSIDY_ROUNDING_POLICY,
  employmentSubsidyForPeriod,
  subsidyDaysInPeriod,
} from './employment-subsidy.js';

// ============================================================
// MX — ISR (Impuesto Sobre la Renta)
// LISR Art. 96 — monthly / biweekly (quincenal) withholding on wages and salaries
// ============================================================

/**
 * Qué tarifa del Anexo 8 le toca a cada periodo de pago.
 *
 * EL DEFECTO QUE ESTO CIERRA (T4 · #91): esta línea decía
 * `pay_frequency === 'quincenal' ? 'quincenal' : 'monthly'`, así que weekly,
 * biweekly y semimonthly recibían la tarifa MENSUAL aplicada a la base de UNA
 * SEMANA. Medido antes del arreglo: 3 000 semanales retenían 0.00 y 7 000
 * retenían 190.96 — las mismas cifras que si el sueldo fuera mensual.
 *
 * El art. 96 LISR grava por MES. Los arts. 175 y 176 de su Reglamento permiten
 * OPTAR por la tarifa del periodo «que para tal efecto publique en el Diario
 * Oficial de la Federación el SAT», y el Anexo 8 publica cinco: diaria, 7, 10
 * y 15 días, y mensual. No publica catorcenal.
 *
 * POR ESO ESTO LANZA EN VEZ DE ADIVINAR. `biweekly` es la catorcena —26 pagos
 * al año— y no tiene tabla publicada; `semimonthly` es una etiqueta
 * estadounidense que en México correspondería a la quincena, pero esa
 * equivalencia no está escrita en ninguna norma que se haya podido verificar.
 * Sustituirlas por la mensual es exactamente el defecto que este tramo repara,
 * y sustituirlas por la quincenal sin fuente sería repetirlo con otro número.
 * Un periodo cuya tarifa no se puede saber se NOMBRA.
 */
export function tarifaDelPeriodo(freq: PayFrequency): PayFrequency {
  switch (freq) {
    case 'weekly': return 'weekly';
    case 'quincenal': return 'quincenal';
    case 'monthly': return 'monthly';
    case 'annual': return 'monthly';
    default:
      throw new Error(
        `No hay tarifa del art. 96 publicada para el periodo «${freq}»: el Anexo 8 publica diaria, ` +
        '7, 10 y 15 días y mensual, y no catorcenal. Antes se le aplicaba la MENSUAL a la base del ' +
        'periodo, que subretiene entre el 85 % y el 100 %. Configura la nómina como quincenal o ' +
        'mensual, o siembra la tarifa que corresponda con su fuente.'
      );
  }
}

export class MexicoIsrCalculator implements ITaxCalculator {
  jurisdiction = 'MX';
  taxType = 'isr';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, pay_frequency } = input;
    // The tariff of the year the wage is PAID, not of the period's label (#242).
    const tax_year = paymentYear(input);

    if (taxable_wages <= 0) {
      return {
        jurisdiction: this.jurisdiction,
        tax_type: this.taxType,
        tax_amount: 0,
        taxable_wages_used: 0,
        notes: 'Taxable base = 0',
      };
    }

    const freq = tarifaDelPeriodo(pay_frequency);
    const brackets = await getBrackets('MX', 'isr', tax_year, null, freq);

    if (brackets.length === 0) {
      throw new Error(`No ISR brackets found for year ${tax_year}, freq ${freq}`);
    }

    const { tax, rate } = applyBrackets(brackets, taxable_wages);

    return {
      jurisdiction: this.jurisdiction,
      tax_type: this.taxType,
      tax_amount: Math.round(tax * 100) / 100,
      taxable_wages_used: taxable_wages,
      rate_applied: rate,
      notes: `Art. 96 LISR ${freq}`,
    };
  }
}

// ============================================================
// MX — Subsidio al Empleo (credit against ISR)
// A share of the monthly UMA for monthly income up to a cap, both read from
// `legal_parameters` on the payment date (#298). See ./employment-subsidy.ts.
// ============================================================

/**
 * Cuántos periodos de éstos caben en un MES, para llevar el sueldo del
 * periodo a la base MENSUAL con la que se compara el tope de ingresos del
 * subsidio.
 *
 * SE DERIVA DE `periodsPerYear`, Y ESO ES DELIBERADO. El IMPORTE del subsidio
 * ya no pasa por aquí: el decreto lo prorratea por días entre 30.4, y eso vive
 * en `employmentSubsidyForPeriod` (#298). Lo que queda es la base de la
 * elegibilidad, que este repositorio ya tenía medida como 24 quincenas al año
 * ⇒ media mensualidad; si el tope se compara contra el sueldo × 30.4 / días
 * del periodo es una pregunta que #298 no decidió, y este tramo no la cambia.
 */
export function periodosPorMes(freq: PayFrequency): number {
  return periodsPerYear(freq) / 12;
}

/** The three `legal_parameters` keys the 2026 subsidy is computed from. */
export const EMPLOYMENT_SUBSIDY_LAW = {
  umaMonthly: 'uma.monthly',
  rate: 'employment_subsidy.uma_monthly_rate',
  incomeCap: 'employment_subsidy.monthly_income_cap',
} as const;

export class MexicoSubsidioEmpleoCalculator implements ITaxCalculator {
  jurisdiction = 'MX';
  taxType = 'subsidio_empleo';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, pay_frequency } = input;

    // THE LAW OF THE PAYMENT DATE (#242), and the date is required: the UMA
    // changes on February 1st, so a year is not enough to know which one
    // applies, and a default of «today» would recompute January with March.
    if (!input.pay_date) {
      throw new Error(
        'El subsidio al empleo se calcula con la ley vigente en la fecha de pago, y esta entrada ' +
          'no trae fecha de pago: la UMA cambia el 1 de febrero y el año no basta para saber cuál rige.'
      );
    }
    const rounding = input.employment_subsidy_rounding;
    if (!rounding) {
      throw new Error(
        `El subsidio al empleo necesita la política ${EMPLOYMENT_SUBSIDY_ROUNDING_POLICY}: el decreto no ` +
          'dice cómo redondear, así que lo decide el despacho y no esta calculadora. Léela con ' +
          'readEmploymentSubsidyRounding y pásala en la entrada.'
      );
    }
    const days = subsidyDaysInPeriod(pay_frequency);
    const onDate = toCalendarDate(input.pay_date);

    const none: TaxOutput = {
      jurisdiction: 'MX', tax_type: this.taxType, tax_amount: 0,
      taxable_wages_used: taxable_wages, is_credit: true,
    };
    if (taxable_wages <= 0) return none;

    const cap = await legalParameterAt('MX', EMPLOYMENT_SUBSIDY_LAW.incomeCap, onDate);
    const monthlyBase = new Decimal(taxable_wages).times(periodosPorMes(pay_frequency));
    if (monthlyBase.greaterThan(cap.value)) {
      return { ...none, notes: `Subsidio al empleo: ingreso mensual ${monthlyBase.toFixed(2)} sobre el tope ${cap.value}` };
    }

    const uma = await legalParameterAt('MX', EMPLOYMENT_SUBSIDY_LAW.umaMonthly, onDate);
    const rate = await legalParameterAt('MX', EMPLOYMENT_SUBSIDY_LAW.rate, onDate);
    const { monthly, period } = employmentSubsidyForPeriod({
      umaMonthly: uma.value, rate: rate.value, days, rounding,
    });

    return {
      ...none,
      tax_amount: period.toNumber(),
      notes:
        `Subsidio al empleo (credit against ISR): ${new Decimal(rate.value).toString()} × UMA mensual ` +
        `${new Decimal(uma.value).toFixed(2)} = ${monthly.toFixed(2)} al mes` +
        (days === null ? '' : `, × ${days} / 30.4`) +
        ` [${rounding}]`,
    };
  }
}
