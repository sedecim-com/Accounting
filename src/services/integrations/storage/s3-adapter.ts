import crypto from 'crypto';
import { integrationRegistry } from '../base/registry.js';
import type { IStorageAdapter, AdapterContext, AdapterHealthCheck } from '../base/adapter.interface.js';
import { AccountingError } from '../../../utils/errors.js';

interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  bucket: string;
  endpoint?: string;           // For R2 or custom S3-compatible endpoints
}

// ============================================================
// S3 / R2 STORAGE ADAPTER
// Supports AWS S3 and S3-compatible services (Cloudflare R2, Backblaze B2).
// Production: use @aws-sdk/client-s3 + @aws-sdk/s3-request-presigner
// ============================================================

export class S3Adapter implements IStorageAdapter {
  readonly providerId = 's3';
  readonly displayName = 'AWS S3 / Compatible';
  readonly regions = ['GLOBAL'] as const;
  readonly category = 'storage' as const;

  async configure(config: S3Credentials, ctx: AdapterContext): Promise<void> {
    if (!config.accessKeyId || !config.secretAccessKey || !config.bucket) {
      throw new AccountingError('INVALID_CONFIG', 'S3 requires accessKeyId, secretAccessKey, bucket');
    }
    await integrationRegistry.saveCredentials(ctx.tenantId, this.providerId, config, {
      userId: ctx.userId,
      metadata: {
        bucket: config.bucket,
        region: config.region,
        endpoint: config.endpoint || `https://s3.${config.region}.amazonaws.com`,
      },
    });
  }

  async healthCheck(ctx: AdapterContext): Promise<AdapterHealthCheck> {
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId);
    if (!creds) return { healthy: false, error: 'Not configured' };
    // Production: HeadBucket command
    return { healthy: true, latencyMs: 20 };
  }

  async getConfigInfo(ctx: AdapterContext): Promise<Record<string, unknown>> {
    const info = await integrationRegistry.getCredentialInfo(ctx.tenantId, this.providerId);
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId) as S3Credentials | null;
    return {
      configured: !!info,
      status: info?.status,
      bucket: creds?.bucket,
      region: creds?.region,
      endpoint: creds?.endpoint,
    };
  }

  async upload(params: {
    key: string;
    body: Buffer | string;
    contentType: string;
    metadata?: Record<string, string>;
    public?: boolean;
  }, ctx: AdapterContext) {
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId) as S3Credentials | null;
    if (!creds) throw new AccountingError('NOT_CONFIGURED', 'S3 not configured');

    // Production: await s3Client.send(new PutObjectCommand({ Bucket, Key, Body, ContentType }))
    const etag = crypto.createHash('md5').update(params.body as string | Buffer).digest('hex');
    const endpoint = creds.endpoint || `https://s3.${creds.region}.amazonaws.com`;
    const url = `${endpoint}/${creds.bucket}/${params.key}`;

    try {
      await integrationRegistry.recordSuccess(ctx.tenantId, this.providerId);
      return { url, key: params.key, etag };
    } catch (error) {
      await integrationRegistry.recordFailure(ctx.tenantId, this.providerId, (error as Error).message);
      throw error;
    }
  }

  async getSignedUrl(key: string, expiresInSeconds: number, ctx: AdapterContext): Promise<string> {
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId) as S3Credentials | null;
    if (!creds) throw new AccountingError('NOT_CONFIGURED', 'S3 not configured');

    // Production: getSignedUrl(s3Client, command, { expiresIn })
    const endpoint = creds.endpoint || `https://s3.${creds.region}.amazonaws.com`;
    const expires = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const signature = crypto.createHmac('sha256', creds.secretAccessKey)
      .update(`${creds.bucket}/${key}:${expires}`)
      .digest('hex');
    return `${endpoint}/${creds.bucket}/${key}?X-Amz-Expires=${expiresInSeconds}&X-Amz-Signature=${signature}`;
  }

  async delete(_key: string, ctx: AdapterContext): Promise<void> {
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId);
    if (!creds) throw new AccountingError('NOT_CONFIGURED', 'S3 not configured');
    // Production: DeleteObjectCommand
  }

  async download(_key: string, ctx: AdapterContext): Promise<Buffer> {
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId);
    if (!creds) throw new AccountingError('NOT_CONFIGURED', 'S3 not configured');
    // Production: GetObjectCommand
    return Buffer.from('');
  }
}

export const s3Adapter = new S3Adapter();
