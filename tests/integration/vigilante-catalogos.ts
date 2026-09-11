import { beforeAll, afterAll, expect } from 'vitest';
import type pg from 'pg';
import {
  clientePropio,
  censarCatalogosGlobales,
  huellaDeCatalogos,
  compararHuellas,
  explicarDesajustes,
  type Huella,
} from './helpers/catalogos-globales.js';

/**
 * EL VIGILANTE DE CATÁLOGOS GLOBALES.
 *
 * `setupFiles` de la suite de integración: corre DENTRO de cada archivo, así
 * que registra su `beforeAll` antes que ninguno del archivo y su `afterAll`
 * después de todos. El orden no es casualidad ni suerte: vitest resuelve
 * `sequence.hooks` a `'stack'` por omisión, y con 'stack' los `afterAll` se
 * ejecutan en orden INVERSO al de registro. El vigilante se registra primero,
 * luego mira el último — después del `drainAttestations` y del
 * `closeDatabase()` del archivo, y después de cualquier limpieza que el
 * archivo sí haga (la de `f07a`, por ejemplo).
 *
 * De ahí que use su PROPIO cliente y no el pool de la aplicación: para cuando
 * mira, el archivo ya cerró el pool.
 *
 * El porqué de todo esto, y qué cuenta como catálogo, está en
 * `helpers/catalogos-globales.ts`.
 */

let cliente: pg.Client | null = null;
let tablas: string[] = [];
let alLlegar: Huella | null = null;
let archivo = 'este archivo';

beforeAll(async () => {
  archivo = expect.getState().testPath ?? archivo;
  cliente = await clientePropio();
  tablas = await censarCatalogosGlobales(cliente);
  alLlegar = await huellaDeCatalogos(cliente, tablas);
});

afterAll(async () => {
  if (!cliente || !alLlegar) return;
  try {
    const alSalir = await huellaDeCatalogos(cliente, tablas);
    const desajustes = compararHuellas(alLlegar, alSalir);
    if (desajustes.length > 0) throw new Error(explicarDesajustes(archivo, desajustes));
  } finally {
    await cliente.end();
    cliente = null;
    alLlegar = null;
  }
});
