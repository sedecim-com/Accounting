import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ============================================================
// EL LOCALE — I6 · issue #148 · regla 5 del epic #141
//
// IDIOMA ≠ FORMATO ≠ JURISDICCIÓN, y este archivo sólo resuelve el PRIMERO de
// los tres. El locale dice en qué idioma habla el binario y, de rebote, con qué
// convenciones se IMPRIME lo que se lee en pantalla. NO dice en qué moneda opera
// la entidad ni qué calendario fiscal la rige —eso lo fija su jurisdicción— y no
// toca un byte de lo que se entrega a una autoridad: el XML del Anexo 24 y la
// DIOT se escriben igual con `--locale en-US` que con `--locale es-MX`.
//
// POR QUÉ ESTE ARCHIVO EXISTE, Y NO ES UN REFACTOR DE ESTILO
//
// `MNEMOSINE_LANG` se leía en DOS sitios —`src/ai/providers/config.ts:1132`
// dentro de `resolveLanguage`, y `src/cli/mnemosine.ts:2238` para el aviso de
// `mnemosine lang`—, y los dos habían derivado sin que nadie lo notara: el
// segundo avisaba «MNEMOSINE_LANG=xx is set and takes precedence» incluso
// cuando el valor era inválido y el PRIMERO lo estaba descartando. Dos lectores
// del mismo dial son dos respuestas a la misma pregunta. Aquí hay una.
//
// ESTE ES EL ÚNICO ARCHIVO DE `src/` QUE NOMBRA LAS VARIABLES DE ENTORNO DEL
// LOCALE. Si aparece un segundo `process.env.MNEMOSINE_LANG` en el árbol, el
// criterio ejecutable de I6 se pone rojo, y con razón.
//
// SIN BASE DE DATOS Y SÍNCRONO. Ver `ResolveLocaleOptions.tenantLocale`, que es
// donde está escrita la decisión de diseño que eso obliga.
// ============================================================

/**
 * Los locales que este sistema sabe hablar. DOS por ahora (decisión del dueño
 * D12, 2026-09-07): no es una limitación técnica —el ICU de este Node formatea
 * `ar-EG` en cifras árabes sin ayuda— sino la negativa a publicar un idioma que
 * nadie mantiene. Un tercero es una fila aquí y un archivo de catálogo más.
 */
export const LOCALES = ['es-MX', 'en-US'] as const;

export type Locale = (typeof LOCALES)[number];

/**
 * El último escalón, y NO es el del sistema operativo. Tomar
 * `Intl.DateTimeFormat().resolvedOptions().locale` como omisión haría que el
 * despacho mexicano que corre esto en un contenedor con `LANG=C.UTF-8` pasara a
 * leer en inglés porque alguien reconstruyó la imagen. El idioma lo elige el
 * usuario (regla 5); cuando no ha elegido, manda el país del producto.
 */
export const DEFAULT_LOCALE: Locale = 'es-MX';

/** El nombre canónico de la variable de entorno. */
export const LOCALE_ENV_VAR = 'MNEMOSINE_LOCALE';

/**
 * ALIAS PERMANENTE, no una grafía en vías de retirada (decisión del dueño D10):
 * `MNEMOSINE_LANG` está escrito en perfiles de shell, en imágenes de Docker y en
 * `docs/wiki/Manual-Trabajar-con-el-agente.md:21`. Deprecarlo rompería máquinas
 * que hoy funcionan a cambio de nada: cuesta una fila de esta lista mantenerlo.
 */
export const LOCALE_ENV_VAR_ALIAS = 'MNEMOSINE_LANG';

/** En orden de precedencia: el nombre canónico gana al alias si los dos están. */
export const LOCALE_ENV_VARS = [LOCALE_ENV_VAR, LOCALE_ENV_VAR_ALIAS] as const;

/** La grafía congelada en `FLAG_DICTIONARY` (`src/cli/kernel/flags.ts`). */
export const LOCALE_FLAG = '--locale';

