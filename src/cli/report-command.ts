import type { Command } from 'commander';
import Decimal from 'decimal.js';
import { bootstrapTenant, type AgentContext } from '../ai/context.js';
import {
  resolvePeriodRange,
  getTrialBalance,
  getBalanceSheet,
  getIncomeStatement,
  getGeneralLedger,
  getAgedReceivables,
  getAgedPayables,
  type PeriodRange,
  type TrialBalanceOptions,
} from '../services/reporting/report-service.js';
import {
  refreshReportingViews,
  getReportingViewStatus,
  REPORTING_VIEWS,
} from '../services/reporting/materialized-view-service.js';
import { resolveAccount } from '../services/accounting/account-service.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  withSelection,
  withTime,
  resolveActiveEntity,
  usageError,
  validationFailed,
  exitCodeFor,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine report
//
// The financial statements from the terminal. Until now they existed
// only as HTTP endpoints and as agent tools, which means the only way a
// human could get a trial balance was to ASK A LANGUAGE MODEL FOR ONE.
// Every command here goes through services/reporting/report-service.ts,
// the same path /v1/reports/* takes, so the numbers cannot drift between
// the API, the chat and the terminal.
//
// Three decisions run through the whole family:
//
//   EVERY AMOUNT IS A STRING. It comes out of Postgres as a decimal
//   string and it reaches stdout as the same string. Nothing here parses
//   money into a JS number, so nothing here can lose a cent to a float.
//
//   TRUNCATION IS NEVER SILENT. Every command that accepts --limit hands
//   render() the true `total`, so a short answer says it is short. A
//   trial balance quietly showing 50 of 412 accounts is not a short trial
//   balance, it is a WRONG one. That is also why no statement carries a
//   default limit: only the general ledger does, because it is unbounded
//   by nature, and it announces the cut.
//
//   TOTALS ARE FOOTED OVER EVERYTHING, THEN THE PAGE IS CUT. --limit
//   changes what you SEE, never what the statement SAYS.
//
// Statements print their subtotals in band (a balance sheet without its
// section totals is not a balance sheet), while the trial balance prints
// its footing on stderr: its rows are uniform and machine-shaped, its
// footing is exactly their sum, and a stray TOTAL row is a landmine in
// a csv someone imports.
// ============================================================

export interface ReportCommandDeps {
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
  period?: string;
  since?: string;
  until?: string;
  asOf?: string;
  dateBasis?: string;
}

/**
 * Postgres hands a DATE back as a Date at LOCAL midnight, so the local
 * getters are the ones that give the day the database actually stored.
 * toISOString() would shift it a day west of Greenwich.
 */
function isoDate(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return value === null || value === undefined ? '' : String(value);
}

function today(): string {
  return isoDate(new Date());
}

/**
 * Normalises an amount to the ledger's four decimals for DISPLAY only.
 * Postgres returns the outer COALESCE(...,0) of an empty account as the
 * integer `0`, so a raw column mixes "0" with "2469.1200" and the eye stops
 * being able to compare them. Decimal in, string out: no float ever exists.
 */
function money(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return new Decimal(value).toFixed(4);
}

/**
 * withSelection carries --status because most list commands need it; no
 * report here filters by lifecycle state, and silently ignoring a flag the
 * user typed is how someone ends up trusting a filter that never ran.
 */
function rejectStatus(opts: CommonOpts, name: string): void {
  if (opts.status?.length) {
    throw usageError(
      `--status does not apply to "${name}": it reports posted balances, not a lifecycle state.`
    );
  }
}

/** --all means "no default limit"; otherwise the command's own default applies. */
function pageLimit(opts: CommonOpts, fallback?: number): number | undefined {
  if (opts.all) return undefined;
  return opts.limit ?? fallback;
}

/**
 * Cuts the page an ASSEMBLED statement displays. The reports that page in
 * SQL get this from the service; a balance sheet and an income statement are
 * built in memory and are paged here, over rows already footed in full.
 *
 * `--offset` is honoured on its own, without `--limit`. Dropping it in that
 * case would be exactly the defect `rejectStatus` exists to prevent: a flag
 * the user typed that quietly does nothing.
 */
function pageOf<T>(rows: T[], opts: CommonOpts): T[] {
  const from = opts.offset ?? 0;
  const shown = pageLimit(opts);
  return shown === undefined ? rows.slice(from) : rows.slice(from, from + shown);
}

