import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';

// ============================================================
// I8.5 · the assets-inventory family speaks by key (MNE-001-222, #267)
//
// `depreciation run`, `depreciation post` and the dry run of `asset create`,
// end to end against doubles of what they read and write. Every line they
// write to a person comes from the catalogue: English under the suite's
// en-US, Spanish when the language is pinned. Texts written by hand, before
// the code. The engines themselves are proven elsewhere (the depreciation
// arithmetic, act2-checklist-and-depreciation, the month spec).
// ============================================================

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: vi.fn(),
  resolveEntity: vi.fn(async () => ({
    entityId: 'ent-1', entityName: 'Demo Activos SA', tenantId: 'ten-1', currency: 'MXN',
    country: 'MX', accountingStandard: 'NIF', taxId: 'X',
  })),
  listEntities: vi.fn(async () => [{ id: 'ent-1' }]),
}));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: vi.fn(async () => ({ userId: 'u-1' })) }));
vi.mock('../../src/services/accounting/fiscal-calendar-service.js', () => ({ resolvePeriod: vi.fn(async () => ({ id: 'p8' })) }));
vi.mock('../../src/services/idempotency/idempotency-store.js', () => ({
  conLlave: vi.fn(async (_ctx: unknown, _act: unknown, fn: () => Promise<unknown>) => ({ repetido: false, resultado: await fn() })),
  hashDeCarga: vi.fn(() => 'hash'),
}));
vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  withTransaction: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({})),
}));
vi.mock('../../src/services/assets/depreciation-plan.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/assets/depreciation-plan.js')>()),
  planDeDepreciacion: vi.fn(),
  leerPlanAprobado: vi.fn(() => []),
  diferenciasContraPlan: vi.fn(() => []),
}));
vi.mock('../../src/services/assets/depreciation.js', () => ({ runMonthlyDepreciation: vi.fn() }));
vi.mock('../../src/services/assets/asset-lookup.js', () => ({
  exigirLibroDelPanel: vi.fn(() => 'book'),
  libroQueRige: vi.fn(async () => ({ libro: 'book', base: 'vida_util_nif', definida: true })),
  resolverCategoriaDeActivo: vi.fn(async () => ({ id: 'cat-1', name: 'Equipo de Cómputo' })),
}));
vi.mock('../../src/services/assets/asset-service.js', () => ({
  crearActivo: vi.fn(async () => ({
    id: 'fa-1', asset_number: 'AF-2026-00001', asset_name: 'Servidor', acquisition_cost: '100000.0000',
    current_book_value: '100000.0000', useful_life_months: 48, depreciation_method: 'straight_line',
    depreciation_start_date: '2026-04-01',
    politicas: { base_depreciacion: 'vida_util_nif', convencion_primer_mes: 'mes_completo' }, avisos: [],
  })),
  sembrarCategoriasDeActivo: vi.fn(),
}));
vi.mock('../../src/services/assets/asset-edit.js', () => ({ editAsset: vi.fn() }));
vi.mock('../../src/services/assets/asset-retire.js', () => ({ retireAsset: vi.fn(), undoAssetRetirement: vi.fn() }));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: vi.fn(async () => 'quizá'), close: vi.fn() })),
}));

import { exigirDimension, noClassLabel, registerDepreciationCommand } from '../../src/cli/depreciation-command.js';
import { registerAssetCommand } from '../../src/cli/asset-command.js';
import { type CliError } from '../../src/cli/kernel/index.js';
import { riskOf, resetDeclarations } from '../../src/cli/kernel/risk.js';
import * as planModule from '../../src/services/assets/depreciation-plan.js';
import * as engine from '../../src/services/assets/depreciation.js';
import * as store from '../../src/services/idempotency/idempotency-store.js';
import { editAsset } from '../../src/services/assets/asset-edit.js';
import { retireAsset, undoAssetRetirement } from '../../src/services/assets/asset-retire.js';
import { t } from '../../src/i18n/index.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import type { PlanDeDepreciacion } from '../../src/services/assets/depreciation-plan.js';

const PALETTE = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

