import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cargarCasosGolden } from '../../../src/ai/eval/golden.js';
import { CFDIParser } from '../../../src/services/xml-ingestion/cfdi-parser.js';

// ============================================================
// El corpus golden se valida DETERMINISTA en cada corrida de la suite:
// un XML que no pasa el validador del parser, un UUID repetido o un
// esperado descuadrado convertirían el eval en una vara chueca — y eso
// se descubre aquí, sin modelo y sin base, no a mitad de una corrida
// con proveedor real.
// ============================================================

const DIR = path.resolve(__dirname, '../../golden/cfdi');

describe('el corpus golden', () => {
  const casos = cargarCasosGolden(DIR);

  it('tiene al menos los nueve casos comprometidos por A1', () => {
    expect(casos.length).toBeGreaterThanOrEqual(9);
  });

  it('cubre los tres resultados: clasificar, preguntar y la ruta determinista', () => {
    const resultados = new Set(casos.map((c) => c.esperado.resultado));
    expect(resultados.has('draft')).toBe(true);
    expect(resultados.has('pregunta')).toBe(true);
    expect(resultados.has('determinista')).toBe(true);
  });

  it('cubre PUE, PPD, retenciones y un caso hostil marcado', () => {
    const tratamientos = new Set(casos.map((c) => c.esperado.tratamiento));
    expect(tratamientos.has('PUE')).toBe(true);
    expect(tratamientos.has('PPD')).toBe(true);
    expect(casos.some((c) => c.esperado.sospecha)).toBe(true);
    expect(
      casos.some((c) => c.esperado.asiento?.some((l) => l.cuenta.includes('2140')))
    ).toBe(true);
  });

  it('cada XML pasa el validador real del parser (timbre, RFCs, cuadres ±0.01)', () => {
    const parser = new CFDIParser();
    for (const caso of casos) {
      const cfdi = parser.parse(caso.xml);
      const v = parser.validate(cfdi);
      expect(v.errors, `${caso.nombre}: ${v.errors.join('; ')}`).toEqual([]);
      expect(v.valid, caso.nombre).toBe(true);
    }
  });

  it('los UUID del timbre son únicos: el dedupe por UUID no debe cruzar casos', () => {
    const parser = new CFDIParser();
    const uuids = casos.map((c) => parser.parse(c.xml).timbreFiscalDigital?.uuid);
    expect(uuids.every(Boolean)).toBe(true);
    expect(new Set(uuids).size).toBe(uuids.length);
  });

  it('el caso determinista es un CFDI tipo P: la ruta que jamás toca al modelo', () => {
    const parser = new CFDIParser();
    for (const caso of casos.filter((c) => c.esperado.resultado === 'determinista')) {
      expect(parser.parse(caso.xml).tipoDeComprobante, caso.nombre).toBe('P');
    }
  });

  it('el asiento esperado de cada draft cuadra contra el BRUTO del propio CFDI', () => {
    // Los cargos igualan subtotal + trasladados (el bruto), no el total: con
    // retenciones, el total neto es bruto − retenido y la diferencia vive en
    // el abono a 2140. El cuadre cargos==abonos ya lo exige el cargador.
    const parser = new CFDIParser();
    for (const caso of casos.filter((c) => c.esperado.resultado === 'draft')) {
      const cfdi = parser.parse(caso.xml);
      const bruto =
        cfdi.subTotal - (cfdi.descuento ?? 0) +
        (cfdi.impuestos?.totalImpuestosTrasladados ?? 0);
      const cargos = caso.esperado
        .asiento!.filter((l) => l.lado === 'cargo')
        .reduce((a, l) => a + Number(l.monto), 0);
      expect(Math.abs(cargos - bruto), caso.nombre).toBeLessThanOrEqual(0.011);
    }
  });
});

describe('cargarCasosGolden rechaza corpus chuecos', () => {
  const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'golden-'));

  it('un xml sin esperado rompe la carga', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'suelto.xml'), '<x/>');
    expect(() => cargarCasosGolden(d)).toThrow(/sin esperado/);
  });

  it('un esperado descuadrado rompe la carga', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'malo.xml'), '<x/>');
    fs.writeFileSync(
      path.join(d, 'malo.esperado.json'),
      JSON.stringify({
        caso: 'malo', resultado: 'draft', tratamiento: null, sospecha: false,
        asiento: [
          { cuenta: ['6100'], lado: 'cargo', monto: '100.00' },
          { cuenta: ['1110'], lado: 'abono', monto: '90.00' },
        ],
        nota: '',
      })
    );
    expect(() => cargarCasosGolden(d)).toThrow(/no cuadra/);
  });

  it('pedir un caso que no existe es error, no un filtro silencioso', () => {
    expect(() => cargarCasosGolden(DIR, ['no-existe'])).toThrow(/no existen/);
  });
});
