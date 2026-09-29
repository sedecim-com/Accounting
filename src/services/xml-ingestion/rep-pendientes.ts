import { query } from '../../database/connection.js';
import { ValidationError } from '../../utils/errors.js';
import { PreRegistrationService } from './pre-registration-service.js';
import { listPaymentsAwaitingRep } from '../accounting/rep-expected.js';

// ============================================================
// F02 · REP-2 — lo que espera un REP, y el reproceso que no existía
//
// Dos poblaciones distintas que el cierre necesita ver juntas:
//
//   · PAYMENTS WITHOUT A REP — money that already moved on a PPD
//     document whose payment receipt has not arrived (received: the
//     payment already credited its IVA, and the REP is the receipt that
//     supports that credit) or has not been issued (issued: our OWN
//     filing obligation, with a deadline). Since MNE-001-125 the list is
//     the one in accounting/rep-expected.ts, the same the close counts:
//     completed payments, live applications, the method the ledger
//     used. A collection of a stamped invoice whose method is not in the
//     mirror is listed too, marked 'desconocido' — the ledger treated it
//     as PUE, but hiding a REP we may owe is worse than listing the doubt.
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
  /** 'PPD' when a fact states it; 'desconocido' when the ledger's conservative default decided. */
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
  const expected = await listPaymentsAwaitingRep(query, entityId);
  const candidates =
    opts.direction === 'received'
      ? expected.awaiting.filter((p) => p.direction === 'received')
      : [...expected.awaiting.filter((p) => p.direction === 'issued'), ...expected.unknownIssuedMethod];
  return candidates
    .filter((p) => Number(p.amount) >= (opts.minAmount ?? 0))
    .sort((x, y) => x.payment_date.localeCompare(y.payment_date) || x.payment_number.localeCompare(y.payment_number))
    .slice(0, limit)
    .map((p) => ({
      payment_number: p.payment_number,
      payment_date: p.payment_date,
      contraparte: p.counterparty,
      amount: p.amount,
      metodo: p.method,
      edad_dias: p.age_days,
    }));
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
      // NUNCA crea proveedores: esto es un reproceso desatendido de una cola.
      // `listRepAparcados` sólo devuelve document_type='payment', que no llega
      // a createBillFromPreReg, pero la autorización se escribe igual para que
      // el filtro sea la segunda cerca y no la única.
      await service.processToAccounting(fila.rows[0], userId, { permitirProveedorNuevo: false });
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