function testPlan(partial: Partial<PlanDeDepreciacion> = {}): PlanDeDepreciacion {
  return {
    entity_id: 'ent-1',
    fiscal_period_id: 'p8',
    periodo: 'Periodo 8/2026',
    inicio: '2026-08-01',
    fin: '2026-08-31',
    fecha_del_asiento: '2026-08-31',
    base: 'vida_util_nif',
    base_definida: true,
    convencion: 'mes_completo',
    convencion_definida: false,
    tipo_calendario: 'book',
    renglones: [
      {
        asset_id: 'a1', asset_number: 'AF-2026-00001', asset_name: 'Servidor', categoria: 'Equipo de Cómputo',
        metodo: 'straight_line', indice: 4, periodos: 48, base_inicial: '96000.0000', depreciacion: '2000.0000',
        acumulada: '10000.0000', valor_en_libros: '86000.0000', cuenta_gasto: '6140', cuenta_gasto_id: 'c1',
        cuenta_acumulada: '1290', cuenta_acumulada_id: 'c2',
      },
    ],
    omitidos: [
      {
        asset_id: 'a9', asset_number: 'AF-2026-00009', asset_name: 'Torno', categoria: '',
        motivo: 'unidades_de_produccion', detalle: 'no production captured', pendiente: true,
      },
    ],
    total: '2000.0000',
    pendientes: 1,
    faltante_al_cierre: { politica: 'avisar', definida: true },
    huella: '0123456789abcdef',
    ...partial,
  } as PlanDeDepreciacion;
}

