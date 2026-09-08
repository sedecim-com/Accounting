// ============================================================
// LA JURISDICCIÓN DE UNA ENTIDAD: DOS EJES, NO UN BOOLEANO
//
// J0.1 de la issue #123. Diseño en docs/jurisdicciones.md §3.1.
//
// Hasta aquí la pregunta «¿de qué jurisdicción es esta entidad?» se
// contestaba con un `boolean` —`keepsMexicanBooks`— y ese booleano
// colapsa DOS preguntas que no son la misma:
//
//   · ¿QUÉ AUTORIDAD FISCAL la gobierna?  Manda sobre el catálogo fiscal,
//     el calendario, las declaraciones, los formatos y la moneda en la que
//     están escritos los umbrales de la ley.
//   · ¿BAJO QUÉ NORMA lleva los libros?  Manda sobre reconocimiento,
//     medición y presentación.
//
// PUEDEN DIFERIR, y el caso no es teórico: una filial constituida en
// Delaware cuyo despacho mexicano le lleva los libros en NIF necesita
// reconocimiento mexicano Y catálogo fiscal estadounidense. Con un solo
// booleano hay que elegir una de las dos y equivocarse en la otra; hoy el
// motor elige «mexicana» y le siembra a esa sociedad de Delaware el estrato
// fiscal del SAT completo.
//
// Este módulo devuelve las dos respuestas por separado. Lo que NO hace es
// cambiar en silencio quién recibe qué: ver la advertencia larga sobre
// `keepsMexicanBooks` más abajo.
//
// ANTE LA DUDA, MEXICANA. Es la regla de la casa (§3.1(b)) y la segura para
// este producto: el motor es mexicano y sus informes son mexicanos. Dejar
// sin estrato fiscal a una entidad que sí lo necesita se manifiesta como
// MISSING_ROLE_ACCOUNT en su primera factura; sembrarle cuatro cuentas de
// más a una que no las usa se manifiesta como cuatro renglones en cero.
// ============================================================

/** Autoridad fiscal que gobierna a la entidad. El producto arranca con dos. */
export type JurisdictionCode = 'MX' | 'US';

/** Norma bajo la que se llevan los libros. Coincide con el CHECK de
 *  `legal_entities.accounting_standard` (001_core_schema.sql). */
export type AccountingStandard = 'mx_nif' | 'us_gaap' | 'ifrs';

export interface Jurisdiction {
  /** La que manda sobre catálogo fiscal, calendario, impuestos y formatos. */
  fiscal: JurisdictionCode;
  /** La que manda sobre reconocimiento, medición y presentación. */
  books: AccountingStandard;
  /** Moneda en la que se expresan los umbrales legales de `fiscal`. */
  legalCurrency: 'MXN' | 'USD';
  /**
   * Sub-jurisdicción cuando la hay (estado de EE. UU.).
   *
   * SE DECLARA Y NO SE POBLA, A PROPÓSITO. La columna existe
   * —`legal_entities.state_province`, 032_schema_contract.sql:24— pero es
   * texto libre de 120 caracteres sin CHECK: sirve para imprimir un
   * domicilio, no para decidir qué impuesto estatal aplica. El proyecto SÍ
   * tiene un código de estado de verdad, y no es éste: `employees.work_state`
   * es VARCHAR(3) precisamente para que quepan las claves c_Estado del SAT
   * junto a las dos letras estadounidenses (migración 068), y de ahí lee el
   * ISN su tasa. Poblar `state` desde un campo postal sería vender como
   * sub-jurisdicción validada lo que no lo es, y el síntoma de esa clase de
   * error ya lo documentó la 068: el motor diciendo que le falta un dato que
   * tiene. Se declara ahora para que el día que la entidad tenga su propio
   * código no cambie la FORMA del tipo ni haya que editar a sus consumidores;
   * y `jurisdictionOf` ni siquiera recibe la columna (§3.1).
   */
  state?: string;
}

/**
 * Lo que `jurisdictionOf` necesita de la entidad: las dos columnas de
 * `legal_entities` que la describen. Ambas opcionales porque una consulta
 * puede no traer las dos.
 */
export interface EntityWithJurisdiction {
  incorporation_country?: string | null;
  accounting_standard?: string | null;
}

