import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { FiscalPeriodStatus } from '../../src/types/index.js';
import { Command } from 'commander';

// The action of `payroll accrue` runs against doubles of what it reads and
// writes (MNE-001-221): the pure helpers below import none of these modules,
// so their cases are unaffected.
vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: vi.fn(),
  resolveEntity: vi.fn(async () => ({
    entityId: 'ent-1', entityName: 'Demo Nomina SA', tenantId: 'ten-1', currency: 'MXN',
    country: 'MX', accountingStandard: 'NIF', taxId: 'X',
  })),
  listEntities: vi.fn(async () => [{ id: 'ent-1' }]),
}));
vi.mock('../../src/ai/draft-service.js', () => ({ resolveReviewer: vi.fn(async () => ({ userId: 'u-1' })) }));
vi.mock('../../src/services/accounting/fiscal-calendar-service.js', () => ({ resolvePeriod: vi.fn(async () => ({ id: 'p3' })) }));
vi.mock('../../src/services/accounting/account-service.js', () => ({
  resolveAccount: vi.fn(async (_entity: string, id: string) => ({ code: id, name: 'Cuenta' })),
}));
vi.mock('../../src/services/idempotency/idempotency-store.js', () => ({
  mirarLlave: vi.fn(async () => undefined),
  conLlave: vi.fn(async (_ctx: unknown, _act: unknown, fn: () => Promise<unknown>) => ({ repetido: false, resultado: await fn() })),
  hashDeCarga: vi.fn(() => 'hash'),
}));
vi.mock('../../src/database/connection.js', () => ({ query: vi.fn(async () => ({ rows: [] })) }));
vi.mock('../../src/services/accruals/provisions-run.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/accruals/provisions-run.js')>()),
  planMonthlyProvisions: vi.fn(),
  runMonthlyProvisions: vi.fn(),
  cuentasDeProvisiones: vi.fn(),
}));
vi.mock('node:readline/promises', () => ({
  createInterface: vi.fn(() => ({ question: vi.fn(async () => 'quizá'), close: vi.fn() })),
}));

import {
  criteriosParaLeer,
  filasDeLaCedula,
  filasDelAsiento,
  registerPayrollCommand,
  requirePeriod,
  skipReasonLabel,
} from '../../src/cli/payroll-command.js';
import { ExitCode, type CliError } from '../../src/cli/kernel/index.js';
import { riskOf, resetDeclarations } from '../../src/cli/kernel/risk.js';
import * as provisions from '../../src/services/accruals/provisions-run.js';
import * as store from '../../src/services/idempotency/idempotency-store.js';
import { query } from '../../src/database/connection.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import type { ProvisionPlan } from '../../src/services/accruals/provisions-run.js';

// ============================================================
// LA HOJA DEL DEVENGO, POR SUS PIEZAS PURAS
//
// Lo que esta batería NO hace es probar el devengo: eso lo prueban la
// aritmética (55 casos unitarios) y el mayor de verdad
// (tests/integration/d1-devengo-en-la-terminal.int.spec.ts). Aquí se prueba lo
// que es del TECLADO y no del motor: que el mes no se adivine, que la cédula
// nombre a los omitidos con su motivo, que el asiento previsto sea el que se
// va a postear —líneas en cero incluidas, o mejor dicho excluidas— y que la
// declaración de riesgo diga lo que la hoja hace.
// ============================================================

const TRAMO = {
  desde: '2026-03-01',
  hasta: '2026-03-31',
  dias: 31,
  anio_de_servicio: 5,
  dias_de_vacaciones: 20,
  salario_diario: '1000.0000',
};

