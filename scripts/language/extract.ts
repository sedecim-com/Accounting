// ============================================================
// EL EXTRACTOR DE CADENAS DE USUARIO (I7 · issue #149, rector §3 y §5)
//
//   npm run language:extract -- src/cli/bank-command.ts          el plan, para leerlo
//   npm run language:extract -- src/cli/bank-command.ts --write  lo aplica a los catálogos
//   npm run language:extract -- src/cli --list                   una línea por cadena
//
// I6 dejó el catálogo cableado: `t()` deriva el idioma en cada llamada y los dos
// archivos de `src/i18n/` no pueden separarse porque `es.ts` se declara
// `Record<keyof typeof EN, string>`. Lo que I6 NO dejó es cómo llega una cadena
// desde el archivo donde hoy está escrita hasta esa pareja. Hacerlo a mano, para
// las que el CLI tenía al abrir este tramo —668, medidas corriendo ESTE mismo
// reconocedor sobre `origin/i6-locale-catalog-formatter`, que es la única forma
// de que la cifra siga queriendo decir lo mismo— es teclear 668 veces la misma
// transformación mecánica: inventar la clave, mover el texto, convertir `${x}`
// en `{x}` y acordarse de poner la marca en el inglés. Ninguno de los cuatro
// pasos es una decisión; los cuatro se equivocan callados.
//
// Y ESTE ARCHIVO NO SÓLO EXTRAE: PUBLICA EL NÚMERO. El mismo reconocedor que
// decide qué se extrae es el que cuenta el carril `spanish-user-strings-cli` de
// `scripts/language/lanes/code.ts`. Que sean el MISMO no es economía de código:
// es lo que hace que «este archivo llegó a cero» signifique «el extractor ya no
// tiene nada que hacer aquí» y no «el metro dejó de mirar». Dos poblaciones, una
// para medir y otra para transformar, divergen el día que alguien afine una de
// las dos, y a partir de ahí el carril baja sin que nadie haya traducido.
//
// ============================================================
// QUÉ CUENTA COMO «CADENA DE USUARIO», Y QUÉ DEJA FUERA
//
// Una CADENA DE USUARIO es un literal de cadena, escrito en el código de
// `src/cli/`, cuyo texto es PROSA ESPAÑOLA. Nada más. Ni «la que se imprime» ni
// «la que llega a la terminal»: eso exigiría seguir el valor hasta su escritura,
// y en este árbol no se puede — está medido. En `bank-command.ts` los literales
// que acaban en stdout pasan antes por `p.dim(...)`, `linea(...)`, `renglon(...)`
// o `agregar(...)`, ayudantes locales de ese archivo. Una lista de sumideros
// tendría que nombrarlos todos, se quedaría corta el día que alguien escriba el
// siguiente ayudante, y una lista que se queda corta hace que un archivo publique
// CERO teniendo español dentro. Eso es peor que contar de más: contar de más se
// discute mirando la lista; contar de menos no se ve.
//
// Así que la población es ancha por dentro y ESTRECHA POR FUERA —el recorte está
// en el árbol, no en la heurística—, y lo que queda fuera queda fuera por una
// razón escrita:
//
//   · SÓLO `src/cli/**`. Es la superficie que el contador lee. `src/services/`
//     tiene otros MILES de cadenas españolas —el recorrido sobre `src/` entero
//     pasa de cuatro mil; la cifra exacta se pregunta con `--list src` y no se
//     copia de aquí, porque se mueve con cada archivo que se traduce— y NO se
//     cuentan aquí porque hasta que I9 le dé `key` a `AppError` no hay por
//     dónde pagarlas: un carril que nadie puede
//     bajar, mezclado con los que sí, es como se acaba apagando el trinquete
//     entero (`lane.ts` lo dice en su contrato). Cuando I9 llegue, ese carril
//     nace al lado, con su propio número, y entonces se puede ver cuál de los
//     dos se movió. `tests/` y `scripts/` no entran nunca: al contador no le
//     sale por pantalla ni la prosa de una prueba ni la de una herramienta de
//     la casa.
//   · LAS DE `src/plan/` Y LOS CATÁLOGOS SEMBRADOS, que son la razón por la que
//     el recorte no es «todo `src/`». Medido al abrir el tramo:
//     `src/plan/criterios.ts` aportaba 1 111 y
//     `src/services/accounting/sat-agrupadores-catalogo.ts` 738. Ninguna de las
//     dos es prosa para el operador: la primera es el enunciado de un criterio
//     del plan —lo lee quien desarrolla— y la segunda son los nombres oficiales
//     del agrupador del SAT, que es exactamente lo que `en.ts` prohíbe meter en
//     el catálogo («nada que vaya a una autoridad»). Un carril que las contara
//     metería 1 849 renglones —1 111 más 738— de deuda que NO se debe pagar
//     dentro del mismo número que sí hay que bajar.
//   · UN IDENTIFICADOR NO ES UNA CADENA. `'estado-cuenta'`, `'debito'`, el
//     nombre de una columna: una palabra, o varias pegadas con guion, no es
//     prosa. Se exigen al menos DOS palabras separadas por espacio. Es lo que
//     distingue un mensaje de un valor, y sin ello el carril contaría cada valor
//     de enumeración escrito en español —que se renombra, no se traduce, y que
//     el censo de identificadores ya gobierna—.
//   · UNA CADENA DE REGISTRO NO ES UNA CADENA DE USUARIO. Aquí no hace falta
//     excluirla —en `src/cli/` no hay llamadas al registro; vive en
//     `src/utils/logger.ts` y sus llamadores están fuera de la población— y se
//     escribe igual porque la pregunta vuelve el día que I9 abra los servicios.
//     La respuesta es que el registro lo lee un operador de sistemas en un
//     archivo, no el contador en su pantalla: no se traduce, y su idioma es otra
//     discusión.
//   · LO QUE ESTÁ EN POSICIÓN DE DATO Y NO DE MENSAJE: el especificador de un
//     `import`, la clave de una propiedad (`{ 'no aplica': 1 }`), un tipo
//     literal (`type X = 'sin cotejar'`), la etiqueta de un `case`, los lados de
//     un `===` y el primer argumento de `t(...)`, que ya es una clave. Los seis
//     son valores que el programa COMPARA o ALMACENA; traducirlos rompería el
//     cable por el que viajan.
//   · Y EL SQL, por su primera palabra. Un `WHERE` con columnas en español es
//     deuda de otro tramo y de otro tipo.
//
// ============================================================
// COMPARAR NO ES SÓLO `===`: LAS DOS FORMAS QUE FALTABAN
//
// «Los lados de un `===`» era la mitad de la regla. Un programa compara de otras
// dos maneras, y las dos dejaban pasar por mensaje lo que es un código:
//
//   · POR PERTENENCIA A UNA LISTA. `src/cli/kernel/audit.ts` declara
//     `const REGLAS_DE_LLAVE = ['R11 llave aceptada sin honrar', 'R11 llave sin
//     declarar']` y `esDeudaDeLlave`, justo debajo, pregunta
//     `REGLAS_DE_LLAVE.includes(v.rule)`. Escribir esas dos cadenas dentro de un
//     arreglo en vez de a la derecha de un `===` no cambia lo que son: el valor
//     contra el que se compara. Traducirlas rompe la comparación.
//   · POR SER CAMPO DE UNA HUELLA. `claveDeViolacion` (en `audit.ts`) devuelve
//     `` `${v.command}|${v.rule}|${v.detail.replace(/\d+/g,'#')}` ``, y
//     `auditarContraLineaBase` compara esa huella contra `LINEA_BASE`. El
//     `detail` no se lee en una terminal —lo dice el docstring de `LINEA_BASE`,
//     en ese mismo archivo—: es un tercio de una clave congelada. Si dependiera
//     del idioma, el veredicto de la puerta dependería de `--locale`.
//
//     LOS TRES SE CITAN POR NOMBRE Y NO POR RENGLÓN, y es una corrección: la
//     versión anterior de este párrafo daba cuatro números de renglón de
//     `audit.ts` y los cuatro apuntaban a otra cosa. Un nombre se encuentra con
//     `grep`; un renglón de OTRO archivo lo mueve cualquiera sin enterarse.
//
// Así que el reconocedor mira, ARCHIVO POR ARCHIVO, qué compara ese archivo
// consigo mismo (`comparedValues`), y no cuenta lo que cae ahí dentro. MEDIDO
// COMPARANDO EL RECORRIDO CONSIGO MISMO —el mismo `--list src/cli` con las dos
// exclusiones puestas y con `compared` vacío—: la regla saca 12 cadenas, las 12
// de `src/cli/kernel/audit.ts`, y NINGUNA de ningún otro archivo de `src/cli/`.
// El total del recorrido no se cita aquí a propósito: se mueve con cada archivo
// que se traduce, y una cifra que envejece en un comentario es una mentira con
// fecha. Se pregunta con `npx tsx scripts/language/extract.ts --list src/cli |
// wc -l`, que es lo que publica el carril.
//
// LO QUE NO ALCANZA, dicho antes de que alguien lo suponga: el análisis es de UN
// archivo. `OBJECTLESS_COMMANDS` se declara en `vocabulary.ts` y se compara en
// `audit.ts`, y esta regla no cruza esa frontera. No se arregla porque no hace
// falta —esa lista son palabras sueltas, que el mínimo de dos palabras ya deja
// fuera— y porque un análisis de árbol entero convertiría el reconocedor en algo
// que nadie puede reproducir leyendo un archivo.
//
// ============================================================
// CÓMO SE DECIDE QUE UN TEXTO ES ESPAÑOL, Y POR QUÉ NO BASTA EL LÉXICO DE I1
//
// El léxico compartido (`lexicon.ts`) clasifica TOKENS DE IDENTIFICADOR, y su
// regla de oro es que lo desconocido cae en inglés: correcto cuando se mide
// `saldoInicial`, desastroso sobre prosa, donde casi toda palabra conjugada
// —`aceptada`, `honrar`, `deshizo`— es desconocida y caería en inglés. Medido:
// con la clasificación del léxico a secas, `'R11 llave aceptada sin honrar'`
// sale inglesa.
//
// Sobre prosa el idioma lo delatan las PALABRAS GRAMATICALES, que son una clase
// cerrada y no se conjugan. Así que se cuentan dos marcadores y se comparan:
//
//   español = palabras funcionales españolas + raíces del léxico de I1 + (1 si
//             el texto trae á é í ó ú ñ ¿ ¡)
//   inglés  = palabras funcionales inglesas
//
// y la cadena es española cuando tiene ≥2 palabras, ≥2 marcadores españoles y
// más españoles que ingleses. Las raíces del léxico entran para que las dos
// mitades de la casa compartan vocabulario donde pueden compartirlo; las
// funcionales son de aquí porque un identificador no lleva artículos.
//
// LO QUE ESTA REGLA NO ALCANZA, escrito para que nadie la persiga con más
// palabras:
//
//   · UN TEXTO BILINGÜE SE CUENTA POR SU MAYORÍA, y ahí la regla acierta y
//     falla. Acierta con los bloques de `Examples:` de `bank-command.ts`, que
//     son inglés con datos de ejemplo españoles («BBVA Operativa MXN») y NO
//     cuentan. Al abrir el tramo contaba UNO, y era un acierto: el bloque de
//     `bank account create` llevaba dentro un comentario entero en castellano
//     («OJO, medido: el catalogo siembra 1112…») que el usuario veía al pedir
//     `--help` — ahí había español saliendo por pantalla. Este mismo tramo lo
//     tradujo («HEADS UP, measured: the chart seeds 1112…»), así que hoy no
//     queda ninguno. Y falla con los bloques CORTOS de `account-command.ts`,
//     cuyo comentario inglés («A new expense account
//     hanging off Gastos de Administracion») trae más nombres del catálogo de
//     cuentas que palabras funcionales inglesas, y sale español sin serlo.
//     SE MIDIÓ ANTES DE DECIDIR NO ARREGLARLO: las cadenas del CLI que llevan
//     `Examples:` dentro se cuentan con los dedos —`--list src/cli` y buscar la
//     palabra— frente a los cientos del recorrido entero. Una regla que apartara
//     la familia entera se llevaría por delante el caso de `bank account
//     create`, que era deuda de verdad, a cambio de quitar ruido de alrededor
//     del uno por ciento. El ruido se anota; la regla no se retuerce por él.
//   · UNA CADENA ESPAÑOLA DE DOS PALABRAS SIN NINGUNA FUNCIONAL —`'saldo
//     final'`— no llega a dos marcadores si el léxico sólo reconoce una de las
//     dos, y se pierde. Es un falso negativo por diseño: la alternativa, bajar a
//     un marcador, mete cada `'Total MXN'` del árbol.
//   · NO SE MIRA DÓNDE ESTÁ LA CADENA para decidir el idioma, sólo qué dice. Una
//     constante española que nunca se imprime cuenta igual, y el remedio es el
//     mismo que para la de `audit.ts`: renombrarla al inglés.
//
// ============================================================
// LA CLAVE ES UN BORRADOR, Y SE DICE EN LA SALIDA
//
// La clave se compone como PREFIJO + SLUG DE LA CADENA, que es lo único que un
// extractor puede hacer: no traduce. El slug sale del castellano, así que la
// clave que propone es española —`bank_sin_cambios_el_mayor_no_toco`— mientras
// el catálogo de I6 las tiene inglesas (`no_changes_ledger_untouched`). El
// extractor NO puede arreglar eso y no finge que sí: marca cada clave cuyo slug
// el léxico de I1 señala como español, con la misma función que usa el metro, y
// quien escriba la traducción inglesa la renombra ahí mismo. Es también la razón
// por la que este comando NO escribe por omisión: una clave es identidad, y una
// identidad provisional que se cuela al catálogo ya no se renombra nunca.
//
// ============================================================
// LO QUE NO HACE, DICHO ANTES DE QUE ALGUIEN LO SUPONGA
//
// NO REESCRIBE EL SITIO DE LLAMADA. Imprime la llamada sugerida —`t('clave',
// { param })`— y ahí se para. Sustituir el literal exige decidir el nombre de
// cada parámetro a partir de una expresión arbitraria, y un nombre mal elegido
// no rompe la compilación: `t()` LANZA en tiempo de ejecución cuando el mensaje
// pide un parámetro que no llegó (`src/i18n/index.ts`, dentro de `resolve`). Un
// codemod que convierte un texto correcto en una excepción en la terminal de un
// contador no es una ayuda.
//
// NO INVENTA PLURALES. Una cadena marcada con `// i18n:plural` —o escrita con la
// forma `(s)`, `(es)`, que es como este CLI resuelve hoy el plural en decenas de
// sitios de `src/cli/`: eran 106 al abrir el tramo y bajan con cada mensaje que
// se muda, así que la cifra se cuenta y no se cita— se lista aparte y NO se
// transforma: su clave tiene que nacer con las ramas `one`/`other` escritas a
// mano, y meterla como texto plano
// congelaría el `(s)` dentro del catálogo, que es justo lo que I6 vino a
// jubilar. LA MARCA NO ES UNA EXENCIÓN DEL METRO: la cadena sigue contando en el
// carril, porque sigue siendo español sin clave. Si la marca descontara, sería
// una puerta para poner un archivo en verde escribiendo comentarios.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { classifyToken, isFlagged } from './lexicon.js';
import { messageParameters } from '../../src/i18n/index.js';

