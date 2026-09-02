import { describe, it, expect } from 'vitest';
import {
  convertirAFuncional,
  diferenciaCambiariaRealizada,
  desgloseCambiarioDelPago,
  type ContextoCambiario,
} from '../../../src/services/accounting/moneda-origen.js';

/**
 * LA ARITMÉTICA DE B-15, SIN POSTGRES DETRÁS.
 *
 * La razón de que moneda-origen.ts sea aritmética pura es exactamente ésta:
 * el caso espejo (misma operación, tasa al revés), el redondeo del décimo
 * decimal y el pago con descuento y anticipo se prueban en cuatro líneas.
 * Sembrar entidad, gasto, tasa y pago para preguntar una resta es como los
 * casos incómodos se quedan sin escribir.
 */

const ctx = (
  tasaPago: string,
  aplicaciones: ContextoCambiario['aplicaciones']
): ContextoCambiario => ({
  moneda: 'USD',
  monedaFuncional: 'MXN',
  tasaPago,
  fuenteTasa: 'parametro',
  aplicaciones,
});

describe('convertirAFuncional', () => {
  it('multiplica por la tasa y entrega 4 decimales, como el mayor', () => {
    expect(convertirAFuncional('1000', '17.00')).toBe('17000.0000');
  });

  it('respeta los diez decimales de la tasa sin perder precisión', () => {
    // 1000 × 17.1234567891 = 17123.4567891 → a 4 decimales del mayor.
    expect(convertirAFuncional('1000', '17.1234567891')).toBe('17123.4568');
  });
});

describe('diferenciaCambiariaRealizada', () => {
  it('pagar 1000 USD registrados a 17.00 con efectivo a 17.50 son 500 MXN de PÉRDIDA', () => {
    const dif = diferenciaCambiariaRealizada({
      importePagado: '1000',
      tasaHistorica: '17.00',
      tasaPago: '17.50',
    });
    expect(dif.tipo).toBe('perdida');
    expect(dif.montoFuncional).toBe('500.0000');
  });

  it('el espejo: pagar a 16.50 lo registrado a 17.00 son 500 MXN de UTILIDAD', () => {
    const dif = diferenciaCambiariaRealizada({
      importePagado: '1000',
      tasaHistorica: '17.00',
      tasaPago: '16.50',
    });
    expect(dif.tipo).toBe('utilidad');
    expect(dif.montoFuncional).toBe('500.0000');
  });

  it('misma tasa en registro y pago: no hay diferencia que asentar', () => {
    const dif = diferenciaCambiariaRealizada({
      importePagado: '1000',
      tasaHistorica: '17.00',
      tasaPago: '17.00',
    });
    expect(dif.tipo).toBe('ninguna');
    expect(dif.montoFuncional).toBe('0.0000');
  });

  it('la diferencia es la resta de los importes YA redondeados, no la teórica', () => {
    // 123.45 × 17.1234567891 = 2113.8907337... → 2113.8907
    // 123.45 × 17.1234567892 = 2113.8907338... → 2113.8907
    // La teoría da una brecha de 0.0000000123; el mayor asienta dos líneas
    // idénticas, así que la diferencia realizada tiene que ser CERO.
    const dif = diferenciaCambiariaRealizada({
      importePagado: '123.45',
      tasaHistorica: '17.1234567891',
      tasaPago: '17.1234567892',
    });
    expect(dif.tipo).toBe('ninguna');
    expect(dif.montoFuncional).toBe('0.0000');
  });
});

describe('desgloseCambiarioDelPago', () => {
  it('el pago simple cuadra: pasivo a tasa histórica, banco a tasa del día, y la brecha es la pérdida', () => {
    const d = desgloseCambiarioDelPago('1000', ctx('17.50', [
      { billId: 'b1', numero: 'BILL-1', aplicado: '1000', descuento: '0', tasaHistorica: '17.00' },
    ]));
    expect(d.pasivos).toHaveLength(1);
    expect(d.pasivos[0].montoFuncional).toBe('17000.0000');
    expect(d.bancoFuncional).toBe('17500.0000');
    expect(d.diferencia.tipo).toBe('perdida');
    expect(d.diferencia.montoFuncional).toBe('500.0000');
    // El asiento que estas cifras producen tiene que cuadrar: DR = CR.
    expect(Number(d.pasivos[0].montoFuncional) + Number(d.diferencia.montoFuncional)).toBe(
      Number(d.bancoFuncional)
    );
  });

  it('el espejo del desglose: banco a 16.50 deja utilidad de 500', () => {
    const d = desgloseCambiarioDelPago('1000', ctx('16.50', [
      { billId: 'b1', numero: 'BILL-1', aplicado: '1000', descuento: '0', tasaHistorica: '17.00' },
    ]));
    expect(d.diferencia.tipo).toBe('utilidad');
    expect(d.diferencia.montoFuncional).toBe('500.0000');
  });

  it('cada gasto se extingue a SU tasa: dos documentos, dos históricas, una sola diferencia', () => {
    const d = desgloseCambiarioDelPago('300', ctx('18.00', [
      { billId: 'b1', numero: 'BILL-1', aplicado: '100', descuento: '0', tasaHistorica: '17.00' },
      { billId: 'b2', numero: 'BILL-2', aplicado: '200', descuento: '0', tasaHistorica: '17.50' },
    ]));
    expect(d.pasivos.map((linea) => linea.montoFuncional)).toEqual(['1700.0000', '3500.0000']);
    expect(d.bancoFuncional).toBe('5400.0000');
    // 5400 − (1700 + 3500) = 200 de pérdida.
    expect(d.diferencia).toEqual({ tipo: 'perdida', montoFuncional: '200.0000' });
  });

  it('el descuento extingue pasivo a la tasa histórica y no fabrica diferencia propia', () => {
    // 900 de efectivo + 100 de descuento extinguen 1000 USD a 17.00; el
    // efectivo sale a 17.00 también: la única línea de resultado es el
    // descuento, no una diferencia cambiaria fantasma.
    const d = desgloseCambiarioDelPago('900', ctx('17.00', [
      { billId: 'b1', numero: 'BILL-1', aplicado: '900', descuento: '100', tasaHistorica: '17.00' },
    ]));
    expect(d.pasivos[0].montoFuncional).toBe('17000.0000'); // (900+100) × 17
    expect(d.descuentos[0].montoFuncional).toBe('1700.0000');
    expect(d.bancoFuncional).toBe('15300.0000');
    expect(d.diferencia.tipo).toBe('ninguna');
  });

  it('lo pagado de más queda de anticipo a la tasa del DÍA, sin diferencia: nada histórico se extinguió', () => {
    const d = desgloseCambiarioDelPago('1200', ctx('17.50', [
      { billId: 'b1', numero: 'BILL-1', aplicado: '1000', descuento: '0', tasaHistorica: '17.50' },
    ]));
    expect(d.anticipoExtranjero).toBe('200.0000');
    expect(d.anticipoFuncional).toBe('3500.0000'); // 200 × 17.50, tasa del pago
    expect(d.diferencia.tipo).toBe('ninguna');
  });
});
