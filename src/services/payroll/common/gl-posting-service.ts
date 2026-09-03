import Decimal from 'decimal.js';
import { query } from '../../../database/connection.js';
import { createJournalEntry, postJournalEntry } from '../../accounting/posting.js';
import { JournalEntryType } from '../../../types/index.js';
import { leerRegistroDelSubsidio } from '../mx/subsidio-entregado.js';

// ============================================================
// PAYROLL → GL POSTING
// Creates a compound journal entry for a pay run.
// Uses payroll_account_mapping table to resolve semantic buckets → GL accounts.
// ============================================================

async function resolveAccounts(entityId: string): Promise<Record<string, string>> {
  const result = await query<{ bucket: string; account_id: string }>(
    `SELECT bucket, account_id FROM payroll_account_mapping WHERE entity_id = $1`,
    [entityId]
  );
  const map: Record<string, string> = {};
  for (const r of result.rows) map[r.bucket] = r.account_id;
  return map;
}

/**
 * EL INQUILINO ES UN PARÁMETRO, NO UNA COLUMNA QUE SE LEE DESPUÉS.
 *
 * Las dos consultas de abajo buscaban por `pr.id = $1` y `pay_run_id = $1` a
 * secas. RLS las tapaba en la API, pero el agregado del que sale la póliza
 * —`SUM(...) FROM paychecks WHERE pay_run_id = $1`— sumaba cualquier recibo
 * colgado de esa corrida viniera de donde viniera: un verificador de F08a lo
 * midió metiendo un recibo de 9 000 de otro inquilino en una corrida ajena y
 * viéndolo entrar en la póliza de nómina del vecino. La puerta de entrada ya
 * se cerró en `calculatePaycheck`; ésta es la otra mitad, y va DENTRO del SQL
 * porque cualquier escritor futuro de `paychecks` vuelve a abrirla si no.
 */
