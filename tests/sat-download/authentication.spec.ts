import { describe, it, expect, vi, beforeEach, afterAll, beforeAll, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The panel: ceiling and reaction per test (see policy below).
const policy = { ceiling: 999999, action: 'bloquear' };
vi.mock('../../src/services/policy/policy-service.js', () => ({
  getPolicyNumber: vi.fn(async () => policy.ceiling),
  getPolicy: vi.fn(async (_c: unknown, key: string) => ({
    key, value: policy.action, defined: true, question: '', rationale: '',
  })),
}));

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

// The real signer, wrapped only to keep a handle on the material it was given.
const signed = vi.hoisted(() => ({ material: undefined as undefined | { key: Buffer; cer: Buffer; password: string } }));
vi.mock('../../src/services/sat-download/ws-security.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/sat-download/ws-security.js')>();
  return {
    ...real,
    buildSignedAutentica: (material: Parameters<typeof real.buildSignedAutentica>[0], opts: Parameters<typeof real.buildSignedAutentica>[1]) => {
      signed.material = material;
      return real.buildSignedAutentica(material, opts);
    },
  };
});

import {
  authenticateWithSat,
  clearSatTokenCache,
  SatAuthenticationError,
} from '../../src/services/sat-download/authentication.js';
import { CredentialAccessDenied } from '../../src/services/fiscal-credentials/service.js';
import { serializeMaterial } from '../../src/services/fiscal-credentials/certificate.js';
import { query } from '../../src/database/connection.js';
import { setVaultForTesting, type SecretVault } from '../../src/services/vault/index.js';
import { startSatSimulator, tokenResponse, faultResponse, SIMULATED_TOKEN, type SatSimulator } from './sat-simulator.js';

const DIR = path.join(__dirname, '../fixtures/certs');
const MATERIAL = {
  cer: fs.readFileSync(`${DIR}/fiel.cer`),
  key: fs.readFileSync(`${DIR}/fiel.key`),
  password: 'test1234',
};

const mockQuery = query as unknown as Mock;
const CTX = { tenantId: 'tenant-a', entityId: 'entity-1', actor: 'scheduler', unattended: true };

let credential: Record<string, unknown>;
let usedToday: number;
let vaultGet: Mock;
let sim: SatSimulator;

function row(id = 'cred-1') {
  return {
    id, tenant_id: 'tenant-a', entity_id: 'entity-1', credential_type: 'efirma', rfc: 'AAA010101AAA',
    cert_serial: '30001', valid_from: new Date('2026-01-01'), valid_to: new Date('2036-01-01'),
    vault_backend: 'local-dev', vault_ref: '/vault/cred.enc', vault_version: null, status: 'active',
    unattended_access: true, max_daily_access: 24, last_used_at: null,
  };
}

/**
 * A tiny fake of the two tables withCredential and the cache read. The cap
 * count honours the outcomes its SQL names, over the rows this test logged
 * plus `usedToday` preloaded successes.
 */
function installDatabase() {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM fiscal_credentials')) return { rows: credential ? [credential] : [] };
    if (sql.includes('count(*)')) {
      const counted = ['success', 'error', 'denied'].filter((o) => sql.includes(`'${o}'`));
      const logged = logRows().filter((r) => counted.includes(String(r[8]))).length;
      return { rows: [{ n: String(logged + (counted.includes('success') ? usedToday : 0)) }] };
    }
    return { rows: [], rowCount: 1 };
  });
}

function logRows(): unknown[][] {
  return mockQuery.mock.calls
    .filter((c) => String(c[0]).includes('INSERT INTO fiscal_credential_access_log'))
    .map((c) => c[1] as unknown[]);
}

beforeAll(async () => {
  sim = await startSatSimulator();
});
afterAll(async () => {
  await sim.close();
});

beforeEach(() => {
  mockQuery.mockReset();
  clearSatTokenCache();
  credential = row();
  usedToday = 0;
  policy.ceiling = 999999;
  policy.action = 'bloquear';
  sim.requests.length = 0;
  sim.failing = false;
  vaultGet = vi.fn(async () => serializeMaterial(MATERIAL));
  setVaultForTesting({ backend: 'local-dev', get: vaultGet, put: vi.fn(), destroy: vi.fn(), healthCheck: vi.fn() } as unknown as SecretVault);
  installDatabase();
});

