import { describe, it, expect } from 'vitest';
import { compare, tighten } from '../../scripts/language-status.js';
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

const lane = (id: string, value: number, perFile?: Record<string, number>): Lane => ({
  id,
  title: id,
  value,
  target: 0,
  command: `echo ${id}`,
  ...(perFile ? { perFile } : {}),
});

const baselineOf = (lanes: Record<string, number>, perFile: Record<string, Record<string, number>> = {}) => ({
  _: '',
  _por_que: '',
  seeded: '2026-01-01',
  lanes,
  perFile,
});

describe('comparar — qué cuenta como retroceso', () => {
  it('un carril que crece se acusa, y uno que baja no', () => {
    const h = compare([lane('a', 11), lane('b', 4)], baselineOf({ a: 10, b: 9 }));
    expect(h).toHaveLength(1);
    expect(h[0].lane).toBe('a');
    expect(h[0].detail).toContain('10 → 11');
  });

  it('un carril igual a su línea base NO es retroceso', () => {
    // Si el empate contara, el trinquete exigiría bajar en cada PR y sería
    // imposible tocar nada sin pagar deuda ajena.
    expect(compare([lane('a', 10)], baselineOf({ a: 10 }))).toEqual([]);
  });

  it('UN ARCHIVO QUE EMPEORA SE ACUSA AUNQUE EL TOTAL NO CREZCA', () => {
    // Es la razón de ser del desglose. Con sólo el total, traducir un archivo
    // y ensuciar otro sale gratis, y el carril se queda quieto mientras la
    // deuda se mueve de sitio.
    const h = compare(
      [lane('a', 10, { 'x.ts': 8, 'y.ts': 2 })],
      baselineOf({ a: 10 }, { a: { 'x.ts': 4, 'y.ts': 6 } })
    );
    expect(h).toHaveLength(1);
    expect(h[0].detail).toContain('x.ts: creció 4 → 8');
  });

  it('LA DEUDA NO SE ESCAPA A UN ARCHIVO NUEVO: sin entrada, el suelo es cero', () => {
    // El agujero que encontró la revisión de I2 (WIT-01). El desglose sólo
    // auditaba archivos que YA tenían entrada, así que la deuda tenía una
    // salida: sacar una unidad de un archivo vigilado y meterla en uno que
    // nadie vigila. El total del carril no se mueve —10 sigue siendo 10— y
    // el desglose no dice nada, que es exactamente el desplazamiento que el
    // desglose existe para impedir.
    //
    // Con el suelo cero implícito, el archivo nuevo tiene que justificarse.
    const h = compare(
      [lane('a', 10, { 'x.ts': 9, 'nuevo.ts': 1 })],
      baselineOf({ a: 10 }, { a: { 'x.ts': 10 } })
    );
    expect(h).toHaveLength(1);
    expect(h[0].lane).toBe('a');
    expect(h[0].detail).toContain('nuevo.ts');
    expect(h[0].detail).toContain('0 → 1');
    // Y que haya hallazgo es que `--check` sale con 1: ese es su único
    // criterio (`findings.length === 0`), no hay otra puerta.
    expect(h.length).toBeGreaterThan(0);
  });

  it('un archivo que DESAPARECE del desglose no es hallazgo: desaparecer es llegar a cero', () => {
    // La otra cara de la misma regla. El desglose sólo lista archivos con
    // deuda; si `y.ts` se traduce entero, deja la lista. Acusarlo convertiría
    // cada traducción terminada en un rojo, y el trinquete se borraría.
    const h = compare(
      [lane('a', 4, { 'x.ts': 4 })],
      baselineOf({ a: 10 }, { a: { 'x.ts': 4, 'y.ts': 6 } })
    );
    expect(h).toEqual([]);
  });

  it('UNA ENTRADA MUERTA SE ACUSA: el trinquete no puede cuidar lo que ya no se mide', () => {
    // El fallo silencioso: se borra un carril, su entrada se queda, y la línea
    // base protege algo que no existe. Se ve verde para siempre.
    const h = compare([lane('a', 1)], baselineOf({ a: 1, fantasma: 7 }));
    expect(h).toHaveLength(1);
    expect(h[0].lane).toBe('fantasma');
    expect(h[0].detail).toContain('ya no se mide');
  });

  it('un carril nuevo sin línea base se nombra, no se ignora', () => {
    const h = compare([lane('nuevo', 3)], baselineOf({}));
    expect(h[0].detail).toContain('siémbralo');
  });
});

describe('apretar — sólo baja', () => {
  it('baja lo que tiene holgura', () => {
    const b = tighten([lane('a', 4)], baselineOf({ a: 10 }));
    expect(b.lanes.a).toBe(4);
  });

  it('NO SUBE, y ésta es la prueba que hace del archivo un trinquete', () => {
    // Si `--apretar` subiera, bastaría con correrlo tras una regresión para
    // que el retroceso quedara bendecido y sin rastro en el diff. Subir tiene
    // que costar una edición a mano que alguien pueda ver en la revisión.
    const b = tighten([lane('a', 99)], baselineOf({ a: 10 }));
    expect(b.lanes.a).toBe(10);
  });

  it('el desglose también baja y también se niega a subir', () => {
    const b = tighten(
      [lane('a', 10, { 'x.ts': 1, 'y.ts': 50 })],
      baselineOf({ a: 10 }, { a: { 'x.ts': 9, 'y.ts': 9 } })
    );
    expect(b.perFile.a['x.ts']).toBe(1);
    expect(b.perFile.a['y.ts']).toBe(9);
  });

  it('un carril que desapareció sale de la línea base en vez de quedarse de adorno', () => {
    const b = tighten([lane('a', 1)], baselineOf({ a: 1, fantasma: 7 }));
    expect(Object.keys(b.lanes)).toEqual(['a']);
  });
});
