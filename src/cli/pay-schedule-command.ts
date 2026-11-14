import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { entityScope, type EntityScope } from '../database/scope.js';
import {
  createPaySchedule,
  listPayPeriods,
  listPaySchedules,
  planPayPeriods,
  writePayPeriods,
  type GeneratedPeriod,
  type PayScheduleInput,
} from '../services/payroll/common/pay-period-service.js';
import { t } from '../i18n/index.js';
import { isRealCalendarDate } from '../utils/calendar-date.js';
import type { Palette } from './palette.js';
import {
  dateOnly,
  declareRisk,
  describeCommand,
  exitCodeFor,
  gateMutation,
  legible,
  optionByKey,
  render,
  requireExplicitEntity,
  resolveActiveEntity,
  usageError,
  withContext,
  withOutput,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine pay-schedule · calendario-nomina — MNE-001-403 (#587)
// mnemosine pay-period · periodo-nomina — MNE-001-404 (#613)
//
// The calendar a pay run runs over, from the terminal: before this a schedule
// and its periods were created only over REST, so `pay-run create --period`
// had nothing to point at without SQL. The nouns, verbs and flags are the
// catalog rows (docs/cli-command-catalog.md, «Calendarios de pago, periodos y
// captura de tiempo»), and every leaf calls pay-period-service.ts, the same
// service as the REST routes; none of them computes a date.
//
// `pay-period create` takes a COUNT, not a range or a year: it continues
// after the schedule's last period, as the REST route does. A replay of the
// same range writes nothing twice — the service inserts on
// UNIQUE(pay_schedule_id, period_start) and reports only what it created.
//
// Neither write is open to the agent: a schedule is not a review queue.
// ============================================================

export interface PayCalendarCommandDeps {
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
  limit?: string;
}

/** The values of the CHECK in 008_payroll.sql; adding one needs a migration. */
export const PAY_FREQUENCIES = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'quincenal'] as const;
const COUNTRIES = ['MX', 'US'] as const;
/** The width of pay_schedules.name in 008_payroll.sql. */
const MAX_NAME = 100;
export const PAY_PERIOD_STATES = ['draft', 'calculated', 'approved', 'paid', 'closed'] as const;
/** The REST route's bound: four years of weekly periods. */
const MAX_COUNT = 208;

const EXAMPLES = {
  scheduleCreate: `
Examples:
  mnemosine pay-schedule create --name Quincenal --frequency quincenal --country MX --first-start 2026-07-01 --dry-run
`,
  scheduleList: `
Examples:
  mnemosine pay-schedule list --all --json
`,
  periodCreate: `
Examples:
  mnemosine pay-period create --schedule 3f0c2a1e-5b7d-4c89-a1e2-6d4f8b9c0a17 --count 2 --dry-run
`,
  periodList: `
Examples:
  mnemosine pay-period list --year 2026 --status draft --json
`,
};

function wholeNumber(value: string | undefined, flag: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  // Digits only: Number() would read `1e1` as ten and ` 7` or `0x10` as numbers.
  const n = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw usageError({ key: 'paycalendar.number_invalid', params: { flag, value, min, max } });
  }
  return n;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], flag: string): T {
  if (value === undefined || !(allowed as readonly string[]).includes(value)) {
    throw usageError({ key: 'paycalendar.value_invalid', params: { flag, value: value ?? '', allowed: allowed.join(', ') } });
  }
  return value as T;
}

function periodRow(p: GeneratedPeriod & { id?: string; status?: string }, scheduleId: string): Row {
  return {
    id: p.id ?? '',
    schedule_id: scheduleId,
    start: p.period_start,
    end: p.period_end,
    pay_date: p.pay_date,
    tax_year: p.tax_year,
    status: p.status ?? 'draft',
  };
}

