import { z } from 'zod/v4';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import Decimal from 'decimal.js';
import { query } from '../../database/connection.js';
import type { AgentContext } from '../context.js';
import type { ToolObserver } from './observer.js';

// ============================================================
// REPORT TOOLS (read-only)
// Same SQL semantics as /v1/reports/* routes, packaged for the
// agent. Sign convention: balances are debit-positive unless
// the tool output says otherwise.
// ============================================================

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
      const params: unknown[] = [ctx.entityId];
      let periodFilter = '';
      if (input.as_of_date) {
        periodFilter = 'AND je.entry_date <= $2';
        params.push(input.as_of_date);
      }

      // The (jel JOIN je) pair is pre-filtered inside the parenthesized join:
      // chaining two LEFT JOINs would keep lines from draft/void entries when
      // the je predicate fails, silently corrupting the balance.
      const result = await query<{
        account_code: string; account_name: string; account_type: string;
        debit_total: string; credit_total: string; ending_balance: string;
      }>(
        `SELECT a.code AS account_code, a.name AS account_name, a.account_type,
                COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0) AS debit_total,
                COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0) AS credit_total,
                COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) AS ending_balance
         FROM accounts a
         LEFT JOIN (journal_entry_lines jel
                    JOIN journal_entries je
                      ON je.id = jel.journal_entry_id
                     AND je.status = 'posted' ${periodFilter})
                ON jel.account_id = a.id
         WHERE a.entity_id = $1 AND a.is_active = true
         GROUP BY a.id, a.code, a.name, a.account_type
         ORDER BY a.code`,
        params
      );

      let rows = result.rows;
      if (input.only_with_balance) {
        rows = rows.filter((r) => !new Decimal(r.ending_balance).isZero());
      }

      const totalDebits = rows.reduce((s, r) => s.plus(new Decimal(r.debit_total)), new Decimal(0));
      const totalCredits = rows.reduce((s, r) => s.plus(new Decimal(r.credit_total)), new Decimal(0));

      return JSON.stringify({
        as_of_date: input.as_of_date ?? null,
        currency: ctx.currency,
        accounts: rows,
        totals: {
          total_debits: totalDebits.toFixed(2),
          total_credits: totalCredits.toFixed(2),
          is_balanced: totalDebits.minus(totalCredits).abs().lessThanOrEqualTo('0.01'),
        },
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
      const result = await query<{
        account_type: string; fs_category: string | null; code: string; name: string; balance: string;
      }>(
        `SELECT a.account_type, a.fs_category, a.code, a.name,
                COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) AS balance
         FROM accounts a
         LEFT JOIN (journal_entry_lines jel
                    JOIN journal_entries je
                      ON je.id = jel.journal_entry_id
                     AND je.status = 'posted' AND je.entry_date <= $2)
                ON jel.account_id = a.id
         WHERE a.entity_id = $1 AND a.is_active = true
           AND a.account_type IN ('asset', 'liability', 'equity', 'contra_asset', 'contra_liability', 'contra_equity')
         GROUP BY a.id, a.account_type, a.fs_category, a.code, a.name
         HAVING COALESCE(SUM(COALESCE(jel.debit_amount, 0) - COALESCE(jel.credit_amount, 0)), 0) != 0
         ORDER BY a.code`,
        [ctx.entityId, input.as_of_date]
      );

      // naturalSign converts the debit-positive raw balance into the section's
      // natural sign (assets: debit; liabilities/equity: credit). Contra
      // accounts then come out negative and NET against their section total —
      // summing abs() would overstate every section with contra accounts.
      const section = (types: string[], naturalSign: 1 | -1) => {
        const accounts = result.rows.filter((r) => types.includes(r.account_type));
        const total = accounts
          .reduce((s, a) => s.plus(a.balance), new Decimal(0))
          .times(naturalSign);
        return {
          total: total.toFixed(2),
          accounts: accounts.map((a) => ({
            code: a.code, name: a.name, category: a.fs_category,
            balance: new Decimal(a.balance).times(naturalSign).toFixed(2),
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
        total_liabilities_and_equity: new Decimal(liabilities.total).plus(equity.total).toFixed(2),
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
      const result = await query<{
        account_type: string; code: string; name: string; debit_total: string; credit_total: string;
      }>(
        `SELECT a.account_type, a.code, a.name,
                COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0) AS debit_total,
                COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0) AS credit_total
         FROM accounts a
         LEFT JOIN (journal_entry_lines jel
                    JOIN journal_entries je
                      ON je.id = jel.journal_entry_id
                     AND je.status = 'posted' AND je.entry_date BETWEEN $2 AND $3)
                ON jel.account_id = a.id
         WHERE a.entity_id = $1 AND a.is_active = true
           AND a.account_type IN ('revenue', 'expense')
         GROUP BY a.id, a.account_type, a.code, a.name
         HAVING COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0) != 0
             OR COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0) != 0
         ORDER BY a.code`,
        [ctx.entityId, input.start_date, input.end_date]
      );

      // Revenue is credit-natural, expenses debit-natural — report both positive.
      const revenueRows = result.rows
        .filter((r) => r.account_type === 'revenue')
        .map((r) => ({
          code: r.code, name: r.name,
          amount: new Decimal(r.credit_total).minus(r.debit_total).toFixed(2),
        }));
      const expenseRows = result.rows
        .filter((r) => r.account_type === 'expense')
        .map((r) => ({
          code: r.code, name: r.name,
          amount: new Decimal(r.debit_total).minus(r.credit_total).toFixed(2),
        }));

      const totalRevenue = revenueRows.reduce((s, r) => s.plus(r.amount), new Decimal(0));
      const totalExpenses = expenseRows.reduce((s, r) => s.plus(r.amount), new Decimal(0));

      return JSON.stringify({
        start_date: input.start_date,
        end_date: input.end_date,
        currency: ctx.currency,
        revenue: { total: totalRevenue.toFixed(2), accounts: revenueRows },
        expenses: { total: totalExpenses.toFixed(2), accounts: expenseRows },
        net_income: totalRevenue.minus(totalExpenses).toFixed(2),
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
      const result = await query(
        `SELECT c.company_name AS customer_name, c.customer_number,
                i.invoice_number, i.invoice_date, i.due_date, i.total_amount, i.amount_due,
                ($2::date - i.due_date) AS days_overdue
         FROM invoices i
         JOIN customers c ON c.id = i.customer_id
         WHERE i.entity_id = $1 AND i.status IN ('sent', 'viewed', 'partially_paid', 'overdue')
           AND i.amount_due > 0
         ORDER BY days_overdue DESC, c.company_name`,
        [ctx.entityId, asOf]
      );
      const totalDue = result.rows.reduce(
        (s, r) => s.plus(new Decimal((r as { amount_due: string }).amount_due)),
        new Decimal(0)
      );
      return JSON.stringify({
        as_of_date: asOf, currency: ctx.currency,
        total_due: totalDue.toFixed(2), count: result.rows.length, invoices: result.rows,
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
      const result = await query(
        `SELECT v.company_name AS vendor_name, v.vendor_number,
                b.bill_number, b.bill_date, b.due_date, b.total_amount, b.amount_due,
                ($2::date - b.due_date) AS days_overdue
         FROM bills b
         JOIN vendors v ON v.id = b.vendor_id
         WHERE b.entity_id = $1 AND b.status IN ('approved', 'posted', 'partially_paid')
           AND b.amount_due > 0
         ORDER BY days_overdue DESC, v.company_name`,
        [ctx.entityId, asOf]
      );
      const totalDue = result.rows.reduce(
        (s, r) => s.plus(new Decimal((r as { amount_due: string }).amount_due)),
        new Decimal(0)
      );
      return JSON.stringify({
        as_of_date: asOf, currency: ctx.currency,
        total_due: totalDue.toFixed(2), count: result.rows.length, bills: result.rows,
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
      const conditions = ["a.entity_id = $1", "je.status = 'posted'", 'a.code = $2'];
      const params: unknown[] = [ctx.entityId, input.account_code];
      let idx = 3;
      if (input.start_date) { conditions.push(`je.entry_date >= $${idx++}`); params.push(input.start_date); }
      if (input.end_date) { conditions.push(`je.entry_date <= $${idx++}`); params.push(input.end_date); }

      const result = await query(
        `SELECT je.entry_number, je.entry_date, je.description AS entry_description,
                jel.debit_amount, jel.credit_amount, jel.description AS line_description
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
         JOIN accounts a ON a.id = jel.account_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY je.entry_date, je.entry_number, jel.line_number
         LIMIT 101`,
        params
      );

      if (result.rows.length === 0) {
        return `No posted movements for account ${input.account_code} in that range.`;
      }
      const truncated = result.rows.length > 100;
      const rows = result.rows.slice(0, 100);
      const debits = rows.reduce((s, r) => s.plus((r as { debit_amount: string | null }).debit_amount ?? 0), new Decimal(0));
      const credits = rows.reduce((s, r) => s.plus((r as { credit_amount: string | null }).credit_amount ?? 0), new Decimal(0));

      return JSON.stringify({
        account_code: input.account_code, truncated, count: rows.length,
        period_debits: debits.toFixed(2), period_credits: credits.toFixed(2),
        movements: rows,
      });
    },
  });

  return [trialBalance, balanceSheet, incomeStatement, agedReceivables, agedPayables, generalLedger];
}