function planDePrueba(parcial: Partial<ProvisionPlan> = {}): ProvisionPlan {
  const worker = (numero: string, nombre: string) =>
    ({
      id: `id-${numero}`,
      employee_number: numero,
      nombre,
      hire_date: new Date(2021, 2, 10),
      termination_date: null,
      status: 'active',
      annual_salary: '365000.00',
      sbc: null,
    }) as ProvisionPlan['rows'][number]['worker'];

  return {
    tenantId: 't',
    periodo: {
      id: 'p3',
      inicio: new Date(2026, 2, 1),
      fin: new Date(2026, 2, 31),
      nombre: 'Periodo 3/2026',
      numero: 3,
      tipo: 'regular',
      estado: FiscalPeriodStatus.OPEN,
    },
    criterios: {
      base_salarial: 'nominal',
      convencion_vacaciones: 'proporcional',
      dias_aguinaldo: 15,
      prima_vacacional_pct: '25',
      ptu_mensual: 'no',
      definidas: {
        provision_base_salarial: true,
        devengo_vacaciones: false,
        dias_aguinaldo: true,
        prima_vacacional_pct: true,
        provision_ptu_mensual: false,
      },
    },
    rows: [
      {
        worker: worker('A-ANA', 'Ana Prueba'),
        provision: {
          base_salarial: 'nominal',
          convencion_vacaciones: 'proporcional',
          dias_devengados: 31,
          tramos: [TRAMO] as never,
          aguinaldo: '1273.9726',
          vacaciones: '1819.1781',
          prima_vacacional: '454.7945',
          total: '3547.9452',
        },
        salary: { diario: '1000.0000', sbc: undefined, fuente: 'annual_salary' },
      },
    ],
    skipped: [
      { worker: worker('A-BETO', 'Beto Prueba'), reason: 'already-accrued' },
      { worker: worker('A-CIRO', 'Ciro Prueba'), reason: 'zero-month' },
    ],
    errors: [],
    aguinaldo: '1273.9726',
    vacaciones: '1819.1781',
    prima_vacacional: '454.7945',
    total: '3547.9452',
    ...parcial,
  };
}

const CUENTAS = {
  gasto: 'c-gasto',
  aguinaldo: 'c-aguinaldo',
  vacaciones: 'c-vacaciones',
  prima_vacacional: 'c-prima',
};

describe('requirePeriod — el mes se teclea, no se adivina del reloj', () => {
  it('sin --period es error de USO y dice por qué no se supone', () => {
    // La razón es la misma que en la hoja gemela y no es teórica: correr «el
    // periodo actual» un día 1 a las 00:05 devengaría el mes que empieza.
    expect(() => requirePeriod(undefined)).toThrow(/--period is missing/);
    expect(() => requirePeriod(undefined)).toThrow(/the month that has just begun/);
    try {
      requirePeriod(undefined);
    } catch (err) {
      expect((err as CliError).exitCode).toBe(ExitCode.USAGE);
      expect((err as CliError).localized('es')).toContain('Falta --period');
    }
  });

  it('con periodo lo devuelve tal cual: quién lo resuelve es el calendario', () => {
    expect(requirePeriod('2026-03')).toBe('2026-03');
  });
});

describe('la cédula que el operador lee antes de postear', () => {
  it('un renglón por trabajador, y los omitidos salen NOMBRADOS con su motivo', () => {
    const filas = filasDeLaCedula(planDePrueba());
    expect(filas).toHaveLength(3);
    expect(filas[0]).toMatchObject({
      empleado: 'A-ANA',
      estado: 'devenga',
      dias: 31,
      aguinaldo: '1273.9726',
      total: '3547.9452',
    });
    // Los dos motivos legítimos significan cosas distintas —«ya se devengó» y
    // «su aritmética dio cero»— y un contador que ve a alguien fuera de la
    // cédula necesita saber cuál le tocó sin volver a consultar la base.
    expect(filas[1]).toMatchObject({ empleado: 'A-BETO', estado: 'omitido' });
    // MNE-001-221: the row is the machine's, so its reason is the English
    // catalogue under any locale; only the table renders it in the user's.
    expect(filas[1].motivo).toBe('already has a live row for this month');
    expect(filas[2].motivo).toBe('its accrual for the month is zero');
    try {
      setLanguage('es');
      expect(filasDeLaCedula(planDePrueba())[1].motivo).toBe('already has a live row for this month');
      expect(skipReasonLabel('already has a live row for this month')).toBe('ya tiene renglón vigente de este mes');
      expect(skipReasonLabel('its accrual for the month is zero')).toBe('su devengo del mes es cero');
      expect(skipReasonLabel('')).toBe('');
    } finally {
      resetLanguage();
    }
  });

  it('el total por trabajador es la suma de sus tres conceptos, con Decimal', () => {
    const [ana] = filasDeLaCedula(planDePrueba());
    // 1273.9726 + 1819.1781 + 454.7945. Con Number esto sale 3547.945199…
    expect(ana.total).toBe('3547.9452');
  });
});

