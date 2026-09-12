import { describe, it, expect } from 'vitest';

import {
  readCtaCatalogo,
  normalizarAtributo,
} from '../../../src/services/sat/anexo24/catalog-reader.js';
import { construirCatalogoCuentas } from '../../../src/services/sat/anexo24/catalogo-cuentas.js';
import type { CuentaParaCatalogo } from '../../../src/services/sat/anexo24/catalogo-cuentas.js';
import { ValidationError } from '../../../src/utils/errors.js';

// ============================================================
// O1 · EL LECTOR DEL CtaCatalogo
//
// La prueba que manda de este archivo es la última: LA IDA Y LA VUELTA. Si el
// generador de este repositorio escribe un catálogo que este lector no
// devuelve idéntico, el sistema no puede releer lo que él mismo entrega, y
// ninguna de las demás pruebas importa.
// ============================================================

const NS = 'http://www.sat.gob.mx/esquemas/ContabilidadE/1_3/CatalogoCuentas';

function documento(filas: string, cabecera = 'Version="1.3" RFC="AAA010101AAA" Mes="01" Anio="2026"'): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<catalogocuentas:Catalogo xmlns:catalogocuentas="${NS}" ${cabecera}>\n${filas}\n` +
    `</catalogocuentas:Catalogo>`
  );
}

const FILA_ACTIVO = '<catalogocuentas:Ctas CodAgrup="100" NumCta="100" Desc="Activo" Nivel="1" Natur="D"/>';

describe('readCtaCatalogo · el archivo que no se puede leer', () => {
  it('rechaza el XML mal formado nombrando la línea, no un booleano', () => {
    expect(() => readCtaCatalogo('<Catalogo><Ctas></Catalogo>')).toThrowError(ValidationError);
    try {
      readCtaCatalogo('<Catalogo><Ctas></Catalogo>');
    } catch (e) {
      expect((e as Error).message).toContain('no es XML bien formado');
      expect((e as Error).message).toContain('línea');
    }
  });

  it('rechaza la balanza entregada por error, y NOMBRA la raíz que sí traía', () => {
    const balanza =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<BCE:Balanza xmlns:BCE="x" RFC="AAA010101AAA"><BCE:Ctas NumCta="100"/></BCE:Balanza>`;
    try {
      readCtaCatalogo(balanza);
      expect.unreachable('debía rechazarlo');
    } catch (e) {
      expect((e as Error).message).toContain('<Balanza>');
      expect((e as Error).message).toContain('<Catalogo>');
    }
  });

  it('rechaza el documento sin raíz de elementos', () => {
    expect(() => readCtaCatalogo('<?xml version="1.0"?><a/>')).toThrowError(/no es un catálogo/);
  });

  it('rechaza la cabecera sin RFC: sin él no se puede saber de quién es el archivo', () => {
    const xml = documento(FILA_ACTIVO, 'Version="1.3" Mes="01" Anio="2026"');
    expect(() => readCtaCatalogo(xml)).toThrowError(/no declara RFC/);
  });
});

