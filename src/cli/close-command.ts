import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import {
  listClosablePeriods, nextPeriodToClose, getCloseReadiness,
  type CloseReadiness,
} from '../ai/close-service.js';
import {
  softClosePeriod, hardClosePeriod, type CarryForwardResult,
} from '../services/accounting/period-close.js';
import { bootstrapTenant } from '../ai/context.js';
import { resolveClosablePeriod } from './kernel/closable-period.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { declareRisk, gateMutation } from './kernel/risk.js';
import {
  abortedByUser, exitCodeFor, notFound, resolveActiveEntity, describeCommand, optionByKey, withContext,
} from './kernel/index.js';
import { confirmarConReintento, noEntendi, yesNoPrompt } from './kernel/confirmacion.js';
import { conLlave, hashDeCarga } from '../services/idempotency/idempotency-store.js';
import { t } from '../i18n/index.js';

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
  /** Where `entity use` keeps its pin; tests point it at a temp dir. */
  home?: string;
}

const MARK = { done: '✔', missing: '✘' } as const;

/**
 * What a hard close's carry-forward reached. A locked period stops it and is
 * named, because every month from there on still opens at the old figure and
 * only a correction in an open period can fix that (#99).
 */
export function renderCarryForward(r: CarryForwardResult, c: CloseCliDeps['palette']): string[] {
  const lines: string[] = [];
  if (r.periods.length > 0) {
    lines.push(c.dim(`  ${t('close.carry.into', { periods: r.periods.join(', ') })}`));
  }
  if (r.stopped_at_locked) {
    lines.push(
      c.red(`  ✘ ${t('close.carry.locked', { period: r.stopped_at_locked })}`),
      c.dim(`    ${t('close.carry.locked_detail')}`)
    );
  }
  return lines;
}

