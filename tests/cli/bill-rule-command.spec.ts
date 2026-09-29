import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerBillCommand } from '../../src/cli/bill-command.js';
import { summarizeRule } from '../../src/cli/bill-rule-command.js';

// ING-2 · #319 (MNE-001-032): `bill rule create|list` from the terminal.

let accountRow: Record<string, unknown> = { id: 'A6100', code: '6100', is_header: false, is_active: true };
vi.mock('../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
  resolveEntity: () => Promise.resolve({ tenantId: 'T1', entityId: 'E1', entityName: 'Acme SA' }),
  listEntities: () => Promise.resolve([{ id: 'E1', name: 'Acme SA' }]),
}));
vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: () => Promise.resolve({ userId: 'U1', email: 'a@b.c' }),
}));
vi.mock('../../src/services/accounting/account-service.js', () => ({
  resolveAccount: () => Promise.resolve(accountRow),
}));
const createSpy = vi.fn();
const listSpy = vi.fn();
vi.mock('../../src/services/xml-ingestion/processing-rules.js', async () => {
  const real = await vi.importActual<typeof import('../../src/services/xml-ingestion/processing-rules.js')>(
    '../../src/services/xml-ingestion/processing-rules.js'
  );
  return {
    ...real,
    createProcessingRule: (...a: unknown[]) => createSpy(...a) as unknown,
    listProcessingRules: (...a: unknown[]) => listSpy(...a) as unknown,
  };
});

let exitCode: number | undefined;
let errs: unknown[] = [];
let out = '';
const id = (s: string) => s;

async function run(argv: string[]) {
  errs = [];
  exitCode = undefined;
  out = '';
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((c: string) => { out += c; return true; }) as typeof process.stdout.write;
  try {
    const program = new Command('mnemosine').exitOverride();
    registerBillCommand(program, {
      palette: { dim: id, bold: id, cyan: id, red: id, green: id, yellow: id },
      shutdown: (c: number) => { exitCode = c; },
      reportError: (e: unknown) => { errs.push(e); },
    } as never);
    await program.parseAsync(['node', 'mnemosine', 'bill', 'rule', ...argv, '--entity', 'E1']);
  } finally {
    process.stdout.write = write;
  }
}

const WHEN = ['--when', 'emisor_rfc equals SIN060101AB1'];

beforeEach(() => {
  process.env.MNEMOSINE_ENTITY = 'E1';
  createSpy.mockReset().mockResolvedValue({ id: 'R1', rule_name: 'R', priority: 100 });
  listSpy.mockReset();
  accountRow = { id: 'A6100', code: '6100', is_header: false, is_active: true };
});

describe('bill rule create', () => {
  it('writes the rule with the account resolved to its id', async () => {
    await run(['create', '--name', 'R', ...WHEN, '--then', 'set_account=6100', '--then', 'set_processing_mode=auto']);
    expect(exitCode, String(errs[0])).toBe(0);
    expect(createSpy).toHaveBeenCalledWith('E1', 'U1', {
      rule_name: 'R', rule_type: 'account_mapping', priority: 100,
      conditions: { all: [{ field: 'emisor_rfc', operator: 'equals', value: 'SIN060101AB1' }] },
      actions: { set_account: 'A6100', set_processing_mode: 'auto' },
    });
  });

  it('--dry-run validates and shows it, writing nothing', async () => {
    await run(['create', '--name', 'R', ...WHEN, '--then', 'add_tag=x', '--dry-run']);
    expect(exitCode).toBe(0);
    expect(out).toContain('"add_tag": "x"');
    expect(createSpy).not.toHaveBeenCalled();
  });

  it.each([
    [['--name', 'R', '--then', 'add_tag=x']],
    [['--name', 'R', ...WHEN]],
    [['--name', 'R', ...WHEN, '--then', 'add_tag=x', '--priority', 'high']],
  ])('usage error, nothing written: %j', async (argv) => {
    await run(['create', ...argv]);
    expect(exitCode).toBe(2);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('refuses a header account', async () => {
    accountRow = { ...accountRow, is_header: true };
    await run(['create', '--name', 'R', ...WHEN, '--then', 'set_account=6000']);
    expect(exitCode).not.toBe(0);
    expect(String(errs[0])).toMatch(/not postable/);
    expect(createSpy).not.toHaveBeenCalled();
  });
});

describe('bill rule list', () => {
  it('lists the entity rules, filtered by a known type', async () => {
    listSpy.mockResolvedValue({ rows: [], total: 0 });
    await run(['list', '--type', 'rejection', '--status', 'inactive', '--json']);
    expect(exitCode, String(errs[0])).toBe(0);
    expect(listSpy).toHaveBeenCalledWith('E1', { ruleType: 'rejection', active: false, limit: 50, offset: undefined });
    await run(['list', '--all']);
    expect(listSpy).toHaveBeenLastCalledWith('E1', { ruleType: undefined, active: undefined, limit: undefined, offset: undefined });
    await run(['list', '--type', 'nope']);
    expect(exitCode).toBe(2);
    await run(['list', '--status', 'paused']);
    expect(exitCode).toBe(2);
  });

  it('summarizes a rule as it was written, with the account by its code', () => {
    expect(summarizeRule({
      id: 'R1', priority: 10, rule_name: 'R', rule_type: 'account_mapping', is_active: true,
      conditions: {
        all: [{ field: 'total_amount', operator: 'greater_than', value: 5 }],
        any: [{ field: 'currency_code', operator: 'in', value: ['MXN', 'USD'] }, { field: 'vendor_id', operator: 'is_null', value: null }],
      },
      actions: { set_account: 'A6100', require_approval: true },
      set_account_code: '6100', times_matched: 2, last_matched_at: '2026-09-28',
    })).toEqual({
      priority: 10, name: 'R', type: 'account_mapping', active: true, matched: 2, last_matched: '2026-09-28', id: 'R1',
      when: 'total_amount greater_than 5 and any: currency_code in MXN,USD and any: vendor_id is_null',
      then: 'set_account=6100 require_approval=true',
    });
    expect(summarizeRule({ id: 'R2' })).toMatchObject({ when: '', then: '', matched: 0, last_matched: '' });
  });
});
