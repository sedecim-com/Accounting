import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { registerAccountCommand, fechaDeCatalogo } from '../../src/cli/account-command.js';
import { ExitCode } from '../../src/cli/kernel/index.js';

// ============================================================
// F07a · LA SUPERFICIE DEL AGRUPADOR desde la terminal.
//
// El patrón es el de closing-command.spec: el programa se construye con
// dobles de los servicios —el motor lo prueban account-service.spec y la
// integración— y se le habla por parseAsync, afirmando sobre stdout/stderr y
// sobre el código con que pidió apagarse.
//
// Lo que se vigila aquí es exactamente lo que la mudanza de columna y la
// compuerta nueva podían romper sin que nada chillara:
//   · `map check` reporta la POBLACIÓN medida y de dónde salió el alcance,
//     y no da verde cuando no había nada que mirar.
//   · `--level` se RECHAZA en vez de aceptarse y no aplicarse.
//   · `map set --year` vuelve a significar algo, y el ensayo valida de verdad.
// ============================================================

const mundo = vi.hoisted(() => ({
  cobertura: {
    alcance: 'cuentas_con_movimientos',
    alcanceElegido: false,
    poblacion: 0,
    huecos: [] as Array<Record<string, unknown>>,
  },
  /** Lo que recibió el servicio en la última llamada: la prueba de que la CLI no inventa. */
  ultimaCobertura: undefined as unknown,
  ultimoMapeo: undefined as unknown,
  validacion: {
    codigo: '',
    veredicto: 'valido',
    nombre: 'Bancos nacionales' as string | null,
    accion: 'aceptar',
    aviso: undefined as string | undefined,
  },
  /** Cuántas veces se preparó la validación: el ensayo tiene que pasar por ella. */
  validaciones: 0,
}));

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
}));

vi.mock('../../src/cli/kernel/entity-context.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveActiveEntity: () =>
    Promise.resolve({ ctx: { tenantId: 'T1', entityId: 'E1', entityName: 'Acme SA' } }),
}));

vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: () => Promise.resolve({ userId: 'U1' }),
}));

vi.mock('../../src/services/accounting/account-service.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveAccount: (_entityId: string, code: string) =>
    Promise.resolve({ id: 'A1', code, name: 'Bancos' }),
  checkMappingCoverageDetallada: (entityId: string, scheme: string, opciones: unknown) => {
    mundo.ultimaCobertura = { entityId, scheme, opciones };
    return Promise.resolve(mundo.cobertura);
  },
  setAccountMapping: (id: string, scheme: string, value: string | null, userId: string, opts: unknown) => {
    mundo.ultimoMapeo = { id, scheme, value, userId, opts };
    return Promise.resolve({ id, code: 'A1' });
  },
}));

vi.mock('../../src/services/accounting/sat-agrupadores.js', () => ({
  prepararValidacionAgrupador: (_ctx: unknown, fecha: string) => {
    mundo.validaciones += 1;
    return Promise.resolve({ politica: 'rechazar', hayCatalogo: true, fecha });
  },
  exigirAgrupadorValido: () => Promise.resolve(mundo.validacion),
}));

const plain = {
  dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
  red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
};

interface Corrida {
  out: string;
  err: string;
  code: number;
}

async function correr(...argv: string[]): Promise<Corrida> {
  let out = '';
  let err = '';
  let code = -1;
  const program = new Command();
  program.exitOverride();
  registerAccountCommand(program, {
    palette: plain,
    shutdown: (c: number) => {
      code = c;
    },
    reportError: (e: unknown) => {
      err += `${(e as Error).message}\n`;
    },
  });
  const spyOut = vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out += String(s);
    return true;
  });
  const spyErr = vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err += String(s);
    return true;
  });
  try {
    await program.parseAsync(['node', 'mnemosine', 'account', ...argv]);
  } finally {
    spyOut.mockRestore();
    spyErr.mockRestore();
  }
  return { out, err, code };
}

beforeEach(() => {
  mundo.cobertura = {
    alcance: 'cuentas_con_movimientos',
    alcanceElegido: false,
    poblacion: 0,
    huecos: [],
  };
  mundo.ultimaCobertura = undefined;
  mundo.ultimoMapeo = undefined;
  mundo.validaciones = 0;
  mundo.validacion = {
    codigo: '102.01',
    veredicto: 'valido',
    nombre: 'Bancos nacionales',
    accion: 'aceptar',
    aviso: undefined,
  };
});

describe('fechaDeCatalogo', () => {
  it('sin bandera no fabrica fecha: el defecto lo pone el servicio, una sola vez', () => {
    expect(fechaDeCatalogo(undefined)).toBeUndefined();
  });

  it('un ejercicio se pregunta por su ÚLTIMO día: el catálogo en vigor al cerrarlo', () => {
    expect(fechaDeCatalogo('2026')).toBe('2026-12-31');
    expect(fechaDeCatalogo('2022')).toBe('2022-12-31');
  });

  it('lo que no es un año de cuatro dígitos es error de uso, con el valor que llegó', () => {
    expect(() => fechaDeCatalogo('26')).toThrow(/"26"/);
    expect(() => fechaDeCatalogo('dos mil')).toThrow(/cuatro dígitos/);
  });
});

