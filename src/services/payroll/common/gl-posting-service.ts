import type pg from 'pg';
import Decimal from 'decimal.js';
import { ConflictError, NotFoundError } from '../../../utils/errors.js';
import { withTransaction } from '../../../database/connection.js';
import { attestEntryAsync, createJournalEntry } from '../../accounting/posting.js';
import { JournalEntryType } from '../../../types/index.js';
import { toCalendarDate } from '../../../utils/calendar-date.js';
import { createDraft, type DraftPayload } from '../../../ai/draft-service.js';
import { leerRegistroDelSubsidio } from '../mx/subsidio-entregado.js';

// ============================================================
// PAYROLL → GL POSTING
// Builds the compound journal entry of a pay run and takes it to the ledger
// by one of two roads (MNE-001-069, #306):
//
//   · `draftPayRunEntry` leaves it as a draft in `ai_drafts` for the
//     `mnemosine review` that already exists: the default of `pay-run post`;
//   · `postPayRunToGL` posts it directly: `pay-run post --post` and the REST
//     route `POST /pay-runs/:id/post-to-gl`.
//
// `previewPayRunEntry` is the dry run of both: the same checks and the same
// lines, nothing written.
//
// All three refuse the same things, read under a row lock on the run: a run
// that is not approved (or paid), a run that already has its entry, and a run
// with a live draft (pending or approved). One pay run, one entry.
// Uses payroll_account_mapping table to resolve semantic buckets → GL accounts.
// ============================================================

/** What `ai_drafts.ai_model` says produced the draft: no model, the payroll engine. */
const DRAFT_PRODUCER = 'mnemosine/payroll';

/** The reference that ties a draft to its run; the double-post guard searches by it. */
export function payRunReference(payRunId: string): string {
  return `pay-run:${payRunId}`;
}

interface MappedAccount {
  id: string;
  code: string;
}

async function resolveAccounts(client: pg.PoolClient, entityId: string): Promise<Record<string, MappedAccount>> {
  const result = await client.query<{ bucket: string; account_id: string; code: string }>(
    `SELECT m.bucket, m.account_id, a.code
       FROM payroll_account_mapping m
       JOIN accounts a ON a.id = m.account_id AND a.entity_id = m.entity_id
      WHERE m.entity_id = $1`,
    [entityId]
  );
  const map: Record<string, MappedAccount> = {};
  for (const r of result.rows) map[r.bucket] = { id: r.account_id, code: r.code };
  return map;
}

export interface PayRunEntryLine {
  account_id: string;
  account_code: string;
  debit_amount: string | null;
  credit_amount: string | null;
  description: string;
}

