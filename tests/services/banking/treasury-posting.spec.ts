import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  desglosarComision,
  desglosarComisionConIvaDeclarado,
  desglosarInteres,
  desglosarInteresConRetencionDeclarada,
  ORIGEN_COMISION,
  ORIGEN_INTERES,
  ORIGEN_COBRO_DE_CHEQUE,
  ORIGENES_DE_TESORERIA,
} from '../../../src/services/banking/treasury-posting.js';
import { ValidationError } from '../../../src/utils/errors.js';

/**
 * LA ARITMÉTICA DE LOS TRES ASIENTOS, SIN POSTGRES DETRÁS.
 *
 * Es la misma razón por la que `reconciliation-math.ts` no toca la base: cada
 * caso de aquí —el IVA calculado sobre una base que ya lo incluía, el residuo
 * de un diezmilésimo que descuadra el asiento, el interés reconocido por el
 * neto— habría necesitado sembrar una entidad, una cuenta, un extracto y un
 * periodo para preguntar algo que es una división.
 *
 * Y son los errores que CUADRAN. Un asiento con la base y el IVA cambiados de
 * sitio balancea igual de bien que el correcto, y `validateJournalEntry` no
 * tiene cómo notarlo: la única prueba que los caza es ésta.
 */

describe('desglosarComision · el IVA que el banco no desglosa', () => {
  it('despeja la base dividiendo, no multiplicando el total por la tasa', () => {
    const d = desglosarComision('116.00', '0.16');
    expect(d.base).toBe('100.0000');
    expect(d.iva).toBe('16.0000');
    expect(d.total).toBe('116.0000');
  });

  it('NO calcula el IVA como total × tasa, que es el error clásico de esta cuenta', () => {
    // 250 × 0.16 = 40.00 sería el IVA sobre una base que ya incluye IVA.
    const d = desglosarComision('250.00', '0.16');
    expect(d.iva).not.toBe('40.0000');
    expect(d.iva).toBe('34.4828');
    expect(d.base).toBe('215.5172');
  });

  it('base + IVA da el total EXACTO, sin el diezmilésimo que descuadraría el asiento', () => {
    // `validateJournalEntry` exige igualdad exacta contra el abono a banco: si
    // los dos cargos se redondearan por separado, este caso dejaría 0.0001 de
    // residuo y el asiento entero se caería en el INSERT.
    for (const cargo of ['250.00', '333.33', '19.7520', '0.0300', '1234.5678', '87.65']) {
      const d = desglosarComision(cargo, '0.16');
      expect(new Decimal(d.base).plus(d.iva).toFixed(4)).toBe(new Decimal(cargo).toFixed(4));
    }
  });

  it('conserva los CUATRO decimales de la columna, no los recorta a dos', () => {
    const d = desglosarComision('19.7520', '0');
    expect(d.base).toBe('19.7520');
    expect(d.total).toBe('19.7520');
  });

  it('con tasa cero el cargo entero es base y no hay línea de IVA que aparcar', () => {
    const d = desglosarComision('500.00', '0');
    expect(d.base).toBe('500.0000');
    expect(d.iva).toBe('0.0000');
  });

  it('rechaza una tasa de 1 o más: el despeje dividiría entre cero', () => {
    expect(() => desglosarComision('116.00', '1')).toThrow(ValidationError);
    expect(() => desglosarComision('116.00', '16')).toThrow(/entre 0 y 1/);
  });

  it('rechaza una tasa negativa', () => {
    expect(() => desglosarComision('116.00', '-0.16')).toThrow(ValidationError);
  });

  it('rechaza un cargo no positivo: el signo del extracto se quita antes', () => {
    expect(() => desglosarComision('-116.00', '0.16')).toThrow(/positivo/);
    expect(() => desglosarComision('0', '0.16')).toThrow(/positivo/);
  });

  it('rechaza un importe ilegible en vez de tratarlo como cero', () => {
    expect(() => desglosarComision('', '0.16')).toThrow(ValidationError);
    expect(() => desglosarComision('116.00', 'dieciséis')).toThrow(ValidationError);
  });
});

describe('desglosarComisionConIvaDeclarado · cuando el impuesto lo dice el extracto', () => {
  it('resta el impuesto declarado del cargo y los dos vuelven a sumar el total', () => {
    const d = desglosarComisionConIvaDeclarado('348.00', '48.00');
    expect(d.base).toBe('300.0000');
    expect(d.iva).toBe('48.0000');
    expect(new Decimal(d.base).plus(d.iva).toFixed(4)).toBe(d.total);
  });

  it('un IVA mayor que el cargo entero se RECHAZA, no se ajusta en silencio', () => {
    // Casi siempre es la base capturada donde iba el impuesto; ajustarlo solo
    // postearía una base negativa que journal_entry_lines rechaza lejos de aquí.
    expect(() => desglosarComisionConIvaDeclarado('48.00', '348.00')).toThrow(/mayor que el cargo/);
  });

  it('rechaza un IVA negativo', () => {
    expect(() => desglosarComisionConIvaDeclarado('348.00', '-48.00')).toThrow(/no puede ser negativo/);
  });

  it('admite el IVA igual al cargo sin inventar una base negativa', () => {
    const d = desglosarComisionConIvaDeclarado('48.00', '48.00');
    expect(d.base).toBe('0.0000');
    expect(d.iva).toBe('48.0000');
  });
});

