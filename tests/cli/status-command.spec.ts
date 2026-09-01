import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));
vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: vi.fn(),
}));

import { query } from '../../src/database/connection.js';
import {
  buildStatusReport,
  formatStatus,
  hasProviderFailures,
  redactHomePath,
  sanitizeDbError,
  statusExitCode,
  type StatusReport,
} from '../../src/cli/status-command.js';

const mockQuery = query as unknown as Mock;

const FAKE_KEY = 'sk-super-secret-status-key-42';
let tmpDir: string;

const plainPalette = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };

const okFetch = () =>
  vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' }) as unknown as typeof fetch;

function writeConfig(over: Record<string, unknown> = {}) {
  fs.writeFileSync(
    path.join(tmpDir, 'mnemosine.config.json'),
    JSON.stringify({
      default_provider: 'primary',
      ingest: { auto_post: true, auto_post_max_amount: 999999 },
      providers: {
        primary: {
          type: 'openai-compatible',
          model: 'primary-model',
          base_url: 'https://primary.example/v1',
          api_key_env: 'FAKE_STATUS_KEY',
          failover: ['backup'],
        },
        backup: {
          type: 'openai-compatible',
          model: 'backup-model',
          base_url: 'https://backup.example/v1',
          api_key_env: 'BACKUP_KEY',
        },
      },
      ...over,
    })
  );
}

function mockDbUp(tenant: string | null = 'tenant-acme') {
  mockQuery.mockImplementation((sql?: unknown) => {
    const q = typeof sql === 'string' ? sql : '';
    if (q.includes('current_setting')) return Promise.resolve({ rows: [{ tenant }] });
    return Promise.resolve({ rows: [{ ok: 1 }] });
  });
}

