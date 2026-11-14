import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { entityScope, type EntityScope } from '../database/scope.js';
import {
  createPaySchedule,
  listPaySchedules,
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
} from './kernel/index.js';

// ============================================================
// mnemosine pay-schedule · calendario-nomina — MNE-001-403 (#587)
//
// The schedule a pay run runs over, from the terminal: before this a schedule
// was created only over REST. The nouns, verbs and flags are the catalog rows
// (docs/cli-command-catalog.md, «Calendarios de pago, periodos y captura de
// tiempo»), and every leaf calls pay-period-service.ts, the same service as
// the REST routes. The periods of a schedule are still created over REST
// only (#613).
//
// The write is not open to the agent: a schedule is not a review queue.
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

const EXAMPLES = {
  scheduleCreate: `
Examples:
  mnemosine pay-schedule create --name Quincenal --frequency quincenal --country MX --first-start 2026-07-01 --dry-run
`,
  scheduleList: `
Examples:
  mnemosine pay-schedule list --all --json
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

export function registerPayCalendarCommand(program: Command, deps: PayCalendarCommandDeps): void {
  const p = deps.palette;
  // Help by key (#314): help.pay_schedule.*.
  const schedule = describeCommand(
    program.command('pay-schedule').alias('calendario-nomina'),
    'help.pay_schedule.description'
  );

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
}
