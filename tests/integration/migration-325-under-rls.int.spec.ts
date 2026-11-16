import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import pg from 'pg';
import { SYSTEM_USER_EMAIL } from '../../src/services/entity/entity-service.js';

/**
 * 325 PURGES THE S3 KEY COPIES FROM AUDIT_LOG ON AN INSTALLED, HARDENED FIRM
 * (#370 · MNE-001-389).
 *
 * The bench of tests/integration/migration-102-under-rls.int.spec.ts, for the
 * reason measured there: this suite runs as a superuser, a superuser ignores
 * RLS, and that is how 040 shipped a purge that purged nothing. Here the
 * runner is a NOBYPASSRLS role that owns the tables, as mnemosine_owner does,
 * the policies carry their FORCE, and the session has the `row_security = off`
 * floor of migrate.ts. It is not mnemosine_app: that role owns nothing and has
 * no UPDATE on audit_log, so it could not run 325 at all. A superuser on the
 * same database seeds the rows and judges what 325 left.
 *
 * Two firms hold copies of PUT /v1/admin/integrations/s3, one with its system
 * user and one without. A third firm, beyond the plan's two, never configured
 * S3 and has no system user, as most firms: its trail must still record the
 * purge, with 0. A Stripe row with its secretKey and a row of
 * POST /v1/admin/integrations/s3/test are controls that must not change by a
 * byte. Every key is synthetic, and none may appear in what 325 prints.
 */

const ADMIN =
  process.env.TEST_ADMIN_DATABASE_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;

const DATABASE = `mnem_325_${randomBytes(4).toString('hex')}`;
const DIR = path.join(__dirname, '..', '..', 'src', 'database', 'migrations');
const FILE_325 = '325_the_s3_key_copies_in_audit_log_are_purged.sql';
const MIGRATOR = `it_mig325_${randomBytes(4).toString('hex')}`;
const S3_KEYS = ['secretAccessKey', 'accessKeyId'];

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
/** A firm that never configured S3: its trail still records the purge, with 0. */
const TENANT_C = randomUUID();
const ORPHAN_TENANT = randomUUID();
const SYSTEM_USER_A = randomUUID();
const STRIPE_SECRET = 'synthetic-stripe-secret-of-firm-a';

/** Every S3 key value this bench writes: none may be printed, or left in audit_log once 325 applies. */
const s3Secrets: string[] = [];

/** The body the retired adapter took, its two keys at the top level. */
function s3Body(label: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const keys = { accessKeyId: `SYNTHETIC-KEY-ID-${label}`, secretAccessKey: `synthetic-secret-${label}-not-a-key` };
  s3Secrets.push(keys.accessKeyId, keys.secretAccessKey);
  return { ...keys, bucket: `synthetic-bucket-${label}`, region: 'us-east-1', ...extra };
}

interface AuditRow {
  tenant: string;
  action: string;
  entityType: string;
  newValues: unknown;
  oldValues?: unknown;
}

interface Snapshot {
  [id: string]: { text: string; rest: unknown; newValues: Record<string, unknown> };
}

interface Trigger {
  tgname: string;
  tgenabled: string;
  comment: string;
}

interface Constraint {
  conname: string;
  def: string;
}

interface RecordRow {
  tenant_id: string;
  entity_id: string;
  user_id: string;
  action: string;
  legal_entity_id: string | null;
  new_values: { purged_rows: number };
  reason: string;
}

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
/** What 325 raises on libpq's asynchronous channel: a migration's output ends up in a deploy log. */
let said: string[] = [];
/** Both 033 triggers as 058 sealed them, and the table's constraints, read before 325 runs. */
let sealed: Trigger[];
let constraints: Constraint[];
let s3Puts: string[];
let controls: string[];

