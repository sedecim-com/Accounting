import { describe, it, expect, beforeAll } from 'vitest';
import { Command } from 'commander';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { riskOf, declareRisk } from '../../src/cli/kernel/risk.js';
import { VERBS } from '../../src/cli/kernel/vocabulary.js';
import { FLAG_DICTIONARY } from '../../src/cli/kernel/flags.js';
import { ExitCode } from '../../src/cli/kernel/exit.js';
import {
  ORIGENES_DE_ANTICIPO,
  elegirAnticipo,
  exigirConvencionDelPanel,
  exigirFecha,
  exigirImporte,
  exigirOrigen,
  exigirPeriodo,
  filasDeAnticipos,
  filasDelAsiento,
  filasDelCalendario,
  filasPrevistas,
  periodosRestantes,
  registerPrepaidCommand,
  renglonDelPeriodo,
  type RenglonPrevisto,
} from '../../src/cli/prepaid-command.js';
import { calcularAmortizacion } from '../../src/services/accruals/amortization-math.js';
import type { PrepaidExpenseRow } from '../../src/services/accruals/prepaid-service.js';

// ============================================================
// D1a · las cuatro hojas de `prepaid` contra el reglamento, antes de
// que el integrador las enchufe en mnemosine.ts. Construir el
// programa basta: `declareRisk` revienta en tiempo de REGISTRO y
// `auditProgram` recorre el árbol igual que el binario embarcado.
//
// Lo que estas pruebas defienden y no es cosmético: que `run` sea
// irreversible (postea al mayor de la 041, que no admite UPDATE ni
// DELETE) y que por serlo el agente no pueda llamarla NUNCA; que
// `create` no insinúe que postea; y que la aritmética de la vista
// previa sea la MISMA que la del motor, anticipo por anticipo, con
// sus cinco motivos de omisión escritos uno a uno.
// ============================================================

const deps = {
  palette: {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  },
  shutdown: () => undefined,
  reportError: () => undefined,
};

let program: Command;
let violations: ReturnType<typeof auditProgram>;
const risks = new Map<string, ReturnType<typeof riskOf>>();

const LEAVES = ['prepaid create', 'prepaid list', 'prepaid show', 'prepaid run'];

beforeAll(() => {
  program = new Command('mnemosine');
  registerPrepaidCommand(program, deps);
  violations = auditProgram(program);
  for (const path of LEAVES) risks.set(path, riskOf(find(path)));
});

function find(path: string): Command {
  let node: Command = program;
  for (const token of path.split(' ')) {
    const next = node.commands.find((c) => c.name() === token);
    if (!next) throw new Error(`No command "${path}" (stuck at "${token}")`);
    node = next;
  }
  return node;
}

function longs(path: string): (string | undefined)[] {
  return find(path).options.map((o) => o.long);
}

describe('the rulebook', () => {
  it('registers without declareRisk refusing anything', () => {
    expect(program.commands.map((c) => c.name())).toEqual(['prepaid']);
  });

  it('passes the consistency audit with no violations', () => {
    expect(violations).toEqual([]);
  });

  it('ships exactly the four leaves and no invented surface', () => {
    const hojas: string[] = [];
    const walk = (cmd: Command, prefix: string[]) => {
      const path = [...prefix, cmd.name()];
      if (cmd.commands.length === 0) hojas.push(path.join(' '));
      for (const child of cmd.commands) walk(child, path);
    };
    for (const child of program.commands) walk(child, []);
    expect(hojas.sort()).toEqual([...LEAVES].sort());
  });

  it('ends every leaf in a verb from the closed list', () => {
    for (const leaf of LEAVES) {
      expect(Object.keys(VERBS), leaf).toContain(leaf.split(' ').pop());
    }
  });

  it('keeps every leaf within the three-token depth limit', () => {
    for (const leaf of LEAVES) expect(leaf.split(' ').length, leaf).toBeLessThanOrEqual(3);
  });
});