async function cli(args: string[], confirm?: (q: string) => Promise<boolean>) {
  resetDeclarations();
  let code: number | undefined;
  const errs: unknown[] = [];
  const program = new Command('mnemosine').exitOverride();
  const deps = {
    palette: PALETTE,
    shutdown: (c: number) => { code = c; },
    reportError: (e: unknown) => { errs.push(e); },
    home: '/tmp/mnemosine-tests-no-home',
    ...(confirm ? { confirm } : {}),
  };
  registerDepreciationCommand(program, deps);
  registerAssetCommand(program, deps);
  let out = '';
  let err = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err += String(c); return true; });
  try {
    await program.parseAsync(['node', 'mnemosine', ...args]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { code, out, err, errs, program };
}

const RUN = ['depreciation', 'run', '--entity', 'ent-1', '--period', '2026-08'];
const POST = ['depreciation', 'post', '--entity', 'ent-1', '--period', '2026-08'];

beforeEach(() => {
  vi.mocked(planModule.planDeDepreciacion).mockResolvedValue(testPlan());
  vi.mocked(planModule.diferenciasContraPlan).mockReturnValue([]);
  vi.mocked(engine.runMonthlyDepreciation).mockResolvedValue({ processed: 1, errors: [], skipped: [] });
});
afterEach(() => resetLanguage());

describe('I8.5 · the usage errors of depreciation', () => {
  it('an unknown --by names the four dimensions, in both languages', () => {
    let e: CliError | undefined;
    try { exigirDimension('cost-center'); } catch (x) { e = x as CliError; }
    expect(e!.message).toContain('--by "cost-center" does not exist. The four dimensions are: asset, class, account, method');
    expect(e!.localized('es')).toContain('--by «cost-center» no existe. Las cuatro dimensiones son: asset, class, account, method');
  });

  it('a run without --period says the month is not guessed', async () => {
    const r = await cli(['depreciation', 'run', '--entity', 'ent-1']);
    expect((r.errs[0] as CliError).message).toContain('--period is missing. Depreciation belongs to one specific month');
  });
});

describe('I8.5 · depreciation run speaks by key', () => {
  it('the header, the criteria, the default warning, the skipped heading and the missing-row warning', async () => {
    const r = await cli(RUN);
    expect(r.err).toContain(
      'Periodo 8/2026 (2026-08-01..2026-08-31) · book book · entries dated 2026-08-31 · fingerprint 0123456789ab\n'
    );
    expect(r.err).toContain('base vida_util_nif · convention mes_completo (default) · 1 asset enters, 1 is skipped, total 2000.0000\n');
    expect(r.err).toContain('  ⚠ At least one declared default governs here, not a choice of the firm.');
    expect(r.err).toContain('\nSkipped (1):\n');
    expect(r.err).toContain(
      '  ⚠ 1 asset is left without a row for Periodo 8/2026, and the month should recognise it. ' +
        'The policy `depreciacion_faltante_al_cierre` is "avisar".\n'
    );
  });

  it('the same run in Spanish, with its plurals and its declared default', async () => {
    vi.mocked(planModule.planDeDepreciacion).mockResolvedValue(
      testPlan({ pendientes: 2, faltante_al_cierre: { politica: 'avisar', definida: false } })
    );
    setLanguage('es');
    const r = await cli(RUN);
    expect(r.err).toContain('libro book · asientos con fecha 2026-08-31 · huella 0123456789ab');
    expect(r.err).toContain('convención mes_completo (defecto) · 1 activo entra, 1 se omite, total 2000.0000');
    expect(r.err).toContain('\nOmitidos (1):\n');
    expect(r.err).toContain('2 activos se quedan sin renglón de Periodo 8/2026 y el mes debería reconocerlo.');
    expect(r.err).toContain('vale «avisar» (defecto declarado).');
  });

  it('--by class labels the classless group in the table, in both languages', async () => {
    const english = await cli([...RUN, '--by', 'class']);
    expect(english.out).toContain('(no class)');
    setLanguage('es');
    const spanish = await cli([...RUN, '--by', 'class']);
    expect(spanish.out).toContain('(sin clase)');
    expect(spanish.out).not.toContain('(no class)');
  });

  it('--json keeps the English group under es-MX', async () => {
    setLanguage('es');
    const r = await cli([...RUN, '--by', 'class', '--json']);
    expect(r.out).toContain('(no class)');
    expect(r.out).not.toContain('(sin clase)');
  });

  it('the label of the group passes any other value through', () => {
    expect(noClassLabel('Equipo de Cómputo')).toBe('Equipo de Cómputo');
    setLanguage('es');
    expect(noClassLabel('(no class)')).toBe('(sin clase)');
  });

  it('--strict turns the warning into a block, and names why', async () => {
    const r = await cli([...RUN, '--strict']);
    expect((r.errs[0] as CliError).message).toBe(
      '1 asset without a row for Periodo 8/2026. --strict turns the warning into a block. ' +
        '`depreciation post` will refuse to post until they are resolved.'
    );
  });

  it('the policy blocks the run without --strict, in both languages', async () => {
    vi.mocked(planModule.planDeDepreciacion).mockResolvedValue(
      testPlan({ pendientes: 2, faltante_al_cierre: { politica: 'bloquear', definida: true } })
    );
    const r = await cli(RUN);
    const e = r.errs[0] as CliError;
    expect(e.message).toContain('2 assets without a row for Periodo 8/2026. The policy `depreciacion_faltante_al_cierre` is set to "bloquear".');
    expect(e.localized('es')).toContain('2 activos sin renglón de Periodo 8/2026. La política `depreciacion_faltante_al_cierre` está en «bloquear».');
  });

  it('an empty plan has nothing to post with this book', async () => {
    vi.mocked(planModule.planDeDepreciacion).mockResolvedValue(
      testPlan({ renglones: [], omitidos: [], pendientes: 0, total: '0.0000' })
    );
    const r = await cli(RUN);
    expect(r.err).toContain('Nothing to post in this period with this book.\n');
  });
});

describe('I8.5 · depreciation post speaks by key', () => {
  it('an empty plan leaves the ledger untouched', async () => {
    vi.mocked(planModule.planDeDepreciacion).mockResolvedValue(
      testPlan({ renglones: [], omitidos: [], pendientes: 0, total: '0.0000' })
    );
    const r = await cli(POST);
    expect(r.err).toContain('Nothing to post in Periodo 8/2026: the ledger was not touched.\n');
  });

  it('a plan that moved since its approval is a conflict, in both languages', async () => {
    const file = join(tmpdir(), 'mne-222-approved-plan.json');
    writeFileSync(file, '[]');
    vi.mocked(planModule.diferenciasContraPlan).mockReturnValue(['A-1: 2000.0000 -> 2083.3333']);
    const r = await cli([...POST, '--file', file]);
    const e = r.errs[0] as CliError;
    expect(e.message).toBe(
      `The plan approved in ${file} no longer matches what the run would do today, so nothing is posted: ` +
        'A-1: 2000.0000 -> 2083.3333. Run `depreciation run` again, review the new plan and post against that one.'
    );
    expect(e.localized('es')).toContain('ya no corresponde a lo que la corrida haría hoy');
  });

  it('the policy refuses to post while an asset owes its row', async () => {
    vi.mocked(planModule.planDeDepreciacion).mockResolvedValue(
      testPlan({ faltante_al_cierre: { politica: 'bloquear', definida: true } })
    );
    const r = await cli(POST);
    const e = r.errs[0] as CliError;
    expect(e.message).toContain(
      'Nothing is posted: 1 asset is left without a row for Periodo 8/2026 and the policy ' +
        '`depreciacion_faltante_al_cierre` is set to "bloquear". Resolve them'
    );
    expect(e.localized('es')).toContain('No se contabiliza: 1 activo se queda sin renglón de Periodo 8/2026');
  });

  it('the dry run says how many entries and reversals, and that the ledger was not touched', async () => {
    const r = await cli([...POST, '--dry-run']);
    expect(r.err).toContain('1 two-line entry, one per asset, not a single one for the run. Reversing this run takes 1 reversal.\n');
    expect(r.err).toContain('Dry run: the ledger was not touched and no row was written.\n');
  });

  it('the dry run in Spanish, with two assets', async () => {
    const plan = testPlan();
    vi.mocked(planModule.planDeDepreciacion).mockResolvedValue(
      testPlan({ renglones: [plan.renglones[0], { ...plan.renglones[0], asset_id: 'a2', asset_number: 'AF-2026-00002' }] })
    );
    setLanguage('es');
    const r = await cli([...POST, '--dry-run']);
    expect(r.err).toContain('2 pólizas de dos líneas, una por activo, no una sola de la corrida. Reversar esta corrida son 2 reversas.');
    expect(r.err).toContain('Ensayo: el mayor no se tocó y no se escribió ningún renglón.');
  });

  it('asks with the total, the entries, the book and the period, in both languages', async () => {
    const asked: string[] = [];
    await cli(POST, async (q) => { asked.push(q); return true; });
    setLanguage('es');
    await cli(POST, async (q) => { asked.push(q); return true; });
    expect(asked).toEqual([
      'Post 2000.0000 in 1 entry of the book book for Periodo 8/2026? The ledger does not allow undoing it.',
      '¿Contabilizar 2000.0000 en 1 póliza del libro book de Periodo 8/2026? El mayor no admite deshacer.',
    ]);
  });

  it('a refusal without a terminal names -y for this leaf', async () => {
    const r = await cli(POST, async () => false);
    expect((r.errs[0] as CliError).message).toBe(
      'No changes: there is no terminal to confirm at. Add -y so `depreciation post` runs without asking, ' +
        'or --dry-run to see the full effect without writing anything.'
    );
  });

  it('on a terminal, an answer it cannot read is taken as a no, and the ledger is untouched', async () => {
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const r = await cli(POST);
      expect(r.err).toContain('; I take it as a no.\n');
      expect((r.errs[0] as CliError).message).toBe('No changes: the ledger was not touched.');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }
  });

  it('a run that differs from its plan says so, and the done line counts the entries', async () => {
    vi.mocked(engine.runMonthlyDepreciation).mockResolvedValue({ processed: 3, errors: [], skipped: [] });
    const r = await cli([...POST, '--yes']);
    expect(r.err).toContain('  ⚠ The plan showed 1 entry and the run made 3. The plan and the engine did not agree');
    expect(r.err).toContain('✔ 3 entries posted in Periodo 8/2026 (book book).\n');
    setLanguage('es');
    const spanish = await cli([...POST, '--yes']);
    expect(spanish.err).toContain('✔ 3 pólizas contabilizadas en Periodo 8/2026 (libro book).');
  });

  it('one entry posted is singular', async () => {
    const r = await cli([...POST, '--yes']);
    expect(r.err).toContain('✔ 1 entry posted in Periodo 8/2026 (book book).\n');
    expect(r.err).not.toContain('The plan showed');
  });

  // MNE-001-881 (#1069): an asset by units of production is skipped by the
  // run, never in silence, and it is not an error: the leaf exits 0.
  it('an asset the run skipped by units of production is named, in both languages', async () => {
    const skipped = [{ asset_number: 'AF-2026-00009', asset_name: 'Torno', reason: 'unidades_de_produccion' as const }];
    vi.mocked(engine.runMonthlyDepreciation).mockResolvedValue({ processed: 1, errors: [], skipped });
    const r = await cli([...POST, '--yes']);
    expect(r.err).toContain(
      '  ⚠ AF-2026-00009 Torno was skipped and nothing was posted for it: it depreciates by units of production, ' +
        'and the production of Periodo 8/2026 cannot be captured yet. Book its charge by hand (mnemosine entry ' +
        'create), or give it another method (mnemosine asset edit --method); the close counts it under ' +
        '`depreciacion_faltante_al_cierre`.\n'
    );
    expect(r.code).toBe(0);
    setLanguage('es');
    const spanish = await cli([...POST, '--yes']);
    expect(spanish.err).toContain(
      '  ⚠ AF-2026-00009 Torno se omitió y no se contabilizó nada por él: se deprecia por unidades de producción, ' +
        'y la producción de Periodo 8/2026 todavía no se puede capturar. Registra su cargo a mano (mnemosine ' +
        'entry create), o dale otro método (mnemosine asset edit --method); el cierre lo cuenta según ' +
        '`depreciacion_faltante_al_cierre`.\n'
    );
  });

  it('a spent key returns the recorded result', async () => {
    vi.mocked(store.conLlave).mockResolvedValueOnce({ repetido: true, resultado: { processed: 1, errors: [] } } as never);
    const r = await cli([...POST, '--yes', '--idempotency-key', 'k1']);
    expect(r.err).toContain('Idempotency key already spent: the recorded result is returned and nothing was posted again.\n');
  });

  it('says in English what it writes, for the audit trail', async () => {
    const r = await cli(['depreciation', 'run', '--entity', 'ent-1', '--period', '2026-08']);
    const post = r.program.commands.find((c) => c.name() === 'depreciation')!.commands.find((c) => c.name() === 'post')!;
    expect(riskOf(post)!.writes).toBe('journal_entries + journal_entry_lines (one entry per asset), depreciation_schedules, fixed_assets');
  });
});

