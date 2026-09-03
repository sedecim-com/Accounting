import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { query, withTransaction } from '../database/connection.js';
import { createJournalEntry, attestEntryAsync } from '../services/accounting/posting.js';
import { JournalEntryType } from '../types/index.js';
import { matchApproval, type MatchApprovalOpts } from './approval-policy.js';
import {
  sujetoAutenticado,
  decidirSujeto,
  autenticacionExigida,
  avisarIdentidadDeclarada,
} from '../auth/sujeto-activo.js';
import { config } from '../config/index.js';
import type { AgentContext } from './context.js';

// ============================================================
// AI DRAFT SERVICE
// The AI creates drafts (ai_drafts); a human approves them with
// `mnemosine review`, which creates and posts the real journal
// entry via createJournalEntry (all engine validations apply).
// ============================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DraftLine {
  account_code: string;
  debit?: number;
  credit?: number;
  description?: string;
}

export interface DraftPayload {
  entry_date: string;
  description: string;
  reference?: string;
  lines: DraftLine[];
}

export interface DraftRow {
  id: string;
  entity_id: string;
  status: 'pending_review' | 'approved' | 'rejected';
  payload: DraftPayload;
  ai_confidence: string;
  ai_reasoning: string;
  ai_model: string;
  user_request: string | null;
  journal_entry_id: string | null;
  review_notes: string | null;
  reviewed_by: string | null;
  created_at: Date;
}

/**
 * Canonical sha256 (hex) of a draft payload: fixed alphabetical key
 * order, amounts normalized to 2-decimal strings (10000, 10000.0 and
 * "what will post" all hash alike), absent optionals as null. The
 * reviewer approves THIS content — approveDraft recomputes the hash
 * from the payload read under the row lock and aborts on mismatch,
 * closing the TOCTOU window between human review and posting.
 */
