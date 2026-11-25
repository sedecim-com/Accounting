import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { arReconcile, runArChecks, AR_CHECK_NAMES, type ArCheckResult } from '../services/ar/ar-controls.js';
import { t } from '../i18n/index.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  resolveActiveEntity,
  checkExitCode,
  exitCodeFor,
  dateOnly,
  describeCommand,
  optionByKey,
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

// ============================================================
// EJEMPLOS · invocaciones copiables
//
// `--check` sin valor ENUMERA la batería en vez de correrla, que es la forma
// de descubrir los nombres sin salir del comando. Prosa en inglés (idioma del
// nodo), datos mexicanos.
// ============================================================
const EJEMPLOS = {
  reconcile: `
Examples:
  # The subledger against the cxc control account, naming the manual entries.
  mnemosine ar reconcile
  # Exit 4 on any delta, however small, so CI can block on it.
  mnemosine ar reconcile --strict
`,
  check: `
Examples:
  # List the diagnostics this battery can run, and run none of them.
  mnemosine ar check --check
  # Run two of them, failing on warnings too.
  mnemosine ar check --check duplicate-invoice,stale-unapplied-cash --strict
`,
} as const;

export function registerArCommand(program: Command, deps: ArCommandDeps): void {
  // Help by key (#314): help.ar.<leaf>.{description,option.<flag>}.
  const ar = describeCommand(program.command('ar').alias('cxc'), 'help.ar.description');

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
  const reconcile = describeCommand(ar.command('reconcile').alias('conciliar'), 'help.ar.reconcile.description');
  withOutput(withContext(reconcile));
  optionByKey(reconcile, '--strict', 'help.ar.reconcile.option.strict');
  declareRisk(reconcile, { risk: 'lectura', agent: true });
  reconcile.addHelpText('after', EJEMPLOS.reconcile);
  reconcile.action((opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const r = await arReconcile(ctx.entityId);
      const p = deps.palette;

      if (opts.json || opts.output || opts.format) {
        render([r as unknown as Record<string, unknown>], {
          ...opts,
          idField: 'delta',
          numeric: ['control_balance', 'open_invoices', 'unapplied_credit_notes', 'fx_revaluation', 'subledger_net', 'delta'],
        });
      } else {
        const out = process.stdout;
        out.write(
          `\n${p.bold(t('ar.reconcile.title'))} ` +
            `${p.dim(`· ${t('ar.reconcile.header', { code: r.control_account?.code ?? '', name: r.control_account?.name ?? '' })}`)}\n\n`
        );
        // The fixed labels set the width (28 at least, the English one); a long foreign row overflows as before.
        const control = t('ar.reconcile.row.control_balance');
        const open = t('ar.reconcile.row.open_invoices');
        const unapplied = `− ${t('ar.reconcile.row.unapplied_credit_notes')}`;
        const fx = `+ ${t('ar.reconcile.row.fx_revaluation')}`;
        const net = t('ar.reconcile.row.subledger_net');
        const width = Math.max(28, ...[control, open, unapplied, fx, net].map((label) => label.length + 1));
        const linea = (label: string, value: string) =>
          out.write(`  ${p.dim(label.padEnd(width))}${value.padStart(14)}\n`);
        const foreign = (f: { currency: string; foreign: string }) =>
          `  ${t('ap.reconcile.row.foreign', { currency: f.currency, foreign: f.foreign })}`;
        linea(control, r.control_balance);
        linea(open, r.open_invoices);
        for (const f of r.foreign_open) linea(foreign(f), f.book);
        linea(unapplied, r.unapplied_credit_notes);
        for (const f of r.foreign_unapplied) linea(foreign(f), f.book);
        // MNE-001-112: this control has no cut-off date, so a revaluation and its
        // day-1 mirror net to zero; the line shows only when a mirror is missing.
        if (r.fx_revaluation !== '0.00') linea(fx, r.fx_revaluation);
        linea(net, r.subledger_net);
        out.write(
          r.balanced
            ? `\n${p.green('✔')} ${t('ap.reconcile.balanced')}\n`
            : `\n${p.red('✘')} ${t('ar.reconcile.delta', { delta: p.bold(r.delta) })}\n`
        );
        if (r.manual_entries.length) {
          out.write(`\n${p.bold(t('ar.reconcile.manual_entries'))} ${p.dim(`(${r.manual_entries.length})`)}\n`);
          render(
            r.manual_entries.map((m) => ({
              entry: m.entry_number,
              date: dateOnly(m.entry_date),
              amount: m.amount,
              description: m.description,
            })),
            { format: 'table', numeric: ['amount'] }
          );
          out.write(
            p.dim(`  ${t('ar.reconcile.manual_note')}\n`)
          );
        }
      }

      if (!r.balanced) await deps.shutdown(4);
    })
  );

  // ---- ar check ----------------------------------------------------
  // A probe whose detail is keyed is rendered here, at the edge, in the reader's language.
  const detailOf = (r: ArCheckResult): string => (r.detailKey ? t(r.detailKey) : r.detail);
  const check = describeCommand(ar.command('check').alias('verificar'), 'help.ar.check.description');
  withOutput(withContext(check));
  optionByKey(check, '--check [names]', 'help.ar.check.option.check');
  optionByKey(check, '--strict', 'help.ar.check.option.strict');
  declareRisk(check, { risk: 'lectura', agent: true });
  check.addHelpText('after', EJEMPLOS.check);
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
            detail: detailOf(r),
            sample: r.sample.join(' · '),
          })),
          { ...opts, idField: 'check', total: results.length }
        );
      } else {
        const out = process.stdout;
        out.write(`\n${p.bold(t('ar.check.title'))} ${p.dim(`· ${ctx.entityName}`)}\n\n`);
        for (const r of results) {
          const icono =
            r.level === 'clean' ? p.green('✔') : r.level === 'warning' ? p.yellow('▲') : p.red('✘');
          out.write(`  ${icono} ${r.name.padEnd(24)} ${p.dim(detailOf(r))}\n`);
          for (const s of r.sample) out.write(`      ${p.dim(`· ${s}`)}\n`);
        }
        const blockingText = t('ar.check.blocking', { count: blocking });
        out.write(
          `\n${blocking ? p.red(blockingText) : p.green(blockingText)} · ` +
            `${warnings ? p.yellow(t('ar.check.warnings', { count: warnings })) : p.dim(t('ar.check.no_warnings'))}\n`
        );
      }

      // El contrato del núcleo: bloqueante → 4; advertencia → 4 sólo con --strict.
      const code = checkExitCode({ blocking, warning: warnings }, { strict: opts.strict === true });
      if (code !== 0) await deps.shutdown(code);
    })
  );
}
