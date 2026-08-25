import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { config } from '../config/index.js';

// __dirname is available natively under CommonJS output (tsx/node)

// Dedicated pool: migrations run DDL and connect as mnemosine_owner,
// separate from the application role. The pool from connection.ts is
// deliberately NOT imported — that one carries the tenant context and the DDL-less role.
const pool = new pg.Pool({ connectionString: config.database.migrationUrl, max: 1 });

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

runMigrations();
