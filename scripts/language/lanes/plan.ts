import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { Lane, LaneMeter } from '../lane.js';
import { isFlagged, tokenize } from '../lexicon.js';

// ============================================================
// LOS CARRILES DEL INSTRUMENTO DEL PLAN (I2 · issue #144 · rector §3.2)
//
// POR QUÉ ESTE MÓDULO EXISTE, Y POR QUÉ ES EL PRIMERO QUE HABÍA QUE ESCRIBIR
//
// El epic #141 traduce el código al inglés en veintisiete tramos. Casi todo lo
// que se rompa en esos tramos se romperá RUIDOSAMENTE: el compilador acusa un
// import que ya no resuelve y la suite acusa una función que cambió de nombre.
// Lo que mide este módulo es la excepción — las seis formas que tiene el
// tablero del plan de romperse EN SILENCIO cuando algo se renombra:
//
//   · un criterio que hace grep de `calcularSaldo` deja de encontrarlo, y si
//     su afirmación estaba escrita en positivo («si aparece, falla») el
//     criterio se pone VERDE sobre un archivo que ya no dice nada;
//   · un criterio que lee `codigoDe('src/services/poliza-service.ts')` mide un
//     archivo que no existe;
//   · un mutante con `archivo:` renombrado deja de aplicarse, y el arnés sólo
//     sabe acusar el ancla rota cuando cambia el TEXTO, no cuando se mueve el
//     archivo;
//   · un umbral de cobertura cuya llave es una ruta española deja de casar con
//     ningún archivo, y v8 no exige nada sobre lo que no encuentra;
//   · una fuente sellada del corpus que se renombra sale como «desapareció» —
//     ése al menos grita— o, peor, se re-sella con el nombre nuevo sin que
//     nadie relea el manual;
//   · y un `vi.mock` que apunta a un módulo renombrado deja la prueba
//     ejercitando el módulo REAL sin decirlo.
//
// Los seis son la misma familia: instrumentos que casan POR NOMBRE contra el
// árbol. Mientras el número no esté publicado, cada tramo del epic los apaga
// de a poco y nadie se entera hasta que hace falta que hablen.
//
// ------------------------------------------------------------
// TRES DECISIONES QUE GOBIERNAN LOS SEIS NÚMEROS
//
// 1. EL LÉXICO DECIDE QUÉ ES ESPAÑOL, NO ESTE ARCHIVO. Todo lo que aquí se
//    llama «español» pasa por `isFlagged` de scripts/language/lexicon.ts. No
//    hay ni una palabra escrita a mano en este módulo, y es a propósito: el
//    día que alguien creyó saber a ojo qué era español, `src/services/vault/`
//    entró a la lista por parecerlo. Con el léxico compartido este módulo
//    hereda las nueve carpetas inglesas verificadas y el 99 % de la muestra de
//    200 declaraciones, y —lo que importa más— publica el MISMO número que el
//    lint de I3, que consume la misma lista.
//
// 2. «RENOMBRABLE» ES PARTE DE LA MEDIDA, NO UN DETALLE. La primera medición
//    de estos carriles dio 37 criterios con ruta española y 25 mutantes; de
//    esos, 17 criterios y 15 mutantes apuntaban a `src/database/migrations/*`.
//    Una migración NO se renombra: su nombre de archivo es su fila en el
//    registro de migraciones, y cambiarlo la vuelve a correr o la pierde.
//    Contarlas habría publicado una deuda que nadie puede pagar —el modo
//    exacto en que un trinquete se desactiva entero—, así que quedan fuera con
//    su razón escrita (ver `isRenameable`). Lo mismo con los `.md`: la regla
//    de la casa mantiene la documentación en español, así que un doc con
//    nombre español no es deuda de este epic. Con esa exclusión, el carril de
//    mutantes da 10 y el de rutas 21 — exactamente las cifras de §3.2, que es
//    la mejor señal de que «renombrable» era lo que el rector medía.
//
// 3. LA UNIDAD ES EL ANCLA, NO EL CRITERIO. Un criterio con cinco greps
//    españoles cuenta cinco. Se consideró contar criterios y se descartó por
//    lo que le hace al trinquete: si la unidad es el criterio, arreglar cuatro
//    de sus cinco anclas no mueve el número, y un carril que no da crédito por
//    el trabajo hecho es un carril que nadie termina de pagar. Como efecto
//    secundario, `perFile` suma exactamente el total en los seis.
//
// ------------------------------------------------------------
// LOS SEIS NO SE PISAN. Es la tercera regla del contrato de carriles y aquí
// hay que comprobarla, porque cinco de los seis miran el mismo archivo:
//
//   · `plan-criteria-grepping-spanish-identifiers` mira LITERALES DE EXPRESIÓN
//     REGULAR dentro de `evaluar`;
//   · `plan-criteria-pinned-to-spanish-paths` mira LITERALES DE CADENA con
//     forma de ruta dentro de `evaluar`;  (una cadena no es una regex: por
//     construcción no hay un solo nodo que caiga en los dos)
//   · `plan-mutants-anchored-to-spanish-files` mira el campo `archivo` de
//     `mutantes` / `mutantesEnDisco`, que está FUERA de `evaluar`;
//   · `coverage-thresholds-keyed-by-spanish-paths` mira dos tablas que viven
//     fuera del array `CRITERIOS`, más los dos vitest.config;
//   · los otros dos no tocan `src/plan/` en absoluto.
//
// Lo que SÍ se repite es el archivo de destino: renombrar
// `src/services/sat/anexo24/balanza-service.ts` baja a la vez el carril 2, el
// 3 y el 6. Eso no es contar dos veces —son tres ediciones distintas en tres
// sitios distintos— y por eso los seis desglosan `perFile` POR EL ARCHIVO
// ESPAÑOL QUE SE VA A RENOMBRAR y no por el archivo que hay que editar: así el
// PR que renombra un módulo ve de un vistazo todo lo que ese renombrado le
// cuesta, sumado entre carriles.
// ============================================================

const ROOT = path.resolve(__dirname, '..', '..', '..');

