import { describe, it, expect } from 'vitest';
import {
  convertirImporte,
  traeCamposFx,
  verificarOrigenFx,
  type LineaConOrigen,
} from '../../../src/services/fx/conversion.js';
import { convertirAFuncional } from '../../../src/services/accounting/moneda-origen.js';
import { AccountingError } from '../../../src/utils/errors.js';

/**
 * LA CONVERSIÓN SE VERIFICA, NO SE CONFÍA — SIN POSTGRES DETRÁS.
 *
 * Cada caso de aquí es la razón de que `conversion.ts` sea puro: el medio
 * centavo que redondea hacia arriba, el cargo cuyo origen llegó como abono,
 * la línea que declara dólares y no trae su importe original. Sembrar una
 * entidad, un periodo y un asiento para preguntar por una multiplicación
 * habría garantizado que el caso incómodo no se escribiera nunca.
 */

const MONEDA_FUNCIONAL = 'MXN';

/** Un cargo en USD correcto de punta a punta: 100.55 × 18.2345 = 1833.4790. */
const cargoUsd = (over: Partial<LineaConOrigen> = {}): LineaConOrigen => ({
  debit_amount: '1833.4790',
  credit_amount: null,
  currency_code: 'USD',
  foreign_debit: '100.55',
  foreign_credit: null,
  exchange_rate: '18.2345',
  ...over,
});

function atrapar(fn: () => void): AccountingError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AccountingError);
    return err as AccountingError;
  }
  throw new Error('se esperaba que lanzara y no lanzó');
}

describe('convertirImporte', () => {
  it('multiplica y redondea a 4 decimales', () => {
    // 100.55 × 18.2345 = 1833.478975 → el quinto decimal (7) sube el cuarto.
    expect(convertirImporte('100.55', '18.2345')).toBe('1833.4790');
  });

  it('redondea half-up en el empate exacto: 0.00025 sube a 0.0003', () => {
    // 0.0005 × 0.5 = 0.00025. Half-up da 0.0003; half-even (el default de
    // muchas librerías bancarias) daría 0.0002 — este caso pinza el criterio.
    expect(convertirImporte('0.0005', '0.5')).toBe('0.0003');
  });

  it('no sube cuando el residuo queda bajo el medio: 0.00004 baja a 0.0000', () => {
    expect(convertirImporte('0.0004', '0.1')).toBe('0.0000');
  });

  it('conserva la precisión de una tasa de diez decimales', () => {
    // 1000.00 × 18.1234567891 = 18123.4567891 → 18123.4568 a 4 decimales.
    expect(convertirImporte('1000.00', '18.1234567891')).toBe('18123.4568');
  });

  it('no pierde centavos en el importe máximo del esquema (el clon de precisión 40)', () => {
    // 999999999999999.9999 (19 dígitos, el tope de DECIMAL(19,4)) ×
    // 18.1234567891 = …099999.99818765432109 exacto → …099999.9982 half-up.
    // Con los 20 dígitos por defecto de decimal.js la multiplicación se
    // redondearía ANTES del corte y saldría …099999.9980: dos centavos de
    // mentira justo en el importe grande.
    expect(convertirImporte('999999999999999.9999', '18.1234567891')).toBe('18123456789099999.9982');
  });

  it('calcula EXACTAMENTE lo mismo que el convertidor del posteo de documentos', () => {
    // moneda-origen.ts convierte; este módulo verifica. Si sus aritméticas
    // difieren en un solo caso, el motor rechazaría una conversión correcta.
    const casos: Array<[string, string]> = [
      ['100.55', '18.2345'],
      ['0.0005', '0.5'],
      ['999999999999999.9999', '18.1234567891'],
      ['1.0001', '0.0000000001'],
    ];
    for (const [importe, tasa] of casos) {
      expect(convertirImporte(importe, tasa), `${importe} × ${tasa}`).toBe(
        convertirAFuncional(importe, tasa)
      );
    }
  });
});

