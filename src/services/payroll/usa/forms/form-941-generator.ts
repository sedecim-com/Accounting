import { query } from '../../../../database/connection.js';

// ============================================================
// Form 941 — Employer's Quarterly Federal Tax Return
// Reports: wages paid, FIT withheld, FICA (EE+ER), adjustments, deposits.
// ============================================================

export interface Form941Data {
  tax_year: number;
  quarter: 1 | 2 | 3 | 4;
  employer: { ein: string; name: string };
  line_1_num_employees: number;
  line_2_wages_tips: number;
  line_3_fit_withheld: number;
  line_5a_ss_wages: number;
  line_5a_ss_tax: number;              // 0.124 (both EE + ER)
  line_5c_medicare_wages: number;
  line_5c_medicare_tax: number;        // 0.029
  line_5d_additional_medicare_wages: number;
  line_5d_additional_medicare_tax: number;  // 0.009
  line_6_total_taxes_before_adjustments: number;
  line_12_total_taxes_after_adjustments: number;
  line_13_total_deposits: number;
  line_14_balance_due: number;
  line_15_overpayment: number;
}

function quarterRange(year: number, q: number): { start: string; end: string } {
  const startMonth = (q - 1) * 3;
  const start = new Date(Date.UTC(year, startMonth, 1));
  const end = new Date(Date.UTC(year, startMonth + 3, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export async function generateForm941(
  tenantId: string,
  entityId: string,
  taxYear: number,
  quarter: 1 | 2 | 3 | 4
): Promise<Form941Data> {
  const { start, end } = quarterRange(taxYear, quarter);

  const result = await query<{
    num: string;
    wages: string; fit: string;
    ss_wages: string; ss_tax_ee: string; ss_tax_er: string;
    med_wages: string; med_ee: string; med_er: string;
    addl_med_wages: string; addl_med: string;
    deposits: string;
  }>(
    `SELECT
       COUNT(DISTINCT p.employee_id) AS num,
       COALESCE(SUM(p.taxable_wages_fit), 0) AS wages,
       COALESCE(SUM(p.fit_withheld), 0) AS fit,
       COALESCE(SUM(p.taxable_wages_fica), 0) AS ss_wages,
       COALESCE(SUM(p.fica_ss_withheld), 0) AS ss_tax_ee,
       COALESCE(SUM(p.fica_ss_employer), 0) AS ss_tax_er,
       COALESCE(SUM(p.taxable_wages_fica), 0) AS med_wages,
       COALESCE(SUM(p.fica_medicare_withheld), 0) AS med_ee,
       COALESCE(SUM(p.fica_medicare_employer), 0) AS med_er,
       COALESCE(SUM(CASE WHEN p.additional_medicare_withheld > 0 THEN p.taxable_wages_fica ELSE 0 END), 0) AS addl_med_wages,
       COALESCE(SUM(p.additional_medicare_withheld), 0) AS addl_med,
       COALESCE((SELECT SUM(amount) FROM employer_tax_liabilities
                 WHERE tenant_id = $1 AND entity_id = $2
                   AND tax_type IN ('941_federal', 'fit', 'fica_ss', 'fica_medicare')
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

  const ssWages = parseFloat(r.ss_wages);
  const ssTaxTotal = parseFloat(r.ss_tax_ee) + parseFloat(r.ss_tax_er);
  const medWages = parseFloat(r.med_wages);
  const medTaxTotal = parseFloat(r.med_ee) + parseFloat(r.med_er);
  const addlMed = parseFloat(r.addl_med);
  const addlMedWages = parseFloat(r.addl_med_wages);
  const fit = parseFloat(r.fit);
  const totalTaxes = fit + ssTaxTotal + medTaxTotal + addlMed;
  const deposits = parseFloat(r.deposits);
  const balance = totalTaxes - deposits;

  const form: Form941Data = {
    tax_year: taxYear,
    quarter,
    employer: { ein: ent.tax_id, name: ent.name },
    line_1_num_employees: parseInt(r.num, 10),
    line_2_wages_tips: parseFloat(r.wages),
    line_3_fit_withheld: fit,
    line_5a_ss_wages: ssWages,
    line_5a_ss_tax: Math.round(ssTaxTotal * 100) / 100,
    line_5c_medicare_wages: medWages,
    line_5c_medicare_tax: Math.round(medTaxTotal * 100) / 100,
    line_5d_additional_medicare_wages: addlMedWages,
    line_5d_additional_medicare_tax: Math.round(addlMed * 100) / 100,
    line_6_total_taxes_before_adjustments: Math.round(totalTaxes * 100) / 100,
    line_12_total_taxes_after_adjustments: Math.round(totalTaxes * 100) / 100,
    line_13_total_deposits: Math.round(deposits * 100) / 100,
    line_14_balance_due: balance > 0 ? Math.round(balance * 100) / 100 : 0,
    line_15_overpayment: balance < 0 ? Math.round(-balance * 100) / 100 : 0,
  };

  await query(
    `INSERT INTO tax_form_filings (tenant_id, entity_id, form_type, tax_year, period, status, data)
     VALUES ($1, $2, '941', $3, $4, 'ready', $5::jsonb)`,
    [tenantId, entityId, taxYear, `Q${quarter}`, JSON.stringify(form)]
  );

  return form;
}
