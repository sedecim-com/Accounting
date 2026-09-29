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
  const available = candidates.map((p) => p.period_name).join(', ') || 'none';
  let resolved: Awaited<ReturnType<typeof resolvePeriod>>;
  try {
    resolved = await resolvePeriod(ctx.entityId, ref, { refuseSharedMonth: true });
  } catch (err) {
    if (err instanceof NotFoundError) {
      throw notFound(`No period matches "${ref}". Closable: ${available}.`);
    }
    throw err;
  }
  const chosen = candidates.find((p) => p.id === resolved.id);
  if (opts.openOnly && (!chosen || chosen.status !== 'open')) {
    throw blockedByState(
      `${resolved.period_name} is already ${resolved.status}: there is nothing left to conduct. ` +
        `Seal it with \`mnemosine closing pack generate "${resolved.period_name}"\`.`
    );
  }
  if (!chosen) {
    throw blockedByState(
      `${resolved.period_name} is ${resolved.status}: only open or soft-closed periods can be closed. ` +
        `Closable: ${available}.`
    );
  }
  return chosen;
}
