// @ts-check
//
// ESLint flat config (ESLint 9 + typescript-eslint 8).
//
// This codebase ran without any lint layer until its first pass, so the
// severities below are a deliberate triage rather than a default preset:
//
//   error  -> defect classes that were found and fixed; they now gate CI.
//   warn   -> unsoundness that enters through THIRD-PARTY types (Express's
//             `req.body: any`, fast-xml-parser's `parse(): any`, and rows
//             typed `Record<string, unknown>`). Fixing these means typing the
//             boundaries, not editing the call sites, so they are tracked as
//             visible debt instead of being silenced.
//   off    -> rules that fight a deliberate design decision here. Each one
//             carries the reason; none is disabled just to get to zero.
//
// The warnings are ratcheted, not ignored: package.json runs eslint with a
// `--max-warnings` cap in the `lint` script. THE NUMBER LIVES THERE AND
// NOWHERE ELSE — it used to be copied here and into CONTRIBUTING.md, and the
// three copies drifted to three different figures (1067 here, 1239 there,
// 1117 actually running). A ratchet that states three numbers is not a
// ratchet. CI fails if the real one goes up; lower it as boundaries get
// typed, and never raise it to make a build pass.
//
// Scope is `src/`, `tests/` and `scripts/`, all with type information. src and
// tests get different rule sets because they run under different constraints;
// scripts follows src.
//
// Este archivo lleva además UNA REGLA DE LA CASA, escrita aquí mismo y sin
// paquete npm: `house/english-identifiers`, la puerta del idioma del epic #141.
// Su razón, su población y sus dos exenciones están escritas justo debajo de
// los imports, y no se resumen aquí para que no haya dos versiones del mismo
// criterio.

import fs from 'node:fs';
import path from 'node:path';

import globals from 'globals';
import tseslint from 'typescript-eslint';

