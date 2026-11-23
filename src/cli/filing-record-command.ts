import type { Command } from 'commander';
import type pg from 'pg';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { withTransaction } from '../database/connection.js';
import { entityScope } from '../database/scope.js';
import { t } from '../i18n/index.js';
import {
  recordFiledReturn,
  type FiledReturn,
  type FiledReturnFiling,
} from '../services/fiscal/filed-returns.js';
import { todayFor } from '../services/policy/today.js';
import { isRealCalendarDate } from '../utils/calendar-date.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  describeCommand,
  exitCodeFor,
  gateMutation,
  legible,
  optionByKey,
  render,
  requireExplicitEntity,
  usageError,
  validationFailed,
  withContext,
  withOutput,
} from './kernel/index.js';

// ============================================================
// mnemosine filing record · declaracion registrar — MNE-001-577 (#308, 3/3)
//
// The accountant records a monthly IVA return ALREADY FILED in the SAT
// portal: its acknowledgement («acuse»), what it left payable or in favour,
// its payment and the earlier balances it credited (LIVA art. 6). It writes
// through recordFiledReturn (MNE-001-576) into the append-only record of
// migration 337: one new row per filed return, never an upsert. Nothing is
// sent to the SAT.
//
// THE LEAF SAYS EVERY FLAG IN WORDS BEFORE ANY QUERY (exit 2): a flag
// missing or malformed, `--payable` and `--in-favor` together or neither,
// half a payment, a `--credit` that is not `<acuse>:<amount>`. The rules of
// the return and between returns are the service's, said by its keys
// (exit 4; exit 6 for an acknowledgement or a month already recorded). Only
// the future-date rule is the leaf's own and waits for the entity, whose day
// decides what "today" is: a return or a payment dated after today has not
// happened yet.
//
// AN AMENDED RETURN IS NOT RECORDED HERE. The approved plan gives this leaf
// no `--replaces`; the service already names the replaced return by its
// acuse, and `filing correct` will use that path.
//
// `--dry-run` RUNS THE WHOLE WRITE AND ROLLS IT BACK, so a rehearsal also
// hears the rules between rows (an unknown credit source, a month already
// recorded) and prints the row a real run would leave. A retry of the same
// return is refused by the acknowledgement's UNIQUE, never written twice, so
// the leaf, a reversible write («escritura»), takes no idempotency key.
// ============================================================

export interface FilingRecordDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface Opts {
  entity?: string; tenant?: string; user?: string;
  format?: string; json?: boolean; fields?: string | boolean; quiet?: boolean; output?: string;
  form?: string; period?: string; filedOn?: string; captureLine?: string;
  // NOTE: `--acuse` is the catalogue's spelling of the flag (the SAT's word on
  // the acknowledgement), and Commander derives this attribute from it. The
  // quoted key mirrors that contract; it is not a name this code chose.
  'acuse'?: string;
  payable?: string; inFavor?: string; paid?: string; paidOn?: string; credit?: string[];
  dryRun?: boolean;
}

/** The forms this leaf records, as typed; `iva` is the monthly IVA return. */
const FORMS = ['iva'] as const;
const PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/;
/** DECIMAL(19,2) of migration 337: up to seventeen digits before the point and two after. */
const AMOUNT = /^\d{1,17}(\.\d{1,2})?$/;

/** The filing as the service takes it, without who records it. */
export type FilingCapture = Omit<FiledReturnFiling, 'recordedBy'>;

function amount(flag: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!AMOUNT.test(value)) throw usageError({ key: 'filing.record.amount_invalid', params: { flag, value } });
  return value;
}

function day(flag: string, value: string | undefined): string {
  if (!isRealCalendarDate(value ?? '')) {
    throw usageError({ key: 'filing.record.date_invalid', params: { flag, value: value ?? '' } });
  }
  return value!;
}

/** `--credit <acuse>:<amount>`: split on the last colon, so the amount is always the tail. */
function credit(value: string): { sourceAcknowledgement: string; amount: string } {
  const at = value.lastIndexOf(':');
  const ack = at > 0 ? value.slice(0, at).trim() : '';
  const figure = at > 0 ? value.slice(at + 1).trim() : '';
  if (ack === '' || !AMOUNT.test(figure)) {
    throw usageError({ key: 'filing.record.credit_invalid', params: { value } });
  }
  return { sourceAcknowledgement: ack, amount: figure };
}

/** The flags as a filing, or the refusal of the first one that fails. No query. */
export function parseFilingRecord(opts: Opts): FilingCapture {
  const form = FORMS.find((f) => f === opts.form?.trim().toLowerCase());
  if (!form) throw usageError({ key: 'filing.record.form_invalid', params: { value: opts.form ?? '', forms: FORMS.join(', ') } });
  const period = opts.period?.trim() ?? '';
  if (!PERIOD.test(period)) throw usageError({ key: 'filing.record.period_invalid', params: { value: period } });
  const filedOn = day('--filed-on', opts.filedOn);
  const acknowledgementNumber = opts['acuse']?.trim() ?? '';
  if (acknowledgementNumber === '') throw usageError({ key: 'filing.record.acuse_required' });
  if (opts.captureLine !== undefined && opts.captureLine.trim() === '') {
    throw usageError({ key: 'filing.record.capture_line_blank' });
  }
  if (opts.payable !== undefined && opts.inFavor !== undefined) throw usageError({ key: 'filing.record.result_both' });
  if (opts.payable === undefined && opts.inFavor === undefined) throw usageError({ key: 'filing.record.result_required' });
  const amountPayable = amount('--payable', opts.payable);
  const balanceInFavor = amount('--in-favor', opts.inFavor);
  if ((opts.paid === undefined) !== (opts.paidOn === undefined)) {
    throw usageError({
      key: 'filing.record.payment_incomplete',
      params: { missing: opts.paid === undefined ? '--paid' : '--paid-on' },
    });
  }
  const amountPaid = amount('--paid', opts.paid);
  const paidOn = opts.paidOn === undefined ? undefined : day('--paid-on', opts.paidOn);
  const credits = (opts.credit ?? []).map(credit);
  return {
    obligation: 'iva_monthly', period, filedOn, acknowledgementNumber,
    ...(opts.captureLine === undefined ? {} : { captureLine: opts.captureLine.trim() }),
    ...(amountPayable === undefined ? {} : { amountPayable }),
    ...(balanceInFavor === undefined ? {} : { balanceInFavor }),
    ...(amountPaid === undefined ? {} : { amountPaid, paidOn }),
    ...(credits.length === 0 ? {} : { credits }),
  };
}

