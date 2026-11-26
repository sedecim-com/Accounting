import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// ============================================================
// I8.8 · the ap family speaks by key (MNE-001-227, #270, part 1: prepaid)
//
// One assertion per key of the I8.8 block that prepaid names, through the real
// leaves over doubles (the same doubles as prepaid-flujo.spec.ts, whose
// `query` throws), in English (the test locale is en-US) and once in es-MX.
// The currency is a parameter: each sentence that carried «MXN» is pinned with
// it in both languages. MNE-001-228 adds bill, payment, ap and vendor here.
// ============================================================

const { POLICY } = vi.hoisted(() => ({
  POLICY: {
    id: 'p1',
    kind: 'prepaid_expense' as const,
    entity_id: 'e1',
    description: 'Insurance policy 2026',
    vendor_name: 'Insurer SA',
    reference: 'POL-778',
    total_amount: '12000.0000',
    coverage_start_date: new Date(2026, 0, 1),
    coverage_end_date: new Date(2026, 11, 31),
    prepaid_account_id: 'c-1160',
    expense_account_id: 'c-6100',
    amortization_convention: 'proporcional_dias',
    origin: 'cfdi' as const,
    source_journal_entry_id: 'je-1',
    cfdi_uuid: null,
    amortized_to_date: '0.0000',
    remaining_amount: '12000.0000',
    last_amortization_date: null,
    status: 'active' as const,
    notes: null,
  },
}));

vi.mock('../../src/database/connection.js', () => ({
  query: () => {
    throw new Error('query must not be called');
  },
  currentTenant: () => 't1',
}));
vi.mock('../../src/ai/context.js', () => ({ bootstrapTenant: vi.fn() }));
vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: vi.fn(async () => ({ userId: 'u1', email: 'a@b.c' })),
}));
vi.mock('../../src/cli/kernel/entity-context.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveActiveEntity: vi.fn(async () => ({ ctx: { tenantId: 't1', entityId: 'e1' } })),
  requireExplicitEntity: vi.fn(async () => ({ tenantId: 't1', entityId: 'e1' })),
}));
vi.mock('../../src/services/accounting/fiscal-calendar-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolvePeriod: vi.fn(async () => ({ id: 'fp-2026-01', period_name: 'January 2026' })),
}));
vi.mock('../../src/services/accounting/account-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  resolveAccount: vi.fn(async (_e: string, ref: string) =>
    ref === 'c-6100' ? { id: 'c-6100', code: '6100', name: 'General expenses' } : { id: 'c-1160', code: '1160', name: 'Prepaid' }
  ),
}));
vi.mock('../../src/services/accruals/prepaid-service.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  criteriosDeAnticipo: vi.fn(async () => ({
    convencion: 'proporcional_dias',
    convencionDefinida: true,
    umbral: '5000.0000',
    umbralDefinido: true,
  })),
  registrarPagoAnticipado: vi.fn(async () => ({
    anticipo: { ...POLICY },
    calendario: [{}, {}],
    avisos: [],
  })),
  anticiposActivos: vi.fn(async () => [POLICY]),
  huecoDeAnticipados: vi.fn(async () => ({ hayHueco: false, hueco: '0', asientos: [] })),
  revisionDeAmortizacionAlCierre: vi.fn(async () => ({ pendientes: [{ id: 'p1' }] })),
}));
vi.mock('../../src/services/accruals/amortization-run.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  periodoDeLaCorrida: vi.fn(async () => ({
    id: 'fp-2026-01',
    inicio: new Date(2026, 0, 1),
    fin: new Date(2026, 0, 31),
    nombre: 'January 2026',
  })),
  runMonthlyAmortization: vi.fn(async () => ({ processed: 1, total: '1019.1781', skipped: 0, errors: [] })),
}));

import {
  PREPAID_CURRENCY,
  elegirAnticipo,
  exigirConvencionDelPanel,
  exigirFecha,
  exigirImporte,
  exigirOrigen,
  exigirPeriodo,
  filasPrevistas,
  skipReason,
  registerPrepaidCommand,
  renglonDelPeriodo,
  type RenglonOmitido,
} from '../../src/cli/prepaid-command.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import {
  anticiposActivos,
  criteriosDeAnticipo,
  huecoDeAnticipados,
  registrarPagoAnticipado,
  revisionDeAmortizacionAlCierre,
} from '../../src/services/accruals/prepaid-service.js';
import { runMonthlyAmortization } from '../../src/services/accruals/amortization-run.js';

