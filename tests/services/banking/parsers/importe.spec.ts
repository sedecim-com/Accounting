import { describe, it, expect } from 'vitest';
import {
  analizarImporte,
  combinarCargoAbono,
} from '../../../../src/services/banking/parsers/importe.js';

// ============================================================
// EL DINERO DE TEXTO A STRING
//
// La mitad de estas pruebas existe para fijar los casos donde `parseFloat`
// habría contestado algo, y algo equivocado: «1,234.56» (contesta 1),
// «(500.00)» (contesta NaN) y «1.234» (contesta 1.234 donde el banco escribió
// mil doscientos treinta y cuatro).
// ============================================================

describe('analizarImporte', () => {
  it('lee el separador de miles con punto decimal', () => {
    const r = analizarImporte('1,234.56', { separadorDecimal: '.' });
    expect(r).toEqual({ ok: true, valor: '1234.56', aviso: undefined });
  });

  it('lee el separador de miles con coma decimal', () => {
    const r = analizarImporte('1.234,56', { separadorDecimal: ',' });
    expect(r).toEqual({ ok: true, valor: '1234.56', aviso: undefined });
  });

  it('con los dos separadores presentes, el de la derecha es el decimal', () => {
    expect(analizarImporte('1.234.567,89')).toMatchObject({ ok: true, valor: '1234567.89' });
    expect(analizarImporte('1,234,567.89')).toMatchObject({ ok: true, valor: '1234567.89' });
  });

  it('confiesa la ambigüedad de un separador solo con tres dígitos detrás', () => {
    const r = analizarImporte('1.234');
    expect(r).toMatchObject({ ok: true, valor: '1234.00' });
    expect(r.ok && r.aviso).toMatch(/ambiguo/);
  });

  it('no la confiesa cuando el perfil ya fijó el separador', () => {
    const r = analizarImporte('1.234', { separadorDecimal: ',' });
    expect(r).toEqual({ ok: true, valor: '1234.00', aviso: undefined });
  });

  it('rechaza el importe que contradice el separador declarado por el perfil', () => {
    const r = analizarImporte('1.234,56', { separadorDecimal: '.' });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.motivo).toMatch(/contradice/);
  });

  it('rechaza una agrupación de miles imposible en vez de leerla a medias', () => {
    const r = analizarImporte('1,2345.67', { separadorDecimal: '.' });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.motivo).toMatch(/agrupación/);
  });

  it('lee el negativo con signo delante, detrás y entre paréntesis', () => {
    expect(analizarImporte('-1,234.56')).toMatchObject({ ok: true, valor: '-1234.56' });
    expect(analizarImporte('1,234.56-')).toMatchObject({ ok: true, valor: '-1234.56' });
    expect(analizarImporte('(1,234.56)')).toMatchObject({ ok: true, valor: '-1234.56' });
    expect(analizarImporte('1234.56DR')).toMatchObject({ ok: true, valor: '-1234.56' });
    expect(analizarImporte('1234.56CR')).toMatchObject({ ok: true, valor: '1234.56' });
  });

  it('no deja pasar el paréntesis como negativo si el perfil lo apaga', () => {
    const r = analizarImporte('(500.00)', { parentesisNegativo: false });
    expect(r).toMatchObject({ ok: false });
  });

  it('quita el símbolo y el código de moneda pegados al número', () => {
    expect(analizarImporte('$1,234.56')).toMatchObject({ ok: true, valor: '1234.56' });
    expect(analizarImporte('1,234.56 MXN')).toMatchObject({ ok: true, valor: '1234.56' });
    expect(analizarImporte('1,234.56 M.N.')).toMatchObject({ ok: true, valor: '1234.56' });
  });

  it('rechaza el texto que no es un importe en vez de quedarse con sus dígitos', () => {
    expect(analizarImporte('1,234.56 ACME')).toMatchObject({ ok: false });
    expect(analizarImporte('N/A')).toMatchObject({ ok: false });
    expect(analizarImporte('  ')).toMatchObject({ ok: false });
    expect(analizarImporte('-')).toMatchObject({ ok: false });
  });

  it('mata el cero negativo, que después no compara igual contra la base', () => {
    expect(analizarImporte('-0.00')).toMatchObject({ ok: true, valor: '0.00' });
  });

  it('normaliza siempre a dos decimales como mínimo', () => {
    expect(analizarImporte('500')).toMatchObject({ ok: true, valor: '500.00' });
    expect(analizarImporte('500.5')).toMatchObject({ ok: true, valor: '500.50' });
    expect(analizarImporte('.75')).toMatchObject({ ok: true, valor: '0.75' });
  });

  it('conserva hasta cuatro decimales y avisa cuando redondea', () => {
    expect(analizarImporte('1.2345')).toMatchObject({ ok: true, valor: '1.2345' });
    const r = analizarImporte('1.23456');
    expect(r).toMatchObject({ ok: true, valor: '1.2346' });
    expect(r.ok && r.aviso).toMatch(/se redondeó/);
  });

  it('rechaza lo que no cabe en DECIMAL(19,4)', () => {
    const r = analizarImporte('1000000000000000.00', { separadorDecimal: '.' });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.motivo).toMatch(/DECIMAL\(19,4\)/);
  });

  it('invierte el signo cuando el perfil lo pide', () => {
    expect(analizarImporte('100.00', { invertirSigno: true })).toMatchObject({
      ok: true,
      valor: '-100.00',
    });
  });
});

describe('combinarCargoAbono', () => {
  it('el cargo sale negativo y el abono positivo', () => {
    expect(combinarCargoAbono('1,500.00', '', { separadorDecimal: '.' })).toMatchObject({
      ok: true,
      valor: '-1500.00',
    });
    expect(combinarCargoAbono('', '2,000.00', { separadorDecimal: '.' })).toMatchObject({
      ok: true,
      valor: '2000.00',
    });
  });

  it('un cargo que YA venía en negativo no se niega dos veces', () => {
    expect(combinarCargoAbono('-1500.00', '', { separadorDecimal: '.' })).toMatchObject({
      ok: true,
      valor: '-1500.00',
    });
  });

  it('trata el 0.00 de relleno como columna ausente', () => {
    expect(combinarCargoAbono('0.00', '750.00', { separadorDecimal: '.' })).toMatchObject({
      ok: true,
      valor: '750.00',
    });
  });

  it('se niega cuando las dos columnas traen importe: la fila no dice el sentido', () => {
    const r = combinarCargoAbono('100.00', '200.00', { separadorDecimal: '.' });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.motivo).toMatch(/en qué sentido/);
  });

  it('se niega cuando ninguna de las dos trae importe', () => {
    expect(combinarCargoAbono('', '', { separadorDecimal: '.' })).toMatchObject({ ok: false });
  });

  it('deja pasar el movimiento de cero, pero avisando', () => {
    const r = combinarCargoAbono('0.00', '0.00', { separadorDecimal: '.' });
    expect(r).toMatchObject({ ok: true, valor: '0.00' });
    expect(r.ok && r.aviso).toMatch(/cero/);
  });

  it('propaga el motivo del lado que falló, diciendo cuál era', () => {
    const r = combinarCargoAbono('x', '', { separadorDecimal: '.' });
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.motivo).toMatch(/^cargo: /);
  });
});
