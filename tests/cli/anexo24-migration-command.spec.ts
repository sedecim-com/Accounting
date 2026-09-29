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
// What the ledger does with the opening is proven against Postgres
// (tests/integration/o1-balanza-de-apertura.int.spec.ts). Here: the risk each
// leaf declares, and that the gesture is the one the owner decided —
// `--dry-run` writes nothing, `--yes` writes once, and `check` exits 4 when
// the balances differ.
// ============================================================

const m = vi.hoisted(() => ({
  importSatChart: vi.fn(),
  importOpeningBalance: vi.fn(),
  checkOpeningBalance: vi.fn(),
}));
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: vi.fn(async () => ({ userId: 'u-1' })),
}));
vi.mock('../../src/cli/kernel/entity-context.js', async (orig) => {
  const ctx = { tenantId: 't-1', entityId: 'e-1', entityName: 'Sintética SA' };
  return {
    ...(await orig<object>()),
    requireExplicitEntity: vi.fn(async () => ctx),
    resolveActiveEntity: vi.fn(async () => ({ ctx, source: 'flag' })),
  };
});
vi.mock('../../src/services/accounting/sat-chart-import.js', () => ({
  importSatChart: m.importSatChart,
  renderSatChartImportReport: () => 'chart report',
}));
vi.mock('../../src/services/accounting/opening-balance.js', () => ({
  importOpeningBalance: m.importOpeningBalance,
  checkOpeningBalance: m.checkOpeningBalance,
  renderOpeningBalanceReport: () => 'opening report',
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
    confirm: vi.fn(async () => false),
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

const opening = (written: boolean) => ({
  puedeCargarse: true, escrito: written, ejercicio: 2026, fecha: '2026-01-01', totalDebe: '1', totalHaber: '1',
});

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  for (const f of Object.values(m)) f.mockReset();
});

describe('the declarations', () => {
  it('pass the kernel audit, with the catalog Spanish aliases', () => {
    const { program, leaf } = build();
    expect(auditProgram(program)).toEqual([]);
    expect(leaf('chart', 'import').aliases()).toContain('importar');
    expect(leaf('opening-balance', 'import').aliases()).toContain('importar');
    expect(leaf('opening-balance', 'check').aliases()).toContain('verificar');
  });

  it('opening-balance import is irreversible and closed to the agent, with --dry-run and --yes', () => {
    const { leaf } = build();
    const c = leaf('opening-balance', 'import');
    expect(riskOf(c)).toMatchObject({ risk: 'irreversible', agentAllowed: false });
    const longs = c.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--dry-run', '--yes', '--subledger']));
  });

  it('chart import writes with the agent closed; check is a read', () => {
    const { leaf } = build();
    expect(riskOf(leaf('chart', 'import'))).toMatchObject({ risk: 'escritura', agentAllowed: false });
    expect(riskOf(leaf('opening-balance', 'check'))).toMatchObject({ risk: 'lectura' });
  });
});

describe('the gesture: --dry-run, then --yes', () => {
  it('--dry-run only previews: the service never runs for real', async () => {
    m.importOpeningBalance.mockResolvedValue(opening(false));
    const code = await build().run('opening-balance', 'import', FILE, '--dry-run');
    expect(code).toBe(0);
    expect(m.importOpeningBalance).toHaveBeenCalledTimes(1);
    expect(m.importOpeningBalance.mock.calls[0][1]).toMatchObject({ dryRun: true, userId: 'u-1' });
  });

  it('without --yes and a "no", nothing is posted', async () => {
    m.importOpeningBalance.mockResolvedValue(opening(false));
    const code = await build().run('opening-balance', 'import', FILE);
    expect(code).not.toBe(0);
    expect(m.importOpeningBalance).toHaveBeenCalledTimes(1);
  });

  it('--yes posts once, after the preview', async () => {
    m.importOpeningBalance.mockResolvedValueOnce(opening(false)).mockResolvedValueOnce(opening(true));
    const code = await build().run('opening-balance', 'import', FILE, '--yes');
    expect(code).toBe(0);
    expect(m.importOpeningBalance).toHaveBeenCalledTimes(2);
    expect(m.importOpeningBalance.mock.calls[1][1]).not.toHaveProperty('dryRun');
  });

  it('under apertura_modo_de_carga = borrador the question says draft, not post (MNE-001-099)', async () => {
    const confirm = vi.fn(async (_question: string) => false);
    const program = new Command('mnemosine').exitOverride();
    registerAnexo24MigrationCommands(program, {
      palette: palette(process.stdout),
      shutdown: () => undefined,
      reportError: vi.fn(),
      confirm,
    });
    m.importOpeningBalance.mockResolvedValue({ ...opening(false), loadMode: 'draft' });
    await program.parseAsync(['opening-balance', 'import', FILE], { from: 'user' });
    expect(confirm.mock.calls[0][0]).toMatch(/draft|borrador/i);
    expect(confirm.mock.calls[0][0]).toMatch(/entry post/);

    confirm.mockClear();
    m.importOpeningBalance.mockResolvedValue({ ...opening(false), loadMode: 'post' });
    await program.parseAsync(['opening-balance', 'import', FILE], { from: 'user' });
    expect(confirm.mock.calls[0][0]).not.toMatch(/draft|borrador/i);
  });

  it('chart import: --yes writes, an incomplete chart without --partial does not', async () => {
    const plan = { puedeImportarse: true, completa: true, aCrear: [], escrito: true };
    m.importSatChart.mockResolvedValue(plan);
    expect(await build().run('chart', 'import', FILE, '--yes')).toBe(0);
    expect(m.importSatChart).toHaveBeenCalledTimes(2);

    m.importSatChart.mockReset();
    m.importSatChart.mockResolvedValue({ ...plan, completa: false, escrito: false });
    expect(await build().run('chart', 'import', FILE, '--yes')).toBe(4);
    expect(m.importSatChart).toHaveBeenCalledTimes(1);
  });
});

describe('opening-balance check', () => {
  const report = (equal: boolean) => ({
    entityId: 'e-1',
    asOf: '2026-01-01',
    comparison: {
      columna: 'SaldoFin',
      comparadas: 3,
      diferencias: [],
      faltantes: [],
      sobrantes: [],
      excluded: [],
      iguales: equal,
    },
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