async function insertAudit(client: pg.Client, row: AuditRow): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO audit_log (id, user_id, tenant_id, action, entity_type, entity_id, old_values, new_values)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb)`,
    [id, randomUUID(), row.tenant, row.action, row.entityType, randomUUID(),
      row.oldValues === undefined ? null : JSON.stringify(row.oldValues), JSON.stringify(row.newValues)]
  );
  return id;
}

/** Applies 325 as migrate.ts does: the floor, then the file and its record in one transaction. */
async function apply325(client: pg.Client, opts: { first?: () => Promise<void>; record?: boolean } = {}): Promise<void> {
  await client.query('SET row_security = off');
  await client.query('BEGIN');
  try {
    await opts.first?.();
    await client.query(sqlOf(FILE_325));
    if (opts.record !== false) await client.query('INSERT INTO public.migrations (filename) VALUES ($1)', [FILE_325]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/** Every audit_log row by id: whole as text, without new_values, and its new_values. */
async function snapshot(): Promise<Snapshot> {
  const { rows } = await verifier.query<{ id: string; text: string; rest: unknown; new_values: Record<string, unknown> }>(
    `SELECT id, a::text AS text, to_jsonb(a) - 'new_values' AS rest, new_values FROM audit_log a`
  );
  return Object.fromEntries(rows.map((r) => [r.id, { text: r.text, rest: r.rest, newValues: r.new_values }]));
}

const triggers = async (): Promise<Trigger[]> => (await verifier.query<Trigger>(
  `SELECT tgname, tgenabled, obj_description(oid, 'pg_trigger') AS comment
     FROM pg_trigger WHERE tgrelid = 'audit_log'::regclass AND NOT tgisinternal ORDER BY tgname`
)).rows;

const constraintsOfAuditLog = async (): Promise<Constraint[]> => (await verifier.query<Constraint>(
  `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = 'audit_log'::regclass ORDER BY conname`
)).rows;

/** The rows 325 writes to record itself, oldest first. */
const records = async (): Promise<RecordRow[]> => (await verifier.query<RecordRow>(
  `SELECT tenant_id, entity_id, user_id, action, legal_entity_id, new_values, reason
     FROM audit_log WHERE entity_type = 'audit_log' ORDER BY timestamp, tenant_id`
)).rows;

const recorded325 = async (): Promise<number> => Number((await verifier.query<{ n: string }>(
  'SELECT count(*) AS n FROM public.migrations WHERE filename = $1', [FILE_325]
)).rows[0].n);

/** Every key of a JSON value, at any depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
}

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
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.sql') && Number(f.slice(0, 3)) < 325).sort()) {
    // 071 ends with RESET ROLE: in production that returns to mnemosine_owner, here to the superuser.
    await db.query(`SET ROLE ${MIGRATOR}`);
    await db.query('BEGIN');
    await db.query(sqlOf(file));
    await db.query('INSERT INTO public.migrations (filename) VALUES ($1)', [file]);
    await db.query('COMMIT');
  }
  // THE HARDENING, as the runner, which makes this an upgrade and not a fresh install.
  await db.query(`SET ROLE ${MIGRATOR}`);
  await db.query(fs.readFileSync(path.join(DIR, '..', 'rls-policies.sql'), 'utf-8'));
  await db.query(`SET ROLE ${MIGRATOR}`);

  for (const [tenant, name] of [[TENANT_A, 'a'], [TENANT_B, 'b'], [TENANT_C, 'c']]) {
    await verifier.query('INSERT INTO tenants (id, name, subdomain, schema_name) VALUES ($1, $2, $3, $4)', [
      tenant, `Firm ${name}`, `firm-${name}-${DATABASE}`, `s_${name}_${DATABASE}`,
    ]);
  }
  // Firm A has the system user ensureSystemUser creates; firms B and C have none yet.
  await verifier.query(
    `INSERT INTO users (id, tenant_id, email, password_hash, first_name, last_name, is_active, roles)
     VALUES ($1, $2, $3, $4, 'Mnemosine', 'Setup', false, '["system"]')`,
    [SYSTEM_USER_A, TENANT_A, SYSTEM_USER_EMAIL, randomBytes(32).toString('hex')]
  );
  s3Puts = [
    await insertAudit(verifier, { tenant: TENANT_A, action: 'update', entityType: 's3', newValues: s3Body('a1') }),
    await insertAudit(verifier, { tenant: TENANT_A, action: 'update', entityType: 's3', newValues: s3Body('a2') }),
    await insertAudit(verifier, {
      tenant: TENANT_B, action: 'update', entityType: 's3',
      newValues: s3Body('b1', { endpoint: 'https://synthetic-endpoint.invalid' }),
    }),
  ];
  controls = [
    await insertAudit(verifier, { tenant: TENANT_A, action: 'update', entityType: 'stripe', newValues: { secretKey: STRIPE_SECRET } }),
    await insertAudit(verifier, { tenant: TENANT_B, action: 'create', entityType: 's3', newValues: {} }),
  ];
  sealed = await triggers();
  constraints = await constraintsOfAuditLog();
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
  it('the runner owns audit_log under FORCE RLS and cannot bypass it, and 058 sealed both triggers', async () => {
    const { rows } = await db.query<{ sup: boolean; bypass: boolean }>(
      'SELECT rolsuper AS sup, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user'
    );
    expect(rows[0], 'as a superuser RLS is inert and nothing here would be proven').toEqual({ sup: false, bypass: false });
    const table = await verifier.query(
      `SELECT relforcerowsecurity AS forced, pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'audit_log'`
    );
    expect(table.rows[0]).toEqual({ forced: true, owner: MIGRATOR });
    expect(sealed.map((t) => [t.tgname, t.tgenabled])).toEqual([['audit_log_append_only', 'A'], ['audit_log_no_truncate', 'A']]);
    for (const t of sealed) expect(t.comment).toMatch(/^garantia-sellada:/);
  });

  it('and under row_security = off a bare read of audit_log throws 42501 instead of reading zero rows', async () => {
    await db.query('SET row_security = off');
    await expect(db.query('SELECT count(*) FROM audit_log')).rejects.toMatchObject({ code: '42501' });
  });
});

// The other cases see the triggers only after a COMMIT or a ROLLBACK, the same
// for a suspension of every trigger or for a restore outside the DO block,
// which psql with no BEGIN would commit apart. So the file itself is read.
describe('the file suspends only audit_log_append_only, and only inside its DO block', () => {
  it('one DISABLE and one ENABLE ALWAYS, both in the DO block, and no other trigger named', () => {
    const code = sqlOf(FILE_325).replace(/--[^\n]*/g, '');
    const block = code.slice(code.indexOf('DO $purge$'), code.indexOf('$purge$;'));
    expect(code.match(/(DISABLE|ENABLE)\b[^;]*TRIGGER[^;]*;/g)).toEqual([
      'DISABLE TRIGGER audit_log_append_only;',
      'ENABLE ALWAYS TRIGGER audit_log_append_only;',
    ]);
    expect(block).toContain('DISABLE TRIGGER audit_log_append_only;');
    expect(block).toContain('ENABLE ALWAYS TRIGGER audit_log_append_only;');
  });
});

/** Keys the tenant loop's UPDATE does not reach, one place each. */
const LEFT_BEHIND: Array<[string, () => AuditRow]> = [
  ['under a tenant_id that is not in tenants', () => ({ tenant: ORPHAN_TENANT, action: 'update', entityType: 's3', newValues: s3Body('orphan') })],
  ['in a (create, s3) row', () => ({ tenant: TENANT_A, action: 'create', entityType: 's3', newValues: s3Body('create') })],
  ["in another provider's update row", () => ({ tenant: TENANT_A, action: 'update', entityType: 'conekta', newValues: s3Body('conekta') })],
  ['nested one level down', () => ({
    tenant: TENANT_B, action: 'update', entityType: 's3', newValues: { bucket: 'synthetic-bucket-nested', credentials: s3Body('nested') },
  })],
  ['in old_values', () => ({
    tenant: TENANT_B, action: 'update', entityType: 's3', newValues: { bucket: 'synthetic-bucket-old' }, oldValues: s3Body('old'),
  })],
];

describe('a key the purge does not reach stops 325, and nothing changes', () => {
  it.each(LEFT_BEHIND)('a key %s: refused, saying what is left and printing no secret', async (_where, row) => {
    const before = await snapshot();
    // 033 forbids deleting such a row afterwards, even to the superuser, so it
    // is written inside the transaction that applies 325 and leaves with its rollback.
    const refusal = await apply325(db, {
      first: async () => {
        await db.query('RESET ROLE');
        await insertAudit(db, row());
        await db.query(`SET ROLE ${MIGRATOR}`);
      },
    }).then(() => undefined, (e: unknown) => e as pg.DatabaseError);

    expect(refusal, '325 applied with an S3 key left in audit_log').toBeInstanceOf(Error);
    expect(refusal?.message).toMatch(/^migration 325: audit_log still holds secretAccessKey or accessKeyId as a key/);
    expect(refusal?.hint).toMatch(/outside this migration, which the authorization on #370 does not cover/);
    const printed = [refusal?.message, ...(Object.values(refusal ?? {}) as unknown[]), ...said].filter((s) => typeof s === 'string').join('\n');
    for (const secret of [...s3Secrets, STRIPE_SECRET]) expect(printed).not.toContain(secret);

    expect(await snapshot(), 'every key is where it was, and no record row is left').toEqual(before);
    expect(await triggers()).toEqual(sealed);
    expect(await recorded325()).toBe(0);
  });
});

describe('with every key in a PUT /v1/admin/integrations/s3 row of a tenant, 325 purges it and records it', () => {
  let before: Snapshot;

  it('applies under RLS and the floor, printing no secret', async () => {
    before = await snapshot();
    await apply325(db);
    expect(await recorded325()).toBe(1);
    for (const secret of [...s3Secrets, STRIPE_SECRET]) expect(said.join('\n')).not.toContain(secret);
  });

  it('no audit_log row holds secretAccessKey or accessKeyId at any depth, nor a value they had', async () => {
    const { rows } = await verifier.query<{ text: string; old_values: unknown; new_values: unknown }>(
      'SELECT a::text AS text, old_values, new_values FROM audit_log a'
    );
    for (const r of rows) {
      expect(keysOf([r.old_values, r.new_values]).filter((k) => S3_KEYS.includes(k))).toEqual([]);
      for (const secret of s3Secrets) expect(r.text).not.toContain(secret);
    }
  });

  it('the S3 rows keep bucket, region and endpoint, and the control rows do not change by a byte', async () => {
    const after = await snapshot();
    for (const id of s3Puts) {
      const kept = Object.fromEntries(Object.entries(before[id].newValues).filter(([k]) => !S3_KEYS.includes(k)));
      expect(Object.keys(kept)).toEqual(expect.arrayContaining(['bucket', 'region']));
      expect(after[id].newValues).toEqual(kept);
      expect(after[id].rest).toEqual(before[id].rest);
    }
    expect(after[s3Puts[2]].newValues.endpoint).toBe('https://synthetic-endpoint.invalid');
    for (const id of controls) expect(after[id].text).toBe(before[id].text);
  });

  it('each tenant has one record row with its count, zero included, under its system user', async () => {
    const rows = await records();
    expect(rows, 'one record row per tenant').toHaveLength(3);
    const { rows: users } = await verifier.query<{ tenant_id: string; id: string; password_hash: string }>(
      'SELECT tenant_id, id, first_name, last_name, is_active, roles, password_hash FROM users WHERE email = $1',
      [SYSTEM_USER_EMAIL]
    );
    const systemUserOf = (tenant: string) => users.find((u) => u.tenant_id === tenant);
    expect(systemUserOf(TENANT_A)?.id).toBe(SYSTEM_USER_A);
    // Firms B and C had none: 325 created it the way ensureSystemUser does.
    for (const tenant of [TENANT_B, TENANT_C]) {
      expect(systemUserOf(tenant)).toMatchObject({
        first_name: 'Mnemosine', last_name: 'Setup', is_active: false, roles: ['system'],
      });
      expect(systemUserOf(tenant)?.password_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    for (const [tenant, purged] of [[TENANT_A, 2], [TENANT_B, 1], [TENANT_C, 0]] as const) {
      const r = rows.find((x) => x.tenant_id === tenant);
      expect(r).toMatchObject({ user_id: systemUserOf(tenant)?.id, action: 'update', legal_entity_id: null });
      expect(r?.new_values).toEqual({ migration: FILE_325, purged_rows: purged, removed_fields: S3_KEYS });
      expect(r?.reason).toMatch(/#370/);
      expect(r?.reason).toMatch(/MNE-001-146/);
    }
    // A new entity_id: no tenant's, no author's, and no earlier row's.
    const ids = rows.map((r) => r.entity_id);
    const taken = [TENANT_A, TENANT_B, TENANT_C, ...users.map((u) => u.id),
      ...Object.values(before).map((s) => (s.rest as { entity_id: string }).entity_id)];
    expect(new Set([...ids, ...taken]).size, 'each record row has a new entity_id').toBe(ids.length + taken.length);
  });

  it('both triggers are sealed again with their comment, the probe is gone, and the table says what was purged', async () => {
    expect(await triggers()).toEqual(sealed);
    expect(await constraintsOfAuditLog()).toEqual(constraints);
    const { rows } = await verifier.query<{ comment: string }>(`SELECT obj_description('audit_log'::regclass, 'pg_class') AS comment`);
    expect(rows[0].comment).toMatch(/One purge was made, by migration 325/);
  });

  it('and the superuser, whom neither RLS nor privileges stop, cannot UPDATE or DELETE a row', async () => {
    for (const sql of ['UPDATE audit_log SET reason = reason WHERE id = $1', 'DELETE FROM audit_log WHERE id = $1']) {
      await verifier.query('BEGIN');
      const error = await verifier.query(sql, [controls[0]]).then(() => undefined, (e: unknown) => e as Error);
      await verifier.query('ROLLBACK');
      // The message, not only 42501: the floor and a missing privilege raise 42501 too.
      expect(error?.message).toMatch(/^audit_log es de sólo escritura: (UPDATE|DELETE) rechazado/);
    }
  });
});

describe('applied again by a superuser, as every CI job migrates, 325 still counts each tenant apart', () => {
  it('fresh copies in both firms: each tenant records its own count', async () => {
    await insertAudit(verifier, { tenant: TENANT_A, action: 'update', entityType: 's3', newValues: s3Body('a3') });
    for (const label of ['b2', 'b3']) {
      await insertAudit(verifier, { tenant: TENANT_B, action: 'update', entityType: 's3', newValues: s3Body(label) });
    }
    // What each firm holds now: 1, 2 and 0 after case 3; 3, 3 and 0 when this case runs alone.
    const holding = async (tenant: string) => Number((await verifier.query<{ n: string }>(
      'SELECT count(*) AS n FROM audit_log WHERE tenant_id = $1 AND new_values ?| $2::text[]', [tenant, S3_KEYS]
    )).rows[0].n);
    const expected = { a: await holding(TENANT_A), b: await holding(TENANT_B) };
    const earlier = (await records()).length;
    // RLS filters nothing for a superuser: only the tenant_id predicate keeps
    // the first tenant of the loop from taking every row. Run alone, this is
    // 325's first run, and it records 325 as migrate.ts would.
    await apply325(verifier, { record: (await recorded325()) === 0 });

    const rows = (await records()).slice(earlier);
    const countsOf = (tenant: string) => rows.filter((r) => r.tenant_id === tenant).map((r) => r.new_values.purged_rows);
    expect(countsOf(TENANT_A), 'firm A: its own copies').toEqual([expected.a]);
    expect(countsOf(TENANT_B), 'firm B: its own copies').toEqual([expected.b]);
    expect(countsOf(TENANT_C), 'firm C: nothing to purge, recorded all the same').toEqual([0]);
    expect(await triggers()).toEqual(sealed);
  });
});
