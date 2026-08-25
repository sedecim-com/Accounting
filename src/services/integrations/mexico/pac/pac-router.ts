import { query } from '../../../../database/connection.js';
import { circuitBreaker, CircuitBreakerOpenError } from '../../base/circuit-breaker.js';
import { integrationRegistry } from '../../base/registry.js';
import type { IPacAdapter, AdapterContext } from '../../base/adapter.interface.js';
import { AccountingError } from '../../../../utils/errors.js';
import { cfdiStampOutcomes } from '../../../../api/rest/middleware/metrics.js';
import { assertPuedeTimbrar } from './simulacion.js';
import { finkokAdapter } from './finkok-adapter.js';
import { swSapienAdapter } from './sw-sapien-adapter.js';
import { edicomAdapter } from './edicom-adapter.js';

// ============================================================
// MULTI-PAC ROUTER
// Selects a healthy PAC based on tenant preferences and
// circuit breaker state. Auto-failover:
//   primary → secondary → tertiary
// ============================================================

// Register all PAC adapters
integrationRegistry.register(finkokAdapter);
integrationRegistry.register(swSapienAdapter);
integrationRegistry.register(edicomAdapter);

const PAC_ADAPTERS: Record<string, IPacAdapter> = {
  finkok: finkokAdapter,
  sw_sapien: swSapienAdapter,
  edicom: edicomAdapter,
};

interface PacPreferences {
  pac_primary: string;
  pac_secondary: string | null;
  pac_tertiary: string | null;
  auto_failover: boolean;
}

