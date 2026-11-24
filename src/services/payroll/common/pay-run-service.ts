import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../../database/connection.js';
import { calculatePaycheck, checkOvertimeLines, checkUsTaxTables, type EarningLine, type DeductionLine } from './paycheck-service.js';
import {
  acumularPasivoPatronal,
  hallazgosQueBloquean,
  type ResultadoAcumulacion,
} from './employer-liability-service.js';
import { dispatchEvent } from '../../webhooks/webhook-service.js';
import { payRunStateTransitions } from '../../../api/rest/middleware/metrics.js';
import type { Scope } from '../../../database/scope.js';
import { alcanceDeCorrida, periodoEnEntidad } from './alcance-nomina.js';
import { ConflictError, NotFoundError, ValidationError } from '../../../utils/errors.js';

// ============================================================
// PAY RUN ORCHESTRATOR
// Creates a pay run, iterates employees, computes paychecks,
// aggregates totals, transitions status.
// ============================================================

export interface EmployeePayInput {
  employee_id: string;
  earnings: EarningLine[];
  deductions?: DeductionLine[];
  hours_worked?: number;
}

export interface PayRunInput {
  tenant_id: string;
  pay_period_id: string;
  run_type?: 'regular' | 'bonus' | 'correction' | 'final' | 'off_cycle';
  employee_inputs: EmployeePayInput[];
  created_by: string;
}

/**
 * Creates a draft run over a pay period of the scope.
 *
 * The period is read INSIDE the scope (MNE-001-068): the REST route checked it
 * before calling, but a second door (the terminal) that forgot the check would
 * hang a run of this tenant on a sibling company's period. With the predicate
 * here, every caller gets the same 404 for a foreign period and a missing one.
 */
export async function createPayRun(input: PayRunInput, scope: Scope): Promise<string> {
  const entity = scope.kind === 'entity' ? ` AND ${periodoEnEntidad('pay_periods.id', 3)}` : '';
  const periodResult = await query<{ tax_year: number }>(
    `SELECT tax_year FROM pay_periods WHERE id = $1 AND tenant_id = $2${entity}`,
    scope.kind === 'entity'
      ? [input.pay_period_id, scope.tenantId, scope.entityId]
      : [input.pay_period_id, scope.tenantId]
  );
  if (periodResult.rows.length === 0) throw new NotFoundError('Pay period', input.pay_period_id);
  const taxYear = periodResult.rows[0].tax_year;

  const id = uuidv4();
  await query(
    `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
     VALUES ($1, $2, $3, $4, 'draft', $5, $6)`,
    [id, scope.tenantId, input.pay_period_id, input.run_type || 'regular', taxYear, input.created_by]
  );
  return id;
}

/**
 * Calculates a run WHOLE OR NOT AT ALL, and again while it is not approved
 * (MNE-001-657, #601).
 *
 * Everything the calculation writes goes through ONE transaction: the gate,
 * the removal of the paychecks the run had, each paycheck with its rows, and
 * the totals. It used to commit `calculating` and then paycheck by paycheck:
 * a failure for the third employee left two paychecks and a run that could
 * not be calculated again, since nothing removed them and the paycheck insert
 * refuses a duplicate on purpose. Now a failure anywhere rolls the run back
 * to the status, the totals and the paychecks it had.
 *
 * A second calculation REPLACES: the run holds the employees of the last
 * inputs and nobody else, which is what makes its totals the sum of its
 * paychecks. Whoever sent a run in several calls sends it in one.
 */
export async function calculatePayRun(
  payRunId: string,
  input: PayRunInput,
  scope: Scope
): Promise<void> {
  const totals = await withTransaction((client) => calculateRunOn(client, payRunId, input, scope));
  // After the commit: a webhook never announces a calculation that rolled back.
  await dispatchEvent(input.tenant_id, 'payroll.run.calculated', {
    pay_run_id: payRunId,
    total_gross: totals.gross,
    total_net: totals.net,
    employee_count: input.employee_inputs.length,
  });
  payRunStateTransitions.inc({ from: 'draft', to: 'calculated', country: 'unknown' });
}