describe('traeCamposFx', () => {
  it('ve cualquier campo FX suelto', () => {
    expect(traeCamposFx({ debit_amount: '1', credit_amount: null })).toBe(false);
    expect(traeCamposFx({ debit_amount: '1', credit_amount: null, exchange_rate: '17.1' })).toBe(true);
    expect(traeCamposFx({ debit_amount: '1', credit_amount: null, currency_code: 'USD' })).toBe(true);
    expect(traeCamposFx({ debit_amount: '1', credit_amount: null, foreign_credit: '2' })).toBe(true);
  });
});

describe('verificarOrigenFx — la regla del origen', () => {
  it('deja pasar la línea sin campos FX: moneda funcional por declaración', () => {
    expect(() =>
      verificarOrigenFx({ debit_amount: '500.0000', credit_amount: null }, MONEDA_FUNCIONAL, 1)
    ).not.toThrow();
  });

  it('deja pasar el cargo en USD con su origen completo y la conversión exacta', () => {
    expect(() => verificarOrigenFx(cargoUsd(), MONEDA_FUNCIONAL, 1)).not.toThrow();
  });

  it('deja pasar el abono espejo', () => {
    const abono: LineaConOrigen = {
      debit_amount: null,
      credit_amount: '1833.4790',
      currency_code: 'USD',
      foreign_debit: null,
      foreign_credit: '100.55',
      exchange_rate: '18.2345',
    };
    expect(() => verificarOrigenFx(abono, MONEDA_FUNCIONAL, 2)).not.toThrow();
  });

  it('REGLA DURA: moneda extranjera declarada sin origen se rechaza nombrando qué falta', () => {
    // Éste es el defecto que R4 existe para cerrar: antes, esta línea se
    // guardaba convertida sin rastro del importe original.
    const err = atrapar(() =>
      verificarOrigenFx(
        { debit_amount: '1833.4790', credit_amount: null, currency_code: 'USD' },
        MONEDA_FUNCIONAL,
        3
      )
    );
    expect(err.code).toBe('FX_ORIGEN_INCOMPLETO');
    expect(err.message).toContain('exchange_rate');
    expect(err.message).toContain('foreign_debit o foreign_credit');
    expect(err.message).toContain('Línea 3');
  });

  it('rechaza el tipo de cambio ausente aunque venga el importe de origen', () => {
    const err = atrapar(() =>
      verificarOrigenFx(cargoUsd({ exchange_rate: null }), MONEDA_FUNCIONAL, 1)
    );
    expect(err.code).toBe('FX_ORIGEN_INCOMPLETO');
    expect(err.message).toContain('exchange_rate');
  });

  it('rechaza campos FX sueltos sin currency_code: un origen sin moneda no es un origen', () => {
    const err = atrapar(() =>
      verificarOrigenFx(
        { debit_amount: '1833.4790', credit_amount: null, foreign_debit: '100.55', exchange_rate: '18.2345' },
        MONEDA_FUNCIONAL,
        1
      )
    );
    expect(err.code).toBe('FX_ORIGEN_INCOMPLETO');
    expect(err.message).toContain('currency_code');
  });

  it('rechaza la moneda funcional como currency_code', () => {
    const err = atrapar(() =>
      verificarOrigenFx(
        cargoUsd({ currency_code: 'MXN', exchange_rate: '1', foreign_debit: '1833.4790' }),
        MONEDA_FUNCIONAL,
        1
      )
    );
    expect(err.code).toBe('FX_ORIGEN_INCOMPLETO');
    expect(err.message).toContain('moneda funcional');
  });

  it('rechaza el código que no es ISO 4217', () => {
    const err = atrapar(() => verificarOrigenFx(cargoUsd({ currency_code: 'usd' }), MONEDA_FUNCIONAL, 1));
    expect(err.code).toBe('FX_ORIGEN_INCOMPLETO');
    expect(err.message).toContain('ISO 4217');
  });

  it('rechaza el cargo cuyo origen llegó como abono: los lados se espejan', () => {
    const err = atrapar(() =>
      verificarOrigenFx(
        cargoUsd({ foreign_debit: null, foreign_credit: '100.55' }),
        MONEDA_FUNCIONAL,
        1
      )
    );
    expect(err.code).toBe('FX_ORIGEN_INCOMPLETO');
    expect(err.message).toContain('foreign_debit');
  });

  it('rechaza los dos lados extranjeros a la vez', () => {
    const err = atrapar(() =>
      verificarOrigenFx(cargoUsd({ foreign_credit: '100.55' }), MONEDA_FUNCIONAL, 1)
    );
    expect(err.code).toBe('FX_ORIGEN_INCOMPLETO');
    expect(err.message).toContain('un solo lado');
  });
});

