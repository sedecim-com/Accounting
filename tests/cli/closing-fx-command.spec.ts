import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { registerClosingFx } from '../../src/cli/closing-fx-command.js';
import { getLanguage, setLanguage } from '../../src/i18n/index.js';
import { ExitCode, type ExitCodeValue } from '../../src/cli/kernel/index.js';
import type { RevaluationRun } from '../../src/services/accounting/fx-revaluation.js';

// ============================================================
// MNE-001-083 · `closing fx revalue`, the action path, against a stubbed
// engine: what it prints, what it asks, and what it hands to the post.
// ============================================================

const m = vi.hoisted(() => ({ revalue: vi.fn() }));

vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: vi.fn(async () => ({ userId: 'u1' })),
}));
vi.mock('../../src/cli/kernel/entity-context.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  requireExplicitEntity: vi.fn(async () => ({ tenantId: 't1', entityId: 'e1' })),
}));
vi.mock('../../src/services/accounting/fiscal-calendar-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolvePeriod: vi.fn(async () => ({ id: 'fp-08', period_name: 'August' })),
}));
vi.mock('../../src/services/accounting/fx-revaluation.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  revalueForeignBalances: m.revalue,
}));

const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

function plan(over: Partial<RevaluationRun> = {}): RevaluationRun {
  return {
    periodId: 'fp-08', periodName: 'August', closingDate: '2026-08-31', reversalDate: '2026-09-01',
    rates: [{ currency: 'USD', tasa: '18.2000000000', fuente: 'dof', fecha: '2026-08-31' }],
    lines: [{
      accountId: 'a1', accountCode: '1150', currency: 'USD', foreignBalance: '1000.0000',
      bookBalance: '17500.0000', rate: '18.2000000000', revaluedBalance: '18200.0000',
      alreadyPosted: '0.0000', difference: '700.0000',
    }],
    gain: '700.0000', loss: '0.0000', alreadyRun: null, sequence: 1, entry: null, reversal: null,
    ...over,
  };
}

let out = '';
let err = '';
let language: ReturnType<typeof getLanguage>;

beforeEach(() => {
  out = '';
  err = '';
  m.revalue.mockReset();
  language = getLanguage();
  setLanguage('en');
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => ((out += String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => ((err += String(s)), true));
});
afterEach(() => {
  vi.restoreAllMocks();
  setLanguage(language);
});

async function cli(args: string[], answer = false): Promise<{ code?: ExitCodeValue; error?: unknown; asked: string[] }> {
  const program = new Command().exitOverride();
  const closing = program.command('closing');
  const result: { code?: ExitCodeValue; error?: unknown; asked: string[] } = { asked: [] };
  registerClosingFx(
    closing,
    { palette: plain },
    async (fn) => {
      try {
        result.code = (await fn()) ?? ExitCode.OK;
      } catch (e) {
        result.error = e;
      }
    },
    async (q) => {
      result.asked.push(q);
      return answer;
    }
  );
  await program.parseAsync(['node', 'mnemosine', 'closing', 'fx', 'revalue', ...args]);
  return result;
}

describe('closing fx revalue · the action path', () => {
  it('--dry-run prints the plan as the one document on stdout and never posts', async () => {
    m.revalue.mockResolvedValueOnce(plan());
    const r = await cli(['2026-08', '--dry-run', '--json']);
    expect(r.code).toBe(ExitCode.OK);
    expect(m.revalue).toHaveBeenCalledTimes(1);
    expect(m.revalue.mock.calls[0][3]).toEqual({ dryRun: true });
    expect((JSON.parse(out) as { rows: unknown[] }).rows).toEqual([expect.objectContaining({ account: '1150', difference: '700.0000', already_posted: '0.0000' })]);
    expect(err).toMatch(/August at USD 18\.2000000000 \(dof 2026-08-31\) · gain 700\.0000 · loss 0\.0000/);
    expect(err).toMatch(/Dry run: the ledger was not touched\./);
  });

  it('without -y and no terminal to confirm on, it aborts and posts nothing', async () => {
    m.revalue.mockResolvedValueOnce(plan());
    const r = await cli(['2026-08']);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toMatch(/Post the revaluation of August \(gain 700\.0000, loss 0\.0000\)/);
    expect(r.error).toMatchObject({ exitCode: ExitCode.ABORTED });
    expect(m.revalue).toHaveBeenCalledTimes(1);
    // The plan the question is about went to stderr; stdout stays empty.
    expect(out).toBe('');
    expect(err).toMatch(/1150/);
  });

  it('a period already revalued, with nothing moved since, says so and posts nothing', async () => {
    m.revalue.mockResolvedValueOnce(
      plan({ alreadyRun: { journalEntryId: 'j', reversalEntryId: 'r', sequence: 2 }, gain: '0.0000', sequence: null })
    );
    const r = await cli(['2026-08', '-y']);
    expect(r.code).toBe(ExitCode.OK);
    expect(m.revalue).toHaveBeenCalledTimes(1);
    expect(err).toMatch(/August was already revalued \(run 2\) and nothing has moved since/);
  });

  it('nothing to revalue posts nothing', async () => {
    m.revalue.mockResolvedValueOnce(plan({ lines: [], rates: [], gain: '0.0000', sequence: null }));
    const r = await cli(['2026-08', '-y']);
    expect(r.code).toBe(ExitCode.OK);
    expect(m.revalue).toHaveBeenCalledTimes(1);
    expect(err).toMatch(/no foreign balance/);
    expect(err).toMatch(/Nothing to revalue: the ledger was not touched\./);
  });

  it('a live run hands the confirmed gain and loss to the post, and prints the entries it created', async () => {
    m.revalue
      .mockResolvedValueOnce(plan())
      .mockResolvedValueOnce(plan({ entry: { id: 'je-1', number: 'JE-100' }, reversal: { id: 'je-2', number: 'JE-101' } }));
    const r = await cli(['2026-08', '-y', '--json']);
    expect(r.code).toBe(ExitCode.OK);
    expect(m.revalue.mock.calls[1][3]).toEqual({ expect: { gain: '700.0000', loss: '0.0000' } });
    expect((JSON.parse(out) as { rows: unknown[] }).rows).toEqual([
      expect.objectContaining({
        account: '1150', difference: '700.0000', sequence: 1,
        entry_number: 'JE-100', entry_id: 'je-1', reversal_number: 'JE-101', reversal_id: 'je-2',
      }),
    ]);
    expect(err).toMatch(/JE-100 on 2026-08-31, reversed by JE-101 on 2026-09-01/);
  });

  it('a supplementary run says the difference is only what moved since', async () => {
    m.revalue.mockResolvedValueOnce(plan({ sequence: 2 }));
    await cli(['2026-08', '--dry-run']);
    expect(err).toMatch(/Supplementary run 2/);
  });
});