/** The writes of one calculation, on the transaction that makes them one. */
async function calculateRunOn(
  client: PoolClient,
  payRunId: string,
  input: PayRunInput,
  scope: Scope
): Promise<{ gross: string; net: string }> {
  // LA PRIMERA ESCRITURA ES LA PUERTA, y no tenía cerradura: `WHERE id = $1`
  // a secas. Medido contra Postgres, `POST /pay-runs/<corrida de B>/calculate`
  // con una sesión de A contestaba 200 y dejaba la corrida de B con
  // `total_gross` en 0.00 y `employee_count` en 0 — o sea que el recálculo no
  // sólo miraba los libros de al lado: los reescribía. El alcance va aquí,
  // en la transición a `calculating`, porque todo lo que sigue cuelga de que
  // esta fila sea del alcance.
  //
  // And the gate carries its STATE (MNE-001-068). Without it an approved or
  // paid run went back to `calculating`: its employer liability was already
  // written, and its paychecks would now be replaced. Draft, calculated and a
  // run an earlier failure left in `calculating` may be calculated; a sealed
  // one may not.
  //
  // The row stays locked until the commit, so an approval or another
  // calculation of this run waits for this one instead of interleaving.
  const alcance = alcanceDeCorrida(scope, 'pay_runs.pay_period_id', 2);
  const puerta = await client.query(
    `UPDATE pay_runs SET status = 'calculating' WHERE id = $1 AND ${alcance.sql}
        AND status IN ('draft', 'calculating', 'calculated')`,
    [payRunId, ...alcance.valores]
  );
  if (puerta.rowCount === 0) {
    const current = await client.query<{ status: string }>(
      `SELECT status FROM pay_runs WHERE id = $1 AND ${alcance.sql}`,
      [payRunId, ...alcance.valores]
    );
    if (current.rows.length === 0) throw new NotFoundError('Pay run', payRunId);
    throw new ConflictError(
      `Cannot calculate pay run in status ${current.rows[0].status}: only draft or calculated runs are calculated`
    );
  }

  let totalGross = new Decimal(0);
  let totalPreTax = new Decimal(0);
  let totalPostTax = new Decimal(0);
  let totalEeTax = new Decimal(0);
  let totalErTax = new Decimal(0);
  let totalNet = new Decimal(0);

  // Overtime is checked for EVERY employee before the first paycheck is
  // calculated (MNE-001-110): a refused line costs no paycheck's work.
  for (const emp of input.employee_inputs) {
    await checkOvertimeLines({
      tenant_id: input.tenant_id,
      pay_run_id: payRunId,
      employee_id: emp.employee_id,
      earnings: emp.earnings,
    });
  }

  // The same for the US bracket tables (MNE-001-353): every employee and every
  // missing table is named in ONE error, before any paycheck exists.
  const missingTables: string[] = [];
  for (const emp of input.employee_inputs) {
    missingTables.push(...await checkUsTaxTables({
      tenant_id: input.tenant_id,
      pay_run_id: payRunId,
      employee_id: emp.employee_id,
      earnings: emp.earnings,
    }));
  }
  if (missingTables.length > 0) {
    throw new ValidationError(
      `The run cannot be calculated, no paycheck was written:\n${missingTables.join('\n')}`,
      'employee_inputs'
    );
  }

  // THE PAYCHECKS THE RUN HAD GO, with their earnings, deductions and taxes
  // (ON DELETE CASCADE): those of an earlier calculation, or those a failure
  // halfway left before this was one transaction. The run is named with the
  // gate's own predicate and must still be `calculating`, so the statement
  // carries the scope itself instead of leaning on the one before it.
  //
  // Except one that ALREADY LEFT THE SYSTEM. The payroll CFDI and the deposit
  // file refuse an unapproved run since MNE-001-720 (`runIsReleased`), but a
  // run whose paycheck was stamped or batched before that still holds it; a
  // stamp is cancelled before the SAT, not erased here. The statement counts
  // them as it deletes, and the refusal rolls the deletion back.
  const replaced = await client.query<{ left_the_system: number }>(
    `WITH gone AS (
       DELETE FROM paychecks
        WHERE paychecks.pay_run_id = $1 AND paychecks.tenant_id = $2
          AND EXISTS (SELECT 1 FROM pay_runs
                       WHERE pay_runs.id = paychecks.pay_run_id AND ${alcance.sql}
                         AND pay_runs.status = 'calculating')
       RETURNING cfdi_status, direct_deposit_batch_id
     )
     SELECT COUNT(*) FILTER (
              WHERE (cfdi_status IS NOT NULL AND cfdi_status <> 'failed')
                 OR direct_deposit_batch_id IS NOT NULL
            )::int AS left_the_system
       FROM gone`,
    [payRunId, ...alcance.valores]
  );
  if (replaced.rows[0].left_the_system > 0) {
    throw new ConflictError({
      key: 'payrun.calculate.paycheck_left_the_system',
      params: { id: payRunId, count: replaced.rows[0].left_the_system },
    });
  }

  for (const emp of input.employee_inputs) {
    const result = await calculatePaycheck(
      {
        tenant_id: input.tenant_id,
        pay_run_id: payRunId,
        employee_id: emp.employee_id,
        earnings: emp.earnings,
        deductions: emp.deductions,
        hours_worked: emp.hours_worked,
      },
      client
    );
    totalGross = totalGross.plus(result.gross_earnings);
    totalPreTax = totalPreTax.plus(result.pre_tax_deductions);
    totalPostTax = totalPostTax.plus(result.post_tax_deductions);
    totalEeTax = totalEeTax.plus(result.employee_taxes);
    totalErTax = totalErTax.plus(result.employer_taxes);
    totalNet = totalNet.plus(result.net_pay);
  }

  // El cierre lleva el alcance OTRA VEZ, con su propio índice. No es
  // redundante por gusto: la puerta de arriba y este cierre son dos viajes
  // separados, y entre ellos corre el cálculo entero de todos los recibos.
  // And its state: it closes the run this transaction opened, and a close
  // that touches no row is an error, not a silence.
  const alcanceFinal = alcanceDeCorrida(scope, 'pay_runs.pay_period_id', 10);
  const closing = await client.query(
    `UPDATE pay_runs SET
       status = 'calculated',
       total_gross = $1,
       total_pre_tax_deductions = $2,
       total_post_tax_deductions = $3,
       total_employee_taxes = $4,
       total_employer_taxes = $5,
       total_net_pay = $6,
       total_employer_cost = $7,
       employee_count = $8,
       calculated_at = NOW()
     WHERE id = $9 AND ${alcanceFinal.sql} AND status = 'calculating'`,
    [
      totalGross.toFixed(2),
      totalPreTax.toFixed(2),
      totalPostTax.toFixed(2),
      totalEeTax.toFixed(2),
      totalErTax.toFixed(2),
      totalNet.toFixed(2),
      totalGross.plus(totalErTax).toFixed(2),
      input.employee_inputs.length,
      payRunId,
      ...alcanceFinal.valores,
    ]
  );
  if (closing.rowCount !== 1) {
    throw new ConflictError({ key: 'payrun.calculate.changed_meanwhile', params: { id: payRunId } });
  }
  return { gross: totalGross.toFixed(2), net: totalNet.toFixed(2) };
}