/** Los archivos que este módulo lee, con su ruta relativa como la publica. */
const CRITERIA_TS = 'src/plan/criterios.ts';
// La OTRA mitad de los mutantes. `criterios.ts` los declara a mano en
// criterios literales; `conducta.ts` los trae en `PRUEBAS_DE_CONDUCTA`, que
// entra a CRITERIOS por un spread que el AST no puede seguir. Leer sólo el
// primero es lo que hacía que este metro publicara 12 mientras el módulo
// importado tenía 13.
const CONDUCT_TS = 'src/plan/conducta.ts';
const VITEST_UNIT = 'vitest.config.ts';
const VITEST_INTEGRATION = 'vitest.integration.config.ts';
const MANIFEST = 'src/ai/docs/manifiesto.json';

// ── EL CERO QUE PARECE UNA VICTORIA ─────────────────────────
//
// Los seis carriles tienen meta cero, así que un cero es indistinguible de la
// victoria — y ésa es exactamente la avería que se cuela cuando una fuente
// desaparece. Un `vitest.config.ts` movido no baja el carril de umbrales
// «porque se arreglaron los umbrales»: lo baja porque el metro dejó de mirar.
// El primer `--apretar` sobre esa lectura clava la línea base en un número que
// ya nadie puede volver a producir, y a partir de ahí el trinquete o miente o
// se desactiva. Por eso cada fuente que este módulo necesita se exige por su
// nombre ANTES de contar, y su ausencia revienta con el nombre puesto en vez
// de publicar un cero limpio. Es el mismo remedio que `tsFiles` en code.ts.

/**
 * Lo que el metro necesita leer, o el error que dice qué falta y por qué
 * importa. Se exporta para que la guarda se pueda ejercitar sin desmontar el
 * árbol: una guarda sin prueba es una guarda que alguien quita en el primer
 * refactor porque «no la cubre nada».
 */
export function required(rel: string, whatFor: string): string {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) {
    throw new Error(
      `no existe ${rel} bajo ${ROOT}: ${whatFor} habría publicado cero sin haber ` +
        'medido nada, que es la meta del carril. Comprueba desde dónde se ejecuta ' +
        'el metro —o si el archivo se movió— antes de creerte la cifra.'
    );
  }
  return full;
}

function read(rel: string, whatFor = 'el carril que lo lee'): string {
  return fs.readFileSync(required(rel, whatFor), 'utf-8');
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(ROOT, rel));
}

/**
 * El AST de un archivo del árbol. Se parsea con el compilador de TypeScript
 * —que ya es dependencia de la casa— y no con expresiones regulares, y la
 * razón está escrita en el propio `sinComentarios` de criterios.ts: ese
 * archivo está LLENO de literales de regex que contienen comillas, llaves y
 * barras (`/'src\/[^']+\.ts':/`), y cualquier lexer casero acaba abriendo un
 * comentario dentro de una cadena y perdiéndose media medición. Un metro que
 * se ciega con una comilla no es un metro.
 *
 * El AST trae además dos cosas gratis que la regex no da: los comentarios
 * quedan fuera por construcción (son trivia, no nodos), que es justo lo que
 * pide la casa —una mención en prosa no ejecuta nada—, y cada hallazgo llega
 * con su línea, que es lo que hace que un ejemplo se pueda abrir.
 */
function ast(rel: string, whatFor = 'el carril que lo lee'): ts.SourceFile {
  return ts.createSourceFile(rel, read(rel, whatFor), ts.ScriptTarget.Latest, true);
}

function lineOf(sf: ts.SourceFile, n: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
}

// ── Qué cuenta como ruta española renombrable ───────────────

/**
 * Una cadena con forma de ruta del repositorio. Deliberadamente estrecha: pide
 * al menos una barra y una extensión, para no confundir con una ruta un
 * fragmento de SQL ni un patrón de glob.
 */
const LOOKS_LIKE_PATH = /^(?:\.\.?\/)*[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.@-]+)+\.[A-Za-z0-9]+$/;

/**
 * El primer SEGMENTO español de una ruta, o `undefined`.
 *
 * Segmento a segmento y no la ruta entera, por dos razones. Una: el segmento
 * es lo que se renombra, así que nombrarlo hace el hallazgo accionable
 * («`poliza`, en `src/services/poliza-service.ts`»). Otra: la extensión se
 * quita antes de preguntar, porque `.sql` no está en ninguna lista y el léxico
 * lo clasificaría como inglés — inofensivo aquí, pero ruido en el ejemplo.
 */
function spanishSegment(filePath: string): string | undefined {
  const withoutExtension = filePath.replace(/\.[A-Za-z0-9]+$/, '');
  for (const segment of withoutExtension.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') continue;
    if (isFlagged(segment)) return segment;
  }
  return undefined;
}

/**
 * ¿Este archivo se puede renombrar? Dos exclusiones, cada una con lo que se
 * rompe si se ignora:
 *
 *   · cualquier ruta bajo un directorio `migrations/` — el nombre de una
 *     migración es su identidad en el registro. Renombrarla la vuelve a
 *     aplicar sobre una base que ya la tenía (o la deja huérfana, según el
 *     migrador), así que ninguna traducción va a tocarla. `040_el_secreto_que_el_compromiso_revelaba.sql` se queda con su
 *     nombre para siempre, y contarla sería publicar deuda impagable.
 *   · `*.md` — la regla escrita de la casa mantiene la documentación en
 *     español (es la decisión de I1: nace en inglés el CÓDIGO). Un documento
 *     con nombre español no es deuda de este epic.
 *
 * Lo que NO se excluye, y conviene decirlo porque parece lo mismo: los `.sql`
 * que no son migraciones y los `.json` de configuración. Ésos sí se renombran
 * —nadie los tiene registrados por nombre— y un criterio anclado a ellos sí se
 * queda apuntando a nada.
 */
