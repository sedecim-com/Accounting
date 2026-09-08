import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { EN } from '../../src/i18n/en.js';
import { ES } from '../../src/i18n/es.js';
import {
  CATALOGS,
  LANGUAGES,
  UNTRANSLATED_MARKER,
  getLanguage,
  isLanguage,
  messageParameters,
  resetLanguage,
  setLanguage,
  t,
  type Catalog,
  type Language,
  type MessageParams,
  type TranslationKey,
} from '../../src/i18n/index.js';
import {
  LOCALES,
  LOCALE_ENV_VAR,
  LOCALE_FLAG,
  languageOfLocale,
  resolveLocale,
} from '../../src/i18n/locale.js';
import {
  PLURAL_CATEGORIES,
  choosePluralBranch,
  chooseSelectBranch,
  pluralCategory,
} from '../../src/i18n/plural.js';

// ============================================================
// LA SINCRONÍA DEL CATÁLOGO (I6 · issue #148)
//
// LO QUE ESTA PRUEBA NO COMPRUEBA, PORQUE YA LO IMPIDE EL COMPILADOR: que a
// `es.ts` le falte una clave. `es.ts` se declara `Record<keyof typeof EN,
// string>`, así que borrar una clave allí es un TS2741 y añadir una que no
// exista en `en.ts` es un TS2353 — los dos, en el editor, sin llegar a CI.
// Aquí se repite igualmente el conteo de claves (§1) por una razón concreta: el
// día que alguien afloje ese tipo a `Record<string, string>` —el arreglo
// «obvio» cuando `tsc` estorba— el compilador se calla y esta prueba no.
//
// LO QUE SÓLO SE VE AQUÍ son las cuatro formas de estar sincronizado en el
// tipo y roto en la pantalla:
//
//   1. PARÁMETROS DISTINTOS. `{command}` traducido a `{comando}` compila
//      perfectamente y sale con el hueco vacío en la terminal de alguien.
//   2. RAMAS DE `select` DISTINTAS. Una causa que en español tiene rama y en
//      inglés no cae en `other`, y el operador inglés lee «no hay nada que
//      devengar» donde el español lee «la cobertura ya terminó».
//   3. LA CADENA INGLESA COPIADA SIN TRADUCIR. Un `Record` no distingue una
//      traducción de un pegado.
//   4. UN `__TRANSLATE__` OLVIDADO, que es lo que un traductor deja donde
//      todavía no llegó.
//
// Y DOS QUE NO SON DEL CATÁLOGO SINO DEL TRAMO:
//
//   · QUE EL CATÁLOGO ESTÉ CABLEADO (§8b). Que `t()` sepa imprimir en inglés
//     cuando se le NOMBRA el inglés no dice nada sobre de dónde saca el idioma
//     cuando no se le nombra ninguno, que es como se le llama en todos los
//     sitios de llamada reales. Durante todo I6 la respuesta fue «del renglón
//     97 de index.ts, congelada al importar», y las cuarenta pruebas de este
//     archivo estuvieron en verde. La §8b es la que hace esa pregunta.
//   · QUE ESTOS ARCHIVOS NO LEAN EL ENTORNO (§7).
//
// Las dos tiran en direcciones opuestas y esa tensión es el diseño: el catálogo
// PREGUNTA el idioma (a `locale.ts`, §8b) sin LEERLO (§7).
//
// El criterio de la issue exige que `MNEMOSINE_LANG` y
// `MNEMOSINE_LOCALE` se lean en EXACTAMENTE UN archivo de `src/`, y hoy se leen
// en dos (`src/ai/providers/config.ts:1132`, `src/cli/mnemosine.ts:2238`). El
// lector único va a ser `src/i18n/locale.ts`; si el catálogo se pusiera a leer
// también, serían dos otra vez y el CLI y el agente podrían imprimir en idiomas
// distintos en la misma corrida.
//
// NINGUNA PRUEBA DE AQUÍ SABE CUÁNTOS IDIOMAS HAY. Todas recorren `LANGUAGES`.
// Un tercer idioma es un archivo más y cero renglones de prueba.
// ============================================================

