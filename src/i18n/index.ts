import { EN } from './en.js';
import { ES } from './es.js';
import { languageOfLocale, resolveLocale } from './locale.js';
import { choosePluralBranch, chooseSelectBranch } from './plural.js';

// ============================================================
// EL CATÁLOGO, `t()` Y SU ANALIZADOR (I6 · issue #148)
//
// ESTE ARCHIVO NO LEE EL ENTORNO, y es un criterio del tramo y no una
// preferencia: la variable de idioma se leía en DOS sitios a la vez
// —`src/ai/providers/config.ts:1132` y `src/cli/mnemosine.ts:2238`—, así que el
// CLI y el agente podían resolver idiomas distintos en la misma corrida sin que
// nada lo dijera. La issue exige UN SOLO LECTOR en todo `src/`, y ése es
// `src/i18n/locale.ts`. Aquí no se toca `process` de ninguna clase, y la §7 de
// `tests/i18n/sync.spec.ts` lo comprueba sobre el árbol del compilador.
//
// PERO NO LEER EL ENTORNO NO ES NO PREGUNTAR. Este archivo LLAMA a
// `resolveLocale()` —el lector único— y proyecta lo que devuelve con
// `languageOfLocale()`. La diferencia entre las dos cosas es todo el tramo, y
// que se confundieran es el defecto que este arreglo cierra: aquí decía
// `let activeLanguage: Language = LANGUAGES[0]`, el idioma quedaba fijado AL
// IMPORTAR, y `setLanguage()` no tenía un solo llamador en `src/`. Medido con
// el locale del proceso en `en-US` —que es el que la suite unitaria fija en
// `vitest.config.ts`—: `resolveLocale()` decía `en-US` y `t()` imprimía en
// español, en la misma corrida, con las cuarenta pruebas en verde.
//
// LA IMPORTACIÓN VA EN UN SOLO SENTIDO. `locale.ts` no importa nada de esta
// carpeta —es hoja a propósito—, así que `index.ts → locale.ts` no cierra
// ningún ciclo. El día que alguien quiera usar `isLanguage()` desde `locale.ts`,
// la respuesta es no: ver su docstring, más abajo.
//
// Y POR ESO EL NOMBRE DE LA VARIABLE NO SE ESCRIBE AQUÍ, ni en un comentario.
// El criterio se defiende contando en cuántos archivos de `src/` APARECE, y un
// censo de texto no distingue una lectura de una explicación: nombrarla en la
// prosa de un archivo que jamás la lee es la forma más tonta de poner el
// criterio en rojo. Vive escrita, una vez, donde se lee.
//
// IDIOMA ≠ FORMATO (regla 5 del epic). `t()` devuelve TEXTO. No formatea
// dinero, ni fechas, ni números: un `{amount}` llega ya como cadena, hecha por
// `src/i18n/format.ts` con el `formatLocale` de la jurisdicción de la entidad.
// La consecuencia práctica está en `#`, más abajo: imprime la cuenta TAL CUAL
// se la dieron, sin agrupar y sin pasar por `Number`.
//
// UN SUBCONJUNTO DE ICU, ESCRITO A MANO, Y POR QUÉ NO UNA BIBLIOTECA (D11)
//
// La sintaxis que se entiende es exactamente ésta:
//
//     {name}                                   interpolación
//     {name, plural, one {# fila} other {# filas}}
//     {name, select, ended {terminó} other {sigue}}
//     #                                        la cuenta, dentro de un plural
//
// No hay `selectordinal`, no hay `{n, number}` —eso es formato y vive en otro
// archivo— y no hay escape de llaves. Lo último es una limitación de verdad: el
// día que una cadena necesite un `{` literal se añade el `''` de ICU, con su
// prueba. Fingir que ya está resuelto sería peor que decirlo.
//
// EL ANÁLISIS ES UNO SOLO, Y ESTO ES LO MENOS OBVIO DE AQUÍ. `t()` y
// `messageParameters()` recorren el mensaje con el MISMO `walk`, cambiando sólo
// qué se hace al llegar a un parámetro. Si fueran dos recorridos, la prueba de
// sincronía estaría comprobando los parámetros de una gramática y el CLI
// imprimiría con otra — y el día que se separaran, la prueba seguiría en verde.
//
// UN MENSAJE MAL FORMADO LANZA, y no se «arregla» solo. El catálogo es dato
// COMPILADO: no llega de un archivo del usuario ni de la base, así que un
// mensaje roto es un error de programación que la prueba de sincronía ve —
// analiza las trece cadenas de los dos idiomas— antes de que llegue a nadie. La
// alternativa, imprimir `{count}` en la pantalla de un contador o, peor, dentro
// del archivo que `-o` prometió, es un defecto que sí se escapa.
// ============================================================