/** La raíz del repositorio: este archivo vive en `scripts/language/`. */
const ROOT = path.resolve(__dirname, '..', '..');

/**
 * LA SUPERFICIE QUE SE MIDE. Ver el encabezado: es la que el contador lee.
 * Cambiarla es cambiar la población de un carril publicado, así que se cambia a
 * la vista y resembrando su línea base, no de paso.
 */
export const CLI_SURFACE = 'src/cli';

/** Los catálogos de I6. `en.ts` es la fuente de claves; `es.ts` la obedece. */
export const EN_CATALOG = 'src/i18n/en.ts';
export const ES_CATALOG = 'src/i18n/es.ts';

/** La marca que I6 publica para lo que todavía no se tradujo. */
const UNTRANSLATED = '__TRANSLATE__';

/** Cuántas palabras del texto entran en el slug. Bastantes para reconocerlo. */
const SLUG_WORDS = 6;

/** Lo que no se recorre, por la misma razón que en `lanes/code.ts`. */
const IGNORED: ReadonlySet<string> = new Set(['node_modules', 'dist', 'coverage', '.git']);

/** Los diacríticos que deja `normalize('NFD')`, para quitarlos. */
const COMBINING_MARKS = /[̀-ͯ]/g;

// ---- El idioma de un texto -------------------------------------------

