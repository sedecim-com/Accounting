import pg from 'pg';
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config/index.js';
import { resolveSsl } from './ssl.js';
import { openTunnel, rewriteForTunnel, type OpenTunnel } from './tunnel.js';

const { Pool } = pg;

// ============================================================
// POOL PEREZOSO
//
// El pool se construye en el primer uso, no al importar el módulo.
// Es lo que permite levantar un túnel SSH ANTES de que exista la
// conexión: si el pool se creara al cargar, capturaría la cadena
// original y el túnel llegaría tarde.
// ============================================================

let pool: pg.Pool | undefined;
let tunnel: OpenTunnel | undefined;
let effectiveUrl: string | undefined;

/**
 * Levanta el túnel SSH si está configurado. Debe llamarse antes de la primera
 * consulta; es idempotente, así que llamarlo de más no cuesta.
 */
export async function initDatabase(): Promise<{ tunneled: boolean; warning?: string }> {
  if (!config.database.tunnel) {
    const { warning } = resolveSsl({
      connectionString: config.database.url,
      mode: config.database.sslMode,
      caSource: config.database.sslCa,
    });
    return { tunneled: false, warning };
  }
  if (tunnel) return { tunneled: true };

  tunnel = await openTunnel(config.database.tunnel);
  effectiveUrl = rewriteForTunnel(config.database.url, tunnel.localPort);
  return { tunneled: true };
}

function getPool(): pg.Pool {
  if (pool) return pool;

  const connectionString = effectiveUrl ?? config.database.url;
  const { ssl } = resolveSsl({
    // El modo TLS se decide sobre la URL ORIGINAL: a través de un túnel el
    // destino sigue siendo remoto aunque el socket sea local.
    connectionString: config.database.url,
    mode: config.database.sslMode,
    caSource: config.database.sslCa,
  });

  pool = new Pool({
    connectionString,
    min: config.database.poolMin,
    max: config.database.poolMax,
    ...(ssl === undefined ? {} : { ssl }),
  });

  pool.on('error', (err) => {
    console.error('Unexpected database pool error:', err);
  });
  return pool;
}

/** Cierra el pool y, si lo hay, el túnel. */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end().catch(() => undefined);
    pool = undefined;
  }
  if (tunnel) {
    await tunnel.close().catch(() => undefined);
    tunnel = undefined;
    effectiveUrl = undefined;
  }
}

// ============================================================
// TENANT CONTEXT
// When a context is active, every query runs inside a transaction
// with `app.current_tenant` set at local scope, and the RLS
// policies filter. Without context, the behavior is exactly the
// historical one: a single round trip to the pool.
//
// The local scope (SET LOCAL / set_config(..., true)) is not a
// detail: a session-level SET would survive release() and
// contaminate whoever takes that connection next.
// ============================================================

interface DbContext {
  tenantId: string;
}

const dbContext = new AsyncLocalStorage<DbContext>();

/**
 * Runs `fn` with the tenant set: every query() and withTransaction()
 * inside is scoped by that tenant's RLS policies.
 */
export async function withTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return dbContext.run({ tenantId }, fn);
}

/**
 * Sets the tenant for the REST of the execution, without wrapping a callback.
 *
 * It is the right form for a CLI: one process serves one command and operates
 * on one tenant, so there is nothing to exit from. In a server it must NOT be
 * used — it never leaves the context and would leak across requests; there
 * withTenant() applies, which does scope.
 */
export function enterTenant(tenantId: string): void {
  dbContext.enterWith({ tenantId });
}

/** Tenant of the current context, if there is one. */
export function currentTenant(): string | undefined {
  return dbContext.getStore()?.tenantId;
}

/**
 * Sets the tenant on a connection already checked out. set_config with a
 * parameter instead of interpolated `SET LOCAL`: the tenant name comes from
 * data and SET does not accept bound parameters.
 */
async function applyTenant(client: pg.PoolClient, tenantId: string): Promise<void> {
  await client.query('SELECT set_config($1, $2, true)', ['app.current_tenant', tenantId]);
}

function logSlow(start: number, text: string): void {
  const duration = Date.now() - start;
  // Opt-in only: this used to fire on every development run and leaked
  // debug noise into the CLI output a user reads (`Slow query (163ms)…`
  // interleaved with the interface). Enable with MNEMOSINE_DEBUG_SQL=1.
  if (!process.env.MNEMOSINE_DEBUG_SQL) return;
  const threshold = Number(process.env.MNEMOSINE_SLOW_QUERY_MS ?? 100);
  if (duration > threshold) {
    console.warn(`Slow query (${duration}ms):`, text.substring(0, 100));
  }
}

export async function query<T extends pg.QueryResultRow = Record<string, unknown>>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  const start = Date.now();
  const ctx = dbContext.getStore();

  if (!ctx) {
    const result = await getPool().query<T>(text, params);
    logSlow(start, text);
    return result;
  }

  // With context a transaction is required: it is the only thing that gives
  // the local set_config its scope and guarantees it reverts at the end.
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await applyTenant(client, ctx.tenantId);
    const result = await client.query<T>(text, params);
    await client.query('COMMIT');
    logSlow(start, text);
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getClient(): Promise<pg.PoolClient> {
  return getPool().connect();
}

export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  const ctx = dbContext.getStore();
  try {
    await client.query('BEGIN');
    if (ctx) await applyTenant(client, ctx.tenantId);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// setTenantSchema se retiró en S1: cero llamadores e interpolaba el nombre
// del esquema directo en el SQL — el aislamiento real es RLS por
// set_config parametrizado (enterTenant), nunca search_path.

export { getPool };
