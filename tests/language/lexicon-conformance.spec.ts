import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';
import ts from 'typescript';
import { Linter, type Rule, type SourceCode } from 'eslint';
import { parser } from 'typescript-eslint';

import {
  DOMAIN_TERMS,
  ENGLISH_EXTRA,
  NEUTRAL_TOKENS,
  SPANISH_ROOTS,
  classify as meterClassify,
  isFlagged as meterIsFlagged,
  tokenize as meterTokenize,
  type IdentifierClass,
} from '../../scripts/language/lexicon.js';
import {
  TREES,
  flaggedDeclarations as meterFlaggedDeclarations,
  identifiersIn,
  tsFiles,
} from '../../scripts/language/lanes/code.js';

// ============================================================
// LA PRUEBA DE CONFORMIDAD DE LOS DOS LÉXICOS (I3 · issue #145)
//
// `tokenize`/`classify` está escrito DOS VECES y a propósito: en TypeScript,
// dentro de `scripts/language/lexicon.ts`, que es de donde bebe el metro; y en
// JavaScript, dentro de `eslint.config.mjs`, que es de donde bebe la puerta.
// El duplicado no es un descuido —ESLint carga su configuración con el Node de
// siempre y no puede importar TypeScript— sino el precio del cruce de mundos.
//
// LO QUE SE ROMPE SI SE SEPARAN, que es por lo que este archivo existe. El
// rector del epic promete UNA SOLA POBLACIÓN Y UN SOLO LÉXICO. El día que las
// dos versiones difieran en una línea, el metro y la puerta contarán cosas
// distintas: el metro publicará que quedan N identificadores españoles y la
// puerta dejará entrar —o acusará— otros. Ninguna de las dos alarmas sonará,
// porque cada una seguirá siendo coherente consigo misma. La promesa será
// falsa y nada lo dirá. Eso es exactamente lo que esta prueba impide.
//
// EL DATO NO SE COMPRUEBA AQUÍ, y conviene decirlo para que nadie lo busque:
// las cuatro listas viven en `scripts/language/lexicon.json` y las leen los dos
// mundos, así que no pueden divergir. Lo que sí puede es la LÓGICA, y es lo
// único que se mide abajo.
//
// LOS IDENTIFICADORES DE ESTE ARCHIVO VAN EN INGLÉS. Nace sin línea base, así
// que su cupo de español es cero y la puerta que verifica es la primera que lo
// mira. Todo el español de aquí vive dentro de comentarios y de cadenas, y ni
// unos ni otras son población.
// ============================================================

/** La raíz del repositorio: esta prueba vive en `tests/language/`. */
const ROOT = path.join(__dirname, '..', '..');

// ============================================================
// EL GEMELO DE LA PUERTA, PEDIDO POR SU URL
//
// `eslint.config.mjs` es ESM y esta prueba compila a CommonJS, así que un
// `import` estático no pasaría el `tsc` del proyecto. Un `import()` dinámico
// con la URL del archivo sí: Node lo carga como el módulo ESM que es, y
// TypeScript no intenta resolver un especificador que no es literal.
//
// Se importa el archivo de configuración ENTERO, no una copia de sus treinta
// líneas: si alguien edita la regla, esta prueba lee lo editado. Ésa es la
// diferencia entre verificar la puerta y verificar un recuerdo de la puerta.
// ============================================================

/** Lo que esta prueba necesita del otro lado. Nada más, y todo obligatorio. */
interface LexiconTwin {
  tokenize(identifier: string): string[];
  classify(identifier: string): IdentifierClass;
  isFlagged(identifier: string): boolean;
  /** Lleva dentro las dos exenciones, que son la otra mitad del criterio duplicado. */
  flaggedDeclarations(sourceCode: SourceCode): { name: string }[];
}

/**
 * EL FALLO SILENCIOSO QUE ESTA FUNCIÓN EVITA. Si el módulo dejara de exportar
 * `tokenize` —renombrado, movido a un paquete, dejado de exportar al limpiar—,
 * un `mod.tokenize?.(x)` daría `undefined` en los dos lados de cada comparación
 * y TODAS coincidirían. La prueba quedaría verde, para siempre, sin haber
 * comparado nada. Así que aquí se exige que las tres sean funciones antes de
 * dejar que se ejecute una sola comparación.
 */
