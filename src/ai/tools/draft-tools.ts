import { z } from 'zod/v4';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { AgentContext } from '../context.js';
import type { ToolDeps } from './observer.js';
import { createDraft, listDrafts, DraftValidationError } from '../draft-service.js';

// ============================================================
// DRAFT TOOLS (write — but only to ai_drafts)
// The AI proposes journal entries as drafts; the real ledger is
// only touched when a human approves with `mnemosine review`.
// ============================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function buildDraftTools(ctx: AgentContext, deps: ToolDeps) {
  const { model, observe, userRequestRef } = deps;
  const draftJournalEntry = betaZodTool({
    name: 'draft_journal_entry',
    description:
      'Creates a DRAFT journal entry for human review. It does NOT post to the ledger: ' +
      'the user must approve it with `mnemosine review`. Before calling this tool: ' +
      '(1) verify the accounts with search_accounts, (2) check precedents with search_journal_entries. ' +
      'Debits must balance with credits. Report confidence honestly: use <0.8 if ' +
      'you had to guess the account or the accounting treatment.',
    inputSchema: z.object({
      entry_date: z.string().regex(DATE_RE).describe('Journal entry date YYYY-MM-DD'),
      description: z.string().min(1).max(500).describe('Journal entry description'),
      reference: z.string().max(255).optional().describe('External reference (invoice, contract…)'),
      confidence: z.number().min(0).max(1).describe('Your confidence that the entry is correct (0-1)'),
      reasoning: z
        .string()
        .min(1)
        .describe('Why you chose these accounts and amounts; cite precedents if you used any'),
      lines: z
        .array(
          z.object({
            account_code: z.string().min(1).describe('Account code from the chart of accounts'),
            debit: z.number().positive().optional().describe('Debit amount (exclusive with credit)'),
            credit: z.number().positive().optional().describe('Credit amount (exclusive with debit)'),
            description: z.string().max(500).optional().describe('Line description'),
          })
        )
        .min(2)
        .describe('Journal entry lines; debits and credits must balance'),
    }),
    run: async (input) => {
      observe?.('draft_journal_entry', input);
      try {
        const result = await createDraft(ctx, {
          payload: {
            entry_date: input.entry_date,
            description: input.description,
            reference: input.reference,
            lines: input.lines,
          },
          confidence: input.confidence,
          reasoning: input.reasoning,
          model,
          userRequest: userRequestRef?.current,
        });
        deps.onDraftCreated?.({
          draftId: result.id,
          confidence: input.confidence,
          totalDebits: result.totalDebits,
          totalCredits: result.totalCredits,
        });
        return JSON.stringify({
          draft_id: result.id,
          status: 'pending_review',
          total_debits: result.totalDebits,
          total_credits: result.totalCredits,
          message:
            'Draft created. It is NOT posted: the user must approve it with `mnemosine review`. ' +
            'Communicate the draft id and summarize the proposed entry.',
        });
      } catch (err) {
        if (err instanceof DraftValidationError) {
          return `The draft was REJECTED by validation. Fix and retry:\n- ${err.errors.join('\n- ')}`;
        }
        throw err;
      }
    },
  });

  const listDraftsTool = betaZodTool({
    name: 'list_drafts',
    description:
      'Lists the journal entry drafts created by the AI in this entity, with their status ' +
      '(pending_review, approved, rejected). Useful to resume previous work or check ' +
      'whether a draft was already approved or rejected (and why, in review_notes).',
    inputSchema: z.object({
      status: z.enum(['pending_review', 'approved', 'rejected']).optional(),
    }),
    run: async (input) => {
      observe?.('list_drafts', input);
      const rows = await listDrafts(ctx, input.status, { limit: 50, newestFirst: true });
      if (rows.length === 0) return 'No drafts' + (input.status ? ` with status ${input.status}` : '') + '.';
      return JSON.stringify({
        count: rows.length,
        note: rows.length === 50 ? 'Showing the 50 most recent' : undefined,
        drafts: rows.map((d) => ({
          id: d.id,
          status: d.status,
          created_at: d.created_at,
          entry_date: d.payload.entry_date,
          description: d.payload.description,
          lines: d.payload.lines.length,
          confidence: d.ai_confidence,
          journal_entry_id: d.journal_entry_id,
          review_notes: d.review_notes,
        })),
      });
    },
  });

  return [draftJournalEntry, listDraftsTool];
}
