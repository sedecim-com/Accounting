import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { Command } from 'commander';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTenant: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

vi.mock('../../../src/ai/context.js', () => ({
  bootstrapTenant: vi.fn(),
  resolveEntity: vi.fn(async () => ({
    entityId: 'entity-1', entityName: 'Acme', tenantId: 'tenant-a',
    currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA',
  })),
}));

vi.mock('../../../src/ai/webhooks/intake.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/ai/webhooks/intake.js')>();
  return {
    ...actual,
    issueWebhookToken: vi.fn(),
    listWebhookTokens: vi.fn(),
    disableWebhookToken: vi.fn(),
    listDeliveries: vi.fn(),
  };
});

import { registerWebhooksCommand } from '../../../src/cli/webhooks-command.js';
import {
  issueWebhookToken,
  listWebhookTokens,
  disableWebhookToken,
} from '../../../src/ai/webhooks/intake.js';

const mockIssue = issueWebhookToken as unknown as ReturnType<typeof vi.fn>;
const mockList = listWebhookTokens as unknown as ReturnType<typeof vi.fn>;
const mockDisable = disableWebhookToken as unknown as ReturnType<typeof vi.fn>;

const identity = (s: string) => s;
const palette = { dim: identity, bold: identity, cyan: identity, yellow: identity };

let logs: string[];
let logSpy: MockInstance<Parameters<typeof console.log>, ReturnType<typeof console.log>>;
let shutdownCodes: number[];

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerWebhooksCommand(program, {
    palette,
    // Records the exit code instead of exiting; the action awaits it and ends.
    shutdown: vi.fn(async (code: number) => {
      shutdownCodes.push(code);
      return undefined as never;
    }),
    reportError: (err) => logs.push(`ERROR: ${(err as Error).message}`),
  });
  return program;
}

function run(...args: string[]): Promise<unknown> {
  return makeProgram().parseAsync(['node', 'mnemosine', ...args]);
}

beforeEach(() => {
  logs = [];
  shutdownCodes = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((line?: unknown) => {
    logs.push(String(line ?? ''));
  });
  mockIssue.mockReset();
  mockList.mockReset();
  mockDisable.mockReset();
});

afterEach(() => {
  logSpy.mockRestore();
});

describe('webhooks create', () => {
  it('prints the raw token exactly once, with a save-it warning', async () => {
    mockIssue.mockResolvedValueOnce({
      token: { name: 'bank-bbva', source_kind: 'bank_notification' },
      rawToken: 'raw-token-abc123',
    });
    await run('webhooks', 'create', 'bank-bbva', '--source', 'bank_notification');

    const output = logs.join('\n');
    // Exactly one occurrence: create is the ONLY place the raw token appears.
    expect(output.split('raw-token-abc123').length - 1).toBe(1);
    expect(output).toContain('SAVE THE TOKEN NOW');
    expect(output).toContain('POST /v1/ai/webhooks/bank-bbva');
    expect(shutdownCodes).toEqual([0]);
  });

  it('rejects an invalid --source before touching anything', async () => {
    await run('webhooks', 'create', 'x', '--source', 'carrier-pigeon');
    expect(logs.join('\n')).toContain('ERROR: Invalid --source');
    expect(mockIssue).not.toHaveBeenCalled();
    expect(shutdownCodes).toEqual([1]);
  });
});

describe('webhooks list', () => {
  it('shows names and last use, never token values or hashes', async () => {
    mockList.mockResolvedValueOnce([
      {
        id: 'tok-1', name: 'bank-bbva', source_kind: 'bank_notification', enabled: true,
        created_by: 'ops', created_at: new Date(), last_used_at: new Date('2026-08-20T12:00:00Z'),
      },
    ]);
    await run('webhooks', 'list');
    const output = logs.join('\n');
    expect(output).toContain('bank-bbva');
    expect(output).toContain('2026-08-20');
    expect(output).not.toMatch(/token_hash|[0-9a-f]{64}/);
    expect(shutdownCodes).toEqual([0]);
  });
});

describe('webhooks disable', () => {
  it('exits 0 when the token was disabled', async () => {
    mockDisable.mockResolvedValueOnce(true);
    await run('webhooks', 'disable', 'bank-bbva');
    expect(logs.join('\n')).toContain('disabled');
    expect(shutdownCodes).toEqual([0]);
  });

  it('exits 1 when no enabled token matches', async () => {
    mockDisable.mockResolvedValueOnce(false);
    await run('webhooks', 'disable', 'ghost');
    expect(shutdownCodes).toEqual([1]);
  });
});

describe('bilingual surface', () => {
  it('registers the Spanish alias "ganchos" for the webhooks command', () => {
    const program = makeProgram();
    const webhooks = program.commands.find((c) => c.name() === 'webhooks');
    expect(webhooks).toBeDefined();
    expect(webhooks!.aliases()).toContain('ganchos');
  });
});
