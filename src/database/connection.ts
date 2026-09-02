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

// ============================================================
// TOPES DE ESPERA
//
// El pool no tenía ninguno: una consulta bloqueada esperaba hasta que alguien
// matara el proceso, y con `max` conexiones ocupadas la petición siguiente se
// formaba en una cola sin fondo. En el día de cierre —cuando más peticiones
// hay y más largas son— eso no se manifiesta como un error sino como un
// sistema que dejó de responder sin decir por qué.
//
// La operación más larga y LEGÍTIMA del sistema es el cierre de periodo, y
// después la exportación por inquilino (exportacion-inquilino.ts vuelca tablas
// enteras en una transacción REPEATABLE READ). Las cifras de abajo están
// elegidas pensando en ésas, no en la consulta media:
//
//  · El cierre es una TRANSACCIÓN larga hecha de consultas cortas.
//    statement_timeout se aplica por SENTENCIA, no por transacción, así que
//    acotar la sentencia no acorta el cierre: sólo impide que una de sus
//    sentencias se quede colgada para siempre dentro de él.
//  · El runner de migraciones tiene su PROPIO pool (database/migrate.ts, con
//    max: 1), así que nada de esto puede abortar un backfill a la mitad. Es
//    deliberado: una migración larga es correcta, una consulta de la API que
//    dura un minuto no.
// ============================================================

/**
 * Interpreta un tope en milisegundos venido del entorno; 0 lo desactiva.
 *
 * Recibe el VALOR, no el nombre de la variable. Leerlo aquí dentro con
 * `process.env[nombre]` funcionaba igual y escondía los nombres: no salían en
 * un grep ni en el censo que compara el código contra .env.example
 * (tests/config/env-example.spec.ts), así que las tres variables quedaban
 * indocumentadas sin que nada se quejara. Con el acceso literal en cada
 * llamada, el nombre se ve desde fuera.
 */
function topeMs(crudo: string | undefined, omision: number): number {
  if (crudo === undefined || crudo.trim() === '') return omision;
  const n = Number(crudo);
  // Un valor ilegible NO cae al 0 silencioso —que en Postgres significa «sin
  // tope»— porque sería justo el defecto que esto viene a cerrar.
  if (!Number.isFinite(n) || n < 0) return omision;
  return Math.floor(n);
}

/** Exportada para que la relación entre los tres topes se pueda afirmar en una
 *  prueba: que lock_timeout quede por debajo de statement_timeout no es un
 *  detalle de estilo, es lo que hace distinguible un candado de una lentitud. */
export function timeouts(): Pick<
  pg.PoolConfig,
  'statement_timeout' | 'lock_timeout' | 'connectionTimeoutMillis'
> {
  return {
    // 60 s. Ninguna sentencia de este sistema tarda un minuto por trabajar: el
    // agregado más pesado de un informe anual y el volcado de una tabla en la
    // exportación se miden en segundos, así que el minuto deja un orden de
    // magnitud de holgura. Pasado ese punto lo que hay es un índice que falta o
    // un bloqueo, y conviene más un error con nombre que una espera indefinida.
    // Para un volcado excepcionalmente grande, DATABASE_STATEMENT_TIMEOUT_MS=0
    // lo desactiva para esa corrida.
    statement_timeout: topeMs(process.env.DATABASE_STATEMENT_TIMEOUT_MS, 60_000),

    // 10 s, y DEBAJO del anterior a propósito. Sin lock_timeout, una sentencia
    // que espera un candado consume el minuto entero de statement_timeout y
    // termina reportando «tardó demasiado», que es cierto y no dice nada. Con
    // este tope el bloqueo se distingue de la lentitud a los diez segundos: el
    // cierre de periodo toma candado sobre el ejercicio, y un segundo cierre
    // simultáneo debe enterarse de que está ocupado, no agonizar un minuto.
    lock_timeout: topeMs(process.env.DATABASE_LOCK_TIMEOUT_MS, 10_000),

    // 10 s. En pg-pool esta cifra acota DOS esperas distintas: el saludo de una
    // conexión nueva, y —lo que importa aquí— el tiempo que una petición pasa
    // en la cola cuando las `max` conexiones están ocupadas. Ésa es la petición
    // 21 del día de cierre: hoy espera para siempre, y con esto recibe un fallo
    // a los diez segundos que el cliente puede reintentar y el balanceador
    // puede contar. Diez y no dos porque una conexión fría a través del túnel
    // SSH o con verify-full tarda más que una local.
    connectionTimeoutMillis: topeMs(process.env.DATABASE_CONNECT_TIMEOUT_MS, 10_000),
  };
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
    ...timeouts(),
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
