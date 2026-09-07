// ============================================================
// LOS CARRILES DEL CÓDIGO (I2 · issue #144, rector §3.2)
//
// Seis números: cuánto español queda DECLARADO en `src/`, `tests/` y
// `scripts/`, y cuántos archivos de esos tres árboles llevan nombre español.
// El epic #141 traduce el código en veintisiete tramos y ninguno es evaluable
// sin esto: sin una cifra por carril, «queda español» es una impresión, y una
// impresión no baja.
//
// LA POBLACIÓN ES LA DEL LINT DE I3, Y ÉSE ES EL PUNTO ENTERO
//
// El metro y el lint `house/english-identifiers` tienen que contar LO MISMO.
// Si el metro publica un número y el lint pone en rojo otro, hay dos verdades
// y nadie sabe cuál miente; peor, la primera vez que alguien arregla lo que el
// lint señala y el metro no se mueve, deja de mirar el metro. Por eso aquí no
// hay recorrido propio: la población es **el identificador en posición de
// declaración**, que es exactamente el nodo sobre el que un lint puede
// informar —variables, funciones, clases, interfaces, tipos, enums y sus
// miembros, parámetros, propiedades y los enlaces de una desestructuración— y
// se cuenta UNA VEZ POR NODO, que es como un lint informa. Dos firmas de
// sobrecarga con el mismo nombre son dos avisos del lint y son dos aquí.
//
// POR QUÉ UN ÁRBOL DE SINTAXIS Y NO UNA EXPRESIÓN REGULAR
//
// No es gusto por el rigor: está medido. Un `grep -E '^\s*(export )?(const )?
// enum '` sobre `src/` da 32 declaraciones de enum; el recorrido de este
// archivo da 24. Las ocho de diferencia están todas en
// `src/api/graphql/schemas/schema.ts`, dentro de la plantilla de SDL de
// GraphQL: son la palabra `enum` VIVIENDO EN UNA CADENA. Un metro que las
// cuenta sube ocho cuando alguien añade un tipo al esquema de GraphQL y baja
// ocho cuando lo quita, sin que nadie haya traducido nada. Aquí parsea el
// mismo TypeScript que compila el proyecto (`typescript` ya es dependencia; no
// entra ninguna nueva), así que los comentarios y las cadenas no existen para
// el recorrido: el aviso del rector —«un regex ingenuo cuenta la palabra
// `const` dentro de una cadena»— queda cerrado por construcción, no por
// cuidado, que es la única forma en que un aviso se queda cerrado.
//
// El mismo recorrido, contrastado contra `grep` donde `grep` SÍ acierta:
// `export function` de primer nivel en `src/` da 1 235 por las dos vías;
// `interface`, 1 102 por las dos; `class`, 100 por las dos. Coinciden donde
// tienen que coincidir y difieren donde el árbol tiene razón.
//
// LO QUE LA POBLACIÓN DEJA FUERA, Y POR QUÉ, QUE ES DONDE SE MIENTE
//
//   · LAS CLAVES DE OBJETO LITERAL (`{ poliza: x }`). Medido: contarlas lleva
//     `src/` de 9 797 a 18 059 y `tests/` de 4 929 a 10 270. No es que haya el
//     doble de deuda: es la MISMA deuda contada otra vez en cada fixture que
//     construye el objeto y en cada llamada que lo pasa. Un carril así sube
//     cuando alguien añade un caso de prueba y baja cuando lo borra, y ninguna
//     de las dos cosas es traducir. La clave se cuenta una vez, donde se
//     DECLARA el tipo que la nombra.
//   · LOS ENLACES DE `import`/`export`. `import { crearPoliza }` no declara
//     `crearPoliza`: lo declaró el archivo de origen, que ya está en este mismo
//     censo. Contarlo aquí convertiría un renombrado en diez.
//   · LAS CLAVES ENTRECOMILLADAS (`{ 'Nombre': v }`, `interface X { 'a-b': T }`).
//     Una cadena no es un identificador —no se puede renombrar sin romper el
//     cable por el que viaja— y la población dice «identificadores».
//   · LOS NOMBRES DE DIRECTORIO. `src/contabilidad/` es español y no se cuenta
//     en el carril de archivos: mover un directorio es otro trabajo, con otro
//     riesgo, y merecerá su propio carril el día que alguien lo abra. Mezclarlo
//     aquí haría que un solo `git mv` moviera un número que mide otra cosa.
//
// LAS EXENCIONES SON DOS Y SÓLO DOS
//
//   1. Dos letras o menos. `fn`, `db`, `mx` no dicen de qué idioma son;
//      señalarlas es ruido, y el ruido es lo que apaga un instrumento.
//   2. `snake_case` en miembros de interfaz —`PropertySignature` y
//      `MethodSignature`, que es donde vive el tipo de una fila—. Son 345 hoy
//      (`emisor_rfc`, `costo_total`, `aprobados_humano`, `dias_con_veredictos`):
//      el estilo de lo que se persiste, y renombrarlos rompe el mapeo con las
//      columnas. La exención se aplica al NODO por su clase, no por dónde esté:
//      235 caen en `interface` con nombre y 110 en tipos de objeto escritos en
//      línea —los que devuelve una consulta—, y son el mismo fenómeno. Un
//      `snake_case` en una variable o en una propiedad de clase NO está exento:
//      ahí no hay columna que proteger.
//
// No hay una tercera. Si alguna palabra tiene que quedarse en español, la
// puerta es `DOMAIN_TERMS` en el léxico —que nace vacía y exige la razón
// escrita al lado—, no una excepción nueva aquí: una excepción por archivo es
// como se llega a dos censos que no se pueden comparar.
//
// ESTE ARCHIVO ESTÁ ESCRITO EN INGLÉS, Y ESO TAMBIÉN ESTÁ MEDIDO
//
// La prosa va en castellano, como toda la casa. Los identificadores, no: una
// primera versión de este módulo se escribió con nombres españoles
// —`declaracionesSenaladas`, `archivosTs`, `porArchivo`— y el propio metro la
// cazó, subiendo `spanish-identifiers-scripts` de 425 a 474. Su prueba iba por
// el mismo camino y aportaba otros 24 a `spanish-identifiers-tests`. Setenta y
// tres de deuda nueva, aportados por el instrumento que viene a medir esa deuda
// y por la prueba que lo verifica. `lexicon.ts` (I1) ya había tomado esta
// decisión y aporta 1; `lane.ts`, 0. Los dos archivos de I2 se reescribieron
// con nombres ingleses —la prosa, los nombres de los casos y los fragmentos de
// ejemplo siguen en castellano, y no cuentan porque viven en cadenas— y hoy
// aportan cero. Un metro que engorda el número que publica no se discute: se
// apaga.
//
// LAS CIFRAS DE HOY, Y EN QUÉ SE APARTAN DE LA INVESTIGACIÓN
//
// Identificadores: src 9 797 · tests 4 929 · scripts 425. Nombres de archivo:
// src 49 · tests 125 · scripts 8. La investigación de 2026-09-06 anotaba
// 8 343 · 4 164 · 361 y 51 · 139 · 12. Los identificadores salen ~1,18 veces
// más altos en LOS TRES ÁRBOLES a la vez (1,174 · 1,184 · 1,177), y esa
// constancia es la que dice que no es el error de un árbol sino una población
// más ancha: aquella medición partía de ocho palabras clave y ésta cubre además
// miembros de interfaz, propiedades y parámetros —la misma diferencia que
// `lexicon.ts` ya deja anotada al explicar sus propias cifras—. Los nombres de
// archivo salen más BAJOS porque el árbol cambió y porque el léxico prefiere
// callar antes que acusar en falso (ver el límite de abajo). La consigna del
// tramo era medir lo que hay y decir cuánto da, no perseguir una cifra: si
// algún día se persigue, se persigue moviendo la población, y eso se discute,
// no se ajusta a escondidas.
//
// Y DOS CARRILES SE MOVIERON MIENTRAS SE ESCRIBÍA ESTO, que es lo mejor que le
// puede pasar a un instrumento el primer día. Los 425 son los catorce
// `scripts/*.ts` que había al empezar el tramo; esa misma tarde aterrizaron en
// `scripts/language/lanes/` los módulos hermanos de I2 —`docs.ts` y `plan.ts`,
// escritos con identificadores españoles— y el carril subió a 425; sus bancos
// de pruebas movieron `tests` de 4 929 a 4 929. Ni una línea de español nueva
// fuera de la propia herramienta. El número no está mal: el árbol creció y el
// metro lo vio, igual que `ux-status` vio pasar sus hojas de 179 a 210 en una
// fusión. Lo que sí dice el salto es dónde está naciendo la deuda nueva de
// `scripts/`, y es en el utillaje del epic que viene a quitarla.
//
// LO QUE ESTE METRO NO VE, medido y no supuesto
//
// Hereda los huecos del léxico, y como el léxico prefiere el falso negativo, el
// número que publica es un SUELO. `eval-clasificador.ts` sale inglés porque
// `clasificador` no está en `SPANISH_ROOTS`, y `build-niif-indice.ts` se salva
// por `indice`, no por `niif`. Al escribir las pruebas aparecieron otros dos
// del mismo tipo: `cancelada` y `cancelar` faltan, aunque `cancela`,
// `cancelacion` y `cancelados` estén —un hueco de conjugación, no de criterio—.
// No se arregla desde aquí —el léxico es de I1 y una lista paralela sería el
// defecto que I1 vino a evitar—: se anota, y la palabra que falte entra allí,
// donde la usan el metro Y el lint.
//
// DETERMINISTA A PROPÓSITO
//
// `fs.readdirSync` no promete orden, así que todo lo que se recorre se ordena
// —y por CÓDIGO DE CARÁCTER, no con `localeCompare`, que depende del ICU de la
// máquina—. Un metro que da dos cifras para el mismo árbol no es un metro: es
// un generador de discusiones sobre si el número subió.
//
// CÓMO SE COMPRUEBA LA CIFRA SIN ESTE METRO
//
// Una línea de `grep` no puede reproducir un recorrido de sintaxis más un
// léxico de mil raíces, y fingir que sí con un comando que da otro número sería
// peor que no ponerlo. Así que el módulo se ejecuta solo y en modo lista:
//
//   npx tsx scripts/language/lanes/code.ts identifiers src | wc -l
//   npx tsx scripts/language/lanes/code.ts filenames tests | wc -l
//
// Eso es lo que va en `command`: no pasa por `language:status` ni por la línea
// base, imprime UNA LÍNEA POR ITEM CONTADO —con archivo y renglón—, y por eso
// el número no sólo se reproduce: se puede auditar item por item, que es lo que
// de verdad hace discutible a un número.
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { Lane, LaneMeter } from '../lane.js';
import { isFlagged } from '../lexicon.js';

