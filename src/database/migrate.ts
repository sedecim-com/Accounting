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
  let fallo = false;
  try {
    // ============================================================
    // EL PISO: FILTRAR EN SILENCIO SE VUELVE ERROR.
    //
    // El corredor conecta como mnemosine_owner, que bajo FORCE ROW LEVEL
    // SECURITY está SUJETO a las políticas y sin GUC de inquilino las evalúa
    // a falso: un INSERT...SELECT sobre una tabla de inquilino "termina bien"
    // habiendo leído CERO filas. Así se perdieron las siembras de la 025 (la
    // confesó la 026) y de la 043 (colisión de folio el 2026-08-31), y los
    // rellenos de la 037 y la purga de secretos de la 040 (reparados por la
    // 046). Con row_security=off Postgres no desactiva RLS: LANZA 42501 en
    // cuanto una política fuera a aplicarse — el mismo default de pg_dump,
    // por la misma razón. Una migración de datos legítima lo declara con
    // `SET LOCAL row_security = on` y el bucle por inquilino (docs/
    // migraciones.md); el opt-in muere con el COMMIT de su transacción.
    // ============================================================
    await client.query('SET row_security = off');
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

      // Ejecutar el .sql y anotarlo en public.migrations son UN acto, no
      // dos. Antes eran dos transacciones implícitas: un fallo entre ambas
      // dejaba la migración aplicada y sin registrar, y la siguiente corrida
      // la re-ejecutaba — lo que revienta en cualquier migración no
      // idempotente y, peor, re-corre los rellenos de datos. El BEGIN
      // envuelve las dos; el ROLLBACK deshace ambas o ninguna.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO public.migrations (filename) VALUES ($1)',
          [file]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
      console.log(`  Completed ${file}`);
    }

    console.log('All migrations complete.');
  } catch (error) {
    console.error('Migration failed:', error);
    fallo = true;
  } finally {
    // El endurecimiento corre SIEMPRE — su comentario decía «ALWAYS» y vivía
    // dentro del try, así que un fallo a mitad de la corrida se lo saltaba:
    // las migraciones que SÍ se aplicaron antes del fallo quedaban con sus
    // tablas creadas y sin política, que es la fuga silenciosa que este
    // bloque existe para impedir. En el finally cubre lo aplicado pase lo
    // que pase, y el proceso sale en rojo igualmente.
    const rlsPath = path.join(__dirname, 'rls-policies.sql');
    if (fs.existsSync(rlsPath)) {
      console.log('  Applying isolation policies...');
      try {
        await client.query(fs.readFileSync(rlsPath, 'utf-8'));
      } catch (rlsError) {
        console.error('Hardening failed:', rlsError);
        fallo = true;
      }
    }
    client.release();
    await pool.end();
  }
  if (fallo) {
    process.exit(1);
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
  // El .catch no es decorativo: runMigrations marca `fallo` y sale por su
  // cuenta ante un error de migracion, pero un rechazo del `finally`
  // (pool.end) escapa a su try/catch interno. Sin este backstop seria un
  // unhandled rejection y el proceso saldria en VERDE tras fallar.
  runMigrations().catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