describe('account map check · la compuerta reporta la población nueva', () => {
  it('cero cuentas en el alcance NO es cobertura completa: lo dice y no da verde', async () => {
    const r = await correr('map', 'check');
    expect(r.err).toMatch(/0 cuentas en el alcance "cuentas_con_movimientos", por omisión/);
    expect(r.err).not.toMatch(/cobertura completa/);
    expect(r.code).toBe(ExitCode.OK);
  });

  it('con --strict, «no se comprobó nada» sí es un hallazgo', async () => {
    const r = await correr('map', 'check', '--strict');
    expect(r.code).toBe(ExitCode.VALIDATION);
  });

  it('sin huecos y con población, el verde dice CUÁNTAS cuentas se miraron', async () => {
    mundo.cobertura = {
      alcance: 'cuentas_con_movimientos', alcanceElegido: true, poblacion: 5, huecos: [],
    };
    const r = await correr('map', 'check');
    expect(r.err).toMatch(/cobertura completa: 5 cuenta\(s\) con sat-agrupador/);
    expect(r.err).toMatch(/elegido en el panel/);
    expect(r.code).toBe(ExitCode.OK);
  });

  it('con huecos: cuántos de cuántos, el alcance, y salida 4', async () => {
    mundo.cobertura = {
      alcance: 'cuentas_con_movimientos',
      alcanceElegido: false,
      poblacion: 5,
      huecos: [
        { account_id: 'a1', code: '1120', name: 'Bancos', account_level: 3, lineas_posteadas: 4 },
        { account_id: 'a2', code: '5100', name: 'Gastos', account_level: 2, lineas_posteadas: 2 },
      ],
    };
    const r = await correr('map', 'check');
    expect(r.err).toMatch(/2 de 5 cuenta\(s\) sin sat-agrupador \(alcance "cuentas_con_movimientos", por omisión\)/);
    expect(r.out).toMatch(/1120/);
    expect(r.code).toBe(ExitCode.VALIDATION);
  });

  it('el inquilino resuelto viaja al servicio: la compuerta no vuelve a subir por la entidad', async () => {
    await correr('map', 'check');
    expect(mundo.ultimaCobertura).toMatchObject({
      entityId: 'E1', scheme: 'sat-agrupador', opciones: { tenantId: 'T1' },
    });
  });

  it('la CLI no impone alcance: quien lo elige es el panel', async () => {
    await correr('map', 'check');
    expect((mundo.ultimaCobertura as { opciones: Record<string, unknown> }).opciones).not.toHaveProperty(
      'alcance'
    );
  });

  it('--level se RECHAZA en vez de aceptarse y no aplicarse', async () => {
    const r = await correr('map', 'check', '--level', '2');
    expect(r.err).toMatch(/--level ya no aplica/);
    expect(r.err).toMatch(/agrupador_alcance_de_la_compuerta/);
    expect(r.code).toBe(ExitCode.USAGE);
  });

  it('sin --level la compuerta corre: el rechazo es de la bandera, no del comando', async () => {
    const r = await correr('map', 'check');
    expect(r.err).not.toMatch(/--level/);
    expect(r.code).toBe(ExitCode.OK);
  });
});

describe('account map set · --year y el ensayo que sí valida', () => {
  it('--year se traduce a la fecha del catálogo y viaja al servicio', async () => {
    await correr('map', 'set', '1120', '--scheme', 'sat-agrupador', '--value', '102.01', '--year', '2022');
    expect(mundo.ultimoMapeo).toMatchObject({
      scheme: 'sat-agrupador', value: '102.01', opts: { fecha: '2022-12-31' },
    });
  });

  it('sin --year no se fabrica fecha en la CLI', async () => {
    await correr('map', 'set', '1120', '--scheme', 'sat-agrupador', '--value', '102.01');
    expect((mundo.ultimoMapeo as { opts: Record<string, unknown> }).opts.fecha).toBeUndefined();
  });

  it('un --year ilegible es error de uso y NO escribe', async () => {
    const r = await correr('map', 'set', '1120', '--scheme', 'sat-agrupador', '--value', '102.01', '--year', '22');
    expect(r.code).toBe(ExitCode.USAGE);
    expect(mundo.ultimoMapeo).toBeUndefined();
  });

  it('el ensayo VALIDA de verdad y confirma el nombre oficial, sin escribir', async () => {
    const r = await correr(
      'map', 'set', '1120', '--scheme', 'sat-agrupador', '--value', '102.01', '--dry-run'
    );
    expect(mundo.validaciones).toBe(1);
    expect(r.out).toMatch(/sería 102\.01 «Bancos nacionales» \(dry-run\)/);
    expect(mundo.ultimoMapeo).toBeUndefined();
  });

  it('el aviso del validador llega a la terminal, no se queda en el log del servicio', async () => {
    mundo.validacion = {
      codigo: '102.01', veredicto: 'sin_catalogo', nombre: null, accion: 'aceptar_con_aviso',
      aviso: 'El catálogo del SAT no está sembrado para 2022-12-31',
    };
    const r = await correr(
      'map', 'set', '1120', '--scheme', 'sat-agrupador', '--value', '102.01', '--year', '2022', '--dry-run'
    );
    expect(r.err).toMatch(/no está sembrado para 2022-12-31/);
  });

  it('limpiar el mapeo no pasa por el catálogo: borrar no puede estar fuera de él', async () => {
    const r = await correr('map', 'set', '1120', '--scheme', 'sat-agrupador', '--dry-run');
    expect(mundo.validaciones).toBe(0);
    expect(r.out).toMatch(/se limpiaría \(dry-run\)/);
  });

  it('otro esquema no consulta el c_CodAgrup: us-tax-line es otra taxonomía', async () => {
    await correr('map', 'set', '1120', '--scheme', 'us-tax-line', '--value', '1125', '--dry-run');
    expect(mundo.validaciones).toBe(0);
  });
});