export function isRenameable(filePath: string): boolean {
  if (/(?:^|\/)migrations\//.test(filePath)) return false;
  if (/\.md$/.test(filePath)) return false;
  return true;
}

/**
 * La ruta es española Y se puede renombrar: devuelve el segmento culpable.
 *
 * Se exporta —como `isRenameable` y `spanishIdentifiers`— porque estas
 * tres funciones NO son detalle de implementación: son la definición de los
 * seis carriles. Una prueba que sólo pueda mirar el total dice «95» y no puede
 * decir por qué; con las definiciones a la vista, cada caso frontera queda
 * clavado con su nombre (ver tests/language/lanes-plan.spec.ts).
 */
export function renameableSegment(filePath: string): string | undefined {
  return isRenameable(filePath) ? spanishSegment(filePath) : undefined;
}

// ── Qué cuenta como identificador español dentro de una regex ──

/**
 * Los identificadores españoles que una expresión regular busca.
 *
 * TRES FILTROS, Y LOS TRES SALIERON DE MIRAR LO QUE SIN ELLOS ENTRABA.
 *
 * 1. SE QUITAN LAS SECUENCIAS DE ESCAPE ANTES DE PARTIR. Sin esto,
 *    `/import \{[^}]*\bcensarRutas\b/` entrega el token `bcensarRutas` — la
 *    `\b` pegada al nombre — y el ejemplo manda a buscar un identificador que
 *    no existe. Un metro que publica un nombre inventado se deja de leer a la
 *    primera.
 *
 * 2. AL MENOS DOS TOKENS. Es lo que separa un IDENTIFICADOR de una PALABRA. La
 *    mitad de las regex de criterios.ts buscan prosa española dentro de un
 *    documento español (`/Los comentarios y la documentación van en español/`),
 *    y esa prosa no se rompe cuando el código se traduce: sus palabras están
 *    sueltas, una por token. `calcularSaldo`, `poliza_id` o `FOLIO_RE` traen
 *    dos o más porque son compuestos, que es como se escriben los nombres.
 *
 * 3. CONVENCIÓN DE MAYÚSCULAS DE TypeScript: camelCase, PascalCase o
 *    SCREAMING_SNAKE. Éste es el filtro que más quita y el que más vale, y no
 *    es un truco: en este árbol la caja del nombre DICE de qué lenguaje es. Lo
 *    que va en `lower_snake_case` es de SQL o de un JSON —
 *    `CREATE POLICY verificacion_publica`, `CONSTRAINT sesion_balanceada_con_aritmetica`,
 *    la columna `dias_con_veredictos`, la llave `segregacion_de_funciones`— y
 *    NINGUNO de ésos lo renombra una traducción de código: son nombres de
 *    objetos de base y valores de datos, y su renombrado es una migración.
 *    Contarlos habría metido diez anclas impagables en un carril con meta cero.
 *
 * LO QUE ESTE FILTRO NO ALCANZA, medido y no supuesto. Quedan dentro seis
 * anclas que un renombrado tampoco va a tocar, porque son nombres externos que
 * SÍ respetan la caja de TypeScript: los nodos del CFDI de nómina
 * (`TipoOtroPago`, `SubsidioAlEmpleo`, `SubsidioCausado`), la operación SOAP
 * del SAT (`SolicitaDescarga`, `IConsultaCFDIService`) y las llaves de
 * catálogo (`SAT_CATALOGS.REGIMEN_FISCAL`). Distinguirlas exige saber que del
 * otro lado del nombre hay un tercero que lo lee, y eso no está en ninguna
 * lista de palabras: es la frontera de AGENTS.md —«lo que identifica no se
 * traduce nunca»— y la decide una persona, no un léxico. Están contadas a
 * propósito y dichas aquí para que el último puñado del carril se cierre con
 * esa decisión escrita y no con un renombrado a ciegas.
 */
export function spanishIdentifiers(regexText: string): string[] {
  const withoutEscapes = regexText.replace(/\\[\s\S]/g, ' ');
  const candidates = withoutEscapes.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (seen.has(c)) continue;
    if (tokenize(c).length < 2) continue;
    if (!isFlagged(c)) continue;
    const camel = /[a-z0-9][A-Z]/.test(c);
    const screaming = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(c);
    if (!camel && !screaming) continue;
    seen.add(c);
  }
  return [...seen].sort();
}

// ── El árbol de criterios, leído una sola vez ───────────────

interface Criterion {
  packageName: string;
  statement: string;
  line: number;
  /** De qué archivo se leyó: los mutantes viven en dos, y el ejemplo lo dice. */
  source: string;
  evaluate?: ts.Expression;
  /** Anclas de mutante, con el campo del que salen (los dos arneses cuentan). */
  mutants: { file: string; field: string; line: number }[];
}

function property(o: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) {
      return p.initializer;
    }
  }
  return undefined;
}

function stringOf(e: ts.Expression | undefined): string | undefined {
  return e !== undefined && ts.isStringLiteralLike(e) ? e.text : undefined;
}

/**
 * El array `CRITERIOS`, sacado del fuente y no importado.
 *
 * Importar el módulo también funciona —`String(c.evaluar)` devuelve el cuerpo—
 * y de hecho es lo que hacen los `command` de estos carriles, a propósito: son
 * dos caminos distintos hasta el mismo número, y que coincidan es la
 * comprobación. Pero el metro se queda con el FUENTE porque el otro camino
 * pasa por el transpilador (esbuild borra los comentarios y reescribe los
 * literales), y un metro cuyo número depende de qué versión de esbuild resolvió
 * el import no es determinista. Además, sólo el fuente tiene líneas que citar.
 */
function criteria(sf: ts.SourceFile): Criterion[] {
  let array: ts.ArrayLiteralExpression | undefined;
  const search = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'CRITERIOS' &&
      n.initializer !== undefined &&
      ts.isArrayLiteralExpression(n.initializer)
    ) {
      array = n.initializer;
    }
    ts.forEachChild(n, search);
  };
  search(sf);
  if (array === undefined) {
    throw new Error(
      `${CRITERIA_TS} ya no declara «export const CRITERIOS = [...]»: los tres primeros ` +
        'carriles medirían cero sobre nada. Ajusta el metro antes que la línea base.'
    );
  }

  const out: Criterion[] = [];
  for (const element of array.elements) {
    // Un `...PRUEBAS_DE_CONDUCTA.map(...)` no es un objeto literal: sus
    // criterios se construyen en tiempo de ejecución y no hay nada estático que
    // leer, y aquí se saltan. Sus mutantes NO se pierden: los lee
    // `conductCriteria` de `conducta.ts`, donde sí están escritos como
    // literales. Antes se daban por perdidos con esa excusa escrita, y el
    // carril publicaba 12 mientras el módulo importado tenía 13 — el hueco no
    // se notó hasta que un tramo ancló el primer mutante de conducta sobre un
    // archivo de nombre español.
    if (!ts.isObjectLiteralExpression(element)) continue;
    const mutants: Criterion['mutants'] = [];
    for (const field of ['mutantes', 'mutantesEnDisco']) {
      const list = property(element, field);
      if (list === undefined || !ts.isArrayLiteralExpression(list)) continue;
      for (const m of list.elements) {
        if (!ts.isObjectLiteralExpression(m)) continue;
        const file = stringOf(property(m, 'archivo'));
        if (file !== undefined) mutants.push({ file, field, line: lineOf(sf, m) });
      }
    }
    out.push({
      packageName: stringOf(property(element, 'paquete')) ?? '(sin paquete)',
      statement: stringOf(property(element, 'enunciado')) ?? '',
      line: lineOf(sf, element),
      source: CRITERIA_TS,
      evaluate: property(element, 'evaluar'),
      mutants,
    });
  }
  return out;
}

