/**
 * LOS CARRILES DE LA DOCUMENTACIÓN (I2 · issue #144)
 *
 *   npx tsx scripts/language/lanes/docs.ts                 los cuatro números
 *   npx tsx scripts/language/lanes/docs.ts <id-del-carril> la lista, uno por línea
 *
 * El epic #141 traduce el código al inglés en veintisiete tramos. Este módulo
 * mide las cuatro deudas que ese trabajo deja en la documentación, y las mide
 * SOBRE EL ÁRBOL, no sobre una lista escrita a mano — que es la lección que
 * `scripts/ux-status.ts` dejó pagada: un instrumento que compara contra una
 * lista mide la lista, y la lista no crece cuando crece el repositorio.
 *
 * LOS CUATRO
 *
 *   `docs-dead-path-citations`      citas en docs/ de rutas del repo que no existen
 *   `src-spanish-comment-lines`     líneas de comentario en español en src/ (informativo)
 *   `docs-english-pages-untwinned`  páginas publicadas en inglés sin su gemela .es.md
 *   `docs-spanish-twins-stale`      gemelas cuyo `source_sha` ya no casa con el original
 *
 * Los cuatro miden cosas distintas y ninguno cuenta lo que cuenta otro: el
 * primero mira CITAS dentro de los .md, el segundo mira COMENTARIOS dentro de
 * los .ts, y los dos últimos miran la EXISTENCIA y la FRESCURA de archivos.
 * Un mismo hecho no puede sumar en dos carriles a la vez.
 *
 * EL RECORRIDO ES DETERMINISTA A PROPÓSITO
 *
 * Todo lo que se recorre se ordena antes de recorrerse. `fs.readdirSync` no
 * promete orden, y un metro que da dos cifras distintas para el mismo árbol no
 * es un metro: es una moneda al aire con formato de tabla.
 *
 * POR QUÉ CASI TODO RECIBE `root` COMO PARÁMETRO
 *
 * Dos de los cuatro carriles valen hoy 2 y 0. Sobre el árbol real no hay forma
 * de probar que saben pasar de cero —no existe ni una `.es.md`—, y un carril
 * que nadie ha visto contar es un carril que nadie sabe si cuenta. Pasando la
 * raíz por parámetro, la prueba les construye un árbol de juguete y les enseña
 * la gemela desactualizada que este repositorio todavía no tiene.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Lane, LaneMeter } from '../lane.js';
import { classifyToken } from '../lexicon.js';

/** scripts/language/lanes/ → la raíz del repositorio. */
export const ROOT = path.resolve(__dirname, '..', '..', '..');

/** Lo que nunca se recorre. Todo lo que empieza por punto tampoco. */
const IGNORED: ReadonlySet<string> = new Set(['node_modules', 'dist', 'coverage', '.git']);

/** Cuántos ejemplos publica cada carril: bastantes para empezar, pocos para caber en un bloque. */
const EXAMPLE_COUNT = 8;

// ── EL CERO QUE PARECE UNA VICTORIA ─────────────────────────
//
// Los cuatro carriles apuntan a cero, así que un cero se lee como la deuda
// pagada. Un recorrido que no encuentra lo que mide da exactamente ese cero:
// sin `docs/`, este módulo publicaba 0-0-0 con la salida impecable, y sin
// `src/` el carril de comentarios caía de 21 953 a 0 sin decir nada. No es una
// hipótesis —está medido sobre un árbol de juguete al que se le quitó la
// carpeta—. El daño no es el número de hoy sino el de mañana: el primer
// `--apretar` sobre esa lectura clava la línea base en cero y deja el
// trinquete insatisfacible para siempre, y un trinquete que nadie puede poner
// en verde acaba desactivado entero. Un metro que no puede medir tiene que
// callarse RUIDOSAMENTE, que es lo que hace `requireDir`.

/** El directorio que un carril necesita, o el error que dice cuál falta y a quién ciega. */
function requireDir(full: string, whatFor: string): string {
  if (!fs.existsSync(full)) {
    throw new Error(
      `no existe ${full}: ${whatFor} habría publicado cero sin haber mirado un solo ` +
        'archivo, que es justo la meta del carril. Comprueba desde dónde se ejecuta el ' +
        'metro —o si la carpeta se movió— antes de creerte la cifra.'
    );
  }
  return full;
}

/**
 * Los archivos de una extensión bajo un árbol, en orden y sin lo ignorado. El
 * `sort` explícito es la única razón por la que dos corridas dan la misma
 * lista de ejemplos.
 */
