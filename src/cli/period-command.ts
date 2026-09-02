import * as readline from 'node:readline/promises';
import { confirmarConReintento, noEntendi } from './kernel/confirmacion.js';
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
  assertFiscalYearNumber,
  PERIOD_STATUSES,
} from '../services/accounting/fiscal-calendar-service.js';
import { conLlave, hashDeCarga } from '../services/idempotency/idempotency-store.js';
import { AccountingError } from '../utils/errors.js';
import { day, translateDomainError } from './entry-command.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  gateMutation,
  render,
  resolveFormat,
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
    deps.palette.dim(`  → ${ctx.entityName} (active entity; name another with --entity)\n`)
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

export function registerPeriodCommand(program: Command, deps: PeriodCommandDeps): void {
  const period = program
    .command('period')
    .alias('periodo')
    .description('Fiscal periods: what exists, what state it is in, and opening a future one');

  const run = makeRunner(deps);
  const entityOf = makeEntityResolver(deps);

  // ---- period list -------------------------------------------------
  const list = period
    .command('list')
    .alias('listar')
    .description('List every period with its state, dates and overdue mark');
  withOutput(withSelection(withContext(list)));
  list.option('--year <year>', 'only periods of this fiscal year');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action((opts: CommonOpts & { year?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      for (const state of opts.status ?? []) {
        if (!(PERIOD_STATUSES as readonly string[]).includes(state)) {
          throw usageError(`Unknown --status "${state}". Use one of: ${PERIOD_STATUSES.join(', ')}.`);
        }
      }
      const yearNumber = opts.year ? Number(opts.year) : undefined;
      if (yearNumber !== undefined && !Number.isInteger(yearNumber)) {
        throw usageError(`--year "${opts.year}" is not a four-digit year.`);
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
  const show = period
    .command('show')
    .alias('ver')
    .argument('<name>', 'period name, YYYY-MM, or id')
    .description('Show a period: state, who closed it, the checklist it closed with, its entries');
  withOutput(withContext(show));
  declareRisk(show, { risk: 'lectura', agent: true });
  show.action((name: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const detail = await getPeriodDetail(ctx.entityId, name);

      if (resolveFormat(opts) !== 'table' || opts.quiet) {
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
            `${detail.overdue ? ' · overdue' : ''}`
        )}\n`
      );
      out.write(
        p.dim(
          `  period ${detail.period_number} of fiscal year ${detail.year_number} · ${detail.period_type}\n`
        )
      );
      if (detail.soft_close_date) {
        out.write(
          p.dim(
            `  soft closed ${new Date(detail.soft_close_date).toISOString()}` +
              `${detail.closed_by_email ? ` by ${detail.closed_by_email}` : ''}\n`
          )
        );
      }
      if (detail.hard_close_date) {
        out.write(p.dim(`  hard closed ${new Date(detail.hard_close_date).toISOString()}\n`));
      }

      out.write(`\n  ${p.bold('Entries')} ${p.dim(`(${detail.entry_count} total)`)}\n`);
      if (detail.entry_count === 0) {
        out.write(p.dim('    none\n'));
      } else {
        for (const [state, count] of Object.entries(detail.entry_counts)) {
          out.write(`    ${state.padEnd(16)} ${String(count).padStart(5)}\n`);
        }
      }

      const checklist = detail.close_checklist as unknown;
      if (Array.isArray(checklist) && checklist.length > 0) {
        out.write(`\n  ${p.bold('Checklist saved at close')}\n`);
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
  const open = period
    .command('open')
    .alias('abrir')
    .argument('<name>', 'period name, YYYY-MM, or id')
    .description('Open a future period so work can be captured in it');
  withContext(open);
  open
    .option('--reason <text>', 'why it is being opened; recorded in the audit trail')
    .option('--dry-run', 'show the transition without performing it');
  declareRisk(open, { risk: 'escritura', agent: false, writes: 'fiscal_periods.status' });
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
          `\n${deps.palette.bold(`Would open ${target.period_name}`)} ` +
            `${deps.palette.dim(`(${target.status} → open, ${day(target.start_date)} → ${day(target.end_date)})`)}\n\n`
        );
        return;
      }

      const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
      const opened = await openPeriod(ctx.entityId, target.id, reviewer.userId, opts.reason);
      process.stdout.write(
        `${deps.palette.green('✔')} ${deps.palette.bold(opened.period_name)} is open ` +
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
  const reopen = period
    .command('reopen')
    .alias('reabrir')
    .argument('<name>', 'period name, YYYY-MM, or id')
    .description('Reopen a closed period so a correction can land in the month it belongs to');
  withContext(reopen);
  withForce(reopen);
  // Irreversible por CATÁLOGO, no por capricho: técnicamente se vuelve a
  // cerrar, pero mientras está abierto acepta posteos que cambian lo que el
  // cierre anterior afirmó — y el kernel añade --dry-run, --yes,
  // --idempotency-key y (por el verbo) --reason obligatorio.
  declareRisk(reopen, {
    risk: 'irreversible',
    writes: "fiscal_periods.status (cerrado → open); audit_log acción 'reopen' con motivo",
  });
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
          throw new AccountingError('PERIOD_ALREADY_OPEN', `${target.period_name} ya está abierto.`);
        }
        if (estado === 'locked') {
          throw new AccountingError(
            'PERIOD_LOCKED',
            `${target.period_name} está 'locked': su información ya salió del sistema y no se ` +
              'reabre — ni con --force. La corrección va en el periodo abierto más próximo.'
          );
        }
        if (estado !== 'soft_close' && estado !== 'hard_close') {
          throw new AccountingError(
            'PERIOD_NOT_CLOSED',
            `${target.period_name} está '${target.status}': reabrir es sólo para periodos cerrados.`
          );
        }

        // El cierre DURO generó asientos de cierre (si fue fin de ejercicio)
        // y arrastró saldos, y NADA de eso se deshace al reabrir: el mayor es
        // inmutable (041). Reabrirlo deja esos derivados diciendo lo que el
        // periodo ya no dice, así que pide la pareja --force + --reason en
        // vez de pasar como si fuera un soft_close.
        if (estado === 'hard_close' && opts.force !== true) {
          throw blockedByState(
            `${target.period_name} está en hard_close: sus asientos de cierre y el arrastre de ` +
              'saldos quedan en pie al reabrir (el mayor no se toca). Si de verdad quieres ' +
              'reabrirlo, repite con --force --reason "<por qué>".'
          );
        }

        if (dryRun) {
          process.stdout.write(
            `\n${deps.palette.bold(`Would reopen ${target.period_name}`)} ` +
              `${deps.palette.dim(`(${target.status} → open, ${day(target.start_date)} → ${day(target.end_date)})`)}\n` +
              deps.palette.dim(
                '  (dry-run: nothing was written; the reopen would be recorded in the audit trail)\n\n'
              )
          );
          return;
        }

        // Reabrir cambia lo que un cierre ya afirmó: siempre se confirma, y
        // sin terminal el comando se niega en vez de suponer consentimiento.
        if (!opts.yes) {
          if (!stdin.isTTY) {
            throw abortedByUser(
              `Reopen ${target.period_name} (${target.status} → open)? — there is no terminal to ask on. ` +
                'Re-run with --yes once you are sure, or with --dry-run to see the effect first.'
            );
          }
          const rl = readline.createInterface({ input: stdin, output: stdout });
          // La comprobación anterior aceptaba como SÍ cualquier respuesta que
          // empezara por «s», «salir» incluida: quien tecleaba salir para NO
          // reabrir un periodo cerrado lo reabría. La gramática vive ahora en el
          // kernel, que distingue el sí del salir y reintenta ante lo ambiguo.
          const veredicto = await confirmarConReintento(
            (p) => rl.question(p).catch(() => null),
            deps.palette.cyan(`Reopen ${target.period_name} (${target.status} → open)? [y/N] `)
          );
          rl.close();
          if (veredicto.incomprendida !== undefined) {
            process.stderr.write(`${noEntendi(veredicto.incomprendida)}; lo tomo como no.\n`);
          }
          if (!veredicto.si) {
            process.stdout.write('Cancelled.\n');
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
            `↩ Idempotency hit: key "${opts.idempotencyKey}" already reopened ` +
              `${acto.resultado.period_name} (was ${acto.resultado.previous_status}). Nothing was executed again.\n`
          );
          return;
        }

        process.stdout.write(
          `${deps.palette.green('✔')} ${deps.palette.bold(acto.resultado.period_name)} is open again ` +
            `${deps.palette.dim(`(was ${acto.resultado.previous_status}, by ${reviewer.email}; reason recorded)`)}\n` +
            deps.palette.dim(
              '  Statements or filings derived from this period are now stale: regenerate them after re-closing.\n' +
              '  Close it again with: mnemosine close --period ' + acto.resultado.period_name + '\n'
            )
        );
      })
  );
}

export function registerYearCommand(program: Command, deps: PeriodCommandDeps): void {
  const year = program
    .command('year')
    .alias('ejercicio')
    .description('Fiscal years: the calendar an entity keeps its books in');

  const run = makeRunner(deps);
  const entityOf = makeEntityResolver(deps);

  // ---- year list ---------------------------------------------------
  const list = year
    .command('list')
    .alias('listar')
    .description('List the fiscal years of the entity with their state and close progress');
  withOutput(withSelection(withContext(list)));
  declareRisk(list, { risk: 'lectura', agent: true });
  list.action((opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      for (const state of opts.status ?? []) {
        if (state !== 'open' && state !== 'closed') {
          throw usageError(`Unknown --status "${state}". A fiscal year is 'open' or 'closed'.`);
        }
      }
      if ((opts.status?.length ?? 0) > 1) {
        throw usageError("A fiscal year is either 'open' or 'closed': pass one --status, or none.");
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
  const show = year
    .command('show')
    .alias('ver')
    .argument('<year>', 'four-digit year, e.g. 2026')
    .description('Show a fiscal year with each of its periods and their states');
  withOutput(withContext(show));
  declareRisk(show, { risk: 'lectura', agent: true });
  show.action((yearArg: string, opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      const yearNumber = Number(yearArg);
      if (!Number.isInteger(yearNumber)) throw usageError(`"${yearArg}" is not a four-digit year.`);
      const { year: fiscalYear, periods } = await getFiscalYear(ctx.entityId, yearNumber);

      if (resolveFormat(opts) !== 'table' || opts.quiet) {
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
        `\n${p.bold(`Fiscal year ${fiscalYear.year_number}`)}  ${p.dim(
          `${day(fiscalYear.start_date)} → ${day(fiscalYear.end_date)} · ${fiscalYear.status}` +
            `${fiscalYear.is_calendar_year ? ' · calendar year' : ''}`
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
  const create = year
    .command('create')
    .alias('crear')
    .argument('<year>', 'four-digit year, e.g. 2027')
    .description('Create a fiscal year and its twelve monthly periods');
  withContext(create);
  create
    .option('--dry-run', 'show the calendar that would be created; write nothing')
    .option('--json', 'JSON output');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'fiscal_years + fiscal_periods' });
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
      if (!Number.isInteger(yearNumber)) throw usageError(`"${yearArg}" is not a four-digit year.`);
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
          throw conflict(
            `Fiscal year ${yearNumber} already exists for ${ctx.entityName} with ` +
              `${existing.period_count} period(s). Nothing would be created.`
          );
        }
        process.stdout.write(
          `\n${deps.palette.bold(`Would create fiscal year ${yearNumber}`)} ` +
            `${deps.palette.dim('with 12 monthly periods (calendar year); months already past and the current one open, the rest future')}\n\n`
        );
        return;
      }

      const result = await createFiscalYear(ctx.entityId, yearNumber);
      if (opts.json) {
        render([{ year_number: result.yearNumber, id: result.fiscalYearId, periods: result.periods }], {
          json: true,
        });
        return;
      }
      process.stdout.write(
        `${deps.palette.green('✔')} Fiscal year ${deps.palette.bold(String(result.yearNumber))} created ` +
          `${deps.palette.dim(`with ${result.periods} monthly periods`)}\n` +
          deps.palette.dim('  Open a future month with: mnemosine period open <name>\n')
      );
    })
  );
}