/**
 * PALABRAS FUNCIONALES ESPAÑOLAS. Clase cerrada: artículos, preposiciones,
 * pronombres, conjunciones y los auxiliares más frecuentes. No lleva sustantivos
 * ni verbos de dominio —ésos los aporta el léxico de I1—, y duplicarlos aquí
 * sería la segunda lista que `lexicon.ts` empieza advirtiendo que no puede haber.
 */
const SPANISH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'del', 'al', 'lo', 'le', 'les',
  'de', 'en', 'con', 'sin', 'para', 'por', 'sobre', 'entre', 'desde', 'hasta', 'hacia',
  'que', 'se', 'es', 'son', 'era', 'fue', 'fueron', 'ha', 'han', 'hay', 'ser', 'sera', 'sean',
  'esta', 'este', 'esto', 'estas', 'estos', 'ese', 'esa', 'eso', 'aquel', 'aquella',
  'su', 'sus', 'mi', 'me', 'te', 'tu', 'nos', 'ya', 'no', 'ni', 'y', 'o', 'si', 'mas',
  'como', 'pero', 'sino', 'porque', 'aunque', 'cuando', 'donde', 'cual', 'cuales', 'quien',
  'nada', 'nadie', 'algo', 'todo', 'toda', 'todos', 'todas', 'cada', 'otra', 'otro',
  'otras', 'otros', 'mismo', 'misma', 'muy', 'tambien', 'solo', 'asi', 'aqui', 'ahi',
  'tiene', 'tienen', 'debe', 'deben', 'puede', 'pueden', 'hace', 'dos', 'tres',
  'ninguna', 'ninguno', 'ningun', 'alguna', 'alguno',
]);

/**
 * PALABRAS FUNCIONALES INGLESAS, y son las que apagan un falso positivo. Sin
 * ellas los bloques de ayuda en inglés de `bank-command.ts` —que llevan dentro
 * nombres de cuenta españoles— contaban como prosa española. Cuántos: se mide
 * vaciando este conjunto y restando las dos listas de `--list src/cli`. No se
 * escribe la cifra porque baja con cada bloque que se traduce; al abrir el
 * tramo eran 14 en `bank-command.ts` y 95 en todo `src/cli/`.
 */
const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'the', 'of', 'and', 'to', 'in', 'is', 'it', 'that', 'for', 'with', 'this', 'not', 'on',
  'be', 'are', 'was', 'were', 'from', 'as', 'by', 'or', 'an', 'at', 'but', 'they', 'you',
  'your', 'its', 'has', 'have', 'had', 'will', 'would', 'when', 'which', 'what', 'who',
  'how', 'all', 'any', 'each', 'one', 'two', 'three', 'only', 'also', 'than', 'then',
  'there', 'these', 'those', 'into', 'out', 'up', 'down', 'so', 'if', 'do', 'does', 'did',
  'can', 'could', 'should', 'may', 'might', 'must', 'never', 'always', 'every', 'more',
  'most', 'less', 'least', 'same', 'other', 'others', 'such', 'both', 'either', 'neither',
  'because', 'while', 'after', 'before', 'during', 'without', 'within', 'about', 'against',
  'through', 'over', 'under', 'again', 'once', 'here', 'now', 'why', 'whether', 'been',
  'being', 'their', 'them', 'we', 'us', 'our', 'his', 'her', 'him', 'she', 'he', 'yet',
  'still', 'just', 'even', 'make', 'makes', 'made', 'use', 'uses', 'used', 'using',
]);

