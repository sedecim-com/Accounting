import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { assertNumeracionUnica } from '../../src/database/migrate.js';

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
