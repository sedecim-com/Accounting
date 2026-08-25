import { query } from '../../../../database/connection.js';

// ============================================================
// Form W-3 — Transmittal of Wage and Tax Statements
// Summary totals of all W-2s for an employer, submitted to SSA.
// ============================================================

export interface W3Data {
  tax_year: number;
  employer: { ein: string; name: string; address: string };
  kind_of_payer: '941' | '943' | '944' | 'CT-1' | 'Hshld' | 'Medicare';
  total_w2_count: number;
  box_1_wages: number;
  box_2_fit_withheld: number;
  box_3_ss_wages: number;
  box_4_ss_withheld: number;
  box_5_medicare_wages: number;
  box_6_medicare_withheld: number;
  box_7_ss_tips: number;
  box_8_allocated_tips: number;
  box_10_dependent_care: number;
  box_11_nonqualified: number;
  box_12a_deferred: number;  // 401(k) etc.
  box_14_third_party_sick: number;
  box_16_state_wages: number;
  box_17_state_tax: number;
  box_18_local_wages: number;
  box_19_local_tax: number;
}

export async function generateW3(
  tenantId: string,
  entityId: string,
  taxYear: number
): Promise<W3Data> {
  const entResult = await query<{ tax_id: string; name: string; address_line1: string | null; city: string | null; state_province: string | null; postal_code: string | null }>(
    `SELECT tax_id, name, address_line1, city, state_province, postal_code FROM legal_entities WHERE id = $1`,
    [entityId]
  );
  const ent = entResult.rows[0];

  const totals = await query<{
    cnt: string;
    box1: string; box2: string;
    box3: string; box4: string;
    box5: string; box6: string;
    box12a: string;
    box16: string; box17: string;
    box18: string; box19: string;
  }>(
    `SELECT
       COUNT(*) AS cnt,
       COALESCE(SUM((data->>'box_1_wages')::numeric), 0) AS box1,
       COALESCE(SUM((data->>'box_2_fit_withheld')::numeric), 0) AS box2,
       COALESCE(SUM((data->>'box_3_ss_wages')::numeric), 0) AS box3,
       COALESCE(SUM((data->>'box_4_ss_withheld')::numeric), 0) AS box4,
       COALESCE(SUM((data->>'box_5_medicare_wages')::numeric), 0) AS box5,
       COALESCE(SUM((data->>'box_6_medicare_withheld')::numeric), 0) AS box6,
       COALESCE(SUM(COALESCE((
         SELECT SUM((b->>'amount')::numeric) FROM jsonb_array_elements(data->'box_12') b WHERE b->>'code' = 'D'
       ), 0)), 0) AS box12a,
       COALESCE(SUM((data->>'box_16_state_wages')::numeric), 0) AS box16,
       COALESCE(SUM((data->>'box_17_state_tax')::numeric), 0) AS box17,
       COALESCE(SUM((data->>'box_18_local_wages')::numeric), 0) AS box18,
       COALESCE(SUM((data->>'box_19_local_tax')::numeric), 0) AS box19
     FROM tax_form_filings
     WHERE tenant_id = $1 AND entity_id = $2 AND form_type = 'w2' AND tax_year = $3`,
    [tenantId, entityId, taxYear]
  );
  const t = totals.rows[0];

  const w3: W3Data = {
    tax_year: taxYear,
    employer: {
      ein: ent?.tax_id || '',
      name: ent?.name || '',
      address: [ent?.address_line1, ent?.city, ent?.state_province, ent?.postal_code].filter(Boolean).join(', '),
    },
    kind_of_payer: '941',
    total_w2_count: parseInt(t.cnt, 10),
    box_1_wages: parseFloat(t.box1),
    box_2_fit_withheld: parseFloat(t.box2),
    box_3_ss_wages: parseFloat(t.box3),
    box_4_ss_withheld: parseFloat(t.box4),
    box_5_medicare_wages: parseFloat(t.box5),
    box_6_medicare_withheld: parseFloat(t.box6),
    box_7_ss_tips: 0,
    box_8_allocated_tips: 0,
    box_10_dependent_care: 0,
    box_11_nonqualified: 0,
    box_12a_deferred: parseFloat(t.box12a),
    box_14_third_party_sick: 0,
    box_16_state_wages: parseFloat(t.box16),
    box_17_state_tax: parseFloat(t.box17),
    box_18_local_wages: parseFloat(t.box18),
    box_19_local_tax: parseFloat(t.box19),
  };

  await query(
    `INSERT INTO tax_form_filings (tenant_id, entity_id, form_type, tax_year, status, data)
     VALUES ($1, $2, 'w3', $3, 'ready', $4::jsonb)`,
    [tenantId, entityId, taxYear, JSON.stringify(w3)]
  );

  return w3;
}

