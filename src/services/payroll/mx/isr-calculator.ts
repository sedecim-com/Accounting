import type { ITaxCalculator, TaxInput, TaxOutput, PayFrequency } from '../tax-engine/tax-engine.interface.js';
import { getBrackets, applyBrackets } from '../tax-engine/tax-tables.js';

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
    const { taxable_wages, pay_frequency, tax_year } = input;

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
// Applies when monthly salary is below threshold (~$10,171 monthly 2026 est.)
// ============================================================

/**
 * Días que cubre un periodo de pago, para prorratear lo que se tabula por mes.
 *
 * `annual` no aparece: un subsidio anual no es un periodo de nómina, y si
 * llegara aquí se estaría prorrateando un año como si fuera un mes.
 */
export function diasDelPeriodo(freq: PayFrequency): number {
  switch (freq) {
    case 'weekly': return 7;
    case 'biweekly': return 14;
    case 'semimonthly': return 15;
    case 'quincenal': return 15;
    case 'monthly': return 30.4;
    default:
      throw new Error(`No sé cuántos días cubre el periodo «${freq}» para prorratear el subsidio al empleo`);
  }
}

export class MexicoSubsidioEmpleoCalculator implements ITaxCalculator {
  jurisdiction = 'MX';
  taxType = 'subsidio_empleo';

  async calculate(input: TaxInput): Promise<TaxOutput> {
    const { taxable_wages, pay_frequency, tax_year } = input;

    // EL PRORRATEO, Y POR QUÉ 30.4.
    //
    // El subsidio se tabula por MES. Antes, la base del periodo se tomaba como
    // si fuera mensual salvo en quincenal —o sea, un sueldo SEMANAL de 3 000
    // se leía como un sueldo mensual de 3 000— y luego se entregaba el
    // subsidio mensual ÍNTEGRO cada semana. Las dos mitades del error empujan
    // en la misma dirección: base baja (tramo con más subsidio) por subsidio
    // sin dividir. Medido: 3 000 semanales retenían 0.00.
    //
    // La regla de conversión es la del propio Decreto del subsidio para el
    // empleo, que manda dividir entre 30.4 y multiplicar por los días del
    // periodo. Es el mismo divisor con el que el Anexo 8 construye las
    // tarifas diaria y de 7, 10 y 15 días desde la mensual.
    const dias = diasDelPeriodo(pay_frequency);
    const monthlyBase = (taxable_wages / dias) * 30.4;

    const brackets = await getBrackets('MX', 'subsidio_empleo', tax_year, null, 'monthly');
    if (brackets.length === 0) {
      return { jurisdiction: 'MX', tax_type: this.taxType, tax_amount: 0, taxable_wages_used: 0 };
    }

    let monthlySubsidy = 0;
    for (const b of brackets) {
      const upper = b.bracket_high ?? Infinity;
      if (monthlyBase >= b.bracket_low && monthlyBase <= upper) {
        monthlySubsidy = b.base_tax;
        break;
      }
    }

    // Y de vuelta al periodo, por la misma vía.
    const subsidy = (monthlySubsidy / 30.4) * dias;

    return {
      jurisdiction: 'MX',
      tax_type: this.taxType,
      tax_amount: Math.round(subsidy * 100) / 100,
      taxable_wages_used: taxable_wages,
      is_credit: true,
      notes: 'Subsidio al empleo (credit against ISR)',
    };
  }
}