describe('the bilingual surface', () => {
  const ALIASES: Record<string, string> = {
    prepaid: 'pago-anticipado',
    'prepaid create': 'crear',
    'prepaid list': 'listar',
    'prepaid show': 'ver',
    'prepaid run': 'ejecutar',
  };

  it('gives every command exactly one Spanish alias', () => {
    for (const [path, alias] of Object.entries(ALIASES)) {
      expect(find(path).aliases(), path).toEqual([alias]);
    }
  });

  it('uses the vocabulary’s Spanish verb for every verb command', () => {
    for (const [path, alias] of Object.entries(ALIASES)) {
      const verb = path.split(' ').pop()!;
      if (VERBS[verb]) expect(alias, path).toBe(VERBS[verb]);
    }
  });

  it('never claims a plural alias: the noun is singular in both languages', () => {
    expect(find('prepaid').aliases()).not.toContain('pagos-anticipados');
  });
});

describe('safety declarations', () => {
  it('declares run irreversible: it posts to the immutable ledger', () => {
    expect(risks.get('prepaid run')?.risk).toBe('irreversible');
  });

  it('forbids the agent from posting, and never lets a flag decide that', () => {
    expect(risks.get('prepaid run')?.agentAllowed).toBe(false);
    expect(() =>
      declareRisk(new Command('prepaid run'), { risk: 'irreversible', agent: true })
    ).toThrow(/permission must never depend on the value of a flag/);
  });

  it('keeps the agent out of the schedule register: a master-data write is not a review queue', () => {
    expect(risks.get('prepaid create')?.risk).toBe('escritura');
    expect(risks.get('prepaid create')?.agentAllowed).toBe(false);
    expect(risks.get('prepaid create')?.draftOnly).toBe(false);
  });

  it('refuses to ship an agent-invocable create without draftOnly', () => {
    expect(() =>
      declareRisk(new Command('prepaid create'), { risk: 'escritura', agent: true })
    ).toThrow(/draftOnly/);
  });

  it('lets the agent read: list and show write nothing', () => {
    for (const hoja of ['prepaid list', 'prepaid show']) {
      expect(risks.get(hoja)?.risk, hoja).toBe('lectura');
      expect(risks.get(hoja)?.agentAllowed, hoja).toBe(true);
    }
  });

  it('carries the three safety flags the irreversible class requires', () => {
    expect(longs('prepaid run')).toEqual(
      expect.arrayContaining(['--dry-run', '--yes', '--idempotency-key'])
    );
  });

  it('gives the read-only leaves none of them: nothing suggests they write', () => {
    for (const hoja of ['prepaid list', 'prepaid show']) {
      for (const bandera of ['--dry-run', '--yes', '--idempotency-key', '--force']) {
        expect(longs(hoja), `${hoja} ${bandera}`).not.toContain(bandera);
      }
    }
  });

  it('gives create --dry-run but NOT --idempotency-key: it posts nothing to dedupe', () => {
    expect(longs('prepaid create')).toContain('--dry-run');
    expect(longs('prepaid create')).not.toContain('--idempotency-key');
  });

  it('says what each mutating leaf writes, for the audit trail', () => {
    expect(risks.get('prepaid create')?.writes).toMatch(/prepaid_expenses/);
    // Y dice lo que NO escribe, que es la mitad del asunto: el cargo a la 1160
    // ya está en el mayor y el alta lo adopta, no lo vuelve a postear.
    expect(risks.get('prepaid create')?.writes).toMatch(/ninguna póliza/);
    expect(risks.get('prepaid run')?.writes).toMatch(/journal_entries/);
    expect(risks.get('prepaid run')?.writes).toMatch(/prepaid_amortization_schedules/);
  });
});