/**
 * LOS IDIOMAS, Y EL ESPAÑOL PRIMERO. No es orden alfabético ni casualidad: es
 * el pedido del dueño y el valor por omisión de todo lo que hay debajo. Que sea
 * una LISTA y no un par es lo que hace que un tercer idioma sea «un archivo
 * más»: se añade aquí, `CATALOGS` deja de compilar hasta que exista su
 * catálogo, y la prueba de sincronía no cambia una línea porque nunca supo
 * cuántos había.
 */
export const LANGUAGES = ['es', 'en'] as const;

export type Language = (typeof LANGUAGES)[number];

/** Las claves del catálogo. `en.ts` es la fuente; ver `es.ts`. */
export type TranslationKey = keyof typeof EN;

export type Catalog = Readonly<Record<TranslationKey, string>>;

/**
 * Un catálogo por idioma. El tipo es `Record<Language, Catalog>` a propósito:
 * añadir 'pt' a `LANGUAGES` rompe la compilación AQUÍ, en un renglón, en vez de
 * fallar en tiempo de ejecución la primera vez que alguien pida el idioma que
 * nadie escribió.
 */
export const CATALOGS: Readonly<Record<Language, Catalog>> = { es: ES, en: EN };

/**
 * La marca que un traductor deja donde todavía no tradujo. Vive aquí —y no
 * escrita a mano en la prueba— porque una marca con dos ortografías es una
 * marca que no detiene nada: la prueba rechaza EXACTAMENTE lo que un traductor
 * pegaría leyendo este archivo.
 */
export const UNTRANSLATED_MARKER = '__TRANSLATE__';

/** Lo que se puede meter en un hueco. Nada más: ni `Date` ni `Decimal`. */
export type MessageValue = string | number;

export type MessageParams = Readonly<Record<string, MessageValue>>;

// ---- El idioma activo -----------------------------------------------

/**
 * EL IDIOMA CLAVADO A MANO, o `null` si nadie lo clavó. Ojo al nombre: esto NO
 * es «el idioma activo», es la EXCEPCIÓN al idioma activo.
 *
 * Aquí vivía `let activeLanguage: Language = LANGUAGES[0]`, y esa línea era el
 * tramo entero sin efecto: el valor se decidía al importar y nada volvía a
 * moverlo nunca. Arranca en `null` a propósito, para que el estado por omisión
 * de este módulo sea «pregúntaselo al resolutor» y no «español porque sí».
 */
let pinnedLanguage: Language | null = null;

/**
 * Los avisos que el resolutor ya dio, para no repetirlos.
 *
 * Derivar el idioma en CADA mensaje multiplica también las quejas: con un
 * locale inservible puesto en el entorno, `resolveLocale()` avisa una vez POR
 * LLAMADA, y una pantalla de cuarenta renglones traería cuarenta veces el mismo
 * aviso. Se deduplica por el TEXTO exacto, así que un valor inservible distinto
 * —o el mismo tras un `resetLanguage()`— sí vuelve a avisar.
 */
const warningsAlreadyGiven = new Set<string>();

function warnOnce(message: string): void {
  if (warningsAlreadyGiven.has(message)) return;
  warningsAlreadyGiven.add(message);
  console.warn(message);
}

