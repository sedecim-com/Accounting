import { describe, it, expect, beforeAll } from 'vitest';
import type { Lane } from '../../scripts/language/lane.js';
import { codeLanes } from '../../scripts/language/lanes/code.js';
import { docsLanes } from '../../scripts/language/lanes/docs.js';
import { planLanes } from '../../scripts/language/lanes/plan.js';

// ============================================================
// EL CONTRATO QUE VALE PARA LOS DIECISÉIS (I2 · issue #144)
//
// Cada módulo de carriles prueba lo suyo: qué cuenta, qué no cuenta y que su
// `command` reproduce la cifra. Lo que ninguno puede probar solo es lo que el
// TRINQUETE da por hecho cuando los junta, y esa es la única razón por la que
// este archivo existe.
//
// LA ARITMÉTICA DEL DESGLOSE, Y POR QUÉ TIENE ARCHIVO PROPIO
//
// `lane.ts` dice que `perFile` cuenta por archivo ADEMÁS DE en total. La línea
// base guarda los dos números y `--check` los compara, así que un carril cuyas
// columnas no sumen su total le entrega al trinquete dos verdades sobre el
// mismo hecho: baja por un lado, no baja por el otro, y quien lo mire acabará
// creyendo al que le convenga.
//
// No es una hipótesis. `docs-dead-path-citations` se sembró publicando 196
// —rutas muertas distintas— con un desglose que sumaba 218, porque contaba
// rutas arriba y reparaciones abajo; la prueba del módulo daba por buena la
// diferencia con un `toBeGreaterThanOrEqual`. Un carril con la excepción
// escrita en su propia prueba es un carril sin prueba. Aquí la igualdad se
// exige sobre TODOS los carriles del metro y desde fuera de cada módulo, que
// es el único sitio donde una excepción no se puede conceder a sí misma.
// ============================================================

let LANES: Lane[];

beforeAll(() => {
  // Los tres metros cuestan unos dos segundos juntos y se corren una vez: la
  // población de esta prueba es «todo lo que el trinquete va a publicar», y
  // recortarla a un módulo sería volver al problema.
  LANES = [...codeLanes(), ...docsLanes(), ...planLanes()];
}, 120_000);

describe('lo que el trinquete da por hecho de cualquier carril', () => {
  it('el desglose por archivo suma EXACTAMENTE el total, carril por carril', () => {
    for (const lane of LANES) {
      if (lane.perFile === undefined) continue;
      const sum = Object.values(lane.perFile).reduce((a, b) => a + b, 0);
      expect(sum, `${lane.id}: el desglose suma ${sum} y el total dice ${lane.value}`).toBe(
        lane.value
      );
    }
  });

  it('ninguna columna del desglose vale cero ni menos', () => {
    // Un archivo limpio no es una entrada en cero: es un archivo que ya no está
    // en la lista. La diferencia importa el día que alguien compare dos líneas
    // base y quiera saber qué se cerró.
    for (const lane of LANES) {
      for (const [file, count] of Object.entries(lane.perFile ?? {})) {
        expect(count, `${lane.id}: ${file}`).toBeGreaterThan(0);
      }
    }
  });

  it('los identificadores de carril no se repiten entre módulos', () => {
    // El `id` es la LLAVE de la línea base. Dos carriles con la misma llave se
    // pisan el histórico en silencio: el segundo escribe encima del primero y
    // la serie del que perdió arranca de cero sin que nada avise.
    const ids = LANES.map((lane) => lane.id);
    expect(new Set(ids).size, `ids repetidos en ${ids.join(', ')}`).toBe(ids.length);
  });

  it('cada carril trae lo que hace falta para discutirlo', () => {
    // Sin comando no hay forma de comprobar la cifra fuera del metro, y un
    // número que sólo el metro sabe producir se cree o no se cree.
    for (const lane of LANES) {
      expect(lane.id, `${lane.id}: el id es la llave, y va en inglés kebab-case`).toMatch(
        /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/
      );
      expect(lane.title.length, `${lane.id}: sin título`).toBeGreaterThan(0);
      expect(lane.command.length, `${lane.id}: sin comando`).toBeGreaterThan(0);
      expect(lane.value, `${lane.id}: valor negativo`).toBeGreaterThanOrEqual(0);
      expect((lane.examples ?? []).length, `${lane.id}: más ejemplos que hallazgos`).toBeLessThanOrEqual(
        lane.value
      );
    }
  });
});