/**
 * Le quita al texto lo que no es prosa antes de juzgar su idioma: los huecos
 * `{param}`, las banderas —`--dry-run` aporta un `no` que no es español, y ése
 * fue un falso positivo real— y lo que va entre acentos graves, que son ejemplos
 * de comando y no frases.
 */
function proseOf(text: string): string {
  return text
    .replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, ' ')
    .replace(/(^|\s)--?[A-Za-z0-9][A-Za-z0-9-]*/g, ' ')
    .replace(/`[^`]*`/g, ' ');
}

/** Minúsculas, sin diacríticos y sin nada que no sea letra latina básica. */
function fold(word: string): string {
  return word.toLowerCase().normalize('NFD').replace(COMBINING_MARKS, '').replace(/[^a-z]/g, '');
}

/** El veredicto de idioma, con sus dos cuentas para que se pueda auditar. */
export interface LanguageVerdict {
  spanish: boolean;
  spanishMarkers: number;
  englishMarkers: number;
  words: number;
}

/**
 * ¿Este texto es prosa española? Ver el encabezado para la regla y sus límites.
 *
 * Las PALABRAS se cuentan separando por espacio —de ahí sale la exigencia de que
 * haya al menos dos— y los MARCADORES separando además por guiones y guiones
 * bajos, porque `ai_sessions, ai_messages; y por sus herramientas` tiene que
 * poder aportar sus tokens sin que `ai_sessions` cuente como una palabra sola.
 */
export function judgeLanguage(text: string): LanguageVerdict {
  const prose = proseOf(text);
  const words = prose.split(/\s+/).map(fold).filter((word) => word.length > 0);
  let spanishMarkers = 0;
  let englishMarkers = 0;
  for (const raw of prose.split(/[^A-Za-zÀ-ɏ]+/)) {
    const token = fold(raw);
    if (token.length === 0) continue;
    if (SPANISH_FUNCTION_WORDS.has(token)) spanishMarkers += 1;
    else if (ENGLISH_FUNCTION_WORDS.has(token)) englishMarkers += 1;
    else if (classifyToken(token) === 'es') spanishMarkers += 1;
  }
  if (/[áéíóúñ¿¡]/i.test(prose)) spanishMarkers += 1;
  return {
    spanish: words.length >= 2 && spanishMarkers >= 2 && spanishMarkers > englishMarkers,
    spanishMarkers,
    englishMarkers,
    words: words.length,
  };
}

// ---- El reconocedor --------------------------------------------------

/** Una cadena de usuario, con todo lo que hace falta para ir a buscarla. */
export interface UserString {
  /** Ruta desde la raíz del repo, siempre con `/`. */
  file: string;
  /** Renglón 1-indexado donde empieza el literal, como lo cuenta un editor. */
  line: number;
  /** El texto ya normalizado: `${x}` convertido en `{x}` y los `+` unidos. */
  text: string;
  /** Los parámetros, en orden de aparición y sin repetir. */
  params: string[];
  /**
   * Lleva `// i18n:plural`, o la forma `(s)`/`(es)` con la que este CLI resuelve
   * hoy el plural. No se transforma; sí se cuenta.
   */
  needsPlural: boolean;
}

function isStringish(node: ts.Node): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isTemplateExpression(node)
  );
}

/** Las hojas de una cadena de `+`, en orden de lectura. */
function additiveLeaves(node: ts.Expression, out: ts.Expression[]): void {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    additiveLeaves(node.left, out);
    additiveLeaves(node.right, out);
    return;
  }
  if (ts.isParenthesizedExpression(node)) {
    additiveLeaves(node.expression, out);
    return;
  }
  out.push(node);
}

/**
 * ¿Es esta expresión una cadena partida con `+`?
 *
 * UNIRLAS ES LO QUE HACE QUE EL NÚMERO SEA UN NÚMERO DE MENSAJES. Un mensaje
 * largo se escribe en tres renglones concatenados porque no cabe en uno, y
 * contarlo tres veces publicaría deuda que no existe: medido sobre
 * `origin/i6-locale-catalog-formatter`, `src/cli/` daba 964 literales sueltos y
 * 668 mensajes. Peor que la cifra sería
 * el efecto: partir un renglón en dos para que quepa haría SUBIR el carril sin
 * que nadie hubiera escrito una palabra nueva de español.
 */
function isAdditiveString(node: ts.Node): node is ts.BinaryExpression {
  if (!ts.isBinaryExpression(node) || node.operatorToken.kind !== ts.SyntaxKind.PlusToken) {
    return false;
  }
  const leaves: ts.Expression[] = [];
  additiveLeaves(node, leaves);
  return leaves.some(isStringish);
}

/**
 * El nombre del parámetro que le toca a una expresión incrustada.
 *
 * `${cuenta}` da `cuenta`; `${opts.dryRun}` da `dryRun`; `${TIPOS.join(', ')}`
 * da `TIPOS`, que es el sujeto y no el verbo. Lo que no se puede nombrar sale
 * `value`, `value2`… El nombre TIENE que ser un identificador ICU: el analizador
 * de `src/i18n/index.ts` rechaza `{co unt}` a propósito, y un hueco que ningún
 * sitio de llamada puede rellenar imprimiría vacío en vez de fallar.
 */
function parameterName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression;
    if (ts.isPropertyAccessExpression(callee)) return parameterName(callee.expression);
    if (ts.isIdentifier(callee)) return callee.text;
  }
  if (ts.isElementAccessExpression(expression)) return parameterName(expression.expression);
  if (ts.isNonNullExpression(expression) || ts.isParenthesizedExpression(expression)) {
    return parameterName(expression.expression);
  }
  return 'value';
}

/**
 * Un trozo de la cadena: o es texto literal, o es un hueco con la expresión que
 * lo llena. Se modela como una unión y no como un carácter centinela metido en
 * el texto porque un centinela es un carácter que algún día alguien escribe: el
 * día que una cadena del CLI lo lleve dentro, el extractor la partiría en dos y
 * pediría un parámetro que nadie puso.
 */
type Segment = { readonly text: string } | { readonly hole: ts.Expression };

/** Los trozos de una expresión de cadena, en orden de lectura. */
function renderTemplate(node: ts.Expression, out: Segment[]): void {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    renderTemplate(node.left, out);
    renderTemplate(node.right, out);
    return;
  }
  if (ts.isParenthesizedExpression(node)) {
    renderTemplate(node.expression, out);
    return;
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    out.push({ text: node.text });
    return;
  }
  if (ts.isTemplateExpression(node)) {
    out.push({ text: node.head.text });
    for (const span of node.templateSpans) {
      out.push({ hole: span.expression });
      out.push({ text: span.literal.text });
    }
    return;
  }
  out.push({ hole: node });
}

// ---- Lo que un archivo compara consigo mismo -------------------------

