// ============================================================
// LOS INSTRUMENTOS MIDEN LA FUENTE INGLESA, NO EL RENDER
// (I7 · issue #149 · regla 6 del epic #141)
//
// I7 (issue #149) pone la descripción de cada comando y el cromo de commander
// a rendirse POR CLAVE en el locale que resuelva `describeLocale`
// (src/i18n/locale.ts), de modo que el MISMO binario pueda imprimir «Usage:» o
// «Uso:». Dos guiones de `scripts/` leen esa prosa y publican un número o un
// fichero versionado a partir de ella:
//
//   · `scripts/ux-status.ts` cuenta seis cosas sobre las hojas y los nodos del
//     árbol —229 y 311 al escribir esto; el propio censo publica las dos—, y
//     una se llama literalmente `nodos-fuera-del-idioma-canonico`, con línea
//     base 7. Ese 7 es el recuento de nodos con castellano dentro de un árbol
//     INGLÉS.
//
//     Y AQUÍ HAY QUE SER EXACTO, PORQUE LA VERSIÓN ANTERIOR DE ESTE PÁRRAFO NO
//     LO ERA: decía que medido sobre el árbol en español el censo se pondría
//     rojo contra un binario correcto, y HOY NO SE MUEVE. Construido el árbol
//     en es-MX y en en-US, las SEIS cifras salen idénticas —7 incluido—, porque
//     `censar` lee la descripción GUARDADA en el objeto de Commander y
//     `kernel/help.ts` guarda ahí el inglés (`englishOf`) y traduce sólo el
//     renderizado. Se comprueba importando `program` antes y después de este
//     módulo y comparando las dos salidas de `censar`. Para el censo, entonces,
//     esto es blindaje y no reparación: lo que hoy lo protege es la decisión de
//     guardar inglés, que vive en otro archivo y que nadie obliga a mantener.
//   · `scripts/generate-cli-reference.ts` escribe `src/ai/docs/cli-reference.md`,
//     que va al repositorio y que el agente lee bajo la orden «never invent a
//     flag that is not listed here». Generado en el idioma de quien corrió el
//     guion, ese fichero cambia ENTERO según la máquina y el commit siguiente
//     lo devolvería. Aquí no hay nada hipotético y está medido: construido el
//     árbol en es-MX, el documento difiere en TODAS sus secciones —las 311 que
//     encabeza un `#`, o sea 310 comandos más la raíz—, porque el generador sí
//     pasa por `outputHelp`, y ahí el cromo se rinde traducido. Ya pasó con el
//     ANCHO de la ayuda —está contado en `ANCHO_CANONICO`— y la respuesta es la
//     misma: se fija lo que no puede depender del entorno.
//
// LO QUE SE PUEDE MEDIR HOY Y LO QUE NO, porque la diferencia es toda la
// honestidad de este archivo. EL ÁRBOL YA IMPRIME EN DOS IDIOMAS —lo entregó
// este mismo tramo—: medido hoy, `npx tsx src/cli/mnemosine.ts bank --help` con
// el entorno limpio empieza por «Uso:» y con `--locale en-US` por «Usage:», y
// las dos pantallas difieren en diez renglones. La versión anterior de este
// párrafo afirmaba lo contrario —«el árbol imprime «Usage:» con cualquier
// locale»— y se quedó escrita después de dejar de ser verdad.
//
// Correr los dos guiones con MNEMOSINE_LOCALE=es-MX SÍ da byte por byte lo
// mismo que con el entorno limpio —comprobado: el `cli-reference.md` sale
// idéntico—, pero eso es el EFECTO de este archivo y no una propiedad del
// kernel: lo produce la asignación de abajo. Lo que SÍ
// está medido es el mecanismo: con MNEMOSINE_LOCALE=es-MX en el entorno, un
// gancho en `require.extensions['.ts']` enseña que al empezar a ejecutarse
// src/cli/mnemosine.ts el locale vigente ya es en-US cuando se llega por
// cualquiera de los dos guiones — y que cargando mnemosine.ts a pelo, con el
// mismo entorno, es es-MX.
//
// POR QUÉ ESTO ES UN MÓDULO APARTE Y NO DOS LÍNEAS EN CADA GUION. Los
// `import` se IZAN: una asignación a `process.env` escrita ARRIBA DEL TODO,
// antes del `import`, se ejecuta DESPUÉS de él. Medido en este árbol con tsx:
// un módulo que lee la variable al cargarse la ve sin poner. Y el árbol de
// commander se construye AL CARGAR src/cli/mnemosine.ts (`program.name(...)`
// y las familias están en el cuerpo del módulo), así que el idioma de TODAS
// sus pantallas queda decidido dentro de ese `import`. Lo único que corre antes de
// un `import` es OTRO `import`: de ahí este archivo. Quien lo use tiene que
// nombrarlo ANTES de nombrar a mnemosine.js, y así está escrito allí.
//
// SE FIJA LA VARIABLE Y NO LA BANDERA, y la diferencia importa:
//
//  · La variable gana a TODO lo que es de la MÁQUINA: ~/.mnemosine/config.json,
//    ./mnemosine.config.json, la clave vieja `language`, el inquilino y el
//    último escalón es-MX (`DEFAULT_LOCALE`). Ésos son los escalones que hacen
//    que dos contadores midan distinto el mismo árbol, y son los que este
//    archivo calla.
//  · `--locale` en la línea de órdenes sigue por ENCIMA, y se deja a
//    propósito. Pisar en silencio una bandera que un humano acaba de teclear
//    es peor que el defecto. Y ninguno de los dos pasa callando, porque
//    `assertEnglishHelp` lo atrapa: MEDIDO HOY, `npx tsx scripts/ux-status.ts
//    --check --locale es-MX` y `npx tsx scripts/generate-cli-reference.ts
//    --locale es-MX` mueren los dos con código 1 y el mensaje de esa guarda; el
//    censo no publica ninguna cifra y el `.md` no se toca. Sin la guarda, el
//    generador habría reescrito las 311 secciones del documento —todas—.
//  · NO se toca `process.argv`. Estos módulos se importan también desde las
//    pruebas, y ahí el argv es del corredor, no del instrumento.
//
// LO QUE NO ARREGLA, dicho porque parece que sí: no hace determinista el
// FORMATO del dinero ni de las fechas. `formatMoney` (src/i18n/format.ts) no
// lee este dial —el separador, el símbolo y el orden de la fecha salen de la
// JURISDICCIÓN de la entidad—, así que una ayuda con cifras de ejemplo no se
// estabiliza con esta línea.
//
// Y HAY UN CAMINO EN EL QUE LLEGA TARDE, que es justo el que no le hace falta:
// bajo vitest, tests/cli/censo-superficie.spec.ts y
// tests/docs/generador-de-referencia.spec.ts importan `program` por su cuenta
// ANTES de importar el guion, así que el árbol ya está construido cuando esto
// corre. Ahí el idioma lo garantiza `vitest.config.ts`, que arranca la suite
// con MNEMOSINE_LOCALE=en-US. Este archivo cubre el camino del INSTRUMENTO
// —`npm run ux:status`, `npx tsx scripts/generate-cli-reference.ts`—, donde no
// hay corredor de pruebas que lo cubra.
// ============================================================
import type { Command } from 'commander';
import { LOCALE_ENV_VAR, type Locale } from '../src/i18n/locale.js';