type Localized = Error & { localized: (l: 'es' | 'en') => string };
const thrown = (fn: () => unknown): Localized => {
  try {
    fn();
  } catch (e) {
    return e as Localized;
  }
  throw new Error('it did not throw');
};

const pass = (s: string) => s;
const palette = { dim: pass, bold: pass, cyan: pass, red: pass, green: pass, yellow: pass };

let out = '';
let err = '';
beforeEach(() => {
  vi.clearAllMocks();
  out = '';
  err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err += String(c); return true; });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetLanguage();
});

function program(confirm?: (q: string) => Promise<boolean>) {
  const state: { code?: number; error?: Localized; cli: Command } = { cli: new Command('mnemosine').exitOverride() };
  registerPrepaidCommand(state.cli, {
    palette,
    shutdown: (c: number) => { state.code = c; },
    reportError: (e: unknown) => { state.error = e as Localized; },
    ...(confirm ? { confirm } : {}),
  });
  return state;
}
async function run(argv: string[], confirm?: (q: string) => Promise<boolean>) {
  const state = program(confirm);
  await state.cli.parseAsync(['node', 'mnemosine', 'prepaid', ...argv, '-e', 'e1']);
  return state;
}

describe('I8.8 · prepaid: the currency is a parameter', () => {
  it('is the books\' pesos, one constant', () => {
    expect(PREPAID_CURRENCY).toBe('MXN');
  });
});

describe('I8.8 · prepaid flag errors speak by key', () => {
  it('ap.prepaid.flag.date_invalid', () => {
    const e = thrown(() => exigirFecha('--start', '2026-02-31'));
    expect(e.message).toBe('--start must be a real date in YYYY-MM-DD form; got "2026-02-31".');
    expect(e.localized('es')).toBe('--start debe ser una fecha real en formato YYYY-MM-DD; llegó "2026-02-31".');
  });

  it('ap.prepaid.flag.amount_invalid', () => {
    const e = thrown(() => exigirImporte('--amount', '-100'));
    expect(e.message).toMatch(/^--amount must be an unsigned decimal amount; got "-100"\. The point separates/);
    expect(e.localized('es')).toMatch(/^--amount debe ser un importe decimal sin signo; llegó "-100"\./);
  });

  it('ap.prepaid.run.period_missing', () => {
    const e = thrown(() => exigirPeriodo(undefined));
    expect(e.message).toMatch(/^Missing --period\. .*would accrue the month that has just begun\.$/);
    expect(e.localized('es')).toMatch(/^Falta --period\. .*devengaría el mes que acaba de empezar\.$/);
  });

  it('ap.prepaid.create.origin_missing and origin_unknown', () => {
    const missing = thrown(() => exigirOrigen(undefined));
    expect(missing.message).toMatch(/^Missing --origin\. The three origins are: cfdi, manual, saldo_preexistente — /);
    expect(missing.localized('es')).toMatch(/^Falta --origin\. Los tres orígenes son: cfdi, manual, saldo_preexistente — /);
    const unknown = thrown(() => exigirOrigen('factura'));
    expect(unknown.message).toBe('--origin "factura" does not exist. The three are: cfdi, manual, saldo_preexistente.');
    expect(unknown.localized('es')).toBe('--origin "factura" no existe. Los tres son: cfdi, manual, saldo_preexistente.');
  });

  it('ap.prepaid.create.convention_unknown names the two conventions', () => {
    const e = thrown(() => exigirConvencionDelPanel('lineal', { convencion: 'proporcional_dias', convencionDefinida: true }));
    expect(e.message).toBe(
      '--convention "lineal" does not exist: the two conventions are proporcional_dias and meses_completos (the days each month covers, or the whole month).'
    );
    expect(e.localized('es')).toBe(
      '--convention "lineal" no existe: las dos convenciones son proporcional_dias y meses_completos (los días que cada mes cubre, o el mes entero).'
    );
  });

  it('ap.prepaid.create.convention_contradicts_panel, answered and by default', () => {
    const answered = thrown(() =>
      exigirConvencionDelPanel('meses_completos', { convencion: 'proporcional_dias', convencionDefinida: true })
    );
    expect(answered.message).toMatch(
      /^--convention meses_completos contradicts the panel: `amortizacion_anticipados_convencion` is "proporcional_dias", and that is what is frozen/
    );
    const byDefault = thrown(() =>
      exigirConvencionDelPanel('meses_completos', { convencion: 'proporcional_dias', convencionDefinida: false })
    );
    expect(byDefault.message).toMatch(/is "proporcional_dias" \(declared default, nobody has answered\), and/);
    expect(byDefault.localized('es')).toMatch(
      /^--convention meses_completos contradice al panel: .* vale "proporcional_dias" \(defecto declarado, nadie ha contestado\), y es lo que se congela/
    );
  });

  it('ap.prepaid.show.not_found and ambiguous', () => {
    const none = thrown(() => elegirAnticipo([POLICY], 'license'));
    expect(none.message).toBe('No live schedule matches "license" in this entity. `mnemosine prepaid list -a` lists them all.');
    expect(none.localized('es')).toBe(
      'No hay ningún calendario vivo que case con "license" en esta entidad. `mnemosine prepaid list -a` los enumera todos.'
    );
    const two = thrown(() => elegirAnticipo([POLICY, { ...POLICY, id: 'p3' }], 'insurance'));
    expect(two.message).toBe(
      '"insurance" matches 2 live schedules: Insurance policy 2026 [p1], Insurance policy 2026 [p3]. Name the id, or a piece of the description that matches only one.'
    );
    expect(two.localized('es')).toMatch(/^"insurance" casa con 2 calendarios vivos: .*\. Nombra el id/);
  });
});

