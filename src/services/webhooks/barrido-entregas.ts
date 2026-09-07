import { query, withTenant, withTransaction } from '../../database/connection.js';
import { deliverWebhook } from './webhook-service.js';
import { politicaDe, veredicto, MUERTA_PREFIJO } from './politica-reintento.js';
import type { WebhookSubscription, WebhookDelivery } from '../../types/index.js';

// ============================================================
// EL BARRIDO DE LO QUE NO SE ENTREGÓ
//
// `markFailed` lleva desde siempre escribiendo `next_retry_at`, y hasta
// este archivo NADIE lo leía: el sistema apuntaba con cuidado la hora a
// la que debía reintentar y jamás miraba el reloj. Una caída de treinta
// segundos del receptor perdía el evento para siempre, y —peor— lo
// perdía en silencio, con la fila en `pending` y una fecha futura que
// no significaba nada.
//
// Esto es lo que mira el reloj. Un PASO, no un proceso: se invoca, hace
// una pasada acotada y termina diciendo qué hizo. Ver `webhook-sweep-
// command.ts` para por qué es un comando y no un trabajador.
// ============================================================

/**
 * CUÁNTAS POR PASADA, Y POR INQUILINO.
 *
 * 100 no es un número redondo por comodidad: es el techo de lo que una
 * pasada puede tardar sin que el cron siguiente la alcance. Cada entrega
 * puede consumir hasta los 30 s del `AbortSignal.timeout` de
 * `deliverWebhook`, y el barrido es secuencial a propósito (ver abajo),
 * así que 100 entregas atascadas son 50 minutos en el peor caso
 * absoluto. Con el cron cada cinco minutos que sugiere el comando, ese
 * peor caso sólo aparece si el receptor está muerto del todo, y en ese
 * escenario lo correcto es NO adelantar trabajo: las entregas siguen en
 * la cola, con su turno intacto, y la pasada siguiente las toma.
 *
 * El tope es POR INQUILINO para que un inquilino con diez mil entregas
 * atascadas no consuma la pasada entera y deje a los demás sin barrer.
 */
export const TOPE_POR_INQUILINO = 100;

/**
 * EL ARRIENDO: cuánto tiempo una entrega reclamada queda fuera del
 * alcance de otra pasada.
 *
 * Dos crones que se solapan —el del despacho y el de alguien que lo
 * lanzó a mano— reclamarían la misma fila y la entregarían dos veces.
 * El `FOR UPDATE ... SKIP LOCKED` del reclamo resuelve el solape DENTRO
 * de la transacción; el arriendo resuelve el que ocurre FUERA, mientras
 * la petición HTTP está en vuelo y ya no hay transacción abierta.
 *
 * Se empuja `next_retry_at` hacia adelante en vez de ponerlo en NULL:
 * si el proceso muere a mitad de la pasada —OOM, el cron lo mata, se
 * cae la máquina—, un NULL dejaría la entrega en `pending` sin fecha,
 * es decir invisible para siempre para este mismo barrido. Con el
 * arriendo, un proceso muerto sólo retrasa la entrega cinco minutos.
 *
 * Cinco minutos es diez veces el tope de 30 s del envío: sobra para el
 * receptor más lento que aún merece llamarse vivo, y es lo máximo que
 * una pasada abortada puede costarle a una entrega.
 */
export const ARRIENDO_SEGUNDOS = 300;

export interface ResultadoEntrega {
  deliveryId: string;
  tenantId: string;
  webhookId: string;
  evento: string;
  /** Intentos consumidos DESPUÉS de esta pasada. */
  intentos: number;
  estado: 'success' | 'pending' | 'failed';
  /** `true` cuando esta pasada la declaró muerta. */
  muerta: boolean;
  error: string | null;
}

export interface ResultadoBarrido {
  /** Inquilinos censados (activos), no sólo los que tenían trabajo. */
  inquilinosRevisados: number;
  vencidas: number;
  entregadas: number;
  reintentables: number;
  /** Declaradas muertas EN ESTA PASADA. */
  muertas: number;
  /**
   * Vencidas que NO se tocaron porque su suscripción está desactivada.
   * Ver la nota de `is_active` en `reclamar`: es un número que se dice,
   * no una decisión que este barrido tome.
   */
  congeladas: number;
  detalle: ResultadoEntrega[];
}

