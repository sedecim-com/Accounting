import type { AgentContext } from '../../ai/context.js';
import type { ClosablePeriod } from '../../ai/close-service.js';
import { resolvePeriod } from '../../services/accounting/fiscal-calendar-service.js';
import { NotFoundError } from '../../utils/errors.js';
import { blockedByState, notFound } from './cli-error.js';

/**
 * The one resolver behind every close surface (`close --period`, `closing
 * preview|check|explain|run`): the period a person named, in the grammar
 * `period show` speaks — uuid, YYYY-MM, or an unambiguous part of the name
 * (#327).
 *
 * It resolves against ALL the entity's periods first and only then asks
 * whether that one is among `candidates`, so a month that exists but is
 * already sealed is refused for its state instead of reported as missing.
 * Ambiguity is refused, never resolved to the first hit: an ambiguous name,
 * and a YYYY-MM that two periods share (December and the year-end
 * adjustments period both start in December). Hard-closing period 12 when
 * period 13 was meant would skip the annual closing entries.
 *
 * `openOnly` is the conductor's rule: a soft-closed period has nothing left
 * to conduct, only to seal.
 */
export async function resolveClosablePeriod(
  ctx: AgentContext,
  ref: string,
  candidates: ClosablePeriod[],
  opts: { openOnly?: boolean } = {}
): Promise<ClosablePeriod> {
  // A nested key, so the English `message` says «none» whatever the locale.
  const available: string | { key: string } = candidates.map((p) => p.period_name).join(', ') || { key: 'closing.period.none' };
  let resolved: Awaited<ReturnType<typeof resolvePeriod>>;
  try {
    resolved = await resolvePeriod(ctx.entityId, ref, { refuseSharedMonth: true });
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw notFound({ key: 'closing.period.not_found', params: { ref, available } });
    }
    throw err;
  }
  const chosen = candidates.find((p) => p.id === resolved.id);
  if (opts.openOnly && (!chosen || chosen.status !== 'open')) {
    const command = `\`mnemosine closing pack generate "${resolved.period_name}"\``;
    throw blockedByState({ key: 'closing.period.nothing_to_conduct', params: { period: resolved.period_name, status: resolved.status, command } });
  }
  if (!chosen) {
    throw blockedByState({ key: 'closing.period.not_closable', params: { period: resolved.period_name, status: resolved.status, available } });
  }
  return chosen;
}
