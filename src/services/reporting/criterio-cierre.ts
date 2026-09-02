import { query, currentTenant } from '../../database/connection.js';
import { getPolicy } from '../policy/policy-service.js';

// ============================================================
// G1a · LOS ASIENTOS DE CIERRE DENTRO DEL RANGO QUE EL INFORME PIDE
//
// El asiento de cierre se fecha al FINAL del periodo que cierra —
// deliberado: antes llevaba `new Date()` y caía en el periodo abierto, de
// modo que el ejercicio cerrado nunca se ponía en cero en su propio mes—.
// El efecto colateral es que ese asiento queda DENTRO del rango que un
// informe de fin de ejercicio consulta, y el estado de resultados no
// filtraba por `entry_type`: su único predicado era `status = 'posted' AND
// entry_date BETWEEN`. Un ejercicio con 10 000 de ventas imprimía
// «Net income 0.0000», sin una sola advertencia, en las tres superficies
// (CLI, REST y las herramientas del agente) porque las tres comparten la
// consulta.
//
// El criterio se resuelve AQUÍ, una vez, y no en cada superficie: si cada
// una decidiera por su cuenta volveríamos a tener tres estados de
// resultados, que es exactamente lo que report-service existe para evitar.
//
// Lo que la política decide (`informes_asientos_de_cierre`) no es un
// detalle de presentación: el estado de resultados contesta «cuánto ganó
// el negocio» y el cierre no es ganancia —es el acto de guardarla—,
// mientras que la balanza contesta «qué dicen los libros» y ahí el asiento
// SÍ es parte de los libros. Esconderlo de la balanza rompería el amarre
// con el mayor contra el que se coteja el Anexo 24; por eso el defecto se
// llama «los informes que no cuentan el cierre» y no «el cierre sobra».
// ============================================================

/** El tipo de asiento que emite el cierre del ejercicio (period-close.ts). */
export const TIPO_ASIENTO_DE_CIERRE = 'closing';

/**
 * Valor por omisión del panel. Se repite aquí porque un informe NO debe
 * morir por no poder leer una política: si la entidad no resuelve inquilino
 * —una entidad que no existe no tiene datos que informar—, se aplica el
 * criterio declarado en el catálogo en vez de reventar una lectura.
 */
const CRITERIO_POR_OMISION = 'estado_sin_cierre_balanza_con_cierre';

export interface CriterioDeCierre {
  /** Valor efectivo de `informes_asientos_de_cierre`. */
  valor: string;
  /** El estado de resultados cuenta los asientos de cierre. */
  enEstadoDeResultados: boolean;
  /** La balanza los cuenta. */
  enBalanza: boolean;
}

/** El trozo de `TrialBalanceFilters` que delimita QUÉ asientos mira un informe. */
export interface RangoConsultado {
  fiscalPeriodId?: string;
  asOfDate?: string;
  sinceDate?: string;
  untilDate?: string;
}

export interface AvisoDeCierre {
  /** Asientos de cierre posteados que caen dentro del rango consultado. */
  entries: number;
  /** Si el informe que lo publica los está contando. */
  included: boolean;
  /** Texto listo para imprimir, en el idioma del informe. */
  note: string;
}

/**
 * Resuelve el criterio para una entidad. El inquilino sale del contexto RLS
 * cuando lo hay (CLI y REST lo fijan) y de `legal_entities` cuando no, que es
 * el mismo patrón de `tenantDe`/`inquilinoDe` en el resto de la casa.
 */
export async function criterioDeCierreEnInformes(entityId: string): Promise<CriterioDeCierre> {
  const tenantId = currentTenant() ?? (await inquilinoDe(entityId));
  const valor = tenantId
    ? (await getPolicy({ tenantId, entityId }, 'informes_asientos_de_cierre')).value
    : CRITERIO_POR_OMISION;

  switch (valor) {
    case 'excluir_siempre':
      return { valor, enEstadoDeResultados: false, enBalanza: false };
    case 'incluir_siempre_y_advertir':
      return { valor, enEstadoDeResultados: true, enBalanza: true };
    // El defecto y cualquier valor que el panel no reconozca: la combinación
    // conservadora, que es la única en la que los dos documentos son ciertos
    // al mismo tiempo.
    default:
      return { valor, enEstadoDeResultados: false, enBalanza: true };
  }
}

