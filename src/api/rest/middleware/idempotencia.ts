import type { Request, RequestHandler, Response } from 'express';
import {
  conLlave,
  hashDeCarga,
  ConflictoDeIdempotencia,
} from '../../../services/idempotency/idempotency-store.js';
import { ConflictError, ValidationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';

// ============================================================
// LA CABECERA `Idempotency-Key`, POR FIN LEÍDA.
//
// El almacén existe desde la 039 y el CLI lo usa en nueve comandos
// (`entry post`, `close`, `bank recon approve`…). REST no lo mencionaba
// NI UNA VEZ: cero apariciones de la cabecera en todo src/api/rest. La
// consecuencia es la que tiene cualquier API de pagos sin llave — un
// reintento de red sobre POST /v1/bills/payments crea un SEGUNDO pago,
// con su póliza, su abono a la cuenta bancaria y su aplicación contra la
// factura. Nada en el dominio lo impide: dos pagos idénticos del mismo
// proveedor el mismo día son un hecho perfectamente legal.
//
// QUÉ RUTAS. No una lista: la clase que la ruta ya declara. `risk.ts`
// resuelve `exigeLlaveDeIdempotencia` para todo lo `irreversible` y todo
// lo `externo` —las 36 rutas que no se deshacen repitiéndolas— y es
// `declararRiesgoRuta` quien cuelga este manejador. Declarar la clase ES
// obtener la llave; no hay un segundo sitio donde acordarse.
//
// EL CONTRATO ES EL DEL ALMACÉN, sin reinterpretarlo:
//
//   · Sin cabecera, no se toca el almacén. La llave sólo actúa si quien
//     llama la pasó, igual que `--idempotency-key` en la terminal. (Ver
//     abajo «la bifurcación que no se decide aquí».)
//   · Misma llave + misma carga → se devuelve la respuesta GRABADA, con
//     su mismo código, sin volver a ejecutar.
//   · Misma llave + carga DISTINTA → 409 con el motivo. Nunca un
//     silencio, y nunca la respuesta de la otra carga.
//
// SÓLO SE GRABA EL ÉXITO, y sólo después del acto. Un 4xx/5xx no consuma
// la llave: si se grabara, el reintento legítimo tras un fallo recibiría
// el fallo para siempre. Un cliente que corta la conexión a media
// respuesta tampoco la consuma — la defensa ahí vuelve a ser el estado
// del dominio, exactamente como razona el almacén para el proceso que
// muere a la mitad.
//
// LO QUE ESTA LLAVE NO CUBRE, y conviene saberlo: DOS PETICIONES
// SIMULTÁNEAS con la misma llave nueva se ejecutan las DOS. El almacén
// graba después del acto, así que ninguna encuentra a la otra al mirar,
// y la restricción única sólo arbitra al grabar — su propio comentario
// lo dice: «ambos ejecutaron; el dominio ya arbitró». Lo que sí cubre es
// el caso para el que existe la cabecera: el reintento SECUENCIAL tras
// un timeout, un 502 o una conexión caída. Cerrar lo otro exigiría
// reservar la llave ANTES del acto, y eso es justo lo que el almacén
// rehúsa porque bloquearía el reintento legítimo tras un proceso muerto
// a la mitad. Es una decisión suya, tomada con su razón, y no se
// reabre desde aquí.
//
// LA BIFURCACIÓN QUE NO SE DECIDE AQUÍ: si la cabecera debería ser
// OBLIGATORIA en las rutas irreversibles. Hay un argumento real para que
// lo sea y que no existe en el CLI — una invocación de terminal la
// escribe una persona una vez, mientras que una petición HTTP la
// reintentan solos el cliente, el proxy y el balanceador. Exigirla
// rompería a todo cliente de hoy, así que este tramo implementa lo que
// el almacén ya decidió (opcional, honrada cuando viene) y deja el
// endurecimiento nombrado en vez de elegirlo por su cuenta.
// ============================================================

/** La cabecera, en minúsculas: es como Node entrega `req.headers`. */
export const CABECERA_LLAVE = 'idempotency-key';

/** `idempotency_keys.clave` es VARCHAR(200) (migración 039). */
export const LARGO_MAX_CLAVE = 200;

/**
 * `idempotency_keys.scope` es VARCHAR(80) (migración 039). El alcance de
 * una ruta es «MÉTODO ruta-con-prefijo», y la más larga de las 36 de hoy
 * mide 50 caracteres. Que quepa no se deja a la suerte: `risk.ts` lo
 * comprueba en el ARRANQUE sobre el censo, porque el día que no quepa el
 * error saldría de Postgres a mitad de un acto irreversible.
 */
export const LARGO_MAX_ALCANCE = 80;

/** Marca en la respuesta repetida, para que el cliente sepa que no volvió a pasar. */
export const CABECERA_REPETIDO = 'Idempotency-Replayed';

/**
 * Lo que se guarda en `idempotency_keys.resultado`: la respuesta entera,
 * no el cuerpo suelto. El código importa tanto como el cuerpo — un 201
 * repetido tiene que volver a contestar 201, y un 204 no puede volver
 * con un cuerpo que nunca tuvo.
 */
type RespuestaGrabada = { estado: number; cuerpo?: unknown };

/**
 * Rechazo interno para «hubo respuesta, pero no se graba»: el manejador ya
 * contestó (con un 4xx, o con la conexión rota), así que `conLlave` no debe
 * consumar la llave y aquí no hay nada más que hacer.
 */
class NoSeGraba extends Error {}

/**
 * El alcance de la llave: verbo y ruta REALES de Express.
 *
 * `req.baseUrl` es el prefijo de montaje tal cual lo resolvió Express (no
 * el reconstruido del censo) y `req.route.path` el patrón con sus
 * parámetros sin sustituir, de modo que el `:id` concreto viaja en el
 * hash de la carga y no en el alcance. Dos actos distintos sobre la misma
 * ruta comparten alcance y se distinguen por carga; es lo que hace que
 * reusar una llave con OTRO id sea un conflicto y no un acierto.
 *
 * CONSECUENCIA CONOCIDA de que el prefijo entre en el alcance:
 * xml-ingestion y blockchain se montan bajo DOS prefijos cada uno
 * (`/v1/xml/…` y `/v1/…`), así que la misma ruta alcanzada por sus dos
 * direcciones tiene dos alcances. Un cliente reintenta la dirección que
 * llamó, así que el caso pide cambiar de URL a mitad del reintento; se
 * deja dicho en vez de inventar una canonicalización que ninguna de las
 * dos direcciones justifica.
 */
export function alcanceDeLaRuta(req: Request): string {
  const patron = (req.route as { path?: string } | undefined)?.path;
  const propia = patron === undefined || patron === '/' ? '' : patron;
  return `${req.method} ${req.baseUrl}${propia}`;
}

/**
 * Orden canónico de las claves antes de serializar. Dos reintentos de un
 * mismo cliente mandan los mismos bytes, pero un cliente que reconstruye
 * el JSON desde un objeto no garantiza el orden, y un cambio de orden no
 * es un cambio de carga: acusarlo como reuso de llave sería un falso
 * conflicto en el peor momento.
 */
function canonico(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonico);
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(o).sort().map((k) => [k, canonico(o[k])]));
  }
  return v;
}

