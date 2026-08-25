import dotenv from 'dotenv';

dotenv.config();

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
    secret: process.env.JWT_SECRET || 'dev-secret-change-me',
    accessExpiration: process.env.JWT_ACCESS_EXPIRATION || '1h',
    refreshExpiration: process.env.JWT_REFRESH_EXPIRATION || '30d',
  },

  encryption: {
    key: process.env.ENCRYPTION_KEY || '0'.repeat(64),
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
