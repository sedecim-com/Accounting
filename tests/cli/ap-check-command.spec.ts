import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerApCommand } from '../../src/cli/ap-command.js';
import { ExitCode } from '../../src/cli/kernel/index.js';

// ============================================================
// MNE-001-432 (#643) · `ap check` at the terminal, with the battery mocked:
// the probe itself is tested against Postgres in
// tests/integration/mne-001-432-ap-check-cancelled-cfdi.int.spec.ts. What is
// watched here is the edge: bare --check lists without reading, a warning
// exits 0 and 4 under --strict, and every bill is printed with its number,
// vendor, UUID and balance. All data is synthetic.
// ============================================================

const world = vi.hoisted(() => ({ calls: 0, lastChecks: undefined as string[] | undefined }));

vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: () => undefined }));

vi.mock('../../src/cli/kernel/entity-context.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveActiveEntity: () => Promise.resolve({ ctx: { tenantId: 'T1', entityId: 'E1', entityName: 'Acme SA' } }),
}));

vi.mock('../../src/services/ap/ap-checks.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runApChecks: (_entityId: string, opts: { checks?: string[] }) => {
    world.calls += 1;
    world.lastChecks = opts.checks;
    return Promise.resolve({
      results: [{
        name: 'cancelled-cfdi-open', level: 'warning', count: 1,
        detailKey: 'ap.check.cancelled_cfdi_open.found',
        bills: [{
          bill_number: 'P1-432', vendor: 'Proveedor Sintético Uno', cfdi_uuid: 'AAAAAAAA-4320-4000-8000-000000000001',
          amount_due: '1160.00', currency: 'MXN', noted_on: '2026-11-20',
        }],
      }],
      blocking: 0,
      warnings: 1,
    });
  },
}));

const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

async function run(...argv: string[]): Promise<{ out: string; code: number }> {
  let out = '';
  let code = -1;
  const program = new Command();
  program.exitOverride();
  registerApCommand(program, { palette: plain, shutdown: (c: number) => { code = c; }, reportError: () => undefined });
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true; });
  try {
    await program.parseAsync(['node', 'mnemosine', 'ap', 'check', ...argv]);
  } finally {
    spy.mockRestore();
  }
  return { out, code };
}

beforeEach(() => {
  world.calls = 0;
  world.lastChecks = undefined;
});

describe('ap check', () => {
  it('bare --check lists the battery without running it', async () => {
    const r = await run('--check', '--json');
    expect(world.calls).toBe(0);
    expect((JSON.parse(r.out) as { rows: unknown[] }).rows).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'cancelled-cfdi-open' })]));
    expect(r.code).toBe(ExitCode.OK);
  });

  it('prints each bill with its number, vendor, UUID and balance, and a warning exits 0', async () => {
    const r = await run();
    expect(r.out).toContain('cancelled-cfdi-open');
    expect(r.out).toMatch(/P1-432 · Proveedor Sintético Uno · AAAAAAAA-4320-4000-8000-000000000001 · \S+ 1160\.00 MXN/);
    expect(r.code).toBe(ExitCode.OK);
  });

  it('exits 4 on the warning under --strict, and passes the selection through', async () => {
    const r = await run('--check', 'cancelled-cfdi-open', '--strict');
    expect(world.lastChecks).toEqual(['cancelled-cfdi-open']);
    expect(r.code).toBe(ExitCode.VALIDATION);
  });

  it('--json carries the bills nested in their probe', async () => {
    const r = await run('--json');
    const { rows } = JSON.parse(r.out) as { rows: Array<{ check: string; level: string; bills: Array<{ amount_due: string }> }> };
    expect(rows[0]).toMatchObject({ check: 'cancelled-cfdi-open', level: 'warning' });
    expect(rows[0].bills[0].amount_due).toBe('1160.00');
  });
});
