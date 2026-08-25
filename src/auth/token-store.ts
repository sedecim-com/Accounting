import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// ============================================================
// CLI CREDENTIAL STORE
//
// System keychain first; 0600 file as a last resort, which is what
// `gh` does. The refresh token is stored; the access token lives
// short because revoking at the IdP does not reach a bearer token
// already issued.
// ============================================================

const SERVICE = 'mnemosine';
const FILE = path.join(os.homedir(), '.mnemosine', 'credentials.json');

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** Epoch in ms. */
  expiresAt: number;
  issuer: string;
}

async function keychainSet(account: string, secret: string): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await run('security', [
      'add-generic-password', '-U', '-a', account, '-s', SERVICE, '-w', secret,
    ]);
    return true;
  } catch {
    return false;
  }
}

async function keychainGet(account: string): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await run('security', [
      'find-generic-password', '-a', account, '-s', SERVICE, '-w',
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function keychainDelete(account: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  try {
    await run('security', ['delete-generic-password', '-a', account, '-s', SERVICE]);
  } catch {
    // It was not there: nothing to delete.
  }
}

function writeFileFallback(payload: string): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  // The mode goes in the write, not afterwards: a later chmod leaves a
  // window in which the file is world-readable.
  fs.writeFileSync(FILE, payload, { mode: 0o600 });
}

export async function saveToken(token: StoredToken, account = 'default'): Promise<'keychain' | 'file'> {
  const payload = JSON.stringify(token);
  if (await keychainSet(account, payload)) return 'keychain';
  writeFileFallback(payload);
  return 'file';
}

export async function loadToken(account = 'default'): Promise<StoredToken | null> {
  const fromKeychain = await keychainGet(account);
  const raw = fromKeychain ?? (fs.existsSync(FILE) ? fs.readFileSync(FILE, 'utf-8') : null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredToken;
  } catch {
    return null;
  }
}

export async function clearToken(account = 'default'): Promise<void> {
  await keychainDelete(account);
  if (fs.existsSync(FILE)) fs.rmSync(FILE);
}

/** Still valid? With a margin, to avoid using one that expires in flight. */
export function isFresh(token: StoredToken, marginMs = 60_000): boolean {
  return token.expiresAt - marginMs > Date.now();
}

export const credentialsPath = FILE;
