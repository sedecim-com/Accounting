import Decimal from 'decimal.js';
import { query, withTransaction, currentTenant } from '../../database/connection.js';
import { getPolicy } from '../policy/policy-service.js';
import { registrarAuditoria } from '../audit/audit-log.js';
import { createJournalEntry, attestEntryAsync } from './posting.js';
import { AccountingError } from '../../utils/errors.js';
import type { FiscalPeriod, JournalEntryType } from '../../types/index.js';

interface PeriodCloseChecklist {
  item: string;
  is_complete: boolean;
  details?: string;
}

interface PeriodCloseStatus {
  can_close: boolean;
  blocking_issues: string[];
  warnings: string[];
  checklist: PeriodCloseChecklist[];
}

export async function getPeriodCloseStatus(
  periodId: string,
  entityId: string,
  client?: pg.PoolClient
): Promise<PeriodCloseStatus> {
  // Con `client`, el checklist corre DENTRO de la transacción del cierre,
  // con la fila del periodo ya bajo FOR UPDATE (R1): la foto y el acto son
  // el mismo instante. Sin él, es la consulta informativa de siempre.
  const q = <T extends Record<string, unknown>>(sql: string, params: unknown[]) =>
    client ? client.query<T>(sql, params) : query<T>(sql, params);
  const blocking_issues: string[] = [];
  const warnings: string[] = [];
  const checklist: PeriodCloseChecklist[] = [];

  // 1. Check all journal entries are posted
  const draftEntries = await q<{ count: string }>(
    `SELECT COUNT(*) as count FROM journal_entries
     WHERE fiscal_period_id = $1 AND entity_id = $2 AND status IN ('draft', 'pending_approval')`,
    [periodId, entityId]
  );
  const draftCount = parseInt(draftEntries.rows[0].count, 10);
  checklist.push({
    item: 'All journal entries posted',
    is_complete: draftCount === 0,
    details: draftCount > 0 ? `${draftCount} entries still in draft/pending` : undefined,
  });
  if (draftCount > 0) blocking_issues.push(`${draftCount} unposted journal entries`);

  // 2. Check bank reconciliations complete
  const unreconciledAccounts = await q<{ count: string }>(
    `SELECT COUNT(*) as count FROM bank_accounts ba
     WHERE ba.entity_id = $1 AND ba.is_active = true
     AND NOT EXISTS (
       SELECT 1 FROM reconciliation_sessions rs
       WHERE rs.bank_account_id = ba.id
       AND rs.status IN ('balanced', 'approved', 'posted')
       AND rs.end_date >= (SELECT end_date FROM fiscal_periods WHERE id = $2)
     )`,
    [entityId, periodId]
  );
  const unreconCount = parseInt(unreconciledAccounts.rows[0].count, 10);
  checklist.push({
    item: 'Bank reconciliations complete',
    is_complete: unreconCount === 0,
    details: unreconCount > 0 ? `${unreconCount} accounts not reconciled` : undefined,
  });
  if (unreconCount > 0) warnings.push(`${unreconCount} bank accounts not reconciled`);

  // 3. Check invoices reviewed
  const draftInvoices = await q<{ count: string }>(
    `SELECT COUNT(*) as count FROM invoices
     WHERE entity_id = $1
     AND invoice_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2)
                           AND (SELECT end_date FROM fiscal_periods WHERE id = $2)
     AND status = 'draft'`,
    [entityId, periodId]
  );
  const draftInvCount = parseInt(draftInvoices.rows[0].count, 10);
  checklist.push({
    item: 'All invoices reviewed',
    is_complete: draftInvCount === 0,
    details: draftInvCount > 0 ? `${draftInvCount} draft invoices` : undefined,
  });
  if (draftInvCount > 0) warnings.push(`${draftInvCount} draft invoices in period`);

  // 4. Check depreciation calculated
  const undepreciatedAssets = await q<{ count: string }>(
    `SELECT COUNT(*) as count FROM fixed_assets fa
     WHERE fa.entity_id = $1 AND fa.status = 'active'
     AND NOT EXISTS (
       SELECT 1 FROM depreciation_schedules ds
       WHERE ds.asset_id = fa.id AND ds.fiscal_period_id = $2 AND ds.is_posted = true
     )`,
    [entityId, periodId]
  );
  const undepCount = parseInt(undepreciatedAssets.rows[0].count, 10);
  checklist.push({
    item: 'Depreciation calculated and posted',
    is_complete: undepCount === 0,
    details: undepCount > 0 ? `${undepCount} assets without depreciation` : undefined,
  });
  if (undepCount > 0) warnings.push(`${undepCount} assets without depreciation posted`);

  // 5. Trial balance check
  const trialBalance = await q<{ diff: string }>(
    `SELECT ABS(SUM(COALESCE(debit_total, 0)) - SUM(COALESCE(credit_total, 0))) as diff
     FROM account_balances
     WHERE fiscal_period_id = $1 AND entity_id = $2`,
    [periodId, entityId]
  );
  const tbDiff = new Decimal(trialBalance.rows[0]?.diff || '0');
  checklist.push({
    item: 'Trial balance balanced',
    is_complete: tbDiff.lessThanOrEqualTo('0.01'),
    details: tbDiff.greaterThan('0.01') ? `Out of balance by ${tbDiff.toFixed(4)}` : undefined,
  });
  if (tbDiff.greaterThan('0.01')) blocking_issues.push(`Trial balance out of balance by ${tbDiff.toFixed(4)}`);

  // 6. F02 · REP-2: el checklist del IVA aparcado. Dos conteos que el cierre
  // no miraba: los REP que llegaron y quedaron aparcados (needs_review), y
  // los pagos del periodo sin REP — recibidos (el IVA sigue en 1135, no es
  // acreditable) y emitidos (obligación fiscal PROPIA con plazo). Si cada
  // uno bloquea o solo avisa lo deciden rep_faltante_recibido y
  // rep_faltante_emitido: SOLO el literal 'bloquear' bloquea (cerrado al
  // declarar); 'avisar' o un valor desconocido avisan — un valor raro del
  // panel no puede congelar el cierre de un despacho.
  const tenantRow = await q<{ tenant_id: string }>(
    `SELECT tenant_id FROM legal_entities WHERE id = $1`,
    [entityId]
  );
  const ctxPanel = { tenantId: tenantRow.rows[0]?.tenant_id, entityId };

  const repAparcados = await q<{ count: string }>(
    `SELECT COUNT(*) as count FROM pre_registrations
      WHERE entity_id = $1 AND document_type = 'payment'
        AND validation_status = 'needs_review'
        AND status NOT IN ('completed', 'rejected', 'duplicate')`,
    [entityId]
  );
  const aparcados = parseInt(repAparcados.rows[0].count, 10);
  checklist.push({
    item: 'Parked payment receipts (REP) resolved',
    is_complete: aparcados === 0,
    details: aparcados > 0 ? `${aparcados} REP(s) esperando decisión: rep reconcile los reintenta` : undefined,
  });
  if (aparcados > 0) warnings.push(`${aparcados} REP(s) aparcados en needs_review`);

  const sinRep = await q<{ recibidos: string; emitidos: string }>(
    `SELECT
       (SELECT COUNT(*) FROM vendor_payments vp
         WHERE vp.entity_id = $1 AND vp.cfdi_uuid IS NULL AND vp.status <> 'void'
           AND vp.payment_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2)
                                   AND (SELECT end_date FROM fiscal_periods WHERE id = $2))::text AS recibidos,
       (SELECT COUNT(*) FROM customer_payments cp
         WHERE cp.entity_id = $1 AND cp.cfdi_uuid IS NULL AND cp.status <> 'void'
           AND cp.payment_date BETWEEN (SELECT start_date FROM fiscal_periods WHERE id = $2)
                                   AND (SELECT end_date FROM fiscal_periods WHERE id = $2))::text AS emitidos`,
    [entityId, periodId]
  );
  const pagosSinRepRecibidos = parseInt(sinRep.rows[0].recibidos, 10);
  const pagosSinRepEmitidos = parseInt(sinRep.rows[0].emitidos, 10);
  checklist.push({
    item: 'Payments in period have their REP',
    is_complete: pagosSinRepRecibidos + pagosSinRepEmitidos === 0,
    details:
      pagosSinRepRecibidos + pagosSinRepEmitidos > 0
        ? `${pagosSinRepRecibidos} pago(s) sin REP del proveedor, ${pagosSinRepEmitidos} cobro(s) sin REP emitido (rep missing list)`
        : undefined,
  });
  if (pagosSinRepRecibidos > 0) {
    const pol = await getPolicy(ctxPanel, 'rep_faltante_recibido');
    (pol.value === 'bloquear' ? blocking_issues : warnings).push(
      `${pagosSinRepRecibidos} pago(s) a proveedor sin REP: el IVA sigue aparcado en 1135`
    );
  }
  if (pagosSinRepEmitidos > 0) {
    const pol = await getPolicy(ctxPanel, 'rep_faltante_emitido');
    (pol.value === 'bloquear' ? blocking_issues : warnings).push(
      `${pagosSinRepEmitidos} cobro(s) sin REP emitido: obligación fiscal propia con plazo`
    );
  }

  return {
    can_close: blocking_issues.length === 0,
    blocking_issues,
    warnings,
    checklist,
  };
}

