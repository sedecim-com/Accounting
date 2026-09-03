import Decimal from 'decimal.js';
import type pg from 'pg';
import { getPolicy } from '../../policy/policy-service.js';
import { AccountingError } from '../../../utils/errors.js';

// ============================================================
// MX · EL SUBSIDIO AL EMPLEO QUE SE ENTREGA EN EFECTIVO
//
// El subsidio al empleo se acredita CONTRA el ISR del periodo. Cuando el
// subsidio es MAYOR que ese ISR —sueldos bajos, que es justo para quien el
// subsidio existe—, la diferencia no se pierde: el patrón la ENTREGA en
// efectivo al trabajador y la acredita después contra el ISR retenido a
// otros trabajadores (LISR, disposiciones de vigencia temporal del subsidio
// al empleo).
//
// El cálculo hacía `Math.max(0, isr - subsidio)` con un comentario encima
// que decía «if negative, employee receives as cash». El Math.max era
// exactamente lo que impedía que lo recibiera: la diferencia se recortaba a
// cero y nadie volvía a nombrarla. No era un redondeo — era el sueldo de
// gente real, cobrado de menos, todos los periodos.
//
// Este módulo hace las dos mitades de la operación explícitas y separadas:
// cuánto ISR se RETIENE (nunca negativo, eso sí era correcto) y cuánto
// dinero SALE del patrón hacia el trabajador. Vive aparte de
// paycheck-service porque es aritmética pura y verificable sin base de
// datos, y porque el defecto que evita se prueba mejor sobre una función que
// sobre un recibo entero.
// ============================================================

/** Las dos mitades de aplicar el subsidio al ISR de un periodo. */
export interface SubsidioAplicado {
  /**
   * ISR efectivamente retenido al trabajador, ya neteado del subsidio.
   * Nunca negativo: un ISR negativo no es una retención, es una entrega.
   */
  isrRetenido: string;
  /**
   * Subsidio que excedió al ISR y que el patrón entrega EN EFECTIVO.
   * No es un impuesto negativo ni una deducción: es dinero que sale del
   * patrón hacia el trabajador y vuelve por vía de acreditamiento.
   */
  entregadoEnEfectivo: string;
}

/**
 * Reparte el subsidio del periodo entre lo que netea al ISR y lo que se
 * entrega en efectivo. Las dos salidas suman siempre el subsidio completo
 * cuando éste no alcanza a agotarse contra el ISR, y ninguna de las dos es
 * nunca negativa.
 *
 * El dinero se lleva en Decimal y sale como cadena con cuatro decimales,
 * como todo importe de la casa: un `number` aquí volvería a introducir el
 * error de coma flotante justo en la resta que decide si alguien cobra.
 */
export function aplicarSubsidioAlEmpleo(
  isr: Decimal.Value,
  subsidio: Decimal.Value
): SubsidioAplicado {
  const isrD = new Decimal(isr);
  const subD = new Decimal(subsidio);

  // Un subsidio negativo no existe; si un tabulador lo devolviera, tratarlo
  // como cero es preferible a convertirlo en una retención extra silenciosa.
  const subsidioAplicable = subD.isNegative() ? new Decimal(0) : subD;
  const isrAplicable = isrD.isNegative() ? new Decimal(0) : isrD;

  const diferencia = isrAplicable.minus(subsidioAplicable);

  return {
    isrRetenido: (diferencia.isNegative() ? new Decimal(0) : diferencia).toFixed(4),
    entregadoEnEfectivo: (diferencia.isNegative() ? diferencia.negated() : new Decimal(0)).toFixed(4),
  };
}

// ------------------------------------------------------------
// DÓNDE SE REGISTRA LO ENTREGADO
// ------------------------------------------------------------

/** Los dos valores que la política `subsidio_al_empleo_entregado_registro` admite. */
export type RegistroDelSubsidio = 'cuenta_por_cobrar_fisco' | 'gasto_del_patron';

export const CLAVE_POLITICA_SUBSIDIO_ENTREGADO = 'subsidio_al_empleo_entregado_registro';

export interface RegistroSubsidioLeido {
  valor: RegistroDelSubsidio;
  /**
   * false = NADIE contestó la política y este valor es el de omisión del
   * catálogo. El código no debe presentarlo como criterio del despacho: el
   * despacho no ha dicho nada todavía, y la diferencia importa cuando
   * alguien audite por qué el importe fue a parar donde fue.
   */
  decididoPorElDespacho: boolean;
}

const REGISTROS_CONOCIDOS: Record<string, RegistroDelSubsidio> = {
  cuenta_por_cobrar_fisco: 'cuenta_por_cobrar_fisco',
  gasto_del_patron: 'gasto_del_patron',
};

/**
 * Lee la política que decide si el efectivo entregado es una cuenta por
 * cobrar al fisco (acreditable contra el ISR retenido a otros) o un gasto
 * que el patrón absorbe.
 *
 * CERRADO AL DECLARAR: un valor que este lector no conozca se acusa en vez
 * de adivinarse. Un tercer valor futuro en el catálogo tiene que llegar aquí
 * a propósito; caer al primero de la lista sería exactamente el instrumento
 * que miente sin avisar.
 *
 * `client` existe para leer DENTRO de la transacción del llamador: sin él,
 * getPolicy toma una segunda conexión del pool y quien ya tenga la suya
 * abierta se espera a sí mismo.
 */
export async function leerRegistroDelSubsidio(
  ctx: { tenantId: string; entityId?: string },
  client?: pg.PoolClient
): Promise<RegistroSubsidioLeido> {
  const politica = await getPolicy(ctx, CLAVE_POLITICA_SUBSIDIO_ENTREGADO, client);
  const valor = REGISTROS_CONOCIDOS[politica.value];
  if (!valor) {
    throw new AccountingError(
      'SUBSIDIO_REGISTRO_DESCONOCIDO',
      `La política ${CLAVE_POLITICA_SUBSIDIO_ENTREGADO} vale "${politica.value}" y este lector sólo ` +
        `entiende ${Object.keys(REGISTROS_CONOCIDOS).join(', ')}. Corrígela en mnemosine pending.`
    );
  }
  return { valor, decididoPorElDespacho: politica.defined };
}

/**
 * La nota que queda en el renglón de `paycheck_taxes`. Dice el importe, a
 * dónde va y —lo que nadie más registra— si eso lo decidió el despacho o es
 * el valor de omisión esperando respuesta.
 */
export function notaDelSubsidioEntregado(registro: RegistroSubsidioLeido): string {
  const destino =
    registro.valor === 'cuenta_por_cobrar_fisco'
      ? 'cuenta por cobrar al fisco (acreditable contra el ISR retenido a otros trabajadores)'
      : 'gasto del patrón (no se acredita)';
  const origen = registro.decididoPorElDespacho
    ? 'criterio del despacho'
    : `valor de omisión: ${CLAVE_POLITICA_SUBSIDIO_ENTREGADO} sigue sin contestar`;
  return `Subsidio al empleo entregado en efectivo al trabajador; se registra como ${destino} [${origen}].`;
}
