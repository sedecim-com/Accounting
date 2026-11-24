import * as readline from 'node:readline/promises';
import { confirmarConReintento, noEntendi, yesNoPrompt } from './kernel/confirmacion.js';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import {
  listFiscalPeriods,
  resolvePeriod,
  getPeriodDetail,
  openPeriod,
  reopenClosedPeriod,
  listFiscalYears,
  getFiscalYear,
  createFiscalYear,
  carryForwardIntoYear,
  assertFiscalYearNumber,
  PERIOD_STATUSES,
} from '../services/accounting/fiscal-calendar-service.js';
import { conLlave, hashDeCarga } from '../services/idempotency/idempotency-store.js';
import { AccountingError } from '../utils/errors.js';
import { t } from '../i18n/index.js';
import { day, translateDomainError } from './entry-command.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  gateMutation,
  render,
  legible,
  withContext,
  withForce,
  withOutput,
  withSelection,
  resolveActiveEntity,
  requireExplicitEntity,
  usageError,
  conflict,
  blockedByState,
  abortedByUser,
  exitCodeFor,
  ExitCode,
  type ExitCodeValue,
  describeCommand,
  optionByKey,
  argumentByKey,
} from './kernel/index.js';

// ============================================================
// mnemosine period · periodo   and   mnemosine year · ejercicio
// The fiscal calendar: which months exist, what state each one is in,
// and the one transition that had no driver anywhere — future → open.
//
// CLOSING IS NOT HERE. `close`/`cierre` is the single orchestrator of
// the monthly close (checklist → soft close → hard close → carry
// forward). A second door into closing would be a second answer to
// "is this month closed?", and the catalog is explicit that `close`
// keeps that job. So there is no `period close`: `mnemosine close`
// already is it.
// ============================================================

export interface PeriodCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  limit?: number;
  offset?: number;
  all?: boolean;
  status?: string[];
}

const PERIOD_COLUMNS = [
  'period_name', 'period_number', 'status', 'start_date', 'end_date', 'overdue',
] as const;

/**
 * How to put a reopened period back where it was. A hard-closed period needs
 * both steps: a soft close alone leaves it in 'soft_close', its carry-forward
 * is never redone, and every later month keeps opening at the old figure
 * while the chain check stays silent, because it only reads hard closes (#99).
 */
export function reopenRemedy(periodName: string, previousStatus: string): string[] {
  const close = `mnemosine close --period "${periodName}"`;
  return previousStatus === 'hard_close'
    ? [t('ledger.period.remedy.close_again', { close }), t('ledger.period.remedy.seal', { close })]
    : [t('ledger.period.remedy.close_again', { close })];
}

function periodRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    period_name: row.period_name,
    period_number: row.period_number,
    period_type: row.period_type,
    status: row.status,
    start_date: day(row.start_date),
    end_date: day(row.end_date),
    year: row.year_number,
    overdue: row.overdue === true ? 'yes' : '',
    id: row.id,
  };
}

function yearRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    year_number: row.year_number,
    status: row.status,
    start_date: day(row.start_date),
    end_date: day(row.end_date),
    is_calendar_year: row.is_calendar_year,
    periods: row.period_count,
    open: row.open_period_count,
    closed: row.closed_period_count,
    id: row.id,
  };
}

function makeRunner(deps: PeriodCommandDeps) {
  return async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? ExitCode.OK);
    } catch (err) {
      const mapped = translateDomainError(err);
      deps.reportError(mapped);
      await deps.shutdown(exitCodeFor(mapped));
    }
  };
}

/** Same note as the entry family: a write says which company it lands in. */
function announceTarget(
  deps: PeriodCommandDeps,
  opts: CommonOpts,
  ctx: { entityName: string }
): void {
  if (opts.entity) return;
  process.stderr.write(
    deps.palette.dim(`  ${t('ledger.period.active_entity', { entity: ctx.entityName })}\n`)
  );
}

function makeEntityResolver(deps: PeriodCommandDeps) {
  return async (opts: CommonOpts) => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity(
      { entity: opts.entity },
      { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
    );
    return ctx;
  };
}