/** Carries a rehearsed row out of the transaction it rolls back. Never reaches the user. */
class Rehearsal extends Error {
  constructor(readonly saved: FiledReturn) {
    super();
  }
}

/** Runs the write in a transaction that is always rolled back, and returns the row it left. */
async function rehearse(write: (c: pg.PoolClient) => Promise<FiledReturn>): Promise<FiledReturn> {
  return withTransaction(async (c) => { throw new Rehearsal(await write(c)); }).catch((e: unknown) => {
    if (e instanceof Rehearsal) return e.saved;
    throw e;
  });
}

/** The usage text: what the leaf does and its examples, keyed, resolved when the help is shown. */
const helpFooter = (): string => `\n${t('help.filing.record.footer')}\n`;

export function registerFilingRecordCommand(program: Command, deps: FilingRecordDeps): void {
  const family =
    program.commands.find((c) => c.name() === 'filing') ??
    describeCommand(program.command('filing').alias('declaracion'), 'help.filing.description');
  const record = describeCommand(family.command('record').alias('registrar'), 'help.filing.record.description');
  withContext(record);
  withOutput(record);
  optionByKey(record, '--form <form>', 'help.filing.record.option.form', { params: { forms: FORMS.join(' | ') } });
  optionByKey(record, '--period <YYYY-MM>', 'help.filing.record.option.period');
  optionByKey(record, '--filed-on <date>', 'help.filing.record.option.filed_on');
  optionByKey(record, '--acuse <number>', 'help.filing.record.option.acuse');
  optionByKey(record, '--capture-line <line>', 'help.filing.record.option.capture_line');
  optionByKey(record, '--payable <amount>', 'help.filing.record.option.payable');
  optionByKey(record, '--in-favor <amount>', 'help.filing.record.option.in_favor');
  optionByKey(record, '--paid <amount>', 'help.filing.record.option.paid');
  optionByKey(record, '--paid-on <date>', 'help.filing.record.option.paid_on');
  optionByKey(record, '--credit <acuse:amount>', 'help.filing.record.option.credit', {
    parser: (value: string, previous: unknown) => [...((previous as string[] | undefined) ?? []), value],
  });
  optionByKey(record, '--dry-run', 'cli.flag.dry_run');
  // Not open to the agent: a filed return is a person's attestation, not a draft for review.
  declareRisk(record, {
    risk: 'escritura', agent: false,
    writes: 'filed_tax_returns + filed_tax_return_credits (one row per filed return, append-only)',
  });
  record.addHelpText('after', helpFooter);
  record.action(async (opts: Opts, cmd: Command) => {
    try {
      const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
      const filing = parseFilingRecord(opts);
      // Tenant FIRST: entity resolution is bounded by it. A write never guesses the entity.
      bootstrapTenant(opts.tenant);
      const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
      const who = await resolveReviewer(ctx.tenantId, opts.user);
      const today = await todayFor({ tenantId: ctx.tenantId, entityId: ctx.entityId });
      if (filing.filedOn > today) {
        throw validationFailed({ key: 'filing.record.filed_on_in_future', params: { value: filing.filedOn, today } });
      }
      if (filing.paidOn !== undefined && filing.paidOn > today) {
        throw validationFailed({ key: 'filing.record.paid_on_in_future', params: { value: filing.paidOn, today } });
      }
      const scope = entityScope(ctx.tenantId, ctx.entityId);
      const full = { ...filing, recordedBy: who.userId };
      const saved = dryRun
        ? await rehearse((c) => recordFiledReturn(scope, full, c))
        : await recordFiledReturn(scope, full);
      render(
        [{
          id: dryRun ? '' : saved.id, form: 'iva', period: saved.period, return_type: saved.returnType,
          filed_on: saved.filedOn, acuse: saved.acknowledgementNumber, capture_line: saved.captureLine,
          payable: saved.amountPayable, in_favor: saved.balanceInFavor, paid: saved.amountPaid, paid_on: saved.paidOn,
          credits: saved.credits.map((x) => `${x.sourceAcknowledgement}:${x.amount}`).join(' '),
          recorded_by: who.email, recorded_at: dryRun ? '' : saved.recordedAt, dry_run: dryRun,
        }],
        { ...opts, idField: 'id' }
      );
      if (legible(opts)) {
        const note = dryRun
          ? t('filing.record.dry_run')
          : t('filing.record.recorded', { acuse: saved.acknowledgementNumber, period: saved.period });
        process.stderr.write(deps.palette.dim(`  ${note}\n`));
      }
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  });
}
