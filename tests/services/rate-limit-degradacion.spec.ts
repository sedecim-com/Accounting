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