beforeEach(() => {
  mockQuery.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-'));
  delete process.env.MNEMOSINE_PROVIDER;
  delete process.env.MNEMOSINE_LANG;
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const env = { FAKE_STATUS_KEY: FAKE_KEY } as NodeJS.ProcessEnv;

describe('buildStatusReport — config summary', () => {
  it('reports thresholds AFTER floor clamping: config can never raise the cap', async () => {
    writeConfig(); // auto_post_max_amount 999999 in the file
    mockDbUp();
    const r = await buildStatusReport({ cwd: tmpDir, env, probeOptions: { fetchImpl: okFetch() } });
    expect(r.config.provider).toBe('primary');
    expect(r.config.model).toBe('primary-model');
    expect(r.config.thresholds.maxAmount).toBe(50000); // Math.min(999999, floor)
    expect(r.config.thresholds.floorCap).toBe(50000);
    expect(r.config.thresholds.autoPost).toBe(true);
    expect(r.config.language).toBe('es');
  });
});

describe('buildStatusReport — providers and probes', () => {
  it('probes the active failover chain by default and reports env var NAMES with set/unset', async () => {
    writeConfig();
    mockDbUp();
    const fetchImpl = okFetch();
    const r = await buildStatusReport({ cwd: tmpDir, env, probeOptions: { fetchImpl } });

    expect(r.providers.map((p) => p.name)).toEqual(['primary', 'backup']);
    const primary = r.providers[0];
    expect(primary.keyEnv).toBe('FAKE_STATUS_KEY'); // the NAME is printable
    expect(primary.keySet).toBe(true);
    expect(primary.failover).toEqual(['backup']);
    expect(primary.probe?.ok).toBe(true);

    // backup's credential env is unset: probe skipped, never attempted blind
    const backup = r.providers[1];
    expect(backup.keySet).toBe(false);
    expect(backup.skipped).toBe('credential BACKUP_KEY unset');
    expect(backup.probe).toBeUndefined();
    const urls = (fetchImpl as unknown as Mock).mock.calls.map((c) => c[0]);
    expect(urls).toEqual(['https://primary.example/v1/models']);
  });
});

describe('buildStatusReport — database and RLS', () => {
  it('checks RLS via current_setting(app.current_tenant) — how connection.ts scopes queries', async () => {
    writeConfig();
    mockDbUp('tenant-acme');
    const r = await buildStatusReport({ cwd: tmpDir, env, probeOptions: { fetchImpl: okFetch() } });
    expect(r.database.ok).toBe(true);
    expect(r.rls.active).toBe(true);
    expect(r.rls.detail).toContain('tenant-acme');
    expect(mockQuery).toHaveBeenCalledWith(
      "SELECT current_setting('app.current_tenant', true) AS tenant"
    );
  });

  it('reports RLS inactive when no tenant context is applied', async () => {
    writeConfig();
    mockDbUp(null);
    const r = await buildStatusReport({ cwd: tmpDir, env, probeOptions: { fetchImpl: okFetch() } });
    expect(r.rls.active).toBe(false);
    expect(r.rls.detail).toContain('MNEMOSINE_TENANT');
  });

  it('captures an unreachable database as a row instead of throwing, without echoing the address', async () => {
    writeConfig();
    mockQuery.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
    const r = await buildStatusReport({ cwd: tmpDir, env, probeOptions: { fetchImpl: okFetch() } });
    expect(r.database.ok).toBe(false);
    expect(r.database.detail).toBe('unreachable (ECONNREFUSED)');
    expect(r.database.detail).not.toContain('127.0.0.1'); // taxonomy + code only
    expect(r.rls.active).toBe(false);
    expect(r.rls.detail).toContain('skipped');
  });

  it('a DSN-bearing pg auth error never leaks user or host into the report', async () => {
    writeConfig();
    mockQuery.mockRejectedValue(
      Object.assign(
        new Error(
          'password authentication failed for user "victor" (postgresql://victor:hunter2@db.internal.corp:5432/mnemosine)'
        ),
        { code: '28P01' }
      )
    );
    const r = await buildStatusReport({ cwd: tmpDir, env, probeOptions: { fetchImpl: okFetch() } });
    expect(r.database.ok).toBe(false);
    expect(r.database.detail).toBe('auth (28P01)');
    const serialized = JSON.stringify(r);
    expect(serialized).not.toContain('victor');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('db.internal.corp');
  });
});

describe('sanitizeDbError — fixed taxonomy, never message text', () => {
  it('maps codes to unreachable/auth/timeout and never echoes err.message', () => {
    expect(sanitizeDbError({ code: '28P01', message: 'password authentication failed for user "victor"' })).toBe(
      'auth (28P01)'
    );
    expect(sanitizeDbError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT 10.0.0.9:5432' })).toBe(
      'timeout (ETIMEDOUT)'
    );
    expect(
      sanitizeDbError({ code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND db.internal.corp' })
    ).toBe('unreachable (ENOTFOUND)');
    expect(sanitizeDbError({ code: '3D000', message: 'database "mnemosine" does not exist' })).toBe(
      'unreachable (3D000)'
    );
  });

  it('reads the code from a nested cause and falls back to allowlisted tokens in the message', () => {
    expect(sanitizeDbError({ message: 'fetch failed', cause: { code: 'ECONNREFUSED' } })).toBe(
      'unreachable (ECONNREFUSED)'
    );
    // No .code at all: the errno is extracted from the message via a FIXED
    // allowlist — free text (the host) still never surfaces.
    expect(sanitizeDbError(new Error('connect ECONNREFUSED 127.0.0.1:5432'))).toBe('unreachable (ECONNREFUSED)');
  });

  it('anything unrecognized collapses to "other" with zero message leakage', () => {
    expect(sanitizeDbError(new Error('malformed DATABASE_URL postgres://u:p@h/d'))).toBe('other');
    expect(sanitizeDbError(null)).toBe('other');
    expect(sanitizeDbError('raw string with a host db.internal.corp')).toBe('other');
  });
});

describe('buildStatusReport — api_key_cmd credential resolution', () => {
  const CMD_KEY = 'sk-from-vault-helper-77';

  function writeCmdConfig() {
    writeConfig({
      default_provider: 'vaulted',
      providers: {
        vaulted: {
          type: 'openai-compatible',
          model: 'vault-model',
          base_url: 'https://vault.example/v1',
          api_key_cmd: 'security find-generic-password -w -s vault-key',
        },
      },
    });
  }

  it('resolves api_key_cmd through the real session resolver and probes with it', async () => {
    writeCmdConfig();
    mockDbUp();
    const fetchImpl = okFetch();
    const resolveProfileFn = vi.fn().mockReturnValue({
      name: 'vaulted',
      type: 'openai-compatible',
      model: 'vault-model',
      base_url: 'https://vault.example/v1',
      apiKey: CMD_KEY,
    });
    const r = await buildStatusReport({
      cwd: tmpDir,
      env: {},
      probeOptions: { fetchImpl },
      resolveProfileFn,
    });
    const row = r.providers.find((p) => p.name === 'vaulted');
    expect(resolveProfileFn).toHaveBeenCalledWith('vaulted', undefined, tmpDir);
    expect(row?.keySet).toBe(true); // NOT reported as unset (#20)
    expect(row?.keySource).toBe('cmd');
    expect(row?.skipped).toBeUndefined();
    expect(row?.probe?.ok).toBe(true);
    const mock = fetchImpl as unknown as Mock;
    expect(mock.mock.calls[0][0]).toBe('https://vault.example/v1/models');
    expect(mock.mock.calls[0][1].headers.authorization).toBe(`Bearer ${CMD_KEY}`);
  });

  it('a failing api_key_cmd skips the probe with a FIXED shareable string (no command echo)', async () => {
    writeCmdConfig();
    mockDbUp();
    const fetchImpl = okFetch();
    const resolveProfileFn = vi.fn().mockImplementation(() => {
      throw new Error('Command failed: security find-generic-password -w -s vault-key');
    });
    const r = await buildStatusReport({
      cwd: tmpDir,
      env: {},
      probeOptions: { fetchImpl },
      resolveProfileFn,
    });
    const row = r.providers.find((p) => p.name === 'vaulted');
    expect(row?.skipped).toBe('api_key_cmd failed to produce a credential');
    expect(row?.probe).toBeUndefined();
    expect((fetchImpl as unknown as Mock).mock.calls).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain('find-generic-password'); // helper cmdline never leaks
  });

  it('env var still wins over api_key_cmd — the helper is only consulted when the env is empty', async () => {
    writeConfig({
      default_provider: 'primary',
      providers: {
        primary: {
          type: 'openai-compatible',
          model: 'primary-model',
          base_url: 'https://primary.example/v1',
          api_key_env: 'FAKE_STATUS_KEY',
          api_key_cmd: 'echo should-not-run',
        },
      },
    });
    mockDbUp();
    const resolveProfileFn = vi.fn();
    const r = await buildStatusReport({
      cwd: tmpDir,
      env,
      probeOptions: { fetchImpl: okFetch() },
      resolveProfileFn,
    });
    expect(resolveProfileFn).not.toHaveBeenCalled();
    expect(r.providers[0].keySource).toBe('env');
  });
});

describe('statusExitCode — DB is the primary gate; --strict adds probe failures', () => {
  const base = (over: Partial<StatusReport> = {}): StatusReport => ({
    config: {
      source: null,
      provider: 'p',
      model: 'm',
      language: 'es',
      thresholds: { autoPost: false, minConfidence: 0.9, maxAmount: 50000, floorCap: 50000 },
    },
    database: { ok: true, detail: 'reachable' },
    rls: { active: true, detail: 'tenant context "t" applied' },
    providers: [],
    ...over,
  });
  const okRow = { name: 'p', type: 'openai-compatible', model: 'm', keyEnv: null, keySet: false };

  it('an unreachable database exits 1 with or without --strict', () => {
    const r = base({ database: { ok: false, detail: 'unreachable (ECONNREFUSED)' } });
    expect(statusExitCode(r, false)).toBe(1);
    expect(statusExitCode(r, true)).toBe(1);
  });

  it('a failed probe exits 0 by default but 1 under --strict', () => {
    const r = base({
      providers: [
        { ...okRow, probe: { name: 'p', ok: false, category: 'auth', latencyMs: 5, detail: 'HTTP 401' } },
      ],
    });
    expect(hasProviderFailures(r)).toBe(true);
    expect(statusExitCode(r, false)).toBe(0); // default: DB gate only
    expect(statusExitCode(r, true)).toBe(1);
  });

  it('a SKIPPED probe fails closed under --strict: "not tested" is not "healthy"', () => {
    const r = base({ providers: [{ ...okRow, skipped: 'credential X_KEY unset' }] });
    expect(statusExitCode(r, false)).toBe(0);
    expect(statusExitCode(r, true)).toBe(1);
  });

  it('all probes ok exits 0 under --strict too', () => {
    const r = base({
      providers: [{ ...okRow, probe: { name: 'p', ok: true, latencyMs: 8, detail: 'HTTP 200' } }],
    });
    expect(hasProviderFailures(r)).toBe(false);
    expect(statusExitCode(r, true)).toBe(0);
  });
});

describe('redaction — the whole output is shareable in a support ticket', () => {
  async function reportWithEchoingProvider(): Promise<StatusReport> {
    writeConfig();
    mockDbUp();
    // Worst case: the endpoint echoes the credential back in an error body.
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => `{"error":{"message":"key ${FAKE_KEY} is invalid"}}`,
    }) as unknown as typeof fetch;
    return buildStatusReport({ cwd: tmpDir, env, probeOptions: { fetchImpl } });
  }

  it('the API key from the env NEVER appears in the report (JSON mode)', async () => {
    const r = await reportWithEchoingProvider();
    expect(JSON.stringify(r)).not.toContain(FAKE_KEY);
    // yet the env var NAME and its set/unset state are there for the operator
    expect(JSON.stringify(r)).toContain('FAKE_STATUS_KEY');
  });

  it('the API key never appears in the human-readable rendering either', async () => {
    const r = await reportWithEchoingProvider();
    const text = formatStatus(r, plainPalette).join('\n');
    expect(text).not.toContain(FAKE_KEY);
    expect(text).toContain('FAKE_STATUS_KEY set');
    expect(text).toContain('BACKUP_KEY unset');
  });

  it('collapses home paths to ~ (redactHomePath)', () => {
    expect(redactHomePath('/home/victor/.mnemosine/config.json', '/home/victor')).toBe(
      '~/.mnemosine/config.json'
    );
    expect(redactHomePath('/srv/app/mnemosine.config.json', '/home/victor')).toBe(
      '/srv/app/mnemosine.config.json'
    );
    expect(redactHomePath(null)).toBeNull();
  });
});