export async function softClosePeriod(
  periodId: string,
  entityId: string,
  userId: string,
  reason?: string
): Promise<FiscalPeriod> {
  // Cierre y rastro en la MISMA transacción. Antes eran dos query()
  // independientes: si el renglón de auditoría fallaba, el periodo quedaba
  // cerrado sin constancia de quién lo cerró. Y desde R1 el CHECKLIST también
  // vive dentro: se evaluaba fuera, así que un posteo en vuelo podía
  // confirmar entre la foto y el UPDATE — el periodo cerraba con un checklist
  // que no lo contaba. El FOR UPDATE de la fila se cruza con el FOR SHARE que
  // todo posteo toma (posting.ts): la foto y el acto son el mismo instante.
  return withTransaction(async (client) => {
    const candado = await client.query<{ status: string }>(
      'SELECT status FROM fiscal_periods WHERE id = $1 AND entity_id = $2 FOR UPDATE',
      [periodId, entityId]
    );
    if (candado.rows.length === 0) {
      throw new AccountingError('PERIOD_NOT_FOUND', 'Fiscal period not found');
    }
    if (candado.rows[0].status !== 'open') {
      throw new AccountingError('PERIOD_NOT_OPEN', 'Period is not in open status');
    }

    const status = await getPeriodCloseStatus(periodId, entityId, client);
    if (!status.can_close) {
      throw new AccountingError(
        'CANNOT_CLOSE_PERIOD',
        `Cannot close period: ${status.blocking_issues.join('; ')}`
      );
    }

    const result = await client.query<FiscalPeriod>(
      `UPDATE fiscal_periods
       SET status = 'soft_close', soft_close_date = NOW(), closed_by = $1,
           close_checklist = $2
       WHERE id = $3 AND entity_id = $4 AND status = 'open'
       RETURNING *`,
      [userId, JSON.stringify(status.checklist), periodId, entityId]
    );

    if (result.rows.length === 0) {
      throw new AccountingError('PERIOD_NOT_OPEN', 'Period is not in open status');
    }

    await registrarAuditoria(client, {
      tenantId: await inquilinoDe(client, entityId),
      userId,
      action: 'close',
      entityType: 'fiscal_period',
      entityId: periodId,
      newValues: { status: 'soft_close' },
      reason,
    });

    return result.rows[0];
  });
}

