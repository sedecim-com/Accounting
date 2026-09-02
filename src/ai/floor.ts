import Decimal from 'decimal.js';

// ============================================================
// THE UNBREAKABLE FLOOR
//
// Hard safety limits enforced in CODE at the call sites — never
// in the prompt, never in configuration. No thresholds file,
// stored approval policy, CLI flag, or future "always-approve"
// rule may raise them: configuration is always combined with the
// floor via Math.min (stricter wins), never Math.max.
//
// Floor rules and where they are enforced:
//   1. floorMaxAutoAmount — ingest-service auto-post path: an
//      entry above FLOOR_MAX_AUTO_POST is NEVER posted without a
//      human in the loop, regardless of configured thresholds.
//   2. Open fiscal period — draft-service approveDraft: the
//      DB-checked rule (validateDraftPayload re-runs under the
//      row lock; posting into a closed/locked period is refused
//      by the engine as well). See the FLOOR marker there.
//   3. isOpStale — external-service executeExternalOp: an outbox
//      operation queued more than FLOOR_MAX_OP_AGE_DAYS ago is
//      refused; a stale approval must be re-queued and re-reviewed.
//   4. floorTolerancia — reconciliation-service criteriosDeCierre:
//      `bank reconciliation close --tolerance` cannot exceed
//      FLOOR_MAX_TOLERANCIA_CONCILIACION, so no flag can close an
//      arbitrary mismatch by calling it a tolerance.
//
// Keep this module small and dependency-free: pure functions the
// call sites cannot accidentally bypass via configuration. The one
// import is decimal.js, a value library with no I/O: money is a
// string here as everywhere else, and comparing two amounts with
// `<` on floats would put a rounding error inside the floor itself.
// ============================================================

/**
 * Hard cap (in the entity's functional currency) for auto-posting
 * without a human in the loop. Config caps ABOVE this are clamped.
 */
export const FLOOR_MAX_AUTO_POST = 50000;

/**
 * Maximum age, in days, of a queued external operation at execution
 * time. Older approvals are stale: the world (and the review) may no
 * longer match the payload.
 */
export const FLOOR_MAX_OP_AGE_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Effective auto-post amount cap: the configured cap clamped by the
 * floor. A non-finite or negative configured value fails CLOSED
 * (returns 0 — nothing auto-posts), never open.
 */
export function floorMaxAutoAmount(configuredMax: number): number {
  if (!Number.isFinite(configuredMax) || configuredMax < 0) return 0;
  return Math.min(configuredMax, FLOOR_MAX_AUTO_POST);
}

/**
 * True when an external operation queued at `createdAt` is too old to
 * execute (strictly more than FLOOR_MAX_OP_AGE_DAYS days ago). An
 * unparseable timestamp counts as stale: the floor fails closed.
 */
export function isOpStale(createdAt: Date | string, now: Date = new Date()): boolean {
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) return true;
  return now.getTime() - created.getTime() > FLOOR_MAX_OP_AGE_DAYS * MS_PER_DAY;
}

/**
 * A4 · «Medir antes de soltar», con números: encender ingest_auto_post='on'
 * exige un historial de SOMBRA con al menos estos días distintos, este
 * acuerdo sombra-vs-humano y estos veredictos decididos. Son PISO, no
 * configuración: la doctrina que ordena estos sprints hecha invariante —
 * un despacho puede medir MÁS tiempo, nunca menos.
 */
export const FLOOR_SOMBRA_DIAS = 7;
export const FLOOR_SOMBRA_ACUERDO = 0.9;
export const FLOOR_SOMBRA_VEREDICTOS = 10;