/** La raíz del repositorio: este archivo vive en `scripts/language/lanes/`. */
const ROOT = path.resolve(__dirname, '..', '..', '..');

/** Los tres árboles del rector, en el orden en que se publican. */
export const TREES = ['src', 'tests', 'scripts'] as const;
export type Tree = (typeof TREES)[number];

/**
 * Lo que no se recorre. `node_modules` y `dist` no son código de la casa,
 * `coverage` es salida de una herramienta y todo lo que empieza por punto es
 * configuración: contar cualquiera de los cuatro haría que el número se moviera
 * al instalar dependencias o al correr las pruebas.
 */
const IGNORED: ReadonlySet<string> = new Set(['node_modules', 'dist', 'coverage', '.git']);

/** Cuántos ejemplos lleva cada carril. Bastantes para empezar, pocos para leer. */
const EXAMPLE_COUNT = 8;

/** Un identificador señalado, con dónde está para que se pueda ir a buscarlo. */
export interface Flagged {
  /** Ruta desde la raíz del repo, siempre con `/`. */
  file: string;
  /** Renglón 1-indexado, como lo cuenta un editor. */
  line: number;
  name: string;
}

/**
 * Orden por unidad de código. `Array.prototype.sort` sin comparador ordena por
 * UTF-16 y `localeCompare` por la configuración de la máquina; ninguna de las
 * dos es una promesa escrita. Ésta sí.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Los `.ts` de un árbol, en orden estable y con la ruta relativa a la raíz.
 *
 * Se ordena LA LECTURA DEL DIRECTORIO, no sólo el resultado, para que el
 * recorrido —y con él los ejemplos y el orden de `perFile`— sea el mismo en
 * macOS y en el contenedor de CI.
 */