const CATALOG_KEYS = Object.keys(EN) as TranslationKey[];

/**
 * El idioma clavado es estado de módulo: si una prueba lo clava, se suelta.
 *
 * Antes esto decía `const ORIGINAL_LANGUAGE = getLanguage()` y volvía a
 * CLAVARLO después de cada prueba. Con el catálogo cableado eso deja de ser una
 * limpieza y pasa a ser una trampa: `getLanguage()` correría al cargar el
 * archivo, congelaría una respuesta, y el `afterEach` la reimpondría — así que
 * a partir de la primera prueba el módulo quedaría CLAVADO, y cualquier prueba
 * posterior que no soltara primero mediría un idioma clavado creyendo medir uno
 * derivado. La §8b se salva porque suelta en su propio `beforeEach`; una
 * prueba futura que se olvide, no. Soltar no es lo mismo que devolver.
 */
afterEach(() => resetLanguage());

/**
 * Cadenas que legítimamente se escriben igual en los dos idiomas. Hoy está
 * VACÍA, y ése es el punto: cuando llegue la primera —un código, una sigla— se
 * añade aquí con su razón, y no se afloja la comprobación §5 para todas.
 */
const IDENTICAL_BY_DESIGN = new Set<TranslationKey>();

// ---- §1 · Las claves -------------------------------------------------

describe('el catálogo tiene las mismas claves en todos los idiomas', () => {
  it('LANGUAGES empieza por es, y no se repite', () => {
    // El español primero es el pedido del dueño y el valor por omisión de
    // `t()`. Invertir la lista a ['en','es'] tiene que poner esto en rojo.
    expect(LANGUAGES[0]).toBe('es');
    expect(new Set(LANGUAGES).size).toBe(LANGUAGES.length);
  });

  it('cada idioma de LANGUAGES trae su catálogo', () => {
    for (const language of LANGUAGES) {
      expect(CATALOGS[language], `falta el catálogo de ${language}`).toBeDefined();
    }
    expect(Object.keys(CATALOGS).sort()).toEqual([...LANGUAGES].sort());
  });

  it('ningún idioma tiene claves de más ni de menos', () => {
    const source = [...CATALOG_KEYS].sort();
    for (const language of LANGUAGES) {
      const keys = Object.keys(CATALOGS[language]).sort();
      expect(keys, `las claves de ${language} no cuadran con las de en.ts`).toEqual(source);
    }
  });

  it('las claves van en el mismo orden en en.ts y en es.ts', () => {
    // No es estética: un catálogo que se desordena hace ilegible el diff de la
    // siguiente traducción, y una traducción que no se puede revisar no se
    // revisa.
    expect(Object.keys(ES)).toEqual(Object.keys(EN));
  });
});

// ---- §2 · Los parámetros --------------------------------------------

