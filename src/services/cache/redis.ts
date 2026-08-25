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

export async function checkRateLimit(
  key: string, windowMs: number, maxRequests: number
): Promise<{ allowed: boolean; remaining: number; resetAt: number }> {
  try {
    const r = getRedis();
    if (!r) return { allowed: true, remaining: maxRequests, resetAt: 0 };

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
    return { allowed: true, remaining: maxRequests, resetAt: 0 };
  }
}