/**
 * LOS MUTANTES DE CONDUCTA, que viven en el otro archivo.
 *
 * `PRUEBAS_DE_CONDUCTA` sí es un arreglo de literales, así que se lee igual que
 * `CRITERIOS`; lo que no se puede seguir es el spread que las convierte en
 * criterios. Sólo se sacan los mutantes: los otros dos carriles que usan
 * `Criterion` miran `evaluar`, que aquí no existe.
 *
 * Se exige el archivo por su nombre, como toda fuente de este módulo: si
 * desaparece, el carril bajaría «solo» y el primer `--apretar` clavaría una
 * cifra que ya nadie puede reproducir.
 */
function conductCriteria(sf: ts.SourceFile): Criterion[] {
  let array: ts.ArrayLiteralExpression | undefined;
  const search = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.name.text === 'PRUEBAS_DE_CONDUCTA' &&
      n.initializer !== undefined &&
      ts.isArrayLiteralExpression(n.initializer)
    ) {
      array = n.initializer;
    }
    ts.forEachChild(n, search);
  };
  search(sf);
  if (array === undefined) {
    throw new Error(
      `${CONDUCT_TS} ya no declara «export const PRUEBAS_DE_CONDUCTA = [...]»: el carril de ` +
        'mutantes volvería a contar sólo la mitad, y su comando publicaría otra cifra.'
    );
  }

  const out: Criterion[] = [];
  for (const element of array.elements) {
    if (!ts.isObjectLiteralExpression(element)) continue;
    const mutants: Criterion['mutants'] = [];
    for (const field of ['mutantes', 'mutantesEnDisco']) {
      const list = property(element, field);
      if (list === undefined || !ts.isArrayLiteralExpression(list)) continue;
      for (const m of list.elements) {
        if (!ts.isObjectLiteralExpression(m)) continue;
        const file = stringOf(property(m, 'archivo'));
        if (file !== undefined) mutants.push({ file, field, line: lineOf(sf, m) });
      }
    }
    if (mutants.length === 0) continue;
    out.push({
      packageName: stringOf(property(element, 'paquete')) ?? '(conducta)',
      statement: stringOf(property(element, 'enunciado')) ?? '',
      line: lineOf(sf, element),
      source: CONDUCT_TS,
      mutants,
    });
  }
  return out;
}

/** Todos los nodos del subárbol que cumplen el predicado, en orden de fuente. */
function nodes(root: ts.Node, matches: (n: ts.Node) => boolean): ts.Node[] {
  const out: ts.Node[] = [];
  const walk = (n: ts.Node): void => {
    if (matches(n)) out.push(n);
    ts.forEachChild(n, walk);
  };
  walk(root);
  return out;
}

// ── Carril 1 · greps de un identificador español ────────────

/**
 * A QUÉ ARCHIVO APUNTA UNA REGEX, que es lo que hace útil el desglose.
 *
 * `perFile` sólo sirve para pagar por tramos si su llave es el archivo cuyo
 * renombrado cierra esa cuenta. Para los otros cinco carriles esa llave está
 * escrita en el propio hallazgo; para éste no: el criterio no cita al
 * identificador, cita al ARCHIVO donde lo busca, y hay que seguirlo un salto.
 *
 * El salto es corto porque criterios.ts escribe siempre la misma figura:
 *
 *     const p = 'src/services/accounting/posting.ts';
 *     const s = codigoDe(p);
 *     if (!/autorizarPosteo/.test(s)) …
 *
 * así que basta con recordar dos clases de variable —la que guarda una ruta y
 * la que guarda el texto leído— y mirar de quién es la regex: el receptor de
 * `.test(x)` / `.exec(x)`, o el sujeto de `x.match(re)`. Con eso se resuelven
 * 93 de las 95 anclas de hoy. Las que no se resuelven van a `src/plan/criterios.ts`,
 * que es literalmente donde hay que editar cuando el criterio no nombra a
 * nadie: no es un cajón de sastre, es la respuesta correcta para ese caso.
 *
 * Se resolvió deliberadamente POCO. Un resolvedor que persiga arrays y objetos
 * de rutas acertaría dos anclas más y traería consigo la clase de código que
 * falla en silencio cuando el archivo cambie de forma; el desglose es una
 * ayuda para repartir trabajo, no la cifra, y la cifra no depende de él.
 */
function fileReadBy(criterion: Criterion, regex: ts.Node): string {
  const ev = criterion.evaluate;
  if (ev === undefined) return CRITERIA_TS;

  const READERS = new Set(['codigoDe', 'crudoDe']);
  const pathFromCall = (n: ts.Node, vars: Map<string, string>): string | undefined => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return undefined;
    if (!READERS.has(n.expression.text)) return undefined;
    const parts: string[] = [];
    for (const a of n.arguments) {
      const c = stringOf(a);
      if (c !== undefined) parts.push(c);
      else if (ts.isIdentifier(a) && vars.has(a.text)) parts.push(vars.get(a.text) as string);
      else return undefined;
    }
    return parts.length > 0 ? parts.join('/') : undefined;
  };

  // Una sola pasada en orden de fuente basta: en TypeScript la declaración
  // precede al uso, y aquí se leen declaraciones, no asignaciones tardías.
  const vars = new Map<string, string>();
  for (const n of nodes(ev, (x) => ts.isVariableDeclaration(x))) {
    const d = n as ts.VariableDeclaration;
    if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue;
    const direct = stringOf(d.initializer);
    if (direct !== undefined && LOOKS_LIKE_PATH.test(direct)) {
      vars.set(d.name.text, direct);
      continue;
    }
    const readPath = pathFromCall(d.initializer, vars);
    if (readPath !== undefined) vars.set(d.name.text, readPath);
  }

  const resolvePath = (e: ts.Expression | undefined): string | undefined => {
    if (e === undefined) return undefined;
    if (ts.isIdentifier(e)) return vars.get(e.text);
    return pathFromCall(e, vars);
  };

  let destination: string | undefined;
  const parent = regex.parent;
  if (
    ts.isPropertyAccessExpression(parent) &&
    ts.isCallExpression(parent.parent) &&
    parent.parent.expression === parent &&
    (parent.name.text === 'test' || parent.name.text === 'exec')
  ) {
    destination = resolvePath(parent.parent.arguments[0]);
  } else if (ts.isCallExpression(parent) && ts.isPropertyAccessExpression(parent.expression)) {
    const method = parent.expression.name.text;
    if (['match', 'matchAll', 'replace', 'replaceAll', 'split', 'search'].includes(method)) {
      destination = resolvePath(parent.expression.expression);
    }
  }

  return destination !== undefined && /\.(?:ts|tsx|mts|cts)$/.test(destination) ? destination : CRITERIA_TS;
}

