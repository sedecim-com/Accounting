import { describe, it, expect } from 'vitest';
import {
  compararPeriodos,
  distanciaEnMeses,
  exigirPeriodo,
  formatearPeriodo,
  mesesDelPeriodo,
  nombrarPeriodo,
  periodosEntre,
  sumarMeses,
} from '../../../src/services/fiscal/inpc/periodo.js';
import { ValidationError } from '../../../src/utils/errors.js';

/**
 * EL MES NO ES UNA FECHA. Estas pruebas existen porque la aritmética de meses
 * hecha con Date es donde el INPC se rompe en silencio: un cruce de año, un
 * mes 13 aceptado, un periodo contado por diferencia en vez de por meses
 * comprendidos. Ninguna toca Postgres, que es la razón de que estén escritas.
 */

describe('exigirPeriodo', () => {
  it('acepta AAAA-MM y AAAA/M', () => {
    expect(exigirPeriodo('2024-07')).toEqual({ anio: 2024, mes: 7 });
    expect(exigirPeriodo('2024/7')).toEqual({ anio: 2024, mes: 7 });
    expect(exigirPeriodo('  2019-03  ')).toEqual({ anio: 2019, mes: 3 });
  });

  it('rechaza el mes 13 en vez de correrlo a enero del año siguiente', () => {
    expect(() => exigirPeriodo('2024-13')).toThrow(ValidationError);
  });

  it('rechaza el mes cero', () => {
    expect(() => exigirPeriodo('2024-00')).toThrow(ValidationError);
  });

  it('rechaza un año anterior a la serie: no es antigüedad, es captura mala', () => {
    const err = (() => {
      try {
        exigirPeriodo('1950-01');
      } catch (e) {
        return e as ValidationError;
      }
      throw new Error('se esperaba que lanzara');
    })();
    expect(err.message).toContain('1969');
  });

  it('rechaza una fecha completa: el INPC no tiene día', () => {
    expect(() => exigirPeriodo('2024-07-15')).toThrow(ValidationError);
  });

  it('nombra la forma esperada en vez de decir «inválido»', () => {
    try {
      exigirPeriodo('julio 2024');
      throw new Error('se esperaba que lanzara');
    } catch (e) {
      expect((e as ValidationError).message).toContain('AAAA-MM');
    }
  });
});

describe('formato y nombre', () => {
  it('rellena el mes a dos dígitos', () => {
    expect(formatearPeriodo({ anio: 2024, mes: 7 })).toBe('2024-07');
  });

  it('nombra el mes en español para los mensajes de error', () => {
    expect(nombrarPeriodo({ anio: 2024, mes: 7 })).toBe('julio de 2024');
    expect(nombrarPeriodo({ anio: 2019, mes: 12 })).toBe('diciembre de 2019');
  });
});

describe('aritmética de meses', () => {
  it('ordena cronológicamente, no alfabéticamente', () => {
    expect(compararPeriodos({ anio: 2023, mes: 12 }, { anio: 2024, mes: 1 })).toBeLessThan(0);
    expect(compararPeriodos({ anio: 2024, mes: 3 }, { anio: 2024, mes: 3 })).toBe(0);
  });

  it('cruza el fin de año al sumar y al restar', () => {
    expect(sumarMeses({ anio: 2023, mes: 11 }, 3)).toEqual({ anio: 2024, mes: 2 });
    expect(sumarMeses({ anio: 2020, mes: 1 }, -1)).toEqual({ anio: 2019, mes: 12 });
    expect(sumarMeses({ anio: 2020, mes: 1 }, -13)).toEqual({ anio: 2018, mes: 12 });
  });

  it('cuenta los meses COMPRENDIDOS, no la diferencia: enero a diciembre son doce', () => {
    expect(distanciaEnMeses({ anio: 2024, mes: 1 }, { anio: 2024, mes: 12 })).toBe(11);
    expect(mesesDelPeriodo({ anio: 2024, mes: 1 }, { anio: 2024, mes: 12 })).toBe(12);
    expect(mesesDelPeriodo({ anio: 2024, mes: 3 }, { anio: 2024, mes: 3 })).toBe(1);
  });

  it('se niega a contar un periodo que termina antes de empezar', () => {
    expect(() => mesesDelPeriodo({ anio: 2024, mes: 5 }, { anio: 2024, mes: 4 })).toThrow(
      ValidationError
    );
  });

  it('enumera el intervalo completo con las dos puntas dentro', () => {
    expect(periodosEntre({ anio: 2023, mes: 11 }, { anio: 2024, mes: 2 }).map(formatearPeriodo)).toEqual([
      '2023-11', '2023-12', '2024-01', '2024-02',
    ]);
    expect(periodosEntre({ anio: 2024, mes: 6 }, { anio: 2024, mes: 6 })).toHaveLength(1);
  });
});