// ============================================================
// EJEMPLOS · invocaciones copiables, con datos mexicanos
//
// El nombre del periodo se acuña en inglés y se GUARDA así ("July 2026",
// fiscal-calendar-service.ts), y estas hojas también aceptan AAAA-MM. Un año
// fiscal nace con sus doce periodos: los ya vencidos y el corriente abiertos,
// el resto en 'future' hasta que alguien los abra a propósito.
// Prosa en inglés (idioma del nodo), datos mexicanos.
// ============================================================
const EJEMPLOS = {
  periodList: `
Examples:
  # Every period of the entity with its state.
  mnemosine period list
  # One fiscal year only, as CSV.
  mnemosine period list --year 2026 --format csv
`,
  periodShow: `
Examples:
  # By the name the calendar minted.
  mnemosine period show "July 2026"
  # By year and month, which resolves to the same period.
  mnemosine period show 2026-07
`,
  periodOpen: `
Examples:
  # Open a future period so work can be captured in it.
  mnemosine period open "January 2027" --reason "Se anticipa la facturacion de enero"
  # See the transition without performing it.
  mnemosine period open 2027-01 --dry-run
`,
  yearList: `
Examples:
  # Every fiscal year with its state and close progress.
  mnemosine year list
  # As JSON, for a script.
  mnemosine year list --json
`,
  yearShow: `
Examples:
  # One fiscal year with each of its twelve periods and their states.
  mnemosine year show 2026
  # The same as CSV.
  mnemosine year show 2026 --format csv
`,
  periodReopen: `
Examples:
  # Reopen a soft-closed month so a correction lands in the month it belongs to.
  # --reason is required, and the audit trail keeps who, why and the previous state.
  mnemosine period reopen "July 2026" --reason "Llego un CFDI de CFE con fecha de julio"
  # See the transition first: nothing is written and nothing is recorded.
  mnemosine period reopen 2026-07 --dry-run
  # A hard-closed month keeps its closing entries and its carry-forward when it
  # reopens, so it also takes --force. A 'locked' month never reopens, not even
  # with it: the information already left the system.
  mnemosine period reopen "December 2026" --force --reason "Ajuste pedido por el auditor externo"
`,
  yearCreate: `
Examples:
  # Create a fiscal year: twelve monthly periods and the year-end adjustment period (13).
  mnemosine year create 2027
  # See the calendar it would create, writing nothing.
  mnemosine year create 2027 --dry-run
`,
} as const;

