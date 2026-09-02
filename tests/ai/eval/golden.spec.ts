import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cargarCasosGolden, type CasoGolden, type LineaEsperada } from '../../../src/ai/eval/golden.js';
import { CFDIParser } from '../../../src/services/xml-ingestion/cfdi-parser.js';
import { ROLE_MAP } from '../../../src/services/xml-ingestion/account-roles-seed.js';

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

// ============================================================
// B3 · UN ASIENTO PUEDE CUADRAR Y ESTAR MAL REPARTIDO
//
// El guardián de arriba SUMA todos los cargos y los compara con el bruto. Esa
// suma es ciega al reparto: un solo cargo de 32 480 al activo fijo —el IVA
// acreditable CAPITALIZADO dentro de la laptop— cuadra exactamente igual que
// 28 000 al activo más 4 480 al IVA. Y capitalizar el IVA acreditable no es un
// matiz de presentación: infla el activo, difiere por años vía depreciación un
// impuesto que se acredita este mes, y deja el acreditamiento del periodo
// corto. Es un error contable de verdad.
//
// Lo que sigue afirma el REPARTO, y lo hace sobre TODOS los casos draft del
// corpus, no sobre el que se acaba de añadir: el defecto es de clase, y un
// corpus que sólo vigilara su caso más nuevo volvería a bendecir el siguiente.
//
// Los códigos no se teclean: salen de ROLE_MAP, el mapa de roles que se
// SIEMBRA en cada entidad. Si mañana el catálogo renumera el IVA acreditable,
// este guardián lo sigue en vez de quedarse mirando un número que ya no existe.
// ============================================================

const CUENTAS_DE_IVA = new Set([ROLE_MAP.iva_acreditable, ROLE_MAP.iva_pendiente_acreditar]);
const CUENTAS_DE_RETENCION = new Set([
  ROLE_MAP.isr_retenido_por_pagar,
  ROLE_MAP.iva_retenido_por_pagar,
]);

const cerca = (a: number, b: number): boolean => Math.abs(a - b) <= 0.011;
const suma = (lineas: LineaEsperada[]): number =>
  lineas.reduce((acc, l) => acc + Number(l.monto), 0);
/** Una línea «es de IVA» sólo si TODOS sus códigos aceptables lo son: un
 *  ['1130','1210'] no cuela como cuenta de impuesto ni como cuenta de activo. */
const esDe = (conjunto: Set<string>) => (l: LineaEsperada): boolean =>
  l.cuenta.every((c) => conjunto.has(c));

