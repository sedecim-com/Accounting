import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { buildTools, MAX_TOOL_RESULT_CHARS } from '../../../src/ai/tools/index.js';
import { query } from '../../../src/database/connection.js';
import type { AgentContext } from '../../../src/ai/context.js';
import type { BetaTool, BetaToolResultContentBlockParam } from '@anthropic-ai/sdk/resources/beta';

/**
 * The concrete shape `betaZodTool` produces: a plain `BetaTool` plus `run`.
 * The builders return a union over many different input schemas and a tool is
 * looked up here by a runtime name string, which TypeScript cannot map back to
 * a single union member — so `run` on the raw union demands the intersection of
 * every tool's schema at once.
 */
type ToolHandle<Input = Record<string, unknown>> = BetaTool & {
  run: (input: Input) => Promise<string | BetaToolResultContentBlockParam[]>;
};

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

const CTX: AgentContext = {
  entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  entityName: 'Acme MX',
  tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'AME010101AAA',
};

function getTool(name: string): ToolHandle {
  const tool = buildTools(CTX, { model: 'claude-opus-5' }).find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool as ToolHandle;
}

describe('buildTools', () => {
  it('exposes 24 uniquely named runnable tools', () => {
    const tools = buildTools(CTX, { model: 'claude-opus-5' });
    expect(tools).toHaveLength(24);
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) expect(typeof t.run).toBe('function');
    expect(names).toEqual(
      expect.arrayContaining([
        'search_accounts', 'search_customers', 'search_vendors',
        'search_journal_entries', 'get_journal_entry',
        'get_trial_balance', 'get_balance_sheet', 'get_income_statement',
        'get_aged_receivables', 'get_aged_payables', 'get_general_ledger',
        'draft_journal_entry', 'list_drafts',
        'ask_user', 'search_precedents', 'read_docs',
        'external_pull', 'get_entity_status', 'external_diff_trial_balance', 'external_push', 'list_external_ops',
        'skills_list', 'skill_view', 'session_search',
      ])
    );
  });

  it('notifies the observer with tool name and input', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const seen: Array<[string, unknown]> = [];
    const tool = buildTools(CTX, {
      model: 'claude-opus-5',
      observe: (name, input) => seen.push([name, input]),
    }).find((t) => t.name === 'search_accounts')! as ToolHandle;
    await tool.run({ search: 'banco' });
    expect(seen).toEqual([['search_accounts', { search: 'banco' }]]);
  });
});

describe('tool-result size cap', () => {
  beforeEach(() => mockQuery.mockReset());

  it('truncates string results over the cap with an actionable marker', async () => {
    // 50 rows with 1000-char names → JSON well past 32000 chars
    const rows = Array.from({ length: 50 }, (_, i) => ({
      code: String(1000 + i), name: 'x'.repeat(1000), account_type: 'asset',
      account_subtype: null, normal_balance: 'debit', allow_manual_entries: true, fs_category: null,
    }));
    mockQuery.mockResolvedValueOnce({ rows });
    const out = (await getTool('search_accounts').run({})) as string;
    const marker =
      `\n[... result truncated at ${MAX_TOOL_RESULT_CHARS} chars — ` +
      `refine your query (filters, date ranges, pagination) to see the rest]`;
    expect(out.endsWith(marker)).toBe(true);
    expect(out.length).toBe(MAX_TOOL_RESULT_CHARS + marker.length);
  });

  it('leaves short results untouched', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ code: '1101', name: 'Bancos', account_type: 'asset', account_subtype: null, normal_balance: 'debit', allow_manual_entries: true, fs_category: null }],
    });
    const out = (await getTool('search_accounts').run({})) as string;
    expect(out).not.toContain('truncated at');
    expect(JSON.parse(out).accounts[0].code).toBe('1101');
  });
});

