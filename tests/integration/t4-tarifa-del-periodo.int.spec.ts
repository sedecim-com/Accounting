import { describe, it, expect } from 'vitest';
import { query } from '../../src/database/connection.js';
import {
  MexicoIsrCalculator,
  MexicoSubsidioEmpleoCalculator,
  tarifaDelPeriodo,
} from '../../src/services/payroll/mx/isr-calculator.js';
import { getTaxParameters } from '../../src/services/payroll/tax-engine/tax-tables.js';
import type { TaxInput } from '../../src/services/payroll/tax-engine/tax-engine.interface.js';

/**
 * LA RETENCIÓN SE COMPRUEBA CONTRA EL DIARIO OFICIAL, NO CONTRA SÍ MISMA.
 *
 * T4 (#91). Antes de este tramo, `isr-calculator.ts` hacía
 * `pay_frequency === 'quincenal' ? 'quincenal' : 'monthly'`: weekly, biweekly y
 * semimonthly recibían la tarifa MENSUAL aplicada a la base de UNA SEMANA, y el
 * subsidio mensual ÍNTEGRO cada periodo. Medido sobre la base migrada de
 * entonces: 3 000 semanales retenían **0.00** y 7 000 retenían 190.96.
 *
 * Y debajo había algo peor, que el issue no decía: la tarifa sembrada como
 * 2026 era, al centavo, la de 2025 (Anexo 8 RMF 2025), y la «quincenal» no era
 * la de ningún año — el propio archivo lo confesaba: «same structure, divided
 * by 2». La quincenal del Anexo 8 no es la mensual entre dos: es la diaria por
 * 15, y la diaria es la mensual entre 30.4.
 *
 * Esta suite fija las tres cosas por separado, porque fallan por separado:
 * el DATO (que la tarifa sea la de este año), la DERIVACIÓN (que las cuatro
 * tablas del periodo salgan de la mensual por la regla verificada) y la
 * ELECCIÓN (que cada periodo use la suya, y que el que no tiene tabla
 * publicada se niegue en vez de disfrazarse de mensual).
 */

const AÑO = 2026;

function entrada(sueldo: number, freq: string): TaxInput {
  return { taxable_wages: sueldo, pay_frequency: freq, tax_year: AÑO } as unknown as TaxInput;
}

async function retencion(sueldo: number, freq: string): Promise<number> {
  const isr = await new MexicoIsrCalculator().calculate(entrada(sueldo, freq));
  const sub = await new MexicoSubsidioEmpleoCalculator().calculate(entrada(sueldo, freq));
  return Math.max(0, Math.round((isr.tax_amount - sub.tax_amount) * 100) / 100);
}

describe('la tarifa del art. 96 que se aplica', () => {
  it('la mensual sembrada es la de 2026, no la de 2025', async () => {
    const r = await query<{ alto: string; cuota: string }>(
      `SELECT bracket_high::text AS alto, base_tax::text AS cuota
         FROM tax_tables
        WHERE jurisdiction = 'MX' AND tax_type = 'isr' AND tax_year = $1
          AND pay_frequency = 'monthly' AND bracket_order = 1`,
      [AÑO]
    );
    // 746.04 es el primer límite de la tarifa de 2025, que es la que estaba
    // sembrada como 2026. La de 2026 es 844.59 (Anexo 8 RMF 2026, rubro B.V).
    expect(Number(r.rows[0].alto)).toBe(844.59);
    expect(Number(r.rows[0].alto)).not.toBe(746.04);
  });

  it('las cuatro tarifas del periodo cuadran con los valores publicados', async () => {
    // Los que las dos lecturas independientes del Anexo 8 2026 citan
    // textualmente. Si la derivación deja de reproducirlos, manda el DOF.
    const anclas: Array<[string, number, number | null, number]> = [
      ['daily', 1, 27.78, 0.0],
      ['weekly', 1, 194.46, 0.0],
      ['decenal', 1, 277.8, 0.0],
      ['quincenal', 1, 416.7, 0.0],
      ['daily', 2, null, 0.53],
      ['weekly', 2, null, 3.71],
      ['decenal', 2, null, 5.3],
      ['quincenal', 2, 3537.15, 7.95],
    ];
    for (const [freq, orden, alto, cuota] of anclas) {
      const r = await query<{ alto: string | null; cuota: string }>(
        `SELECT bracket_high::text AS alto, base_tax::text AS cuota
           FROM tax_tables
          WHERE jurisdiction = 'MX' AND tax_type = 'isr' AND tax_year = $1
            AND pay_frequency = $2 AND bracket_order = $3`,
        [AÑO, freq, orden]
      );
      expect(r.rows.length, `falta el tramo ${orden} de la tarifa ${freq}`).toBe(1);
      if (alto !== null) expect(Number(r.rows[0].alto), `${freq} t${orden} límite superior`).toBe(alto);
      expect(Number(r.rows[0].cuota), `${freq} t${orden} cuota fija`).toBe(cuota);
    }
  });

  it('la quincenal NO es la mensual entre dos, que es lo que estaba sembrado', async () => {
    const r = await query<{ freq: string; alto: string }>(
      `SELECT pay_frequency AS freq, bracket_high::text AS alto
         FROM tax_tables
        WHERE jurisdiction = 'MX' AND tax_type = 'isr' AND tax_year = $1
          AND pay_frequency IN ('monthly', 'quincenal') AND bracket_order = 1`,
      [AÑO]
    );
    const m = Number(r.rows.find((x) => x.freq === 'monthly')?.alto);
    const q = Number(r.rows.find((x) => x.freq === 'quincenal')?.alto);
    expect(q).not.toBeCloseTo(m / 2, 2);
    // Es la mensual ÷ 30.4 × 15, que es como la construye el Anexo 8.
    expect(q).toBeCloseTo(Math.round((m / 30.4) * 100) / 100 * 15, 2);
  });
});

