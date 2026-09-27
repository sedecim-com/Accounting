/**
 * scripts/setup.sh promises a working environment in one command, and
 * .devcontainer promises the versions CI uses. These tests keep both promises
 * checkable without a database: the versions are read from ci.yml, never
 * copied, and the one step that can destroy something —writing .env— is run
 * for real in a scratch copy of the repository.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CI = read('.github/workflows/ci.yml');

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repository root holding only what `setup.sh --only env` touches. */
function scratchRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-spec-'));
  scratches.push(dir);
  fs.mkdirSync(path.join(dir, 'scripts', 'lib'), { recursive: true });
  for (const rel of ['scripts/setup.sh', 'scripts/lib/env.sh', '.env.example']) {
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  return dir;
}

function run(script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    // A clean environment: an inherited DATABASE_URL must not decide a test.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('.devcontainer pins what CI uses', () => {
  const ciPostgres = [...new Set([...CI.matchAll(/image: (postgres:\S+)/g)].map((m) => m[1]))];
  const ciNode = CI.match(/NODE_VERSION: '(\d+)'/)?.[1];

  it('CI itself uses a single Postgres image and a Node major', () => {
    expect(ciPostgres).toHaveLength(1);
    expect(ciNode).toMatch(/^\d+$/);
  });

  it('runs the same Postgres image as every CI job', () => {
    expect(read('.devcontainer/compose.yml')).toContain(`image: ${ciPostgres[0]}`);
  });

  it('builds on the Node major CI uses, with the matching Postgres client', () => {
    const dockerfile = read('.devcontainer/Dockerfile');
    expect(dockerfile).toMatch(new RegExp(`^FROM \\S+:${ciNode}-`, 'm'));
    const major = ciPostgres[0].split(':')[1];
    expect(dockerfile).toContain(`postgresql-client-${major}`);
  });

  it('carries xmllint when CI installs it for the Anexo 24 XSD tests', () => {
    expect(read('.github/workflows/ci.yml')).toContain('apt-get install -y libxml2-utils');
    expect(read('.devcontainer/Dockerfile')).toMatch(/apt-get install[^\n]*libxml2-utils/);
  });

  it('runs scripts/setup.sh when the container is created', () => {
    const config = JSON.parse(read('.devcontainer/devcontainer.json')) as { postCreateCommand?: string };
    expect(config.postCreateCommand).toBe('scripts/setup.sh');
  });
});

describe('scripts/setup.sh --only env', () => {
  it('writes a development .env whose every key is documented in .env.example', () => {
    const repo = scratchRepo();
    const r = run(path.join(repo, 'scripts/setup.sh'), ['--only', 'env']);
    expect(r.status).toBe(0);
    const written = fs.readFileSync(path.join(repo, '.env'), 'utf8');
    const keys = [...written.matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]);
    expect(keys).toEqual(expect.arrayContaining(['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'TEST_ADMIN_DATABASE_URL']));
    const documented = read('.env.example');
    for (const key of keys) expect(documented).toMatch(new RegExp(`^${key}=`, 'm'));
  });

  it('changes nothing the second time, and says so', () => {
    const repo = scratchRepo();
    const script = path.join(repo, 'scripts/setup.sh');
    run(script, ['--only', 'env']);
    const first = fs.readFileSync(path.join(repo, '.env'), 'utf8');
    const again = run(script, ['--only', 'env']);
    expect(again.status).toBe(0);
    expect(again.stdout).toMatch(/^ok\s+env\s/m);
    expect(fs.readFileSync(path.join(repo, '.env'), 'utf8')).toBe(first);
  });

  it('never rewrites a .env someone already has, and names the database keys it lacks', () => {
    const repo = scratchRepo();
    const mine = 'JWT_SECRET=somebody-elses-value\nDATABASE_URL=postgresql://me@db:5432/mine\n';
    fs.writeFileSync(path.join(repo, '.env'), mine);
    const r = run(path.join(repo, 'scripts/setup.sh'), ['--only', 'env']);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(repo, '.env'), 'utf8')).toBe(mine);
    expect(r.stdout).toContain('TEST_ADMIN_DATABASE_URL');
    expect(r.stdout).not.toMatch(/lacks[^\n]*\bDATABASE_URL\b(?!_)/);
  });

  it('rejects an unknown step with exit 2 and runs nothing', () => {
    const repo = scratchRepo();
    const r = run(path.join(repo, 'scripts/setup.sh'), ['--only', 'nonexistent']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(fs.existsSync(path.join(repo, '.env'))).toBe(false);
  });
});

describe('scripts/lib/env.sh reads .env the way dotenv does', () => {
  function valueOf(key: string, dotenv: string, env: NodeJS.ProcessEnv = {}): string {
    const repo = scratchRepo();
    fs.writeFileSync(path.join(repo, '.env'), dotenv);
    const probe = path.join(repo, 'probe.sh');
    fs.writeFileSync(probe, `cd "$(dirname "$0")"\n. scripts/lib/env.sh\ndotenv_value ${key}\n`);
    return run(probe, [], env).stdout;
  }

  it('takes the value from .env when the environment does not set it', () => {
    expect(valueOf('TEST_ADMIN_DATABASE_URL', 'TEST_ADMIN_DATABASE_URL=postgresql://a@b/c\n')).toBe(
      'postgresql://a@b/c',
    );
  });

  it('lets the environment win, as dotenv does without override', () => {
    expect(valueOf('DATABASE_URL', 'DATABASE_URL=from-file\n', { DATABASE_URL: 'from-env' })).toBe('from-env');
  });

  it('strips quotes and a trailing comment, and takes the last assignment', () => {
    expect(valueOf('K', 'K=first\nK="second"\n')).toBe('second');
    expect(valueOf('K', 'K=value # note\n')).toBe('value');
    expect(valueOf('K', "export K='x y'\n")).toBe('x y');
  });

  it('answers empty for a key that is nowhere', () => {
    expect(valueOf('MISSING', 'OTHER=1\n')).toBe('');
  });
});

describe('the SessionStart hook', () => {
  it('is registered in .claude/settings.json', () => {
    const settings = JSON.parse(read('.claude/settings.json')) as {
      hooks?: { SessionStart?: { hooks: { command: string }[] }[] };
    };
    const commands = (settings.hooks?.SessionStart ?? []).flatMap((h) => h.hooks.map((x) => x.command));
    expect(commands).toContain('$CLAUDE_PROJECT_DIR/.claude/hooks/session-start.sh');
  });

  it('does nothing outside Claude Code on the web', () => {
    const r = run(path.join(ROOT, '.claude/hooks/session-start.sh'), [], { CLAUDE_PROJECT_DIR: ROOT });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  });
});
