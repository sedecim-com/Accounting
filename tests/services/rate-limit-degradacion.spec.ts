import { describe, it, expect } from 'vitest';
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
 * Y «SIN REDIS CONFIGURADO» ERA EL TERCER ESTADO, EL QUE SEGUÍA ABIERTO.
 *
 * La rama de Redis caído ya degradaba al contador local —«nunca barra libre»,
 * dice el archivo—, pero la de Redis ausente devolvía allowed:true sin contar
 * nada. Dos respuestas opuestas a la misma pregunta, y la abierta era la del
 * despliegue que olvida configurarlo: justamente el que no quiere quedar sin
 * freno, ahora que /public/v1 sirve sin credenciales.
 */
describe('checkRateLimit sin Redis configurado', () => {
  it('cuenta y niega igual que con Redis caído: no devuelve barra libre', async () => {
    const { checkRateLimit } = await import('../../src/services/cache/redis.js');
    const key = `sinredis-${Math.floor(performance.now() * 1000)}`;
    const w = 60_000;

    const primera = await checkRateLimit(key, w, 2);
    expect(primera.allowed).toBe(true);
    // La prueba de que CUENTA: si fuera barra libre, remaining sería siempre
    // el máximo y resetAt cero.
    expect(primera.remaining).toBe(1);
    expect(primera.resetAt).toBeGreaterThan(0);

    await checkRateLimit(key, w, 2);
    const tercera = await checkRateLimit(key, w, 2);
    expect(tercera.allowed).toBe(false);
    expect(tercera.remaining).toBe(0);
  });
});
