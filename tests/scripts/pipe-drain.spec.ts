/**
 * The repository's instruments must hand their whole output to a pipe (#659).
 *
 * On a pipe Node's stdout drains asynchronously, so a script ending in
 * `process.exit(main(...))` dropped whatever the pipe had not taken yet: a
 * single large write was cut at the 64 KiB pipe buffer, a line-by-line writer
 * lost a tail of varying length. A file redirect is synchronous and hid the
 * defect, so these tests spawn each script with a piped stdout and compare
 * what arrives with the same figure computed in this process.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { measure } from '../../scripts/language-status.js';
import { filasCompletas } from '../../scripts/catalogo-estado.js';
import { userStringsUnder } from '../../scripts/language/extract.js';

const ROOT = path.resolve(__dirname, '..', '..');
const PIPE_BUFFER = 64 * 1024;

function runPiped(script: string, args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', path.join(ROOT, script), ...args], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    timeout: 150_000,
  });
}

/** Runs `producer | consumer` in bash and reports the producer's own exit code. */
function runIntoConsumer(producer: string, consumer: string) {
  const r = spawnSync('bash', ['-c', `${producer} | ${consumer}; echo "producer=\${PIPESTATUS[0]}" >&2`], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 150_000,
  });
  const match = /producer=(\d+)/.exec(r.stderr);
  return { stdout: r.stdout, stderr: r.stderr, producerStatus: match ? Number(match[1]) : null };
}

describe('instruments through a pipe', () => {
  it('language-status.ts --json: the piped JSON parses and carries the lanes measured in process', () => {
    const r = runPiped('scripts/language-status.ts', ['--json']);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(PIPE_BUFFER);
    const piped = JSON.parse(r.stdout.toString('utf8')) as { lanes: unknown };
    expect(piped.lanes).toEqual(JSON.parse(JSON.stringify(measure())));
  }, 180_000);

  it('catalogo-estado.ts --json: same bytes as the rows computed in process', () => {
    const md = fs.readFileSync(path.join(ROOT, 'docs', 'cli-command-catalog.md'), 'utf8');
    const expected = Buffer.from(JSON.stringify(filasCompletas(md)), 'utf8');
    expect(expected.length).toBeGreaterThan(PIPE_BUFFER);
    const r = runPiped('scripts/catalogo-estado.ts', ['--json']);
    expect(r.status).toBe(0);
    expect(r.stdout.length).toBe(expected.length);
    expect(r.stdout.equals(expected)).toBe(true);
  }, 180_000);

  it('language/extract.ts --list src/services: one line per string found in process', () => {
    const expected = userStringsUnder('src/services').map(
      (hit) => `${hit.file}:${hit.line}\t${JSON.stringify(hit.text)}\n`,
    );
    expect(Buffer.byteLength(expected.join(''))).toBeGreaterThan(PIPE_BUFFER);
    const r = runPiped('scripts/language/extract.ts', ['--list', 'src/services']);
    expect(r.status).toBe(0);
    const piped = r.stdout.toString('utf8');
    // Line count first, so a truncated run fails with two numbers, not a wall of diff.
    expect(piped.split('\n').length - 1).toBe(expected.length);
    expect(piped === expected.join('')).toBe(true);
  }, 180_000);

  it('a consumer that stops early ends the run quietly, without an unhandled EPIPE', () => {
    const r = runIntoConsumer('node --import tsx scripts/language/lanes/code.ts identifiers src', 'head -1');
    expect(r.stdout.split('\n').filter(Boolean)).toHaveLength(1);
    expect(r.stderr).not.toMatch(/EPIPE|Unhandled/);
    expect(r.producerStatus).toBe(0);
  }, 180_000);

  it('a failing exit code still reaches the shell through the pipe', () => {
    const r = runIntoConsumer('node --import tsx scripts/language/lanes/code.ts', 'wc -l');
    expect(r.producerStatus).toBe(2);
    expect(r.stderr).toMatch(/uso: tsx scripts\/language\/lanes\/code\.ts/);
  }, 60_000);
});