/** Los métodos con los que se pregunta «¿está esto dentro?». */
const MEMBERSHIP_METHODS: ReadonlySet<string> = new Set(['includes', 'indexOf', 'has']);

/** Los operadores que comparan dos valores por igualdad. */
const EQUALITY_OPERATORS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/**
 * LO QUE UN ARCHIVO COMPARA CONSIGO MISMO. Ver el encabezado, sección «comparar
 * no es sólo `===`».
 */
export interface ComparedValues {
  /** Nombres ligados a un arreglo cuya PERTENENCIA prueba el mismo archivo. */
  lists: ReadonlySet<string>;
  /** Nombres de propiedad que el archivo lee dentro de una comparación. */
  fields: ReadonlySet<string>;
}

/**
 * El PRIMER campo de una cadena de accesos que arranca en un identificador:
 * `v.rule` da `rule`, `v.detail.replace(...)` da `detail` —y no `replace`, que
 * es el método y no el dato—, `ruta` a secas da `null`.
 */
function rootFieldOf(node: ts.Expression): string | null {
  let current: ts.Expression = node;
  for (;;) {
    if (ts.isNonNullExpression(current) || ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isAsExpression(current) || ts.isSatisfiesExpression(current)) {
      current = current.expression;
      continue;
    }
    // `v.detail.replace(/…/g, '#')`: lo que interesa es el dato del que cuelga
    // la llamada, no el nombre del método con el que se le da forma.
    if (ts.isCallExpression(current)) {
      current = current.expression;
      continue;
    }
    break;
  }
  if (!ts.isPropertyAccessExpression(current)) return null;
  let access = current;
  while (ts.isPropertyAccessExpression(access.expression)) access = access.expression;
  return ts.isIdentifier(access.expression) ? access.name.text : null;
}

/**
 * ¿Es este trozo de plantilla una JUNTA y no una frase? Sin letras dentro.
 *
 * Es lo que separa una HUELLA —`${a}|${b}|${c}`, cuyos trozos literales son
 * separadores— de un mensaje que interpola datos. Sin este corte, «una
 * plantilla que se devuelve» incluiría cualquier frase construida con `${}` y
 * la exclusión se comería mensajes de verdad.
 */
function isJoiner(text: string): boolean {
  return !/[A-Za-zÀ-ɏ]/.test(text);
}

/** Una huella: plantilla de puros separadores, devuelta por una función. */
function isFingerprintTemplate(node: ts.TemplateExpression): boolean {
  if (node.templateSpans.length === 0) return false;
  if (!isJoiner(node.head.text)) return false;
  for (const span of node.templateSpans) if (!isJoiner(span.literal.text)) return false;
  const parent = node.parent;
  if (parent === undefined) return false;
  return ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === node);
}

/**
 * Recorre un archivo y reúne lo que ese archivo compara.
 *
 * EL RECORRIDO ES ITERATIVO por la misma razón que el de `userStrings` — y esa
 * razón NO es que la recursión desborde: allí está medido que no lo hace.
 */
export function comparedValues(source: ts.SourceFile): ComparedValues {
  const lists = new Set<string>();
  const fields = new Set<string>();
  const add = (expression: ts.Expression): void => {
    const field = rootFieldOf(expression);
    if (field !== null) fields.add(field);
  };

  const pending: ts.Node[] = [source];
  while (pending.length > 0) {
    const node = pending.pop() as ts.Node;
    ts.forEachChild(node, (child) => {
      pending.push(child);
    });

    if (ts.isBinaryExpression(node) && EQUALITY_OPERATORS.has(node.operatorToken.kind)) {
      add(node.left);
      add(node.right);
      continue;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      MEMBERSHIP_METHODS.has(node.expression.name.text)
    ) {
      const receiver = node.expression.expression;
      if (ts.isIdentifier(receiver)) lists.add(receiver.text);
      for (const argument of node.arguments) add(argument);
      continue;
    }
    // `new Set(LINEA_BASE)` es una lista que se va a preguntar por pertenencia:
    // el `.has()` cae sobre la variable nueva y no sobre el arreglo de origen.
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Set'
    ) {
      const first = node.arguments?.[0];
      if (first !== undefined && ts.isIdentifier(first)) lists.add(first.text);
      continue;
    }
    if (ts.isTemplateExpression(node) && isFingerprintTemplate(node)) {
      for (const span of node.templateSpans) add(span.expression);
    }
  }
  return { lists, fields };
}

/** El nombre de una propiedad escrito como identificador o entre comillas. */
function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** ¿Está este literal dentro de un arreglo cuya pertenencia se prueba? */
function inComparedList(node: ts.Node, lists: ReadonlySet<string>): boolean {
  const array = node.parent;
  if (array === undefined || !ts.isArrayLiteralExpression(array)) return false;
  let up: ts.Node | undefined = array.parent;
  while (
    up !== undefined &&
    (ts.isAsExpression(up) || ts.isSatisfiesExpression(up) || ts.isParenthesizedExpression(up))
  ) {
    up = up.parent;
  }
  if (up === undefined || !ts.isVariableDeclaration(up) || !ts.isIdentifier(up.name)) return false;
  return lists.has(up.name.text);
}

/**
 * La razón por la que un literal NO es un mensaje, o `null` si sí lo es. Ver el
 * encabezado: son las posiciones en las que una cadena es un VALOR.
 */
function positionalReason(node: ts.Node, compared: ComparedValues): string | null {
  const parent = node.parent;
  if (parent === undefined) return null;
  if (
    ts.isImportDeclaration(parent) ||
    ts.isExportDeclaration(parent) ||
    ts.isImportTypeNode(parent) ||
    ts.isExternalModuleReference(parent) ||
    ts.isModuleDeclaration(parent)
  ) {
    return 'module specifier';
  }
  if (ts.isPropertyAssignment(parent) && parent.name === node) return 'property key';
  if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node) {
    return 'property key';
  }
  // Un valor que este mismo archivo compara: por pertenecer a una lista que
  // pregunta `.includes()`, o por llenar un campo que entra en una huella.
  if (inComparedList(node, compared.lists)) return 'member of a compared list';
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    const name = propertyNameText(parent.name);
    if (name !== null && compared.fields.has(name)) return 'compared record field';
  }
  if (ts.isLiteralTypeNode(parent)) return 'literal type';
  if (ts.isCaseClause(parent)) return 'case label';
  if (ts.isBinaryExpression(parent)) {
    const operator = parent.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      operator === ts.SyntaxKind.EqualsEqualsToken ||
      operator === ts.SyntaxKind.ExclamationEqualsToken
    ) {
      return 'comparison';
    }
  }
  if (
    ts.isCallExpression(parent) &&
    parent.arguments.length > 0 &&
    parent.arguments[0] === node &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === 't'
  ) {
    return 'already a catalog key';
  }
  return null;
}

