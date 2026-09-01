import { z } from 'zod/v4';
import { envolverDatosDeTerceros } from '../untrusted.js';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { query } from '../../database/connection.js';
import type { AgentContext } from '../context.js';
import type { ToolObserver } from './observer.js';

// ============================================================
// SEARCH TOOLS (read-only)
// Master-data lookups: chart of accounts, customers, vendors.
// Every query is scoped to the session's entity_id.
// ============================================================

const MAX_ROWS = 50;

export function buildSearchTools(ctx: AgentContext, observe?: ToolObserver) {
  const searchAccounts = betaZodTool({
    name: 'search_accounts',
    description:
      "Searches the entity's chart of accounts by code, name, or type. " +
      'Returns code, name, type, normal balance (debit/credit), and whether it accepts manual journal entries. ' +
      'Use it to find the correct account before analyzing movements.',
    inputSchema: z.object({
      search: z.string().optional().describe('Text to search in code or name (ILIKE)'),
      account_type: z
        .enum(['asset', 'liability', 'equity', 'revenue', 'expense', 'contra_asset', 'contra_liability', 'contra_equity'])
        .optional()
        .describe('Filter by account type'),
      only_postable: z.boolean().optional().describe('true = only accounts that accept manual journal entries'),
    }),
    run: async (input) => {
      observe?.('search_accounts', input);
      const conditions = ['entity_id = $1', 'is_active = true'];
      const params: unknown[] = [ctx.entityId];
      let idx = 2;

      if (input.search) {
        conditions.push(`(code ILIKE $${idx} OR name ILIKE $${idx})`);
        params.push(`%${input.search}%`);
        idx++;
      }
      if (input.account_type) {
        conditions.push(`account_type = $${idx++}`);
        params.push(input.account_type);
      }
      if (input.only_postable) {
        conditions.push('allow_manual_entries = true');
        conditions.push('is_header IS NOT TRUE');
      }

      const result = await query<{
        code: string; name: string; account_type: string; account_subtype: string | null;
        normal_balance: string; allow_manual_entries: boolean; fs_category: string | null;
      }>(
        `SELECT code, name, account_type, account_subtype, normal_balance, allow_manual_entries, fs_category
         FROM accounts WHERE ${conditions.join(' AND ')}
         ORDER BY code LIMIT ${MAX_ROWS + 1}`,
        params
      );

      const truncated = result.rows.length > MAX_ROWS;
      const rows = result.rows.slice(0, MAX_ROWS);
      if (rows.length === 0) return 'No results. Try another term or remove filters.';
      return JSON.stringify({ truncated, count: rows.length, accounts: rows });
    },
  });

  const searchCustomers = betaZodTool({
    name: 'search_customers',
    description:
      "Searches the entity's customers by name, customer number, or RFC/tax id. " +
      'Returns contact details, payment terms, and credit limit.',
    inputSchema: z.object({
      search: z.string().optional().describe('Text to search in name, number, or tax id'),
      only_active: z.boolean().optional().describe('true (default) = only active customers'),
    }),
    run: async (input) => {
      observe?.('search_customers', input);
      const conditions = ['entity_id = $1'];
      const params: unknown[] = [ctx.entityId];
      let idx = 2;

      if (input.only_active !== false) conditions.push('is_active = true');
      if (input.search) {
        conditions.push(
          `(company_name ILIKE $${idx} OR first_name ILIKE $${idx} OR last_name ILIKE $${idx} OR customer_number ILIKE $${idx} OR tax_id ILIKE $${idx})`
        );
        params.push(`%${input.search}%`);
        idx++;
      }

      const result = await query(
        `SELECT customer_number, company_name, first_name, last_name, tax_id, email,
                payment_terms, credit_limit, currency_code, is_active
         FROM customers WHERE ${conditions.join(' AND ')}
         ORDER BY COALESCE(company_name, first_name) LIMIT ${MAX_ROWS + 1}`,
        params
      );

      const truncated = result.rows.length > MAX_ROWS;
      const rows = result.rows.slice(0, MAX_ROWS);
      if (rows.length === 0) return 'No results.';
      return envolverDatosDeTerceros({ truncated, count: rows.length, customers: rows });
    },
  });

  const searchVendors = betaZodTool({
    name: 'search_vendors',
    description:
      "Searches the entity's vendors by name, vendor number, or RFC/tax id. " +
      'Returns contact details, payment terms, and whether it is a 1099 vendor (USA).',
    inputSchema: z.object({
      search: z.string().optional().describe('Text to search in name, number, or tax id'),
      only_active: z.boolean().optional().describe('true (default) = only active vendors'),
    }),
    run: async (input) => {
      observe?.('search_vendors', input);
      const conditions = ['entity_id = $1'];
      const params: unknown[] = [ctx.entityId];
      let idx = 2;

      if (input.only_active !== false) conditions.push('is_active = true');
      if (input.search) {
        conditions.push(
          `(company_name ILIKE $${idx} OR vendor_number ILIKE $${idx} OR tax_id ILIKE $${idx})`
        );
        params.push(`%${input.search}%`);
        idx++;
      }

      const result = await query(
        `SELECT vendor_number, company_name, contact_name, tax_id, email,
                payment_terms, is_1099_vendor, currency_code, is_active
         FROM vendors WHERE ${conditions.join(' AND ')}
         ORDER BY company_name LIMIT ${MAX_ROWS + 1}`,
        params
      );

      const truncated = result.rows.length > MAX_ROWS;
      const rows = result.rows.slice(0, MAX_ROWS);
      if (rows.length === 0) return 'No results.';
      return envolverDatosDeTerceros({ truncated, count: rows.length, vendors: rows });
    },
  });

  return [searchAccounts, searchCustomers, searchVendors];
}