/**
 * El idioma activo, DERIVADO en el momento en que se pregunta.
 *
 * Sin idioma clavado se le pregunta a `resolveLocale()` —el único lector del
 * entorno de `src/`— y se proyecta con `languageOfLocale()`, que es quien sabe
 * que `es-MX` se lee del catálogo `es`. Se vuelve a preguntar en CADA llamada, y
 * es deliberado: la alternativa es un caché, y un caché que este archivo no
 * sabría invalidar —no mira el entorno, ni debe— es el defecto de antes con una
 * capa de pintura encima. Así, si el proceso cambia de locale entre dos
 * llamadas, `t()` cambia; `tests/i18n/sync.spec.ts` §8b lo demuestra con la
 * misma clave y dos locales en una sola corrida.
 *
 * LO QUE NO ALCANZA, DICHO AQUÍ PARA QUE NO SE PROMETA DE MÁS: se llama a
 * `resolveLocale()` SIN opciones, así que este camino sólo recorre los escalones
 * que el resolutor saca del proceso —la bandera, el entorno, los dos archivos de
 * configuración— y NUNCA el de `tenants.settings.locale`, que exige un valor ya
 * leído de la base y no hay de dónde sacarlo desde una función que sólo tiene
 * una clave de catálogo delante. Quien atienda a un inquilino con locale propio
 * tiene que resolverlo donde ya tiene conexión y clavarlo con `setLanguage()`;
 * es la misma frontera que `locale.ts` describe en `tenantLocale`, salida (c).
 *
 * LO QUE CUESTA, MEDIDO EN ESTE ÁRBOL (20 000 llamadas, Node 22, macOS): 21 µs
 * por llamada sin archivos de configuración presentes y 14 µs con
 * `~/.mnemosine/config.json` presente — el caso caro es el ENOENT de un archivo
 * que no está, no la lectura de uno que sí. Es coste por MENSAJE y no por celda:
 * el dinero de una tabla lo formatea `src/i18n/format.ts`, que no pasa por aquí.
 * Y cuando el arranque del CLI clave el idioma —eso es I7/I8, no este tramo— el
 * coste desaparece: un idioma clavado se devuelve sin tocar el disco.
 */
export function getLanguage(): Language {
  if (pinnedLanguage !== null) return pinnedLanguage;
  return languageOfLocale(resolveLocale({ onWarning: warnOnce }));
}

/**
 * CLAVA el idioma, y con eso apaga la derivación hasta que alguien llame a
 * `resetLanguage()`.
 *
 * Es para quien YA resolvió el locale y no quiere que se resuelva otra vez: el
 * arranque del CLI (I7/I8) y las pruebas. No es el camino normal — el normal es
 * no llamar a nadie y dejar que `getLanguage()` derive.
 */
export function setLanguage(language: Language): void {
  pinnedLanguage = language;
}

/**
 * Suelta el idioma clavado: el siguiente `t()` vuelve a derivarlo. Olvida
 * también los avisos ya dados, porque «vuelve a preguntar» incluye «vuelve a
 * quejarte si la respuesta sigue siendo mala».
 *
 * Hace falta fuera de las pruebas, y por eso es público: un proceso largo que
 * atiende a varios usuarios —el servidor de `src/api/`— no puede quedarse con el
 * idioma del primero que entró. Un `setLanguage()` sin vuelta atrás sería
 * exactamente el caché global que `locale.ts` rechaza por escrito en
 * `ResolveLocaleOptions.tenantLocale`, salida (b).
 */
export function resetLanguage(): void {
  pinnedLanguage = null;
  warningsAlreadyGiven.clear();
}

/**
 * ¿Esta cadena es uno de los idiomas que hay?
 *
 * NO LO LLAMA `locale.ts`, y no puede: desde este arreglo la importación va de
 * `index.ts` a `locale.ts`, y al revés sería un ciclo. Lo que decía antes aquí
 * —«existe para que `locale.ts` estreche el subtag primario»— describía un
 * llamador que no existe y que además ya no podría existir. Hoy tiene un solo
 * llamador y es la prueba; se exporta porque es la forma correcta de estrechar
 * una cadena que venga de fuera —un JSON, una bandera, una respuesta de la
 * base— sin escribir en el sitio de llamada una segunda lista de idiomas.
 */