describe('I8.8 · prepaid omission reasons are codes, said by key', () => {
  const at = (overrides: Partial<typeof POLICY>, month: Date) =>
    renglonDelPeriodo({ ...POLICY, ...overrides } as never, month) as RenglonOmitido;

  it('ap.prepaid.skip.*, in both languages', () => {
    const cases: Array<[RenglonOmitido, string, string, string]> = [
      [at({ amortization_convention: 'lineal' }, new Date(2026, 0, 1)), 'unknown_convention', 'unknown stored convention ("lineal")', 'convención guardada desconocida ("lineal")'],
      [at({}, new Date(2025, 11, 1)), 'not_started', 'the coverage has not started yet', 'la cobertura todavía no empieza'],
      [at({}, new Date(2027, 0, 1)), 'ended', 'the coverage has already ended', 'la cobertura ya terminó'],
      [at({ remaining_amount: '0.0000' }, new Date(2026, 0, 1)), 'nothing_left', 'no balance is left to accrue', 'no queda saldo por devengar'],
    ];
    for (const [p, cause, en, es] of cases) {
      expect(p.cause).toBe(cause);
      expect(skipReason(p)).toBe(en);
      expect(skipReason(p, 'es')).toBe(es);
    }
    const zero: RenglonOmitido = { estado: 'omitido', id: 'z', description: 'z', cause: 'zero_row', storedConvention: '' };
    expect(skipReason(zero)).toBe('the row of the month is zero');
    expect(skipReason(zero, 'es')).toBe('el renglón del mes es cero');
  });

  it('the motivo column stays English under es-MX, for scripts', () => {
    setLanguage('es');
    const rows = filasPrevistas([at({}, new Date(2027, 0, 1))]);
    expect(rows[0].motivo).toBe('the coverage has already ended');
  });
});