export function canonicalDraftHash(payload: DraftPayload): string {
  const amount = (v: number | undefined | null): string | null =>
    v !== undefined && v !== null && typeof v === 'number' && Number.isFinite(v)
      ? new Decimal(v).toDecimalPlaces(2).toFixed(2)
      : null;
  const canonical = {
    description: payload.description ?? null,
    entry_date: payload.entry_date ?? null,
    lines: (Array.isArray(payload.lines) ? payload.lines : []).map((l) => ({
      account_code: l.account_code ?? null,
      credit: amount(l.credit),
      debit: amount(l.debit),
      description: l.description ?? null,
    })),
    reference: payload.reference ?? null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface DraftValidation {
  errors: string[];
  totalDebits: Decimal;
  totalCredits: Decimal;
  accountIdByCode: Map<string, string>;
}

/**
 * Structural + catalog validation of a draft payload. The definitive
 * validation happens again inside createJournalEntry at approval time;
 * this pass exists so the AI gets immediate, actionable feedback.
 */
export async function validateDraftPayload(
  entityId: string,
  payload: DraftPayload
): Promise<DraftValidation> {
  const errors: string[] = [];
  let totalDebits = new Decimal(0);
  let totalCredits = new Decimal(0);

  if (!DATE_RE.test(payload.entry_date)) {
    errors.push(`entry_date "${payload.entry_date}" is not in YYYY-MM-DD format`);
  } else if (Number.isNaN(new Date(payload.entry_date).getTime())) {
    errors.push(`entry_date "${payload.entry_date}" is not a valid date`);
  }
  if (!payload.description?.trim()) {
    errors.push('description is required');
  }
  if (!Array.isArray(payload.lines) || payload.lines.length < 2) {
    errors.push('The journal entry needs at least 2 lines');
  }

  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = i + 1;

    // The payload is JSONB written by the model (or any future producer):
    // defend against missing codes and non-numeric amounts, which would
    // otherwise crash rendering/approval further down.
    if (typeof line.account_code !== 'string' || !line.account_code.trim()) {
      errors.push(`Line ${n}: account_code is required`);
      continue;
    }
    const hasDebit = line.debit !== undefined && line.debit !== null;
    const hasCredit = line.credit !== undefined && line.credit !== null;

    if (hasDebit === hasCredit) {
      errors.push(`Line ${n}: must have exactly one of debit or credit`);
      continue;
    }
    if ((hasDebit && typeof line.debit !== 'number') || (hasCredit && typeof line.credit !== 'number')) {
      errors.push(`Line ${n}: the amount must be numeric`);
      continue;
    }
    // Validate the amount AS IT WILL POST (2 decimals): 0.004 rounds to 0.00
    // and would trip the engine's positive-amount rule at approval.
    const amount = new Decimal(hasDebit ? line.debit! : line.credit!).toDecimalPlaces(2);
    if (amount.lessThanOrEqualTo(0)) {
      errors.push(`Line ${n}: the amount must be positive (rounded to 2 decimals)`);
      continue;
    }
    if (hasDebit) totalDebits = totalDebits.plus(amount);
    else totalCredits = totalCredits.plus(amount);
  }

  // Exact equality on the rounded amounts: journal_entries has a CHECK of
  // total_debits = total_credits on posting — a tolerance here would accept
  // drafts that can never post.
  if (!totalDebits.equals(totalCredits)) {
    errors.push(
      `The journal entry does not balance: debits ${totalDebits.toFixed(2)} vs credits ${totalCredits.toFixed(2)}`
    );
  }

  // A draft for a date without an open fiscal period can never be approved —
  // fail fast so the AI can propose a different date instead of stranding it.
  if (DATE_RE.test(payload.entry_date)) {
    const period = await query<{ id: string }>(
      `SELECT id FROM fiscal_periods
       WHERE entity_id = $1 AND start_date <= $2 AND end_date >= $2
         AND status NOT IN ('hard_close', 'locked')
       LIMIT 1`,
      [entityId, payload.entry_date]
    );
    if (period.rows.length === 0) {
      errors.push(
        `There is no open fiscal period for the date ${payload.entry_date}; the journal entry could not be posted`
      );
    }
  }

  // Resolve account codes against the entity's catalog
  const codes = [...new Set(lines.map((l) => l.account_code).filter((c) => typeof c === 'string' && c.trim()))];
  const accountIdByCode = new Map<string, string>();
  if (codes.length > 0) {
    const placeholders = codes.map((_, i) => `$${i + 2}`).join(',');
    const result = await query<{
      id: string; code: string; is_active: boolean; is_header: boolean; allow_manual_entries: boolean;
    }>(
      `SELECT id, code, is_active, is_header, allow_manual_entries
       FROM accounts WHERE entity_id = $1 AND code IN (${placeholders})`,
      [entityId, ...codes]
    );
    const byCode = new Map(result.rows.map((a) => [a.code, a]));
    for (const code of codes) {
      const acct = byCode.get(code);
      if (!acct) {
        errors.push(`Account "${code}" does not exist in this entity's chart of accounts`);
      } else if (!acct.is_active) {
        errors.push(`Account "${code}" is inactive`);
      } else if (acct.is_header) {
        errors.push(`Account "${code}" is a grouping (header) account; use a detail account`);
      } else if (!acct.allow_manual_entries) {
        errors.push(`Account "${code}" does not accept manual journal entries`);
      } else {
        accountIdByCode.set(code, acct.id);
      }
    }
  }

  return { errors, totalDebits, totalCredits, accountIdByCode };
}

export interface CreateDraftInput {
  payload: DraftPayload;
  confidence: number;
  reasoning: string;
  model: string;
  userRequest?: string;
}

export async function createDraft(
  ctx: AgentContext,
  input: CreateDraftInput
): Promise<{ id: string; totalDebits: string; totalCredits: string }> {
  const validation = await validateDraftPayload(ctx.entityId, input.payload);
  if (validation.errors.length > 0) {
    throw new DraftValidationError(validation.errors);
  }

  const id = uuidv4();
  await query(
    `INSERT INTO ai_drafts (
      id, tenant_id, entity_id, draft_type, status, payload,
      ai_confidence, ai_reasoning, ai_model, user_request
    ) VALUES ($1, $2, $3, 'journal_entry', 'pending_review', $4::jsonb, $5, $6, $7, $8)`,
    [
      id, ctx.tenantId, ctx.entityId,
      JSON.stringify(input.payload),
      input.confidence.toFixed(2), input.reasoning, input.model,
      input.userRequest ?? null,
    ]
  );

  return {
    id,
    totalDebits: validation.totalDebits.toFixed(2),
    totalCredits: validation.totalCredits.toFixed(2),
  };
}

export class DraftValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid draft:\n- ${errors.join('\n- ')}`);
    this.name = 'DraftValidationError';
  }
}

export async function listDrafts(
  ctx: AgentContext,
  status?: DraftRow['status'],
  opts?: { limit?: number; newestFirst?: boolean }
): Promise<DraftRow[]> {
  const conditions = ['entity_id = $1'];
  const params: unknown[] = [ctx.entityId];
  if (status) {
    conditions.push('status = $2');
    params.push(status);
  }
  const order = opts?.newestFirst ? 'DESC' : 'ASC';
  const limit = opts?.limit ? ` LIMIT ${Math.max(1, Math.floor(opts.limit))}` : '';
  const result = await query<DraftRow>(
    `SELECT id, entity_id, status, payload, ai_confidence, ai_reasoning, ai_model,
            user_request, journal_entry_id, review_notes, reviewed_by, created_at
     FROM ai_drafts
     WHERE ${conditions.join(' AND ')}
     ORDER BY created_at ${order}${limit}`,
    params
  );
  return result.rows;
}

export async function getDraft(ctx: AgentContext, draftId: string): Promise<DraftRow | null> {
  const result = await query<DraftRow>(
    `SELECT id, entity_id, status, payload, ai_confidence, ai_reasoning, ai_model,
            user_request, journal_entry_id, review_notes, reviewed_by, created_at
     FROM ai_drafts WHERE id = $1 AND entity_id = $2`,
    [draftId, ctx.entityId]
  );
  return result.rows[0] ?? null;
}

export interface Reviewer {
  userId: string;
  email: string;
}

/**
 * QUIÉN FIRMA ESTA ESCRITURA (G3).
 *
 * `journal_entries.created_by` es un UUID de `users`, y de ahí el hecho
 * pasa a `audit_log.user_id`, que no se puede reescribir (033). Así que
 * lo que decida esta función queda certificado para siempre.
 *
 * Hasta este tramo lo decidía `--user <correo>` y nada más: la bandera
 * que teclea quien ejecuta el comando. Ahora la identidad la trae la
 * sesión OIDC —que existía completa y no consumía nadie— y `--user`
 * queda reducida a lo único que puede hacer honestamente: RESTRINGIR.
 * Nombrarte a ti mismo se acepta; nombrar a otro se rechaza.
 *
 * Sin proveedor de identidad configurado, la bandera sigue siendo la
 * única identidad que hay y el comportamiento no cambia — pero lo dice
 * (`avisarIdentidadDeclarada`) en vez de callárselo.
 *
 * NO la use quien ya sabe a quién atribuir por otra vía: la aprobación
 * por política atribuye al humano que la concedió y para eso está
 * `resolvePolicyGrantor`, que no autentica porque el otorgante no es
 * quien está delante de la terminal.
 */
export async function resolveReviewer(tenantId: string, email?: string): Promise<Reviewer> {
  const sesion = await sujetoAutenticado();
  const elegido = decidirSujeto(sesion, email, {
    exigeAutenticacion: autenticacionExigida(),
  });

  if (!elegido.autenticado && email) {
    avisarIdentidadDeclarada(email);
  }

  // Con sesión se busca primero por el `sub` del proveedor, que no
  // cambia: el correo sí puede cambiar en el IdP, y atar la atribución a
  // un dato mutable es cómo se pierde el rastro de una persona que se
  // casó o cambió de dominio. El correo queda como respaldo para la
  // identidad todavía no vinculada, que es lo que hace el alta JIT.
  if (elegido.subject) {
    const porIdentidad = await query<{ id: string; email: string }>(
      `SELECT u.id, u.email FROM identities i
       JOIN users u ON u.id = i.user_id
       WHERE i.provider = $1 AND i.subject = $2
         AND u.tenant_id = $3 AND u.is_active = true
       LIMIT 1`,
      [config.auth.provider, elegido.subject, tenantId]
    );
    if (porIdentidad.rows.length > 0) {
      return { userId: porIdentidad.rows[0].id, email: porIdentidad.rows[0].email };
    }
  }

  if (elegido.email) {
    return usuarioActivoPorCorreo(tenantId, elegido.email, elegido.autenticado);
  }

  return unicoUsuarioActivo(tenantId);
}

/**
 * El humano que concedió una política de auto-aprobación.
 *
 * NO pasa por la sesión, y es deliberado: el otorgante es a quien la
 * política atribuye, no quien está ejecutando el comando —de hecho lo
 * normal es que no haya nadie ejecutando nada—. Someterlo a la regla de
 * `--user` haría que ninguna política aprobara nunca mientras hubiera
 * una sesión abierta de otra persona.
 */
export async function resolvePolicyGrantor(tenantId: string, email: string): Promise<Reviewer> {
  return usuarioActivoPorCorreo(tenantId, email, false);
}

async function usuarioActivoPorCorreo(
  tenantId: string,
  email: string,
  autenticado: boolean
): Promise<Reviewer> {
  const result = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users
     WHERE tenant_id = $1 AND is_active = true AND email = $2
     LIMIT 1`,
    [tenantId, email]
  );
  if (result.rows.length === 0) {
    // Con sesión el mensaje es otro problema: te autenticaste bien y no
    // tienes fila en este inquilino. Decir «no existe ese usuario» ahí
    // manda a buscar un error de tecleo que no hay.
    throw new Error(
      autenticado
        ? `Tu sesión (${email}) está verificada pero no corresponde a ningún usuario activo de este inquilino; un administrador tiene que darte de alta`
        : `No active user with email ${email} exists in this tenant`
    );
  }
  return { userId: result.rows[0].id, email: result.rows[0].email };
}