describe('the flags the catalog names', () => {
  it('gives `prepaid create` the window, the amount and the two accounts', () => {
    expect(longs('prepaid create')).toEqual(
      expect.arrayContaining([
        '--amount', '--start', '--end', '--origin', '--source-entry',
        '--prepaid-account', '--expense-account', '--convention', '--dry-run',
      ])
    );
  });

  it('gives `prepaid list` the four the catalog lists, plus the list contract', () => {
    expect(longs('prepaid list')).toEqual(
      expect.arrayContaining(['--all', '--as-of', '--json', '--limit', '--format'])
    );
  });

  it('gives `prepaid run` --period and the machine-readable output', () => {
    expect(longs('prepaid run')).toEqual(expect.arrayContaining(['--period', '--json']));
  });

  it('reads --fields on every leaf, so the default table honours it too', () => {
    for (const leaf of LEAVES) expect(longs(leaf), leaf).toContain('--fields');
  });

  it('registers every new spelling in the single dictionary', () => {
    for (const flag of [
      '--convention', '--prepaid-account', '--start', '--end', '--origin',
      '--reference', '--cfdi-uuid',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(FLAG_DICTIONARY, flag), flag).toBe(true);
      expect(FLAG_DICTIONARY[flag], flag).toBeNull();
    }
  });

  it('never reuses --method for the convention: F06a froze it with another vocabulary', () => {
    // El catálogo escribe `--method straight-line-day|month|usage` en la fila
    // de `prepaid create`. `--method` es desde F06a el método CONTABLE de
    // depreciación, con otros valores; y `usage` no existe en este motor.
    expect(longs('prepaid create')).not.toContain('--method');
    expect(longs('prepaid create')).toContain('--convention');
  });

  it('never reuses --asset-account for the 1160: that one is the fixed-asset account', () => {
    expect(longs('prepaid create')).not.toContain('--asset-account');
    expect(longs('prepaid create')).toContain('--prepaid-account');
  });

  it('declares no --status on the list: the reader only returns live schedules', () => {
    // Una bandera declarada que nadie lee es el defecto que este repositorio ya
    // cazó en `ap reconcile`. `anticiposActivos` devuelve sólo `status=active`.
    expect(longs('prepaid list')).not.toContain('--status');
  });

  it('pairs --force with --reason, so overriding the threshold leaves a why', () => {
    expect(longs('prepaid create')).toEqual(expect.arrayContaining(['--force', '--reason']));
  });
});

// ============================================================
// `--convention` DECLARA, NO ELIGE
// ============================================================

describe('exigirConvencionDelPanel', () => {
  const panel = { convencion: 'proporcional_dias' as const, convencionDefinida: true };

  it('devuelve la del panel cuando la bandera no viene', () => {
    expect(exigirConvencionDelPanel(undefined, panel)).toBe('proporcional_dias');
  });

  it('acepta la bandera que coincide con el panel', () => {
    expect(exigirConvencionDelPanel('proporcional_dias', panel)).toBe('proporcional_dias');
  });

  it('rechaza la que contradice al panel, en vez de obedecerla', () => {
    expect(() => exigirConvencionDelPanel('meses_completos', panel)).toThrow(/contradice al panel/);
  });

  it('nombra la política que sí decide, para que la contradicción tenga salida', () => {
    expect(() => exigirConvencionDelPanel('meses_completos', panel)).toThrow(
      /amortizacion_anticipados_convencion/
    );
  });

  it('avisa cuando la convención vigente viene del defecto y no del despacho', () => {
    expect(() =>
      exigirConvencionDelPanel('proporcional_dias', {
        convencion: 'meses_completos',
        convencionDefinida: false,
      })
    ).toThrow(/defecto declarado/);
  });

  it('rechaza un valor que no es ninguna de las dos convenciones', () => {
    expect(() => exigirConvencionDelPanel('lineal', panel)).toThrow(/no existe/);
  });
});

// ============================================================
// LAS BANDERAS QUE SE VALIDAN ANTES DE GASTAR UNA CONEXIÓN
// ============================================================

