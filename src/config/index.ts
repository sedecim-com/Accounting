import dotenv from 'dotenv';

dotenv.config();

// ============================================================
// DEVELOPMENT DEFAULTS FOR SECRETS
//
// Named, so the production check below can recognise them by
// identity instead of by a string literal repeated in two places
// that drift apart.
// ============================================================

/** Signs and verifies every access token when JWT_SECRET is unset. */
const DEV_JWT_SECRET = 'dev-secret-change-me';

/** AES key when ENCRYPTION_KEY is unset: 32 bytes of zeros. */
const DEV_ENCRYPTION_KEY = '0'.repeat(64);

/**
 * Every JWT secret this repository publishes, not just the one the code falls
 * back to. docker/docker-compose.yml:15 hands the container
 * 'dev-secret-change-in-production' — a different string, equally readable by
 * anyone with a clone, and therefore equally able to forge a token for any
 * tenant. A gate that only recognised the code default would let a compose
 * file flipped to NODE_ENV=production start with a published secret and
 * report itself checked.
 *
 * Add to this set, never subtract: a secret that has been in the repository
 * is burned whether or not it is still the default.
 */
const PUBLISHED_JWT_SECRETS = new Set<string>([
  DEV_JWT_SECRET,
  'dev-secret-change-in-production',
]);

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  apiVersion: process.env.API_VERSION || 'v1',
  appName: process.env.APP_NAME || 'accounting-core',

  database: {
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/accounting_core',
    // Migrations need DDL; the app does not. They connect as distinct roles
    // (mnemosine_owner vs mnemosine_app) so that FORCE ROW LEVEL SECURITY
    // takes effect on the app. If undefined, it falls back to DATABASE_URL,
    // which is the usual behavior in development.
    migrationUrl:
      process.env.MIGRATION_DATABASE_URL ||
      process.env.DATABASE_URL ||
      'postgresql://postgres:postgres@localhost:5432/accounting_core',
    poolMin: parseInt(process.env.DATABASE_POOL_MIN || '5', 10),
    poolMax: parseInt(process.env.DATABASE_POOL_MAX || '20', 10),

    // Preset del proveedor: solo aporta los defaults y las advertencias
    // (ver src/database/providers.ts). La cadena de conexión sigue siendo tuya.
    provider: process.env.DATABASE_PROVIDER || '',

    // TLS. Sin valor explícito se infiere: disable en local, verify-full fuera.
    // `require` cifra pero NO verifica nada; no lo uses en producción.
    sslMode: process.env.DATABASE_SSL_MODE || '',
    // Ruta a un .pem o el PEM en línea. Sin esto, verify-full usa el almacén
    // de confianza del sistema (suficiente para Neon, Supabase o Crunchy;
    // RDS y Cloud SQL necesitan su bundle).
    sslCa: process.env.DATABASE_SSL_CA || '',

    // Túnel SSH hacia una base autoalojada. Con esto, el 5432 del VPS no se
    // expone a internet: la app conecta a localhost y quien autentica es tu
    // llave SSH.
    tunnel: process.env.DATABASE_SSH_HOST
      ? {
          target: process.env.DATABASE_SSH_HOST,
          remoteHost: process.env.DATABASE_SSH_REMOTE_HOST || 'localhost',
          remotePort: parseInt(process.env.DATABASE_SSH_REMOTE_PORT || '5432', 10),
          sshPort: process.env.DATABASE_SSH_PORT
            ? parseInt(process.env.DATABASE_SSH_PORT, 10)
            : undefined,
          identity: process.env.DATABASE_SSH_KEY || undefined,
        }
      : undefined,
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  // Authentication with an external provider. The issuer is enough: the rest
  // is read from /.well-known/openid-configuration, so the same block works
  // for Google Workspace, Entra ID, Okta, Auth0, Keycloak, Zitadel or Cognito.
  auth: {
    issuer: process.env.AUTH_OIDC_ISSUER || '',
    clientId: process.env.AUTH_OIDC_CLIENT_ID || '',
    audience: process.env.AUTH_OIDC_AUDIENCE || '',
    provider: process.env.AUTH_OIDC_PROVIDER || 'oidc',
    // Which tenant whoever comes in through this issuer belongs to. NOT
    // decided by the token: it is deployment configuration.
    tenantId: process.env.AUTH_OIDC_TENANT_ID || '',
    get enabled(): boolean {
      return Boolean(this.issuer && this.audience);
    },
  },

  jwt: {
    // Development default. Refused in production by assertProductionSecrets()
    // at the bottom of this file — see the note there.
    secret: process.env.JWT_SECRET || DEV_JWT_SECRET,
    accessExpiration: process.env.JWT_ACCESS_EXPIRATION || '1h',
    refreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '30d',
  },

  encryption: {
    // Development default: a 32-byte key of zeros. Same treatment.
    key: process.env.ENCRYPTION_KEY || DEV_ENCRYPTION_KEY,
  },

  aws: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
    region: process.env.AWS_REGION || 'us-east-1',
    s3Bucket: process.env.S3_BUCKET || 'accounting-core-documents',
  },

  elasticsearch: {
    url: process.env.ELASTICSEARCH_URL || 'http://localhost:9200',
  },

  pac: {
    provider: process.env.PAC_PROVIDER || 'finkok',
    username: process.env.PAC_USERNAME || '',
    password: process.env.PAC_PASSWORD || '',
    environment: process.env.PAC_ENVIRONMENT || 'sandbox',
  },

  plaid: {
    clientId: process.env.PLAID_CLIENT_ID || '',
    secret: process.env.PLAID_SECRET || '',
    env: process.env.PLAID_ENV || 'sandbox',
  },

  webhooks: {
    maxRetries: parseInt(process.env.WEBHOOK_MAX_RETRIES || '5', 10),
    retryInterval: parseInt(process.env.WEBHOOK_RETRY_INTERVAL || '60', 10),
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '3600000', 10),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || '1000', 10),
  },
} as const;

