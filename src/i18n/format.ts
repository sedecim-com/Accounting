// ============================================================
// EL FORMATEADOR: IDIOMA ≠ FORMATO ≠ JURISDICCIÓN (regla 5 del epic #141)
//
// I6 · issue #148. Documento rector: docs/language.md §3 y §5.
//
// Tres decisiones que este archivo mantiene separadas a propósito, porque
// colapsarlas es el error caro del tramo:
//
//   · EL IDIOMA lo elige el usuario (`--locale`, MNEMOSINE_LOCALE, su
//     configuración). Decide en qué idioma se le HABLA. Ese dato NO entra
//     aquí: este módulo no importa el resolutor de locale, no lee `process.env`
//     y no tiene forma de enterarse de qué idioma pidió nadie. Que no lo lea es
//     estructural, no disciplina — no hay ninguna línea que pueda leerlo.
//   · EL FORMATO —separador de miles, separador decimal, orden de la fecha,
//     nombre del mes— lo fija la JURISDICCIÓN DE LA ENTIDAD. Un contador
//     mexicano que trabaja con el CLI en inglés sigue leyendo 12,458,930.55 y
//     «4 mar 2026» de su entidad mexicana; lo que cambia de idioma son las
//     etiquetas alrededor, no la cifra.
//   · LOS ARTEFACTOS QUE VAN A UNA AUTORIDAD no pasan por aquí NUNCA. El XML
//     del CFDI, la DIOT, la contabilidad electrónica: sus cifras son contrato
//     con el SAT, cadena de cuatro decimales sin separador de miles. Lo mismo
//     vale para los formatos de máquina del CLI (json/ndjson/csv/tsv/md), que
//     `src/cli/kernel/output.ts` deja pasar intactos. Este módulo es SÓLO para
//     la tabla de humanos y la prosa.
//
// EL DINERO PASA POR CADENA O NO PASA, y esto es dinero, no presentación.
// `Intl.NumberFormat.prototype.format` acepta una cadena decimal desde ES2023 y
// la formatea EXACTA. Medido en este árbol con Node 22:
//
//     format('12345678901234567.89')          -> 12,345,678,901,234,567.89
//     format(Number('12345678901234567.89'))  -> 12,345,678,901,234,568.00
//
// El importe cambió al pasar por `Number`, y cambió en la última cifra, que es
// donde nadie mira. Por eso `formatMoney` recibe `string` y NO `number`: el
// compilador rechaza el importe numérico antes de que exista el redondeo.
// La función que este módulo jubila —`formatMoneyMx`, en output.ts— evitaba
// exactamente esto a mano con BigInt y cadenas; se cambia de mecanismo, no de
// promesa.
//
// DÓNDE SE ACABA ESA EXACTITUD, QUE ANTES NO ESTABA ESCRITO. `Intl` conserva
// TODOS los dígitos de la cadena —301 dígitos distintos entran y salen iguales,
// medido en este árbol— así que no hay ningún `Number(` en el camino de las
// CIFRAS. Lo que sigue siendo float es la FRONTERA: el estándar acota la
// MAGNITUD al rango de un `double` y por encima contesta ±∞. Medido antes de la
// guarda: `formatMoney('1'.repeat(320) + '.00')` daba «MXN∞». Un ∞ en la columna
// de importes de una balanza parece un dato, igual que el «NaN» del que ya se
// defendía este archivo. La raya y su cuenta están en
// `MAX_FORMATTABLE_INTEGER_DIGITS`.
//
// LA FECHA NO SE DESPLAZA — Y AQUÍ VA LA LETRA CHICA QUE FALTABA.
//
// Este encabezado prometía que «el día que sale es el día que entró, corra donde
// corra el proceso». Era verdad a medias, y la mitad falsa costaba un día.
// Medido en este árbol con TZ=America/Mexico_City, escribiendo `iso` por
// `{ style: 'iso' }` para que se vea el día y no el mes en letra:
//
//     formatDate('2026-01-31T00:00:00Z', iso)            -> 2026-01-31
//     formatDate(new Date('2026-01-31T00:00:00Z'), iso)  -> 2026-01-30  ← un día menos
//     formatDate(new Date('2026-12-31T00:00:00Z'), iso)  -> 2026-12-30  ← y otro EJERCICIO
//
// El mismo instante imprimía dos días distintos según entrara como cadena o como
// `Date`, y en fin de año se llevaba el ejercicio por delante.
//
// LAS TRES LÍNEAS SIGUEN MIDIENDO IGUAL HOY, y decirlo importa más que taparlo:
// lo que cambió no es la omisión —que sigue leyendo el `Date` en local, y tiene
// que seguir haciéndolo, ver abajo— sino que ahora EXISTE cómo declarar la zona
// del instante, y declarándola la cuarta línea da lo que se esperaba:
//
//     formatDate(new Date('2026-12-31T00:00:00Z'), { ...iso, instantZone: 'UTC' })
//         -> 2026-12-31, y lo mismo en los cinco husos que prueba el spec.
//
// La causa no es un descuido, es que las dos entradas NO SON LA MISMA COSA: una
// cadena 'YYYY-MM-DD' es un DÍA CIVIL —tres números, sin zona—, y un `Date` es
// un INSTANTE, del que no sale ningún día sin decir en qué zona se mira. La
// versión anterior miraba siempre en la zona LOCAL y no lo decía en ningún
// sitio. Ahora lo dice y deja elegir:
//
//   · cadena — el día se lee de las diez primeras letras, tal como se escribió.
//     No se reinterpreta nunca, así que no depende de la zona del proceso. Lo
//     mismo que hace `dateOnly` (src/cli/kernel/output.ts), y a propósito: si
//     los dos renderizadores leyeran distinto, la misma póliza saldría con dos
//     fechas en la misma pantalla.
//   · `Date` — instante, y se proyecta a día civil en la zona que diga
//     `instantZone`. Por omisión `'local'`, que es como lo leen `dateOnly` y
//     `medianocheLocal`; con `'UTC'` el día sale igual en todas las zonas.
//
// LO QUE SIGUE SIN PODERSE, dicho aquí en vez de prometer lo contrario: adivinar
// cuál de las dos es. Un `Date` no recuerda cómo lo construyeron, así que un
// instante UTC pasado SIN `instantZone` sigue imprimiendo el día anterior al
// oeste de Greenwich. No es un defecto pendiente: es que la pregunta no tiene
// respuesta sin ese dato, y el dato lo tiene el llamador. Lo que se arregló es
// que ahora hay cómo decirlo, y que la promesa de arriba ya no miente.
//
// La impresión final sí es zona-independiente en las dos ramas: el día civil se
// reconstruye a medianoche UTC y se imprime con `timeZone: 'UTC'`. Sin ese par,
// `dateStyle` vuelve a restar las horas del huso al imprimir.
// ============================================================