describe('exigirFecha', () => {
  it('acepta una fecha real', () => {
    expect(exigirFecha('--start', '2026-03-20')).toBe('2026-03-20');
  });

  it('rechaza un día que no existe en vez de correrlo al mes siguiente', () => {
    // JavaScript acepta 2026-02-31 y lo mueve al 3 de marzo: así es como una
    // cobertura acaba empezando un día que nadie tecleó.
    expect(() => exigirFecha('--start', '2026-02-31')).toThrow(/fecha real/);
  });

  it('rechaza otro formato', () => {
    expect(() => exigirFecha('--end', '20/03/2026')).toThrow(/YYYY-MM-DD/);
  });
});

describe('exigirImporte', () => {
  it('normaliza a los cuatro decimales de la columna', () => {
    expect(exigirImporte('--amount', '12000')).toBe('12000.0000');
  });

  it('ignora las comas de millares', () => {
    expect(exigirImporte('--amount', '1,250,000.50')).toBe('1250000.5000');
  });

  it('no pierde precisión por el flotante en nueve cifras', () => {
    expect(exigirImporte('--amount', '123456789.1234')).toBe('123456789.1234');
  });

  it('rechaza un importe con signo', () => {
    expect(() => exigirImporte('--amount', '-100')).toThrow(/sin signo/);
  });
});

describe('exigirPeriodo', () => {
  it('exige el mes en vez de deducirlo del reloj', () => {
    expect(() => exigirPeriodo(undefined)).toThrow(/Falta --period/);
    expect(() => exigirPeriodo(undefined)).toThrow(/el mes que acaba de empezar/);
  });

  it('deja pasar el que llega', () => {
    expect(exigirPeriodo('2026-03')).toBe('2026-03');
  });
});

describe('exigirOrigen', () => {
  it('no tiene valor por omisión: suponerlo apunta el rastro a otro asiento', () => {
    expect(() => exigirOrigen(undefined)).toThrow(/Falta --origin/);
  });

  it('acepta los tres del vocabulario', () => {
    for (const o of ORIGENES_DE_ANTICIPO) expect(exigirOrigen(o)).toBe(o);
  });

  it('rechaza cualquier otro', () => {
    expect(() => exigirOrigen('factura')).toThrow(/no existe/);
  });
});

// ============================================================
// LA ARITMÉTICA DE LA VISTA PREVIA, QUE ES LA DEL MOTOR
// ============================================================

const POLIZA: PrepaidExpenseRow = {
  id: 'p1',
  entity_id: 'e1',
  description: 'Póliza de seguro 2026',
  vendor_name: 'Aseguradora SA',
  reference: 'POL-778',
  total_amount: '12000.0000',
  coverage_start_date: new Date(2026, 0, 1),
  coverage_end_date: new Date(2026, 11, 31),
  prepaid_account_id: 'c-1160',
  expense_account_id: 'c-6100',
  amortization_convention: 'proporcional_dias',
  origin: 'cfdi',
  source_journal_entry_id: 'je-1',
  cfdi_uuid: null,
  amortized_to_date: '0.0000',
  remaining_amount: '12000.0000',
  last_amortization_date: null,
  status: 'active',
  notes: null,
};

const con = (cambios: Partial<PrepaidExpenseRow>): PrepaidExpenseRow => ({ ...POLIZA, ...cambios });

