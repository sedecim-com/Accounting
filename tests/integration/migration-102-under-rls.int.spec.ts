import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';

/**
 * 102 DELETES THE S3 KEYS ON AN INSTALLED, HARDENED FIRM (#370 · MNE-001-105).
 *
 * The bench of tests/integration/migration-085-under-rls.int.spec.ts, for the
 * reason measured there: this suite runs as a superuser, a superuser ignores
 * RLS, and that is how 040 shipped a purge that deleted nothing. Here the
 * runner is a NOBYPASSRLS role that owns the tables, the policies carry their
 * FORCE, and the session has the `row_security = off` floor of migrate.ts.
 * Every secret below is synthetic, and none may appear in what 102 prints.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;

const DATABASE = `mnem_102_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const FILE_102 = '102_the_s3_keys_the_stub_kept_are_deleted.sql';
const MIGRATOR = `it_mig102_${randomBytes(4).toString('hex')}`;

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ORPHAN_TENANT = randomUUID();
const AUDIT_ROW = randomUUID();

const SECRETS = {
  ciphertextA: 'synthetic-s3-ciphertext-of-tenant-a',
  ciphertextB: 'synthetic-s3-ciphertext-of-tenant-b',
  ciphertextOrphan: 'synthetic-s3-ciphertext-of-no-tenant',
  ciphertextSovos: 'synthetic-sovos-ciphertext-that-stays',
  accessKeyIdInAudit: 'SYNTHETIC-AKID-IN-AUDIT-LOG',
  secretAccessKeyInAudit: 'synthetic-secret-access-key-in-audit-log',
};

const urlWithDatabase = (url: string, database: string): string => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};

const sqlOf = (file: string): string => fs.readFileSync(path.join(DIR, file), 'utf-8');

let admin: pg.Client;
let db: pg.Client;
/** A superuser on THIS database: the runner cannot read what it is judged on. */
let verifier: pg.Client;
/** What 102 raises, as `SEVERITY: message | hint`: a migration's output ends up in a deploy log. */
let said: string[] = [];

/** Applies 102 as migrate.ts does: the file and its record in one transaction, with the floor on. */
async function apply102(): Promise<void> {
  await db.query('SET row_security = off');
  await db.query('BEGIN');
  try {
    await db.query(sqlOf(FILE_102));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [FILE_102]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK');
    throw err;
  }
}

async function countOf(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await verifier.query<{ n: string }>(sql, params)).rows[0].n);
}

const S3_ROWS = `SELECT count(*) AS n FROM integration_credentials WHERE provider = 's3'`;

beforeAll(async () => {
  if (!ADMIN) throw new Error('missing TEST_ADMIN_DATABASE_URL / MIGRATION_DATABASE_URL / DATABASE_URL');
  admin = new pg.Client({ connectionString: urlWithDatabase(ADMIN, 'postgres') });
  await admin.connect();
  await admin.query(`CREATE ROLE ${MIGRATOR} NOLOGIN NOBYPASSRLS`);
  await admin.query(`GRANT ${MIGRATOR} TO CURRENT_USER`);
  await admin.query(`CREATE DATABASE ${DATABASE} OWNER ${MIGRATOR}`);

  db = new pg.Client({ connectionString: urlWithDatabase(ADMIN, DATABASE) });
  await db.connect();
  // NOTICE and WARNING come on libpq's asynchronous channel, not in the result;
  // the installed @types/pg does not export their type.
  (db as unknown as { on(e: 'notice', cb: (n: { severity?: string; message?: string; hint?: string }) => void): void })
    .on('notice', (n) => said.push(`${n.severity}: ${n.message}${n.hint ? ` | ${n.hint}` : ''}`));
  verifier = new pg.Client({ connectionString: urlWithDatabase(ADMIN, DATABASE) });
  await verifier.connect();

  await db.query(`SET ROLE ${MIGRATOR}`);
  await db.query(
    'CREATE TABLE public.migrations (id SERIAL PRIMARY KEY, filename VARCHAR(255) UNIQUE NOT NULL, executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
  );
  await db.query('SET row_security = off');
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) < 102).sort()) {
    await db.query('BEGIN');
    await db.query(sqlOf(file));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }

  // Two firms that configured the stub, one of them also a real provider, and
  // the copy the audit middleware left of one PUT.
  for (const [tenant, name] of [[TENANT_A, 'a'], [TENANT_B, 'b']]) {
    await db.query(`INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1, $2, $3, $4)`, [
      tenant, `Firm ${name}`, `firm-${name}-${DATABASE}`, `s_${name}_${DATABASE}`,
    ]);
  }
  await db.query(
    `INSERT INTO integration_credentials (tenant_id, provider, provider_account_id, credentials_encrypted)
     VALUES ($1, 's3', '', $2), ($1, 'sovos_reachcore', '', $3), ($4, 's3', '', $5)`,
    [TENANT_A, SECRETS.ciphertextA, SECRETS.ciphertextSovos, TENANT_B, SECRETS.ciphertextB]
  );
  await db.query(
    `INSERT INTO audit_log (id, user_id, tenant_id, action, entity_type, entity_id, new_values)
     VALUES ($1, $2, $3, 'update', 's3', $4, $5::jsonb)`,
    [AUDIT_ROW, randomUUID(), TENANT_A, randomUUID(), JSON.stringify({
      accessKeyId: SECRETS.accessKeyIdInAudit,
      secretAccessKey: SECRETS.secretAccessKeyInAudit,
      bucket: 'synthetic-bucket',
    })]
  );

  // THE HARDENING, which makes this an upgrade and not a fresh install:
  // migrate.ts applies it in the `finally` of every run. And the runner's role
  // again, because 071 ends with RESET ROLE.
  await db.query(fs.readFileSync(path.join(DIR, '..', 'rls-policies.sql'), 'utf-8'));
  await db.query(`SET ROLE ${MIGRATOR}`);
}, 900_000);