// ============================================================
// LA PUERTA DEL IDIOMA: `house/english-identifiers` (I3 · issue #145)
//
// El epic #141 traduce el código al inglés en veintisiete tramos. I2 puso el
// metro (`npm run language:status`) y sabe que hoy quedan 15 151 identificadores
// españoles declarados. Esta regla es la PUERTA: el metro documenta una marea,
// y sin puerta la marea sube por un lado mientras se achica por el otro.
//
// UNA SOLA POBLACIÓN Y UN SOLO LÉXICO, Y POR ESO ESTO ESTÁ AQUÍ ESCRITO DOS VECES
//
// El metro cuenta con `scripts/language/lexicon.ts` y `scripts/language/lanes/
// code.ts`. Este archivo es ESM plano y no puede importar TypeScript: no hay
// `allowJs`, no hay paso de compilación para el lint y ESLint carga su
// configuración con el Node de siempre. La salida no es que cada lado traiga su
// lista —eso da dos números y ninguna forma de saber cuál miente—, sino partir
// DATO de LÓGICA:
//
//   · el DATO —las cuatro listas— vive en `scripts/language/lexicon.json`, y lo
//     leen los dos mundos. Una palabra nueva entra una vez y la ven los dos.
//   · la LÓGICA —`tokenize`/`classify`, cincuenta y dos líneas de código— sí está duplicada,
//     aquí en JavaScript y allí en TypeScript. Es el precio del cruce, y lo que
//     impide que las dos versiones se separen no es el cuidado de nadie: es la
//     prueba de conformidad que las corre a las dos sobre el mismo corpus.
//
// El recorrido también está duplicado, y ahí el riesgo es otro: `code.ts` anda
// el árbol del compilador de TypeScript y esta regla anda el AST de ESLint, que
// son dos formas distintas del mismo programa. La equivalencia no se argumenta,
// se comprueba: los dos recorridos se han corrido sobre `src/`, `tests/` y
// `scripts/` —15 151 identificadores— y coinciden uno a uno, archivo y renglón.
// Donde los dos árboles no se parecen en nada está anotado abajo, en el
// recorrido, porque es donde se romperá el día que alguien toque uno de los dos.
//
// LA LÍNEA BASE ES POR ARCHIVO, Y SIN ENTRADA ES CERO
//
// En error sobre un árbol con 15 151 identificadores españoles, la regla dejaría
// CI en rojo para siempre y alguien acabaría bajándole la severidad — que es la
// forma habitual en que una puerta se convierte en un adorno. Así que la línea
// base los absorbe: `docs/language-baseline.json`, sección `perFile`, carriles
// `spanish-identifiers-src|tests|scripts`. Es el MISMO archivo que el trinquete
// del metro, no una copia: si fueran dos, la primera vez que `--tighten` bajara
// uno el otro seguiría perdonando lo que ya se ganó.
//
// SIN ENTRADA = 0. Un archivo nuevo no tiene derecho a español, y ése es el
// punto entero del tramo: la deuda vieja se paga por tramos, la nueva no nace.
//
// QUÉ SE INFORMA CUANDO UN ARCHIVO SE PASA, QUE ES LA DECISIÓN FINA DE AQUÍ
//
// Un archivo con línea base 12 que hoy tiene 13 excede en uno. Señalar «el
// decimotercero» sería inventarse un culpable: la línea base es UN NÚMERO, no
// la lista de los doce perdonados, así que ningún identificador concreto es
// demostrablemente el que sobra. Se informa entonces a la resolución más fina
// que se puede demostrar, y son dos:
//
//   · LÍNEA BASE 0 → un error POR IDENTIFICADOR, sobre su propio nodo. Aquí no
//     hay ambigüedad: si no hay nada perdonado, cada uno de ellos sobra, y el
//     aviso cae exactamente encima de la palabra que hay que renombrar.
//   · LÍNEA BASE > 0 y hoy más → UN error, del ARCHIVO, en su primer renglón.
//     Dice cuántos hay, cuántos se perdonan y cuántos sobran. No apunta a una
//     palabra porque no sabe cuál es, y fingir que lo sabe mandaría a renombrar
//     una que quizá lleva ahí dos años.
//
// Por debajo de la línea base no hay error: eso es holgura ganada, y quien la
// baja es `npm run language:status -- --tighten`, en un commit que se ve.
//
// LA EXENCIÓN ESCRITA
//
// `// language-allow: <razón>` en la línea de ARRIBA exime ese identificador.
// La razón es obligatoria: una exención sin motivo es una excepción sin dueño, y
// un `language-allow:` pelado no exime nada —el identificador sigue contando—.
// La regla sólo puede comprobar que hay algo escrito; que sea una razón lo
// comprueba quien lea el diff. Se quedan detectables con un `grep -rn
// 'language-allow:'`, que es como el metro las contará.
//
// La marca es de LÍNEA, no de nombre, porque el formato no lleva a quién exime:
// eso significa que exime TODO lo que se declare en la línea de abajo — en
// `function calcularSaldo(montoInicial)` son dos. Se dice aquí porque es la
// forma de exentar de más sin darse cuenta; si un día hace falta apuntar a uno,
// el cambio es del formato, no de la regla.
//
// Y la exención resta del recuento del archivo, no de su cupo: un archivo con
// línea base 12 que exime uno pasa a valer 11, y esa holgura la recoge
// `--tighten`. La marca no es una forma de subir el cupo por la puerta de atrás.
// ============================================================

/** La raíz del repositorio: este archivo vive en ella. */
const HOUSE_ROOT = import.meta.dirname;

/**
 * Un JSON de la casa, o un fallo ruidoso.
 *
 * Sin léxico o sin línea base esta regla no es una versión suave de sí misma:
 * es otra regla. Sin línea base, además, todo archivo valdría 0 y el árbol
 * entero saldría en rojo — ruidoso, sí, pero ilegible. Se para aquí, con el
 * nombre del archivo que falta, que es lo único accionable.
 */