export interface OpcionesBarrido {
  /** Acota a un solo inquilino. Sin esto, censa todos los activos. */
  tenantId?: string;
  /** Tope por inquilino en esta pasada. */
  limite?: number;
  /** Enumera lo vencido sin reclamar, sin entregar y sin escribir nada. */
  marchaSeca?: boolean;
  /** Traza legible por entrega; el comando la conecta a su salida. */
  traza?: (linea: string) => void;
}

interface FilaTrabajo {
  id: string;
  webhook_id: string;
  event: string;
  payload: Record<string, unknown>;
  attempt_count: number;
  sub: WebhookSubscription;
}

/**
 * EL CENSO: la ÚNICA sentencia del barrido que cruza inquilinos.
 *
 * El barrido cruza inquilinos por naturaleza —esa es su razón de ser—,
 * y la tentación es resolverlo con un rol BYPASSRLS y una consulta que
 * lea las entregas de todo el mundo de una vez. Eso pondría los cuerpos
 * de entrega y los secretos de firma de todos los inquilinos en el
 * mismo conjunto de resultados, y bastaría un `WHERE` mal puesto para
 * mandar el evento de uno a la URL de otro.
 *
 * Aquí lo cruzado es sólo la LISTA DE IDs. `tenants` está excluida de
 * RLS a propósito y desde siempre —«tenants is the root of the
 * hierarchy», rls-policies.sql:21—, así que este censo no necesita
 * ningún privilegio especial: no hay BYPASSRLS en ninguna parte de este
 * archivo. Todo lo demás —qué entregas hay, con qué cuerpo, contra qué
 * URL y con qué secreto— se lee ya dentro del contexto del inquilino.
 */
async function censarInquilinos(): Promise<string[]> {
  const { rows } = await query<{ id: string }>(
    'SELECT id FROM tenants WHERE is_active = true ORDER BY created_at'
  );
  return rows.map((r) => r.id);
}

/**
 * Reclama hasta `limite` entregas vencidas de ESTE inquilino y las
 * arrienda, todo en una transacción.
 *
 * `s.tenant_id = $1` está en el SQL aunque el contexto de inquilino ya
 * lo garantice por RLS. No es redundancia decorativa: la suite de
 * integración corre como superusuario —con RLS inerte a propósito—, así
 * que un barrido que confiara sólo en la política se probaría a sí
 * mismo en un entorno donde la política no existe, y la prueba de «no
 * mezcla» pasaría sin demostrar nada. El predicado explícito es lo que
 * la prueba puede ejercer.
 *
 * `s.is_active = true` deja fuera las suscripciones apagadas. NO las
 * mata ni las entrega: quedan intactas, y su número sale en el informe
 * como `congeladas`. Qué debe pasarle a la entrega pendiente de una
 * suscripción que el cliente desactivó —¿muere?, ¿espera a que la
 * reactiven?— es una bifurcación de criterio y este barrido no la
 * decide: la enseña.
 */
async function reclamar(tenantId: string, limite: number): Promise<FilaTrabajo[]> {
  const ids = await withTransaction(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `WITH vencidas AS (
         SELECT d.id
           FROM webhook_deliveries d
           JOIN webhook_subscriptions s ON s.id = d.webhook_id
          WHERE s.tenant_id = $1
            AND s.is_active = true
            AND d.status = 'pending'
            AND d.next_retry_at IS NOT NULL
            AND d.next_retry_at <= NOW()
          ORDER BY d.next_retry_at
          LIMIT $2
          FOR UPDATE OF d SKIP LOCKED
       )
       UPDATE webhook_deliveries d
          SET next_retry_at = NOW() + make_interval(secs => $3::double precision)
         FROM vencidas v
        WHERE d.id = v.id
       RETURNING d.id`,
      [tenantId, limite, ARRIENDO_SEGUNDOS]
    );
    return rows.map((r) => r.id);
  });

  if (ids.length === 0) return [];

  const { rows } = await query<FilaTrabajo>(
    `SELECT d.id, d.webhook_id, d.event, d.payload, d.attempt_count, row_to_json(s.*) AS sub
       FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.id = d.webhook_id
      WHERE d.id = ANY($1::uuid[]) AND s.tenant_id = $2
      ORDER BY d.next_retry_at`,
    [ids, tenantId]
  );
  return rows;
}

