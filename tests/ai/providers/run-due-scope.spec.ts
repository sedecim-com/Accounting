import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRunDueScope, loadConfigFile, writeConfigPatch, userConfigPath } from '../../../src/ai/providers/config.js';

// MNE-001-453 (#646): `jobs.run_due` is read from the operator's OWN
// ~/.mnemosine/config.json, never from the project's file.

let home: string;
let cwd: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'run-due-home-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-due-cwd-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
});

function userFile(content: unknown): string {
  const file = userConfigPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
}

describe('readRunDueScope', () => {
  it('no file, or no key, is unset', () => {
    expect(readRunDueScope({ home, cwd })).toEqual({ scope: 'unset', file: userConfigPath(home), projectCarriesKey: false });
    userFile({ tenant: 'T1' });
    expect(readRunDueScope({ home, cwd }).scope).toBe('unset');
  });

  it('reads adopted and all', () => {
    userFile({ jobs: { run_due: 'adopted' } });
    expect(readRunDueScope({ home, cwd }).scope).toBe('adopted');
    userFile({ jobs: { run_due: 'all' } });
    expect(readRunDueScope({ home, cwd }).scope).toBe('all');
  });

  it('a project file never decides it, and is named when it tries', () => {
    fs.writeFileSync(path.join(cwd, 'mnemosine.config.json'), JSON.stringify({ jobs: { run_due: 'all' } }));
    expect(readRunDueScope({ home, cwd })).toEqual({ scope: 'unset', file: userConfigPath(home), projectCarriesKey: true });
  });

  it('a value that is neither is refused with the key and its two values', () => {
    userFile({ jobs: { run_due: 'adopt' } });
    expect(() => readRunDueScope({ home, cwd })).toThrow(/jobs\.run_due.*"adopted".*"all"/);
  });

  it('a user file that does not parse is refused by its path', () => {
    const file = userFile('{ nope');
    expect(() => readRunDueScope({ home, cwd })).toThrow(file);
  });
});

describe('the schema accepts the key', () => {
  it('the writer and the loader accept jobs.run_due, and refuse another value', () => {
    const file = path.join(cwd, 'mnemosine.config.json');
    writeConfigPatch({ jobs: { run_due: 'adopted' } }, cwd, file);
    expect(loadConfigFile(cwd).config.jobs).toEqual({ run_due: 'adopted' });
    expect(() => writeConfigPatch({ jobs: { run_due: 'some' } }, cwd, file)).toThrow(/jobs\.run_due/);
    expect(() => writeConfigPatch({ jobs: { other: true } }, cwd, file)).toThrow(/jobs/);
  });
});