describe('los parámetros son los mismos en todos los idiomas', () => {
  it('cada clave pide los mismos nombres en todos los idiomas', () => {
    for (const key of CATALOG_KEYS) {
      const expected = messageParameters(EN[key], key).map((p) => p.name);
      for (const language of LANGUAGES) {
        const actual = messageParameters(CATALOGS[language][key], `${language}:${key}`).map(
          (p) => p.name,
        );
        expect(actual, `${language}.${key} no pide los mismos parámetros que en.ts`).toEqual(
          expected,
        );
      }
    }
  });

  it('un select reparte por las mismas ramas en todos los idiomas', () => {
    for (const key of CATALOG_KEYS) {
      const source = messageParameters(EN[key], key).filter((p) => p.kind === 'select');
      for (const language of LANGUAGES) {
        const other = messageParameters(CATALOGS[language][key], `${language}:${key}`);
        for (const parameter of source) {
          const twin = other.find((p) => p.name === parameter.name);
          expect(twin?.kind, `${language}.${key}: "${parameter.name}" cambió de clase`).toBe(
            'select',
          );
          expect(
            twin?.branches,
            `${language}.${key}: las ramas de "${parameter.name}" no coinciden con en.ts`,
          ).toEqual(parameter.branches);
        }
      }
    }
  });

  it('las ramas de un plural son categorías CLDR o coincidencias exactas', () => {
    // Aquí NO se exige que coincidan entre idiomas, y es deliberado: el árabe
    // necesita 'few' y 'many' donde el español sólo tiene 'one' y 'other'.
    // Exigir simetría obligaría a escribir ramas muertas en cada idioma.
    const categories = new Set<string>(PLURAL_CATEGORIES);
    for (const language of LANGUAGES) {
      for (const key of CATALOG_KEYS) {
        for (const parameter of messageParameters(CATALOGS[language][key], key)) {
          if (parameter.kind !== 'plural') continue;
          for (const branch of parameter.branches) {
            const valid = categories.has(branch) || /^=\d+$/.test(branch);
            expect(valid, `${language}.${key}: "${branch}" no es una rama de plural`).toBe(true);
          }
        }
      }
    }
  });
});

// ---- §3 · Cadenas vacías --------------------------------------------

describe('ninguna cadena está vacía', () => {
  it('toda traducción tiene texto', () => {
    for (const language of LANGUAGES) {
      for (const key of CATALOG_KEYS) {
        const value = CATALOGS[language][key];
        expect(typeof value, `${language}.${key} no es una cadena`).toBe('string');
        expect(value.trim(), `${language}.${key} está vacía`).not.toBe('');
      }
    }
  });

  it('ninguna rama de un select o un plural está vacía', () => {
    // Una rama vacía es peor que una clave sin traducir: no se ve. El mensaje
    // sale con un hueco donde iba la mitad de la frase.
    for (const language of LANGUAGES) {
      for (const key of CATALOG_KEYS) {
        for (const parameter of messageParameters(CATALOGS[language][key], key)) {
          for (const branch of parameter.branches) {
            expect(branch.trim(), `${language}.${key}: rama sin nombre`).not.toBe('');
          }
        }
      }
    }
  });
});

// ---- §4 · La marca del traductor ------------------------------------

describe('__TRANSLATE__ se rechaza', () => {
  it('ninguna cadena de ningún catálogo lo lleva dentro', () => {
    for (const language of LANGUAGES) {
      for (const key of CATALOG_KEYS) {
        expect(
          CATALOGS[language][key].includes(UNTRANSLATED_MARKER),
          `${language}.${key} sigue marcada como sin traducir`,
        ).toBe(false);
      }
    }
  });

  it('la marca es una sola, y viene del módulo', () => {
    // Escrita a mano aquí, esta prueba y el traductor podrían usar dos
    // ortografías distintas y la puerta no cerraría nada.
    expect(UNTRANSLATED_MARKER).toBe('__TRANSLATE__');
  });
});

// ---- §5 · El idioma equivocado --------------------------------------

describe('ninguna traducción es la fuente copiada', () => {
  it('el español no repite palabra por palabra el inglés', () => {
    for (const key of CATALOG_KEYS) {
      if (IDENTICAL_BY_DESIGN.has(key)) continue;
      expect(ES[key], `es.${key} es la cadena inglesa sin traducir`).not.toBe(EN[key]);
    }
  });

  it('un idioma que no existe cae al primero y no revienta', () => {
    // `locale.ts` puede resolver cualquier cosa que venga de --locale, de
    // MNEMOSINE_LANG o de un JSON escrito a mano. Un CLI que no arranca por una
    // etiqueta mal escrita es peor que uno que imprime en español.
    const invented = 'fr' as Language;
    expect(t('no_changes_ledger_untouched', {}, invented)).toBe(
      ES.no_changes_ledger_untouched,
    );
  });

  it('cada idioma imprime lo suyo cuando se le nombra', () => {
    expect(t('prepaid_no_live_schedule', {}, 'es')).toBe(ES.prepaid_no_live_schedule);
    expect(t('prepaid_no_live_schedule', {}, 'en')).toBe(EN.prepaid_no_live_schedule);
  });
});

