// ============================================================
// EL LÉXICO COMPARTIDO (I1 · issue #143)
//
// UNA SOLA POBLACIÓN Y UN SOLO LÉXICO. El metro (`language:status`, I2) y el
// lint (`house/english-identifiers`, I3) tienen que contar LO MISMO: si cada
// uno trae su propia lista, el número que publica el metro y el que el lint
// pone en rojo divergen, y entonces nadie sabe cuál de los dos miente. La
// lista es `lexicon.json`, aquí al lado —dato que leen los dos mundos, ver
// más abajo por qué—, y `tokenize`/`classify` son ese recorrido.
//
// POR QUÉ ESTÁ RECONSTRUIDO Y NO COPIADO. La investigación de 2026-09-06
// documenta una lista curada a mano —1 128 raíces, 226 neutros— en archivos
// `datos/es_sorted.txt` y `datos/neutral_sorted.txt`. Esos archivos NO se
// comprometieron: al fusionarse la investigación entraron los .md y se
// perdieron los datos. El método sí quedó escrito, así que se rehízo con él:
// se extrajeron las declaraciones de `src/`, se tokenizaron, se clasificaron
// contra el diccionario del sistema (web2, 235 976 entradas) y se curaron a
// mano los 2 244 tokens que quedaron fuera. Las cifras son mayores que las de
// la investigación porque el recorrido cubre además miembros de interfaz y
// propiedades, y porque el árbol creció.
//
// LA REGLA QUE GOBIERNA LAS DUDAS, y explica por qué NEUTROS es tan grande:
// un falso positivo manda a una persona a renombrar código que está bien
// escrito, y a la tercera vez esa persona deja de mirar el instrumento; un
// falso negativo deja español sin señalar y lo caza la pasada siguiente. Los
// dos errores no cuestan lo mismo, así que ante la duda: neutro.
// ============================================================

import lexiconData from './lexicon.json';

// ============================================================
// LAS LISTAS SON DATO, Y VIVEN EN `lexicon.json`
//
// Estaban escritas aquí, en cuatro literales, hasta que I3 (issue #145) puso
// la puerta. La regla `house/english-identifiers` vive en `eslint.config.mjs`,
// que es ESM plano y NO puede importar este archivo: no hay `allowJs`, no hay
// paso de compilación para el lint, y ESLint carga su configuración con el
// Node de siempre. Copiarle las listas habría dado DOS listas — y con ellas
// los dos números que este mismo archivo empieza advirtiendo que no puede
// haber.
//
// Así que se parte DATO de LÓGICA. Las palabras se van a `lexicon.json`, que
// leen los dos mundos; aquí se quedan la lógica y, sobre todo, LA PROSA. La
// prosa no se muda: un JSON no puede decir por qué `mayor` cuenta como
// española ni por qué ante la duda se elige neutro, y es esa mitad la que
// evita que la lista crezca por comodidad.
//
// Lo que sí queda duplicado es `tokenize`/`classify`, reescrito en JavaScript
// dentro de `eslint.config.mjs`: unas treinta líneas, que son el precio del
// cruce de mundos. Lo que impide que las dos versiones se separen no es el
// cuidado de nadie, sino la prueba de conformidad que las corre a las dos
// sobre el mismo corpus.
// ============================================================

/** La forma del JSON. Sus claves van en inglés, como toda identidad. */
interface LexiconData {
  spanishRoots: string[];
  neutralTokens: string[];
  englishExtra: string[];
  domainTerms: Record<string, string>;
}

// El JSON lleva además claves que empiezan por `_`: prosa para quien lo abra
// —qué es y dónde están las razones—, no listas. No se leen aquí, y la
// aserción es lo que dice que sobran: `resolveJsonModule` infiere la forma que
// el archivo tiene HOY y esta interfaz es la que el léxico EXIGE.
const DATA = lexiconData as LexiconData;

