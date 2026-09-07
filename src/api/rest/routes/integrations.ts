import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { query } from '../../../database/connection.js';
import { requirePermission } from '../middleware/auth.js';
import { asyncHandler, validateBody } from '../middleware/async-handler.js';
import { NotFoundError } from '../../../utils/errors.js';
import { integrationRegistry, pacRouter } from '../../../services/integrations/index.js';
import type { IIntegrationAdapter } from '../../../services/integrations/base/adapter.interface.js';
import { declararRiesgoRuta } from '../risk.js';

const router = Router();

/**
 * SI EL ADAPTADOR FABRICA EL FOLIO, EL LISTADO TIENE QUE DECIRLO.
 *
 * Tres de los cuatro PACs (`finkok`, `sw_sapien`, `edicom`) inventan el UUID y
 * el sello con `crypto.randomBytes`, y el cerrojo de `simulacion.ts` les
 * prohíbe timbrar. Hasta hoy ninguno se registraba junto al único real, así
 * que el listado enseñaba tres simuladores y punto. Ahora que
 * `sovos_reachcore` también está registrado, los cuatro salen por la misma
 * respuesta con los mismos campos: sin esta bandera, un operador elige un
 * proveedor que no emite nada y sólo se entera al intentar timbrar.
 *
 * `undefined` en lo que no es PAC — `JSON.stringify` no serializa la llave, y
 * un `simulado: false` sobre Stripe afirmaría algo que nadie ha comprobado.
 */
function esSimulado(adapter: IIntegrationAdapter): boolean | undefined {
  return 'simulado' in adapter ? Boolean(adapter.simulado) : undefined;
}

const configureProviderSchema = z.record(z.unknown());

const pacPreferencesSchema = z.object({
  pac_primary: z.string().optional(),
  pac_secondary: z.string().optional(),
  pac_tertiary: z.string().optional(),
  auto_failover: z.boolean().optional(),
});

// ============================================================
// GET /v1/admin/integrations
// List all registered integrations + tenant config status
// ============================================================

