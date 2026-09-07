import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  registerDiotCommand,
  mesDeLaDiot,
  exigirChecksDeDiot,
  exigirLayout,
  filtrarPorChecks,
  checkDelCodigo,
  reciboDeDiot,
  filaDeTercero,
  CODIGOS_POR_CHECK,
  DESCRIPCION_DEL_CHECK,
  DIOT_CHECK_NAMES,
  LAYOUTS,
  PASOS_PARA_PRESENTAR_DIOT,
  TITULAR_NO_PRESENTADA,
  type DiotCommandDeps,
} from '../../src/cli/diot-command.js';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { riskOf, ExitCode } from '../../src/cli/kernel/index.js';
import { FLAG_DICTIONARY } from '../../src/cli/kernel/flags.js';
import { LO_QUE_FALTA_CONFIRMAR } from '../../src/services/sat/diot/index.js';

// ============================================================
// F07c · `diot` contra sus filas del catálogo (docs/cli-command-catalog.md
// 2040-2043) y contra el contrato de salida del núcleo (§4): limpio 0,
// bloqueante 4, aviso 0 salvo --strict, nombre desconocido 2, layout sin
// fundamentar 11.
//
// El patrón es el de e-accounting-command.spec: el programa se arma con un
// doble de `construirDiot` —el motor lo prueban tests/sat/diot/** y la
// integración— y se le habla por parseAsync. Los DOS SERIALIZADORES son los
// de verdad: el papel de trabajo que sale por stdout en `export` es byte por
// byte el que produce el módulo, que es lo único que hace verificable la
// promesa de «byte-estable para diffear».
//
// LAS DOS PRUEBAS QUE MÁS IMPORTAN DE ESTE ARCHIVO no son de forma:
//
//   1. Las tres hojas dicen SIEMPRE que la DIOT no se presentó. Un contador
//      que cierre la terminal creyendo que presentó descubre el error cuando
//      le llega el requerimiento.
//   2. Ningún código de hallazgo del motor se queda sin clasificar. Un código
//      nuevo sin nombre de verificación desaparecería de un `--check`
//      selectivo sin que nadie lo notase: un verde que miente.
// ============================================================

const mundo = vi.hoisted(() => ({
  diot: undefined as unknown,
  ultima: undefined as unknown,
  /** Cuántas veces se llamó al motor: `--check` a secas ha de ser 0. */
  llamadas: 0,
}));

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
  resolveEntity: (id?: string) =>
    Promise.resolve({
      tenantId: 'T1',
      entityId: id ?? 'E1',
      entityName: 'Acme SA de CV',
      currency: 'MXN',
      country: 'MX',
      accountingStandard: 'NIF',
      taxId: 'AAA010101AAA',
    }),
  listEntities: () => Promise.resolve([{ id: 'E1' }]),
}));

// Sólo `construirDiot` es doble. Los serializadores, `contarHallazgos` y
// `esEntregable` son los REALES: son la parte cuya salida se afirma.
vi.mock('../../src/services/sat/diot/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/sat/diot/index.js')>();
  return {
    ...real,
    construirDiot: (opts: unknown) => {
      mundo.llamadas += 1;
      mundo.ultima = opts;
      return Promise.resolve(mundo.diot);
    },
  };
});

/** Paleta identidad: se afirma sobre el texto, no sobre códigos ANSI. */
const plain = {
  dim: (s: string) => s,
  bold: (s: string) => s,
  cyan: (s: string) => s,
  red: (s: string) => s,
  green: (s: string) => s,
  yellow: (s: string) => s,
};

const CERO = { base: '0.0000', iva: '0.0000' };

function desglose(over: Record<string, unknown> = {}) {
  return { tasa16: CERO, tasa8: CERO, tasa0: CERO, exento: CERO, otras: [], ...over };
}