export function tsFiles(tree: Tree): string[] {
  const base = path.join(ROOT, tree);
  // EL CERO QUE PARECE UNA VICTORIA. Los tres árboles son estructura de este
  // repositorio: si uno no está, no es que la deuda se haya pagado — es que el
  // metro está mirando otro sitio (una raíz mal resuelta, un checkout parcial,
  // el módulo copiado a otra carpeta). Devolver una lista vacía publicaría
  // `spanish-identifiers-src = 0`, que es exactamente la meta del carril, y el
  // primer `--apretar` clavaría esa línea base en cero para siempre: a partir
  // de ahí el trinquete es insatisfacible y alguien acaba desactivándolo. Un
  // instrumento que no encuentra lo que mide tiene que callarse ruidosamente.
  if (!fs.existsSync(base)) {
    throw new Error(
      `no existe ${tree}/ bajo ${ROOT}: el carril daría cero sin haber medido nada. ` +
        'Comprueba desde dónde se está ejecutando el metro antes de creerte la cifra.'
    );
  }
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => byCodeUnit(a.name, b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) {
        out.push(path.relative(ROOT, full).split(path.sep).join('/'));
      }
    }
  };
  walk(base);
  return out;
}

/** `saldo_inicial` sí; `saldoInicial` y `SALDO_INICIAL` no. */
function isSnakeCase(name: string): boolean {
  return name.includes('_') && !/[A-Z]/.test(name);
}