describe('verificarOrigenFx — la aritmética', () => {
  it('rechaza la conversión que no casa CON LOS TRES NÚMEROS en el error', () => {
    const err = atrapar(() =>
      verificarOrigenFx(cargoUsd({ debit_amount: '1833.4789' }), MONEDA_FUNCIONAL, 1)
    );
    expect(err.code).toBe('FX_CONVERSION_NO_CASA');
    // Los tres números: el origen, el tipo y el esperado — más el recibido.
    expect(err.message).toContain('100.55');
    expect(err.message).toContain('18.2345');
    expect(err.message).toContain('1833.4790');
    expect(err.message).toContain('1833.4789');
    expect(err.details).toMatchObject({
      importe_origen: '100.55',
      tipo_de_cambio: '18.2345',
      esperado: '1833.4790',
      recibido: '1833.4789',
    });
  });

  it('exige el half-up en el empate: el valor half-even se rechaza', () => {
    // 0.0005 × 0.5 = 0.00025 → half-up 0.0003. Quien convierta con
    // half-even mandará 0.0002 y debe enterarse aquí, no en el CHECK.
    const empate = (funcional: string): LineaConOrigen => ({
      debit_amount: funcional,
      credit_amount: null,
      currency_code: 'USD',
      foreign_debit: '0.0005',
      foreign_credit: null,
      exchange_rate: '0.5',
    });
    expect(() => verificarOrigenFx(empate('0.0003'), MONEDA_FUNCIONAL, 1)).not.toThrow();
    const err = atrapar(() => verificarOrigenFx(empate('0.0002'), MONEDA_FUNCIONAL, 1));
    expect(err.code).toBe('FX_CONVERSION_NO_CASA');
  });

  it('compara como números, no como cadenas: 1833.479 es 1833.4790', () => {
    expect(() =>
      verificarOrigenFx(cargoUsd({ debit_amount: '1833.479' }), MONEDA_FUNCIONAL, 1)
    ).not.toThrow();
  });

  it('rechaza el tipo con más de diez decimales antes de que Postgres lo recorte en silencio', () => {
    const err = atrapar(() =>
      verificarOrigenFx(
        cargoUsd({ exchange_rate: '18.12345678901', debit_amount: '1822.3103' }),
        MONEDA_FUNCIONAL,
        1
      )
    );
    expect(err.code).toBe('FX_ORIGEN_INCOMPLETO');
    expect(err.message).toContain('10 decimales');
  });

  it('rechaza el importe de origen con más de cuatro decimales', () => {
    const err = atrapar(() =>
      verificarOrigenFx(cargoUsd({ foreign_debit: '100.55001' }), MONEDA_FUNCIONAL, 1)
    );
    expect(err.code).toBe('FX_ORIGEN_INCOMPLETO');
    expect(err.message).toContain('4 decimales');
  });

  it('rechaza el tipo de cambio cero o negativo', () => {
    for (const tasa of ['0', '-18.2345']) {
      const err = atrapar(() =>
        verificarOrigenFx(cargoUsd({ exchange_rate: tasa }), MONEDA_FUNCIONAL, 1)
      );
      expect(err.code, `tasa ${tasa}`).toBe('FX_ORIGEN_INCOMPLETO');
    }
  });

  it('rechaza el importe de origen cero o negativo', () => {
    for (const importe of ['0', '-100.55']) {
      const err = atrapar(() =>
        verificarOrigenFx(cargoUsd({ foreign_debit: importe }), MONEDA_FUNCIONAL, 1)
      );
      expect(err.code, `importe ${importe}`).toBe('FX_ORIGEN_INCOMPLETO');
    }
  });

  it('rechaza la basura que no es número', () => {
    const err = atrapar(() =>
      verificarOrigenFx(cargoUsd({ exchange_rate: 'diecisiete' }), MONEDA_FUNCIONAL, 1)
    );
    expect(err.code).toBe('FX_ORIGEN_INCOMPLETO');
  });
});
