import { config } from '../../config/index.js';
import type { WebhookSubscription } from '../../types/index.js';

// ============================================================
// LA POLÍTICA DE REINTENTO, EN UN SOLO SITIO
//
// El esquema lleva desde la migración 003 preparado para reintentar
// —`attempt_count`, `next_retry_at`, un índice parcial sobre
// `next_retry_at WHERE status = 'pending'`, y hasta un `retry_config`
// JSONB POR SUSCRIPCIÓN— y el reintento nunca ocurrió: `markFailed`
// escribía `next_retry_at` y NADIE lo leía. Un índice construido para
// una consulta que no existe es la firma exacta de esa deuda.
//
// Este módulo es la política: los números, el retroceso y la frontera
// entre «vuelve a intentarse» y «está muerta». Vive aparte del envío
// porque lo usan dos caminos —el fallo en vivo (`markFailed`) y el
// barrido (`barrido-entregas.ts`)— y dos caminos con dos políticas es
// cómo una cola acaba reintentando a ritmos distintos según quién la
// tocó de último.
// ============================================================

/**
 * El estado de una entrega no cabía en la columna `status`.
 *
 * El CHECK de la 003 sólo admite `pending | success | failed`, y las
 * migraciones no se tocan en este frente. Así que MUERTA no es un
 * valor nuevo: es el par (`failed`, `next_retry_at IS NULL`), y el
 * resto del espacio queda repartido sin ambigüedad:
 *
 *   pending + next_retry_at NULL   → nunca falló todavía (recién creada
 *                                     o en vuelo).
 *   pending + next_retry_at futuro → espera su turno; el barrido la
 *                                     dejará en paz hasta que venza.
 *   pending + next_retry_at vencido→ VENCIDA: es lo que el barrido toma.
 *   failed  + next_retry_at NULL   → MUERTA: agotó sus intentos y no se
 *                                     volverá a intentar sola.
 *   success                        → entregada.
 *
 * `markFailed` es el único código que escribe `failed`, y sólo al
 * agotar los intentos, así que `failed` ⟺ muerta sin excepciones.
 */
export const MUERTA_PREFIJO = 'ENTREGA MUERTA';

export interface PoliticaReintento {
  /** Intentos TOTALES, contando el primer envío. Al llegar aquí, muere. */
  maxIntentos: number;
  /** Espera del primer reintento, en segundos. Se duplica en cada uno. */
  baseSegundos: number;
  /** Tope por espera individual, en segundos. */
  topeSegundos: number;
}

// ============================================================
// LOS NÚMEROS, Y POR QUÉ ÉSTOS
//
// El defecto anterior —5 intentos con base de 60 s y duplicado— agota
// la cola en 1+2+4+8 = 15 minutos. Eso no es una política de
// reintento: es un trámite. Sobrevive al hipo de treinta segundos del
// enunciado y a nada más; el despliegue del receptor que tarda media
// hora pierde el evento igual que antes, sólo que después de haberlo
// intentado cuatro veces.
//
// Los números de aquí se eligen contra el fallo REAL que hay que
// sobrevivir, que no es el hipo sino la ventana de mantenimiento del
// receptor: un despliegue que sale mal, un certificado que caduca un
// viernes, un proveedor con un incidente. Ese suceso dura horas, no
// minutos, y se repara en horario de oficina.
//
//   · baseSegundos = 60. El primer reintento tarda un minuto: cubre el
//     hipo sin martillear a un receptor que quizá esté justo cayéndose.
//     Menos que eso convierte cada caída breve en una ráfaga.
//
//   · factor 2. Duplicar es lo que hace que la misma cola sirva para el
//     hipo (minutos) y para el incidente (horas) sin dos políticas.
//
//   · topeSegundos = 21600 (6 h). Sin tope, duplicar es una bomba: con
//     `retry_config.max_retries = 20` la última espera sería de once
//     años. El tope es lo que permite que el número de intentos sea
//     configurable sin que la configuración pueda inventar un plazo
//     absurdo. Y 6 h es el turno: si nadie lo arregló en seis horas,
//     esperar doce no cambia nada.
//
//   · maxIntentos = 12, o sea once esperas: 1, 2, 4, 8, 16, 32, 64 min,
//     2 h08, 4 h16, y dos de 6 h ya topadas. Suman 20 h 31 min: el
//     último intento cae al día siguiente del evento. Un evento de la
//     tarde del viernes sigue vivo el sábado por la tarde. Menos de un
//     turno completo no sobrevive a un incidente nocturno; los tres
//     días de Stripe obligan a retener cuerpos de entrega mucho más
//     tiempo del que aquí se justifica.
//
//     La suma está fijada por prueba (politica-reintento.spec.ts): si
//     alguien cambia un número, el total deja de cuadrar y hay que
//     volver a escribir este párrafo en vez de dejarlo mintiendo.
//
// Los tres son configurables —por entorno, y POR SUSCRIPCIÓN vía
// `webhook_subscriptions.retry_config`, que existe desde la 003 y que
// hasta ahora no leía nadie—. El tope no: es la barandilla.
//
// Y UNA ADVERTENCIA QUE COSTÓ ENCONTRAR: los números de arriba sólo
// gobiernan a la suscripción que no diga otra cosa, y `retry_config` es
// NOT NULL con DEFAULT `{"max_retries": 5, "retry_interval_seconds": 60}`
// desde la 003. Mientras `createWebhook` no escribió esa columna, TODA
// suscripción nacía con ese 5 —el «trámite» de quince minutos que estos
// párrafos dicen haber sustituido— y la ventana de 20 h 31 min no se
// aplicaba en ninguna parte: el defecto del entorno no le llegaba a
// nadie. `retryConfigInicial` cierra el hueco para las suscripciones
// NUEVAS; las creadas antes conservan su 5 hasta que se rellenen con una
// migración, que no es de este frente.
// ============================================================
export const TOPE_ESPERA_SEGUNDOS = 21_600;