/** El inquilino del contexto, o el de la entidad. */
async function inquilinoDe(client: pg.PoolClient, entityId: string): Promise<string> {
  const delContexto = currentTenant();
  if (delContexto) return delContexto;
  const r = await client.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM legal_entities WHERE id = $1',
    [entityId]
  );
  const tenantId = r.rows[0]?.tenant_id;
  if (!tenantId) {
    throw new AccountingError(
      'TENANT_NO_RESUELTO',
      `No se pudo determinar el inquilino de la entidad ${entityId}: el cierre no se registra sin rastro.`
    );
  }
  return tenantId;
}

export async function hardClosePeriod(
  periodId: string,
  entityId: string,
  userId: string,
  reason?: string
): Promise<FiscalPeriod> {
  // Closing entries are created with the transaction's client (atomic with
  // the hard close), so attestation must fire here, AFTER commit.
  const closingEntryIds: string[] = [];
  const closed = await withTransaction(async (client) => {
    // Verify soft_close
    const periodResult = await client.query<FiscalPeriod>(
      'SELECT * FROM fiscal_periods WHERE id = $1 AND entity_id = $2 FOR UPDATE',
      [periodId, entityId]
    );

    if (periodResult.rows.length === 0) {
      throw new AccountingError('PERIOD_NOT_FOUND', 'Fiscal period not found');
    }

    const period = periodResult.rows[0];

    if (period.status !== 'soft_close') {
      throw new AccountingError(
        'PERIOD_NOT_SOFT_CLOSED',
        'Period must be in soft_close status before hard close'
      );
    }

    // Check if this is a year-end period (last period in fiscal year)
    const isYearEnd = await client.query<{ is_last: boolean }>(
      `SELECT (fp.period_number = MAX(fp2.period_number)) as is_last
       FROM fiscal_periods fp
       JOIN fiscal_periods fp2 ON fp2.fiscal_year_id = fp.fiscal_year_id
       WHERE fp.id = $1
       GROUP BY fp.period_number`,
      [periodId]
    );

    // Generate closing entries for year-end
    if (isYearEnd.rows[0]?.is_last) {
      closingEntryIds.push(
        ...(await generateClosingEntries(client, entityId, periodId, userId, new Date(period.end_date)))
      );
    }

    // Carry balance-sheet endings into the next period's beginnings.
    // Runs AFTER closing entries so a year-end carry already reflects the
    // P&L swept into retained earnings.
    await carryForwardBalances(client, entityId, periodId);

    // Hard close
    await client.query(
      `UPDATE fiscal_periods
       SET status = 'hard_close', hard_close_date = NOW()
       WHERE id = $1`,
      [periodId]
    );

    // El sello duro deja rastro en la misma transacción, igual que el suave.
    // Antes NO auditaba nada: el único vestigio era hard_close_date, sin
    // quién ni por qué — y es el acto que genera asientos de cierre y
    // arrastra saldos.
    await registrarAuditoria(client, {
      tenantId: await inquilinoDe(client, entityId),
      userId,
      action: 'close',
      entityType: 'fiscal_period',
      entityId: periodId,
      oldValues: { status: 'soft_close' },
      newValues: { status: 'hard_close', closing_entries: closingEntryIds.length },
      reason,
    });

    // Lock all journal entries in this period
    await client.query(
      `UPDATE journal_entries
       SET status = CASE WHEN status = 'posted' THEN 'posted' ELSE status END
       WHERE fiscal_period_id = $1 AND entity_id = $2`,
      [periodId, entityId]
    );

    const result = await client.query<FiscalPeriod>(
      'SELECT * FROM fiscal_periods WHERE id = $1',
      [periodId]
    );

    return result.rows[0];
  });

  const tenantId = currentTenant();
  if (tenantId) {
    for (const entryId of closingEntryIds) {
      attestEntryAsync(tenantId, entityId, entryId);
    }
  }
  return closed;
}

