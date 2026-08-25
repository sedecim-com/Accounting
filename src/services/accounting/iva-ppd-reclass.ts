import { query, withTransaction } from '../../database/connection.js';
import { createJournalEntry } from './posting.js';
import { reopenClosedPeriod, restorePeriodStatus } from './fiscal-calendar-service.js';
import { JournalEntryType } from '../../types/index.js';

// ============================================================
// RECLASIFICACIÓN DEL IVA DE CFDI PPD MAL ACREDITADO.
//
// Hasta que el clasificador entró en la ruta viva, toda factura recibida
// mandaba su IVA a «IVA Acreditable» sin mirar el método de pago. Bajo PPD
// el IVA no es acreditable hasta que se paga la factura y llega el REP: lo
// ya registrado sobrestima el IVA acreditable de cada periodo.
//
// La corrección es una RECLASIFICACIÓN, no una reversión del asiento
// completo: los importes eran correctos y la cuenta no. Se mueve el saldo
// de «IVA Acreditable» a «IVA Pendiente de Acreditar» con un asiento
// propio, fechado en el periodo del hecho —reclasificar un IVA de marzo no
// es un movimiento de agosto—.
//
// Idempotente por construcción: cada reclasificación queda marcada con
// source_type='iva_reclass' y source_id = el asiento original, y el censo
// excluye lo ya reclasificado. Correrlo dos veces no duplica nada.
// ============================================================

/** Marca que une la reclasificación con el asiento que corrige. */
export const ORIGEN_RECLASIFICACION = 'iva_reclass';

export interface HallazgoIvaPpd {
  entity_id: string;
  entity_name: string;
  entry_id: string;
  entry_number: string;
  entry_date: Date;
  period_id: string;
  period_name: string;
  period_status: string;
  importe: string;
  cuenta_acreditable_id: string;
  cuenta_acreditable_code: string;
  cuenta_pendiente_id: string | null;
  cuenta_pendiente_code: string | null;
  bill_number: string | null;
  cfdi_uuid: string;
}

const CENSO = `
WITH iva_acreditable AS (
  -- El rol manda; el código es la red por si la entidad no tiene
  -- sembrada la capa semántica.
  SELECT a.id, a.entity_id, a.code
  FROM accounts a
  LEFT JOIN account_roles ar
         ON ar.account_id = a.id AND ar.role = 'iva_acreditable' AND ar.qualifier IS NULL
  WHERE ar.id IS NOT NULL OR a.code = '1130'
),
iva_pendiente AS (
  SELECT a.id, a.entity_id, a.code
  FROM accounts a
  LEFT JOIN account_roles ar
         ON ar.account_id = a.id AND ar.role = 'iva_pendiente_acreditar' AND ar.qualifier IS NULL
  WHERE ar.id IS NOT NULL OR a.code = '1135'
)
SELECT
  le.id   AS entity_id,
  le.name AS entity_name,
  je.id   AS entry_id,
  je.entry_number,
  je.entry_date,
  fp.id     AS period_id,
  fp.period_name,
  fp.status AS period_status,
  jel.debit_amount AS importe,
  acr.id   AS cuenta_acreditable_id,
  acr.code AS cuenta_acreditable_code,
  pen.id   AS cuenta_pendiente_id,
  pen.code AS cuenta_pendiente_code,
  b.bill_number,
  xd.cfdi_uuid
FROM journal_entry_lines jel
JOIN iva_acreditable acr ON acr.id = jel.account_id
JOIN journal_entries je  ON je.id = jel.journal_entry_id
JOIN fiscal_periods fp   ON fp.id = je.fiscal_period_id
JOIN legal_entities le   ON le.id = je.entity_id
JOIN bills b             ON b.id = je.source_id AND je.source_type = 'bill'
JOIN pre_registrations pr ON pr.bill_id = b.id
JOIN xml_documents xd    ON xd.id = pr.xml_document_id
LEFT JOIN iva_pendiente pen ON pen.entity_id = le.id
WHERE le.tenant_id = $1
  AND je.status = 'posted'
  AND jel.debit_amount > 0
  AND xd.metodo_pago = 'PPD'
  AND je.reversed_by_entry_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM journal_entries r
     WHERE r.source_type = $3 AND r.source_id = je.id AND r.status = 'posted'
  )
  AND ($2::uuid IS NULL OR le.id = $2::uuid)
ORDER BY le.name, je.entry_date, je.entry_number`;

