import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import os from 'node:os';
import * as path from 'node:path';
import { OpenAIError } from 'openai';
import {
  MissingProviderCredentialError, ProjectFileRefusalError, approveProjectProfile, resolveProfile,
} from '../../../src/ai/providers/config.js';
import {
  CredentialHelperError,
  HELPER_RENEW_AFTER_MS,
  RenewingHelperKey,
  runCredentialHelper,
  runCredentialHelperSync,
} from '../../../src/ai/providers/credential-helper.js';
import { createOpenAiClient } from '../../../src/ai/providers/openai-client.js';
import type { ResolvedProfile } from '../../../src/ai/providers/types.js';

// ============================================================
// MNE-001-446 (#644): a helper's token renews during a session, and its
// error never repeats its command. Synthetic helpers only: a counter file
// and `printf`, never a real login. The home directory is a temp dir.
// ============================================================

const COMPLETION = {
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'm',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
};

let home: string;
let project: string;
let counter: string;
/** While this file exists the counting helper fails with exit 4. */
let broken: string;
/** Authorization header of each request, in order. */
let sent: string[];
/** Status the fake endpoint answers with, one per request (default 200). */
let statuses: number[];
let written: string[];

/** A helper that counts its runs and prints a different synthetic token each time. */
const countingHelper = (): string =>
  `if [ -f '${broken}' ]; then echo roto-inventado >&2; exit 4; fi; ` +
  `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'; printf 'tok-inventado-%s' "$n"`;
const runs = (): number => (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf-8').trim()) : 0);

const profileEntry = (cmd: string) => ({
  providers: {
    vault: { type: 'openai-compatible', model: 'm', base_url: 'https://v.example.test/v1', api_key_cmd: cmd },
  },
});

function writeUserConfig(cmd: string): void {
  fs.mkdirSync(path.join(home, '.mnemosine'), { recursive: true });
  fs.writeFileSync(path.join(home, '.mnemosine', 'config.json'), JSON.stringify(profileEntry(cmd)));
}

async function ask(client: ReturnType<typeof createOpenAiClient>): Promise<void> {
  await client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hola' }] });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'renewal-home-'));
  project = fs.mkdtempSync(path.join(os.tmpdir(), 'renewal-project-'));
  counter = path.join(home, 'runs');
  broken = path.join(home, 'broken');
  sent = [];
  statuses = [];
  written = [];
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('MNEMOSINE_PROVIDER', '');
  vi.stubEnv('OPENAI_BASE_URL', '');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(new Headers(init?.headers).get('authorization') ?? '');
      const status = statuses.shift() ?? 200;
      const body = status === 200 ? COMPLETION : { error: { message: 'invalid token', type: 'invalid_request_error' } };
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    })
  );
  // Nothing a helper prints may reach a log line.
  const capture = (...args: unknown[]): void => {
    written.push(args.map(String).join(' '));
  };
  for (const m of ['log', 'error', 'warn', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => (capture(chunk), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => (capture(chunk), true));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(project, { recursive: true, force: true });
});