/**
 * Seeds the NEXT period's account_balances with the closed period's ending
 * balances as beginning_balance — balance-sheet accounts only (P&L accounts
 * reset yearly through closing entries and hold per-period activity).
 * Invariant kept everywhere: ending = beginning + debit_total - credit_total,
 * in the ledger's sign convention (positive = debit nature).
 * Idempotent: recomputes from components on conflict. Returns the number of
 * accounts carried (0 when no next period exists yet).
 */
export async function carryForwardBalances(
  client: pg.PoolClient,
  entityId: string,
  closedPeriodId: string
): Promise<number> {
  const next = await client.query<{ id: string }>(
    `SELECT id FROM fiscal_periods
     WHERE entity_id = $1
       AND start_date > (SELECT end_date FROM fiscal_periods WHERE id = $2)
     ORDER BY start_date ASC LIMIT 1`,
    [entityId, closedPeriodId]
  );
  if (next.rows.length === 0) return 0; // next year not created yet — nothing to seed

  const nextPeriodId = next.rows[0].id;
  const result = await client.query(
    `INSERT INTO account_balances (
        account_id, fiscal_period_id, entity_id,
        beginning_balance, debit_total, credit_total, ending_balance)
     SELECT ab.account_id, $3, ab.entity_id,
            ab.ending_balance, 0, 0, ab.ending_balance
     FROM account_balances ab
     JOIN accounts a ON a.id = ab.account_id
     WHERE ab.fiscal_period_id = $2 AND ab.entity_id = $1
       AND a.account_type IN ('asset', 'liability', 'equity',
                              'contra_asset', 'contra_liability', 'contra_equity')
       AND ab.ending_balance <> 0
     ON CONFLICT (account_id, fiscal_period_id)
     DO UPDATE SET
       beginning_balance = EXCLUDED.beginning_balance,
       ending_balance = EXCLUDED.beginning_balance
                        + account_balances.debit_total - account_balances.credit_total,
       updated_at = NOW()`,
    [entityId, closedPeriodId, nextPeriodId]
  );
  return result.rowCount ?? 0;
}

