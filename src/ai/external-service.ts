import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../database/connection.js';
import { FLOOR_MAX_OP_AGE_DAYS, isOpStale } from './floor.js';
import { matchApproval, type MatchApprovalOpts } from './approval-policy.js';
import { getExternalAdapter } from '../services/integrations/accounting/registry.js';
import type {
  ExternalTrialBalanceRow,
  ManualPolicyInput,
} from '../services/integrations/accounting/accounting-adapter.interface.js';
import type { AgentContext } from './context.js';

// ============================================================
// EXTERNAL SYNC SERVICE
// - Direct pull (reads) from external accounting systems.
// - Deterministic diff of remote vs local trial balance (the AI
//   interprets, the code compares).
// - Outbox: writes to the external system stay pending and are
//   executed by the human (mnemosine outbox) with an atomic claim.
// ============================================================

const DIFF_TOLERANCE = new Decimal('0.01');

export interface TrialBalanceDiff {
  as_of: { start: string; end: string };
  matched_equal: number;
  differences: Array<{ account_code: string; local: string; remote: string; delta: string }>;
  only_local: Array<{ account_code: string; name: string; balance: string }>;
  only_remote: Array<{ account_code: string; name: string; balance: string }>;
}

/** Local (posted) balances per account at the cutoff — same criterion as get_trial_balance. */
async function fetchLocalBalances(
  entityId: string,
  endDate: string
): Promise<Map<string, { name: string; balance: Decimal }>> {
  const result = await query<{ code: string; name: string; balance: string }>(
    `SELECT a.code, a.name,
            COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) AS balance
     FROM accounts a
     LEFT JOIN (journal_entry_lines jel
                JOIN journal_entries je
                  ON je.id = jel.journal_entry_id
                 AND je.status = 'posted' AND je.entry_date <= $2)
            ON jel.account_id = a.id
     WHERE a.entity_id = $1 AND a.is_active = true
     GROUP BY a.id, a.code, a.name`,
    [entityId, endDate]
  );
  return new Map(result.rows.map((r) => [r.code, { name: r.name, balance: new Decimal(r.balance) }]));
}

/** Compares the external system's trial balance against the local one, account by account. */
export async function diffTrialBalance(
  ctx: AgentContext,
  provider: string,
  startDate: string,
  endDate: string
): Promise<TrialBalanceDiff> {
  const adapter = getExternalAdapter(provider);
  const [remoteRows, localMap] = await Promise.all([
    adapter.getTrialBalance(startDate, endDate),
    fetchLocalBalances(ctx.entityId, endDate),
  ]);

  const diff: TrialBalanceDiff = {
    as_of: { start: startDate, end: endDate },
    matched_equal: 0,
    differences: [],
    only_local: [],
    only_remote: [],
  };

  const remoteByCode = new Map<string, ExternalTrialBalanceRow>();
  for (const row of remoteRows) {
    if (row.account_code) remoteByCode.set(row.account_code, row);
  }

  for (const [code, remote] of remoteByCode) {
    const local = localMap.get(code);
    const remoteBalance = new Decimal(remote.ending_balance);
    if (!local) {
      if (!remoteBalance.abs().lessThanOrEqualTo(DIFF_TOLERANCE)) {
        diff.only_remote.push({
          account_code: code, name: remote.account_name, balance: remoteBalance.toFixed(2),
        });
      }
      continue;
    }
    if (local.balance.minus(remoteBalance).abs().greaterThan(DIFF_TOLERANCE)) {
      diff.differences.push({
        account_code: code,
        local: local.balance.toFixed(2),
        remote: remoteBalance.toFixed(2),
        delta: local.balance.minus(remoteBalance).toFixed(2),
      });
    } else {
      diff.matched_equal++;
    }
  }

  for (const [code, local] of localMap) {
    if (!remoteByCode.has(code) && !local.balance.abs().lessThanOrEqualTo(DIFF_TOLERANCE)) {
      diff.only_local.push({ account_code: code, name: local.name, balance: local.balance.toFixed(2) });
    }
  }

  return diff;
}

// ─── Outbox ───

export type ExternalOperation =
  | 'create_policy' | 'update_policy' | 'upload_xml' | 'bank_transaction' | 'reconcile_invoice';

export interface ExternalOpRow {
  id: string;
  provider: string;
  operation: ExternalOperation;
  payload: Record<string, unknown>;
  status: 'pending' | 'executing' | 'executed' | 'failed' | 'rejected';
  ai_reasoning: string;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: Date;
}