function readHouseJson(relativePath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOUSE_ROOT, relativePath), 'utf8'));
  } catch (cause) {
    throw new Error(
      `house/english-identifiers no pudo leer ${relativePath}. Sin ese archivo la regla no ` +
        'tiene ni léxico ni línea base; comprueba desde dónde se ejecuta ESLint antes de ' +
        'tocarle la severidad.',
      { cause },
    );
  }
}

const LEXICON = readHouseJson('scripts/language/lexicon.json');
const BASELINE = readHouseJson('docs/language-baseline.json');

/**
 * UNA LISTA QUE FALTA NO ES UNA LISTA VACÍA. `new Set(undefined)` devuelve un
 * conjunto vacío sin quejarse, y con `spanishRoots` ausente esta regla daría
 * todo por inglés: cero errores, para siempre, sin haber mirado nada. Una
 * puerta que se abre sola cuando su dato se rompe es peor que no tenerla, así
 * que se para aquí. El gemelo de `lexicon.ts` hace la misma comprobación.
 */
function listFrom(key) {
  const list = LEXICON[key];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(
      `lexicon.json no trae '${key}' o la trae vacía: sin esa lista house/english-identifiers ` +
        'daría todo por inglés y no señalaría nada, en verde y sin haber mirado.',
    );
  }
  return new Set(list);
}

const SPANISH_ROOTS = listFrom('spanishRoots');
const NEUTRAL_TOKENS = listFrom('neutralTokens');
const ENGLISH_EXTRA = listFrom('englishExtra');
const DOMAIN_TERMS = new Map(Object.entries(LEXICON.domainTerms ?? {}));

/**
 * EL GEMELO DE `plegarDiacriticos`. `tamaño` → `tamano`, `año` → `ano`.
 *
 * No es cosmética: las listas están escritas PLEGADAS —`tamano`, no `tamaño`—,
 * así que sin este paso esas raíces son inalcanzables para el cotejo. La
 * pérdida está acotada a la COMPARACIÓN; el token que se enseña es el que el
 * código escribió.
 */