export function registerPeriodCommand(program: Command, deps: PeriodCommandDeps): void {
  // The help of this family is rendered by key (#314, pilot of the recipe):
  // help.period.<leaf>.{description,option.<flag>,argument.<name>}.
  const period = describeCommand(program.command('period').alias('periodo'), 'help.period.description');

  const run = makeRunner(deps);
  const entityOf = makeEntityResolver(deps);

  // ---- period list -------------------------------------------------
  const list = describeCommand(period.command('list').alias('listar'), 'help.period.list.description');
  withOutput(withSelection(withContext(list)));
  optionByKey(list, '--year <year>', 'help.period.list.option.year');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EJEMPLOS.periodList);
  list.action((opts: CommonOpts & { year?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      for (const state of opts.status ?? []) {
        if (!(PERIOD_STATUSES as readonly string[]).includes(state)) {
          throw usageError({ key: 'ledger.period.status_unknown', params: { value: state, statuses: PERIOD_STATUSES.join(', ') } });
        }
      }
      const yearNumber = opts.year ? Number(opts.year) : undefined;
      if (yearNumber !== undefined && !Number.isInteger(yearNumber)) {
        throw usageError({ key: 'ledger.period.year_invalid', params: { value: opts.year ?? '' } });
      }

      // Unlike `close --list`, which shows only what can be closed, this is
      // the whole calendar: future periods are exactly what `period open`
      // exists for, so hiding them would hide the work.
      const rows = await listFiscalPeriods(
        ctx.entityId,
        {
          status: opts.status?.length ? opts.status : undefined,
          yearNumber,
        },
        { includeYear: true }
      );

      const limited = opts.all ? rows : rows.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50));
      render(limited.map((r) => periodRow(r as unknown as Record<string, unknown>)), {
        ...opts,
        total: rows.length,
        idField: 'period_name',
        fields: opts.fields ?? (limited.length ? PERIOD_COLUMNS.join(',') : undefined),
      });
    })
  );

  // ---- period show -------------------------------------------------
  const show = describeCommand(
    argumentByKey(period.command('show').alias('ver'), '<name>', 'help.period.show.argument.name'),
    'help.period.show.description'
  );
  withOutput(withContext(show));
  declareRisk(show, { risk: 'lectura', agent: true });
  show.addHelpText('after', EJEMPLOS.periodShow);
  show.action((name: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const detail = await getPeriodDetail(ctx.entityId, name);

      // `-o` CUENTA COMO PEDIR OTRA FORMA (#90). Esta guarda copiaba a mano
      // TRES de las cinco cláusulas del predicado canónico, y le faltaba la
      // que importa aquí: con `-o`, la ficha en prosa se iba por la terminal y
      // el archivo se quedaba sin ella —o no existía siquiera—. Se pregunta al
      // kernel, que es donde vive la definición de «modo humano».
      if (!legible(opts)) {
        render(
          [
            {
              ...periodRow(detail as unknown as Record<string, unknown>),
              soft_close_date: detail.soft_close_date,
              hard_close_date: detail.hard_close_date,
              closed_by: detail.closed_by_email ?? detail.closed_by,
              entry_count: detail.entry_count,
              entry_counts: detail.entry_counts,
              close_checklist: detail.close_checklist,
            },
          ],
          { ...opts, idField: 'period_name' }
        );
        return;
      }

      const p = deps.palette;
      const out = process.stdout;
      out.write(
        `\n${p.bold(detail.period_name)}  ${p.dim(
          `${day(detail.start_date)} → ${day(detail.end_date)} · ${detail.status}` +
            `${detail.overdue ? t('ledger.period.show.overdue') : ''}`
        )}\n`
      );
      out.write(
        p.dim(
          `  ${t('ledger.period.show.position', {
            number: detail.period_number,
            year: String(detail.year_number),
            type: detail.period_type,
          })}\n`
        )
      );
      if (detail.soft_close_date) {
        out.write(
          p.dim(
            `  ${t('ledger.period.show.soft_closed', { date: new Date(detail.soft_close_date).toISOString() })}` +
              `${detail.closed_by_email ? t('ledger.period.show.by', { email: detail.closed_by_email }) : ''}\n`
          )
        );
      }
      if (detail.hard_close_date) {
        out.write(
          p.dim(`  ${t('ledger.period.show.hard_closed', { date: new Date(detail.hard_close_date).toISOString() })}\n`)
        );
      }

      out.write(
        `\n  ${p.bold(t('ledger.period.show.entries'))} ` +
          `${p.dim(t('ledger.period.show.entries_total', { count: detail.entry_count }))}\n`
      );
      if (detail.entry_count === 0) {
        out.write(p.dim(`    ${t('ledger.period.show.none')}\n`));
      } else {
        for (const [state, count] of Object.entries(detail.entry_counts)) {
          out.write(`    ${state.padEnd(16)} ${String(count).padStart(5)}\n`);
        }
      }

      const checklist = detail.close_checklist as unknown;
      if (Array.isArray(checklist) && checklist.length > 0) {
        out.write(`\n  ${p.bold(t('ledger.period.show.checklist'))}\n`);
        for (const item of checklist as Array<{ item: string; is_complete: boolean; details?: string }>) {
          out.write(
            `    ${item.is_complete ? p.green('✔') : p.red('✘')} ${item.item}` +
              `${item.details ? p.dim(`  ${item.details}`) : ''}\n`
          );
        }
      }
      out.write('\n');
    })
  );

  // ---- period open -------------------------------------------------
  const open = describeCommand(
    argumentByKey(period.command('open').alias('abrir'), '<name>', 'help.period.open.argument.name'),
    'help.period.open.description'
  );
  withContext(open);
  optionByKey(open, '--reason <text>', 'help.period.open.option.reason');
  // A generic flag reuses the kernel's key (decision of 2026-09-26 on #152).
  optionByKey(open, '--dry-run', 'cli.flag.dry_run');
  declareRisk(open, { risk: 'escritura', agent: false, writes: 'fiscal_periods.status' });
  open.addHelpText('after', EJEMPLOS.periodOpen);
  open.action((name: string, opts: CommonOpts & { reason?: string; dryRun?: boolean }) =>
    run(async () => {
      // Tenant FIRST: resolving the entity is itself a query, and under RLS a
      // connection with no app.current_tenant sees zero rows in legal_entities.
      // With this the other way round every write in this family died with
      // "No active entity matches …" even when --tenant/--entity were correct.
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
      announceTarget(deps, opts, ctx);
      const target = await resolvePeriod(ctx.entityId, name);

      if (opts.dryRun) {
        process.stdout.write(
          `\n${deps.palette.bold(t('ledger.period.open.would_open', { period: target.period_name }))} ` +
            `${deps.palette.dim(`(${target.status} → open, ${day(target.start_date)} → ${day(target.end_date)})`)}\n\n`
        );
        return;
      }

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const opened = await openPeriod(ctx.entityId, target.id, reviewer.userId, opts.reason);
      process.stdout.write(
        `${deps.palette.green('✔')} ${t('ledger.period.open.done', { period: deps.palette.bold(opened.period_name) })} ` +
          `${deps.palette.dim(`(${day(opened.start_date)} → ${day(opened.end_date)})`)}\n`
      );
    })
  );

  // ---- period reopen -----------------------------------------------
  //
  // La otra puerta del calendario: `open` es future → open; ESTA es
  // cerrado → open, la operación aparte y auditada a la que openPeriod
  // remite. El servicio existe desde antes que el comando
  // (reopenClosedPeriod): exige motivo, se niega sobre 'locked' —la
  // información ya salió del sistema— y escribe en audit_log la acción
  // 'reopen' con el estado anterior. Reabrir es el acto que un auditor más
  // pregunta, así que el rastro no es opcional y no se duplica aquí: lo
  // escribe el servicio, dentro de su misma transacción.
  const reopen = describeCommand(
    argumentByKey(period.command('reopen').alias('reabrir'), '<name>', 'help.period.reopen.argument.name'),
    'help.period.reopen.description'
  );
  withContext(reopen);
  withForce(reopen);
  // Irreversible por CATÁLOGO, no por capricho: técnicamente se vuelve a
  // cerrar, pero mientras está abierto acepta posteos que cambian lo que el
  // cierre anterior afirmó — y el kernel añade --dry-run, --yes,
  // --idempotency-key y (por el verbo) --reason obligatorio.
  declareRisk(reopen, {
    risk: 'irreversible',
    llave: { scope: 'period-reopen' },
    writes: "fiscal_periods.status (closed → open); audit_log action 'reopen' with its reason",
  });
  reopen.addHelpText('after', EJEMPLOS.periodReopen);
  reopen.action(
    (
      name: string,
      opts: CommonOpts & {
        reason?: string;
        dryRun?: boolean;
        yes?: boolean;
        force?: boolean;
        idempotencyKey?: string;
      }
    ) =>
      run(async () => {
        // Tenant FIRST — la misma trampa de RLS que `open` y `create`.
        bootstrapTenant(opts.tenant);
        // La copia plana es por tipos: CommonOpts es interface y no lleva la
        // firma de índice que gateMutation pide.
        const { dryRun, reason } = gateMutation(reopen, { ...opts });
        const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
        announceTarget(deps, opts, ctx);
        const target = await resolvePeriod(ctx.entityId, name);

        // EL MISMO VEREDICTO QUE EL ACTO (el precedente de `year create
        // --dry-run`): estos guardas replican los del servicio para que la
        // marcha seca falle exactamente donde fallaría la real, con los
        // mismos códigos. El servicio los re-comprueba bajo FOR UPDATE, así
        // que replicarlos aquí no abre ninguna carrera — sólo adelanta la
        // respuesta. (`as string` como en el servicio: la columna habla en
        // literales y el tipo en enum.)
        const estado = target.status as string;
        if (estado === 'open') {
          throw new AccountingError('PERIOD_ALREADY_OPEN', {
            key: 'error.PERIOD_ALREADY_OPEN',
            params: { period: target.period_name },
          });
        }
        if (estado === 'locked') {
          throw new AccountingError('PERIOD_LOCKED', {
            key: 'ledger.period.reopen.locked',
            params: { period: target.period_name },
          });
        }
        if (estado !== 'soft_close' && estado !== 'hard_close') {
          throw new AccountingError('PERIOD_NOT_CLOSED', {
            key: 'ledger.period.reopen.not_closed',
            params: { period: target.period_name, status: target.status },
          });
        }

        // El cierre DURO generó asientos de cierre (si fue fin de ejercicio)
        // y arrastró saldos, y NADA de eso se deshace al reabrir: el mayor es
        // inmutable (041). Reabrirlo deja esos derivados diciendo lo que el
        // periodo ya no dice, así que pide la pareja --force + --reason en
        // vez de pasar como si fuera un soft_close.
        if (estado === 'hard_close' && opts.force !== true) {
          throw blockedByState({ key: 'ledger.period.reopen.hard_close', params: { period: target.period_name } });
        }

        if (dryRun) {
          process.stdout.write(
            `\n${deps.palette.bold(t('ledger.period.reopen.would_reopen', { period: target.period_name }))} ` +
              `${deps.palette.dim(`(${target.status} → open, ${day(target.start_date)} → ${day(target.end_date)})`)}\n` +
              deps.palette.dim(`  ${t('ledger.period.reopen.dry_run')}\n\n`)
          );
          return;
        }

        // Reabrir cambia lo que un cierre ya afirmó: siempre se confirma, y
        // sin terminal el comando se niega en vez de suponer consentimiento.
        if (!opts.yes) {
          const question = {
            key: 'ledger.period.reopen.question',
            params: { period: target.period_name, status: target.status },
          } as const;
          if (!stdin.isTTY) {
            throw abortedByUser({ key: 'ap.payment.confirm.no_terminal', params: { question } });
          }
          const rl = readline.createInterface({ input: stdin, output: stdout });
          // La comprobación anterior aceptaba como SÍ cualquier respuesta que
          // empezara por «s», «salir» incluida: quien tecleaba salir para NO
          // reabrir un periodo cerrado lo reabría. La gramática vive ahora en el
          // kernel, que distingue el sí del salir y reintenta ante lo ambiguo.
          const veredicto = await confirmarConReintento(
            (p) => rl.question(p).catch(() => null),
            deps.palette.cyan(yesNoPrompt(t(question.key, question.params)))
          );
          rl.close();
          if (veredicto.incomprendida !== undefined) {
            process.stderr.write(`${t('bank.confirm.taken_as_no', { reason: noEntendi(veredicto.incomprendida) })}\n`);
          }
          if (!veredicto.si) {
            process.stdout.write(`${t('ledger.period.reopen.cancelled')}\n`);
            return;
          }
        }

        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const acto = await conLlave(
          { tenantId: ctx.tenantId, entityId: ctx.entityId },
          {
            scope: 'period-reopen',
            clave: opts.idempotencyKey,
            payloadHash: hashDeCarga(target.id),
          },
          async () => {
            const { period: reabierto, previousStatus } = await reopenClosedPeriod(
              ctx.entityId,
              target.id,
              reviewer.userId,
              // gateMutation ya exigió el motivo (verbo 'reopen'); el
              // servicio lo vuelve a exigir por su cuenta — dos cerrojos, un
              // solo mensaje posible sin motivo.
              reason ?? ''
            );
            return { period_name: reabierto.period_name, previous_status: previousStatus };
          }
        );

        if (acto.repetido) {
          process.stdout.write(
            `${t('ledger.period.reopen.idempotency_hit', {
              key: opts.idempotencyKey ?? '',
              period: acto.resultado.period_name,
              previous: acto.resultado.previous_status,
            })}\n`
          );
          return;
        }

        process.stdout.write(
          `${deps.palette.green('✔')} ${t('ledger.period.reopen.done', { period: deps.palette.bold(acto.resultado.period_name) })} ` +
            `${deps.palette.dim(
              t('ledger.period.reopen.done_detail', { previous: acto.resultado.previous_status, email: reviewer.email })
            )}\n` +
            deps.palette.dim(
              `  ${t('ledger.period.reopen.stale')}\n` +
              reopenRemedy(acto.resultado.period_name, acto.resultado.previous_status)
                .map((line) => `  ${line}\n`)
                .join('')
            )
        );
      })
  );
}

