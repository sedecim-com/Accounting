import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from 'vitest';
import { Command } from 'commander';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  registerEAccountingCommand,
  mesDelCatalogo,
  exigirTipoDeEnvio,
  exigirChecksDeBalanza,
  reciboDeCatalogo,
  reciboDeBalanza,
  renderHallazgos,
  PASOS_PARA_PRESENTAR,
  type EAccountingCommandDeps,
} from '../../src/cli/e-accounting-command.js';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { riskOf, ExitCode } from '../../src/cli/kernel/index.js';
import { BALANZA_CHECK_NAMES } from '../../src/services/sat/anexo24/balanza-invariantes.js';
import { OfficialXsdRefusal } from '../../src/services/sat/anexo24/official-xsd.js';
import { ValidationError } from '../../src/utils/errors.js';
import { resetLanguage, setLanguage, t } from '../../src/i18n/index.js';
import { changePolicyHint } from '../../src/services/policy/policy-hint.js';

// ============================================================
// F07b · `e-accounting` · `contabilidad-electronica` contra su fila del
// catálogo (docs/cli-command-catalog.md 2060, 2063, 2064) y contra el
// contrato de salida del núcleo (§4): limpio 0, bloqueante 4, aviso 0 salvo
// --strict, nombre desconocido 2, confirmación declinada 10.
//
// El patrón es el de closing-command.spec: el programa se arma con dobles de
// los servicios —el motor del Anexo 24 lo prueban anexo24-*.spec y la
// integración—, se le habla por parseAsync y se afirma sobre stdout, stderr y
// el código con que pidió apagarse.
//
// LA PRUEBA QUE MÁS IMPORTA DE ESTE ARCHIVO no es ninguna de las de forma: es
// que las dos hojas `generate` digan SIEMPRE que el archivo no va sellado y
// que no se presentó nada. Un contador que cierre la terminal creyendo que ya
// presentó es el peor resultado posible del tramo, y esa promesa se clava
// aquí, en los dos formatos de salida.
// ============================================================

// ---- dobles --------------------------------------------------------

const mundo = vi.hoisted(() => ({
  catalogo: undefined as unknown,
  balanza: undefined as unknown,
  verificacion: undefined as unknown,
  /** Lo último que el CLI le pasó a cada servicio, para afirmar el traspaso. */
  ultimoCatalogo: undefined as unknown,
  ultimaBalanza: undefined as unknown,
  ultimaVerificacion: undefined as unknown,
  /** Cuántas veces se llamó a un servicio: `--check` a secas ha de ser 0. */
  llamadas: 0,
  /** Lo que `generarBalanza` debe lanzar en vez de devolver. */
  balanzaLanza: undefined as Error | undefined,
  /** What the CLI handed to sealArchivedDocument (EFIRMA-4). */
  ultimoSello: undefined as unknown,
}));

vi.mock('../../src/services/sat/anexo24/seal.js', () => ({
  sealArchivedDocument: (req: unknown) => {
    mundo.ultimoSello = req;
    return Promise.resolve({
      xml: '<sealed/>',
      sealedFrom: 'art-unsealed',
      sourceHash: 's'.repeat(64),
      certificateNumber: '00001000000000000145',
      artifact: { id: 'art-sealed', hash_sha256: 'h'.repeat(64), bytes: 9, generado_en: '', yaExistia: false },
    });
  },
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

vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: () => Promise.resolve({ userId: 'U-1', email: 'contador@despacho.mx' }),
}));

vi.mock('../../src/services/sat/anexo24/index.js', () => ({
  // Real: los bytes que se escriben en disco tienen que ser los que se
  // hashearon, y ésa es justamente una de las cosas que aquí se comprueba.
  bytesDe: (xml: string) => Buffer.from(xml, 'utf8'),
  generarCatalogoCuentas: (_ctx: unknown, opts: unknown) => {
    mundo.llamadas += 1;
    mundo.ultimoCatalogo = opts;
    return Promise.resolve(mundo.catalogo);
  },
}));

vi.mock('../../src/services/sat/anexo24/balanza-service.js', () => ({
  generarBalanza: (entityId: string, opts: unknown) => {
    mundo.llamadas += 1;
    mundo.ultimaBalanza = { entityId, opts };
    if (mundo.balanzaLanza) return Promise.reject(mundo.balanzaLanza);
    return Promise.resolve(mundo.balanza);
  },
  resolverPeriodoDeBalanza: (_entityId: string, opts: Record<string, unknown>) =>
    Promise.resolve({ anio: 2026, mes: opts.cierre === true ? '13' : '07', cierre: opts.cierre === true }),
  verificarBalanza: (entityId: string, opts: unknown) => {
    mundo.llamadas += 1;
    mundo.ultimaVerificacion = { entityId, opts };
    return Promise.resolve(mundo.verificacion);
  },
}));

/** Paleta identidad: se afirma sobre el texto, no sobre códigos ANSI. */
const plain = {
  dim: (s: string) => s,
  bold: (s: string) => s,
  cyan: (s: string) => s,
  red: (s: string) => s,
  green: (s: string) => s,
  yellow: (s: string) => s,
};

const XML_CATALOGO =
  '<?xml version="1.0" encoding="UTF-8"?>\n<catalogocuentas:Catalogo Version="1.3"/>';
const XML_BALANZA = '<?xml version="1.0" encoding="UTF-8"?>\n<BCE:Balanza Version="1.3"/>';

function catalogo(over: Record<string, unknown> = {}) {
  return {
    entityId: 'E1',
    rfc: 'AAA010101AAA',
    anio: 2026,
    mes: 2,
    xml: XML_CATALOGO,
    hash: 'c0ffee'.repeat(8),
    bytes: Buffer.byteLength(XML_CATALOGO, 'utf8'),
    filas: [
      { NumCta: '1120', Desc: 'Bancos', CodAgrup: '102', Nivel: 2, Natur: 'D' as const },
      { NumCta: '4100', Desc: 'Ingresos', CodAgrup: '401', Nivel: 2, Natur: 'A' as const },
    ],
    omitidas: [],
    sinAgrupador: [],
    hallazgos: [],
    puedeEntregarse: true,
    sellado: false as const,
    notaDeSellado: 'El sellado y la transmisión son actos tuyos.',
    politicas: {
      niveles: 'jerarquia_completa',
      sinAgrupador: 'bloquear',
      sellado: 'nunca_sellar_en_el_sistema',
    },
    artefacto: {
      id: 'ART-1',
      hash_sha256: 'c0ffee'.repeat(8),
      bytes: 64,
      generado_en: '2026-09-02 19:04:33',
      yaExistia: false,
    },
    ...over,
  };
}

const META_BALANZA = {
  tenant_id: 'T1',
  entity_id: 'E1',
  rfc: 'AAA010101AAA',
  anio: 2026,
  mes: '02',
  tipo_envio: 'N' as const,
  cierre: false,
  period_name: 'Febrero 2026',
  desde: '2026-02-01',
  hasta: '2026-02-28',
  cuentas: 3,
  criterio_niveles: 'jerarquia_completa',
  criterio_sellado: 'nunca_sellar_en_el_sistema',
  sellada: false,
};

const INICIAL = {
  criterio: 'derivado_del_mayor',
  origen: 'mayor' as const,
  desde: '2026-02-01',
  firme: true,
  periodo_anterior: { period_name: 'Enero 2026', status: 'closed' },
  descuadres: [],
  note: 'SaldoIni derivado del mayor; el periodo anterior está cerrado.',
};