export function isLanguage(value: unknown): value is Language {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

// ---- El analizador ---------------------------------------------------

interface Cursor {
  readonly text: string;
  index: number;
}

type ParameterKind = 'value' | 'plural' | 'select';

interface ParsedParameter {
  readonly name: string;
  readonly kind: ParameterKind;
  /** Vacío para un `{name}` pelado. */
  readonly branches: ReadonlyMap<string, string>;
}

const NO_BRANCHES: ReadonlyMap<string, string> = new Map<string, string>();

/**
 * El error de un mensaje roto trae SIEMPRE la clave y el texto. Un
 * «unexpected token» sin decir de qué cadena obliga a buscar a mano entre
 * trece; con la clave delante, el arreglo es un renglón.
 */
function malformed(label: string, reason: string, text: string): never {
  throw new Error(`i18n: message "${label}" is malformed: ${reason} — «${text}»`);
}

function skipBlanks(cursor: Cursor): void {
  while (cursor.index < cursor.text.length && /\s/.test(cursor.text.charAt(cursor.index))) {
    cursor.index += 1;
  }
}

/** El nombre del parámetro: desde `{` hasta la primera `,` o `}`. */
function readParameterName(cursor: Cursor, label: string): string {
  const start = cursor.index;
  while (cursor.index < cursor.text.length) {
    const char = cursor.text.charAt(cursor.index);
    if (char === ',' || char === '}' || char === '{') break;
    cursor.index += 1;
  }
  const name = cursor.text.slice(start, cursor.index).trim();
  if (!name) malformed(label, 'a placeholder has no parameter name', cursor.text);
  // El nombre tiene que ser un identificador. Sin esto, `{co unt}` es un
  // parámetro perfectamente válido llamado «co unt» que ningún sitio de llamada
  // puede pasar nunca, y el mensaje sale con el hueco vacío en vez de fallar.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    malformed(label, `"${name}" is not a usable parameter name`, cursor.text);
  }
  return name;
}

/** Una palabra suelta: `plural`, `select`, o el nombre de una rama. */
function readWord(cursor: Cursor): string {
  const start = cursor.index;
  while (cursor.index < cursor.text.length && !/[\s,{}]/.test(cursor.text.charAt(cursor.index))) {
    cursor.index += 1;
  }
  return cursor.text.slice(start, cursor.index);
}

/**
 * El cuerpo de una rama, contando llaves anidadas: `one {# de {total}}` termina
 * en su PROPIA llave y no en la primera que aparezca. Contar mal aquí parte el
 * mensaje por la mitad y el resto sale como texto.
 */
function readBranchBody(cursor: Cursor, label: string): string {
  const start = cursor.index + 1;
  let depth = 0;
  while (cursor.index < cursor.text.length) {
    const char = cursor.text.charAt(cursor.index);
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = cursor.text.slice(start, cursor.index);
        cursor.index += 1;
        return body;
      }
    }
    cursor.index += 1;
  }
  malformed(label, 'a branch is missing its closing brace', cursor.text);
}

function readBranches(cursor: Cursor, label: string, name: string): Map<string, string> {
  const branches = new Map<string, string>();
  for (;;) {
    skipBlanks(cursor);
    if (cursor.index >= cursor.text.length) {
      malformed(label, `"${name}" is missing its closing brace`, cursor.text);
    }
    if (cursor.text.charAt(cursor.index) === '}') break;
    const branch = readWord(cursor);
    if (!branch) malformed(label, `"${name}" has a branch with no name`, cursor.text);
    skipBlanks(cursor);
    if (cursor.text.charAt(cursor.index) !== '{') {
      malformed(label, `branch "${branch}" of "${name}" has no body`, cursor.text);
    }
    // Una rama repetida es una traducción que se pisa a sí misma y que en
    // pantalla se ve como «la corrección no llegó»: la segunda gana en silencio.
    if (branches.has(branch)) {
      malformed(label, `branch "${branch}" of "${name}" appears twice`, cursor.text);
    }
    branches.set(branch, readBranchBody(cursor, label));
  }
  return branches;
}

