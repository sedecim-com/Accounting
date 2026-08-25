import { query } from '../../database/connection.js';

export interface SATValidationResult {
  uuid: string;
  status: 'valid' | 'cancelled' | 'not_found' | 'error';
  estado: string;
  esCancelable: string;
  estatusCancelacion?: string;
  fechaCancelacion?: Date;
  validatedAt: Date;
  rawResponse?: Record<string, unknown>;
}

/**
 * SAT CFDI Validation Service
 * Validates CFDI status against SAT web services
 * Note: In production, integrates with https://consultaqr.facturaelectronica.sat.gob.mx
 */
export class SATValidationService {
  private readonly WSDL_URL = 'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc?wsdl';

  /**
   * Validate CFDI against SAT (stub for production SOAP integration)
   */
  async validate(
    emisorRfc: string,
    receptorRfc: string,
    total: string,
    uuid: string
  ): Promise<SATValidationResult> {
    try {
      // Production: use soap.createClientAsync(this.WSDL_URL) and call ConsultaAsync
      // Sandbox/dev: return a simulated "valid" response
      if (process.env.PAC_ENVIRONMENT === 'sandbox') {
        return {
          uuid,
          status: 'valid',
          estado: 'Vigente',
          esCancelable: 'Cancelable sin aceptación',
          validatedAt: new Date(),
          rawResponse: { simulated: true },
        };
      }

      // Real SOAP implementation would go here:
      // const soapClient = await soap.createClientAsync(this.WSDL_URL);
      // const expresionImpresa = `?re=${emisorRfc}&rr=${receptorRfc}&tt=${total}&id=${uuid}`;
      // const [result] = await soapClient.ConsultaAsync({ expresionImpresa });

      return {
        uuid,
        status: 'error',
        estado: 'SAT validation not configured',
        esCancelable: '',
        validatedAt: new Date(),
      };
    } catch (error) {
      return {
        uuid,
        status: 'error',
        estado: 'Error',
        esCancelable: '',
        validatedAt: new Date(),
        rawResponse: { error: (error as Error).message },
      };
    }
  }

  async validateBatch(
    cfdis: Array<{
      uuid: string;
      emisorRfc: string;
      receptorRfc: string;
      total: string;
    }>
  ): Promise<SATValidationResult[]> {
    const results: SATValidationResult[] = [];
    const BATCH_SIZE = 10;
    const DELAY_MS = 1000;

    for (let i = 0; i < cfdis.length; i += BATCH_SIZE) {
      const batch = cfdis.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map((c) => this.validate(c.emisorRfc, c.receptorRfc, c.total, c.uuid))
      );
      results.push(...batchResults);

      if (i + BATCH_SIZE < cfdis.length) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
      }
    }

    return results;
  }

  /**
   * Validate and update xml_documents table
   */
  async validateAndUpdate(xmlDocumentId: string): Promise<SATValidationResult | null> {
    const doc = await query<{
      cfdi_uuid: string;
      emisor_rfc: string;
      receptor_rfc: string;
      total: string;
    }>(
      `SELECT cfdi_uuid, emisor_rfc, receptor_rfc, total
       FROM xml_documents WHERE id = $1`,
      [xmlDocumentId]
    );

    if (doc.rows.length === 0) return null;

    const d = doc.rows[0];
    const result = await this.validate(d.emisor_rfc, d.receptor_rfc, d.total, d.cfdi_uuid);

    await query(
      `UPDATE xml_documents SET
        sat_validation_status = $1,
        sat_estado = $2,
        sat_validated_at = NOW(),
        sat_efecto_cancelacion = $3,
        sat_fecha_cancelacion = $4
       WHERE id = $5`,
      [
        result.status,
        result.estado,
        result.estatusCancelacion || null,
        result.fechaCancelacion || null,
        xmlDocumentId,
      ]
    );

    return result;
  }
}
