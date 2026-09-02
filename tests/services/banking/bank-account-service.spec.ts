import { describe, it, expect, vi } from 'vitest';

// Sin base de datos: lo que se prueba aquí son funciones puras, y el doble de
// `connection.js` es la garantía de que ninguna de ellas abre el pool por un
// camino que nadie esperaba.
vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  digitoVerificadorClabe,
  clabeValida,
  routingAbaValido,
  exigirClabe,
  exigirRoutingAba,
} from '../../../src/services/banking/bank-account-service.js';
import { ValidationError } from '../../../src/utils/errors.js';

// ============================================================
// LOS DOS CHECKSUM
//
// Las CLABEs de abajo están CONSTRUIDAS y su dígito verificador calculado a
// mano, no tomadas de ninguna cuenta real. Cada una lleva su aritmética en el
// comentario: si alguien cambia la implementación, la prueba no se limita a
// discrepar, dice contra qué cuenta.
//
// Los literales importan más de lo que parece. Una prueba que dijera
// `clabeValida(p + digitoVerificadorClabe(p))` sería verdad para CUALQUIER
// implementación consistente consigo misma, incluida una equivocada; los
// números escritos a mano son los que fijan el algoritmo. La propiedad va
// después, y prueba otra cosa: que el verificador correcto es ÚNICO.
// ============================================================

/**
 * 002 · 180 · 00000000000
 * Términos (dígito×peso mod 10): 0·3=0, 0·7=0, 2·1=2, 1·3=3, 8·7=56→6, resto 0.
 * Suma 11 → 11 mod 10 = 1 → verificador (10−1) mod 10 = 9.
 */
const CLABE_A = '002180000000000009';

/**
 * 012 · 914 · 12345678901
 * Términos: 0,7,2,7,7,4,3,4,3,2,5,6,1,6,9,0,7 → suma 73 → 73 mod 10 = 3
 * → verificador (10−3) mod 10 = 7.
 */
const CLABE_B = '012914123456789017';

/**
 * 002 · 150 · 00000000000 — el caso que justifica el `mod 10` de AFUERA.
 * Términos: 0, 0, 2, 3, 5·7=35→5 → suma 10 → 10 mod 10 = 0
 * → verificador (10−0) mod 10 = 0, y no 10, que no cabe en un dígito.
 */
const CLABE_CERO = '002150000000000000';

describe('digitoVerificadorClabe', () => {
  it('calcula el verificador de una CLABE construida a mano', () => {
    expect(digitoVerificadorClabe('00218000000000000')).toBe(9);
    expect(digitoVerificadorClabe('01291412345678901')).toBe(7);
  });

  it('devuelve 0 —y no 10— cuando la suma ponderada es múltiplo de diez', () => {
    expect(digitoVerificadorClabe('00215000000000000')).toBe(0);
  });

  it('exige exactamente 17 dígitos: no calcula sobre la CLABE entera', () => {
    // El error real que esto atrapa: pasar los 18 y quedarse con un
    // verificador calculado sobre una ventana corrida.
    expect(() => digitoVerificadorClabe(CLABE_A)).toThrow(ValidationError);
    expect(() => digitoVerificadorClabe('0021800000000000')).toThrow(ValidationError);
    expect(() => digitoVerificadorClabe('0021800000000000X')).toThrow(ValidationError);
  });
});

describe('clabeValida', () => {
  it('acepta las CLABEs cuyo dígito 18 es el que exigen los 17 primeros', () => {
    expect(clabeValida(CLABE_A)).toBe(true);
    expect(clabeValida(CLABE_B)).toBe(true);
    expect(clabeValida(CLABE_CERO)).toBe(true);
  });

  it('rechaza los otros nueve dígitos verificadores posibles', () => {
    // La propiedad que el algoritmo promete: el verificador correcto es uno
    // solo. Nueve rechazos por cada aceptación.
    for (const prefijo of ['00218000000000000', '01291412345678901', '00215000000000000']) {
      const correcto = digitoVerificadorClabe(prefijo);
      for (let d = 0; d <= 9; d++) {
        expect(clabeValida(`${prefijo}${d}`)).toBe(d === correcto);
      }
    }
  });

  it('detecta la transposición de dos dígitos contiguos, que es para lo que existe', () => {
    // CLABE_B con el 45 del número de cuenta vuelto 54: el error de tecleo más
    // común, y el que una simple suma sin pesos NO vería.
    expect(clabeValida('012914123546789017')).toBe(false);
  });

  it('rechaza lo que no son 18 dígitos', () => {
    expect(clabeValida('')).toBe(false);
    expect(clabeValida('12345')).toBe(false);
    expect(clabeValida(`${CLABE_A}0`)).toBe(false);
    expect(clabeValida('00218000000000000X')).toBe(false);
    // Con separadores es trabajo de `exigirClabe`, no del predicado.
    expect(clabeValida('002 180 00000000000 9')).toBe(false);
  });
});