async function loadGateTwin(): Promise<LexiconTwin> {
  const moduleUrl = pathToFileURL(path.join(ROOT, 'eslint.config.mjs')).href;
  const exported = (await import(moduleUrl)) as Partial<Record<keyof LexiconTwin, unknown>>;
  for (const key of ['tokenize', 'classify', 'isFlagged', 'flaggedDeclarations'] as const) {
    if (typeof exported[key] !== 'function') {
      throw new Error(
        `eslint.config.mjs ya no exporta '${key}'. Sin esa exportación la conformidad ` +
          'compararía undefined contra undefined y saldría verde sin haber mirado: la ' +
          'puerta y el metro podrían separarse sin que nada lo dijera. Si la regla se ' +
          'mudó de archivo, múdese también esta prueba.',
      );
    }
  }
  return exported as unknown as LexiconTwin;
}

// ============================================================
// EL CORPUS, Y POR QUÉ SON ÉSTOS Y NO OTROS
//
// Tres fuentes, cada una tapando lo que a las otras se les escapa:
//
//  1. LA POBLACIÓN. Todos los identificadores EN POSICIÓN DE DECLARACIÓN de
//     `src/`, `tests/` y `scripts/`: hoy 57 117 apariciones sobre 741 archivos,
//     13 433 nombres distintos. Las cifras se mueven con el árbol y por eso no
//     se afirman en ninguna aserción, sólo los pisos de más abajo.
//     Es literalmente lo que el metro cuenta y lo que la puerta juzga, así que
//     una divergencia sobre este conjunto es una divergencia que ya está
//     ocurriendo hoy en el repositorio, no una hipotética.
//  2. TODOS LOS DEMÁS IDENTIFICADORES del árbol sintáctico: referencias, tipos,
//     claves, importaciones. No son población, pero son cadenas reales que
//     mañana pueden serlo —renombrar mueve un nombre de referencia a
//     declaración— y salen del mismo recorrido, así que son gratis.
//  3. EL LÉXICO ENTERO, palabra a palabra y en cinco formas cada una (cruda,
//     SCREAMING, camelCase, snake_case y pegada a una sigla). Ésta es la que
//     ataca la PRECEDENCIA: las 1 876 raíces españolas se comprueban una por
//     una contra las 579 neutras y las 166 inglesas. Un corpus de código real
//     ejercita las palabras frecuentes; éste ejercita las 2 621.
//
// SE COMPARAN LOS DISTINTOS, NO LAS APARICIONES, y es suficiente: `tokenize` y
// `classify` son funciones puras de la cadena —no miran archivo, ni renglón, ni
// nada más—, así que la aparición número 300 de `saldo` no puede contestar
// distinto de la primera. Las apariciones se cuentan igualmente, abajo, porque
// su número es el que dice que el recorrido no se ha encogido.
// ============================================================

/** Lo que el recorrido saca de los tres árboles, ya separado por procedencia. */
interface Corpus {
  /** Nombres declarados, con repeticiones: el tamaño de la población. */
  declarationOccurrences: number;
  /** Nombres declarados, distintos. */
  declared: ReadonlySet<string>;
  /** Todos los identificadores del AST, distintos, declaraciones incluidas. */
  everything: ReadonlySet<string>;
  /** `archivo -> nombres declarados`, para el guardia de cobertura de abajo. */
  declaredByFile: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * EL RECORRIDO DE ESTA PRUEBA ES DELIBERADAMENTE MÁS ANCHO QUE EL DEL METRO, y
 * eso es una decisión, no una copia mal hecha.
 *
 * `flaggedDeclarations` de `lanes/code.ts` devuelve sólo lo SEÑALADO: filtra por
 * `isFlagged`, y con él las dos exenciones escritas (dos letras o menos, y
 * `snake_case` en miembro de interfaz). Un corpus filtrado por el propio
 * clasificador sería circular: no contendría ni un solo nombre inglés, que es
 * justo la mitad del espacio donde una divergencia puede esconderse —y tampoco
 * los cortos, que son el borde de la regla de las dos letras—. Así que aquí se
 * recogen TODOS los nombres, sin filtro.
 *
 * Que este recorrido no se haya desviado del suyo no se argumenta: se comprueba,
 * en «el corpus cubre lo que el metro cuenta».
 */
function harvest(): Corpus {
  const declared = new Set<string>();
  const everything = new Set<string>();
  const declaredByFile = new Map<string, ReadonlySet<string>>();
  let declarationOccurrences = 0;

  for (const tree of TREES) {
    for (const file of tsFiles(tree)) {
      const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
      const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const here = new Set<string>();

      const take = (name: string): void => {
        declarationOccurrences += 1;
        declared.add(name);
        here.add(name);
      };

      // El mismo desarme de nombres que `lanes/code.ts`: identificador, privado
      // sin la almohadilla, o patrón de desestructuración —donde sólo cuenta el
      // enlace que se CREA—.
      const nameOf = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) take(node.text);
        else if (ts.isPrivateIdentifier(node)) take(node.text.replace(/^#/, ''));
        else if (ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
          for (const element of node.elements) {
            if (ts.isBindingElement(element)) nameOf(element.name);
          }
        }
      };

      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) everything.add(node.text);
        else if (ts.isPrivateIdentifier(node)) everything.add(node.text.replace(/^#/, ''));

        if (ts.isVariableDeclaration(node) || ts.isParameter(node)) nameOf(node.name);
        else if (ts.isFunctionDeclaration(node) && node.name) nameOf(node.name);
        else if (ts.isClassDeclaration(node) && node.name) nameOf(node.name);
        else if (ts.isInterfaceDeclaration(node)) nameOf(node.name);
        else if (ts.isTypeAliasDeclaration(node)) nameOf(node.name);
        else if (ts.isEnumDeclaration(node)) nameOf(node.name);
        else if (ts.isEnumMember(node)) nameOf(node.name);
        else if (ts.isTypeParameterDeclaration(node)) nameOf(node.name);
        else if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) nameOf(node.name);
        else if (ts.isGetAccessor(node) || ts.isSetAccessor(node)) nameOf(node.name);
        else if (ts.isPropertySignature(node) || ts.isMethodSignature(node)) nameOf(node.name);
        ts.forEachChild(node, visit);
      };

      visit(source);
      declaredByFile.set(file, here);
    }
  }

