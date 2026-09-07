import { describe, it, expect } from 'vitest';
import { XMLParser } from 'fast-xml-parser';
import {
  serializar,
  exigirValorDeAtributo,
  importeAnexo24,
  bytesDe,
  type NodoXml,
} from '../../../src/services/sat/anexo24/xml.js';
import { ValidationError } from '../../../src/utils/errors.js';

// ============================================================
// F07b · EL CONSTRUCTOR
//
// Estas pruebas no comprueban que fast-xml-parser funcione: comprueban lo
// contrario, que las tres cosas que SE MIDIÓ que hace mal no puedan llegar al
// archivo. Cada una lleva escrito el defecto que caza.
// ============================================================

const nodo = (nombre: string, atributos: [string, string | undefined][], hijos?: NodoXml[]): NodoXml =>
  hijos === undefined ? { nombre, atributos } : { nombre, atributos, hijos };

describe('el constructor de XML del Anexo 24', () => {
  describe('lo que el Anexo 24 exige de la forma', () => {
    it('emite la declaración con UTF-8, los prefijos de espacio de nombres y el nodo vacío autocerrado', () => {
      const xml = serializar(
        nodo(
          'catalogocuentas:Catalogo',
          [
            ['xmlns:catalogocuentas', 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas'],
            ['Version', '1.3'],
          ],
          [nodo('catalogocuentas:Ctas', [['NumCta', '100']])]
        )
      );

      expect(xml).toBe(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<catalogocuentas:Catalogo xmlns:catalogocuentas="http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas" Version="1.3">\n' +
          '  <catalogocuentas:Ctas NumCta="100"/>\n' +
          '</catalogocuentas:Catalogo>\n'
      );
    });

    it('conserva el orden en que se declaran los atributos y NO los ordena alfabéticamente', () => {
      // El orden de atributos no lo puede exigir un XSD —la recomendación XML
      // los declara sin orden—, pero sí lo exige `generate`: bytes idénticos
      // para entradas idénticas es como un humano diffea la presentación de
      // este mes contra la del anterior.
      const xml = serializar(
        nodo('r', [
          ['zeta', '1'],
          ['alfa', '2'],
          ['Nivel', '3'],
        ])
      );
      expect(xml).toContain('<r zeta="1" alfa="2" Nivel="3"/>');
      expect(xml.indexOf('zeta')).toBeLessThan(xml.indexOf('alfa'));
    });

    it('omite el atributo opcional ausente en vez de emitirlo vacío', () => {
      // SubCtaDe ausente NO es SubCtaDe="": lo segundo declara que la cuenta
      // cuelga de una cuenta sin número.
      const xml = serializar(
        nodo('Ctas', [
          ['NumCta', '100'],
          ['SubCtaDe', undefined],
          ['Nivel', '1'],
        ])
      );
      expect(xml).toContain('<Ctas NumCta="100" Nivel="1"/>');
      expect(xml).not.toContain('SubCtaDe');
    });

    it('produce los MISMOS bytes para las mismas entradas', () => {
      const construir = (): string =>
        serializar(
          nodo('raiz', [['a', '1']], [nodo('h', [['b', '2']]), nodo('h', [['b', '3']])])
        );
      expect(bytesDe(construir()).equals(bytesDe(construir()))).toBe(true);
    });
  });

  describe('el escapado, que es la razón de no usar plantilla de cadena', () => {
    it('escapa el ampersand, los ángulos y las comillas sin que el llamador tenga que acordarse', () => {
      const xml = serializar(nodo('c', [['Desc', 'Aceros & Cía <"S.A.">']]));
      expect(xml).toContain('Desc="Aceros &amp; Cía &lt;&quot;S.A.&quot;&gt;"');
    });

    it('escapa una entidad que ya venía escrita, en vez de dejarla pasar', () => {
      // "&amp;" en el dato es el texto de cinco caracteres, no un ampersand:
      // si saliera tal cual, al leerlo el SAT vería "&" y el nombre cambiaría.
      const xml = serializar(nodo('c', [['Desc', '&amp;']]));
      expect(xml).toContain('Desc="&amp;amp;"');
    });

    it('sobrevive la ida y vuelta: lo que se escribe es lo que se lee', () => {
      const original = 'Aceros & Cía <"S.A."> ñ';
      const xml = serializar(nodo('c', [['Desc', original]]));
      const leido: unknown = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(xml);
      expect((leido as { c: { '@_Desc': string } }).c['@_Desc']).toBe(original);
    });
  });

  describe('los tres defectos medidos de XMLBuilder, cerrados en la puerta', () => {
    it('rechaza el salto de línea dentro de un atributo, que ningún parser conforme devuelve intacto', () => {
      // MEDIDO: XMLBuilder emite el salto CRUDO y XMLValidator lo aprueba.
      // XML 1.0 §3.3.3 obliga a todo analizador conforme a sustituir #xA por
      // un espacio al leer el atributo, así que el SAT recibiría un texto
      // distinto del que se firmó. El XMLParser de esta misma librería NO
      // normaliza y devuelve el salto: una prueba de ida y vuelta contra la
      // propia librería daría verde. Por eso la puerta no confía en ella.
      expect(() => serializar(nodo('c', [['Desc', 'Caja\ny bancos']]))).toThrow(ValidationError);
      expect(() => serializar(nodo('c', [['Desc', 'Caja\ty bancos']]))).toThrow(/tabulador/);
      expect(() => serializar(nodo('c', [['Desc', 'Caja\ry bancos']]))).toThrow(ValidationError);
    });

    it('rechaza los caracteres de control que XML 1.0 prohíbe y que XMLValidator aprueba', () => {
      // MEDIDO: con un #x00 y un #x0B dentro de un atributo, XMLBuilder los
      // deja pasar y XMLValidator.validate() devuelve true. El único chequeo
      // de XML que hoy existe en el repositorio bendeciría un archivo que
      // ningún analizador puede leer.
      expect(() => serializar(nodo('c', [['Desc', 'a\u0000b']]))).toThrow(/U\+0000/);
      expect(() => serializar(nodo('c', [['Desc', 'a\u000Bb']]))).toThrow(/U\+000B/);
    });

    it('rechaza el sustituto suelto, que al archivar se convertiría en otro byte', () => {
      // Buffer.from(xml, 'utf8') sustituye un sustituto suelto por U+FFFD: el
      // hash se calcularía sobre unos bytes distintos de los que el
      // constructor creyó emitir.
      expect(() => serializar(nodo('c', [['Desc', 'a\uD800b']]))).toThrow(/U\+D800/);
    });

    it('rechaza un valor que no sea cadena, porque el número pierde el centavo antes del XML', () => {
      // MEDIDO: {'@_f': 1.10} sale f="1.1".
      expect(() => exigirValorDeAtributo('Ctas', 'Saldo', 1.1)).toThrow(/ha de ser cadena/);
      expect(() => exigirValorDeAtributo('Ctas', 'Saldo', null)).toThrow(ValidationError);
    });
  });

  describe('el orden de la secuencia de elementos, que el XSD sí puede exigir', () => {
    it('rechaza hijos del mismo nombre no contiguos en vez de reagruparlos en silencio', () => {
      const raiz = nodo('r', [], [nodo('a', []), nodo('b', []), nodo('a', [])]);
      expect(() => serializar(raiz)).toThrow(/no están contiguos/);
    });

    it('conserva el orden entre nombres distintos cuando cada bloque va junto', () => {
      const xml = serializar(nodo('r', [], [nodo('b', []), nodo('b', []), nodo('a', [])]));
      expect(xml.indexOf('<b/>')).toBeLessThan(xml.indexOf('<a/>'));
    });
  });

  describe('los importes', () => {
    it('pasa de los cuatro decimales de la casa a los dos del Anexo 24', () => {
      expect(importeAnexo24('1234.5600').texto).toBe('1234.56');
      expect(importeAnexo24('0').texto).toBe('0.00');
      expect(importeAnexo24('-42.5').texto).toBe('-42.50');
    });

    it('redondea mitad arriba en valor absoluto y NO se traga el residuo', () => {
      const a = importeAnexo24('0.1250');
      expect(a.texto).toBe('0.13');
      expect(a.redondeado).toBe(true);
      expect(a.residuo).toBe('-0.005');

      const b = importeAnexo24('-0.1250');
      expect(b.texto).toBe('-0.13');
      expect(b.residuo).toBe('0.005');
    });

    it('dice que no hubo residuo cuando no lo hubo', () => {
      const r = importeAnexo24('100.0000');
      expect(r.redondeado).toBe(false);
      expect(r.residuo).toBe('0');
    });

    it('el residuo es lo que rompe la invariante de la balanza, y por eso viaja', () => {
      // Cuatro cifras que cuadran EXACTAMENTE con cuatro decimales…
      const saldoIni = '0.0050';
      const debe = '0.0050';
      const haber = '0.0000';
      const saldoFin = '0.0100';
      // …y que redondeadas por separado dejan de cuadrar: 0.01 + 0.01 − 0.00
      // = 0.02, contra un SaldoFin de 0.01. Un centavo, y el SAT rehace esta
      // resta sobre el archivo sellado.
      const r = (s: string): number => Number(importeAnexo24(s).texto);
      expect(r(saldoIni) + r(debe) - r(haber)).not.toBe(r(saldoFin));
      // Lo que salva a quien genere la balanza es que el residuo se ve:
      expect(importeAnexo24(saldoIni).redondeado).toBe(true);
    });

    it('rechaza un importe que no es número en vez de emitir NaN', () => {
      expect(() => importeAnexo24('no-es-un-importe')).toThrow(ValidationError);
      expect(() => importeAnexo24('Infinity')).toThrow(ValidationError);
    });
  });
});
