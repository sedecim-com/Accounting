import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import {
  withCredential,
  CredentialAccessDenied,
  CredentialError,
} from '../../src/services/fiscal-credentials/service.js';
import { serializeMaterial } from '../../src/services/fiscal-credentials/certificate.js';
import { query } from '../../src/database/connection.js';
import { setVaultForTesting, type SecretVault } from '../../src/services/vault/index.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

const ROW = {
  id: 'cred-1',
  tenant_id: 'tenant-a',
  entity_id: 'entity-1',
  credential_type: 'efirma' as const,
  rfc: 'AAA010101AAA',
  cert_serial: '30001',
  valid_from: new Date('2026-01-01'),
  valid_to: new Date('2030-01-01'),
  vault_backend: 'local-dev',
  vault_ref: '/vault/cred.enc',
  vault_version: null,
  status: 'active' as const,
  unattended_access: true,
  max_daily_access: 24,
  last_used_at: null,
};

const MATERIAL = {
  cer: Buffer.from('CERT'),
  key: Buffer.from('PRIVATE-KEY'),
  password: 'clave123',
};

function fakeVault(overrides: Partial<SecretVault> = {}): SecretVault & { get: ReturnType<typeof vi.fn> } {
  const get = vi.fn().mockResolvedValue(serializeMaterial(MATERIAL));
  return {
    backend: 'local-dev',
    get,
    put: vi.fn(),
    destroy: vi.fn(),
    healthCheck: vi.fn(),
    ...overrides,
  } as never;
}

/** Queues: active credential, rate limit count, and the log inserts. */
function queueHappyPath(row = ROW, usedToday = '0') {
  mockQuery.mockResolvedValueOnce({ rows: [row] });        // SELECT credential
  mockQuery.mockResolvedValueOnce({ rows: [{ n: usedToday }] }); // rate limit
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });  // logs + last_used_at
}

const OPTS = { purpose: 'sat_auth' as const, actor: 'scheduler', unattended: true };

beforeEach(() => {
  mockQuery.mockReset();
  setVaultForTesting(null);
});

describe('withCredential — happy path', () => {
  it('delivers the decrypted material and logs the successful access', async () => {
    const vault = fakeVault();
    setVaultForTesting(vault);
    queueHappyPath();

    const seen: string[] = [];
    const result = await withCredential('entity-1', 'tenant-a', OPTS, async (m) => {
      seen.push(m.key.toString(), m.password);
      return 'done';
    });

    expect(result).toBe('done');
    expect(seen).toEqual(['PRIVATE-KEY', 'clave123']);

    const logInsert = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO fiscal_credential_access_log'));
    expect(logInsert).toBeDefined();
    expect(logInsert![1]).toEqual(expect.arrayContaining(['sat_auth', 'scheduler', true, 'success']));
  });

  it('zeroizes the material on exit (nothing stays in memory)', async () => {
    setVaultForTesting(fakeVault());
    queueHappyPath();

    let captured: { cer: Buffer; key: Buffer; password: string } | undefined;
    await withCredential('entity-1', 'tenant-a', OPTS, async (m) => {
      captured = m;
      return null;
    });

    expect(captured!.key.every((b) => b === 0)).toBe(true);
    expect(captured!.cer.every((b) => b === 0)).toBe(true);
    expect(captured!.password).toBe('');
  });

  it('passes the correct context to the vault (tenant + entity + kind)', async () => {
    const vault = fakeVault();
    setVaultForTesting(vault);
    queueHappyPath();
    await withCredential('entity-1', 'tenant-a', OPTS, async () => null);
    expect(vault.get).toHaveBeenCalledWith(
      { tenantId: 'tenant-a', entityId: 'entity-1', kind: 'efirma' },
      { ref: '/vault/cred.enc', backend: 'local-dev', version: undefined }
    );
  });
});

describe('withCredential — denial policies', () => {
  it('denies and LOGS when the credential has expired', async () => {
    setVaultForTesting(fakeVault());
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, valid_to: new Date('2020-01-01') }] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await expect(
      withCredential('entity-1', 'tenant-a', OPTS, async () => null)
    ).rejects.toBeInstanceOf(CredentialAccessDenied);

    const log = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO fiscal_credential_access_log'));
    expect(log![1]).toEqual(expect.arrayContaining(['denied', 'expired']));
  });

  it('denies unattended use when the policy forbids it', async () => {
    setVaultForTesting(fakeVault());
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, unattended_access: false }] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await expect(
      withCredential('entity-1', 'tenant-a', { ...OPTS, unattended: true }, async () => null)
    ).rejects.toThrow(/operator must be present/);
  });

  it('allows ATTENDED use even when unattended use is forbidden', async () => {
    setVaultForTesting(fakeVault());
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, unattended_access: false }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '0' }] });
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });

    await expect(
      withCredential('entity-1', 'tenant-a', { ...OPTS, unattended: false }, async () => 'ok')
    ).resolves.toBe('ok');
  });

  it('denies when the daily access limit is reached', async () => {
    setVaultForTesting(fakeVault());
    queueHappyPath(ROW, '24'); // max_daily_access = 24
    await expect(
      withCredential('entity-1', 'tenant-a', OPTS, async () => null)
    ).rejects.toThrow(/limit of 24 accesses/);
  });

  it('does NOT query the vault when policy denies', async () => {
    const vault = fakeVault();
    setVaultForTesting(vault);
    queueHappyPath(ROW, '99');
    await expect(withCredential('entity-1', 'tenant-a', OPTS, async () => null)).rejects.toThrow();
    expect(vault.get).not.toHaveBeenCalled();
  });

  it('requires an active credential to exist', async () => {
    setVaultForTesting(fakeVault());
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      withCredential('entity-1', 'tenant-a', OPTS, async () => null)
    ).rejects.toBeInstanceOf(CredentialError);
  });
});

describe('withCredential — errors', () => {
  it('logs the error and propagates it when the callback fails', async () => {
    setVaultForTesting(fakeVault());
    queueHappyPath();

    await expect(
      withCredential('entity-1', 'tenant-a', OPTS, async () => {
        throw new Error('the SAT rejected the token');
      })
    ).rejects.toThrow('the SAT rejected the token');

    const log = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO fiscal_credential_access_log'));
    expect(log![1]).toEqual(expect.arrayContaining(['error']));
  });

  it('zeroizes even if the callback blows up', async () => {
    setVaultForTesting(fakeVault());
    queueHappyPath();
    let captured: { key: Buffer } | undefined;
    await withCredential('entity-1', 'tenant-a', OPTS, async (m) => {
      captured = m;
      throw new Error('boom');
    }).catch(() => undefined);
    expect(captured!.key.every((b) => b === 0)).toBe(true);
  });

  it('logs the error if the vault fails to decrypt', async () => {
    setVaultForTesting(fakeVault({ get: vi.fn().mockRejectedValue(new Error('KMS down')) }));
    queueHappyPath();
    await expect(
      withCredential('entity-1', 'tenant-a', OPTS, async () => null)
    ).rejects.toThrow(/KMS down/);
    const log = mockQuery.mock.calls.find((c) => String(c[0]).includes('INSERT INTO fiscal_credential_access_log'));
    expect(log![1]).toEqual(expect.arrayContaining(['error']));
  });
});
