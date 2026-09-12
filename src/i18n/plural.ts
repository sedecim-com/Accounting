// ============================================================
// QUÉ RAMA SE IMPRIME: PLURAL Y SELECT (I6 · issue #148)
//
// CERO DEPENDENCIAS NUEVAS (D11). Un catálogo con plural pide, por reflejo, un
// `intl-messageformat` o un `i18next`. No entra ninguno: la parte de esto que
// de verdad es difícil —cuántas categorías tiene un idioma y en cuál cae un
// número— la trae el motor desde hace años en `Intl.PluralRules`, y lo que
// falta son las treinta líneas de este archivo. Medido en el Node de este
// árbol: `new Intl.PluralRules('es-MX').select(1)` da 'one' y `.select(2)` da
// 'other', y el ICU es completo (`new Intl.NumberFormat('ar-EG').format(1234)`
// devuelve cifras árabes), así que no hace falta `full-icu` para esto.
//
// LA CATEGORÍA LA DECIDE EL IDIOMA, NO LA JURISDICCIÓN. Es la regla 5 del epic
// partida por su costura menos evidente: el separador de miles de una entidad
// mexicana es cosa de México, pero si el operador leyó su CLI en inglés, «2
// rows» se pluraliza con las reglas del inglés. Por eso la entrada de aquí es
// una etiqueta de IDIOMA y jamás el `formatLocale` de la entidad.
//
// EL REPARTO CON `index.ts`: aquí se elige la rama, allí se analiza el mensaje
// y se interpola. Separados porque son dos defectos distintos —una rama mal
// elegida imprime la frase equivocada; un análisis mal hecho imprime `{count}`
// en pantalla— y cada uno se prueba solo.
// ============================================================

/**
 * Las seis categorías del CLDR. `Intl.PluralRules.select` no devuelve otra
 * cosa, pero su tipo declarado es `Intl.LDMLPluralRule`, y esta lista es la que
 * la prueba recorre para comprobar que ninguna rama de los catálogos se llama
 * como una categoría inexistente.
 */
export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;

export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

/**
 * Un `Intl.PluralRules` por idioma. No es una micro-optimización: construirlo
 * cuesta lo que cuesta cargar los datos del idioma, y `t()` se llama una vez
 * por renglón impreso — una tabla de mil movimientos lo pagaría mil veces.
 */
const RULES_BY_LANGUAGE = new Map<string, Intl.PluralRules>();

function rulesFor(language: string): Intl.PluralRules {
  const cached = RULES_BY_LANGUAGE.get(language);
  if (cached) return cached;
  let rules: Intl.PluralRules;
  try {
    rules = new Intl.PluralRules(language);
  } catch {
    // Una etiqueta mal formada —`'espanol'`, una variable de entorno con una
    // coma dentro— hace que el constructor lance un RangeError. Reventar aquí convertiría un
    // ajuste de entorno en un CLI que no arranca, así que se cae al inglés, que
    // es el idioma de las reglas más simples, y se sigue imprimiendo.
    rules = new Intl.PluralRules('en');
  }
  RULES_BY_LANGUAGE.set(language, rules);
  return rules;
}

/**
 * La categoría CLDR de `count` en `language`. `NaN` e `Infinity` caen en
 * 'other': llegan de un `Number('')` o de una división por cero río arriba, y
 * la respuesta útil no es una excepción en mitad de una tabla sino la rama que
 * todo mensaje tiene obligada.
 */
export function pluralCategory(language: string, count: number): PluralCategory {
  if (!Number.isFinite(count)) return 'other';
  // Sin aserción, y eso es una comprobación gratis: `select` devuelve
  // `Intl.LDMLPluralRule`, y que asigne a `PluralCategory` prueba que la lista
  // de arriba —la que la prueba de sincronía recorre— no se ha quedado corta.
  // El día que el CLDR añada una categoría, `tsc` lo dirá aquí.
  return rulesFor(language).select(count);
}

/**
 * La rama de un `{n, plural, ...}`, en el orden que manda el CLDR:
 *
 *   1. la coincidencia EXACTA `=0` / `=1`, que gana siempre. Es la que deja
 *      escribir «ningún calendario» sin inventar una categoría 'zero' que el
 *      español no tiene.
 *   2. la categoría del idioma ('one', 'other', y en otros idiomas 'few' o
 *      'many').
 *   3. 'other', que `index.ts` exige que exista en todo mensaje.
 *
 * Devuelve `undefined` cuando no hay ninguna de las tres, y no lanza: quien
 * llama sabe la clave del catálogo y puede decirlo en el error; aquí sólo se
 * conoce el mapa de ramas.
 */
export function choosePluralBranch(
  branches: ReadonlyMap<string, string>,
  language: string,
  count: number,
): string | undefined {
  const exact = branches.get(`=${count}`);
  if (exact !== undefined) return exact;
  const byCategory = branches.get(pluralCategory(language, count));
  if (byCategory !== undefined) return byCategory;
  return branches.get('other');
}

/**
 * La rama de un `{n, select, ...}`: coincidencia literal, o 'other'.
 *
 * Sin categorías y sin idioma, a propósito. Un `select` reparte por un valor
 * del dominio —la causa por la que un renglón de anticipado no entra a la
 * corrida, `prepaid-command.ts:374-380`— y ese valor es un CÓDIGO, no prosa:
 * comparar con las reglas de un idioma haría que la misma causa cayera en
 * ramas distintas según quién esté mirando.
 */
export function chooseSelectBranch(
  branches: ReadonlyMap<string, string>,
  value: string,
): string | undefined {
  const exact = branches.get(value);
  if (exact !== undefined) return exact;
  return branches.get('other');
}