function balanza(over: Record<string, unknown> = {}) {
  return {
    xml: XML_BALANZA,
    hash: 'beef'.repeat(16),
    bytes: Buffer.byteLength(XML_BALANZA, 'utf8'),
    nombre: 'AAA010101AAA202602BN.XML',
    meta: META_BALANZA,
    inicial: INICIAL,
    hallazgos: [],
    artefacto: {
      id: 'ART-2',
      hash_sha256: 'beef'.repeat(16),
      bytes: 64,
      generado_en: '2026-09-02 19:24:00',
      yaExistia: false,
    },
    ...over,
  };
}

const HALLAZGO_BLOQUEA = {
  check: 'saldos' as const,
  severity: 'blocking' as const,
  referencia: '4100',
  detalle: 'esperado 7000.0000 / obtenido 8300.0000 / −1300.0000',
};
const HALLAZGO_AVISA = {
  check: 'sin-sello' as const,
  severity: 'warning' as const,
  referencia: '',
  detalle: "el criterio está en 'sellar_con_custodia' y este archivo sale SIN Sello",
};

function verificacion(over: Record<string, unknown> = {}) {
  return {
    checks: [...BALANZA_CHECK_NAMES],
    meta: META_BALANZA,
    hallazgos: [],
    conteo: { blocking: 0, warning: 0 },
    inicial: INICIAL,
    catalogo: { origen: 'artefacto_archivado', referencia: 'abc123def456', cuentas: ['1120'] },
    ...over,
  };
}

beforeEach(() => {
  mundo.llamadas = 0;
  mundo.balanzaLanza = undefined;
  mundo.ultimoCatalogo = undefined;
  mundo.ultimaBalanza = undefined;
  mundo.ultimaVerificacion = undefined;
  mundo.catalogo = catalogo();
  mundo.balanza = balanza();
  mundo.verificacion = verificacion();
});

// ---- las funciones puras -------------------------------------------

describe('mesDelCatalogo: el mes se exige, no se supone', () => {
  it('YYYY-MM se traduce a año y mes', () => {
    expect(mesDelCatalogo('2026-02')).toEqual({ anio: 2026, mes: 2 });
    expect(mesDelCatalogo('  2015-12 ')).toEqual({ anio: 2015, mes: 12 });
  });

  it('sin --period se rehúsa: adivinar el mes es archivar enero creyendo diciembre', () => {
    for (const v of [undefined, '', '   ']) {
      expect(() => mesDelCatalogo(v)).toThrow(/--period YYYY-MM/);
    }
  });

  it('un trimestre o un ejercicio no tienen dónde ponerse en la cabecera', () => {
    for (const v of ['2026-Q1', 'FY2026', 'last-month', '2026-01..2026-06', '2026']) {
      expect(() => mesDelCatalogo(v), v).toThrow(/YYYY-MM/);
    }
  });

  it('el 13 manda a --closing en vez de colarse como mes del catálogo', () => {
    expect(() => mesDelCatalogo('2026-13')).toThrow(/--closing/);
    expect(() => mesDelCatalogo('2026-00')).toThrow(/01 to 12/);
  });
});

describe('exigirTipoDeEnvio y exigirChecksDeBalanza', () => {
  it('N y C, en cualquier caja; el cierre NO es un tipo', () => {
    expect(exigirTipoDeEnvio('N')).toBe('N');
    expect(exigirTipoDeEnvio('c')).toBe('C');
    expect(exigirTipoDeEnvio(undefined)).toBeUndefined();
    expect(() => exigirTipoDeEnvio('cierre')).toThrow(/--closing/);
  });

  it('un nombre de verificación desconocido lista los disponibles', () => {
    expect(exigirChecksDeBalanza('saldos,redondeo')).toEqual(['saldos', 'redondeo']);
    expect(() => exigirChecksDeBalanza('no-existe')).toThrow(/no-existe/);
    expect(() => exigirChecksDeBalanza('no-existe')).toThrow(/cuentas-en-catalogo/);
    // Una lista vacía NO es «todas»: sería un check que no verificó nada y
    // contestó limpio.
    expect(() => exigirChecksDeBalanza(' , ')).toThrow(/--check named no check/);
  });
});

describe('los recibos llevan siempre el sello ausente y lo que falta', () => {
  it('el del catálogo publica sellado:false y los pasos que quedan', () => {
    const fila = reciboDeCatalogo(catalogo() as never, '/tmp/x.xml');
    expect(fila.sellado).toBe(false);
    expect(fila.falta_para_presentar).toEqual([...PASOS_PARA_PRESENTAR]);
    expect(fila.entregable).toBe(true);
    expect(fila.archivado).toBe('nuevo');
  });

  it('el de la balanza publica sellada:false y si el SaldoIni es firme', () => {
    const fila = reciboDeBalanza(balanza() as never, '(artifact store)');
    expect(fila.sellada).toBe(false);
    expect(fila.saldo_inicial_firme).toBe(true);
    expect(fila.falta_para_presentar).toEqual([...PASOS_PARA_PRESENTAR]);
  });

  it('los pasos no mandan a ningún comando: `catalog file` no está construido', () => {
    const texto = PASOS_PARA_PRESENTAR.join(' ');
    expect(texto).not.toMatch(/mnemosine/);
    expect(texto).toMatch(/e\.firma/);
    expect(texto).toMatch(/Buzón Tributario/);
    expect(texto).toMatch(/acknowledgement of receipt/);
  });
});

describe('renderHallazgos: la cuenta y la diferencia, con su peso', () => {
  it('marca, nombre, cuenta y detalle por hallazgo', () => {
    const lineas = renderHallazgos(
      [
        { severity: 'blocking', nombre: 'saldos', referencia: '4100', detalle: '−1300.0000' },
        { severity: 'warning', nombre: 'sin-sello', referencia: '', detalle: 'sin Sello' },
      ],
      plain
    ).join('\n');
    expect(lineas).toMatch(/✘ saldos\s+4100\s+\[blocking\]\s+−1300\.0000/);
    expect(lineas).toMatch(/⚠ sin-sello\s+\[warning\]\s+sin Sello/);
  });

  it('sin hallazgos no inventa una línea', () => {
    expect(renderHallazgos([], plain)).toEqual([]);
  });
});

// ---- el registro ---------------------------------------------------

