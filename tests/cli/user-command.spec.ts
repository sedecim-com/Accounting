import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable } from 'node:stream';
import { Command } from 'commander';

vi.mock('../../src/services/user/user-service.js', () => ({
  listUsers: vi.fn(),
  createUser: vi.fn(),
  archiveUser: vi.fn(),
  resolveUserTenant: vi.fn(),
}));

import { listUsers, createUser, archiveUser, resolveUserTenant } from '../../src/services/user/user-service.js';
import { registerUserCommand, readPassword, PASSWORD_ENV, type UserCommandDeps } from '../../src/cli/user-command.js';
import { riskOf, ExitCode } from '../../src/cli/kernel/index.js';

// ============================================================
// MNE-001-086 (#326) · `mnemosine user create|list|archive` with the service
// stubbed; tests/integration/mne086-user-without-tty.int.spec.ts runs the
// real binary against Postgres. Here: where the password may come from, and
// that it never reaches stdout, stderr or an argument.
// ============================================================

const SECRET = 'correct-horse-battery-staple';

const plain = {
  dim: (x: string) => x, bold: (x: string) => x, cyan: (x: string) => x,
  red: (x: string) => x, green: (x: string) => x, yellow: (x: string) => x,
};

interface Run { exitCode?: number; out: string; err: string; errors: unknown[] }

function deps(over: Partial<UserCommandDeps> = {}): UserCommandDeps & { exits: number[]; errors: unknown[] } {
  const exits: number[] = [];
  const errors: unknown[] = [];
  return {
    palette: plain as never,
    shutdown: (c: number) => { exits.push(c); },
    reportError: (e: unknown) => { errors.push(e); },
    readSecret: vi.fn(async () => null),
    stdin: Object.assign(Readable.from([]), { isTTY: false }),
    env: {},
    exits,
    errors,
    ...over,
  };
}

async function cli(argv: string[], d = deps()): Promise<Run> {
  const root = new Command('mnemosine');
  root.exitOverride();
  registerUserCommand(root, d);
  const out: string[] = [];
  const err: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const writeErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  let thrown: unknown;
  try {
    await root.parseAsync(['node', 'mnemosine', ...argv]);
  } catch (e) {
    thrown = e;
  } finally {
    process.stdout.write = write;
    process.stderr.write = writeErr;
  }
  return { exitCode: d.exits[0], out: out.join(''), err: err.join(''), errors: thrown ? [thrown, ...d.errors] : d.errors };
}

function leaf(root: Command, ...names: string[]): Command {
  let node = root;
  for (const name of names) node = (node.commands as Command[]).find((c) => c.name() === name)!;
  return node;
}

beforeEach(() => {
  vi.mocked(resolveUserTenant).mockResolvedValue('t-1');
  vi.mocked(createUser).mockReset().mockImplementation(async (i) => ({ id: 'u-1', email: i.email, role: 'viewer' }));
  vi.mocked(archiveUser).mockReset().mockResolvedValue({ id: 'u-1', email: 'ana@example.com' });
});

describe('the declarations', () => {
  it('names the family as the catalog does, and #326 disable is an alias of archive', () => {
    const root = new Command('mnemosine');
    registerUserCommand(root, deps());
    expect(leaf(root, 'user').aliases()).toEqual(['usuario']);
    expect(leaf(root, 'user', 'archive').aliases()).toEqual(['archivar', 'disable', 'desactivar']);
    for (const name of ['list', 'create', 'archive']) {
      expect(riskOf(leaf(root, 'user', name))?.agentAllowed).toBe(false);
    }
  });

  it('there is no option that takes the password as an argument', async () => {
    const root = new Command('mnemosine');
    registerUserCommand(root, deps());
    const longs = leaf(root, 'user', 'create').options.map((o) => o.long);
    expect(longs).toContain('--password-stdin');
    expect(longs.filter((l) => l?.startsWith('--password'))).toEqual(['--password-stdin']);
    const r = await cli(['user', 'create', '--email', 'a@b.mx', '--role', 'viewer', '--password', SECRET]);
    expect(createUser).not.toHaveBeenCalled();
    expect(String(r.errors[0])).toMatch(/unknown option/);
  });
});

