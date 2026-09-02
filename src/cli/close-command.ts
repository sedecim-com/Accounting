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
import { declareRisk, gateMutation } from './kernel/risk.js';
import { abortedByUser, exitCodeFor } from './kernel/index.js';
import { confirmarConReintento, noEntendi } from './kernel/confirmacion.js';
import { conLlave, hashDeCarga } from '../services/idempotency/idempotency-store.js';

// ============================================================
// mnemosine cierre
// Answers "can I close the month?" and, if so, closes it.
// Soft close first (reversible, blocks new entries), hard close
// only as an explicit second step.
//
// One leaf, declared at its gravest path (S0.6). The catalog's
// REGISTRY §5 #6 rules that `close --check` STAYS a flag of this
// leaf — `closing check` does not replace it — so the risk is
// declared irreversible (the --hard path) and the kernel's flags
// are honored here: --dry-run reports without writing, --yes
// skips the prompt (and a non-TTY run without it aborts loudly
// instead of pretending), --idempotency-key is stored on success,
// and --reason lands in the audit trail of the close.
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

/**
 * La doble compuerta del cierre, extraída para poder probarla sin base de
 * datos. Primero el sí/no por el kernel (aquí vivía la alternancia sin
 * anclar que dejaba que «salir» cerrara el periodo); después, sólo para
 * --hard, el listón de `terraform destroy`: un cierre duro no se deshace,
 * así que el sí no basta y hay que teclear el NOMBRE del periodo que se va
 * a cerrar. --yes salta ambas preguntas desde el action, nunca desde aquí.
 */
export async function confirmarCierre(
  preguntar: (prompt: string) => Promise<string | null>,
  c: CloseCliDeps['palette'],
  kind: string,
  destino: { hard: boolean; periodName: string }
): Promise<{ procede: boolean; mensaje?: string }> {
  const veredicto = await confirmarConReintento(preguntar, c.cyan(`Proceed with ${kind}? [y/N] `));
  if (!veredicto.si) {
    return {
      procede: false,
      mensaje:
        veredicto.incomprendida !== undefined
          ? `${noEntendi(veredicto.incomprendida)} — Cancelled.`
          : 'Cancelled.',
    };
  }
  if (destino.hard) {
    const escrito = await preguntar(
      c.cyan(
        `A hard close cannot be undone. Type the period name (${destino.periodName}) to confirm: `
      )
    );
    if ((escrito ?? '').trim() !== destino.periodName) {
      return {
        procede: false,
        mensaje: `That does not match ${destino.periodName}: nothing was closed.`,
      };
    }
  }
  return { procede: true };
}

export function registerCloseCommand(program: Command, deps: CloseCliDeps): void {
  const close = program
    .command('close')
    .alias('cierre')
    .description('Month-end close: checks what is missing and closes the period')
    .option('-e, --entity <idOrName>', 'Legal entity')
    .option('-t, --tenant <id>', 'Tenant')
    .option('-u, --user <email>', 'Who performs the close')
    // Sin forma corta: el diccionario reserva -p a --provider (R6).
    .option('--period <name>', 'Period to close (default: the oldest open one)')
    .option('-l, --list', 'List closable periods and exit')
    .option('--check', 'Only check readiness, never close')
    .option('--hard', 'Hard close (irreversible) instead of soft close')
    .option('--reason <text>', 'why this close happens now; recorded in the audit trail')
    .option('--json', 'JSON output for scripts');
  // Declarado por su camino más grave: --hard genera asientos de cierre y
  // arrastra saldos, y no se deshace re-ejecutando. El kernel añade
  // --dry-run, --yes e --idempotency-key, y le niega el comando al agente.
  declareRisk(close, {
    risk: 'irreversible',
    writes: 'fiscal_periods; con --hard, asientos de cierre POSTEADOS y arrastre de saldos',
  });
  close.action(async (opts: {
      entity?: string; tenant?: string; user?: string; period?: string;
      list?: boolean; check?: boolean; hard?: boolean; json?: boolean;
      yes?: boolean; reason?: string; idempotencyKey?: string;
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

        const { dryRun, reason } = gateMutation(close, opts);
        const kind = opts.hard ? 'HARD close (irreversible)' : 'soft close (reversible)';

        if (dryRun) {
          // El mismo veredicto que el acto real daría: aquí sólo se llega con
          // canClose en verde, así que la marcha seca informa y sale 0.
          console.log(deps.palette.bold(`Would ${opts.hard ? 'hard' : 'soft'} close ${period.period_name}.`));
          console.log(deps.palette.dim('  (dry-run: nothing was written)'));
          await deps.shutdown(0);
        }

        // Closing changes what can be posted: always confirm. Without a
        // terminal there is nobody to ask, so the command refuses instead of
        // assuming consent — re-run with --yes once you are sure.
        if (!opts.yes) {
          if (!stdin.isTTY) {
            throw abortedByUser(
              `Proceed with ${kind}? — there is no terminal to ask on. ` +
                'Re-run with --yes once you are sure, or with --dry-run to see the effect first.'
            );
          }
          rl = readline.createInterface({ input: stdin, output: stdout });
          const askFn = deps.ask ?? (async (r: readline.Interface, q: string) => r.question(q).catch(() => null));
          const r = rl;
          const veredicto = await confirmarCierre((q) => askFn(r, q), deps.palette, kind, {
            hard: opts.hard === true,
            periodName: period.period_name,
          });
          rl.close();
          rl = undefined;
          if (!veredicto.procede) {
            console.log(veredicto.mensaje);
            await deps.shutdown(0);
          }
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const acto = await conLlave(
          { tenantId: ctx.tenantId, entityId: ctx.entityId },
          {
            scope: 'close',
            clave: opts.idempotencyKey,
            payloadHash: hashDeCarga(period.id, opts.hard ? 'hard' : 'soft'),
          },
          async () => {
            const closed = opts.hard
              ? await hardClosePeriod(period.id, ctx.entityId, reviewer.userId, reason)
              : await softClosePeriod(period.id, ctx.entityId, reviewer.userId, reason);
            return { period_name: period.period_name, status: closed.status };
          }
        );

        if (acto.repetido) {
          console.log(
            `↩ Idempotency hit: key "${opts.idempotencyKey}" already closed ` +
              `${acto.resultado.period_name} (now ${acto.resultado.status}). Nothing was executed again.`
          );
          await deps.shutdown(0);
        }

        console.log(`✔ ${acto.resultado.period_name} is now ${acto.resultado.status} (by ${reviewer.email})`);
        if (!opts.hard) {
          console.log(deps.palette.dim('  Soft close is reversible. To seal it: mnemosine close --hard'));
        }
        await deps.shutdown(0);
      } catch (err) {
        rl?.close();
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });
}
