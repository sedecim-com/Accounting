import Redis from 'ioredis';
import { config } from '../../config/index.js';

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (!redis) {
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      retryStrategy(times) {
        if (times > 3) return null;
        return Math.min(times * 200, 2000);
      },
      lazyConnect: true,
    });

    redis.on('error', (err) => {
      console.error('Redis connection error:', err.message);
    });

    redis.connect().catch(() => {
      console.warn('Redis not available, caching disabled');
      redis = null;
    });
  }
  return redis!;
}

const TTL = {
  ACCOUNTS: 3600,        // 1 hour
  EXCHANGE_RATES: 86400,  // 24 hours
  REPORTS: 1800,          // 30 minutes (until invalidated)
  FISCAL_PERIODS: 3600,   // 1 hour
} as const;

// ============================================================
// Layer 1: Chart of Accounts Cache
// ============================================================

export async function getCachedAccounts(entityId: string): Promise<unknown[] | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const data = await r.get(`accounts:${entityId}`);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

export async function setCachedAccounts(entityId: string, accounts: unknown[]): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.setex(`accounts:${entityId}`, TTL.ACCOUNTS, JSON.stringify(accounts));
  } catch { /* ignore */ }
}

export async function invalidateAccountsCache(entityId: string): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.del(`accounts:${entityId}`);
  } catch { /* ignore */ }
}

// ============================================================
// Layer 2: Exchange Rates Cache
// ============================================================

export async function getCachedExchangeRate(
  from: string, to: string, date: string, rateType: string
): Promise<string | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    return await r.get(`fx:${from}:${to}:${date}:${rateType}`);
  } catch { return null; }
}

export async function setCachedExchangeRate(
  from: string, to: string, date: string, rateType: string, rate: string
): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.setex(`fx:${from}:${to}:${date}:${rateType}`, TTL.EXCHANGE_RATES, rate);
  } catch { /* ignore */ }
}

// ============================================================
// Layer 3: Report Results Cache
// ============================================================

export async function getCachedReport(key: string): Promise<unknown | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const data = await r.get(`report:${key}`);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

export async function setCachedReport(key: string, data: unknown): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.setex(`report:${key}`, TTL.REPORTS, JSON.stringify(data));
  } catch { /* ignore */ }
}

export async function invalidateReportCache(entityId: string, periodId?: string): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    // Scan and delete matching keys
    const patterns = [
      `report:trial-balance:${entityId}:*`,
      `report:balance-sheet:${entityId}:*`,
      `report:income-statement:${entityId}:*`,
      `report:cash-flow:${entityId}:*`,
    ];
    for (const pattern of patterns) {
      const keys = await r.keys(pattern);
      if (keys.length > 0) await r.del(...keys);
    }
  } catch { /* ignore */ }
}

// ============================================================
// Fiscal Periods Cache
// ============================================================

export async function getCachedFiscalPeriods(entityId: string): Promise<unknown[] | null> {
  try {
    const r = getRedis();
    if (!r) return null;
    const data = await r.get(`fiscal-periods:${entityId}`);
    return data ? JSON.parse(data) : null;
  } catch { return null; }
}

export async function setCachedFiscalPeriods(entityId: string, periods: unknown[]): Promise<void> {
  try {
    const r = getRedis();
    if (!r) return;
    await r.setex(`fiscal-periods:${entityId}`, TTL.FISCAL_PERIODS, JSON.stringify(periods));
  } catch { /* ignore */ }
}

// ============================================================
// Rate Limiting
// ============================================================

// ============================================================
// «SIN REDIS» Y «REDIS CAÍDO» SON DOS ESTADOS DISTINTOS (S1).
//
// Antes ambos degradaban a allowed:true — fail-open. Aceptable cuando el
// operador decidió no configurar Redis (desarrollo); inaceptable cuando lo
// configuró y se cayó, porque la superficie NO autenticada de adivinación de
// tokens de webhook depende de este límite. La degradación correcta es un
// contador local en memoria: peor que Redis (por proceso, se pierde al
// reiniciar) pero un límite de verdad mientras Redis vuelve.
// ============================================================

const ventanaLocal = new Map<string, { ventana: number; cuenta: number }>();

/** Exportada para pruebas: la degradación debe contarse, no suponerse. */
export function limiteEnMemoria(
  key: string, windowMs: number, maxRequests: number
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const ventana = Math.floor(now / windowMs);
  const entrada = ventanaLocal.get(key);
  const cuenta = entrada && entrada.ventana === ventana ? entrada.cuenta + 1 : 1;
  ventanaLocal.set(key, { ventana, cuenta });
  // Poda oportunista: sin ella, claves únicas (p. ej. por IP) crecerían sin tope.
  if (ventanaLocal.size > 10_000) {
    for (const [k, v] of ventanaLocal) {
      if (v.ventana !== ventana) ventanaLocal.delete(k);
    }
  }
  return {
    allowed: cuenta <= maxRequests,
    remaining: Math.max(0, maxRequests - cuenta),
    resetAt: (ventana + 1) * windowMs,
  };
}

export async function checkRateLimit(
  key: string, windowMs: number, maxRequests: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  const r = getRedis();
  // SIN REDIS TAMPOCO HAY BARRA LIBRE — Y HOY, ADEMÁS, ESTA RAMA NO SE PISA.
  //
  // Antes devolvía allowed:true —«decisión del operador»—, lo que dejaba sin
  // freno a quien no configurara Redis. Dos líneas más abajo, para el caso de
  // Redis configurado pero inalcanzable, el mismo archivo ya decía
  // «degradación local, nunca barra libre». Eran dos respuestas opuestas a la
  // misma pregunta.
  //
  // La corrección importa aunque el camino esté muerto: `getRedis()` no
  // devuelve null nunca —construye el cliente y sólo lo anula después, en el
  // .catch() asíncrono de connect()—, así que esta rama es hoy inalcanzable, y
  // lo era también cuando devolvía true. La «barra libre» que parecía haber
  // aquí tampoco ocurría. Quien recorre el camino de verdad cuando Redis no
  // responde es el catch de abajo.
  //
  // Se deja contando en memoria y no abriendo, porque si algún día getRedis()
  // sí devuelve null lo correcto es contar. Ese límite es por proceso —varias
  // instancias multiplican la cuota y un reinicio la olvida—, así que Redis
  // sigue siendo lo correcto en producción; pero un freno imperfecto vence a
  // ninguno. Pesa más desde que /public/v1 sirve sin credenciales.
  if (!r) return limiteEnMemoria(key, windowMs, maxRequests);
  try {
    const now = Date.now();
    const windowKey = `ratelimit:${key}:${Math.floor(now / windowMs)}`;

    const count = await r.incr(windowKey);
    if (count === 1) {
      await r.pexpire(windowKey, windowMs);
    }

    const remaining = Math.max(0, maxRequests - count);
    const resetAt = (Math.floor(now / windowMs) + 1) * windowMs;

    return { allowed: count <= maxRequests, remaining, resetAt };
  } catch {
    // Redis configurado pero inalcanzable: degradación local, nunca barra libre.
    return limiteEnMemoria(key, windowMs, maxRequests);
  }
}
