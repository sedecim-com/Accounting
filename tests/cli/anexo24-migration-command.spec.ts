import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { registerAnexo24MigrationCommands } from '../../src/cli/anexo24-migration-command.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { palette } from '../../src/cli/palette.js';

// ============================================================
// MNE-001-018 · THE ANEXO 24 MIGRATION LEAVES, WITHOUT A DATABASE
//
// What the ledger does is proven against Postgres
// (tests/integration/o1-balanza-de-apertura.int.spec.ts). Here: the risk each
// leaf declares, and that `check` exits 4 when the balances differ.
// ============================================================

const m = vi.hoisted(() => ({
  checkOpeningBalance: vi.fn(),
}));
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/cli/kernel/entity-context.js', async (orig) => {
  const ctx = { tenantId: 't-1', entityId: 'e-1', entityName: 'Sintética SA' };
  return {
    ...(await orig<object>()),
    requireExplicitEntity: vi.fn(async () => ctx),
    resolveActiveEntity: vi.fn(async () => ({ ctx, source: 'flag' })),
  };
});
vi.mock('../../src/services/accounting/opening-balance.js', () => ({
  checkOpeningBalance: m.checkOpeningBalance,
}));

const FILE = path.join(mkdtempSync(path.join(tmpdir(), 'mne018-')), 'synthetic.xml');
writeFileSync(FILE, '<synthetic/>');

function build() {
  const exits: number[] = [];
  const program = new Command('mnemosine').exitOverride();
  registerAnexo24MigrationCommands(program, {
    palette: palette(process.stdout),
    shutdown: (code) => void exits.push(code),
    reportError: vi.fn(),
  });
  const leaf = (family: string, name: string): Command => {
    const c = program.commands.find((x) => x.name() === family)?.commands.find((x) => x.name() === name);
    if (!c) throw new Error(`${family} ${name} was not registered`);
    return c;
  };
  const run = async (...argv: string[]) => {
    await program.parseAsync(argv, { from: 'user' });
    return exits.at(-1);
  };
  return { program, leaf, run };
}

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const f of Object.values(m)) f.mockReset();
});

describe('the declarations', () => {
  it('pass the kernel audit, with the catalog Spanish aliases', () => {
    const { program, leaf } = build();
    expect(auditProgram(program)).toEqual([]);
    expect(leaf('opening-balance', 'check').aliases()).toContain('verificar');
  });

  it('check is a read, with the output contract', () => {
    const { leaf } = build();
    const c = leaf('opening-balance', 'check');
    expect(riskOf(c)).toMatchObject({ risk: 'lectura' });
    expect(c.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--format', '--json']));
  });
});

describe('opening-balance check', () => {
  const report = (equal: boolean) => ({
    entityId: 'e-1',
    asOf: '2026-01-01',
    comparison: { columna: 'SaldoFin', comparadas: 3, diferencias: [], faltantes: [], sobrantes: [], iguales: equal },
  });

  it('exits 0 when equal to the peso, and 4 when not', async () => {
    m.checkOpeningBalance.mockResolvedValue(report(true));
    expect(await build().run('opening-balance', 'check', FILE)).toBe(0);
    m.checkOpeningBalance.mockResolvedValue(report(false));
    expect(await build().run('opening-balance', 'check', FILE)).toBe(4);
  });

  it('an unreadable file is a usage error, not a crash', async () => {
    expect(await build().run('opening-balance', 'check', `${FILE}.missing`)).toBe(2);
    expect(m.checkOpeningBalance).not.toHaveBeenCalled();
  });
});