/**
 * El hash de la carga: cuerpo, parámetros de ruta, query Y ENTIDAD.
 *
 * La entidad va dentro a propósito. La unicidad del almacén es por
 * (inquilino, alcance, llave) —no por entidad, porque la llave la elige
 * el cliente—, así que sin ella la misma llave enviada con otra
 * `x-entity-id` sería un ACIERTO y devolvería la respuesta grabada de la
 * PRIMERA entidad. Eso no es deduplicar: es servir el resultado de una
 * entidad a quien preguntó por otra. Con la entidad dentro del hash ese
 * caso es un conflicto, que es lo que es.
 *
 * Se serializa la tupla ENTERA de una vez y no parte por parte: la
 * concatenación con separador de `hashDeCarga` haría que ["a|b","c"] y
 * ["a","b|c"] compartieran hash.
 */
function hashDeLaPeticion(req: Request): string {
  return hashDeCarga(
    JSON.stringify([
      canonico((req as { body?: unknown }).body ?? null),
      canonico(req.params ?? {}),
      canonico(req.query ?? {}),
      req.entityId ?? null,
    ])
  );
}

/**
 * La forma que admite una llave: un token opaco de ASCII imprimible, sin
 * espacios NI COMAS.
 *
 * Lo de la coma no es estética. Node NO entrega un arreglo cuando llegan
 * dos cabeceras con el mismo nombre (eso sólo pasa con `set-cookie`): las
 * une con «, » y entrega una sola cadena. Sin esta comprobación, un
 * cliente que manda `K-1` y un proxy que añade otra dejarían la llave
 * `K-1, K-2` — que no es la llave de nadie, y que en el reintento con una
 * sola cabecera NO casaría, repitiendo el acto sin que nada lo dijera. Un
 * UUID, un ULID o un hash —lo que un cliente usa de verdad— pasan sin
 * tocar nada.
 */