  return { declarationOccurrences, declared, everything, declaredByFile };
}

/**
 * LAS CINCO FORMAS DE UNA PALABRA. Una palabra suelta sólo ejercita la búsqueda
 * en el conjunto; puesta en un nombre compuesto ejercita además el corte, que es
 * la otra mitad de lo que puede divergir. `RFC` delante es a propósito: es el
 * caso de la sigla pegada, la única regla de `tokenize` que no es obvia.
 */
function wordForms(word: string): string[] {
  const capitalized = word.charAt(0).toUpperCase() + word.slice(1);
  return [word, word.toUpperCase(), `get${capitalized}`, `${word}_value`, `RFC${capitalized}`];
}

/**
 * El léxico entero, en las cinco formas. Ataca la precedencia palabra por palabra.
 *
 * Las claves de `DOMAIN_TERMS` entran aquí aunque hoy no haya ninguna: la lista
 * nace vacía a propósito, y el día que alguien meta el primer término de dominio
 * la conformidad lo cubre sin que nadie se acuerde de venir a añadirlo.
 */
function lexiconStress(): string[] {
  const out: string[] = [];
  for (const word of [...SPANISH_ROOTS, ...NEUTRAL_TOKENS, ...ENGLISH_EXTRA, ...DOMAIN_TERMS.keys()]) {
    out.push(...wordForms(word));
  }
  return out;
}

// ============================================================
// LOS BORDES QUE UN CORPUS NO TRAE
//
// El código real no contiene la cadena vacía, ni un nombre de un solo carácter
// raro, ni `kebab-case` —que no es un identificador legal de TypeScript pero SÍ
// llega a `tokenize`, porque el metro le pasa nombres de archivo—. Éstos se
// escriben a mano.
//
// Y SE FIJA EL VALOR, NO SÓLO EL ACUERDO. Dos implementaciones equivocadas de la
// misma manera concuerdan perfectamente: sobre estos casos la conformidad no
// prueba nada, así que aquí se escribe lo que TIENE que salir y se le exige a
// los dos lados por separado. Varias de estas respuestas son incómodas —están
// marcadas— y están escritas justamente para que cambiarlas cueste un diff
// visible en vez de pasar de largo.
// ============================================================

interface EdgeCase {
  input: string;
  tokens: string[];
  klass: IdentifierClass;
  /** Por qué este caso está aquí. Se imprime cuando falla. */
  why: string;
}