describe('desglosarInteres · el bruto que el catálogo promete', () => {
  it('despeja el BRUTO desde el neto depositado y la tasa de retención', () => {
    const d = desglosarInteres('850.00', '0.15');
    expect(d.bruto).toBe('1000.0000');
    expect(d.retencion).toBe('150.0000');
    expect(d.neto).toBe('850.0000');
  });

  it('reconoce el ingreso por el BRUTO y no por el neto: son distintos a propósito', () => {
    const d = desglosarInteres('850.00', '0.15');
    // La versión de dos líneas —DR banco / CR 4310 por el neto— cuadra igual y
    // subestima el ingreso justo por la retención.
    expect(new Decimal(d.bruto).greaterThan(d.neto)).toBe(true);
    expect(new Decimal(d.bruto).minus(d.neto).toFixed(4)).toBe(d.retencion);
  });

  it('neto + retención da el bruto EXACTO para importes que no dividen redondo', () => {
    for (const neto of ['850.00', '1234.5678', '0.1250', '99.99', '7777.77']) {
      const d = desglosarInteres(neto, '0.0125');
      expect(new Decimal(d.neto).plus(d.retencion).toFixed(4)).toBe(d.bruto);
      expect(d.neto).toBe(new Decimal(neto).toFixed(4));
    }
  });

  it('conserva los cuatro decimales del abono', () => {
    const d = desglosarInteres('0.1250', '0');
    expect(d.bruto).toBe('0.1250');
    expect(d.retencion).toBe('0.0000');
  });

  it('rechaza una tasa de 1: el bruto dividiría entre cero y saldría Infinity', () => {
    expect(() => desglosarInteres('850.00', '1')).toThrow(ValidationError);
  });

  it('rechaza un abono no positivo: lo que no entra a la cuenta no es un interés', () => {
    expect(() => desglosarInteres('-850.00', '0.15')).toThrow(/positivo/);
    expect(() => desglosarInteres('0', '0.15')).toThrow(/positivo/);
  });
});

describe('desglosarInteresConRetencionDeclarada · cuando el extracto la publica en pesos', () => {
  it('suma la retención al neto para llegar al bruto', () => {
    const d = desglosarInteresConRetencionDeclarada('850.00', '150.00');
    expect(d.bruto).toBe('1000.0000');
    expect(d.retencion).toBe('150.0000');
    expect(d.neto).toBe('850.0000');
  });

  it('sin retención el bruto es el neto y el asiento sale sin línea de 1145', () => {
    const d = desglosarInteresConRetencionDeclarada('850.00', '0');
    expect(d.bruto).toBe('850.0000');
    expect(d.retencion).toBe('0.0000');
  });

  it('rechaza una retención negativa: el banco retiene, no devuelve', () => {
    expect(() => desglosarInteresConRetencionDeclarada('850.00', '-150.00')).toThrow(
      /no puede ser negativa/
    );
  });
});

describe('los tres `source_type`', () => {
  it('son tres, distintos entre sí', () => {
    expect(new Set(ORIGENES_DE_TESORERIA).size).toBe(3);
    expect(ORIGENES_DE_TESORERIA).toEqual([
      ORIGEN_COMISION,
      ORIGEN_INTERES,
      ORIGEN_COBRO_DE_CHEQUE,
    ]);
  });

  it('ninguno colisiona con los orígenes del subdiario de CxP ni con los de CxC', () => {
    // `ap-controls.ts` y `ar-controls.ts` separan «lo que vino de un subdiario»
    // de «lo que alguien tecleó» por estos nombres, y `uq_je_document_source`
    // (025) indexa los cuatro primeros. Un choque volvería los tres asientos de
    // tesorería invisibles para un informe o los haría chocar contra un índice.
    const ajenos = [
      'invoice',
      'bill',
      'customer_payment',
      'vendor_payment',
      'vendor_application',
      'receipt_application',
      'receipt_unapplication',
      'credit_note',
      'iva_reclass',
    ];
    for (const origen of ORIGENES_DE_TESORERIA) {
      expect(ajenos).not.toContain(origen);
    }
  });
});
