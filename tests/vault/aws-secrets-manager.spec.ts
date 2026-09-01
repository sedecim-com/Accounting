import { describe, it, expect, vi, type Mock } from 'vitest';
import { AwsSecretsManagerVault } from '../../src/services/vault/aws-secrets-manager.js';
import { SecretContextMismatchError, SecretVaultError } from '../../src/services/vault/types.js';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

const CTX = { tenantId: 'tenant-a', entityId: 'entity-1', kind: 'efirma' };
const PREFIX = 'mnemosine/prod';
const NAME = `${PREFIX}/fiscal/tenant-a/entity-1/efirma`;
const ARN = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${NAME}-AbCdEf`;

function vaultWith(send: Mock) {
  return new AwsSecretsManagerVault({
    region: 'us-east-1',
    prefix: PREFIX,
    client: { send } as unknown as SecretsManagerClient,
  });
}

function awsError(name: string) {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe('AwsSecretsManagerVault', () => {
  it('names the secret deterministically with tenant and entity', () => {
    const v = vaultWith(vi.fn());
    expect(v.secretName(CTX)).toBe(NAME);
  });

  it('creates the secret as binary, with the KMS key and tenant tags', async () => {
    const send = vi.fn().mockResolvedValueOnce({ ARN, VersionId: 'v1' });
    const v = new AwsSecretsManagerVault({
      region: 'us-east-1', prefix: PREFIX, kmsKeyId: 'alias/mnemosine',
      client: { send } as unknown as SecretsManagerClient,
    });
    const ref = await v.put(CTX, Buffer.from('material'));

    expect(ref).toEqual({ ref: ARN, backend: 'aws-secrets-manager', version: 'v1' });
    const input = send.mock.calls[0][0].input;
    expect(input.Name).toBe(NAME);
    expect(input.SecretBinary).toBeInstanceOf(Buffer);
    expect(input.SecretString).toBeUndefined(); // binary, not string
    expect(input.KmsKeyId).toBe('alias/mnemosine');
    expect(input.Tags).toEqual(
      expect.arrayContaining([{ Key: 'tenant_id', Value: 'tenant-a' }])
    );
  });

  it('versions with PutSecretValue if it already exists', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(awsError('ResourceExistsException'))
      .mockResolvedValueOnce({ ARN, VersionId: 'v2' });
    const ref = await vaultWith(send).put(CTX, Buffer.from('new'));
    expect(ref.version).toBe('v2');
    expect(send.mock.calls[1][0].input.SecretId).toBe(NAME);
  });

  it('propagates other creation errors as SecretVaultError', async () => {
    const send = vi.fn().mockRejectedValueOnce(awsError('AccessDeniedException'));
    await expect(vaultWith(send).put(CTX, Buffer.from('x'))).rejects.toBeInstanceOf(SecretVaultError);
  });

  it('rejects material exceeding the 64 KB limit', async () => {
    const send = vi.fn();
    await expect(
      vaultWith(send).put(CTX, Buffer.alloc(65_537))
    ).rejects.toThrow(/exceeds the Secrets Manager limit/);
    expect(send).not.toHaveBeenCalled();
  });

  it('reads the binary material', async () => {
    const send = vi.fn().mockResolvedValueOnce({ SecretBinary: Buffer.from('key-material') });
    const got = await vaultWith(send).get(CTX, { ref: ARN, backend: 'aws-secrets-manager' });
    expect(got.toString()).toBe('key-material');
  });

  it('REJECTS a reference that does not match the context (another tenant)', async () => {
    const send = vi.fn();
    const otherArn = ARN.replace('tenant-a', 'tenant-z');
    await expect(
      vaultWith(send).get(CTX, { ref: otherArn, backend: 'aws-secrets-manager' })
    ).rejects.toBeInstanceOf(SecretContextMismatchError);
    expect(send).not.toHaveBeenCalled(); // AWS is not even called
  });

  it('deletes without a recovery window', async () => {
    const send = vi.fn().mockResolvedValueOnce({});
    await vaultWith(send).destroy(CTX, { ref: ARN, backend: 'aws-secrets-manager' });
    expect(send.mock.calls[0][0].input.ForceDeleteWithoutRecovery).toBe(true);
  });

  it('destroy is idempotent if the secret no longer exists', async () => {
    const send = vi.fn().mockRejectedValueOnce(awsError('ResourceNotFoundException'));
    await expect(
      vaultWith(send).destroy(CTX, { ref: ARN, backend: 'aws-secrets-manager' })
    ).resolves.toBeUndefined();
  });

  it('healthCheck uses ListSecrets (reads no material, no GetSecretValue cost)', async () => {
    const send = vi.fn().mockResolvedValueOnce({ SecretList: [] });
    const h = await vaultWith(send).healthCheck();
    expect(h.healthy).toBe(true);
    expect(send.mock.calls[0][0].input.MaxResults).toBe(1);
  });

  it('healthCheck reports the failure without throwing', async () => {
    const send = vi.fn().mockRejectedValueOnce(awsError('UnrecognizedClientException'));
    const h = await vaultWith(send).healthCheck();
    expect(h.healthy).toBe(false);
    expect(h.detail).toMatch(/UnrecognizedClientException/);
  });
});