const EDGE_CASES: readonly EdgeCase[] = [
  { input: '', tokens: [], klass: 'neutral', why: 'la cadena vacía no es de ningún idioma' },
  { input: '_', tokens: [], klass: 'neutral', why: 'sólo separadores: cero tokens, no un token vacío' },
  { input: '$', tokens: [], klass: 'neutral', why: 'el dólar es separador para este recorte' },
  { input: '___', tokens: [], klass: 'neutral', why: 'separadores repetidos no producen tokens vacíos' },
  { input: 'a', tokens: ['a'], klass: 'neutral', why: 'un carácter no dice idioma' },
  { input: 'Z', tokens: ['z'], klass: 'neutral', why: 'una mayúscula suelta tampoco' },
  { input: 'id', tokens: ['id'], klass: 'neutral', why: 'la exención escrita de dos letras' },
  { input: 'iva', tokens: ['iva'], klass: 'neutral', why: 'acrónimo de ley: neutro por lista' },
  { input: '123', tokens: ['123'], klass: 'neutral', why: 'sólo dígitos: no es una palabra' },
  { input: '0', tokens: ['0'], klass: 'neutral', why: 'un dígito suelto' },
  {
    input: '2fa',
    tokens: ['2fa'],
    klass: 'en',
    why: 'INCÓMODO: tres caracteres con dígito, en ninguna lista, cae en inglés por defecto',
  },
  {
    input: 'tasa8',
    tokens: ['tasa8'],
    klass: 'es',
    why: 'el dígito no corta: `tasa8` sale español porque la curación lo metió ENTERO en las raíces',
  },
  {
    input: 'tasa9',
    tokens: ['tasa9'],
    klass: 'en',
    why: 'INCÓMODO: el vecino de arriba con otro dígito no está curado, y el mismo nombre sale inglés',
  },
  { input: 'saldoInicial', tokens: ['saldo', 'inicial'], klass: 'es', why: 'camelCase español, el caso central' },
  { input: 'amountDue', tokens: ['amount', 'due'], klass: 'en', why: 'camelCase inglés' },
  {
    input: 'calcularBalanceSheet',
    tokens: ['calcular', 'balance', 'sheet'],
    klass: 'mixed',
    why: 'medio traducido',
  },
  { input: 'SALDO_INICIAL', tokens: ['saldo', 'inicial'], klass: 'es', why: 'SCREAMING_SNAKE' },
  { input: 'saldo_inicial', tokens: ['saldo', 'inicial'], klass: 'es', why: 'snake_case' },
  {
    input: 'poliza-service',
    tokens: ['poliza', 'service'],
    klass: 'mixed',
    why: 'kebab-case: llega por los nombres de archivo',
  },
  {
    input: 'RFCValido',
    tokens: ['rfc', 'valido'],
    klass: 'es',
    why: 'sigla pegada a palabra: sin esa regla el español viaja invisible',
  },
  { input: 'CFDIRecibido', tokens: ['cfdi', 'recibido'], klass: 'es', why: 'la misma regla con una sigla de cuatro' },
  {
    input: 'HTTPSProxy',
    tokens: ['https', 'proxy'],
    klass: 'en',
    why: 'la sigla larga se corta antes de la última mayúscula',
  },
  { input: 'CFDI', tokens: ['cfdi'], klass: 'neutral', why: 'una sigla sola no se parte' },
  {
    input: 'iva16Tasa',
    tokens: ['iva16', 'tasa'],
    klass: 'es',
    why: 'el dígito sí corta antes de una mayúscula, y `iva16` está curado como neutro',
  },
  {
    input: 'año',
    tokens: ['a', 'o'],
    klass: 'neutral',
    why: 'INCÓMODO: el acento parte la palabra en dos trozos cortos y el español desaparece',
  },
  {
    input: 'añoFiscal',
    tokens: ['a', 'o', 'fiscal'],
    klass: 'neutral',
    why: 'INCÓMODO: un nombre español entero sale NEUTRAL, invisible para la puerta, por una eñe',
  },
  { input: 'ñ', tokens: [], klass: 'neutral', why: 'un carácter no ASCII solo no deja token' },
  {
    input: '#saldo',
    tokens: ['saldo'],
    klass: 'es',
    why: 'la almohadilla es separador; los llamadores además la quitan antes',
  },
  { input: 'saldo inicial', tokens: ['saldo', 'inicial'], klass: 'es', why: 'el espacio ya venía contemplado' },
  { input: 'v2', tokens: ['v2'], klass: 'neutral', why: 'dos caracteres con dígito' },
  { input: 'XMLHttpRequest', tokens: ['xml', 'http', 'request'], klass: 'en', why: 'dos siglas seguidas' },
  { input: 'aB', tokens: ['a', 'b'], klass: 'neutral', why: 'el corte camelCase también parte lo cortísimo' },
  { input: 'ABc', tokens: ['a', 'bc'], klass: 'neutral', why: 'sigla de dos seguida de palabra' },
];