function readParameter(cursor: Cursor, label: string): ParsedParameter {
  cursor.index += 1; // la `{`
  const name = readParameterName(cursor, label);
  skipBlanks(cursor);
  const afterName = cursor.text.charAt(cursor.index);
  if (afterName === '}') {
    cursor.index += 1;
    return { name, kind: 'value', branches: NO_BRANCHES };
  }
  if (afterName !== ',') malformed(label, `"${name}" is missing its closing brace`, cursor.text);
  cursor.index += 1;
  skipBlanks(cursor);
  const kind = readWord(cursor);
  if (kind !== 'plural' && kind !== 'select') {
    malformed(
      label,
      `"${name}" declares "${kind}", and only plural and select exist here ` +
        '(number and date formatting live in src/i18n/format.ts)',
      cursor.text,
    );
  }
  skipBlanks(cursor);
  if (cursor.text.charAt(cursor.index) !== ',') {
    malformed(label, `"${name}" declares ${kind} with no branches`, cursor.text);
  }
  cursor.index += 1;
  const branches = readBranches(cursor, label, name);
  cursor.index += 1; // la `}` que cierra el parámetro
  // 'other' OBLIGATORIA. Sin ella, una cuenta de 3 en un idioma con 'few' no
  // tendría nada que imprimir, y el hueco saldría vacío en pantalla en vez de
  // fallar aquí, donde la prueba lo ve.
  if (!branches.has('other')) {
    malformed(label, `"${name}" has no "other" branch`, cursor.text);
  }
  return { name, kind, branches };
}

type ParameterResolver = (parameter: ParsedParameter, hash: string | undefined) => string;

/**
 * El ÚNICO recorrido del mensaje. `hash` es lo que imprime `#`: llega definido
 * sólo dentro de una rama de plural, y se hereda hacia dentro para que un
 * `select` anidado siga sabiendo de qué cuenta hablaba.
 */
function walk(
  text: string,
  label: string,
  hash: string | undefined,
  resolve: ParameterResolver,
): string {
  const cursor: Cursor = { text, index: 0 };
  let out = '';
  while (cursor.index < text.length) {
    const char = text.charAt(cursor.index);
    if (char === '#' && hash !== undefined) {
      out += hash;
      cursor.index += 1;
      continue;
    }
    if (char === '}') {
      // A este nivel toda `}` legítima ya la consumió `readBranchBody`. Lo que
      // queda es un `{count}}` de dedo, y dejarlo pasar imprimiría la llave.
      malformed(label, 'unbalanced closing brace', text);
    }
    if (char !== '{') {
      out += char;
      cursor.index += 1;
      continue;
    }
    out += resolve(readParameter(cursor, label), hash);
  }
  return out;
}

// ---- Renderizar ------------------------------------------------------

function catalogFor(language: Language): Catalog {
  // El tipo dice que esto no puede faltar; el entorno dice otra cosa. `t()`
  // recibe lo que resolvió `locale.ts` a partir de una bandera, una variable de
  // entorno o un JSON de configuración, y una cadena que se coló sin pasar por
  // `isLanguage` llegaría aquí como un idioma que no existe. Se cae al primero
  // —español— en vez de reventar: un CLI que no arranca porque alguien escribió
  // mal una variable de entorno es peor que uno que imprime en español.
  const catalog: Catalog | undefined = CATALOGS[language];
  return catalog ?? CATALOGS[LANGUAGES[0]];
}

