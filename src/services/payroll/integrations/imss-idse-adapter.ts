import Decimal from 'decimal.js';
import { query } from '../../../database/connection.js';
import { ValidationError } from '../../../utils/errors.js';

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
  /** For mod_salario. Decimal STRING — an SBC is money and never a JS number. */
  new_sbc?: string;
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

    // The SBC is money: it stays a decimal string from the column to the
    // seven cents digits of the record. Through a JS float, a peso ending in
    // .005 lands on the wrong centavo and the cuota derived from it is wrong
    // for as long as the movement stands.
    //
    // An SBC that is not an amount is REFUSED, not padded. `new_sbc` arrives
    // straight off req.body, so "5,000.50" or "$5000.50" reach here; the old
    // float path turned those into NaN and wrote `0000NaN` into the record,
    // answering 200 with a record_count that counted a batch IMSS rejects.
    // Decimal throws on the same input, and a raw DecimalError escaping this
    // function is a 500 at best — so the check is explicit and names the
    // movement it came from.
    const rawSbc: unknown =
      mov.movement_type === 'mod_salario' && mov.new_sbc ? mov.new_sbc : e.sbc || '0';
    let sbcForMov: Decimal;
    try {
      sbcForMov = new Decimal(rawSbc as Decimal.Value);
    } catch {
      throw new ValidationError(
        `SBC "${String(rawSbc)}" for employee ${mov.employee_id} is not an amount. Send a plain ` +
          'decimal string — no thousands separator, no currency symbol.',
        'new_sbc'
      );
    }
    if (!sbcForMov.isFinite() || sbcForMov.isNegative()) {
      throw new ValidationError(
        `SBC "${String(rawSbc)}" for employee ${mov.employee_id} is not a usable amount: an IDSE ` +
          'record carries centavos as seven digits and cannot express this.',
        'new_sbc'
      );
    }
    const sbcCents = sbcForMov.times(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed(0);

    // IDSE fixed-width record (simplified layout)
    const line =
      pad(rp, 11) +                                             // 1-11   Employer registration number (registro patronal)
      pad(e.nss, 11) +                                          // 12-22  NSS
      pad(e.rfc, 13) +                                          // 23-35  RFC
      pad(e.curp, 18) +                                         // 36-53  CURP
      pad(e.last_name, 27) +                                    // 54-80
      pad(e.second_last_name || '', 27) +                       // 81-107
      pad(e.first_name, 27) +                                   // 108-134
      pad(sbcCents, 7, true, '0') +                             // 135-141 SBC cents
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

// submitIdseBatch was REMOVED. It fabricated a folio from Date.now() and
// returned status 'accepted' without opening a socket: no WS-Security
// envelope, no FIEL, no IMSS acuse. A caller who saw 'accepted' believed
// the alta or baja had been filed, and an unfiled baja keeps accruing
// cuotas on a worker who left.
//
// The batch this module generates is a real file. Upload it yourself at
// idse.imss.gob.mx and keep the acuse IMSS returns — that acuse, not
// anything mnemosine can produce, is the proof the movement was filed.