describe('I8.5 · asset create speaks by key', () => {
  // MNE-001-881: the help offers the five methods a registration takes.
  it('the help of --method and --tax-method does not offer units of production', async () => {
    const { program } = await cli(RUN);
    const create = program.commands.find((c) => c.name() === 'asset')!.commands.find((c) => c.name() === 'create')!;
    const five = 'straight_line, declining_balance_150, declining_balance_200, sum_of_years_digits, macrs';
    const help = (flag: string) => create.options.find((o) => o.long === flag)!.description;
    expect(help('--method')).toBe(`BOOK depreciation method: ${five}`);
    expect(help('--tax-method')).toBe(`TAX depreciation method: ${five}`);
  });

  it('the dry run says the transaction was rolled back, in both languages', async () => {
    const args = ['asset', 'create', 'Servidor', '--entity', 'ent-1', '--category', 'Equipo de Cómputo',
      '--cost', '100000', '--acquired', '2026-03-20', '--capitalized', 'yes', '--dry-run'];
    const r = await cli(args);
    expect(r.errs).toEqual([]);
    expect(r.err).toContain('Dry run: the transaction was rolled back. No asset was created.\n');
    setLanguage('es');
    const spanish = await cli(args);
    expect(spanish.err).toContain('Ensayo: la transacción se deshizo. No se creó ningún activo.');
  });
});