describe('readCtaCatalogo · la cabecera', () => {
  it('lee versión, RFC, mes y año, y sube el RFC a mayúsculas', () => {
    const r = readCtaCatalogo(
      documento(FILA_ACTIVO, 'Version="1.3" RFC="aaa010101aaa" Mes="01" Anio="2026"')
    );
    expect(r.header).toEqual({ version: '1.3', rfc: 'AAA010101AAA', mes: '01', anio: '2026' });
    expect(r.puedeImportarse).toBe(true);
  });

  it('avisa —sin bloquear— de una versión que no es la 1.3', () => {
    const r = readCtaCatalogo(
      documento(FILA_ACTIVO, 'Version="1.1" RFC="AAA010101AAA" Mes="01" Anio="2026"')
    );
    expect(r.findings.map((f) => f.regla)).toContain('LEC-VERSION');
    expect(r.puedeImportarse).toBe(true);
  });

  it('avisa cuando el archivo no declara el espacio de nombres del catálogo', () => {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Catalogo Version="1.3" RFC="AAA010101AAA" Mes="01" Anio="2026">${FILA_ACTIVO.replace(
        /catalogocuentas:/g,
        ''
      )}</Catalogo>`;
    const r = readCtaCatalogo(xml);
    expect(r.findings.map((f) => f.regla)).toContain('LEC-SIN-ESPACIO-DE-NOMBRES');
    expect(r.rows).toHaveLength(1);
  });
});

describe('readCtaCatalogo · las filas, con número y campo', () => {
  it('lee una fila completa con su padre', () => {
    const r = readCtaCatalogo(
      documento(
        `${FILA_ACTIVO}\n<catalogocuentas:Ctas CodAgrup="101.01" NumCta="100-01" Desc="Caja" SubCtaDe="100" Nivel="2" Natur="D"/>`
      )
    );
    expect(r.rows).toEqual([
      { fila: 1, numCta: '100', desc: 'Activo', subCtaDe: null, codAgrup: '100', nivel: 1, natur: 'D' },
      {
        fila: 2,
        numCta: '100-01',
        desc: 'Caja',
        subCtaDe: '100',
        codAgrup: '101.01',
        nivel: 2,
        natur: 'D',
      },
    ]);
  });

  it('un solo nodo Ctas también es una lista, no un objeto suelto', () => {
    const r = readCtaCatalogo(documento(FILA_ACTIVO));
    expect(r.rows).toHaveLength(1);
    expect(r.rowsLeidas).toBe(1);
  });

  it.each([
    ['NumCta', '<catalogocuentas:Ctas CodAgrup="100" Desc="Activo" Nivel="1" Natur="D"/>', 'LEC-NUMCTA-AUSENTE'],
    ['Desc', '<catalogocuentas:Ctas CodAgrup="100" NumCta="100" Nivel="1" Natur="D"/>', 'LEC-DESC-AUSENTE'],
    ['Nivel', '<catalogocuentas:Ctas CodAgrup="100" NumCta="100" Desc="A" Nivel="uno" Natur="D"/>', 'LEC-NIVEL'],
    ['Natur', '<catalogocuentas:Ctas CodAgrup="100" NumCta="100" Desc="A" Nivel="1" Natur="X"/>', 'LEC-NATUR'],
  ])('%s defectuoso bloquea, dice la fila y dice el campo', (campo, fila, regla) => {
    const r = readCtaCatalogo(documento(`${FILA_ACTIVO}\n${fila}`));
    const h = r.findings.find((f) => f.regla === regla);
    expect(h).toBeDefined();
    expect(h?.severidad).toBe('bloquea');
    expect(h?.fila).toBe(2);
    expect(h?.campo).toBe(campo);
    expect(r.puedeImportarse).toBe(false);
    // La fila defectuosa NO entra: no se fabrica un valor que el archivo no trae.
    expect(r.rows.map((x) => x.fila)).toEqual([1]);
  });

  it('Nivel 0 no es un nivel', () => {
    const r = readCtaCatalogo(
      documento('<catalogocuentas:Ctas CodAgrup="100" NumCta="100" Desc="A" Nivel="0" Natur="D"/>')
    );
    expect(r.findings.map((f) => f.regla)).toContain('LEC-NIVEL');
  });

  it('NumCta duplicado bloquea y nombra LAS DOS filas', () => {
    const r = readCtaCatalogo(documento(`${FILA_ACTIVO}\n${FILA_ACTIVO}`));
    const h = r.findings.find((f) => f.regla === 'LEC-NUMCTA-DUPLICADO');
    expect(h?.mensaje).toContain('fila 2');
    expect(h?.mensaje).toContain('ya estaba en la 1');
    expect(r.puedeImportarse).toBe(false);
  });

  it('el agrupador ausente AVISA y no bloquea: es un hallazgo del informe', () => {
    const r = readCtaCatalogo(
      documento('<catalogocuentas:Ctas CodAgrup="" NumCta="100" Desc="Activo" Nivel="1" Natur="D"/>')
    );
    const h = r.findings.find((f) => f.regla === 'LEC-CODAGRUP-AUSENTE');
    expect(h?.severidad).toBe('aviso');
    expect(h?.fila).toBe(1);
    expect(r.puedeImportarse).toBe(true);
    expect(r.rows[0].codAgrup).toBe('');
  });

  it('un archivo sin ninguna cuenta se rehúsa en vez de informar de un éxito sin efecto', () => {
    const xml = `<?xml version="1.0"?><catalogocuentas:Catalogo xmlns:catalogocuentas="${NS}" Version="1.3" RFC="AAA010101AAA" Mes="01" Anio="2026"/>`;
    const r = readCtaCatalogo(xml);
    expect(r.findings.map((f) => f.regla)).toContain('LEC-VACIO');
    expect(r.puedeImportarse).toBe(false);
  });

  it('SubCtaDe vacío es SubCtaDe ausente, no un padre llamado ""', () => {
    const r = readCtaCatalogo(
      documento('<catalogocuentas:Ctas CodAgrup="100" NumCta="100" Desc="A" SubCtaDe="" Nivel="1" Natur="D"/>')
    );
    expect(r.rows[0].subCtaDe).toBeNull();
  });
});

describe('readCtaCatalogo · lo que la librería hace mal y aquí se corrige', () => {
  it('decodifica las referencias numéricas de carácter: "Cr&#233;dito" es "Crédito"', () => {
    // Sin `htmlEntities` fast-xml-parser deja la cadena literal `Cr&#233;dito`
    // y ese texto entraría a la base como nombre de la cuenta. Está medido en
    // la cabecera del módulo; esto es el trinquete.
    const r = readCtaCatalogo(
      documento(
        '<catalogocuentas:Ctas CodAgrup="100" NumCta="100" Desc="Cr&#233;dito al di&#233;sel" Nivel="1" Natur="D"/>'
      )
    );
    expect(r.rows[0].desc).toBe('Crédito al diésel');
    expect(r.rows[0].desc).not.toContain('&#');
  });

  it('decodifica también las entidades con nombre', () => {
    const r = readCtaCatalogo(
      documento('<catalogocuentas:Ctas CodAgrup="100" NumCta="100" Desc="Aceros &amp; C&#237;a" Nivel="1" Natur="D"/>')
    );
    expect(r.rows[0].desc).toBe('Aceros & Cía');
  });

  it('normaliza el salto de línea del atributo a espacio, como manda XML 1.0 §3.3.3, y lo dice', () => {
    const r = readCtaCatalogo(
      documento('<catalogocuentas:Ctas CodAgrup="100" NumCta="100" Desc="Caja&#10;y bancos" Nivel="1" Natur="D"/>')
    );
    expect(r.rows[0].desc).toBe('Caja y bancos');
    const h = r.findings.find((f) => f.regla === 'LEC-ATRIBUTO-NORMALIZADO');
    expect(h?.campo).toBe('Desc');
    expect(h?.severidad).toBe('aviso');
  });

  it('recorta el espacio del código y lo DENUNCIA: dos cuentas invisiblemente distintas', () => {
    const r = readCtaCatalogo(
      documento('<catalogocuentas:Ctas CodAgrup="100" NumCta=" 100 " Desc="Activo" Nivel="1" Natur="D"/>')
    );
    expect(r.rows[0].numCta).toBe('100');
    const h = r.findings.find((f) => f.regla === 'LEC-ATRIBUTO-CON-ESPACIOS');
    expect(h?.campo).toBe('NumCta');
    expect(h?.fila).toBe(1);
  });

  it('normalizarAtributo cambia los tres caracteres que la norma manda y dice si tocó algo', () => {
    expect(normalizarAtributo('a\tb\nc\rd')).toEqual({ texto: 'a b c d', normalizado: true });
    expect(normalizarAtributo('limpio')).toEqual({ texto: 'limpio', normalizado: false });
  });
});

