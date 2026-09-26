import type { Command } from 'commander';
import { runDoctor, type DoctorReport, type CheckLevel } from '../ai/doctor-service.js';
import { exitCodeFor } from './kernel/index.js';

// ============================================================
// mnemosine doctor
// ============================================================

export interface DoctorCliDeps {
  palette: { dim: (s: string) => string; bold: (s: string) => string; red: (s: string) => string };
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
}

const MARK: Record<CheckLevel, string> = { ok: '✔', warn: '⚠', fail: '✘' };

export function renderDoctor(report: DoctorReport, c: DoctorCliDeps['palette']): string[] {
  const out: string[] = ['', c.bold('Mnemosine health check'), ''];
  const pad = Math.max(...report.checks.map((ch) => ch.name.length));

  for (const ch of report.checks) {
    const mark = ch.level === 'fail' ? c.red(MARK.fail) : MARK[ch.level];
    out.push(`  ${mark} ${ch.name.padEnd(pad)}  ${ch.detail}`);
    if (ch.fix && ch.level !== 'ok') out.push(c.dim(`      → ${ch.fix}`));
    // On 'ok' the fix is an optional suggestion, not a correction.
    else if (ch.fix) out.push(c.dim(`      · ${ch.fix}`));
  }

  out.push('');
  if (report.worst === 'fail') {
    out.push(c.red('  There are failures that prevent operation. Resolve them in the order shown.'));
  } else if (report.worst === 'warn') {
    out.push('  Operational with warnings.');
  } else {
    out.push('  All good.');
  }
  out.push('');
  return out;
}

export function registerDoctorCommand(program: Command, deps: DoctorCliDeps): void {
  program
    .command('doctor')
    .description('Diagnoses system health: DB, migrations, provider, credentials, isolation')
    .option('--json', 'JSON output for scripts')
    .action(async (opts: { json?: boolean }) => {
      try {
        const report = await runDoctor();
        if (opts.json) {
          // THE WHOLE REPORT, NO FIELD PICKING, and that includes each check's
          // `id` alongside its `name` (#153, decision 3). Whoever consumes this
          // JSON groups and silences by `id`, which is stable; `name` is the
          // label and is headed for the i18n catalogue. Picking fields here —
          // or leaving the id out — would send that consumer back to grouping
          // by a translatable string, the defect #253 closed in the reports.
          // The test that pins it lives in tests/ai/doctor-service.spec.ts.
          console.log(JSON.stringify(report, null, 2));
        } else {
          for (const line of renderDoctor(report, deps.palette)) console.log(line);
        }
        // Exit 1 only on failures: a warn must not break a CI pipeline.
        await deps.shutdown(report.worst === 'fail' ? 1 : 0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });
}
