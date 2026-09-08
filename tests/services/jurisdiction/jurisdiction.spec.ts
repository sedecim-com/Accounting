import { describe, it, expect } from 'vitest';
import {
  jurisdictionOf,
  keepsMexicanBooks,
  sqlKeepsMexicanBooks,
  type Jurisdiction,
} from '../../../src/services/jurisdiction/jurisdiction.js';

// ============================================================
// LA TABLA DE VERDAD DEL CONMUTADOR
//
// El conmutador sustituye a cuatro predicados escritos a mano que coincidían
// en el caso normal y diferían en los bordes. Los bordes son, entonces, lo
// único que vale la pena fijar: el caso normal ya lo cubría cualquiera de las
// cuatro copias, y es justamente por eso que nadie notó que eran cuatro.
//
// `incorporation_country` es `CHAR(2) NOT NULL` SIN CHECK de valor
// (001_core_schema.sql), así que la base admite: dos espacios en blanco —así
// almacena bpchar la cadena vacía—, minúsculas, y cualquier tercer país. Lo
// que la base NO admite es 'USA' (tres caracteres) ni NULL; se prueban igual
// porque la firma los acepta y una consulta puede no traer la columna.
// ============================================================

/** Un renglón de la tabla, para que el caso se lea entero en el error. */
function caseOf(country: string | null | undefined, standard: string | null | undefined): Jurisdiction {
  return jurisdictionOf({ incorporation_country: country, accounting_standard: standard });
}

describe('jurisdictionOf — los dos países por las tres normas', () => {
  it('México con cada una de las tres normas: la norma manda sobre los libros, el país sobre lo fiscal', () => {
    expect(caseOf('MX', 'mx_nif')).toEqual({ fiscal: 'MX', books: 'mx_nif', legalCurrency: 'MXN' });
    expect(caseOf('MX', 'us_gaap')).toEqual({ fiscal: 'MX', books: 'us_gaap', legalCurrency: 'MXN' });
    expect(caseOf('MX', 'ifrs')).toEqual({ fiscal: 'MX', books: 'ifrs', legalCurrency: 'MXN' });
  });

  it('Estados Unidos con cada una de las tres normas', () => {
    expect(caseOf('US', 'us_gaap')).toEqual({ fiscal: 'US', books: 'us_gaap', legalCurrency: 'USD' });
    expect(caseOf('US', 'mx_nif')).toEqual({ fiscal: 'US', books: 'mx_nif', legalCurrency: 'USD' });
    expect(caseOf('US', 'ifrs')).toEqual({ fiscal: 'US', books: 'ifrs', legalCurrency: 'USD' });
  });

  /**
   * ESTE ES EL TRAMO ENTERO. Con un booleano hay una sola respuesta y hay que
   * equivocarse en uno de los dos ejes: hoy `keepsMexicanBooks` dice
   * «mexicana» de esta filial y con eso le siembra a una sociedad de Delaware
   * el estrato fiscal del SAT completo. La jurisdicción separa las dos: sus
   * libros se llevan en NIF —reconocimiento y medición mexicanos, que es lo
   * que el despacho hace— y su autoridad fiscal es la estadounidense, que es
   * de quien recibe formatos, calendario y umbrales.
   */
  it('la filial de Delaware con libros en NIF: fiscal US y libros mx_nif, que es el caso que el booleano colapsa', () => {
    expect(caseOf('US', 'mx_nif')).toEqual({ fiscal: 'US', books: 'mx_nif', legalCurrency: 'USD' });
  });

  it('y su simétrica: la mexicana que reporta al corporativo en US GAAP sigue siendo fiscalmente mexicana', () => {
    expect(caseOf('MX', 'us_gaap')).toEqual({ fiscal: 'MX', books: 'us_gaap', legalCurrency: 'MXN' });
  });
});