// ---- §6 · Todo mensaje se puede imprimir ----------------------------

/** Un juego de parámetros que satisface a un mensaje, sea cual sea su forma. */
function probeParams(message: string, key: string, count: number): MessageParams {
  const params: Record<string, string | number> = {};
  for (const parameter of messageParameters(message, key)) {
    if (parameter.kind === 'plural') params[parameter.name] = count;
    else if (parameter.kind === 'select') params[parameter.name] = parameter.branches[0] ?? 'other';
    else params[parameter.name] = `<${parameter.name}>`;
  }
  return params;
}

describe('todo mensaje se analiza y se imprime', () => {
  it('cada clave rinde texto en cada idioma y para cada cuenta', () => {
    // Las cuentas cubren las categorías que el CLDR reparte distinto entre
    // idiomas: 0, 1, 2, 5, 11 y 21. Que el catálogo ENTERO se analice aquí es
    // lo que permite que el analizador de `index.ts` lance ante un mensaje roto
    // en vez de imprimirlo a medias.
    for (const language of LANGUAGES) {
      for (const key of CATALOG_KEYS) {
        const message = CATALOGS[language][key];
        for (const count of [0, 1, 2, 5, 11, 21]) {
          const rendered = t(key, probeParams(message, key, count), language);
          expect(rendered, `${language}.${key} salió vacía con count=${count}`).not.toBe('');
          expect(rendered, `${language}.${key} dejó un hueco sin llenar`).not.toMatch(/[{}]/);
          expect(rendered, `${language}.${key} dejó un # sin sustituir`).not.toContain('#');
        }
      }
    }
  });

  it('cada rama de cada select se puede pedir por su nombre', () => {
    for (const language of LANGUAGES) {
      for (const key of CATALOG_KEYS) {
        const message = CATALOGS[language][key];
        for (const parameter of messageParameters(message, key)) {
          if (parameter.kind !== 'select') continue;
          for (const branch of parameter.branches) {
            const params = { ...probeParams(message, key, 1), [parameter.name]: branch };
            expect(t(key, params, language), `${language}.${key}/${branch}`).not.toBe('');
          }
        }
      }
    }
  });
});

// ---- §7 · El catálogo no lee el entorno -----------------------------

/**
 * ¿Este archivo NOMBRA `process`?
 *
 * Se pregunta sobre el ÁRBOL DEL COMPILADOR y no con un `includes`, y la razón
 * la dio la primera versión de esta prueba: fallaba porque el comentario de
 * cabecera de `index.ts` dice, en prosa, que ahí no hay `process.env`. Un
 * guardián que no distingue el código de lo que se escribe sobre el código
 * obliga a elegir entre la comprobación y la explicación. El AST no confunde
 * las dos, y de paso tampoco confunde una cadena que diga `process.env`.
 *
 * Se prohíbe el identificador ENTERO y no sólo `.env`: un catálogo que escriba
 * en `process.stdout` o mire `process.argv` es la misma clase de error —una
 * pieza de texto que decide cosas por su cuenta— que la issue viene a cerrar.
 */
