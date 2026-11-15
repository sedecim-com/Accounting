import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertNextIsMaxPlusOne,
  assertNumeracionUnica,
  LAST_OUT_OF_SEQUENCE_MIGRATION,
} from '../../src/database/migrate.js';

const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');

/**
 * Los NUEVE archivos que comparten cuatro números y ya están aplicados en bases
 * desplegadas. Se escriben aquí LITERALMENTE, y no se derivan del directorio, a
 * propósito: una prueba que lee el árbol y lo compara consigo misma es una
 * tautología que pasa con cualquier guarda, incluida la rota.
 */
const HISTORICOS = [
  '012_ai_drafts_unique_source.sql',
  '012_fix_mv_account_balance_summary.sql',
  '014_ai_external_ops.sql',
  '014_fiscal_credentials.sql',
  '014_rls_tenant_isolation.sql',
  '015_account_roles.sql',
  '015_identities.sql',
  '018_ai_sessions.sql',
  '018_fix_account_roles_unique.sql',
];

describe('numeración de migraciones', () => {
  it('el árbol actual pasa la guarda', () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(() => assertNumeracionUnica(files)).not.toThrow();
  });

  it('rechaza un duplicado nuevo y dice cuál es el siguiente número libre', () => {
    const files = ['001_a.sql', '030_b.sql', '031_c.sql', '031_d.sql'];
    expect(() => assertNumeracionUnica(files)).toThrow(/031: 031_c\.sql, 031_d\.sql/);
    expect(() => assertNumeracionUnica(files)).toThrow(/siguiente libre es 032/);
  });

  it('tolera los nueve históricos, y los tolera por su NOMBRE', () => {
    expect(() => assertNumeracionUnica([...HISTORICOS])).not.toThrow();
    // Los nueve siguen existiendo: si alguien renumera uno, la lista de
    // migrate.ts pasa a perdonar a un fantasma y hay que enterarse aquí.
    const enDisco = new Set(fs.readdirSync(DIR));
    for (const h of HISTORICOS) expect(enDisco.has(h), `${h} ya no está en el árbol`).toBe(true);
  });

  it('rechaza un archivo NUEVO que reutilice un número histórico, y señala al intruso', () => {
    // ESTA es la prueba que faltaba, y la razón del issue #88: la guarda
    // perdonaba el PREFIJO, así que este archivo pasaba, y como el orden de
    // ejecución es files.sort(), corría antes de las 015 a 069.
    const intruso = '014_migracion_nueva_de_hoy.sql';
    expect(() => assertNumeracionUnica([...HISTORICOS, intruso])).toThrow(/014_migracion_nueva_de_hoy\.sql/);
    expect(() => assertNumeracionUnica([...HISTORICOS, intruso])).toThrow(/sobra/);
  });

  it('rechaza también el intruso contra el árbol REAL, no sólo contra la lista', () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(() => assertNumeracionUnica([...files, '018_lo_que_sea.sql'])).toThrow(/018_lo_que_sea\.sql/);
  });

  it('rechaza un archivo sin prefijo numérico', () => {
    expect(() => assertNumeracionUnica(['fix_algo.sql'])).toThrow(/sin prefijo numérico/);
  });
});

describe('the max + 1 rule (#158)', () => {
  // The three jumps that happened before the rule had a guard, written out
  // literally for the same reason HISTORICOS is: read from the tree, they
  // would prove nothing.
  const JUMPS = [
    [176, 250],
    [250, 310],
    [310, 324],
  ];

  it('the current tree passes the guard', () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
    expect(() => assertNextIsMaxPlusOne(files)).not.toThrow();
  });

  it('the three historical jumps are still in the tree, and 324 is the last one', () => {
    const numbers = new Set(
      fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).map((f) => Number(f.slice(0, 3)))
    );
    for (const [from, to] of JUMPS) {
      expect(numbers.has(from), `${from} is gone from the tree`).toBe(true);
      expect(numbers.has(to), `${to} is gone from the tree`).toBe(true);
      for (let n = from + 1; n < to; n++) expect(numbers.has(n), `${n} filled the jump`).toBe(false);
    }
    expect(LAST_OUT_OF_SEQUENCE_MIGRATION).toBe(324);
  });

  it('no new migration takes a number of 324 or less, not even to fill an old gap', () => {
    // 118 files, the four historical duplicates included, were numbered 324
    // or less on 15 Nov 2026. The guard only judges what comes after 324, so
    // this count is what stops a new file from slipping into an old gap.
    const upTo324 = fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) <= LAST_OUT_OF_SEQUENCE_MIGRATION);
    expect(upTo324).toHaveLength(118);
  });

  it('accepts the next numbers in order', () => {
    expect(() => assertNextIsMaxPlusOne(['324_a.sql', '325_b.sql', '326_c.sql'])).not.toThrow();
  });

  it('rejects a jump after 324 and names the number that was due', () => {
    const files = ['324_a.sql', '325_b.sql', '327_c.sql'];
    expect(() => assertNextIsMaxPlusOne(files)).toThrow(/Migration 327 breaks the max \+ 1 rule/);
    expect(() => assertNextIsMaxPlusOne(files)).toThrow(/the next number is 326/);
  });

  it('rejects a first new migration that skips 325', () => {
    expect(() => assertNextIsMaxPlusOne(['324_a.sql', '330_b.sql'])).toThrow(/the next number is 325/);
  });

  it('leaves the numbers up to 324 alone, gaps included', () => {
    expect(() => assertNextIsMaxPlusOne(['095_a.sql', '102_b.sql', '250_c.sql', '324_d.sql'])).not.toThrow();
  });
});