function filesWithExtension(root: string, extension: string, whatFor: string): string[] {
  requireDir(root, whatFor);
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith('.') || IGNORED.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(extension)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Siempre con barras hacia adelante: la cifra no puede depender del sistema de archivos. */
function relativePath(root: string, full: string): string {
  return path.relative(root, full).split(path.sep).join('/');
}

// ============================================================
// CARRIL 1 · RUTAS CITADAS EN docs/ QUE NO EXISTEN
//
// La documentación de esta casa cita el árbol constantemente: `src/ai/floor.ts`
// en prosa, `[criterios](../src/plan/criterios.ts)` como enlace, y
// `src/config/index.ts:214` cuando quiere señalar una línea. Cada renombrado
// del epic rompe todas las citas del archivo que renombra, y no rompe ninguna
// prueba: por eso hace falta un número.
//
// QUÉ CUENTA COMO RUTA, Y POR QUÉ TAN ESTRECHO
//
// Éste es el carril fácil de inflar, así que la regla se escribió pensando en
// lo que hay que DEJAR FUERA, con el caso real que obligó a cada exclusión:
//
//   · Los bloques cercados (``` y ~~~) se borran antes de mirar. Una ruta
//     dentro de un ejemplo ejecutable es un ejemplo, no una referencia.
//   · Nada con espacios, comillas, comodines, tuberías, paréntesis, `$` ni
//     puntos suspensivos. Eso descarta `-s/--status <a|b>`, `!tests/**/*.key`
//     y `.../servicios/soap/cancel.wsdl`, que son formas, no rutas.
//   · Nada con `://` ni `mailto:`. Un enlace a GitHub apunta a un servidor, no
//     al árbol de quien lee, y hay 337 en docs/.
//   · Nada que empiece por `-`: son banderas — `-B/--cost` tiene una barra y
//     no es una ruta.
//   · El último segmento tiene que tener extensión, O la cita tiene que venir
//     escrita con barra final (`src/cli/`). Sin esa exigencia entra
//     `docs/auditoria-integral-ii`, que es un NOMBRE DE RAMA, y entra
//     `src/tests/scripts`, que es prosa enumerando tres carpetas con barras.
//   · Se rechaza la cita cuyo último segmento acaba en `-` o `_`: es un prefijo
//     cortado (`tests/integration/s3-`, escrito así para filtrar vitest).
//   · Se rechaza la cita en la que TODOS los segmentos son raíces del repo, por
//     lo mismo que `src/tests/scripts`.
//
// Y el ancla: en prosa entre acentos graves, el primer segmento tiene que ser
// una carpeta que HOY existe en la raíz. En un enlace markdown no hace falta,
// porque un enlace es una ruta por definición y se resuelve contra su propio
// documento. La consecuencia está medida y es deliberada: `research/cli-ux.md`,
// citado en prosa en docs/cli-command-registry.md, NO se cuenta, porque sin un
// ancla que exista no hay forma de distinguir la ruta de este repo de la de
// otro. El enlace equivalente sí se contaría.
// ============================================================

/**
 * Las carpetas de primer nivel del repo, DERIVADAS del árbol y no escritas.
 * Se añade `.github` porque el recorrido salta lo que empieza por punto y esa
 * carpeta sí se cita: `.github/workflows/ci.yml` aparece 69 veces en docs/.
 */
function repoRoots(root: string): ReadonlySet<string> {
  // Sin raíz no hay ancla, y sin ancla ninguna cita en prosa se reconoce: el
  // carril daría cero por no saber dónde está mirando.
  const names = fs
    .readdirSync(requireDir(root, 'el ancla de las citas en prosa'), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !IGNORED.has(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name);
  if (fs.existsSync(path.join(root, '.github'))) names.push('.github');
  return new Set(names.sort());
}

/** Lo que descalifica a un candidato por su forma. */
const IMPOSSIBLE_SHAPE = /[\s"'`|<>$(){}[\]!*?\\]|\.\.\./;
const HAS_EXTENSION = /\.[A-Za-z0-9]{1,6}$/;

/**
 * Quita del candidato bruto lo que la prosa le pegó encima: los `<...>` de un
 * autolink, el ancla `#seccion`, la puntuación de final de frase y la
 * referencia de línea. El orden importa — `src/cli/ar-command.ts:110,` sólo
 * suelta su `:110` DESPUÉS de que se le haya quitado la coma final.
 */
export function cleanCitation(raw: string): string {
  let s = raw.trim().replace(/^<(.*)>$/, '$1');
  const anchor = s.indexOf('#');
  if (anchor > 0) s = s.slice(0, anchor);
  s = s.replace(/[.,;)\]]+$/, '');
  s = s.replace(/:[0-9]+(?:[-–,][0-9]+)*\+?$/, '');
  s = s.replace(/[.,;:)\]]+$/, '');
  return s.trim();
}

/**
 * El candidato ya limpio, si tiene forma de ruta; `null` si no.
 * `raices` sólo interviene para descartar la enumeración con barras.
 */