/** Vencidas de un inquilino cuya suscripción está apagada. */
async function contarCongeladas(tenantId: string): Promise<number> {
  const { rows } = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n
       FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.id = d.webhook_id
      WHERE s.tenant_id = $1
        AND s.is_active = false
        AND d.status = 'pending'
        AND d.next_retry_at IS NOT NULL
        AND d.next_retry_at <= NOW()`,
    [tenantId]
  );
  return Number(rows[0]?.n ?? 0);
}

/** Lo que quedó escrito de una entrega tras intentarla. */
async function leerDesenlace(deliveryId: string, tenantId: string): Promise<WebhookDelivery | undefined> {
  const { rows } = await query<WebhookDelivery>(
    `SELECT d.* FROM webhook_deliveries d
       JOIN webhook_subscriptions s ON s.id = d.webhook_id
      WHERE d.id = $1 AND s.tenant_id = $2`,
    [deliveryId, tenantId]
  );
  return rows[0];
}

/**
 * UNA PASADA del barrido.
 *
 * IDEMPOTENCIA HACIA FUERA. El reintento manda el MISMO identificador de
 * evento que el intento original —`X-Webhook-ID: <delivery.id>`, y
 * dentro del cuerpo el `id: whd_xxxxxxxx` que se grabó en el JSONB al
 * despachar—, porque el cuerpo se relee de la fila en vez de
 * reconstruirse. Eso es lo que permite al receptor reconocer «esto ya lo
 * procesé» y no cobrar dos veces.
 *
 * Lo que eso NO garantiza, dicho sin adornos:
 *   · La deduplicación la hace el RECEPTOR. Nosotros mandamos la llave;
 *     si él no la mira, cobra dos veces y no hay nada aquí que lo
 *     impida.
 *   · La FIRMA no se repite, y es deliberado. Cubre `t=<timestamp>.
 *     <cuerpo>` justamente para que el receptor pueda rechazar un
 *     replay por antigüedad; repetir la firma obligaría a repetir el
 *     timestamp original, y un receptor con la ventana de tolerancia
 *     habitual (cinco minutos, estilo Stripe) rechazaría por viejo todo
 *     reintento posterior al primer minuto. Es decir: firma repetida y
 *     reintento entregable son incompatibles. La identidad del evento
 *     viaja en `X-Webhook-ID`, que no caduca; la firma sólo prueba
 *     autenticidad y frescura de ESTE intento.
 *   · La entrega es AL MENOS UNA VEZ. Si el proceso muere entre el POST
 *     aceptado por el receptor y el UPDATE que lo registra, el arriendo
 *     vence y la entrega se repite. Preferimos repetir a perder, y por
 *     eso la llave estable importa.
 */
export async function barrerEntregasVencidas(
  opciones: OpcionesBarrido = {}
): Promise<ResultadoBarrido> {
  const limite = Math.min(Math.max(Math.trunc(opciones.limite ?? TOPE_POR_INQUILINO), 1), 1000);
  const traza = opciones.traza ?? ((): void => undefined);
  const inquilinos = opciones.tenantId ? [opciones.tenantId] : await censarInquilinos();

  const resultado: ResultadoBarrido = {
    inquilinosRevisados: inquilinos.length,
    vencidas: 0,
    entregadas: 0,
    reintentables: 0,
    muertas: 0,
    congeladas: 0,
    detalle: [],
  };

  for (const tenantId of inquilinos) {
    // CONTEXTO POR INQUILINO, y por tanto por entrega: todo lo que se
    // lee y se escribe de aquí para adentro pasa por las políticas de
    // ESE inquilino. `withTenant` (y no `enterTenant`) porque el
    // contexto tiene que CERRARSE al terminar con él: si se filtrara al
    // siguiente, el barrido leería las entregas de uno con el contexto
    // del otro, que es exactamente la mezcla que hay que evitar.
    await withTenant(tenantId, async () => {
      resultado.congeladas += await contarCongeladas(tenantId);

      if (opciones.marchaSeca) {
        // La marcha seca lee la MISMA política que aplicaría el envío
        // —`retry_config` de la suscripción incluido—, o enseñaría un
        // pronóstico que no es el que va a cumplirse.
        const { rows } = await query<{
          id: string; webhook_id: string; event: string; attempt_count: number;
          retry_config: WebhookSubscription['retry_config'];
        }>(
          `SELECT d.id, d.webhook_id, d.event, d.attempt_count, s.retry_config
             FROM webhook_deliveries d
             JOIN webhook_subscriptions s ON s.id = d.webhook_id
            WHERE s.tenant_id = $1 AND s.is_active = true AND d.status = 'pending'
              AND d.next_retry_at IS NOT NULL AND d.next_retry_at <= NOW()
            ORDER BY d.next_retry_at LIMIT $2`,
          [tenantId, limite]
        );
        resultado.vencidas += rows.length;
        for (const f of rows) {
          const politica = politicaDe(f);
          const proximo = f.attempt_count + 1;
          const moriria = veredicto(proximo, politica, () => 0.5).muerta;
          if (moriria) resultado.muertas += 1;
          else resultado.reintentables += 1;
          resultado.detalle.push({
            deliveryId: f.id,
            tenantId,
            webhookId: f.webhook_id,
            evento: f.event,
            intentos: f.attempt_count,
            estado: 'pending',
            muerta: moriria,
            error: null,
          });
          traza(
            `[marcha seca] ${f.id} ${f.event} intento ${proximo}/${politica.maxIntentos}` +
              (moriria ? ' → moriría en este intento' : '')
          );
        }
        return;
      }

      const trabajos = await reclamar(tenantId, limite);
      resultado.vencidas += trabajos.length;

      // SECUENCIAL a propósito. Estas entregas van casi siempre al
      // MISMO receptor que ya falló; lanzarlas en paralelo es mandarle
      // la estampida justo cuando se está levantando. El ruido
      // aleatorio de la política dispersa las pasadas; esto dispersa
      // la pasada por dentro.
      for (const t of trabajos) {
        // UNA ENTREGA ENVENENADA NO TUMBA LA PASADA. `deliverWebhook` ya
        // atrapa el fallo de red, pero no el de la base que viene después
        // (un UPDATE que choca, la conexión que se cae). Sin esto, la
        // entrega número tres se lleva por delante las noventa y siete que
        // faltaban, y la cola se atasca justo cuando más hay que barrer.
        // La fila queda arrendada, así que la pasada siguiente la retoma.
        try {
          await deliverWebhook(t.id, t.sub, t.payload);
        } catch (err) {
          resultado.reintentables += 1;
          const causa = err instanceof Error ? err.message : String(err);
          resultado.detalle.push({
            deliveryId: t.id,
            tenantId,
            webhookId: t.webhook_id,
            evento: t.event,
            intentos: t.attempt_count,
            estado: 'pending',
            muerta: false,
            error: causa,
          });
          traza(`no se pudo procesar: ${t.id} ${t.event} — ${causa}`);
          continue;
        }
        const fin = await leerDesenlace(t.id, tenantId);
        const estado: ResultadoEntrega['estado'] = fin?.status ?? 'pending';
        const muerta = estado === 'failed';

        if (estado === 'success') resultado.entregadas += 1;
        else if (muerta) resultado.muertas += 1;
        else resultado.reintentables += 1;

        resultado.detalle.push({
          deliveryId: t.id,
          tenantId,
          webhookId: t.webhook_id,
          evento: t.event,
          intentos: fin?.attempt_count ?? t.attempt_count,
          estado,
          muerta,
          error: fin?.error_message ?? null,
        });

        traza(
          muerta
            ? `${MUERTA_PREFIJO}: ${t.id} ${t.event} tras ${fin?.attempt_count ?? '?'} intento(s)`
            : `${estado === 'success' ? 'entregada' : 'reintentable'}: ${t.id} ${t.event} ` +
              `(intento ${fin?.attempt_count ?? '?'})`
        );
      }
    });
  }

  return resultado;
}
