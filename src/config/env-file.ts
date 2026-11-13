import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Where the CLI keeps its `.env`. Two places, in this order of precedence:
//   1. ./.env            (a repository checkout, where .env is gitignored)
//   2. ~/.mnemosine/.env (an installation with no checkout to write into)
// Kept free of imports from src/config so `init` and the loader share one rule.

/** The per-user location, used when the working directory is not the home of the install. */
export function userEnvPath(home: string = os.homedir()): string {
  return path.join(home, '.mnemosine', '.env');
}

/** The `.env` already in use, or null when none exists yet. */
export function findEnvFile(cwd: string, home: string = os.homedir()): string | null {
  for (const candidate of envFileCandidates(cwd, home)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** dotenv paths in precedence order: dotenv never overrides, so the first file wins. */
export function envFileCandidates(cwd: string, home: string = os.homedir()): string[] {
  return [path.join(cwd, '.env'), userEnvPath(home)];
}
