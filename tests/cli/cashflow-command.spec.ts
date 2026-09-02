import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ============================================================
// G1b · LA FAMILIA `cashflow` · `flujo` EN EL BINARIO
//
// El patrón es el de closing-command.spec y report-command.spec: la CLI se
// ejercita sin base —el SQL vive en los dos motores y tiene su propia suite,
// unitaria y de integración— y lo que se afirma aquí es la PUERTA: nombres,
// alias, banderas del catálogo, riesgo declarado, el contrato de salida, y
// las tres cosas que sólo esta capa puede equivocar:
//
//   1. que `--method direct` LLEGUE al motor como «directo» y no se
//      convierta en indirecto en silencio, que es letra por letra lo que
//      hacía la ruta REST;
//   2. que el amarre —inicio, movimiento, final, residuo— salga EN BANDA,
//      de modo que el csv que alguien importa traiga el documento entero;
//   3. que `generate` y `reconcile` construyan el estado con la MISMA
//      función, para que no puedan publicar dos cifras del mismo periodo.
// ============================================================

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: vi.fn(),
  resolveEntity: vi.fn(async () => ({
    entityId: 'ent-1',
    entityName: 'Demo Corp MX',
    tenantId: 'ten-1',
    currency: 'MXN',
    country: 'MX',
    accountingStandard: 'NIF',
    taxId: 'X',
  })),
  listEntities: vi.fn(async () => [{ id: 'ent-1' }]),
}));

vi.mock('../../src/services/reporting/report-service.js', () => ({
  LEDGER_SCALE: 4,
  resolvePeriodRange: vi.fn(async () => ({
    period_name: '2026-07',
    fiscal_period_id: 'fp-1',
    matched_fiscal_period: true,
    start_date: '2026-07-01',
    end_date: '2026-07-31',
  })),
}));

vi.mock('../../src/services/reporting/cash-flow-service.js', () => ({
  getCashFlowStatement: vi.fn(),
}));

vi.mock('../../src/services/reporting/cash-flow-reconcile.js', () => ({
  movimientoRealDeEfectivo: vi.fn(),
  conciliarFlujoDeEfectivo: vi.fn(),
}));

import {
  registerCashFlowCommand,
  metodoPedido,
  rotuloDelMetodo,
  filasDelEstado,
  filasDelAmarre,
  residuoDe,
  type CashFlowCommandDeps,
} from '../../src/cli/cashflow-command.js';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { riskOf, resetDeclarations } from '../../src/cli/kernel/risk.js';
import { FLAG_DICTIONARY } from '../../src/cli/kernel/flags.js';
import { ExitCode } from '../../src/cli/kernel/exit.js';
import { palette } from '../../src/cli/palette.js';
import type {
  CashFlowStatement,
  LineaDeFlujo,
  SeccionDeFlujo,
} from '../../src/services/reporting/cash-flow-service.js';
import type { MovimientoRealDeEfectivo } from '../../src/services/reporting/cash-flow-reconcile.js';
import * as motor from '../../src/services/reporting/cash-flow-service.js';
import * as amarre from '../../src/services/reporting/cash-flow-reconcile.js';

const noColor = palette({ isTTY: false } as NodeJS.WriteStream);

// Un home que no existe: `readState` devuelve {} y la resolución de entidad
// cae en el doble de `resolveEntity`. Sin esto la prueba leería el
// ~/.mnemosine/state.json de quien la corra.
const DEPS: Omit<CashFlowCommandDeps, 'shutdown' | 'reportError'> = {
  palette: noColor,
  home: '/tmp/mnemosine-tests-no-home',
};

// ---- material de prueba --------------------------------------------

function linea(code: string, name: string, neto: string, amount: string): LineaDeFlujo {
  return { account_id: `a-${code}`, code, name, renglon: 'capital_de_trabajo', neto, amount };
}

function seccion(total: string, lines: LineaDeFlujo[]): SeccionDeFlujo {
  return { total, lines };
}