router.get('/', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  const adapters = integrationRegistry.list();
  const data = await Promise.all(
    adapters.map(async (adapter) => {
      const info = await integrationRegistry.getCredentialInfo(req.user!.tenant_id, adapter.providerId);
      return {
        providerId: adapter.providerId,
        displayName: adapter.displayName,
        category: adapter.category,
        regions: adapter.regions,
        simulado: esSimulado(adapter),
        configured: !!info,
        status: info?.status || 'not_configured',
        lastSyncAt: info?.last_sync_at,
        lastError: info?.last_error,
      };
    })
  );

  res.json({
    data: {
      total: data.length,
      byCategory: data.reduce((acc: Record<string, number>, a) => {
        acc[a.category] = (acc[a.category] || 0) + 1;
        return acc;
      }, {}),
      configured: data.filter((a) => a.configured).length,
      integrations: data,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// ============================================================
// GET /v1/admin/integrations/:provider
// Get sanitized config info for a specific provider
// ============================================================

router.get('/:provider', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  const adapter = integrationRegistry.get(req.params.provider);
  const info = await adapter.getConfigInfo({ tenantId: req.user!.tenant_id, userId: req.user!.user_id });

  res.json({
    data: {
      providerId: adapter.providerId,
      displayName: adapter.displayName,
      category: adapter.category,
      regions: adapter.regions,
      simulado: esSimulado(adapter),
      ...info,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// ============================================================
// PUT /v1/admin/integrations/:provider
// Configure credentials for a provider
// ============================================================

// Mismo criterio que `mnemosine sat add`, declarado `externo`: lo que entra
// aqui son credenciales con las que este sistema hablara por el cliente.
router.put('/:provider', declararRiesgoRuta({ riesgo: 'externo', escribe: 'integration_credentials + el material en la boveda: credenciales del cliente ante un tercero' }), requirePermission('settings:manage'), validateBody(configureProviderSchema), asyncHandler(async (req: Request, res: Response) => {
  const adapter = integrationRegistry.get(req.params.provider);
  const ctx = { tenantId: req.user!.tenant_id, userId: req.user!.user_id };

  await adapter.configure(req.body as never, ctx);

  const info = await adapter.getConfigInfo(ctx);
  res.json({
    data: { providerId: adapter.providerId, configured: true, ...info },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// ============================================================
// POST /v1/admin/integrations/:provider/test
// Test connection to an integration
// ============================================================

router.post('/:provider/test', declararRiesgoRuta({ riesgo: 'externo', escribe: 'nada en la base; ALCANZA al proveedor con la credencial del cliente' }), requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  const adapter = integrationRegistry.get(req.params.provider);
  const health = await adapter.healthCheck({ tenantId: req.user!.tenant_id, userId: req.user!.user_id });

  res.json({
    data: {
      providerId: adapter.providerId,
      ...health,
    },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// ============================================================
// DELETE /v1/admin/integrations/:provider
// Deactivate an integration
// ============================================================

// Un DELETE que no borra: apaga. Por eso es escritura. Si algun dia
// destruye el material —como `sat revoke`— pasa a irreversible.
router.delete('/:provider', declararRiesgoRuta({ riesgo: 'escritura', escribe: 'integration_credentials.status = inactive; NO destruye el material de la boveda' }), requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  // 204 sobre CERO filas era «apagado» sin apagar nada: el proveedor mal
  // escrito, o el que nunca se configuro, contestaban igual que el que si
  // se apago. En un endpoint cuyo acto es cortarle a un tercero el acceso
  // a las credenciales del cliente, ese silencio es el peor posible.
  const apagada = await integrationRegistry.deactivate(req.user!.tenant_id, req.params.provider);
  if (!apagada) throw new NotFoundError('Integration', req.params.provider);
  res.status(204).send();
}));

// ============================================================
// MULTI-PAC SPECIFIC
// ============================================================

// GET /v1/admin/integrations/pac/preferences
router.get('/pac/preferences/all', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  const prefs = await pacRouter.getPreferences(req.user!.tenant_id);
  const health = await pacRouter.getAllHealth({ tenantId: req.user!.tenant_id, userId: req.user!.user_id });

  res.json({
    data: { preferences: prefs, health },
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// PUT /v1/admin/integrations/pac/preferences
router.put('/pac/preferences/all', declararRiesgoRuta({ riesgo: 'escritura', escribe: 'preferencias de enrutado entre PACs' }), requirePermission('settings:manage'), validateBody(pacPreferencesSchema), asyncHandler(async (req: Request, res: Response) => {
  const { pac_primary, pac_secondary, pac_tertiary, auto_failover } = req.body;
  await pacRouter.savePreferences(req.user!.tenant_id, {
    pac_primary, pac_secondary, pac_tertiary, auto_failover,
  });

  const prefs = await pacRouter.getPreferences(req.user!.tenant_id);
  res.json({
    data: prefs,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

// GET /v1/admin/integrations/health/all
// Provider health status across all integrations (circuit breaker state)
router.get('/health/all', requirePermission('settings:manage'), asyncHandler(async (req: Request, res: Response) => {
  const result = await query<{
    provider: string;
    circuit_state: string;
    consecutive_failures: number;
    total_requests: number;
    total_failures: number;
    avg_latency_ms: number | null;
    last_success_at: Date | null;
    last_failure_at: Date | null;
  }>(
    `SELECT provider, circuit_state, consecutive_failures, total_requests,
            total_failures, avg_latency_ms, last_success_at, last_failure_at
     FROM provider_health WHERE tenant_id = $1 ORDER BY provider`,
    [req.user!.tenant_id]
  );

  res.json({
    data: result.rows,
    meta: { request_id: req.headers['x-request-id'], timestamp: new Date().toISOString(), version: 'v1' },
  });
}));

export default router;