/**
 * Generate SSA EFW2 flat file (fixed 512-char records) for BSO upload.
 * Simplified — real EFW2 has many more record types (RA, RE, RS, RT, RF, RW, RO).
 */
export async function generateEfw2File(
  tenantId: string,
  entityId: string,
  taxYear: number,
  submitterInfo: { ein: string; name: string; address: string; contact_name: string; contact_phone: string; contact_email: string }
): Promise<{ content: string; record_count: number }> {
  const pad = (v: string | number, n: number, left = false, fill = ' ') => {
    const s = String(v);
    if (s.length > n) return s.slice(0, n);
    return left ? fill.repeat(n - s.length) + s : s + fill.repeat(n - s.length);
  };
  const padN = (n: number, len: number) => pad(Math.round(n * 100).toString(), len, true, '0');

  // RA — Submitter
  const ra = 'RA' + pad(submitterInfo.ein.replace(/\D/g, ''), 9) + pad('', 4) + pad(submitterInfo.name, 57) +
    pad(submitterInfo.address, 22) + pad('', 400);

  // RE — Employer
  const ent = await query<{ tax_id: string; name: string; address_line1: string | null; city: string | null; state_province: string | null; postal_code: string | null }>(
    `SELECT tax_id, name, address_line1, city, state_province, postal_code FROM legal_entities WHERE id = $1`,
    [entityId]
  );
  const e = ent.rows[0];
  const re = 'RE' + pad(taxYear.toString(), 4) + pad('', 1) + pad((e?.tax_id || '').replace(/\D/g, ''), 9) +
    pad(e?.name || '', 57) + pad(e?.address_line1 || '', 22) + pad(e?.city || '', 22) +
    pad(e?.state_province || '', 2) + pad(e?.postal_code || '', 5) + pad('', 388);

  // RW — Employee wage records (one per employee)
  const w2s = await query<{ data: W2Envelope }>(
    `SELECT data FROM tax_form_filings WHERE tenant_id = $1 AND entity_id = $2 AND form_type = 'w2' AND tax_year = $3`,
    [tenantId, entityId, taxYear]
  );
  type W2Envelope = { employee: { ssn: string; first_name: string; last_name: string }; box_1_wages: number; box_2_fit_withheld: number; box_3_ss_wages: number; box_4_ss_withheld: number; box_5_medicare_wages: number; box_6_medicare_withheld: number };

  const rwRecords: string[] = [];
  let totalWages = 0, totalFit = 0, totalSsWages = 0, totalSsTax = 0, totalMedWages = 0, totalMedTax = 0;
  for (const row of w2s.rows) {
    const w = row.data;
    const rw = 'RW' + pad(w.employee.ssn.replace(/\D/g, ''), 9) +
      pad(w.employee.first_name, 15) + pad('', 15) + pad(w.employee.last_name, 20) +
      pad('', 4) + pad('', 22) + pad('', 22) + pad('', 2) + pad('', 5) + pad('', 5) +
      pad('', 23) +
      padN(w.box_1_wages, 11) + padN(w.box_2_fit_withheld, 11) +
      padN(w.box_3_ss_wages, 11) + padN(w.box_4_ss_withheld, 11) +
      padN(w.box_5_medicare_wages, 11) + padN(w.box_6_medicare_withheld, 11) +
      pad('', 297);
    rwRecords.push(rw);
    totalWages += w.box_1_wages; totalFit += w.box_2_fit_withheld;
    totalSsWages += w.box_3_ss_wages; totalSsTax += w.box_4_ss_withheld;
    totalMedWages += w.box_5_medicare_wages; totalMedTax += w.box_6_medicare_withheld;
  }

  // RT — Total
  const rt = 'RT' + pad(rwRecords.length.toString(), 7, true, '0') +
    padN(totalWages, 15) + padN(totalFit, 15) +
    padN(totalSsWages, 15) + padN(totalSsTax, 15) +
    padN(totalMedWages, 15) + padN(totalMedTax, 15) +
    pad('', 400);

  // RF — Final
  const rf = 'RF' + pad('', 7) + pad(rwRecords.length.toString(), 9, true, '0') + pad('', 494);

  const records = [ra, re, ...rwRecords, rt, rf];
  // Pad each record to exactly 512 chars
  const content = records.map((r) => (r.length >= 512 ? r.slice(0, 512) : r + ' '.repeat(512 - r.length))).join('\r\n') + '\r\n';

  return { content, record_count: records.length };
}
