import { describe, it, expect } from 'vitest';
import {
  DECIMALES_FACTOR,
  factorDeActualizacion,
  normalizarBase,
  ultimoMesDeLaPrimeraMitad,
  type IndiceEnPeriodo,
} from '../../../src/services/fiscal/inpc/factor.js';
import { formatearPeriodo } from '../../../src/services/fiscal/inpc/periodo.js';
import { AccountingError, ValidationError } from '../../../src/utils/errors.js';

/**
 * EL CORAZÓN DEL FRENTE ES UNA NEGATIVA, Y AQUÍ SE PRUEBA QUE SE NIEGA.
 *
 * Los casos de bases distintas son el motivo de que este archivo exista: la
 * división SIEMPRE da un número, y el número que sale de cruzar la base
 * 2010=100 con la base 2018=100 es 0.7669 — plausible, revisable, firmable y
 * sin significado alguno. Ninguna aritmética lo detecta; sólo la guarda.
 *
 * Sin Postgres a propósito (el molde es conversion.ts de R4): los factores a
 * mano se escriben aquí en tres líneas y en una prueba de integración no se
 * escribirían nunca.
 */

/** Base vigente desde 2018: la segunda quincena de julio de 2018 = 100. */
const B2018 = '2018-Jul2=100';
/** La base anterior, la que el INEGI rebasó. */
const B2010 = '2010=100';

const idx = (anio: number, mes: number, valor: string, base = B2018): IndiceEnPeriodo => ({
  periodo: { anio, mes },
  valor,
  base,
});

function atrapar(fn: () => unknown): AccountingError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AccountingError);
    return err as AccountingError;
  }
  throw new Error('se esperaba que lanzara y no lanzó');
}

describe('factorDeActualizacion — el número a mano', () => {
  it('divide el índice reciente entre el antiguo (LISR art. 6 fr. II)', () => {
    // 132.373 / 126.478 = 1.0466089… → 1.0466 al diezmilésimo.
    // Son los INPC reales de diciembre de 2022 y diciembre de 2023.
    const r = factorDeActualizacion(idx(2022, 12, '126.478'), idx(2023, 12, '132.373'));
    expect(r.factor).toBe('1.0466');
    expect(r.base).toBe(B2018);
    expect(r.meses).toBe(13);
  });

  it('corta al diezmilésimo por omisión', () => {
    expect(DECIMALES_FACTOR).toBe(4);
    expect(factorDeActualizacion(idx(2020, 1, '100'), idx(2021, 1, '120')).factor).toBe('1.2000');
  });

  it('redondea half-up, no half-even: 1.33545 sube a 1.3355', () => {
    // 133.545 / 100 = 1.33545 exacto. Half-even daría 1.3354 y el papel de
    // trabajo del despacho no cuadraría contra el del SAT por un diezmilésimo.
    expect(factorDeActualizacion(idx(2018, 7, '100'), idx(2024, 3, '133.545')).factor).toBe('1.3355');
  });

  it('acepta más decimales para el papel de trabajo', () => {
    const r = factorDeActualizacion(idx(2022, 12, '126.478'), idx(2023, 12, '132.373'), {
      decimales: 6,
    });
    expect(r.factor).toBe('1.046609');
    expect(r.decimales).toBe(6);
  });

  it('da exactamente 1 cuando las dos puntas son el mismo mes', () => {
    // Adquirir y actualizar en el mismo mes NO actualiza. Es lo contrario del
    // 1.0 que el catálogo prohíbe: aquel sale de un mes FALTANTE, y ése se
    // rechaza al resolver el índice, no aquí.
    const r = factorDeActualizacion(idx(2024, 3, '133.555'), idx(2024, 3, '133.555'));
    expect(r.factor).toBe('1.0000');
  });

  it('rechaza pedir menos de dos decimales o más de diez', () => {
    expect(() => factorDeActualizacion(idx(2020, 1, '100'), idx(2021, 1, '120'), { decimales: 1 })).toThrow(
      ValidationError
    );
    expect(() => factorDeActualizacion(idx(2020, 1, '100'), idx(2021, 1, '120'), { decimales: 11 })).toThrow(
      ValidationError
    );
  });
});