function grepsLane(sf: ts.SourceFile, list: Criterion[]): Lane {
  const perFile: Record<string, number> = {};
  const examples: string[] = [];
  let total = 0;

  for (const c of list) {
    if (c.evaluate === undefined) continue;
    for (const n of nodes(c.evaluate, (x) => x.kind === ts.SyntaxKind.RegularExpressionLiteral)) {
      const ids = spanishIdentifiers(n.getText(sf));
      if (ids.length === 0) continue;
      total++;
      const file = fileReadBy(c, n);
      perFile[file] = (perFile[file] ?? 0) + 1;
      examples.push(
        `${CRITERIA_TS}:${lineOf(sf, n)} · ${c.packageName} · ${n.getText(sf)} → ${ids.join(', ')} (en ${file})`
      );
    }
  }

  return {
    id: 'plan-criteria-grepping-spanish-identifiers',
    title: 'plan criteria regexes that grep a Spanish identifier',
    value: total,
    target: 0,
    // El único de los seis cuyo comando repite la receta en vez de llegar por
    // otro camino, y hay que decirlo: un literal de expresión regular no se
    // saca de TypeScript con grep —hace falta el parser para saber que esa
    // barra abre una regex y no una división—, así que el comando parsea igual
    // que el carril. Lo que sí es independiente es el RECORTE: en vez de
    // recorrer el array de criterios, corta el fuente por texto —desde la
    // declaración hasta el `];` que la cierra en la columna cero— y parsea ese
    // trozo. Si el número coincide, el recorrido del metro no se está dejando
    // ni añadiendo criterios por el camino.
    //
    // EL RECORTE TIENE QUE CERRAR, y la primera versión no cerraba: cortaba
    // desde la declaración HASTA EL FINAL DEL ARCHIVO. Hoy detrás del array
    // sólo queda `criterioDeConducta`, que no lleva ni una regex, así que los
    // dos números coincidían; plantado un `export const AUXILIAR =
    // /calcularSaldoDeudor/` después del cierre, el metro seguía en 1 y el
    // comando decía 2. Un comando que cuenta lo que el carril no cuenta no
    // reproduce la cifra: la desmiente el día que alguien escriba una regex
    // española en un ayudante del archivo, y entonces el que no se cree es el
    // metro.
    command:
      'npx tsx -e \'const fs=require("fs"),ts=require("typescript"),{isFlagged,tokenize}=require("./scripts/language/lexicon.ts");' +
      'const s=fs.readFileSync("src/plan/criterios.ts","utf8"),i=s.indexOf("export const CRITERIOS");' +
      'const sf=ts.createSourceFile("c.ts",s.slice(i,s.indexOf("\\n];",i)),ts.ScriptTarget.Latest,true);' +
      'let n=0;const w=x=>{if(x.kind===ts.SyntaxKind.RegularExpressionLiteral&&' +
      '(x.getText(sf).replace(/\\\\[\\s\\S]/g," ").match(/[A-Za-z_$][A-Za-z0-9_$]*/g)||[]).some(' +
      'r=>tokenize(r).length>1&&isFlagged(r)&&(/[a-z0-9][A-Z]/.test(r)||/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(r))))n++;' +
      'ts.forEachChild(x,w)};w(sf);console.log(n)\'',
    examples: examples.slice(0, 6),
    perFile: sortKeys(perFile),
  };
}

// ── Carril 2 · rutas españolas citadas por un criterio ──────

/**
 * LA LLAVE DEL DESGLOSE TIENE QUE SER EL ARCHIVO, NO CÓMO SE ESCRIBIÓ.
 *
 * `src/plan/criterios.ts` cita el mismo módulo de dos formas: como ruta del
 * repositorio —`codigoDe('src/cli/kernel/riesgos-retrofit.ts')`, línea 3039— y
 * como specifier de un `import()` dinámico, que va relativo al archivo y con
 * la extensión compilada —`'../cli/kernel/riesgos-retrofit.js'`, línea 2945—.
 * Son dos anclas y cuentan dos, que es la regla del carril; pero sin
 * normalizar salían en DOS COLUMNAS del desglose, y una de ellas
 * (`../cli/...`) no es una ruta de este árbol ni casa con ninguna llave de los
 * otros cinco carriles. El PR que renombra ese módulo buscaba su nombre en el
 * desglose y leía «1» donde le cuestan dos, que es justo lo contrario de para
 * lo que existe `perFile`. El carril 6 ya normalizaba así sus specifiers; esto
 * es la misma normalización, y por eso vive junto a ella y no en otra idea.
 *
 * El cambio de `.js` a `.ts` se hace SÓLO cuando el `.ts` existe y el `.js` no:
 * un artefacto compilado que de verdad se citara por su nombre seguiría
 * apareciendo con el suyo en vez de mandarnos a un fuente que no es.
 */
function perFileKey(cited: string): string {
  const fromRepoRoot = cited.startsWith('.')
    ? path.posix.normalize(path.posix.join(path.posix.dirname(CRITERIA_TS), cited))
    : cited;
  if (!fromRepoRoot.endsWith('.js')) return fromRepoRoot;
  const asSource = fromRepoRoot.replace(/\.js$/, '.ts');
  return !exists(fromRepoRoot) && exists(asSource) ? asSource : fromRepoRoot;
}