export function asRepoPath(clean: string, roots: ReadonlySet<string>): string | null {
  if (clean === '' || IMPOSSIBLE_SHAPE.test(clean)) return null;
  if (clean.includes('://') || clean.startsWith('mailto:')) return null;
  if (clean.startsWith('-')) return null;
  if (!clean.includes('/') || clean.includes('//') || clean.includes(':')) return null;
  const writtenAsFolder = clean.endsWith('/');
  const withoutSlash = clean.replace(/\/+$/, '');
  const segments = withoutSlash.split('/');
  if (segments.some((s) => s === '')) return null;
  const last = segments[segments.length - 1];
  if (/[-_]$/.test(last)) return null;
  if (!writtenAsFolder && !HAS_EXTENSION.test(last)) return null;
  if (segments.every((s) => roots.has(s))) return null;
  return withoutSlash;
}

/**
 * El documento sin sus bloques cercados. Las líneas se sustituyen por vacías en
 * vez de borrarse para que el número de línea del ejemplo siga siendo el que
 * verá quien abra el archivo.
 */
export function withoutFencedBlocks(text: string): string[] {
  const out: string[] = [];
  let inside = false;
  let fence = '';
  for (const line of text.split('\n')) {
    const opens = /^\s*(`{3,}|~{3,})/.exec(line);
    if (opens !== null) {
      if (!inside) {
        inside = true;
        fence = opens[1][0];
        out.push('');
        continue;
      }
      if (opens[1][0] === fence) {
        inside = false;
        out.push('');
        continue;
      }
    }
    out.push(inside ? '' : line);
  }
  return out;
}

/** Una cita: la ruta ya resuelta contra la raíz, y dónde se escribió. */
interface Citation {
  citedPath: string;
  doc: string;
  line: number;
}

function citationsIn(root: string, documentPath: string, roots: ReadonlySet<string>): Citation[] {
  const doc = relativePath(root, documentPath);
  const folder = path.dirname(documentPath);
  const out: Citation[] = [];

  withoutFencedBlocks(fs.readFileSync(documentPath, 'utf8')).forEach((line, i) => {
    // (a) prosa entre acentos graves: exige ancla en una raíz del repo.
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      const citedPath = asRepoPath(cleanCitation(m[1]), roots);
      if (citedPath === null || !roots.has(citedPath.split('/')[0])) continue;
      out.push({ citedPath, doc, line: i + 1 });
    }
    // (b) enlace markdown: es una ruta por definición, y se resuelve contra su
    //     propio documento. Sin esta mitad el carril no ve `](motores/)` ni
    //     `](../src/plan/criterios.ts)`, que son la mitad de los enlaces.
    for (const m of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const citedPath = asRepoPath(cleanCitation(m[1]), roots);
      if (citedPath === null) continue;
      let resolved: string;
      if (roots.has(citedPath.split('/')[0])) resolved = citedPath;
      else {
        resolved = relativePath(root, path.resolve(folder, citedPath));
        // Un enlace que sale del repo (`../../issues`) no es una ruta del árbol.
        if (resolved.startsWith('..')) continue;
      }
      out.push({ citedPath: resolved, doc, line: i + 1 });
    }
  });
  return out;
}

/** Todas las citas del árbol, agrupadas por ruta y en orden de aparición. */
function citationsInDocs(root: string): Map<string, Citation[]> {
  const roots = repoRoots(root);
  const citations = new Map<string, Citation[]>();
  for (const documentPath of filesWithExtension(path.join(root, 'docs'), '.md', 'el carril de citas muertas')) {
    for (const citation of citationsIn(root, documentPath, roots)) {
      const previous = citations.get(citation.citedPath);
      if (previous) previous.push(citation);
      else citations.set(citation.citedPath, [citation]);
    }
  }
  return citations;
}

/** Una cita muerta: la ruta que no lleva a ningún sitio y el documento que la escribe. */
interface DeadCitation {
  citedPath: string;
  doc: string;
  /** El primer renglón de ese documento donde aparece, que es por donde se empieza. */
  line: number;
}

/**
 * LA UNIDAD ES LA CITA, NO LA RUTA, y esto costó un descuadre de veintidós.
 *
 * La primera versión publicaba `value` = rutas muertas distintas (196) y
 * desglosaba `perFile` por documento, donde una ruta citada en siete
 * documentos ponía siete. Las columnas sumaban 218 y el total decía 196, con
 * una nota al lado que llamaba a la diferencia deliberada. No lo es: el
 * contrato de `Lane` dice que `perFile` cuenta POR ARCHIVO **además de** en
 * total, la línea base guarda los dos números y `--check` los compara, así que
 * un carril cuyas columnas no suman su total le da al trinquete dos verdades
 * sobre el mismo hecho. Y la avería no era sólo aritmética: con la ruta como
 * unidad, arreglar seis de los siete documentos que citan
 * `docs/evals/clasificador.jsonl` movía el desglose seis y el total CERO — un
 * carril que no da crédito por el trabajo hecho es un carril que nadie
 * termina de pagar.
 *
 * De los dos números, el que estaba mal es el TOTAL, por tres razones:
 *
 *   · el `id` del carril dice `citations` y el desglose ya contaba citas: el
 *     que se salía de la definición era el valor publicado;
 *   · una ruta muerta no tiene un archivo al que atribuirse —vive en los N
 *     documentos que la citan—, así que un desglose que sumara 196 tendría que
 *     inventarle un dueño (el primer documento, digamos) y mentiría sobre
 *     quién puede pagarla;
 *   · lo que se edita es la cita. La ruta desaparece del carril cuando se
 *     arregla la última, y hasta entonces cada documento tiene su parte.
 *
 * Se deduplica DENTRO del documento: la misma ruta muerta escrita en cinco
 * renglones de la misma página es una sola pasada de arreglo (hoy, 218 pares
 * contra 343 apariciones). Entre documentos no se deduplica, porque cada uno
 * es una edición aparte, con su revisión aparte.
 */
function deadCitations(root: string): DeadCitation[] {
  const citations = citationsInDocs(root);
  const out: DeadCitation[] = [];
  for (const citedPath of [...citations.keys()].sort()) {
    if (fs.existsSync(path.join(root, citedPath))) continue;
    const firstLine = new Map<string, number>();
    for (const citation of citations.get(citedPath) ?? []) {
      if (!firstLine.has(citation.doc)) firstLine.set(citation.doc, citation.line);
    }
    for (const doc of [...firstLine.keys()].sort()) {
      out.push({ citedPath, doc, line: firstLine.get(doc) as number });
    }
  }
  return out;
}

function deadPathsLane(root: string): Lane {
  const dead = deadCitations(root);

  // El desglose es el mismo número repartido por el documento que hay que
  // editar, y por eso suma exactamente el total. Las llaves van ordenadas para
  // que dos corridas den el mismo JSON byte a byte.
  const tally: Record<string, number> = {};
  for (const citation of dead) tally[citation.doc] = (tally[citation.doc] ?? 0) + 1;
  const perFile: Record<string, number> = {};
  for (const doc of Object.keys(tally).sort()) perFile[doc] = tally[doc];

  return {
    id: 'docs-dead-path-citations',
    // El título dice CITAS porque la unidad es la cita: hoy son 218 citas
    // sobre 196 rutas distintas, y quien compare con un `find` tiene que saber
    // cuál de los dos números está leyendo.
    title: 'citations in docs/ of repository paths that no longer exist',
    value: dead.length,
    target: 0,
    command: 'npx tsx scripts/language/lanes/docs.ts docs-dead-path-citations | wc -l',
    examples: dead.slice(0, EXAMPLE_COUNT).map((c) => `${c.citedPath}  ←  ${c.doc}:${c.line}`),
    perFile,
  };
}

// ============================================================
// CARRIL 2 · LÍNEAS DE COMENTARIO EN ESPAÑOL EN src/
//
// INFORMATIVO, y no por timidez: el epic no exige traducir comentarios hasta
// I20. Un carril que hoy nadie puede bajar, metido en el mismo trinquete que
// los que sí, es exactamente cómo se llega a una puerta que nunca está en verde
// y que alguien acaba desactivando entera. Se mide desde el primer día para que
// en I20 haya serie, no para exigirlo desde el primer día.
//
// POR QUÉ NO SE MIRAN LOS ACENTOS. Media base de código escribe sin ellos
// («comision», «periodo», «analisis»), así que buscar `[áéíóúñ]` mediría quién
// teclea con acentos y no qué idioma se escribió. Se mira el LÉXICO: se parten
// las palabras de la línea, se les quita el acento para poder buscarlas —el
// léxico está escrito sin ninguno— y basta UNA raíz española para que la línea
// cuente. Es el mismo criterio que `isFlagged` aplica a un identificador
// (español entero o a medias, las dos cosas), porque una línea con una mitad en
// cada idioma es exactamente lo que hay que reescribir.
//
// EL LECTOR DE COMENTARIOS TIENE UNA TRAMPA MEDIDA. Se recorre el archivo
// carácter a carácter con cuatro estados (código, `//`, `/* */`, cadena) para no
// confundir el `//` de dentro de una cadena con un comentario. La trampa es la
// expresión regular: `/['"]/` abre una comilla que nunca cierra, y sin remedio
// el lector se queda en modo cadena hasta el final del archivo y se come los
// comentarios que vengan después. El remedio es que un salto de línea cierra
// las comillas simples y dobles —en JavaScript no pueden cruzarlo—, lo que acota
// el daño a la línea en la que ocurre. Medido: sin ese remedio el recorrido
// perdía 666 líneas, 307 de ellas en src/cli/mnemosine.ts sola.
//
// QUÉ QUEDA FUERA: los 75 .sql de src/ (2 786 líneas que empiezan por `--`).
// Setenta y cuatro son migraciones ya aplicadas: reescribirles el comentario
// cambia un archivo que la base de datos ya ejecutó, y eso no es un renombrado,
// es otra discusión.
// ============================================================

const WITHOUT_ACCENT: Readonly<Record<string, string>> = Object.freeze({
  á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u', ñ: 'n',
});

/** A minúsculas y sin acentos, que es como está escrito el léxico. */
function fold(word: string): string {
  return word.toLowerCase().replace(/[áéíóúüñ]/g, (m) => WITHOUT_ACCENT[m] ?? m);
}

const LETTERS = /[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+/g;

/** ¿El texto de esta línea de comentario está en español? Una raíz basta. */
export function isSpanishComment(text: string): boolean {
  const words = text.match(LETTERS);
  if (words === null) return false;
  return words.some((p) => classifyToken(fold(p)) === 'es');
}

/**
 * El texto de comentario de cada línea del fuente, `''` donde no hay ninguno.
 * Devuelve una entrada por línea para que el desglose y los ejemplos puedan
 * decir el número de línea sin volver a recorrer nada.
 */
export function commentsByLine(source: string): string[] {
  const out: string[] = [];
  let current = '';
  let mode: 'code' | 'line' | 'block' | 'string' = 'code';
  let quote = '';

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '\n') {
      if (mode === 'line') mode = 'code';
      // El remedio de la comilla huérfana: una cadena simple o doble no cruza
      // el salto de línea, así que aquí se cierra pase lo que pase. La
      // plantilla (`) sí lo cruza, y por eso se queda abierta.
      if (mode === 'string' && quote !== '`') mode = 'code';
      out.push(current);
      current = '';
      continue;
    }

    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line'; i++; continue; }
      if (c === '/' && next === '*') { mode = 'block'; i++; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = 'string'; quote = c; continue; }
      continue;
    }

    if (mode === 'string') {
      if (c === '\\') { i++; continue; }
      if (c === quote) mode = 'code';
      continue;
    }

    if (mode === 'block' && c === '*' && next === '/') { mode = 'code'; i++; continue; }
    current += c;
  }

  out.push(current);
  return out;
}

