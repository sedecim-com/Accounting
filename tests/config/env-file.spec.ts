import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { envFileCandidates, findEnvFile, userEnvPath } from '../../src/config/env-file.js';

describe('env-file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'envfile-'));
  const cwd = path.join(tmp, 'cwd');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.mnemosine'), { recursive: true });

  it('orders ./.env before the per-user file', () => {
    expect(envFileCandidates(cwd, home)).toEqual([path.join(cwd, '.env'), userEnvPath(home)]);
  });

  it('finds nothing, then the user file, then ./.env wins', () => {
    expect(findEnvFile(cwd, home)).toBeNull();
    fs.writeFileSync(userEnvPath(home), '');
    expect(findEnvFile(cwd, home)).toBe(userEnvPath(home));
    fs.writeFileSync(path.join(cwd, '.env'), '');
    expect(findEnvFile(cwd, home)).toBe(path.join(cwd, '.env'));
  });

  it('defaults the home to os.homedir()', () => {
    expect(userEnvPath()).toBe(path.join(os.homedir(), '.mnemosine', '.env'));
  });
});
