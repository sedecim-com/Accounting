import { z } from 'zod/v4';
import { envolverDatosDeTerceros } from '../untrusted.js';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import Decimal from 'decimal.js';
import type { AgentContext } from '../context.js';
import type { ToolObserver } from './observer.js';
import {
  queryTrialBalanceRows,
  totalTrialBalance,
  queryBalanceSheetRows,
  queryIncomeStatementRows,
  netMovement,
  queryAgedReceivableRows,
  queryAgedPayableRows,
  queryLedgerRows,
  type BalanceSheetQueryRow,
} from '../../services/reporting/report-service.js';
import { avisoDeCierreEnRango } from '../../services/reporting/criterio-cierre.js';

// ============================================================
// REPORT TOOLS (read-only)
//
// The SQL now lives in src/services/reporting/report-service.ts and is
// shared with /v1/reports/* and with `mnemosine report …`: one trial
// balance, one set of sign conventions, one place where the
// parenthesized (jel JOIN je) pair keeps draft and void entries out.
//
// What stays here is the AGENT's projection, and it stays on purpose.
// These tools round to 2 decimals (a model reading 18477.1200 is a model
// inventing precision it was not given), publish a flatter shape than the
// REST envelope, order the ageing by days_overdue rather than by customer,
// and cap the ledger at 100 movements. Those are properties of the agent's
// context window, not of the report — so they are expressed here, over
// shared rows, instead of being pushed into the service where the other
// two surfaces would inherit them.
//
// Sign convention: balances are debit-positive unless the tool output
// says otherwise.
// ============================================================

/** What the agent gets to see. More digits is not more truth. */
const AGENT_SCALE = 2;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateInput = (desc: string) => z.string().regex(DATE_RE).describe(desc);