/** Cada línea de comentario en español de src/, con su archivo y su número. */
function spanishCommentLines(root: string): Array<{ file: string; line: number; text: string }> {
  const out: Array<{ file: string; line: number; text: string }> = [];
  for (const full of filesWithExtension(path.join(root, 'src'), '.ts', 'el carril de comentarios en español')) {
    const file = relativePath(root, full);
    commentsByLine(fs.readFileSync(full, 'utf8')).forEach((text, i) => {
      const clean = text.trim();
      if (clean !== '' && isSpanishComment(clean)) {
        out.push({ file, line: i + 1, text: clean });
      }
    });
  }
  return out;
}

function spanishCommentsLane(root: string): Lane {
  const lines = spanishCommentLines(root);
  const perFile: Record<string, number> = {};
  for (const l of lines) perFile[l.file] = (perFile[l.file] ?? 0) + 1;

  return {
    id: 'src-spanish-comment-lines',
    title: 'comment lines written in Spanish under src/',
    value: lines.length,
    target: 0,
    command: 'npx tsx scripts/language/lanes/docs.ts src-spanish-comment-lines | wc -l',
    examples: lines.slice(0, EXAMPLE_COUNT).map((l) => `${l.file}:${l.line}  ${l.text.slice(0, 72)}`),
    informational: true,
    perFile,
  };
}