function pathsLane(sf: ts.SourceFile, list: Criterion[]): Lane {
  const perFile: Record<string, number> = {};
  const examples: string[] = [];
  let total = 0;

  for (const c of list) {
    if (c.evaluate === undefined) continue;
    // Por CRITERIO y no por aparición: `codigoDe(p)` tras `const p = '…'` cita
    // la misma ruta dos veces en el fuente y es UNA sola cosa que arreglar.
    // Dentro de un criterio se deduplica; entre criterios no, porque cada uno
    // es una edición aparte.
    const citedPaths = new Map<string, number>();
    for (const n of nodes(c.evaluate, (x) => ts.isStringLiteralLike(x))) {
      const t = (n as ts.StringLiteralLike).text;
      if (!LOOKS_LIKE_PATH.test(t)) continue;
      if (renameableSegment(t) === undefined) continue;
      if (!citedPaths.has(t)) citedPaths.set(t, lineOf(sf, n));
    }
    for (const [filePath, line] of [...citedPaths].sort()) {
      total++;
      // El TOTAL sigue contando anclas —dos escrituras son dos ediciones— y la
      // deduplicación sigue siendo por texto dentro del criterio: lo que se
      // normaliza es sólo la llave con la que se agrupa el trabajo.
      perFile[perFileKey(filePath)] = (perFile[perFileKey(filePath)] ?? 0) + 1;
      examples.push(
        `${CRITERIA_TS}:${line} · ${c.packageName} · ${filePath} (segmento «${spanishSegment(filePath) ?? ''}»)`
      );
    }
  }

  return {
    id: 'plan-criteria-pinned-to-spanish-paths',
    title: 'plan criteria pinned to a renameable Spanish path',
    value: total,
    target: 0,
    // Llega por el otro camino: importa el módulo y lee el cuerpo transpilado
    // de cada `evaluar`. No comparte una línea de código con el carril, así
    // que si los dos números coinciden, coinciden de verdad.
    command:
      'npx tsx -e \'const{CRITERIOS}=require("./src/plan/criterios.ts"),{isFlagged}=require("./scripts/language/lexicon.ts");' +
      'const ren=p=>!/(^|\\/)migrations\\//.test(p)&&!/\\.md$/.test(p);' +
      'const esp=p=>p.replace(/\\.[A-Za-z0-9]+$/,"").split("/").some(s=>s&&s!=="."&&s!==".."&&isFlagged(s));' +
      'let n=0;for(const c of CRITERIOS){const r=new Set((String(c.evaluar).match(/["\\x27`][^"\\x27`\\n]*["\\x27`]/g)||[])' +
      '.map(s=>s.slice(1,-1)).filter(t=>/^(?:\\.\\.?\\/)*[A-Za-z0-9_.-]+(?:\\/[A-Za-z0-9_.@-]+)+\\.[A-Za-z0-9]+$/.test(t)&&ren(t)&&esp(t)));' +
      'n+=r.size}console.log(n)\'',
    examples: examples.slice(0, 6),
    perFile: sortKeys(perFile),
  };
}

// ── Carril 3 · mutantes anclados a un archivo renombrable ───

function mutantsLane(list: Criterion[]): Lane {
  const perFile: Record<string, number> = {};
  const examples: string[] = [];
  let total = 0;

  for (const c of list) {
    for (const m of c.mutants) {
      if (renameableSegment(m.file) === undefined) continue;
      total++;
      perFile[m.file] = (perFile[m.file] ?? 0) + 1;
      examples.push(`${c.source}:${m.line} · ${c.packageName} · ${m.field} → ${m.file}`);
    }
  }

  return {
    id: 'plan-mutants-anchored-to-spanish-files',
    title: 'plan mutants anchored to a renameable Spanish file',
    value: total,
    target: 0,
    // Por el otro camino: los mutantes REALES del módulo importado, no los que
    // este metro cree haber leído del fuente.
    command:
      'npx tsx -e \'const{CRITERIOS}=require("./src/plan/criterios.ts"),{isFlagged}=require("./scripts/language/lexicon.ts");' +
      'const ok=p=>!/(^|\\/)migrations\\//.test(p)&&!/\\.md$/.test(p)&&' +
      'p.replace(/\\.[A-Za-z0-9]+$/,"").split("/").some(s=>s&&isFlagged(s));' +
      'console.log(CRITERIOS.flatMap(c=>[...(c.mutantes||[]),...(c.mutantesEnDisco||[])]).filter(m=>ok(m.archivo)).length)\'',
    examples: examples.slice(0, 6),
    perFile: sortKeys(perFile),
  };
}

// ── Carril 4 · umbrales de cobertura con llave española ─────

/**
 * Las llaves de un objeto `thresholds:` o de una tabla de suelos.
 *
 * Se localiza el objeto por el nombre que lo introduce y se leen los nombres de
 * sus propiedades. Buscar `'src/…\.ts':` por regex sobre el archivo entero
 * —que fue el primer intento— cuenta de más y de forma vergonzosa: criterios.ts
 * lleva un mutante cuyo `de:` es exactamente la cadena `"'src/services/reporting/criterio-cierre.ts': {"`
 * y otro cuyo `a:` la sustituye por `otro-archivo.ts`, así que la regex
 * publicaba cuatro entradas donde hay dos. El AST no confunde el texto de un
 * mutante con una entrada de tabla.
 */