/**
 * Qué dijo la entidad sobre su país, antes de decidir nada.
 *
 * SON CUATRO ESTADOS Y NO DOS, y ésa es la razón de que este paso exista
 * aparte: «no lo declaró» y «declaró un país que este producto no modela»
 * son hechos distintos, y hoy el motor los trata distinto —el primero es
 * mexicano por omisión, el segundo NO recibe el estrato fiscal mexicano—.
 * Colapsarlos aquí sería tomar una decisión de criterio contable dentro de
 * una función de normalización.
 */
type DeclaredCountry = 'MX' | 'US' | 'OTHER' | 'ABSENT';

/**
 * Normaliza la escritura antes de comparar. La columna es `CHAR(2) NOT NULL`
 * y NADIE valida qué dos caracteres se guardan: nada impide 'mx' en
 * minúsculas ni los dos espacios en blanco con los que `bpchar` almacena la
 * cadena vacía. Comparar en crudo contra 'MX' —que es lo que hacían las tres
 * copias que este módulo sustituye— deja fuera a esas entidades.
 *
 * Se acepta 'USA' además de 'US' porque ese alias ya causó un defecto real y
 * documentado en este repositorio: `chartFor` comparaba contra 'USA' contra
 * una columna CHAR(2) y por eso JAMÁS devolvía el catálogo de nómina
 * estadounidense (payroll-account-mapping-seed.ts:258-271). El asistente y
 * `COUNTRY_PROFILES` nombran al país 'USA'; la base guarda 'US'. Aquí valen
 * los dos.
 *
 * NO se acepta 'MEX' ni 'MEXICO', Y LA ASIMETRÍA CON 'USA' ES DELIBERADA, así
 * que conviene decir por qué de verdad. No es que el producto escriba México
 * de una sola forma: `taxIdTypeForCountry` (ap/vendor-service.ts:64) reconoce
 * 'MX', 'MEX' y 'MEXICO'. Lo que pasa es que esa función contesta OTRA
 * pregunta —qué tipo de identificador fiscal emite un país— y el documento
 * rector la deja fuera de este criterio a propósito (§3.1); ninguna ruta que
 * decida JURISDICCIÓN nombra hoy a México con tres letras, mientras que 'USA'
 * sí llega por una que existe y que un paso posterior va a migrar
 * (`normalizarPais`, cuyo dominio publicado es 'MX' | 'USA').
 *
 * Y la razón que manda sobre la anterior: admitir 'MEX' cambiaría la respuesta
 * de `keepsMexicanBooks` —esa entidad pasaría de fuera a dentro del
 * estrato fiscal mexicano— y J0.1 conserva esa respuesta bit por bit. Aceptar
 * 'USA' no la cambia: 'USA' ya contestaba `false` antes y sigue contestando
 * `false`. Un alias que sólo reordena el camino entra; uno que mueve la
 * frontera del estrato fiscal se decide con nombre propio, no aquí.
 */
function readCountry(raw?: string | null): DeclaredCountry {
  // SE RECORTA EL ESPACIO, Y SÓLO EL ESPACIO. Con `String.prototype.trim`
  // esta mitad quitaba TODO blanco Unicode —tabulador, salto de línea, el
  // espacio duro U+00A0— y la mitad de SQL no: `btrim` sin segundo argumento
  // quita únicamente el espacio ASCII. Un país guardado como dos tabuladores
  // —la columna es CHAR(2) sin CHECK, así que se puede— daba `true` aquí y
  // `false` dentro del WHERE del censo y del doctor: el defecto del §1.1
  // renacido dentro de la solución que viene a cerrarlo, y sin una sola
  // prueba que lo viera. Se alinea TypeScript con SQL y no al revés porque el
  // único blanco que `CHAR(2)` produce por su cuenta es el relleno con
  // espacios; los demás sólo llegan de una escritura inválida, y a ésa no se
  // le regala el estrato fiscal mexicano.
  const country = (raw ?? '').replace(/^ +| +$/g, '').toUpperCase();
  if (country === '') return 'ABSENT';
  if (country === 'MX') return 'MX';
  if (country === 'US' || country === 'USA') return 'US';
  return 'OTHER';
}

/** Las tres normas que el CHECK de la columna admite, para no confiar en el
 *  tipo cuando el dato viene de la base o de un JSON. */
const STANDARDS: readonly AccountingStandard[] = ['mx_nif', 'us_gaap', 'ifrs'];