/**
 * Las grafías que se aceptan, y las que NO.
 *
 * `es` y `en` entran porque son lo que ya está escrito en los archivos de
 * configuración de hoy (la clave `language` del esquema es `'en' | 'es'`) y en
 * los `MNEMOSINE_LANG` de los perfiles: rechazarlas sería romper a todo el que
 * ya lo tenía puesto.
 *
 * `es-ES` y `pt-BR` NO entran, ni siquiera cayendo a su idioma. Quien escribe
 * `es-ES` espera además el formato español —punto de miles, euro— y en este
 * sistema el formato lo fija la jurisdicción de la entidad, así que aceptarla en
 * silencio como `es-MX` sería confirmarle una expectativa que el formateador no
 * va a cumplir. Se avisa y se pasa al siguiente escalón.
 */
const CANONICAL_BY_TAG = new Map<string, Locale>([
  ['es', 'es-MX'],
  ['es-mx', 'es-MX'],
  ['en', 'en-US'],
  ['en-us', 'en-US'],
]);

/** De dónde salió el locale que se está usando. */
export type LocaleSourceKind =
  | 'flag'
  | 'env'
  | 'user-config'
  | 'project-config'
  | 'legacy-config'
  | 'tenant'
  | 'default';

export interface LocaleDecision {
  locale: Locale;
  kind: LocaleSourceKind;
  /**
   * Cómo se nombra la fuente cuando hay que decírsela a un humano:
   * `MNEMOSINE_LANG`, `--locale`, `locale in /Users/x/.mnemosine/config.json`.
   * `null` sólo en el escalón por omisión, que no tiene fuente que nombrar.
   */
  label: string | null;
  /** El texto crudo de la fuente, antes de normalizar. `null` en la omisión. */
  raw: string | null;
}

export interface ResolveLocaleOptions {
  /** Por omisión `process.argv`. Se inyecta en pruebas y desde un servidor. */
  argv?: readonly string[];
  /** Por omisión `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Por omisión `process.cwd()`: dónde se busca `./mnemosine.config.json`. */
  cwd?: string;
  /** Por omisión `os.homedir()`: dónde se busca `~/.mnemosine/config.json`. */
  home?: string;
  /**
   * `tenants.settings.locale` YA LEÍDO. Éste es el escalón incómodo y aquí está
   * la razón de la forma que tiene.
   *
   * El resolutor es SÍNCRONO —se le llama desde donde se imprime un número, en
   * medio de una fila de una tabla— y ese escalón vive en Postgres. Había tres
   * salidas y dos son peores:
   *
   *  (a) VOLVERLO ASÍNCRONO contagia `await` a cada punto de impresión y
   *      convierte «formatear un importe» en una operación que puede fallar por
   *      la red. Un informe no se cae porque la base tarde en decir en qué
   *      idioma imprimirlo.
   *  (b) UN CACHÉ GLOBAL rellenado al arrancar es estado mutable compartido: el
   *      servidor de `src/api/` atiende a VARIOS inquilinos en el mismo proceso,
   *      y el segundo heredaría el locale del primero que entró. Ése es un
   *      defecto de cruce de inquilino disfrazado de presentación.
   *  (c) RECIBIR EL VALOR YA LEÍDO deja la consulta donde ya hay conexión e
   *      inquilino resuelto, y hace visible en la firma que este escalón no se
   *      paga solo: quien no pasa el valor no lo obtiene. Que hoy no lo pase
   *      nadie —la columna tiene cero lectores— es un hecho a la vista en vez de
   *      una promesa que el resolutor fingiría cumplir.
   */
  tenantLocale?: string | null;
  /**
   * A dónde van los avisos de valor inservible. Por omisión `console.warn`, que
   * es lo que hacía `resolveLanguage` antes de I6 y va a stderr: un aviso en
   * stdout ensuciaría un `--format json` que alguien está canalizando.
   */
  onWarning?: (message: string) => void;
}

function defaultWarning(message: string): void {
  console.warn(message);
}

