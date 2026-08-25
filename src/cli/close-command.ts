import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import {
  listClosablePeriods, nextPeriodToClose, getCloseReadiness,
  type CloseReadiness,
} from '../ai/close-service.js';
import { softClosePeriod, hardClosePeriod } from '../services/accounting/period-close.js';
import { resolveEntity, bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';

// ============================================================
// mnemosine cierre
// Answers "can I close the month?" and, if so, closes it.
// Soft close first (reversible, blocks new entries), hard close
// only as an explicit second step.
// ============================================================

export interface CloseCliDeps {
  palette: {
    dim: (s: string) => string; bold: (s: string) => string;
    cyan: (s: string) => string; red: (s: string) => string;
  };
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
  ask?: (rl: readline.Interface, prompt: string) => Promise<string | null>;
}

const MARK = { done: '✔', missing: '✘' } as const;

/** Pure render: testable without a database or a terminal. */
export function renderReadiness(r: CloseReadiness, c: CloseCliDeps['palette']): string[] {
  const out: string[] = [''];
  const p = r.period;
  out.push(
    c.bold(`${p.period_name}`) +
      c.dim(`  ${p.start_date} → ${p.end_date} · ${p.status}${p.overdue ? ' · overdue' : ''}`)
  );
  out.push('');

  for (const item of r.checklist) {
    const mark = item.is_complete ? MARK.done : MARK.missing;
    out.push(`  ${mark} ${item.item}${item.details ? c.dim(`  ${item.details}`) : ''}`);
  }

  if (r.blockingIssues.length > 0) {
    out.push('');
    out.push(c.red('  Blocking:'));
    for (const b of r.blockingIssues) out.push(c.red(`    · ${b}`));
  }
  if (r.warnings.length > 0) {
    out.push('');
    out.push('  Warnings:');
    for (const w of r.warnings) out.push(c.dim(`    · ${w}`));
  }

  out.push('');
  out.push(
    r.canClose
      ? '  Ready to close.'
      : c.red('  Cannot close yet: resolve the blocking items above.')
  );
  out.push('');
  return out;
}

export function registerCloseCommand(program: Command, deps: CloseCliDeps): void {
  program
    .command('close')
    .alias('cierre')
    .description('Month-end close: checks what is missing and closes the period')
    .option('-e, --entity <idOrName>', 'Legal entity')
    .option('-t, --tenant <id>', 'Tenant')
    .option('-u, --user <email>', 'Who performs the close')
    .option('-p, --period <name>', 'Period to close (default: the oldest open one)')
    .option('-l, --list', 'List closable periods and exit')
    .option('--check', 'Only check readiness, never close')
    .option('--hard', 'Hard close (irreversible) instead of soft close')
    .option('--json', 'JSON output for scripts')
    .action(async (opts: {
      entity?: string; tenant?: string; user?: string; period?: string;
      list?: boolean; check?: boolean; hard?: boolean; json?: boolean;
    }) => {
      let rl: readline.Interface | undefined;
      try {
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const periods = await listClosablePeriods(ctx);

        if (periods.length === 0) {
          console.log('No open periods: nothing to close.');
          await deps.shutdown(0);
        }

        if (opts.list) {
          console.log('');
          for (const p of periods) {
            const tag = p.overdue ? ' · overdue' : '';
            console.log(`  ${p.period_name}  ${deps.palette.dim(`${p.start_date} → ${p.end_date} · ${p.status}${tag}`)}`);
          }
          console.log('');
          await deps.shutdown(0);
        }

        // A period cannot be closed while an earlier one is open, so the
        // default is always the oldest — never "the current month".
        const period = opts.period
          ? periods.find((p) => p.period_name.toLowerCase().includes(opts.period!.toLowerCase()))
          : await nextPeriodToClose(ctx);

        if (!period) {
          console.error(`No open period matches "${opts.period}".`);
          console.error(`Available: ${periods.map((p) => p.period_name).join(', ')}`);
          return deps.shutdown(1);
        }

        const readiness = await getCloseReadiness(ctx, period);

        if (opts.json) {
          console.log(JSON.stringify(readiness, null, 2));
          await deps.shutdown(readiness.canClose ? 0 : 1);
        }

        for (const line of renderReadiness(readiness, deps.palette)) console.log(line);

        if (opts.check || !readiness.canClose) {
          // Exit 1 when it cannot close: a cron can act on that.
          await deps.shutdown(readiness.canClose ? 0 : 1);
        }

        // Closing changes what can be posted: always confirm.
        const kind = opts.hard ? 'HARD close (irreversible)' : 'soft close (reversible)';
        if (!stdin.isTTY) {
          console.log(deps.palette.dim(`Not a terminal: not closing. Run without --check in a terminal.`));
          await deps.shutdown(0);
        }
        rl = readline.createInterface({ input: stdin, output: stdout });
        const askFn = deps.ask ?? (async (r: readline.Interface, q: string) => r.question(q).catch(() => null));
        const answer = await askFn(rl, deps.palette.cyan(`Proceed with ${kind}? [y/N] `));
        rl.close();
        rl = undefined;

        if (!answer || !/^y|^s/i.test(answer.trim())) {
          console.log('Cancelled.');
          await deps.shutdown(0);
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const closed = opts.hard
          ? await hardClosePeriod(period.id, ctx.entityId, reviewer.userId)
          : await softClosePeriod(period.id, ctx.entityId, reviewer.userId);

        console.log(`✔ ${period.period_name} is now ${closed.status} (by ${reviewer.email})`);
        if (!opts.hard) {
          console.log(deps.palette.dim('  Soft close is reversible. To seal it: mnemosine close --hard'));
        }
        await deps.shutdown(0);
      } catch (err) {
        rl?.close();
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });
}