describe('el asiento que se enseña es el que se va a postear', () => {
  it('un cargo al gasto por el total y un abono por concepto, con sus descripciones', () => {
    const filas = filasDelAsiento(planDePrueba(), (id) => `código de ${id}`, CUENTAS);
    expect(filas).toHaveLength(4);
    expect(filas[0]).toMatchObject({
      cuenta: 'código de c-gasto',
      descripcion: 'Benefit provisions - 1 employee(s)',
      debe: '3547.9452',
      haber: '',
    });
    expect(filas.map((f) => f.descripcion)).toEqual([
      'Benefit provisions - 1 employee(s)',
      'Aguinaldo accrual (LFT art. 87)',
      'Vacation accrual (LFT art. 76)',
      'Vacation premium accrual (LFT art. 80)',
    ]);
    // La fecha es la del ÚLTIMO DÍA del periodo corrido: el devengo es de mes
    // cerrado, y `createJournalEntry` deduce el periodo fiscal DE LA FECHA.
    expect(filas.every((f) => f.fecha === '2026-03-31')).toBe(true);
  });

  it('el concepto en cero NO produce línea: los CHECK exigen importes positivos', () => {
    // Bajo la convención `aniversario` las vacaciones valen cero once meses de
    // cada doce. Una previa que enseñara la línea prometería un asiento que el
    // esquema rechaza.
    const filas = filasDelAsiento(
      planDePrueba({ vacaciones: '0.0000', total: '1728.7671' }),
      (id) => id,
      CUENTAS
    );
    expect(filas.map((f) => f.cuenta)).toEqual(['c-gasto', 'c-aguinaldo', 'c-prima']);
    expect(filas.map((f) => f.linea)).toEqual([1, 2, 3]);
  });
});

describe('el panel que gobernó el importe viaja con el resultado', () => {
  it('cada clave dice su valor Y si alguien la contestó de verdad', () => {
    // «Devengamos sobre el nominal» y «nadie contestó y el sistema usó el
    // nominal» son dos frases distintas delante de un auditor.
    const c = criteriosParaLeer(planDePrueba().criterios);
    expect(c.provision_base_salarial).toEqual({ valor: 'nominal', definida: true });
    expect(c.devengo_vacaciones).toEqual({ valor: 'proporcional', definida: false });
    expect(c.dias_aguinaldo).toEqual({ valor: 15, definida: true });
  });
});

describe('la declaración de riesgo de la hoja', () => {
  it('es irreversible, el agente NO puede llamarla, y honra la llave bajo su ámbito', () => {
    const p = new Command('mnemosine');
    registerPayrollCommand(p, {
      palette: {
        dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
        red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
      },
      shutdown: () => undefined,
      reportError: () => undefined,
    });
    const hoja = p.commands
      .find((c) => c.name() === 'payroll')!
      .commands.find((c) => c.name() === 'accrue')!;
    const r = riskOf(hoja)!;
    // Postea al mayor de la 041, donde un asiento no se edita ni se borra.
    expect(r.risk).toBe('irreversible');
    expect(r.agentAllowed).toBe(false);
    expect(r.llave).toEqual({ scope: 'payroll accrue' });
    expect(r.writes).toMatch(/ONE adjusting entry per run/);
    // Las tres banderas que su clase de riesgo obliga a llevar.
    const largos = hoja.options.map((o) => o.long);
    expect(largos).toEqual(expect.arrayContaining(['--dry-run', '--yes', '--idempotency-key']));
  });
});

