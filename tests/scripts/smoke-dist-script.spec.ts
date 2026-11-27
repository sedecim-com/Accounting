/**
 * scripts/smoke-dist.sh builds the program and starts what a firm installs
 * (MNE-001-970). The build belongs in its gate, `scripts/verify.sh --only
 * build`, never in this suite: these tests keep the script's promises checkable
 * without building anything and without a database.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The four trees the task names: a build that loses one must not pass. */
const DATA = [
  'services/sat/anexo24/xsd/ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd',
  'services/sat/cfdi40/xsd/cfd/4/cfdv40.xsd',
  'ai/docs/manifiesto.json',
  'database/migrations/001_first.sql',
  'database/rls-policies.sql',
];

const scratches: string[] = [];
afterEach(() => {
  for (const dir of scratches.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repository root: the script, a package.json and the files given. */
function scratchRepo(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-dist-spec-'));
  scratches.push(dir);
  for (const rel of ['scripts/smoke-dist.sh', 'scripts/lib/env.sh']) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ version: '9.9.9', main: 'dist/index.js', bin: { mnemosine: 'dist/cli/mnemosine.js' } }),
  );
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), 'x');
  }
  return dir;
}

function smoke(dir: string, args: string[]) {
  const r = spawnSync('bash', [path.join(dir, 'scripts', 'smoke-dist.sh'), ...args], {
    encoding: 'utf8',
    timeout: 30_000,
    // A clean environment: an inherited database URL must not decide a test.
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

const BUILT = ['dist/index.js', 'dist/cli/mnemosine.js'];
const inSrc = (rels: string[]): string[] => rels.map((rel) => `src/${rel}`);
const inDist = (rels: string[]): string[] => rels.map((rel) => `dist/${rel}`);

describe('scripts/smoke-dist.sh --files-only', () => {
  it('passes when dist carries every file of src that is not TypeScript', () => {
    const dir = scratchRepo([...inSrc(DATA), 'src/index.ts', ...inDist(DATA), ...BUILT]);
    const r = smoke(dir, ['--files-only']);
    expect(r.out).toContain('ok    files');
    expect(r.status).toBe(0);
  });

  it('names a data file the build did not carry', () => {
    const forgotten = 'services/sat/nomina12/xsd/nomina12.xsd';
    const dir = scratchRepo([...inSrc([...DATA, forgotten]), ...inDist(DATA), ...BUILT]);
    const r = smoke(dir, ['--files-only']);
    expect(r.status).toBe(1);
    expect(r.out).toContain(`dist/${forgotten}`);
    expect(r.out).not.toContain('dist/ai/docs/manifiesto.json');
  });

  it('does not pass because a tree the task names left src', () => {
    const rest = DATA.filter((rel) => !rel.startsWith('database/migrations/'));
    const dir = scratchRepo([...inSrc(rest), ...inDist(rest), ...BUILT]);
    const r = smoke(dir, ['--files-only']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('src/database/migrations');
  });

  it('asks for the bin and the main of package.json', () => {
    const dir = scratchRepo([...inSrc(DATA), ...inDist(DATA), 'dist/index.js']);
    const r = smoke(dir, ['--files-only']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('dist/cli/mnemosine.js');
  });

  it('does not ask for what only a checkout reads', () => {
    const checkoutOnly = ['cli/README.md', 'plan/mutation-census.txt'];
    const dir = scratchRepo([...inSrc([...DATA, ...checkoutOnly]), ...inDist(DATA), ...BUILT]);
    expect(smoke(dir, ['--files-only']).status).toBe(0);
  });
});

describe('scripts/smoke-dist.sh and its database', () => {
  it('stops before building when no administrator URL is given', () => {
    const dir = scratchRepo(inSrc(DATA));
    const r = smoke(dir, []);
    expect(r.status).toBe(2);
    expect(r.out).toContain('TEST_ADMIN_DATABASE_URL');
    expect(fs.existsSync(path.join(dir, 'dist'))).toBe(false);
  });

  it('rejects an option it does not know', () => {
    expect(smoke(scratchRepo([]), ['--skip-build']).status).toBe(2);
  });

  it('creates a database of its own and never names one of the .env', () => {
    const script = read('scripts/smoke-dist.sh');
    expect(script).toMatch(/^DB_NAME=mnemosine_smoke_\$\(/m);
    expect(script).not.toMatch(/dotenv_value (DATABASE_URL|MIGRATION_DATABASE_URL)/);
    expect(script).toContain('trap cleanup EXIT');
  });

  it('never alters a role that exists: no password is read or set, and the roles are provisioned only where neither is there', () => {
    const script = read('scripts/smoke-dist.sh');
    expect(script).not.toMatch(/rolpassword|pg_authid|ALTER ROLE/i);
    expect(script.match(/-f scripts\/provision-roles\.sql/g)).toHaveLength(1);
    const body = script.slice(script.indexOf('create_database() {'));
    const usedAsTheyAre = body.indexOf('if [ "$ROLES" = 2 ]; then');
    const appearedMeanwhile = body.indexOf('if [ "$(roles_present)" != 0 ]; then');
    const provisions = body.indexOf('-f scripts/provision-roles.sql');
    expect(usedAsTheyAre).toBeGreaterThan(-1);
    expect(appearedMeanwhile).toBeGreaterThan(usedAsTheyAre);
    expect(provisions).toBeGreaterThan(appearedMeanwhile);
  });
});

describe('the build gate of scripts/verify.sh', () => {
  const verify = (args: string[]) =>
    spawnSync('bash', [path.join(ROOT, 'scripts', 'verify.sh'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });

  it('runs the script', () => {
    expect(read('scripts/verify.sh')).toMatch(/run_gate build\s+bash scripts\/smoke-dist\.sh/);
  });

  it('is listed as SKIP without a database, never as passed', () => {
    const r = verify(['--only', 'build', '--no-integration']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/SKIP\s+build\s+--no-integration/);
    expect(r.stdout).toContain("only 'build' was selected, and it did not run");
  });
});

describe('docker/Dockerfile', () => {
  it('installs what the lockfile says, in both stages', () => {
    const dockerfile = read('docker/Dockerfile');
    expect(dockerfile).not.toMatch(/npm install/);
    expect(dockerfile.match(/^RUN npm ci( --omit=dev)?$/gm)).toEqual(['RUN npm ci', 'RUN npm ci --omit=dev']);
  });
});