function tableKeys(sf: ts.SourceFile, names: string[]): { key: string; line: number }[] {
  const out: { key: string; line: number }[] = [];
  const collect = (obj: ts.ObjectLiteralExpression): void => {
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = ts.isStringLiteralLike(p.name)
        ? p.name.text
        : ts.isIdentifier(p.name)
          ? p.name.text
          : undefined;
      if (key !== undefined) out.push({ key, line: lineOf(sf, p) });
    }
  };
  const walk = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      names.includes(n.name.text) &&
      n.initializer !== undefined &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      collect(n.initializer);
    }
    if (
      ts.isPropertyAssignment(n) &&
      ts.isIdentifier(n.name) &&
      names.includes(n.name.text) &&
      ts.isObjectLiteralExpression(n.initializer)
    ) {
      collect(n.initializer);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

function thresholdsLane(criteriaSf: ts.SourceFile): Lane {
  const perFile: Record<string, number> = {};
  const examples: string[] = [];
  let total = 0;

  // Los cuatro sitios donde una ruta se convierte en exigencia de cobertura.
  // El rector nombra dos —`thresholds` de vitest.config.ts y
  // SUELO_COBERTURA_UNITARIA—; están los cuatro porque el defecto es idéntico
  // en los otros dos y porque la pareja de integración existe desde S4a: dejar
  // fuera el suelo que vigila las pruebas que de verdad tocan el dinero habría
  // sido medir la mitad del instrumento.
  const sources: { rel: string; names: string[]; sf?: ts.SourceFile }[] = [
    { rel: VITEST_UNIT, names: ['thresholds'] },
    { rel: VITEST_INTEGRATION, names: ['thresholds'] },
    {
      rel: CRITERIA_TS,
      names: ['SUELO_COBERTURA_UNITARIA', 'SUELO_COBERTURA_INTEGRACION'],
      // Ya parseado por el metro: 6 700 líneas no se leen dos veces.
      sf: criteriaSf,
    },
  ];

  // LO QUE SÍ SE EXIGE Y LO QUE NO. El ARCHIVO que falta se nombra y para la
  // medición: antes había aquí un `continue` y costaba una unidad medida —sin
  // `vitest.config.ts` el carril bajaba de 4 a 3 con la salida limpia, como si
  // alguien hubiera traducido una llave—. La TABLA vacía, en cambio, no
  // revienta: un `thresholds: {}` puede ser una decisión legítima de la casa, y
  // una guarda que la prohíba obligaría a editar este metro para cambiar la
  // configuración de cobertura. El hueco que queda —que alguien RENOMBRE
  // `SUELO_COBERTURA_UNITARIA` y el carril baje solo— lo caza el `command` de
  // abajo, que importa esas constantes POR SU NOMBRE: si dejan de existir, la
  // prueba que ejecuta el comando falla en vez de callarse.
  for (const f of sources) {
    for (const { key, line } of tableKeys(f.sf ?? ast(f.rel, 'el carril de umbrales'), f.names)) {
      if (!LOOKS_LIKE_PATH.test(key)) continue;
      if (renameableSegment(key) === undefined) continue;
      total++;
      perFile[key] = (perFile[key] ?? 0) + 1;
      examples.push(`${f.rel}:${line} · ${key}`);
    }
  }

  return {
    id: 'coverage-thresholds-keyed-by-spanish-paths',
    title: 'coverage thresholds keyed by a renameable Spanish path',
    value: total,
    target: 0,
    // Por el otro camino, y usando el parser que la propia casa ya escribió
    // para leer umbrales (`umbralesDeclarados`) en vez de uno nuevo.
    command:
      'npx tsx -e \'const fs=require("fs"),{SUELO_COBERTURA_UNITARIA:U,SUELO_COBERTURA_INTEGRACION:I,umbralesDeclarados:D}=require("./src/plan/criterios.ts"),' +
      '{isFlagged}=require("./scripts/language/lexicon.ts");' +
      'const k=[...Object.keys(U),...Object.keys(I),...D(fs.readFileSync("vitest.config.ts","utf8")).keys(),' +
      '...D(fs.readFileSync("vitest.integration.config.ts","utf8")).keys()];' +
      'console.log(k.filter(p=>p.replace(/\\.[A-Za-z0-9]+$/,"").split("/").some(s=>isFlagged(s))).length)\'',
    examples: examples.slice(0, 6),
    perFile: sortKeys(perFile),
  };
}

// ── Carril 5 · fuentes selladas con nombre español ──────────

/**
 * La llave del manifiesto donde el corpus declara las fuentes de cada manual.
 * Va como CADENA y no como propiedad de un tipo escrito aquí: es un dato del
 * archivo, lo escribe otro, y un identificador español en este módulo sería
 * deuda del propio metro —además de que renombrarlo rompería la lectura del
 * JSON sin que nada se queje—.
 */
const MANUALS_KEY = 'manuales';

/** El manifiesto tal y como viene: llaves de datos, no nombres nuestros. */
export type Manifest = Record<string, Record<string, string[]> | undefined>;

/**
 * El mapa de manuales del manifiesto, o el error que dice que ya no está.
 *
 * Se exporta para que la guarda tenga prueba propia: un manifiesto que cambió
 * de forma deja este carril tan ciego como un manifiesto ausente, y las dos
 * cegueras publican el mismo cero —que es la meta del carril— sin una línea de
 * salida que lo delate.
 */
export function manualsIn(manifest: Manifest): Record<string, string[]> {
  const manuals = manifest[MANUALS_KEY];
  if (manuals === undefined) {
    throw new Error(
      `${MANIFEST} ya no trae el mapa «${MANUALS_KEY}»: el carril del corpus daría ` +
        'cero sin haber mirado una sola fuente. Ajusta el metro antes que la línea base.'
    );
  }
  return manuals;
}

function corpusLane(): Lane {
  const perFile: Record<string, number> = {};
  const examples: string[] = [];
  let total = 0;

  // El `if (exists(...))` que había aquí publicaba 0 cuando el manifiesto no
  // estaba, y 0 es la meta: la desaparición del corpus se leía como el corpus
  // ya traducido. Ahora falta el archivo y se dice; y falta el mapa de
  // manuales dentro del archivo y también se dice, porque un manifiesto que
  // cambió de forma deja este carril igual de ciego que un manifiesto ausente.
  const manuals = manualsIn(JSON.parse(read(MANIFEST, 'el carril del corpus')) as Manifest);

  // Se cuentan las fuentes DECLARADAS, no las ya selladas en `hashes`. Un
  // manual sin revisar todavía —hoy, payroll.md— no tiene hash y aun así
  // declara sus fuentes por ruta: el día que una de ellas se renombre, el
  // manifiesto dirá «desapareció» igual, y el hueco es el mismo. Contar sólo
  // los hashes daría cero justo sobre el único caso que hay.
  const declared = new Map<string, string[]>();
  for (const [manual, sources] of Object.entries(manuals)) {
    for (const f of sources) {
      declared.set(f, [...(declared.get(f) ?? []), manual]);
    }
  }
  for (const [filePath, citedBy] of [...declared].sort()) {
    if (renameableSegment(filePath) === undefined) continue;
    total++;
    perFile[filePath] = (perFile[filePath] ?? 0) + 1;
    examples.push(`${MANIFEST} · ${citedBy.sort().join(', ')} → ${filePath}`);
  }

  return {
    id: 'agent-corpus-sources-with-spanish-names',
    title: 'agent corpus sources sealed under a renameable Spanish path',
    value: total,
    target: 0,
    command:
      'npx tsx -e \'const m=require("./src/ai/docs/manifiesto.json"),{isFlagged}=require("./scripts/language/lexicon.ts");' +
      'console.log([...new Set(Object.values(m.manuales).flat())]' +
      '.filter(p=>p.replace(/\\.[A-Za-z0-9]+$/,"").split("/").some(s=>isFlagged(s))).length)\'',
    examples: examples.slice(0, 6),
    perFile: sortKeys(perFile),
  };
}

// ── Carril 6 · vi.mock a un módulo español ──────────────────

/** Los .ts de un directorio, en orden estable. `readdirSync` no lo promete. */
function tsFilesUnder(rel: string, whatFor: string): string[] {
  // Sin este `required`, un `tests/` que no está devuelve la lista vacía y el
  // carril de mocks publica 0 — la meta exacta — con la salida impecable.
  required(rel, whatFor);
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs
      .readdirSync(path.join(ROOT, dir), { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
      const child = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith('.ts')) out.push(child);
    }
  };
  walk(rel);
  return out;
}