function tercero(over: Record<string, unknown> = {}) {
  return {
    tercero: {
      vendorId: 'V1',
      nombre: 'Aceros & Cía SA de CV',
      tipoTercero: '04',
      tipoOperacion: '85',
      rfc: 'AAC050505AB1',
      procedencia: { tipoTercero: 'declarado', tipoOperacion: 'declarado' },
    },
    desglose: desglose({ tasa16: { base: '1000.0000', iva: '160.0000' } }),
    ivaRetenido: '0.0000',
    documentos: [
      {
        billId: 'B1',
        billNumber: 'F-001',
        metodo: 'PUE',
        origenDelMetodo: 'cfdi',
        ivaPagado: '160.0000',
        ivaRetenido: '0.0000',
        desglose: desglose({ tasa16: { base: '1000.0000', iva: '160.0000' } }),
      },
    ],
    ...over,
  };
}

function diot(over: Record<string, unknown> = {}) {
  return {
    periodo: { anio: 2026, mes: 2, desde: '2026-02-01', hasta: '2026-02-28' },
    rfc: 'AAA010101AAA',
    razonSocial: 'Acme SA de CV',
    renglones: [tercero()],
    totales: {
      desglose: desglose({ tasa16: { base: '1000.0000', iva: '160.0000' } }),
      ivaRetenido: '0.0000',
      ivaAcreditablePagado: '160.0000',
      terceros: 1,
      documentos: 1,
    },
    politicas: [
      { clave: 'diot_tipo_operacion_por_omision', valor: '85', definida: false },
      { clave: 'diot_tercero_sin_rfc', valor: 'bloquear', definida: true },
      { clave: 'diot_iva_exento_y_base', valor: 'exigir_base', definida: false },
    ],
    hallazgos: [],
    ...over,
  };
}

const BLOQUEA = {
  codigo: 'DIOT-SIN-RFC',
  severidad: 'bloqueante' as const,
  politica: 'diot_tercero_sin_rfc',
  vendorId: 'V2',
  mensaje: 'El proveedor Fletes del Bajío no tiene RFC usable.',
};
const AVISA = {
  codigo: 'DIOT-TIPO-OPERACION-POR-OMISION',
  severidad: 'aviso' as const,
  politica: 'diot_tipo_operacion_por_omision',
  vendorId: 'V1',
  mensaje: 'Aceros & Cía se declara con tipo de operación 85 por omisión.',
};

beforeEach(() => {
  mundo.llamadas = 0;
  mundo.ultima = undefined;
  mundo.diot = diot();
});

// ---- las funciones puras -------------------------------------------

describe('mesDeLaDiot: el mes se exige, no se supone', () => {
  it('YYYY-MM se traduce a año y mes', () => {
    expect(mesDeLaDiot('2026-02')).toEqual({ anio: 2026, mes: 2 });
    expect(mesDeLaDiot('  2015-12 ')).toEqual({ anio: 2015, mes: 12 });
  });

  it('sin --period se rehúsa: adivinar el mes declara el mes equivocado', () => {
    for (const v of [undefined, '', '   ']) {
      expect(() => mesDeLaDiot(v)).toThrow(/--period YYYY-MM/);
    }
  });

  it('un trimestre o un ejercicio no se declaran: la DIOT es mensual', () => {
    for (const v of ['2026-Q1', 'FY2026', 'last-month', '2026-01..2026-06', '2026']) {
      expect(() => mesDeLaDiot(v), v).toThrow(/YYYY-MM/);
    }
  });

  it('el mes 13 es de la balanza de cierre, no de una declaración informativa', () => {
    expect(() => mesDeLaDiot('2026-13')).toThrow(/mes 13/);
    expect(() => mesDeLaDiot('2026-00')).toThrow(/01 a 12/);
  });
});