/**
 * ¿Se cuenta este nombre? Las dos exenciones escritas, y nada más.
 *
 * `interfaceMember` no mira DÓNDE está el nodo sino QUÉ ES: una firma de
 * propiedad o de método, que es lo único que hay dentro de una interfaz o de un
 * tipo de objeto. Preguntarlo por el nodo y no por el contexto evita el error
 * silencioso de dejar exento, por arrastre, a un parámetro que apareció dentro
 * de un tipo de función.
 */
function isCounted(name: string, interfaceMember: boolean): boolean {
  if (name.length <= 2) return false;
  if (interfaceMember && isSnakeCase(name)) return false;
  return isFlagged(name);
}

/**
 * Los identificadores señalados de UN archivo, recorriendo su sintaxis.
 *
 * Recibe el texto en vez de leerlo para que las pruebas puedan darle un
 * fragmento de tres líneas: un recorredor que sólo se puede ejercitar contra el
 * árbol entero es un recorredor que nadie acota.
 */
export function flaggedDeclarations(code: string, file: string): Flagged[] {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found: Flagged[] = [];

  const record = (name: string, node: ts.Node, interfaceMember: boolean): void => {
    if (!isCounted(name, interfaceMember)) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    found.push({ file, line: line + 1, name });
  };

  /**
   * El nombre de una declaración. Puede ser un identificador, uno privado
   * (`#saldo`, que se cuenta sin la almohadilla porque la almohadilla no es
   * parte del nombre) o un patrón de desestructuración, y ahí sólo cuenta el
   * enlace que se CREA: en `const { poliza: entry } = x` se declara `entry`, y
   * `poliza` es una propiedad del objeto de origen —declarada en su tipo, ya
   * contada allí—.
   */
  const nameOf = (node: ts.Node, interfaceMember: boolean): void => {
    if (ts.isIdentifier(node)) record(node.text, node, interfaceMember);
    else if (ts.isPrivateIdentifier(node)) record(node.text.replace(/^#/, ''), node, interfaceMember);
    else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
      for (const element of node.elements) {
        if (ts.isBindingElement(element)) nameOf(element.name, false);
      }
    }
    // Cualquier otra cosa —una clave entrecomillada, un nombre computado— no es
    // un identificador y queda fuera de la población a propósito.
  };

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) nameOf(node.name, false);
    else if (ts.isParameter(node)) nameOf(node.name, false);
    else if (ts.isFunctionDeclaration(node) && node.name) nameOf(node.name, false);
    else if (ts.isClassDeclaration(node) && node.name) nameOf(node.name, false);
    else if (ts.isInterfaceDeclaration(node)) nameOf(node.name, false);
    else if (ts.isTypeAliasDeclaration(node)) nameOf(node.name, false);
    else if (ts.isEnumDeclaration(node)) nameOf(node.name, false);
    else if (ts.isEnumMember(node)) nameOf(node.name, false);
    else if (ts.isTypeParameterDeclaration(node)) nameOf(node.name, false);
    else if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) nameOf(node.name, false);
    else if (ts.isGetAccessor(node) || ts.isSetAccessor(node)) nameOf(node.name, false);
    else if (ts.isPropertySignature(node) || ts.isMethodSignature(node)) nameOf(node.name, true);
    ts.forEachChild(node, visit);
  };

  visit(source);
  return found;
}