const FORMA_DE_LLAVE = /^[A-Za-z0-9_.:@+/=-]+$/;

function llaveDe(req: Request): string | undefined {
  const cruda = req.headers[CABECERA_LLAVE];
  if (cruda === undefined) return undefined;

  // Por si algún día el runtime sí entrega arreglo: no se elige una. Cuál
  // gana decidiría en silencio si el acto se deduplica o se repite.
  if (Array.isArray(cruda)) {
    throw new ValidationError(
      `La petición trae ${cruda.length} cabeceras ${CABECERA_LLAVE}. Manda exactamente una: ` +
        'con dos, cuál manda decidiría en silencio si este acto se repite o no.'
    );
  }
  const clave = cruda.trim();
  if (clave.length === 0) {
    throw new ValidationError(
      `La cabecera ${CABECERA_LLAVE} viene vacía. Quítala, o manda una llave: una llave vacía ` +
        'no deduplica nada y hace creer que sí.'
    );
  }
  if (clave.length > LARGO_MAX_CLAVE) {
    throw new ValidationError(
      `La llave de idempotencia mide ${clave.length} caracteres y el máximo es ${LARGO_MAX_CLAVE}.`
    );
  }
  if (!FORMA_DE_LLAVE.test(clave)) {
    throw new ValidationError(
      `La llave de idempotencia "${clave}" trae caracteres que no se admiten. Usa letras, ` +
        'dígitos y _ . : @ + / = - (un UUID sirve). La coma y el espacio quedan fuera a ' +
        'propósito: es como llegan DOS cabeceras unidas por el servidor, y una llave así no es ' +
        'la que mandó nadie — el reintento no casaría y el acto se repetiría en silencio.'
    );
  }
  return clave;
}

/** Devuelve la respuesta grabada, con su código original. */
function responderRepetido(res: Response, grabada: RespuestaGrabada): void {
  res.setHeader(CABECERA_REPETIDO, 'true');
  // Sin cuerpo grabado (un 204, p.ej.) no se inventa uno: `end()`.
  if (grabada.cuerpo === undefined) {
    res.status(grabada.estado).end();
    return;
  }
  res.status(grabada.estado).json(grabada.cuerpo);
}

/**
 * El manejador que hace verdadera la cabecera en una ruta.
 *
 * No se monta a mano en ninguna ruta: lo cuelga `declararRiesgoRuta`
 * (src/api/rest/risk.ts) en todo lo que declare `irreversible` o
 * `externo`. Ésa es la única razón por la que no puede olvidarse en una
 * ruta nueva — la clase es obligatoria, y la clase trae la llave.
 */