// ============================================================

let gate: LexiconTwin;
let corpus: Corpus;

// EL HOOK TIENE SU PROPIO LÍMITE, Y NO ES EL DE LAS PRUEBAS. Este `beforeAll`
// cosecha el árbol entero —setecientos y pico archivos— y además compila el
// gemelo del lint. Las PRUEBAS ya llevaban su límite ampliado; al hook se le
// había olvidado, y vitest le da DIEZ SEGUNDOS por omisión.
//
// Cuando se agotan no falla una prueba: falla el ARCHIVO al cargar, y la suite
// reporta «FAIL … [ archivo ]» sin haber corrido ninguna. Se lee como si el
// conformance estuviera roto. Pasó en CI (corrida 34183268942, «Pruebas
// unitarias»), no sólo en una máquina cargada: 5 657 pruebas en verde y este
// archivo sin arrancar.
beforeAll(async () => {
  gate = await loadGateTwin();
  corpus = harvest();
}, 120_000);

/** Cuántas divergencias se imprimen. Bastantes para ver el patrón, pocas para leer. */
const MAX_REPORTED = 12;

/**
 * Compara los dos lados sobre un conjunto de cadenas y devuelve las
 * divergencias en prosa.
 *
 * NO se usa `expect` dentro del bucle: veinte mil aserciones tardan más que las
 * veinte mil comparaciones, y sobre todo la primera que falla esconde a las
 * demás. Se recogen todas y se afirma UNA VEZ, para que el diagnóstico diga si
 * lo que cambió fue una palabra o el criterio entero.
 */
function divergencesOver(names: Iterable<string>): string[] {
  const found: string[] = [];
  for (const name of names) {
    const meterTokens = meterTokenize(name);
    const gateTokens = gate.tokenize(name);
    if (meterTokens.length !== gateTokens.length || meterTokens.some((t, i) => t !== gateTokens[i])) {
      found.push(
        `tokenize(${JSON.stringify(name)}): metro ${JSON.stringify(meterTokens)} - ` +
          `puerta ${JSON.stringify(gateTokens)}`,
      );
      continue;
    }
    const meterClass = meterClassify(name);
    const gateClass = gate.classify(name);
    if (meterClass !== gateClass) {
      found.push(`classify(${JSON.stringify(name)}): metro '${meterClass}' - puerta '${gateClass}'`);
      continue;
    }
    if (meterIsFlagged(name) !== gate.isFlagged(name)) {
      found.push(
        `isFlagged(${JSON.stringify(name)}): metro ${String(meterIsFlagged(name))} - ` +
          `puerta ${String(gate.isFlagged(name))}`,
      );
    }
  }
  return found;
}

/** El informe que se lee cuando la conformidad se rompe. */
function report(label: string, found: string[], size: number): string {
  return (
    `${found.length} de ${size} cadenas reciben distinta respuesta del metro ` +
    `(scripts/language/lexicon.ts) y de la puerta (eslint.config.mjs) sobre ${label}. ` +
    'Las dos implementaciones se han separado: a partir de aquí el número que publica ' +
    'el metro y lo que el lint deja entrar cuentan poblaciones distintas.\n  ' +
    found.slice(0, MAX_REPORTED).join('\n  ') +
    (found.length > MAX_REPORTED ? `\n  y ${found.length - MAX_REPORTED} más` : '')
  );
}