describe('renglonDelPeriodo — los mismos números que devengarUnAnticipo', () => {
  it('calcula enero por días: 12 000 × 31/365', () => {
    const r = renglonDelPeriodo(POLIZA, new Date(2026, 0, 1));
    expect(r.estado).toBe('entra');
    const e = r as RenglonPrevisto;
    expect(e.indice).toBe(0);
    expect(e.dias).toBe(31);
    expect(e.periodos).toBe(12);
    expect(e.importe).toBe('1019.1781');
    expect(e.topado).toBe(false);
  });

  it('indexa febrero por MESES DE CALENDARIO y no repite el renglón de enero', () => {
    // El defecto A de F06a: dividir milisegundos entre la longitud media de un
    // mes hacía que marzo repitiera la fila de febrero y el índice quedara
    // atrasado para siempre desde abril.
    const r = renglonDelPeriodo(POLIZA, new Date(2026, 1, 1)) as RenglonPrevisto;
    expect(r.indice).toBe(1);
    expect(r.dias).toBe(28);
    expect(r.importe).toBe('920.5479');
  });

  it('el último mes es el tapón: los doce renglones suman la póliza exacta', () => {
    const meses = [...Array(12).keys()].map(
      (m) => renglonDelPeriodo(POLIZA, new Date(2026, m, 1)) as RenglonPrevisto
    );
    const suma = meses.reduce((s, r) => s + Number(r.importe), 0);
    expect(suma.toFixed(4)).toBe('12000.0000');
  });

  it('omite el anticipo cuya cobertura todavía no empieza', () => {
    const r = renglonDelPeriodo(POLIZA, new Date(2025, 11, 1));
    expect(r).toMatchObject({ estado: 'omitido', motivo: 'la cobertura todavía no empieza' });
  });

  it('omite el anticipo cuya cobertura ya terminó', () => {
    const r = renglonDelPeriodo(POLIZA, new Date(2027, 0, 1));
    expect(r).toMatchObject({ estado: 'omitido', motivo: 'la cobertura ya terminó' });
  });

  it('omite el que ya no tiene saldo, en vez de dejar la cuenta en negativo', () => {
    const r = renglonDelPeriodo(con({ remaining_amount: '0.0000' }), new Date(2026, 0, 1));
    expect(r).toMatchObject({ estado: 'omitido', motivo: 'no queda saldo por devengar' });
  });

  it('omite —y no revienta— el que guarda una convención que nadie declaró', () => {
    // La fila escrita por SQL a mano antes de que existiera el CHECK de la 059.
    const r = renglonDelPeriodo(con({ amortization_convention: 'lineal' }), new Date(2026, 0, 1));
    expect(r).toMatchObject({ estado: 'omitido' });
    expect((r as { motivo: string }).motivo).toMatch(/convención guardada desconocida/);
  });

  it('TOPA el renglón contra lo que queda, y lo dice', () => {
    // Si ya se devengó de más —un mes corrido dos veces bajo otra convención—,
    // abonar el renglón entero dejaría un activo con saldo ACREEDOR y el
    // balance seguiría cuadrando.
    const r = renglonDelPeriodo(
      con({ remaining_amount: '500.0000', amortized_to_date: '11500.0000' }),
      new Date(2026, 0, 1)
    ) as RenglonPrevisto;
    expect(r.teorico).toBe('1019.1781');
    expect(r.importe).toBe('500.0000');
    expect(r.topado).toBe(true);
  });

  it('meses_completos reparte en doce iguales y no por días', () => {
    const r = renglonDelPeriodo(
      con({ amortization_convention: 'meses_completos' }),
      new Date(2026, 0, 1)
    ) as RenglonPrevisto;
    expect(r.importe).toBe('1000.0000');
  });
});

describe('filasPrevistas', () => {
  it('pone los omitidos en la MISMA tabla, con su motivo', () => {
    // Esconderlos en stderr los perdería en --json, y «qué se saltó y por qué»
    // es la mitad del valor de una corrida.
    const filas = filasPrevistas([
      renglonDelPeriodo(POLIZA, new Date(2026, 0, 1)),
      renglonDelPeriodo(POLIZA, new Date(2027, 0, 1)),
    ]);
    expect(filas.map((f) => f.estado)).toEqual(['entra', 'omitido']);
    expect(filas[1].motivo).toBe('la cobertura ya terminó');
    expect(filas[1].amortizacion).toBe('');
  });
});