/**
 * La ÚNICA validación de un locale en el árbol. Devuelve la grafía canónica o
 * `null` si la etiqueta no es una de las que este sistema habla.
 *
 * Que sea la única importa: el esquema de `mnemosine.config.json` deja la clave
 * `locale` como cadena libre a propósito, para no tener que repetir aquí y allí
 * la tabla de alias y la insensibilidad a mayúsculas. Dos tablas se separan.
 */
export function normalizeLocale(raw: string | null | undefined): Locale | null {
  if (typeof raw !== 'string') return null;
  const tag = raw.trim().toLowerCase();
  if (tag === '') return null;
  return CANONICAL_BY_TAG.get(tag) ?? null;
}

/**
 * El idioma del catálogo que le toca a un locale. Existe para que nadie vuelva a
 * escribir a mano el mapeo `es-MX → es`: era exactamente la clase de tabla
 * duplicada que dejó dos lectores de `MNEMOSINE_LANG` respondiendo distinto.
 */
export function languageOfLocale(locale: Locale): 'es' | 'en' {
  return locale === 'es-MX' ? 'es' : 'en';
}

/**
 * `--locale <tag>` leída de `process.argv` a mano, sin commander.
 *
 * La raíz DECLARA la bandera (`src/cli/mnemosine.ts`) para que el binario la
 * acepte y salga en `--help`, pero el resolutor no puede pedírsela a commander:
 * se le llama desde un formateador dentro de una tabla, que no tiene el objeto
 * `Command` a mano, y también antes de que commander haya despachado nada.
 *
 * Se para en el `--` de fin de opciones: lo que va después es del usuario —un
 * argumento literal, no una bandera— y robárselo sería inventarse un locale.
 */