describe('el corpus, antes de creerse una sola comparación', () => {
  // UNA PRUEBA DE CONFORMIDAD SOBRE UN CORPUS VACÍO ES VERDE Y NO PRUEBA NADA.
  // Es el modo de fallo más probable de este archivo: alguien mueve una carpeta,
  // el recorrido devuelve tres nombres, todo concuerda y nadie se entera. Los
  // pisos de abajo están puestos MUY por debajo de lo medido hoy —57 117
  // apariciones, 13 433 declarados distintos, 15 150 identificadores en total,
  // 741 archivos— porque no son un trinquete que haya que subir: son la
  // diferencia entre medir y no medir.
  it('es grande, y por eso una coincidencia significa algo', () => {
    expect(corpus.declarationOccurrences).toBeGreaterThan(50_000);
    expect(corpus.declared.size).toBeGreaterThan(10_000);
    expect(corpus.everything.size).toBeGreaterThan(12_000);
    expect(corpus.declaredByFile.size).toBeGreaterThan(500);
  });

  // EL RECORRIDO DE ESTA PRUEBA ES UNA TERCERA COPIA, y una copia sin comprobar
  // es la misma enfermedad que este archivo viene a curar. Aquí se comprueba: el
  // metro señala un subconjunto de nombres por archivo, y todos tienen que estar
  // en el corpus. Si `lanes/code.ts` empieza a contar una forma de declaración
  // que este recorrido no recoge, salta aquí y no en silencio.
  it('cubre lo que el metro cuenta, archivo por archivo', () => {
    const missing: string[] = [];
    for (const tree of TREES) {
      for (const flagged of identifiersIn(tree)) {
        const here = corpus.declaredByFile.get(flagged.file);
        if (!here?.has(flagged.name)) missing.push(`${flagged.file}:${flagged.line} ${flagged.name}`);
      }
    }
    expect(
      missing.slice(0, MAX_REPORTED),
      `el metro cuenta ${missing.length} identificadores que el recorrido de esta prueba no ve. ` +
        'El corpus se ha quedado más estrecho que la población, así que la conformidad ya no ' +
        'la cubre entera.',
    ).toEqual([]);
    // PLAZO PROPIO, y no es flakiness disfrazada: este caso recorre los 741
    // archivos de los tres árboles con el compilador de TypeScript. Sola tarda
    // unos segundos; dentro de la suite completa, compitiendo por CPU con
    // otros doscientos cincuenta archivos, se pasaba del plazo de cinco
    // segundos y salía roja sin que nada estuviera mal. Un rojo que depende de
    // la carga de la máquina enseña a ignorar los rojos.
  }, 120_000);

  // Y la comprobación simétrica: que la puerta esté leyendo el MISMO
  // `lexicon.json`. Si un día leyera otro archivo —o ninguno, cayendo en listas
  // vacías— contestaría 'neutral' a todo, y contra un corpus que también sale
  // neutro eso podría pasar desapercibido. Aquí se le exige que reconozca el
  // léxico por su contenido.
  it('la puerta lee las mismas palabras que el metro', () => {
    const spanish = [...SPANISH_ROOTS].sort().slice(0, 50);
    const english = [...ENGLISH_EXTRA].sort().slice(0, 50);
    expect(spanish.filter((word) => gate.classify(word) !== 'es')).toEqual([]);
    expect(english.filter((word) => gate.classify(word) !== 'en')).toEqual([]);
  });

  // LA CONFORMIDAD NO PUEDE SER UNA TAUTOLOGÍA. Si algún día los dos lados
  // acabaran siendo el mismo objeto —porque alguien logró compartir el módulo,
  // que sería la buena noticia—, cada comparación de abajo se convertiría en
  // `f === f` y este archivo pasaría a no proteger nada mientras sigue en verde.
  // Que se rompa aquí es la señal de que ya sobra: bórrese entonces, con su
  // razón en el commit.
  it('son dos implementaciones distintas, no la misma dos veces', () => {
    expect(gate.tokenize).not.toBe(meterTokenize);
    expect(gate.classify).not.toBe(meterClassify);
    expect(gate.isFlagged).not.toBe(meterIsFlagged);
  });
});

describe('los bordes, con el valor escrito y no sólo el acuerdo', () => {
  it.each(EDGE_CASES)('$input - $why', ({ input, tokens, klass }) => {
    expect(meterTokenize(input), 'metro tokenize').toEqual(tokens);
    expect(gate.tokenize(input), 'puerta tokenize').toEqual(tokens);
    expect(meterClassify(input), 'metro classify').toBe(klass);
    expect(gate.classify(input), 'puerta classify').toBe(klass);
    const flagged = klass === 'es' || klass === 'mixed';
    expect(meterIsFlagged(input), 'metro isFlagged').toBe(flagged);
    expect(gate.isFlagged(input), 'puerta isFlagged').toBe(flagged);
  });
});