/**
 * UNA LISTA QUE FALTA NO ES UNA LISTA VACÍA, y hasta que las palabras vivieron
 * en un JSON esto no podía pasar.
 *
 * `new Set(undefined)` devuelve un conjunto vacío sin quejarse. Con
 * `spanishRoots` ausente o vaciada, `classify` diría «inglés» de todo: el metro
 * publicaría CERO identificadores españoles —que es exactamente su meta— y el
 * lint dejaría de señalar. Las dos cosas en verde, las dos falsas. Un léxico
 * que no encuentra sus palabras tiene que callarse ruidosamente, no aprobarlo
 * todo.
 */
function listFrom(key: 'spanishRoots' | 'neutralTokens' | 'englishExtra'): ReadonlySet<string> {
  const list = DATA[key];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      `lexicon.json no trae '${key}' o la trae vacía: sin esa lista el léxico daría todo por ` +
        'inglés y tanto el metro como el lint quedarían en verde sin haber mirado nada.'
    );
  }
  return new Set(list);
}

/** Clase de un token, y de ahí la del identificador que lo contiene. */
export type TokenClass = 'es' | 'en' | 'neutral';

/** Clase de un identificador completo. */
export type IdentifierClass = 'es' | 'en' | 'mixed' | 'neutral';

/**
 * RAÍCES ESPAÑOLAS. Un token de aquí, y sin ningún token inglés, hace que el
 * identificador se señale.
 *
 * Incluye las que el diccionario inglés da por buenas —`mayor`, `banco`,
 * `estado`, `asiento`, `cargo`, `folio`, `norma`, `lote`, `clave`, `ruta`—
 * porque ésas son las que se cuelan sin que nadie las mire: la clasificación
 * automática las declara inglesas y el español viaja escondido en ellas.
 */
export const SPANISH_ROOTS: ReadonlySet<string> = listFrom('spanishRoots');

/**
 * NEUTROS. No distinguen idioma, así que NUNCA señalan.
 *
 * Cuatro familias: acrónimos de dominio y de ley (cfdi, rfc, iva, imss, sat,
 * diot, nif, fica, futa), abreviaturas técnicas (id, uuid, ctx, json, sql,
 * deps, opts), marcas y nombres propios (redis, stripe, postgres, sovos), y
 * las palabras que se escriben igual en los dos idiomas —sea porque lo son
 * (`error`, `base`, `total`, `fiscal`, `control`, `final`) o porque coinciden
 * al quitar el acento (`decision`, `version`, `region`, `provision`)—.
 *
 * También caen aquí los TROZOS que la tokenización produce y que no son
 * palabras de ningún idioma (`emis`, `undep`, `ots`): señalar un fragmento es
 * señalar un accidente del recorrido, no una decisión de quien escribió.
 */
export const NEUTRAL_TOKENS: ReadonlySet<string> = listFrom('neutralTokens');

/**
 * INGLESAS QUE EL DICCIONARIO NO TRAE. web2 es de 1913 y le faltan
 * participios regulares y vocabulario técnico moderno, así que sin esta lista
 * `parsed`, `mapped`, `webhook` o `payload` se señalarían como españolas.
 */
export const ENGLISH_EXTRA: ReadonlySet<string> = listFrom('englishExtra');

/**
 * TÉRMINOS DE DOMINIO QUE SE QUEDAN EN ESPAÑOL. Nace VACÍA, y esto no es un
 * descuido: es la puerta por la que se escapa un plan de traducción.
 *
 * La tentación, cuando un renombrado cuesta, es declarar la palabra «término
 * de dominio» y seguir. Por eso la lista empieza vacía y **cada entrada
 * futura tiene que traer su razón escrita al lado** —no «es de dominio», sino
 * qué se rompe si se traduce: un catálogo externo que casa por nombre, un
 * contrato publicado, una columna que un tercero lee—. Un término aquí sin
 * esa frase es una excepción sin dueño.
 */
export const DOMAIN_TERMS: ReadonlyMap<string, string> = new Map(Object.entries(DATA.domainTerms));

