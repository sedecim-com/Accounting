import { describe, it, expect } from 'vitest';
import {
  calcularFiniquito,
  devengaPrimaDeAntiguedad,
  baseDiariaDePrima,
  type EntradaFiniquito,
} from '../../../src/services/payroll/mx/finiquito-math.js';
import Decimal from 'decimal.js';

/**
 * LA PRESTACIÓN MÁS GRANDE DEL FINIQUITO NO SE CALCULABA.
 *
 * T4b (#91). `calcularFiniquito` sumaba cuatro conceptos —salario pendiente,
 * aguinaldo, prima vacacional y vacaciones— y llamaba `total` al resultado.
 * Faltaba la PRIMA DE ANTIGÜEDAD del art. 162 LFT: doce días de salario por
 * año de servicio, sin tope de años.
 *
 * Medido sobre el caso de esta suite —quince años cumplidos, salario diario de
 * 1 000— el finiquito pasaba de 24 610.96 a 138 025.36: faltaba MÁS DE CUATRO
 * VECES lo que se pagaba.
 *
 * Tres reglas que es fácil equivocar, y por eso cada una tiene su caso:
 *
 *  1. EL TOPE SE APLICA AL SALARIO, NO AL RESULTADO. El art. 486 dice «se
 *     considerará esa cantidad como salario MÁXIMO»: se acota la base diaria y
 *     después se multiplica. Topar el resultado da otra cifra.
 *  2. EL DESPIDO LA PAGA SIEMPRE. Sólo la renuncia tiene umbral de quince años
 *     (fr. III); al despedido se le paga «independientemente de la
 *     justificación o injustificación del despido».
 *  3. EL MÍNIMO ES EL DE LA ZONA donde se presta el trabajo, no el general por
 *     defecto. Como este esquema todavía no guarda la zona, la ausencia del
 *     dato NO se resuelve suponiendo: se nombra.
 */

const QUINCE_AÑOS: EntradaFiniquito = {
  fecha_alta: '2011-03-01',
  fecha_baja: '2026-06-30',
  pagado_hasta: '2026-06-15',
  salario_diario: '1000.00',
  dias_vacaciones_pendientes: 0,
  dias_aguinaldo_por_anio: 15,
  prima_vacacional_pct: '0.25',
  motivo_baja: 'renuncia',
  salario_minimo_diario: '315.04',
};

describe('la base diaria de la prima (LFT arts. 485 y 486)', () => {
  it('topa el SALARIO en dos mínimos, no el resultado', () => {
    // 1 000 excede el doble de 315.04, así que la base es 630.08 y no 1 000.
    expect(baseDiariaDePrima(new Decimal('1000'), new Decimal('315.04')).toFixed(2)).toBe('630.08');
  });

  it('y respeta el piso del 485: nunca por debajo de un mínimo', () => {
    // Un salario inferior al mínimo no baja la base: el 485 lo impide.
    expect(baseDiariaDePrima(new Decimal('200'), new Decimal('315.04')).toFixed(2)).toBe('315.04');
  });

  it('un salario ENTRE uno y dos mínimos entra tal cual', () => {
    expect(baseDiariaDePrima(new Decimal('500'), new Decimal('315.04')).toFixed(2)).toBe('500.00');
  });

  it('la zona cambia el tope, y con él la prestación', () => {
    // Frontera 2026: 440.87. El doble es 881.74, no 630.08.
    expect(baseDiariaDePrima(new Decimal('1000'), new Decimal('440.87')).toFixed(2)).toBe('881.74');
  });
});

describe('quién la devenga (LFT art. 162 fr. III y V)', () => {
  it('la renuncia, sólo con quince años cumplidos', () => {
    expect(devengaPrimaDeAntiguedad('renuncia', 15)).toBe(true);
    expect(devengaPrimaDeAntiguedad('renuncia', 14)).toBe(false);
  });

  it('el despido SIEMPRE, tenga la antigüedad que tenga', () => {
    // «independientemente de la justificación o injustificación del despido».
    // Es la mitad del artículo que más se pasa por alto.
    expect(devengaPrimaDeAntiguedad('despido', 3)).toBe(true);
    expect(devengaPrimaDeAntiguedad('despido', 0)).toBe(true);
  });

  it('la rescisión por causa imputable al patrón y la muerte, también sin umbral', () => {
    expect(devengaPrimaDeAntiguedad('rescision_por_el_trabajador', 1)).toBe(true);
    // Fr. V: «cualquiera que sea su antigüedad».
    expect(devengaPrimaDeAntiguedad('muerte', 1)).toBe(true);
  });
});

describe('el finiquito con su prima', () => {
  it('quince años de servicio son 180 días, y entran en el total', () => {
    const r = calcularFiniquito(QUINCE_AÑOS);
    expect(r.prima_antiguedad_dias).toBe(180);
    expect(r.prima_antiguedad_base_diaria).toBe('630.0800');
    expect(r.prima_antiguedad_importe).toBe('113414.4000');
    // Y el total la incluye: antes de este tramo eran 24 610.9589.
    expect(r.total).toBe('138025.3589');
  });

  it('un despedido con tres años la cobra: 36 días', () => {
    const r = calcularFiniquito({
      ...QUINCE_AÑOS,
      fecha_alta: '2023-03-01',
      motivo_baja: 'despido',
    });
    expect(r.prima_antiguedad_dias).toBe(36);
    expect(r.prima_antiguedad_importe).toBe('22682.8800');
  });

  it('quien renuncia con tres años no la devenga, y el desglose dice por qué', () => {
    const r = calcularFiniquito({
      ...QUINCE_AÑOS,
      fecha_alta: '2023-03-01',
      motivo_baja: 'renuncia',
    });
    expect(r.prima_antiguedad_importe).toBe('0.0000');
    expect(r.prima_antiguedad_nota).toMatch(/no se devenga.*quince años/i);
  });

  it('SIN el salario mínimo NO se inventa el tope: se nombra lo que falta', () => {
    // Suponer el general le pagaría de menos a un trabajador fronterizo:
    // 180 días × 630.08 contra × 881.74 son 45 298.80 de diferencia. Un cero
    // sin explicación es indistinguible de un cero por no saber.
    const { salario_minimo_diario: _omitido, ...sinMinimo } = QUINCE_AÑOS;
    const r = calcularFiniquito(sinMinimo as EntradaFiniquito);
    expect(r.prima_antiguedad_importe).toBe('0.0000');
    expect(r.prima_antiguedad_base_diaria).toBeNull();
    expect(r.prima_antiguedad_nota).toMatch(/SIN CALCULAR/);
    // Y dice CUÁNTOS días se deben, que es lo accionable.
    expect(r.prima_antiguedad_nota).toMatch(/180 días/);
  });

  it('la zona de frontera cambia el finiquito en 45 298.80', () => {
    const general = calcularFiniquito(QUINCE_AÑOS);
    const frontera = calcularFiniquito({ ...QUINCE_AÑOS, salario_minimo_diario: '440.87' });
    const diferencia = new Decimal(frontera.prima_antiguedad_importe).minus(
      general.prima_antiguedad_importe
    );
    expect(diferencia.toFixed(2)).toBe('45298.80');
  });
});
