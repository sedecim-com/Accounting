// ============================================================
// Una sola gramática de «sí» para todos los prompts [y/N].
//
// Antes de este módulo había OCHO predicados distintos detrás del
// mismo prompt, y la correlación iba en la peor dirección: las hojas
// irreversibles (entry post, invoice void, payment create) exigían
// «y»/«yes» a secas y rechazaban el «si» de un despacho que trabaja
// en español, mientras que la ÚNICA compuerta que aceptaba de más era
// el cierre de periodo: su /^y|^s/i anclaba cada alternativa por
// separado, así que cualquier palabra que empezara con s o con y
// contaba como consentimiento. «salir» —que además es el alias en
// español que este CLI define para logout—, «stop», «sale» y hasta
// «seguro que no» CERRABAN EL PERIODO. Un usuario que intentaba irse
// firmaba el cierre.
//
// De ahí las dos reglas de esta gramática:
//   1. ANCLADA: la respuesta completa es el token, nunca su inicial.
//   2. BILINGÜE Y SIN ACENTOS OBLIGATORIOS: y/yes/s/si/sí valen igual,
//      en cualquier mezcla de mayúsculas, porque el prompt dice [y/N]
//      pero el usuario contesta en el idioma en el que piensa.
//
// Todo predicado de confirmación del CLI debe salir de aquí; el censo
// de tests/cli/confirmacion-gramatica.spec.ts acusa cualquier regex o
// comparación de confirmación que reaparezca fuera de este módulo.
// ============================================================

/** Minúsculas y sin marcas diacríticas: «SÍ» y «si» son la misma respuesta. */
const normaliza = (respuesta: string): string =>
  respuesta
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

const AFIRMATIVAS = new Set(['y', 'yes', 's', 'si']);
const NEGATIVAS = new Set(['n', 'no']);

/**
 * ¿La respuesta es un sí? Sólo el token completo cuenta: «salir»
 * empieza con s y aun así NO es un sí. EOF (null) jamás lo es.
 */
export function esAfirmativa(respuesta: string | null | undefined): boolean {
  if (respuesta == null) return false;
  return AFIRMATIVAS.has(normaliza(respuesta));
}

/**
 * ¿La respuesta es un no explícito o el default del prompt [y/N]?
 * Vacío y EOF cuentan como no: el default anunciado es N, y una stdin
 * cerrada nunca debe leerse como consentimiento.
 */
export function esNegativa(respuesta: string | null | undefined): boolean {
  if (respuesta == null) return true;
  const t = normaliza(respuesta);
  return t === '' || NEGATIVAS.has(t);
}

/**
 * Lo que se le dice a un contador cuando su respuesta no fue ni sí ni
 * no. «Aborted.» a secas se lee como un rechazo contable; esto nombra
 * lo que no se entendió y enseña las teclas.
 */
export const noEntendi = (respuesta: string): string =>
  `no entendí «${respuesta}»: responde y/s para sí, n para no`;

/** Veredicto de una confirmación con derecho a una repregunta. */
export interface VeredictoConfirmacion {
  si: boolean;
  /** Presente cuando el no final vino de una respuesta incomprensible. */
  incomprendida?: string;
}

/**
 * Pregunta una vez; si la respuesta no es ni sí ni no, explica qué no
 * entendió y repregunta UNA vez antes de rendirse. La repregunta es
 * deliberadamente única: un prompt que insiste sin límite frente a una
 * stdin que repite basura es un ciclo infinito en un cron.
 */
export async function confirmarConReintento(
  preguntar: (prompt: string) => Promise<string | null>,
  prompt: string
): Promise<VeredictoConfirmacion> {
  const primera = await preguntar(prompt);
  if (esAfirmativa(primera)) return { si: true };
  if (esNegativa(primera)) return { si: false };

  const segunda = await preguntar(`${noEntendi((primera ?? '').trim())}\n${prompt}`);
  if (esAfirmativa(segunda)) return { si: true };
  if (esNegativa(segunda)) return { si: false };
  return { si: false, incomprendida: (segunda ?? '').trim() };
}