function mentionsProcess(file: string): boolean {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    // El nombre de una propiedad no es una referencia: `{ process: 1 }` y
    // `algo.process` no leen el `process` global.
    // El nodo raíz no tiene padre, y preguntárselo revienta dentro de la
    // propia `isPropertyAccessExpression` de TypeScript.
    const parent: ts.Node | undefined = node.parent;
    const isPropertyName =
      parent !== undefined &&
      ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node));
    if (ts.isIdentifier(node) && node.text === 'process' && !isPropertyName) found = true;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('el catálogo no lee el entorno', () => {
  const OWNED = ['index.ts', 'en.ts', 'es.ts', 'plural.ts'];
  const HOME = path.join(__dirname, '..', '..', 'src', 'i18n');

  it('ninguno de estos archivos nombra process', () => {
    for (const file of OWNED) {
      expect(
        mentionsProcess(path.join(HOME, file)),
        `src/i18n/${file} nombra process: el criterio de la issue exige que ` +
          'MNEMOSINE_LANG|MNEMOSINE_LOCALE se lean en un solo archivo de src/, y ' +
          'ese archivo es locale.ts',
      ).toBe(false);
    }
  });

  it('y el guardián sí ve un process de verdad', () => {
    // Sin esto, un `mentionsProcess` que devolviera siempre `false` —un visitor
    // que no recorre, un `ts.createSourceFile` con la ruta equivocada— pasaría
    // la prueba de arriba para siempre y en verde.
    const decoy = path.join(__dirname, '..', '..', 'src', 'cli', 'kernel', 'output.ts');
    expect(mentionsProcess(decoy)).toBe(true);
  });
});

// ---- §8 · `t()` ------------------------------------------------------

describe('t() interpola, pluraliza y reparte', () => {
  it('llena un hueco simple', () => {
    expect(t('confirm_answer_not_understood', { answer: 'quizá' }, 'es')).toBe(
      'no entendí «quizá»: responde y/s para sí, n para no',
    );
  });

  it('elige la rama one y la rama other', () => {
    expect(t('cfdi_cancelled_by_issuer', { count: 1 }, 'es')).toContain('1 CFDI cancelado por');
    expect(t('cfdi_cancelled_by_issuer', { count: 3 }, 'es')).toContain('3 CFDI cancelados por');
    expect(t('cfdi_cancelled_by_issuer', { count: 1 }, 'en')).toContain('1 CFDI cancelled by');
    expect(t('cfdi_cancelled_by_issuer', { count: 3 }, 'en')).toContain('3 CFDIs cancelled by');
  });

  it('resuelve dos plurales independientes en una frase', () => {
    expect(t('diot_findings_summary', { blocking: 1, warnings: 4 }, 'es')).toBe(
      '1 bloqueante, 4 avisos. Un bloqueante impide capturar la declaración.',
    );
  });

  it('reparte un select por su código, y cae en other cuando no lo conoce', () => {
    expect(t('prepaid_row_skipped', { reason: 'coverage_ended' }, 'es')).toBe(
      'la cobertura ya terminó',
    );
    expect(t('prepaid_row_skipped', { reason: 'algo_nuevo' }, 'es')).toBe(
      'no hay nada que devengar este mes',
    );
  });

  it('# imprime la cuenta TAL CUAL, sin pasar por Number', () => {
    // El defecto que esto cierra está medido: '12345678901234567' pasado por
    // Number vuelve como 12345678901234568. El plural necesita un número para
    // elegir la rama, pero lo que se IMPRIME es la cadena original.
    const huge = '12345678901234567';
    expect(t('cfdi_cancelled_by_issuer', { count: huge }, 'es')).toContain(huge);
  });

  it('el idioma activo manda cuando no se nombra ninguno', () => {
    // Se CLAVA el idioma en vez de dar por supuesto que es el español. Antes
    // esta prueba abría con `expect(getLanguage()).toBe('es')` y pasaba por la
    // razón equivocada: pasaba porque el idioma estaba congelado en
    // `LANGUAGES[0]` desde la importación, no porque nadie hubiera pedido otro.
    // La suite corre con el locale del proceso en en-US (`vitest.config.ts`),
    // así que hoy, sin clavar nada, el idioma derivado es el inglés. Lo que
    // esta prueba mide es el ARGUMENTO OMITIDO; de dónde sale cuando nadie
    // clava nada es la §8b.
    setLanguage('es');
    expect(getLanguage()).toBe('es');
    expect(t('prepaid_no_live_schedule')).toBe(ES.prepaid_no_live_schedule);
    setLanguage('en');
    expect(getLanguage()).toBe('en');
    expect(t('prepaid_no_live_schedule')).toBe(EN.prepaid_no_live_schedule);
  });

  it('un parámetro que falta lanza, y dice cuál y de qué clave', () => {
    expect(() => t('prepaid_no_schedule_covers_date', {}, 'es')).toThrowError(
      /prepaid_no_schedule_covers_date.*"date"/,
    );
  });

  it('isLanguage estrecha lo que venga de fuera', () => {
    expect(isLanguage('es')).toBe(true);
    expect(isLanguage('en')).toBe(true);
    expect(isLanguage('es-MX')).toBe(false);
    expect(isLanguage(undefined)).toBe(false);
    expect(isLanguage(7)).toBe(false);
  });
});