async function generateClosingEntries(
  client: pg.PoolClient,
  entityId: string,
  periodId: string,
  userId: string,
  periodEndDate: Date
): Promise<string[]> {
  // Income Summary (3900 "Resumen de Ingresos y Gastos") and Retained
  // Earnings (3200 "Resultado de Ejercicios Anteriores").
  // Resolution is by CODE: both are equity, so matching on account_type
  // picked the SAME account twice and the Income Summary → Retained
  // Earnings entry debited and credited itself. The code must be 3200, not
  // 3100: 3100 is "Capital Social", and sweeping the year's result into
  // share capital both misstates equity and violates NIF C-11 (capital
  // social only moves by formal corporate acts).
  const systemAccounts = await client.query<{ id: string; code: string }>(
    `SELECT id, code FROM accounts
     WHERE entity_id = $1 AND is_system_account = true
     AND code IN ('3900', '3200')`,
    [entityId]
  );

  const incomeSummaryId = systemAccounts.rows.find((a) => a.code === '3900')?.id;
  const retainedEarningsId = systemAccounts.rows.find((a) => a.code === '3200')?.id;
  if (!incomeSummaryId || !retainedEarningsId) return []; // System accounts not set up

  const createdIds: string[] = [];

  // 1. Close Revenue accounts. Balances aggregate over EVERY period of the
  // fiscal year being closed: per-period rows hold activity only (P&L
  // accounts do not carry forward), so closing just the last period (the
  // old query) left the earlier months' P&L unclosed.
  const revenueAccounts = await client.query<{ id: string; balance: string }>(
    `SELECT ab.account_id as id,
            SUM(ab.debit_total - ab.credit_total) as balance
     FROM account_balances ab
     JOIN accounts a ON a.id = ab.account_id
     JOIN fiscal_periods fp ON fp.id = ab.fiscal_period_id
     WHERE a.entity_id = $1 AND a.account_type = 'revenue'
     AND fp.fiscal_year_id = (SELECT fiscal_year_id FROM fiscal_periods WHERE id = $2)
     GROUP BY ab.account_id`,
    [entityId, periodId]
  );

  const closingLines: Array<{
    account_id: string;
    debit_amount: string | null;
    credit_amount: string | null;
    description: string;
  }> = [];

  let totalRevenue = new Decimal(0);
  for (const rev of revenueAccounts.rows) {
    const balance = new Decimal(rev.balance);
    if (balance.isZero()) continue;

    closingLines.push({
      account_id: rev.id,
      debit_amount: balance.abs().toFixed(4),
      credit_amount: null,
      description: 'Close revenue to Income Summary',
    });
    totalRevenue = totalRevenue.plus(balance.abs());
  }

  if (totalRevenue.greaterThan(0)) {
    closingLines.push({
      account_id: incomeSummaryId,
      debit_amount: null,
      credit_amount: totalRevenue.toFixed(4),
      description: 'Revenue closed to Income Summary',
    });
  }

  // 2. Close Expense accounts (same full-fiscal-year aggregation)
  const expenseAccounts = await client.query<{ id: string; balance: string }>(
    `SELECT ab.account_id as id,
            SUM(ab.debit_total - ab.credit_total) as balance
     FROM account_balances ab
     JOIN accounts a ON a.id = ab.account_id
     JOIN fiscal_periods fp ON fp.id = ab.fiscal_period_id
     WHERE a.entity_id = $1 AND a.account_type = 'expense'
     AND fp.fiscal_year_id = (SELECT fiscal_year_id FROM fiscal_periods WHERE id = $2)
     GROUP BY ab.account_id`,
    [entityId, periodId]
  );

  let totalExpenses = new Decimal(0);
  for (const exp of expenseAccounts.rows) {
    const balance = new Decimal(exp.balance);
    if (balance.isZero()) continue;

    closingLines.push({
      account_id: exp.id,
      debit_amount: null,
      credit_amount: balance.abs().toFixed(4),
      description: 'Close expense to Income Summary',
    });
    totalExpenses = totalExpenses.plus(balance.abs());
  }

  if (totalExpenses.greaterThan(0)) {
    closingLines.push({
      account_id: incomeSummaryId,
      debit_amount: totalExpenses.toFixed(4),
      credit_amount: null,
      description: 'Expenses closed to Income Summary',
    });
  }

  // Create closing journal entry (revenue + expenses). Dated at the END of
  // the period being closed — new Date() (the old code) landed them in the
  // CURRENT open period, so the closed year's P&L never zeroed out in its
  // own period. Same client: atomic with the hard close.
  if (closingLines.length > 0) {
    const entry = await createJournalEntry(
      entityId,
      periodEndDate,
      'closing' as JournalEntryType,
      'Year-end closing entries',
      closingLines,
      userId,
      { autoPost: true, client }
    );
    createdIds.push(entry.id);
  }

  // 3. Close Income Summary to Retained Earnings
  const netIncome = totalRevenue.minus(totalExpenses);
  if (!netIncome.isZero()) {
    const isProfit = netIncome.greaterThan(0);
    const entry = await createJournalEntry(
      entityId,
      periodEndDate,
      'closing' as JournalEntryType,
      'Close Income Summary to Retained Earnings',
      [
        {
          account_id: incomeSummaryId,
          debit_amount: isProfit ? netIncome.toFixed(4) : null,
          credit_amount: isProfit ? null : netIncome.abs().toFixed(4),
          description: 'Close Income Summary',
        },
        {
          account_id: retainedEarningsId,
          debit_amount: isProfit ? null : netIncome.abs().toFixed(4),
          credit_amount: isProfit ? netIncome.toFixed(4) : null,
          description: `Net ${isProfit ? 'income' : 'loss'} to Retained Earnings`,
        },
      ],
      userId,
      { autoPost: true, client }
    );
    createdIds.push(entry.id);
  }

  return createdIds;
}

// Need to import pg for the client type
import pg from 'pg';