function mocksLane(): Lane {
  const perFile: Record<string, number> = {};
  const examples: string[] = [];
  let total = 0;

  for (const rel of tsFilesUnder('tests', 'el carril de mocks')) {
    const sf = ast(rel);
    for (const n of nodes(sf, (x) => ts.isCallExpression(x))) {
      const call = n as ts.CallExpression;
      if (!ts.isPropertyAccessExpression(call.expression)) continue;
      const obj = call.expression.expression;
      if (!ts.isIdentifier(obj) || obj.text !== 'vi') continue;
      // `mock` y `doMock` son los que sustituyen. `unmock` también apunta por
      // ruta y también se queda huérfano, así que cuenta: un `unmock` que ya
      // no casa con nada deja puesto el mock que venía a quitar.
      if (!['mock', 'doMock', 'unmock'].includes(call.expression.name.text)) continue;
      const specifier = stringOf(call.arguments[0]);
      if (specifier === undefined) continue;

      // Se normaliza a ruta del repositorio para que la llave de `perFile`
      // sea el archivo que se renombra y no cinco escrituras relativas del
      // mismo módulo. `.js` → `.ts` porque NodeNext obliga a escribir el
      // specifier compilado y el archivo que existe es el fuente.
      const absolute = specifier.startsWith('.')
        ? path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier))
        : specifier;
      const moduleFile = absolute.replace(/\.js$/, '.ts');
      if (renameableSegment(moduleFile) === undefined) continue;

      total++;
      perFile[moduleFile] = (perFile[moduleFile] ?? 0) + 1;
      examples.push(
        `${rel}:${lineOf(sf, call)} · vi.${call.expression.name.text}('${specifier}') → ${moduleFile}`
      );
    }
  }

  return {
    id: 'test-mocks-of-spanish-modules',
    title: 'vi.mock calls pointing at a renameable Spanish module',
    value: total,
    target: 0,
    // Éste sí sale con grep, porque `vi.mock('…')` es una línea y no un
    // literal que haya que desambiguar. El léxico entra sólo para decidir el
    // idioma, que es lo único que no se puede pedir a grep.
    //
    // EL ANCLA `^[[:space:]]*` NO ES COSMÉTICA, y lo demostró la propia prueba
    // de este carril: su comentario CITA un `vi.mock('…criterio-cierre.js')`
    // para explicar por qué se normaliza el specifier, y sin el ancla el
    // comando contaba once donde el carril cuenta diez. El AST no ve los
    // comentarios; grep sí, así que hay que decirle que una llamada empieza la
    // línea. Si algún día alguien escribe un `vi.doMock` anidado dentro de una
    // expresión, este comando dejará de casar con el carril y la prueba que los
    // compara lo dirá — que es exactamente para lo que está.
    //
    // LO QUE SÍ ERA COSMÉTICO Y NO LO PARECÍA: la comilla. La primera versión
    // sólo casaba con `vi.mock('…')` en comilla simple, que es como está
    // escrito todo `tests/` HOY —por eso los dos números daban diez y nadie
    // veía nada—. Plantados dos mocks más en un árbol de juguete, uno con
    // comillas dobles, el carril decía cuatro y el comando uno. La comilla no
    // es una convención que este metro pueda dar por hecha: el linter de la
    // casa no la fija en un argumento de llamada, y el día que alguien pegue
    // un `vi.mock("…")` el comando se queda corto en silencio. Ahora las dos
    // comillas entran, y el ancla de principio de línea —que sí gana algo—
    // se queda.
    command:
      "grep -rhoE \"^[[:space:]]*vi\\.(mock|doMock|unmock)\\(['\\\"][^'\\\"]+['\\\"]\" tests --include='*.ts' | sed -E \"s/.*['\\\"]([^'\\\"]+)['\\\"]$/\\1/\" | " +
      'npx tsx -e \'const{isFlagged}=require("./scripts/language/lexicon.ts");' +
      'console.log(require("fs").readFileSync(0,"utf8").split("\\n").filter(Boolean)' +
      '.filter(p=>!/(^|\\/)migrations\\//.test(p)&&p.replace(/\\.[A-Za-z0-9]+$/,"")' +
      '.split("/").some(s=>s&&s!=="."&&s!==".."&&isFlagged(s))).length)\'',
    examples: examples.slice(0, 6),
    perFile: sortKeys(perFile),
  };
}

// ── El metro ────────────────────────────────────────────────

/** Llaves ordenadas: el JSON del metro tiene que ser byte a byte reproducible. */
function sortKeys(m: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(m).sort()) out[k] = m[k];
  return out;
}

/**
 * Los seis carriles del instrumento del plan.
 *
 * Se parsea `criterios.ts` UNA vez y se reparte: son 6 700 líneas y tres
 * carriles la necesitan.
 */
export const planLanes: LaneMeter = (): Lane[] => {
  const sf = ast(CRITERIA_TS);
  const list = criteria(sf);
  // El carril de mutantes cuenta LAS DOS fuentes; los otros dos miran `evaluar`,
  // que sólo existe en criterios.ts.
  const withConduct = [...list, ...conductCriteria(ast(CONDUCT_TS))];
  return [
    grepsLane(sf, list),
    pathsLane(sf, list),
    mutantsLane(withConduct),
    thresholdsLane(sf),
    corpusLane(),
    mocksLane(),
  ];
};
