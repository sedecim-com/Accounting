import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  criteriosParaLeer,
  filasDeLaCedula,
  filasDelAsiento,
  registerPayrollCommand,
  requirePeriod,
} from '../../src/cli/payroll-command.js';
import { ExitCode, type CliError } from '../../src/cli/kernel/index.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
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
    expect(() => requirePeriod(undefined)).toThrow(/Falta --period/);
    expect(() => requirePeriod(undefined)).toThrow(/el mes que acaba de empezar/);
    try {
      requirePeriod(undefined);
    } catch (err) {
      expect((err as CliError).exitCode).toBe(ExitCode.USAGE);
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
    expect(String(filas[1].motivo)).toContain('ya tiene renglon vigente');
    expect(String(filas[2].motivo)).toContain('devengo del mes es cero');
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
    // Las tres banderas que su clase de riesgo obliga a llevar.
    const largos = hoja.options.map((o) => o.long);
    expect(largos).toEqual(expect.arrayContaining(['--dry-run', '--yes', '--idempotency-key']));
  });
});
