import { describe, it, expect, vi } from 'vitest';
import { limiteEnMemoria } from '../../src/services/cache/redis.js';

/**
 * «SIN REDIS» Y «REDIS CAÍDO» SON DOS ESTADOS DISTINTOS (S1).
 *
 * El fail-open anterior convertía una caída de Redis en barra libre para la
 * superficie NO autenticada de adivinación de tokens de webhook. La
 * degradación correcta es un contador local: peor que Redis, pero un límite
 * de verdad.
 */
describe('limiteEnMemoria', () => {
  it('cuenta dentro de la ventana y niega al rebasar el máximo', () => {
    const key = `t-${Math.floor(performance.now() * 1000)}`;
    const w = 60_000;
    for (let i = 1; i <= 3; i++) {
      const r = limiteEnMemoria(key, w, 3);
      expect(r.allowed).toBe(true);
      expect(r.remaining).toBe(3 - i);
    }
    const cuarto = limiteEnMemoria(key, w, 3);
    expect(cuarto.allowed).toBe(false);
    expect(cuarto.remaining).toBe(0);
    expect(cuarto.resetAt).toBeGreaterThan(0);
  });

  it('claves distintas no comparten cuenta', () => {
    const w = 60_000;
    const a = `a-${Math.floor(performance.now() * 1000)}`;
    const b = `b-${Math.floor(performance.now() * 1000)}`;
    limiteEnMemoria(a, w, 1);
    expect(limiteEnMemoria(a, w, 1).allowed).toBe(false);
    expect(limiteEnMemoria(b, w, 1).allowed).toBe(true);
  });
});

/**
 * LA DEGRADACIÓN REAL OCURRE EN EL `catch`, NO EN LA RAMA `if (!r)`.
 *
 * Escribí antes una prueba titulada «sin Redis configurado» que resultó floja
 * en CI, y al perseguirla apareció algo más útil: `getRedis()` NUNCA devuelve
 * null. Construye el cliente y lo devuelve (`return redis!`); sólo lo anula
 * después, dentro del `.catch()` asíncrono de `connect()`. De modo que la rama
 * `if (!r)` de checkRateLimit es inalcanzable en la práctica —lo era también
 * cuando devolvía allowed:true— y una prueba que dependa de alcanzarla depende
 * en realidad de una carrera.
 *
 * El camino que SÍ se recorre cuando Redis no responde es el `catch` de
 * `r.incr()`, y eso es lo que se fija aquí, con un cliente que falla a
 * propósito: cuenta, niega al rebasar, y nunca deja barra libre.
 */
describe('checkRateLimit con Redis inalcanzable', () => {
  it('cae al contador local: cuenta, niega, y no deja barra libre', async () => {
    vi.resetModules();
    vi.doMock('ioredis', () => ({
      default: class {
        on() { return this; }
        connect() { return Promise.resolve(); }
        incr() { return Promise.reject(new Error('ECONNREFUSED')); }
        pexpire() { return Promise.resolve(); }
      },
    }));
    const { checkRateLimit } = await import('../../src/services/cache/redis.js');
    const key = `caido-${Math.floor(performance.now() * 1000)}`;
    const w = 60_000;

    const primera = await checkRateLimit(key, w, 2);
    expect(primera.allowed).toBe(true);
    // Que CUENTE es la prueba: con barra libre, remaining sería siempre el
    // máximo y resetAt cero.
    expect(primera.remaining).toBe(1);
    expect(primera.resetAt).toBeGreaterThan(0);

    await checkRateLimit(key, w, 2);
    const tercera = await checkRateLimit(key, w, 2);
    expect(tercera.allowed).toBe(false);
    expect(tercera.remaining).toBe(0);
    vi.doUnmock('ioredis');
  });
});