export function registerYearCommand(program: Command, deps: PeriodCommandDeps): void {
  // Help by key (#314): help.year.<leaf>.{description,option.<flag>,argument.<name>}.
  const year = describeCommand(program.command('year').alias('ejercicio'), 'help.year.description');

  const run = makeRunner(deps);
  const entityOf = makeEntityResolver(deps);

  // ---- year list ---------------------------------------------------
  const list = describeCommand(year.command('list').alias('listar'), 'help.year.list.description');
  withOutput(withSelection(withContext(list)));
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EJEMPLOS.yearList);
  list.action((opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      for (const state of opts.status ?? []) {
        if (state !== 'open' && state !== 'closed') {
          throw usageError({ key: 'ledger.period.year.status_unknown', params: { value: state } });
        }
      }
      if ((opts.status?.length ?? 0) > 1) {
        throw usageError({ key: 'ledger.period.year.one_status' });
      }
      const rows = await listFiscalYears(ctx.entityId, { status: opts.status?.[0] });
      const limited = opts.all ? rows : rows.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? 50));
      render(limited.map((r) => yearRow(r as unknown as Record<string, unknown>)), {
        ...opts,
        total: rows.length,
        idField: 'year_number',
      });
    })
  );

  // ---- year show ---------------------------------------------------
  const show = describeCommand(
    argumentByKey(year.command('show').alias('ver'), '<year>', 'help.year.show.argument.year'),
    'help.year.show.description'
  );
  withOutput(withContext(show));
  declareRisk(show, { risk: 'lectura', agent: true });
  show.addHelpText('after', EJEMPLOS.yearShow);
  show.action((yearArg: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const yearNumber = Number(yearArg);
      if (!Number.isInteger(yearNumber)) throw usageError({ key: 'ledger.period.year.not_a_year', params: { value: yearArg } });
      const { year: fiscalYear, periods } = await getFiscalYear(ctx.entityId, yearNumber);

      if (!legible(opts)) {
        render(
          [
            {
              ...yearRow(fiscalYear as unknown as Record<string, unknown>),
              periods_detail: periods.map((p) => periodRow(p as unknown as Record<string, unknown>)),
            },
          ],
          { ...opts, idField: 'year_number' }
        );
        return;
      }

      const p = deps.palette;
      process.stdout.write(
        `\n${p.bold(t('ledger.period.year.title', { year: fiscalYear.year_number }))}  ${p.dim(
          `${day(fiscalYear.start_date)} → ${day(fiscalYear.end_date)} · ${fiscalYear.status}` +
            `${fiscalYear.is_calendar_year ? t('ledger.period.year.calendar') : ''}`
        )}\n\n`
      );
      render(periods.map((row) => periodRow(row as unknown as Record<string, unknown>)), {
        ...opts,
        format: 'table',
        fields: periods.length ? PERIOD_COLUMNS.join(',') : undefined,
      });
      process.stdout.write('\n');
    })
  );

  // ---- year create -------------------------------------------------
  const create = describeCommand(
    argumentByKey(year.command('create').alias('crear'), '<year>', 'help.year.create.argument.year'),
    'help.year.create.description'
  );
  withContext(create);
  optionByKey(create, '--dry-run', 'help.year.create.option.dry_run');
  optionByKey(create, '--json', 'help.year.create.option.json');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'fiscal_years + fiscal_periods' });
  create.addHelpText('after', EJEMPLOS.yearCreate);
  create.action((yearArg: string, opts: CommonOpts & { dryRun?: boolean }) =>
    run(async () => {
      // Tenant FIRST: resolving the entity is itself a query, and under RLS a
      // connection with no app.current_tenant sees zero rows in legal_entities.
      // With this the other way round every write in this family died with
      // "No active entity matches …" even when --tenant/--entity were correct.
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
      announceTarget(deps, opts, ctx);
      const yearNumber = Number(yearArg);
      if (!Number.isInteger(yearNumber)) throw usageError({ key: 'ledger.period.year.not_a_year', params: { value: yearArg } });
      // Range-checked BEFORE the dry-run branch, with the service's own rule:
      // otherwise `year create 99999 --dry-run` reported "would create" and
      // exit 0 while the real command refused it with exit 4.
      assertFiscalYearNumber(yearNumber);

      if (opts.dryRun) {
        const existing = await listFiscalYears(ctx.entityId).then((years) =>
          years.find((y) => y.year_number === yearNumber)
        );
        if (existing) {
          // Same verdict, and the same exit code, as the real run: a dry run
          // that reports a different failure than the act it previews is worse
          // than no dry run at all.
          throw conflict({
            key: 'ledger.period.year.exists',
            params: { year: yearNumber, entity: ctx.entityName, count: Number(existing.period_count) },
          });
        }
        process.stdout.write(
          `\n${deps.palette.bold(t('ledger.period.year.would_create', { year: yearNumber }))} ` +
            `${deps.palette.dim(t('ledger.period.year.would_create_detail'))}\n\n`
        );
        return;
      }

      const result = await createFiscalYear(ctx.entityId, yearNumber);
      // The previous year was sealed before this one existed: it opens with
      // that year's balances (#594), and the accountant is told from where.
      const opening = result.opening;
      const carried =
        opening?.previous && opening.carry
          ? { from: opening.previous.period_name, accounts: opening.carry.carried }
          : null;
      if (opts.json) {
        render([{
          year_number: result.yearNumber, id: result.fiscalYearId, periods: result.periods,
          ...(carried ? { opening_carried_from: carried.from, opening_accounts: carried.accounts } : {}),
        }], {
          json: true,
        });
        return;
      }
      process.stdout.write(
        `${deps.palette.green('✔')} ${t('ledger.period.year.created', { year: deps.palette.bold(String(result.yearNumber)) })} ` +
          `${deps.palette.dim(t('ledger.period.year.created_detail'))}\n` +
          (carried
            ? deps.palette.dim(`${t('ledger.period.year.carried', { period: carried.from, count: carried.accounts })}\n`)
            : '') +
          deps.palette.dim(`${t('ledger.period.year.open_hint')}\n`)
      );
    })
  );

  // ---- year carry-forward run (MNE-001-645, #594) ------------------
  // The year that was created after its predecessor was sealed, before
  // `year create` carried: its first period has no beginning balances. The
  // service runs the creation's own carry on it and says what it corrected;
  // the dry run is that same run, rolled back by the service.
  const carryForward = describeCommand(
    year.command('carry-forward').alias('arrastre'),
    'help.year.carry_forward.description'
  );
  const carryRun = describeCommand(
    argumentByKey(carryForward.command('run').alias('ejecutar'), '<year>', 'help.year.carry_forward.run.argument.year'),
    'help.year.carry_forward.run.description'
  );
  withContext(carryRun);
  optionByKey(carryRun, '--dry-run', 'help.year.carry_forward.run.option.dry_run');
  optionByKey(carryRun, '--json', 'help.year.carry_forward.run.option.json');
  // No --idempotency-key, as `year create` and `period open`: the act is
  // idempotent by its domain. A retry finds the balances right, says so and
  // writes nothing, where a replayed result would repeat «corrected».
  declareRisk(carryRun, {
    risk: 'escritura',
    agent: false,
    writes: "account_balances (beginning and ending of the year's first period); audit_log action 'update'",
  });
  carryRun.addHelpText('after', () => t('help.year.carry_forward.run.examples'));
  carryRun.action((yearArg: string, opts: CommonOpts & { dryRun?: boolean }) =>
    run(async () => {
      // Tenant FIRST, as in `year create`: resolving the entity is itself a query under RLS.
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
      announceTarget(deps, opts, ctx);
      const yearNumber = Number(yearArg);
      if (!Number.isInteger(yearNumber)) throw usageError({ key: 'ledger.period.year.not_a_year', params: { value: yearArg } });

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const result = await carryForwardIntoYear(ctx.entityId, yearNumber, reviewer.userId, {
        dryRun: opts.dryRun === true,
      });
      const count = result.corrections.length;
      const status = count === 0 ? 'unchanged' : result.written ? 'corrected' : 'would_correct';
      if (opts.json) {
        render([{
          year_number: result.year_number, period: result.period.period_name, carried_from: result.carried_from,
          status, accounts: count, corrections: result.corrections,
        }], { json: true });
        return;
      }

      const p = deps.palette;
      const said = { period: result.period.period_name, source: result.carried_from, count };
      if (status === 'unchanged') {
        process.stdout.write(`${t('ledger.period.year.carry.unchanged', said)}\n`);
        return;
      }
      process.stdout.write(
        status === 'corrected'
          ? `${p.green('✔')} ${t('ledger.period.year.carry.corrected', { ...said, period: p.bold(said.period) })}\n`
          : `\n${p.bold(t('ledger.period.year.carry.would_correct', said))}\n`
      );
      render(result.corrections.map((c) => ({ account: c.code, before: c.before, after: c.after })), {
        format: 'table',
        fields: 'account,before,after',
      });
      process.stdout.write(
        p.dim(
          `${status === 'corrected'
            ? t('ledger.period.year.carry.corrected_detail', { email: reviewer.email })
            : t('ledger.period.year.carry.dry_run')}\n`
        )
      );
    })
  );
}
