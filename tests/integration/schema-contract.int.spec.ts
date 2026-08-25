import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import { query, closeDatabase } from '../../src/database/connection.js';
import { listarFuentes, escanearArchivo } from './helpers/sql-scan.js';

/**
 * CONTRATO ENTRE EL CÓDIGO Y EL ESQUEMA.
 *
 * Convierte en fallo de CI cualquier consulta que nombre una tabla o una
 * columna que el esquema real no tiene. Corre contra la base efímera, que ya
 * pasó por las 35 migraciones, así que la fuente de verdad es el esquema
 * resultante y no un archivo que alguien recuerde actualizar.
 *
 * ALCANCE (deliberado, para que nadie lo confunda con cobertura total):
 * - Sí: nombres de tabla en FROM / JOIN / INSERT INTO / UPDATE.
 * - Sí: listas de columnas de INSERT INTO tabla (...).
 * - Sí: columnas de SELECT cuando la consulta toca UNA sola tabla sin alias
 *   ni JOIN, donde cada nombre pertenece sin ambigüedad a esa tabla.
 * - No: columnas en WHERE o SET, columnas de SELECT con JOIN, ni vocabularios
 *   de CHECK. Eso exige un parser de SQL de verdad.
 */

const RAIZ = path.join(__dirname, '..', '..', 'src');

let tablasReales: Set<string>;
let columnasPorTabla: Map<string, Set<string>>;

beforeAll(async () => {
  // information_schema.tables NO lista las vistas materializadas, y el código
  // consulta dos: se unen explícitamente.
  const t = await query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
     UNION ALL
     SELECT matviewname FROM pg_matviews WHERE schemaname = 'public'`
  );
  tablasReales = new Set(t.rows.map((r) => r.table_name.toLowerCase()));

  const c = await query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public'`
  );
  columnasPorTabla = new Map();
  for (const r of c.rows) {
    const k = r.table_name.toLowerCase();
    if (!columnasPorTabla.has(k)) columnasPorTabla.set(k, new Set());
    columnasPorTabla.get(k)!.add(r.column_name.toLowerCase());
  }
});

afterAll(async () => {
  await closeDatabase();
});

function rel(p: string): string {
  return path.relative(path.join(RAIZ, '..'), p);
}

describe('contrato código ↔ esquema', () => {
  it('el esquema migrado expone las tablas que el escáner necesita comparar', () => {
    expect(tablasReales.size).toBeGreaterThan(80);
    expect(tablasReales.has('legal_entities')).toBe(true);
    expect(tablasReales.has('journal_entries')).toBe(true);
  });

  it('ninguna consulta nombra una tabla que no existe', () => {
    const faltantes: string[] = [];
    for (const archivo of listarFuentes(RAIZ)) {
      for (const r of escanearArchivo(archivo).tablas) {
        if (!tablasReales.has(r.tabla)) {
          faltantes.push(`${rel(r.archivo)}:${r.linea} → tabla "${r.tabla}"`);
        }
      }
    }
    const unicos = [...new Set(faltantes)].sort();
    expect(
      unicos,
      `Consultas contra tablas inexistentes:\n  ${unicos.join('\n  ')}`
    ).toEqual([]);
  });

  it('ningún SELECT sobre una sola tabla pide una columna que no existe', () => {
    const faltantes: string[] = [];
    for (const archivo of listarFuentes(RAIZ)) {
      for (const r of escanearArchivo(archivo).selects) {
        const cols = columnasPorTabla.get(r.tabla);
        if (!cols) continue;
        for (const c of r.columnas) {
          if (!cols.has(c)) faltantes.push(`${rel(r.archivo)}:${r.linea} → ${r.tabla}.${c}`);
        }
      }
    }
    const unicos = [...new Set(faltantes)].sort();
    expect(
      unicos,
      `SELECT contra columnas inexistentes:\n  ${unicos.join('\n  ')}`
    ).toEqual([]);
  });

  it('ningún INSERT nombra una columna que no existe', () => {
    const faltantes: string[] = [];
    for (const archivo of listarFuentes(RAIZ)) {
      for (const r of escanearArchivo(archivo).inserts) {
        const cols = columnasPorTabla.get(r.tabla);
        if (!cols) continue; // la tabla ya la reporta la prueba anterior
        for (const c of r.columnas) {
          if (!cols.has(c)) {
            faltantes.push(`${rel(r.archivo)}:${r.linea} → ${r.tabla}.${c}`);
          }
        }
      }
    }
    const unicos = [...new Set(faltantes)].sort();
    expect(
      unicos,
      `INSERT contra columnas inexistentes:\n  ${unicos.join('\n  ')}`
    ).toEqual([]);
  });
});