describe('authenticateWithSat — through withCredential', () => {
  it('signs with the vault e.firma, gets the token from the simulator and logs one sat_auth success', async () => {
    const token = await authenticateWithSat(CTX, { url: sim.url });

    expect(token.value).toBe(SIMULATED_TOKEN);
    expect(sim.requests).toHaveLength(1);
    expect(vaultGet).toHaveBeenCalledTimes(1);
    expect(logRows()).toEqual([expect.arrayContaining(['cred-1', 'sat_auth', 'scheduler', true, 'success'])]);
  });

  it('logs error, caches nothing and throws when the SAT refuses', async () => {
    sim.failing = true;
    await expect(authenticateWithSat(CTX, { url: sim.url })).rejects.toBeInstanceOf(SatAuthenticationError);
    expect(logRows()).toEqual([expect.arrayContaining(['sat_auth', 'error'])]);
    expect(String(logRows()[0].at(-1))).toMatch(/HTTP 500\); SAT said: "An error occurred when verifying security/);

    sim.failing = false;
    await authenticateWithSat(CTX, { url: sim.url });
    expect(sim.requests).toHaveLength(2);
  });

  it('is denied before any request when the daily cap is reached and the panel says bloquear', async () => {
    usedToday = 24;
    await expect(authenticateWithSat(CTX, { url: sim.url })).rejects.toBeInstanceOf(CredentialAccessDenied);
    expect(sim.requests).toHaveLength(0);
    expect(vaultGet).not.toHaveBeenCalled();
    expect(logRows()).toEqual([expect.arrayContaining(['sat_auth', 'denied', 'rate_limit'])]);
  });

  it('is denied before any request by the stricter panel ceiling', async () => {
    usedToday = 4;
    policy.ceiling = 4;
    await expect(authenticateWithSat(CTX, { url: sim.url })).rejects.toBeInstanceOf(CredentialAccessDenied);
    expect(sim.requests).toHaveLength(0);
  });

  it('counts SAT refusals toward the daily cap: after `cap` refusals the next call is denied offline', async () => {
    credential = { ...row(), max_daily_access: 3 };
    sim.failing = true;
    for (let i = 0; i < 3; i++) {
      await expect(authenticateWithSat(CTX, { url: sim.url })).rejects.toBeInstanceOf(SatAuthenticationError);
    }
    expect(sim.requests).toHaveLength(3);

    await expect(authenticateWithSat(CTX, { url: sim.url })).rejects.toBeInstanceOf(CredentialAccessDenied);
    expect(sim.requests).toHaveLength(3);
    expect(vaultGet).toHaveBeenCalledTimes(3);
    expect(logRows().at(-1)).toEqual(expect.arrayContaining(['sat_auth', 'denied', 'rate_limit']));
  });

  it('goes on with an alert row when the panel says alertar', async () => {
    usedToday = 24;
    policy.action = 'alertar';
    await authenticateWithSat(CTX, { url: sim.url });
    expect(sim.requests).toHaveLength(1);
    expect(logRows().map((r) => r[8])).toEqual(['denied', 'success']);
  });
});

