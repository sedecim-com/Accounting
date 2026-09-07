import { z } from 'zod';

// ============================================================
// LOS TOPES DE ARREGLO DE LA API REST.
//
// Un arreglo en el cuerpo de una petición no cuesta lo que ocupa: cuesta
// lo que MULTIPLICA. Todas las rutas de abajo recorren su arreglo con al
// menos un viaje a la base por elemento, y varias lo hacen dentro de una
// transacción abierta, sujetando una conexión del pool y los candados de
// fila mientras dura. El freno por petición (middleware/rate-limiter.ts)
// no ve nada de eso: cuenta peticiones, y una petición con cien mil
// renglones es UNA.
//
// Ese hueco ya se cerró una vez —`xml_contents` e `ids` en
// xml-ingestion.ts, con MAX_XML_POR_LOTE— y ahí se quedó. Lo que este
// archivo recoge son las arreglos HERMANOS que la misma auditoría
// destapó y que seguían sin tope: el extracto bancario y los renglones y
// aplicaciones de los documentos.
//
// POR QUÉ AQUÍ Y NO EN CADA ESQUEMA. Los números tienen que poder
// compararse entre sí y con el que ya existe; sueltos en cinco archivos
// se vuelven cinco criterios distintos que nadie vuelve a leer juntos.
// Cada esquema importa su constante, y el porqué vive una sola vez.
//
// LO QUE NO SE ACOTA AQUÍ, a propósito y con nombre:
//
//   · `events` (webhooks), `tags` (accounts, pre-registrations),
//     `secondary_chains` / `ots_calendars` / `notification_emails`
//     (blockchain), `applies_to_document_types` (processing rules).
//     Todos caen en UNA columna con UNA escritura: su longitud no se
//     multiplica por nada, y su techo es el límite de 10 MB del cuerpo
//     que monta src/index.ts. Un tope aquí sería un número sin defecto
//     detrás.
//
//   · El bucle en sí. `POST /v1/bank-accounts/:account_id/import` hace
//     DOS viajes por movimiento en serie; el importador de la terminal
//     (bank-statement-service.ts) inserta de 200 en 200 y hace un
//     extracto de 3 000 líneas en quince viajes. El tope acota el daño;
//     lotear la escritura lo quitaría. Son dos cambios distintos y éste
//     es el primero.
// ============================================================

/**
 * Movimientos por importación de extracto bancario.
 *
 * El manejador comprueba duplicado e inserta uno por uno: dos viajes por
 * movimiento, en serie. Sin tope, un cuerpo de cien mil filas son
 * doscientos mil viajes que atan un worker y una conexión del pool —el
 * día del cierre, cuando el pool es justo lo que falta.
 *
 * 5 000 y no menos: el modelo de extracto del propio sistema es de
 * «3 000 líneas» (bank-statement-service.ts, LOTE_LINEAS), así que un
 * tope por debajo rechazaría el mes de una cuenta operativa movida. 5 000
 * y no más: es donde el peor caso —diez mil viajes -- sigue siendo un
 * incidente de segundos y no de minutos. Un extracto mayor se carga por
 * `mnemosine bank import`, que sí lotea.
 */
export const MAX_MOVIMIENTOS_POR_IMPORTACION = 5_000;

/**
 * Renglones de un documento: póliza, factura o factura de proveedor.
 *
 * Los tres insertan un renglón por viaje DENTRO de la transacción que
 * crea el documento, así que la longitud del arreglo es el tiempo que esa
 * transacción tiene abiertos sus candados (el periodo fiscal, entre
 * ellos: posting.ts lo bloquea para postear).
 *
 * 1 000 es dos órdenes de magnitud por encima de lo que una persona
 * escribe y sigue siendo un documento; a partir de ahí lo que hay es una
 * importación, y una importación tiene su propia puerta.
 */
export const MAX_RENGLONES_POR_DOCUMENTO = 1_000;