export function bajoLlaveDeIdempotencia(): RequestHandler {
  return (req, res, next) => {
    let clave: string | undefined;
    try {
      clave = llaveDe(req);
    } catch (err) {
      next(err);
      return;
    }
    if (clave === undefined) {
      next();
      return;
    }

    // Todas las rutas que exigen llave van detrás de `authenticate`, así que
    // esto es inalcanzable hoy. Se contesta igualmente en vez de seguir sin
    // deduplicar: el cliente pidió que el acto no se repitiera y tiene que
    // enterarse si no se le puede prometer.
    const tenantId = req.tenantId;
    if (!tenantId) {
      next(
        new ValidationError(
          `No se puede honrar ${CABECERA_LLAVE}: la petición no identifica un inquilino, y las ` +
            'llaves consumadas se guardan por inquilino.'
        )
      );
      return;
    }

    const alcance = alcanceDeLaRuta(req);
    const payloadHash = hashDeLaPeticion(req);

    let capturado: unknown;
    let seCapturo = false;
    // En un objeto y no en una variable suelta: se asigna dentro de un cierre
    // y se lee fuera, y así el compilador no la estrecha a `null`.
    const aplazada: { soltar: (() => void) | null } = { soltar: null };

    void conLlave<RespuestaGrabada>(
      { tenantId, entityId: req.entityId },
      { scope: alcance, clave, payloadHash },
      () => {
        // ─────────────────────────────────────────────────────────────
        // LA RESPUESTA SALE DESPUÉS DE QUE LA LLAVE ESTÉ GRABADA.
        //
        // La primera versión de esto grababa la llave cuando la respuesta ya
        // había volado —escuchando `finish`— y la prueba de integración lo
        // cazó: entre que el cliente lee su 201 y que el INSERT termina hay
        // una ventana en la que un reintento NO encuentra la llave y vuelve a
        // ejecutar el acto. Milisegundos, pero es justo la ventana que este
        // middleware existe para cerrar, y una garantía que se cumple «casi
        // siempre» no es una garantía.
        //
        // Así que se intercepta `res.end` —por donde salen json, send y el
        // 204 por igual— y se retiene su llamada hasta que `conLlave` haya
        // terminado. Cuando el cliente ve el éxito, su reintento ya casa. El
        // coste es un viaje a la base de latencia, y sólo en las peticiones
        // que mandan la cabecera.
        //
        // El acto NO se retiene: ya ocurrió. Lo único que espera es el
        // acuse. Si la llave no se puede grabar, la respuesta sale igual
        // (abajo) y el fallo queda escrito.
        // ─────────────────────────────────────────────────────────────
        const endOriginal = res.end.bind(res);
        // `res.end` está sobrecargado; para reenviar los argumentos tal cual
        // llegaron hace falta una firma variádica.
        const soltarEnd = endOriginal as unknown as (...args: unknown[]) => unknown;

        const respuesta = new Promise<RespuestaGrabada>((resolve, reject) => {
          res.end = ((...args: unknown[]) => {
            // Sólo el PRIMER end se aplaza; cualquier otro sale directo.
            res.end = endOriginal;
            aplazada.soltar = () => {
              soltarEnd(...args);
            };
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ estado: res.statusCode, cuerpo: seCapturo ? capturado : undefined });
            } else {
              // El fallo no consuma la llave: el reintento tiene que poder
              // volver a intentarlo cuando se arregle lo que falló.
              reject(new NoSeGraba());
            }
            return res;
          }) as typeof res.end;

          // Conexión cortada antes de responder. No se sabe si el acto llegó
          // a completarse, así que tampoco se graba: la defensa vuelve a ser
          // el estado del dominio, como razona el almacén para el proceso que
          // muere a la mitad.
          res.on('close', () => reject(new NoSeGraba()));
        });

        // `res.json` se intercepta aparte y sólo para QUEDARSE con el objeto:
        // del cuerpo ya serializado no se puede reconstruir el JSON grabado.
        const jsonOriginal = res.json.bind(res);
        res.json = ((cuerpo: unknown) => {
          capturado = cuerpo;
          seCapturo = true;
          return jsonOriginal(cuerpo);
        }) as typeof res.json;

        next();
        return respuesta;
      }
    )
      .then((acto) => {
        if (acto.repetido) {
          // `fn` no llegó a correr: nada que soltar, y la respuesta es la
          // grabada.
          responderRepetido(res, acto.resultado);
          return;
        }
        // La llave ya está en la base. Ahora sale la respuesta.
        aplazada.soltar?.();
      })
      .catch((err: unknown) => {
        if (aplazada.soltar) {
          // El manejador YA produjo su respuesta: sale, se haya podido grabar
          // la llave o no. `NoSeGraba` es el caso normal (un 4xx no consuma
          // la llave); cualquier otro error es un fallo REAL del almacén
          // después de un acto que sí ocurrió, y ése se escribe: un reintento
          // va a repetirlo y tiene que quedar dicho con qué llave.
          if (!(err instanceof NoSeGraba)) {
            logger.error('El acto salió pero la llave de idempotencia no se pudo grabar', {
              alcance,
              clave,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          aplazada.soltar();
          return;
        }

        if (err instanceof NoSeGraba) return; // conexión cortada: no hay a quién responder

        // Nada se respondió todavía, así que el error es de la LLAVE y no del
        // acto: el reuso de llave es 409 con el motivo del almacén.
        next(err instanceof ConflictoDeIdempotencia ? new ConflictError(err.message) : err);
      });
  };
}