/**
 * El mensaje `key`, en `language`, con sus huecos llenos.
 *
 * Un parámetro que falta LANZA, con la clave y el nombre del hueco. Es la
 * decisión incómoda de este archivo y va escrita: la alternativa —dejar
 * `{amount}` escrito en pantalla— convierte un error de programación en un
 * documento equivocado que alguien archiva. Que los dos idiomas piden los
 * MISMOS parámetros lo garantiza `tests/i18n/sync.spec.ts`, así que un sitio de
 * llamada correcto en español lo es también en inglés.
 *
 * EL TERCER ARGUMENTO SE OMITE CASI SIEMPRE, y entonces el idioma sale de
 * `getLanguage()` EN CADA LLAMADA. Que la omisión sea una LLAMADA y no la
 * lectura de una variable de módulo es justo lo que hace que el catálogo esté
 * cableado: un `= activeLanguage` aquí volvería a atar `t()` al valor que el
 * módulo tuviera al importarse, que es el defecto que este arreglo cierra. Se
 * nombra el idioma a mano sólo para imprimir en uno que no es el del usuario, y
 * hoy el único caso es la prueba de sincronía, que recorre los dos catálogos.
 */
export function t(
  key: TranslationKey,
  params: MessageParams = {},
  language: Language = getLanguage(),
): string {
  const message = catalogFor(language)[key];
  if (typeof message !== 'string') {
    throw new Error(`i18n: there is no message named "${String(key)}"`);
  }

  const resolve: ParameterResolver = (parameter, hash) => {
    const given: MessageValue | undefined = params[parameter.name];
    if (given === undefined) {
      throw new Error(
        `i18n: "${String(key)}" needs the parameter "${parameter.name}" and none was given`,
      );
    }
    // La cuenta se imprime TAL CUAL llegó. Un `Number(importe)` aquí sería el
    // redondeo que este sistema prohíbe (`output.ts:176-183` lo dice para el
    // dinero), y agrupar los miles sería usurpar el trabajo de la jurisdicción.
    const text = typeof given === 'number' ? String(given) : given;

    if (parameter.kind === 'value') return text;

    if (parameter.kind === 'select') {
      const body = chooseSelectBranch(parameter.branches, text);
      if (body === undefined) {
        malformed(String(key), `"${parameter.name}" has no branch for "${text}"`, message);
      }
      return walk(body, String(key), hash, resolve);
    }

    const count = typeof given === 'number' ? given : Number(given);
    const body = choosePluralBranch(parameter.branches, language, count);
    if (body === undefined) {
      malformed(String(key), `"${parameter.name}" has no branch for ${text}`, message);
    }
    return walk(body, String(key), text, resolve);
  };

  return walk(message, String(key), undefined, resolve);
}

// ---- Lo que la sincronía necesita saber ------------------------------

export interface MessageParameter {
  readonly name: string;
  readonly kind: ParameterKind;
  /** Las ramas, ordenadas. Vacío para un `{name}` pelado. */
  readonly branches: readonly string[];
}

/**
 * Los parámetros de un mensaje, con su clase y sus ramas.
 *
 * Es lo que hace comparable un catálogo con otro: `{command}` traducido a
 * `{comando}` compila, pasa el `Record` de `es.ts` y sale con el hueco vacío en
 * la terminal de alguien. Aquí se ve como dos listas distintas.
 *
 * Ordena con `<` y no con `localeCompare`: un orden que depende del idioma de la
 * máquina que corre la prueba es, literalmente, el defecto que este tramo viene
 * a cerrar.
 */
export function messageParameters(message: string, label = 'message'): MessageParameter[] {
  const found = new Map<string, MessageParameter>();
  const collect: ParameterResolver = (parameter, hash) => {
    if (!found.has(parameter.name)) {
      found.set(parameter.name, {
        name: parameter.name,
        kind: parameter.kind,
        branches: [...parameter.branches.keys()].sort(compareNames),
      });
    }
    // Se entra a TODAS las ramas, no sólo a la que se imprimiría: un parámetro
    // que sólo aparece dentro de `other` es igual de obligatorio.
    for (const body of parameter.branches.values()) walk(body, label, hash, collect);
    return '';
  };
  walk(message, label, undefined, collect);
  return [...found.values()].sort((a, b) => compareNames(a.name, b.name));
}

function compareNames(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