describe('los nombres de verificación cubren TODO lo que el motor emite', () => {
  /**
   * Lee el código fuente del motor y saca cada `codigo: 'X'`.
   *
   * Es deliberadamente burdo —una expresión regular sobre el fuente— y ésa es
   * la gracia: no hay forma de añadir un código al motor sin que esta prueba
   * lo vea. La alternativa, una lista escrita a mano en este archivo, se
   * queda vieja el día que otro frente toque `desglose.ts`.
   */
  const codigosDelMotor = (): string[] => {
    const dir = path.join(process.cwd(), 'src/services/sat/diot');
    const codigos = new Set<string>();
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
      const fuente = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of fuente.matchAll(/codigo:\s*'([A-Z0-9-]+)'/g)) codigos.add(m[1]);
    }
    return [...codigos].sort();
  };

  it('el fuente se lee: si no, esta prueba no prueba nada', () => {
    expect(codigosDelMotor().length).toBeGreaterThan(10);
    expect(codigosDelMotor()).toContain('DIOT-SIN-RFC');
  });

  it('ningún código del motor se queda sin nombre de verificación', () => {
    const huerfanos = codigosDelMotor().filter((c) => checkDelCodigo(c) === undefined);
    expect(
      huerfanos,
      'un código sin clasificar desaparece de un `--check` selectivo sin que nadie lo note. ' +
        'Clasifícalo en CODIGOS_POR_CHECK de src/cli/diot-command.ts.'
    ).toEqual([]);
  });

  it('ningún nombre clasifica un código que ya no existe', () => {
    const vivos = new Set(codigosDelMotor());
    const muertos = Object.values(CODIGOS_POR_CHECK)
      .flatMap((cs) => [...cs])
      .filter((c) => !vivos.has(c));
    expect(muertos, 'entradas muertas: el motor ya no emite estos códigos').toEqual([]);
  });

  it('cada código cae en UN solo nombre, y cada nombre tiene su descripción', () => {
    const vistos = new Map<string, string>();
    for (const nombre of DIOT_CHECK_NAMES) {
      expect(DESCRIPCION_DEL_CHECK[nombre], nombre).toBeTruthy();
      for (const codigo of CODIGOS_POR_CHECK[nombre]) {
        expect(vistos.has(codigo), `${codigo} está en dos verificaciones`).toBe(false);
        vistos.set(codigo, nombre);
      }
    }
  });
});

describe('exigirChecksDeDiot y filtrarPorChecks', () => {
  it('un nombre desconocido lista los disponibles y es error de USO', () => {
    expect(exigirChecksDeDiot('tercero-identificado,hecho-pagado')).toEqual([
      'tercero-identificado',
      'hecho-pagado',
    ]);
    expect(() => exigirChecksDeDiot('no-existe')).toThrow(/no-existe/);
    expect(() => exigirChecksDeDiot('no-existe')).toThrow(/desglose-por-tasa/);
    // Una lista vacía NO es «todas»: sería un check que no verificó nada y
    // contestó limpio.
    expect(() => exigirChecksDeDiot(' , ')).toThrow(/no nombró ninguna/);
  });

  it('sin --check pasan todos; con --check sólo los del nombre pedido', () => {
    const todos = [BLOQUEA, AVISA];
    expect(filtrarPorChecks(todos, undefined)).toHaveLength(2);
    expect(filtrarPorChecks(todos, ['tercero-identificado'])).toEqual([BLOQUEA]);
    expect(filtrarPorChecks(todos, ['tipo-de-operacion'])).toEqual([AVISA]);
  });

  it('un código SIN clasificar sobrevive a cualquier filtro: nunca se esconde', () => {
    const raro = { ...BLOQUEA, codigo: 'DIOT-INVENTADO-MANANA' };
    expect(filtrarPorChecks([raro], ['tipo-de-operacion'])).toEqual([raro]);
  });
});

describe('exigirLayout: el archivo de la autoridad NO es el valor por omisión', () => {
  it('sin --layout sale el papel de trabajo, que es el único que existe', () => {
    expect(exigirLayout(undefined).esArchivoDeclarable).toBe(false);
    expect(exigirLayout('working-paper')).toBe(LAYOUTS['working-paper']);
  });

  it('sat es el archivo declarable, y es el que se niega', () => {
    expect(exigirLayout('sat').esArchivoDeclarable).toBe(true);
  });

  it('un layout inventado lista los que hay', () => {
    expect(() => exigirLayout('txt')).toThrow(/working-paper/);
    expect(() => exigirLayout('txt')).toThrow(/sat/);
  });

  it('--layout está en el diccionario de banderas y sin forma corta', () => {
    expect(Object.prototype.hasOwnProperty.call(FLAG_DICTIONARY, '--layout')).toBe(true);
    expect(FLAG_DICTIONARY['--layout']).toBeNull();
  });
});

