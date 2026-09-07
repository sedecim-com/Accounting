import { describe, it, expect } from 'vitest';
import {
  jurisdiccionDe,
  esContabilidadMexicana,
  sqlEsContabilidadMexicana,
  type Jurisdiccion,
} from '../../../src/services/jurisdiccion/jurisdiccion.js';

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
function caso(pais: string | null | undefined, norma: string | null | undefined): Jurisdiccion {
  return jurisdiccionDe({ incorporation_country: pais, accounting_standard: norma });
}

describe('jurisdiccionDe — los dos países por las tres normas', () => {
  it('México con cada una de las tres normas: la norma manda sobre los libros, el país sobre lo fiscal', () => {
    expect(caso('MX', 'mx_nif')).toEqual({ fiscal: 'MX', libros: 'mx_nif', monedaLegal: 'MXN' });
    expect(caso('MX', 'us_gaap')).toEqual({ fiscal: 'MX', libros: 'us_gaap', monedaLegal: 'MXN' });
    expect(caso('MX', 'ifrs')).toEqual({ fiscal: 'MX', libros: 'ifrs', monedaLegal: 'MXN' });
  });

  it('Estados Unidos con cada una de las tres normas', () => {
    expect(caso('US', 'us_gaap')).toEqual({ fiscal: 'US', libros: 'us_gaap', monedaLegal: 'USD' });
    expect(caso('US', 'mx_nif')).toEqual({ fiscal: 'US', libros: 'mx_nif', monedaLegal: 'USD' });
    expect(caso('US', 'ifrs')).toEqual({ fiscal: 'US', libros: 'ifrs', monedaLegal: 'USD' });
  });

  /**
   * ESTE ES EL TRAMO ENTERO. Con un booleano hay una sola respuesta y hay que
   * equivocarse en uno de los dos ejes: hoy `esContabilidadMexicana` dice
   * «mexicana» de esta filial y con eso le siembra a una sociedad de Delaware
   * el estrato fiscal del SAT completo. La jurisdicción separa las dos: sus
   * libros se llevan en NIF —reconocimiento y medición mexicanos, que es lo
   * que el despacho hace— y su autoridad fiscal es la estadounidense, que es
   * de quien recibe formatos, calendario y umbrales.
   */
  it('la filial de Delaware con libros en NIF: fiscal US y libros mx_nif, que es el caso que el booleano colapsa', () => {
    expect(caso('US', 'mx_nif')).toEqual({ fiscal: 'US', libros: 'mx_nif', monedaLegal: 'USD' });
  });

  it('y su simétrica: la mexicana que reporta al corporativo en US GAAP sigue siendo fiscalmente mexicana', () => {
    expect(caso('MX', 'us_gaap')).toEqual({ fiscal: 'MX', libros: 'us_gaap', monedaLegal: 'MXN' });
  });
});

describe('jurisdiccionDe — los bordes del país', () => {
  it('nulo, indefinido, vacío y en blanco caen en México: ante la duda, mexicana', () => {
    for (const pais of [null, undefined, '', '  ']) {
      expect(caso(pais, null).fiscal).toBe('MX');
    }
    // Sin país y sin norma, la norma la deduce el país: mx_nif.
    expect(jurisdiccionDe({})).toEqual({ fiscal: 'MX', libros: 'mx_nif', monedaLegal: 'MXN' });
  });

  it('la escritura no decide: minúsculas y espacios alrededor dan la misma entidad', () => {
    expect(caso('mx', null).fiscal).toBe('MX');
    expect(caso(' MX ', null).fiscal).toBe('MX');
    expect(caso('us', null).fiscal).toBe('US');
    expect(caso(' us ', null).fiscal).toBe('US');
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
    expect(caso('USA', null).fiscal).toBe('US');
    expect(caso('usa', null).monedaLegal).toBe('USD');
  });

  /**
   * Un tercer país no tiene dónde caer: `CodigoJurisdiccion` tiene dos
   * valores y la base guarda cualquier par de caracteres. Cae en el del
   * motor, que es la regla del §3.1(b). Lo que NO hace es arrastrar a
   * `esContabilidadMexicana` consigo — ver la tabla de abajo.
   */
  it('un tercer país cae en MX por la regla de la casa, no por descuido', () => {
    expect(caso('CA', 'us_gaap')).toEqual({ fiscal: 'MX', libros: 'us_gaap', monedaLegal: 'MXN' });
    expect(caso('ES', 'ifrs')).toEqual({ fiscal: 'MX', libros: 'ifrs', monedaLegal: 'MXN' });
    expect(caso('DE', null).libros).toBe('mx_nif');
  });
});

