import { query } from '../../../../database/connection.js';
import { circuitBreaker, CircuitBreakerOpenError } from '../../base/circuit-breaker.js';
import { integrationRegistry } from '../../base/registry.js';
import type { IPacAdapter, AdapterContext } from '../../base/adapter.interface.js';
import { AccountingError } from '../../../../utils/errors.js';
import { cfdiStampOutcomes } from '../../../../api/rest/middleware/metrics.js';
import { assertPuedeTimbrar } from './simulacion.js';
import { finkokAdapter } from './finkok-adapter.js';
import { sovosReachcoreAdapter } from './sovos-reachcore-adapter.js';
import { swSapienAdapter } from './sw-sapien-adapter.js';
import { edicomAdapter } from './edicom-adapter.js';

// ============================================================
// MULTI-PAC ROUTER
// Selects a healthy PAC based on tenant preferences and
// circuit breaker state. Auto-failover:
//   primary → secondary → tertiary
// ============================================================

/**
 * Los PAC que el enrutador puede elegir. Se EXPORTA para que una prueba pueda
 * cotejarlo contra el registry: la divergencia entre esta lista y la de
 * registro vivió meses precisamente porque nada podía compararlas.
 */
export const PAC_ADAPTERS: Record<string, IPacAdapter> = {
  sovos_reachcore: sovosReachcoreAdapter,
  finkok: finkokAdapter,
  sw_sapien: swSapienAdapter,
  edicom: edicomAdapter,
};

// EL ENRUTADOR Y EL REGISTRY SE ALIMENTAN DE LA MISMA LISTA, Y POR ESO.
//
// Eran dos listas escritas a mano y divergieron: `sovos_reachcore` estaba en
// el diccionario de arriba —enrutable, con failover y con cerrojo— y NO en el
// registry, que es de donde salen `GET /v1/admin/integrations` y el
// `registry.get(:provider)` de las cuatro rutas de administración. El efecto
// medido: `PUT /v1/admin/integrations/sovos_reachcore` moría en
// PROVIDER_NOT_FOUND, así que el ÚNICO adaptador que no fabrica el folio
// (`simulado = false`) era el único que no se podía dar de alta por la API, y
// el listado enseñaba tres PACs, los tres simuladores.
//
// Recorrer el diccionario en vez de repetir sus llaves no es economía de
// líneas: es que un adaptador nuevo ya no puede quedarse a medio cablear.
for (const adaptador of Object.values(PAC_ADAPTERS)) {
  integrationRegistry.register(adaptador);
}

/**
 * Default failover order for a tenant with no saved preferences. Evidence-based
 * (docs/pac-proveedores.md): SW Sapien first (pre-sealed XML + customId that
 * dedupes retries), Prodigia second (cfdiPorUUID recovers a lost stamp),
 * Solucion Factible as reserve, Finkok last. Ids with no registered adapter yet
 * (prodigia, solucion_factible) are skipped by the router until their adapters
 * land (MNE-001-311/312).
 */
export const DEFAULT_PAC_ORDER: readonly string[] = [
  'sw_sapien',
  'prodigia',
  'solucion_factible',
  'finkok',
];

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
    return (await this.resolvePreferences(tenantId)).prefs;
  }

  /** Preferences plus the full ordered candidate list (the default order has four entries, the table three columns). */
  private async resolvePreferences(
    tenantId: string
  ): Promise<{ prefs: PacPreferences; order: string[] }> {
    const result = await query<PacPreferences>(
      `SELECT pac_primary, pac_secondary, pac_tertiary, auto_failover
       FROM pac_preferences WHERE tenant_id = $1`,
      [tenantId]
    );

    if (result.rows.length === 0) {
      return {
        prefs: {
          pac_primary: DEFAULT_PAC_ORDER[0],
          pac_secondary: DEFAULT_PAC_ORDER[1],
          pac_tertiary: DEFAULT_PAC_ORDER[2],
          auto_failover: true,
        },
        order: [...DEFAULT_PAC_ORDER],
      };
    }
    const prefs = result.rows[0];
    return {
      prefs,
      order: [prefs.pac_primary, prefs.pac_secondary, prefs.pac_tertiary].filter(
        (x): x is string => !!x
      ),
    };
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
        prefs.pac_primary || DEFAULT_PAC_ORDER[0],
        prefs.pac_secondary || DEFAULT_PAC_ORDER[1],
        prefs.pac_tertiary || DEFAULT_PAC_ORDER[2],
        prefs.auto_failover ?? true,
      ]
    );
  }

  /**
   * Select the best available PAC for this tenant.
   * Returns the adapter + selected provider ID.
   */
  async selectPac(ctx: AdapterContext): Promise<{ adapter: IPacAdapter; providerId: string }> {
    const { prefs, order: candidates } = await this.resolvePreferences(ctx.tenantId);
    const tried: string[] = [];
    const errors: string[] = [];
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
    const { prefs, order: candidates } = await this.resolvePreferences(ctx.tenantId);
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
        // NO SE HACE FAILOVER DE UN «YA TIMBRADO».
        //
        // Un PAC que responde «el hash de esta cadena original ya fue
        // timbrado» está diciendo que el comprobante EXISTE ante el SAT. Si
        // ante eso se prueba con el siguiente proveedor, ese sí lo timbra: el
        // mismo documento acaba con DOS folios fiscales, y el segundo no se
        // puede cancelar sin que el primero quede huérfano. El failover
        // existe para un PAC caído, no para uno que contesta que el trabajo
        // ya está hecho — y esa respuesta es idéntica en todos los
        // proveedores, no una peculiaridad de uno.
        if ((error as { code?: string }).code === 'PAC_YA_TIMBRADO') {
          cfdiStampOutcomes.inc({ provider: providerId, outcome: 'already_stamped' });
          throw error;
        }
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

    // El mismo cerrojo que `stamp`, por la misma razón y con más motivo: una
    // cancelación simulada deja una factura que el mayor cree cancelada y el
    // SAT sigue considerando vigente. Cancelar es irreversible ante el SAT,
    // así que un acuse fabricado es peor que un timbre fabricado.
    assertPuedeTimbrar(pacProvider, adapter.simulado);

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