describe('el recibo dice siempre que NO se presentó', () => {
  it('presentada:false, los pasos que quedan y los criterios aplicados', () => {
    const fila = reciboDeDiot(diot() as never);
    expect(fila.presentada).toBe(false);
    expect(fila.entregable).toBe(true);
    expect(fila.falta_para_presentar).toEqual([...PASOS_PARA_PRESENTAR_DIOT]);
    expect(fila.criterio_diot_tercero_sin_rfc).toBe('bloquear');
    expect(fila.criterio_diot_tercero_sin_rfc_origen).toBe('contestada');
    expect(fila.criterio_diot_tipo_operacion_por_omision_origen).toBe('omision');
  });

  it('el dinero viaja como CADENA con cuatro decimales, nunca como número', () => {
    const fila = reciboDeDiot(diot() as never);
    for (const campo of ['iva_acreditable_pagado', 'base_16', 'iva_16', 'iva_retenido']) {
      expect(typeof fila[campo], campo).toBe('string');
    }
    expect(fila.iva_acreditable_pagado).toBe('160.0000');
    expect(filaDeTercero(tercero() as never).base_16).toBe('1000.0000');
  });

  it('los pasos no mandan a un comando que no existe', () => {
    const texto = PASOS_PARA_PRESENTAR_DIOT.join(' ');
    expect(texto).toMatch(/portal del SAT/);
    expect(texto).toMatch(/acuse/);
    // `diot record` se nombra SÓLO para decir que no está construido.
    expect(texto).toMatch(/`diot record` no está construido/);
  });
});

// ---- el registro ---------------------------------------------------

describe('registro de la familia diot', () => {
  const program = new Command();
  registerDiotCommand(program, {
    palette: plain,
    shutdown: () => undefined,
    reportError: () => undefined,
  });
  const familia = program.commands.find((c) => c.name() === 'diot');
  const hoja = (n: string) => familia?.commands.find((c) => c.name() === n);

  it('`diot` no lleva alias: es la misma palabra en los dos idiomas', () => {
    expect(familia).toBeDefined();
    expect(familia?.aliases()).toEqual([]);
  });

  it('tres hojas con sus alias españoles, y NINGUNA más', () => {
    expect((familia?.commands ?? []).map((c) => c.name()).sort()).toEqual([
      'check',
      'export',
      'generate',
    ]);
    expect(hoja('generate')?.aliases()).toContain('generar');
    expect(hoja('check')?.aliases()).toContain('verificar');
    expect(hoja('export')?.aliases()).toContain('exportar');
  });

  it('`record` NO existe: su almacén no guarda acuse ni línea de captura', () => {
    expect((familia?.commands ?? []).map((c) => c.name())).not.toContain('record');
  });

  it('las tres son lectura + IA ✓: nada de esto escribe una fila', () => {
    for (const n of ['generate', 'check', 'export']) {
      const r = riskOf(hoja(n) as Command);
      expect(r?.risk, n).toBe('lectura');
      expect(r?.agentAllowed, n).toBe(true);
      expect(r?.requiresLiveGate, n).toBe(false);
      expect(r?.requiresDryRun, n).toBe(false);
    }
  });

  it('pasa la auditoría de consistencia sin violaciones', () => {
    expect(auditProgram(program)).toEqual([]);
  });

  it('las tres llevan el grupo de salida COMPLETO, no --json suelto', () => {
    for (const n of ['generate', 'check', 'export']) {
      const longs = hoja(n)?.options.map((o) => o.long);
      expect(longs, n).toEqual(
        expect.arrayContaining(['--format', '--json', '--fields', '--output', '--quiet'])
      );
      expect(longs, n).toEqual(expect.arrayContaining(['--entity', '--tenant', '--user']));
      expect(longs, n).toContain('--period');
    }
  });

  it('las banderas de cada fila del catálogo están, con su forma corta', () => {
    expect(hoja('check')?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--period', '--check', '--strict', '--json'])
    );
    expect(hoja('export')?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--period', '--format', '--output', '--layout'])
    );
    expect(hoja('export')?.options.find((o) => o.long === '--output')?.short).toBe('-o');
  });

  it('la ayuda de -o en `export` dice lo que -o HACE: el archivo, no la salida', () => {
    const o = hoja('export')?.options.find((x) => x.long === '--output');
    expect(o?.description).toContain('exported file');
    expect(o?.description).not.toContain('instead of stdout');
    // En `check` NO se toca: allí `-o` conserva su significado del núcleo.
    expect(hoja('check')?.options.find((x) => x.long === '--output')?.description).toContain(
      'instead of stdout'
    );
  });

  it('la ayuda avisa ANTES de ejecutar que esto no presenta nada', () => {
    for (const n of ['generate', 'export']) {
      const cmd = hoja(n) as Command;
      let texto = '';
      cmd.configureOutput({
        writeOut: (s: string) => {
          texto += s;
        },
      });
      cmd.outputHelp();
      expect(texto, n).toMatch(/does NOT file it/);
      expect(texto, n).toMatch(/never loads an e\.firma/);
    }
  });

  it('`check` dice en su ayuda qué NO verifica y por qué', () => {
    const cmd = hoja('check') as Command;
    let texto = '';
    cmd.configureOutput({
      writeOut: (s: string) => {
        texto += s;
      },
    });
    cmd.outputHelp();
    expect(texto).toMatch(/against the VAT return of the/);
    expect(texto).toMatch(/`filing preview` is not built/);
  });
});

