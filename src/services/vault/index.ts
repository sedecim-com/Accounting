import { AwsSecretsManagerVault } from './aws-secrets-manager.js';
import { LocalDevVault } from './local-dev.js';
import { SecretVaultError, type SecretVault } from './types.js';

export * from './types.js';
export { AwsSecretsManagerVault } from './aws-secrets-manager.js';
export { LocalDevVault } from './local-dev.js';

// ============================================================
// VAULT FACTORY
// Backend via env var, so the same code runs in dev (without
// AWS) and in production (Secrets Manager) without conditionals
// scattered through the code.
//   VAULT_BACKEND=aws-secrets-manager | local-dev
//   AWS_REGION, VAULT_PREFIX, VAULT_KMS_KEY_ID
// ============================================================

let cached: SecretVault | null = null;

export function getVault(): SecretVault {
  if (cached) return cached;
  cached = buildVault();
  return cached;
}

/** For tests only: injects a vault and clears the cache. */
export function setVaultForTesting(vault: SecretVault | null): void {
  cached = vault;
}

function buildVault(): SecretVault {
  const backend = process.env.VAULT_BACKEND || (process.env.NODE_ENV === 'production' ? '' : 'local-dev');

  switch (backend) {
    case 'aws-secrets-manager': {
      const region = process.env.AWS_REGION;
      if (!region) {
        throw new SecretVaultError('VAULT_BACKEND=aws-secrets-manager requires AWS_REGION');
      }
      const prefix = process.env.VAULT_PREFIX || `mnemosine/${process.env.NODE_ENV || 'development'}`;
      return new AwsSecretsManagerVault({
        region,
        prefix,
        kmsKeyId: process.env.VAULT_KMS_KEY_ID,
      });
    }
    case 'local-dev':
      return new LocalDevVault({ dir: process.env.VAULT_DIR });
    case '':
      throw new SecretVaultError(
        'VAULT_BACKEND is not configured and NODE_ENV=production: ' +
          'set VAULT_BACKEND=aws-secrets-manager (the local vault is not valid in production).'
      );
    default:
      throw new SecretVaultError(`Unknown VAULT_BACKEND: "${backend}"`);
  }
}