describe('la ida y la vuelta contra el generador de esta misma casa', () => {
  const cuenta = (p: Partial<CuentaParaCatalogo> & { code: string }): CuentaParaCatalogo => ({
    name: p.name ?? `Cuenta ${p.code}`,
    account_level: p.account_level ?? 1,
    parent_code: p.parent_code ?? null,
    codigo_agrupador_sat: p.codigo_agrupador_sat ?? '100',
    normal_balance: p.normal_balance ?? 'debit',
    account_type: p.account_type ?? 'asset',
    lineas_posteadas: 0,
    naturaleza_agrupador: null,
    estado_agrupador: 'valido',
    code: p.code,
  });

  it('lo que construirCatalogoCuentas escribe, readCtaCatalogo lo devuelve campo por campo', () => {
    const construido = construirCatalogoCuentas({
      rfc: 'AAA010101AAA',
      anio: 2026,
      mes: 1,
      politicas: {
        niveles: 'jerarquia_completa',
        sinAgrupador: 'bloquear',
        sellado: 'nunca_sellar_en_el_sistema',
      },
      cuentas: [
        cuenta({ code: '100', name: 'Activo', codigo_agrupador_sat: '100' }),
        cuenta({
          code: '100-01',
          // Con acento y con ampersand: los dos viajan por el escapado del
          // constructor y los dos tienen que volver iguales.
          name: 'Caja & Bancos — Cía. de México',
          account_level: 2,
          parent_code: '100',
          codigo_agrupador_sat: '101.01',
        }),
        cuenta({
          code: '200',
          name: 'Proveedores',
          codigo_agrupador_sat: '201',
          normal_balance: 'credit',
          account_type: 'liability',
        }),
      ],
    });
    expect(construido.xml).not.toBeNull();

    const leido = readCtaCatalogo(construido.xml as string);

    expect(leido.header).toEqual({ version: '1.3', rfc: 'AAA010101AAA', mes: '01', anio: '2026' });
    expect(leido.puedeImportarse).toBe(true);
    // Ni un solo aviso: el archivo que esta casa emite se relee limpio.
    expect(leido.findings).toEqual([]);
    expect(leido.rows.map((r) => ({ ...r, fila: undefined }))).toEqual(
      construido.filas.map((f) => ({
        fila: undefined,
        numCta: f.NumCta,
        desc: f.Desc,
        subCtaDe: f.SubCtaDe ?? null,
        codAgrup: f.CodAgrup,
        nivel: f.Nivel,
        natur: f.Natur,
      }))
    );
  });
});