function estado(over: Partial<CashFlowStatement> = {}): CashFlowStatement {
  return {
    entity_id: 'ent-1',
    start_date: '2026-07-01',
    end_date: '2026-07-31',
    method: 'indirect',
    policies: { metodo: 'indirecto', cuentasDeEfectivo: 'rol', descuadre: 'avisar' },
    net_income: '30000.0000',
    operating_activities: {
      net_income: '30000.0000',
      non_cash: seccion('5000.0000', [
        linea('1290', 'Depreciación acumulada', '-5000.0000', '5000.0000'),
      ]),
      working_capital: seccion('-2000.0000', [
        linea('1120', 'Clientes', '2000.0000', '-2000.0000'),
      ]),
      total: '33000.0000',
    },
    investing_activities: seccion('-10000.0000', [
      linea('1210', 'Maquinaria', '10000.0000', '-10000.0000'),
    ]),
    financing_activities: seccion('50000.0000', [
      linea('3100', 'Capital social', '-50000.0000', '50000.0000'),
    ]),
    unclassified: seccion('0.0000', []),
    net_cash_flow: '73000.0000',
    non_cash_transactions: [],
    cash_accounts: [{ id: 'a1', code: '1110', name: 'Caja y Bancos' }],
    self_check: {
      unclassified_total: '0.0000',
      candidates: [],
      ties: true,
      note: 'Every account that moved was classified into a section.',
    },
    ...over,
  };
}

function efectivo(over: Partial<MovimientoRealDeEfectivo> = {}): MovimientoRealDeEfectivo {
  return {
    criterio: 'rol',
    criterio_definido: true,
    cuentas: [{ account_id: 'a1', code: '1110', name: 'Caja y Bancos', via: 'rol' }],
    saldo_inicial: '100000.0000',
    saldo_final: '173000.0000',
    variacion: '73000.0000',
    ...over,
  };
}

// ---- arranque -------------------------------------------------------

function construir(): Command {
  resetDeclarations();
  const program = new Command('mnemosine');
  registerCashFlowCommand(program, {
    ...DEPS,
    shutdown: () => undefined,
    reportError: () => undefined,
  });
  return program;
}

const familia = (program: Command) =>
  program.commands.find((c) => c.name() === 'cashflow') as Command;

const hoja = (program: Command, nombre: string) =>
  familia(program).commands.find((c) => c.name() === nombre) as Command;