export function registerReportCommand(program: Command, deps: ReportCommandDeps): void {
  const report = program
    .command('report')
    .alias('reporte')
    .description('Financial statements, trial balance, general ledger and ageing');

  const note = (message: string) => process.stderr.write(deps.palette.dim(`${message}\n`));
  const warn = (message: string) => process.stderr.write(deps.palette.yellow(`${message}\n`));

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  const entityOf = async (opts: CommonOpts): Promise<AgentContext> => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity(
      { entity: opts.entity },
      { home: deps.home, warn }
    );
    return ctx;
  };

  /** Resolves --period once, and says so when it fell back to the calendar. */
  const windowOf = async (ctx: AgentContext, opts: CommonOpts): Promise<PeriodRange | null> => {
    if (!opts.period) return null;
    const range = await resolvePeriodRange(ctx.entityId, opts.period);
    if (!range.matched_fiscal_period) {
      note(
        `"${opts.period}" matched no single fiscal period; using the calendar range ` +
          `${range.start_date} → ${range.end_date}.`
      );
    }
    return range;
  };

  const header = (ctx: AgentContext, title: string, scope: string) =>
    note(`${title} · ${ctx.entityName} · ${ctx.currency} · ${scope}`);

  // ---- report trial-balance show -----------------------------------
  const trialBalance = report
    .command('trial-balance')
    .alias('balanza')
    .description('Trial balance');
  const tbShow = trialBalance
    .command('show')
    .alias('ver')
    .description('Debits, credits and ending balance by account, with the footing');
  withOutput(withSelection(withTime(withContext(tbShow))));
  tbShow
    .option('--level <n>', 'roll up to at most this account level (default: every level)')
    .option('--exclude-zero', 'omit accounts whose ending balance is exactly zero');
  declareRisk(tbShow, { risk: 'lectura', agent: true });
  tbShow.action((opts: CommonOpts & { level?: string; excludeZero?: boolean }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      rejectStatus(opts, 'report trial-balance show');
      const range = await windowOf(ctx, opts);

      const filters: TrialBalanceOptions = { excludeZero: opts.excludeZero };
      let scope: string;
      if (opts.asOf) {
        // Cumulative: everything posted up to the cutoff.
        filters.asOfDate = opts.asOf;
        scope = `cumulative to ${opts.asOf}`;
      } else if (range?.fiscal_period_id) {
        // The activity of ONE fiscal period, by its id — the strict reading.
        filters.fiscalPeriodId = range.fiscal_period_id;
        scope = `period ${range.period_name}`;
      } else if (range) {
        filters.sinceDate = range.start_date;
        filters.untilDate = range.end_date;
        scope = `${range.start_date} → ${range.end_date}`;
      } else if (opts.since || opts.until) {
        filters.sinceDate = opts.since;
        filters.untilDate = opts.until;
        scope = `${opts.since ?? 'start'} → ${opts.until ?? 'today'}`;
      } else {
        scope = 'full posted history';
      }

      if (opts.level !== undefined) {
        const level = Number(opts.level);
        if (!Number.isInteger(level) || level < 1) {
          throw usageError(`--level must be a whole number of at least 1; got "${opts.level}".`);
        }
        filters.maxLevel = level;
      }

      const tb = await getTrialBalance(ctx.entityId, {
        ...filters,
        limit: pageLimit(opts),
        offset: opts.offset,
      });

      const rows: Row[] = tb.rows.map((r) => ({
        account_code: r.account_code,
        account_name: r.account_name,
        account_type: r.account_type,
        debit_total: money(r.debit_total),
        credit_total: money(r.credit_total),
        ending_balance: money(r.ending_balance),
      }));

      header(ctx, 'Trial balance', scope);
      render(rows, { ...opts, total: tb.total, idField: 'account_code' });

      // The footing goes to stderr so a piped csv stays importable, and it is
      // computed over every matched account, not over the page above.
      const { total_debits, total_credits, is_balanced } = tb.totals;
      const line = `Debits ${total_debits}   Credits ${total_credits}   (${tb.total} accounts)`;
      if (is_balanced) note(`${line}   balanced`);
      else {
        warn(
          `${line}   OUT OF BALANCE by ` +
            `${new Decimal(total_debits).minus(total_credits).toFixed(4)}`
        );
      }
    })
  );

  // ---- report balance-sheet show -----------------------------------
  const balanceSheet = report
    .command('balance-sheet')
    .alias('balance')
    .description('Balance sheet');
  const bsShow = balanceSheet
    .command('show')
    .alias('ver')
    .description('Assets, liabilities and equity at a cutoff date, in natural sign');
  withOutput(withSelection(withTime(withContext(bsShow))));
  declareRisk(bsShow, { risk: 'lectura', agent: true });
  bsShow.action((opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      rejectStatus(opts, 'report balance-sheet show');
      const range = await windowOf(ctx, opts);
      const asOf = opts.asOf ?? range?.end_date ?? opts.until ?? today();

      const bs = await getBalanceSheet(ctx.entityId, { asOfDate: asOf });

      // A balance sheet is its subtotals. They travel in band, tagged by
      // `line`, so csv, json and the table all carry the same statement.
      const rows: Row[] = [];
      for (const section of [bs.assets, bs.liabilities, bs.equity]) {
        for (const sub of section.subsections) {
          for (const account of sub.accounts) {
            rows.push({
              section: section.name,
              category: sub.name,
              code: account.code,
              name: account.name,
              amount: account.balance,
              line: 'account',
            });
          }
          rows.push({
            section: section.name, category: sub.name, code: '',
            name: `Total ${sub.name}`, amount: sub.total, line: 'subtotal',
          });
        }
        rows.push({
          section: section.name, category: '', code: '',
          name: `Total ${section.name}`, amount: section.total, line: 'total',
        });
      }
      rows.push({
        section: '', category: '', code: '',
        name: 'Total Liabilities and Equity',
        amount: bs.total_liabilities_and_equity,
        line: 'total',
      });

      header(ctx, 'Balance sheet', `as of ${asOf}`);
      render(pageOf(rows, opts), { ...opts, total: rows.length, idField: 'code' });

      // The accounting identity, enforced rather than explained away.
      //
      // This used to warn and then excuse the difference as "an open period
      // differs by exactly the net income" — which was the defect stating
      // itself as if it were a rule. The result of the period is now inside
      // equity (see queryUnclosedEarnings), so the statement foots whether or
      // not the year has been closed, and any remaining difference is a real
      // defect in the ledger. A balance sheet that does not balance is not a
      // warning, it is a failed check: exit 4, per the diagnostic contract.
      if (bs.is_balanced) {
        note(`Assets ${bs.assets.total} = Liabilities + Equity ${bs.total_liabilities_and_equity}`);
      } else {
        throw validationFailed(
          `The balance sheet does not balance: assets ${bs.assets.total} vs liabilities plus ` +
            `equity ${bs.total_liabilities_and_equity} — out by ${bs.out_of_balance}. ` +
            'The ledger itself is inconsistent at this date; run `mnemosine entry check` and ' +
            'reconcile the subledgers before relying on any statement.',
          { out_of_balance: bs.out_of_balance, as_of: asOf }
        );
      }
    })
  );

  // ---- report income-statement show --------------------------------
  const incomeStatement = report
    .command('income-statement')
    .alias('resultados')
    .description('Income statement');
  const isShow = incomeStatement
    .command('show')
    .alias('ver')
    .description('Revenue, expenses and net income for a period');
  withOutput(withSelection(withTime(withContext(isShow))));
  declareRisk(isShow, { risk: 'lectura', agent: true });
  isShow.action((opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      rejectStatus(opts, 'report income-statement show');
      const range = await windowOf(ctx, opts);

      const startDate = range?.start_date ?? opts.since;
      const endDate = range?.end_date ?? opts.until;
      if (!startDate || !endDate) {
        // An income statement without a period is not a statement, so this
        // refuses rather than inventing a range that would look authoritative.
        throw usageError(
          'An income statement covers a period. Pass --period <expr>, or both --since and --until.'
        );
      }

      const is = await getIncomeStatement(ctx.entityId, { startDate, endDate });

      const rows: Row[] = [];
      for (const section of [is.revenue, is.expenses]) {
        for (const account of section.accounts) {
          rows.push({
            section: section.name, code: account.code, name: account.name,
            amount: account.amount, line: 'account',
          });
        }
        rows.push({
          section: section.name, code: '', name: `Total ${section.name}`,
          amount: section.total, line: 'total',
        });
      }
      rows.push({ section: '', code: '', name: 'Net income', amount: is.net_income, line: 'total' });

      header(ctx, 'Income statement', `${startDate} → ${endDate}`);
      render(pageOf(rows, opts), { ...opts, total: rows.length, idField: 'code' });
      note(
        `Revenue ${is.revenue.total}   Expenses ${is.expenses.total}   Net income ${is.net_income}`
      );
    })
  );

  // ---- report general-ledger show ----------------------------------
  const generalLedger = report
    .command('general-ledger')
    .alias('mayor')
    .description('General ledger detail');
  const glShow = generalLedger
    .command('show')
    .alias('ver')
    .description('Posted movements line by line, filterable by account and date');
  withOutput(withSelection(withTime(withContext(glShow))));
  glShow.option('--account <code>', 'restrict to one account (code or id)');
  declareRisk(glShow, { risk: 'lectura', agent: true });
  glShow.action((opts: CommonOpts & { account?: string }) =>
    run(async () => {
      const ctx = await entityOf(opts);
      rejectStatus(opts, 'report general-ledger show');
      const range = await windowOf(ctx, opts);

      // `--as-of` means here exactly what it means on the trial balance:
      // everything posted up to the cutoff, with no lower bound. Accepting the
      // flag and then filtering by nothing handed back the movements from
      // AFTER the date the caller asked about — more data than was asked for,
      // which is the quiet kind of wrong.
      const startDate = opts.asOf ? undefined : (range?.start_date ?? opts.since);
      const endDate = opts.asOf ?? range?.end_date ?? opts.until;

      // Resolved through the account service so a code and an id both work,
      // and so an unknown account is a 3, not an empty ledger.
      const accountId = opts.account
        ? (await resolveAccount(ctx.entityId, opts.account)).id
        : undefined;

      // The ledger is the one report with a default limit: it is unbounded,
      // and `total` below is what keeps the cut visible.
      const limit = pageLimit(opts, 100);
      const gl = await getGeneralLedger(ctx.entityId, {
        accountId,
        startDate,
        endDate,
        limit: limit ?? Number.MAX_SAFE_INTEGER,
        offset: opts.offset,
      });

      const rows: Row[] = gl.rows.map((r) => ({
        entry_date: isoDate(r.entry_date),
        entry_number: r.entry_number,
        account_code: r.account_code,
        account_name: r.account_name,
        line_number: r.line_number,
        debit_amount: money(r.debit_amount),
        credit_amount: money(r.credit_amount),
        description: r.line_description ?? r.entry_description ?? '',
        entry_type: r.entry_type,
        journal_entry_id: r.journal_entry_id,
      }));

      const scope =
        (opts.asOf
          ? `cumulative to ${opts.asOf}`
          : startDate || endDate
            ? `${startDate ?? 'start'} → ${endDate ?? 'today'}`
            : 'full posted history') +
        (opts.account ? ` · account ${opts.account}` : '');
      header(ctx, 'General ledger', scope);
      render(rows, {
        ...opts,
        total: gl.total,
        idField: 'entry_number',
        fields: opts.fields ?? 'entry_date,entry_number,account_code,account_name,line_number,debit_amount,credit_amount,description',
      });
      note(
        `Page debits ${gl.period_debits}   page credits ${gl.period_credits}   ` +
          `(${gl.rows.length} of ${gl.total} movements)`
      );
    })
  );

  // ---- report aged-receivable / aged-payable show ------------------
  registerAging(report, 'receivable');
  registerAging(report, 'payable');

  function registerAging(parent: Command, kind: 'receivable' | 'payable'): void {
    const isAr = kind === 'receivable';
    const group = parent
      .command(isAr ? 'aged-receivable' : 'aged-payable')
      .alias(isAr ? 'antiguedad-cobrar' : 'antiguedad-pagar')
      .description(isAr ? 'Aged receivables' : 'Aged payables');
    const show = group
      .command('show')
      .alias('ver')
      .description(
        isAr
          ? 'Open customer invoices by age bucket, with the amount still due'
          : 'Open vendor bills by age bucket, with the amount still due'
      );
    withOutput(withSelection(withTime(withContext(show))));
    declareRisk(show, { risk: 'lectura', agent: true });
    show.action((opts: CommonOpts) =>
      run(async () => {
        const ctx = await entityOf(opts);
        rejectStatus(opts, `report aged-${kind} show`);
        const range = await windowOf(ctx, opts);
        const asOf = opts.asOf ?? range?.end_date ?? opts.until ?? today();

        const aging = isAr
          ? await getAgedReceivables(ctx.entityId, {
              asOfDate: asOf, order: 'overdue', limit: pageLimit(opts), offset: opts.offset,
            })
          : await getAgedPayables(ctx.entityId, {
              asOfDate: asOf, order: 'overdue', limit: pageLimit(opts), offset: opts.offset,
            });

        const rows: Row[] = aging.rows.map((r) => {
          const common = {
            bucket: bucketOf(r.days_overdue),
            days_overdue: r.days_overdue,
            due_date: isoDate(r.due_date),
            total_amount: money(r.total_amount),
            amount_due: money(r.amount_due),
          };
          return isAr
            ? {
                customer_number: (r as { customer_number: string }).customer_number,
                customer_name: (r as { customer_name: string }).customer_name,
                invoice_number: (r as { invoice_number: string }).invoice_number,
                invoice_date: isoDate((r as { invoice_date: Date | string }).invoice_date),
                ...common,
              }
            : {
                vendor_number: (r as { vendor_number: string }).vendor_number,
                vendor_name: (r as { vendor_name: string }).vendor_name,
                bill_number: (r as { bill_number: string }).bill_number,
                bill_date: isoDate((r as { bill_date: Date | string }).bill_date),
                ...common,
              };
        });

        header(ctx, isAr ? 'Aged receivables' : 'Aged payables', `as of ${asOf}`);
        render(rows, {
          ...opts,
          total: aging.total,
          idField: isAr ? 'invoice_number' : 'bill_number',
        });
        note(
          `Total due ${aging.total_due} across ${aging.total} open ` +
            (isAr ? 'invoice(s)' : 'bill(s)')
        );

        // The limit of this report, said out loud rather than left for an
        // auditor to discover: the cutoff ages the DUE DATE, but the amount
        // is the balance as it stands right now. Reproducing what was owed
        // on a past date needs the payment history, which this report does
        // not reconstruct.
        if (asOf !== today()) {
          warn(
            `--as-of ${asOf} ages the due dates only. The amounts are today's open balances, ` +
              'not the balances as they stood on that date.'
          );
        }
      })
    );
  }

  // ---- report view show / sync -------------------------------------
  const view = report
    .command('view')
    .alias('vista')
    .description('The reporting materialized views (mv_trial_balance, mv_account_balance_summary)');

  const viewShow = view
    .command('show')
    .alias('ver')
    .description('Whether each reporting view still agrees with the ledger, and by how much');
  withOutput(withSelection(withContext(viewShow)));
  declareRisk(viewShow, { risk: 'lectura', agent: true });
  viewShow.action((opts: CommonOpts) =>
    run(async () => {
      const ctx = await entityOf(opts);
      rejectStatus(opts, 'report view show');
      const statuses = await getReportingViewStatus(ctx.entityId);
      header(ctx, 'Reporting views', 'view totals vs the live ledger');
      render(pageOf(statuses, opts) as unknown as Row[], {
        ...opts,
        total: statuses.length,
        idField: 'view',
      });
      if (statuses.some((s) => s.is_stale)) {
        warn(
          'At least one view no longer agrees with the ledger. The refresh trigger fires only when ' +
            'an entry becomes posted, so migrations and bulk loads leave the views behind. ' +
            'Rebuild them with `mnemosine report view sync`.'
        );
      } else {
        note('Every reporting view agrees with the ledger.');
      }
    })
  );

  const viewSync = view
    .command('sync')
    .alias('sincronizar')
    .description('Rebuild the reporting materialized views from the ledger (firm-wide)');
  withOutput(withContext(viewSync));
  viewSync
    .option('--view <name...>', `which views to rebuild (default: all of ${REPORTING_VIEWS.join(', ')})`)
    .option('--no-concurrently', 'rebuild with an exclusive lock; needed only for a never-populated view');
  // escritura, and closed to the agent: this takes locks, costs real time on a
  // large ledger and changes what every other reader sees. `report view show`
  // is the preview — it says whether a rebuild would change anything at all.
  declareRisk(viewSync, {
    risk: 'escritura',
    agent: false,
    writes: 'mv_trial_balance, mv_account_balance_summary',
  });
  viewSync.action((opts: CommonOpts & { view?: string[]; concurrently?: boolean }) =>
    run(async () => {
      bootstrapTenant(opts.tenant);
      // Deliberately not entity-scoped: a materialized view covers the whole
      // installation, so there is no per-entity refresh to resolve.
      const results = await refreshReportingViews({
        views: opts.view,
        concurrently: opts.concurrently !== false,
      });
      const rows: Row[] = results.map((r) => ({
        view: r.view,
        concurrently: r.concurrently,
        duration_ms: r.duration_ms,
      }));
      render(rows, { ...opts, total: rows.length, idField: 'view' });
      note('Reporting views rebuilt for every entity in this installation.');
    })
  );
}

/** Ageing buckets, derived from days_overdue alone — the part the cutoff gets right. */
export function bucketOf(daysOverdue: number): string {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  if (daysOverdue <= 90) return '61-90';
  return '90+';
}
