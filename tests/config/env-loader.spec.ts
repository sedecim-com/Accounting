import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Runs the real src/config/index.ts in a child so the dotenv call it makes at
// import time is what is under test, not a re-implementation of it.
const ROOT = path.resolve(__dirname, '../..');
const TSX = path.join(ROOT, 'node_modules/.bin/tsx');

let tmp: string;
let home: string;
let cwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'envloader-'));
  home = path.join(tmp, 'home');
  cwd = path.join(tmp, 'cwd');
  fs.mkdirSync(path.join(home, '.mnemosine'), { recursive: true });
  fs.mkdirSync(cwd);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function load(): { stdout: string; status: number | null; stderr: string } {
  const script = path.join(tmp, 'probe.mts');
  fs.writeFileSync(
    script,
    `await import(${JSON.stringify(path.join(ROOT, 'src/config/index.ts'))});\n` +
      `process.stdout.write(JSON.stringify(process.env.ENV_LOADER_PROBE ?? null));\n`
  );
  const env = { ...process.env, HOME: home, USERPROFILE: home } as Record<string, string | undefined>;
  delete env.ENV_LOADER_PROBE;
  const r = spawnSync(TSX, [script], { cwd, env, encoding: 'utf-8', timeout: 60_000 });
  return { stdout: r.stdout, status: r.status, stderr: r.stderr };
}

describe('config loader reads ~/.mnemosine/.env', () => {
  it('loads the variable from the user file when cwd has no .env, printing nothing else', () => {
    fs.writeFileSync(path.join(home, '.mnemosine', '.env'), 'ENV_LOADER_PROBE=user\n');
    const r = load();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('"user"'); // only the probe output: dotenv stayed quiet
  });

  it('./.env wins over the user file', () => {
    fs.writeFileSync(path.join(home, '.mnemosine', '.env'), 'ENV_LOADER_PROBE=user\n');
    fs.writeFileSync(path.join(cwd, '.env'), 'ENV_LOADER_PROBE=local\n');
    const r = load();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('"local"');
  });
});
