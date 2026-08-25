import { query } from '../../../../database/connection.js';
import { decrypt } from '../../../../utils/encryption.js';

// ============================================================
// W-2 Wage and Tax Statement — annual form per employee
// IRS Forms W-2 + W-3 (transmittal).
// Format: EFW2 (Electronic Filing W-2) for SSA Business Services Online.
// ============================================================

export interface W2Data {
  tax_year: number;
  employer: {
    ein: string;
    name: string;
    address: string;
  };
  employee: {
    ssn: string;
    first_name: string;
    last_name: string;
    address: string;
  };
  box_1_wages: number;                   // Wages, tips, other compensation (FIT taxable)
  box_2_fit_withheld: number;            // Federal income tax withheld
  box_3_ss_wages: number;                // Social Security wages (capped)
  box_4_ss_withheld: number;             // SS tax withheld
  box_5_medicare_wages: number;          // Medicare wages (uncapped)
  box_6_medicare_withheld: number;       // Medicare tax withheld (incl. additional)
  box_12: Array<{ code: string; amount: number }>;  // D=401k, W=HSA, DD=employer health, etc.
  box_14: Array<{ label: string; amount: number }>; // Other (SDI, union dues, etc.)
  box_15_state: string;
  box_16_state_wages: number;
  box_17_state_tax: number;
  box_18_local_wages: number;
  box_19_local_tax: number;
  box_20_locality: string;
}

export async function generateW2(
  employeeId: string,
  taxYear: number
): Promise<W2Data> {
  const empResult = await query<{
    ssn_encrypted: string;
    first_name: string;
    last_name: string;
    address_line1: string | null;
    city: string | null;
    state_province: string | null;
    postal_code: string | null;
    entity_id: string;
    work_state: string | null;
    work_city: string | null;
  }>(
    `SELECT ssn_encrypted, first_name, last_name, address_line1,
            city, state_province, postal_code, entity_id, work_state, work_city
     FROM employees WHERE id = $1`,
    [employeeId]
  );
  if (empResult.rows.length === 0) throw new Error('Employee not found');
  const e = empResult.rows[0];

  const entResult = await query<{ tax_id: string; name: string; address_line1: string | null; city: string | null; state_province: string | null; postal_code: string | null }>(
    `SELECT tax_id, name, address_line1, city, state_province, postal_code FROM legal_entities WHERE id = $1`,
    [e.entity_id]
  );
  const ent = entResult.rows[0];

  const totals = await query<{
    box1: string; box2: string;
    box3: string; box4: string;
    box5: string; box6: string;
    pretax_401k: string;
    employer_hsa: string;
    employer_health: string;
    box16: string; box17: string;
    box18: string; box19: string;
    sdi: string;
  }>(
    `SELECT
       COALESCE(SUM(p.taxable_wages_fit), 0) AS box1,
       COALESCE(SUM(p.fit_withheld), 0) AS box2,
       COALESCE(SUM(p.taxable_wages_fica), 0) AS box3,
       COALESCE(SUM(p.fica_ss_withheld), 0) AS box4,
       COALESCE(SUM(p.taxable_wages_fica), 0) AS box5,
       COALESCE(SUM(p.fica_medicare_withheld + p.additional_medicare_withheld), 0) AS box6,
       COALESCE(SUM((SELECT SUM(amount) FROM paycheck_deductions WHERE paycheck_id = p.id AND deduction_type = '401k' AND NOT is_employer_contribution)), 0) AS pretax_401k,
       COALESCE(SUM((SELECT SUM(amount) FROM paycheck_deductions WHERE paycheck_id = p.id AND deduction_type = 'hsa' AND NOT is_employer_contribution)), 0) AS employer_hsa,
       COALESCE(SUM((SELECT SUM(amount) FROM paycheck_deductions WHERE paycheck_id = p.id AND deduction_type = 'health_insurance' AND is_employer_contribution)), 0) AS employer_health,
       COALESCE(SUM(p.taxable_wages_state), 0) AS box16,
       COALESCE(SUM(p.state_tax_withheld), 0) AS box17,
       COALESCE(SUM(p.taxable_wages_state), 0) AS box18,
       COALESCE(SUM(p.local_tax_withheld), 0) AS box19,
       COALESCE(SUM(p.sdi_withheld), 0) AS sdi
     FROM paychecks p
     JOIN pay_runs pr ON pr.id = p.pay_run_id
     JOIN pay_periods pp ON pp.id = pr.pay_period_id
     WHERE p.employee_id = $1 AND pp.tax_year = $2 AND pr.status IN ('approved', 'paid')`,
    [employeeId, taxYear]
  );
  const t = totals.rows[0];

  // SS wage base cap (Box 3 cannot exceed the year's wage base; Medicare/Box 5 is uncapped)
  const ssCapByYear: Record<number, number> = { 2024: 168600, 2025: 176100, 2026: 183600 };
  const ssCap = ssCapByYear[taxYear] ?? 168600;
  const box3Capped = Math.min(parseFloat(t.box3), ssCap);

  const box12: Array<{ code: string; amount: number }> = [];
  if (parseFloat(t.pretax_401k) > 0) box12.push({ code: 'D', amount: parseFloat(t.pretax_401k) });
  if (parseFloat(t.employer_hsa) > 0) box12.push({ code: 'W', amount: parseFloat(t.employer_hsa) });
  if (parseFloat(t.employer_health) > 0) box12.push({ code: 'DD', amount: parseFloat(t.employer_health) });

  const box14: Array<{ label: string; amount: number }> = [];
  if (parseFloat(t.sdi) > 0) box14.push({ label: 'SDI', amount: parseFloat(t.sdi) });

  const w2: W2Data = {
    tax_year: taxYear,
    employer: {
      ein: ent?.tax_id || '',
      name: ent?.name || '',
      address: [ent?.address_line1, ent?.city, ent?.state_province, ent?.postal_code].filter(Boolean).join(', '),
    },
    employee: {
      ssn: e.ssn_encrypted ? decrypt(e.ssn_encrypted) : '',
      first_name: e.first_name,
      last_name: e.last_name,
      address: [e.address_line1, e.city, e.state_province, e.postal_code].filter(Boolean).join(', '),
    },
    box_1_wages: parseFloat(t.box1),
    box_2_fit_withheld: parseFloat(t.box2),
    box_3_ss_wages: box3Capped,
    box_4_ss_withheld: parseFloat(t.box4),
    box_5_medicare_wages: parseFloat(t.box5),
    box_6_medicare_withheld: parseFloat(t.box6),
    box_12: box12,
    box_14: box14,
    box_15_state: e.work_state || '',
    box_16_state_wages: parseFloat(t.box16),
    box_17_state_tax: parseFloat(t.box17),
    box_18_local_wages: parseFloat(t.box18),
    box_19_local_tax: parseFloat(t.box19),
    box_20_locality: e.work_city || '',
  };

  const empResult2 = await query<{ tenant_id: string; entity_id: string }>(
    `SELECT tenant_id, entity_id FROM employees WHERE id = $1`,
    [employeeId]
  );
  await query(
    `INSERT INTO tax_form_filings (tenant_id, entity_id, form_type, tax_year, status, data, employee_id)
     VALUES ($1, $2, 'w2', $3, 'ready', $4::jsonb, $5)
     ON CONFLICT DO NOTHING`,
    [empResult2.rows[0].tenant_id, empResult2.rows[0].entity_id, taxYear, JSON.stringify(w2), employeeId]
  );

  return w2;
}