// ============================================================
// PRODUCTION SECRET CHECK
//
// A development default that survives into production is not a
// weak secret — it is a PUBLISHED one. 'dev-secret-change-me' is
// in this repository, so anyone holding a copy can mint an access
// token for any tenant and any role; and a 32-byte encryption key
// of zeros means the vendor bank accounts, CLABEs and fiscal
// credentials in the database are stored in something that looks
// like ciphertext and is not.
//
// Both defaults are correct in development and in the test suite,
// which is exactly why they are dangerous: nothing ever fails,
// nothing ever warns, and the first signal is a breach. So the
// process refuses to start under NODE_ENV=production while either
// is still in place. Loud, at import time, before a single request
// is served — the same posture the vault takes in
// services/vault/index.ts.
//
// Deliberately NOT a warning. A warning in a log nobody reads is
// how this class of defect reaches production in the first place.
//
// It fires on IMPORT, not on server start, so it also catches the
// CLI and the migration runner — an operator running `mnemosine`
// against production with no ENCRYPTION_KEY is writing the same
// unprotected rows the API would.
// ============================================================

/**
 * The complaints against a given (env, secret, key) triple. Pure and
 * exported so the rule can be tested for every combination without
 * reloading this module — the module reads real process.env exactly
 * once, and a test that has to fake that is a test nobody trusts.
 *
 * Empty array means "nothing to say", which for a non-production env
 * is always the answer: the defaults are the point in development.
 */
export function insecureProductionSecrets(
  env: string,
  jwtSecret: string,
  encryptionKey: string
): string[] {
  if (env !== 'production') return [];

  const problems: string[] = [];
  if (PUBLISHED_JWT_SECRETS.has(jwtSecret)) {
    problems.push(
      'JWT_SECRET is a value committed to this repository — the code default, or the one ' +
        'docker/docker-compose.yml passes the container. Anyone with the source can forge a token ' +
        'for any tenant. Set it to a random value of at least 32 bytes.'
    );
  }
  if (encryptionKey === DEV_ENCRYPTION_KEY) {
    problems.push(
      'ENCRYPTION_KEY is 32 bytes of zeros. Bank accounts, CLABEs and fiscal credentials would be ' +
        'written to the database effectively in the clear. Set it to 64 hex characters ' +
        '(`openssl rand -hex 32`). Changing it later makes existing ciphertext unreadable, so set ' +
        'it before the first write.'
    );
  }
  return problems;
}

const secretProblems = insecureProductionSecrets(
  config.env,
  config.jwt.secret,
  config.encryption.key
);
if (secretProblems.length > 0) {
  throw new Error(
    `Refusing to start with NODE_ENV=production and development secrets:\n  - ${secretProblems.join('\n  - ')}`
  );
}
