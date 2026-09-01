import { query } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';
import { PreRegistrationService } from './pre-registration-service.js';

// ============================================================
// F02 · REP-2 — lo que espera un REP, y el reproceso que no existía
//
// Dos poblaciones distintas que el cierre necesita ver juntas:
//
//   · PAGOS SIN REP — dinero que ya se movió sobre una factura PPD y
//     cuyo comprobante de pago no ha llegado (recibido: el IVA sigue
//     aparcado en 1135 y NO es acreditable) o no se ha emitido
//     (emitido: obligación fiscal PROPIA, con plazo). El método de
//     pago sale del ESPEJO; cuando el CFDI propio no está espejado el
//     método es desconocido y se lista CON esa marca — listar de más
//     con la duda dicha es mejor que esconder un REP exigible.
//
//   · REPs APARCADOS — comprobantes P que llegaron y quedaron en
//     needs_review porque la ligadura pidió decisión humana. El propio
//     código lo decía: «nada lo reintenta solo». Desde F02,
//     reprocesarREPsAparcados los reintenta: contestada la política o
//     ingerida la factura que faltaba, el reproceso es seguro — la
//     idempotencia de la 036 salta lo ya resuelto.
// ============================================================

export interface PagoSinRep {
  payment_number: string;
  payment_date: string;
  contraparte: string;
  amount: string;
  /** 'PPD' | 'PUE' | 'desconocido' — del espejo; desconocido cuando el CFDI no está espejado. */
  metodo: string;
  edad_dias: number;
}

export async function listPagosSinRep(
  entityId: string,
  opts: { direction: 'received' | 'issued'; overdueOnly?: boolean; minAmount?: number; limit?: number } = { direction: 'received' }
): Promise<PagoSinRep[]> {
  if (!['received', 'issued'].includes(opts.direction)) {
    throw new ValidationError(`--direction ilegible "${opts.direction}": received o issued.`);
  }
  const limit = opts.limit ?? 200;

  if (opts.direction === 'received') {
    const r = await query<PagoSinRep>(
      `SELECT vp.payment_number, vp.payment_date::text AS payment_date,
              v.company_name AS contraparte, vp.payment_amount::text AS amount,
              COALESCE(MAX(xd.metodo_pago), 'desconocido') AS metodo,
              FLOOR(EXTRACT(EPOCH FROM (NOW() - vp.payment_date)) / 86400)::int AS edad_dias
         FROM vendor_payments vp
         JOIN vendors v ON v.id = vp.vendor_id
         JOIN payment_applications pa ON pa.payment_id = vp.id
         JOIN bills b ON b.id = pa.bill_id
         LEFT JOIN xml_documents xd
           ON xd.entity_id = vp.entity_id AND xd.cfdi_uuid = b.cfdi_uuid
        WHERE vp.entity_id = $1 AND vp.cfdi_uuid IS NULL AND vp.status <> 'void'
        GROUP BY vp.id, v.company_name
       HAVING COALESCE(MAX(xd.metodo_pago), 'PPD') <> 'PUE'
          AND vp.payment_amount >= $2
        ORDER BY vp.payment_date
        LIMIT $3`,
      [entityId, opts.minAmount ?? 0, limit]
    );
    return r.rows;
  }

  const r = await query<PagoSinRep>(
    `SELECT cp.payment_number, cp.payment_date::text AS payment_date,
            c.company_name AS contraparte, cp.payment_amount::text AS amount,
            COALESCE(MAX(xd.metodo_pago), 'desconocido') AS metodo,
            FLOOR(EXTRACT(EPOCH FROM (NOW() - cp.payment_date)) / 86400)::int AS edad_dias
       FROM customer_payments cp
       JOIN customers c ON c.id = cp.customer_id
       JOIN payment_allocations pal ON pal.payment_id = cp.id
       JOIN invoices inv ON inv.id = pal.invoice_id
       LEFT JOIN xml_documents xd
         ON xd.entity_id = cp.entity_id AND xd.cfdi_uuid = inv.cfdi_uuid
      WHERE cp.entity_id = $1 AND cp.cfdi_uuid IS NULL AND cp.status <> 'void'
        AND inv.cfdi_uuid IS NOT NULL
      GROUP BY cp.id, c.company_name
     HAVING COALESCE(MAX(xd.metodo_pago), 'PPD') <> 'PUE'
        AND cp.payment_amount >= $2
      ORDER BY cp.payment_date
      LIMIT $3`,
    [entityId, opts.minAmount ?? 0, limit]
  );
  return r.rows;
}

export interface RepAparcado {
  id: string;
  external_reference: string | null;
  document_date: string;
  total_amount: string;
  error_message: string | null;
}

export async function listRepAparcados(entityId: string, limit = 100): Promise<RepAparcado[]> {
  const r = await query<RepAparcado>(
    `SELECT id, external_reference, document_date::text AS document_date,
            total_amount::text AS total_amount, error_message
       FROM pre_registrations
      WHERE entity_id = $1 AND document_type = 'payment'
        AND validation_status = 'needs_review'
        AND status NOT IN ('completed', 'rejected', 'duplicate')
      ORDER BY document_date
      LIMIT $2`,
    [entityId, limit]
  );
  return r.rows;
}

export interface ResultadoReproceso {
  reprocesados: number;
  ligados: number;
  siguen_aparcados: number;
  errores: number;
  detalles: Array<{ id: string; resultado: 'ligado' | 'aparcado' | 'error'; motivo?: string }>;
}

/**
 * Reintenta los REP en needs_review. Idempotente de punta a punta: los nodos
 * de pago ya resueltos los salta el índice de la 036, y un REP que vuelve a
 * pedir decisión simplemente se queda aparcado con su motivo fresco.
 */
export async function reprocesarREPsAparcados(
  entityId: string,
  userId: string,
  opts: { limit?: number; service?: PreRegistrationService } = {}
): Promise<ResultadoReproceso> {
  const service = opts.service ?? new PreRegistrationService();
  const aparcados = await listRepAparcados(entityId, opts.limit ?? 50);
  const resultado: ResultadoReproceso = {
    reprocesados: 0, ligados: 0, siguen_aparcados: 0, errores: 0, detalles: [],
  };
  for (const rep of aparcados) {
    resultado.reprocesados += 1;
    const fila = await query(`SELECT * FROM pre_registrations WHERE id = $1`, [rep.id]);
    try {
      await service.processToAccounting(fila.rows[0], userId);
      resultado.ligados += 1;
      resultado.detalles.push({ id: rep.id, resultado: 'ligado' });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'CFDI_REQUIERE_DECISION') {
        resultado.siguen_aparcados += 1;
        resultado.detalles.push({ id: rep.id, resultado: 'aparcado', motivo: (err as Error).message });
      } else {
        resultado.errores += 1;
        resultado.detalles.push({ id: rep.id, resultado: 'error', motivo: (err as Error).message });
      }
    }
  }
  return resultado;
}
