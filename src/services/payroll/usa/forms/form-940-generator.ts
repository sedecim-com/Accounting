import { query } from '../../../../database/connection.js';

// ============================================================
// Form 940 — Employer's Annual Federal Unemployment (FUTA)
// 0.6% net rate on first $7,000 wages/employee (after state credit).
// ============================================================

export interface Form940Data {
  tax_year: number;
  employer: { ein: string; name: string };
  line_3_total_payments: number;
  line_4_exempt_payments: number;
  line_5_payments_over_7000: number;
  line_7_total_taxable_wages: number;
  line_8_futa_before_adjustments: number;
  line_12_total_futa: number;
  line_13_deposits: number;
  line_14_balance_due: number;
  line_15_overpayment: number;
  quarterly_liabilities: { q1: number; q2: number; q3: number; q4: number };
}

export async function generateForm940(
  tenantId: string,
  entityId: string,
  taxYear: number
): Promise<Form940Data> {
  const start = `${taxYear}-01-01`;
  const end = `${taxYear}-12-31`;

  const result = await query<{
    total_pay: string;
    taxable_futa: string;
    futa_tax: string;
    q1: string; q2: string; q3: string; q4: string;
    deposits: string;
  }>(
    `SELECT
       COALESCE(SUM(p.gross_earnings), 0) AS total_pay,
       COALESCE(SUM(p.taxable_wages_futa), 0) AS taxable_futa,
       -- paychecks.futa, no futa_employer: FUTA es un impuesto SOLO patronal,
       -- así que no lleva sufijo como fica_ss_employer, que sí tiene mitad del
       -- trabajador. La columna inexistente hacía reventar la forma 940 en la
       -- primera invocación, y el contrato de esquema no lo veía porque su
       -- alcance excluye consultas con alias (aquí paychecks es "p").
       COALESCE(SUM(p.futa), 0) AS futa_tax,
       COALESCE(SUM(CASE WHEN EXTRACT(QUARTER FROM pp.pay_date) = 1 THEN p.futa ELSE 0 END), 0) AS q1,
       COALESCE(SUM(CASE WHEN EXTRACT(QUARTER FROM pp.pay_date) = 2 THEN p.futa ELSE 0 END), 0) AS q2,
       COALESCE(SUM(CASE WHEN EXTRACT(QUARTER FROM pp.pay_date) = 3 THEN p.futa ELSE 0 END), 0) AS q3,
       COALESCE(SUM(CASE WHEN EXTRACT(QUARTER FROM pp.pay_date) = 4 THEN p.futa ELSE 0 END), 0) AS q4,
       COALESCE((SELECT SUM(amount) FROM employer_tax_liabilities
                 WHERE tenant_id = $1 AND entity_id = $2 AND tax_type = 'futa'
                   AND period_start >= $3 AND period_end <= $4 AND deposited_at IS NOT NULL), 0) AS deposits
     FROM paychecks p
     JOIN pay_runs pr ON pr.id = p.pay_run_id AND pr.status IN ('approved', 'paid')
     JOIN pay_periods pp ON pp.id = pr.pay_period_id
     JOIN employees e ON e.id = p.employee_id
     WHERE e.tenant_id = $1 AND e.entity_id = $2 AND e.country_code = 'US'
       AND pp.pay_date >= $3 AND pp.pay_date <= $4`,
    [tenantId, entityId, start, end]
  );
  const r = result.rows[0];

  const entResult = await query<{ tax_id: string; name: string }>(
    `SELECT tax_id, name FROM legal_entities WHERE id = $1`,
    [entityId]
  );
  const ent = entResult.rows[0] || { tax_id: '', name: '' };

  const totalPay = parseFloat(r.total_pay);
  const taxable = parseFloat(r.taxable_futa);
  const over7k = Math.max(0, totalPay - taxable);
  const futa = parseFloat(r.futa_tax);
  const deposits = parseFloat(r.deposits);
  const balance = futa - deposits;

  const form: Form940Data = {
    tax_year: taxYear,
    employer: { ein: ent.tax_id, name: ent.name },
    line_3_total_payments: Math.round(totalPay * 100) / 100,
    line_4_exempt_payments: 0,
    line_5_payments_over_7000: Math.round(over7k * 100) / 100,
    line_7_total_taxable_wages: Math.round(taxable * 100) / 100,
    line_8_futa_before_adjustments: Math.round(futa * 100) / 100,
    line_12_total_futa: Math.round(futa * 100) / 100,
    line_13_deposits: Math.round(deposits * 100) / 100,
    line_14_balance_due: balance > 0 ? Math.round(balance * 100) / 100 : 0,
    line_15_overpayment: balance < 0 ? Math.round(-balance * 100) / 100 : 0,
    quarterly_liabilities: {
      q1: Math.round(parseFloat(r.q1) * 100) / 100,
      q2: Math.round(parseFloat(r.q2) * 100) / 100,
      q3: Math.round(parseFloat(r.q3) * 100) / 100,
      q4: Math.round(parseFloat(r.q4) * 100) / 100,
    },
  };

  await query(
    `INSERT INTO tax_form_filings (tenant_id, entity_id, form_type, tax_year, status, data)
     VALUES ($1, $2, '940', $3, 'ready', $4::jsonb)`,
    [tenantId, entityId, taxYear, JSON.stringify(form)]
  );

  return form;
}
