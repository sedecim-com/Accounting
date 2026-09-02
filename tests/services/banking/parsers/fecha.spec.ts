import { describe, it, expect } from 'vitest';
import {
  analizarFecha,
  fechaDeOperacionMt940,
} from '../../../../src/services/banking/parsers/fecha.js';

describe('analizarFecha con formato declarado', () => {
  it('lee DD/MM/YYYY', () => {
    expect(analizarFecha('05/01/2026', 'DD/MM/YYYY')).toEqual({ ok: true, valor: '2026-01-05' });
  });

  it('lee MM/DD/YYYY sin confundirlo con el anterior', () => {
    expect(analizarFecha('05/01/2026', 'MM/DD/YYYY')).toEqual({ ok: true, valor: '2026-05-01' });
  });

  it('tolera un dígito donde el formato declara dos, si hay separador', () => {
    expect(analizarFecha('5/1/2026', 'DD/MM/YYYY')).toEqual({ ok: true, valor: '2026-01-05' });
  });

  it('lee el mes en letras, con y sin acento, en español y en inglés', () => {
    expect(analizarFecha('15-ENE-2026', 'DD-MMM-YYYY')).toEqual({ ok: true, valor: '2026-01-15' });
    expect(analizarFecha('15-dic-2026', 'DD-MMM-YYYY')).toEqual({ ok: true, valor: '2026-12-15' });
    expect(analizarFecha('15-MAR-2026', 'DD-MMM-YYYY')).toEqual({ ok: true, valor: '2026-03-15' });
  });

  it('lee YYMMDD con la bisagra de siglo de la banca', () => {
    expect(analizarFecha('260105', 'YYMMDD')).toEqual({ ok: true, valor: '2026-01-05' });
    expect(analizarFecha('980105', 'YYMMDD')).toEqual({ ok: true, valor: '1998-01-05' });
  });

  it('exige ancho exacto cuando el formato no tiene separadores', () => {
    expect(analizarFecha('2610', 'YYMMDD')).toMatchObject({ ok: false });
  });

  it('rechaza la fecha que tiene forma pero no existe en el calendario', () => {
    const r = analizarFecha('31/02/2026', 'DD/MM/YYYY');
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.motivo).toMatch(/calendario/);
  });

  it('acepta el 29 de febrero sólo en año bisiesto', () => {
    expect(analizarFecha('29/02/2024', 'DD/MM/YYYY')).toEqual({ ok: true, valor: '2024-02-29' });
    expect(analizarFecha('29/02/2026', 'DD/MM/YYYY')).toMatchObject({ ok: false });
  });

  it('rechaza el texto que no tiene la forma declarada', () => {
    expect(analizarFecha('no-es-fecha', 'DD/MM/YYYY')).toMatchObject({ ok: false });
    expect(analizarFecha('', 'DD/MM/YYYY')).toMatchObject({ ok: false });
  });
});

describe('analizarFecha en automático', () => {
  it('reconoce el ISO y le quita la hora', () => {
    expect(analizarFecha('2026-01-05')).toEqual({ ok: true, valor: '2026-01-05' });
    expect(analizarFecha('2026-01-05T14:30:00-06:00')).toEqual({ ok: true, valor: '2026-01-05' });
  });

  it('desambigua sola cuando el propio número lo permite', () => {
    expect(analizarFecha('25/12/2026')).toEqual({ ok: true, valor: '2026-12-25' });
    expect(analizarFecha('12/25/2026')).toEqual({ ok: true, valor: '2026-12-25' });
  });

  it('CONFIESA la fecha ambigua en vez de elegir en silencio', () => {
    const r = analizarFecha('03/04/2026');
    expect(r).toMatchObject({ ok: true, valor: '2026-04-03' });
    expect(r.ok && r.aviso).toMatch(/ambigua/);
    expect(r.ok && r.aviso).toMatch(/formatoFecha/);
  });

  it('lee YYYYMMDD y el mes en letras', () => {
    expect(analizarFecha('20260105')).toEqual({ ok: true, valor: '2026-01-05' });
    expect(analizarFecha('5-ENE-26')).toEqual({ ok: true, valor: '2026-01-05' });
  });

  it('se rinde con lo que no reconoce', () => {
    expect(analizarFecha('05.01.26.99')).toMatchObject({ ok: false });
    expect(analizarFecha('ayer')).toMatchObject({ ok: false });
  });
});

describe('fechaDeOperacionMt940', () => {
  it('toma el año de la fecha valor', () => {
    expect(fechaDeOperacionMt940('2026-01-05', '0105')).toEqual({ ok: true, valor: '2026-01-05' });
  });

  it('retrocede un año cuando la operación fue en diciembre y el valor en enero', () => {
    expect(fechaDeOperacionMt940('2026-01-02', '1231')).toEqual({ ok: true, valor: '2025-12-31' });
  });

  it('avanza un año cuando la operación es de enero y el valor de diciembre', () => {
    expect(fechaDeOperacionMt940('2025-12-30', '0102')).toEqual({ ok: true, valor: '2026-01-02' });
  });

  it('rechaza un MMDD imposible', () => {
    expect(fechaDeOperacionMt940('2026-01-05', '0230')).toMatchObject({ ok: false });
    expect(fechaDeOperacionMt940('2026-01-05', '11')).toMatchObject({ ok: false });
  });
});
