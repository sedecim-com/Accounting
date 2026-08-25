import crypto from 'node:crypto';
import { query } from '../../database/connection.js';
import { logger } from '../../utils/logger.js';
import type { AgentContext } from '../context.js';

// ============================================================
// WEBHOOK INTAKE (item 22)
// Dedicated inbound tokens + idempotent delivery recording.
//
// Security model:
//   - The raw token exists exactly once, in the HTTP response of
//     `mnemosine webhooks create`. The database stores ONLY its
//     sha256 hash; verification recomputes the hash and compares
//     with crypto.timingSafeEqual (constant time).
//   - A delivery is idempotent by (token_id, document_key): the
//     key derives from the payload's document id (bank tx id,
//     CFDI UUID), so a replayed notification maps to the same row
//     and NEVER re-wakes the reader agent. That id is third-party
//     (untrusted) input, so a collision is NOT assumed benign — a
//     suppressed duplicate is always logged (see recordDelivery),
//     since an attacker holding a token could pre-claim the key a
//     future legitimate document will carry.
//   - Everything the third party controls (the body, and therefore
//     the document id) is untrusted: keys are length-capped and
//     control characters stripped before they touch SQL params.
// ============================================================

export type WebhookSourceKind = 'bank_notification' | 'sat_mailbox' | 'generic';

export const WEBHOOK_SOURCE_KINDS: WebhookSourceKind[] = [
  'bank_notification',
  'sat_mailbox',
  'generic',
];

export type WebhookDeliveryStatus = 'received' | 'processed' | 'duplicate' | 'rejected';

export interface WebhookTokenRow {
  id: string;
  tenant_id: string;
  entity_id: string;
  name: string;
  token_hash: string;
  source_kind: WebhookSourceKind;
  enabled: boolean;
  created_by: string;
  created_at: Date;
  last_used_at: Date | null;
}

export interface WebhookDeliveryRow {
  id: string;
  token_id: string;
  tenant_id: string;
  entity_id: string;
  document_key: string;
  received_at: Date;
  status: WebhookDeliveryStatus;
  suspicion: unknown;
  drafts_created: number;
}

const TOKEN_COLUMNS =
  'id, tenant_id, entity_id, name, token_hash, source_kind, enabled, created_by, created_at, last_used_at';
const DELIVERY_COLUMNS =
  'id, token_id, tenant_id, entity_id, document_key, received_at, status, suspicion, drafts_created';

// URL path segment and CLI argument: keep it boring on purpose.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex');
}

// ─── Token issuance ───

export interface IssuedWebhookToken {
  token: WebhookTokenRow;
  /** Shown exactly once. It is NEVER stored and cannot be recovered. */
  rawToken: string;
}

/**
 * Creates a webhook token for the entity. The returned rawToken is the only
 * copy that will ever exist: the row stores its sha256 hash.
 */
export async function issueWebhookToken(
  ctx: AgentContext,
  input: { name: string; sourceKind: WebhookSourceKind; createdBy: string }
): Promise<IssuedWebhookToken> {
  const name = input.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new Error(
      `Invalid webhook name "${input.name}": use 1-64 lowercase letters, digits, "-" or "_".`
    );
  }
  if (!WEBHOOK_SOURCE_KINDS.includes(input.sourceKind)) {
    throw new Error(
      `Invalid source kind "${input.sourceKind}". Use one of: ${WEBHOOK_SOURCE_KINDS.join(', ')}.`
    );
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const result = await query<WebhookTokenRow>(
    `INSERT INTO ai_webhook_tokens (tenant_id, entity_id, name, token_hash, source_kind, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${TOKEN_COLUMNS}`,
    [ctx.tenantId, ctx.entityId, name, hashToken(rawToken), input.sourceKind, input.createdBy]
  );
  return { token: result.rows[0], rawToken };
}

// ─── Verification ───

function timingSafeHexEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Verifies a raw bearer token against the enabled tokens registered under
 * `tokenName` (the URL segment). Returns the matching row or null.
 *
 * The lookup is keyed on the token's OWN sha256 hash (high-entropy, uniform,
 * indexed — migration 030), scoped to the routing name. There is NO name-only
 * candidate window: a cross-tenant attacker who registers many tokens sharing
 * a common name can no longer shadow a victim's token out of a bounded scan
 * (the old `ORDER BY created_at DESC LIMIT 25` was a silent-drop DoS surface).
 * The single matched row's stored hash is re-compared with a constant-time
 * comparison so nothing about the outcome leaks through timing.
 *
 * Runs WITHOUT tenant context on purpose: the tenant is only known AFTER the
 * token matches (the pre-auth SELECT policy in migration 030 — tightened to
 * the no-tenant-context path — covers this read, mirroring users/sessions).
 */