/** Un `SELECT` con columnas españolas es deuda de otro tramo y de otro tipo. */
const SQL_HEAD = /^\s*(select|insert|update|delete|with|create|alter|drop|truncate)\b/i;

/** La forma con la que este CLI resuelve hoy el plural: `cancelado(s)`. */
const PLURAL_SHAPE = /\([a-zA-Z]{1,3}\)/;

/**
 * Las cadenas de usuario de UN archivo.
 *
 * Recibe el texto en vez de leerlo para que una prueba pueda darle tres
 * renglones: un reconocedor que sólo se puede ejercitar contra el árbol entero
 * es un reconocedor que nadie acota. Es la misma decisión —y por la misma
 * razón— que `flaggedDeclarations` en `lanes/code.ts`.
 *
 * EL RECORRIDO ES ITERATIVO, y conviene decir por qué NO lo es: no porque la
 * recursión desborde. Se midió, y no desborda. `ts.forEachChild` recursivo
 * TERMINA sobre `src/cli/bank-command.ts` —más de cinco mil renglones, el
 * archivo más grande del CLI— con Node 22: su árbol tiene 36 niveles de hondo y
 * el más hondo de todo `src/cli/` tiene 46, muy lejos del límite de la pila. La
 * pila explícita se queda porque funciona y porque el recorrido empuja nodos a
 * mitad de camino —las expresiones incrustadas de una plantilla, más abajo—;
 * quien la cambie por una recursión que lo haga por claridad, no por miedo a un
 * `RangeError` que este comentario prometía y que no ocurre.
 */
export function userStrings(code: string, file: string): UserString[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  // Qué compara este archivo consigo mismo. Se calcula UNA vez, antes del
  // recorrido, porque la pregunta es del archivo entero: una cadena escrita en
  // el renglón 43 es un código por lo que dice el renglón 47.
  const compared = comparedValues(source);

  // LA MARCA SE BUSCA EN EL TEXTO, no entre los comentarios del árbol. Un
  // comentario suelto entre dos argumentos no siempre queda «adjunto» al nodo
  // que uno cree —depende de dónde caiga la coma—, y una marca que a veces se
  // pierde es peor que ninguna. Se acepta en el renglón de la cadena, en
  // cualquiera de los que ocupa, o en el inmediatamente anterior, que es donde
  // una persona la escribe.
  const markedLines = new Set<number>();
  code.split('\n').forEach((row, index) => {
    if (row.includes('i18n:plural')) markedLines.add(index + 1);
  });

  const found: UserString[] = [];
  const pending: ts.Node[] = [source];
  while (pending.length > 0) {
    const node = pending.pop() as ts.Node;
    if (!isStringish(node) && !isAdditiveString(node)) {
      ts.forEachChild(node, (child) => {
        pending.push(child);
      });
      continue;
    }

    const segments: Segment[] = [];
    renderTemplate(node as ts.Expression, segments);

    const params: string[] = [];
    const taken = new Set<string>();
    let text = '';
    for (const segment of segments) {
      if ('text' in segment) {
        text += segment.text;
        continue;
      }
      // Las expresiones incrustadas se siguen recorriendo: una cadena dentro de
      // `${cuentas.join(', ')}` es una cadena más y no deja de serlo por estar
      // dentro de otra.
      pending.push(segment.hole);
      const proposed = parameterName(segment.hole);
      const base = /^[A-Za-z_][A-Za-z0-9_]*$/.test(proposed) ? proposed : 'value';
      let name = base;
      let n = 2;
      while (taken.has(name)) {
        name = `${base}${n}`;
        n += 1;
      }
      taken.add(name);
      params.push(name);
      text += `{${name}}`;
    }

    if (positionalReason(node, compared) !== null) continue;
    if (SQL_HEAD.test(text)) continue;
    if (!judgeLanguage(text).spanish) continue;

    const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
    let marked = false;
    for (let row = start - 1; row <= end; row += 1) {
      if (markedLines.has(row)) marked = true;
    }
    found.push({ file, line: start, text, params, needsPlural: marked || PLURAL_SHAPE.test(text) });
  }

  // El recorrido con pila explícita no sale en orden de lectura; el orden lo
  // pone esto. Un carril cuyos ejemplos cambian de sitio entre dos corridas es
  // un carril que nadie compara.
  found.sort((a, b) => a.line - b.line || compareText(a.text, b.text));
  return found;
}

/** Orden por unidad de código, como en `lanes/code.ts` y por lo mismo. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---- El árbol --------------------------------------------------------

/**
 * Los `.ts` bajo una ruta del repositorio, en orden estable.
 *
 * NO SE IMPORTA `tsFiles` DE `lanes/code.ts` —sería un ciclo, porque ese módulo
 * importa éste para publicar el carril— y además aquél está atado a los tres
 * árboles del rector mientras éste tiene que aceptar cualquier ruta, incluido un
 * archivo suelto. Lo que impide que las dos versiones se separen es que el
 * carril usa ÉSTA: el número publicado y el que imprime `--list` salen del mismo
 * recorrido, que es la promesa que hace auditable a un carril.
 */
export function tsFilesUnder(target: string): string[] {
  const absolute = path.resolve(ROOT, target);
  if (!fs.existsSync(absolute)) {
    // El cero que parece una victoria, otra vez: una ruta que no existe daría
    // una lista vacía —o sea, el carril en su meta— sin haber medido nada.
    throw new Error(
      `no existe ${target} bajo ${ROOT}: la lista saldría vacía sin haber mirado nada.`
    );
  }
  const relative = (full: string): string => path.relative(ROOT, full).split(path.sep).join('/');
  if (fs.statSync(absolute).isFile()) return [relative(absolute)];

  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => compareText(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) out.push(relative(full));
    }
  };
  walk(absolute);
  out.sort(compareText);
  return out;
}

/** Las cadenas de usuario de una ruta —archivo o carpeta—, en orden de recorrido. */
export function userStringsUnder(target: string): UserString[] {
  const out: UserString[] = [];
  for (const file of tsFilesUnder(target)) {
    out.push(...userStrings(fs.readFileSync(path.join(ROOT, file), 'utf8'), file));
  }
  return out;
}

// ---- La clave --------------------------------------------------------

/** `Sin cambios: el mayor no se tocó.` → `sin_cambios_el_mayor_no_toco`. */
export function slugFor(text: string): string {
  const words = text
    .replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, ' ')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  return words.slice(0, SLUG_WORDS).join('_');
}

/**
 * El PREFIJO de las claves de un archivo, deducido de su ruta.
 *
 * `src/cli/bank-command.ts` da `bank`, que es el prefijo que I6 ya usó para
 * `bank_run_hit_cap`. `src/cli/kernel/exit.ts` da `exit`. Se puede pisar con
 * `--prefix`, y hace falta: `confirmacion.ts` daría `confirmacion`, y la clave
 * que I6 escribió a mano es `confirm_answer_not_understood`. Un prefijo español
 * es exactamente lo que `--prefix` existe para evitar.
 */