describe('search_accounts', () => {
  beforeEach(() => mockQuery.mockReset());

  it('scopes by entity and applies search + type filters', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ code: '1101', name: 'Bancos', account_type: 'asset', account_subtype: null, normal_balance: 'debit', allow_manual_entries: true, fs_category: 'current_assets' }],
    });
    const out = await getTool('search_accounts').run({ search: 'banco', account_type: 'asset' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/entity_id = \$1/);
    expect(sql).toMatch(/code ILIKE \$2 OR name ILIKE \$2/);
    expect(sql).toMatch(/account_type = \$3/);
    expect(params).toEqual([CTX.entityId, '%banco%', 'asset']);
    const parsed = JSON.parse(out as string);
    expect(parsed.count).toBe(1);
    expect(parsed.accounts[0].code).toBe('1101');
  });

  it('returns a friendly message when empty', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const out = await getTool('search_accounts').run({});
    expect(out).toMatch(/No results/);
  });

  it('flags truncation past 50 rows', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({
      code: String(1000 + i), name: `Cuenta ${i}`, account_type: 'asset',
      account_subtype: null, normal_balance: 'debit', allow_manual_entries: true, fs_category: null,
    }));
    mockQuery.mockResolvedValueOnce({ rows });
    const parsed = JSON.parse((await getTool('search_accounts').run({})) as string);
    expect(parsed.truncated).toBe(true);
    expect(parsed.count).toBe(50);
  });
});

describe('search_journal_entries', () => {
  beforeEach(() => mockQuery.mockReset());

  it('combines text, date and account filters with correct params', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTool('search_journal_entries').run({
      search: 'renta', date_from: '2026-01-01', date_to: '2026-06-30', account_code: '5201',
    });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/je\.description ILIKE \$2 OR je\.reference ILIKE \$2/);
    expect(sql).toMatch(/je\.entry_date >= \$3/);
    expect(sql).toMatch(/je\.entry_date <= \$4/);
    expect(sql).toMatch(/a\.code = \$5/);
    expect(params).toEqual([CTX.entityId, '%renta%', '2026-01-01', '2026-06-30', '5201']);
  });
});

describe('get_journal_entry', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns header with lines and omits the internal id', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ id: 'je-id', entry_number: 'JE-2026-00042', entry_date: '2026-05-01', entry_type: 'standard', status: 'posted', description: 'Renta mayo', reference: null, total_debits: '10000.0000', total_credits: '10000.0000', source_type: null, posted_date: null }],
      })
      .mockResolvedValueOnce({
        rows: [
          { line_number: 1, account_code: '5201', account_name: 'Renta de oficinas', debit_amount: '10000.0000', credit_amount: null, description: null },
          { line_number: 2, account_code: '1101', account_name: 'Bancos', debit_amount: null, credit_amount: '10000.0000', description: null },
        ],
      });
    const parsed = JSON.parse((await getTool('get_journal_entry').run({ entry_number: 'JE-2026-00042' })) as string);
    expect(parsed.id).toBeUndefined();
    expect(parsed.entry_number).toBe('JE-2026-00042');
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0].account_code).toBe('5201');
  });

  it('reports a missing entry', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const out = await getTool('get_journal_entry').run({ entry_number: 'JE-XXX' });
    expect(out).toMatch(/does not exist/);
  });
});

describe('get_trial_balance', () => {
  beforeEach(() => mockQuery.mockReset());

  it('computes totals and balance flag', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { account_code: '1101', account_name: 'Bancos', account_type: 'asset', debit_total: '1500.00', credit_total: '500.00', ending_balance: '1000.00' },
        { account_code: '4101', account_name: 'Ventas', account_type: 'revenue', debit_total: '0.00', credit_total: '1000.00', ending_balance: '-1000.00' },
      ],
    });
    const parsed = JSON.parse((await getTool('get_trial_balance').run({})) as string);
    expect(parsed.totals.total_debits).toBe('1500.00');
    expect(parsed.totals.total_credits).toBe('1500.00');
    expect(parsed.totals.is_balanced).toBe(true);
    expect(parsed.currency).toBe('MXN');
  });

  it('filters zero-balance accounts when asked', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { account_code: '1101', account_name: 'Bancos', account_type: 'asset', debit_total: '100.00', credit_total: '100.00', ending_balance: '0.00' },
        { account_code: '1102', account_name: 'Caja', account_type: 'asset', debit_total: '50.00', credit_total: '0.00', ending_balance: '50.00' },
      ],
    });
    const parsed = JSON.parse((await getTool('get_trial_balance').run({ only_with_balance: true })) as string);
    expect(parsed.accounts).toHaveLength(1);
    expect(parsed.accounts[0].account_code).toBe('1102');
  });

  it('passes as_of_date as a query param', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTool('get_trial_balance').run({ as_of_date: '2026-06-30' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/je\.entry_date <= \$2/);
    expect(params).toEqual([CTX.entityId, '2026-06-30']);
  });
});