export async function verifyWebhookToken(
  rawToken: string,
  tokenName: string
): Promise<WebhookTokenRow | null> {
  if (!rawToken || !NAME_RE.test(tokenName)) return null;
  const digest = hashToken(rawToken);
  // Exact hash match (scoped to the routing name): the presented token's hash
  // selects its own row directly, so no attacker-controllable set of same-name
  // rows can crowd it out.
  const result = await query<WebhookTokenRow>(
    `SELECT ${TOKEN_COLUMNS} FROM ai_webhook_tokens
     WHERE token_hash = $1 AND name = $2 AND enabled = true`,
    [digest, tokenName]
  );
  let match: WebhookTokenRow | null = null;
  for (const row of result.rows) {
    // Defence in depth: re-verify with a constant-time comparison rather than
    // trusting the SQL equality alone.
    if (timingSafeHexEqual(digest, row.token_hash)) match = row;
  }
  return match;
}

/**
 * Records usage on a verified token. Guarded by `enabled = true` so a token
 * disabled between verification and use is not resurrected-looking in the
 * audit trail. Must run inside the token's tenant context.
 */
export async function touchWebhookToken(token: WebhookTokenRow): Promise<void> {
  await query(
    `UPDATE ai_webhook_tokens SET last_used_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND enabled = true`,
    [token.id, token.tenant_id]
  );
}

// ─── Document key derivation ───

/** Per-source extractor of the payload's own document id. */
export type DocumentKeyExtractor = (body: unknown) => string | undefined;

function firstString(body: unknown, keys: string[]): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

export const DEFAULT_KEY_EXTRACTORS: Record<WebhookSourceKind, DocumentKeyExtractor> = {
  bank_notification: (body) => firstString(body, ['transaction_id', 'tx_id', 'movement_id', 'id']),
  sat_mailbox: (body) => firstString(body, ['cfdi_uuid', 'uuid', 'folio_fiscal', 'id']),
  generic: (body) => firstString(body, ['document_id', 'document_key', 'id']),
};

// The key ends up in a URL-ish audit trail and a VARCHAR(255) unique index:
// strip control characters and cap the length. A third party controls it.
const KEY_CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const MAX_KEY_LENGTH = 200;

/**
 * Derives the idempotency key for a delivery: the payload's own document id
 * per source kind, falling back to sha256 of the raw body when the payload
 * does not carry one. The fallback still deduplicates exact replays.
 */
export function deriveDocumentKey(
  sourceKind: WebhookSourceKind,
  body: unknown,
  rawBody: string,
  extractors: Record<WebhookSourceKind, DocumentKeyExtractor> = DEFAULT_KEY_EXTRACTORS
): string {
  const extracted = extractors[sourceKind]?.(body);
  if (extracted) {
    const clean = extracted.replace(KEY_CONTROL_CHARS, '').trim().slice(0, MAX_KEY_LENGTH);
    if (clean !== '') return clean;
  }
  return `sha256:${crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex')}`;
}

// ─── Delivery recording (idempotent) ───

export interface RecordedDelivery {
  delivery: WebhookDeliveryRow;
  /** true = replay: the prior row is returned and the agent must NOT wake. */
  duplicate: boolean;
}

/**
 * Records a delivery idempotently by (token_id, document_key). A first-seen
 * document inserts a 'received' row; a replay returns the PRIOR delivery
 * flagged duplicate — the caller must never wake the agent for a duplicate.
 * Must run inside the token's tenant context.
 */