function readLocaleFlag(argv: readonly string[]): string | null {
  const withValue = `${LOCALE_FLAG}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') return null;
    if (arg === LOCALE_FLAG) {
      const next = argv[i + 1];
      // `--locale` sin valor, o seguida de otra bandera: no es un valor. Que se
      // queje commander, que es quien sabe decir «option argument missing».
      return next !== undefined && !next.startsWith('-') ? next : null;
    }
    if (arg.startsWith(withValue)) return arg.slice(withValue.length);
  }
  return null;
}

/**
 * Una clave de cadena de un archivo de configuración, SIN pasar por zod.
 *
 * Dos razones para no reutilizar `loadConfigFile` de `src/ai/providers/config.ts`:
 * ese archivo importa ÉSTE (ahí vive `resolveLanguage`), así que importarlo de
 * vuelta sería un ciclo; y `loadConfigFile` devuelve el PRIMER archivo que
 * existe, mientras que aquí hacen falta los dos por separado.
 *
 * Un archivo ilegible o roto se SALTA con aviso en vez de tumbar el proceso: el
 * locale es presentación, y morir al imprimir un número porque el JSON del
 * usuario tiene una coma de más sería un modo de fallo nuevo peor que el
 * defecto. La validación estricta —con cuarentena del archivo rechazado— sigue
 * ocurriendo en `loadConfigFile` en cuanto algo lea la configuración de verdad,
 * así que la evidencia no se pierde; lo que se gana aquí es que el usuario se
 * entere de POR QUÉ su locale fue ignorado.
 */
function readConfigString(
  file: string,
  key: 'locale' | 'language',
  warn: (message: string) => void
): string | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return null; // no existe, o no se puede leer: es el caso normal
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warn(`[mnemosine] ${file} is not valid JSON; ignoring it while choosing the locale.`);
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const value = (parsed as Record<string, unknown>)[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    warn(`[mnemosine] "${key}" in ${file} is not a string; ignoring it while choosing the locale.`);
    return null;
  }
  return value;
}

function accept(
  raw: string,
  kind: LocaleSourceKind,
  label: string,
  warn: (message: string) => void
): LocaleDecision | null {
  const locale = normalizeLocale(raw);
  if (locale !== null) return { locale, kind, label, raw };
  // El valor inservible NO cae a la omisión: cae al SIGUIENTE escalón, que es lo
  // que hacía `resolveLanguage` antes de I6 con un MNEMOSINE_LANG inválido.
  warn(
    `[mnemosine] ${label}="${raw}" is not supported ` +
      `(use ${LOCALES.join('|')}, or es|en); ignoring it.`
  );
  return null;
}

/**
 * El locale efectivo Y de dónde salió. `resolveLocale` es esto sin la
 * procedencia; ésta la necesita `mnemosine lang`, que tiene que decirle al
 * usuario QUÉ le está ganando a lo que acaba de configurar.
 *
 * Precedencia (issue #148):
 *   `--locale` > MNEMOSINE_LOCALE (alias MNEMOSINE_LANG) > ~/.mnemosine/config.json
 *   > ./mnemosine.config.json > tenants.settings.locale > es-MX
 */
export function describeLocale(options: ResolveLocaleOptions = {}): LocaleDecision {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const home = options.home ?? os.homedir();
  const warn = options.onWarning ?? defaultWarning;

  const flag = readLocaleFlag(argv);
  if (flag !== null) {
    const hit = accept(flag, 'flag', LOCALE_FLAG, warn);
    if (hit) return hit;
  }

  for (const name of LOCALE_ENV_VARS) {
    const raw = env[name];
    // Vacía = no puesta. `MNEMOSINE_LOCALE=` en un `docker run` es la forma
    // habitual de DESACTIVARLA, no de pedir un locale llamado «».
    if (raw === undefined || raw.trim() === '') continue;
    const hit = accept(raw, 'env', name, warn);
    if (hit) return hit;
  }

  // EL ARCHIVO DEL USUARIO GANA AL DEL PROYECTO, y es al revés que en todo lo
  // demás de esta casa (`configFilePaths` pone el del proyecto primero, y así lo
  // publica docs/cli-command-catalog.md §3.1 para el inquilino). No es un
  // descuido: el inquilino y el proveedor son propiedades del REPOSITORIO, que
  // se versionan y se comparten; el idioma es del HUMANO que está mirando. Un
  // `mnemosine.config.json` con `locale: es-MX` comiteado por el despacho no
  // puede obligar a leer en español al contador que se instaló el suyo en
  // inglés. Regla 5: el idioma lo elige el usuario.
  const userFile = path.join(home, '.mnemosine', 'config.json');
  const projectFile = path.join(cwd, 'mnemosine.config.json');
  const localeFiles: ReadonlyArray<readonly [string, LocaleSourceKind]> = [
    [userFile, 'user-config'],
    [projectFile, 'project-config'],
  ];
  for (const [file, kind] of localeFiles) {
    const raw = readConfigString(file, 'locale', warn);
    if (raw === null) continue;
    const hit = accept(raw, kind, `locale in ${file}`, warn);
    if (hit) return hit;
  }

  // LA CLAVE VIEJA, CON SU PRECEDENCIA VIEJA INTACTA.
  //
  // `language` ya tiene lectores y la escribe `mnemosine lang`. Su orden era —y
  // sigue siendo— el de `loadConfigFile`: el PRIMER archivo que existe manda
  // ENTERO, aunque no traiga la clave (proyecto antes que usuario). Darle aquí
  // la precedencia nueva habría cambiado en silencio el idioma de quien tiene
  // los dos archivos, en un tramo cuyo encargo era justamente no cambiar nada de
  // lo que el usuario ve. La clave NUEVA estrena orden nuevo; la vieja no.
  const activeConfig = [projectFile, userFile].find((file) => fs.existsSync(file));
  if (activeConfig !== undefined) {
    const raw = readConfigString(activeConfig, 'language', warn);
    if (raw !== null) {
      const hit = accept(raw, 'legacy-config', `language in ${activeConfig}`, warn);
      if (hit) return hit;
    }
  }

  if (options.tenantLocale !== undefined && options.tenantLocale !== null) {
    const hit = accept(options.tenantLocale, 'tenant', 'tenants.settings.locale', warn);
    if (hit) return hit;
  }

  return { locale: DEFAULT_LOCALE, kind: 'default', label: null, raw: null };
}

/** El locale efectivo. Ver `describeLocale` para la precedencia y el porqué. */
export function resolveLocale(options: ResolveLocaleOptions = {}): Locale {
  return describeLocale(options).locale;
}