describe('I8.8 · prepaid run speaks by key', () => {
  it('the dry run: header, entries note, dry-run line', async () => {
    const s = await run(['run', '--period', '2026-01', '--dry-run']);
    expect(s.code).toBe(0);
    expect(err).toContain(
      'January 2026 (2026-01-01..2026-01-31) · entries dated 2026-01-31 · 1 schedule enters, 0 skipped, 0 already have a row this month · total 1019.1781\n'
    );
    expect(err).toContain('1 two-line adjusting entry, one per schedule — not one for the run. Reversing this run takes 1 reversal.\n');
    expect(err).toContain('Dry run: the ledger was not touched and no row was written.\n');
    expect(runMonthlyAmortization).not.toHaveBeenCalled();
  });

  it('the same dry run in es-MX, with plurals instead of «(s)»', async () => {
    setLanguage('es');
    vi.mocked(anticiposActivos).mockResolvedValueOnce([POLICY, { ...POLICY, id: 'p2' }]);
    vi.mocked(revisionDeAmortizacionAlCierre).mockResolvedValueOnce({ pendientes: [{ id: 'p1' }, { id: 'p2' }] } as never);
    await run(['run', '--period', '2026-01', '--dry-run']);
    expect(err).toContain('· 2 calendarios entran, 0 se omiten, 0 ya tienen renglón de este mes · total 2038.3562\n');
    expect(err).toContain('2 asientos de ajuste de dos líneas, uno por calendario — no uno de la corrida. Reversar esta corrida son 2 reversas.\n');
    expect(err).toContain('Ensayo: el mayor no se tocó y no se escribió ningún renglón.\n');
  });

  it('the confirmation carries the currency as a parameter, and a no aborts', async () => {
    const asked: string[] = [];
    const s = await run(['run', '--period', '2026-01'], async (q) => { asked.push(q); return false; });
    expect(asked[0]).toBe('Accrue 1019.18 MXN in 1 entry of January 2026? The ledger cannot be undone.');
    expect(s.code).toBe(10);
    expect(s.error?.message).toMatch(/^No changes: (the ledger was not touched\.|there is no terminal to confirm in\.)/);
    setLanguage('es');
    asked.length = 0;
    const es = await run(['run', '--period', '2026-01'], async (q) => { asked.push(q); return false; });
    expect(asked[0]).toBe('¿Devengar 1019.18 MXN en 1 asiento de January 2026? El mayor no admite deshacer.');
    expect(es.error?.localized('es')).toMatch(/^Sin cambios: /);
  });

  it('ap.prepaid.run.aborted and aborted_no_tty, by key', async () => {
    const tty = process.stdin.isTTY;
    try {
      Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
      const a = await run(['run', '--period', '2026-01'], async () => false);
      expect(a.error?.message).toBe('No changes: the ledger was not touched.');
      expect(a.error?.localized('es')).toBe('Sin cambios: el mayor no se tocó.');
      Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
      const b = await run(['run', '--period', '2026-01'], async () => false);
      expect(b.error?.message).toBe(
        'No changes: there is no terminal to confirm in. Add -y to accrue without asking, or --dry-run to see the full entries without writing anything.'
      );
      expect(b.error?.localized('es')).toMatch(/^Sin cambios: no hay terminal donde confirmar\. Añade -y/);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }
  });

  it('ap.prepaid.run.done, and both mismatches against the preview', async () => {
    await run(['run', '--period', '2026-01', '-y']);
    expect(err).toContain('✔ 1 accrual entry posted in January 2026 for 1019.1781.\n');
    err = '';
    vi.mocked(runMonthlyAmortization).mockResolvedValueOnce({ processed: 2, total: '2000.0000', skipped: 0, errors: [] } as never);
    await run(['run', '--period', '2026-01', '-y']);
    expect(err).toContain(
      '⚠ The preview showed 1 entry and the run made 2. The preview and the engine did not agree: review the errors before calling the month closed.\n'
    );
    expect(err).toContain('⚠ The preview added up to 1019.1781 and the run accrued 2000.0000.\n');
    expect(err).toContain('✔ 2 accrual entries posted in January 2026 for 2000.0000.\n');
    setLanguage('es');
    err = '';
    vi.mocked(runMonthlyAmortization).mockResolvedValueOnce({ processed: 2, total: '2000.0000', skipped: 0, errors: [] } as never);
    await run(['run', '--period', '2026-01', '-y']);
    expect(err).toContain('⚠ La vista previa enseñaba 1 asiento y la corrida hizo 2.');
    expect(err).toContain('⚠ La vista previa sumaba 1019.1781 y la corrida devengó 2000.0000.\n');
    expect(err).toContain('✔ 2 asientos de devengo contabilizados en January 2026 por 2000.0000.\n');
  });

  it('a capped row and a skipped row, by key', async () => {
    vi.mocked(anticiposActivos).mockResolvedValueOnce([
      { ...POLICY, remaining_amount: '500.0000' },
      { ...POLICY, id: 'p2', description: 'Old lease', coverage_end_date: new Date(2025, 11, 31), coverage_start_date: new Date(2025, 0, 1) },
    ]);
    vi.mocked(revisionDeAmortizacionAlCierre).mockResolvedValueOnce({ pendientes: [{ id: 'p1' }, { id: 'p2' }] } as never);
    await run(['run', '--period', '2026-01', '--dry-run']);
    expect(err).toContain('· Old lease skipped: the coverage has already ended\n');
    expect(err).toContain(
      '⚠ Insurance policy 2026: the theoretical row is 1019.1781 and is capped at 500.0000 against what is left to accrue.\n'
    );
    setLanguage('es');
    err = '';
    vi.mocked(anticiposActivos).mockResolvedValueOnce([
      { ...POLICY, id: 'p2', description: 'Old lease', coverage_end_date: new Date(2025, 11, 31), coverage_start_date: new Date(2025, 0, 1) },
      POLICY,
    ]);
    vi.mocked(revisionDeAmortizacionAlCierre).mockResolvedValueOnce({ pendientes: [{ id: 'p1' }, { id: 'p2' }] } as never);
    await run(['run', '--period', '2026-01', '--dry-run']);
    expect(err).toContain('· omitido Old lease: la cobertura ya terminó\n');
  });

  it('nothing to accrue: the note by key, the table in the user language, --json in English', async () => {
    const ended = { ...POLICY, coverage_start_date: new Date(2025, 0, 1), coverage_end_date: new Date(2025, 11, 31) };
    vi.mocked(anticiposActivos).mockResolvedValue([ended]);
    await run(['run', '--period', '2026-01', '--dry-run']);
    expect(err).toContain('Nothing to accrue in January 2026: the ledger was not touched.\n');
    setLanguage('es');
    out = '';
    err = '';
    await run(['run', '--period', '2026-01', '--dry-run']);
    expect(err).toContain('Nada que devengar en January 2026: el mayor no se tocó.\n');
    expect(out).toContain('la cobertura ya terminó');
    out = '';
    await run(['run', '--period', '2026-01', '--dry-run', '--json']);
    expect(out).toContain('the coverage has already ended');
    expect(out).not.toContain('la cobertura ya terminó');
    vi.mocked(anticiposActivos).mockResolvedValue([POLICY]);
  });

  it('states what it writes in English', () => {
    const cli = program().cli;
    const leaf = (n: string) => cli.commands.find((c) => c.name() === 'prepaid')!.commands.find((c) => c.name() === n)!;
    expect(riskOf(leaf('run'))?.writes).toBe(
      'journal_entries + journal_entry_lines (one adjusting entry per prepaid), prepaid_amortization_schedules, prepaid_expenses'
    );
    expect(riskOf(leaf('create'))?.writes).toBe(
      'prepaid_expenses (the schedule header); no journal entry — the charge is already in the ledger'
    );
  });
});