/**
 * ¿El NOMBRE de este archivo es español? Se le quita sólo el `.ts` final y el
 * resto se tokeniza igual que un identificador, guiones incluidos:
 * `poliza-service.ts` cuenta y `bank-service.ts` no.
 *
 * El sufijo `.spec` se deja dentro a propósito. Aporta un token inglés, y como
 * el léxico señala también lo MIXTO —lo medio traducido, que suele ser peor que
 * lo que está entero en un idioma— `poliza.spec.ts` sigue contando. Quitarlo
 * sería una regla más que mantener a cambio de ninguna diferencia medible.
 */
export function hasSpanishFileName(file: string): boolean {
  return isFlagged(path.basename(file).replace(/\.ts$/, ''));
}

/** Los identificadores señalados de un árbol entero, en orden de recorrido. */
export function identifiersIn(tree: Tree): Flagged[] {
  const out: Flagged[] = [];
  for (const file of tsFiles(tree)) {
    out.push(...flaggedDeclarations(fs.readFileSync(path.join(ROOT, file), 'utf8'), file));
  }
  return out;
}

/** Los archivos de un árbol cuyo nombre es español, en orden de recorrido. */
export function filesWithSpanishName(tree: Tree): string[] {
  return tsFiles(tree).filter(hasSpanishFileName);
}

/** Las dos cosas que este módulo sabe listar, y las llaves del CLI. */
export const MODES = ['identifiers', 'filenames'] as const;
export type Mode = (typeof MODES)[number];

/**
 * La lista que hay detrás de un número, una línea por item. Es lo que imprime
 * el CLI y lo que cuenta `wc -l`: el número del carril y esta lista salen de la
 * misma llamada, así que no pueden separarse ni desviarse una del otro.
 */
export function list(mode: Mode, tree: Tree): string[] {
  if (mode === 'identifiers') {
    return identifiersIn(tree).map((hit) => `${hit.file}:${hit.line} ${hit.name}`);
  }
  return filesWithSpanishName(tree);
}

/** El comando que reproduce la cifra sin pasar por el metro. */
function commandFor(mode: Mode, tree: Tree): string {
  return `npx tsx scripts/language/lanes/code.ts ${mode} ${tree} | wc -l`;
}