// ---- conducta ------------------------------------------------------

const tmpRaiz = fs.mkdtempSync(path.join(os.tmpdir(), 'f07c-cli-'));
afterAll(() => {
  fs.rmSync(tmpRaiz, { recursive: true, force: true });
});

async function correr(argv: string[], extra: Partial<DiotCommandDeps> = {}) {
  let exitCode: number | undefined;
  const errs: unknown[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const stdoutOriginal = process.stdout.write.bind(process.stdout);
  const stderrOriginal = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string | Uint8Array) => {
    out.push(String(c));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => {
    err.push(String(c));
    return true;
  }) as typeof process.stderr.write;
  try {
    const p = new Command('mnemosine').exitOverride();
    registerDiotCommand(p, {
      palette: plain,
      shutdown: (c: number) => {
        exitCode = c;
      },
      reportError: (e: unknown) => {
        errs.push(e);
      },
      ...extra,
    });
    await p.parseAsync(['node', 'mnemosine', ...argv]);
  } finally {
    process.stdout.write = stdoutOriginal;
    process.stderr.write = stderrOriginal;
  }
  return { exitCode, errs, out: out.join(''), err: err.join('') };
}

const E = ['-e', 'E1'];

describe('diot generate · la declaración y la advertencia que la acompaña', () => {
  it('arma el mes, enseña las casillas y DICE que no se presentó', async () => {
    const r = await correr(['diot', 'generate', '--period', '2026-02', ...E]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.out).toMatch(/DIOT 02\/2026/);
    expect(r.out).toMatch(/AAA010101AAA/);
    expect(r.out).toMatch(/IVA acreditable pagado en el mes\s+160\.00/);
    expect(r.err, 'la advertencia del tramo entero').toContain(TITULAR_NO_PRESENTADA);
    for (const paso of PASOS_PARA_PRESENTAR_DIOT) {
      expect(r.err).toContain(paso);
    }
  });

  it('el mes llega al motor tal cual, con el inquilino y la entidad', async () => {
    await correr(['diot', 'generate', '--period', '2026-02', ...E]);
    expect(mundo.ultima).toEqual({ tenantId: 'T1', entityId: 'E1', anio: 2026, mes: 2 });
  });

  it('el alias español entero funciona: diot generar', async () => {
    const r = await correr(['diot', 'generar', '--period', '2026-02', ...E]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.err).toContain(TITULAR_NO_PRESENTADA);
  });

  it('el mes se valida ANTES de tocar la base: un typo no cuesta una conexión', async () => {
    const r = await correr(['diot', 'generate', '--period', '2026-Q1', ...E]);
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(mundo.llamadas).toBe(0);
  });

  it('un hallazgo bloqueante sale 4 y lo dice: no se captura tal cual', async () => {
    mundo.diot = diot({ hallazgos: [BLOQUEA] });
    const r = await correr(['diot', 'generate', '--period', '2026-02', ...E]);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    expect(r.err).toContain('DIOT-SIN-RFC');
    expect(r.err).toMatch(/impiden capturar/);
    // Y aun así dice lo que falta para presentar: no se presentó nada.
    expect(r.err).toContain(TITULAR_NO_PRESENTADA);
  });

  it('--json publica el recibo con presentada:false y los hallazgos anidados', async () => {
    mundo.diot = diot({ hallazgos: [AVISA] });
    const r = await correr(['diot', 'generate', '--period', '2026-02', '--json', ...E]);
    const sobre = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    const fila = sobre.rows[0];
    expect(fila.presentada).toBe(false);
    expect(fila.iva_acreditable_pagado).toBe('160.0000');
    expect((fila.hallazgos as unknown[]).length).toBe(1);
    expect(r.exitCode).toBe(ExitCode.OK);
  });
});