// ============================================================
// CARRILES 3 y 4 · LA PÁGINA INGLESA Y SU GEMELA ESPAÑOLA
//
// La regla del epic: una página se publica en inglés (`docs/language.md`) con su
// gemela española al lado (`docs/language.es.md`), y la gemela declara el
// `source_sha` del original que tradujo. Con eso, una gemela que se quedó atrás
// se detecta sola: el sha guardado deja de casar con el del archivo de hoy.
//
// HOY LOS DOS CARRILES VALEN 2 Y 0, Y ESO ES LO CORRECTO. `docs/language.md`
// viene de un PR sin fusionar y no está en este árbol; no hay ni una sola
// `.es.md`. Un carril que reventara por eso sería inútil el día que más falta
// hace —el día que el rector aterriza—, así que los dos se escribieron para dar
// un número correcto sobre un árbol donde el esquema todavía no existe, y la
// prueba les construye ese esquema aparte para verlos contar.
//
// QUÉ ES «UNA PÁGINA PUBLICADA EN INGLÉS», Y POR QUÉ NO ES «TODA PÁGINA»
//
// La tentación es contar las 147 páginas de docs/ como «sin gemela». Sería un
// número enorme, subiría con cada auditoría nueva —que se escriben en español y
// no necesitan gemela española— y pondría el trinquete en rojo por hacer el
// trabajo normal de la casa. La página que necesita gemela es la que YA está en
// inglés, porque ésa es la que un lector español no puede leer.
//
// Y para saber si una página está en inglés se usa el mismo léxico que todo lo
// demás. Medido sobre las 147 páginas de hoy, la proporción de raíces españolas
// sobre (españolas + inglesas) separa limpio:
//
//     0,008  docs/harness-best-practices.md      ← inglesa de verdad
//     0,056  docs/cli-command-registry.md        ← inglesa de verdad
//     ────────────────── el hueco ──────────────────
//     0,385  …/practicas/conectores.md           ← española con mucho término inglés
//     0,717  docs/auditorias/F07a.md             ← la más española de todas
//
// El umbral se pone en 0,20, en mitad de un hueco de siete veces. No es un
// número elegido para que salga bonito: es el punto más ancho entre las dos
// poblaciones que hay en el árbol. Si algún día una página cae cerca, el hueco
// se habrá cerrado y habrá que volver a mirar esto, no a moverlo.
// ============================================================