function foldDiacritics(token) {
  return token.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * EL GEMELO DE `tokenize` DE `scripts/language/lexicon.ts`.
 *
 * Parte un identificador en tokens: camelCase, PascalCase, snake_case,
 * SCREAMING_CASE, kebab-case y las fronteras con dígitos. Todo a minúsculas y
 * con los acentos plegados. `RFCValido` da ['rfc', 'valido'] por la regla de la
 * sigla seguida de palabra.
 *
 * EL PARTIDOR ES UNICODE (#197), y llegó por `main` mientras esta rama estaba
 * fuera. Con `[^A-Za-z0-9]+` una `ñ` o una vocal acentuada eran SEPARADOR:
 * `pequeño` daba ['peque','o'] y se contaba como INGLÉS. El sesgo no era
 * neutro —convertía en inglesas justo las palabras más españolas—, así que el
 * gemelo tenía que traerlo o las dos mitades del cruce publicarían otra vez
 * dos números distintos, que es lo único que este archivo existe para impedir.
 *
 * Lo único que se aparta del gemelo son los nombres locales —allí
 * `conEspacios`, de I1, y `plegarDiacriticos`/`partirEnDigitos`, que llegaron
 * con #197 por `main`; los tres cuentan en la línea base de su archivo y ahí se
 * quedan hasta que el epic los renombre—: lo que I3 escribe va en inglés,
 * empezando por su propio guardián.
 */
export function tokenize(identifier) {
  const withSpaces = identifier
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2');
  return withSpaces
    .split(/[^\p{L}\p{N}]+|\s+/u)
    .filter((t) => t.length > 0)
    .map((t) => foldDiacritics(t.toLowerCase()))
    .flatMap(splitOnDigits);
}

/**
 * EL GEMELO DE `partirEnDigitos`. La frontera letra↔dígito, PERO SÓLO EN LO
 * QUE EL LÉXICO NO RECONOCE: `sha256` es un neutro curado y partirlo deja
 * `sha`, que no está en ninguna lista y se daría por inglés. Así que primero
 * se pregunta por el token entero; si no lo conoce, se parte, y ahí aparece lo
 * que el corte venía a rescatar —`tasa99` da ['tasa','99']—.
 */
function splitOnDigits(token) {
  if (!/\p{L}/u.test(token) || !/\p{N}/u.test(token)) return [token];
  if (SPANISH_ROOTS.has(token) || NEUTRAL_TOKENS.has(token) || ENGLISH_EXTRA.has(token)) {
    return [token];
  }
  return token
    .replace(/(\p{L})(\p{N})/gu, '$1 $2')
    .replace(/(\p{N})(\p{L})/gu, '$1 $2')
    .split(' ')
    .filter((t) => t.length > 0);
}

/**
 * EL GEMELO DE `classifyToken`. Precedencia estricta: español gana a neutro y
 * neutro gana a inglés, porque `estado` está en el diccionario inglés y aquí es
 * español. Dos letras o menos no dicen de qué idioma son.
 */
export function classifyToken(token) {
  if (SPANISH_ROOTS.has(token)) return 'es';
  if (NEUTRAL_TOKENS.has(token)) return 'neutral';
  if (ENGLISH_EXTRA.has(token)) return 'en';
  if (/^[0-9]+$/.test(token)) return 'neutral';
  if (token.length <= 2) return 'neutral';
  return 'en';
}

/**
 * EL GEMELO DE `classify`. ≥1 español y 0 inglés → es · ≥1 inglés y 0 español →
 * en · los dos → mixed · sólo neutros → neutral.
 */
export function classify(identifier) {
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

/** EL GEMELO DE `isFlagged`. Español entero o a medias, las dos cosas. */
export function isFlagged(identifier) {
  const c = classify(identifier);
  return c === 'es' || c === 'mixed';
}

/** `saldo_inicial` sí; `saldoInicial` y `SALDO_INICIAL` no. */
function isSnakeCase(name) {
  return name.includes('_') && !/[A-Z]/.test(name);
}

/**
 * LAS DOS EXENCIONES, Y NO HAY UNA TERCERA. Dos letras o menos, y `snake_case`
 * en miembro de interfaz —donde vive el tipo de una fila, y renombrarlo rompe el
 * mapeo con la columna—. Un `snake_case` en una variable o en una propiedad de
 * clase SÍ cuenta: ahí no hay columna que proteger.
 */
function isCounted(name, interfaceMember) {
  if (name.length <= 2) return false;
  if (interfaceMember && isSnakeCase(name)) return false;
  return isFlagged(name);
}

/**
 * LOS IDENTIFICADORES SEÑALADOS DE UN ARCHIVO, sobre el AST de ESLint.
 *
 * Es el gemelo de `flaggedDeclarations` de `scripts/language/lanes/code.ts`, y
 * la población es la misma: el identificador EN POSICIÓN DE DECLARACIÓN.
 * Fuera quedan, a propósito, las claves de objeto literal, las cadenas, los
 * comentarios y los especificadores de `import` —un nombre importado ya se
 * cuenta donde se declara, y contarlo aquí convertiría un renombrado en diez—.
 *
 * DONDE LOS DOS ÁRBOLES NO SE PARECEN, que es donde esto se romperá:
 *
 *   · `catch (e)`. TypeScript mete ahí una `VariableDeclaration`; ESLint pone
 *     `CatchClause.param`, que no es un declarador de nada. Sin este caso el
 *     lint perdonaría los `catch (errorFatal)` que el metro sí cuenta.
 *   · LOS PARÁMETROS no cuelgan de un tipo de nodo sino de un campo: los tiene
 *     la función, la firma de método de una interfaz, el tipo de función escrito
 *     en línea y el constructor. Se recogen por el campo `params` esté donde
 *     esté —igual que `ts.isParameter` no mira el contexto—, más `parameters` de
 *     la firma de índice, que es el mismo fenómeno con otro nombre.
 *   · LAS CLAVES COMPUTADAS (`{ [CLAVE]: v }`, `class X { [clave] = 1 }`). En
 *     TypeScript son un `ComputedPropertyName` y no un identificador, así que el
 *     metro no las ve; en el AST de ESLint el nodo SÍ es un `Identifier` y hay
 *     que descartarlo por `computed`. Si no, el lint acusaría una REFERENCIA a
 *     una constante declarada —y ya contada— en otro sitio.
 *   · EL MIEMBRO DE OBJETO LITERAL. `{ poliza: x }` no cuenta —se cuenta donde
 *     se declara el tipo que la nombra—, pero `{ poliza() {} }` y `{ get poliza()
 *     {} }` sí: para TypeScript son un método y un accesor, no una asignación de
 *     propiedad. La asimetría es de allí y se copia tal cual.
 *   · `class Foo` cuenta y `const F = class Foo {}` no: `ts.isClassDeclaration`
 *     deja fuera la expresión de clase, así que aquí también.
 *
 * Se exporta —como `tokenize`, `classify` e `isFlagged`— porque la prueba de
 * conformidad tiene que poder llamar a este lado sin pasar por ESLint: si sólo
 * se pudiera ejercitar a través de la regla, comparar los dos recorridos
 * exigiría leer mensajes de error, y entonces nadie los compararía.
 */
export function flaggedDeclarations(sourceCode) {
  const found = [];

  const record = (name, node, interfaceMember) => {
    if (!isCounted(name, interfaceMember)) return;
    found.push({ name, node });
  };

  /**
   * El nombre de una declaración: un identificador, uno privado (`#saldo`, sin
   * la almohadilla porque no es parte del nombre) o un patrón de
   * desestructuración, donde sólo cuenta el enlace que se CREA — en
   * `const { poliza: entry } = x` se declara `entry`, y `poliza` es una
   * propiedad del objeto de origen, contada en su tipo.
   */
  const nameOf = (node, interfaceMember) => {
    if (!node) return;
    switch (node.type) {
      case 'Identifier':
      case 'PrivateIdentifier':
        record(node.name, node, interfaceMember);
        break;
      case 'ObjectPattern':
        for (const property of node.properties) {
          if (property.type === 'Property') nameOf(property.value, false);
          else nameOf(property.argument, false);
        }
        break;
      case 'ArrayPattern':
        for (const element of node.elements) nameOf(element, false);
        break;
      case 'AssignmentPattern':
        nameOf(node.left, false);
        break;
      case 'RestElement':
        nameOf(node.argument, false);
        break;
      case 'TSParameterProperty':
        nameOf(node.parameter, false);
        break;
      default:
        // Una clave entrecomillada o un nombre computado no es un identificador
        // y queda fuera de la población a propósito.
        break;
    }
  };

  const visit = (node) => {
    switch (node.type) {
      case 'VariableDeclarator':
        nameOf(node.id, false);
        break;
      case 'CatchClause':
        nameOf(node.param, false);
        break;
      case 'FunctionDeclaration':
      case 'TSDeclareFunction':
      case 'ClassDeclaration':
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSEnumDeclaration':
        nameOf(node.id, false);
        break;
      case 'TSEnumMember':
        if (!node.computed) nameOf(node.id, false);
        break;
      case 'TSTypeParameter':
        nameOf(node.name, false);
        break;
      // EL TIPO MAPEADO, `{ [Llave in keyof T]: ... }`. Para TypeScript su
      // llave es un `TypeParameterDeclaration` como cualquier otro; el AST de
      // ESLint la saca aparte, en `key`. Sin este caso el metro contaba una
      // declaración que el lint no veía —el único desacuerdo que quedaba entre
      // los dos recorridos, y lo destapó un fixture, no la lectura—. Se dejan
      // los dos casos porque son excluyentes: la forma que no exista devuelve
      // `undefined` y `nameOf` se calla.
      case 'TSMappedType':
        nameOf(node.key, false);
        break;
      case 'MethodDefinition':
      case 'PropertyDefinition':
      case 'AccessorProperty':
      case 'TSAbstractMethodDefinition':
      case 'TSAbstractPropertyDefinition':
      case 'TSAbstractAccessorProperty':
        if (!node.computed) nameOf(node.key, false);
        break;
      case 'Property':
        if (!node.computed && (node.method || node.kind === 'get' || node.kind === 'set')) {
          nameOf(node.key, false);
        }
        break;
      case 'TSPropertySignature':
      case 'TSMethodSignature':
        if (!node.computed) nameOf(node.key, true);
        break;
      case 'TSIndexSignature':
        for (const parameter of node.parameters) nameOf(parameter, false);
        break;
      default:
        break;
    }
    if (Array.isArray(node.params)) {
      for (const parameter of node.params) nameOf(parameter, false);
    }
  };

  for (const node of nodesOf(sourceCode)) visit(node);
  return found;
}

/**
 * Cada nodo del árbol, una vez, EN EL MISMO ORDEN EN QUE LOS VISITA UN LINT.
 *
 * `sourceCode.traverse()` es el recorrido propio de ESLint —el que alimenta a
 * los selectores de cualquier regla—, así que usa las claves de visita del
 * parser y no una lista escrita a mano aquí. Un tipo de nodo nuevo de
 * TypeScript entra solo; escribir el recorrido a mano habría dejado ese caso
 * cayéndose en silencio, que es la forma en que un lint deja de ver cosas sin
 * que nadie se entere. `phase: 1` es la entrada al nodo: sin filtrarla, cada
 * nodo se visitaría dos veces y todo contaría el doble.
 */
function* nodesOf(sourceCode) {
  for (const step of sourceCode.traverse()) {
    if (step.type === 'visit' && step.phase === 1) yield step.target;
  }
}

/**
 * Las líneas exentas por una razón escrita. `// language-allow: <razón>` exime
 * el identificador de la línea SIGUIENTE; un `language-allow:` sin nada detrás
 * no exime a nadie y el identificador sigue contando, que es lo que convierte la
 * razón en obligatoria de verdad y no sólo en costumbre.
 */
function linesAllowedBelow(sourceCode) {
  const allowed = new Set();
  for (const comment of sourceCode.getAllComments()) {
    const text = comment.value.trim();
    if (!text.startsWith('language-allow:')) continue;
    if (text.slice('language-allow:'.length).trim().length === 0) continue;
    allowed.add(comment.loc.end.line);
  }
  return allowed;
}

/** La ruta con la que el metro nombra un archivo: relativa a la raíz y con `/`. */
function housePath(filename) {
  const relative = path.isAbsolute(filename) ? path.relative(HOUSE_ROOT, filename) : filename;
  return relative.split(path.sep).join('/');
}

/**
 * Lo que este archivo tiene perdonado. Sin entrada, cero — y eso no es un vacío
 * que rellenar: es la regla del tramo escrita como dato.
 */
function baselineFor(housePathOfFile) {
  const tree = housePathOfFile.split('/')[0];
  const lane = BASELINE.perFile?.[`spanish-identifiers-${tree}`] ?? {};
  return lane[housePathOfFile] ?? 0;
}

/** @type {import('eslint').Rule.RuleModule} */
export const englishIdentifiersRule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Ningún identificador español nuevo: por archivo, contra la línea base de docs/language-baseline.json',
    },
    schema: [],
    messages: {
      // El archivo no tiene nada perdonado, así que cada uno sobra y el aviso
      // cae encima de la palabra exacta.
      bornInSpanish:
        '«{{name}}» está en español y {{file}} no tiene línea base: aquí nada nuevo nace en ' +
        'español. Renómbralo en inglés, o escribe encima `// language-allow: <razón>`.',
      // El archivo excede; cuál sobra no se sabe y no se finge.
      overBaseline:
        '{{file}} declara {{count}} identificadores en español y tiene {{baseline}} en la línea ' +
        'base: {{excess}} de más. El aviso es del archivo entero porque la línea base es un ' +
        'número y no una lista — renombra en inglés lo que acabas de añadir. Los ves con: ' +
        '{{command}}',
    },
  },

  create(context) {
    const sourceCode = context.sourceCode;
    const file = housePath(context.filename);

    return {
      'Program:exit'() {
        const allowed = linesAllowedBelow(sourceCode);
        const flagged = flaggedDeclarations(sourceCode).filter(
          (hit) => !allowed.has(hit.node.loc.start.line - 1),
        );
        const baseline = baselineFor(file);
        if (flagged.length <= baseline) return;

        if (baseline === 0) {
          for (const hit of flagged) {
            context.report({
              node: hit.node,
              messageId: 'bornInSpanish',
              data: { name: hit.name, file },
            });
          }
          return;
        }

        const tree = file.split('/')[0];
        context.report({
          loc: { line: 1, column: 0 },
          messageId: 'overBaseline',
          data: {
            file,
            count: String(flagged.length),
            baseline: String(baseline),
            excess: String(flagged.length - baseline),
            command: `npx tsx scripts/language/lanes/code.ts identifiers ${tree} | grep ${file}`,
          },
        });
      },
    };
  },
};