// ============================================================
// LAS DOS EXENCIONES, QUE TAMBIÉN ESTÁN ESCRITAS DOS VECES
//
// `isFlagged` no es lo último que decide si un nombre cuenta: encima suyo hay
// `isCounted`, con las dos exenciones escritas del tramo —dos letras o menos, y
// `snake_case` en miembro de interfaz—. Y `isCounted` está duplicado igual que
// el léxico: en `lanes/code.ts` y en `eslint.config.mjs`, palabra por palabra.
//
// SE COMPROBÓ QUE NADIE LO MIRABA. Cambiar `name.length <= 2` por `<= 3` en el
// gemelo de la puerta —y sólo ahí— dejaba la conformidad del léxico en verde, la
// prueba de la regla en verde y la de los carriles en verde: la puerta habría
// empezado a perdonar los nombres de tres letras que el metro sigue contando, y
// las dos cifras se habrían separado sin una sola alarma. Igual con
// `isSnakeCase`. Este bloque es lo que cierra ese hueco.
//
// SE COMPARA A TRAVÉS DE `flaggedDeclarations`, que es lo que los dos exportan,
// y sobre fragmentos elegidos en el BORDE de cada exención: un nombre español de
// tres letras (que cuenta) contra uno de dos (que no), y `snake_case` dentro de
// una interfaz (exento) contra el mismo nombre fuera (contado) y contra uno con
// una mayúscula dentro (que ya no es `snake_case` y vuelve a contar).
//
// LOS FRAGMENTOS SON DELIBERADAMENTE ABURRIDOS. Los dos recorridos difieren a
// propósito en varias formas —miembros de objeto literal, claves computadas,
// expresiones de clase—, y ésas están documentadas y probadas donde toca. Aquí
// sólo entran construcciones donde los dos tienen que coincidir, para que un
// fallo de este bloque signifique «las exenciones se separaron» y no «los
// recorridos difieren donde ya sabíamos».
// ============================================================

/**
 * Un `SourceCode` de ESLint para un fragmento, que es lo único que el gemelo de
 * la puerta sabe recorrer.
 *
 * Se pide por dentro de un `Linter` en vez de construirlo a mano porque así lo
 * arma el mismo camino que usa ESLint de verdad: el parser de TypeScript, sus
 * claves de visita y su `traverse()`. Un `SourceCode` fabricado a mano podría
 * recorrer distinto que el de producción y la comparación no diría nada.
 */
function sourceCodeOf(code: string): SourceCode {
  const linter = new Linter();
  let captured: SourceCode | null = null;
  const grab: Rule.RuleModule = {
    create(context) {
      captured = context.sourceCode;
      return {};
    },
  };
  const messages = linter.verify(
    code,
    [
      {
        files: ['**/*.ts'],
        languageOptions: { parser },
        plugins: { probe: { rules: { grab } } },
        rules: { 'probe/grab': 'error' },
      },
    ],
    'probe.ts',
  );
  if (captured === null) {
    throw new Error(
      `no se pudo obtener el SourceCode del fragmento: ${JSON.stringify(messages)}. Sin él este ` +
        'bloque compararía dos listas vacías y saldría verde sin haber mirado las exenciones.',
    );
  }
  return captured;
}

/** Un fragmento y los nombres que los DOS lados tienen que señalar en él. */
interface ExemptionCase {
  code: string;
  names: string[];
  why: string;
}

const EXEMPTION_CASES: readonly ExemptionCase[] = [
  { code: 'const dia = 1;', names: ['dia'], why: 'tres letras españolas: el primer nombre que la exención NO perdona' },
  { code: 'const la = 1;', names: [], why: 'dos letras: la exención escrita, aunque la palabra sea española' },
  { code: 'const alta = 1;', names: ['alta'], why: 'control, lejos del borde' },
  {
    code: 'interface Row { saldo_inicial: string }',
    names: [],
    why: 'snake_case en miembro de interfaz: ahí vive el nombre de una columna',
  },
  {
    code: 'interface Row { saldo_Inicial: string }',
    names: ['saldo_Inicial'],
    why: 'una mayúscula y ya no es snake_case: vuelve a contar aunque siga en la interfaz',
  },
  {
    code: 'const saldo_inicial = 1;',
    names: ['saldo_inicial'],
    why: 'el mismo nombre fuera de una interfaz sí cuenta: no hay columna que proteger',
  },
  {
    code: 'class Ledger { saldo_inicial = 1; }',
    names: ['saldo_inicial'],
    why: 'una propiedad de clase tampoco es un miembro de interfaz',
  },
  {
    code: 'function calcularSaldo(montoInicial: number) { return montoInicial; }',
    names: ['calcularSaldo', 'montoInicial'],
    why: 'función y parámetro, que es donde el recuento de un archivo se hace grande',
  },
];