/** The entry of a pay run, as it would post. */
export interface PayRunEntry {
  payRunId: string;
  entityId: string;
  /** The pay date of the period, YYYY-MM-DD. */
  entryDate: string;
  description: string;
  reference: string;
  lines: PayRunEntryLine[];
  totalDebits: string;
  totalCredits: string;
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
async function buildPayRunEntry(
  client: pg.PoolClient,
  payRunId: string,
  tenantId: string,
  entityId: string
): Promise<PayRunEntry> {
  // Load pay run + totals, and LOCK it: two posts of the same run (two
  // terminals, a terminal and the API, a draft and a --post) serialize here,
  // so the second one sees the first one's entry or draft and refuses.
  const prResult = await client.query<{
    tenant_id: string;
    status: string;
    journal_entry_id: string | null;
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
    `SELECT pr.tenant_id, pr.status, pr.journal_entry_id, pr.pay_period_id, ps.entity_id, pr.tax_year_used,
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
     WHERE pr.id = $1 AND pr.tenant_id = $2 AND ps.entity_id = $3
       FOR UPDATE OF pr`,
    [payRunId, tenantId, entityId]
  );
  // T9 (#96): LA ENTIDAD LA DECIDE EL TOKEN, NO EL ID QUE SE MANDA.
  //
  // Este SELECT filtraba sólo por `pr.tenant_id` y sacaba `ps.entity_id` del
  // JOIN, así que la entidad del asiento salía de la FILA. Medido: un contador
  // con acceso sólo a la sociedad A mandaba `POST /pay-runs/<corrida de B>/
  // post-to-gl`, recibía 200, y a B le quedaba una póliza POSTEADA de 10 029.92
  // en su mayor — cambiando su balanza, su estado de resultados y el ISR e IMSS
  // que de ahí se reportan. Y como el asiento está posteado, sólo se deshace
  // con una reversa que también queda en libros.
  //
  // El filtro va DENTRO del SQL y no en una comprobación previa a propósito:
  // este servicio es quien llama a `createJournalEntry(pr.entity_id, …)`, y
  // comprobar antes en la ruta deja una ventana entre mirar y escribir.
  //
  // No encuentra = no existe: el llamador no puede distinguir la corrida ajena
  // de una inventada, que es lo que impide usar esta puerta para descubrir qué
  // sociedades hay.
  if (prResult.rows.length === 0) throw new NotFoundError('Pay run', payRunId);
  const pr = prResult.rows[0];

  // ONLY A SEALED RUN REACHES THE LEDGER. This used to post a `draft` or a
  // `calculated` run, whose paychecks can still be recalculated: the ledger
  // would carry figures the run itself no longer has.
  if (pr.status !== 'approved' && pr.status !== 'paid') {
    throw new ConflictError(
      `Pay run ${payRunId} is ${pr.status}; only an approved or paid run is posted (approve it first)`
    );
  }
  // ONE RUN, ONE ENTRY. A second post used to write a second posted entry
  // and overwrite the link to the first one.
  if (pr.journal_entry_id !== null) {
    throw new ConflictError(`Pay run ${payRunId} is already posted as entry ${pr.journal_entry_id}`);
  }
  // A draft waiting for review, or already approved by it, is the run's entry
  // too: posting another one would book the payroll twice.
  const live = await client.query<{ id: string; status: string }>(
    `SELECT id, status FROM ai_drafts
      WHERE tenant_id = $1 AND entity_id = $2 AND payload->>'reference' = $3
        AND status IN ('pending_review', 'approved')
      LIMIT 1`,
    [tenantId, entityId, payRunReference(payRunId)]
  );
  if (live.rows.length > 0) {
    const d = live.rows[0];
    throw new ConflictError(
      d.status === 'pending_review'
        ? `Pay run ${payRunId} already has draft ${d.id} awaiting \`mnemosine review\`; approve or reject it there`
        : `Pay run ${payRunId} was already posted through review (draft ${d.id})`
    );
  }

  // Aggregate tax breakdown across all paychecks
  const breakdownResult = await client.query<{
    fit: string; fica_ss_ee: string; fica_med_ee: string; addl_med: string; sit: string; sdi: string;
    local_tax: string;
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
       COALESCE(SUM(local_tax_withheld), 0) AS local_tax,
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

  const accounts = await resolveAccounts(client, pr.entity_id);
  const required = ['wages_expense', 'payroll_tax_expense', 'cash_payroll'];
  for (const k of required) {
    if (!accounts[k]) throw new Error(`Missing payroll_account_mapping for bucket: ${k}`);
  }

  const lines: PayRunEntryLine[] = [];
  const debit = (a: MappedAccount, amount: string, description: string): void => {
    lines.push({ account_id: a.id, account_code: a.code, debit_amount: amount, credit_amount: null, description });
  };
  const credit = (a: MappedAccount, amount: string, description: string): void => {
    lines.push({ account_id: a.id, account_code: a.code, debit_amount: null, credit_amount: amount, description });
  };

  const n = (s: string): number => parseFloat(s);
  const totalGross = parseFloat(pr.totals_gross);
  const totalNet = parseFloat(pr.totals_net);
  const totalErTaxes = parseFloat(pr.totals_er_taxes);

  // DR: Wages expense (gross)
  debit(accounts.wages_expense, totalGross.toFixed(2), `Gross wages for pay run ${payRunId.slice(0, 8)}`);

  // DR: Payroll tax expense (employer-only taxes)
  if (totalErTaxes > 0) {
    debit(accounts.payroll_tax_expense, totalErTaxes.toFixed(2), 'Employer payroll taxes');
  }

  // CR: Cash payroll (net pay)
  credit(accounts.cash_payroll, totalNet.toFixed(2), 'Net pay disbursement');

  const creditIfPresent = (bucket: string, amount: number, desc: string) => {
    if (amount <= 0) return;
    const acct = accounts[bucket];
    if (!acct) return;
    credit(acct, amount.toFixed(2), desc);
  };

  // Employee withholding payables
  creditIfPresent('fit_payable', n(b.fit), 'FIT withheld');
  creditIfPresent('fica_payable', n(b.fica_ss_ee) + n(b.fica_med_ee) + n(b.addl_med) + n(b.fica_ss_er) + n(b.fica_med_er), 'FICA EE+ER');
  creditIfPresent('futa_payable', n(b.futa), 'FUTA');
  creditIfPresent('suta_payable', n(b.suta), 'SUTA');
  // EL IMPUESTO LOCAL ENTRA AQUÍ, Y SU AUSENCIA IMPEDÍA POSTEAR (T20 · #127).
  //
  // `local_tax_withheld` se calcula y SE PERSISTE en el recibo desde F08a, así
  // que el neto del trabajador ya lo descuenta — pero este agregado no lo
  // sumaba, de modo que al asiento le faltaba ese abono y los débitos dejaban
  // de igualar a los créditos: `Payroll GL entry unbalanced`, y la corrida
  // entera no llegaba al mayor. Cualquier recibo con impuesto local > 0
  // bloqueaba el posteo de su nómina.
  //
  // Va a la misma cubeta que el estatal porque la cuenta se llama así: 2154
  // «State and Local Tax Payable». No hace falta cuenta nueva ni semilla
  // nueva; hacía falta mandarle el importe.
  creditIfPresent('state_tax_payable', n(b.sit) + n(b.sdi) + n(b.local_tax), 'State + local tax + SDI');
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
    debit(
      cuenta,
      entregado.toFixed(2),
      registro.valor === 'cuenta_por_cobrar_fisco'
        ? 'Subsidio al empleo entregado en efectivo (acreditable contra ISR retenido)'
        : 'Subsidio al empleo entregado en efectivo (absorbido por el patrón)'
    );
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

  return {
    payRunId,
    entityId: pr.entity_id,
    entryDate: toCalendarDate(pr.pay_date),
    description: `Payroll run ${payRunId.slice(0, 8)}`,
    reference: payRunReference(payRunId),
    lines,
    totalDebits: totalDebits.toFixed(2),
    totalCredits: totalCredits.toFixed(2),
  };
}

/**
 * THE DRY RUN of `pay-run post`: the same lock, the same refusals and the same
 * lines as the two roads below, in a transaction that only reads.
 */
export async function previewPayRunEntry(
  payRunId: string,
  tenantId: string,
  entityId: string
): Promise<PayRunEntry> {
  return withTransaction((client) => buildPayRunEntry(client, payRunId, tenantId, entityId));
}

/**
 * THE DEFAULT ROAD: the entry becomes a draft for `mnemosine review`, which
 * validates it again and posts it under the reviewer's name. The draft is
 * inserted under the run's lock, so no second draft and no direct post can
 * slip in between the check and the insert.
 */
export async function draftPayRunEntry(
  payRunId: string,
  tenantId: string,
  entityId: string
): Promise<{ draftId: string; entry: PayRunEntry }> {
  return withTransaction(async (client) => {
    const entry = await buildPayRunEntry(client, payRunId, tenantId, entityId);
    const payload: DraftPayload = {
      entry_date: entry.entryDate,
      description: entry.description,
      reference: entry.reference,
      lines: entry.lines.map((l) => ({
        account_code: l.account_code,
        ...(l.debit_amount !== null ? { debit: Number(l.debit_amount) } : { credit: Number(l.credit_amount) }),
        description: l.description,
      })),
    };
    const draft = await createDraft(
      { tenantId, entityId: entry.entityId },
      {
        payload,
        // The figures are the engine's and the accounts the firm's mapping:
        // nothing here is a guess. What the review adds is a person's yes.
        confidence: 1,
        reasoning:
          `Journal entry of approved pay run ${payRunId}: gross wages and employer taxes against net pay ` +
          'and each withholding payable, from payroll_account_mapping.',
        model: DRAFT_PRODUCER,
      },
      client
    );
    return { draftId: draft.id, entry };
  });
}

/**
 * THE ESCAPE: posts the entry directly (`pay-run post --post`, and the REST
 * route). The entry and the link on the run commit together or not at all.
 */
export async function postPayRunToGL(
  payRunId: string,
  userId: string,
  tenantId: string,
  entityId: string
): Promise<string> {
  return (await postPayRunEntry(payRunId, userId, tenantId, entityId)).journalEntryId;
}

/** `postPayRunToGL` with the entry and its number, for a caller that prints them. */
export async function postPayRunEntry(
  payRunId: string,
  userId: string,
  tenantId: string,
  entityId: string
): Promise<{ journalEntryId: string; entryNumber: string; entry: PayRunEntry }> {
  const result = await withTransaction(async (client) => {
    const entry = await buildPayRunEntry(client, payRunId, tenantId, entityId);
    const je = await createJournalEntry(
      entry.entityId,
      entry.entryDate,
      JournalEntryType.PAYROLL,
      entry.description,
      entry.lines.map(({ account_id, debit_amount, credit_amount, description }) => ({
        account_id,
        debit_amount,
        credit_amount,
        description,
      })),
      userId,
      { sourceType: 'pay_run', sourceId: payRunId, reference: payRunId, autoPost: true, client }
    );
    const linked = await client.query(
      `UPDATE pay_runs SET journal_entry_id = $1
        WHERE id = $2 AND tenant_id = $3 AND journal_entry_id IS NULL`,
      [je.id, payRunId, tenantId]
    );
    if (linked.rowCount !== 1) {
      throw new ConflictError(`Pay run ${payRunId} changed while it was being posted; nothing was written`);
    }
    return { journalEntryId: je.id, entryNumber: je.entry_number, entry };
  });
  // The attestation reads the entry back, so it runs after the commit.
  attestEntryAsync(tenantId, result.entry.entityId, result.journalEntryId);
  return result;
}