async function inquilinoDe(entityId: string): Promise<string | undefined> {
  const r = await query<{ tenant_id: string }>(
    'SELECT tenant_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  return r.rows[0]?.tenant_id;
}

/**
 * QUÉ ES «UN ASIENTO DE CIERRE», PARA UN INFORME.
 *
 * No basta con `entry_type = 'closing'`. Cuando un periodo se reabre y se
 * vuelve a cerrar, la política por omisión
 * (`cierre_recierre_de_periodo_reabierto` = reversar_y_reemitir) emite el
 * ESPEJO del cierre anterior, y ese espejo nace con entry_type='reversing'
 * porque eso es lo que es. Un filtro que sólo mira 'closing' deja pasar el
 * espejo, y el espejo devuelve al ingreso y al gasto exactamente lo que el
 * cierre reversado les había quitado: un ejercicio de 8 000 de ingreso neto
 * imprimía 16 000, y 3 000 de utilidad salían como 6 000. El defecto que G1a
 * vino a matar —un estado firmado que miente— reaparecía por la puerta del
 * arreglo del recierre.
 *
 * El reconocimiento es POR EL ASIENTO QUE REVIERTE, no por el tipo del
 * espejo, y eso es lo que lo mantiene estrecho: la reversa de una venta
 * —que es actividad real y TIENE que bajar el ingreso— apunta a un asiento
 * 'standard' y sigue contando. Sólo se cae la que deshace un cierre.
 */
function condicionDeCierre(alias: string): string {
  return (
    `(${alias}.entry_type = '${TIPO_ASIENTO_DE_CIERRE}'` +
    ` OR EXISTS (SELECT 1 FROM journal_entries rev` +
    ` WHERE rev.id = ${alias}.reverses_entry_id` +
    ` AND rev.entry_type = '${TIPO_ASIENTO_DE_CIERRE}'))`
  );
}

/**
 * `AND …` que deja fuera los asientos de cierre Y los espejos que los
 * deshacen. Vive DENTRO del par (jel JOIN je), como el resto de los
 * predicados sobre `je`: colgado de un LEFT JOIN encadenado volvería a dejar
 * pasar las líneas que pretende quitar.
 */
export function predicadoSinCierre(): string {
  return `AND NOT ${condicionDeCierre('je')}`;
}

/** Mismo recorte de rango que `entryFilter` de report-service, sobre `je`. */
function rangoSql(rango: RangoConsultado, params: unknown[], desde: number): string {
  let i = desde;
  if (rango.fiscalPeriodId) {
    params.push(rango.fiscalPeriodId);
    return `AND je.fiscal_period_id = $${i}`;
  }
  if (rango.asOfDate) {
    params.push(rango.asOfDate);
    return `AND je.entry_date <= $${i}`;
  }
  const partes: string[] = [];
  if (rango.sinceDate) {
    params.push(rango.sinceDate);
    partes.push(`AND je.entry_date >= $${i++}`);
  }
  if (rango.untilDate) {
    params.push(rango.untilDate);
    partes.push(`AND je.entry_date <= $${i++}`);
  }
  return partes.join(' ');
}

/**
 * Cuántos asientos de cierre posteados caen dentro del rango consultado.
 *
 * Cuenta lo MISMO que `predicadoSinCierre` deja fuera —espejos del recierre
 * incluidos—, o la nota anunciaría dos asientos mientras el informe descuenta
 * cuatro, y quien ate las cifras a mano no cuadraría.
 */
export async function contarAsientosDeCierre(
  entityId: string,
  rango: RangoConsultado
): Promise<number> {
  const params: unknown[] = [entityId];
  const r = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM journal_entries je
      WHERE je.entity_id = $1
        AND je.status = 'posted'
        AND ${condicionDeCierre('je')}
        ${rangoSql(rango, params, 2)}`,
    params
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * El aviso que acompaña a un informe cuyo rango contiene un cierre.
 *
 * Que la BALANZA lo diga es la mitad útil del criterio: sin la nota, una
 * balanza que incluye el cierre y un estado de resultados que lo excluye
 * parecen discrepar, y quien los ata a mano concluye que uno de los dos está
 * mal. Con la nota, los dos se leen juntos sin contradicción.
 *
 * Devuelve `null` cuando no hay ningún cierre en el rango: un informe normal
 * no arrastra una nota sobre algo que no ocurrió.
 */
export async function avisoDeCierreEnRango(
  entityId: string,
  rango: RangoConsultado,
  informe: 'trial-balance' | 'income-statement'
): Promise<AvisoDeCierre | null> {
  const criterio = await criterioDeCierreEnInformes(entityId);
  const entries = await contarAsientosDeCierre(entityId, rango);
  if (entries === 0) return null;

  const included = informe === 'trial-balance' ? criterio.enBalanza : criterio.enEstadoDeResultados;
  const cuantos = `${entries} year-end closing ${entries === 1 ? 'entry' : 'entries'}`;
  return {
    entries,
    included,
    note: included
      ? `This range contains the close of the fiscal year (${cuantos}); they are counted here.`
      : `This range contains the close of the fiscal year (${cuantos}); they are left out of this statement.`,
  };
}