export interface PayRunSummary {
  id: string;
  pay_period_id: string;
  run_type: string;
  status: string;
  tax_year_used: number;
  employee_count: number;
  total_gross: string;
  total_employee_taxes: string;
  total_employer_taxes: string;
  total_net_pay: string;
  total_employer_cost: string;
}

/** One run of the scope, or NotFoundError: a foreign run and a missing one answer alike. */
export async function getPayRun(payRunId: string, scope: Scope): Promise<PayRunSummary> {
  const runScope = alcanceDeCorrida(scope, 'pay_runs.pay_period_id', 2);
  const r = await query<PayRunSummary>(
    `SELECT id, pay_period_id, run_type, status, tax_year_used, employee_count,
            total_gross::text AS total_gross, total_employee_taxes::text AS total_employee_taxes,
            total_employer_taxes::text AS total_employer_taxes,
            total_net_pay::text AS total_net_pay, total_employer_cost::text AS total_employer_cost
       FROM pay_runs WHERE id = $1 AND ${runScope.sql}`,
    [payRunId, ...runScope.valores]
  );
  if (r.rows.length === 0) throw new NotFoundError('Pay run', payRunId);
  return r.rows[0];
}

/**
 * APROBAR ES CERRAR, Y AL CERRAR SE APUNTA LO QUE EL PATRÓN DEBE.
 *
 * La aprobación es el momento en que los números de la corrida dejan de
 * moverse, así que es el momento en que el pasivo patronal —IMSS e INFONAVIT
 * patronales, y el ISN de cada estado— pasa de ser un cálculo a ser una deuda
 * con fecha límite. Hasta esta pieza nadie escribía `employer_tax_liabilities`
 * y las formas que la suman reportaban ceros con aspecto de números.
 *
 * VA DENTRO DE LA MISMA TRANSACCIÓN que el cambio de estado, no después: si
 * el pasivo no se puede escribir, la corrida no queda aprobada. Una corrida
 * aprobada sin su pasivo es exactamente el estado que este tramo repara, y
 * dejarlo ocurrir «sólo cuando falla la segunda mitad» lo vuelve intermitente,
 * que es peor que constante.
 *
 * Lo que NO detiene la aprobación es una tasa de ISN sin capturar: eso vuelve
 * como hallazgo bloqueante en el resultado, con el estado y el periodo
 * nombrados, para que el llamador lo enseñe. Detener la nómina de todos porque
 * a un estado le falta el dato en el catálogo sería cambiar una omisión por
 * una parálisis; lo que no se permite es que se vuelva un cero silencioso.
 */