/** JSON.stringify with recursively sorted object keys (arrays keep order). */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Canonical sha256 (hex) of an outbox operation: provider + operation +
 * payload with a stable key order. The human executes THIS content —
 * executeExternalOp recomputes the hash after the atomic claim and
 * reverts the claim on mismatch (drift between review and execution).
 */
export function canonicalOpHash(
  provider: string,
  operation: string,
  payload: Record<string, unknown>
): string {
  return createHash('sha256')
    .update(stableStringify({ operation, payload, provider }))
    .digest('hex');
}

export async function queueExternalOp(
  ctx: AgentContext,
  input: {
    provider: string;
    operation: ExternalOperation;
    payload: Record<string, unknown>;
    reasoning: string;
    model: string;
    userRequest?: string;
  }
): Promise<string> {
  // Validate that the provider exists (and its credentials) BEFORE queueing,
  // so the AI receives the configuration error immediately.
  getExternalAdapter(input.provider);

  const id = uuidv4();
  await query(
    `INSERT INTO ai_external_ops (
      id, tenant_id, entity_id, provider, operation, payload, ai_reasoning, ai_model, user_request
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)`,
    [
      id, ctx.tenantId, ctx.entityId, input.provider, input.operation,
      JSON.stringify(input.payload), input.reasoning, input.model, input.userRequest ?? null,
    ]
  );
  return id;
}

export async function listExternalOps(
  ctx: AgentContext,
  status?: ExternalOpRow['status']
): Promise<ExternalOpRow[]> {
  const conditions = ['entity_id = $1'];
  const params: unknown[] = [ctx.entityId];
  if (status) {
    conditions.push('status = $2');
    params.push(status);
  }
  const result = await query<ExternalOpRow>(
    `SELECT id, provider, operation, payload, status, ai_reasoning, result, error, created_at
     FROM ai_external_ops WHERE ${conditions.join(' AND ')} ORDER BY created_at ASC`,
    params
  );
  return result.rows;
}

export async function rejectExternalOp(
  ctx: AgentContext,
  opId: string,
  reviewedBy: string,
  reason: string
): Promise<void> {
  const result = await query(
    `UPDATE ai_external_ops
     SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), error = $2
     WHERE id = $3 AND entity_id = $4 AND status = 'pending'`,
    [reviewedBy, reason, opId, ctx.entityId]
  );
  if (result.rowCount !== 1) {
    throw new Error(`No pending operation with id ${opId} exists in this entity`);
  }
}

/**
 * Manual recovery for an operation stranded in 'executing' (the process
 * died between the atomic claim and the terminal update). The human decides,
 * after checking the external system, whether the write landed:
 * - 'failed': the write may have landed — mark failed with a verify note.
 * - 'pending': the write did NOT land — return it to the review queue,
 *   clearing the claim's reviewed_by/reviewed_at.
 * Guarded on status = 'executing' so a concurrently-resolved row throws.
 */
export async function recoverExecutingOp(
  ctx: AgentContext,
  opId: string,
  reviewedBy: string,
  resolution: 'failed' | 'pending'
): Promise<void> {
  const result =
    resolution === 'failed'
      ? await query(
          `UPDATE ai_external_ops
           SET status = 'failed', reviewed_by = $1, reviewed_at = NOW(), error = $2
           WHERE id = $3 AND entity_id = $4 AND status = 'executing'`,
          [
            reviewedBy,
            'interrupted mid-execution; verify in the external system manually',
            opId,
            ctx.entityId,
          ]
        )
      : await query(
          `UPDATE ai_external_ops
           SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL, error = NULL
           WHERE id = $1 AND entity_id = $2 AND status = 'executing'`,
          [opId, ctx.entityId]
        );
  if (result.rowCount !== 1) {
    throw new Error(`No executing operation with id ${opId} exists in this entity`);
  }
}

/**
 * Executes an approved operation against the external system.
 * Atomic pending→executing claim: two outbox sessions cannot
 * execute the same operation twice.
 *
 * `expectedHash` binds the execution to exact content: pass the
 * canonicalOpHash computed when the operation was SHOWN to the human;
 * if the claimed row hashes differently, the claim is reverted to
 * pending and the execution aborted.
 */