describe('readPassword', () => {
  it('reads stdin whole, dropping only the trailing line ending', async () => {
    const d = deps({ stdin: Readable.from([Buffer.from(' spaced '), Buffer.from('pass\r\n')]) });
    expect(await readPassword({ passwordStdin: true }, d)).toBe(' spaced pass');
  });

  it('takes the variable and removes it, so nothing spawned later inherits it', async () => {
    const env: NodeJS.ProcessEnv = { [PASSWORD_ENV]: SECRET };
    expect(await readPassword({}, deps({ env }))).toBe(SECRET);
    expect(env[PASSWORD_ENV]).toBeUndefined();
  });

  it('refuses two sources instead of choosing one', async () => {
    const d = deps({ env: { [PASSWORD_ENV]: SECRET }, stdin: Readable.from([SECRET]) });
    await expect(readPassword({ passwordStdin: true }, d)).rejects.toMatchObject({ exitCode: ExitCode.USAGE });
  });

  it('without a terminal and without a source, it fails with usage and never prompts', async () => {
    const d = deps();
    await expect(readPassword({}, d)).rejects.toThrow(/--password-stdin/);
    expect(d.readSecret).not.toHaveBeenCalled();
  });

  it('on a real terminal it asks with the hidden-echo prompt', async () => {
    const d = deps({ stdin: Object.assign(Readable.from([]), { isTTY: true }), readSecret: vi.fn(async () => SECRET) });
    expect(await readPassword({}, d)).toBe(SECRET);
  });
});

describe('user create', () => {
  it('passes the piped password to the service and never prints it', async () => {
    const d = deps({ stdin: Readable.from([`${SECRET}\n`]) });
    const r = await cli(['user', 'create', '--email', 'ana@example.com', '--role', 'contador', '--password-stdin'], d);
    expect(r.exitCode).toBe(0);
    expect(createUser).toHaveBeenCalledWith({ tenantId: 't-1', email: 'ana@example.com', role: 'contador', password: SECRET });
    expect(r.out + r.err).not.toContain(SECRET);
    expect(r.out).toContain('ana@example.com');
  });

  it('a login never gets a role by default', async () => {
    const r = await cli(['user', 'create', '--email', 'ana@example.com'], deps({ env: { [PASSWORD_ENV]: SECRET } }));
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(createUser).not.toHaveBeenCalled();
  });

  it('--json prints the result, without the password', async () => {
    const r = await cli(['usuario', 'crear', '--email', 'ana@example.com', '--role', 'viewer', '--json'], deps({ env: { [PASSWORD_ENV]: SECRET } }));
    expect((JSON.parse(r.out) as { rows: unknown[] }).rows).toEqual([{ id: 'u-1', email: 'ana@example.com', role: 'viewer', tenantId: 't-1' }]);
    expect(r.out).not.toContain(SECRET);
  });
});

describe('user list', () => {
  it('prints the firm\'s users with their state, and honours --status', async () => {
    vi.mocked(listUsers).mockResolvedValue([
      { id: 'u-1', email: 'a@x.mx', roles: ['owner'], is_active: true, last_login_at: null, created_at: '2026-01-01' },
      { id: 'u-2', email: 'b@x.mx', roles: ['viewer'], is_active: false, last_login_at: null, created_at: '2026-01-02' },
    ]);
    const r = await cli(['user', 'list', '--json', '--status', 'archived']);
    expect(listUsers).toHaveBeenCalledWith('t-1');
    const body = JSON.parse(r.out) as { total: number; rows: unknown[] };
    expect(body.rows).toEqual([{ id: 'u-2', email: 'b@x.mx', roles: 'viewer', status: 'archived', last_login_at: null }]);
  });

  it('refuses an unknown --status', async () => {
    const r = await cli(['user', 'list', '-s', 'deleted']);
    expect(r.exitCode).toBe(ExitCode.USAGE);
  });
});

describe('user archive', () => {
  it('requires --reason', async () => {
    const r = await cli(['user', 'archive', 'ana@example.com']);
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(archiveUser).not.toHaveBeenCalled();
  });

  it('`user disable` (the word of #326) archives with the reason', async () => {
    const r = await cli(['user', 'disable', 'ana@example.com', '--reason', 'left the firm']);
    expect(r.exitCode).toBe(0);
    expect(archiveUser).toHaveBeenCalledWith({ tenantId: 't-1', email: 'ana@example.com', reason: 'left the firm' });
  });
});
