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
  ExternalCredentialError,
} from '../../../src/services/integrations/accounting/entity-credentials.js';
import { getExternalAdapter, listExternalSystems } from '../../../src/services/integrations/accounting/registry.js';

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

  it('refuses an entity outside the tenant', async () => {
    mockQuery.mockResolvedValueOnce(credRow(RFC)).mockResolvedValueOnce({ rows: [] });
    await expect(withExternalCredential(REF, 'contalink', (k) => k)).rejects.toThrow(ExternalCredentialError);
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
    expect(vault.get).toHaveBeenCalledWith({ tenantId: 't1', entityId: 'e1', kind: 'contalink' },
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

  it('revokes the previous active key and inserts the new one in one transaction, without the key', async () => {
    mockQuery.mockResolvedValueOnce(entityRow(RFC));
    vault.put.mockResolvedValueOnce({ backend: 'test', ref: 'r2', version: 'v2' });
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'c2', rfc: RFC }] }) };
    mockTx.mockImplementationOnce(async (fn: (c: typeof client) => unknown) => fn(client));

    expect(await storeExternalCredential({ ...input, apiKey: Buffer.from('k-123') })).toEqual({ id: 'c2', rfc: RFC });
    const [revokeSql, revokeParams] = client.query.mock.calls[0] as [string, unknown[]];
    expect(revokeSql).toMatch(/SET status = 'revoked'[\s\S]*entity_id = \$1 AND tenant_id = \$2 AND provider = \$3 AND status = 'active'/);
    expect(revokeParams).toEqual(['e1', 't1', 'contalink']);
    const [, insertParams] = client.query.mock.calls[1] as [string, unknown[]];
    expect(insertParams).toEqual(['t1', 'e1', 'contalink', RFC, 'test', 'r2', 'v2', 'owner@test']);
    expect(JSON.stringify(insertParams)).not.toContain('k-123');
  });
});

describe('hasExternalCredential and the registry', () => {
  it('checks the metadata only', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    expect(await hasExternalCredential(REF, 'contalink')).toBe(true);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await hasExternalCredential(REF, 'contalink')).toBe(false);
    expect(vault.get).not.toHaveBeenCalled();
  });

  it('rejects an unknown system before looking for a key', async () => {
    expect(listExternalSystems()).toEqual(['contalink']);
    await expect(getExternalAdapter(REF, 'nope')).rejects.toThrow(/Unknown external accounting system/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
