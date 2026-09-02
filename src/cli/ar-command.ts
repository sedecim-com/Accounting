import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { arReconcile, runArChecks, AR_CHECK_NAMES } from '../services/ar/ar-controls.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  resolveActiveEntity,
  checkExitCode,
  exitCodeFor,
} from './kernel/index.js';

// ============================================================
// mnemosine ar · cxc
//
// Los controles de la cartera: `ar reconcile` (el auxiliar contra la cuenta
// de control, con los asientos manuales que la tocaron como sospechosos
// nombrados) y `ar check` (la batería de diagnósticos que `close --check`
// consumirá). Lectura pura, abierta al agente: medir nunca es peligroso;
// lo peligroso es no medir.
//
// El contrato de salida de un check es el del núcleo: exit 0 limpio, 4 con
// hallazgos bloqueantes (o advertencias bajo --strict) — el mismo idioma
// que doctor y que el trinquete del plan.
// ============================================================

export interface ArCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  strict?: boolean;
  check?: string | boolean;
}

export function registerArCommand(program: Command, deps: ArCommandDeps): void {
  const ar = program
    .command('ar')
    .alias('cxc')
    .description('Receivables controls: reconcile the subledger against the control account, run named diagnostics');

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  const entityOf = async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity(
      { entity: opts.entity },
      { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
    );
    return ctx;
  };

  // ---- ar reconcile ------------------------------------------------
  const reconcile = ar
    .command('reconcile')
    .alias('conciliar')
    .description('Subledger (open invoices − unapplied credit notes) vs the cxc control account, naming manual entries');
  withOutput(withContext(reconcile));
  reconcile.option('--strict', 'exit 4 on any delta, however small the list of suspects');
  declareRisk(reconcile, { risk: 'lectura', agent: true });
  reconcile.action((opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const r = await arReconcile(ctx.entityId);
      const p = deps.palette;

      if (opts.json || opts.output || opts.format) {
        render([r as unknown as Record<string, unknown>], {
          ...opts,
          idField: 'delta',
          numeric: ['control_balance', 'open_invoices', 'unapplied_credit_notes', 'subledger_net', 'delta'],
        });
      } else {
        const out = process.stdout;
        out.write(
          `\n${p.bold('AR reconciliation')} ${p.dim(`· control ${r.control_account?.code ?? ''} ${r.control_account?.name ?? ''}`)}\n\n`
        );
        const linea = (label: string, value: string) =>
          out.write(`  ${p.dim(label.padEnd(28))}${value.padStart(14)}\n`);
        linea('Control account balance', r.control_balance);
        linea('Open invoices', r.open_invoices);
        linea('− Credit notes unapplied', r.unapplied_credit_notes);
        linea('Subledger net', r.subledger_net);
        out.write(
          r.balanced
            ? `\n${p.green('✔')} Balanced.\n`
            : `\n${p.red('✘')} Delta ${p.bold(r.delta)} — the subledger and the ledger tell different stories.\n`
        );
        if (r.manual_entries.length) {
          out.write(`\n${p.bold('Manual entries touching the control account')} ${p.dim(`(${r.manual_entries.length})`)}\n`);
          render(
            r.manual_entries.map((m) => ({
              entry: m.entry_number,
              date: m.entry_date instanceof Date ? m.entry_date.toISOString().slice(0, 10) : m.entry_date,
              amount: m.amount,
              description: m.description,
            })),
            { format: 'table', numeric: ['amount'] }
          );
          out.write(
            p.dim('  A manual entry on a control account is the classic cause of a delta nobody can find.\n')
          );
        }
      }

      if (!r.balanced) await deps.shutdown(4);
    })
  );

  // ---- ar check ----------------------------------------------------
  const check = ar
    .command('check')
    .alias('verificar')
    .description('Named receivables diagnostics; `--check` with no value lists them, `--check a,b` selects');
  withOutput(withContext(check));
  check
    .option('--check [names]', 'comma-separated diagnostics to run; bare --check lists the battery')
    .option('--strict', 'exit 4 on warnings too, not only blocking findings');
  declareRisk(check, { risk: 'lectura', agent: true });
  check.action((opts: CommonOpts) =>
    run(async () => {
      const p = deps.palette;
      // `--check` sin valor: el catálogo de la batería, sin tocar la base.
      if (opts.check === true) {
        render(
          AR_CHECK_NAMES.map((name) => ({ check: name })),
          { ...opts, idField: 'check', total: AR_CHECK_NAMES.length }
        );
        return;
      }

      const ctx = await entityOf(opts);
      const seleccion =
        typeof opts.check === 'string'
          ? opts.check.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined;
      const { results, blocking, warnings } = await runArChecks(ctx.entityId, { checks: seleccion });

      if (opts.json || opts.output || opts.format) {
        render(
          results.map((r) => ({
            check: r.name,
            level: r.level,
            count: r.count,
            detail: r.detail,
            sample: r.sample.join(' · '),
          })),
          { ...opts, idField: 'check', total: results.length }
        );
      } else {
        const out = process.stdout;
        out.write(`\n${p.bold('AR checks')} ${p.dim(`· ${ctx.entityName}`)}\n\n`);
        for (const r of results) {
          const icono =
            r.level === 'clean' ? p.green('✔') : r.level === 'warning' ? p.yellow('▲') : p.red('✘');
          out.write(`  ${icono} ${r.name.padEnd(24)} ${p.dim(r.detail)}\n`);
          for (const s of r.sample) out.write(`      ${p.dim(`· ${s}`)}\n`);
        }
        out.write(
          `\n${blocking ? p.red(`${blocking} blocking`) : p.green('0 blocking')} · ` +
            `${warnings ? p.yellow(`${warnings} warning(s)`) : p.dim('0 warnings')}\n`
        );
      }

      // El contrato del núcleo: bloqueante → 4; advertencia → 4 sólo con --strict.
      const code = checkExitCode({ blocking, warning: warnings }, { strict: opts.strict === true });
      if (code !== 0) await deps.shutdown(code);
    })
  );
}
