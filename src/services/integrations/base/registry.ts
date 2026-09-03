import { query } from '../../../database/connection.js';
import { encrypt, decrypt } from '../../../utils/encryption.js';
import type { IIntegrationAdapter } from './adapter.interface.js';
import { AccountingError } from '../../../utils/errors.js';

// ============================================================
// INTEGRATION REGISTRY
// Central singleton that holds all registered adapters and
// provides credential management via encrypted storage.
// ============================================================

export class IntegrationRegistry {
  private adapters = new Map<string, IIntegrationAdapter>();

  register(adapter: IIntegrationAdapter): void {
    // Idempotent — silently skip duplicate registrations (happens with dynamic imports / HMR)
    if (this.adapters.has(adapter.providerId)) return;
    this.adapters.set(adapter.providerId, adapter);
  }

  get(providerId: string): IIntegrationAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new AccountingError('PROVIDER_NOT_FOUND', `Provider ${providerId} not registered`);
    }
    return adapter;
  }

  getByCategory(category: string): IIntegrationAdapter[] {
    return Array.from(this.adapters.values()).filter((a) => a.category === category);
  }

  getByRegion(region: string): IIntegrationAdapter[] {
    return Array.from(this.adapters.values()).filter((a) =>
      a.regions.includes(region as 'MX' | 'USA' | 'LATAM' | 'EU' | 'GLOBAL')
    );
  }

  list(): IIntegrationAdapter[] {
    return Array.from(this.adapters.values());
  }

  // ============================================================
  // CREDENTIAL MANAGEMENT (encrypted storage)
  // ============================================================

  async saveCredentials(
    tenantId: string,
    provider: string,
    credentials: Record<string, unknown> | object,
    options: {
      providerAccountId?: string;
      scopes?: string[];
      expiresAt?: Date;
      refreshToken?: string;
      priority?: number;
      isPrimary?: boolean;
      metadata?: Record<string, unknown>;
      userId?: string;
    } = {}
  ): Promise<string> {
    const encrypted = encrypt(JSON.stringify(credentials));
    const refreshEncrypted = options.refreshToken ? encrypt(options.refreshToken) : null;

    const result = await query<{ id: string }>(
      `INSERT INTO integration_credentials (
        tenant_id, provider, provider_account_id,
        credentials_encrypted, scopes, expires_at,
        refresh_token_encrypted, priority, is_primary,
        metadata, status, created_by
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, 'active', $11)
      ON CONFLICT (tenant_id, provider, provider_account_id) DO UPDATE SET
        credentials_encrypted = EXCLUDED.credentials_encrypted,
        scopes = EXCLUDED.scopes,
        expires_at = EXCLUDED.expires_at,
        refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
        priority = EXCLUDED.priority,
        is_primary = EXCLUDED.is_primary,
        metadata = EXCLUDED.metadata,
        status = 'active',
        updated_at = NOW()
      RETURNING id`,
      [
        tenantId, provider, options.providerAccountId || '',
        encrypted, JSON.stringify(options.scopes || []), options.expiresAt || null,
        refreshEncrypted, options.priority ?? 100, options.isPrimary ?? false,
        JSON.stringify(options.metadata || {}), options.userId || null,
      ]
    );

    return result.rows[0].id;
  }

  async loadCredentials(tenantId: string, provider: string): Promise<Record<string, unknown> | null> {
    const result = await query<{ credentials_encrypted: string; expires_at: Date | null }>(
      `SELECT credentials_encrypted, expires_at FROM integration_credentials
       WHERE tenant_id = $1 AND provider = $2 AND status = 'active'
       ORDER BY priority ASC, is_primary DESC LIMIT 1`,
      [tenantId, provider]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    if (row.expires_at && new Date() > new Date(row.expires_at)) {
      return null; // Expired credentials
    }

    return JSON.parse(decrypt(row.credentials_encrypted)) as Record<string, unknown>;
  }

  async getCredentialInfo(tenantId: string, provider: string): Promise<{
    status: string;
    last_sync_at: Date | null;
    last_error: string | null;
    scopes: string[];
    expires_at: Date | null;
    is_primary: boolean;
    priority: number;
  } | null> {
    const result = await query<{
      status: string;
      last_sync_at: Date | null;
      last_error: string | null;
      scopes: unknown;
      expires_at: Date | null;
      is_primary: boolean;
      priority: number;
    }>(
      `SELECT status, last_sync_at, last_error, scopes, expires_at, is_primary, priority
       FROM integration_credentials
       WHERE tenant_id = $1 AND provider = $2
       ORDER BY priority ASC LIMIT 1`,
      [tenantId, provider]
    );

    if (result.rows.length === 0) return null;

    const r = result.rows[0];
    return {
      status: r.status,
      last_sync_at: r.last_sync_at,
      last_error: r.last_error,
      scopes: Array.isArray(r.scopes) ? (r.scopes as string[]) : [],
      expires_at: r.expires_at,
      is_primary: r.is_primary,
      priority: r.priority,
    };
  }

  async recordSuccess(tenantId: string, provider: string): Promise<void> {
    await query(
      `UPDATE integration_credentials SET
        last_sync_at = NOW(), last_success_at = NOW(),
        consecutive_failures = 0, last_error = NULL
       WHERE tenant_id = $1 AND provider = $2`,
      [tenantId, provider]
    );
  }

  async recordFailure(tenantId: string, provider: string, error: string): Promise<void> {
    await query(
      `UPDATE integration_credentials SET
        last_error = $3, last_error_at = NOW(),
        consecutive_failures = consecutive_failures + 1
       WHERE tenant_id = $1 AND provider = $2`,
      [tenantId, provider, error]
    );
  }

  /**
   * Apaga la integración. Devuelve `false` cuando no había ninguna que
   * apagar para ese inquilino y proveedor.
   *
   * Devolvía `void`, y ahí estaba el defecto: un UPDATE que no encontraba
   * fila terminaba igual de bien que uno que sí, y DELETE
   * /v1/admin/integrations/:provider contestaba 204 «hecho». Quien
   * escribía mal el nombre del proveedor —o desconectaba uno que nunca
   * estuvo conectado— se quedaba creyendo que había cortado el acceso de
   * un tercero a sus credenciales. Es la peor dirección en la que puede
   * mentir un apagado.
   */
  async deactivate(tenantId: string, provider: string): Promise<boolean> {
    const r = await query(
      `UPDATE integration_credentials SET status = 'inactive', updated_at = NOW()
       WHERE tenant_id = $1 AND provider = $2`,
      [tenantId, provider]
    );
    return (r.rowCount ?? 0) > 0;
  }
}

export const integrationRegistry = new IntegrationRegistry();
