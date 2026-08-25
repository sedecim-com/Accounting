import crypto from 'crypto';
import { integrationRegistry } from '../../base/registry.js';
import type { IPacAdapter, AdapterContext, AdapterHealthCheck } from '../../base/adapter.interface.js';
import { AccountingError } from '../../../../utils/errors.js';

interface FinkokCredentials {
  username: string;
  password: string;
  environment: 'sandbox' | 'production';
}

// ============================================================
// FINKOK PAC ADAPTER
// Primary PAC for CFDI 4.0 stamping.
// Production: https://facturacion.finkok.com/servicios/soap/stamp.wsdl
// Sandbox:    https://demo-facturacion.finkok.com/servicios/soap/stamp.wsdl
// ============================================================

export class FinkokAdapter implements IPacAdapter {
  readonly providerId = 'finkok';
  readonly displayName = 'Finkok';
  readonly regions = ['MX'] as const;

  // Fabrica el UUID y el sello con crypto.randomBytes: no habla con 
  // Finkok. Mientras siga así, el cerrojo impide que su folio se guarde
  // como timbrado real.
  readonly simulado = true;
  readonly category = 'pac' as const;

  async configure(config: FinkokCredentials, ctx: AdapterContext): Promise<void> {
    if (!config.username || !config.password) {
      throw new AccountingError('INVALID_CONFIG', 'Finkok requires username and password');
    }
    await integrationRegistry.saveCredentials(ctx.tenantId, this.providerId, config, {
      userId: ctx.userId,
      isPrimary: true,
      metadata: { environment: config.environment },
    });
  }

  async healthCheck(ctx: AdapterContext): Promise<AdapterHealthCheck> {
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId);
    if (!creds) return { healthy: false, error: 'Credentials not configured' };

    const start = Date.now();
    try {
      // Production: ping SOAP endpoint's ObtenerSaldo method
      // Sandbox: simulate
      if ((creds as unknown as FinkokCredentials).environment === 'sandbox') {
        return { healthy: true, latencyMs: Date.now() - start, metadata: { simulated: true } };
      }
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (error) {
      return { healthy: false, error: (error as Error).message };
    }
  }

  async getConfigInfo(ctx: AdapterContext): Promise<Record<string, unknown>> {
    const info = await integrationRegistry.getCredentialInfo(ctx.tenantId, this.providerId);
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId) as FinkokCredentials | null;
    return {
      configured: !!info,
      status: info?.status,
      environment: creds?.environment,
      username_masked: creds?.username ? creds.username.substring(0, 3) + '***' : null,
      last_sync_at: info?.last_sync_at,
      last_error: info?.last_error,
    };
  }

  async stamp(xml: string, ctx: AdapterContext) {
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId) as FinkokCredentials | null;
    if (!creds) throw new AccountingError('NOT_CONFIGURED', 'Finkok not configured for tenant');

    // Production: SOAP call to /servicios/soap/stamp.wsdl → stamp method
    // Parse response → extract UUID, sello SAT, no_certificado_sat
    //
    // Sandbox implementation:
    const uuid = this.generateSandboxUuid();
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
      RfcProvCertif="FINK1506162M2"
      SelloCFD="..."
      NoCertificadoSAT="00001000000500000000"
      SelloSAT="${selloSat}" />
  </cfdi:Complemento>
</cfdi:Comprobante>`);

      await integrationRegistry.recordSuccess(ctx.tenantId, this.providerId);

      return {
        uuid,
        xml_timbrado,
        cadena_original: `||1.1|${uuid}|${now.toISOString()}|FINK1506162M2|...|00001000000500000000||`,
        fecha_timbrado: now,
        no_certificado_sat: '00001000000500000000',
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
  }, ctx: AdapterContext) {
    const creds = await integrationRegistry.loadCredentials(ctx.tenantId, this.providerId) as FinkokCredentials | null;
    if (!creds) throw new AccountingError('NOT_CONFIGURED', 'Finkok not configured');

    // Production: SOAP cancel method with signed cancellation XML
    return {
      status: 'cancelled',
      acuse_xml: `<?xml version="1.0"?><Acuse Fecha="${new Date().toISOString()}" RfcEmisor="${params.rfcEmisor}">
  <Folios><UUID>${params.uuid}</UUID><EstatusUUID>201</EstatusUUID></Folios>
</Acuse>`,
    };
  }

  async getRemainingStamps(_ctx: AdapterContext): Promise<number> {
    // Production: call ObtenerSaldo SOAP method
    return 10000; // Sandbox default
  }

  private generateSandboxUuid(): string {
    const bytes = crypto.randomBytes(16);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // v4
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex').toUpperCase();
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }
}

export const finkokAdapter = new FinkokAdapter();