export function prefixFor(file: string): string {
  const base = path.basename(file).replace(/\.ts$/, '').replace(/-command$/, '');
  return slugFor(base) || 'app';
}

/**
 * La clave de una cadena: prefijo + slug, sin chocar con las que ya hay.
 *
 * El desempate es un sufijo numérico y no un slug más largo: dos mensajes que
 * empiezan igual suelen seguir igual, y una clave de treinta caracteres no se
 * lee mejor que una de veinte con un `_2`.
 */
export function keyFor(prefix: string, text: string, taken: ReadonlySet<string>): string {
  const slug = slugFor(text) || 'message';
  const base = `${prefix}_${slug}`;
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

// ---- El plan ---------------------------------------------------------

/** Una cadena lista para entrar al catálogo. */
export interface CatalogEntry {
  key: string;
  /** El español, tal cual, con `{param}` en los huecos. */
  spanish: string;
  params: string[];
  /**
   * TODOS los sitios donde está escrita esa misma frase, no sólo el primero.
   *
   * UN TEXTO REPETIDO ES UNA SOLA CLAVE, y ésa es la mitad del valor de mudar al
   * catálogo. `en.ts` lo dice de la siembra de I6: `Sin cambios: el mayor no se
   * tocó.` vivía igual en tres archivos, «la señal de que una cadena ya era una
   * clave y nadie lo había escrito». Aquí pasa dentro de un mismo archivo:
   * `src/cli/kernel/audit.ts` escribe `R11 llave sin declarar` dos veces. Dos
   * claves para la misma frase harían que una corrección tocara una y dejara la
   * otra vieja, que en pantalla se lee como «el arreglo no llegó».
   *
   * El carril, en cambio, cuenta SITIOS: cada uno es un literal que hay que
   * sustituir por su `t()`, y hasta que se sustituyan los dos el archivo no está
   * traducido.
   */
  sites: { file: string; line: number }[];
  /** El slug es español: quien escriba el inglés tiene que renombrar la clave. */
  keyIsSpanish: boolean;
}

/** Lo que el comando propone para un archivo. */
export interface ExtractionPlan {
  file: string;
  prefix: string;
  entries: CatalogEntry[];
  /** Las que no se transforman: plural a mano, o texto que ICU no acepta. */
  skipped: { hit: UserString; reason: string }[];
}

/**
 * Las claves que ya existen en `en.ts`, para no proponer una repetida.
 *
 * Se leen del TEXTO del catálogo y no importándolo: importarlo obligaría a que
 * `en.ts` compile para poder extraer, y el estado normal mientras se traduce es
 * justamente un catálogo a medio escribir.
 *
 * LAS ENTRECOMILLADAS TAMBIÉN CUENTAN, y ésa era una ceguera medida. I6 sembró
 * claves de identificador (`no_changes_ledger_untouched`) e I7 escribe las
 * suyas con punto y entre comillas (`'cli.risk.undeclared'`), que no son un
 * identificador válido y por eso van citadas. El patrón sólo aceptaba las
 * primeras: medido sobre este árbol daba 13 claves vistas y 320 invisibles
 * (`[...text.matchAll(/^  '([^']+)':/gm)].length`). Una lista de «lo que ya
 * existe» a la que le falta el 96 % no impide nada — es otra vez el cero que
 * parece una victoria.
 */
export function existingKeys(): string[] {
  const catalog = path.join(ROOT, EN_CATALOG);
  if (!fs.existsSync(catalog)) return [];
  const text = fs.readFileSync(catalog, 'utf8');
  const bare = [...text.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*):/gm)].map((m) => m[1]);
  const quoted = [...text.matchAll(/^ {2}'([^']+)':/gm)].map((m) => m[1]);
  return [...bare, ...quoted];
}

/**
 * El plan de un archivo: qué claves nacen, con qué texto, y qué queda fuera.
 *
 * VALIDA CADA MENSAJE CON EL ANALIZADOR DE VERDAD —`messageParameters` de
 * `src/i18n/index.ts`, el mismo recorrido que usa `t()`— antes de proponerlo.
 * Sin esto el extractor podría escribir en el catálogo un texto que `t()`
 * rechaza en tiempo de ejecución: basta con que la cadena original traiga una
 * `{` o una `}` sueltas, que en una plantilla de JavaScript son un carácter más
 * y en ICU son sintaxis. La que no pase se lista aparte, con su razón.
 */
export function planFor(file: string, prefixOverride?: string): ExtractionPlan {
  return planFrom(fs.readFileSync(path.join(ROOT, file), 'utf8'), file, prefixOverride);
}

/**
 * El mismo plan a partir del TEXTO, para poder acotarlo con tres renglones. Es
 * la misma decisión que en `userStrings`, y por la misma razón: una función que
 * sólo se puede ejercitar contra un archivo del árbol es una función cuyas
 * pruebas se caen el día que ese archivo se traduzca — que es el día que se
 * supone que todo salió bien.
 */
export function planFrom(code: string, file: string, prefixOverride?: string): ExtractionPlan {
  const prefix = prefixOverride ?? prefixFor(file);
  const strings = userStrings(code, file);
  const taken = new Set<string>(existingKeys());
  const entries: CatalogEntry[] = [];
  const byText = new Map<string, CatalogEntry>();
  const skipped: { hit: UserString; reason: string }[] = [];

  for (const hit of strings) {
    if (hit.needsPlural) {
      skipped.push({ hit, reason: 'plural a mano (marca `// i18n:plural` o la forma `(s)`)' });
      continue;
    }
    try {
      messageParameters(hit.text, `${hit.file}:${hit.line}`);
    } catch (error) {
      skipped.push({ hit, reason: `ICU no la acepta: ${(error as Error).message}` });
      continue;
    }
    const already = byText.get(hit.text);
    if (already !== undefined) {
      already.sites.push({ file: hit.file, line: hit.line });
      continue;
    }
    const key = keyFor(prefix, hit.text, taken);
    taken.add(key);
    const entry: CatalogEntry = {
      key,
      spanish: hit.text,
      params: hit.params,
      sites: [{ file: hit.file, line: hit.line }],
      keyIsSpanish: isFlagged(slugFor(hit.text)),
    };
    byText.set(hit.text, entry);
    entries.push(entry);
  }
  return { file, prefix, entries, skipped };
}

// ---- Escribir en los catálogos ---------------------------------------