describe('jurisdictionOf — los bordes del país', () => {
  it('nulo, indefinido, vacío y en blanco caen en México: ante la duda, mexicana', () => {
    for (const country of [null, undefined, '', '  ']) {
      expect(caseOf(country, null).fiscal).toBe('MX');
    }
    // Sin país y sin norma, la norma la deduce el país: mx_nif.
    expect(jurisdictionOf({})).toEqual({ fiscal: 'MX', books: 'mx_nif', legalCurrency: 'MXN' });
  });

  it('la escritura no decide: minúsculas y espacios alrededor dan la misma entidad', () => {
    expect(caseOf('mx', null).fiscal).toBe('MX');
    expect(caseOf(' MX ', null).fiscal).toBe('MX');
    expect(caseOf('us', null).fiscal).toBe('US');
    expect(caseOf(' us ', null).fiscal).toBe('US');
  });

  /**
   * 'USA' no cabe en `CHAR(2)` y por la tabla no llega — pero el asistente y
   * `COUNTRY_PROFILES` nombran así al país, y ese alias ya causó un defecto
   * real: `chartFor` comparaba contra 'USA' contra la columna de dos
   * caracteres y por eso jamás devolvía el catálogo de nómina estadounidense
   * (payroll-account-mapping-seed.ts:258-271). Si el conmutador reconociera
   * sólo 'US', migrar aquel código lo reintroduciría con otro nombre.
   */
  it('acepta el alias USA además del alfa-2, porque el producto usa las dos grafías', () => {
    expect(caseOf('USA', null).fiscal).toBe('US');
    expect(caseOf('usa', null).legalCurrency).toBe('USD');
  });

  /**
   * Un tercer país no tiene dónde caer: `JurisdictionCode` tiene dos
   * valores y la base guarda cualquier par de caracteres. Cae en el del
   * motor, que es la regla del §3.1(b). Lo que NO hace es arrastrar a
   * `keepsMexicanBooks` consigo — ver la tabla de abajo.
   */
  it('un tercer país cae en MX por la regla de la casa, no por descuido', () => {
    expect(caseOf('CA', 'us_gaap')).toEqual({ fiscal: 'MX', books: 'us_gaap', legalCurrency: 'MXN' });
    expect(caseOf('ES', 'ifrs')).toEqual({ fiscal: 'MX', books: 'ifrs', legalCurrency: 'MXN' });
    expect(caseOf('DE', null).books).toBe('mx_nif');
  });
});

describe('jurisdictionOf — los bordes de la norma', () => {
  it('sin norma, la deduce el país: MX → mx_nif, US → us_gaap', () => {
    expect(caseOf('MX', null).books).toBe('mx_nif');
    expect(caseOf('MX', undefined).books).toBe('mx_nif');
    expect(caseOf('MX', '').books).toBe('mx_nif');
    expect(caseOf('US', null).books).toBe('us_gaap');
  });

  /**
   * El CHECK de la columna sólo admite tres valores, pero la firma recibe
   * `string | null` y el dato puede venir de un JSON o de una consulta a otra
   * base. Un valor que no es ninguna de las tres normas NO es una norma: se
   * trata como ausente y decide el país, en vez de colarse en el tipo.
   */
  it('una norma que el CHECK no admite se trata como ausente, no se cuela en el tipo', () => {
    expect(caseOf('US', 'gaap').books).toBe('us_gaap');
    expect(caseOf('MX', 'nif').books).toBe('mx_nif');
    expect(caseOf('US', 'IFRS').books).toBe('ifrs'); // la escritura sí se normaliza
  });
});

describe('jurisdictionOf — la moneda legal', () => {
  /**
   * Sigue a `fiscal` y no a `functional_currency`, y la diferencia no es
   * teórica: los umbrales que esta moneda denomina son los de la LEY —los
   * 2 000 pesos del efectivo, los 7.25 dólares del mínimo federal— no los de
   * la contabilidad. Una mexicana que mide en dólares sigue teniendo umbrales
   * legales en pesos.
   */
  it('la denomina la autoridad fiscal, no la moneda en la que la entidad se mide', () => {
    expect(caseOf('MX', 'us_gaap').legalCurrency).toBe('MXN');
    expect(caseOf('US', 'mx_nif').legalCurrency).toBe('USD');
  });
});