/**
 * Documentos contra los que un solo pago se aplica.
 *
 * `POST /v1/bills/payments` es una ruta IRREVERSIBLE: cada aplicación
 * mueve `amount_due` y participa en la póliza que se postea. El arreglo
 * se recorre dentro de la transacción del pago.
 *
 * 500 facturas en un pago es ya una remesa a un proveedor grande; por
 * encima de eso lo que se está pidiendo es un lote de pagos, que es otra
 * cosa y no la hace esta ruta.
 */
export const MAX_APLICACIONES_POR_PAGO = 500;

// ============================================================
// EL TOPE TIENE QUE PODER PUBLICARSE.
//
// `arregloAcotado` guarda el número dentro del cierre de un `superRefine`,
// y desde fuera del cierre no hay forma de leerlo: ni Zod lo expone ni el
// `ZodEffects` que devuelve lo enseña en su `_def`. Mientras estuvo sólo
// en el rechazo eso daba igual —quien se pasaba, se enteraba—, pero el
// contrato de la API (openapi.ts) se deriva de estos mismos esquemas, y un
// contrato que anuncia `minItems: 2` y calla el techo de 1 000 miente por
// omisión justo donde más cuesta: quien integra descubre el tope con un
// 422 en producción.
//
// Así que el tope se cuelga del esquema, con la misma técnica con la que
// la clase de riesgo se cuelga de su manejador y el esquema de cuerpo del
// suyo. Un mapa «esquema → tope» al lado sería otra lista paralela.
// ============================================================
const MARCA_COTA = Symbol('cota-de-arreglo');

type ConCota = { [MARCA_COTA]?: number };

/**
 * El techo que `arregloAcotado` puso, si el esquema salió de ahí.
 *
 * Quien lo lea puede tratarlo como el `maxItems` COMPLETO del arreglo: la
 * marca la pone únicamente `arregloAcotado`, cuyo `superRefine` no
 * comprueba nada más que la longitud. Un refinamiento que hiciera algo
 * además de eso no debe llevar esta marca.
 */
export function cotaDeArreglo(esquema: unknown): number | undefined {
  return typeof esquema === 'object' && esquema !== null
    ? (esquema as ConCota)[MARCA_COTA]
    : undefined;
}

/**
 * Un arreglo con tope, y con un rechazo que se puede leer.
 *
 * `z.array(...).max(n)` ya nombra el tope («at most 5000 element(s)»), pero
 * no dice cuántos llegaron ni a dónde ir con el resto, y quien recibe ese
 * 422 con un extracto de veinte mil líneas necesita las dos cosas para
 * partirlo. El mensaje se arma aquí para que los cuatro topes suenen igual.
 *
 * El mínimo se pasa por aquí y no se encadena después porque `superRefine`
 * devuelve un `ZodEffects`, que ya no tiene `.min()`.
 */
export function arregloAcotado<T extends z.ZodTypeAny>(
  elemento: T,
  opciones: {
    tope: number;
    /** Cómo se llama lo que va dentro, en plural: «movimientos», «renglones». */
    plural: string;
    /** Qué hacer con lo que no cupo. */
    salida: string;
    minimo?: number;
    mensajeMinimo?: string;
  }
): z.ZodEffects<z.ZodArray<T>, z.infer<T>[], z.infer<T>[]> {
  const { tope, plural, salida, minimo, mensajeMinimo } = opciones;
  const base =
    minimo === undefined ? z.array(elemento) : z.array(elemento).min(minimo, mensajeMinimo);
  const acotado: z.ZodEffects<z.ZodArray<T>, z.infer<T>[], z.infer<T>[]> & ConCota =
    base.superRefine((valor, ctx) => {
      if (valor.length <= tope) return;
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: 'array',
        maximum: tope,
        inclusive: true,
        message: `llegaron ${valor.length} ${plural} y caben ${tope} por petición. ${salida}`,
      });
    });
  acotado[MARCA_COTA] = tope;
  return acotado;
}