/** Pure render: testable without a database or a terminal. */
export function renderReadiness(r: CloseReadiness, c: CloseCliDeps['palette']): string[] {
  const out: string[] = [''];
  const p = r.period;
  out.push(
    c.bold(`${p.period_name}`) +
      c.dim(`  ${p.start_date} → ${p.end_date} · ${p.status}${p.overdue ? t('ledger.period.show.overdue') : ''}`)
  );
  out.push('');

  for (const item of r.checklist) {
    const mark = item.is_complete ? MARK.done : MARK.missing;
    out.push(`  ${mark} ${item.item}${item.details ? c.dim(`  ${item.details}`) : ''}`);
  }

  if (r.blockingIssues.length > 0) {
    out.push('');
    out.push(c.red(`  ${t('closing.readiness.blocking')}`));
    for (const b of r.blockingIssues) out.push(c.red(`    · ${b}`));
  }
  if (r.warnings.length > 0) {
    out.push('');
    out.push(`  ${t('closing.readiness.warnings')}`);
    for (const w of r.warnings) out.push(c.dim(`    · ${w}`));
  }

  out.push('');
  out.push(
    r.canClose
      ? `  ${t('close.ready')}`
      : c.red(`  ${t('close.not_ready')}`)
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
  const veredicto = await confirmarConReintento(preguntar, c.cyan(yesNoPrompt(t('close.confirm.proceed', { kind }))));
  if (!veredicto.si) {
    return {
      procede: false,
      mensaje:
        veredicto.incomprendida !== undefined
          ? `${noEntendi(veredicto.incomprendida)} — ${t('ledger.period.reopen.cancelled')}`
          : t('ledger.period.reopen.cancelled'),
    };
  }
  if (destino.hard) {
    const escrito = await preguntar(
      c.cyan(`${t('close.confirm.type_name', { period: destino.periodName })} `)
    );
    if ((escrito ?? '').trim() !== destino.periodName) {
      return {
        procede: false,
        mensaje: t('close.confirm.mismatch', { period: destino.periodName }),
      };
    }
  }
  return { procede: true };
}

// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// `--period` takes YYYY-MM, the period id, or an unambiguous part of its
// name — the grammar of `period show` and every other family (#327). A
// YYYY-MM that two periods share is refused: December and the year-end
// adjustments period (13) both start in December, and only closing 13 posts
// the annual closing entries (period-close.ts, isYearEnd).
//
// Sin `--period` cierra el periodo abierto MÁS ANTIGUO, que es lo correcto:
// uno no se cierra mientras otro anterior siga abierto.
// Prosa en inglés (idioma del nodo), datos mexicanos.
// ============================================================
const EJEMPLOS = `
Examples:
  # What is still missing before the oldest open period can be closed.
  mnemosine close --check
  # The periods that can be closed right now, and nothing else.
  mnemosine close --list
  # Soft-close one month.
  mnemosine close --period 2026-07 --reason "Cierre mensual de julio"
  # Hard-close a month. It is irreversible: see it first.
  mnemosine close --period 2026-11 --hard --reason "Cierre definitivo de noviembre" --dry-run
  # The annual close is the hard close of the year-end adjustments period (13):
  # it posts the closing entries. 2026-12 is refused because December shares
  # it, so name period 13 by its full name or its id.
  mnemosine close --period "Year-end adjustments 2026" --hard --reason "Cierre anual 2026" --dry-run
`;

export function registerCloseCommand(program: Command, deps: CloseCliDeps): void {
  // Help by key (#314): help.close.{description,option.<flag>}.
  const close = describeCommand(program.command('close').alias('cierre'), 'help.close.description');
  // The generic context flags reuse cli.flag.* (owner's decision on #152).
  withContext(close);
  // Sin forma corta: el diccionario reserva -p a --provider (R6).
  optionByKey(close, '--period <expr>', 'help.close.option.period');
  optionByKey(close, '-l, --list', 'help.close.option.list');
  optionByKey(close, '--check', 'help.close.option.check');
  optionByKey(close, '--hard', 'help.close.option.hard');
  optionByKey(close, '--reason <text>', 'help.close.option.reason');
  optionByKey(close, '--json', 'help.close.option.json');
  // Declarado por su camino más grave: --hard genera asientos de cierre y
  // arrastra saldos, y no se deshace re-ejecutando. El kernel añade
  // --dry-run, --yes e --idempotency-key, y le niega el comando al agente.
  declareRisk(close, {
    risk: 'irreversible',
    llave: { scope: 'close' },
    writes: 'fiscal_periods; with --hard, POSTED closing entries and the carry-forward of balances',
  });
  close.addHelpText('after', EJEMPLOS);
  close.action(async (opts: {
      entity?: string; tenant?: string; user?: string; period?: string;
      list?: boolean; check?: boolean; hard?: boolean; json?: boolean;
      yes?: boolean; reason?: string; idempotencyKey?: string;
    }) => {
      let rl: readline.Interface | undefined;
      try {
        bootstrapTenant(opts.tenant);
        // The same precedence as every other leaf: -e, MNEMOSINE_ENTITY, the
        // `entity use` pin, and only then the single-entity fallback.
        const { ctx } = await resolveActiveEntity({ entity: opts.entity }, { home: deps.home });
        const periods = await listClosablePeriods(ctx);

        if (periods.length === 0) {
          console.log(t('close.none_open'));
          await deps.shutdown(0);
        }

        if (opts.list) {
          console.log('');
          for (const p of periods) {
            const tag = p.overdue ? t('ledger.period.show.overdue') : '';
            console.log(`  ${p.period_name}  ${deps.palette.dim(`${p.start_date} → ${p.end_date} · ${p.status}${tag}`)}`);
          }
          console.log('');
          await deps.shutdown(0);
        }

        // A period cannot be closed while an earlier one is open, so the
        // default is always the oldest — never "the current month".
        const period = opts.period
          ? await resolveClosablePeriod(ctx, opts.period, periods)
          : await nextPeriodToClose(ctx);
        if (!period) throw notFound({ key: 'close.none_open' });

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
        const kind = t(opts.hard ? 'close.kind.hard' : 'close.kind.soft');

        if (dryRun) {
          // El mismo veredicto que el acto real daría: aquí sólo se llega con
          // canClose en verde, así que la marcha seca informa y sale 0.
          console.log(deps.palette.bold(t('close.dry_run.would', { mode: opts.hard ? 'hard' : 'soft', period: period.period_name })));
          console.log(deps.palette.dim(`  ${t('close.dry_run.nothing')}`));
          await deps.shutdown(0);
        }

        // Closing changes what can be posted: always confirm. Without a
        // terminal there is nobody to ask, so the command refuses instead of
        // assuming consent — re-run with --yes once you are sure.
        if (!opts.yes) {
          if (!stdin.isTTY) {
            throw abortedByUser({ key: 'ap.payment.confirm.no_terminal', params: { question: { key: 'close.confirm.proceed_as', params: { mode: opts.hard ? 'hard' : 'soft' } } } });
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
          async (): Promise<{ period_name: string; status: string; carry_forward?: CarryForwardResult }> => {
            if (opts.hard) {
              const sealed = await hardClosePeriod(period.id, ctx.entityId, reviewer.userId, reason);
              return {
                period_name: period.period_name,
                status: sealed.status,
                carry_forward: sealed.carry_forward,
              };
            }
            const closed = await softClosePeriod(period.id, ctx.entityId, reviewer.userId, reason);
            return { period_name: period.period_name, status: closed.status };
          }
        );

        if (acto.repetido) {
          const hit = { key: String(opts.idempotencyKey), period: acto.resultado.period_name, status: acto.resultado.status };
          console.log(`↩ ${t('close.idempotency_hit', hit)}`);
          await deps.shutdown(0);
        }

        console.log(`✔ ${t('close.done', { period: acto.resultado.period_name, status: acto.resultado.status, email: reviewer.email })}`);
        if (acto.resultado.carry_forward) {
          for (const line of renderCarryForward(acto.resultado.carry_forward, deps.palette)) console.log(line);
        }
        if (!opts.hard) {
          console.log(deps.palette.dim(`  ${t('close.soft_reversible', { command: 'mnemosine close --hard' })}`));
        }
        await deps.shutdown(0);
      } catch (err) {
        rl?.close();
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });
}