describe('filasDelAsiento', () => {
  const entra = renglonDelPeriodo(POLIZA, new Date(2026, 0, 1)) as RenglonPrevisto;
  const filas = filasDelAsiento([entra], new Date(2026, 0, 31), (id) =>
    id === 'c-6100' ? '6100 Gastos Generales' : '1160 Pagos Anticipados'
  );

  it('produce DOS líneas por anticipo, cargo al gasto y abono al anticipo', () => {
    expect(filas).toHaveLength(2);
    expect(filas[0]).toMatchObject({ cuenta: '6100 Gastos Generales', debe: '1019.1781', haber: '' });
    expect(filas[1]).toMatchObject({ cuenta: '1160 Pagos Anticipados', debe: '', haber: '1019.1781' });
  });

  it('numera los asientos para que se vea que son N y no uno', () => {
    // El día que alguien quiera reversar la corrida son N reversas.
    expect(filas[0].asiento).toBe('1/1');
  });

  it('usa LITERALMENTE las descripciones que escribe el motor', () => {
    // Lo que se lee en la previa es lo que quedará en el mayor inmutable.
    expect(filas[0].descripcion).toBe('Accrued expense - Póliza de seguro 2026');
    expect(filas[1].descripcion).toBe('Prepaid expenses - Póliza de seguro 2026');
  });

  it('fecha las dos líneas con el último día del periodo', () => {
    for (const f of filas) expect(f.fecha).toEqual(new Date(2026, 0, 31));
  });
});

describe('filasDelCalendario y periodosRestantes', () => {
  const calendario = calcularAmortizacion({
    importe: '12000.0000',
    inicio: new Date(2026, 0, 1),
    fin: new Date(2026, 11, 31),
    convencion: 'proporcional_dias',
  });

  it('imprime un renglón por mes con su saldo', () => {
    const filas = filasDelCalendario(calendario);
    expect(filas).toHaveLength(12);
    expect(filas[0].amortizacion).toBe('1019.1781');
    expect(filas[11].saldo).toBe('0.0000');
  });

  it('cuenta los renglones que quedan por delante de una fecha', () => {
    expect(periodosRestantes(calendario, new Date(2026, 0, 1))).toBe(12);
    expect(periodosRestantes(calendario, new Date(2026, 6, 15))).toBe(6);
    expect(periodosRestantes(calendario, new Date(2027, 0, 1))).toBe(0);
  });
});

describe('filasDeAnticipos', () => {
  it('lleva el devengado y el remanente, que son del mayor, junto al calendario', () => {
    const [fila] = filasDeAnticipos(
      [con({ amortized_to_date: '1019.1781', remaining_amount: '10980.8219' })],
      new Date(2026, 1, 1)
    );
    expect(fila.amortized_to_date).toBe('1019.1781');
    expect(fila.remaining_amount).toBe('10980.8219');
    expect(fila.periodos).toBe(12);
    expect(fila.periodos_restantes).toBe(11);
  });

  it('no revienta con una convención que no se entiende: deja el hueco en blanco', () => {
    const [fila] = filasDeAnticipos([con({ amortization_convention: 'lineal' })], new Date(2026, 0, 1));
    expect(fila.periodos).toBe('');
    expect(fila.periodos_restantes).toBe('');
  });
});

describe('elegirAnticipo', () => {
  const otro = con({ id: 'p2', description: 'Renta anticipada de bodega' });

  it('encuentra por id exacto', () => {
    expect(elegirAnticipo([POLIZA, otro], 'p2').id).toBe('p2');
  });

  it('encuentra por un trozo de descripción que sólo case con uno', () => {
    expect(elegirAnticipo([POLIZA, otro], 'bodega').id).toBe('p2');
  });

  it('no elige «el primero» cuando hay dos: pregunta, y enumera los ids', () => {
    expect(() => elegirAnticipo([POLIZA, con({ id: 'p3' })], 'seguro')).toThrow(/casa con 2/);
    expect(() => elegirAnticipo([POLIZA, con({ id: 'p3' })], 'seguro')).toThrow(/p3/);
  });

  it('dice que no existe cuando no casa con nada, con el código 5', () => {
    expect(() => elegirAnticipo([POLIZA], 'licencia')).toThrow(/ningún calendario vivo/);
    try {
      elegirAnticipo([POLIZA], 'licencia');
      expect.unreachable('debía lanzar');
    } catch (err) {
      expect((err as { exitCode: number }).exitCode).toBe(ExitCode.NOT_FOUND);
    }
  });
});