export class PacRouter {
  /**
   * Get tenant's PAC preferences (or defaults)
   */
  async getPreferences(tenantId: string): Promise<PacPreferences> {
    const result = await query<PacPreferences>(
      `SELECT pac_primary, pac_secondary, pac_tertiary, auto_failover
       FROM pac_preferences WHERE tenant_id = $1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      return {
        pac_primary: 'finkok',
        pac_secondary: 'sw_sapien',
        pac_tertiary: 'edicom',
        auto_failover: true,
      };
    }
    return result.rows[0];
  }

  /**
   * Save tenant's PAC preferences
   */
  async savePreferences(tenantId: string, prefs: Partial<PacPreferences>): Promise<void> {
    await query(
      `INSERT INTO pac_preferences (tenant_id, pac_primary, pac_secondary, pac_tertiary, auto_failover)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id) DO UPDATE SET
         pac_primary = COALESCE(EXCLUDED.pac_primary, pac_preferences.pac_primary),
         pac_secondary = COALESCE(EXCLUDED.pac_secondary, pac_preferences.pac_secondary),
         pac_tertiary = COALESCE(EXCLUDED.pac_tertiary, pac_preferences.pac_tertiary),
         auto_failover = COALESCE(EXCLUDED.auto_failover, pac_preferences.auto_failover),
         updated_at = NOW()`,
      [
        tenantId,
        prefs.pac_primary || 'finkok',
        prefs.pac_secondary || 'sw_sapien',
        prefs.pac_tertiary || 'edicom',
        prefs.auto_failover ?? true,
      ]
    );
  }

  /**
   * Select the best available PAC for this tenant.
   * Returns the adapter + selected provider ID.
   */
  async selectPac(ctx: AdapterContext): Promise<{ adapter: IPacAdapter; providerId: string }> {
    const prefs = await this.getPreferences(ctx.tenantId);
    const tried: string[] = [];
    const errors: string[] = [];

    const candidates = [prefs.pac_primary, prefs.pac_secondary, prefs.pac_tertiary]
      .filter((x): x is string => !!x);

    for (const providerId of candidates) {
      const adapter = PAC_ADAPTERS[providerId];
      if (!adapter) continue;

      tried.push(providerId);

      // Check circuit breaker
      const canAttempt = await circuitBreaker.canAttempt(ctx.tenantId, providerId);
      if (!canAttempt) {
        errors.push(`${providerId}: circuit open`);
        if (!prefs.auto_failover) break;
        continue;
      }

      // Check if credentials are configured
      const creds = await integrationRegistry.loadCredentials(ctx.tenantId, providerId);
      if (!creds) {
        errors.push(`${providerId}: not configured`);
        if (!prefs.auto_failover) break;
        continue;
      }

      return { adapter, providerId };
    }

    throw new AccountingError(
      'NO_PAC_AVAILABLE',
      `No PAC available. Tried: ${tried.join(', ')}. Errors: ${errors.join('; ')}`
    );
  }

  /**
   * Stamp CFDI via the best available PAC, with automatic failover.
   */
  async stamp(xml: string, ctx: AdapterContext): Promise<{
    uuid: string;
    xml_timbrado: string;
    cadena_original: string;
    fecha_timbrado: Date;
    no_certificado_sat: string;
    sello_sat: string;
    provider_used: string;
    /** true si el folio lo fabricó un adaptador simulado (solo fuera de
     *  producción y con CFDI_PERMITIR_SIMULACION=true). */
    simulado: boolean;
  }> {
    const prefs = await this.getPreferences(ctx.tenantId);
    const candidates = [prefs.pac_primary, prefs.pac_secondary, prefs.pac_tertiary]
      .filter((x): x is string => !!x);

    const errors: Array<{ provider: string; error: string }> = [];

    for (let i = 0; i < candidates.length; i++) {
      const providerId = candidates[i];
      const adapter = PAC_ADAPTERS[providerId];
      if (!adapter) continue;

      // Cerrojo antisimulación: se comprueba ANTES de pedir el timbre, para
      // que un adaptador que fabrica folios no llegue siquiera a producirlo.
      // No entra al failover: si el proveedor es simulado, el problema es de
      // configuración y probar con el siguiente lo esconde.
      assertPuedeTimbrar(providerId, adapter.simulado);

      try {
        const result = await circuitBreaker.execute(ctx.tenantId, providerId, () =>
          adapter.stamp(xml, ctx)
        );
        // Success on the primary → 'success'; success after at least one failure → 'fallback'
        cfdiStampOutcomes.inc({ provider: providerId, outcome: i === 0 ? 'success' : 'fallback' });
        return { ...result, provider_used: providerId, simulado: adapter.simulado };
      } catch (error) {
        if (error instanceof CircuitBreakerOpenError) {
          errors.push({ provider: providerId, error: 'circuit_open' });
          cfdiStampOutcomes.inc({ provider: providerId, outcome: 'circuit_open' });
        } else {
          errors.push({ provider: providerId, error: (error as Error).message });
          cfdiStampOutcomes.inc({ provider: providerId, outcome: 'failure' });
        }
        if (!prefs.auto_failover) throw error;
      }
    }

    throw new AccountingError(
      'ALL_PACS_FAILED',
      `All PACs failed. Errors: ${JSON.stringify(errors)}`,
      { attempts: errors }
    );
  }

  /**
   * Cancel CFDI via the PAC that stamped it (or default).
   */
  async cancel(
    pacProvider: string,
    params: {
      uuid: string;
      rfcEmisor: string;
      reason: '01' | '02' | '03' | '04';
      replacementUuid?: string;
    },
    ctx: AdapterContext
  ): Promise<{ status: string; acuse_xml: string }> {
    const adapter = PAC_ADAPTERS[pacProvider];
    if (!adapter) {
      throw new AccountingError('PAC_NOT_FOUND', `Unknown PAC provider: ${pacProvider}`);
    }

    return circuitBreaker.execute(ctx.tenantId, pacProvider, () => adapter.cancel(params, ctx));
  }

  /**
   * Get health status for all PACs
   */
  async getAllHealth(ctx: AdapterContext): Promise<Array<{
    providerId: string;
    health: { healthy: boolean; latencyMs?: number; error?: string };
    configured: boolean;
  }>> {
    const results = [];
    for (const [providerId, adapter] of Object.entries(PAC_ADAPTERS)) {
      const info = await integrationRegistry.getCredentialInfo(ctx.tenantId, providerId);
      const health = await adapter.healthCheck(ctx);
      results.push({ providerId, health, configured: !!info });
    }
    return results;
  }
}

export const pacRouter = new PacRouter();
