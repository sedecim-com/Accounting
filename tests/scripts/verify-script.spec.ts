/**
 * scripts/verify.sh promises the gates CI runs. These tests keep that promise
 * checkable: every CI step is either reproduced (`# ci:`) or declared as not
 * runnable locally (`# ci-skip:`), and the gate selector cannot turn a typo into
 * a green run that checked nothing.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const CI = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
const SCRIPT_PATH = path.join(ROOT, 'scripts', 'verify.sh');
const SCRIPT = fs.readFileSync(SCRIPT_PATH, 'utf8');

/** Environment setup, not gates: installing, migrating, seeding, installing Postgres clients. */
const SETUP = [/^npm ci$/, /^npm run migrate$/, /^npm run seed$/, /^sudo apt-get /];

/** The --exigir list is read from ci.yml at run time, so it is compared as a placeholder. */
const normalize = (cmd: string): string => cmd.replace(/--exigir=\S+/, '--exigir=<read from ci.yml>');

function singleLineCiRuns(): string[] {
  return [...CI.matchAll(/^\s*(?:- )?run: (?!\|)(.+)$/gm)]
    .map((m) => normalize(m[1].trim()))
    .filter((cmd) => !SETUP.some((re) => re.test(cmd)));
}

function declared(kind: 'ci' | 'ci-skip' | 'ci-step'): string[] {
  const re = new RegExp(`^# ${kind}: (.+)$`, 'gm');
  return [...SCRIPT.matchAll(re)].map((m) => m[1].split(' — ')[0].trim());
}

function runVerify(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('bash', [SCRIPT_PATH, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('scripts/verify.sh parity with ci.yml', () => {
  it('accounts for every single-line run step of CI', () => {
    const accounted = new Set([...declared('ci'), ...declared('ci-skip')]);
    const missing = singleLineCiRuns().filter((cmd) => !accounted.has(cmd));
    expect(missing).toEqual([]);
  });

  it('does not claim CI steps that no longer exist', () => {
    const runs = new Set(singleLineCiRuns());
    const stale = [...declared('ci'), ...declared('ci-skip')].filter((cmd) => !runs.has(cmd));
    expect(stale).toEqual([]);
  });

  it('accounts for the named multi-line CI step it reproduces', () => {
    for (const step of declared('ci-step')) {
      expect(CI).toContain(`name: ${step}`);
    }
    expect(declared('ci-step')).toContain('ICU completo en el Node de la corrida');
  });

  it('runs unit and integration tests with coverage, as CI does', () => {
    expect(SCRIPT).toMatch(/run_gate unit\s+npx vitest run --coverage/);
    expect(SCRIPT).toMatch(/run_gate integration\s+npm run --silent test:integration -- --coverage/);
  });
});

describe('scripts/verify.sh gate selector', () => {
  it('rejects an unknown gate with exit 2 and runs nothing', () => {
    const r = runVerify(['--only', 'nonexistent']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('--only needs one of');
  });

  it('rejects --only without a gate name', () => {
    expect(runVerify(['--only']).status).toBe(2);
  });

  it('reports a partial run as partial, never as every gate passing', () => {
    const r = runVerify(['--only', 'icu']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("only 'icu' ran, and it passed");
    expect(r.stdout).not.toMatch(/all gates passed/);
  });

  it('sees the database URLs of .env, as the Node processes it launches do', () => {
    // A scratch root with no package.json: the plan gate fails at once, and what
    // is judged is the note verify.sh prints before running it.
    const noteFor = (dotenv: string | null): string => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-spec-'));
      try {
        for (const rel of ['scripts/verify.sh', 'scripts/lib/env.sh', '.github/workflows/ci.yml']) {
          fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
          fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
        }
        if (dotenv !== null) fs.writeFileSync(path.join(dir, '.env'), dotenv);
        return spawnSync('bash', [path.join(dir, 'scripts/verify.sh'), '--only', 'plan'], {
          encoding: 'utf8',
          timeout: 60_000,
          env: { PATH: process.env.PATH, HOME: process.env.HOME },
        }).stdout;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(noteFor(null)).toContain('DATABASE_URL is not set');
    expect(noteFor('DATABASE_URL=postgresql://postgres@localhost:5432/mnemosine_dev\n')).not.toContain(
      'DATABASE_URL is not set',
    );
  });

  it('lists a gate that cannot run here as SKIP, not as passed', () => {
    const r = runVerify(['--only', 'eval']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/SKIP\s+eval/);
    expect(r.stdout).toContain("only 'eval' was selected, and it did not run");
  });
});