/**
 * La política que se ESCRIBE en una suscripción al darla de alta.
 *
 * Existe porque dejar la columna a su DEFAULT no es «heredar la
 * configuración»: es heredar el `{"max_retries": 5}` que puso la
 * migración 003, y `politicaDe` prefiere lo que dice la suscripción sobre
 * lo que dice el entorno. Escribirla al crear es lo único que hace que
 * WEBHOOK_MAX_RETRIES signifique algo para una suscripción nueva.
 */
export function retryConfigInicial(): { max_retries: number; retry_interval_seconds: number } {
  return {
    max_retries: config.webhooks.maxRetries,
    retry_interval_seconds: config.webhooks.retryInterval,
  };
}

/** Amplitud del ruido aleatorio: ±20 % de la espera calculada. */
const JITTER = 0.2;

/**
 * La política efectiva de una suscripción.
 *
 * Precedencia: lo que diga la suscripción, si no el entorno, si no los
 * números de arriba. `retry_config` puede venir de la base con formas
 * imposibles (la columna es JSONB con un DEFAULT, no un tipo), así que
 * cada campo se valida por separado y un valor ilegible NO tumba el
 * barrido: cae al defecto y la entrega se sigue intentando.
 */
export function politicaDe(
  sub: Pick<WebhookSubscription, 'retry_config'> | null | undefined
): PoliticaReintento {
  const crudo = (sub?.retry_config ?? {}) as Partial<{
    max_retries: unknown;
    retry_interval_seconds: unknown;
  }>;

  return {
    maxIntentos: entero(crudo.max_retries, config.webhooks.maxRetries, 1, 50),
    baseSegundos: entero(crudo.retry_interval_seconds, config.webhooks.retryInterval, 1, TOPE_ESPERA_SEGUNDOS),
    topeSegundos: TOPE_ESPERA_SEGUNDOS,
  };
}

/** Entero utilizable, o el defecto. Acota además contra un JSONB hostil. */
function entero(valor: unknown, omision: number, min: number, max: number): number {
  const n = typeof valor === 'number' ? valor : Number.NaN;
  if (!Number.isFinite(n)) return acotar(omision, min, max);
  return acotar(Math.trunc(n), min, max);
}

function acotar(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}

export interface Veredicto {
  /** `true` cuando la entrega agotó sus intentos: se declara muerta. */
  muerta: boolean;
  /** Cuándo vuelve a intentarse. `null` exactamente cuando está muerta. */
  proximoIntento: Date | null;
  /** Espera aplicada, en segundos, ya con tope y ruido. 0 si murió. */
  esperaSegundos: number;
}

/**
 * Qué le toca a una entrega que acaba de fallar su intento número
 * `intentosConsumidos` (ya incrementado: 1 = falló el primer envío).
 *
 * El ruido aleatorio (±20 %) NO es adorno. Cuando un receptor se cae,
 * todas sus entregas fallan casi a la vez y con una espera determinista
 * vuelven TODAS a la vez: el receptor se levanta y recibe la estampida
 * que lo tira otra vez. `aleatorio` se inyecta para que la prueba pueda
 * fijar el valor y comprobar la fórmula, no el azar.
 */
export function veredicto(
  intentosConsumidos: number,
  politica: PoliticaReintento,
  aleatorio: () => number = Math.random
): Veredicto {
  if (intentosConsumidos >= politica.maxIntentos) {
    return { muerta: true, proximoIntento: null, esperaSegundos: 0 };
  }

  // 2^(n-1): tras el primer fallo se espera la base, tras el segundo el
  // doble. El tope se aplica DOS veces —antes del ruido, para que la curva
  // se aplane donde debe, y DESPUÉS, porque un ±20 % sobre una espera ya
  // topada la sacaría un 20 % por encima del tope y entonces el tope no
  // sería un tope sino una sugerencia—. Y nunca menos de un segundo: un
  // reintento inmediato es un martillo, no un reintento.
  const crecida = politica.baseSegundos * Math.pow(2, intentosConsumidos - 1);
  const acotada = Math.min(crecida, politica.topeSegundos);
  const conRuido = acotada * (1 + (aleatorio() * 2 - 1) * JITTER);
  const esperaSegundos = acotar(Math.round(conRuido), 1, politica.topeSegundos);

  return {
    muerta: false,
    proximoIntento: new Date(Date.now() + esperaSegundos * 1000),
    esperaSegundos,
  };
}

/** El texto que queda EN LA FILA diciendo por qué ya nadie la va a intentar. */
export function razonDeMuerte(intentos: number, ultimoError: string): string {
  const causa = ultimoError.trim() || 'sin error registrado';
  return `${MUERTA_PREFIJO} tras ${intentos} intento(s): no se reintentará automáticamente. Último fallo: ${causa}`;
}