describe('authenticateWithSat — the token lives in memory only while valid', () => {
  it('reuses the cached token without touching the vault or the log', async () => {
    const first = await authenticateWithSat(CTX, { url: sim.url });
    const second = await authenticateWithSat(CTX, { url: sim.url });
    expect(second).toEqual(first);
    expect(sim.requests).toHaveLength(1);
    expect(vaultGet).toHaveBeenCalledTimes(1);
    expect(logRows()).toHaveLength(1);
  });

  it('does not hand an attended token to an unattended caller the credential does not allow', async () => {
    credential = { ...row(), unattended_access: false };
    await authenticateWithSat({ ...CTX, unattended: false }, { url: sim.url });

    await expect(authenticateWithSat(CTX, { url: sim.url })).rejects.toBeInstanceOf(CredentialAccessDenied);
    expect(sim.requests).toHaveLength(1);
    expect(logRows().at(-1)).toEqual(expect.arrayContaining(['sat_auth', 'denied', 'unattended_disabled']));
  });

  it('does not serve a cached token once the credential is past its valid_to', async () => {
    await authenticateWithSat(CTX, { url: sim.url });
    credential = { ...row(), valid_to: new Date(Date.now() - 1000) };
    await expect(authenticateWithSat(CTX, { url: sim.url })).rejects.toBeInstanceOf(CredentialAccessDenied);
    expect(sim.requests).toHaveLength(1);
    expect(logRows().at(-1)).toEqual(expect.arrayContaining(['sat_auth', 'denied', 'expired']));
  });

  it('shares one signature among concurrent misses for the same entity', async () => {
    const [a, b, c] = await Promise.all([
      authenticateWithSat(CTX, { url: sim.url }),
      authenticateWithSat(CTX, { url: sim.url }),
      authenticateWithSat(CTX, { url: sim.url }),
    ]);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(sim.requests).toHaveLength(1);
    expect(vaultGet).toHaveBeenCalledTimes(1);
    expect(logRows()).toHaveLength(1);
  });

  it('wipes the decrypted material before the request leaves the process', async () => {
    let wiped = false;
    await authenticateWithSat(CTX, {
      fetchImpl: async () => {
        const m = signed.material!;
        wiped = m.key.every((b) => b === 0) && m.cer.every((b) => b === 0) && m.password === '';
        return new Response(tokenResponse(new Date(), null), { status: 200 });
      },
    });
    expect(wiped).toBe(true);
  });

  it('never writes the token to the database', async () => {
    await authenticateWithSat(CTX, { url: sim.url });
    const written = JSON.stringify(mockQuery.mock.calls);
    expect(written).not.toContain(SIMULATED_TOKEN);
  });

  it('authenticates again once the token is about to expire', async () => {
    const t0 = Date.now();
    let now = new Date(t0);
    await authenticateWithSat(CTX, { url: sim.url, now: () => now });
    now = new Date(t0 + 4 * 60_000 + 45_000);
    await authenticateWithSat(CTX, { url: sim.url, now: () => now });
    expect(sim.requests).toHaveLength(2);
  });

  it('drops the cached token when the credential that minted it is no longer the active one', async () => {
    await authenticateWithSat(CTX, { url: sim.url });
    credential = row('cred-2');
    await authenticateWithSat(CTX, { url: sim.url });
    expect(sim.requests).toHaveLength(2);
  });

  it('keeps each entity’s token apart', async () => {
    await authenticateWithSat(CTX, { url: sim.url });
    await authenticateWithSat({ ...CTX, entityId: 'entity-2' }, { url: sim.url });
    expect(sim.requests).toHaveLength(2);
  });

  it('holds the token no longer than the SAT says, and never past the signed five minutes', async () => {
    const created = new Date('2026-09-29T12:00:00.000Z');
    const answer = (expires: Date | null) => async () => new Response(tokenResponse(created, expires), { status: 200 });

    const short = await authenticateWithSat(CTX, {
      fetchImpl: answer(new Date('2026-09-29T12:02:00.000Z')), now: () => created,
    });
    expect(short.expiresAt.toISOString()).toBe('2026-09-29T12:02:00.000Z');

    clearSatTokenCache();
    const long = await authenticateWithSat(CTX, { fetchImpl: answer(new Date('2026-09-29T13:00:00.000Z')), now: () => created });
    expect(long.expiresAt.toISOString()).toBe('2026-09-29T12:05:00.000Z');

    clearSatTokenCache();
    const unstated = await authenticateWithSat(CTX, { fetchImpl: answer(null), now: () => created });
    expect(unstated.expiresAt.toISOString()).toBe('2026-09-29T12:05:00.000Z');
  });

  it('treats a 200 without a token as a refusal', async () => {
    const empty = async () => new Response('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body/></s:Envelope>', { status: 200 });
    await expect(authenticateWithSat(CTX, { fetchImpl: empty })).rejects.toThrow(/HTTP 200\)$/);
    const garbage = async () => new Response('<not xml', { status: 502 });
    await expect(authenticateWithSat(CTX, { fetchImpl: garbage })).rejects.toThrow(/HTTP 502/);
    const fault = async () => new Response(faultResponse('x'.repeat(500)), { status: 500 });
    await expect(authenticateWithSat(CTX, { fetchImpl: fault })).rejects.toThrow(/SAT said: "x{200}"$/);
  });

  it('strips control characters from the SAT fault before it reaches the log or a terminal', async () => {
    const hostile = async () => new Response(faultResponse('bad\u001b[2J\nOK forged line\u009b'), { status: 500 });
    const err = await authenticateWithSat(CTX, { fetchImpl: hostile }).catch((e: unknown) => e);
    expect((err as Error).message).toBe('The SAT refused the authentication (HTTP 500); SAT said: "bad [2J OK forged line "');
    // eslint-disable-next-line no-control-regex
    expect(String(logRows().at(-1)?.at(-1))).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
});