describe('jurisdictionOf — el estado', () => {
  /**
   * Se declara en el tipo y no se puebla. `legal_entities.state_province`
   * existe (032_schema_contract.sql:24) pero es texto libre sin CHECK: sirve
   * para imprimir un domicilio, no para decidir un impuesto estatal. Fijarlo
   * en `undefined` es fijar la promesa: hoy nadie puede leerlo y creer que
   * tiene una sub-jurisdicción validada.
   */
  it('se declara en el tipo y se deja sin poblar mientras no haya un código de estado de verdad', () => {
    expect(caseOf('US', 'us_gaap').state).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(caseOf('US', 'us_gaap'), 'state')).toBe(false);
  });
});

// ============================================================
// LA ENVOLTURA QUE NO ES UNA ENVOLTURA
//
// El documento rector y la tarjeta de este tramo proponían redefinir
// `keepsMexicanBooks` como `jurisdictionOf(e).fiscal === 'MX'` «para no
// tocar a sus dos consumidores». Estas dos pruebas existen para que esa
// redefinición no se haga por descuido: son los dos renglones donde la
// supuesta envoltura cambia de respuesta, cada uno en una dirección.
// ============================================================

describe('keepsMexicanBooks — se conserva, y NO es `fiscal === MX`', () => {
  it('la filial con libros en NIF sigue siendo mexicana para el estrato fiscal, aunque su jurisdicción fiscal sea US', () => {
    expect(keepsMexicanBooks('US', 'mx_nif')).toBe(true);
    // Y aquí está la divergencia, escrita: si esto fuera una envoltura, esta
    // entidad perdería ESTRATO_FISCAL_MX y los doce ROLES_FISCALES_MX, y su
    // primera factura moriría con MISSING_ROLE_ACCOUNT.
    expect(jurisdictionOf({ incorporation_country: 'US', accounting_standard: 'mx_nif' }).fiscal).toBe('US');
  });

  it('el tercer país NO recibe el estrato fiscal mexicano, aunque su jurisdicción fiscal caiga en MX', () => {
    expect(keepsMexicanBooks('CA', 'us_gaap')).toBe(false);
    // La otra dirección de la misma divergencia: con la envoltura, la filial
    // canadiense recibiría el estrato fiscal del SAT entero.
    expect(jurisdictionOf({ incorporation_country: 'CA', accounting_standard: 'us_gaap' }).fiscal).toBe('MX');
  });

  it('la tabla completa, tal como la contestaba pais-contable.ts antes de moverse', () => {
    // País declarado México, en cualquier escritura.
    expect(keepsMexicanBooks('MX', 'us_gaap')).toBe(true);
    expect(keepsMexicanBooks('mx', 'us_gaap')).toBe(true);
    expect(keepsMexicanBooks(' MX ', 'ifrs')).toBe(true);
    // Sin país: ante la duda, mexicana.
    expect(keepsMexicanBooks(null, null)).toBe(true);
    expect(keepsMexicanBooks(undefined, undefined)).toBe(true);
    expect(keepsMexicanBooks('', 'us_gaap')).toBe(true);
    expect(keepsMexicanBooks('  ', 'us_gaap')).toBe(true);
    expect(keepsMexicanBooks()).toBe(true);
    // País declarado y distinto de México: fuera, salvo que los libros sean NIF.
    expect(keepsMexicanBooks('US', 'us_gaap')).toBe(false);
    expect(keepsMexicanBooks('USA', 'us_gaap')).toBe(false);
    expect(keepsMexicanBooks('US', 'ifrs')).toBe(false);
    expect(keepsMexicanBooks('CA', null)).toBe(false);
    expect(keepsMexicanBooks('ES', 'ifrs')).toBe(false);
  });

  /**
   * El único argumento que decide por sí solo es la norma, y lo hace con el
   * literal exacto: si alguien invierte los dos parámetros posicionales, la
   * respuesta cambia en silencio. Se fija para que el día que alguien pase un
   * objeto por error la prueba lo diga.
   */
  it('la norma sólo cuenta escrita exactamente como el CHECK la admite', () => {
    expect(keepsMexicanBooks('US', 'MX_NIF')).toBe(false);
    expect(keepsMexicanBooks('mx_nif', 'US')).toBe(false);
  });
});