describe('I8.8 · prepaid create speaks by key', () => {
  const BASE = ['create', 'Insurance policy 2026', '--amount', '12000', '--start', '2026-01-01', '--end', '2026-12-31'];

  it('ap.prepaid.create.flags_missing: one flag and four', async () => {
    const four = await run(['create', 'Something']);
    expect(four.error?.message).toMatch(/^Missing --amount, --start, --end, --origin\. A schedule with no amount/);
    expect(four.error?.localized('es')).toMatch(/^Faltan --amount, --start, --end, --origin\. Un calendario sin importe/);
    const one = await run([...BASE]);
    expect(one.error?.localized('es')).toMatch(/^Falta --origin\. Un calendario/);
  });

  it('ap.prepaid.create.cfdi_needs_source_entry', async () => {
    const s = await run([...BASE, '--origin', 'cfdi']);
    expect(s.error?.message).toMatch(/^`--origin cfdi` needs `--source-entry <id>`: if the schedule is born from a bill already posted/);
    expect(s.error?.localized('es')).toMatch(/^`--origin cfdi` exige `--source-entry <id>`: si el calendario nace/);
  });

  it('the dry run: criteria header, below threshold, what it computed, what it cannot check', async () => {
    await run(['create', 'Annual subscription', '--amount', '900', '--start', '2026-01-01', '--end', '2026-12-31', '--origin', 'manual', '--dry-run']);
    expect(err).toContain('convention proporcional_dias · threshold 5000.00 MXN\n');
    expect(err).toContain(
      '⚠ 900.00 is below the threshold of 5000.00 MXN (`umbral_anticipado_mxn`): the real creation would stop for materiality (NIF A-4).'
    );
    expect(err).toContain('Dry run: no row was written. 12 rows for 900.00 MXN, convention proporcional_dias.\n');
    expect(err).toContain('The dry run does NOT check the backing in the account —how much posted balance is left with no schedule—');
    expect(registrarPagoAnticipado).not.toHaveBeenCalled();
  });

  it('the criteria header says which key rules by default, in both languages', async () => {
    vi.mocked(criteriosDeAnticipo).mockResolvedValueOnce({
      convencion: 'proporcional_dias', convencionDefinida: false, umbral: '5000.0000', umbralDefinido: false,
    } as never);
    await run([...BASE, '--origin', 'manual', '--dry-run']);
    expect(err).toContain('convention proporcional_dias (default) · threshold 5000.00 MXN (default)\n');
    expect(err).toContain('⚠ At least one declared default rules, not a choice of the firm.');
    setLanguage('es');
    err = '';
    vi.mocked(criteriosDeAnticipo).mockResolvedValueOnce({
      convencion: 'proporcional_dias', convencionDefinida: true, umbral: '5000.0000', umbralDefinido: false,
    } as never);
    await run([...BASE, '--origin', 'manual', '--dry-run']);
    expect(err).toContain('convención proporcional_dias · umbral 5000.00 MXN (defecto)\n');
    expect(err).toContain('⚠ Rige al menos un defecto declarado y no una elección del despacho.');
    expect(err).toContain('Ensayo: no se escribió ninguna fila. 12 renglones por 12000.00 MXN, convención proporcional_dias.\n');
    expect(err).toContain('El ensayo NO comprueba el respaldo en la cuenta');
  });

  it('ap.prepaid.create.done, singular and plural', async () => {
    await run([...BASE, '--origin', 'manual']);
    expect(err).toContain(
      '✔ Schedule of 2 rows created. The ledger was not touched: the charge was already there. It is accrued with `mnemosine prepaid run --period <month>`.\n'
    );
    setLanguage('es');
    err = '';
    vi.mocked(registrarPagoAnticipado).mockResolvedValueOnce({ anticipo: { ...POLICY }, calendario: [{}], avisos: [] } as never);
    await run([...BASE, '--origin', 'manual']);
    expect(err).toContain('✔ Calendario de 1 renglón dado de alta. El mayor no se tocó');
  });
});