describe('el reparto del asiento esperado, línea por línea', () => {
  const parser = new CFDIParser();
  const drafts = cargarCasosGolden(DIR).filter((c) => c.esperado.resultado === 'draft');

  it('el IVA trasladado viaja SOLO, en su cuenta y por su importe exacto', () => {
    let juzgados = 0;
    for (const caso of drafts) {
      const cfdi = parser.parse(caso.xml);
      const trasladados = cfdi.impuestos?.totalImpuestosTrasladados ?? 0;
      if (trasladados === 0) continue;
      juzgados++;
      const lineas = caso.esperado.asiento!;

      // 1 · UNA línea de IVA, y por el importe que trae el comprobante. Un
      // asiento que capitaliza el impuesto no tiene ninguna: muere aquí.
      const ivas = lineas.filter(esDe(CUENTAS_DE_IVA));
      expect(
        ivas.length,
        `${caso.nombre}: el IVA trasladado (${trasladados}) necesita su PROPIA línea en ` +
          `${[...CUENTAS_DE_IVA].join('/')} — fundirlo en otra cuenta lo capitaliza`
      ).toBe(1);
      const iva = ivas[0];
      expect(
        cerca(Number(iva.monto), trasladados),
        `${caso.nombre}: la línea de IVA dice ${iva.monto} y el CFDI traslada ${trasladados}`
      ).toBe(true);

      // 2 · Lo que acompaña al IVA en su mismo lado es la BASE, ni un peso
      // más: es la mitad que impide mover importe del impuesto al gasto.
      const base = cfdi.subTotal - (cfdi.descuento ?? 0);
      const acompañantes = lineas.filter((l) => l.lado === iva.lado && l !== iva);
      expect(acompañantes.length, `${caso.nombre}: el IVA no puede ir solo en su lado`)
        .toBeGreaterThan(0);
      expect(
        cerca(suma(acompañantes), base),
        `${caso.nombre}: la base esperada suma ${suma(acompañantes)} y el CFDI dice ${base}`
      ).toBe(true);

      // 3 · La contrapartida es lo que de verdad se mueve: el TOTAL del
      // comprobante, después de separar la retención en su cuenta.
      const contra = lineas.filter((l) => l.lado !== iva.lado);
      const retenidos = cfdi.impuestos?.totalImpuestosRetenidos ?? 0;
      const retenciones = contra.filter(esDe(CUENTAS_DE_RETENCION));
      expect(
        retenciones.length,
        `${caso.nombre}: ${retenidos > 0 ? 'la retención necesita su línea' : 'no hay retención que registrar'}`
      ).toBe(retenidos > 0 ? 1 : 0);
      if (retenidos > 0) {
        expect(cerca(Number(retenciones[0].monto), retenidos), caso.nombre).toBe(true);
      }
      const contrapartida = suma(contra.filter((l) => !retenciones.includes(l)));
      expect(
        cerca(contrapartida, cfdi.total),
        `${caso.nombre}: la contrapartida suma ${contrapartida} y el CFDI cobra ${cfdi.total}`
      ).toBe(true);
    }
    // Un filtro que no casa nada reporta éxito sobre cero: el corpus tiene
    // seis casos draft y todos traen IVA trasladado.
    expect(juzgados, 'ningún caso draft con IVA trasladado fue juzgado').toBeGreaterThanOrEqual(6);
  });

  it('el gemelo que CAPITALIZA manda el bien al activo fijo y el impuesto a su cuenta', () => {
    // El contraste del par de gemelos es el panel: con el umbral contestado, el
    // bien de 28 000 se capitaliza. Que se capitalice el BIEN es el criterio;
    // que se capitalice además el IMPUESTO es el error que el reparto de arriba
    // ya prohíbe, y que aquí se dice con nombre y apellido.
    const gemelo = drafts.filter(
      (c: CasoGolden) => c.esperado.precondicion?.politicas['umbral_capitalizacion_mxn']
    );
    expect(gemelo, 'el caso del umbral contestado desapareció del corpus').toHaveLength(1);
    const caso = gemelo[0];
    const cfdi = parser.parse(caso.xml);
    const lineas = caso.esperado.asiento!;

    const cargos = lineas.filter((l) => l.lado === 'cargo');
    const activo = cargos.filter((l) => !esDe(CUENTAS_DE_IVA)(l));
    expect(activo, `${caso.nombre}: un solo destino para el bien`).toHaveLength(1);
    // Al ACTIVO FIJO (o a una subcuenta suya), y explícitamente NO al gasto:
    // ésa es la respuesta que el panel contestado cambia.
    for (const codigo of activo[0].cuenta) {
      expect(codigo.startsWith(ROLE_MAP.activo_fijo.slice(0, 2)), `${codigo} no es activo fijo`).toBe(true);
      expect(codigo).not.toBe(ROLE_MAP.gasto);
    }
    expect(Number(activo[0].monto)).toBeCloseTo(cfdi.subTotal, 2);

    const iva = cargos.filter(esDe(CUENTAS_DE_IVA));
    expect(iva, `${caso.nombre}: el IVA acreditable, en su cuenta`).toHaveLength(1);
    expect(Number(iva[0].monto)).toBeCloseTo(cfdi.impuestos!.totalImpuestosTrasladados!, 2);

    // Y el abono a BANCOS, no a proveedores: es PUE, se pagó de una vez.
    const abonos = lineas.filter((l) => l.lado === 'abono');
    expect(abonos, `${caso.nombre}: una sola contrapartida`).toHaveLength(1);
    for (const codigo of abonos[0].cuenta) {
      expect(codigo.startsWith(ROLE_MAP.banco.slice(0, 3)), `${codigo} no es una cuenta de bancos`).toBe(true);
      expect(codigo, 'PUE no deja cuenta por pagar').not.toBe(ROLE_MAP.cxp);
    }
    expect(Number(abonos[0].monto)).toBeCloseTo(cfdi.total, 2);
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
