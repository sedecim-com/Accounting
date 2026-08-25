import { query } from '../../../database/connection.js';

// ============================================================
// IMSS IDSE Adapter — affiliation movements (movimientos afiliatorios)
// Handles: alta (registration), baja (termination), salary modification (MSC).
// IDSE is IMSS Desktop with SOAP web service via certificate-based auth.
// Movement types:
//   08 = Employee registration (alta)
//   02 = Employee termination (baja)
//   07 = Salary modification (MSC)
//   11 = Rehire (reingreso)
// Format: fixed-width TXT batch file uploaded to IDSE portal.
// ============================================================

export type ImssMovementType = 'alta' | 'baja' | 'mod_salario' | 'reingreso';
const MOVEMENT_CODES: Record<ImssMovementType, string> = {
  alta: '08',
  baja: '02',
  mod_salario: '07',
  reingreso: '11',
};

export type BajaReason =
  | '1'   // End of contract
  | '2'   // Voluntary separation
  | '3'   // Job abandonment
  | '4'   // Death
  | '5'   // Absenteeism
  | '6'   // Contract rescission
  | '9'   // Pension
  | 'A'   // Other
;

export interface ImssMovement {
  employee_id: string;
  movement_type: ImssMovementType;
  effective_date: string;         // YYYY-MM-DD
  new_sbc?: number;                // For mod_salario
  baja_reason?: BajaReason;        // For baja
}

function pad(v: string | number, n: number, left = false, fill = ' '): string {
  const s = String(v);
  if (s.length > n) return s.slice(0, n);
  return left ? fill.repeat(n - s.length) + s : s + fill.repeat(n - s.length);
}
function ddmmyyyy(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}${m}${y}`;
}

/**
 * Generate IDSE batch file. Each record is 270 chars fixed-width.
 * Real IDSE layouts vary by movement type — this captures the most common fields.
 */
export async function generateIdseBatch(
  tenantId: string,
  entityId: string,
  movements: ImssMovement[]
): Promise<{ content: string; record_count: number; batch_id: string }> {
  const entResult = await query<{ imss_registro_patronal: string | null }>(
    `SELECT imss_registro_patronal FROM legal_entities WHERE id = $1`,
    [entityId]
  );
  const rp = entResult.rows[0]?.imss_registro_patronal || '';

  const records: string[] = [];
  for (const mov of movements) {
    const empResult = await query<{
      nss: string; rfc: string; curp: string;
      first_name: string; last_name: string; second_last_name: string | null;
      sbc: string | null;
    }>(
      `SELECT nss, rfc, curp, first_name, last_name, second_last_name, sbc
       FROM employees WHERE id = $1`,
      [mov.employee_id]
    );
    if (empResult.rows.length === 0) continue;
    const e = empResult.rows[0];

    const sbcForMov = mov.movement_type === 'mod_salario' && mov.new_sbc ? mov.new_sbc : parseFloat(e.sbc || '0');
    const sbcCents = Math.round(sbcForMov * 100);

    // IDSE fixed-width record (simplified layout)
    const line =
      pad(rp, 11) +                                             // 1-11   Employer registration number (registro patronal)
      pad(e.nss, 11) +                                          // 12-22  NSS
      pad(e.rfc, 13) +                                          // 23-35  RFC
      pad(e.curp, 18) +                                         // 36-53  CURP
      pad(e.last_name, 27) +                                    // 54-80
      pad(e.second_last_name || '', 27) +                       // 81-107
      pad(e.first_name, 27) +                                   // 108-134
      pad(sbcCents.toString(), 7, true, '0') +                  // 135-141 SBC cents
      pad(MOVEMENT_CODES[mov.movement_type], 2) +               // 142-143 Movement type
      pad(ddmmyyyy(mov.effective_date), 8) +                    // 144-151 DDMMYYYY
      pad(mov.baja_reason || '', 1) +                            // 152 Termination reason (motivo baja)
      pad('', 118);                                              // filler → 270

    records.push(line);
  }

  const batchId = `IDSE-${Date.now()}`;
  const content = records.join('\r\n') + '\r\n';

  await query(
    `INSERT INTO tax_form_filings (tenant_id, entity_id, form_type, tax_year, status, data)
     VALUES ($1, $2, 'imss_idse', $3, 'draft', $4::jsonb)`,
    [tenantId, entityId, new Date().getUTCFullYear(), JSON.stringify({
      batch_id: batchId,
      record_count: records.length,
      movements: movements.map((m) => ({ employee_id: m.employee_id, type: m.movement_type, effective_date: m.effective_date })),
    })]
  );

  return { content, record_count: records.length, batch_id: batchId };
}

/**
 * Submit IDSE batch. In production this calls the IMSS IDSE web service with
 * the patron's digital certificate (.cer/.key). Stub returns a tracking folio.
 */
export async function submitIdseBatch(
  batchContent: string,
  credentials: { cer_base64: string; key_base64: string; password: string }
): Promise<{ folio: string; status: 'accepted' | 'rejected'; errors?: string[] }> {
  // Real impl: POST SOAP envelope to https://idse.imss.gob.mx/... with WS-Security
  // signed with the patron's FIEL/sello certificate.
  if (!credentials.cer_base64 || !credentials.key_base64) {
    throw new Error('IMSS IDSE credentials required (.cer + .key)');
  }
  const recordCount = batchContent.split('\n').filter((l) => l.trim()).length;
  return {
    folio: `IDSE${Date.now().toString().slice(-10)}`,
    status: 'accepted',
    errors: recordCount === 0 ? ['Empty batch'] : undefined,
  };
}
