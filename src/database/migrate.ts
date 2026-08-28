import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { config } from '../config/index.js';

// __dirname is available natively under CommonJS output (tsx/node)

// Dedicated pool: migrations run DDL and connect as mnemosine_owner,
// separate from the application role. The pool from connection.ts is
// deliberately NOT imported — that one carries the tenant context and the DDL-less role.
const pool = new pg.Pool({ connectionString: config.database.migrationUrl, max: 1 });

/**
 * Cuatro números quedaron duplicados antes de que existiera esta guarda y ya
 * están aplicados en bases desplegadas: renumerarlos rompería instalaciones,
 * así que se documentan y se toleran. Cualquier duplicado NUEVO es un error.
 * Reparto de rangos para el plan de cierre en docs/migraciones.md.
 */
const DUPLICADOS_HISTORICOS = new Set(['012', '014', '015', '018']);

export function assertNumeracionUnica(files: string[]): void {
  const porNumero = new Map<string, string[]>();
  for (const f of files) {
    const n = f.slice(0, 3);
    if (!/^\d{3}$/.test(n)) {
      throw new Error(`Migración sin prefijo numérico de tres dígitos: ${f}`);
    }
    porNumero.set(n, [...(porNumero.get(n) ?? []), f]);
  }
  const choques = [...porNumero.entries()]
    .filter(([n, fs]) => fs.length > 1 && !DUPLICADOS_HISTORICOS.has(n))
    .map(([n, fs]) => `  ${n}: ${fs.join(', ')}`);
  if (choques.length > 0) {
    const libre = String(
      Math.max(...[...porNumero.keys()].map(Number)) + 1
    ).padStart(3, '0');
    throw new Error(
      `Números de migración duplicados (el siguiente libre es ${libre}):\n${choques.join('\n')}`
    );
  }
}

async function runMigrations() {
  const client = await pool.connect();
  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.migrations (
        id SERIAL PRIMARY KEY,
        filename VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const migrationsDir = path.join(__dirname, 'migrations');
    const files = fs.readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    assertNumeracionUnica(files);

    for (const file of files) {
      const existing = await client.query(
        'SELECT id FROM public.migrations WHERE filename = $1',
        [file]
      );

      if (existing.rows.length > 0) {
        console.log(`  Skipping ${file} (already executed)`);
        continue;
      }

      console.log(`  Executing ${file}...`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
      await client.query(sql);

      await client.query(
        'INSERT INTO public.migrations (filename) VALUES ($1)',
        [file]
      );
      console.log(`  Completed ${file}`);
    }

    // ALWAYS re-harden: a migration may have created new tables, and a
    // table with tenant_id but no policy is a silent leak.
    const rlsPath = path.join(__dirname, 'rls-policies.sql');
    if (fs.existsSync(rlsPath)) {
      console.log('  Applying isolation policies...');
      await client.query(fs.readFileSync(rlsPath, 'utf-8'));
    }

    console.log('All migrations complete.');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// ============================================================
// MIGRAR SÓLO CUANDO SE INVOCA, NO CUANDO SE IMPORTA
//
// `runMigrations()` estaba aquí suelta, y este archivo exporta además
// assertNumeracionUnica, que una prueba unitaria importa. El import ejecutaba
// las migraciones: en CI —donde el job unitario NO tiene Postgres a propósito—
// eso reventaba con ECONNREFUSED y ponía el job en rojo con las 2007 pruebas
// en verde, porque vitest falla ante un error no manejado aunque no falle
// ninguna aserción. En la máquina de quien desarrolla no se veía: había un
// Postgres escuchando, así que `npm test` migraba su base sin decírselo.
//
// Es el mismo cerrojo que ya lleva mnemosine.ts: bajo CJS (tsx / node dist)
// require.main identifica al archivo que se invocó.
// ============================================================
if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  runMigrations();
}