describe('a helper in your own ~/.mnemosine/config.json renews its token', () => {
  it('runs once before the session, not again before five minutes, and again after', async () => {
    writeUserConfig(countingHelper());
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const profile = resolveProfile('vault', undefined, project);
    expect(profile.apiKey).toBe('tok-inventado-1');
    expect(profile.keyRenewal).toBeDefined();
    expect(runs()).toBe(1);

    const client = createOpenAiClient(profile);
    await ask(client);
    now += HELPER_RENEW_AFTER_MS - 1;
    await ask(client);
    expect(runs(), 'renewed before five minutes').toBe(1);
    now += 1;
    await ask(client);
    expect(runs()).toBe(2);
    expect(sent).toEqual(['Bearer tok-inventado-1', 'Bearer tok-inventado-1', 'Bearer tok-inventado-2']);
    expect(written.join('\n')).not.toMatch(/tok-inventado/);
  });

  it('after a 401 the next request carries a fresh token, and the failing turn surfaces the 401', async () => {
    writeUserConfig(countingHelper());
    const client = createOpenAiClient(resolveProfile('vault', undefined, project));
    statuses = [401];
    await expect(ask(client)).rejects.toMatchObject({ status: 401 });
    expect(sent, 'the SDK retried the 401 itself').toHaveLength(1);
    await ask(client);
    expect(sent).toEqual(['Bearer tok-inventado-1', 'Bearer tok-inventado-2']);
    expect(written.join('\n')).not.toMatch(/tok-inventado/);
  });

  it('concurrent requests on a stale token share one renewal', async () => {
    let now = 0;
    const run = vi.fn(async () => `tok-renovado-${run.mock.calls.length}`);
    const key = new RenewingHelperKey('vault', 'unused', 'tok-primero', { now: () => now, run });
    now = HELPER_RENEW_AFTER_MS;
    const tokens = await Promise.all([key.apiKey(), key.apiKey(), key.apiKey()]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(new Set(tokens)).toEqual(new Set(['tok-renovado-1']));
  });

  it('never serializes its token or its command', () => {
    const key = new RenewingHelperKey('vault', 'op read op://inventado/llave', 'tok-secreto-inventado');
    const asText = JSON.stringify({ keyRenewal: key }) + String(Object.entries(key));
    expect(asText).not.toMatch(/tok-secreto-inventado|op read/);
  });
});

describe('a helper anywhere else runs once per session, as before', () => {
  it('a project file helper does not run until approved, and then renews like the person\'s own (MNE-001-452)', async () => {
    // A project api_key_cmd names its script directly (no shell forms): the same
    // counting helper, as a script of the project.
    fs.writeFileSync(path.join(project, 'count.sh'), countingHelper() + '\n');
    fs.writeFileSync(path.join(project, 'mnemosine.config.json'), JSON.stringify(profileEntry('sh count.sh')));
    expect(() => resolveProfile('vault', undefined, project)).toThrow(ProjectFileRefusalError);
    expect(runs()).toBe(0);
    approveProjectProfile('vault', project);
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const profile = resolveProfile('vault', undefined, project);
    expect(profile.keyRenewal).toBeDefined();
    const client = createOpenAiClient(profile);
    await ask(client);
    now += 2 * HELPER_RENEW_AFTER_MS;
    await ask(client);
    expect(runs()).toBe(2);
    expect(new Set(sent)).toEqual(new Set(['Bearer tok-inventado-1', 'Bearer tok-inventado-2']));
  });

  it('an anthropic profile with a helper still sends its output once, as an API key', () => {
    fs.mkdirSync(path.join(home, '.mnemosine'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.mnemosine', 'config.json'),
      JSON.stringify({ providers: { claude: { type: 'anthropic', model: 'm', api_key_cmd: countingHelper() } } })
    );
    const profile = resolveProfile('claude', undefined, project);
    expect(profile.apiKey).toBe('tok-inventado-1');
    expect(profile.keyRenewal).toBeUndefined();
  });
});

describe('a helper that fails says which profile and why, never its command or stderr', () => {
  const COMMAND_MARK = 'marca-del-comando-inventada';
  const STDERR_MARK = 'stderr-inventado-con-ruta-secreta';
  const failing = `echo ${STDERR_MARK} >&2; exit 3 # ${COMMAND_MARK}`;

  const expectFixed = (err: unknown, reason: RegExp): void => {
    expect(err).toBeInstanceOf(CredentialHelperError);
    expect(err).not.toBeInstanceOf(MissingProviderCredentialError);
    const message = (err as Error).message;
    expect(message).toMatch(/^Provider "vault": /);
    expect(message).toMatch(reason);
    expect(message).toMatch(/Run the helper yourself to see why/);
    expect(message).not.toContain(COMMAND_MARK);
    expect(message).not.toContain(STDERR_MARK);
  };

  it('at the first run, through resolveProfile', () => {
    writeUserConfig(failing);
    let caught: unknown;
    try {
      resolveProfile('vault', undefined, project);
    } catch (err) {
      caught = err;
    }
    expectFixed(caught, /exited with code 3/);
    writeUserConfig(`printf '' # ${COMMAND_MARK}`);
    expect(() => resolveProfile('vault', undefined, project)).toThrow(/did not print a credential/);
    expect(written.join('\n')).not.toContain(STDERR_MARK);
  });

  it('on each runner: exit code, empty output and the deadline', async () => {
    expectFixed(await runCredentialHelper('vault', failing).catch((e: unknown) => e), /exited with code 3/);
    expectFixed(await runCredentialHelper('vault', `true # ${COMMAND_MARK}`).catch((e: unknown) => e), /did not print/);
    expectFixed(
      await runCredentialHelper('vault', `sleep 5 # ${COMMAND_MARK}`, { timeoutMs: 200 }).catch((e: unknown) => e),
      /did not finish within 0.2 s/
    );
    let caught: unknown;
    try {
      runCredentialHelperSync('vault', `sleep 5 # ${COMMAND_MARK}`, { timeoutMs: 200 });
    } catch (err) {
      caught = err;
    }
    expectFixed(caught, /did not finish within/);
    expect(written.join('\n')).not.toContain(STDERR_MARK);
  });

  it('a renewal that fails mid-session reaches the caller as the SDK error with the helper error as its cause', async () => {
    writeUserConfig(countingHelper());
    const profile: ResolvedProfile = resolveProfile('vault', undefined, project);
    const client = createOpenAiClient(profile);
    await ask(client);
    fs.writeFileSync(broken, '');
    profile.keyRenewal!.markStale();
    const err = await ask(client).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenAIError);
    expect((err as Error).message).not.toContain('roto-inventado');
    expectFixed((err as { cause?: unknown }).cause, /exited with code 4/);
    expect(sent, 'a request left with no fresh token').toHaveLength(1);
  });
});