/** Bajo este número de palabras clasificables, una página no da para juzgarla. */
const MIN_WORDS = 20;

/** Proporción de raíces españolas por debajo de la cual la página se da por inglesa. */
const ENGLISH_THRESHOLD = 0.2;

/** La proporción española de una prosa, o `null` si es demasiado corta para decirlo. */
export function spanishRatio(prose: string): number | null {
  const words = prose.match(LETTERS);
  if (words === null) return null;
  let spanish = 0;
  let english = 0;
  for (const p of words) {
    const kind = classifyToken(fold(p));
    if (kind === 'es') spanish++;
    else if (kind === 'en') english++;
  }
  if (spanish + english < MIN_WORDS) return null;
  return spanish / (spanish + english);
}

/** `docs/language.md` → `docs/language.es.md`. */
const twinOf = (page: string): string => page.replace(/\.md$/, '.es.md');

/**
 * El sha que `git hash-object` le daría al archivo, calculado aquí para no
 * depender de que haya un git alrededor. Es el mismo algoritmo: sha1 sobre
 * `blob <bytes>\0` seguido del contenido en crudo.
 */
export function blobSha(absolutePath: string): string {
  const content = fs.readFileSync(absolutePath);
  const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, content])).digest('hex');
}

/**
 * El `source_sha` que declara una gemela. Se busca en la cabecera del archivo y
 * se acepta escrito de cualquiera de las formas en que puede venir —front matter
 * YAML, comentario HTML, línea en negrita—: el PR que trae el rector no está
 * fusionado, así que el lector es deliberadamente tolerante en la FORMA y
 * estricto en el CONTENIDO (hexadecimal, de siete a cuarenta caracteres).
 */