function readStandard(raw?: string | null): AccountingStandard | null {
  const standard = (raw ?? '').trim().toLowerCase();
  return (STANDARDS as readonly string[]).includes(standard) ? (standard as AccountingStandard) : null;
}

/**
 * La jurisdicción de una entidad, en sus dos ejes.
 *
 * Las reglas, EN ESTE ORDEN (§3.1):
 *
 *  (a) `accounting_standard` decide `books`. Si no viene —o viene con un
 *      valor que el CHECK de la columna no admite— lo decide el país:
 *      MX → mx_nif, US → us_gaap.
 *  (b) `incorporation_country` decide `fiscal`. Nulo, vacío o desconocido
 *      → MX. El tipo tiene dos valores y una filial canadiense tiene que
 *      caer en uno: cae en el del motor, que es la regla de la casa.
 *  (c) `books` y `fiscal` PUEDEN DIFERIR. Es todo el punto del tramo.
 *
 * `legalCurrency` sigue a `fiscal` y no a `functional_currency`: es la moneda
 * en la que están escritos los umbrales de la LEY que gobierna a la entidad
 * —los 2 000 pesos del efectivo, los 7.25 dólares del salario mínimo
 * federal— y no la moneda en la que la entidad decide medirse. Confundirlas
 * es cómo un piso de 500 en `src/ai/floor.ts` acaba valiendo un orden de
 * magnitud distinto según a quién se aplique.
 */
export function jurisdictionOf(e: EntityWithJurisdiction): Jurisdiction {
  const country = readCountry(e.incorporation_country);

  // (b) primero en el código porque (a) lo necesita como respaldo; el ORDEN
  //     DE LAS REGLAS del documento describe la precedencia del DATO
  //     —la norma declarada gana sobre el país— y eso es lo que hace la
  //     línea de `books`, no el orden en que se calculan las variables.
  const fiscal: JurisdictionCode = country === 'US' ? 'US' : 'MX';

  // (a) la norma declarada manda; sin ella, la deduce el país.
  const books: AccountingStandard = readStandard(e.accounting_standard) ?? (fiscal === 'MX' ? 'mx_nif' : 'us_gaap');

  return {
    fiscal,
    books,
    legalCurrency: fiscal === 'MX' ? 'MXN' : 'USD',
  };
}

// ============================================================
// «¿ESTA ENTIDAD RECIBE EL ESTRATO FISCAL MEXICANO?»
//
// ESTA PREGUNTA NO ES `jurisdictionOf(e).fiscal === 'MX'`, Y LA DIFERENCIA
// IMPORTA. El documento rector (§3.1) y la tarjeta de este tramo proponían
// redefinir `keepsMexicanBooks` como esa envoltura «para no tocar a sus
// dos consumidores». No es una envoltura: cambia la respuesta en las dos
// direcciones, y en las dos rompe algo.
//
//   país 'US' + norma 'mx_nif' → hoy true, con `fiscal === 'MX'` false.
//       Es EXACTAMENTE el caso que el «O» existe para proteger. Esa filial
//       perdería ESTRATO_FISCAL_MX y los doce ROLES_FISCALES_MX, y su
//       primera factura moriría con MISSING_ROLE_ACCOUNT; en una entidad ya
//       sembrada el daño es peor porque es silencioso: el diagnóstico
//       dejaría de reportar como ausentes unos roles que la entidad SÍ tiene
//       y SÍ usa.
//   país 'CA' (o cualquier tercero) → hoy false, con `fiscal === 'MX'` true,
//       porque la regla (b) manda todo país desconocido a MX. La filial
//       canadiense pasaría a recibir el estrato fiscal del SAT entero y a
//       acreditar IVA sobre flujo.
//
// Ninguna redefinición sobre los tres campos de `Jurisdiction` salva las dos
// a la vez —`fiscal === 'MX'`, `books === 'mx_nif'` y la disyunción de
// ambas fallan cada una en un caso— porque el tipo, con dos valores, no
// puede distinguir «país no declarado» de «país declarado y no modelado», y
// hoy el motor los trata distinto. Añadir un cuarto campo para lograrlo
// sería cambiar la forma que §3.1 fija.
//
// Así que la función CONSERVA SU CUERPO, y lo conserva aquí: lo que J0.1
// unifica es DÓNDE se escribe la comparación, no QUÉ contesta. Qué entidad
// merece el estrato fiscal mexicano es una bifurcación de criterio contable
// —la filial extranjera con libros en NIF— y por la regla de la casa no se
// resuelve dentro de una refactorización.
// ============================================================