import type { Jurisdiction, JurisdictionCode } from '../services/jurisdiction/jurisdiction.js';

// ------------------------------------------------------------
// El puente hacia el `Intl` de ES2023 que este Node sí trae
// ------------------------------------------------------------

// `tsconfig.json` declara `"lib": ["ES2022"]`, así que el compilador ve el
// `Intl` de ES2022: `format(value: number)`, `useGrouping?: boolean` y un
// `signDisplay` sin `'negative'`. El RUNTIME es Node 22 con ICU completo y sí
// implementa las tres cosas de ES2023 (comprobado ejecutando, no leyendo los
// tipos). Subir `lib` es un archivo fuera de este territorio y arrastra a todo
// el árbol, así que el desfase se absorbe AQUÍ, en un solo punto y con nombre:
// un tipo y una conversión, en vez de un `as any` repartido por el archivo.
// El día que `lib` suba a ES2023, estas dos declaraciones se borran y nada más
// cambia.
type Es2023NumberFormatOptions = Omit<Intl.NumberFormatOptions, 'useGrouping' | 'signDisplay'> & {
  useGrouping?: boolean | 'always' | 'auto' | 'min2';
  signDisplay?: 'auto' | 'never' | 'always' | 'exceptZero' | 'negative';
};

/** El único punto del sistema por el que una cadena decimal cruza a `Intl`. */
function formatExact(formatter: Intl.NumberFormat, value: string): string {
  return (formatter as unknown as { format(input: string): string }).format(value);
}

// Un `Intl.NumberFormat` no es gratis y esto se llama UNA VEZ POR CELDA: la
// tabla de una balanza de comprobación son miles de importes con las mismas
// opciones. La clave lleva el locale y las opciones serializadas; el orden de
// las claves del objeto es estable porque todos se construyen en un solo lugar
// —`moneyFormatter`, `currencyFractionDigits` y `formatNumber`—, no los arma el
// llamador.
const NUMBER_FORMATTERS = new Map<string, Intl.NumberFormat>();