export async function approvePayRun(
  payRunId: string,
  approvedBy: string,
  scope: Scope,
  options: { dryRun?: boolean } = {}
): Promise<ResultadoAcumulacion> {
  let tenantId = '';
  let pasivo: ResultadoAcumulacion | undefined;
  const alcance = alcanceDeCorrida(scope, 'pay_runs.pay_period_id', 2);
  try {
    await withTransaction(async (client) => {
      // EL ALCANCE VA EN LA MISMA SENTENCIA QUE BLOQUEA (T9c · #96). La consulta
      // no llevaba ni inquilino: un id adivinado aprobaba la corrida de otro
      // despacho, y con ella el pasivo patronal y el permiso para postear y
      // pagar. La entidad tampoco la acotaba nadie —`pay_runs` no tiene
      // `entity_id`—, así que la sociedad hermana caía con sólo cambiar la
      // cabecera, guarda de entidad montada incluida: la guarda valida la
      // entidad DECLARADA, acotar la consulta es otra defensa, y hacen falta
      // las dos.
      //
      // Comprobar aquí y actualizar después por `id` a secas es correcto
      // porque el `FOR UPDATE` de esta misma línea tiene la fila tomada hasta
      // el final de la transacción. Fuera de una transacción con bloqueo, el
      // predicado tiene que ir en el UPDATE —ver `markPayRunPaid`.
      const res = await client.query<{ status: string; tenant_id: string }>(
        `SELECT status, tenant_id FROM pay_runs WHERE id = $1 AND ${alcance.sql} FOR UPDATE`,
        [payRunId, ...alcance.valores]
      );
      if (res.rows.length === 0) throw new NotFoundError('Pay run', payRunId);
      if (res.rows[0].status !== 'calculated') {
        throw new ConflictError(`Cannot approve pay run in status ${res.rows[0].status}`);
      }
      tenantId = res.rows[0].tenant_id;
      await client.query(
        `UPDATE pay_runs SET status = 'approved', approved_by = $1, approved_at = NOW() WHERE id = $2`,
        [approvedBy, payRunId]
      );
      pasivo = await acumularPasivoPatronal({ tenantId, payRunId }, client);
      // The rehearsal (MNE-001-068) is the real approval, rolled back: the
      // liability rows and the blocking findings it shows are the ones the
      // approval would write, not a second calculation of them.
      if (options.dryRun === true) throw new ApprovalRehearsal();
    });
  } catch (err) {
    if (!(err instanceof ApprovalRehearsal)) throw err;
    return pasivo!;
  }
  const resultado = pasivo!;
  await dispatchEvent(tenantId, 'payroll.run.approved', {
    pay_run_id: payRunId,
    approved_by: approvedBy,
    pasivo_renglones: resultado.renglones.length,
    hallazgos_bloqueantes: hallazgosQueBloquean(resultado.hallazgos).length,
  });
  payRunStateTransitions.inc({ from: 'calculated', to: 'approved', country: 'unknown' });
  return resultado;
}

/** Thrown inside the approval transaction to roll a rehearsal back. */
class ApprovalRehearsal extends Error {}

export async function markPayRunPaid(payRunId: string, scope: Scope): Promise<void> {
  // `status = 'paid'` AFIRMA QUE EL DINERO SALIÓ, y lo afirmaba sobre
  // cualquier corrida del sistema: un solo UPDATE por `id`, sin inquilino ni
  // entidad. Aquí el alcance va DENTRO del UPDATE y no en una comprobación
  // previa, porque esto no corre en transacción con bloqueo: mirar primero y
  // escribir después deja la ventana entre las dos sentencias.
  const alcance = alcanceDeCorrida(scope, 'pay_runs.pay_period_id', 2);
  const res = await query<{ tenant_id: string }>(
    `UPDATE pay_runs SET status = 'paid', paid_at = NOW()
     WHERE id = $1 AND ${alcance.sql} AND status = 'approved' RETURNING tenant_id`,
    [payRunId, ...alcance.valores]
  );
  if (res.rows[0]) {
    await dispatchEvent(res.rows[0].tenant_id, 'payroll.run.paid', { pay_run_id: payRunId });
    payRunStateTransitions.inc({ from: 'approved', to: 'paid', country: 'unknown' });
    return;
  }

  // Cero filas dice DOS cosas a la vez, y sólo una de ellas es un 404. La
  // segunda pregunta es por tanto si la corrida está en el alcance; el
  // predicado es el mismo, así que no reabre nada: el UPDATE de arriba ya se
  // negó a escribir, y esto sólo elige qué contestar.
  const visible = await query<{ status: string }>(
    `SELECT status FROM pay_runs WHERE id = $1 AND ${alcance.sql}`,
    [payRunId, ...alcance.valores]
  );
  if (visible.rows.length === 0) throw new NotFoundError('Pay run', payRunId);

  // Está en el alcance pero no aprobada. Sigue callando —era el
  // comportamiento de antes y no es lo que este tramo mide—, pero la ruta
  // contesta `{ ok: true }` sobre una corrida que NO se marcó pagada, que es
  // una mentira distinta y con dueño propio: ver #96.
}
