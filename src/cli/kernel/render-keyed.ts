import { EN } from '../../i18n/en.js';
import { getLanguage, t, type Language, type TranslationKey } from '../../i18n/index.js';
import type { KeyedMessage } from './exit.js';

// ============================================================
// RENDIR UN MENSAJE ESCRITO POR CLAVE
//
// POR QUÉ VIVE AQUÍ Y NO EN `exit.ts`, que es donde nació.
//
// `exit.ts` lo importa el arnés de evaluación ANTES del global-setup, así que
// cualquier dependencia suya se carga antes de que exista la base efímera y
// puede armar el pool con la DATABASE_URL equivocada. Lo vigila
// `tests/ai/eval/arnes-cableado.spec.ts`, y cuenta CUALQUIER `import` —también
// los de sólo tipo—, porque lo que importa no es si el tipo se borra al
// compilar sino que el archivo no tenga a quién cargar.
//
// I7 rompió esa invariante al hacer que `CliError` se rindiera por clave. El
// reparto correcto es el de siempre: el error LLEVA el dato (`{key, params}`,
// declarado en `exit.ts` sin importar nada) y quien lo RINDE es este archivo,
// que sí puede depender del catálogo porque nadie lo carga temprano.
// ============================================================

/**
 * LA CLAVE SE COMPRUEBA AL RENDIR, y aquí está el precio de la invariante.
 *
 * `KeyedMessage.key` es `string` y no `TranslationKey`, porque estrechar el
 * tipo allí habría exigido el import que `exit.ts` no puede tener. Eso mueve
 * la comprobación del compilador al tiempo de ejecución, así que se hace de
 * verdad en vez de con un `as`: una clave que no está en el catálogo se acusa
 * con su nombre en lugar de imprimir la clave cruda al usuario, que es como
 * estas cosas llegan a producción sin que nadie las vea.
 */
function known(key: string): TranslationKey {
  if (!(key in EN)) {
    // En inglés y no en español: es un error de PROGRAMADOR —una clave que
    // no existe—, no un mensaje para el contador, y lo nuevo nace en inglés.
    throw new Error(`i18n: "${key}" is not in the catalog, so there is nothing to render`);
  }
  return key as TranslationKey;
}

/** La frase y sus renglones, en el idioma que se pida (por omisión, el activo). */
export function renderKeyed(message: KeyedMessage, language?: Language): string {
  const target = language ?? getLanguage();
  const head = t(known(message.key), message.params ?? {}, target);
  const rest = (message.lines ?? []).map(
    (line) => `${line.prefix ?? ''}${t(known(line.key), line.params ?? {}, target)}`
  );
  return [head, ...rest].join('\n');
}