export async function executeExternalOp(
  ctx: AgentContext,
  opId: string,
  reviewedBy: string,
  expectedHash?: string
): Promise<{ result: Record<string, unknown> }> {
  const claim = await query<ExternalOpRow>(
    `UPDATE ai_external_ops
     SET status = 'executing', reviewed_by = $1, reviewed_at = NOW()
     WHERE id = $2 AND entity_id = $3 AND status = 'pending'
     RETURNING id, provider, operation, payload, status, ai_reasoning, result, error, created_at`,
    [reviewedBy, opId, ctx.entityId]
  );
  if (claim.rowCount !== 1) {
    throw new Error(`No pending operation with id ${opId} exists (was it already executed or rejected?)`);
  }
  const op = claim.rows[0];

  // FLOOR: a stale approval must not execute. The op was reviewed against
  // a world that is FLOOR_MAX_OP_AGE_DAYS+ days old — reject it (guarded,
  // only our own claim) so it must be re-queued and re-reviewed. No
  // configuration raises this limit.
  if (isOpStale(op.created_at)) {
    const message =
      `Operation ${opId} was queued more than ${FLOOR_MAX_OP_AGE_DAYS} days ago; ` +
      'stale approvals are never executed — re-queue the operation for a fresh review';
    await query(
      `UPDATE ai_external_ops SET status = 'rejected', error = $1
       WHERE id = $2 AND entity_id = $3 AND status = 'executing'`,
      [message, opId, ctx.entityId]
    );
    throw new Error(message);
  }

  // Drift detection: the hash of what the human reviewed must match the
  // row we just claimed. On mismatch, revert OUR claim (guarded on the
  // executing status we set) so the op returns to the review queue.
  const contentHash = canonicalOpHash(op.provider, op.operation, op.payload);
  if (expectedHash !== undefined && contentHash !== expectedHash) {
    await query(
      `UPDATE ai_external_ops SET status = 'pending', reviewed_by = NULL, reviewed_at = NULL
       WHERE id = $1 AND entity_id = $2 AND status = 'executing'`,
      [opId, ctx.entityId]
    );
    throw new Error('Operation content changed after review; execution invalidated');
  }

  let result: Record<string, unknown>;
  try {
    const adapter = getExternalAdapter(op.provider);
    const p = op.payload;
    switch (op.operation) {
      case 'create_policy':
        result = await adapter.createManualPolicy(p as unknown as ManualPolicyInput);
        break;
      case 'update_policy':
        result = await adapter.updateManualPolicy(
          Number(p.policy_id),
          p as unknown as ManualPolicyInput
        );
        break;
      case 'upload_xml':
        result = await adapter.uploadXml(String(p.xml_base64), p.name ? String(p.name) : undefined);
        break;
      case 'bank_transaction':
        result = await adapter.createBankTransaction(p as never);
        break;
      case 'reconcile_invoice':
        result = await adapter.reconcileInvoice(p as never);
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Guarded failure transition: only OUR 'executing' claim may become
    // 'failed'. If the guard misses, the row was concurrently recovered
    // (mnemosine outbox) — the recovered status is left untouched; we
    // log and rethrow instead of clobbering it (never silent).
    const failed = await query(
      `UPDATE ai_external_ops SET status = 'failed', error = $1
       WHERE id = $2 AND entity_id = $3 AND status = 'executing'`,
      [message, opId, ctx.entityId]
    );
    if (failed.rowCount !== 1) {
      console.error(
        `Operation ${opId} failed against ${op.provider}, but its row was concurrently ` +
        `recovered out of 'executing'; the recovered status was left untouched`
      );
    }
    throw new Error(`The operation failed against ${op.provider}: ${message}`);
  }

  // Guarded terminal transition: only OUR 'executing' claim may become
  // 'executed'. If the guard misses, the row was concurrently recovered
  // (mnemosine outbox reset it while the adapter call was in flight) —
  // NEVER overwrite that recovery: log and throw so the operator
  // reconciles manually (the external write DID land).
  const done = await query(
    `UPDATE ai_external_ops
     SET status = 'executed', result = $1::jsonb, approved_content_hash = $2
     WHERE id = $3 AND entity_id = $4 AND status = 'executing'`,
    [JSON.stringify(result), contentHash, opId, ctx.entityId]
  );
  if (done.rowCount !== 1) {
    const warning =
      `Operation ${opId} completed against ${op.provider}, but its row was concurrently ` +
      `recovered out of 'executing' — the external write LANDED and the local status was NOT ` +
      `overwritten; reconcile the operation manually`;
    console.error(warning);
    throw new Error(warning);
  }
  return { result };
}

/** Numeric guard for schema-guaranteed amount fields: finite, non-negative numbers only. */
function toFiniteNonNegative(value: unknown): Decimal | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return new Decimal(value);
}