describe('registro de la familia e-accounting', () => {
  const program = new Command();
  registerEAccountingCommand(program, {
    palette: plain,
    shutdown: () => undefined,
    reportError: () => undefined,
  });
  const familia = program.commands.find((c) => c.name() === 'e-accounting');
  const grupo = (n: string) => familia?.commands.find((c) => c.name() === n);
  const hoja = (g: string, n: string) => grupo(g)?.commands.find((c) => c.name() === n);

  it('e-accounting · contabilidad-electronica, con los dos sustantivos intermedios', () => {
    expect(familia).toBeDefined();
    expect(familia?.aliases()).toContain('contabilidad-electronica');
    expect(grupo('catalog')?.aliases()).toContain('catalogo');
    expect(grupo('balance')?.aliases()).toContain('balanza');
    expect((familia?.commands ?? []).map((c) => c.name()).sort()).toEqual([
      'balance',
      'catalog',
      'subledger',
      'voucher',
    ]);
  });

  it('the phase-1 rows, with their Spanish aliases (seal since EFIRMA-4, #442)', () => {
    expect(grupo('catalog')?.commands.map((c) => c.name()).sort()).toEqual(['generate', 'seal']);
    expect(grupo('balance')?.commands.map((c) => c.name()).sort()).toEqual(['check', 'generate', 'seal']);
    for (const g of ['catalog', 'balance']) {
      expect(hoja(g, 'seal')?.aliases(), g).toContain('sellar');
      // The taxpayer's signature: a write the agent may not invoke, whatever the flags.
      const r = riskOf(hoja(g, 'seal') as Command);
      expect(r?.risk, g).toBe('escritura');
      expect(r?.agentAllowed, g).toBe(false);
      expect(r?.writes, g).toMatch(/nothing is sent to the SAT/);
    }
    expect(hoja('catalog', 'generate')?.aliases()).toContain('generar');
    expect(hoja('balance', 'generate')?.aliases()).toContain('generar');
    expect(hoja('balance', 'check')?.aliases()).toContain('verificar');
  });

  it('the catalog seal --period help names no --closing, which that leaf does not have', () => {
    const period = hoja('catalog', 'seal')?.options.find((o) => o.long === '--period');
    expect(period?.description).toBe(t('help.e_accounting.catalog.seal.option.period'));
    expect(period?.description).not.toMatch(/--closing/);
    expect(hoja('catalog', 'seal')?.options.some((o) => o.long === '--closing')).toBe(false);
  });

  it('lo que NO entra en este tramo sigue sin existir: file, diff, match, apply', () => {
    const todas = (familia?.commands ?? []).flatMap((g) => g.commands.map((h) => h.name()));
    for (const ausente of ['file', 'diff', 'match', 'apply']) {
      expect(todas, `${ausente} firma o transmite: no es de F07b`).not.toContain(ausente);
    }
  });

  it('las dos generate son ESCRITURA + IA ✓ con draftOnly; check es lectura + IA ✓', () => {
    for (const g of ['catalog', 'balance']) {
      const r = riskOf(hoja(g, 'generate') as Command);
      expect(r?.risk, g).toBe('escritura');
      expect(r?.agentAllowed, g).toBe(true);
      expect(r?.draftOnly, g).toBe(true);
      // El artefacto es lo ÚNICO que se escribe: ni póliza ni envío.
      expect(r?.writes).toMatch(/sat_anexo24_artefactos/);
      expect(r?.writes).toMatch(/UNSEALED/);
    }
    const check = riskOf(hoja('balance', 'check') as Command);
    expect(check?.risk).toBe('lectura');
    expect(check?.agentAllowed).toBe(true);
  });

  it('ninguna hoja de este tramo es irreversible ni externa: nada sale del sistema', () => {
    for (const g of familia?.commands ?? []) {
      for (const h of g.commands) {
        const r = riskOf(h);
        expect(['lectura', 'escritura'], `${g.name()} ${h.name()}`).toContain(r?.risk);
        expect(r?.requiresLiveGate, `${g.name()} ${h.name()}`).toBe(false);
      }
    }
  });

  it('pasa la auditoría de consistencia sin violaciones', () => {
    expect(auditProgram(program)).toEqual([]);
  });

  it('las tres llevan el grupo de salida COMPLETO, no --json suelto', () => {
    for (const [g, n] of [
      ['catalog', 'generate'],
      ['balance', 'generate'],
      ['balance', 'check'],
    ]) {
      const longs = hoja(g, n)?.options.map((o) => o.long);
      expect(longs, `${g} ${n}`).toEqual(
        expect.arrayContaining(['--format', '--json', '--fields', '--output', '--quiet'])
      );
      expect(longs, `${g} ${n}`).toEqual(
        expect.arrayContaining(['--entity', '--tenant', '--user'])
      );
    }
  });

  it('las banderas de cada fila del catálogo están, con su forma corta del diccionario', () => {
    const cat = hoja('catalog', 'generate');
    expect(cat?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--dry-run', '--output', '--period'])
    );
    expect(cat?.options.find((o) => o.long === '--output')?.short).toBe('-o');
    expect(cat?.options.find((o) => o.long === '--yes')?.short).toBe('-y');

    const gen = hoja('balance', 'generate');
    expect(gen?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--period', '--type', '--closing', '--dry-run', '--output'])
    );

    const chk = hoja('balance', 'check');
    expect(chk?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--period', '--check', '--strict', '--json'])
    );
  });

  it('la ayuda de -o dice lo que -o HACE aquí: el XML, no la salida renderizada', () => {
    for (const [g, que] of [
      ['catalog', 'CtaCatalogo'],
      ['balance', 'Balanza'],
    ]) {
      const o = hoja(g, 'generate')?.options.find((x) => x.long === '--output');
      expect(o?.description, g).toContain(`${que} XML`);
      expect(o?.description, g).not.toContain('instead of stdout');
    }
    // En `check` NO se toca: allí `-o` conserva su significado del núcleo.
    const chk = hoja('balance', 'check')?.options.find((x) => x.long === '--output');
    expect(chk?.description).toContain('instead of stdout');
  });

  it('la ayuda de las dos generate avisa del sello ANTES de que nadie ejecute', () => {
    for (const g of ['catalog', 'balance']) {
      const cmd = hoja(g, 'generate') as Command;
      let texto = '';
      cmd.configureOutput({
        writeOut: (s: string) => {
          texto += s;
        },
      });
      cmd.outputHelp();
      expect(texto, g).toMatch(/does NOT seal it and does NOT file it/);
      expect(texto, g).toMatch(/never loads a private key/);
      expect(texto, g).toMatch(/Buzón Tributario/);
    }
  });
});

// ---- conducta ------------------------------------------------------

const tmpRaiz = fs.mkdtempSync(path.join(os.tmpdir(), 'f07b-cli-'));
afterAll(() => {
  fs.rmSync(tmpRaiz, { recursive: true, force: true });
});