/**
 * Parte un identificador en tokens: camelCase, PascalCase, snake_case,
 * SCREAMING_CASE, kebab-case y las fronteras con dígitos. Todo a minúsculas.
 *
 * `RFCValido` da ['rfc', 'valido'] y no ['rfcvalido']: la regla de la sigla
 * seguida de palabra —`([A-Z]+)([A-Z][a-z])`— es la que hace que un acrónimo
 * pegado a una palabra española no esconda a la española.
 */
export function tokenize(identifier: string): string[] {
  const conEspacios = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return conEspacios
    .split(/[^A-Za-z0-9]+|\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());
}

/**
 * La clase de UN token, con precedencia estricta: español gana a neutro, y
 * neutro gana a inglés. El orden importa —`estado` está en el diccionario
 * inglés y aun así es español aquí— y por eso la lista española se consulta
 * primero.
 */
export function classifyToken(token: string): TokenClass {
  if (SPANISH_ROOTS.has(token)) return 'es';
  if (NEUTRAL_TOKENS.has(token)) return 'neutral';
  if (ENGLISH_EXTRA.has(token)) return 'en';
  if (/^[0-9]+$/.test(token)) return 'neutral';
  // EXENCIÓN ESCRITA: dos letras o menos no dicen de qué idioma son. `id`,
  // `ok`, `db`, `mx`, `js` — señalarlas sería ruido puro.
  if (token.length <= 2) return 'neutral';
  return 'en';
}

/**
 * La clase de un IDENTIFICADOR a partir de sus tokens:
 *   ≥1 español y 0 inglés → es · ≥1 inglés y 0 español → en
 *   los dos → mixed · sólo neutros → neutral
 *
 * `mixed` no es un estado intermedio benigno: `calcularBalance` está a medio
 * traducir, que suele ser peor que estar entero en un idioma, porque el
 * siguiente que lo lea no sabrá cuál de las dos mitades es la convención.
 */
export function classify(identifier: string): IdentifierClass {
  const tokens = tokenize(identifier);
  if (tokens.length === 0) return 'neutral';
  let es = false;
  let en = false;
  for (const t of tokens) {
    if (DOMAIN_TERMS.has(t)) continue;
    const c = classifyToken(t);
    if (c === 'es') es = true;
    else if (c === 'en') en = true;
  }
  if (es && en) return 'mixed';
  if (es) return 'es';
  if (en) return 'en';
  return 'neutral';
}

/**
 * LO QUE ESTE LÉXICO NO PUEDE VER, medido y no supuesto.
 *
 * Sobre las 200 declaraciones etiquetadas a mano (tests/language/muestra200.tsv)
 * acierta 198. Los dos fallos no son tokens que falten: son las dos cosas que
 * una lista de palabras no alcanza, y conviene que estén escritas para que
 * nadie las persiga con más entradas.
 *
 *   · LA ABREVIATURA SE JUZGA POR SÍ MISMA, no por la palabra que abrevia.
 *     `infEr` es inglés —`inf` de INFONAVIT más `er` de employer— y aquí sale
 *     neutro, porque ninguno de sus dos trozos dice idioma. Juzgar por la
 *     palabra abreviada exigiría un diccionario de abreviaturas del proyecto,
 *     y ése es un instrumento distinto.
 *
 *   · LA POSICIÓN NO SE MIRA. `resolverRouting` es mixto —`resolver` es el
 *     verbo español— y `makeEntityResolver` es inglés puro, con el MISMO
 *     token: en uno es verbo español y en otro sustantivo inglés. Para
 *     distinguirlos hace falta la posición en el nombre, no la lista.
 *
 * Y una tercera que la muestra enseñó sin llegar a fallar: el ORDEN DE LAS
 * PALABRAS delata el idioma cuando los tokens no. `final_balance` convive con
 * `beginning_balance` y es inglés; `jsonOriginal` se lee «el json original» y
 * es español. Los dos salen neutros, que es lo correcto para un instrumento
 * que mide tokens: si algún día alguien quiere esa señal, es sintaxis y va en
 * otra capa.
 */
/** ¿Este identificador se señala? Español entero o a medias, las dos cosas. */
export function isFlagged(identifier: string): boolean {
  const c = classify(identifier);
  return c === 'es' || c === 'mixed';
}
