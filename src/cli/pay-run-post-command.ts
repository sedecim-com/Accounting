import type { Command } from 'commander';
import type { EntityScope } from '../database/scope.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { conLlave, hashDeCarga, mirarLlave } from '../services/idempotency/idempotency-store.js';
import {
  draftPayRunEntry,
  postPayRunEntry,
  previewPayRunEntry,
  type PayRunEntry,
} from '../services/payroll/common/gl-posting-service.js';
import { t } from '../i18n/index.js';
import type { Palette } from './palette.js';
import {
  abortedByUser,
  declareRisk,
  gateMutation,
  legible,
  render,
  withContext,
  withOutput,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine pay-run post · corrida contabilizar — MNE-001-069 (#306, part 3/4)
//
// The entry of an approved run. As the catalog row fixes it
// (docs/cli-command-catalog.md, «pay-run post»), it is built and LEFT AS A
// DRAFT for the `mnemosine review` that already exists; `--post` is the
// explicit escape that posts it directly, like `onboard --post`. Both roads
// and the dry run call gl-posting-service.ts, the same service as the REST
// route: none of them adds a peso.
//
// The service refuses, under a lock on the run, a run that is not approved or
// paid, a run that already has its entry, and a run whose draft is waiting for
// review or was approved by it. Those refusals exit 5 (blocked by state).
// ============================================================

export interface PayRunPostHelpers {
  palette: Palette;
  run: (fn: () => Promise<ExitCodeValue | void>) => Promise<void>;
  scopeForWrite: (opts: PostOpts) => Promise<EntityScope>;
  ask: (question: string) => Promise<boolean>;
  blockedOnConflict: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface PostOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  post?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  idempotencyKey?: string;
}

/** What the leaf did, as recorded under the idempotency key. */
export type PostOutcome = {
  mode: 'dry_run' | 'draft' | 'posted';
  draft_id: string | null;
  journal_entry_id: string | null;
  entry_number: string | null;
  entry: PayRunEntry;
} & Record<string, unknown>;

/** The entry as printable rows, one per line. */
export function entryRows(entry: PayRunEntry): Row[] {
  return entry.lines.map((l) => ({
    account: l.account_code,
    debit: l.debit_amount,
    credit: l.credit_amount,
    description: l.description,
  }));
}

const EXAMPLES = `
Examples:
  # ALWAYS this one first: the entry the run would book, and whether it balances.
  mnemosine pay-run post 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d --dry-run
  # The entry as a draft; a person approves it in \`mnemosine review\`.
  mnemosine pay-run post 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d
  # The escape: post it directly, with a key so a retry does not post twice.
  mnemosine pay-run post 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d --post --yes --idempotency-key poliza-2026-07-1
`;

export function registerPayRunPostCommand(payRun: Command, h: PayRunPostHelpers): void {
  const p = h.palette;
  const post = payRun
    .command('post')
    .alias('contabilizar')
    .argument('<id>', 'approved pay run whose entry is built')
    .description(
      'Build the payroll entry of an approved run and leave it as a draft for `mnemosine review`; ' +
        '--post posts it directly'
    );
  withContext(post);
  withOutput(post);
  post.option('--post', 'post the entry to the ledger now instead of leaving a draft for review');
  declareRisk(post, {
    // The worst road decides the class: with --post the entry is POSTED.
    risk: 'irreversible',
    agent: false,
    llave: { scope: 'pay-run post' },
    writes:
      'ai_drafts (one pending_review draft of the run entry); with --post instead journal_entries + ' +
      'journal_entry_lines POSTED by the engine and pay_runs.journal_entry_id',
  });
  post.addHelpText('after', EXAMPLES);
  post.action((id: string, opts: PostOpts, cmd: Command) =>
    h.run(async () => {
      const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
      const scope = await h.scopeForWrite(opts);
      const reviewer = await resolveReviewer(scope.tenantId, opts.user);
      const road = opts.post === true ? 'post' : 'draft';
      const key = {
        scope: 'pay-run post',
        clave: opts.idempotencyKey,
        payloadHash: hashDeCarga(scope.entityId, id, road),
      };

      // The key is looked at BEFORE the rehearsal: a retry finds the run
      // already drafted or posted, and the rehearsal would refuse it instead
      // of returning the recorded result the key promises.
      const recorded = dryRun ? undefined : await mirarLlave<PostOutcome>({ tenantId: scope.tenantId }, key);
      let outcome: PostOutcome;
      let repeated = recorded !== undefined;
      if (recorded !== undefined) {
        outcome = recorded;
      } else {
        const entry = await h.blockedOnConflict(() => previewPayRunEntry(id, scope.tenantId, scope.entityId));
        outcome = { mode: 'dry_run', draft_id: null, journal_entry_id: null, entry_number: null, entry };
        if (!dryRun) {
          if (road === 'post' && opts.yes !== true) {
            const ok = await h.ask(
              t('payrun.post.confirm', { id, debits: entry.totalDebits, credits: entry.totalCredits })
            );
            if (!ok) throw abortedByUser({ key: 'payrun.post.aborted' });
          }
          const done = await conLlave<PostOutcome>(
            { tenantId: scope.tenantId, entityId: scope.entityId },
            key,
            async () => {
              if (road === 'post') {
                const r = await h.blockedOnConflict(() =>
                  postPayRunEntry(id, reviewer.userId, scope.tenantId, scope.entityId)
                );
                return {
                  mode: 'posted',
                  draft_id: null,
                  journal_entry_id: r.journalEntryId,
                  entry_number: r.entryNumber,
                  entry: r.entry,
                };
              }
              const r = await h.blockedOnConflict(() => draftPayRunEntry(id, scope.tenantId, scope.entityId));
              return { mode: 'draft', draft_id: r.draftId, journal_entry_id: null, entry_number: null, entry: r.entry };
            }
          );
          outcome = done.resultado;
          repeated = done.repetido;
        }
      }

      const e = outcome.entry;
      if (!legible(opts)) {
        render(
          [
            {
              pay_run: id,
              mode: outcome.mode,
              repeated,
              draft_id: outcome.draft_id,
              journal_entry_id: outcome.journal_entry_id,
              entry_number: outcome.entry_number,
              entry_date: e.entryDate,
              total_debits: e.totalDebits,
              total_credits: e.totalCredits,
              lines: entryRows(e),
            },
          ],
          { ...opts, idField: 'pay_run' }
        );
        return;
      }
      render(entryRows(e), { ...opts, idField: 'account', numeric: ['debit', 'credit'] });
      const params = {
        id,
        debits: e.totalDebits,
        credits: e.totalCredits,
        draft: outcome.draft_id ?? '',
        number: outcome.entry_number ?? '',
      };
      if (repeated) process.stderr.write(`${p.green('✔')} ${t('payrun.post.repeated', params)}\n`);
      if (outcome.mode === 'dry_run') process.stderr.write(`${p.yellow('◑')} ${t('payrun.post.dry_run', params)}\n`);
      else if (outcome.mode === 'draft') process.stderr.write(`${p.green('✔')} ${t('payrun.post.drafted', params)}\n`);
      else process.stderr.write(`${p.green('✔')} ${t('payrun.post.posted', params)}\n`);
    })
  );
}