async function correr(argv: string[], extra: Partial<EAccountingCommandDeps> = {}) {
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
    registerEAccountingCommand(p, {
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

/** El argumento común: la entidad SIEMPRE explícita, que es lo que exige una escritura. */
const E = ['-e', 'E1'];

describe('catalog generate · el archivo y la advertencia que lo acompaña', () => {
  it('genera, archiva y DICE que no va sellado ni presentado', async () => {
    const r = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', ...E]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.out).toMatch(/CtaCatalogo 02\/2026/);
    expect(r.out).toMatch(/AAA010101AAA/);
    expect(r.err, 'la advertencia del tramo entero').toContain(t('fiscal_mx.e_accounting.unsealed.headline'));
    for (const paso of PASOS_PARA_PRESENTAR) {
      expect(r.err).toContain(paso);
    }
  });

  it('el alias español entero funciona: contabilidad-electronica catalogo generar', async () => {
    const r = await correr([
      'contabilidad-electronica', 'catalogo', 'generar', '--period', '2026-02', ...E,
    ]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.err).toContain(t('fiscal_mx.e_accounting.unsealed.headline'));
  });

  it('el mes se valida ANTES de tocar la base: un typo no cuesta una conexión', async () => {
    const r = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-Q1', ...E]);
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(mundo.llamadas).toBe(0);
  });

  it('--dry-run llega al servicio y se dice que no se archivó nada', async () => {
    const r = await correr([
      'e-accounting', 'catalog', 'generate', '--period', '2026-02', '--dry-run', ...E,
    ]);
    expect((mundo.ultimoCatalogo as { dryRun: boolean }).dryRun).toBe(true);
    expect(r.err).toMatch(/--dry-run: nothing was archived/);
    expect(r.exitCode).toBe(ExitCode.OK);
  });

  it('lo que no se puede entregar sale 4, lo explica y NO deja archivo en disco', async () => {
    mundo.catalogo = catalogo({
      xml: null,
      hash: null,
      bytes: 0,
      filas: [],
      puedeEntregarse: false,
      sinAgrupador: [{ code: '1120', name: 'Bancos' }],
      hallazgos: [
        {
          regla: 'cuenta-sin-agrupador',
          severidad: 'bloquea',
          procedencia: 'coherencia_interna',
          mensaje: '1120 Bancos no tiene código agrupador',
          numCta: '1120',
        },
      ],
      artefacto: null,
    });
    const destino = path.join(tmpRaiz, 'no-entregable.xml');
    const r = await correr([
      'e-accounting', 'catalog', 'generate', '--period', '2026-02', '-o', destino, ...E,
    ]);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    expect(r.err).toMatch(/1120/);
    expect(r.err).toMatch(/anexo24_cuenta_sin_agrupador/);
    expect(
      fs.existsSync(destino),
      'sembrar un XML no entregable es sembrar el archivo que alguien firmará por error'
    ).toBe(false);
  });

  it('-o escribe el XML, no el sobre del renderizador, y el recibo sigue saliendo por stdout', async () => {
    const destino = path.join(tmpRaiz, 'catalogo.xml');
    const r = await correr([
      'e-accounting', 'catalog', 'generate', '--period', '2026-02', '-o', destino, '--json', ...E,
    ]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(fs.readFileSync(destino, 'utf8')).toBe(XML_CATALOGO);
    const sobre = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    expect(sobre.rows[0].destino).toBe(destino);
    expect(sobre.rows[0].sellado).toBe(false);
  });

  it('-o crea el directorio que falta en vez de fallar por una carpeta', async () => {
    const destino = path.join(tmpRaiz, 'anidado', 'hondo', 'catalogo.xml');
    const r = await correr([
      'e-accounting', 'catalog', 'generate', '--period', '2026-02', '-o', destino, ...E,
    ]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(fs.readFileSync(destino, 'utf8')).toBe(XML_CATALOGO);
  });

  it('pisar un archivo existente PREGUNTA, y un no lo deja intacto (10)', async () => {
    const destino = path.join(tmpRaiz, 'ya-sellado.xml');
    fs.writeFileSync(destino, '<sellado/>', 'utf8');
    const preguntas: string[] = [];
    const r = await correr(
      ['e-accounting', 'catalog', 'generate', '--period', '2026-02', '-o', destino, ...E],
      {
        confirm: (q: string) => {
          preguntas.push(q);
          return Promise.resolve(false);
        },
      }
    );
    expect(r.exitCode).toBe(ExitCode.ABORTED);
    expect(preguntas[0], 'la pregunta dice lo que está en juego').toMatch(/sealed/);
    expect(fs.readFileSync(destino, 'utf8')).toBe('<sellado/>');
  });

  it('--yes no pregunta y reemplaza', async () => {
    const destino = path.join(tmpRaiz, 'reemplazable.xml');
    fs.writeFileSync(destino, '<viejo/>', 'utf8');
    let pregunto = false;
    const r = await correr(
      ['e-accounting', 'catalog', 'generate', '--period', '2026-02', '-o', destino, '--yes', ...E],
      {
        confirm: () => {
          pregunto = true;
          return Promise.resolve(true);
        },
      }
    );
    expect(pregunto).toBe(false);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(fs.readFileSync(destino, 'utf8')).toBe(XML_CATALOGO);
  });

  it('--dry-run con -o no escribe NADA, ni siquiera sobre un destino nuevo', async () => {
    const destino = path.join(tmpRaiz, 'ensayo.xml');
    await correr([
      'e-accounting', 'catalog', 'generate', '--period', '2026-02',
      '-o', destino, '--dry-run', ...E,
    ]);
    expect(fs.existsSync(destino)).toBe(false);
  });

  it('--json anida los hallazgos con su cuenta: el detalle no se pierde en la tabla', async () => {
    mundo.catalogo = catalogo({
      hallazgos: [
        {
          regla: 'desc-longitud',
          severidad: 'aviso',
          procedencia: 'coherencia_interna',
          mensaje: 'Desc de 1120 repite la de su padre',
          numCta: '1120',
        },
      ],
    });
    const r = await correr([
      'e-accounting', 'catalog', 'generate', '--period', '2026-02', '--json', ...E,
    ]);
    const sobre = JSON.parse(r.out) as {
      rows: Array<{ hallazgos: Array<Record<string, unknown>>; falta_para_presentar: string[] }>;
    };
    expect(sobre.rows[0].hallazgos[0]).toMatchObject({
      regla: 'desc-longitud',
      severity: 'warning',
      referencia: '1120',
    });
    expect(sobre.rows[0].falta_para_presentar).toEqual([...PASOS_PARA_PRESENTAR]);
  });

  it('--fields se lee TAMBIÉN en la salida por omisión', async () => {
    const r = await correr([
      'e-accounting', 'catalog', 'generate', '--period', '2026-02', '--fields', 'hash,sellado', ...E,
    ]);
    expect(r.out).toMatch(/hash\s+sellado/);
    expect(r.out).not.toMatch(/criterio_niveles/);
  });

  it('regenerar los mismos bytes lo dice: la idempotencia por hash se ve', async () => {
    mundo.catalogo = catalogo({
      artefacto: {
        id: 'ART-1',
        hash_sha256: 'c0ffee'.repeat(8),
        bytes: 64,
        generado_en: '2026-09-02 19:04:33',
        yaExistia: true,
      },
    });
    const r = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', ...E]);
    expect(r.err).toMatch(/were already archived/);
  });

  it('con el sellado declarado por el despacho, la nota del motor se repite en voz alta', async () => {
    mundo.catalogo = catalogo({
      politicas: {
        niveles: 'jerarquia_completa',
        sinAgrupador: 'bloquear',
        sellado: 'sellar_con_custodia',
      },
      notaDeSellado: 'El despacho tiene declarado el sellado con custodia, pero esto NO SELLA.',
    });
    const r = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', ...E]);
    expect(r.err).toMatch(/NO SELLA/);
    expect(r.err).toContain(t('fiscal_mx.e_accounting.unsealed.headline'));
  });
});

describe('balance generate · la balanza y sus banderas', () => {
  it('genera, nombra el archivo sugerido y advierte del sello ausente', async () => {
    const r = await correr([
      'e-accounting', 'balance', 'generate', '--period', '2026-02', ...E,
    ]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.out).toMatch(/Trial balance 02\/2026/);
    expect(r.out).toMatch(/AAA010101AAA202602BN\.XML/);
    expect(r.err).toContain(t('fiscal_mx.e_accounting.unsealed.headline'));
  });

  it('--type C traslada --modified como FechaModBal; --closing pide la del ejercicio', async () => {
    await correr([
      'e-accounting', 'balance', 'generate', '--period', '2026-02',
      '--type', 'C', '--modified', '2026-03-15', ...E,
    ]);
    expect((mundo.ultimaBalanza as { opts: Record<string, unknown> }).opts).toMatchObject({
      tipo: 'C',
      fechaModBal: '2026-03-15',
    });

    await correr(['e-accounting', 'balance', 'generate', '--closing', ...E]);
    expect((mundo.ultimaBalanza as { opts: Record<string, unknown> }).opts.cierre).toBe(true);
  });

  it('un --type inventado es error de USO (2) y no llega al motor', async () => {
    const r = await correr([
      'e-accounting', 'balance', 'generate', '--period', '2026-02', '--type', 'X', ...E,
    ]);
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(mundo.llamadas).toBe(0);
  });

  it('un hallazgo bloqueante impide generar y sale 4 con la cuenta en el mensaje', async () => {
    mundo.balanzaLanza = new ValidationError(
      'La balanza de 02/2026 no se genera: 1 hallazgo(s) bloqueante(s). ' +
        '[saldos 4100] esperado 7000.0000 / obtenido 8300.0000. ' +
        "Corra 'balance check' para verlos todos."
    );
    const destino = path.join(tmpRaiz, 'balanza-rota.xml');
    const r = await correr([
      'e-accounting', 'balance', 'generate', '--period', '2026-02', '-o', destino, ...E,
    ]);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    expect(String((r.errs[0] as Error).message)).toMatch(/4100/);
    expect(fs.existsSync(destino)).toBe(false);
  });

  it('a balance that could not be validated against the XSD (#608) exits 4, writes nothing and says why', async () => {
    mundo.balanzaLanza = new OfficialXsdRefusal('not_validated', {
      schema: 'BalanzaComprobacion_1_3.xsd',
      cause: 'spawnSync xmllint ENOENT',
    });
    const target = path.join(tmpRaiz, 'balance-not-validated.xml');
    const r = await correr(['e-accounting', 'balance', 'generate', '--period', '2026-02', '-o', target, ...E]);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    expect(fs.existsSync(target)).toBe(false);
    expect((r.errs[0] as OfficialXsdRefusal).localized('es')).toBe(
      'Este archivo no se validó contra el XSD del SAT (BalanzaComprobacion_1_3.xsd) porque xmllint no corrió ' +
        '(spawnSync xmllint ENOENT), así que no es entregable. Instala libxml2-utils (apt, apk) o libxml2 ' +
        '(Homebrew), compruébalo con `mnemosine doctor` y vuelve a generar.'
    );
  });

  it('un SaldoIni que todavía puede cambiar se grita, y viaja en el recibo', async () => {
    mundo.balanza = balanza({
      inicial: {
        ...INICIAL,
        firme: false,
        periodo_anterior: { period_name: 'Enero 2026', status: 'open' },
        note: 'El periodo anterior sigue abierto: el SaldoIni de mañana puede ser otro.',
      },
    });
    const legible = await correr(['e-accounting', 'balance', 'generate', '--period', '2026-02', ...E]);
    expect(legible.out).toMatch(/MAY STILL CHANGE/);
    expect(legible.err).toMatch(/sigue abierto/);

    const maquina = await correr([
      'e-accounting', 'balance', 'generate', '--period', '2026-02', '--json', ...E,
    ]);
    const sobre = JSON.parse(maquina.out) as { rows: Array<Record<string, unknown>> };
    expect(sobre.rows[0].saldo_inicial_firme).toBe(false);
  });

  it('los avisos que sobreviven se enseñan y NO impiden entregar (0)', async () => {
    mundo.balanza = balanza({ hallazgos: [HALLAZGO_AVISA] });
    const r = await correr(['e-accounting', 'balance', 'generate', '--period', '2026-02', ...E]);
    expect(r.err).toMatch(/⚠ sin-sello/);
    expect(r.exitCode).toBe(ExitCode.OK);
  });
});

describe('balance check · el contrato de salida §4', () => {
  it('--check a secas imprime los nombres SIN tocar el motor, y sale 0', async () => {
    const r = await correr(['e-accounting', 'balance', 'check', '--check', ...E]);
    for (const n of BALANZA_CHECK_NAMES) expect(r.out).toContain(n);
    expect(mundo.llamadas, 'preguntar qué se verifica no cuesta una conexión').toBe(0);
    expect(r.exitCode).toBe(ExitCode.OK);
  });

  it('un nombre desconocido es error de USO (2) y se rechaza antes del motor', async () => {
    const r = await correr(['e-accounting', 'balance', 'check', '--check', 'saldo', ...E]);
    expect(r.exitCode).toBe(ExitCode.USAGE);
    expect(String((r.errs[0] as Error).message)).toMatch(/saldo/);
    expect(String((r.errs[0] as Error).message)).toMatch(/sin-sello/);
    expect(mundo.llamadas).toBe(0);
  });

  it('limpia: lo dice en prosa y sale 0', async () => {
    const r = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', ...E]);
    expect(r.out).toMatch(/no findings/);
    expect(r.exitCode).toBe(ExitCode.OK);
  });

  it('un bloqueante manda 4 y publica la cuenta y la diferencia', async () => {
    mundo.verificacion = verificacion({
      hallazgos: [HALLAZGO_BLOQUEA],
      conteo: { blocking: 1, warning: 0 },
    });
    const r = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', ...E]);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    expect(r.out).toMatch(/✘ saldos\s+4100\s+\[blocking\]/);
    expect(r.out).toMatch(/−1300\.0000/);
  });

  it('sólo avisos: 0 a secas, 4 con --strict', async () => {
    mundo.verificacion = verificacion({
      hallazgos: [HALLAZGO_AVISA],
      conteo: { blocking: 0, warning: 1 },
    });
    const suave = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', ...E]);
    expect(suave.exitCode).toBe(ExitCode.OK);
    const duro = await correr([
      'e-accounting', 'balance', 'check', '--period', '2026-02', '--strict', ...E,
    ]);
    expect(duro.exitCode).toBe(ExitCode.VALIDATION);
  });

  it('--check a,b corre exactamente ésas y el motor las recibe', async () => {
    mundo.verificacion = verificacion({ checks: ['saldos', 'redondeo'] });
    await correr([
      'e-accounting', 'balance', 'check', '--period', '2026-02', '--check', 'saldos,redondeo', ...E,
    ]);
    expect((mundo.ultimaVerificacion as { opts: Record<string, unknown> }).opts.checks).toEqual([
      'saldos',
      'redondeo',
    ]);
  });

  it('--closing verifica la del ejercicio: lo que se puede generar se puede verificar', async () => {
    await correr(['e-accounting', 'balance', 'check', '--closing', ...E]);
    expect((mundo.ultimaVerificacion as { opts: Record<string, unknown> }).opts.cierre).toBe(true);
  });

  it('--json entrega los hallazgos como filas, con su cuenta, y el sobre por stderr', async () => {
    mundo.verificacion = verificacion({
      hallazgos: [HALLAZGO_BLOQUEA, HALLAZGO_AVISA],
      conteo: { blocking: 1, warning: 1 },
    });
    const r = await correr([
      'e-accounting', 'balance', 'check', '--period', '2026-02', '--json', ...E,
    ]);
    const sobre = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    expect(sobre.rows).toHaveLength(2);
    expect(sobre.rows[0]).toMatchObject({
      check: 'saldos',
      severity: 'blocking',
      referencia: '4100',
    });
    expect(r.err, 'el sobre es nota: viaja por stderr y no ensucia el pipe').toMatch(
      /trial balance 02\/2026/
    );
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
  });

  it('el alias español entero: contabilidad-electronica balanza verificar', async () => {
    const r = await correr([
      'contabilidad-electronica', 'balanza', 'verificar', '--period', '2026-02', ...E,
    ]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.out).toMatch(/Trial balance 02\/2026/);
  });

  it('--type C and --modified reach the check: an amended balance is sealed as its own bytes', async () => {
    await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', '--type', 'c', '--modified', '2026-03-15', ...E]);
    expect(mundo.ultimaVerificacion).toMatchObject({ opts: { periodo: '2026-02', tipo: 'C', fechaModBal: '2026-03-15' } });
  });

  it('check NO archiva ni escribe: el motor de generación no se llama nunca', async () => {
    await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', ...E]);
    expect((mundo.ultimaBalanza as unknown) ?? null).toBe(null);
  });
});

describe('catalog seal · balance seal (EFIRMA-4, #442)', () => {
  it('catalog seal hands the month and the reviewer to the sealer, and says nothing was filed', async () => {
    const r = await correr(['e-accounting', 'catalog', 'seal', '--period', '2026-07', '--json', ...E]);
    expect(r.errs).toEqual([]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(mundo.ultimoSello).toMatchObject({
      tenantId: 'T1', entityId: 'E1', document: 'catalogo', year: 2026, month: 7, envelopeType: 'N',
      actor: 'contador@despacho.mx', userId: 'U-1',
    });
    const receipt = JSON.parse(r.out) as { rows: Array<Record<string, unknown>> };
    expect(receipt.rows[0]).toMatchObject({
      sealed_from: 'art-unsealed',
      sealed_from_hash: 's'.repeat(64),
      certificate_number: '00001000000000000145',
      filed_with_sat: false,
    });
    expect(r.err).toContain(t('anexo24.seal.nothing_filed'));
  });

  it('balance seal resolves the year-end balance as month 13, with its envelope type', async () => {
    const r = await correr([
      'contabilidad-electronica', 'balanza', 'sellar', '--period', '2026', '--closing', '--type', 'C', ...E,
    ]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(mundo.ultimoSello).toMatchObject({ document: 'balanza', year: 2026, month: 13, envelopeType: 'C' });
    expect(r.err).toContain(t('anexo24.seal.nothing_filed'));
  });
});

// ============================================================
// I8.7 · the e-accounting leaves speak by key (MNE-001-225, #269)
//
// Every line these leaves write to a person comes from the catalogue: English
// under the suite's en-US, Spanish when the language is pinned to es. The
// receipt's prose (`destino`, `falta_para_presentar`) is English in --json
// under any locale, because scripts read it; the table labels it in the
// user's language. Texts by hand, before the code.
//
// Not driven here: the «lo tomo como no» line of the overwrite prompt, which
// only a TTY reaches (`deps.confirm` replaces the prompt in these tests). It
// reuses `bank.confirm.taken_as_no`, which the bank, payroll and backup specs
// assert.
// ============================================================

describe('I8.7 · the e-accounting leaves speak by key (MNE-001-225)', () => {
  afterEach(() => resetLanguage());

  const usageOf = (fn: () => unknown): { message: string; es: string } => {
    try {
      fn();
    } catch (e) {
      const err = e as Error & { localized: (l: 'es' | 'en') => string };
      return { message: err.message, es: err.localized('es') };
    }
    throw new Error('it did not throw');
  };

  it('the catalog period errors, in English and in Spanish', () => {
    expect(usageOf(() => mesDelCatalogo(undefined)).message).toBe(
      'The chart of accounts is filed by month: give --period YYYY-MM (for example --period 2026-02). ' +
        'Without it there is no Mes or Anio to declare in the header.'
    );
    expect(usageOf(() => mesDelCatalogo('2026-Q1')).message).toBe(
      '--period "2026-Q1" is not a month. The CtaCatalogo declares ONE month of ONE fiscal year, so only the ' +
        'form YYYY-MM (2026-02) is valid here. A quarter, a fiscal year or a range has nowhere to go in the file.'
    );
    const outOfRange = usageOf(() => mesDelCatalogo('2026-13'));
    expect(outOfRange.message).toBe(
      '--period "2026-13": the month must run from 01 to 12. Month 13 belongs to the year-end balance ' +
        '(`balance generate --closing`), not to the chart of accounts.'
    );
    expect(outOfRange.es).toBe(
      '--period «2026-13»: el mes ha de ir de 01 a 12. El 13 es de la balanza de cierre ' +
        '(`balance generate --closing`), no del catálogo de cuentas.'
    );
  });

  it('the --type and --check errors, with a plural for the unknown checks', () => {
    expect(usageOf(() => exigirTipoDeEnvio('X')).message).toBe(
      '--type "X" does not exist: N is the normal balance and C the amended one. ' +
        'The year-end balance is not a type, it is --closing (filed as Mes 13).'
    );
    const available = 'saldos, redondeo, cuentas-en-catalogo, natur-coherente, sin-sello, xsd';
    expect(usageOf(() => exigirChecksDeBalanza('no-existe')).message).toBe(
      `Unknown check: no-existe. The available ones are: ${available}.`
    );
    const two = usageOf(() => exigirChecksDeBalanza('a,b'));
    expect(two.message).toBe(`Unknown checks: a, b. The available ones are: ${available}.`);
    expect(two.es).toBe(`Verificaciones desconocidas: a, b. Las disponibles son: ${available}.`);
    expect(usageOf(() => exigirChecksDeBalanza(' , ')).message).toBe(
      `--check named no check. The available ones are: ${available}.`
    );
  });

  it('the steps of the receipt are English, whatever the language', () => {
    setLanguage('es');
    expect([...PASOS_PARA_PRESENTAR]).toEqual([
      'Review the XML: it is the document you are going to file, and once it is sealed it is not touched again.',
      "Seal it with the taxpayer's e.firma: outside this system or, if the firm declared sellar_con_custodia, " +
        "with this family's seal leaf. No one will ask you for the e.firma by chat.",
      'Compress it and upload it yourself through the Buzón Tributario (Contabilidad electrónica).',
      'Keep the acknowledgement of receipt and, later, the one of acceptance or rejection: it is the only proof ' +
        'that it was filed.',
    ]);
  });

  it('catalog generate, en-US: the summary, the policies, the target and the unsealed block', async () => {
    const r = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', ...E]);
    expect(r.exitCode).toBe(ExitCode.OK);
    expect(r.out).toContain('CtaCatalogo 02/2026  RFC AAA010101AAA · 2 accounts · 80 bytes\n');
    expect(r.out).toContain(
      '  levels jerarquia_completa · without grouping code bloquear · sealing nunca_sellar_en_el_sistema\n'
    );
    expect(r.out).toContain('  target (artifact store)\n');
    expect(r.err).toContain('  ⚠ THIS FILE IS NOT SEALED AND NOTHING WAS FILED WITH THE SAT.\n');
    expect(r.err).toContain('    Building the file and signing it are separate acts, by separate hands.\n');
    expect(r.err).toContain(
      '    1. Review the XML: it is the document you are going to file, and once it is sealed it is not touched again.\n'
    );
    expect(r.err).toContain(
      '    4. Keep the acknowledgement of receipt and, later, the one of acceptance or rejection: it is the only ' +
        'proof that it was filed.'
    );
  });

  it('catalog generate, es-MX: the same block in Spanish, with «Comprímelo»', async () => {
    setLanguage('es');
    const r = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', ...E]);
    expect(r.out).toContain('CtaCatalogo 02/2026  RFC AAA010101AAA · 2 cuentas · 80 bytes\n');
    expect(r.out).toContain('  destino (almacén de artefactos)\n');
    expect(r.err).toContain('  ⚠ ESTE ARCHIVO NO VA SELLADO Y NO SE PRESENTÓ NADA ANTE EL SAT.\n');
    expect(r.err).toContain(
      '    3. Comprímelo y transmítelo tú por el Buzón Tributario (Contabilidad electrónica).\n'
    );
  });

  it('catalog generate --dry-run --json, es-MX: the receipt stays English, the note is Spanish', async () => {
    setLanguage('es');
    const r = await correr([
      'e-accounting', 'catalog', 'generate', '--period', '2026-02', '--dry-run', '--json', ...E,
    ]);
    const receipt = (JSON.parse(r.out) as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(receipt['destino']).toBe('(dry run: nothing was written)');
    expect((receipt['falta_para_presentar'] as string[])[2]).toBe(
      'Compress it and upload it yourself through the Buzón Tributario (Contabilidad electrónica).'
    );
    expect(r.err).toContain('  --dry-run: no se archivó nada y no se escribió ningún archivo.\n');
  });

  it('catalog generate --fields, es-MX: the table labels the English cells in Spanish', async () => {
    setLanguage('es');
    const r = await correr([
      'e-accounting', 'catalog', 'generate', '--period', '2026-02', '--fields', 'destino,falta_para_presentar', ...E,
    ]);
    expect(r.out).toContain('(almacén de artefactos)');
    expect(r.out).toContain('Comprímelo y transmítelo tú');
    expect(r.out).not.toContain('(artifact store)');
  });

  it('catalog generate with accounts left out says how many', async () => {
    mundo.catalogo = catalogo({ omitidas: [{ code: '9100' }, { code: '9200' }] });
    const r = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', ...E]);
    expect(r.out).toContain('  2 accounts left out of the file\n');
  });

  const undeliverable = (ungrouped: unknown[]) =>
    catalogo({
      xml: null, hash: null, bytes: 0, filas: [], puedeEntregarse: false, sinAgrupador: ungrouped, artefacto: null,
    });

  it('not deliverable: one account without its grouping code, in the singular', async () => {
    mundo.catalogo = undeliverable([{ code: '1120', name: 'Bancos' }]);
    const r = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', ...E]);
    expect(r.exitCode).toBe(ExitCode.VALIDATION);
    expect(r.err).toContain(
      '  No deliverable file was produced. 1 account in scope has no grouping code and the policy ' +
        "`anexo24_cuenta_sin_agrupador` is set to 'bloquear'. Assign it, or change the policy with " +
        `${changePolicyHint('anexo24_cuenta_sin_agrupador')}.\n`
    );
  });

  it('not deliverable: two accounts, in the plural and in Spanish', async () => {
    mundo.catalogo = undeliverable([{ code: '1120' }, { code: '1130' }]);
    const en = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', ...E]);
    expect(en.err).toContain('2 accounts in scope have no grouping code');
    expect(en.err).toContain("is set to 'bloquear'. Assign them, or change the policy with");
    setLanguage('es');
    const es = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', ...E]);
    expect(es.err).toContain(
      '  No se generó ningún archivo entregable. 2 cuentas del alcance no tienen código agrupador y la política ' +
        "`anexo24_cuenta_sin_agrupador` está en 'bloquear'. Asígnalos, o cambia la política con "
    );
  });

  it('not deliverable for a blocking finding: resolve them and generate again', async () => {
    mundo.catalogo = undeliverable([]);
    const r = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', ...E]);
    expect(r.err).toContain(
      '  No deliverable file was produced. Resolve the blocking findings above and generate again.\n'
    );
  });

  it('not deliverable by the official XSD (#608): Spanish on screen by key, English in the receipt', async () => {
    const english =
      'The SAT XSD (CatalogoCuentas_1_3.xsd) does not accept this file, so it is not deliverable: ' +
      'line 3: x; and 2 more lines';
    mundo.catalogo = catalogo({
      puedeEntregarse: false,
      artefacto: null,
      hallazgos: [
        {
          regla: 'CAT-XSD-REJECTED',
          severidad: 'bloquea',
          procedencia: 'official_xsd',
          mensaje: english,
          messageKey: {
            key: 'anexo24.xsd.rejected',
            params: { schema: 'CatalogoCuentas_1_3.xsd', errors: 'line 3: x', more: 2 },
          },
        },
      ],
    });
    setLanguage('es');
    const screen = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', ...E]);
    expect(screen.exitCode).toBe(ExitCode.VALIDATION);
    expect(screen.err).toContain(
      'El XSD del SAT (CatalogoCuentas_1_3.xsd) no acepta este archivo, así que no es entregable: ' +
        'line 3: x; y 2 líneas más'
    );
    const json = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', '--json', ...E]);
    const receipt = (JSON.parse(json.out) as { rows: Array<Record<string, unknown>> }).rows[0];
    expect(receipt['entregable']).toBe(false);
    expect((receipt['hallazgos'] as Array<Record<string, unknown>>)[0]['detalle']).toBe(english);
  });

  it('bytes already archived: the generator is deterministic', async () => {
    mundo.catalogo = catalogo({ artefacto: { ...catalogo().artefacto, yaExistia: true } });
    const r = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', ...E]);
    expect(r.err).toContain(
      '  These same bytes were already archived: no new version was created. The generator is deterministic.\n'
    );
  });

  it('the overwrite question, and the abort a «no» gives', async () => {
    const target = path.join(tmpRaiz, 'i87-sellado.xml');
    fs.writeFileSync(target, '<sellado/>', 'utf8');
    const questions: string[] = [];
    const r = await correr(['e-accounting', 'catalog', 'generate', '--period', '2026-02', '-o', target, ...E], {
      confirm: (q: string) => {
        questions.push(q);
        return Promise.resolve(false);
      },
    });
    expect(questions[0]).toBe(
      `${target} already exists. If that file is already sealed, overwriting it leaves it without its seal. Replace it?`
    );
    expect(r.exitCode).toBe(ExitCode.ABORTED);
    expect((r.errs[0] as Error).message).toBe(
      `Nothing was written: ${target} is kept as it was. Use another path, or --yes if you really want to replace it.`
    );
  });

  it('balance generate, en-US: the title, the header, the policies and the suggested file', async () => {
    const r = await correr(['e-accounting', 'balance', 'generate', '--period', '2026-02', ...E]);
    expect(r.out).toContain(
      'Trial balance 02/2026  RFC AAA010101AAA · TipoEnvio N · Febrero 2026 2026-02-01 → 2026-02-28 · 3 accounts\n'
    );
    expect(r.out).toContain(
      '  levels jerarquia_completa · sealing nunca_sellar_en_el_sistema · SaldoIni from mayor, firm\n'
    );
    expect(r.out).toContain('  suggested file AAA010101AAA202602BN.XML · 67 bytes\n');
    expect(r.out).toContain('  target (artifact store)\n');
  });

  it('balance generate, a closing balance whose SaldoIni may still change, in both languages', async () => {
    mundo.balanza = balanza({
      meta: { ...META_BALANZA, cierre: true },
      inicial: { ...INICIAL, firme: false },
    });
    const en = await correr(['e-accounting', 'balance', 'generate', '--period', '2026-02', ...E]);
    expect(en.out).toContain('· TipoEnvio N · closing (Mes 13) ·');
    expect(en.out).toContain('SaldoIni from mayor, MAY STILL CHANGE (the previous period is still open)\n');
    setLanguage('es');
    const es = await correr(['e-accounting', 'balance', 'generate', '--period', '2026-02', ...E]);
    expect(es.out).toContain(
      'Balanza 02/2026  RFC AAA010101AAA · TipoEnvio N · cierre (Mes 13) · Febrero 2026 2026-02-01 → 2026-02-28 · 3 cuentas\n'
    );
    expect(es.out).toContain(
      '  niveles jerarquia_completa · sellado nunca_sellar_en_el_sistema · SaldoIni del mayor, ' +
        'TODAVÍA PUEDE CAMBIAR (el periodo anterior sigue abierto)\n'
    );
  });

  it('balance generate with the sealing declared names the seal leaf', async () => {
    mundo.balanza = balanza({ meta: { ...META_BALANZA, criterio_sellado: 'sellar_con_custodia' } });
    const r = await correr(['e-accounting', 'balance', 'generate', '--period', '2026-02', ...E]);
    expect(r.err).toContain(
      '    The firm declared "sellar_con_custodia" in efirma_sellado_contabilidad_electronica, and this command ' +
        'does not seal: the file comes out without Sello, noCertificado or Certificado. ' +
        'Review it and seal it with `e-accounting balance seal`.\n'
    );
  });

  it('balance check, clean: the matching catalog, the checks and the verdict, in both languages', async () => {
    const en = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', ...E]);
    expect(en.out).toContain('  matching catalog: artefacto_archivado (abc123def456)\n');
    expect(en.out).toContain('  checks: saldos, redondeo, cuentas-en-catalogo, natur-coherente, sin-sello, xsd\n');
    expect(en.out).toContain('  ✔ no findings: the trial balance passes the 6 checks asked for.\n');
    setLanguage('es');
    const es = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', ...E]);
    expect(es.out).toContain('  catálogo de cotejo: artefacto_archivado (abc123def456)\n');
    expect(es.out).toContain('  verificaciones: saldos, redondeo, cuentas-en-catalogo, natur-coherente, sin-sello, xsd\n');
    expect(es.out).toContain('  ✔ sin hallazgos: la balanza pasa las 6 verificaciones pedidas.\n');
  });

  it('balance check of one check and no catalog: the singular, and «none»', async () => {
    mundo.verificacion = verificacion({ checks: ['saldos'], catalogo: null });
    const en = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', '--check', 'saldos', ...E]);
    expect(en.out).toContain('  matching catalog: none\n');
    expect(en.out).toContain('passes the 1 check asked for.\n');
    setLanguage('es');
    const es = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', '--check', 'saldos', ...E]);
    expect(es.out).toContain('  catálogo de cotejo: ninguno\n');
    expect(es.out).toContain('la balanza pasa la 1 verificación pedida.\n');
  });

  it('balance check with findings counts them with plurals, in both languages', async () => {
    mundo.verificacion = verificacion({
      hallazgos: [HALLAZGO_BLOQUEA, HALLAZGO_AVISA],
      conteo: { blocking: 1, warning: 1 },
    });
    const en = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', ...E]);
    expect(en.out).toContain('  1 blocking, 1 warning. A blocking finding stops the file from being generated.\n');
    setLanguage('es');
    const es = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', ...E]);
    expect(es.out).toContain('  1 bloqueante, 1 aviso. Un bloqueante impide generar el archivo.\n');
    resetLanguage();
    mundo.verificacion = verificacion({ hallazgos: [HALLAZGO_BLOQUEA], conteo: { blocking: 2, warning: 0 } });
    const two = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', ...E]);
    expect(two.out).toContain('  2 blocking, 0 warnings. ');
  });

  it('the xsd finding (MNE-001-774): Spanish on screen by key, English in the --json rows', async () => {
    const english =
      'The SAT XSD (BalanzaComprobacion_1_3.xsd) does not accept this file, so it is not deliverable: line 2: x';
    mundo.verificacion = verificacion({
      hallazgos: [
        {
          check: 'xsd',
          severity: 'blocking',
          referencia: '',
          detalle: english,
          messageKey: {
            key: 'anexo24.xsd.rejected',
            params: { schema: 'BalanzaComprobacion_1_3.xsd', errors: 'line 2: x', more: 0 },
          },
        },
      ],
      conteo: { blocking: 1, warning: 0 },
    });
    setLanguage('es');
    const screen = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', ...E]);
    expect(screen.exitCode).toBe(ExitCode.VALIDATION);
    expect(screen.out).toMatch(/✘ xsd\s+\[blocking\]\s+El XSD del SAT \(BalanzaComprobacion_1_3\.xsd\) no acepta este archivo/);
    const json = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', '--json', ...E]);
    const rows = (JSON.parse(json.out) as { rows: Array<Record<string, unknown>> }).rows;
    expect(rows).toEqual([{ check: 'xsd', severity: 'blocking', referencia: '', detalle: english }]);
  });

  it('a balance with no file to build (MNE-001-774): the new key, in both catalogues', () => {
    const params = { schema: 'BalanzaComprobacion_1_3.xsd', cause: 'sin FechaModBal' };
    expect(t('anexo24.xsd.not_built', params, 'en')).toBe(
      'No file was built to check against the SAT XSD (BalanzaComprobacion_1_3.xsd), so `balance generate` ' +
        'refuses it as well: sin FechaModBal'
    );
    expect(t('anexo24.xsd.not_built', params, 'es')).toBe(
      'No se construyó ningún archivo que comprobar contra el XSD del SAT (BalanzaComprobacion_1_3.xsd), así que ' +
        '`balance generate` también lo rechaza: sin FechaModBal'
    );
  });

  it('a builder refusal by key inside the xsd finding (MNE-001-775): the cause follows the screen language', async () => {
    const cause = { key: 'anexo24.balance.modified_date', params: { date: '2014-12-31' } } as const;
    mundo.verificacion = verificacion({
      hallazgos: [
        {
          check: 'xsd',
          severity: 'blocking',
          referencia: '',
          detalle: 'No file was built … FechaModBal «2014-12-31» is not a date the SAT XSD accepts…',
          messageKey: {
            key: 'anexo24.xsd.not_built',
            params: { schema: 'BalanzaComprobacion_1_3.xsd', cause: 'English cause' },
            lists: { cause: { join: '', items: [cause] } },
          },
        },
      ],
      conteo: { blocking: 1, warning: 0 },
    });
    setLanguage('es');
    const screen = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', ...E]);
    expect(screen.out).toMatch(/también lo rechaza: FechaModBal «2014-12-31» no es una fecha que el XSD del SAT acepte/);
    expect(screen.out).not.toContain('English cause');
  });

  it('balance check --json: the envelope line on stderr', async () => {
    const r = await correr(['e-accounting', 'balance', 'check', '--period', '2026-02', '--json', ...E]);
    expect(r.err).toContain(
      'AAA010101AAA · trial balance 02/2026 · Febrero 2026 · 3 accounts · ' +
        'checks: saldos,redondeo,cuentas-en-catalogo,natur-coherente,sin-sello,xsd\n'
    );
  });

  it('the generate leaves write the archived artifact, UNSEALED, in English', () => {
    const program = new Command();
    registerEAccountingCommand(program, { palette: plain, shutdown: () => undefined, reportError: () => undefined });
    const family = program.commands.find((c) => c.name() === 'e-accounting')!;
    for (const g of ['catalog', 'balance']) {
      const generate = family.commands.find((c) => c.name() === g)!.commands.find((c) => c.name() === 'generate')!;
      expect(riskOf(generate)?.writes, g).toBe(
        'sat_anexo24_artefactos (the archived XML with its hash, UNSEALED); no journal entry, nothing sent to the authority'
      );
    }
  });
});