// ============================================================
// EL MISMO PREDICADO, EN SQL
// ============================================================

describe('sqlKeepsMexicanBooks', () => {
  it('normaliza la columna igual que el TypeScript: btrim, upper y el nulo como ausente', () => {
    const sql = sqlKeepsMexicanBooks('le');
    // La cadena vacía y las minúsculas entran, que es donde las tres copias
    // en crudo diferían del conmutador.
    expect(sql).toContain("upper(btrim(le.incorporation_country))");
    expect(sql).toContain("IN ('', 'MX')");
    // LAS DOS columnas van dentro de un coalesce, y no es simetría: sin él el
    // fragmento devuelve la lógica de TRES valores de SQL en vez de un
    // booleano. Con la norma nula, `NULL = 'mx_nif'` es NULL, y `NULL OR
    // FALSE` da NULL — que dentro de un WHERE excluye igual que FALSE y por
    // eso nadie lo nota, hasta que alguien lo niega o lo proyecta. Lo
    // encontró la prueba de integración con el par ('DE', NULL).
    expect(sql).toContain("coalesce(upper(btrim(le.incorporation_country)), '')");
    expect(sql).toContain("coalesce(le.accounting_standard, '') = 'mx_nif'");
    // Es una disyunción cerrada entre paréntesis: intercalada con otros AND
    // dentro de un WHERE, sin ellos el OR se llevaría por delante el resto.
    expect(sql.startsWith('(')).toBe(true);
    expect(sql.endsWith(')')).toBe(true);
    expect(sql).toContain(' OR ');

    // Y EL FRAGMENTO ENTERO, LETRA POR LETRA.
    //
    // Las comprobaciones por subcadena de arriba documentan cada pieza y
    // ninguna sobra, pero todas juntas dejan pasar lo que se AÑADE: un
    // verificador adversarial metió `OR true` dentro del predicado y las seis
    // siguieron en verde. Con eso, el censo de IVA PPD se trae TODA entidad
    // —y ese censo alimenta a `reclasificar`, que escribe asientos—, así que
    // la única red bajo esa frontera era la suite de integración, que la
    // puerta unitaria con cobertura de la CI no ejecuta.
    //
    // Una igualdad exacta es incómoda de mantener, y es justo lo que hace
    // falta: cambiar el predicado tiene que costar tocar esta línea a
    // propósito, en la puerta que corre en cada PR y no en la que necesita
    // Postgres.
    expect(sql).toBe(
      "(coalesce(le.accounting_standard, '') = 'mx_nif'" +
        " OR coalesce(upper(btrim(le.incorporation_country)), '') IN ('', 'MX'))"
    );
  });

  it('el alias es un identificador, y el que no lo sea no llega a la consulta', () => {
    expect(sqlKeepsMexicanBooks('e')).toContain('e.accounting_standard');
    expect(sqlKeepsMexicanBooks('legal_entities')).toContain('legal_entities.accounting_standard');
    // Interpolar un identificador es la vía de inyección clásica de un
    // constructor de SQL. Se cierra aquí y no en la confianza del llamador.
    expect(() => sqlKeepsMexicanBooks("le'; DROP TABLE accounts; --")).toThrow(/Invalid table alias/);
    expect(() => sqlKeepsMexicanBooks('')).toThrow(/Invalid table alias/);
    expect(() => sqlKeepsMexicanBooks('1le')).toThrow(/Invalid table alias/);
  });
});
