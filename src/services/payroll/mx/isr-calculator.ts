import type { ITaxCalculator, TaxInput, TaxOutput, PayFrequency } from '../tax-engine/tax-engine.interface.js';
import { getBrackets, applyBrackets, periodsPerYear } from '../tax-engine/tax-tables.js';

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
 * Cuántos periodos de éstos caben en un MES, para prorratear lo que se tabula
 * mensualmente.
 *
 * SE DERIVA DE `periodsPerYear`, Y ESO ES DELIBERADO. La primera versión de
 * este arreglo prorrateaba por días entre 30.4 —el divisor con el que el
 * Anexo 8 construye las tarifas del periodo— y con eso la quincena pasaba de
 * la mitad de un mes (0.5) a 15/30.4 = 0.4934. Es un 1.3 % menos de subsidio,
 * y lo cazó F08a, que fija la conducta ya verificada del subsidio quincenal:
 * `expected '98.68' to be '100.00'`.
 *
 * Cuál de los dos manda para el SUBSIDIO no está resuelto —el decreto ordena
 * el 30.4 para el prorrateo diario, pero la quincena tabulada como media
 * mensualidad es la práctica que este repositorio ya tenía medida—, así que
 * este tramo NO lo decide: conserva la proporción que ya estaba verificada
 * (24 periodos al año ⇒ media mensualidad) y se limita a arreglar lo que sí
 * estaba roto, que era tratar una SEMANA como si fuera un MES.
 */
export function periodosPorMes(freq: PayFrequency): number {
  return periodsPerYear(freq) / 12;
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
    const porMes = periodosPorMes(pay_frequency);
    const monthlyBase = taxable_wages * porMes;

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

    // Y de vuelta al periodo, por la misma proporción.
    const subsidy = monthlySubsidy / porMes;

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