export function buildReportTools(ctx: AgentContext, observe?: ToolObserver) {
  const trialBalance = betaZodTool({
    name: 'get_trial_balance',
    description:
      'Trial balance: per account, total debits, credits, and balance (positive = debit balance). ' +
      'Only journal entries with posted status. Includes totals and whether the trial balance balances.',
    inputSchema: z.object({
      as_of_date: dateInput('Cutoff YYYY-MM-DD; omit to include the full history').optional(),
      only_with_balance: z.boolean().optional().describe('true = omit zero-balance accounts'),
    }),
    run: async (input) => {
      observe?.('get_trial_balance', input);
      const all = await queryTrialBalanceRows(ctx.entityId, { asOfDate: input.as_of_date });

      const kept = input.only_with_balance
        ? all.filter((r) => !new Decimal(r.ending_balance).isZero())
        : all;
      const rows = kept.map((r) => ({
        account_code: r.account_code,
        account_name: r.account_name,
        account_type: r.account_type,
        debit_total: r.debit_total,
        credit_total: r.credit_total,
        ending_balance: r.ending_balance,
      }));

      // El agente ve la misma nota que la CLI y el REST: sin ella explicaría
      // como discrepancia la diferencia normal entre una balanza que cuenta el
      // cierre del ejercicio y un estado de resultados que no lo cuenta.
      const closing = await avisoDeCierreEnRango(
        ctx.entityId,
        { asOfDate: input.as_of_date },
        'trial-balance'
      );

      return JSON.stringify({
        as_of_date: input.as_of_date ?? null,
        currency: ctx.currency,
        accounts: rows,
        totals: totalTrialBalance(kept, AGENT_SCALE),
        ...(closing ? { closing_entries: closing } : {}),
      });
    },
  });

  const balanceSheet = betaZodTool({
    name: 'get_balance_sheet',
    description:
      'Balance sheet (statement of financial position) as of a cutoff date. ' +
      "Amounts in each section's natural sign: a negative amount is a contra " +
      'account that subtracts from its section (e.g. accumulated depreciation in assets).',
    inputSchema: z.object({
      as_of_date: dateInput('Cutoff date YYYY-MM-DD'),
    }),
    run: async (input) => {
      observe?.('get_balance_sheet', input);
      const rows = await queryBalanceSheetRows(ctx.entityId, input.as_of_date);

      // Flat by account code, not grouped into fs_category subsections: the
      // agent reads a list, and the REST envelope's nesting only costs tokens.
      // naturalSign converts the debit-positive raw balance into the section's
      // natural sign, so contra accounts NET against their section total.
      const section = (types: string[], naturalSign: 1 | -1) => {
        const accounts = rows.filter((r: BalanceSheetQueryRow) => types.includes(r.account_type));
        const total = accounts
          .reduce((s, a) => s.plus(a.balance), new Decimal(0))
          .times(naturalSign);
        return {
          total: total.toFixed(AGENT_SCALE),
          accounts: accounts.map((a) => ({
            code: a.code, name: a.name, category: a.fs_category,
            balance: new Decimal(a.balance).times(naturalSign).toFixed(AGENT_SCALE),
          })),
        };
      };

      const assets = section(['asset', 'contra_asset'], 1);
      const liabilities = section(['liability', 'contra_liability'], -1);
      const equity = section(['equity', 'contra_equity'], -1);

      return JSON.stringify({
        as_of_date: input.as_of_date,
        currency: ctx.currency,
        assets, liabilities, equity,
        total_liabilities_and_equity: new Decimal(liabilities.total).plus(equity.total).toFixed(AGENT_SCALE),
      });
    },
  });

  const incomeStatement = betaZodTool({
    name: 'get_income_statement',
    description:
      'Income statement for a date range: revenue, expenses, and net income. ' +
      'Revenue in its natural credit sign; expenses in their natural debit sign (both positive).',
    inputSchema: z.object({
      start_date: dateInput('Period start YYYY-MM-DD'),
      end_date: dateInput('Period end YYYY-MM-DD'),
    }),
    run: async (input) => {
      observe?.('get_income_statement', input);
      // 'any-activity': an account that moved and netted to zero is still a
      // fact the agent may need to explain, unlike in the REST statement.
      const rows = await queryIncomeStatementRows(ctx.entityId, {
        startDate: input.start_date,
        endDate: input.end_date,
        include: 'any-activity',
      });

      // Revenue is credit-natural, expenses debit-natural — report both positive.
      const revenueRows = rows
        .filter((r) => r.account_type === 'revenue')
        .map((r) => ({ code: r.code, name: r.name, amount: netMovement(r).negated().toFixed(AGENT_SCALE) }));
      const expenseRows = rows
        .filter((r) => r.account_type === 'expense')
        .map((r) => ({ code: r.code, name: r.name, amount: netMovement(r).toFixed(AGENT_SCALE) }));

      const totalRevenue = revenueRows.reduce((s, r) => s.plus(r.amount), new Decimal(0));
      const totalExpenses = expenseRows.reduce((s, r) => s.plus(r.amount), new Decimal(0));

      const closing = await avisoDeCierreEnRango(
        ctx.entityId,
        { sinceDate: input.start_date, untilDate: input.end_date },
        'income-statement'
      );

      return JSON.stringify({
        start_date: input.start_date,
        end_date: input.end_date,
        currency: ctx.currency,
        revenue: { total: totalRevenue.toFixed(AGENT_SCALE), accounts: revenueRows },
        expenses: { total: totalExpenses.toFixed(AGENT_SCALE), accounts: expenseRows },
        net_income: totalRevenue.minus(totalExpenses).toFixed(AGENT_SCALE),
        ...(closing ? { closing_entries: closing } : {}),
      });
    },
  });

  const agedReceivables = betaZodTool({
    name: 'get_aged_receivables',
    description:
      'Aged receivables: customer invoices with outstanding balance and days overdue ' +
      '(negative days_overdue = not yet due).',
    inputSchema: z.object({
      as_of_date: dateInput('Reference date YYYY-MM-DD; omit for today').optional(),
    }),
    run: async (input) => {
      observe?.('get_aged_receivables', input);
      const asOf = input.as_of_date ?? new Date().toISOString().split('T')[0];
      const all = await queryAgedReceivableRows(ctx.entityId, { asOfDate: asOf, order: 'overdue' });
      const invoices = all.map((r) => ({
        customer_name: r.customer_name,
        customer_number: r.customer_number,
        invoice_number: r.invoice_number,
        invoice_date: r.invoice_date,
        due_date: r.due_date,
        total_amount: r.total_amount,
        amount_due: r.amount_due,
        days_overdue: r.days_overdue,
      }));
      const totalDue = all.reduce((s, r) => s.plus(new Decimal(r.amount_due)), new Decimal(0));
      return envolverDatosDeTerceros({
        as_of_date: asOf, currency: ctx.currency,
        total_due: totalDue.toFixed(AGENT_SCALE), count: invoices.length, invoices,
      });
    },
  });

  const agedPayables = betaZodTool({
    name: 'get_aged_payables',
    description:
      'Aged payables: vendor bills with outstanding balance and days overdue ' +
      '(negative days_overdue = not yet due).',
    inputSchema: z.object({
      as_of_date: dateInput('Reference date YYYY-MM-DD; omit for today').optional(),
    }),
    run: async (input) => {
      observe?.('get_aged_payables', input);
      const asOf = input.as_of_date ?? new Date().toISOString().split('T')[0];
      const all = await queryAgedPayableRows(ctx.entityId, { asOfDate: asOf, order: 'overdue' });
      const bills = all.map((r) => ({
        vendor_name: r.vendor_name,
        vendor_number: r.vendor_number,
        bill_number: r.bill_number,
        bill_date: r.bill_date,
        due_date: r.due_date,
        total_amount: r.total_amount,
        amount_due: r.amount_due,
        days_overdue: r.days_overdue,
      }));
      const totalDue = all.reduce((s, r) => s.plus(new Decimal(r.amount_due)), new Decimal(0));
      return envolverDatosDeTerceros({
        as_of_date: asOf, currency: ctx.currency,
        total_due: totalDue.toFixed(AGENT_SCALE), count: bills.length, bills,
      });
    },
  });

  const generalLedger = betaZodTool({
    name: 'get_general_ledger',
    description:
      'General ledger detail: line-by-line movements of an account (posted journal entries) in a date range. ' +
      'Maximum 100 movements per query.',
    inputSchema: z.object({
      account_code: z.string().describe('Account code, e.g. 1101'),
      start_date: dateInput('Start YYYY-MM-DD').optional(),
      end_date: dateInput('End YYYY-MM-DD').optional(),
    }),
    run: async (input) => {
      observe?.('get_general_ledger', input);
      // 101 rows for a 100-row answer: the extra one is how truncation is
      // detected without paying for a COUNT the agent never shows.
      const fetched = await queryLedgerRows(ctx.entityId, {
        accountCode: input.account_code,
        startDate: input.start_date,
        endDate: input.end_date,
        limit: 101,
      });

      if (fetched.length === 0) {
        return `No posted movements for account ${input.account_code} in that range.`;
      }
      const truncated = fetched.length > 100;
      const rows = fetched.slice(0, 100);
      const movements = rows.map((r) => ({
        entry_number: r.entry_number,
        entry_date: r.entry_date,
        entry_description: r.entry_description,
        debit_amount: r.debit_amount,
        credit_amount: r.credit_amount,
        line_description: r.line_description,
      }));
      const debits = rows.reduce((s, r) => s.plus(new Decimal(r.debit_amount ?? 0)), new Decimal(0));
      const credits = rows.reduce((s, r) => s.plus(new Decimal(r.credit_amount ?? 0)), new Decimal(0));

      return envolverDatosDeTerceros({
        account_code: input.account_code, truncated, count: movements.length,
        period_debits: debits.toFixed(AGENT_SCALE), period_credits: credits.toFixed(AGENT_SCALE),
        movements,
      });
    },
  });

  return [trialBalance, balanceSheet, incomeStatement, agedReceivables, agedPayables, generalLedger];
}