export function declaredSha(twinText: string): string | null {
  // El `[*_`\s]*` de en medio es lo que deja pasar `**source_sha**: abc123` sin
  // exigirle a nadie que escriba el front matter de una forma concreta.
  const m = /source_sha[*_`\s]*[:=][\s*_`"']*([0-9a-f]{7,40})\b/i.exec(twinText.slice(0, 4096));
  return m === null ? null : m[1].toLowerCase();
}

/** Las páginas de docs/, separadas en originales y gemelas. */
function docsPages(root: string): { originals: string[]; twins: string[] } {
  const all = filesWithExtension(path.join(root, 'docs'), '.md', 'los carriles de páginas y gemelas');
  return {
    originals: all.filter((p) => !p.endsWith('.es.md')),
    twins: all.filter((p) => p.endsWith('.es.md')),
  };
}

function englishPagesWithoutTwin(root: string): string[] {
  const out: string[] = [];
  for (const page of docsPages(root).originals) {
    const ratio = spanishRatio(fs.readFileSync(page, 'utf8'));
    if (ratio === null || ratio >= ENGLISH_THRESHOLD) continue;
    if (fs.existsSync(twinOf(page))) continue;
    out.push(relativePath(root, page));
  }
  return out.sort();
}

function untwinnedPagesLane(root: string): Lane {
  const untwinned = englishPagesWithoutTwin(root);
  return {
    id: 'docs-english-pages-untwinned',
    title: 'docs/ pages published in English with no .es.md twin',
    value: untwinned.length,
    target: 0,
    command: 'npx tsx scripts/language/lanes/docs.ts docs-english-pages-untwinned | wc -l',
    examples: untwinned.slice(0, EXAMPLE_COUNT),
    perFile: Object.fromEntries(untwinned.map((p) => [p, 1])),
  };
}

/**
 * Una gemela cuenta como desactualizada mientras no se pueda DEMOSTRAR que está
 * al día. No declarar `source_sha` no es un estado neutro: es una gemela cuya
 * frescura nadie puede comprobar, que es el mismo defecto con otra cara.
 */
function staleTwins(root: string): Array<{ twin: string; reason: string }> {
  const out: Array<{ twin: string; reason: string }> = [];
  for (const full of docsPages(root).twins) {
    const original = full.replace(/\.es\.md$/, '.md');
    const twin = relativePath(root, full);
    if (!fs.existsSync(original)) {
      out.push({ twin, reason: `su original ${relativePath(root, original)} ya no existe` });
      continue;
    }
    const declared = declaredSha(fs.readFileSync(full, 'utf8'));
    if (declared === null) {
      out.push({ twin, reason: 'no declara source_sha' });
      continue;
    }
    // Se compara por prefijo para admitir el sha corto de siete que se escribe a
    // mano; `git hash-object` da el largo y el prefijo es el mismo.
    if (!blobSha(original).startsWith(declared)) {
      out.push({ twin, reason: `source_sha ${declared} ya no casa con ${relativePath(root, original)}` });
    }
  }
  return out;
}

function staleTwinsLane(root: string): Lane {
  const stale = staleTwins(root);
  return {
    id: 'docs-spanish-twins-stale',
    title: 'docs/ Spanish twins whose source_sha no longer matches the original',
    value: stale.length,
    target: 0,
    // Éste sí se reproduce sin tocar el metro: git calcula el mismo sha.
    //
    // TRES COSAS QUE LA PRIMERA VERSIÓN DE ESTE COMANDO HACÍA MAL, y que sólo
    // se vieron plantando gemelas en un árbol de juguete —sobre el árbol real
    // hay CERO gemelas, así que el comando y el metro coincidían en 0 por
    // casualidad y el comando podía estar roto para siempre sin que nadie lo
    // notara. Un carril en cero es donde se esconde un comando muerto:
    //
    //   1. `git ls-files "docs/**/*.es.md"` NO lista las gemelas de primer
    //      nivel. En el pathspec de git, sin la magia `:(glob)`, `*` cruza las
    //      barras, así que ese patrón exige un directorio intermedio: veía
    //      `docs/sub/x.es.md` y se saltaba `docs/x.es.md`. Aquí se recorre con
    //      `find`, que además ve la gemela recién escrita y todavía sin
    //      añadir al índice — que es exactamente la población del metro, el
    //      árbol de archivos y no el índice de git.
    //   2. Cuando la gemela NO declaraba `source_sha`, `$d` quedaba vacío y el
    //      patrón `"$d"*` se volvía `*`, que casa con todo: el caso «no se
    //      puede demostrar que esté al día» —que el metro cuenta— salía
    //      invisible. Ahora la falta de sha se decide antes del `case`.
    //   3. El grep exigía `source_sha` pegado a `:`, así que no leía
    //      `**source_sha**: abc123`, que es una de las tres formas que acepta
    //      `declaredSha`. El separador se admite ahora como «lo que no es un
    //      dígito hexadecimal», que cubre `* _ ` : = " '` y los espacios sin
    //      arrastrar aquí la expresión entera del lector.
    command:
      "for g in $(find docs -name '*.es.md' | sort); do o=${g%.es.md}.md; " +
      "d=$(head -c 4096 \"$g\" | grep -oiE 'source_sha[^0-9a-f]{1,12}[0-9a-f]{7,40}' " +
      "| head -1 | grep -oiE '[0-9a-f]{7,40}$' | tr 'A-F' 'a-f'); " +
      'if [ -z "$d" ] || [ ! -f "$o" ]; then echo "$g"; continue; fi; ' +
      'case "$(git hash-object "$o")" in "$d"*) ;; *) echo "$g";; esac; done | wc -l',
    examples: stale.slice(0, EXAMPLE_COUNT).map((a) => `${a.twin}  ←  ${a.reason}`),
    perFile: Object.fromEntries(stale.map((a) => [a.twin, 1])),
  };
}

// ============================================================
// LO QUE SE ENTREGA
//
// SOBRE EL CAMPO `command`. Los tres primeros carriles no se reproducen con un
// grep, y decirlo es más honesto que inventar una tubería que dé otro número:
// «qué es una ruta» son siete exclusiones y un ancla, y «qué es español» es un
// léxico de 2 621 entradas; ninguna de las dos cosas cabe en una regular.
// Lo que sí se puede hacer sin el trinquete, sin la línea base y sin el bloque
// del documento es correr este módulo y CONTAR SU LISTA — que es lo que hace
// falta para discutir un número, porque discutir «218» es imposible y discutir
// los doscientos dieciocho renglones no lo es. El cuarto carril sí tiene
// comando de verdad: `git hash-object` calcula exactamente el mismo sha.
//
// LO QUE DIO AL SEMBRARSE (2026-09-07)
//
//   docs-dead-path-citations       218  de 2 094 citas (196 rutas de 747)
//   src-spanish-comment-lines   21 953  de 32 270 líneas con comentario
//   docs-english-pages-untwinned     2  de 147 páginas
//   docs-spanish-twins-stale         0  de 0 gemelas
//
// El 218 son CITAS y el 196, rutas distintas: la unidad del carril es la cita
// —una por documento y ruta— porque es lo que se edita, y está razonado junto a
// `deadCitations`. La primera medición de este tramo publicó el 196 con un
// desglose que ya sumaba 218; los dos números están aquí para que quien
// compare con aquella nota sepa cuál era cuál.
//
// La referencia con la que se encargó el tramo decía «92 de 422» para el primero
// y «22 731» para el segundo. El segundo casa al 97 % y la diferencia es de
// definición: los .sql, que aquí quedan fuera y explicados arriba. El primero NO
// casa, y como el número es el producto, aquí queda por escrito a qué se debe,
// en vez de ajustar el filtro hasta que salga 92:
//
//   · 164 de las 218 las escribe UN SOLO documento, docs/plan-cierre-brechas.md,
//     y 160 de esas rutas no las cita nadie más. Casi todas están en renglones
//     que dicen «— crear:»: es un plan, nombra los artefactos que todavía no
//     existen, y por eso los cita. Son citas muertas de verdad —quien las siga
//     no encuentra nada— pero nacen muertas por diseño, no por un renombrado.
//     Con ese documento fuera del recorrido el carril daría 54 (36 rutas);
//     saltando los renglones que dicen «crear», 177. Ninguna de las dos
//     exclusiones se aplicó, porque las dos son una lista escrita a mano
//     disfrazada de regla, y el `perFile` ya pone esas 164 en su columna, que es
//     donde alguien las puede pagar de una sentada.
//   · Las 425 rutas —577 citas— que quedan al excluir docs/auditorias/,
//     docs/investigacion/ y docs/archive/ se parecen mucho a las 422 de la
//     referencia, así que es probable que la cifra de origen midiera sólo la
//     documentación viva. Ese recorte tampoco se aplicó —una auditoría que cita
//     un archivo que ya no está es exactamente lo que este carril tiene que
//     ver— y de todas formas no explica el otro número: sobre esos 52
//     documentos las muertas son 177 citas (174 rutas), no 92.
//
// Verificaciones independientes que sí se corrieron, y lo que dieron:
//   · 337 enlaces a github.com en docs/, todos descartados por la regla de
//     `://`; los que apuntan a blob/main citan rutas de este repo, pero apuntan a
//     un servidor y no al árbol de quien lee.
//   · `grep -rE '^[[:space:]]*(//|\*|/\*)' src --include='*.ts' | wc -l` da 35 300
//     contra las 32 270 de aquí. La diferencia son líneas de código de ejemplo
//     dentro de plantillas (293 sólo en src/plan/criterios.ts) que el grep cuenta
//     como comentario y el lector de estados no.
// ============================================================

/** Los cuatro carriles medidos sobre un árbol cualquiera. */
export function lanesFor(root: string): Lane[] {
  return [
    deadPathsLane(root),
    spanishCommentsLane(root),
    untwinnedPagesLane(root),
    staleTwinsLane(root),
  ];
}

export const docsLanes: LaneMeter = () => lanesFor(ROOT);

/**
 * Los renglones que hay detrás del número de un carril. Es lo que imprime la
 * línea de órdenes, y lo que hace que la cifra se pueda discutir en vez de
 * creerla o no creerla.
 */
export function linesFor(id: string, root: string = ROOT): string[] {
  switch (id) {
    case 'docs-dead-path-citations':
      // Una línea por CITA —la ruta y dónde se escribe—, que es lo que cuenta
      // el carril y lo que hay que ir a arreglar.
      return deadCitations(root).map((c) => `${c.citedPath}\t${c.doc}:${c.line}`);
    case 'src-spanish-comment-lines':
      return spanishCommentLines(root).map((l) => `${l.file}:${l.line}\t${l.text}`);
    case 'docs-english-pages-untwinned':
      return englishPagesWithoutTwin(root);
    case 'docs-spanish-twins-stale':
      return staleTwins(root).map((a) => `${a.twin}\t${a.reason}`);
    default:
      throw new Error(`carril desconocido: ${id}`);
  }
}

if (require.main === module) {
  const id = process.argv[2];
  if (id === undefined) {
    for (const lane of docsLanes()) {
      const mark = lane.informational === true ? ' (informativo)' : '';
      process.stdout.write(`${String(lane.value).padStart(7)}  ${lane.id}${mark}\n`);
    }
  } else {
    process.stdout.write(linesFor(id).map((r) => `${r}\n`).join(''));
  }
}
