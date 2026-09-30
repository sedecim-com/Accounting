import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
}));

import { query, withTransaction } from '../../../src/database/connection.js';
import { setVaultForTesting, type SecretVault } from '../../../src/services/vault/index.js';
import {
  storeExternalCredential,
  withExternalCredential,
  hasExternalCredential,
  assertExternalCredentialUsable,
  ExternalCredentialError,
} from '../../../src/services/integrations/accounting/entity-credentials.js';
import {
  assertExternalAdapterUsable,
  getExternalAdapter,
  listExternalSystems,
} from '../../../src/services/integrations/accounting/registry.js';
import { exitCodeFor, ExitCode } from '../../../src/cli/kernel/index.js';

// MNE-001-121 (#357): the edges the integration spec does not walk.

const mockQuery = query as unknown as Mock;
const mockTx = withTransaction as unknown as Mock;
const REF = { tenantId: 't1', entityId: 'e1' };
const RFC = 'EKU9003173C9';
const vault = { backend: 'test', put: vi.fn(), get: vi.fn(), destroy: vi.fn(), healthCheck: vi.fn() };

const entityRow = (tax_id: string, tax_id_type = 'rfc') => ({ rows: [{ tax_id, tax_id_type }] });
const credRow = (rfc: string) => ({
  rows: [{ id: 'c1', rfc, vault_backend: 'test', vault_ref: 'r1', vault_version: null }],
});

beforeEach(() => {
  mockQuery.mockReset();
  mockTx.mockReset();
  Object.values(vault).forEach((v) => typeof v === 'function' && v.mockReset());
  setVaultForTesting(vault as unknown as SecretVault);
});

describe('withExternalCredential', () => {
  it('refuses an entity with no RFC before reading the vault', async () => {
    mockQuery.mockResolvedValueOnce(credRow(RFC)).mockResolvedValueOnce(entityRow('12-3456789', 'ein'));
    await expect(withExternalCredential(REF, 'contalink', (k) => k)).rejects.toThrow(/has no RFC/);
    expect(vault.get).not.toHaveBeenCalled();
  });

  it('refuses an entity outside the tenant: the RFC lookup is scoped to the tenant', async () => {
    mockQuery.mockResolvedValueOnce(credRow(RFC)).mockResolvedValueOnce({ rows: [] });
    await expect(withExternalCredential(REF, 'contalink', (k) => k)).rejects.toThrow(/does not exist in this tenant/);
    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(sql).toMatch(/FROM legal_entities WHERE id = \$1 AND tenant_id = \$2/);
    expect(params).toEqual(['e1', 't1']);
    expect(vault.get).not.toHaveBeenCalled();
  });

  it('refuses a key registered for another RFC before reading the vault', async () => {
    mockQuery.mockResolvedValueOnce(credRow('XAXX010101000')).mockResolvedValueOnce(entityRow(RFC));
    await expect(withExternalCredential(REF, 'contalink', (k) => k)).rejects.toThrow(/registered for RFC XAXX010101000/);
    expect(vault.get).not.toHaveBeenCalled();
  });

  it('a refusal is BLOCKED (423), not the generic exit 1: a human must register the key', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const err = await withExternalCredential(REF, 'contalink', (k) => k).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExternalCredentialError);
    expect((err as ExternalCredentialError).statusCode).toBe(423);
    expect(exitCodeFor(err)).toBe(ExitCode.BLOCKED);
  });

  it('scopes the lookup to entity, tenant, provider and the ACTIVE key', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(withExternalCredential(REF, 'contalink', (k) => k)).rejects.toThrow(/no contalink key/);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/entity_id = \$1 AND tenant_id = \$2 AND provider = \$3 AND status = 'active'/);
    expect(params).toEqual(['e1', 't1', 'contalink']);
  });

  it('hands the key to the caller and wipes the vault buffer afterwards', async () => {
    const blob = Buffer.from('secret-key');
    vault.get.mockResolvedValueOnce(blob);
    mockQuery.mockResolvedValueOnce(credRow(RFC)).mockResolvedValueOnce(entityRow(` ${RFC.toLowerCase()} `));
    expect(await withExternalCredential(REF, 'contalink', (k) => k)).toBe('secret-key');
    // One secret per registration: the row id is part of the vault name.
    expect(vault.get).toHaveBeenCalledWith({ tenantId: 't1', entityId: 'e1', kind: 'contalink-c1' },
      { ref: 'r1', backend: 'test', version: undefined });
    expect(blob.every((byte) => byte === 0)).toBe(true);
  });
});