/**
 * Derives the candidate amount for policy matching from a FIXED,
 * operation-specific allowlist of fields the adapter schema guarantees
 * (accounting-adapter.interface.ts) — NEVER from a free-form AI payload
 * key like a top-level `amount` the model could omit or nest to slip
 * under FLOOR_MAX_AUTO_POST.
 *
 * FAIL CLOSED: returns null whenever a trustworthy amount cannot be
 * derived — missing/empty/malformed fields, non-numeric or negative
 * values, or an operation with no monetary schema (upload_xml). A null
 * here means NO policy may auto-approve the operation; it stays pending
 * for human review.
 */
export function deriveOpAmount(
  operation: ExternalOperation,
  payload: Record<string, unknown>
): string | null {
  switch (operation) {
    case 'create_policy':
    case 'update_policy': {
      // ManualPolicyInput.records: [{ account_code, debit, credit }]
      const records = payload['records'];
      if (!Array.isArray(records) || records.length === 0) return null;
      let debits = new Decimal(0);
      let credits = new Decimal(0);
      for (const record of records) {
        if (record === null || typeof record !== 'object' || Array.isArray(record)) return null;
        const rec = record as Record<string, unknown>;
        const debit = toFiniteNonNegative(rec['debit']);
        const credit = toFiniteNonNegative(rec['credit']);
        if (debit === null || credit === null) return null;
        debits = debits.plus(debit);
        credits = credits.plus(credit);
      }
      // Conservative: the LARGER side is what the policy must cover.
      return Decimal.max(debits, credits).toDecimalPlaces(2).toFixed(2);
    }
    case 'bank_transaction': {
      // createBankTransaction input: { deposit, withdrawal, ... } — both required.
      const deposit = toFiniteNonNegative(payload['deposit']);
      const withdrawal = toFiniteNonNegative(payload['withdrawal']);
      if (deposit === null || withdrawal === null) return null;
      return deposit.plus(withdrawal).toDecimalPlaces(2).toFixed(2);
    }
    case 'reconcile_invoice': {
      // reconcileInvoice input: { amount: number, ... } — schema-typed number.
      const amount = toFiniteNonNegative(payload['amount']);
      return amount === null ? null : amount.toDecimalPlaces(2).toFixed(2);
    }
    default:
      // upload_xml (and any future operation not explicitly allowlisted):
      // no schema-guaranteed monetary amount — fail closed.
      return null;
  }
}

/**
 * Policy path: execute a pending outbox operation because a stored
 * approval policy (src/ai/approval-policy.ts) authorizes it.
 * executeExternalOp remains the HUMAN path and is untouched — this
 * routes through the SAME atomic pending→executing claim, the same
 * stale-op floor, and the same hash binding.
 *
 * The candidate offers provider + operation + an amount derived by
 * deriveOpAmount from schema-guaranteed fields ONLY. When no
 * trustworthy amount can be derived, this throws WITHOUT matching —
 * no policy may auto-approve an operation whose amount the code
 * cannot vouch for (fail closed; the op stays pending for a human).
 *
 * reviewed_by records WHICH policy authorized it ('policy:<id>'), and
 * matchApproval touches last_used_at (consuming 'once' policies
 * atomically). The execution is hash-bound to the row the policy
 * MATCHED: drift between match and claim reverts the claim.
 */
export async function autoExecuteOpByPolicy(
  ctx: AgentContext,
  opId: string,
  opts?: MatchApprovalOpts
): Promise<{ result: Record<string, unknown>; policyId: string }> {
  const pending = await query<ExternalOpRow>(
    `SELECT id, provider, operation, payload, status, ai_reasoning, result, error, created_at
     FROM ai_external_ops WHERE id = $1 AND entity_id = $2 AND status = 'pending'`,
    [opId, ctx.entityId]
  );
  const op = pending.rows[0];
  if (!op) throw new Error(`No pending operation with id ${opId} exists in this entity`);

  // FAIL CLOSED: the amount comes ONLY from operation-specific fields the
  // adapter schema guarantees — never from a free-form AI payload key. No
  // derivable amount means no auto-approval, full stop.
  const amount = deriveOpAmount(op.operation, op.payload);
  if (amount === null) {
    throw new Error(
      `No trustworthy amount can be derived for operation ${opId} (${op.operation}); ` +
        'no policy may auto-approve it — it stays pending for human review'
    );
  }
  const candidate = { provider: op.provider, operation: op.operation, amount };
  const policy = await matchApproval(ctx, 'external_op', candidate, opts);
  if (!policy) {
    throw new Error(`No approval policy authorizes operation ${opId}; it stays pending for human review`);
  }

  const matchedHash = canonicalOpHash(op.provider, op.operation, op.payload);
  const { result } = await executeExternalOp(ctx, opId, `policy:${policy.id}`, matchedHash);
  return { result, policyId: policy.id };
}