async function unicoUsuarioActivo(tenantId: string): Promise<Reviewer> {
  const result = await query<{ id: string; email: string }>(
    `SELECT id, email FROM users
     WHERE tenant_id = $1 AND is_active = true
     ORDER BY created_at ASC LIMIT 2`,
    [tenantId]
  );
  if (result.rows.length === 0) {
    throw new Error('There are no active users in this tenant to attribute the review to');
  }
  if (result.rows.length > 1) {
    throw new Error(
      'There are multiple active users in this tenant; specify the reviewer with --user <email> to attribute the journal entry correctly'
    );
  }
  return { userId: result.rows[0].id, email: result.rows[0].email };
}

/**
 * Approve a pending draft: creates AND posts the real journal entry through
 * the accounting engine (fiscal period lookup, balance, account and period
 * validations all apply), then marks the draft approved.
 *
 * Runs as ONE transaction with a row lock on the draft: a concurrent
 * approver blocks on FOR UPDATE, then sees a non-pending status and errors —
 * and a failure anywhere rolls back both the posted entry and the draft
 * update, so a draft can never end up pending with an entry already posted.
 *
 * `expectedHash` binds the approval to exact content: pass the
 * canonicalDraftHash computed when the payload was SHOWN to the reviewer;
 * if the payload read under the row lock hashes differently, the content
 * drifted between review and approval and the approval is invalidated.
 */