// ---- §8b · El catálogo está CABLEADO --------------------------------

/**
 * LA PRUEBA QUE FALTABA, Y EL DEFECTO QUE MIDE.
 *
 * Hasta este arreglo `src/i18n/index.ts` abría con `let activeLanguage:
 * Language = LANGUAGES[0]` y `setLanguage()` no tenía UN SOLO llamador en
 * `src/`. El idioma quedaba decidido al importar el módulo y no había en el
 * árbol nada capaz de moverlo — que es exactamente lo que I6 venía a cerrar.
 *
 * La medición, antes del arreglo, corriendo con el locale del proceso en en-US
 * (el que fija `vitest.config.ts` para toda la suite):
 *
 *     resolveLocale()               → 'en-US'
 *     languageOfLocale(resolveLocale()) → 'en'
 *     getLanguage()                 → 'es'      ← el catálogo, ajeno
 *     t('prepaid_no_live_schedule') → 'No hay ningún calendario vivo…'
 *
 * y cambiar el locale del proceso a es-MX a mitad de corrida no movía ninguna
 * de las dos últimas líneas. Las cuarenta pruebas de este archivo estaban en
 * verde mientras tanto: §5 y §8 siempre NOMBRABAN el idioma al llamar a `t()`,
 * así que ninguna llegaba a preguntar de dónde salía cuando no se nombra.
 *
 * De ahí la forma de esta sección: nada de lo que hay aquí pasa el tercer
 * argumento de `t()`. Lo que se mide es la omisión.
 */