export default tseslint.config(
  {
    name: 'accounting-core/ignores',
    ignores: ['dist/**', 'coverage/**', 'node_modules/**'],
  },

  // Type-aware recommended set: the rules that need the type checker
  // (no-floating-promises, no-misused-promises) are the ones that found the
  // real bugs here, so the cheaper untyped preset would not have been enough.
  ...tseslint.configs.recommendedTypeChecked,

  {
    name: 'accounting-core/typed',
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.node },
      parserOptions: {
        // tsconfig.test.json rather than tsconfig.json: it extends the latter
        // and adds tests/ and scripts/, so it is the one project covering
        // everything the type-aware rules are pointed at. tsconfig.json stays
        // src-only because it is the build, and scripts must not reach dist/.
        project: ['./tsconfig.test.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // The four pre-existing `eslint-disable-next-line no-explicit-any`
      // comments in src/ai are real and load-bearing. This makes sure a
      // disable comment that stops being needed is reported instead of rotting.
      reportUnusedDisableDirectives: 'error',
    },
  },

  {
    name: 'accounting-core/src',
    files: ['src/**/*.ts'],
    rules: {
      // ── error: fixed, and kept fixed ───────────────────────────────────

      // Underscore prefix is this codebase's existing convention for a
      // parameter that exists only to satisfy a signature (errorHandler's
      // `_next`, ledger-tools' `_id`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // `declare global { namespace Express { ... } }` in the auth middleware
      // is the only supported way to augment Express's Request type. The rule
      // is about authoring new namespaces, not about module augmentation.
      '@typescript-eslint/no-namespace': ['error', { allowDeclarations: true }],

      // ── warn: unsoundness owned by third-party types ───────────────────
      //
      // Express 4 types `Request.body` as `any` and fast-xml-parser returns
      // `any`, so every route body read and every parsed CFDI node is unsafe
      // by construction. The fix is to parse at the boundary (the repo's own
      // `validateBody` zod helper already does this on some routes) and to
      // give xml-ingestion real result types. Until then these stay visible.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',

      // Same root cause seen from the string side: `Record<string, unknown>`
      // row fields become `{}` under `??`, which is not provably stringable.
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',

      // ── off: rules that contradict a deliberate design here ────────────

      // The system is built on Promise-returning interfaces whose
      // implementations are sometimes synchronous on purpose: the local-dev
      // vault, the PAC adapters' unsupported `getRemainingStamps`, and the
      // Validator hierarchy in services/accounting/validation.ts. Dropping
      // `async` there would break the interface; `Promise.resolve()` wrappers
      // would only obscure it.
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    // Tests get the same type-aware analysis as src, minus the rules that
    // fight what a test is allowed to do. Note that no-floating-promises and
    // no-misused-promises stay ON here: a test that forgets to await is a test
    // that passes for the wrong reason.
    name: 'accounting-core/tests',
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],

      // La aserción "innecesaria" que sí hace falta.
      //
      // Con el arnés de dobles, `vi.hoisted(() => ({ arnes: { actual: null } }))`
      // infiere `{ actual: null }`, y sin el `as { actual: ClienteFalso | null }`
      // ninguna asignación posterior compila. ESLint, con su propia vista de
      // tipos, cree que la aserción sobra; `tsc -p tsconfig.test.json` dice lo
      // contrario, y es la autoridad: aplicar el --fix de esta regla rompió
      // literalmente el typecheck de tests/accounting/posting-sod.spec.ts.
      // Se apaga en tests, no en src, porque es el arnés lo que la provoca.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',

      // Same third-party/`any` boundary as src, plus the fake pg client in
      // tests/helpers/fake-pg.ts, which is deliberately loosely typed so one
      // helper can stand in for every query shape.
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',

      // `expect(obj.method).toHaveBeenCalled()` is the normal vitest assertion
      // form and is exactly what this rule flags. There is no vitest plugin
      // installed to supply the assertion-aware version, so it is off here and
      // stays on in src.
      '@typescript-eslint/unbound-method': 'off',

      // Tests must be able to simulate what a real SDK throws. failover.spec.ts
      // throws bare objects like `{ status: 429 }` on purpose, because the
      // failover code under test has to survive non-Error rejections.
      '@typescript-eslint/only-throw-error': 'off',

      // Test doubles are the one place `any` earns its keep: a stub only needs
      // to satisfy the call site, not the whole interface.
      '@typescript-eslint/no-explicit-any': 'off',

      // Off for a different reason than in src: spec files declare `async` on
      // every `it(...)` for consistency within a file, whether or not that
      // particular case awaits anything. An async test with no await is not a
      // defect, and no-floating-promises still catches a forgotten await.
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    // scripts/ runs under the same compiler settings as src (CommonJS, NodeNext)
    // and is covered by tsconfig.test.json, so it gets the same type-aware
    // treatment. This matters most for reclasificar-iva-ppd.ts, which rewrites
    // already-posted IVA: no-floating-promises is exactly the rule you want
    // pointed at a script that mutates the ledger.
    name: 'accounting-core/scripts',
    files: ['scripts/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-base-to-string': 'warn',
      '@typescript-eslint/restrict-template-expressions': 'warn',
      '@typescript-eslint/require-await': 'off',
    },
  },

  {
    // LA PUERTA DEL IDIOMA, EN ERROR SOBRE LOS TRES ÁRBOLES.
    //
    // En error y no en aviso, y no es una preferencia: los avisos de este
    // archivo tienen un tope (`--max-warnings`) que se comparte entre todos, así
    // que un carril que hoy vale 15 151 se comería el tope entero y taparía la
    // deuda de tipos que ese tope vigila. Y sobre todo: lo que esta regla
    // señala no es deuda heredada —de ésa no dice nada, la absorbe la línea
    // base por archivo— sino ESPAÑOL NUEVO, que es exactamente lo que no debe
    // entrar. Un error que nadie puede evitar se acaba apagando; éste se evita
    // escribiendo el nombre en inglés.
    //
    // Los tres árboles a la vez porque la población del metro son los tres: si
    // la puerta cubriera menos, el número que el metro publica y el que el lint
    // defiende dejarían de ser el mismo, que es el defecto que I1, I2 y I3
    // vienen esquivando desde el principio.
    name: 'accounting-core/language',
    files: ['src/**/*.ts', 'tests/**/*.ts', 'scripts/**/*.ts'],
    plugins: { house: { rules: { 'english-identifiers': englishIdentifiersRule } } },
    rules: { 'house/english-identifiers': 'error' },
  },
);