describe('I8.8 · prepaid list and show speak by key', () => {
  it('ap.prepaid.list.none_alive and none_on_date', async () => {
    vi.mocked(anticiposActivos).mockResolvedValueOnce([]);
    await run(['list', '-a']);
    expect(err).toContain('There is no live schedule in this entity.\n');
    await run(['list', '--as-of', '2030-01-01']);
    expect(err).toContain('No schedule covers 2030-01-01. With -a all of them are listed.\n');
    setLanguage('es');
    await run(['list', '--as-of', '2030-01-01']);
    expect(err).toContain('Ningún calendario cubre el 2030-01-01. Con -a se listan todos.\n');
  });

  it('ap.prepaid.gap.warning carries the currency and counts its entries', async () => {
    const entry = { journal_entry_id: 'je-9', entry_number: 'JE-2025-00311', description: 'Fleet', cargo: '40000.0000' };
    vi.mocked(huecoDeAnticipados).mockResolvedValueOnce({ hayHueco: true, hueco: '40000.0000', asientos: [entry] } as never);
    await run(['list']);
    expect(err).toContain(
      '⚠ 40000.00 MXN posted to the prepaid expenses account that no schedule will accrue, in 1 entry. That expense will never reach the income statement.'
    );
    setLanguage('es');
    vi.mocked(huecoDeAnticipados).mockResolvedValueOnce({ hayHueco: true, hueco: '40000.0000', asientos: [entry, entry] } as never);
    await run(['list']);
    expect(err).toContain('⚠ 40000.00 MXN posteados en la cuenta de pagos anticipados que ningún calendario va a devengar, en 2 asientos.');
  });

  it('ap.prepaid.show.summary and rows_are_schedule', async () => {
    await run(['show', 'insurance']);
    expect(err).toContain('Insurance policy 2026 · 12000.00 MXN · proporcional_dias · origin cfdi · accrued 0.00, 12000.00 left\n');
    expect(err).toContain('The rows are the schedule the run will follow, not what was already posted');
    setLanguage('es');
    await run(['show', 'insurance']);
    expect(err).toContain('Insurance policy 2026 · 12000.00 MXN · proporcional_dias · origen cfdi · devengado 0.00, queda 12000.00\n');
    expect(err).toContain('Los renglones son el calendario que la corrida seguirá, no lo ya posteado');
  });

  it('ap.prepaid.show.unknown_convention', async () => {
    vi.mocked(anticiposActivos).mockResolvedValueOnce([{ ...POLICY, amortization_convention: 'lineal' }]);
    const s = await run(['show', 'insurance']);
    expect(s.error?.message).toBe(
      'The schedule "Insurance policy 2026" stores the convention "lineal", which is none of the declared ones (proporcional_dias, meses_completos). No amount can be computed with it.'
    );
    expect(s.error?.localized('es')).toMatch(/^El calendario "Insurance policy 2026" guarda la convención "lineal"/);
  });
});
