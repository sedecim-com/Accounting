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
 * Nueve archivos quedaron compartiendo cuatro números antes de que existiera
 * esta guarda y ya están aplicados en bases desplegadas: renumerarlos rompería
 * instalaciones, así que se documentan y se toleran.
 *
 * SON NOMBRES, NO PREFIJOS, Y ESA ES TODA LA GUARDA (#88). Hasta T1 esto era
 * `new Set(['012','014','015','018'])` —los NÚMEROS—, así que el perdón cubría
 * también a los archivos que aún no existían: un `014_migracion_nueva_de_hoy.sql`
 * pasaba la guarda, y como el orden de ejecución es `files.sort()`, corría ANTES
 * de las 015 a 069. El comentario ya decía «cualquier duplicado NUEVO es un
 * error» y el código no podía distinguir nuevo de histórico, porque no miraba
 * el archivo sino su número.
 *
 * Esta lista NO CRECE. Un duplicado nuevo se renumera al siguiente libre; el
 * criterio E0.2 del tablero vigila que siga teniendo exactamente estos nueve.
 * Reparto de rangos para el plan de cierre en docs/migraciones.md.
 */
const DUPLICADOS_HISTORICOS = new Set([
  '012_ai_drafts_unique_source.sql',
  '012_fix_mv_account_balance_summary.sql',
  '014_ai_external_ops.sql',
  '014_fiscal_credentials.sql',
  '014_rls_tenant_isolation.sql',
  '015_account_roles.sql',
  '015_identities.sql',
  '018_ai_sessions.sql',
  '018_fix_account_roles_unique.sql',
]);

export function assertNumeracionUnica(files: string[]): void {
  const porNumero = new Map<string, string[]>();
  for (const f of files) {
    const n = f.slice(0, 3);
    if (!/^\d{3}$/.test(n)) {
      throw new Error(`Migración sin prefijo numérico de tres dígitos: ${f}`);
    }
    porNumero.set(n, [...(porNumero.get(n) ?? []), f]);
  }
  // Un número con varios archivos sólo se perdona si TODOS ellos son
  // históricos. En cuanto uno solo es nuevo, el choque se denuncia entero —y
  // se señala cuál es el intruso, que es lo que hace accionable el mensaje.
  const choques = [...porNumero.entries()]
    .filter(([, fs]) => fs.length > 1 && fs.some((f) => !DUPLICADOS_HISTORICOS.has(f)))
    .map(([n, fs]) => {
      const nuevos = fs.filter((f) => !DUPLICADOS_HISTORICOS.has(f));
      return `  ${n}: ${fs.join(', ')}  → sobra${nuevos.length > 1 ? 'n' : ''}: ${nuevos.join(', ')}`;
    });
  if (choques.length > 0) {
    const libre = String(
      Math.max(...[...porNumero.keys()].map(Number)) + 1
    ).padStart(3, '0');
    throw new Error(
      `Números de migración duplicados (el siguiente libre es ${libre}):\n${choques.join('\n')}`
    );
  }
}


/**
 * The advisory lock every run takes before it reads public.migrations.
 * Advisory locks are per database, so two firms' databases on one cluster
 * never wait on each other; hashed the same way as closing-conductor.ts.
 */
export const MIGRATION_LOCK_NAME = 'mnemosine:migrate';

export interface MigrationRunOptions {
  /** Directory of NNN_name.sql files, applied in sorted order. */
  migrationsDir: string;
  /** Hardening script re-applied after every run, or null to skip it. */
  hardeningPath: string | null;
}

/**
 * Applies the pending migrations on `client` and returns true when every
 * step succeeded. It never exits the process: runMigrations below owns that.
 */
export async function applyMigrations(
  client: pg.ClientBase,
  options: MigrationRunOptions
): Promise<boolean> {
  let fallo = false;
  // ============================================================
  // ONE RUNNER AT A TIME PER DATABASE (#373).
  //
  // The deploy runs migrate as a pre-step or a Job, so two replicas or two
  // overlapping deploys can start it together. Without this, both read the
  // same pending file from public.migrations and both execute it: the loser
  // dies on a duplicate (even CREATE TABLE IF NOT EXISTS races in the
  // catalog) and anything non-transactional in the file happens twice.
  //
  // A SESSION lock, not a transaction one: it must span every per-file
  // transaction and the hardening. It is taken BEFORE the try, so a run that
  // never got it never unlocks, and it is released in the finally, so a
  // failed run frees it at once instead of when its connection closes.
  // No timeout of its own: the waiter is bounded by the deploy step.
  // ============================================================
  const free = await client.query<{ ok: boolean }>(
    'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok',
    [MIGRATION_LOCK_NAME]
  );
  if (!free.rows[0].ok) {
    console.log('  Another migrate run holds the lock; waiting for it to finish...');
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [MIGRATION_LOCK_NAME]);
  }
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

    const { migrationsDir } = options;
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
    const rlsPath = options.hardeningPath;
    if (rlsPath && fs.existsSync(rlsPath)) {
      console.log('  Applying isolation policies...');
      try {
        await client.query(fs.readFileSync(rlsPath, 'utf-8'));
      } catch (rlsError) {
        console.error('Hardening failed:', rlsError);
        fallo = true;
      }
    }
    // After the hardening, which also must not interleave with another run.
    // If the connection is gone the server already dropped the lock with it.
    try {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [MIGRATION_LOCK_NAME]);
    } catch (unlockError) {
      console.error('Releasing the migration lock failed:', unlockError);
      fallo = true;
    }
  }
  return !fallo;
}

async function runMigrations() {
  const client = await pool.connect();
  let ok = false;
  try {
    ok = await applyMigrations(client, {
      migrationsDir: path.join(__dirname, 'migrations'),
      hardeningPath: path.join(__dirname, 'rls-policies.sql'),
    });
  } finally {
    client.release();
    await pool.end();
  }
  if (!ok) {
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