describe('get_balance_sheet', () => {
  beforeEach(() => mockQuery.mockReset());

  it('nets contra accounts against their section instead of adding abs values', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { account_type: 'asset', fs_category: 'non_current_assets', code: '1200', name: 'Equipo', balance: '1000.00' },
        { account_type: 'contra_asset', fs_category: 'non_current_assets', code: '1290', name: 'Dep. acumulada', balance: '-400.00' },
        { account_type: 'liability', fs_category: 'current_liabilities', code: '2101', name: 'Proveedores', balance: '-500.00' },
        { account_type: 'equity', fs_category: 'equity', code: '3101', name: 'Capital', balance: '-100.00' },
      ],
    });
    const parsed = JSON.parse((await getTool('get_balance_sheet').run({ as_of_date: '2026-06-30' })) as string);
    expect(parsed.assets.total).toBe('600.00');
    expect(parsed.liabilities.total).toBe('500.00');
    expect(parsed.equity.total).toBe('100.00');
    expect(parsed.total_liabilities_and_equity).toBe('600.00');
    // contra account shows negative in its section's natural sign
    const contra = parsed.assets.accounts.find((a: { code: string }) => a.code === '1290');
    expect(contra.balance).toBe('-400.00');
  });

  it('pre-filters the join so only posted entries can contribute', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await getTool('get_balance_sheet').run({ as_of_date: '2026-06-30' });
    const [sql] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/LEFT JOIN \(journal_entry_lines jel\s+JOIN journal_entries je/);
    expect(sql).toMatch(/je\.status = 'posted'/);
  });
});

describe('get_income_statement', () => {
  beforeEach(() => mockQuery.mockReset());

  it('reports revenue credit-natural, expenses debit-natural, and net income', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { account_type: 'revenue', code: '4101', name: 'Ventas', debit_total: '200.00', credit_total: '10200.00' },
        { account_type: 'expense', code: '5201', name: 'Renta', debit_total: '4000.00', credit_total: '0.00' },
      ],
    });
    const parsed = JSON.parse(
      (await getTool('get_income_statement').run({ start_date: '2026-01-01', end_date: '2026-06-30' })) as string
    );
    expect(parsed.revenue.total).toBe('10000.00');
    expect(parsed.expenses.total).toBe('4000.00');
    expect(parsed.net_income).toBe('6000.00');
  });
});

describe('get_aged_receivables', () => {
  beforeEach(() => mockQuery.mockReset());

  it('totals amount_due', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { customer_name: 'Cliente A', customer_number: 'C-1', invoice_number: 'F-1', invoice_date: '2026-05-01', due_date: '2026-05-31', total_amount: '1160.00', amount_due: '1160.00', days_overdue: 30 },
        { customer_name: 'Cliente B', customer_number: 'C-2', invoice_number: 'F-2', invoice_date: '2026-06-01', due_date: '2026-07-01', total_amount: '580.00', amount_due: '80.00', days_overdue: -10 },
      ],
    });
    const parsed = JSON.parse((await getTool('get_aged_receivables').run({ as_of_date: '2026-06-21' })) as string);
    expect(parsed.total_due).toBe('1240.00');
    expect(parsed.count).toBe(2);
  });
});

describe('get_general_ledger', () => {
  beforeEach(() => mockQuery.mockReset());

  it('sums period debits/credits and scopes to posted + account code', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { entry_number: 'JE-1', entry_date: '2026-05-01', entry_description: 'x', debit_amount: '100.00', credit_amount: null, line_description: null },
        { entry_number: 'JE-2', entry_date: '2026-05-02', entry_description: 'y', debit_amount: null, credit_amount: '40.00', line_description: null },
      ],
    });
    const parsed = JSON.parse((await getTool('get_general_ledger').run({ account_code: '1101' })) as string);
    expect(parsed.period_debits).toBe('100.00');
    expect(parsed.period_credits).toBe('40.00');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toMatch(/je\.status = 'posted'/);
    expect(params).toEqual([CTX.entityId, '1101']);
  });
});