async function correr(argv: string[]) {
  resetDeclarations();
  let code: number | undefined;
  const errs: unknown[] = [];
  const program = new Command('mnemosine').exitOverride();
  registerCashFlowCommand(program, {
    ...DEPS,
    shutdown: (c: number) => {
      code = c;
    },
    reportError: (e: unknown) => {
      errs.push(e);
    },
  });

  let out = '';
  let err = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    err += String(chunk);
    return true;
  });
  try {
    await program.parseAsync(['node', 'mnemosine', ...argv]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { code, out, err, errs };
}

beforeEach(() => {
  vi.mocked(motor.getCashFlowStatement).mockReset();
  vi.mocked(amarre.movimientoRealDeEfectivo).mockReset();
  vi.mocked(motor.getCashFlowStatement).mockResolvedValue(estado());
  vi.mocked(amarre.movimientoRealDeEfectivo).mockResolvedValue(efectivo());
});

afterEach(() => {
  resetDeclarations();
});

// ============================================================
// LA SUPERFICIE
// ============================================================

describe('cashflow · flujo — la familia', () => {
  it('registra las DOS hojas de fase 1 del catálogo, con sus alias, y ninguna más', () => {
    const program = construir();
    expect(familia(program)).toBeDefined();
    expect(familia(program).aliases()).toContain('flujo');
    const hojas = Object.fromEntries(familia(program).commands.map((c) => [c.name(), c.aliases()]));
    expect(hojas.generate).toContain('generar');
    expect(hojas.reconcile).toContain('conciliar');
    // `category set`, `explain` y `check` son fases 2 y 3: aquí NO existen.
    // Un comando que existe y no hace lo que su fila promete es peor que su
    // ausencia — que es justo el defecto que esta familia vino a cerrar.
    expect(Object.keys(hojas).sort()).toEqual(['generate', 'reconcile']);
  });

  it('pasa la auditoría de consistencia del núcleo sin violaciones', () => {
    expect(auditProgram(construir())).toEqual([]);
  });

  it('las dos son lectura y abiertas al agente, como dice el catálogo (✓)', () => {
    const program = construir();
    for (const nombre of ['generate', 'reconcile']) {
      const r = riskOf(hoja(program, nombre));
      expect(r?.risk, nombre).toBe('lectura');
      expect(r?.agentAllowed, nombre).toBe(true);
    }
  });

  it('ninguna declara bandera de mutación: construir e informar no escriben nada', () => {
    const program = construir();
    for (const nombre of ['generate', 'reconcile']) {
      const largas = hoja(program, nombre).options.map((o) => o.long);
      for (const prohibida of ['--yes', '--force', '--dry-run', '--idempotency-key', '--live']) {
        expect(largas, `${nombre} ${prohibida}`).not.toContain(prohibida);
      }
    }
  });

  it('las dos llevan el grupo de salida COMPLETO, no --json suelto', () => {
    const program = construir();
    for (const nombre of ['generate', 'reconcile']) {
      const largas = hoja(program, nombre).options.map((o) => o.long);
      expect(largas, nombre).toEqual(
        expect.arrayContaining(['--format', '--json', '--fields', '--output', '--quiet'])
      );
    }
  });

  it('las dos llevan el grupo de contexto: la entidad se nombra, nunca se adivina a medias', () => {
    const program = construir();
    for (const nombre of ['generate', 'reconcile']) {
      const largas = hoja(program, nombre).options.map((o) => o.long);
      expect(largas, nombre).toEqual(expect.arrayContaining(['--entity', '--tenant', '--user']));
    }
  });

  it('generate lleva las cuatro banderas de su fila; reconcile las tres de la suya', () => {
    const program = construir();
    const gen = hoja(program, 'generate').options.map((o) => o.long);
    expect(gen).toEqual(expect.arrayContaining(['--method', '--period', '--gross', '--format']));
    const rec = hoja(program, 'reconcile').options.map((o) => o.long);
    expect(rec).toEqual(expect.arrayContaining(['--period', '--show-candidates', '--strict']));
  });

  it('`--strict` es de reconcile y NO de generate: el veredicto es de la hoja que verifica', () => {
    const program = construir();
    expect(hoja(program, 'generate').options.map((o) => o.long)).not.toContain('--strict');
  });

  it('las dos banderas nuevas quedan congeladas en el diccionario, sin forma corta', () => {
    // Sin esta entrada `--gross` reaparece la próxima sesión como --detail o
    // --expanded, que son OTRA promesa: enseñar más renglones no es dejar de
    // compensar entradas contra salidas.
    expect(FLAG_DICTIONARY).toHaveProperty('--gross', null);
    expect(FLAG_DICTIONARY).toHaveProperty('--show-candidates', null);
    // `--method` se reutiliza tal como estaba congelada en F06a: sin forma
    // corta, porque `-m` ya es el modelo de IA en este binario.
    expect(FLAG_DICTIONARY['--method']).toBeNull();
  });
});

// ============================================================
// LAS PIEZAS PURAS
// ============================================================

describe('metodoPedido — la traducción que impide que vuelva el defecto', () => {
  it('acepta las dos grafías del catálogo y las dos del panel', () => {
    expect(metodoPedido('indirect')).toBe('indirecto');
    expect(metodoPedido('indirecto')).toBe('indirecto');
    expect(metodoPedido('direct')).toBe('directo');
    expect(metodoPedido('directo')).toBe('directo');
    expect(metodoPedido('  DIRECT ')).toBe('directo');
  });

  it('sin bandera no impone nada: manda la política del panel', () => {
    expect(metodoPedido(undefined)).toBeUndefined();
  });

  it('un valor desconocido es error de USO, jamás un valor por omisión', () => {
    // Ésta es la prueba que cuida el defecto original: `comoMetodo` del motor
    // colapsa a «indirecto» todo lo que no sea 'directo', así que dejar pasar
    // la cadena cruda convertiría `--method direct` en indirecto en silencio.
    expect(() => metodoPedido('idirect')).toThrow(/must be one of/);
    try {
      metodoPedido('brutos');
    } catch (e) {
      expect((e as { exitCode: number }).exitCode).toBe(ExitCode.USAGE);
    }
  });
});

describe('rotuloDelMetodo — un estado que no declara su método no es un estado', () => {
  it('dice el método y de dónde salió cuando manda la política', () => {
    expect(rotuloDelMetodo(estado(), undefined)).toBe(
      'method: indirect (policy `flujo_efectivo_metodo` · indirecto)'
    );
  });

  it('dice que fue la bandera cuando la hubo', () => {
    expect(rotuloDelMetodo(estado(), 'indirecto')).toMatch(/--method/);
  });
});

describe('filasDelEstado — el documento, subtotales incluidos', () => {
  const filas = filasDelEstado(estado());
  const nombres = filas.map((f) => f.name);

  it('trae las tres secciones con su neto y el cambio total en efectivo', () => {
    expect(nombres).toContain('Net cash from operating activities');
    expect(nombres).toContain('Net cash from investing activities');
    expect(nombres).toContain('Net cash from financing activities');
    expect(nombres).toContain('Net change in cash');
  });

  it('los subtotales viajan EN BANDA, etiquetados por `line`', () => {
    const total = filas.find((f) => f.name === 'Net change in cash');
    expect(total?.line).toBe('total');
    expect(total?.amount).toBe('73000.0000');
    expect(filas.find((f) => f.code === '1290')?.line).toBe('account');
  });

  it('la utilidad neta es el primer renglón del método indirecto', () => {
    expect(filas[0]).toMatchObject({ name: 'Net income', amount: '30000.0000' });
  });

  it('sin cuentas huérfanas no imprime la sección `unclassified`', () => {
    expect(filas.some((f) => f.section === 'unclassified')).toBe(false);
  });

  it('con cuentas huérfanas las imprime CON NOMBRE, fuera del neto', () => {
    // El residuo se nombra, nunca se absorbe: es la mitad del arreglo.
    const con = filasDelEstado(
      estado({
        unclassified: seccion('-4000.0000', [linea('9999', 'Cuenta sin categoría', '4000.0000', '-4000.0000')]),
      })
    );
    const huerfana = con.find((f) => f.code === '9999');
    expect(huerfana).toMatchObject({ section: 'unclassified', amount: '-4000.0000' });
    // Y el neto publicado NO la incluye: sigue siendo el del motor.
    expect(con.find((f) => f.name === 'Net change in cash')?.amount).toBe('73000.0000');
  });
});

describe('el amarre visible', () => {
  it('inicio, movimiento y final salen como filas, no como una nota', () => {
    const filas = filasDelAmarre(estado(), efectivo());
    expect(filas.map((f) => f.amount)).toEqual([
      '100000.0000',
      '73000.0000',
      '173000.0000',
      '0.0000',
    ]);
    expect(filas.every((f) => f.section === 'cash')).toBe(true);
  });

  it('el residuo es derivado − real, el MISMO orden que `conciliarFlujoDeEfectivo`', () => {
    // Si las dos hojas restaran al revés, un lector vería el mismo descuadre
    // con el signo cambiado según qué comando corrió.
    expect(residuoDe(estado(), efectivo({ variacion: '8000.0000' }))).toBe('65000.0000');
    expect(residuoDe(estado({ net_cash_flow: '0.0000' }), efectivo())).toBe('-73000.0000');
  });

  it('el saldo inicial y el final se imprimen aunque la política sea «silencio»', () => {
    const filas = filasDelAmarre(
      estado({ policies: { metodo: 'indirecto', cuentasDeEfectivo: 'rol', descuadre: 'silencio' } }),
      efectivo()
    );
    expect(filas.filter((f) => f.line === 'tie')).toHaveLength(3);
  });
});

// ============================================================
// LA CONDUCTA
// ============================================================

describe('cashflow generate — la conducta', () => {
  it('encabeza con entidad, moneda, periodo y MÉTODO, y sale 0 cuando amarra', async () => {
    const r = await correr(['cashflow', 'generate', '--period', '2026-07']);
    expect(r.err).toMatch(/Statement of cash flows · Demo Corp MX · MXN · 2026-07-01 → 2026-07-31/);
    expect(r.err).toMatch(/method: indirect \(policy `flujo_efectivo_metodo`/);
    expect(r.err).toMatch(/Ties: the statement net equals the movement/);
    expect(r.code).toBe(ExitCode.OK);
  });

  it('el amarre sale en la tabla, con las cuatro cifras que el lector compara contra su banco', async () => {
    const r = await correr(['cashflow', 'generate', '--period', '2026-07', '--json']);
    const sobre = JSON.parse(r.out) as { rows: Array<Record<string, string>> };
    const tie = sobre.rows.filter((f) => f.section === 'cash');
    expect(tie.map((f) => f.line)).toEqual(['tie', 'tie', 'tie', 'residue']);
    expect(tie[0].amount).toBe('100000.0000');
    expect(tie[2].amount).toBe('173000.0000');
  });

  it('`--method direct` LLEGA al motor como «directo», no se convierte en indirecto en silencio', async () => {
    vi.mocked(motor.getCashFlowStatement).mockRejectedValueOnce(new Error('el directo no se construye'));
    await correr(['cashflow', 'generate', '--period', '2026-07', '--method', 'direct']);
    expect(vi.mocked(motor.getCashFlowStatement).mock.calls[0][1]).toMatchObject({
      metodo: 'directo',
    });
  });

  it('un `--method` desconocido es exit 2 y NO cuesta una conexión', async () => {
    const r = await correr(['cashflow', 'generate', '--period', '2026-07', '--method', 'bruto']);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(vi.mocked(motor.getCashFlowStatement)).not.toHaveBeenCalled();
  });

  it('`--gross` se rehúsa diciendo qué falta, antes de tocar la base', async () => {
    const r = await correr(['cashflow', 'generate', '--period', '2026-07', '--gross']);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(String((r.errs[0] as Error).message)).toMatch(/BRUTOS/);
    expect(vi.mocked(motor.getCashFlowStatement)).not.toHaveBeenCalled();
  });

  it('sin periodo se rehúsa en vez de inventar el mes en curso', async () => {
    const r = await correr(['cashflow', 'generate']);
    expect(r.code).toBe(ExitCode.USAGE);
    expect(String((r.errs[0] as Error).message)).toMatch(/movement between two dates/);
  });

  it('--since y --until sirven de rango cuando no hay periodo fiscal', async () => {
    const r = await correr([
      'cashflow', 'generate', '--since', '2026-07-01', '--until', '2026-07-31',
    ]);
    expect(r.code).toBe(ExitCode.OK);
    expect(vi.mocked(motor.getCashFlowStatement).mock.calls[0][1]).toMatchObject({
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    });
  });

  it('--fields se lee TAMBIÉN en la salida por omisión', async () => {
    const r = await correr(['cashflow', 'generate', '--period', '2026-07', '--fields', 'name']);
    expect(r.out).toContain('Net change in cash');
    // La columna de importes no se pidió: una bandera aceptada y no leída es
    // una promesa incumplida.
    expect(r.out).not.toContain('73,000.00');
  });

  it('revela las operaciones de inversión y financiamiento que no movieron efectivo', async () => {
    vi.mocked(motor.getCashFlowStatement).mockResolvedValue(
      estado({
        non_cash_transactions: [
          {
            entry_id: 'je-9',
            entry_number: 'JE-0009',
            entry_date: '2026-07-14',
            description: 'Maquinaria a crédito',
            amount: '250000.0000',
            accounts: [],
          },
        ],
      })
    );
    const r = await correr(['cashflow', 'generate', '--period', '2026-07']);
    expect(r.err).toMatch(/non-cash investing\/financing transaction/);
    expect(r.err).toMatch(/JE-0009/);
    // Y no entra en el cuerpo del estado: no es un flujo.
    expect(r.out).not.toContain('250,000.00');
  });
});

describe('cashflow generate — el residuo y quién decide su gravedad', () => {
  const conResiduo = () => {
    vi.mocked(amarre.movimientoRealDeEfectivo).mockResolvedValue(
      efectivo({ saldo_final: '108000.0000', variacion: '8000.0000' })
    );
  };

  it('«avisar»: nombra el residuo por stderr, lo imprime en banda y sale 0', async () => {
    conResiduo();
    const r = await correr(['cashflow', 'generate', '--period', '2026-07', '--json']);
    expect(r.err).toMatch(/does not tie to cash/);
    expect(r.err).toMatch(/Residue of 65000\.0000/);
    const sobre = JSON.parse(r.out) as { rows: Array<Record<string, string>> };
    expect(sobre.rows.find((f) => f.line === 'residue')?.amount).toBe('65000.0000');
    expect(r.code).toBe(ExitCode.OK);
  });

  it('«bloquear»: el mismo residuo pasa a ser hallazgo y sale 4', async () => {
    conResiduo();
    vi.mocked(motor.getCashFlowStatement).mockResolvedValue(
      estado({ policies: { metodo: 'indirecto', cuentasDeEfectivo: 'rol', descuadre: 'bloquear' } })
    );
    const r = await correr(['cashflow', 'generate', '--period', '2026-07']);
    expect(r.code).toBe(ExitCode.VALIDATION);
    expect(r.err).toMatch(/«bloquear»/);
  });

  it('«silencio» degrada a nota y LO DICE: apagar el aviso no es no haber medido', async () => {
    conResiduo();
    vi.mocked(motor.getCashFlowStatement).mockResolvedValue(
      estado({ policies: { metodo: 'indirecto', cuentasDeEfectivo: 'rol', descuadre: 'silencio' } })
    );
    const r = await correr(['cashflow', 'generate', '--period', '2026-07', '--json']);
    expect(r.code).toBe(ExitCode.OK);
    expect(r.err).toMatch(/«silencio»/);
    // El residuo SIGUE en la tabla: la política gobierna la gravedad, no si
    // el lector puede ver contra qué se compara el estado.
    const sobre = JSON.parse(r.out) as { rows: Array<Record<string, string>> };
    expect(sobre.rows.find((f) => f.line === 'residue')?.amount).toBe('65000.0000');
  });
});

describe('las dos hojas no pueden publicar dos cifras del mismo periodo', () => {
  it('reconcile construye el estado con la MISMA función que generate', async () => {
    vi.mocked(amarre.conciliarFlujoDeEfectivo).mockResolvedValue({
      entity_id: 'ent-1',
      start_date: '2026-07-01',
      end_date: '2026-07-31',
      method: 'indirect',
      efectivo: efectivo(),
      residuo: { derivado: '73000.0000', real: '73000.0000', importe: '0.0000', cuadra: true },
      politica_descuadre: 'avisar',
      politica_descuadre_definida: true,
      trato: 'sin_residuo',
      aviso: null,
      hallazgos: { blocking: 0, warning: 0 },
    });
    const r = await correr(['cashflow', 'reconcile', '--period', '2026-07']);
    expect(r.code).toBe(ExitCode.OK);
    // El constructor inyectado es `getCashFlowStatement`: si `reconcile`
    // resolviera el estado por su cuenta habría dos estados de flujos, el que
    // se firma y el que se concilia.
    expect(vi.mocked(motor.getCashFlowStatement)).toHaveBeenCalledWith('ent-1', {
      startDate: '2026-07-01',
      endDate: '2026-07-31',
    });
  });
});
