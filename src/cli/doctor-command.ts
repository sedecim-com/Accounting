import type { Command } from 'commander';
import { runDoctor, type DoctorReport, type CheckLevel } from '../ai/doctor-service.js';

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
          console.log(JSON.stringify(report, null, 2));
        } else {
          for (const line of renderDoctor(report, deps.palette)) console.log(line);
        }
        // Exit 1 only on failures: a warn must not break a CI pipeline.
        await deps.shutdown(report.worst === 'fail' ? 1 : 0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });
}