export function registerPayCalendarCommand(program: Command, deps: PayCalendarCommandDeps): void {
  const p = deps.palette;
  // Help by key (#314): help.pay_schedule.* and help.pay_period.*.
  const schedule = describeCommand(
    program.command('pay-schedule').alias('calendario-nomina'),
    'help.pay_schedule.description'
  );
  const period = describeCommand(program.command('pay-period').alias('periodo-nomina'), 'help.pay_period.description');

  const run = async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? 0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  // Tenant FIRST: entity resolution is itself bounded by RLS. A write never
  // guesses the entity; a read may use the active one.
  const scopeForWrite = async (opts: CommonOpts): Promise<EntityScope> => {
    bootstrapTenant(opts.tenant);
    const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
    return entityScope(ctx.tenantId, ctx.entityId);
  };
  const scopeForRead = async (opts: CommonOpts): Promise<EntityScope> => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity({ entity: opts.entity }, { home: deps.home });
    return entityScope(ctx.tenantId, ctx.entityId);
  };

  // ---- pay-schedule create -------------------------------------------
  const sCreate = describeCommand(schedule.command('create').alias('crear'), 'help.pay_schedule.create.description');
  withContext(sCreate);
  withOutput(sCreate);
  optionByKey(sCreate, '--name <name>', 'help.pay_schedule.create.option.name');
  optionByKey(sCreate, '--frequency <frequency>', 'help.pay_schedule.create.option.frequency', {
    params: { frequencies: PAY_FREQUENCIES.join(' | ') },
  });
  optionByKey(sCreate, '--country <MX|US>', 'help.pay_schedule.create.option.country');
  optionByKey(sCreate, '--first-start <date>', 'help.pay_schedule.create.option.first_start');
  optionByKey(sCreate, '--pay-day-offset <days>', 'help.pay_schedule.create.option.pay_day_offset');
  optionByKey(sCreate, '--dry-run', 'cli.flag.dry_run');
  declareRisk(sCreate, { risk: 'escritura', agent: false, writes: 'pay_schedules (one row)' });
  sCreate.addHelpText('after', EXAMPLES.scheduleCreate);
  sCreate.action(
    (
      opts: CommonOpts & {
        name?: string; frequency?: string; country?: string; firstStart?: string; payDayOffset?: string; dryRun?: boolean;
      },
      cmd: Command
    ) =>
      run(async () => {
        const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
        const name = opts.name?.trim();
        if (!name) throw usageError({ key: 'paycalendar.schedule.name_required' });
        // pay_schedules.name is VARCHAR(100), counted in characters, not UTF-16 units.
        if ([...name].length > MAX_NAME) {
          throw usageError({ key: 'paycalendar.schedule.name_too_long', params: { max: MAX_NAME } });
        }
        const frequency = oneOf(opts.frequency, PAY_FREQUENCIES, '--frequency');
        const country = oneOf(opts.country?.toUpperCase(), COUNTRIES, '--country');
        const firstStart = opts.firstStart;
        if (!firstStart || !isRealCalendarDate(firstStart)) {
          throw usageError({ key: 'paycalendar.schedule.first_start_invalid', params: { value: firstStart ?? '' } });
        }
        const offset = wholeNumber(opts.payDayOffset, '--pay-day-offset', 0, 31) ?? 0;
        const scope = await scopeForWrite(opts);
        const input: PayScheduleInput = {
          tenant_id: scope.tenantId,
          entity_id: scope.entityId,
          name,
          frequency,
          country_code: country,
          first_period_start: firstStart,
          pay_day_offset: offset,
        };
        const id = dryRun ? '' : await createPaySchedule(input);
        render(
          [{ id, name, frequency, country, first_start: firstStart, pay_day_offset: offset, dry_run: dryRun }],
          { ...opts, idField: 'id' }
        );
        if (legible(opts)) {
          const next = dryRun ? t('paycalendar.schedule.dry_run') : t('paycalendar.schedule.next', { id });
          process.stderr.write(p.dim(`  ${next}\n`));
        }
      })
  );

  // ---- pay-schedule list ---------------------------------------------
  const sList = describeCommand(schedule.command('list').alias('listar'), 'help.pay_schedule.list.description');
  withContext(sList);
  withOutput(sList);
  optionByKey(sList, '-a, --all', 'help.pay_schedule.list.option.all');
  optionByKey(sList, '-n, --limit <n>', 'cli.flag.limit');
  declareRisk(sList, { risk: 'lectura', agent: true });
  sList.addHelpText('after', EXAMPLES.scheduleList);
  sList.action((opts: CommonOpts & { all?: boolean }) =>
    run(async () => {
      const limit = wholeNumber(opts.limit, '--limit', 1, 1000);
      const scope = await scopeForRead(opts);
      const rows = await listPaySchedules(scope, { all: opts.all, limit });
      render(
        rows.map((s) => ({
          id: s.id,
          name: s.name,
          frequency: s.frequency,
          country: s.country_code,
          first_start: dateOnly(s.first_period_start),
          pay_day_offset: s.pay_day_offset,
          active: s.is_active,
          employees: s.employees,
        })),
        { ...opts, idField: 'id' }
      );
      if (rows.length === 0 && legible(opts)) process.stderr.write(p.dim(`${t('paycalendar.schedule.empty')}\n`));
    })
  );

  // ---- pay-period create ---------------------------------------------
  const pCreate = describeCommand(period.command('create').alias('crear'), 'help.pay_period.create.description');
  withContext(pCreate);
  withOutput(pCreate);
  optionByKey(pCreate, '--schedule <id>', 'help.pay_period.create.option.schedule');
  optionByKey(pCreate, '--count <n>', 'help.pay_period.create.option.count', { params: { max: MAX_COUNT } });
  optionByKey(pCreate, '--dry-run', 'cli.flag.dry_run');
  declareRisk(pCreate, {
    risk: 'escritura',
    agent: false,
    writes: 'pay_periods (the next periods of one schedule; a period already there is not written again)',
  });
  pCreate.addHelpText('after', EXAMPLES.periodCreate);
  pCreate.action((opts: CommonOpts & { schedule?: string; count?: string; dryRun?: boolean }, cmd: Command) =>
    run(async () => {
      const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
      if (!opts.schedule) throw usageError({ key: 'paycalendar.period.schedule_required' });
      const count = wholeNumber(opts.count, '--count', 1, MAX_COUNT);
      if (count === undefined) throw usageError({ key: 'paycalendar.period.count_required', params: { max: MAX_COUNT } });
      const scope = await scopeForWrite(opts);
      const plan = await planPayPeriods(scope, opts.schedule, count);
      const rows = dryRun ? plan : await writePayPeriods(scope, opts.schedule, plan);
      render(rows.map((r) => periodRow(r, opts.schedule!)), { ...opts, idField: 'id' });
      if (legible(opts)) {
        const done = dryRun
          ? t('paycalendar.period.dry_run', { count: rows.length })
          : t('paycalendar.period.done', { count: rows.length });
        process.stderr.write(p.dim(`  ${done}\n`));
      }
    })
  );

  // ---- pay-period list -----------------------------------------------
  const pList = describeCommand(period.command('list').alias('listar'), 'help.pay_period.list.description');
  withContext(pList);
  withOutput(pList);
  optionByKey(pList, '-s, --status <state>', 'help.pay_period.list.option.status', {
    params: { states: PAY_PERIOD_STATES.join(' | ') },
  });
  optionByKey(pList, '--year <yyyy>', 'help.pay_period.list.option.year');
  optionByKey(pList, '-n, --limit <n>', 'cli.flag.limit');
  declareRisk(pList, { risk: 'lectura', agent: true });
  pList.addHelpText('after', EXAMPLES.periodList);
  pList.action((opts: CommonOpts & { status?: string; year?: string }) =>
    run(async () => {
      const status = opts.status === undefined ? undefined : oneOf(opts.status, PAY_PERIOD_STATES, '--status');
      const year = wholeNumber(opts.year, '--year', 1900, 9999);
      const limit = wholeNumber(opts.limit, '--limit', 1, 1000);
      const scope = await scopeForRead(opts);
      const rows = await listPayPeriods(scope, { status, year, limit });
      render(
        rows.map((r) =>
          periodRow(
            {
              id: r.id,
              period_start: dateOnly(r.period_start),
              period_end: dateOnly(r.period_end),
              pay_date: dateOnly(r.pay_date),
              tax_year: r.tax_year,
              status: r.status,
            },
            r.pay_schedule_id
          )
        ),
        { ...opts, idField: 'id' }
      );
      if (rows.length === 0 && legible(opts)) process.stderr.write(p.dim(`${t('paycalendar.period.empty')}\n`));
    })
  );
}