/** Qué hay que corregir. No escribe nada. */
export async function censarIvaPpd(
  tenantId: string,
  entityId?: string | null
): Promise<HallazgoIvaPpd[]> {
  const r = await query<HallazgoIvaPpd>(CENSO, [
    tenantId,
    entityId ?? null,
    ORIGEN_RECLASIFICACION,
  ]);
  return r.rows;
}

export interface ResultadoReclasificacion {
  reclasificados: number;
  omitidos: HallazgoIvaPpd[];
  motivosOmision: Map<string, string>;
  fallos: string[];
  montoReclasificado: number;
}

export interface OpcionesReclasificacion {
  /** Reabre los periodos cerrados y los devuelve a su estado. 'locked' nunca. */
  reabrirCerrados?: boolean;
}

/**
 * Aplica la reclasificación. Cada asiento va en su propia transacción: un
 * fallo aislado no tira los que sí se pudieron corregir, y el censo del
 * siguiente intento vuelve a listarlo.
 */
export async function reclasificarIvaPpd(
  hallazgos: HallazgoIvaPpd[],
  actorUserId: string,
  opts: OpcionesReclasificacion = {}
): Promise<ResultadoReclasificacion> {
  const omitidos: HallazgoIvaPpd[] = [];
  const motivosOmision = new Map<string, string>();
  const fallos: string[] = [];
  let reclasificados = 0;
  let montoReclasificado = 0;

  const omitir = (h: HallazgoIvaPpd, motivo: string): void => {
    omitidos.push(h);
    motivosOmision.set(h.entry_id, motivo);
  };

  for (const h of hallazgos) {
    if (!h.cuenta_pendiente_id) {
      omitir(h, `${h.entity_name} no tiene cuenta «IVA Pendiente de Acreditar» (1135)`);
      continue;
    }
    if (h.period_status === 'locked') {
      omitir(h, `${h.period_name} está 'locked': su información ya salió del sistema`);
      continue;
    }
    if (h.period_status !== 'open' && !opts.reabrirCerrados) {
      omitir(h, `${h.period_name} está '${h.period_status}' y no se pidió reabrir`);
      continue;
    }

    const motivo =
      `Reclasificación de IVA: el CFDI ${h.cfdi_uuid} es PPD y su IVA no era acreditable ` +
      `al recibir la factura (se acredita con el REP).`;
    let estadoPrevio: string | null = null;

    try {
      if (h.period_status !== 'open') {
        const r = await reopenClosedPeriod(h.entity_id, h.period_id, actorUserId, motivo);
        estadoPrevio = r.previousStatus;
      }

      await withTransaction(async (client) => {
        await createJournalEntry(
          h.entity_id,
          new Date(h.entry_date),
          JournalEntryType.CORRECTION,
          `Reclasificación IVA PPD — ${h.entry_number}`,
          [
            {
              account_id: h.cuenta_pendiente_id as string,
              debit_amount: Number(h.importe).toFixed(4),
              credit_amount: null,
              description: `IVA pendiente de acreditar — CFDI ${h.cfdi_uuid}`,
            },
            {
              account_id: h.cuenta_acreditable_id,
              debit_amount: null,
              credit_amount: Number(h.importe).toFixed(4),
              description: `Sale de IVA acreditable — ${h.bill_number ?? h.entry_number}`,
            },
          ],
          actorUserId,
          {
            autoPost: true,
            client,
            sourceType: ORIGEN_RECLASIFICACION,
            sourceId: h.entry_id,
            reference: h.entry_number,
          }
        );
      });
      reclasificados += 1;
      montoReclasificado += Number(h.importe);
    } catch (e) {
      fallos.push(`${h.entry_number}: ${(e as Error).message}`);
    } finally {
      if (estadoPrevio) {
        await restorePeriodStatus(
          h.entity_id, h.period_id, estadoPrevio, actorUserId,
          'Cierre restaurado tras la reclasificación de IVA PPD.'
        ).catch((e) =>
          fallos.push(`no se pudo volver a cerrar ${h.period_name}: ${(e as Error).message}`)
        );
      }
    }
  }

  return { reclasificados, omitidos, motivosOmision, fallos, montoReclasificado };
}
