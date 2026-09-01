import { z } from 'zod/v4';
import { envolverDatosDeTerceros } from '../untrusted.js';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { AgentContext } from '../context.js';
import type { ToolDeps } from './observer.js';
import { getExternalAdapter, listExternalSystems } from '../../services/integrations/accounting/registry.js';
import { diffTrialBalance, queueExternalOp, listExternalOps } from '../external-service.js';

// ============================================================
// EXTERNAL ACCOUNTING TOOLS
// Reads from external accounting systems = direct.
// Writes = ALWAYS to the outbox (ai_external_ops); a human
// executes them with `mnemosine outbox`.
// ============================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateInput = (desc: string) => z.string().regex(DATE_RE).describe(desc);

export function buildExternalTools(ctx: AgentContext, deps: ToolDeps) {
  const externalPull = betaZodTool({
    name: 'external_pull',
    description:
      'Reads data from a connected external accounting system (e.g. contalink): trial balance, ' +
      'an account balance, or a listing of fiscal documents (CFDIs) recorded there. ' +
      'Direct read, modifies nothing. Read the "external-integrations" doc first.',
    inputSchema: z.object({
      provider: z.string().min(1).describe('External system, e.g. "contalink"'),
      resource: z.enum(['trial_balance', 'account_balance', 'documents']),
      start_date: dateInput('Start (trial_balance/documents)').optional(),
      end_date: dateInput('End (trial_balance/documents)').optional(),
      date: dateInput('Cutoff (account_balance)').optional(),
      account_code: z.string().optional().describe('Remote account (account_balance)'),
      rfc: z.string().optional().describe("The company's RFC (documents)"),
      transaction_type: z.enum(['E', 'R']).optional().describe('Issued (E) or Received (R) (documents)'),
      document_type: z.enum(['Nomina', 'Ingreso', 'Egreso', 'Pago']).optional(),
      page: z.number().int().min(0).optional().describe('Page (documents, default 0)'),
    }),
    run: async (input) => {
      deps.observe?.('external_pull', input);
      const adapter = getExternalAdapter(input.provider);

      if (input.resource === 'trial_balance') {
        if (!input.start_date || !input.end_date) return 'Error: trial_balance requires start_date and end_date';
        const rows = await adapter.getTrialBalance(input.start_date, input.end_date);
        // Size the result to the tool-result cap instead of a fixed row count,
        // so the returned JSON is always complete and parseable (never cut
        // mid-object by the generic truncation marker). The trial_balance
        // resource has NO pagination or account filters, so when rows are
        // omitted the guidance points to the tools that DO cover the rest.
        // A3: el presupuesto descuenta la envoltura UNTRUSTED — si no, un
        // resultado al ras del tope quedaría truncado a media envoltura.
        const MAX_TRIAL_BALANCE_CHARS = 30_000 - envolverDatosDeTerceros('').length;
        const kept: typeof rows = [];
        let serializedLength = 0;
        for (const row of rows) {
          const rowLength = JSON.stringify(row).length + 1; // +1 for the separator
          if (serializedLength + rowLength > MAX_TRIAL_BALANCE_CHARS) break;
          kept.push(row);
          serializedLength += rowLength;
        }
        const omitted = rows.length - kept.length;
        return envolverDatosDeTerceros({
          provider: input.provider,
          count: rows.length,
          shown: kept.length,
          omitted,
          note:
            omitted > 0
              ? 'Trial balance truncated to fit the tool-result limit; this resource has no pagination. ' +
                'Use external_diff_trial_balance for a full account-by-account comparison, or ' +
                'external_pull account_balance for a specific account.'
              : undefined,
          trial_balance: kept,
        });
      }
      if (input.resource === 'account_balance') {
        if (!input.account_code || !input.date) return 'Error: account_balance requires account_code and date';
        const balance = await adapter.getAccountBalance(input.account_code, input.date);
        return JSON.stringify({ provider: input.provider, account_code: input.account_code, date: input.date, balance });
      }
      if (!input.rfc || !input.transaction_type || !input.document_type || !input.start_date || !input.end_date) {
        return 'Error: documents requires rfc, transaction_type (E/R), document_type, start_date and end_date';
      }
      const list = await adapter.listFiscalDocuments({
        rfc: input.rfc, transaction_type: input.transaction_type, document_type: input.document_type,
        start_date: input.start_date, end_date: input.end_date, page: input.page,
      });
      return envolverDatosDeTerceros({ provider: input.provider, page: input.page ?? 0, documents: list });
    },
  });

  const externalDiff = betaZodTool({
    name: 'external_diff_trial_balance',
    description:
      "Compares (in code, deterministic) an external system's trial balance against the LOCAL trial balance " +
      'account by account at the cutoff: balance differences, local-only and remote-only accounts. ' +
      'It is THE tool for migrations and parallel operation with contalink. You interpret ' +
      'the result and propose the adjustments (as drafts) or explain the causes.',
    inputSchema: z.object({
      provider: z.string().min(1),
      start_date: dateInput('Start of the remote period'),
      end_date: dateInput('Comparison cutoff (ending balances at this date)'),
    }),
    run: async (input) => {
      deps.observe?.('external_diff_trial_balance', input);
      const diff = await diffTrialBalance(ctx, input.provider, input.start_date, input.end_date);
      return envolverDatosDeTerceros(diff);
    },
  });

  const externalPush = betaZodTool({
    name: 'external_push',
    description:
      'QUEUES a write to the external accounting system (create/edit a journal entry there, upload XML, ' +
      'bank transaction, reconcile invoice). It is NOT executed: it stays pending in the outbox and a ' +
      'human executes it with `mnemosine outbox`. Structure the payload EXACTLY as the ' +
      '"external-integrations" doc requires for the provider. Never say it was already applied in the external system.',
    inputSchema: z.object({
      provider: z.string().min(1),
      operation: z.enum(['create_policy', 'update_policy', 'upload_xml', 'bank_transaction', 'reconcile_invoice']),
      payload: z.record(z.string(), z.unknown()).describe("Operation body per the provider's contract"),
      reasoning: z.string().min(1).describe('Why this operation; what the human validates before executing'),
    }),
    run: async (input) => {
      deps.observe?.('external_push', input);
      const id = await queueExternalOp(ctx, {
        provider: input.provider,
        operation: input.operation,
        payload: input.payload,
        reasoning: input.reasoning,
        model: deps.model,
        userRequest: deps.userRequestRef?.current,
      });
      return JSON.stringify({
        queued: true,
        op_id: id,
        status: 'pending',
        note: 'Operation QUEUED, not executed. The human reviews and executes it with `mnemosine outbox`.',
      });
    },
  });

  const externalOps = betaZodTool({
    name: 'list_external_ops',
    description:
      'Lists the outbox operations toward external systems and their status (pending, executed, ' +
      'failed with its error, rejected). Use it to resume work or check whether the human already executed ' +
      'something you queued. Available systems: ' + listExternalSystems().join(', ') + '.',
    inputSchema: z.object({
      status: z.enum(['pending', 'executing', 'executed', 'failed', 'rejected']).optional(),
    }),
    run: async (input) => {
      deps.observe?.('list_external_ops', input);
      const rows = await listExternalOps(ctx, input.status);
      if (rows.length === 0) return 'No external operations' + (input.status ? ` with status ${input.status}` : '') + '.';
      return envolverDatosDeTerceros({
        count: rows.length,
        ops: rows.map((o) => ({
          id: o.id, provider: o.provider, operation: o.operation, status: o.status,
          reasoning: o.ai_reasoning, error: o.error, created_at: o.created_at,
        })),
      });
    },
  });

  return [externalPull, externalDiff, externalPush, externalOps];
}
