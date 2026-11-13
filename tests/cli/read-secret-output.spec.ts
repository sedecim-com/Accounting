import { describe, it, expect, vi } from 'vitest';
import { Writable } from 'node:stream';
import { readSecretFromTty } from '../../src/cli/init-command.js';

// MNE-001-086 (#326): `user create --json | jq` from a terminal must keep
// stdout for the JSON, so the hidden-echo prompt writes where it is told.

describe('readSecretFromTty', () => {
  it('writes the prompt to the stream it is given, never to stdout', async () => {
    const seen: string[] = [];
    const out = new Writable({ write(chunk, _enc, done) { seen.push(String(chunk)); done(); } });
    const toStdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      // Under the test runner stdin is not a terminal: the prompt is written and skipped.
      expect(await readSecretFromTty('  Password: ', out)).toBeNull();
    } finally {
      toStdout.mockRestore();
    }
    expect(seen.join('')).toContain('  Password: ');
    expect(toStdout).not.toHaveBeenCalled();
  });
});
