import { z } from 'zod/v4';
import { envolverDatosDeTerceros } from '../untrusted.js';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { query } from '../../database/connection.js';
import type { AgentContext } from '../context.js';
import type { ToolObserver } from './observer.js';

// ============================================================
// LEDGER TOOLS (read-only)
// Journal-entry search ("how was this recorded before?") and
// entry detail with lines. Scoped to the session entity.
// ============================================================

const MAX_ROWS = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function buildLedgerTools(ctx: AgentContext, observe?: ToolObserver) {
  const searchJournalEntries = betaZodTool({
    name: 'search_journal_entries',
    description:
      "Searches the entity's journal entries. Filters by text in description/reference, " +
      'status, type, date range, amount range, or account involved. ' +
      'Use it to find precedents: how similar operations were recorded in the past.',
    inputSchema: z.object({
      search: z.string().optional().describe('Text in description or reference (ILIKE)'),
      status: z.enum(['draft', 'pending_approval', 'approved', 'posted', 'void']).optional(),
      entry_type: z.string().optional().describe('standard, adjusting, auto_invoice, auto_payment, etc.'),
      date_from: z.string().regex(DATE_RE).optional().describe('YYYY-MM-DD'),
      date_to: z.string().regex(DATE_RE).optional().describe('YYYY-MM-DD'),
      min_amount: z.number().optional().describe('Minimum amount (total debits)'),
      max_amount: z.number().optional().describe('Maximum amount (total debits)'),
      account_code: z.string().optional().describe('Only journal entries touching this account'),
    }),
    run: async (input) => {
      observe?.('search_journal_entries', input);
      const conditions = ['je.entity_id = $1'];
      const params: unknown[] = [ctx.entityId];
      let idx = 2;

      if (input.search) {
        conditions.push(`(je.description ILIKE $${idx} OR je.reference ILIKE $${idx})`);
        params.push(`%${input.search}%`);
        idx++;
      }
      if (input.status) { conditions.push(`je.status = $${idx++}`); params.push(input.status); }
      if (input.entry_type) { conditions.push(`je.entry_type = $${idx++}`); params.push(input.entry_type); }
      if (input.date_from) { conditions.push(`je.entry_date >= $${idx++}`); params.push(input.date_from); }
      if (input.date_to) { conditions.push(`je.entry_date <= $${idx++}`); params.push(input.date_to); }
      if (input.min_amount !== undefined) { conditions.push(`je.total_debits >= $${idx++}`); params.push(input.min_amount); }
      if (input.max_amount !== undefined) { conditions.push(`je.total_debits <= $${idx++}`); params.push(input.max_amount); }
      if (input.account_code) {
        conditions.push(
          `EXISTS (SELECT 1 FROM journal_entry_lines jel
                   JOIN accounts a ON a.id = jel.account_id
                   WHERE jel.journal_entry_id = je.id AND a.code = $${idx++})`
        );
        params.push(input.account_code);
      }

      const result = await query(
        `SELECT je.entry_number, je.entry_date, je.entry_type, je.status,
                je.description, je.reference, je.total_debits, je.total_credits, je.source_type
         FROM journal_entries je
         WHERE ${conditions.join(' AND ')}
         ORDER BY je.entry_date DESC, je.entry_number DESC
         LIMIT ${MAX_ROWS + 1}`,
        params
      );

      const truncated = result.rows.length > MAX_ROWS;
      const rows = result.rows.slice(0, MAX_ROWS);
      if (rows.length === 0) return 'No journal entries match those filters.';
      return envolverDatosDeTerceros({ truncated, count: rows.length, entries: rows });
    },
  });

  const getJournalEntry = betaZodTool({
    name: 'get_journal_entry',
    description:
      'Gets the full detail of a journal entry by its number (entry_number), including its lines ' +
      'with account, debit, and credit. Use it after search_journal_entries to see the exact entry.',
    inputSchema: z.object({
      entry_number: z.string().describe('Journal entry number, e.g. JE-2026-00042'),
    }),
    run: async (input) => {
      observe?.('get_journal_entry', input);
      const header = await query(
        `SELECT id, entry_number, entry_date, entry_type, status, description, reference,
                total_debits, total_credits, source_type, posted_date
         FROM journal_entries
         WHERE entity_id = $1 AND entry_number = $2`,
        [ctx.entityId, input.entry_number]
      );
      if (header.rows.length === 0) {
        return `Journal entry ${input.entry_number} does not exist in this entity.`;
      }
      const entry = header.rows[0];

      const lines = await query(
        `SELECT jel.line_number, a.code AS account_code, a.name AS account_name,
                jel.debit_amount, jel.credit_amount, jel.description
         FROM journal_entry_lines jel
         JOIN accounts a ON a.id = jel.account_id
         WHERE jel.journal_entry_id = $1
         ORDER BY jel.line_number`,
        [entry.id]
      );

      const { id: _id, ...entryWithoutId } = entry;
      return envolverDatosDeTerceros({ ...entryWithoutId, lines: lines.rows });
    },
  });

  return [searchJournalEntries, getJournalEntry];
}