// MNE-001-880 (#1069), part 1. Texts written by hand, before the code.
describe('MNE-001-880 · asset edit speaks by key', () => {
  const EDIT = ['asset', 'edit', 'AF-2026-00007', '--entity', 'ent-1', '--reason', 'Cost mistyped'];
  const edited = (changes: Array<{ field: string; before: string; after: string }>, startRederived = false) =>
    ({ id: 'fa-7', asset_number: 'AF-2026-00007', asset_name: 'Camioneta', changes, startRederived }) as never;
  const leaf = async () =>
    (await cli(RUN)).program.commands.find((c) => c.name() === 'asset')!.commands.find((c) => c.name() === 'edit')!;

  it('hands the service what was typed and nothing else, with the reason and the person', async () => {
    vi.mocked(editAsset).mockResolvedValue(edited([{ field: 'acquisition_cost', before: '4890000.0000', after: '489000.0000' }]));
    const r = await cli([...EDIT, '--cost', '489,000.00', '--json']);
    expect(r.errs).toEqual([]);
    const [entity, asset, changes, reason, user, opts] = vi.mocked(editAsset).mock.calls.at(-1)!;
    expect([entity, asset, reason, user, opts]).toEqual(['ent-1', 'AF-2026-00007', 'Cost mistyped', 'u-1', { client: undefined }]);
    expect(JSON.parse(JSON.stringify(changes))).toEqual({ acquisition_cost: '489000.0000' });
    expect(r.out).toContain('"before": "4890000.0000"');
    expect(r.out).toContain('"after": "489000.0000"');
  });

  it('the dry run goes through the real path on a transaction it rolls back, and a start that moved is named, in both languages', async () => {
    vi.mocked(editAsset).mockResolvedValue(edited([
      { field: 'acquisition_date', before: '2026-01-08', after: '2026-03-20' },
      { field: 'depreciation_start_date', before: '2026-01-01', after: '2026-03-01' },
    ], true));
    const args = [...EDIT, '--acquired', '2026-03-20', '--dry-run'];
    const r = await cli(args);
    expect(r.errs).toEqual([]);
    expect(vi.mocked(editAsset).mock.calls.at(-1)![5]).toEqual({ client: {} });
    expect(r.err).toContain(
      'The start of depreciation moved from 2026-01-01 to 2026-03-01: it follows the acquisition date, by ' +
        '`convencion_primer_mes` on the panel, unless --in-service is given.'
    );
    expect(r.err).toContain('Dry run: it really was written, and then rolled back.');
    setLanguage('es');
    const spanish = await cli(args);
    expect(spanish.err).toContain(
      'El inicio de la depreciación pasó de 2026-01-01 a 2026-03-01: sigue a la fecha de adquisición, según ' +
        '`convencion_primer_mes` del panel, salvo que se dé --in-service.'
    );
  });

  it('the refusal of an asset with posted months names the reversal and the disposal to come, in both languages', () => {
    const key = 'error.VALIDATION_ERROR.asset.edit_has_posted_months';
    expect(t(key, { asset: 'AF-2026-00007', months: 1, entries: 'DEP-0003', more: 0 }, 'en')).toBe(
      'AF-2026-00007 cannot be edited: it has depreciation posted in 1 month (DEP-0003), computed from the values ' +
        'you want to change. Reverse those entries first (mnemosine entry reverse <number> --reason "..."): a reversed ' +
        'month is owed again, and the next run posts it from the corrected values. To take the asset out of the ' +
        'register instead, `asset dispose` is coming. Nothing was changed.'
    );
    expect(t(key, { asset: 'AF-2026-00007', months: 8, entries: 'DEP-0003, DEP-0009', more: 6 }, 'es')).toBe(
      'AF-2026-00007 no se puede editar: tiene depreciación contabilizada en 8 meses (DEP-0003, DEP-0009 y 6 más), ' +
        'calculada con los valores que quieres cambiar. Reversa primero esas pólizas (mnemosine entry reverse <numero> ' +
        '--reason "..."): un mes reversado vuelve a deberse, y la siguiente corrida lo contabiliza con los valores ' +
        'corregidos. Para sacar el activo del registro, `asset dispose` está por llegar. No se cambió nada.'
    );
  });

  it('asks for a reason, offers the five methods of registration, and keeps the agent out', async () => {
    const calls = vi.mocked(editAsset).mock.calls.length;
    await expect(cli(['asset', 'edit', 'AF-2026-00007', '--entity', 'ent-1', '--cost', '1'])).rejects.toThrow(/--reason <text>/);
    const blank = await cli(['asset', 'edit', 'AF-2026-00007', '--entity', 'ent-1', '--cost', '1', '--reason', '  ']);
    expect((blank.errs[0] as CliError).message).toBe("error: required option '--reason <text>' not specified");
    const typo = await cli([...EDIT, '--method', 'units_of_production_x']);
    expect((typo.errs[0] as CliError).message).toContain('--method "units_of_production_x" does not exist');
    expect(vi.mocked(editAsset).mock.calls.length).toBe(calls);

    const edit = await leaf();
    expect(edit.options.find((o) => o.long === '--method')!.description).toBe(
      'BOOK depreciation method: straight_line, declining_balance_150, declining_balance_200, sum_of_years_digits, macrs'
    );
    expect(riskOf(edit)).toMatchObject({ risk: 'escritura', agentAllowed: false });
    expect(riskOf(edit)!.writes).toBe(
      'fixed_assets (the columns given, only while no depreciation row is live) + audit_log; no journal entry'
    );
  });
});