describe('factorDeActualizacion — LA GUARDA DE BASES', () => {
  it('SE NIEGA cuando las dos puntas no comparten base', () => {
    // Enero de 2018 vale 128.832 en la base 2010=100 y 98.795 en la base
    // 2018=100: son el mismo mes en dos escalas. Cruzarlas da 0.7669, que
    // pasa cualquier revisión de vista y no significa nada.
    const err = atrapar(() =>
      factorDeActualizacion(idx(2018, 1, '128.832', B2010), idx(2024, 3, '133.555', B2018))
    );
    expect(err.code).toBe('INPC_BASES_DISTINTAS');
    expect(err.message).toContain(B2010);
    expect(err.message).toContain(B2018);
    expect(err.details).toMatchObject({ baseAntiguo: B2010, baseReciente: B2018 });
  });

  it('se niega también cuando el número resultante sería inocente', () => {
    // 100 entre 100 da 1.0000 exacto: el caso donde la guarda es la ÚNICA
    // señal, porque el resultado ni siquiera se ve raro.
    const err = atrapar(() =>
      factorDeActualizacion(idx(2018, 7, '100', B2010), idx(2018, 7, '100', B2018))
    );
    expect(err.code).toBe('INPC_BASES_DISTINTAS');
  });

  it('no da por equivalentes dos grafías distintas de la misma base', () => {
    // Deliberado: dar por iguales «2018=100» y «2018-Jul2=100» sería adivinar,
    // y adivinar la serie es el error que la base en la llave impide. Se
    // arregla la captura, no la comparación.
    const err = atrapar(() =>
      factorDeActualizacion(idx(2020, 1, '100', '2018=100'), idx(2021, 1, '120', B2018))
    );
    expect(err.code).toBe('INPC_BASES_DISTINTAS');
  });

  it('sí ignora los espacios de sobra, que no son otra serie', () => {
    const r = factorDeActualizacion(
      idx(2020, 1, '100', `  ${B2018} `),
      idx(2021, 1, '120', B2018)
    );
    expect(r.factor).toBe('1.2000');
    expect(r.base).toBe(B2018);
    expect(normalizarBase(`  2010 =  100 `)).toBe('2010 = 100');
  });

  it('rechaza un índice sin base', () => {
    expect(() => factorDeActualizacion(idx(2020, 1, '100', '   '), idx(2021, 1, '120'))).toThrow(
      ValidationError
    );
  });
});

describe('factorDeActualizacion — puntas y valores imposibles', () => {
  it('se niega si el «más antiguo» es posterior al «más reciente»', () => {
    const err = atrapar(() =>
      factorDeActualizacion(idx(2024, 3, '133.555'), idx(2022, 12, '126.478'))
    );
    expect(err.code).toBe('INPC_PERIODO_INVERTIDO');
  });

  it('rechaza un índice cero, negativo o no numérico', () => {
    expect(() => factorDeActualizacion(idx(2020, 1, '0'), idx(2021, 1, '120'))).toThrow(ValidationError);
    expect(() => factorDeActualizacion(idx(2020, 1, '100'), idx(2021, 1, '-120'))).toThrow(ValidationError);
    expect(() => factorDeActualizacion(idx(2020, 1, 'n/d'), idx(2021, 1, '120'))).toThrow(ValidationError);
  });
});

describe('ultimoMesDeLaPrimeraMitad — LISR art. 31', () => {
  it('con doce meses de uso, el tope es junio', () => {
    const r = ultimoMesDeLaPrimeraMitad({ anio: 2024, mes: 1 }, { anio: 2024, mes: 12 });
    expect(formatearPeriodo(r.mes)).toBe('2024-06');
    expect(r.meses).toBe(12);
    expect(r.impar).toBe(false);
  });

  it('con once meses (febrero a diciembre) toma el inmediato anterior a la mitad: junio', () => {
    // La mitad de once meses cae en julio; la ley manda el mes anterior.
    const r = ultimoMesDeLaPrimeraMitad({ anio: 2024, mes: 2 }, { anio: 2024, mes: 12 });
    expect(formatearPeriodo(r.mes)).toBe('2024-06');
    expect(r.meses).toBe(11);
    expect(r.impar).toBe(true);
  });

  it('con tres meses toma el primero, no el de en medio', () => {
    const r = ultimoMesDeLaPrimeraMitad({ anio: 2024, mes: 10 }, { anio: 2024, mes: 12 });
    expect(formatearPeriodo(r.mes)).toBe('2024-10');
    expect(r.impar).toBe(true);
  });

  it('con dos meses toma el primero', () => {
    const r = ultimoMesDeLaPrimeraMitad({ anio: 2024, mes: 11 }, { anio: 2024, mes: 12 });
    expect(formatearPeriodo(r.mes)).toBe('2024-11');
    expect(r.impar).toBe(false);
  });

  it('cruza el fin de ejercicio sin descolocarse', () => {
    const r = ultimoMesDeLaPrimeraMitad({ anio: 2023, mes: 7 }, { anio: 2024, mes: 6 });
    expect(formatearPeriodo(r.mes)).toBe('2023-12');
    expect(r.meses).toBe(12);
  });

  it('BLOQUEA el periodo de un solo mes en vez de inventar criterio', () => {
    // Con un mes la «primera mitad» termina dentro de ese mes y el «inmediato
    // anterior» que la ley manda tomar cae fuera. La lectura alternativa
    // produce 1.0000 en silencio, que es justo el número que el catálogo
    // prohíbe porque no se distingue de un mes faltante.
    const err = atrapar(() =>
      ultimoMesDeLaPrimeraMitad({ anio: 2024, mes: 12 }, { anio: 2024, mes: 12 })
    );
    expect(err.code).toBe('INPC_MEDIO_PERIODO_DE_UN_MES');
    expect(err.message).toContain('diciembre de 2024');
  });
});
