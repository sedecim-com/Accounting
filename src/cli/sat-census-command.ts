import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { entityScope } from '../database/scope.js';
import { t } from '../i18n/index.js';
import { reconcileCensus, type CensusReconciliation } from '../services/sat-census/reconcile.js';
import {
  declareRisk, describeCommand, ExitCode, exitCodeFor, optionByKey, render, requireExplicitEntity, usageError,
  withContext, withOutput, type Row,
} from './kernel/index.js';

// ============================================================
// `mnemosine sat download reconcile --period YYYY-MM` (MNE-001-119, #312)
//
// The SAT census of a month read against what the entity has posted: what is
// still to fetch, what is fetched and not posted, what the SAT cancelled and
// the books still carry, and what the books carry and the SAT does not list
// (src/services/sat-census/reconcile.ts). Read-only, no network, no e.firma:
// it reads the census that `ingest --kind zip|metadata` loaded.
//
// Exit 4 (VALIDATION) when the month cannot be called complete: any finding,
// or a direction nobody loaded. 0 only when every CFDI the SAT lists is in the
// books and both directions were loaded.
// ============================================================

const EXAMPLES = `
Examples:
  # What August's SAT census has that the books do not (exit 4 if the month is not complete).
  mnemosine sat download reconcile --period 2026-08
  # The same, as data, for a script.
  mnemosine sat download reconcile --period 2026-08 --json
`;

const MONTH_RE =/^(\d{4})-(0[1-9]|1[0-2])$/;

/** First and last day of a `YYYY-MM`, as ISO dates. */
export function monthBounds(period: string): { from: string; to: string } {
  const m = MONTH_RE.exec(period);
  if (!m) throw usageError({ key: 'sat.reconcile.bad_period', params: { value: period } });
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
}

export function findingRows(r: CensusReconciliation): Row[] {
  const census = (status: string, xs: CensusReconciliation['toFetch']): Row[] =>
    xs.map((x) => ({ status, direction: x.direction, type: x.cfdiType, uuid: x.uuid, date: x.issuedAt, amount: x.amount }));
  return [
    ...census('to_fetch', r.toFetch),
    ...census('to_post', r.toPost),
    ...census('cancelled_booked', r.cancelledBooked),
    ...r.surplus.map((s) => ({
      status: 'surplus', direction: s.direction, type: s.source, uuid: s.uuid, date: s.date, amount: s.amount,
    })),
  ];
}

export function registerSatCensus(
  sat: Command,
  deps: { shutdown: (code: number) => Promise<never>; reportError: (err: unknown) => void }
): void {
  const download = describeCommand(sat.command('download').alias('descarga'), 'help.sat.download.description');
  const reconcile = describeCommand(
    download.command('reconcile').alias('conciliar'), 'help.sat.download.reconcile.description'
  );
  optionByKey(reconcile, '--period <YYYY-MM>', 'help.sat.download.reconcile.option.period', { mandatory: true });
  withContext(reconcile);
  withOutput(reconcile);
  declareRisk(reconcile, { risk: 'lectura', agent: true });
  reconcile.addHelpText('after', EXAMPLES);
  reconcile.action(async (opts: { period: string; entity?: string; tenant?: string; json?: boolean }) => {
    try {
      const { from, to } = monthBounds(opts.period);
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity({ entity: opts.entity });
      const r = await reconcileCensus(entityScope(ctx.tenantId, ctx.entityId), from, to);
      const rows = findingRows(r);
      render(rows, { ...(opts as Record<string, unknown>), idField: 'uuid', numeric: ['amount'] });
      const err = process.stderr;
      err.write(`${t('sat.reconcile.summary', {
        period: opts.period, matched: r.matched, fetch: r.toFetch.length, post: r.toPost.length,
        cancelled: r.cancelledBooked.length, surplus: r.surplus.length, cancelledUnbooked: r.cancelledUnbooked,
      })}\n`);
      const missing = (['issued', 'received'] as const).filter((d) => !r.covered[d]);
      for (const d of missing) err.write(`${t('sat.reconcile.not_loaded', { direction: d })}\n`);
      const clean = rows.length === 0 && missing.length === 0;
      await deps.shutdown(clean ? ExitCode.OK : ExitCode.VALIDATION);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  });
}