// MNE-001-880 (#1069), part 2. Texts written by hand, before the code.
describe('MNE-001-880 · asset retire speaks by key', () => {
  const RETIRE = ['asset', 'retire', 'AF-2026-00007', '--entity', 'ent-1', '--reason', 'Engine seized'];
  const retired = (months: string[]) =>
    ({ id: 'fa-7', asset_number: 'AF-2026-00007', asset_name: 'Camioneta', from: 'active', to: 'inactive', effective: '2026-08-20', months }) as never;
  const back = (months: string[]) =>
    ({ id: 'fa-7', asset_number: 'AF-2026-00007', asset_name: 'Camioneta', from: 'inactive', to: 'active', effective: '2026-08-20', months }) as never;

  it('retires as of the day given, and names the months already posted, which stand, in both languages', async () => {
    vi.mocked(retireAsset).mockResolvedValue(retired(['Periodo 8/2026 (JE-000031)', 'Periodo 9/2026 (JE-000044)']));
    const args = [...RETIRE, '--effective', '2026-08-20'];
    const r = await cli(args);
    expect(r.errs).toEqual([]);
    expect(vi.mocked(retireAsset).mock.calls.at(-1)).toEqual(['ent-1', 'AF-2026-00007', '2026-08-20', 'Engine seized', 'u-1', { client: undefined }]);
    expect(r.err).toBe(
      'AF-2026-00007 is retired as of 2026-08-20: the monthly run no longer takes it, and its card keeps what was posted. ' +
        'To bring it back: mnemosine asset retire AF-2026-00007 --undo --reason "...".\n' +
        '  ⚠ 2 months already posted on or after that date stand: Periodo 8/2026 (JE-000031), Periodo 9/2026 (JE-000044). ' +
        'Nothing already posted is changed: reverse by hand what should not have been posted ' +
        '(mnemosine entry reverse <number> --reason "...").\n'
    );
    setLanguage('es');
    vi.mocked(retireAsset).mockResolvedValue(retired(['Periodo 8/2026 (JE-000031)']));
    expect((await cli(args)).err).toBe(
      'AF-2026-00007 queda retirado desde el 2026-08-20: la corrida mensual ya no lo toma, y su ficha conserva lo ' +
        'contabilizado. Para devolverlo al uso: mnemosine asset retire AF-2026-00007 --undo --reason "...".\n' +
        '  ⚠ 1 mes ya contabilizado en esa fecha o después se queda como está: Periodo 8/2026 (JE-000031). ' +
        'Lo ya contabilizado no se cambia: reversa a mano lo que no debió contabilizarse ' +
        '(mnemosine entry reverse <numero> --reason "...").\n'
    );
  });

  it('--undo brings it back on the real path, posts nothing for the months skipped and names them, in both languages', async () => {
    vi.mocked(undoAssetRetirement).mockResolvedValue(back(['Periodo 9/2026', 'Periodo 10/2026']));
    const args = [...RETIRE, '--undo', '--dry-run'];
    const r = await cli(args);
    expect(r.errs).toEqual([]);
    expect(vi.mocked(undoAssetRetirement).mock.calls.at(-1)).toEqual(['ent-1', 'AF-2026-00007', 'Engine seized', 'u-1', { client: {} }]);
    expect(r.err).toBe(
      'AF-2026-00007 is in use again (it was retired as of 2026-08-20): the monthly run takes it from the next month it ' +
        'runs. Nothing was posted for the months it skipped.\n' +
        '  ⚠ 2 months have no depreciation for it: Periodo 9/2026, Periodo 10/2026. Catching them up is yours: run each one ' +
        '(mnemosine depreciation post --period <month>).\n' +
        'Dry run: it really was written, and then rolled back.\n'
    );
    setLanguage('es');
    vi.mocked(undoAssetRetirement).mockResolvedValue(back([]));
    expect((await cli([...RETIRE, '--undo'])).err).toBe(
      'AF-2026-00007 vuelve al uso (estaba retirado desde el 2026-08-20): la corrida mensual lo toma desde el siguiente ' +
        'mes que corra. No se contabilizó nada por los meses que se saltó.\n'
    );
  });

  it('asks for one of --effective or --undo, a real day and a reason, before any connection', async () => {
    const before = [vi.mocked(retireAsset).mock.calls.length, vi.mocked(undoAssetRetirement).mock.calls.length];
    for (const args of [RETIRE, [...RETIRE, '--effective', '2026-08-20', '--undo']]) {
      const e = (await cli(args)).errs[0] as CliError;
      expect(e.message).toBe(
        'Say which: --effective <date> retires the asset, --undo brings back one that was retired. Not both, and not neither.'
      );
      expect(e.localized('es')).toBe(
        'Di cuál: --effective <fecha> retira el activo, --undo devuelve al uso uno que fue retirado. No los dos, y no ninguno.'
      );
    }
    expect(((await cli([...RETIRE, '--effective', '2026-02-30'])).errs[0] as CliError).message).toContain('--effective');
    await expect(cli(['asset', 'retire', 'AF-2026-00007', '--entity', 'ent-1', '--undo'])).rejects.toThrow(/--reason <text>/);
    expect([vi.mocked(retireAsset).mock.calls.length, vi.mocked(undoAssetRetirement).mock.calls.length]).toEqual(before);
  });

  it('the refusals read as written, in both languages', () => {
    expect(t('error.VALIDATION_ERROR.asset.retire_effective_future', { effective: '2026-09-01', today: '2026-08-20' }, 'en')).toBe(
      "The retirement cannot take effect on 2026-09-01: today is 2026-08-20 in the entity's time zone, and a retired asset " +
        'stops depreciating at once. Run this command on that day. Nothing was changed.'
    );
    expect(t('error.VALIDATION_ERROR.asset.retire_not_active', { asset: 'AF-2026-00007', status: 'inactive' }, 'es')).toBe(
      'AF-2026-00007 está en estado inactive, no activo: no hay nada que retirar. Para devolverlo al uso: mnemosine asset ' +
        'retire AF-2026-00007 --undo --reason "...". No se cambió nada.'
    );
    expect(t('error.VALIDATION_ERROR.asset.retire_not_active', { asset: 'AF-2026-00007', status: 'disposed' }, 'en')).toBe(
      'AF-2026-00007 is disposed, not active: there is nothing to retire. Nothing was changed.'
    );
    expect(t('error.VALIDATION_ERROR.asset.retire_undo_not_retired', { asset: 'AF-2026-00007', status: 'inactive' }, 'en')).toBe(
      'AF-2026-00007 is inactive and the last change of its state is not an `asset retire`: there is nothing to undo. ' +
        'Nothing was changed.'
    );
    expect(
      t('error.VALIDATION_ERROR.asset.retire_effective_before_service', { asset: 'AF-2026-00007', effective: '2025-12-31', start: '2026-01-01' }, 'es')
    ).toBe(
      'AF-2026-00007 no se puede retirar con fecha 2025-12-31: su depreciación empieza el 2026-01-01. Un activo que nunca ' +
        'estuvo en servicio se corrige con `asset edit`. No se cambió nada.'
    );
  });
});
