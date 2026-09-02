import { describe, it, expect } from 'vitest';
import {
  FLOOR_MAX_AUTO_POST,
  FLOOR_MAX_OP_AGE_DAYS,
  floorMaxAutoAmount,
  isOpStale,
  floorTolerancia,
} from '../../src/ai/floor.js';

describe('the unbreakable floor', () => {
  it('pins the constants: changing them is a deliberate act, not a refactor', () => {
    expect(FLOOR_MAX_AUTO_POST).toBe(50000);
    expect(FLOOR_MAX_OP_AGE_DAYS).toBe(30);
  });
});

describe('floorMaxAutoAmount', () => {
  it('keeps a configured cap below the floor', () => {
    expect(floorMaxAutoAmount(10000)).toBe(10000);
    expect(floorMaxAutoAmount(0)).toBe(0);
  });

  it('clamps a configured cap above the floor — config can never raise it', () => {
    expect(floorMaxAutoAmount(1_000_000)).toBe(FLOOR_MAX_AUTO_POST);
    expect(floorMaxAutoAmount(FLOOR_MAX_AUTO_POST + 0.01)).toBe(FLOOR_MAX_AUTO_POST);
  });

  it('allows exactly the floor', () => {
    expect(floorMaxAutoAmount(FLOOR_MAX_AUTO_POST)).toBe(FLOOR_MAX_AUTO_POST);
  });

  it('fails CLOSED on garbage config (NaN, Infinity, negative → 0, nothing auto-posts)', () => {
    expect(floorMaxAutoAmount(NaN)).toBe(0);
    expect(floorMaxAutoAmount(Infinity)).toBe(0);
    expect(floorMaxAutoAmount(-5)).toBe(0);
  });
});

describe('isOpStale', () => {
  const NOW = new Date('2026-08-24T12:00:00Z');
  const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

  it('a fresh op is not stale', () => {
    expect(isOpStale(daysAgo(0), NOW)).toBe(false);
    expect(isOpStale(daysAgo(29), NOW)).toBe(false);
  });

  it('exactly the limit is still executable; strictly older is stale', () => {
    expect(isOpStale(daysAgo(FLOOR_MAX_OP_AGE_DAYS), NOW)).toBe(false);
    expect(isOpStale(daysAgo(FLOOR_MAX_OP_AGE_DAYS + 0.001), NOW)).toBe(true);
    expect(isOpStale(daysAgo(31), NOW)).toBe(true);
  });

  it('accepts an ISO string timestamp', () => {
    expect(isOpStale('2026-08-20T00:00:00Z', NOW)).toBe(false);
    expect(isOpStale('2026-07-01T00:00:00Z', NOW)).toBe(true);
  });

  it('an unparseable timestamp fails CLOSED (stale)', () => {
    expect(isOpStale('not a date', NOW)).toBe(true);
  });
});

/**
 * `floorTolerancia` falla cerrado, y su propio docblock nombraba un caso que
 * NO fallaba cerrado.
 *
 * Decía que `1e400` tiene que dar cero «porque un parseFloat daría Infinity», y
 * la guarda que lo perseguía era `isFinite()`. Pero decimal.js no es coma
 * flotante: su exponente llega mucho más lejos, así que `1e400` es un Decimal
 * perfectamente finito, la guarda no se disparaba, y el valor salía por
 * `Decimal.min` convertido en EL TECHO — la tolerancia más permisiva que la ley
 * permite, a partir de un campo mal capturado. Lo contrario de fallar cerrado,
 * en el módulo cuya única tesis es fallar cerrado.
 *
 * El criterio correcto no es la finitud sino la representabilidad: una
 * tolerancia es un importe, y los importes viven en DECIMAL(19,4).
 */
describe('floorTolerancia', () => {
  it('lo ilegible, lo negativo y lo vacío valen cero', () => {
    for (const v of ['abc', '-5', '', '  ']) {
      expect(floorTolerancia(v), v).toBe('0.0000');
    }
  });

  it('lo que no cabe en una columna de dinero vale cero, no el techo', () => {
    // El caso que el docblock nombraba y la guarda no cazaba.
    expect(floorTolerancia('1e400')).toBe('0.0000');
    expect(floorTolerancia('1e15')).toBe('0.0000');
  });

  it('pero un importe legítimo y enorme SÍ se acota al techo', () => {
    // La corrección tenía que distinguir «no es dinero» de «es mucho dinero».
    // Recortar los dos a cero habría cambiado un fallo abierto por uno cerrado
    // de más, y una tolerancia grande y válida es una decisión del despacho.
    expect(floorTolerancia('1e14')).not.toBe('0.0000');
  });

  it('y lo que cabe por debajo del techo pasa tal cual', () => {
    expect(floorTolerancia('120')).toBe('120.0000');
    expect(floorTolerancia('0')).toBe('0.0000');
  });
});
