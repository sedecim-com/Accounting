import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

vi.mock('../../src/services/tenant/tenant-service.js', () => ({
  listTenants: vi.fn(),
  createTenant: vi.fn(),
}));

import { listTenants, createTenant } from '../../src/services/tenant/tenant-service.js';
import { registerTenantCommand } from '../../src/cli/tenant-command.js';
import { riskOf, exitCodeFor } from '../../src/cli/kernel/index.js';
import { fijarInquilinoDeLaSesion, olvidarInquilinoDeLaSesion } from '../../src/ai/context.js';
import { ConflictError } from '../../src/utils/errors.js';

// ============================================================
// MNE-001-085 (#326) · `mnemosine tenant list|create`, with the service
// stubbed: tests/integration/mne085-tenant-create-list.int.spec.ts runs the
// same leaves against Postgres. Here: the declarations, the rows the list
// prints, and what reaches stdout and stderr.
// ============================================================

const plain = {
  dim: (x: string) => x, bold: (x: string) => x, cyan: (x: string) => x,
  red: (x: string) => x, green: (x: string) => x, yellow: (x: string) => x,
};

const TENANTS = [
  { id: 't-1', name: 'Primero', subdomain: 'primero', plan: 'professional', is_active: true, created_at: '2026-01-01' },
  { id: 't-2', name: 'Segundo', subdomain: 'segundo', plan: 'professional', is_active: false, created_at: '2026-02-01' },
  { id: 't-3', name: 'Tercero', subdomain: 'tercero', plan: 'free', is_active: true, created_at: '2026-03-01' },
];

interface Run { exitCode?: number; out: string; err: string; errors: unknown[] }

function build(): { root: Command; exits: number[]; errors: unknown[] } {
  const exits: number[] = [];
  const errors: unknown[] = [];
  const root = new Command('mnemosine');
  root.exitOverride();
  registerTenantCommand(root, {
    palette: plain as never,
    shutdown: (c: number) => { exits.push(c); },
    reportError: (e: unknown) => { errors.push(e); },
  });
  return { root, exits, errors };
}

async function cli(argv: string[]): Promise<Run> {
  const { root, exits, errors } = build();
  const out: string[] = [];
  const err: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    await root.parseAsync(['node', 'mnemosine', ...argv]);
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
  return { exitCode: exits[0], out: out.join(''), err: err.join(''), errors };
}

function leaf(root: Command, ...names: string[]): Command {
  let node = root;
  for (const name of names) {
    const next = (node.commands as Command[]).find((c) => c.name() === name);
    if (!next) throw new Error(`no ${names.join(' ')}`);
    node = next;
  }
  return node;
}

beforeEach(() => {
  vi.mocked(listTenants).mockResolvedValue(TENANTS as never);
  vi.mocked(createTenant).mockReset();
});

afterEach(() => {
  olvidarInquilinoDeLaSesion();
});

describe('the declarations', () => {
  it('names the family and its leaves as the catalog does, in both languages', () => {
    const { root } = build();
    const family = leaf(root, 'tenant');
    expect(family.aliases()).toEqual(['despacho']);
    expect(leaf(root, 'tenant', 'list').aliases()).toEqual(['listar']);
    expect(leaf(root, 'tenant', 'create').aliases()).toEqual(['crear']);
  });

  it('neither leaf is the agent\'s: both see every firm of the installation', () => {
    const { root } = build();
    expect(riskOf(leaf(root, 'tenant', 'list'))).toMatchObject({ risk: 'lectura', agentAllowed: false });
    expect(riskOf(leaf(root, 'tenant', 'create'))).toMatchObject({ risk: 'escritura', agentAllowed: false });
  });
});

describe('tenant list', () => {
  it('prints every tenant and marks the one in session', async () => {
    fijarInquilinoDeLaSesion('t-3');
    const r = await cli(['tenant', 'list', '--json']);
    expect(r.exitCode).toBe(0);
    const body = JSON.parse(r.out) as { total: number; rows: Array<Record<string, string>> };
    expect(body.total).toBe(3);
    expect(body.rows).toEqual([
      { id: 't-1', name: 'Primero', subdomain: 'primero', plan: 'professional', status: 'active', active: '' },
      { id: 't-2', name: 'Segundo', subdomain: 'segundo', plan: 'professional', status: 'archived', active: '' },
      { id: 't-3', name: 'Tercero', subdomain: 'tercero', plan: 'free', status: 'active', active: '*' },
    ]);
  });

  it('honours --status, --offset and --limit', async () => {
    const r = await cli(['tenant', 'list', '--json', '--status', 'active', '--offset', '1', '--limit', '1']);
    const body = JSON.parse(r.out) as { total: number; rows: Array<{ id: string }> };
    expect(body.total).toBe(2);
    expect(body.rows.map((t) => t.id)).toEqual(['t-3']);
  });

  it('reports a failure with its exit code instead of printing an empty list', async () => {
    const boom = new Error('connection refused');
    vi.mocked(listTenants).mockRejectedValueOnce(boom);
    const r = await cli(['tenant', 'list']);
    expect(r.errors).toEqual([boom]);
    expect(r.exitCode).toBe(exitCodeFor(boom));
    expect(r.exitCode).not.toBe(0);
  });
});

describe('tenant create', () => {
  const RESULT = {
    tenantId: 't-new', name: 'Norte', subdomain: 'norte', plan: 'professional', createdBy: 'u-sys',
  };

  it('passes the name and --subdomain through, and prints the id and the next step', async () => {
    vi.mocked(createTenant).mockResolvedValue(RESULT);
    const r = await cli(['tenant', 'create', 'Norte', '--subdomain', 'norte']);
    expect(createTenant).toHaveBeenCalledWith({ name: 'Norte', subdomain: 'norte' });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('Norte (norte)');
    expect(r.err).toContain('tenant  t-new');
    expect(r.err).toContain('entity create <name> --tax-id <rfc> -t t-new');
  });

  it('--json prints the result as one row', async () => {
    vi.mocked(createTenant).mockResolvedValue(RESULT);
    const r = await cli(['despacho', 'crear', 'Norte', '--json']);
    expect(createTenant).toHaveBeenCalledWith({ name: 'Norte', subdomain: undefined });
    expect((JSON.parse(r.out) as { rows: unknown[] }).rows).toEqual([RESULT]);
  });

  it('a taken subdomain exits with the conflict code', async () => {
    const conflict = new ConflictError('Subdomain "norte" already belongs to "Norte Viejo"');
    vi.mocked(createTenant).mockRejectedValue(conflict);
    const r = await cli(['tenant', 'create', 'Norte']);
    expect(r.errors).toEqual([conflict]);
    expect(r.exitCode).toBe(exitCodeFor(conflict));
    expect(r.out).toBe('');
  });
});