/**
 * El desglose por archivo. Es lo que hace que la deuda se pueda pagar por
 * tramos: sin él, bajar el total exige tocar el árbol entero a la vez y ningún
 * PR puede demostrar que cerró algo.
 *
 * Sólo entran los archivos con cuenta > 0. Un archivo limpio no es una entrada
 * en cero: es un archivo que ya no está en la lista, y la diferencia importa
 * cuando alguien compara dos líneas base.
 */
function countByFile(files: string[]): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const file of files) tally[file] = (tally[file] ?? 0) + 1;
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(tally).sort(byCodeUnit)) sorted[key] = tally[key];
  return sorted;
}

/**
 * LOS SEIS CARRILES.
 *
 * Tres de identificadores y tres de nombres de archivo, uno por árbol. Los seis
 * miden poblaciones DISJUNTAS —lo que se declara dentro de un archivo y cómo se
 * llama el archivo—, así que la suma no cuenta nada dos veces; y están partidos
 * por árbol porque `src/`, `tests/` y `scripts/` se traducen en tramos
 * distintos del epic y un total único los volvería a atar.
 *
 * Ninguno es `informational`: los seis se pueden bajar hoy renombrando, que es
 * justamente el trabajo del epic. Lo informativo se reserva para lo que se
 * observa y todavía no se puede exigir, y aquí no hay nada así.
 */
export const codeLanes: LaneMeter = () => {
  const lanes: Lane[] = [];

  for (const tree of TREES) {
    const hits = identifiersIn(tree);
    lanes.push({
      id: `spanish-identifiers-${tree}`,
      title: `Spanish identifiers declared under ${tree}/`,
      value: hits.length,
      target: 0,
      command: commandFor('identifiers', tree),
      examples: hits.slice(0, EXAMPLE_COUNT).map((hit) => `${hit.file}:${hit.line} ${hit.name}`),
      perFile: countByFile(hits.map((hit) => hit.file)),
    });
  }

  for (const tree of TREES) {
    const files = filesWithSpanishName(tree);
    lanes.push({
      id: `spanish-filenames-${tree}`,
      // EL TÍTULO DICE «TypeScript» PORQUE LA POBLACIÓN SON LOS `.ts`, Y LA
      // diferencia está medida: bajo `src/` hay 45 archivos MÁS con nombre
      // español que este carril no cuenta —34 `.sql`, 10 `.md`, 1 `.json`—, y
      // bajo `tests/` otros 19 (`.xml` y `.json` de fixture). Casi todos los
      // `.sql` son migraciones, cuyo nombre es su fila en el registro y no se
      // renombra nunca (la misma razón escrita en `isRenameable`, en el módulo
      // del plan). Un título que dijera «Files» mandaría a quien compare con un
      // `find` a buscar la diferencia entre 49 y 94, y la encontraría en deuda
      // que este epic no puede pagar.
      title: `TypeScript files with Spanish names under ${tree}/`,
      value: files.length,
      target: 0,
      command: commandFor('filenames', tree),
      examples: files.slice(0, EXAMPLE_COUNT),
      // Cada archivo cuenta uno —el desglose ES la lista completa de renombrados
      // pendientes—, y por eso el valor es siempre 1: lo que se paga por tramos
      // aquí no es «cuántos quedan dentro» sino «este archivo, o no».
      perFile: countByFile(files),
    });
  }

  return lanes;
};

// ============================================================
// EL MISMO MÓDULO, EN LA TERMINAL
//
// `command` promete un número reproducible fuera del metro; esto es lo que
// cumple la promesa. Imprime la lista y no el total, para que `wc -l` dé la
// cifra Y para que quien dude pueda leer qué se contó.
// ============================================================

function main(args: string[]): number {
  const [mode, tree] = args;
  if (!MODES.includes(mode as Mode) || !TREES.includes(tree as Tree)) {
    process.stderr.write(
      `uso: tsx scripts/language/lanes/code.ts <${MODES.join('|')}> <${TREES.join('|')}>\n`,
    );
    return 2;
  }
  for (const row of list(mode as Mode, tree as Tree)) process.stdout.write(`${row}\n`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