describe('lo que se le retiene a un sueldo semanal', () => {
  it('un sueldo semanal deja de retener CERO', async () => {
    // El defecto tal cual salía: con la tarifa mensual sobre base semanal, el
    // ISR caía en el primer tramo y el subsidio mensual íntegro se lo comía.
    expect(await retencion(3000, 'weekly')).toBe(248.82);
    expect(await retencion(7000, 'weekly')).toBe(1060.39);
  });

  it('y no se le aplica la tarifa mensual: las dos cifras son distintas', async () => {
    const semanal = await retencion(3000, 'weekly');
    const mensual = await retencion(3000, 'monthly');
    expect(semanal).not.toBe(mensual);

    const isr = await new MexicoIsrCalculator().calculate(entrada(3000, 'weekly'));
    expect(isr.notes, 'la nota dice qué tarifa se usó, para que se pueda auditar').toMatch(/weekly/);
  });

  it('el subsidio se prorratea: un sueldo semanal no cobra el subsidio de un mes', async () => {
    const sub = await new MexicoSubsidioEmpleoCalculator().calculate(entrada(3000, 'weekly'));
    // 3 000 semanales son ~13 029 al mes, por encima del límite del subsidio:
    // antes se leían como 3 000 MENSUALES y cobraban 406.62 cada semana.
    expect(sub.tax_amount).toBe(0);
    const quincenal = await new MexicoSubsidioEmpleoCalculator().calculate(entrada(3000, 'quincenal'));
    const mensual = await new MexicoSubsidioEmpleoCalculator().calculate(entrada(3000, 'monthly'));
    expect(quincenal.tax_amount, 'media quincena de subsidio, no uno entero').toBeLessThan(mensual.tax_amount);
  });
});

describe('los periodos sin tarifa publicada', () => {
  it('la catorcena y el semimonthly se NIEGAN, en vez de disfrazarse de mensuales', () => {
    // El Anexo 8 publica diaria, 7, 10 y 15 días y mensual. No hay catorcenal,
    // y la equivalencia semimonthly = quincenal no está en ninguna norma que se
    // haya podido verificar. Adivinarla es repetir el defecto con otro número.
    expect(() => tarifaDelPeriodo('biweekly')).toThrow(/no hay tarifa del art\. 96 publicada/i);
    expect(() => tarifaDelPeriodo('semimonthly')).toThrow(/no hay tarifa del art\. 96 publicada/i);
    // Y el mensaje dice qué hacer, no sólo que no se puede.
    expect(() => tarifaDelPeriodo('biweekly')).toThrow(/quincenal o\s+mensual|siembra la tarifa/i);
  });

  it('las tres que sí tienen tabla la usan', () => {
    expect(tarifaDelPeriodo('weekly')).toBe('weekly');
    expect(tarifaDelPeriodo('quincenal')).toBe('quincenal');
    expect(tarifaDelPeriodo('monthly')).toBe('monthly');
  });
});

describe('los parámetros legales tienen fecha', () => {
  it('el ejercicio 2026 tiene DOS UMAs, y cada una en su ventana', async () => {
    // La UMA entra en vigor el 1 de febrero: en enero de 2026 seguía rigiendo
    // la de 2025. La fila que había no estaba mal, estaba mal fechada.
    const enero = await getTaxParameters('MX', AÑO, '2026-01-15');
    const marzo = await getTaxParameters('MX', AÑO, '2026-03-15');
    expect(Number(enero.uma_daily)).toBe(113.14);
    expect(Number(marzo.uma_daily)).toBe(117.31);
  });

  it('un día sin parámetros vigentes se NOMBRA, no devuelve un objeto vacío', async () => {
    // Antes devolvía `{}` en silencio y cada motor rellenaba a su manera:
    // `imss-calculator` con `uma_daily || 113.14`, `infonavit-calculator` con
    // `|| 0.05`. La cifra inventada sale en el recibo y en la línea de captura.
    await expect(getTaxParameters('MX', 1999, '1999-06-01')).rejects.toThrow(
      /No hay parámetros fiscales de MX vigentes el 1999-06-01/
    );
  });
});
