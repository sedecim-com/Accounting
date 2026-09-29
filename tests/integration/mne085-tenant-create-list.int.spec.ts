import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as crypto from 'node:crypto';
import { Command } from 'commander';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { drainAttestations } from '../../src/services/accounting/posting.js';
import { createTenant, listTenants } from '../../src/services/tenant/tenant-service.js';
import { createEntity, SYSTEM_USER_EMAIL } from '../../src/services/entity/entity-service.js';
import { registerTenantCommand } from '../../src/cli/tenant-command.js';
import { ConflictError } from '../../src/utils/errors.js';

/**
 * MNE-001-085 (#326), against the real database.
 *
 * A second firm on one installation needed hand-written SQL: the only door
 * that created a tenant was `entity create`, and only while there was none.
 * These pin the door that replaces the SQL, and migration 145, without which
 * the honest schema_name ('public') could be written only once.
 */

let f: Fixture;
const suffix = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  f = await crearInquilino('MNE-085 existing firm');
}, 120_000);

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('migration 145', () => {
  it('drops the UNIQUE on tenants.schema_name, so every tenant can say public', async () => {
    const unique = await query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'public.tenants'::regclass AND contype = 'u'
          AND pg_get_constraintdef(oid) LIKE '%schema_name%'`
    );
    expect(unique.rows).toEqual([]);
  });
});

describe('createTenant and listTenants', () => {
  it('creates a second firm next to an existing one, and the list shows both', async () => {
    const created = await createTenant({ name: `Despacho Pérez ${suffix}` });
    expect(created.subdomain).toBe(`despacho-perez-${suffix}`);
    expect(created.plan).toBe('professional');

    const row = await query<{ schema_name: string; name: string }>(
      'SELECT schema_name, name FROM public.tenants WHERE id = $1',
      [created.tenantId]
    );
    expect(row.rows[0]).toEqual({ schema_name: 'public', name: `Despacho Pérez ${suffix}` });

    const ids = (await listTenants()).map((t) => t.id);
    expect(ids).toContain(f.tenantId);
    expect(ids).toContain(created.tenantId);
  });

  it('attributes the creation to the new firm\'s system account, in its own audit log', async () => {
    const created = await createTenant({ name: `Audit Trail ${suffix}` });
    const user = await query<{ id: string; is_active: boolean }>(
      'SELECT id, is_active FROM public.users WHERE tenant_id = $1 AND email = $2',
      [created.tenantId, SYSTEM_USER_EMAIL]
    );
    expect(user.rows).toEqual([{ id: created.createdBy, is_active: false }]);
    const audit = await query<{ action: string; entity_type: string; user_id: string }>(
      `SELECT action, entity_type, user_id FROM audit_log WHERE tenant_id = $1 AND entity_id = $1`,
      [created.tenantId]
    );
    expect(audit.rows).toEqual([{ action: 'create', entity_type: 'tenants', user_id: created.createdBy }]);
  });

  it('refuses a retry of the same firm instead of creating a twin', async () => {
    const name = `Retry Firm ${suffix}`;
    const first = await createTenant({ name });
    await expect(createTenant({ name })).rejects.toThrow(ConflictError);
    await expect(createTenant({ name })).rejects.toThrow(first.tenantId);
    const count = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM public.tenants WHERE name = $1',
      [name]
    );
    expect(count.rows[0].n).toBe('1');
  });

  it('the new firm can receive its first company with entity create --tenant', async () => {
    const created = await createTenant({ name: `Second Books ${suffix}` });
    const entity = await createEntity({
      name: 'Cliente del Segundo SA', taxId: 'CSE010101AB1', country: 'MX',
      tenantId: created.tenantId, taxRegime: '601', taxPostalCode: '01000',
    });
    expect(entity.tenantId).toBe(created.tenantId);
    expect(entity.createdBy).toBe(created.createdBy);
  });
});

describe('the CLI, without a TTY and without SQL', () => {
  const plain = {
    dim: (x: string) => x, bold: (x: string) => x, cyan: (x: string) => x,
    red: (x: string) => x, green: (x: string) => x, yellow: (x: string) => x,
  };

  async function cli(argv: string[]): Promise<{ exitCode?: number; out: string; err: string }> {
    let exitCode: number | undefined;
    const out: string[] = [];
    const err: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
    process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
    try {
      const p = new Command('mnemosine');
      registerTenantCommand(p, {
        palette: plain as never,
        shutdown: (c: number) => { exitCode = c; },
        reportError: (e: unknown) => { err.push(`${(e as Error).message}\n`); },
      });
      await p.parseAsync(['node', 'mnemosine', ...argv]);
    } finally {
      process.stdout.write = write;
      process.stderr.write = writeErr;
    }
    return { exitCode, out: out.join(''), err: err.join('') };
  }

  it('tenant create then tenant list --json shows the existing firm and the new one', async () => {
    const created = await cli(['tenant', 'create', `CLI Firm ${suffix}`, '--json']);
    expect(created.exitCode).toBe(0);
    const [row] = (JSON.parse(created.out) as { rows: Array<{ tenantId: string; subdomain: string }> }).rows;
    expect(row.subdomain).toBe(`cli-firm-${suffix}`);

    const listed = await cli(['tenant', 'list', '--json']);
    expect(listed.exitCode).toBe(0);
    const ids = (JSON.parse(listed.out) as { rows: Array<{ id: string }> }).rows.map((t) => t.id);
    expect(ids).toContain(f.tenantId);
    expect(ids).toContain(row.tenantId);
  });

  it('a taken subdomain exits with the conflict code and names the owner', async () => {
    const r = await cli(['tenant', 'create', 'Anything', '--subdomain', `cli-firm-${suffix}`]);
    expect(r.exitCode).not.toBe(0);
    expect(r.err).toContain(`CLI Firm ${suffix}`);
  });
});
