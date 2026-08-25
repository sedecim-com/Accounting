import { query } from '../../../database/connection.js';

// ============================================================
// SUA (Sistema Unico de Autodeterminacion — IMSS self-determination system) — IMSS monthly file
// Fixed-width TXT layout. Reference: IMSS SUA manual.
// One record per employee per period.
// ============================================================

function pad(value: string | number, len: number, left = false, fill = ' '): string {
  const s = String(value);
  if (s.length > len) return s.slice(0, len);
  return left ? fill.repeat(len - s.length) + s : s + fill.repeat(len - s.length);
}

function padN(n: number, len: number): string {
  return pad(Math.round(n).toString(), len, true, '0');
}

interface SuaEmployee {
  nss: string;
  rfc: string;
  curp: string;
  last_name: string;
  second_last_name: string;
  first_name: string;
  sbc: number;
  days_worked: number;
  imss_employer_amount: number;
  imss_employee_amount: number;
  infonavit_employer_amount: number;
  infonavit_employee_amount: number;
}

export async function generateSuaFile(
  tenantId: string,
  entityId: string,
  year: number,
  month: number
): Promise<{ content: string; filename: string; employee_count: number }> {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  const periodStart = start.toISOString().slice(0, 10);
  const periodEnd = end.toISOString().slice(0, 10);

  const result = await query<{
    nss: string;
    rfc: string;
    curp: string;
    last_name: string;
    second_last_name: string | null;
    first_name: string;
    sbc: string;
    imss_ee: string;
    imss_er: string;
    inf_ee: string;
    inf_er: string;
    days: string;
  }>(
    `SELECT
       e.nss, e.rfc, e.curp,
       e.last_name, e.second_last_name, e.first_name,
       e.sbc,
       COALESCE(SUM(p.imss_employee), 0) AS imss_ee,
       COALESCE(SUM(p.imss_employer), 0) AS imss_er,
       COALESCE(SUM(p.infonavit_withheld), 0) AS inf_ee,
       COALESCE(SUM(p.infonavit_employer), 0) AS inf_er,
       SUM(EXTRACT(DAY FROM (pp.period_end::timestamp - pp.period_start::timestamp)) + 1) AS days
     FROM employees e
     LEFT JOIN paychecks p ON p.employee_id = e.id
     LEFT JOIN pay_runs pr ON pr.id = p.pay_run_id AND pr.status IN ('approved', 'paid')
     LEFT JOIN pay_periods pp ON pp.id = pr.pay_period_id
       AND pp.period_start >= $3 AND pp.period_end <= $4
     WHERE e.tenant_id = $1 AND e.entity_id = $2 AND e.country_code = 'MX'
     GROUP BY e.id, e.nss, e.rfc, e.curp, e.last_name, e.second_last_name, e.first_name, e.sbc`,
    [tenantId, entityId, periodStart, periodEnd]
  );

  const records: string[] = [];
  const employees: SuaEmployee[] = result.rows.map((r) => ({
    nss: r.nss || '',
    rfc: r.rfc || '',
    curp: r.curp || '',
    last_name: r.last_name,
    second_last_name: r.second_last_name || '',
    first_name: r.first_name,
    sbc: parseFloat(r.sbc),
    days_worked: parseInt(r.days || '0', 10),
    imss_employer_amount: parseFloat(r.imss_er),
    imss_employee_amount: parseFloat(r.imss_ee),
    infonavit_employer_amount: parseFloat(r.inf_er),
    infonavit_employee_amount: parseFloat(r.inf_ee),
  }));

  for (const e of employees) {
    // Simplified SUA layout (real SUA has ~150 fixed positions per record).
    // This captures the critical positions for integration testing.
    const line =
      pad(e.nss, 11) +                                        // 1-11   NSS
      pad(e.rfc, 13) +                                        // 12-24  RFC
      pad(e.curp, 18) +                                       // 25-42  CURP
      pad(e.last_name, 27) +                                  // 43-69
      pad(e.second_last_name, 27) +                           // 70-96
      pad(e.first_name, 27) +                                 // 97-123
      padN(e.sbc * 100, 8) +                                  // SBC cents
      padN(e.days_worked, 2) +                                // Days worked
      padN(e.imss_employer_amount * 100, 10) +                // IMSS employer
      padN(e.imss_employee_amount * 100, 10) +                // IMSS employee
      padN(e.infonavit_employer_amount * 100, 10) +           // INFONAVIT employer
      padN(e.infonavit_employee_amount * 100, 10);            // INFONAVIT employee
    records.push(line);
  }

  const content = records.join('\r\n') + '\r\n';
  const filename = `SUA_${entityId.slice(0, 8)}_${year}${String(month).padStart(2, '0')}.txt`;

  await query(
    `INSERT INTO tax_form_filings (tenant_id, entity_id, form_type, tax_year, period, status, data)
     VALUES ($1, $2, 'sua', $3, $4, 'draft', $5::jsonb)`,
    [tenantId, entityId, year, String(month).padStart(2, '0'), JSON.stringify({
      employee_count: employees.length,
      totals: {
        imss_employer: employees.reduce((s, e) => s + e.imss_employer_amount, 0),
        imss_employee: employees.reduce((s, e) => s + e.imss_employee_amount, 0),
        infonavit_employer: employees.reduce((s, e) => s + e.infonavit_employer_amount, 0),
        infonavit_employee: employees.reduce((s, e) => s + e.infonavit_employee_amount, 0),
      },
    })]
  );

  return { content, filename, employee_count: employees.length };
}