export async function postPayRunToGL(
  payRunId: string,
  userId: string,
  tenantId: string
): Promise<string> {
  // Load pay run + totals
  const prResult = await query<{
    tenant_id: string;
    pay_period_id: string;
    entity_id: string;
    tax_year_used: number;
    pay_date: string;
    totals_gross: string;
    totals_pretax: string;
    totals_net: string;
    totals_ee_taxes: string;
    totals_er_taxes: string;
    totals_post: string;
  }>(
    `SELECT pr.tenant_id, pr.pay_period_id, ps.entity_id, pr.tax_year_used,
            pp.pay_date,
            pr.total_gross AS totals_gross,
            pr.total_pre_tax_deductions AS totals_pretax,
            pr.total_net_pay AS totals_net,
            pr.total_employee_taxes AS totals_ee_taxes,
            pr.total_employer_taxes AS totals_er_taxes,
            pr.total_post_tax_deductions AS totals_post
     FROM pay_runs pr
     JOIN pay_periods pp ON pp.id = pr.pay_period_id
     JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id
     WHERE pr.id = $1 AND pr.tenant_id = $2`,
    [payRunId, tenantId]
  );
  if (prResult.rows.length === 0) throw new Error('Pay run not found');
  const pr = prResult.rows[0];

  // Aggregate tax breakdown across all paychecks
  const breakdownResult = await query<{
    fit: string; fica_ss_ee: string; fica_med_ee: string; addl_med: string; sit: string; sdi: string;
    fica_ss_er: string; fica_med_er: string; futa: string; suta: string;
    isr: string; imss_ee: string; infonavit_ee: string; imss_er: string; infonavit_er: string;
    benefits_pretax: string; benefits_posttax: string;
  }>(
    `SELECT
       COALESCE(SUM(fit_withheld), 0) AS fit,
       COALESCE(SUM(fica_ss_withheld), 0) AS fica_ss_ee,
       COALESCE(SUM(fica_medicare_withheld), 0) AS fica_med_ee,
       COALESCE(SUM(additional_medicare_withheld), 0) AS addl_med,
       COALESCE(SUM(state_tax_withheld), 0) AS sit,
       COALESCE(SUM(sdi_withheld), 0) AS sdi,
       COALESCE(SUM(fica_ss_employer), 0) AS fica_ss_er,
       COALESCE(SUM(fica_medicare_employer), 0) AS fica_med_er,
       COALESCE(SUM(futa), 0) AS futa,
       COALESCE(SUM(suta), 0) AS suta,
       COALESCE(SUM(isr_withheld - subsidio_empleo), 0) AS isr,
       COALESCE(SUM(imss_employee), 0) AS imss_ee,
       COALESCE(SUM(infonavit_withheld), 0) AS infonavit_ee,
       COALESCE(SUM(imss_employer), 0) AS imss_er,
       COALESCE(SUM(infonavit_employer), 0) AS infonavit_er,
       COALESCE(SUM(pre_tax_deductions), 0) AS benefits_pretax,
       COALESCE(SUM(post_tax_deductions), 0) AS benefits_posttax
     FROM paychecks WHERE pay_run_id = $1 AND tenant_id = $2`,
    [payRunId, tenantId]
  );
  const b = breakdownResult.rows[0];

  const accounts = await resolveAccounts(pr.entity_id);
  const required = ['wages_expense', 'payroll_tax_expense', 'cash_payroll'];
  for (const k of required) {
    if (!accounts[k]) throw new Error(`Missing payroll_account_mapping for bucket: ${k}`);
  }

  type Line = { account_id: string; debit_amount: string | null; credit_amount: string | null; description: string };
  const lines: Line[] = [];

  const n = (s: string): number => parseFloat(s);
  const totalGross = parseFloat(pr.totals_gross);
  const totalNet = parseFloat(pr.totals_net);
  const totalErTaxes = parseFloat(pr.totals_er_taxes);

  // DR: Wages expense (gross)
  lines.push({
    account_id: accounts.wages_expense,
    debit_amount: totalGross.toFixed(2),
    credit_amount: null,
    description: `Gross wages for pay run ${payRunId.slice(0, 8)}`,
  });

  // DR: Payroll tax expense (employer-only taxes)
  if (totalErTaxes > 0) {
    lines.push({
      account_id: accounts.payroll_tax_expense,
      debit_amount: totalErTaxes.toFixed(2),
      credit_amount: null,
      description: 'Employer payroll taxes',
    });
  }

  // CR: Cash payroll (net pay)
  lines.push({
    account_id: accounts.cash_payroll,
    debit_amount: null,
    credit_amount: totalNet.toFixed(2),
    description: 'Net pay disbursement',
  });

  const creditIfPresent = (bucket: string, amount: number, desc: string) => {
    if (amount <= 0) return;
    const acct = accounts[bucket];
    if (!acct) return;
    lines.push({ account_id: acct, debit_amount: null, credit_amount: amount.toFixed(2), description: desc });
  };

  // Employee withholding payables
  creditIfPresent('fit_payable', n(b.fit), 'FIT withheld');
  creditIfPresent('fica_payable', n(b.fica_ss_ee) + n(b.fica_med_ee) + n(b.addl_med) + n(b.fica_ss_er) + n(b.fica_med_er), 'FICA EE+ER');
  creditIfPresent('futa_payable', n(b.futa), 'FUTA');
  creditIfPresent('suta_payable', n(b.suta), 'SUTA');
  creditIfPresent('state_tax_payable', n(b.sit) + n(b.sdi), 'State tax + SDI');
  // EL ISR PUEDE SER NEGATIVO, Y ENTONCES NO ES UN ABONO QUE SE DESCARTA.
  //
  // `b.isr` es SUM(isr_withheld − subsidio_empleo) de la corrida: el ISR que
  // se remite. Cuando el subsidio al empleo de la corrida supera al ISR
  // retenido, ese importe es dinero que el patrón ENTREGÓ en efectivo a sus
  // trabajadores, y va al DEBE. Pasaba por `creditIfPresent`, que descarta lo
  // que no es positivo, así que la póliza quedaba descuadrada por exactamente
  // esa cifra y la corrida entera no se podía postear — el trabajador cobraba
  // (desde F08a) y la contabilidad se negaba a registrarlo.
  //
  // A qué cuenta va lo decide el despacho, no este archivo.
  const isrDeLaCorrida = new Decimal(b.isr);
  if (isrDeLaCorrida.greaterThan(0)) {
    creditIfPresent('isr_payable', isrDeLaCorrida.toNumber(), 'ISR withheld (net of subsidio)');
  } else if (isrDeLaCorrida.lessThan(0)) {
    const entregado = isrDeLaCorrida.abs();
    const registro = await leerRegistroDelSubsidio({ tenantId, entityId: pr.entity_id });
    const cubeta =
      registro.valor === 'cuenta_por_cobrar_fisco' ? 'isr_payable' : 'subsidio_empleo_expense';
    const cuenta = accounts[cubeta];
    if (!cuenta) {
      throw new Error(
        `Missing payroll_account_mapping for bucket: ${cubeta}. La corrida entregó ` +
          `${entregado.toFixed(2)} de subsidio al empleo en efectivo y la política ` +
          `subsidio_al_empleo_entregado_registro dice registrarlo como ${registro.valor}.`
      );
    }
    lines.push({
      account_id: cuenta,
      debit_amount: entregado.toFixed(2),
      credit_amount: null,
      description:
        registro.valor === 'cuenta_por_cobrar_fisco'
          ? 'Subsidio al empleo entregado en efectivo (acreditable contra ISR retenido)'
          : 'Subsidio al empleo entregado en efectivo (absorbido por el patrón)',
    });
  }
  creditIfPresent('imss_payable', n(b.imss_ee) + n(b.imss_er), 'IMSS EE+ER');
  creditIfPresent('infonavit_payable', n(b.infonavit_ee) + n(b.infonavit_er), 'INFONAVIT');

  const benefitsPre = n(b.benefits_pretax);
  if (benefitsPre > 0 && accounts['benefits_payable']) {
    creditIfPresent('benefits_payable', benefitsPre, 'Pre-tax benefit withholding');
  }
  const benefitsPost = n(b.benefits_posttax);
  if (benefitsPost > 0 && accounts['garnishment_payable']) {
    creditIfPresent('garnishment_payable', benefitsPost, 'Post-tax deductions/garnishments');
  }

  // Verify debits = credits
  // El cuadre se medía restando floats, y el mensaje lo delataba: imprimía
  // diferencias como «96.05000000000018». La tolerancia de un centavo se queda
  // —cada renglón se redondea a dos decimales desde importes de cuatro, y en
  // una corrida de cien trabajadores eso puede dejar un centavo honesto— pero
  // ahora la diferencia que se compara y la que se imprime son la misma.
  const totalDebits = lines
    .filter((l) => l.debit_amount)
    .reduce((a, l) => a.plus(l.debit_amount!), new Decimal(0));
  const totalCredits = lines
    .filter((l) => l.credit_amount)
    .reduce((a, l) => a.plus(l.credit_amount!), new Decimal(0));
  const diff = totalDebits.minus(totalCredits).abs();
  if (diff.greaterThan('0.01')) {
    throw new Error(
      `Payroll GL entry unbalanced: debits ${totalDebits.toFixed(2)} credits ${totalCredits.toFixed(2)} diff ${diff.toFixed(2)}`
    );
  }

  const entry = await createJournalEntry(
    pr.entity_id,
    new Date(pr.pay_date),
    JournalEntryType.PAYROLL,
    `Payroll run ${payRunId.slice(0, 8)}`,
    lines,
    userId,
    { sourceType: 'pay_run', sourceId: payRunId, reference: payRunId }
  );

  await postJournalEntry(entry.id, userId);

  await query(`UPDATE pay_runs SET journal_entry_id = $1 WHERE id = $2`, [entry.id, payRunId]);

  return entry.id;
}