describe('routingAbaValido', () => {
  /**
   * 3·(1+4+7) + 7·(2+5+8) + 1·(3+6+0) = 36 + 105 + 9 = 150, múltiplo de 10.
   */
  const ABA_A = '123456780';
  /**
   * 3·(9+6+3) + 7·(8+5+2) + 1·(7+4+0) = 54 + 105 + 11 = 170.
   */
  const ABA_B = '987654320';

  it('acepta nueve dígitos cuya ponderación 3,7,1 es múltiplo de diez', () => {
    expect(routingAbaValido(ABA_A)).toBe(true);
    expect(routingAbaValido(ABA_B)).toBe(true);
  });

  it('rechaza el mismo número con el último dígito movido', () => {
    expect(routingAbaValido('123456781')).toBe(false);
    expect(routingAbaValido('123456789')).toBe(false);
    expect(routingAbaValido('987654321')).toBe(false);
  });

  it('rechaza lo que no son nueve dígitos', () => {
    expect(routingAbaValido('12345678')).toBe(false);
    expect(routingAbaValido('1234567800')).toBe(false);
    expect(routingAbaValido('12345678X')).toBe(false);
    expect(routingAbaValido('')).toBe(false);
  });

  it('acepta nueve ceros, y por eso el checksum no basta', () => {
    // Documentado a propósito: la suma de nueve ceros es cero, así que el
    // checksum lo bendice. Que no exista tal institución lo dice
    // `exigirRoutingAba`, no esta función.
    expect(routingAbaValido('000000000')).toBe(true);
  });
});

describe('exigirClabe', () => {
  it('normaliza los separadores con que se copia de un estado de cuenta', () => {
    expect(exigirClabe('002 180 00000000000 9')).toEqual({
      clabe: CLABE_A,
      bancoSat: '002',
    });
    expect(exigirClabe('012-914-12345678901-7').clabe).toBe(CLABE_B);
  });

  it('devuelve la clave de banco del SAT, que son los tres primeros dígitos', () => {
    expect(exigirClabe(CLABE_B).bancoSat).toBe('012');
  });

  it('nombra el dígito que esperaba cuando el verificador no cuadra', () => {
    expect(() => exigirClabe('002180000000000000')).toThrow(/exigen 9 y trae 0/);
  });

  it('dice cuántos dígitos llegaron cuando no son 18', () => {
    expect(() => exigirClabe('0021800000')).toThrow(/tiene 10/);
  });

  it('rechaza la clave de banco 000 aunque el verificador cuadre', () => {
    // 000 · 000 · 00000000000 → suma 0 → verificador 0. Aritméticamente
    // impecable y de ninguna institución.
    expect(clabeValida('000000000000000000')).toBe(true);
    expect(() => exigirClabe('000000000000000000')).toThrow(ValidationError);
    expect(() => exigirClabe('000000000000000000')).toThrow(/Banxico/);
  });
});

describe('exigirRoutingAba', () => {
  it('normaliza y devuelve el routing', () => {
    expect(exigirRoutingAba('123-456-780')).toBe('123456780');
    expect(exigirRoutingAba('123 456 780')).toBe('123456780');
  });

  it('rechaza el que no pasa el checksum', () => {
    expect(() => exigirRoutingAba('123456781')).toThrow(ValidationError);
    expect(() => exigirRoutingAba('123456781')).toThrow(/checksum ABA/);
  });

  it('rechaza los nueve ceros que el checksum sí acepta', () => {
    expect(() => exigirRoutingAba('000000000')).toThrow(/ninguna institución/);
  });

  it('lleva el nombre del campo al error, para que la CLI señale el flag correcto', () => {
    try {
      exigirRoutingAba('12345678', 'routing_wire');
      expect.unreachable('debía lanzar');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('routing_wire');
    }
  });
});