// ============================================================
// LA PRECEDENCIA, Y DE QUÉ DEPENDE QUE SE PUEDA COMPROBAR
//
// Los dos gemelos consultan las listas EN ORDEN —española, neutra, inglesa— y
// los dos lo explican como si fuera el corazón del criterio. Pero un orden de
// consulta sólo se puede observar donde las listas SE SOLAPAN: si ninguna
// palabra está en dos listas, cualquier orden da exactamente el mismo resultado
// y ningún corpus del mundo distingue una versión de la otra.
//
// Hoy hay UN solo solapamiento en las 2 621 palabras: `decimales`, que está a la
// vez en las raíces españolas y en los neutros. Ese único cruce es lo que hace
// que invertir las dos primeras líneas de `classifyToken` en un gemelo y no en
// el otro se vea en la conformidad: un puñado de cadenas del árbol cambian de
// clase, y con ellas la prueba se pone roja.
// Quítese `decimales` de una de las dos listas, que es la limpieza que cualquiera
// haría al ver una palabra repetida, y esa mutación deja de detectarse: la
// prueba de conformidad seguiría verde con los dos criterios separados.
//
// Por eso se fija aquí. No es una prueba del léxico —eso es I1— sino de la
// COBERTURA de esta prueba: dice en voz alta de qué depende que muerda, para que
// el día que eso desaparezca lo diga un fallo y no el silencio.
//
// Y consta lo que NO se cubre: entre las raíces españolas y las inglesas no hay
// ni un cruce, así que ese tercer escalón de la precedencia no lo comprueba
// nadie. Lo único que hoy lo sostiene es que las dos versiones se escribieron
// iguales.
// ============================================================

describe('las dos exenciones, que también están escritas dos veces', () => {
  it.each(EXEMPTION_CASES)('$code - $why', ({ code, names }) => {
    const meterNames = meterFlaggedDeclarations(code, 'probe.ts').map((entry) => entry.name);
    const gateNames = gate.flaggedDeclarations(sourceCodeOf(code)).map((entry) => entry.name);
    expect(meterNames, 'metro (scripts/language/lanes/code.ts)').toEqual(names);
    expect(gateNames, 'puerta (eslint.config.mjs)').toEqual(names);
  });
});

describe('la precedencia, y de qué depende que se pueda comprobar', () => {
  it('el solapamiento que hace observable el orden sigue en su sitio', () => {
    const inBothLists = [...SPANISH_ROOTS].filter((word) => NEUTRAL_TOKENS.has(word)).sort();
    expect(
      inBothLists,
      'ninguna palabra está a la vez en las raíces españolas y en los neutros. Sin ese cruce, ' +
        'el ORDEN en que `classifyToken` consulta las listas deja de tener efecto observable: ' +
        'un gemelo puede invertirlo y la conformidad no lo verá. Si el cruce se quitó a ' +
        'propósito, hay que sustituir esta cobertura por otra cosa antes de borrar esta prueba.',
    ).not.toEqual([]);

    // Y que el cruce lo resuelven igual los dos, que es lo que la precedencia promete.
    for (const word of inBothLists) {
      expect(meterClassify(word), `metro sobre '${word}'`).toBe('es');
      expect(gate.classify(word), `puerta sobre '${word}'`).toBe('es');
    }
  });

  it('el escalón que ningún corpus cubre, escrito para que no se dé por cubierto', () => {
    const spanishAndEnglish = [...SPANISH_ROOTS].filter((word) => ENGLISH_EXTRA.has(word)).sort();
    expect(
      spanishAndEnglish,
      'ahora SÍ hay palabras en las raíces españolas y en las inglesas a la vez. Eso convierte ' +
        'en observable un escalón de la precedencia que hasta hoy no lo era: decídase a ' +
        'conciencia quién gana, compruébese que los dos gemelos lo resuelven igual, y ' +
        'reescríbase este caso.',
    ).toEqual([]);
  });
});

describe('la conformidad sobre el árbol entero', () => {
  it('los nombres declarados reciben la misma clase de los dos', () => {
    const found = divergencesOver(corpus.declared);
    expect(found.length, report('la población declarada', found, corpus.declared.size)).toBe(0);
  });

  it('y también los identificadores que hoy sólo son referencias', () => {
    const found = divergencesOver(corpus.everything);
    expect(found.length, report('todos los identificadores del AST', found, corpus.everything.size)).toBe(0);
  });

  it('el léxico entero, palabra a palabra y en cinco formas', () => {
    const stress = lexiconStress();
    // El piso dice que las listas se cargaron: sin él, un `lexicon.json` roto
    // daría un corpus de cero palabras y esta prueba seguiría verde.
    expect(stress.length).toBeGreaterThan(10_000);
    const found = divergencesOver(stress);
    expect(found.length, report('el léxico en cinco formas', found, stress.length)).toBe(0);
  });
});
