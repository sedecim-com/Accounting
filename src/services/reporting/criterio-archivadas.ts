import { query, currentTenant } from '../../database/connection.js';
import { getPolicy } from '../policy/policy-service.js';

// ============================================================
// T13 · QUÉ MUESTRA UN INFORME SOBRE UNA CUENTA ARCHIVADA
//
// LA PREGUNTA ESTABA MAL PLANTEADA, y por eso cinco consultas del mismo
// servicio contestaban dos cosas distintas. La balanza y el estado de
// resultados filtraban `a.is_active = true`; el balance general, el arrastre
// del resultado y el acumulado NO, con un comentario que explicaba que
// excluirla «silently removed real money from the statement».
//
// Ninguno de los dos bandos tenía razón entera, porque los dos respondían a
// «¿está viva la cuenta HOY?» y un informe no habla de hoy: habla de un
// periodo. Lo que decide es si la cuenta tuvo ALGO en el periodo del informe.
//
// LOS DOS HECHOS QUE LO CIERRAN
//
//  1. Postear a una cuenta inactiva está PROHIBIDO
//     (validation.ts: «Account "…" is inactive»). Así que archivar congela el
//     historial de la cuenta: no puede aparecer movimiento nuevo después.
//     «Tuvo movimiento en el periodo» y «está activa hoy» son, por tanto,
//     independientes — y sólo la primera es una propiedad DEL PERIODO.
//  2. Archivar sólo exige saldo de por vida cero (account-service), que es
//     EXACTAMENTE lo que tiene una cuenta de resultados después del cierre.
//     Con el filtro puesto, `account archive 4100` reescribía el estado de
//     resultados de un ejercicio ya cerrado y FIRMADO: Revenue 10 000 pasaba
//     a 0, la utilidad de 6 000 a una pérdida de 4 000, y el balance general
//     al 31-dic seguía cuadrando. Ningún control avisaba.
//
// DE AHÍ SALE UNA SOLA REGLA para las cinco consultas:
//
//     Un informe enseña una cuenta cuando la cuenta lleva algo EN EL PERIODO
//     DEL INFORME. `is_active` no gobierna el dinero: gobierna, como mucho,
//     los renglones de cortesía que la balanza añade para las cuentas que no
//     llevan nada.
//
// Tres de las cinco ya la cumplían sin decirlo: el balance general la aplica
// con su HAVING (saldo ≠ 0), el arrastre del resultado y el acumulado con sus
// JOIN internos (sin línea posteada no hay fila). El estado de resultados la
// cumplía en su HAVING Y ADEMÁS filtraba por `is_active`, de modo que ese
// filtro sólo podía borrar una cuenta que SÍ se movió: era pura pérdida.
// Se retiró. La balanza es la única donde `is_active` hacía trabajo real —es
// el informe con forma de catálogo, el que conserva a propósito las cuentas
// sin movimiento— y ahí se queda, pero deja de poder tapar dinero.
//
// LO QUE SÍ ES CRITERIO DEL DESPACHO, Y POR ESO VIVE EN EL PANEL
//
// Que un informe emitido no pierda dinero no es una preferencia: no hay
// despacho para el que «mi estado de resultados firmado cambia cuando ordeno
// el catálogo» sea la respuesta correcta, y ofrecerla como opción sería poner
// una respuesta falsa en el menú. Eso se corrigió en el código.
//
// Lo que sí se bifurca es lo otro, y ahí las dos respuestas son defendibles:
// una vez archivada, ¿la cuenta conserva su renglón en la balanza de un
// periodo donde NO lleva nada? El despacho que archivó para dejar de verla
// dice que no; el que cuadra el Anexo 24 contra un catálogo fijo mes a mes
// dice que sí, porque quiere el mismo juego de renglones siempre. Ninguna de
// las dos mueve una cifra. Es `informes_cuentas_archivadas`.
// ============================================================

/**
 * Valor por omisión del panel. Se repite aquí por lo mismo que en
 * criterio-cierre: un informe NO debe morir por no poder leer una política.
 */
export const CRITERIO_ARCHIVADAS_POR_OMISION = 'retirar_cuando_no_tiene_nada';

export interface CriterioDeArchivadas {
  /** Valor efectivo de `informes_cuentas_archivadas`. */
  valor: string;
  /**
   * La balanza retira el renglón de una cuenta archivada que no lleva NADA
   * al corte del informe. Falso = la conserva, como a cualquier cuenta del
   * catálogo sin movimiento.
   */
  retirarSinCifras: boolean;
}