function numberFormatter(locale: string, options: Es2023NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale} ${JSON.stringify(options)}`;
  let formatter = NUMBER_FORMATTERS.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, options as Intl.NumberFormatOptions);
    NUMBER_FORMATTERS.set(key, formatter);
  }
  return formatter;
}

const DATE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(locale: string, style: 'short' | 'medium' | 'long'): Intl.DateTimeFormat {
  const key = `${locale} ${style}`;
  let formatter = DATE_FORMATTERS.get(key);
  if (formatter === undefined) {
    // `timeZone: 'UTC'` NO es una preferencia: es la mitad de la salida al
    // desplazamiento de día. La otra mitad es que la fecha que llega aquí ya se
    // reconstruyó en UTC (ver `civilDateOf`). Quitar cualquiera de las dos
    // devuelve el «3 mar 2026» que `formatDate` documenta medido.
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: style, timeZone: 'UTC' });
    DATE_FORMATTERS.set(key, formatter);
  }
  return formatter;
}

// ------------------------------------------------------------
// De la jurisdicción al locale de FORMATO
// ------------------------------------------------------------

/**
 * El locale de formato de cada autoridad fiscal.
 *
 * VIVE AQUÍ Y NO EN `Jurisdiction`, y conviene decir por qué antes de que
 * alguien lo «arregle». `src/services/jurisdiction/jurisdiction.ts` contesta
 * dos preguntas contables —qué autoridad fiscal gobierna a la entidad y bajo
 * qué norma lleva los libros— y su tipo fija tres campos que sus consumidores
 * ya leen. Un `formatLocale` ahí sería un cuarto campo de PRESENTACIÓN dentro
 * de un tipo de criterio contable, y obligaría a que cada constructor de
 * `Jurisdiction` —incluidas las pruebas que arman uno a mano— eligiera un
 * BCP-47. La tabla es una función de `fiscal`, así que se deriva.
 *
 * NO ES EL IDIOMA DEL USUARIO. Que 'MX' dé 'es-MX' es una coincidencia de este
 * producto, no la regla: una entidad mexicana atendida por un despacho que usa
 * el CLI en inglés sigue formateando en es-MX.
 */
const FORMAT_LOCALES: Record<JurisdictionCode, string> = {
  MX: 'es-MX',
  US: 'en-US',
};

/**
 * El locale de formato cuando no hay entidad de la que colgarse: un comando que
 * todavía no eligió entidad, una prosa de ayuda, una prueba.
 *
 * Coincide con el último escalón de `resolveLocale()` por la regla de la casa
 * («ante la duda, mexicana»), y la coincidencia no los ata: si el idioma por
 * omisión cambiara mañana, el FORMATO por omisión de una entidad sin declarar
 * seguiría siendo el del motor.
 */
export const DEFAULT_FORMAT_LOCALE = 'es-MX';

/** El BCP-47 con el que se escriben las cifras y fechas de esta entidad. */
export function formatLocaleFor(jurisdiction: Jurisdiction): string {
  return FORMAT_LOCALES[jurisdiction.fiscal];
}

/** Lo que toda función de este módulo necesita saber para elegir el formato. */
export interface FormatOptions {
  /** La jurisdicción de la ENTIDAD. Es la que manda (regla 5). */
  jurisdiction?: Jurisdiction;
  /**
   * Escapatoria para quien ya tiene el BCP-47 resuelto —el alias mexicano de
   * output.ts, una prueba que quiere ver otro separador—. Gana sobre
   * `jurisdiction` porque es más específico, no porque sea más importante.
   *
   * AQUÍ NO SE LE PASA EL LOCALE DEL USUARIO. Un `--locale de-DE` no debe
   * reformatear los libros de una entidad mexicana, y además llega sin validar.
   *
   * La razón que estaba escrita aquí era FALSA y se corrige con lo medido: decía
   * que «`new Intl.NumberFormat('zzz')` lanza `RangeError`». No lanza. Los dos
   * finales malos, medidos los dos en este árbol (Node 22 / ICU 78):
   *
   *   · etiqueta MAL FORMADA — sí lanza `RangeError`: 'es_MX' con guion bajo,
   *     '12', la cadena vacía. Una errata plausible tumba la impresión.
   *   · etiqueta BIEN FORMADA pero inexistente — NO lanza: 'zzz' resuelve al
   *     locale POR OMISIÓN DE LA MÁQUINA (medido: 'en-US' aquí, 'de-DE' con
   *     LC_ALL=de-DE). Éste es el peor de los dos, porque es silencioso: los
   *     libros salen con el separador que el host tenga puesto, y la misma
   *     corrida da otra cosa en el portátil del contador y en el servidor.
   *
   * Este módulo no valida BCP-47 —no le toca—: la escapatoria es para quien ya
   * tiene un locale resuelto y responde por él.
   */
  locale?: string;
}

function resolveFormatLocale(options: FormatOptions): string {
  if (options.locale !== undefined) return options.locale;
  if (options.jurisdiction !== undefined) return formatLocaleFor(options.jurisdiction);
  return DEFAULT_FORMAT_LOCALE;
}

// ------------------------------------------------------------
// Dinero
// ------------------------------------------------------------

/**
 * Cómo se marca la moneda al lado de la cifra.
 *
 *  · `'code'` — el código ISO-4217: «MXN 12,458,930.55». Es lo que va en prosa
 *    y en cualquier salida donde puedan convivir dos monedas.
 *  · `'symbol'` — «$12,458,930.55». No es el valor por omisión, y la razón que
 *    estaba escrita aquí era FALSA: decía que «el símbolo del peso y el del
 *    dólar son EL MISMO en es-MX». No lo son. Lo medido es otra cosa, y es peor:
 *    el `$` a secas se lo queda LA MONEDA LOCAL DE CADA LOCALE.
 *
 *        es-MX + MXN -> $1,234.50        es-MX + USD -> USD 1,234.50
 *        en-US + USD -> $1,234.50        en-US + MXN -> MX$1,234.50
 *
 *    O sea que «$1,234.50» son pesos si la entidad es mexicana y dólares si es
 *    estadounidense, y este producto tiene las dos jurisdicciones. El símbolo
 *    sólo sirve donde la moneda ya está dicha alrededor. De paso, tampoco tiene
 *    ancho estable —«$», «MX$» y «USD » ocupan distinto—, así que una columna
 *    con dos monedas deja de alinearse.
 *  · `'plain'` — la cifra sola, sin marca. Es lo que imprime hoy la columna de
 *    dinero de la tabla, que no sabe la moneda de la entidad.
 */
export type MoneyDisplay = 'code' | 'symbol' | 'plain';

export interface MoneyFormatOptions extends FormatOptions {
  /** ISO-4217. Por omisión, la moneda legal de la jurisdicción. */
  currency?: string;
  /** Por omisión `'code'`: donde pueden convivir dos monedas, la cifra sola miente. */
  display?: MoneyDisplay;
  /**
   * Decimales impresos. Por omisión, los que la moneda usa —2 para MXN y USD,
   * 0 para JPY o CLP—, que es un dato que ICU tiene y que nosotros no
   * deberíamos escribir a mano. NO son los 4 decimales de ALMACENAMIENTO: aquí
   * se está imprimiendo, y el dato de origen conserva sus cuatro.
   */
  fractionDigits?: number;
}

/** La moneda por omisión cuando no hay jurisdicción de la que leerla. */
const DEFAULT_CURRENCY = 'MXN';

/**
 * La forma que el almacenamiento produce: signo opcional, dígitos, punto
 * opcional, decimales. Es LA MISMA expresión con la que `formatMoneyMx` decidía
 * si tocaba el valor, y se conserva letra por letra a propósito.
 *
 * Sin esta guarda, `Intl` no falla: contesta, y contesta mal. `format('abc')`
 * da «NaN», `format('')` da «0.00» y `format('1,234.00')` —un importe YA
 * formateado, que es lo que llega cuando alguien rinde dos veces— da «NaN». Un
 * «NaN» en la columna de importes de una balanza es peor que la cadena
 * original: parece un dato.
 */
const STORAGE_DECIMAL_RE = /^-?\d+(?:\.\d*)?$/;

/**
 * ISO-4217 BIEN FORMADO, que no es lo mismo que existente, y la diferencia se
 * mide: `Intl` lanza `RangeError` con lo que no sean tres letras ('PESOS', 'P',
 * '12', la cadena vacía), y NO lanza con tres letras inventadas —'ZZZ' imprime
 * «ZZZ 1,234.50»—. Esta guarda cubre lo primero, que es lo que tumbaría la
 * impresión; para lo segundo el catálogo de monedas es de la jurisdicción, no
 * del formateador.
 */
const CURRENCY_CODE_RE = /^[A-Za-z]{3}$/;

/**
 * DONDE SE ACABA LA EXACTITUD DE `Intl`, Y POR QUÉ LA RAYA ESTÁ EN 308.
 *
 * Lo primero, para no acusar de más: los DÍGITOS no pasan por float. Una cadena
 * de 301 dígitos distintos entra y sale idéntica (medido, Node 22 / ICU 78), así
 * que no hay ningún `Number(` en el camino del importe. Lo que sí quedó de float
 * es la FRONTERA: ES2023 acota la magnitud al rango de un `double` y por encima
 * contesta ±∞. Medido en este árbol antes de esta guarda:
 *
 *     formatMoney('1'.repeat(320) + '.00')  ->  MXN∞
 *     formatMoney('1'.repeat(310) + '.00')  ->  MXN∞
 *     formatMoney('1'.repeat(309) + '.00')  ->  MXN 111,111,…,111.00   (exacto)
 *
 * Y no cae en un número redondo de dígitos: con 309 dígitos el resultado depende
 * de los primeros —'1' seguido de 308 ceros formatea; '2' seguido de 308 ceros
 * da ∞—, porque el límite de verdad es el `double` máximo (≈1.797e308). ESA
 * CONSTANTE NO SE ESCRIBE AQUÍ: es exactamente el float que este módulo no deja
 * entrar, y clavarla en un archivo de dinero la ataría a la representación de
 * coma flotante de hoy. La raya se pone un dígito antes, en 308, que es una
 * cuenta de CADENAS y no de floats: cualquier entero de 308 dígitos vale menos
 * de 1e308 y por tanto siempre cabe.
 *
 * Lo que la guarda cuesta y lo que compra, dicho sin adorno: deja fuera un
 * puñado de valores de 309 dígitos que `Intl` sí formatearía, y ninguno de los
 * dos lados de esa raya existe en un despacho —el PIB mundial en centavos tiene
 * 17 dígitos—. Vale por lo que IMPIDE, no por lo que habilita: que un ∞ se cuele
 * en una columna de importes pareciendo un dato. Es la misma regla que la guarda
 * de forma de arriba, aplicada a la otra manera de contestar mal.
 */
const MAX_FORMATTABLE_INTEGER_DIGITS = 308;

/**
 * Dígitos de la parte entera, sin signo y sin ceros a la izquierda.
 *
 * `String(value)` y no `value.startsWith(...)` sobre el argumento: el tipo dice
 * `string`, pero la garantía es del COMPILADOR y no del runtime. La guarda de
 * forma de arriba es `RegExp.test`, que COACCIONA sin quejarse, así que hoy un
 * `number` de un llamador sin tipos —una fila `unknown`, JavaScript llano—
 * atraviesa este archivo y se imprime. Escrito con `startsWith` a secas, este
 * ayudante lo convertía en un `TypeError` y tumbaba la impresión: lo midió la
 * prueba del `@ts-expect-error` en el primer intento de esta guarda. Una guarda
 * que estrena una caída donde antes había una salida no es una guarda.
 */
function integerDigitsOf(value: string): number {
  const text = String(value);
  const unsigned = text.startsWith('-') ? text.slice(1) : text;
  const dot = unsigned.indexOf('.');
  const integerPart = dot === -1 ? unsigned : unsigned.slice(0, dot);
  return integerPart.replace(/^0+(?=\d)/, '').length;
}

/**
 * ¿La magnitud cabe en lo que `Intl` formatea sin desbordar a ∞?
 *
 * Sólo mira la parte ENTERA a propósito: una fracción larguísima no desborda
 * —`0.` y dos mil unos imprime «0.11» (medido)—, porque los decimales que
 * sobran se redondean a los `fractionDigits` pedidos y nunca crecen la magnitud.
 */
function withinFormattableRange(value: string): boolean {
  return integerDigitsOf(value) <= MAX_FORMATTABLE_INTEGER_DIGITS;
}

function moneyFormatter(
  locale: string,
  currency: string,
  display: MoneyDisplay,
  fractionDigits: number
): Intl.NumberFormat {
  // `useGrouping: 'always'` en vez de dejarlo en `'auto'`: con `'auto'` el
  // agrupamiento de los números de cuatro cifras lo decide `minimumGroupingDigits`
  // del CLDR —es-MX agrupa 1,000 hoy; es-ES no—, y una columna donde 1,000.00 y
  // 12,458,930.55 se agrupan distinto deja de alinearse por dígito. Además es un
  // dato que CLDR puede cambiar en una actualización de ICU, y debajo de esto hay
  // un contrato de bytes con el alias mexicano y su prueba.
  //
  // `signDisplay: 'negative'` para que el menos-cero no llegue a la hoja: con
  // `'auto'`, `-0.0040` redondeado a dos decimales imprime «-0.00» (medido), y
  // un menos delante de un cero es ilegible en una balanza. `formatMoneyMx` ya
  // lo suprimía a mano.
  const base: Es2023NumberFormatOptions = {
    useGrouping: 'always',
    signDisplay: 'negative',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  };
  if (display === 'plain') return numberFormatter(locale, { ...base, style: 'decimal' });
  return numberFormatter(locale, {
    ...base,
    style: 'currency',
    currency,
    currencyDisplay: display === 'code' ? 'code' : 'symbol',
  });
}

/** Los decimales que la propia moneda usa, según ICU: MXN y USD 2, JPY 0. */
function currencyFractionDigits(locale: string, currency: string): number {
  // El `?? 2` no es defensa contra un runtime que falle: los tipos de ES2022
  // declaran `minimumFractionDigits` OPCIONAL en `resolvedOptions()` aunque con
  // `style: 'currency'` siempre venga. Dos es el de MXN y el de USD, las dos
  // monedas legales que este producto conoce.
  const resolved = numberFormatter(locale, { style: 'currency', currency }).resolvedOptions();
  return resolved.minimumFractionDigits ?? 2;
}

/**
 * Un importe listo para que lo lea una persona, en el formato de la
 * jurisdicción de su entidad.
 *
 * EL ARGUMENTO ES `string` Y NO `number`, Y ES LO ÚNICO IMPORTANTE DE ESTA
 * FIRMA. Postgres entrega los `numeric` como cadena y este sistema los conserva
 * como cadena hasta la hoja; `Number(importe)` en cualquier punto del camino es
 * el redondeo que el proyecto prohíbe, y a partir de 2^53 centésimos miente en
 * la última cifra sin avisar. Si un llamador tiene un `number`, el arreglo es
 * que no lo tenga, no convertirlo aquí.
 *
 * Un valor que no sea una cadena decimal de almacenamiento SALE COMO ENTRÓ, sin
 * lanzar: el renderizador de la tabla no puede morirse porque una columna
 * traía un guion. Y por encima de `MAX_FORMATTABLE_INTEGER_DIGITS` sale también
 * como entró, por la misma razón y con la razón medida allí: formatearlo daría
 * «∞», que en una columna de importes se lee como si fuera un dato.
 *
 * @param amount cadena decimal de almacenamiento, p. ej. '12458930.5500'.
 */
export function formatMoney(amount: string, options: MoneyFormatOptions = {}): string {
  if (!STORAGE_DECIMAL_RE.test(amount)) return amount;
  // Junto a la guarda de forma y ANTES de la validación de moneda, para no
  // cambiar el orden que ya existía: las dos guardas de valor devuelven la
  // cadena, y sólo un código de moneda mal escrito —que es un error del
  // llamador, no del dato— lanza.
  if (!withinFormattableRange(amount)) return amount;
  const locale = resolveFormatLocale(options);
  const currency = options.currency ?? options.jurisdiction?.legalCurrency ?? DEFAULT_CURRENCY;
  if (!CURRENCY_CODE_RE.test(currency)) {
    throw new Error(
      `Currency code must be three letters (ISO 4217), got ${JSON.stringify(currency)}.`
    );
  }
  const display = options.display ?? 'code';
  const fractionDigits = options.fractionDigits ?? currencyFractionDigits(locale, currency);
  return formatExact(moneyFormatter(locale, currency, display, fractionDigits), amount);
}

// ------------------------------------------------------------
// Fechas
// ------------------------------------------------------------

/**
 * `'iso'` es yyyy-mm-dd y no depende del locale: es lo que va en la TABLA y en
 * todo formato de máquina, porque un 03/04/26 se lee como dos fechas distintas
 * a los dos lados del Bravo. Los otros tres estilos son para prosa.
 */
export type DateStyle = 'iso' | 'short' | 'medium' | 'long';

/**
 * En qué zona se lee un `Date`, que es un INSTANTE y no un día civil.
 *
 * Existe porque de un instante no sale ningún día sin decir dónde se mira, y
 * porque antes esta decisión estaba tomada en silencio (siempre local) mientras
 * el encabezado prometía una salida independiente de la zona.
 *
 *  · `'local'` — la zona del proceso, y el valor por omisión. El `Date` que más
 *    llega aquí lo fabrica node-postgres: sin `setTypeParser` —y este árbol no
 *    lo pone—, una columna DATE llega como `Date` a MEDIANOCHE LOCAL, así que
 *    sólo los getters locales devuelven el día que la base guardó. Es lo que ya
 *    leen `dateOnly` (src/cli/kernel/output.ts) y `medianocheLocal`
 *    (src/services/assets/depreciation.ts); leer distinto que ellos pondría dos
 *    fechas de la misma póliza en la misma pantalla.
 *  · `'UTC'` — para un instante anclado en UTC: un `new Date('…Z')`, un
 *    `Date.UTC(…)`, un `created_at` que viaja en JSON. Con esto el día sale
 *    IGUAL en todas las zonas, que es justo lo que la rama de `Date` no podía
 *    dar antes de I6 (medido: 2026-12-31Z salía «2026-12-30» en CDMX).
 */
export type InstantZone = 'local' | 'UTC';

export interface DateFormatOptions extends FormatOptions {
  /** Por omisión `'medium'`, que es el que nombra el mes sin ambigüedad. */
  style?: DateStyle;
  /**
   * Sólo se mira cuando el valor es un `Date`. Una cadena trae el día ya
   * escrito y no se reproyecta nunca, así que pasar esto con una cadena no
   * cambia nada. Por omisión `'local'`.
   */
  instantZone?: InstantZone;
}

interface CivilDate {
  year: number;
  /** 1-12, como lo escribe una persona y no como lo cuenta `Date`. */
  month: number;
  day: number;
}

/**
 * El día CIVIL del valor: tres números, sin instante y sin zona.
 *
 * Las dos formas en que una fecha contable llega hasta aquí, y por qué se leen
 * distinto:
 *
 *  · `Date` — es un INSTANTE, y proyectarlo a un día exige una zona. La elige
 *    `instantZone` (ver su tipo): `'local'` por omisión, porque node-postgres
 *    entrega las columnas DATE como `Date` a MEDIANOCHE LOCAL y sólo los
 *    getters locales devuelven el día que la base guardó —`dateOnly`
 *    (src/cli/kernel/output.ts) documenta el mismo caso con la póliza del 31 de
 *    enero a las 20:00 en CDMX, y esta función contesta igual que aquélla a
 *    propósito—; `'UTC'` para el instante que sí está anclado en UTC.
 *
 *    Aquí está el defecto que I6 cerró a medias y conviene no volver a vender
 *    entero: la asimetría con la rama de cadena no se «arregla» eligiendo bien,
 *    porque un `Date` no recuerda cómo lo construyeron. Se arregla dejando que
 *    el llamador lo diga, y ésta es la línea donde se le hace caso.
 *  · `string` — una cadena ISO ya trae la fecha decidida por quien la escribió.
 *    Se recorta, no se reinterpreta —ni siquiera si trae hora y `Z`—: pasarla
 *    por `new Date(...)` la convertiría en un instante UTC y reabriría el
 *    corrimiento. `instantZone` no la toca, y por eso esta rama es la única de
 *    las dos que da el mismo día en cualquier zona sin que nadie declare nada.
 */
function civilDateOf(value: string | Date, instantZone: InstantZone): CivilDate | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return instantZone === 'UTC'
      ? { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() }
      : { year: value.getFullYear(), month: value.getMonth() + 1, day: value.getDate() };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[T ]|$)/.exec(value);
  if (match === null) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

/**
 * Una fecha contable escrita en el formato de la jurisdicción de la entidad.
 *
 * QUÉ PROMETE, EXACTAMENTE —y la letra chica va aquí porque la versión anterior
 * prometía de más y se corría un día:
 *
 *  · con una CADENA, el día que sale es el día escrito, en cualquier zona en la
 *    que corra el proceso. Sin condiciones.
 *  · con un `Date`, el día que sale es el del instante MIRADO EN `instantZone`
 *    —`'local'` por omisión—. Si el llamador declara la zona en la que ancló su
 *    instante, el día también es el mismo en cualquier zona; si no la declara y
 *    su instante era UTC, sigue saliendo el día anterior al oeste de Greenwich.
 *    Eso no se puede adivinar desde aquí: ver `InstantZone`.
 *
 * Fijado el día civil, la impresión ya no depende de nadie: se reconstruye a
 * medianoche UTC y se formatea con `timeZone: 'UTC'`. Sin ese par, `dateStyle`
 * vuelve a imprimir el día ANTERIOR al oeste de Greenwich —medido: 2026-03-04Z
 * sale «3 mar 2026» en America/Mexico_City— y una fecha contable corrida un día
 * cruza el corte de periodo, o el corte de EJERCICIO si cae el 31 de diciembre.
 *
 * Un valor que no sea una fecha reconocible sale como entró (la cadena tal
 * cual, o vacía si era un `Date` inválido), por la misma razón que en
 * `formatMoney`: imprimir no puede tumbar el comando.
 */
export function formatDate(value: string | Date, options: DateFormatOptions = {}): string {
  const civil = civilDateOf(value, options.instantZone ?? 'local');
  if (civil === null) return typeof value === 'string' ? value : '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  const iso = `${String(civil.year).padStart(4, '0')}-${pad(civil.month)}-${pad(civil.day)}`;
  const style = options.style ?? 'medium';
  if (style === 'iso') return iso;
  // `new Date(Date.UTC(y, ...))` interpreta los años de dos cifras como 19xx
  // (`Date.UTC(26, 2, 4)` es 1926). `setUTCFullYear` no arrastra esa regla, y un
  // ejercicio contable del año 26 d. C. no existe, pero un dato corrupto sí.
  const at = new Date(0);
  at.setUTCFullYear(civil.year, civil.month - 1, civil.day);
  at.setUTCHours(0, 0, 0, 0);
  return dateFormatter(resolveFormatLocale(options), style).format(at);
}

// ------------------------------------------------------------
// Números que no son dinero
// ------------------------------------------------------------

export interface NumericFormatOptions extends FormatOptions {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

/**
 * Una cantidad que NO es dinero: un conteo de pólizas, unos días de mora, un
 * número de renglones.
 *
 * Acepta `number` porque un conteo ES un `number` y obligarlo a pasar por
 * cadena sería ceremonia. LOS IMPORTES NO PASAN POR AQUÍ: van a `formatMoney`,
 * que sólo admite cadena, y esa asimetría entre las dos firmas es justamente lo
 * que impide colar un importe por la puerta que redondea.
 *
 * El agrupamiento se deja en manos del locale (`'auto'`) y no se fuerza a
 * `'always'` como en el dinero: allá se fuerza para sostener un contrato de
 * bytes y una columna que se alinea por dígito, y aquí no hay ni lo uno ni lo
 * otro, así que manda la convención del locale.
 *
 * Y QUE QUEDE DICHO, PORQUE ES UNA TRAMPA: `'auto'` NO significa «no agrupa los
 * números cortos». En es-MX sí los agrupa —`formatNumber(2026)` da «2,026»
 * (medido)—, porque el CLDR mexicano tiene `minimumGroupingDigits` en 1. Un año,
 * un folio numérico o una clave del SAT no son cantidades y no pasan por aquí:
 * se imprimen tal cual.
 */
export function formatNumber(value: string | number, options: NumericFormatOptions = {}): string {
  const locale = resolveFormatLocale(options);
  const formatter = numberFormatter(locale, {
    style: 'decimal',
    minimumFractionDigits: options.minimumFractionDigits,
    maximumFractionDigits: options.maximumFractionDigits,
  });
  if (typeof value === 'number') return formatter.format(value);
  if (!STORAGE_DECIMAL_RE.test(value)) return value;
  // La misma frontera del dinero, y por la misma razón: sin esto,
  // `formatNumber('1'.repeat(320))` contestaba «∞» (medido). Cubre la rama de
  // CADENA, que es la que puede traer una magnitud que un `number` ni siquiera
  // sabe representar; un `number` que ya llegue como `Infinity` viene roto de su
  // llamador y aquí no hay nada que conservar.
  if (!withinFormattableRange(value)) return value;
  return formatExact(formatter, value);
}