describe('storeExternalCredential', () => {
  const input = { ...REF, provider: 'contalink', rfc: RFC, registeredBy: 'owner@test' };

  it('refuses an empty key before the vault', async () => {
    mockQuery.mockResolvedValueOnce(entityRow(RFC));
    await expect(storeExternalCredential({ ...input, apiKey: Buffer.alloc(0) })).rejects.toThrow(/empty/);
    expect(vault.put).not.toHaveBeenCalled();
  });

  it('refuses a key declared for another RFC before the vault; the lookup is tenant-scoped', async () => {
    mockQuery.mockResolvedValueOnce(entityRow(RFC));
    await expect(storeExternalCredential({ ...input, rfc: 'XAXX010101000', apiKey: Buffer.from('k') }))
      .rejects.toThrow(/declared for RFC XAXX010101000/);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/FROM legal_entities WHERE id = \$1 AND tenant_id = \$2/);
    expect(params).toEqual(['e1', 't1']);
    expect(vault.put).not.toHaveBeenCalled();
  });

  it('revokes the previous active key and inserts the new one in one transaction, without the key', async () => {
    mockQuery.mockResolvedValueOnce(entityRow(RFC));
    vault.put.mockResolvedValueOnce({ backend: 'test', ref: 'r2', version: 'v2' });
    vault.destroy.mockResolvedValue(undefined);
    const old = { id: 'c0', rfc: RFC, vault_backend: 'test', vault_ref: 'r0', vault_version: null };
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [old] }).mockResolvedValueOnce({ rows: [{ id: 'c2', rfc: RFC }] }) };
    mockTx.mockImplementationOnce(async (fn: (c: typeof client) => unknown) => fn(client));

    expect(await storeExternalCredential({ ...input, apiKey: Buffer.from('k-123') })).toEqual({ id: 'c2', rfc: RFC });
    const [revokeSql, revokeParams] = client.query.mock.calls[0] as [string, unknown[]];
    expect(revokeSql).toMatch(/SET status = 'revoked'[\s\S]*entity_id = \$1 AND tenant_id = \$2 AND provider = \$3 AND status = 'active'/);
    expect(revokeParams).toEqual(['e1', 't1', 'contalink']);
    const [, insertParams] = client.query.mock.calls[1] as [string, unknown[]];
    const [id, ...rest] = insertParams;
    expect(rest).toEqual(['t1', 'e1', 'contalink', RFC, 'test', 'r2', 'v2', 'owner@test']);
    expect(JSON.stringify(insertParams)).not.toContain('k-123');
    // The secret is named after THIS row, so it never overwrites another row's.
    expect(vault.put.mock.calls[0][0]).toEqual({ tenantId: 't1', entityId: 'e1', kind: `contalink-${id as string}` });
    // The revoked row keeps its metadata as history; its key material goes.
    expect(vault.destroy).toHaveBeenCalledTimes(1);
    expect(vault.destroy).toHaveBeenCalledWith(
      { tenantId: 't1', entityId: 'e1', kind: 'contalink-c0' },
      { ref: 'r0', backend: 'test', version: undefined }
    );
  });

  it('a failed transaction destroys the secret it just wrote and surfaces the original error', async () => {
    mockQuery.mockResolvedValueOnce(entityRow(RFC));
    const written = { backend: 'test', ref: 'r3' };
    vault.put.mockResolvedValueOnce(written);
    vault.destroy.mockRejectedValueOnce(new Error('vault down'));
    mockTx.mockRejectedValueOnce(new Error('duplicate key value violates unique constraint'));

    await expect(storeExternalCredential({ ...input, apiKey: Buffer.from('k-9') })).rejects.toThrow(/duplicate key/);
    expect(vault.destroy).toHaveBeenCalledWith(vault.put.mock.calls[0][0], written);
  });
});

describe('hasExternalCredential and the registry', () => {
  it('checks the metadata only, scoped to entity AND tenant, and requires the current RFC', async () => {
    mockQuery.mockResolvedValueOnce(credRow(RFC)).mockResolvedValueOnce(entityRow(RFC));
    expect(await hasExternalCredential(REF, 'contalink')).toBe(true);
    const [credSql, credParams] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(credSql).toMatch(/entity_id = \$1 AND tenant_id = \$2 AND provider = \$3 AND status = 'active'/);
    expect(credParams).toEqual(['e1', 't1', 'contalink']);
    const [entSql, entParams] = mockQuery.mock.calls[1] as [string, unknown[]];
    expect(entSql).toMatch(/FROM legal_entities WHERE id = \$1 AND tenant_id = \$2/);
    expect(entParams).toEqual(['e1', 't1']);

    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await hasExternalCredential(REF, 'contalink')).toBe(false);
    // A key left behind by an RFC change is not a usable key.
    mockQuery.mockResolvedValueOnce(credRow('XAXX010101000')).mockResolvedValueOnce(entityRow(RFC));
    expect(await hasExternalCredential(REF, 'contalink')).toBe(false);
    expect(vault.get).not.toHaveBeenCalled();
  });

  it('lets an infrastructure error through instead of reading it as "no key"', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));
    await expect(hasExternalCredential(REF, 'contalink')).rejects.toThrow(/connection refused/);
  });

  it('assertExternalAdapterUsable validates system and key without touching the vault', async () => {
    await expect(assertExternalAdapterUsable(REF, 'nope')).rejects.toThrow(/Unknown external accounting system/);
    mockQuery.mockResolvedValueOnce(credRow(RFC)).mockResolvedValueOnce(entityRow(RFC));
    await expect(assertExternalAdapterUsable(REF, 'contalink')).resolves.toBeUndefined();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(assertExternalCredentialUsable(REF, 'contalink')).rejects.toThrow(ExternalCredentialError);
    expect(vault.get).not.toHaveBeenCalled();
  });

  it('rejects an unknown system before looking for a key', async () => {
    expect(listExternalSystems()).toEqual(['contalink']);
    await expect(getExternalAdapter(REF, 'nope')).rejects.toThrow(/Unknown external accounting system/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