describe('jurisdiccionDe — los bordes de la norma', () => {
  it('sin norma, la deduce el país: MX → mx_nif, US → us_gaap', () => {
    expect(caso('MX', null).libros).toBe('mx_nif');
    expect(caso('MX', undefined).libros).toBe('mx_nif');
    expect(caso('MX', '').libros).toBe('mx_nif');
    expect(caso('US', null).libros).toBe('us_gaap');
  });

  /**
   * El CHECK de la columna sólo admite tres valores, pero la firma recibe
   * `string | null` y el dato puede venir de un JSON o de una consulta a otra
   * base. Un valor que no es ninguna de las tres normas NO es una norma: se
   * trata como ausente y decide el país, en vez de colarse en el tipo.
   */
  it('una norma que el CHECK no admite se trata como ausente, no se cuela en el tipo', () => {
    expect(caso('US', 'gaap').libros).toBe('us_gaap');
    expect(caso('MX', 'nif').libros).toBe('mx_nif');
    expect(caso('US', 'IFRS').libros).toBe('ifrs'); // la escritura sí se normaliza
  });
});

describe('jurisdiccionDe — la moneda legal', () => {
  /**
   * Sigue a `fiscal` y no a `functional_currency`, y la diferencia no es
   * teórica: los umbrales que esta moneda denomina son los de la LEY —los
   * 2 000 pesos del efectivo, los 7.25 dólares del mínimo federal— no los de
   * la contabilidad. Una mexicana que mide en dólares sigue teniendo umbrales
   * legales en pesos.
   */
  it('la denomina la autoridad fiscal, no la moneda en la que la entidad se mide', () => {
    expect(caso('MX', 'us_gaap').monedaLegal).toBe('MXN');
    expect(caso('US', 'mx_nif').monedaLegal).toBe('USD');
  });
});

describe('jurisdiccionDe — el estado', () => {
  /**
   * Se declara en el tipo y no se puebla. `legal_entities.state_province`
   * existe (032_schema_contract.sql:24) pero es texto libre sin CHECK: sirve
   * para imprimir un domicilio, no para decidir un impuesto estatal. Fijarlo
   * en `undefined` es fijar la promesa: hoy nadie puede leerlo y creer que
   * tiene una sub-jurisdicción validada.
   */
  it('se declara en el tipo y se deja sin poblar mientras no haya un código de estado de verdad', () => {
    expect(caso('US', 'us_gaap').estado).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(caso('US', 'us_gaap'), 'estado')).toBe(false);
  });
});

// ============================================================
// LA ENVOLTURA QUE NO ES UNA ENVOLTURA
//
// El documento rector y la tarjeta de este tramo proponían redefinir
// `esContabilidadMexicana` como `jurisdiccionDe(e).fiscal === 'MX'` «para no
// tocar a sus dos consumidores». Estas dos pruebas existen para que esa
// redefinición no se haga por descuido: son los dos renglones donde la
// supuesta envoltura cambia de respuesta, cada uno en una dirección.
// ============================================================