// ============================================================
// I8.4 · payroll accrue speaks by key (MNE-001-221, #266)
//
// The action, end to end against doubles: every line it writes to a person
// comes from the I8.4 block, in English under the suite's en-US and in
// Spanish when the language is pinned. Texts written by hand, before the code.
// ============================================================
const PALETTE = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

async function accrue(args: string[], confirm?: (q: string) => Promise<boolean>) {
  resetDeclarations();
  let code: number | undefined;
  const errs: unknown[] = [];
  const program = new Command('mnemosine').exitOverride();
  registerPayrollCommand(program, {
    palette: PALETTE,
    shutdown: (c: number) => { code = c; },
    reportError: (e: unknown) => { errs.push(e); },
    home: '/tmp/mnemosine-tests-no-home',
    ...(confirm ? { confirm } : {}),
  });
  let out = '';
  let err = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err += String(c); return true; });
  try {
    await program.parseAsync(['node', 'mnemosine', 'payroll', 'accrue', '--entity', 'ent-1', '--period', '2026-03', ...args]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { code, out, err, errs };
}

describe('I8.4 · payroll accrue speaks by key', () => {
  beforeEach(() => {
    vi.mocked(provisions.planMonthlyProvisions).mockResolvedValue(planDePrueba());
    vi.mocked(provisions.cuentasDeProvisiones).mockResolvedValue(CUENTAS as never);
    vi.mocked(store.mirarLlave).mockResolvedValue(undefined);
    vi.mocked(provisions.runMonthlyProvisions).mockResolvedValue({
      processed: 3, skipped: 0, total: '1000.0000', errors: [], journalEntryId: 'je-9',
    } as never);
  });
  afterEach(() => resetLanguage());

  it('the dry run says the summary, the criteria, the default warning, the entry heading and the dry run', async () => {
    const r = await accrue(['--dry-run']);
    expect(r.err).toContain(
      'Periodo 3/2026 (2026-03-01..2026-03-31) · entry dated 2026-03-31 · 1 worker accrues, 2 are skipped · ' +
        'aguinaldo 1273.9726 · vacation 1819.1781 · premium 454.7945 · total 3547.9452'
    );
    expect(r.err).toContain('salary base nominal · vacation proporcional (default) · aguinaldo 15 days · premium 25');
    expect(r.err).toContain('  ⚠ At least one declared default governs here, not a choice of the firm');
    expect(r.err).toContain("The run's single entry, 4 lines:");
    expect(r.err).toContain('Dry run: the ledger was not touched and no schedule row was written.');
    expect(r.out).toContain('already has a live row for this month');
  });

  it('the dry run in Spanish, with its plurals and its Spanish reason in the table', async () => {
    setLanguage('es');
    const r = await accrue(['--dry-run']);
    expect(r.err).toContain('asiento con fecha 2026-03-31 · 1 trabajador devenga, 2 se omiten');
    expect(r.err).toContain('vacaciones proporcional (defecto) · aguinaldo 15 días');
    expect(r.out).toContain('ya tiene renglón vigente de este mes');
  });

  it('--json keeps the English reason under es-MX', async () => {
    setLanguage('es');
    const r = await accrue(['--dry-run', '--json']);
    expect(r.out).toContain('already has a live row for this month');
    expect(r.out).not.toContain('ya tiene renglón vigente');
  });

  it('an empty plan has nothing to accrue', async () => {
    vi.mocked(provisions.planMonthlyProvisions).mockResolvedValue(planDePrueba({ rows: [], total: '0.0000' }));
    const r = await accrue([]);
    expect(r.err).toContain('Nothing to accrue in Periodo 3/2026: the ledger was not touched and no schedule row was written.');
  });

  it('a spent key whose entry is live returns the recorded result', async () => {
    vi.mocked(store.mirarLlave).mockResolvedValue({ processed: 1, skipped: 0, total: '3547.9452', errors: [], journalEntryId: 'je-1' });
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ uno: 1 }] } as never);
    const r = await accrue(['--idempotency-key', 'k1', '--yes']);
    expect(r.err).toContain('Idempotency key already spent: the recorded result is returned and nothing was accrued again.');
  });

  it('a spent key whose entry was reversed is refused, in both languages', async () => {
    vi.mocked(store.mirarLlave).mockResolvedValue({ processed: 1, skipped: 0, total: '3547.9452', errors: [], journalEntryId: 'je-1' });
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as never);
    const r = await accrue(['--idempotency-key', 'k1', '--yes']);
    const e = r.errs[0] as CliError;
    expect(e.message).toContain('The key "k1" recorded entry je-1, which was reversed afterwards.');
    expect(e.localized('es')).toContain('La llave «k1» grabó el asiento je-1, que después se reversó.');
  });

  it('asks with the amount, the workers and the period, in both languages', async () => {
    const asked: string[] = [];
    await accrue([], async (q) => { asked.push(q); return true; });
    setLanguage('es');
    await accrue([], async (q) => { asked.push(q); return true; });
    expect(asked).toEqual([
      'Accrue 3547.95 MXN for 1 worker in Periodo 3/2026? The ledger does not allow undoing it.',
      '¿Devengar 3547.95 MXN de 1 trabajador en Periodo 3/2026? El mayor no admite deshacer.',
    ]);
  });

  it('a refusal without a terminal says how to go on', async () => {
    const r = await accrue([], async () => false);
    expect((r.errs[0] as CliError).message).toContain('Nothing changed: there is no terminal to confirm on.');
  });

  it('on a terminal, an answer it cannot read is taken as a no, and the ledger is untouched', async () => {
    const tty = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const r = await accrue([]);
      expect(r.err).toContain('did not understand “quizá”: answer y or yes for yes, n or no for no; I take it as a no.');
      expect((r.errs[0] as CliError).message).toBe('Nothing changed: the ledger was not touched.');
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: tty, configurable: true });
    }
  });

  it('a run that differs from its preview says so, and the done line names the entry', async () => {
    const r = await accrue(['--yes']);
    expect(r.err).toContain('  ⚠ The preview showed 1 worker and the run accrued 3.');
    expect(r.err).toContain('  ⚠ The preview added up to 3547.9452 and the run accrued 1000.0000.');
    expect(r.err).toContain('✔ 3 workers accrued in Periodo 3/2026 for 1000.0000 · entry je-9.');
  });

  it('with no entry the done line stops at the total, in both languages', async () => {
    vi.mocked(provisions.runMonthlyProvisions).mockResolvedValue({
      processed: 3, skipped: 0, total: '1000.0000', errors: [], journalEntryId: null,
    } as never);
    const r = await accrue(['--yes']);
    expect(r.err).toContain('✔ 3 workers accrued in Periodo 3/2026 for 1000.0000.\n');
    setLanguage('es');
    const spanish = await accrue(['--yes']);
    expect(spanish.err).toContain('✔ 3 trabajadores devengados en Periodo 3/2026 por 1000.0000.');
  });

  it('a repeated key says so after the run, and does not compare against the preview', async () => {
    vi.mocked(store.conLlave).mockResolvedValueOnce({
      repetido: true, resultado: { processed: 3, skipped: 0, total: '1000.0000', errors: [], journalEntryId: 'je-9' },
    } as never);
    const r = await accrue(['--yes', '--idempotency-key', 'k2']);
    expect(r.err).toContain('Idempotency key already spent:');
    expect(r.err).not.toContain('The preview showed');
  });
});