/** Una cadena TypeScript entre comillas simples, con lo justo escapado. */
function quote(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

/**
 * El renglón de una entrada, partido en trozos concatenados si no cabe. Se corta
 * DESPUÉS de un espacio para que el espacio se quede en el trozo de la
 * izquierda: partirlo antes cambiaría el texto, y un catálogo que no dice lo
 * mismo que decía el código no es una migración sino un error de copia.
 */
export function entryLines(key: string, value: string): string[] {
  const single = `  ${key}: ${quote(value)},`;
  if (single.length <= 100) return [single];
  const chunks: string[] = [];
  let chunk = '';
  for (const piece of value.split(/(?<= )/)) {
    if (chunk.length + piece.length > 84 && chunk.length > 0) {
      chunks.push(chunk);
      chunk = '';
    }
    chunk += piece;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return [
    `  ${key}:`,
    ...chunks.map(
      (part, index) => `    ${quote(part)}${index === chunks.length - 1 ? ',' : ' +'}`
    ),
  ];
}

/** El bloque que se añade a `en.ts`: la cita de origen y la marca sin traducir. */
export function englishBlock(plan: ExtractionPlan): string {
  const rows: string[] = ['', `  // --- ${plan.file} (npm run language:extract) ---`];
  for (const entry of plan.entries) {
    const draft = entry.keyIsSpanish
      ? ' Clave borrador: el slug es español, renómbrala al traducir.'
      : '';
    const where = entry.sites.map((site) => `\`${site.file}:${site.line}\``).join(', ');
    rows.push(`  /** ${where}.${draft} */`);
    rows.push(...entryLines(entry.key, UNTRANSLATED));
  }
  return `${rows.join('\n')}\n`;
}

/** El bloque que se añade a `es.ts`: el español que el CLI ya imprime. */
export function spanishBlock(plan: ExtractionPlan): string {
  const rows: string[] = ['', `  // --- ${plan.file} (npm run language:extract) ---`];
  for (const entry of plan.entries) rows.push(...entryLines(entry.key, entry.spanish));
  return `${rows.join('\n')}\n`;
}

/**
 * Mete un bloque justo antes del cierre del objeto del catálogo.
 *
 * Se busca el ÚLTIMO cierre y no el primero: cualquiera de las dos secuencias
 * puede aparecer antes dentro de una cadena del propio catálogo.
 */
function insertBeforeClose(source: string, close: string, block: string): string {
  const at = source.lastIndexOf(close);
  if (at === -1) throw new Error(`no encontré el cierre ${close} del catálogo`);
  return source.slice(0, at) + block + source.slice(at);
}

/** Aplica el plan a los dos catálogos. Devuelve las rutas que tocó. */
export function applyPlan(plan: ExtractionPlan): string[] {
  if (plan.entries.length === 0) return [];
  const english = path.join(ROOT, EN_CATALOG);
  const spanish = path.join(ROOT, ES_CATALOG);
  fs.writeFileSync(
    english,
    insertBeforeClose(fs.readFileSync(english, 'utf8'), '} as const;', englishBlock(plan))
  );
  fs.writeFileSync(
    spanish,
    insertBeforeClose(fs.readFileSync(spanish, 'utf8'), '};', spanishBlock(plan))
  );
  return [EN_CATALOG, ES_CATALOG];
}

// ============================================================
// EL MISMO MÓDULO, EN LA TERMINAL
// ============================================================

const USAGE = [
  'uso: npm run language:extract -- <ruta> [--list] [--write] [--prefix <p>]',
  '',
  '  <ruta>     un archivo .ts o una carpeta bajo la raíz del repositorio.',
  '  (sin nada) imprime el plan: qué claves nacen y con qué texto. No toca nada.',
  '  --list     una línea por cadena de usuario. Es lo que cuenta el carril.',
  '  --write    aplica el plan a src/i18n/en.ts y src/i18n/es.ts.',
  '  --prefix   pisa el prefijo deducido de la ruta.',
  '',
].join('\n');

function printPlan(plan: ExtractionPlan): void {
  const write = (row: string): void => {
    process.stdout.write(`${row}\n`);
  };
  write(`${plan.file} — prefijo \`${plan.prefix}\`, ${plan.entries.length} clave(s) nueva(s).`);
  for (const entry of plan.entries) {
    write('');
    write(`  ${entry.key}${entry.keyIsSpanish ? '   (borrador: el slug es español)' : ''}`);
    write(`    ${entry.sites.map((site) => `${site.file}:${site.line}`).join('  ')}`);
    write(`    es  ${entry.spanish}`);
    write(`    en  ${UNTRANSLATED}`);
    const args = entry.params.length > 0 ? `, { ${entry.params.join(', ')} }` : '';
    write(`    →   t('${entry.key}'${args})`);
  }
  if (plan.skipped.length > 0) {
    write('');
    write(`  ${plan.skipped.length} cadena(s) SIN transformar. Su clave se escribe a mano —con`);
    write('  sus ramas one/other si es plural—, y siguen contando en el carril:');
    for (const row of plan.skipped) {
      write(`    ${row.hit.file}:${row.hit.line}  ${row.reason}`);
      write(`      ${row.hit.text}`);
    }
  }
  write('');
  write('Nada se escribió. Con --write se aplica a src/i18n/en.ts y src/i18n/es.ts.');
}

function main(argv: string[]): number {
  const flags = new Set(argv.filter((arg) => arg.startsWith('--')));
  const prefixAt = argv.indexOf('--prefix');
  const prefix = prefixAt === -1 ? undefined : argv[prefixAt + 1];
  // El valor de `--prefix` no es un posicional. La comparación se hace sólo
  // cuando la bandera está: sin ella `prefixAt` vale -1 y `prefixAt + 1` es 0,
  // que se comía el primer argumento — la ruta — y el comando imprimía su uso
  // en vez de trabajar.
  const positional = argv.filter(
    (arg, index) => !arg.startsWith('--') && !(prefixAt !== -1 && index === prefixAt + 1)
  );
  const target = positional[0];

  if (target === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }

  if (flags.has('--list')) {
    for (const hit of userStringsUnder(target)) {
      process.stdout.write(`${hit.file}:${hit.line}\t${JSON.stringify(hit.text)}\n`);
    }
    return 0;
  }

  const files = tsFilesUnder(target);
  if (files.length > 1 && flags.has('--write')) {
    // El plan de una carpeta entera son cientos de claves borrador en un solo
    // commit, y una clave es identidad. Se hace archivo por archivo, que es
    // también como se revisa.
    process.stderr.write(
      `--write toma UN archivo; ${target} son ${files.length}. Usa --list para verlos.\n`
    );
    return 2;
  }

  for (const file of files) {
    const plan = planFor(file, prefix);
    if (!flags.has('--write')) {
      printPlan(plan);
      continue;
    }
    const touched = applyPlan(plan);
    process.stdout.write(
      touched.length === 0
        ? `${file}: nada que extraer.\n`
        : `${file}: ${plan.entries.length} clave(s) en ${touched.join(' y ')}. ` +
            `Traduce las ${UNTRANSLATED} — tests/i18n/sync.spec.ts las rechaza.\n`
    );
  }
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