describe('esContabilidadMexicana — se conserva, y NO es `fiscal === MX`', () => {
  it('la filial con libros en NIF sigue siendo mexicana para el estrato fiscal, aunque su jurisdicción fiscal sea US', () => {
    expect(esContabilidadMexicana('US', 'mx_nif')).toBe(true);
    // Y aquí está la divergencia, escrita: si esto fuera una envoltura, esta
    // entidad perdería ESTRATO_FISCAL_MX y los doce ROLES_FISCALES_MX, y su
    // primera factura moriría con MISSING_ROLE_ACCOUNT.
    expect(jurisdiccionDe({ incorporation_country: 'US', accounting_standard: 'mx_nif' }).fiscal).toBe('US');
  });

  it('el tercer país NO recibe el estrato fiscal mexicano, aunque su jurisdicción fiscal caiga en MX', () => {
    expect(esContabilidadMexicana('CA', 'us_gaap')).toBe(false);
    // La otra dirección de la misma divergencia: con la envoltura, la filial
    // canadiense recibiría el estrato fiscal del SAT entero.
    expect(jurisdiccionDe({ incorporation_country: 'CA', accounting_standard: 'us_gaap' }).fiscal).toBe('MX');
  });

  it('la tabla completa, tal como la contestaba pais-contable.ts antes de moverse', () => {
    // País declarado México, en cualquier escritura.
    expect(esContabilidadMexicana('MX', 'us_gaap')).toBe(true);
    expect(esContabilidadMexicana('mx', 'us_gaap')).toBe(true);
    expect(esContabilidadMexicana(' MX ', 'ifrs')).toBe(true);
    // Sin país: ante la duda, mexicana.
    expect(esContabilidadMexicana(null, null)).toBe(true);
    expect(esContabilidadMexicana(undefined, undefined)).toBe(true);
    expect(esContabilidadMexicana('', 'us_gaap')).toBe(true);
    expect(esContabilidadMexicana('  ', 'us_gaap')).toBe(true);
    expect(esContabilidadMexicana()).toBe(true);
    // País declarado y distinto de México: fuera, salvo que los libros sean NIF.
    expect(esContabilidadMexicana('US', 'us_gaap')).toBe(false);
    expect(esContabilidadMexicana('USA', 'us_gaap')).toBe(false);
    expect(esContabilidadMexicana('US', 'ifrs')).toBe(false);
    expect(esContabilidadMexicana('CA', null)).toBe(false);
    expect(esContabilidadMexicana('ES', 'ifrs')).toBe(false);
  });

  /**
   * El único argumento que decide por sí solo es la norma, y lo hace con el
   * literal exacto: si alguien invierte los dos parámetros posicionales, la
   * respuesta cambia en silencio. Se fija para que el día que alguien pase un
   * objeto por error la prueba lo diga.
   */
  it('la norma sólo cuenta escrita exactamente como el CHECK la admite', () => {
    expect(esContabilidadMexicana('US', 'MX_NIF')).toBe(false);
    expect(esContabilidadMexicana('mx_nif', 'US')).toBe(false);
  });
});

// ============================================================
// EL MISMO PREDICADO, EN SQL
// ============================================================

describe('sqlEsContabilidadMexicana', () => {
  it('normaliza la columna igual que el TypeScript: btrim, upper y el nulo como ausente', () => {
    const sql = sqlEsContabilidadMexicana('le');
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
    expect(sqlEsContabilidadMexicana('e')).toContain('e.accounting_standard');
    expect(sqlEsContabilidadMexicana('legal_entities')).toContain('legal_entities.accounting_standard');
    // Interpolar un identificador es la vía de inyección clásica de un
    // constructor de SQL. Se cierra aquí y no en la confianza del llamador.
    expect(() => sqlEsContabilidadMexicana("le'; DROP TABLE accounts; --")).toThrow(/Alias de tabla inválido/);
    expect(() => sqlEsContabilidadMexicana('')).toThrow(/Alias de tabla inválido/);
    expect(() => sqlEsContabilidadMexicana('1le')).toThrow(/Alias de tabla inválido/);
  });
});
