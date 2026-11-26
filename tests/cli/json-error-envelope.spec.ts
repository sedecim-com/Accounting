import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ============================================================
// MNE-001-698 (#952, stage 1; PRD-003 RF-36) · WITH --json, AN ERROR IS
// ONE MACHINE ENVELOPE ON STDERR
//
// The real binary, as a child process, with an empty HOME and a database
// that cannot be reached: the two classes a leaf decides before or without a
// database, usage and an internal failure. The classes that need rows (not
// found, validation, blocked, conflict, permission, external) are in
// tests/integration/mne-001-698-json-error-envelope.int.spec.ts.
//
// Each case is asked twice. With --json the last line of stderr is the
// envelope and stdout is empty; without it stderr is the prose of today,
// byte for byte, written here by hand.
// ============================================================

const ROOT = path.join(__dirname, '..', '..');
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const CLI = path.join(ROOT, 'src', 'cli', 'mnemosine.ts');
const DEAD_DATABASE = 'postgresql://127.0.0.1:1/unreachable';

interface Envelope {
  schema: string;
  exit_code: number;
  key: string | null;
  params: Record<string, string | number>;
  message: string;
  remedy: string | null;
}

function run(args: string[], locale = 'en-US'): { status: number; stdout: string; stderr: string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mne-698-'));
  try {
    const env = { ...process.env };
    delete env.MNEMOSINE_TENANT;
    delete env.MNEMOSINE_ENTITY;
    delete env.MNEMOSINE_LANG;
    const r = spawnSync(TSX, [CLI, ...args], {
      encoding: 'utf-8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 90_000,
      env: {
        ...env,
        HOME: home,
        DATABASE_URL: DEAD_DATABASE,
        MNEMOSINE_NO_BANNER: '1',
        MNEMOSINE_LOCALE: locale,
        NO_COLOR: '1',
      },
    });
    return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** The envelope is the last line of stderr: warnings and notes may come before it. */
function envelopeOf(stderr: string): Envelope {
  const lines = stderr.trimEnd().split('\n');
  return JSON.parse(lines[lines.length - 1]) as Envelope;
}

describe('MNE-001-698 · usage: the leaf refuses what was typed', () => {
  it('with --json: exit 2, stdout empty, one envelope with the prose message and no key', () => {
    const r = run(['usage', '--since', '7w', '--json']);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stdout).toBe('');
    expect(envelopeOf(r.stderr)).toEqual({
      schema: 'mnemosine.error/1',
      exit_code: 2,
      key: null,
      params: {},
      message: 'Invalid --since value "7w". Use Nd (e.g. 7d, 30d) or YYYY-MM-DD.',
      remedy: null,
    });
  }, 120_000);

  it('without --json: the prose of today, byte for byte, and the same exit', () => {
    const r = run(['usage', '--since', '7w']);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe('\nInvalid --since value "7w". Use Nd (e.g. 7d, 30d) or YYYY-MM-DD.\n');
  }, 120_000);
});

describe('MNE-001-698 · an internal error: the database does not answer', () => {
  it('with --json: exit 1, a fixed key, the remedy, and never the raw driver text', () => {
    const r = run(['account', 'list', '--json']);
    expect(r.status, r.stderr).toBe(1);
    expect(r.stdout).toBe('');
    expect(envelopeOf(r.stderr)).toEqual({
      schema: 'mnemosine.error/1',
      exit_code: 1,
      key: 'cli.error.internal',
      params: {},
      message:
        'The command failed on an internal error (database, network or system); ' +
        'its details are not part of a machine error.',
      remedy: 'mnemosine doctor   (and check DATABASE_URL in .env)',
    });
    // The host, the port and the driver's own words stay out of it.
    expect(r.stderr).not.toContain('127.0.0.1');
    expect(r.stderr).not.toContain('ECONNREFUSED');
  }, 120_000);

  it('in es-MX the key and the params stay, and the message and the remedy are Spanish', () => {
    const r = run(['account', 'list', '--json'], 'es-MX');
    expect(r.status, r.stderr).toBe(1);
    const e = envelopeOf(r.stderr);
    expect(e.key).toBe('cli.error.internal');
    expect(e.params).toEqual({});
    expect(e.message).toBe(
      'El comando falló por un error interno (de la base de datos, la red o el sistema); ' +
        'sus detalles no forman parte de un error de máquina.'
    );
  }, 120_000);

  it('without --json: the prose of today, byte for byte, raw text and remedy included', () => {
    const r = run(['account', 'list']);
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toBe(
      '\nconnect ECONNREFUSED 127.0.0.1:1\n  → mnemosine doctor   (and check DATABASE_URL in .env)\n'
    );
  }, 120_000);
});