/**
 * Entidad que lleva contabilidad mexicana: la que declara México como país de
 * constitución, o la que lleva sus libros en NIF mexicanas.
 *
 * Ambos argumentos son opcionales porque las dos columnas se leen de
 * `legal_entities` y una consulta puede no traer las dos. Sin ninguna de las
 * dos, la respuesta es `true` por la regla del encabezado del módulo.
 */
export function keepsMexicanBooks(
  incorporationCountry?: string | null,
  accountingStandard?: string | null
): boolean {
  if (accountingStandard === 'mx_nif') return true;
  // Sólo un país DECLARADO y distinto de MX saca a la entidad del estrato
  // mexicano. Ausente —nulo, vacío o en blanco— sigue siendo México.
  const country = readCountry(incorporationCountry);
  return country === 'ABSENT' || country === 'MX';
}

/**
 * El MISMO predicado, escrito en SQL, para las consultas que tienen que
 * acotar dentro del `WHERE`.
 *
 * POR QUÉ EXISTE Y NO SE FILTRA EN TYPESCRIPT. Dos de las copias que este
 * módulo unifica viven dentro de una consulta: el censo de IVA PPD
 * (`iva-ppd-reclass.ts`) y la revisión de roles del doctor. Sacarlas a TS
 * significaría traer de la base los renglones de TODA entidad para
 * descartarlos después — más lento, y sobre todo una frontera de entidad
 * fuera del SQL, que en este proyecto no se hace. El censo de PPD alimenta a
 * `reclasificar`, que ESCRIBE asientos y puede reabrir periodos cerrados: la
 * lista de la que se alimenta no puede depender de un `filter` que alguien
 * olvide.
 *
 * QUÉ DICE, RENGLÓN POR RENGLÓN, y por qué no es la traducción ingenua:
 *
 *   · `btrim` + `upper`: la columna es `CHAR(2)`, así que la cadena vacía se
 *     almacena como dos espacios y nada obliga a que 'MX' venga en
 *     mayúsculas. Un `= 'MX'` a secas —lo que decían las tres copias— deja
 *     fuera a esas entidades, y el TS de arriba sí las incluye. Sin esto las
 *     dos mitades del conmutador contestarían distinto sobre la misma fila,
 *     que es el defecto que el tramo viene a cerrar, sólo que mejor vestido.
 *   · `coalesce` en LAS DOS columnas: sin él el fragmento no devuelve un
 *     booleano, devuelve la lógica de tres valores de SQL. `upper(btrim(NULL))`
 *     es NULL y `NULL IN (...)` es NULL; con la norma nula, `NULL = 'mx_nif'`
 *     también lo es, y `NULL OR FALSE` da NULL. Dentro de un WHERE, NULL y
 *     FALSE excluyen igual y nadie lo nota — hasta que alguien lo niega, lo
 *     mete en un CASE o lo proyecta como columna, y entonces el mismo
 *     fragmento contesta distinto que el TypeScript sobre la misma fila. Lo
 *     descubrió la prueba de integración que corre las dos mitades sobre la
 *     misma tabla de pares, con `('DE', NULL)`. Las dos columnas son NOT NULL
 *     y por la tabla no se alcanza; un LEFT JOIN sí produce el nulo.
 *
 * @param alias alias de `legal_entities` dentro de la consulta ('le', 'e'…).
 */
export function sqlKeepsMexicanBooks(alias: string): string {
  // El alias se interpola: no puede ir como parámetro ($1 liga valores, no
  // identificadores). Se valida en vez de confiar en que todo llamador pase
  // un literal — un constructor de SQL que acepta cualquier cadena está a un
  // descuido de convertirse en la vía de inyección del sistema.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Invalid table alias for the jurisdiction predicate: ${JSON.stringify(alias)}`);
  }
  return (
    `(coalesce(${alias}.accounting_standard, '') = 'mx_nif'` +
    ` OR coalesce(upper(btrim(${alias}.incorporation_country)), '') IN ('', 'MX'))`
  );
}
