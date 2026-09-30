import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import bcrypt from 'bcryptjs';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createUser, listUsers, archiveUser } from '../../src/services/user/user-service.js';
import { ConflictError, NotFoundError, ValidationError } from '../../src/utils/errors.js';

/**
 * MNE-001-086 (#326), against the real database and the real binary.
 *
 * The only door that created a login was the interactive wizard: without a
 * TTY it answered "Password too short". These pin the door that replaces it:
 * the password arrives on stdin or in a variable, never in argv, and never
 * comes back out. The suite connects as a superuser on purpose, which is the
 * state the once-per-session RLS notice exists for.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'src', 'cli', 'mnemosine.ts');
const SECRET = 'piped-secret-7f3a9c2e';
const NOTICE = 'bypasses row level security';

let f: Fixture;
let home: string;

beforeAll(async () => {
  f = await crearInquilino('MNE-086 firm');
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'mne086-'));
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
  fs.rmSync(home, { recursive: true, force: true });
});

function mnemosine(args: string[], opts: { input?: string; env?: Record<string, string> } = {}) {
  const r = spawnSync('npx', ['tsx', CLI, ...args, '-t', f.tenantId], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 120_000,
    // A pipe, not a terminal: this is what a provisioning script has.
    input: opts.input ?? '',
    env: { ...process.env, HOME: home, NO_COLOR: '1', MNEMOSINE_LOCALE: 'en-US', ...opts.env },
  });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('the service', () => {
  it('creates, lists and archives a login of one firm, and audits without the hash', async () => {
    const other = await crearInquilino('MNE-086 other firm');
    const made = await createUser({ tenantId: f.tenantId, email: 'Lista@Example.com', role: 'revisor', password: SECRET });
    await createUser({ tenantId: other.tenantId, email: 'lista@example.com', role: 'owner', password: SECRET });

    const mine = await listUsers(f.tenantId);
    expect(mine.map((u) => u.email)).toContain('lista@example.com');
    expect(mine.every((u) => !u.roles.includes('system'))).toBe(true);
    // Only the other firm's own logins: its fixture user and its lista@, never ours.
    const theirs = await listUsers(other.tenantId);
    expect(theirs.map((u) => u.email)).toContain('lista@example.com');
    expect(theirs.map((u) => u.id)).not.toContain(made.id);

    await archiveUser({ tenantId: f.tenantId, email: 'lista@example.com', reason: 'left' });
    const row = await query<{ is_active: boolean }>('SELECT is_active FROM users WHERE id = $1', [made.id]);
    expect(row.rows[0].is_active).toBe(false);
    const otherRow = await query<{ is_active: boolean }>(
      'SELECT is_active FROM users WHERE tenant_id = $1 AND email = $2', [other.tenantId, 'lista@example.com']
    );
    expect(otherRow.rows[0].is_active).toBe(true);

    const audit = await query<{ action: string; new_values: unknown; reason: string | null }>(
      `SELECT action, new_values, reason FROM audit_log WHERE entity_type = 'users' AND entity_id = $1 ORDER BY "timestamp"`,
      [made.id]
    );
    expect(audit.rows.map((a) => [a.action, a.reason])).toEqual([['create', null], ['update', 'left']]);
    expect(JSON.stringify(audit.rows)).not.toMatch(/\$2[aby]\$|piped-secret/);
  });

  it('a second create of the same address is a conflict, never a silent role change', async () => {
    await createUser({ tenantId: f.tenantId, email: 'twice@example.com', role: 'viewer', password: SECRET });
    await expect(
      createUser({ tenantId: f.tenantId, email: 'twice@example.com', role: 'owner', password: SECRET })
    ).rejects.toThrow(ConflictError);
    const r = await query<{ roles: string[] }>('SELECT roles FROM users WHERE tenant_id = $1 AND email = $2', [f.tenantId, 'twice@example.com']);
    expect(r.rows[0].roles).toEqual(['viewer']);
  });

  it('refuses to archive the last active owner, an unknown user, and an archived one', async () => {
    const lone = await crearInquilino('MNE-086 lone owner');
    await createUser({ tenantId: lone.tenantId, email: 'boss@example.com', role: 'owner', password: SECRET });
    // The fixture may seed its own owner; archive every other owner first.
    const owners = await query<{ email: string }>(
      `SELECT email FROM users WHERE tenant_id = $1 AND is_active AND roles @> '["owner"]' AND email <> 'boss@example.com'`,
      [lone.tenantId]
    );
    for (const o of owners.rows) await archiveUser({ tenantId: lone.tenantId, email: o.email, reason: 'test' });
    await expect(archiveUser({ tenantId: lone.tenantId, email: 'boss@example.com', reason: 'x' })).rejects.toThrow(ValidationError);
    await expect(archiveUser({ tenantId: lone.tenantId, email: 'ghost@example.com', reason: 'x' })).rejects.toThrow(NotFoundError);
    await createUser({ tenantId: lone.tenantId, email: 'gone@example.com', role: 'viewer', password: SECRET });
    await archiveUser({ tenantId: lone.tenantId, email: 'gone@example.com', reason: 'x' });
    await expect(archiveUser({ tenantId: lone.tenantId, email: 'gone@example.com', reason: 'x' })).rejects.toThrow(ConflictError);
  });
});

describe('the binary, without a TTY', () => {
  it('user create reads the password from stdin, stores only its hash, and never prints it', () => {
    const r = mnemosine(['user', 'create', '--email', 'piped@example.com', '--role', 'contador', '--password-stdin'], {
      input: `${SECRET}\n`,
    });
    expect(r.status, r.err).toBe(0);
    expect(r.out + r.err).not.toContain(SECRET);
    // The first write of the session says RLS is not filtering, exactly once.
    expect(r.err.split(NOTICE).length - 1).toBe(1);
    return query<{ password_hash: string; roles: string[] }>(
      'SELECT password_hash, roles FROM users WHERE tenant_id = $1 AND email = $2', [f.tenantId, 'piped@example.com']
    ).then((row) => {
      expect(row.rows[0].roles).toEqual(['contador']);
      expect(bcrypt.compareSync(SECRET, row.rows[0].password_hash)).toBe(true);
    });
  }, 120_000);

  it('user create takes the password from MNEMOSINE_USER_PASSWORD', () => {
    const r = mnemosine(['user', 'create', '--email', 'env@example.com', '--role', 'lector'], {
      env: { MNEMOSINE_USER_PASSWORD: SECRET },
    });
    expect(r.status, r.err).toBe(0);
    expect(r.out + r.err).not.toContain(SECRET);
  }, 120_000);

  it('without a source it refuses with usage, and a read says nothing about RLS', () => {
    const refused = mnemosine(['user', 'create', '--email', 'none@example.com', '--role', 'viewer']);
    expect(refused.status).toBe(2);
    expect(refused.err).toContain('--password-stdin');

    const listed = mnemosine(['user', 'list', '--json']);
    expect(listed.status, listed.err).toBe(0);
    expect(listed.out).toContain('piped@example.com');
    expect(listed.err).not.toContain(NOTICE);
  }, 240_000);

  it('user disable archives with the reason', () => {
    const r = mnemosine(['user', 'disable', 'env@example.com', '--reason', 'left the firm']);
    expect(r.status, r.err).toBe(0);
    return query<{ is_active: boolean }>('SELECT is_active FROM users WHERE tenant_id = $1 AND email = $2', [f.tenantId, 'env@example.com'])
      .then((row) => expect(row.rows[0].is_active).toBe(false));
  }, 120_000);
});