export async function recordDelivery(
  token: WebhookTokenRow,
  input: { documentKey: string; suspicion?: string[] }
): Promise<RecordedDelivery> {
  const inserted = await query<WebhookDeliveryRow>(
    `INSERT INTO ai_webhook_deliveries (token_id, tenant_id, entity_id, document_key, status, suspicion)
     VALUES ($1, $2, $3, $4, 'received', $5)
     ON CONFLICT (token_id, document_key) DO NOTHING
     RETURNING ${DELIVERY_COLUMNS}`,
    [
      token.id,
      token.tenant_id,
      token.entity_id,
      input.documentKey,
      input.suspicion && input.suspicion.length > 0 ? JSON.stringify(input.suspicion) : null,
    ]
  );
  if (inserted.rows.length === 1) {
    return { delivery: inserted.rows[0], duplicate: false };
  }

  const prior = await query<WebhookDeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS} FROM ai_webhook_deliveries
     WHERE token_id = $1 AND document_key = $2 AND tenant_id = $3`,
    [token.id, input.documentKey, token.tenant_id]
  );
  if (prior.rows.length !== 1) {
    // The insert conflicted but the row is not visible: fail closed instead
    // of inventing a delivery id.
    throw new Error(`Delivery conflict for document key "${input.documentKey}" but the prior row is not visible.`);
  }
  const priorRow = prior.rows[0];
  // A duplicate is NEVER silent: the document_key is derived from third-party
  // body fields, so a delivery that collides may be a genuine document whose
  // idempotency key was pre-claimed by an earlier (possibly hostile) delivery
  // on the same token. Surface every suppression so an operator/alert can spot
  // a legitimate document being dropped, instead of letting it vanish. The
  // UNIQUE(token_id, document_key) still deduplicates honest retries.
  logger.warn('webhook_delivery_duplicate_suppressed', {
    token_id: token.id,
    tenant_id: token.tenant_id,
    entity_id: token.entity_id,
    document_key: input.documentKey,
    prior_delivery_id: priorRow.id,
    prior_status: priorRow.status,
    prior_drafts_created: priorRow.drafts_created,
  });
  // The row keeps its real lifecycle status; 'duplicate' is what this
  // ATTEMPT was, reported to the caller and on the HTTP response.
  return { delivery: { ...priorRow, status: 'duplicate' }, duplicate: true };
}

/**
 * Finalizes a processed delivery. Guarded UPDATE: only a row still in
 * 'received' for this token/tenant can move, and rowCount tells the caller
 * whether it actually did. Must run inside the token's tenant context.
 */
export async function markDeliveryOutcome(
  delivery: WebhookDeliveryRow,
  outcome: { status: 'processed' | 'rejected'; draftsCreated: number }
): Promise<boolean> {
  const result = await query(
    `UPDATE ai_webhook_deliveries
     SET status = $1, drafts_created = $2
     WHERE id = $3 AND token_id = $4 AND tenant_id = $5 AND status = 'received'`,
    [outcome.status, outcome.draftsCreated, delivery.id, delivery.token_id, delivery.tenant_id]
  );
  return (result.rowCount ?? 0) === 1;
}

// ─── CLI queries ───

export interface WebhookTokenSummary {
  id: string;
  name: string;
  source_kind: WebhookSourceKind;
  enabled: boolean;
  created_by: string;
  created_at: Date;
  last_used_at: Date | null;
}

/** Tokens for the entity — names and usage only, NEVER hashes or tokens. */
export async function listWebhookTokens(ctx: AgentContext): Promise<WebhookTokenSummary[]> {
  const result = await query<WebhookTokenSummary>(
    `SELECT id, name, source_kind, enabled, created_by, created_at, last_used_at
     FROM ai_webhook_tokens
     WHERE entity_id = $1 AND tenant_id = $2
     ORDER BY name`,
    [ctx.entityId, ctx.tenantId]
  );
  return result.rows;
}

/** Disables a token by name. Guarded: returns false when nothing changed. */
export async function disableWebhookToken(ctx: AgentContext, name: string): Promise<boolean> {
  const result = await query(
    `UPDATE ai_webhook_tokens SET enabled = false
     WHERE entity_id = $1 AND tenant_id = $2 AND name = $3 AND enabled = true`,
    [ctx.entityId, ctx.tenantId, name.trim().toLowerCase()]
  );
  return (result.rowCount ?? 0) === 1;
}

export interface WebhookDeliveryLogRow extends WebhookDeliveryRow {
  token_name: string;
}

/** Recent deliveries for the entity, newest first. */
export async function listDeliveries(
  ctx: AgentContext,
  opts: { limit?: number } = {}
): Promise<WebhookDeliveryLogRow[]> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 200);
  const result = await query<WebhookDeliveryLogRow>(
    `SELECT d.id, d.token_id, d.tenant_id, d.entity_id, d.document_key, d.received_at,
            d.status, d.suspicion, d.drafts_created, t.name AS token_name
     FROM ai_webhook_deliveries d
     JOIN ai_webhook_tokens t ON t.id = d.token_id
     WHERE d.entity_id = $1 AND d.tenant_id = $2
     ORDER BY d.received_at DESC
     LIMIT $3`,
    [ctx.entityId, ctx.tenantId, limit]
  );
  return result.rows;
}
