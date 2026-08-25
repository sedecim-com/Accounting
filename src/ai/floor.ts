// ============================================================
// THE UNBREAKABLE FLOOR
//
// Hard safety limits enforced in CODE at the call sites — never
// in the prompt, never in configuration. No thresholds file,
// stored approval policy, CLI flag, or future "always-approve"
// rule may raise them: configuration is always combined with the
// floor via Math.min (stricter wins), never Math.max.
//
// Floor rules and where they are enforced:
//   1. floorMaxAutoAmount — ingest-service auto-post path: an
//      entry above FLOOR_MAX_AUTO_POST is NEVER posted without a
//      human in the loop, regardless of configured thresholds.
//   2. Open fiscal period — draft-service approveDraft: the
//      DB-checked rule (validateDraftPayload re-runs under the
//      row lock; posting into a closed/locked period is refused
//      by the engine as well). See the FLOOR marker there.
//   3. isOpStale — external-service executeExternalOp: an outbox
//      operation queued more than FLOOR_MAX_OP_AGE_DAYS ago is
//      refused; a stale approval must be re-queued and re-reviewed.
//
// Keep this module small and dependency-free: pure functions the
// call sites cannot accidentally bypass via configuration.
// ============================================================

/**
 * Hard cap (in the entity's functional currency) for auto-posting
 * without a human in the loop. Config caps ABOVE this are clamped.
 */
export const FLOOR_MAX_AUTO_POST = 50000;

/**
 * Maximum age, in days, of a queued external operation at execution
 * time. Older approvals are stale: the world (and the review) may no
 * longer match the payload.
 */
export const FLOOR_MAX_OP_AGE_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Effective auto-post amount cap: the configured cap clamped by the
 * floor. A non-finite or negative configured value fails CLOSED
 * (returns 0 — nothing auto-posts), never open.
 */
export function floorMaxAutoAmount(configuredMax: number): number {
  if (!Number.isFinite(configuredMax) || configuredMax < 0) return 0;
  return Math.min(configuredMax, FLOOR_MAX_AUTO_POST);
}

/**
 * True when an external operation queued at `createdAt` is too old to
 * execute (strictly more than FLOOR_MAX_OP_AGE_DAYS days ago). An
 * unparseable timestamp counts as stale: the floor fails closed.
 */
export function isOpStale(createdAt: Date | string, now: Date = new Date()): boolean {
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  if (Number.isNaN(created.getTime())) return true;
  return now.getTime() - created.getTime() > FLOOR_MAX_OP_AGE_DAYS * MS_PER_DAY;
}
