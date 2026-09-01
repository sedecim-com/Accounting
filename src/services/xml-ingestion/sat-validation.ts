import { query } from '../../database/connection.js';
import { consultaCfdi, toValidationStatus } from '../sat/cfdi-status.js';

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
  /**
   * F02: delega en el cliente REAL (src/services/sat/cfdi-status.ts —
   * ConsultaCFDIService, público y anónimo). El stub anterior respondía
   * «Vigente» SIEMPRE en sandbox: un CFDI cancelado se clasificaba vigente
   * y el asiento se planeaba encima. Apagado (SAT_STATUS_MODE=off) ahora
   * significa apagado — un resultado que LO DICE, jamás un vigente falso.
   */
  async validate(
    emisorRfc: string,
    receptorRfc: string,
    total: string,
    uuid: string
  ): Promise<SATValidationResult> {
    try {
      const st = await consultaCfdi({ emisorRfc, receptorRfc, total, uuid });
      if (st.codigoEstatus === 'DISABLED') {
        return {
          uuid, status: 'error', estado: st.estado, esCancelable: '',
          validatedAt: st.consultedAt, rawResponse: { disabled: true },
        };
      }
      return {
        uuid,
        status: toValidationStatus(st.estado),
        estado: st.estado,
        esCancelable: st.esCancelable,
        estatusCancelacion: st.estatusCancelacion ?? undefined,
        validatedAt: st.consultedAt,
        rawResponse: {
          codigoEstatus: st.codigoEstatus,
          validacionEFOS: st.validacionEFOS,
        },
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
