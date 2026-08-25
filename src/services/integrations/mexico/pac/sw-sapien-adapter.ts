import crypto from 'crypto';
import { integrationRegistry } from '../../base/registry.js';
import type { IPacAdapter, AdapterContext, AdapterHealthCheck } from '../../base/adapter.interface.js';
import { AccountingError } from '../../../../utils/errors.js';

interface SWSapienCredentials {
  token: string;       // SW uses Bearer token instead of user/pass
  environment: 'sandbox' | 'production';
}

// ============================================================
// SW SAPIEN PAC ADAPTER
// Secondary PAC — failover #1.
// Production: https://services.sw.com.mx
// Sandbox:    https://services.test.sw.com.mx
// Uses REST API (easier than SOAP).
// ============================================================

export class SWSapienAdapter implements IPacAdapter {
  readonly providerId = 'sw_sapien';
  readonly displayName = 'SW Sapien';
  readonly regions = ['MX'] as const;

  // Fabrica el UUID y el sello con crypto.randomBytes: no habla con 
  // SW sapien. Mientras siga así, el cerrojo impide que su folio se guarde
  // como timbrado real.
  readonly simulado = true;
  readonly category = 'pac' as const;

  async configure(config: SWSapienCredentials, ctx: AdapterContext): Promise<void> {
    if (!config.token) throw new AccountingError('INVALID_CONFIG', 'SW Sapien requires token');
    await integrationRegistry.saveCredentials(ctx.tenantId, this.providerId, config, {
      userId: ctx.userId,
      metadata: { environment: config.environment },
    });
  }

  async healthCheck(ctx: AdapterContext): Promise<AdapterHealthCheck> {
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId);
    if (!creds) return { healthy: false, error: 'Credentials not configured' };

    const start = Date.now();
    try {
      // Production: GET /account/balance
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  async getConfigInfo(ctx: AdapterContext): Promise<Record<string, unknown>> {
    const info = await integrationRegistry.getCredentialInfo(ctx.tenantId, this.providerId);
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId) as SWSapienCredentials | null;
    return {
      configured: !!info,
      status: info?.status,
      environment: creds?.environment,
      token_masked: creds?.token ? '***' + creds.token.slice(-4) : null,
      last_sync_at: info?.last_sync_at,
    };
  }

  async stamp(xml: string, ctx: AdapterContext) {
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId) as SWSapienCredentials | null;
    if (!creds) throw new AccountingError('NOT_CONFIGURED', 'SW Sapien not configured');

    // Production: POST /cfdi33/stamp/v4 with Bearer token and XML in body
    // Response: { data: { uuid, cadenaOriginalSAT, selloSAT, ... } }
    const uuid = crypto.randomUUID().toUpperCase();
    const now = new Date();
    const selloSat = crypto.randomBytes(32).toString('base64');

    try {
      const xml_timbrado = xml.replace('</cfdi:Comprobante>', `
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital
      xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
      Version="1.1"
      UUID="${uuid}"
      FechaTimbrado="${now.toISOString()}"
      RfcProvCertif="SWS130301113"
      SelloCFD="..."
      NoCertificadoSAT="00001000000600000000"
      SelloSAT="${selloSat}" />
  </cfdi:Complemento>
</cfdi:Comprobante>`);

      await integrationRegistry.recordSuccess(ctx.tenantId, this.providerId);

      return {
        uuid,
        xml_timbrado,
        cadena_original: `||1.1|${uuid}|${now.toISOString()}|SWS130301113|...|00001000000600000000||`,
        fecha_timbrado: now,
        no_certificado_sat: '00001000000600000000',
        sello_sat: selloSat,
      };
    } catch (error) {
      await integrationRegistry.recordFailure(ctx.tenantId, this.providerId, (error as Error).message);
      throw error;
    }
  }

  async cancel(params: {
    uuid: string;
    rfcEmisor: string;
    reason: '01' | '02' | '03' | '04';
    replacementUuid?: string;
  }, _ctx: AdapterContext) {
    // Production: POST /cfdi33/cancel/csd
    return {
      status: 'cancelled',
      acuse_xml: `<Acuse UUID="${params.uuid}" EstatusUUID="201" RfcEmisor="${params.rfcEmisor}"/>`,
    };
  }

  async getRemainingStamps(_ctx: AdapterContext): Promise<number> {
    return 10000;
  }
}

export const swSapienAdapter = new SWSapienAdapter();