describe('el idioma activo se deriva del locale, y se mueve con él', () => {
  const ARGV_OUTSIDE = process.argv;
  const LOCALE_OUTSIDE = process.env[LOCALE_ENV_VAR];

  beforeEach(() => {
    // `--locale` GANA a la variable de entorno. Si quien corre la suite la
    // pasara —o si el corredor metiera algo parecido en `process.argv`— esta
    // sección estaría midiendo su línea de comandos en vez del cambio que ella
    // misma provoca, y el verde no querría decir nada.
    process.argv = ['node', 'vitest'];
    resetLanguage();
  });

  afterEach(() => {
    process.argv = ARGV_OUTSIDE;
    if (LOCALE_OUTSIDE === undefined) delete process.env[LOCALE_ENV_VAR];
    else process.env[LOCALE_ENV_VAR] = LOCALE_OUTSIDE;
    resetLanguage();
  });

  it('la MISMA clave sale en dos idiomas al mover el locale, en una sola corrida', () => {
    // El corazón del asunto. El módulo lleva importado desde la cabecera de
    // este archivo, muchas pruebas atrás: si el idioma se decidiera al
    // importar, estas dos llamadas darían la misma cadena.
    process.env[LOCALE_ENV_VAR] = 'es-MX';
    const spanish = t('prepaid_no_live_schedule');

    process.env[LOCALE_ENV_VAR] = 'en-US';
    const english = t('prepaid_no_live_schedule');

    expect(spanish).toBe(ES.prepaid_no_live_schedule);
    expect(english).toBe(EN.prepaid_no_live_schedule);
    expect(spanish, 'el locale cambió y `t()` no se enteró').not.toBe(english);
  });

  it('getLanguage() sigue al locale, y no al primer renglón de LANGUAGES', () => {
    // Esta es la que caía antes con el mensaje más claro: `getLanguage()`
    // devolvía 'es' con el proceso puesto en en-US.
    process.env[LOCALE_ENV_VAR] = 'en-US';
    expect(getLanguage()).toBe('en');
    process.env[LOCALE_ENV_VAR] = 'es-MX';
    expect(getLanguage()).toBe('es');
  });

  it('para cada locale que existe, el idioma es el que proyecta languageOfLocale', () => {
    // Recorre LOCALES, así que un tercer locale no cuesta un renglón aquí.
    // Lo que ESTO prueba y lo de arriba no: que el idioma sale del resolutor y
    // de su proyección, y no de una tabla `es-MX → es` copiada dentro del
    // catálogo. Dos tablas del mismo dato es el defecto de origen de I6.
    for (const locale of LOCALES) {
      process.env[LOCALE_ENV_VAR] = locale;
      expect(getLanguage(), `con el proceso en ${locale}`).toBe(
        languageOfLocale(resolveLocale()),
      );
    }
  });

  it('setLanguage() clava el idioma, y resetLanguage() lo vuelve a soltar', () => {
    process.env[LOCALE_ENV_VAR] = 'en-US';
    expect(getLanguage()).toBe('en');

    setLanguage('es');
    expect(getLanguage(), 'clavado: el entorno ya no manda').toBe('es');
    process.env[LOCALE_ENV_VAR] = 'es-MX';
    setLanguage('en');
    expect(t('prepaid_no_live_schedule')).toBe(EN.prepaid_no_live_schedule);

    resetLanguage();
    expect(getLanguage(), 'soltado: vuelve a mandar el entorno').toBe('es');
  });

  it('un locale inservible avisa UNA vez, no una por mensaje', () => {
    // Derivar en cada llamada multiplica también los avisos: sin la
    // deduplicación de `index.ts`, cinco mensajes traían cinco veces el mismo
    // renglón, y una pantalla de cuarenta líneas lo traía cuarenta veces. Se
    // cuentan sólo los avisos que hablan de ESTE valor, para que un
    // `~/.mnemosine/config.json` roto en la máquina de alguien no decida si la
    // prueba pasa.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      process.env[LOCALE_ENV_VAR] = 'pt-BR';
      for (let i = 0; i < 5; i += 1) {
        expect(t('prepaid_no_live_schedule')).not.toBe('');
      }
      const aboutThisValue = warn.mock.calls.filter(([line]) =>
        String(line).includes('pt-BR'),
      );
      expect(aboutThisValue, 'el aviso se repitió una vez por mensaje').toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('la bandera llega hasta `t()`, y en las DOS direcciones', () => {
    // `--locale` no la mira `index.ts` —§7 le prohíbe nombrar `process`—, la
    // mira `locale.ts`; que aun así mande sobre `t()` es la prueba de que el
    // catálogo PREGUNTA en vez de leer. Y se comprueba en los dos sentidos a
    // propósito: con una sola dirección, un idioma congelado en el valor
    // esperado pasaría esta prueba sin que nada funcionara. Medido: escrita en
    // un solo sentido, pasaba en verde contra el defecto revertido.
    process.env[LOCALE_ENV_VAR] = 'es-MX';
    process.argv = ['node', 'mnemosine', LOCALE_FLAG, 'en-US'];
    expect(t('prepaid_no_live_schedule'), 'la bandera no le ganó al entorno').toBe(
      EN.prepaid_no_live_schedule,
    );

    process.env[LOCALE_ENV_VAR] = 'en-US';
    process.argv = ['node', 'mnemosine', `${LOCALE_FLAG}=es-MX`];
    expect(t('prepaid_no_live_schedule'), 'la bandera no le ganó al entorno').toBe(
      ES.prepaid_no_live_schedule,
    );
  });
});

// ---- §9 · El analizador, por dentro ---------------------------------

describe('messageParameters lee la gramática entera', () => {
  it('no encuentra nada en un mensaje sin huecos', () => {
    expect(messageParameters('Sin cambios: el mayor no se tocó.')).toEqual([]);
  });

  it('distingue valor, plural y select', () => {
    expect(messageParameters('{a} {b, plural, other {#}} {c, select, other {x}}')).toEqual([
      { name: 'a', kind: 'value', branches: [] },
      { name: 'b', kind: 'plural', branches: ['other'] },
      { name: 'c', kind: 'select', branches: ['other'] },
    ]);
  });

  it('entra en las ramas que no se imprimirían', () => {
    // Un parámetro que sólo vive dentro de `one` es igual de obligatorio que
    // uno del cuerpo: si el recorrido no entrara, la comparación entre idiomas
    // no vería la mitad de los huecos.
    const found = messageParameters('{n, plural, one {sólo {name}} other {#}}');
    expect(found.map((p) => p.name)).toEqual(['n', 'name']);
  });

  it('rechaza un mensaje sin rama other', () => {
    expect(() => messageParameters('{n, plural, one {#}}', 'probe')).toThrowError(/"other"/);
  });

  it('rechaza una llave sin cerrar y una de más', () => {
    expect(() => messageParameters('hola {name', 'probe')).toThrowError(/closing brace/);
    expect(() => messageParameters('hola {name}}', 'probe')).toThrowError(/unbalanced/);
  });

  it('rechaza una clase de parámetro que no existe', () => {
    // `{amount, number}` es el error que este tramo tiene que impedir: el
    // formato no es cosa del idioma.
    expect(() => messageParameters('{amount, number, other {x}}', 'probe')).toThrowError(
      /format\.ts/,
    );
  });

  it('rechaza un nombre de parámetro que nadie podría pasar', () => {
    expect(() => messageParameters('quedan {co unt} filas', 'probe')).toThrowError(
      /not a usable parameter name/,
    );
  });

  it('rechaza una rama repetida', () => {
    expect(() => messageParameters('{n, plural, other {a} other {b}}', 'probe')).toThrowError(
      /twice/,
    );
  });
});

// ---- §10 · La elección de rama --------------------------------------

describe('plural.ts elige la rama', () => {
  it('pluralCategory usa las reglas del idioma', () => {
    expect(pluralCategory('es', 1)).toBe('one');
    expect(pluralCategory('es', 2)).toBe('other');
    expect(pluralCategory('en', 1)).toBe('one');
    expect(pluralCategory('en', 0)).toBe('other');
  });

  it('una etiqueta rota no tumba el CLI', () => {
    expect(pluralCategory('no es una etiqueta', 1)).toBe('one');
    expect(pluralCategory('es', Number.NaN)).toBe('other');
  });

  it('la coincidencia exacta gana a la categoría', () => {
    const branches = new Map([
      ['=1', 'exacta'],
      ['one', 'categoría'],
      ['other', 'resto'],
    ]);
    expect(choosePluralBranch(branches, 'es', 1)).toBe('exacta');
    expect(choosePluralBranch(branches, 'es', 9)).toBe('resto');
  });

  it('sin categoría se cae en other, y sin other en undefined', () => {
    expect(choosePluralBranch(new Map([['other', 'resto']]), 'es', 1)).toBe('resto');
    expect(choosePluralBranch(new Map([['one', 'uno']]), 'es', 9)).toBeUndefined();
  });

  it('chooseSelectBranch compara el código, no el idioma', () => {
    const branches = new Map([
      ['coverage_ended', 'terminó'],
      ['other', 'resto'],
    ]);
    expect(chooseSelectBranch(branches, 'coverage_ended')).toBe('terminó');
    expect(chooseSelectBranch(branches, 'lo_que_sea')).toBe('resto');
    expect(chooseSelectBranch(new Map([['a', 'x']]), 'b')).toBeUndefined();
  });
});

// ---- §11 · El tipo de un catálogo ------------------------------------

describe('la forma del catálogo', () => {
  it('CATALOGS entrega catálogos, no copias sueltas', () => {
    const catalog: Catalog = CATALOGS.es;
    expect(catalog).toBe(ES);
    expect(CATALOGS.en).toBe(EN);
  });
});