describe('diot check · las invariantes por nombre, con el contrato §4', () => {
  it('`--check` a secas lista las verificaciones SIN tocar la base', async () => {
    const r = await correr(['diot', 'check', '--check', ...E]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(mundo.llamadas).toBe(0);
    for (const n of DIOT_CHECK_NAMES) expect(r.out).toContain(n);
  });

  it('sin hallazgos sale 0 y lo dice con todas las verificaciones', async () => {
    const r = await correr(['diot', 'check', '--period', '2026-02', ...E]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.out).toMatch(/sin hallazgos/);
    expect(r.out).toContain('tercero-identificado');
  });

  it('un bloqueante sale 4; un aviso sale 0 salvo --strict', async () => {
    mundo.diot = diot({ hallazgos: [BLOQUEA] });
    expect((await correr(['diot', 'check', '--period', '2026-02', ...E])).exitCode).toBe(
      ExitCode.VALIDATION
    );

    mundo.diot = diot({ hallazgos: [AVISA] });
    expect((await correr(['diot', 'check', '--period', '2026-02', ...E])).exitCode).toBe(
      ExitCode.OK
    );
    expect(
      (await correr(['diot', 'check', '--period', '2026-02', '--strict', ...E])).exitCode
    ).toBe(ExitCode.VALIDATION);
  });

  it('--check selectivo deja fuera lo que no pidió, y el código lo sigue', async () => {
    mundo.diot = diot({ hallazgos: [BLOQUEA, AVISA] });
    const r = await correr([
      'diot', 'check', '--period', '2026-02', '--check', 'tipo-de-operacion', ...E,
    ]);
    // Sólo queda el aviso: el bloqueante era de otra verificación, así que
    // sale 0. Ése es justamente el valor de poder pedir una sola.
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.out).toContain('DIOT-TIPO-OPERACION-POR-OMISION');
    expect(r.out).not.toContain('DIOT-SIN-RFC');
  });

  it('un nombre de verificación desconocido es error de USO, no un filtro vacío', async () => {
    const r = await correr(['diot', 'check', '--period', '2026-02', '--check', 'nada', ...E]);
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(mundo.llamadas).toBe(0);
  });

  it('--json publica los hallazgos como FILAS, con su check y su código', async () => {
    mundo.diot = diot({ hallazgos: [BLOQUEA] });
    const r = await correr(['diot', 'check', '--period', '2026-02', '--json', ...E]);
    const sobre = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    expect(sobre.rows[0].check).toBe('tercero-identificado');
    expect(sobre.rows[0].codigo).toBe('DIOT-SIN-RFC');
    expect(sobre.rows[0].severity).toBe('blocking');
    expect(sobre.rows[0].politica).toBe('diot_tercero_sin_rfc');
  });
});

