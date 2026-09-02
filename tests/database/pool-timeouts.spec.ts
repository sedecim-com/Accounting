import { describe, it, expect, afterEach } from 'vitest';
import { timeouts } from '../../src/database/connection.js';

// ============================================================
// El pool no tenía ningún tope: una consulta bloqueada esperaba hasta que
// alguien matara el proceso, y la petición que no cabía se formaba en una cola
// sin fondo. Lo que se afirma aquí no son las cifras exactas —ésas se ajustan
// con la operación— sino las RELACIONES que las hacen útiles, que son las que
// se rompen sin querer al tocar una sola de las tres.
// ============================================================

const VARIABLES = [
  'DATABASE_STATEMENT_TIMEOUT_MS',
  'DATABASE_LOCK_TIMEOUT_MS',
  'DATABASE_CONNECT_TIMEOUT_MS',
] as const;

afterEach(() => {
  for (const v of VARIABLES) delete process.env[v];
});

describe('topes del pool — las tres esperas están acotadas', () => {
  it('ninguna queda en «para siempre»', () => {
    const t = timeouts();
    expect(t.statement_timeout).toBeGreaterThan(0);
    expect(t.lock_timeout).toBeGreaterThan(0);
    expect(t.connectionTimeoutMillis).toBeGreaterThan(0);
  });

  it('el candado se rinde ANTES que la sentencia', () => {
    // Si lock_timeout subiera por encima de statement_timeout, esperar un
    // candado volvería a reportarse como «la consulta tardó demasiado»: cierto
    // y sin información. El orden es la razón de ser del segundo tope.
    const t = timeouts();
    expect(t.lock_timeout).toBeLessThan(Number(t.statement_timeout));
  });

  it('la sentencia tiene holgura para el cierre de mes y la exportación', () => {
    // El cierre de periodo es una transacción larga de sentencias cortas, pero
    // la exportación por inquilino vuelca tablas enteras. Menos de medio minuto
    // por sentencia empieza a morder operación legítima.
    expect(Number(timeouts().statement_timeout)).toBeGreaterThanOrEqual(30_000);
  });
});

describe('topes del pool — configurables por entorno', () => {
  it('el entorno gana sobre la omisión', () => {
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = '120000';
    expect(timeouts().statement_timeout).toBe(120_000);
  });

  it('0 desactiva, que es el escape para un volcado excepcional', () => {
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = '0';
    expect(timeouts().statement_timeout).toBe(0);
  });

  it('un valor ilegible cae a la omisión, NUNCA al 0 silencioso', () => {
    // En Postgres 0 significa «sin tope». Que una errata de tecleo desactivara
    // el tope sería exactamente el defecto que esto vino a cerrar.
    const omision = timeouts().statement_timeout;
    for (const basura of ['abc', '-1', '']) {
      process.env.DATABASE_STATEMENT_TIMEOUT_MS = basura;
      expect(timeouts().statement_timeout, `con "${basura}"`).toBe(omision);
    }
  });

  it('las tres variables se leen, no sólo la primera', () => {
    process.env.DATABASE_LOCK_TIMEOUT_MS = '3000';
    process.env.DATABASE_CONNECT_TIMEOUT_MS = '4000';
    const t = timeouts();
    expect(t.lock_timeout).toBe(3_000);
    expect(t.connectionTimeoutMillis).toBe(4_000);
  });
});
