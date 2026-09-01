import pg from 'pg';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import dotenv from 'dotenv';

// El global setup corre antes que src/config, que es quien normalmente carga
// .env: aquí hay que leerlo explícitamente para saber a qué Postgres conectar.
dotenv.config();

/**
 * Base EFÍMERA por corrida: se crea, se migra y se destruye. Los dos scripts
 * E2E que esta suite reemplaza dependían de una base de desarrollo con UUID
 * fijos y reparaban a mano los saldos al limpiar; aquí nadie limpia nada
 * porque la base entera desaparece.
 *
 * La URL de administración sale de MIGRATION_DATABASE_URL (o DATABASE_URL):
 * se usa solo para CREATE/DROP DATABASE contra la base `postgres`.
 */


function urlConBase(url: string, base: string): string {
  const u = new URL(url);
  u.pathname = `/${base}`;
  return u.toString();
}

export async function setup(): Promise<void> {
  // TEST_ADMIN_DATABASE_URL es un rol con permiso de CREATE DATABASE, que
  // deliberadamente NO tiene mnemosine_owner: crear bases no es una atribución
  // del dueño del esquema. En CI el servicio de Postgres da ese rol de fábrica.
  const BASE_URL =
    process.env.TEST_ADMIN_DATABASE_URL ||
    process.env.MIGRATION_DATABASE_URL ||
    process.env.DATABASE_URL;
  if (!BASE_URL) {
    throw new Error(
      'La suite de integración necesita TEST_ADMIN_DATABASE_URL (un rol con CREATE DATABASE) ' +
        'o, en su defecto, MIGRATION_DATABASE_URL / DATABASE_URL.'
    );
  }
  const nombre = `mnemosine_it_${crypto.randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: urlConBase(BASE_URL, 'postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${nombre}`);
  // R2: mnemosine_verifier es objeto de CLÚSTER (lo crea provision-roles.sql
  // en producción); el clúster de CI nace sin aprovisionar, y sin el rol el
  // bloque del verifier de rls-policies.sql se salta y el camino sancionado
  // de /public/v1 quedaría sin probar. Crearlo aquí es idempotente.
  await admin.query(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mnemosine_verifier') THEN
        CREATE ROLE mnemosine_verifier NOLOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOBYPASSRLS;
      END IF;
    END $$`);
  await admin.end();

  const urlEfimera = urlConBase(BASE_URL, nombre);
  process.env.__IT_DB__ = nombre;
  process.env.__IT_ADMIN_URL__ = BASE_URL;
  // El runner de migraciones y el pool de la app leen estas dos.
  process.env.DATABASE_URL = urlEfimera;
  process.env.MIGRATION_DATABASE_URL = urlEfimera;

  execFileSync('npx', ['tsx', 'src/database/migrate.ts'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: urlEfimera, MIGRATION_DATABASE_URL: urlEfimera },
  });
}

export async function teardown(): Promise<void> {
  const nombre = process.env.__IT_DB__;
  const adminUrl = process.env.__IT_ADMIN_URL__;
  if (!nombre || !adminUrl) return;
  const admin = new pg.Client({ connectionString: urlConBase(adminUrl, 'postgres') });
  await admin.connect();
  // Cerrar conexiones colgadas antes de soltar la base.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [nombre]
  );
  await admin.query(`DROP DATABASE IF EXISTS ${nombre}`);
  await admin.end();
}