/**
 * A5 · EL TECHO DE LA TOLERANCIA DE CONCILIACIÓN, en la moneda de la cuenta.
 *
 * `bank reconciliation close --tolerance` nació SIN TOPE. Con la política
 * `conciliacion_tolerancia` en `tolerancia_con_residual`, nada acotaba cuánto
 * podía valer la tolerancia que llega por bandera: se podía cerrar CUALQUIER
 * descuadre llamándolo tolerancia. Y una sesión cerrada no es una nota interna
 * — `period-close.ts` lee `status IN ('balanced','approved','posted')` como la
 * evidencia de que el efectivo de esa cuenta se verificó contra el banco. Un
 * control que la línea de comandos puede aflojar hasta cubrir justo el error
 * que existe para descubrir no es un control: es un formulario.
 *
 * ES PISO Y NO CONFIGURACIÓN, por la misma razón que `FLOOR_MAX_AUTO_POST`: el
 * despacho puede exigir MÁS —bajar la tolerancia, o dejar la política en
 * `cero_exacto`, que es el default—, nunca menos. Y se combina por el MÍNIMO
 * (`Decimal.min`), jamás por el máximo: una regla que se combina por el máximo
 * no es un piso, es una sugerencia con nombre de piso.
 *
 * EL NÚMERO, y por qué éste. 500 es el orden de magnitud de una comisión
 * bancaria, que es la cosa más grande que aparece de rutina en un extracto sin
 * estar en libros. Por debajo, un residual es polvo de redondeo. Por encima es
 * un HALLAZGO, y un hallazgo se arrastra como partida conciliatoria con nombre,
 * responsable y fecha esperada —que es literalmente lo que la opción
 * `tolerancia_con_residual` promete en el panel— en vez de enterrarse detrás de
 * una bandera que nadie vuelve a leer.
 *
 * LA MONEDA, dicho en voz alta: es una magnitud en la moneda de la cuenta que
 * se concilia, con la misma limitación declarada que `FLOOR_MAX_AUTO_POST`.
 * Convertir exigiría un tipo de cambio a la fecha de cierre, y este módulo no
 * consulta nada a propósito — un piso que depende de una lectura es un piso que
 * se cae cuando la lectura falla.
 */
export const FLOOR_MAX_TOLERANCIA_CONCILIACION = '500.0000';

/**
 * La tolerancia efectiva: la pedida, acotada por el techo. Devuelve una CADENA
 * con los cuatro decimales que guardan las columnas de dinero.
 *
 * FALLA CERRADO, como el resto del módulo: lo ilegible, lo no finito y lo
 * negativo devuelven `'0.0000'` —tolerancia cero, o sea variación exactamente
 * cero—, nunca el techo y nunca lo que llegó. Un `Number('')` daría 0 y un
 * `parseFloat('1e400')` daría Infinity; las dos formas son exactamente cómo un
 * campo mal capturado se convierte en un cuadre falso.
 */
export function floorTolerancia(configurada: string): string {
  let pedida: Decimal;
  try {
    pedida = new Decimal(configurada);
  } catch {
    return '0.0000';
  }
  if (!pedida.isFinite() || pedida.isNegative()) return '0.0000';

  // Y LO QUE NO CABE EN UNA COLUMNA DE DINERO TAMPOCO ES DINERO.
  //
  // El docblock de arriba nombraba `1e400` como uno de los casos que tienen
  // que dar cero, y no lo daba: `isFinite()` es de coma flotante, pero
  // decimal.js NO usa coma flotante — su exponente llega mucho más lejos, así
  // que `1e400` es un Decimal perfectamente finito y la guarda no se disparaba.
  // El valor caía en `Decimal.min` y salía el TECHO: un campo mal capturado se
  // convertía en la tolerancia más permisiva que la ley permite, que es lo
  // contrario de fallar cerrado.
  //
  // El criterio correcto no es la finitud sino la REPRESENTABILIDAD: una
  // tolerancia es un importe, los importes viven en DECIMAL(19,4), y quince
  // dígitos enteros es el límite. Lo que no cabe ahí no es una tolerancia
  // grande — es un error de captura o un ataque, y las dos cosas valen cero.
  if (pedida.abs().greaterThanOrEqualTo('1e15')) return '0.0000';

  return Decimal.min(pedida, new Decimal(FLOOR_MAX_TOLERANCIA_CONCILIACION)).toFixed(4);
}
