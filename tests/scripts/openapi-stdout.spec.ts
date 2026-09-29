/**
 * scripts/openapi.ts --stdout must hand the whole contract to a pipe (#408).
 *
 * On a pipe Node's stdout drains asynchronously, so a `process.exit` right
 * after the write dropped everything past the pipe buffer (64 KiB). A file
 * redirect is synchronous and hid the defect; only a real pipe shows it, so
 * these tests spawn the script with piped stdio and compare against the
 * committed docs/openapi.json.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'openapi.ts');
const COMMITTED = fs.readFileSync(path.join(ROOT, 'docs', 'openapi.json'));
const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

function runScript(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 90_000,
  });
}

describe('scripts/openapi.ts through a pipe', () => {
  it('the committed contract is larger than a pipe buffer, so the test can bite', () => {
    expect(COMMITTED.length).toBeGreaterThan(64 * 1024);
  });

  it('--stdout delivers the whole document: same bytes and sha256 as docs/openapi.json', () => {
    const r = runScript(['--stdout']);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(COMMITTED.length);
    expect(sha256(r.stdout)).toBe(sha256(COMMITTED));
  }, 120_000);

  it('--check keeps its exit code and message', () => {
    const r = runScript(['--check']);
    expect(r.status).toBe(0);
    expect(r.stdout.toString('utf8')).toBe('El contrato de la API está al día.\n');
    expect(r.stderr.toString('utf8')).toBe('');
  }, 120_000);
});