describe('diot export · el papel de trabajo, y la negativa del archivo de lote', () => {
  it('sin -o el ARCHIVO sale por stdout, crudo, para poder diffearlo', async () => {
    const r = await correr(['diot', 'export', '--period', '2026-02', ...E]);
    expect(r.exitCode).toBe(ExitCode.OK);
    // Primera línea del papel de trabajo real, no un recibo.
    expect(r.out.startsWith('# PAPEL DE TRABAJO DE LA DIOT')).toBe(true);
    expect(r.out).toContain('ESTO NO ES EL ARCHIVO DE LA DECLARACIÓN');
    // El sobre no ensucia la tubería.
    expect(r.out).not.toContain(TITULAR_NO_PRESENTADA);
    expect(r.err).toContain(TITULAR_NO_PRESENTADA);
  });

  it('la salida es byte-estable: dos corridas iguales dan los mismos bytes', async () => {
    const a = await correr(['diot', 'export', '--period', '2026-02', ...E]);
    const b = await correr(['diot', 'export', '--period', '2026-02', ...E]);
    expect(a.out).toBe(b.out);
    expect(a.out.length).toBeGreaterThan(0);
  });

  it('el nombre del tercero con una barra vertical no corre las columnas', async () => {
    mundo.diot = diot({
      renglones: [
        tercero({
          tercero: {
            vendorId: 'V9',
            nombre: 'Fletes | del Bajío',
            tipoTercero: '04',
            tipoOperacion: '85',
            rfc: 'FDB090909XY0',
            procedencia: { tipoTercero: 'declarado', tipoOperacion: 'politica' },
          },
        }),
      ],
    });
    const r = await correr(['diot', 'export', '--period', '2026-02', ...E]);
    const fila = r.out.split('\n').find((l) => l.startsWith('04|'));
    expect(fila).toBeDefined();
    // La cabecera declara 16 columnas: la fila tiene que traer 16.
    expect((fila as string).split('|')).toHaveLength(16);
    // El saneado sustituye la barra por un espacio y NO recompone: lo que
    // importa es que el separador desaparezca, no que el nombre quede bonito.
    expect(fila).not.toContain('Fletes |');
    expect(fila).toMatch(/Fletes\s+del Bajío/);
  });

  it('con -o escribe el archivo y el recibo pasa a stdout', async () => {
    const destino = path.join(tmpRaiz, 'sub', 'diot-202602.txt');
    const r = await correr(['diot', 'export', '--period', '2026-02', '-o', destino, ...E]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(fs.readFileSync(destino, 'utf8')).toContain('PAPEL DE TRABAJO');
    expect(r.out).toMatch(/DIOT 02\/2026/);
    expect(r.out).toContain(destino);
  });

  it('no pisa un archivo existente sin --yes: un papel anotado no se reemplaza', async () => {
    const destino = path.join(tmpRaiz, 'ya-existe.txt');
    fs.writeFileSync(destino, 'anotado a mano');
    const r = await correr(['diot', 'export', '--period', '2026-02', '-o', destino, ...E]);
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(fs.readFileSync(destino, 'utf8')).toBe('anotado a mano');

    const conYes = await correr([
      'diot', 'export', '--period', '2026-02', '-o', destino, '-y', ...E,
    ]);
    expect(conYes.exitCode).toBe(ExitCode.OK);
    expect(fs.readFileSync(destino, 'utf8')).toContain('PAPEL DE TRABAJO');
  });

  it('--layout sat SE NIEGA con 11 y enumera lo que hay que confirmar', async () => {
    const r = await correr(['diot', 'export', '--period', '2026-02', '--layout', 'sat', ...E]);
    // 11 y no 1: el trabajo no falló, espera a que una persona confirme el
    // layout contra el vigente. Y no 0 con un archivo inventado, que es el
    // error que este repositorio ya cometió y borró.
    expect(r.exitCode).toBe(ExitCode.NEEDS_HUMAN);
    const mensaje = (r.errs[0] as Error).message;
    for (const punto of LO_QUE_FALTA_CONFIRMAR) expect(mensaje).toContain(punto);
    expect(mensaje).toContain('--layout working-paper');
    expect(r.out).toBe('');
  });

  it('--layout sat con un bloqueante se niega ANTES, por no entregable', async () => {
    mundo.diot = diot({ hallazgos: [BLOQUEA] });
    const r = await correr(['diot', 'export', '--period', '2026-02', '--layout', 'sat', ...E]);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    expect((r.errs[0] as Error).message).toContain('DIOT-SIN-RFC');
  });

  it('con un bloqueante el papel de trabajo SÍ se escribe, y sale 4', async () => {
    mundo.diot = diot({ hallazgos: [BLOQUEA] });
    const r = await correr(['diot', 'export', '--period', '2026-02', ...E]);
    // El papel de trabajo existe justo para arreglar esto: negárselo al
    // contador sería quitarle la herramienta con la que se arregla.
    expect(r.out).toContain('LA DECLARACIÓN NO SE PUEDE ENTREGAR TAL CUAL');
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
  });
});