export async function approveDraft(
  ctx: AgentContext,
  draftId: string,
  reviewer: Reviewer,
  notes?: string,
  expectedHash?: string
): Promise<{ entryId: string; entryNumber: string }> {
  return approveDraftInternal(ctx, draftId, reviewer, notes, expectedHash, reviewer.email);
}

/**
 * Shared approval core for the human path (approveDraft) and the policy
 * path (autoApproveDraftByPolicy). Identical transaction, row lock, hash
 * binding and guarded update — the ONLY difference is what lands in
 * reviewed_by (`reviewer.email` vs `policy:<id>`).
 */
async function approveDraftInternal(
  ctx: AgentContext,
  draftId: string,
  reviewer: Reviewer,
  notes: string | undefined,
  expectedHash: string | undefined,
  reviewedByAs: string
): Promise<{ entryId: string; entryNumber: string }> {
  return withTransaction(async (client) => {
    const locked = await client.query<DraftRow>(
      `SELECT id, entity_id, status, payload
       FROM ai_drafts WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
      [draftId, ctx.entityId]
    );
    const draft = locked.rows[0];
    if (!draft) throw new Error(`Draft ${draftId} does not exist in this entity`);
    if (draft.status !== 'pending_review') {
      throw new Error(`The draft was already ${draft.status === 'approved' ? 'approved' : 'rejected'}`);
    }

    // Drift detection: the hash of what the human reviewed must match the
    // payload we are about to post, read UNDER the row lock.
    const contentHash = canonicalDraftHash(draft.payload);
    if (expectedHash !== undefined && contentHash !== expectedHash) {
      throw new Error('Draft content changed after review; approval invalidated');
    }

    // FLOOR: an entry can only ever post into an OPEN fiscal period —
    // validateDraftPayload re-checks fiscal_periods here (under the lock),
    // and the accounting engine enforces it again inside createJournalEntry.
    // No configuration or approval policy bypasses this validation.
    // Re-validate: the catalog may have changed since the AI drafted it.
    const validation = await validateDraftPayload(ctx.entityId, draft.payload);
    if (validation.errors.length > 0) {
      throw new DraftValidationError(validation.errors);
    }

    // Same 2-decimal normalization the validator used — validated amounts
    // are byte-identical to posted amounts.
    const lines = draft.payload.lines.map((l) => ({
      account_id: validation.accountIdByCode.get(l.account_code)!,
      debit_amount:
        l.debit !== undefined && l.debit !== null ? new Decimal(l.debit).toDecimalPlaces(2).toFixed(2) : null,
      credit_amount:
        l.credit !== undefined && l.credit !== null ? new Decimal(l.credit).toDecimalPlaces(2).toFixed(2) : null,
      description: l.description ?? draft.payload.description,
    }));

    const entry = await createJournalEntry(
      ctx.entityId,
      new Date(`${draft.payload.entry_date}T00:00:00`),
      JournalEntryType.STANDARD,
      draft.payload.description,
      lines,
      reviewer.userId,
      {
        sourceType: 'ai_draft',
        sourceId: draftId,
        reference: draft.payload.reference,
        autoPost: true,
        client, // same transaction as the draft update below
      }
    );

    const updated = await client.query(
      `UPDATE ai_drafts
       SET status = 'approved', journal_entry_id = $1,
           reviewed_by = $2, reviewed_at = NOW(), review_notes = $3,
           approved_content_hash = $4
       WHERE id = $5 AND entity_id = $6 AND status = 'pending_review'`,
      [entry.id, reviewedByAs, notes ?? null, contentHash, draftId, ctx.entityId]
    );
    if (updated.rowCount !== 1) {
      throw new Error(`Draft ${draftId} changed status during approval; everything was rolled back`);
    }

    return { entryId: entry.id, entryNumber: entry.entry_number };
  }).then((result) => {
    // Attestation must run post-commit (it reads the entry back from the DB).
    attestEntryAsync(ctx.tenantId, ctx.entityId, result.entryId);
    return result;
  });
}

/**
 * FAIL-CLOSED amount derivation for the policy path: total debits as
 * they will post (2 decimals), or null when ANY line is malformed —
 * the payload is AI-written JSONB, so nothing lenient (no skipping bad
 * lines, no defaulting to 0). A null result must block auto-approval.
 */
export function deriveDraftAmount(payload: DraftPayload): string | null {
  const lines = payload.lines;
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let total = new Decimal(0);
  for (const line of lines) {
    if (line === null || typeof line !== 'object') return null;
    const hasDebit = line.debit !== undefined && line.debit !== null;
    const hasCredit = line.credit !== undefined && line.credit !== null;
    if (hasDebit === hasCredit) return null; // both or neither: malformed
    const raw = hasDebit ? line.debit : line.credit;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
    if (hasDebit) total = total.plus(new Decimal(raw).toDecimalPlaces(2));
  }
  return total.toDecimalPlaces(2).toFixed(2);
}

/**
 * Candidate kind for policy matching: the payload's own `kind` (or
 * legacy `entry_type`) when it is a non-empty string, otherwise
 * 'journal_entry'. This is what a `mnemosine approvals grant --kind`
 * pattern matches against — so a '--kind payroll' policy can actually
 * match a payroll draft instead of being dead on arrival.
 */
export function deriveDraftKind(payload: DraftPayload): string {
  const p = payload as unknown as Record<string, unknown>;
  for (const field of ['kind', 'entry_type'] as const) {
    const value = p[field];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return 'journal_entry';
}

/** El «no casó» tiene nombre: la ingesta lo distingue del «casó y falló». */
export class NoMatchingApprovalPolicyError extends Error {
  readonly code = 'NO_MATCHING_APPROVAL_POLICY';
}

/**
 * Policy path: approve a pending draft because a stored approval policy
 * (src/ai/approval-policy.ts) authorizes it. A3: es la VÍA SECUNDARIA de
 * la ingesta — cuando una compuerta DISCRECIONAL del auto-post no basta
 * (confianza, monto, proveedor), una política otorgada por un humano puede
 * autorizar; las compuertas de INTEGRIDAD (sospecha, multi-draft, moneda,
 * cuadre) jamás se saltan. approveDraft remains the HUMAN path, untouched.
 *
 * Safety properties:
 * - matching is conservative and the FLOOR wins: matchApproval caps any
 *   policy amount at FLOOR_MAX_AUTO_POST via Math.min, and the open
 *   fiscal-period floor still runs inside the approval transaction;
 * - the approval is hash-bound to the payload the policy MATCHED: if the
 *   draft drifts before the row lock, the approval is invalidated;
 * - reviewed_by records WHICH policy authorized it ('policy:<id>'), and
 *   matchApproval touches last_used_at (consuming 'once' policies
 *   atomically). The posted entry's created_by is the human who GRANTED
 *   the policy, resolved as a real user of the tenant.
 * A 'once' policy consumed by a match whose approval then fails stays
 * consumed: spending it on a failure is the fail-closed direction.
 */
export async function autoApproveDraftByPolicy(
  ctx: AgentContext,
  draftId: string,
  opts?: MatchApprovalOpts
): Promise<{ entryId: string; entryNumber: string; policyId: string }> {
  const draft = await getDraft(ctx, draftId);
  if (!draft) throw new Error(`Draft ${draftId} does not exist in this entity`);
  if (draft.status !== 'pending_review') {
    throw new Error(`Draft ${draftId} is not pending review (status: ${draft.status})`);
  }

  // Candidate amount = total debits AS THEY WILL POST (2 decimals),
  // derived FAIL CLOSED from the schema-guaranteed line structure: the
  // payload is JSONB, so a malformed line (missing/non-numeric/negative
  // amount, both or neither side set) or an empty lines array means no
  // trustworthy amount exists — and then NO policy may auto-approve the
  // draft; it stays pending for human review.
  const total = deriveDraftAmount(draft.payload);
  if (total === null) {
    throw new Error(
      `No trustworthy amount can be derived for draft ${draftId}; ` +
        'no policy may auto-approve it — it stays pending for human review'
    );
  }
  const policy = await matchApproval(
    ctx,
    'draft',
    { kind: deriveDraftKind(draft.payload), amount: total },
    opts
  );
  if (!policy) {
    throw new NoMatchingApprovalPolicyError(
      `No approval policy authorizes draft ${draftId}; it stays pending for human review`
    );
  }

  // Attribution: journal_entries.created_by must be a real user — the
  // human who granted the policy. If they no longer resolve (deactivated),
  // this fails closed and the draft stays pending.
  const reviewer = await resolvePolicyGrantor(ctx.tenantId, policy.created_by);

  // Hash binding to the exact content the policy matched.
  const matchedHash = canonicalDraftHash(draft.payload);
  const result = await approveDraftInternal(
    ctx,
    draftId,
    reviewer,
    `auto-approved by policy ${policy.id} (${policy.mode})`,
    matchedHash,
    `policy:${policy.id}`
  );
  return { ...result, policyId: policy.id };
}

export async function rejectDraft(
  ctx: AgentContext,
  draftId: string,
  reviewer: Reviewer,
  reason: string
): Promise<void> {
  const result = await query(
    `UPDATE ai_drafts
     SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW(), review_notes = $2
     WHERE id = $3 AND entity_id = $4 AND status = 'pending_review'`,
    [reviewer.email, reason, draftId, ctx.entityId]
  );
  if (result.rowCount === 0) {
    throw new Error(`No pending draft with id ${draftId} exists in this entity`);
  }
}
