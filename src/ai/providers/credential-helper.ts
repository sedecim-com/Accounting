import { execSync, spawn } from 'node:child_process';

// ============================================================
// SECURITY: the one place a profile's `api_key_cmd` runs.
//
// A helper prints a credential on stdout. Nothing it prints is ever logged,
// and neither its command line nor its stderr reaches an error message:
// stderr is not even captured, so a vault that echoes its query, or a
// `gcloud` that prints the account, cannot leak through `reportError` or a
// CI log. A failure says the profile and the exit code or the limit it hit,
// and asks the person to run the helper themselves (MNE-001-446, #644).
//
// CONTRACT (catalog-info.yaml, provides.cli): a helper that fails or prints
// nothing raises CredentialHelperError with that fixed message. It is NOT a
// MissingProviderCredentialError, so `ingest` fails loudly at start instead
// of running the deterministic layer alone.
// ============================================================

/** The helper's deadline, as before this module existed (config.ts ran it with the same 10 s). */
export const HELPER_TIMEOUT_MS = 10_000;

/** A token older than this is renewed before the next request (renewing profiles only). */
export const HELPER_RENEW_AFTER_MS = 5 * 60_000;

/** The most a helper may print. A credential is a few kilobytes at most. */
export const HELPER_MAX_OUTPUT_BYTES = 1024 * 1024;

export type HelperFailure =
  | { kind: 'exit'; code: number | null }
  | { kind: 'deadline'; ms: number }
  | { kind: 'empty' }
  | { kind: 'oversize' };

function describeFailure(failure: HelperFailure): string {
  switch (failure.kind) {
    case 'exit':
      return failure.code === null
        ? 'its api_key_cmd stopped without an exit code'
        : `its api_key_cmd exited with code ${failure.code}`;
    case 'deadline':
      return `its api_key_cmd did not finish within ${failure.ms / 1000} s`;
    case 'empty':
      return 'its api_key_cmd did not print a credential';
    case 'oversize':
      return `its api_key_cmd printed more than ${HELPER_MAX_OUTPUT_BYTES / 1024} KiB`;
  }
}

/**
 * The helper of `profile` could not produce a credential. The message is fixed:
 * the profile and what went wrong, never the command or anything it printed.
 */
export class CredentialHelperError extends Error {
  readonly profile: string;
  readonly failure: HelperFailure;
  constructor(profile: string, failure: HelperFailure) {
    super(
      `Provider "${profile}": ${describeFailure(failure)}. ` +
        'Run the helper yourself to see why; mnemosine never prints its command or its output.'
    );
    this.name = 'CredentialHelperError';
    this.profile = profile;
    this.failure = failure;
  }
}

export interface HelperRunOptions {
  /** Deadline in ms (default HELPER_TIMEOUT_MS). A seam for tests: a real helper keeps 10 s. */
  timeoutMs?: number;
  /** The folder it runs in; default process.cwd(). */
  cwd?: string;
  /** Its environment; default process.env. */
  env?: NodeJS.ProcessEnv;
}

/** Runs the helper once, synchronously: the first run, before the session opens. */
export function runCredentialHelperSync(profile: string, command: string, opts: HelperRunOptions = {}): string {
  const timeoutMs = opts.timeoutMs ?? HELPER_TIMEOUT_MS;
  let out: string;
  try {
    out = execSync(command, {
      cwd: opts.cwd,
      env: opts.env,
      encoding: 'utf-8',
      timeout: timeoutMs,
      maxBuffer: HELPER_MAX_OUTPUT_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    const e = err as { code?: string; status?: number | null };
    if (e.code === 'ETIMEDOUT') throw new CredentialHelperError(profile, { kind: 'deadline', ms: timeoutMs });
    if (e.code === 'ENOBUFS') throw new CredentialHelperError(profile, { kind: 'oversize' });
    throw new CredentialHelperError(profile, { kind: 'exit', code: typeof e.status === 'number' ? e.status : null });
  }
  const token = out.trim();
  if (!token) throw new CredentialHelperError(profile, { kind: 'empty' });
  return token;
}

/** Runs the helper once, without blocking the event loop: every renewal. */
export function runCredentialHelper(profile: string, command: string, opts: HelperRunOptions = {}): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? HELPER_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const child = spawn(command, { cwd: opts.cwd, env: opts.env, shell: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new CredentialHelperError(profile, { kind: 'deadline', ms: timeoutMs })));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > HELPER_MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(() => reject(new CredentialHelperError(profile, { kind: 'oversize' })));
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', () => finish(() => reject(new CredentialHelperError(profile, { kind: 'exit', code: null }))));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(() => reject(new CredentialHelperError(profile, { kind: 'exit', code })));
        return;
      }
      const token = Buffer.concat(chunks).toString('utf-8').trim();
      finish(() => (token ? resolve(token) : reject(new CredentialHelperError(profile, { kind: 'empty' }))));
    });
  });
}