/** El trozo de `TrialBalanceFilters` que fija el CORTE SUPERIOR del informe. */
export interface CorteDelInforme {
  fiscalPeriodId?: string;
  asOfDate?: string;
  untilDate?: string;
}

/**
 * Resuelve el criterio para una entidad. Mismo patrón que
 * `criterioDeCierreEnInformes`: el inquilino sale del contexto RLS cuando lo
 * hay y de `legal_entities` cuando no.
 */
export async function criterioDeCuentasArchivadas(
  entityId: string
): Promise<CriterioDeArchivadas> {
  const tenantId = currentTenant() ?? (await inquilinoDe(entityId));
  const valor = tenantId
    ? (await getPolicy({ tenantId, entityId }, 'informes_cuentas_archivadas')).value
    : CRITERIO_ARCHIVADAS_POR_OMISION;

  // El defecto y cualquier valor que el panel no reconozca caen del lado que
  // NO cambia lo que hoy se ve: la archivada sin cifras no vuelve sola a la
  // balanza de nadie.
  return { valor, retirarSinCifras: valor !== 'mantener_en_la_balanza' };
}

async function inquilinoDe(entityId: string): Promise<string | undefined> {
  const r = await query<{ tenant_id: string }>(
    'SELECT tenant_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  return r.rows[0]?.tenant_id;
}

/**
 * El `AND …` que decide qué cuentas entran en la balanza.
 *
 * POR QUÉ EL RESCATE MIRA EL MAYOR Y NO EL SALDO. La condición no es «la
 * cuenta tiene saldo» sino «el mayor tiene algo que decir de ella hasta el
 * corte», y son distintas: una cuenta con 100 al debe y 100 al haber tiene
 * saldo cero y SÍ se movió — el Anexo 24 la declara igual, y `soloConCifras`
 * de la balanza SAT ya razonaba así sobre las cuatro columnas. Un rescate por
 * saldo dejaría fuera precisamente a la cuenta de resultados barrida por el
 * cierre, que es el caso que este archivo existe para arreglar.
 *
 * POR QUÉ SÓLO LA COTA SUPERIOR. El SaldoIni de la balanza es todo lo
 * posteado ANTES del rango: una archivada sin movimiento en el rango pero con
 * arrastre tiene que salir, o la cuarta columna del Anexo 24 pierde una
 * cuenta y el recálculo de la autoridad no cuadra. Aplicar también la cota
 * inferior la borraría. Tampoco se aplica el criterio de asientos de cierre:
 * una cuenta cuyo único movimiento en el rango es el propio cierre debe
 * aparecer en la balanza que SÍ lo cuenta.
 *
 * `posicionDelCorte` es el `$n` que YA ocupa ese tope en la consulta —el
 * mismo parámetro, no una copia—. Reaprovecharlo no es tacañería con los
 * binds: es lo que garantiza que el rescate y el informe hablen del mismo
 * corte para siempre. Cero = el informe no tiene tope (una balanza abierta
 * por arriba), y entonces basta con que el mayor tenga algo de la cuenta.
 *
 * Devuelve cadena vacía cuando no hay nada que recortar —criterio
 * `mantener_en_la_balanza`, o la balanza EN CRUDO del cotejo contra las
 * materializadas—, y entonces entran todas las cuentas de la entidad.
 */
export function predicadoDeCuentaEnBalanza(
  criterio: CriterioDeArchivadas | null,
  corte: CorteDelInforme,
  posicionDelCorte: number
): string {
  if (criterio === null || !criterio.retirarSinCifras) return '';

  let cota = '';
  if (posicionDelCorte > 0) {
    cota = corte.fiscalPeriodId
      ? ` AND arch_je.entry_date <= (SELECT fp.end_date FROM fiscal_periods fp WHERE fp.id = $${posicionDelCorte})`
      : ` AND arch_je.entry_date <= $${posicionDelCorte}`;
  }

  // El `OR` es el rescate, y es lo único que separa esta balanza de la que
  // borraba dinero: la cuenta ACTIVA entra siempre —la balanza conserva a
  // propósito las cuentas sin movimiento— y la ARCHIVADA entra cuando el
  // mayor la respalda. Convertirlo en `AND` mata las dos propiedades a la vez.
  return (
    ` AND (a.is_active = true` +
    ` OR EXISTS (SELECT 1 FROM journal_entry_lines arch_jel` +
    ` JOIN journal_entries arch_je ON arch_je.id = arch_jel.journal_entry_id` +
    ` WHERE arch_jel.account_id = a.id AND arch_je.status = 'posted'${cota}))`
  );
}