afterAll(async () => {
  await verifier?.end();
  await db?.end();
  await admin?.query(`DROP DATABASE IF EXISTS ${DATABASE}`);
  await admin?.query(`DROP ROLE IF EXISTS ${MIGRATOR}`);
  await admin?.end();
});

beforeEach(() => {
  said = [];
});

describe('the bench is the one where a purge went silent, and it is checked first', () => {
  it('the runner owns both tables under FORCE RLS, and cannot bypass it', async () => {
    const { rows } = await db.query<{ sup: boolean; bypass: boolean }>(
      `SELECT rolsuper AS sup, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    );
    expect(rows[0], 'as a superuser RLS is inert and nothing here would be proven').toEqual({ sup: false, bypass: false });
    const tables = await verifier.query(
      `SELECT relname, relforcerowsecurity AS forced, pg_get_userbyid(relowner) AS owner
         FROM pg_class WHERE relname IN ('integration_credentials', 'audit_log') ORDER BY relname`
    );
    expect(tables.rows).toEqual([
      { relname: 'audit_log', forced: true, owner: MIGRATOR },
      { relname: 'integration_credentials', forced: true, owner: MIGRATOR },
    ]);
  });

  it('and under row_security = off a bare read of the credentials throws 42501 instead of reading zero rows', async () => {
    await db.query('SET row_security = off');
    await expect(db.query('SELECT count(*) FROM integration_credentials')).rejects.toMatchObject({ code: '42501' });
  });
});

describe('an S3 key the tenant loop cannot reach stops the migration', () => {
  it('refuses, says what to do, prints no secret, and leaves every key where it was', async () => {
    await verifier.query(
      `INSERT INTO integration_credentials (tenant_id, provider, provider_account_id, credentials_encrypted)
       VALUES ($1, 's3', '', $2)`,
      [ORPHAN_TENANT, SECRETS.ciphertextOrphan]
    );
    const refusal = (await apply102().then(() => undefined, (e: unknown) => e)) as
      | { message: string; detail?: string; hint?: string }
      | undefined;

    expect(refusal?.message).toMatch(/still holds S3 credentials under a tenant_id that is not in tenants/);
    expect(refusal?.hint).toMatch(/As a superuser: DELETE FROM integration_credentials WHERE provider = 's3'/);
    const printed = [refusal?.message, refusal?.detail, refusal?.hint, ...said].join('\n');
    for (const secret of Object.values(SECRETS)) expect(printed).not.toContain(secret);
    // The rows the loop had deleted came back with the rollback, and 102 is not recorded.
    expect(await countOf(S3_ROWS)).toBe(3);
    expect(await countOf(`SELECT count(*) AS n FROM public.migrations WHERE filename = $1`, [FILE_102])).toBe(0);
  });
});

describe('with every S3 key under a tenant, 102 deletes them all', () => {
  it('applies, counts what it deleted and warns about the copy it cannot delete, printing no secret', async () => {
    await verifier.query(`DELETE FROM integration_credentials WHERE tenant_id = $1`, [ORPHAN_TENANT]);
    await apply102();

    expect(said).toContain('NOTICE: migration 102: deleted 2 stored S3 credential row(s) in 2 tenant(s)');
    expect(said.filter((s) => s.startsWith('WARNING: migration 102: 1 audit_log row(s) keep an S3 access key'))).toHaveLength(1);
    for (const secret of Object.values(SECRETS)) expect(said.join('\n')).not.toContain(secret);
  });

  it('no S3 credential is left in any tenant, and every other provider keeps its own byte for byte', async () => {
    expect(await countOf(S3_ROWS)).toBe(0);
    const { rows } = await verifier.query(
      `SELECT tenant_id, credentials_encrypted FROM integration_credentials WHERE provider = 'sovos_reachcore'`
    );
    expect(rows).toEqual([{ tenant_id: TENANT_A, credentials_encrypted: SECRETS.ciphertextSovos }]);
  });

  it('leaves the schema as it found it, and the append-only audit_log untouched', async () => {
    expect(
      await countOf(`SELECT count(*) AS n FROM pg_constraint WHERE conname = 'integration_credentials_no_s3_probe'`)
    ).toBe(0);
    expect(await countOf(`SELECT count(*) AS n FROM audit_log WHERE id = $1`, [AUDIT_ROW])).toBe(1);
  });
});