export interface RenewingHelperKeyOptions {
  /** Clock seam (ms). Default Date.now. */
  now?: () => number;
  /** Runner seam. Default runCredentialHelper with its 10 s deadline. */
  run?: (profile: string, command: string) => Promise<string>;
  /** Age at which the token is renewed (default HELPER_RENEW_AFTER_MS). */
  renewAfterMs?: number;
}

/**
 * The credential of an OpenAI-compatible profile whose helper lives in the
 * person's own `~/.mnemosine/config.json`, handed to the `openai` SDK as its
 * async `apiKey`: the SDK calls `apiKey()` each time it builds a request's
 * auth header (node_modules/openai/client.js, bearerAuth → _callApiKey).
 *
 * The token is reused for five minutes and then renewed, so a one-hour
 * `gcloud` token does not expire mid-chat. The SDK does not retry a 401, so
 * the client calls `markStale()` on one: the failing turn surfaces the 401,
 * and the next request renews. A renewal that fails throws
 * CredentialHelperError, which the SDK wraps as an OpenAIError with it as its
 * `cause`; the old token is not reused.
 *
 * The token and the command are private fields: neither appears in
 * JSON.stringify, util.inspect or an object spread of the profile.
 */
export class RenewingHelperKey {
  readonly #profile: string;
  readonly #command: string;
  readonly #now: () => number;
  readonly #run: (profile: string, command: string) => Promise<string>;
  readonly #renewAfterMs: number;
  #token: string;
  #fetchedAt: number;
  #stale = false;
  #inflight: Promise<string> | null = null;
  readonly #listeners = new Set<(token: string) => void>();

  constructor(profile: string, command: string, firstToken: string, opts: RenewingHelperKeyOptions = {}) {
    this.#profile = profile;
    this.#command = command;
    this.#now = opts.now ?? (() => Date.now());
    this.#run = opts.run ?? ((p, c) => runCredentialHelper(p, c));
    this.#renewAfterMs = opts.renewAfterMs ?? HELPER_RENEW_AFTER_MS;
    this.#token = firstToken;
    this.#fetchedAt = this.#now();
  }

  /**
   * Called with every renewed token BEFORE the SDK uses it (the eval's
   * redactor registers it here). Returns the unsubscribe function.
   */
  onToken(listener: (token: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The provider rejected the token (401): the next request renews it. */
  markStale(): void {
    this.#stale = true;
  }

  /** The SDK's `apiKey` function. Concurrent requests share one renewal. */
  async apiKey(): Promise<string> {
    if (!this.#stale && this.#now() - this.#fetchedAt < this.#renewAfterMs) return this.#token;
    this.#inflight ??= this.#renew().finally(() => {
      this.#inflight = null;
    });
    return this.#inflight;
  }

  async #renew(): Promise<string> {
    const token = await this.#run(this.#profile, this.#command);
    for (const listener of this.#listeners) listener(token);
    this.#token = token;
    this.#fetchedAt = this.#now();
    this.#stale = false;
    return token;
  }

  toJSON(): string {
    return `[renewing api_key_cmd of "${this.#profile}"]`;
  }
}