/** El locale en el que miden los instrumentos de `scripts/`. */
export const MEASURED_LOCALE: Locale = 'en-US';

// EL EFECTO. Va aquí, en el cuerpo del módulo, porque tiene que ocurrir por el
// hecho de IMPORTARLO: si hubiera que llamar a una función, la llamada sería
// una sentencia y volvería a quedar por debajo del `import` de mnemosine.js.
process.env[LOCALE_ENV_VAR] = MEASURED_LOCALE;

/**
 * Muere si el árbol NO se construyó en inglés.
 *
 * Es el seguro del seguro, y existe por una fragilidad concreta y nombrada:
 * lo de arriba depende del ORDEN de dos `import`, y un día alguien puede
 * reordenarlos (hoy no hay regla de lint que los ordene sola —comprobado en
 * eslint.config.mjs—, pero un editor sí). Si eso pasa, sin esto el censo
 * publicaría un número falso y el generador escribiría un documento en
 * español, los dos en silencio y con código 0. Con esto se para y lo dice.
 *
 * Mide `Usage:`, el cromo que commander pone en la primera línea de toda
 * ayuda, porque es lo único que se puede comprobar sin conocer ni una sola
 * clave del catálogo.
 *
 * QUÉ HACE, MEDIDO HOY: FALLA CUANDO TIENE QUE FALLAR. Con los dos `import` al
 * revés —mnemosine.js primero— y el entorno limpio, la ayuda de la raíz empieza
 * por «Uso:» y esta función lanza; con el orden correcto, pasa. Y atrapa
 * también el otro camino, el de la bandera: `--locale es-MX` gana a la variable
 * que este módulo fija, y la guarda para la corrida entera.
 *
 * ESTE PÁRRAFO DECÍA ANTES «HOY NO PUEDE FALLAR», y era verdad mientras el
 * kernel imprimía «Usage:» con cualquier locale. Dejó de serlo en este mismo
 * tramo y el párrafo se quedó escrito: se corrige aquí midiendo, que es la
 * única forma de que un comentario así no vuelva a envejecer callado.
 *
 * LO QUE SIGUE SIN CUBRIR: mira la PRIMERA línea de la raíz y nada más. Un
 * árbol con el cromo en inglés y las descripciones en español pasaría igual.
 */
export function assertEnglishHelp(root: Command): void {
  const help = root.helpInformation();
  if (help.startsWith('Usage:')) return;
  throw new Error(
    'El árbol del CLI no se construyó en inglés: la ayuda de la raíz empieza por ' +
      `«${help.slice(0, 24).trim()}…» y no por «Usage:». Este instrumento mide la fuente ` +
      'inglesa, así que se para en vez de publicar la medida. Causa probable: el ' +
      "`import './english-locale.js'` dejó de ir ANTES del import de mnemosine.js, o " +
      `alguien fijó ${LOCALE_ENV_VAR} después de cargar el CLI.`
  );
}
