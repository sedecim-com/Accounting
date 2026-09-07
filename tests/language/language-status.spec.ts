import { describe, it, expect } from 'vitest';
import { comparar, apretar } from '../../scripts/language-status.js';
import type { Lane } from '../../scripts/language/lane.js';

// ============================================================
// LA MAQUINARIA DEL TRINQUETE (I2 · issue #144)
//
// Los carriles tienen sus propias pruebas: cuentan bien o no. Esto prueba lo
// OTRO, que es donde un trinquete se rompe sin que se note — cómo compara
// contra la línea base y cómo la aprieta.
//
// Se prueba sobre carriles SINTÉTICOS y no sobre el árbol real a propósito:
// una prueba que dependa de las cifras de hoy se pone roja cada vez que
// alguien traduce un archivo, y a la tercera vez se borra.
// ============================================================

const carril = (id: string, value: number, perFile?: Record<string, number>): Lane => ({
  id,
  title: id,
  value,
  target: 0,
  command: `echo ${id}`,
  ...(perFile ? { perFile } : {}),
});

const baseDe = (carriles: Record<string, number>, porArchivo: Record<string, Record<string, number>> = {}) => ({
  _: '',
  _por_que: '',
  sembrada: '2026-01-01',
  carriles,
  porArchivo,
});

describe('comparar — qué cuenta como retroceso', () => {
  it('un carril que crece se acusa, y uno que baja no', () => {
    const h = comparar([carril('a', 11), carril('b', 4)], baseDe({ a: 10, b: 9 }));
    expect(h).toHaveLength(1);
    expect(h[0].carril).toBe('a');
    expect(h[0].detalle).toContain('10 → 11');
  });

  it('un carril igual a su línea base NO es retroceso', () => {
    // Si el empate contara, el trinquete exigiría bajar en cada PR y sería
    // imposible tocar nada sin pagar deuda ajena.
    expect(comparar([carril('a', 10)], baseDe({ a: 10 }))).toEqual([]);
  });

  it('UN ARCHIVO QUE EMPEORA SE ACUSA AUNQUE EL TOTAL NO CREZCA', () => {
    // Es la razón de ser del desglose. Con sólo el total, traducir un archivo
    // y ensuciar otro sale gratis, y el carril se queda quieto mientras la
    // deuda se mueve de sitio.
    const h = comparar(
      [carril('a', 10, { 'x.ts': 8, 'y.ts': 2 })],
      baseDe({ a: 10 }, { a: { 'x.ts': 4, 'y.ts': 6 } })
    );
    expect(h).toHaveLength(1);
    expect(h[0].detalle).toContain('x.ts: creció 4 → 8');
  });

  it('UNA ENTRADA MUERTA SE ACUSA: el trinquete no puede cuidar lo que ya no se mide', () => {
    // El fallo silencioso: se borra un carril, su entrada se queda, y la línea
    // base protege algo que no existe. Se ve verde para siempre.
    const h = comparar([carril('a', 1)], baseDe({ a: 1, fantasma: 7 }));
    expect(h).toHaveLength(1);
    expect(h[0].carril).toBe('fantasma');
    expect(h[0].detalle).toContain('ya no se mide');
  });

  it('un carril nuevo sin línea base se nombra, no se ignora', () => {
    const h = comparar([carril('nuevo', 3)], baseDe({}));
    expect(h[0].detalle).toContain('siémbralo');
  });
});

describe('apretar — sólo baja', () => {
  it('baja lo que tiene holgura', () => {
    const b = apretar([carril('a', 4)], baseDe({ a: 10 }));
    expect(b.carriles.a).toBe(4);
  });

  it('NO SUBE, y ésta es la prueba que hace del archivo un trinquete', () => {
    // Si `--apretar` subiera, bastaría con correrlo tras una regresión para
    // que el retroceso quedara bendecido y sin rastro en el diff. Subir tiene
    // que costar una edición a mano que alguien pueda ver en la revisión.
    const b = apretar([carril('a', 99)], baseDe({ a: 10 }));
    expect(b.carriles.a).toBe(10);
  });

  it('el desglose también baja y también se niega a subir', () => {
    const b = apretar(
      [carril('a', 10, { 'x.ts': 1, 'y.ts': 50 })],
      baseDe({ a: 10 }, { a: { 'x.ts': 9, 'y.ts': 9 } })
    );
    expect(b.porArchivo.a['x.ts']).toBe(1);
    expect(b.porArchivo.a['y.ts']).toBe(9);
  });

  it('un carril que desapareció sale de la línea base en vez de quedarse de adorno', () => {
    const b = apretar([carril('a', 1)], baseDe({ a: 1, fantasma: 7 }));
    expect(Object.keys(b.carriles)).toEqual(['a']);
  });
});
