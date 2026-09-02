import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// El único doble es `query`: todo lo demás del módulo de conexión se
// conserva, porque las fábricas de herramientas lo importan entero.
vi.mock('../../src/database/connection.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, query: vi.fn() };
});

// ─── el arnés de las DOS hojas de clasificación por lotes ───
//
// `mnemosine ingest` y `mnemosine init` corren el MISMO pipeline sobre una
// carpeta entera. Lo que estas pruebas afirman no se puede afirmar leyendo el
// fuente —el defecto que vienen a cerrar es justamente un guardián que leía el
// fuente—, así que las hojas se EJECUTAN con la fábrica de sesiones doblada y
// se mira el objeto que de verdad viajó.

/** Cada llamada real a `createLlmSession`, con sus cuatro argumentos. */
const sesiones = vi.hoisted(() => ({
  llamadas: [] as Array<{
    profile: { name: string; model: string };
    ctx: { entityId: string };
    callbacks: Record<string, ((...a: never[]) => void) | undefined>;
    opts: { herramientas?: readonly string[]; grounding?: { enabled?: boolean } };
  }>,
}));
vi.mock('../../src/ai/providers/index.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    createLlmSession: (profile: never, ctx: never, callbacks: never, opts: never) => {
      sesiones.llamadas.push({ profile, ctx, callbacks, opts: opts ?? {} });
      return Promise.resolve({
        label: 'doble · modelo',
        runTurn: () => Promise.resolve(''),
        reset: () => undefined,
      });
    },
  };
});

/**
 * Doble CONMUTABLE de `conCorridaRegistrada`. Apagado —que es lo normal— la
 * hoja corre el envoltorio REAL, que es lo que las pruebas de la fila ejercen.
 * Encendido, se queda con el objeto que la hoja le pasó: ahí viven el
 * `cierre` y el `cuerpo` de verdad, los que deciden qué se escribe cuando la
 * corrida muere.
 */
const intercepcion = vi.hoisted(() => ({
  activa: false,
  opts: null as null | {
    ctx: { entityId: string };
    apertura: { provider: string; model: string; filesTotal: number; autoPostEnabled: boolean; createdBy: string };
    cuerpo: (id: string | null) => Promise<unknown>;
    cierre: (resultado: unknown) => Record<string, unknown>;
    onAviso: (m: string) => void;
  },
}));
vi.mock('../../src/ai/ingest-runs.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/ai/ingest-runs.js')>();
  return {
    ...real,
    conCorridaRegistrada: (opts: never) => {
      if (!intercepcion.activa) return real.conCorridaRegistrada(opts);
      intercepcion.opts = opts;
      // La hoja no debe seguir: lo que se está midiendo es lo que le ENTREGÓ
      // al envoltorio, no lo que imprime después.
      throw new Error('corrida interceptada por el arnés');
    },
  };
});

/** El pipeline real no corre aquí: cada prueba dice qué hace la ingesta. */
const ingesta = vi.hoisted(() => ({
  impl: null as null | ((opts: Record<string, unknown>) => Promise<unknown>),
}));
vi.mock('../../src/ai/ingest-service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    ingestCfdiFiles: (opts: never) =>
      (ingesta.impl ?? (() => Promise.resolve({ results: [], counts: CUENTAS_VACIAS })))(opts),
  };
});

vi.mock('../../src/ai/ingest-thresholds.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    resolverUmbralesConPanel: () =>
      Promise.resolve({ autoPost: false, minConfidence: 0.9, maxAmount: 10000 }),
  };
});

vi.mock('../../src/ai/context.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, resolveEntity: () => Promise.resolve(CTX) };
});

vi.mock('../../src/ai/draft-service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    resolveReviewer: () =>
      Promise.resolve({ userId: 'uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu', email: 'contador@despacho.mx' }),
  };
});

import {
  abrirCorridaIngesta,
  cerrarCorridaIngesta,
  conCorridaRegistrada,
} from '../../src/ai/ingest-runs.js';
import { buildTools } from '../../src/ai/tools/index.js';
import { SUPERFICIE_INGESTA } from '../../src/ai/tools/superficie.js';
import { query } from '../../src/database/connection.js';
import { program } from '../../src/cli/mnemosine.js';
import { ImportSection, defaultCreateSession } from '../../src/cli/init/s5-import.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { SectionContext } from '../../src/cli/init/section.js';

/**
 * A7·3 — MIL QUINIENTOS ASIENTOS Y CERO FILAS DE CORRIDA.
 *
 * Dos defectos del mismo camino, `mnemosine ingest`:
 *
 *  (A) La fila de ai_ingest_runs se abría DESPUÉS del bucle, con los
 *      contadores ya finales. Una corrida de 2 000 CFDI que muere en el
 *      archivo 1 500 dejaba mil quinientos borradores en la base y CERO filas
 *      de corrida — y el aviso de que no se registró iba a un stderr en gris.
 *  (B) La hoja construía su sesión sin pasar lista, así que recibía TODAS las
 *      herramientas porque nadie se lo impidió: propiedad por accidente en el
 *      único camino que puede postear al mayor sin humano.
 */

const RAIZ = path.join(__dirname, '..', '..');
const mockQuery = query as unknown as Mock;

const CTX: AgentContext = {
  entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  entityName: 'Acme MX',
  tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'AME010101AAA',
};

const APERTURA = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  filesTotal: 1500,
  autoPostEnabled: false,
  createdBy: 'contador@despacho.mx',
};

const COUNTS = {
  rules: 3, auto_post: 0, draft: 1495, blocked: 2, duplicate: 0, invalid: 0, error: 0,
};

const CUENTAS_VACIAS = {
  rules: 0, auto_post: 0, draft: 0, blocked: 0, duplicate: 0, invalid: 0, error: 0,
};

const CIERRE_COMPLETO = {
  counts: COUNTS,
  sospechaCount: 4,
  draftsCreated: 1495,
  inputTokens: 900000,
  outputTokens: 40000,
  estimatedCostUsd: 12.5,
  durationMs: 3_600_000,
};

beforeEach(() => {
  mockQuery.mockReset();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  sesiones.llamadas.length = 0;
  intercepcion.activa = false;
  intercepcion.opts = null;
  ingesta.impl = null;
});

const llamada = (i: number): { sql: string; params: unknown[] } => {
  const call = mockQuery.mock.calls[i] as [string, unknown[] | undefined];
  return { sql: call[0], params: call[1] ?? [] };
};

// ============================================================
// (B) LA SUPERFICIE DE LA INGESTA
// ============================================================

describe('la superficie de la ingesta es una lista NOMBRADA, no «todas»', () => {
  const deps = { model: 'm' } as never;
  const todas = () => buildTools(CTX, deps).map((t) => t.name);

  it('la lista nombra herramientas que existen, todas', () => {
    // Si esto falla, alguien renombró una herramienta sin tocar la lista: la
    // superficie declarada dejaría de ser la real, y debe romper aquí y no
    // descubrirse en una corrida nocturna de mil quinientos comprobantes.
    expect(() => buildTools(CTX, deps, SUPERFICIE_INGESTA)).not.toThrow();
  });

  it('con la lista, la sesión recibe EXACTAMENTE esos nombres y ninguno más', () => {
    const recortadas = buildTools(CTX, deps, SUPERFICIE_INGESTA).map((t) => t.name);
    expect(recortadas.sort()).toEqual([...SUPERFICIE_INGESTA].sort());
    // Y a diferencia de la desatendida, aquí el recorte SÍ recorta: la
    // ingesta clasifica comprobantes, no concilia ni reporta.
    expect(recortadas.length).toBeLessThan(todas().length);
  });

  it('deja fuera el brazo externo ENTERO', () => {
    const externas = [
      'external_pull', 'external_push', 'external_diff_trial_balance', 'list_external_ops',
    ];
    for (const n of externas) {
      // Existe en la superficie completa (si no, esto sería un typo pasando
      // por una exclusión) y NO viaja a la ingesta.
      expect(todas(), `${n} debería existir`).toContain(n);
      expect(SUPERFICIE_INGESTA, `${n} no clasifica comprobantes`).not.toContain(n);
    }
  });

  it('deja fuera los estados financieros y los saldos agregados', () => {
    const reportes = [
      'get_general_ledger', 'get_trial_balance', 'get_balance_sheet',
      'get_income_statement', 'get_aged_payables', 'get_aged_receivables',
    ];
    for (const n of reportes) {
      expect(todas(), `${n} debería existir`).toContain(n);
      expect(SUPERFICIE_INGESTA, `${n} es reportar, no clasificar`).not.toContain(n);
    }
    // Y las tres que sobran por otra razón: no hay conversación que buscar,
    // el dedupe es determinista y previo, y aquí no se arranca ninguna entidad.
    for (const n of ['session_search', 'list_drafts', 'get_entity_status', 'search_customers']) {
      expect(SUPERFICIE_INGESTA).not.toContain(n);
    }
  });

  it('pero conserva el panel del despacho, el borrador y la pregunta', () => {
    // A7·2: el umbral de capitalización se aplica CLASIFICANDO. Sin el panel,
    // una corrida nocturna decide activo contra gasto con MENOS criterio del
    // que el despacho ya contestó.
    expect(SUPERFICIE_INGESTA).toContain('get_accounting_policies');
    // La salida de la ingesta, y su camino bloqueado.
    expect(SUPERFICIE_INGESTA).toContain('draft_journal_entry');
    expect(SUPERFICIE_INGESTA).toContain('ask_user');
    // Lo que el prompt del CFDI pide por su nombre.
    for (const n of ['search_precedents', 'search_journal_entries', 'search_accounts']) {
      expect(SUPERFICIE_INGESTA, `el prompt del CFDI pide ${n}`).toContain(n);
    }
  });

  it('un nombre fantasma LANZA en vez de encoger la superficie en silencio', () => {
    expect(() =>
      buildTools(CTX, deps, [...SUPERFICIE_INGESTA, 'herramienta_renombrada'])
    ).toThrow(/no existen/);
  });

});

// ============================================================
// B3 · EL GUARDIÁN AFIRMA LA LISTA QUE VIAJA, NO EL TEXTO QUE LA NOMBRA
//
// El guardián anterior era `expect(hoja).toMatch(/herramientas:\s*
// SUPERFICIE_INGESTA/)` sobre el fuente de la hoja. Comprueba el NOMBRE de la
// bandera y jamás su VALOR:
//
//     herramientas: SUPERFICIE_INGESTA.concat(['get_trial_balance', 'external_push'])
//
// casa el patrón entero, y con él la ingesta recupera de tapadillo la cola
// hacia fuera —la exclusión que la propia lista pone de titular— con la suite
// completa en verde.
//
// Así que las dos hojas se EJECUTAN y se mira el array que la fábrica de
// sesiones recibió de verdad. Y son DOS: `mnemosine ingest` y la carpeta que
// `mnemosine init` ingiere en el alta corren el mismo pipeline de
// clasificación por lotes, así que la lista tiene que viajar por los dos o el
// recorte es una propiedad de un camino y una coincidencia del otro.
// ============================================================

class SalidaSimulada extends Error {
  constructor(readonly codigo: number) {
    super(`shutdown(${codigo})`);
  }
}

/**
 * Ejecuta la HOJA REAL de `mnemosine ingest`. `shutdown()` termina en
 * `process.exit`, que en un worker de vitest mataría la corrida entera: se
 * dobla por una excepción que este arnés reconoce y se traga.
 */
async function correrHojaDeIngesta(archivos: string[] = ['/facturas/a.xml']): Promise<void> {
  intercepcion.activa = true;
  const salida = vi.spyOn(process, 'exit').mockImplementation(((codigo?: number) => {
    throw new SalidaSimulada(codigo ?? 0);
  }) as never);
  const mudos = [
    vi.spyOn(process.stderr, 'write').mockReturnValue(true),
    vi.spyOn(process.stdout, 'write').mockReturnValue(true),
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(console, 'error').mockImplementation(() => undefined),
  ];
  try {
    await program.parseAsync(['node', 'mnemosine', 'ingest', ...archivos]);
  } catch (err) {
    if (!(err instanceof SalidaSimulada)) throw err;
  } finally {
    salida.mockRestore();
    for (const m of mudos) m.mockRestore();
    intercepcion.activa = false;
  }
}

/** La lista tal y como la recibió la fábrica, sin pasar por ningún fuente. */
function herramientasQueViajaron(i: number): readonly string[] {
  expect(sesiones.llamadas.length, 'ninguna hoja llegó a construir su sesión').toBeGreaterThan(i);
  const opts = sesiones.llamadas[i].opts;
  expect(
    opts.herramientas,
    'la sesión se construyó SIN lista: recibe la superficie completa'
  ).toBeDefined();
  return opts.herramientas!;
}

function afirmarRecorteDeIngesta(viajaron: readonly string[]): void {
  // Exactamente la lista, ni un nombre más: `.concat([...])` muere aquí.
  expect([...viajaron].sort()).toEqual([...SUPERFICIE_INGESTA].sort());
  expect(viajaron).toHaveLength(SUPERFICIE_INGESTA.length);
  // Y por su nombre, las cuatro que el titular de la lista promete excluir:
  // las tres que hablan con el sistema del cliente con su credencial, y el
  // reporte más caro. Que el fallo diga CUÁL volvió.
  for (const fuera of [
    'external_pull', 'external_push', 'external_diff_trial_balance', 'get_trial_balance',
  ]) {
    expect(viajaron, `${fuera} viajó a una corrida de clasificación por lotes`).not.toContain(fuera);
  }
}

describe('la lista recortada VIAJA a las dos hojas que clasifican por lotes', () => {
  it('`mnemosine ingest` construye su sesión con la lista, y con grounding apagado', async () => {
    await correrHojaDeIngesta();
    expect(sesiones.llamadas).toHaveLength(1);
    afirmarRecorteDeIngesta(herramientasQueViajaron(0));
    expect(sesiones.llamadas[0].opts.grounding).toEqual({ enabled: false });
  });

  it('y el ALTA también: es el segundo camino del mismo pipeline, no otro producto', async () => {
    // Por la SECCIÓN real y con su fábrica POR OMISIÓN. Ejercer
    // `defaultCreateSession` a solas dejaría vivo el mutante que la
    // desconecta del constructor: la lista sería correcta en una función que
    // ya no construye ninguna sesión.
    ingesta.impl = () => Promise.resolve({ results: [], counts: CUENTAS_VACIAS });
    await seccionDeAlta(['/facturas/a.xml']).configure(ctxDeAlta());
    expect(sesiones.llamadas).toHaveLength(1);
    afirmarRecorteDeIngesta(herramientasQueViajaron(0));
    expect(sesiones.llamadas[0].opts.grounding).toEqual({ enabled: false });
  });

  it('y la fábrica que el alta embarca por omisión es la que lleva la lista', async () => {
    // La otra mitad del mismo par: la sección de arriba prueba que el
    // constructor la ENCHUFA; ésta, que la función exportada la LLEVA.
    await defaultCreateSession({ name: 'anthropic', model: 'claude-opus-5' } as never, CTX, {});
    expect(sesiones.llamadas).toHaveLength(1);
    afirmarRecorteDeIngesta(herramientasQueViajaron(0));
  });

  it('y lo que viaja son nombres que existen: la lista no puede quedarse mintiendo', async () => {
    await correrHojaDeIngesta();
    const deps = { model: 'm' } as never;
    expect(() => buildTools(CTX, deps, herramientasQueViajaron(0))).not.toThrow();
  });
});

// ============================================================
// B3 · EL CIERRE DE LA CORRIDA MUERTA, EJERCIDO DE VERDAD
//
// `conCorridaRegistrada` se probaba con un cuerpo y un cierre SINTÉTICOS: el
// envoltorio quedaba cubierto y el closure REAL de la hoja —el que decide qué
// se escribe cuando la corrida muere— no lo ejercía nadie. Cambiar, en el
// camino de la muerte, `borradoresCapturados.n` por `capture.drafts.length`
// —que es EXACTAMENTE lo que el comentario de tres líneas de encima explica
// que hay que evitar, porque el pipeline REEMPLAZA `capture.drafts` en cada
// archivo— dejaba la suite entera en verde y la fila diciendo que una corrida
// de mil quinientos borradores creó los del último archivo.
//
// Aquí se ejerce el closure que la hoja entrega, con una ingesta doblada que
// vacía el buffer archivo a archivo como hace el pipeline real.
// ============================================================

/** El objeto que la hoja le entregó al envoltorio de la corrida. */
function corridaInterceptada(): NonNullable<typeof intercepcion.opts> {
  expect(intercepcion.opts, 'la hoja no llegó a envolver su corrida').not.toBeNull();
  return intercepcion.opts!;
}

/**
 * Una ingesta que anuncia `borradores` borradores repartidos de uno por
 * archivo y VACÍA el buffer antes de cada uno, igual que ingest-service
 * (`capture.drafts = []` antes de cada turno). Si `muerte` viene, revienta
 * después del último: el buffer queda vacío y el contador de la corrida no.
 */
function ingestaQueAnuncia(borradores: number, muerte?: Error): void {
  ingesta.impl = (opts) => {
    const capture = opts.capture as { drafts: unknown[] };
    const onDraftCreated = sesiones.llamadas[0]?.callbacks.onDraftCreated;
    expect(onDraftCreated, 'la sesión se construyó sin el gancho de borradores').toBeDefined();
    for (let i = 0; i < borradores; i++) {
      capture.drafts = [];
      (onDraftCreated as (info: unknown) => void)({ draftId: `d${i}`, entryNumber: null });
    }
    // El archivo que mató la corrida no alcanzó a dejar nada en el buffer.
    capture.drafts = [];
    return muerte ? Promise.reject(muerte) : Promise.resolve({
      results: [], counts: CUENTAS_VACIAS,
    });
  };
}

describe('el CIERRE que la hoja de ingest entrega decide qué se escribe', () => {
  it('si la corrida muere, cuenta los borradores de TODA la corrida, no los del último archivo', async () => {
    await correrHojaDeIngesta(['/facturas/a.xml']);
    const corrida = corridaInterceptada();

    ingestaQueAnuncia(3, new Error('SIGTERM en el archivo 1500'));
    await expect(corrida.cuerpo('corrida-1')).rejects.toThrow('SIGTERM en el archivo 1500');

    const cierre = corrida.cierre(null);
    expect(
      cierre.draftsCreated,
      'el pipeline vacía capture.drafts por archivo: leerlo ahí escribe los del último'
    ).toBe(3);
    // Y NO se inventan contadores: nadie llegó a contar.
    expect(cierre.counts).toBeUndefined();
    expect(cierre.sospechaCount).toBe(0);
  });

  it('si la corrida termina, los contadores salen del REPORTE y no del andamio', async () => {
    await correrHojaDeIngesta(['/facturas/a.xml']);
    const corrida = corridaInterceptada();

    ingestaQueAnuncia(3);
    await corrida.cuerpo('corrida-1');

    const report = {
      counts: COUNTS,
      results: [
        { file: 'a.xml', status: 'draft', draftId: 'd1', sospechas: ['total'] },
        { file: 'b.xml', status: 'draft', draftId: 'd2' },
        { file: 'c.xml', status: 'duplicate' },
      ],
    };
    const cierre = corrida.cierre(report);
    expect(cierre.counts).toBe(COUNTS);
    // Dos borradores en el reporte, tres anuncios en el camino: el camino
    // feliz mide donde siempre se midió, y los dos números no se confunden.
    expect(cierre.draftsCreated).toBe(2);
    expect(cierre.sospechaCount).toBe(1);
  });

  it('y la apertura nombra el modelo que de verdad clasificó, y cuántos archivos', async () => {
    await correrHojaDeIngesta(['/facturas/a.xml', '/facturas/b.xml']);
    const { apertura } = corridaInterceptada();
    expect(apertura.filesTotal).toBe(2);
    expect(apertura.autoPostEnabled).toBe(false);
    expect(apertura.createdBy).toBe('contador@despacho.mx');
    // El perfil de la fila y el de la sesión son el MISMO objeto resuelto: una
    // fila que nombrara otro modelo haría de «costo por borrador» una división
    // entre dos corridas distintas.
    expect(apertura.provider).toBe(sesiones.llamadas[0].profile.name);
    expect(apertura.model).toBe(sesiones.llamadas[0].profile.model);
  });
});

// ============================================================
// B3 · LA CARPETA DEL ALTA TAMBIÉN DEJA FILA
//
// src/cli/init/s5-import.ts no nombraba `ai_ingest_runs` ni una vez: una
// carpeta ingerida desde `mnemosine init` producía documentos, borradores y
// asientos, y CERO filas de corrida. A7·3 arregló la instancia (la hoja de
// `ingest`); la clase son los dos caminos.
// ============================================================

function ctxDeAlta(carpeta = '/facturas'): SectionContext & { lines: string[] } {
  const lines: string[] = [];
  const respuestas = ['2', carpeta];
  return {
    rl: {} as never,
    flags: {},
    lines,
    print: (l?: string) => lines.push(l ?? ''),
    askText: (_p: string, fallback?: string) => Promise.resolve(respuestas.shift() ?? fallback ?? null),
    askSecret: () => Promise.resolve(null),
    confirm: (_p: string, d = true) => Promise.resolve(d),
  };
}

function seccionDeAlta(archivos: string[]): ImportSection {
  return new ImportSection({
    resolveEntity: () => Promise.resolve(CTX),
    resolveReviewer: () =>
      Promise.resolve({ userId: 'uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu', email: 'contador@despacho.mx' }),
    resolveProfile: () => ({ name: 'anthropic', model: 'claude-opus-5' }) as never,
    listXmlFiles: () => archivos,
  });
}

describe('la carpeta que ingiere el ALTA deja su fila de corrida', () => {
  it('la fila se abre ANTES del primer archivo y se cierra con los contadores', async () => {
    const sqlAlEmpezar: string[] = [];
    ingesta.impl = (opts) => {
      // El instante del archivo 1: lo único que quedaría si el proceso muere.
      sqlAlEmpezar.push(...mockQuery.mock.calls.map((c) => (c as [string])[0]));
      expect((opts.files as string[]).length).toBe(2);
      return Promise.resolve({
        results: [
          { file: 'a.xml', status: 'draft', draftId: 'd1', sospechas: ['emisor'] },
          { file: 'b.xml', status: 'draft', draftId: 'd2' },
        ],
        counts: { ...CUENTAS_VACIAS, draft: 2 },
      });
    };
    const ctx = ctxDeAlta();
    await seccionDeAlta(['/facturas/a.xml', '/facturas/b.xml']).configure(ctx);

    expect(sqlAlEmpezar).toHaveLength(1);
    expect(sqlAlEmpezar[0]).toMatch(/INSERT INTO ai_ingest_runs/);
    expect(sqlAlEmpezar[0]).toMatch(/'running'/);
    const apertura = llamada(0);
    expect(apertura.params.slice(1, 8)).toEqual([
      CTX.tenantId, CTX.entityId, 'anthropic', 'claude-opus-5', 2, false, 'contador@despacho.mx',
    ]);

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const cierre = llamada(1);
    expect(cierre.sql).toMatch(/UPDATE ai_ingest_runs/);
    expect(cierre.params[0]).toBe('completed');
    expect(cierre.params.slice(2, 9)).toEqual([0, 0, 2, 0, 0, 0, 0]);
    expect(cierre.params[9], 'sospechas del reporte').toBe(1);
    expect(cierre.params[10], 'borradores del reporte').toBe(2);
    // Y el alta no se traga el aviso ni se lo come el resumen.
    expect(ctx.lines.join('\n')).toMatch(/Review the drafts/);
  });

  it('el tope de la primera corrida viaja a la fila: 50 de 60, no 60', async () => {
    ingesta.impl = () =>
      Promise.resolve({ results: [], counts: CUENTAS_VACIAS });
    const muchos = Array.from({ length: 60 }, (_, i) => `/facturas/f${i}.xml`);
    await seccionDeAlta(muchos).configure(ctxDeAlta());
    // files_total es el sexto parámetro del INSERT de apertura.
    expect(llamada(0).params[5]).toBe(50);
  });

  it('y su cierre cuenta la corrida entera cuando muere a media carpeta', async () => {
    intercepcion.activa = true;
    try {
      await seccionDeAlta(['/facturas/a.xml']).configure(ctxDeAlta());
    } finally {
      intercepcion.activa = false;
    }
    const corrida = corridaInterceptada();
    expect(corrida.apertura.filesTotal).toBe(1);

    ingestaQueAnuncia(4, new Error('SIGTERM a media carpeta'));
    await expect(corrida.cuerpo(null)).rejects.toThrow('SIGTERM a media carpeta');
    const cierre = corrida.cierre(null);
    expect(cierre.draftsCreated, 'capture.drafts se vacía por archivo').toBe(4);
    expect(cierre.counts).toBeUndefined();
  });

  it('un registro que no se puede escribir AVISA por donde el humano mira', async () => {
    mockQuery.mockRejectedValue(new Error('la base tosió'));
    ingesta.impl = () => Promise.resolve({ results: [], counts: CUENTAS_VACIAS });
    const ctx = ctxDeAlta();
    await seccionDeAlta(['/facturas/a.xml']).configure(ctx);
    const salida = ctx.lines.join('\n');
    // Los CFDI clasificados son verdad aunque la anotación falle…
    expect(salida).toMatch(/Review the drafts/);
    // …pero el fallo se ve, y en el asistente el sitio donde se mira es esta
    // misma columna de texto, no un stderr en gris.
    expect(salida).toMatch(/no quedó ABIERTA en ai_ingest_runs/);
  });
});

// ============================================================
// (A) LA FILA SE ABRE ANTES DEL BUCLE
// ============================================================

describe('la fila de la corrida se abre ANTES del bucle', () => {
  it('cuando el primer archivo se procesa, la fila YA existe y está en running', async () => {
    let sqlAlEmpezar: string | undefined;
    let paramsAlEmpezar: unknown[] = [];
    await conCorridaRegistrada({
      ctx: CTX,
      apertura: APERTURA,
      cuerpo: async () => {
        // Este es el instante del archivo 1: lo que la base sepa AHORA es lo
        // único que quedará si el proceso muere en el archivo 1 500.
        expect(mockQuery).toHaveBeenCalledTimes(1);
        ({ sql: sqlAlEmpezar, params: paramsAlEmpezar } = llamada(0));
        return { counts: COUNTS };
      },
      cierre: () => CIERRE_COMPLETO,
      onAviso: () => expect.unreachable('no debía haber aviso'),
    });
    expect(sqlAlEmpezar).toMatch(/INSERT INTO ai_ingest_runs/);
    expect(sqlAlEmpezar).toMatch(/'running'/);
    // Lo que se sabe al abrir viaja completo: quién, con qué modelo, cuántos
    // archivos y si el auto-posteo estaba encendido.
    expect(paramsAlEmpezar.slice(1, 8)).toEqual([
      CTX.tenantId, CTX.entityId, 'anthropic', 'claude-opus-5', 1500, false,
      'contador@despacho.mx',
    ]);
  });

  it('la apertura no inventa contadores: los deja en su DEFAULT', async () => {
    await abrirCorridaIngesta(CTX, APERTURA);
    const { sql } = llamada(0);
    for (const col of ['rules_count', 'draft_count', 'blocked_count', 'duration_ms']) {
      expect(sql, `${col} no se sabe al abrir`).not.toContain(col);
    }
  });

  it('y se cierra DESPUÉS, con los contadores finales y el consumo', async () => {
    await conCorridaRegistrada({
      ctx: CTX,
      apertura: APERTURA,
      cuerpo: async () => ({ counts: COUNTS }),
      cierre: () => CIERRE_COMPLETO,
      onAviso: () => expect.unreachable('no debía haber aviso'),
    });
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const { sql, params } = llamada(1);
    expect(sql).toMatch(/UPDATE ai_ingest_runs/);
    expect(sql).toMatch(/closed_at = NOW\(\)/);
    expect(params[0]).toBe('completed');
    expect(params[1]).toBeNull(); // sin razón de muerte
    expect(params.slice(2, 9)).toEqual([3, 0, 1495, 2, 0, 0, 0]);
    expect(params[13]).toBe('12.500000'); // costo con 6 decimales, como ai_usage
    // La guarda: id + entidad + abierta. La frontera de entidad va DENTRO del
    // SQL, no en un if de arriba.
    expect(sql).toMatch(/WHERE id = \$16 AND entity_id = \$17 AND status = 'running'/);
    expect(params[16]).toBe(CTX.entityId);
  });
});

describe('una corrida que revienta a media lista deja la fila MUERTA', () => {
  it('cierra en failed con la razón, y el error sigue subiendo', async () => {
    const muerte = new Error('SIGTERM en el archivo 1500');
    await expect(
      conCorridaRegistrada({
        ctx: CTX,
        apertura: APERTURA,
        cuerpo: async () => {
          throw muerte;
        },
        // Lo que el proceso SÍ midió: consumo y borradores capturados.
        cierre: (resultado) => ({
          counts: resultado === null ? undefined : COUNTS,
          sospechaCount: 0,
          draftsCreated: 1500,
          inputTokens: 900000,
          outputTokens: 40000,
          estimatedCostUsd: 12.5,
          durationMs: 3_600_000,
        }),
        onAviso: () => expect.unreachable('el registro sí funcionó: no hay nada que avisar'),
      })
    ).rejects.toThrow('SIGTERM en el archivo 1500');

    expect(mockQuery).toHaveBeenCalledTimes(2);
    const { sql, params } = llamada(1);
    expect(sql).toMatch(/UPDATE ai_ingest_runs/);
    expect(params[0]).toBe('failed');
    expect(params[1]).toBe('SIGTERM en el archivo 1500');
    // Y NO inventa contadores: van NULL, el COALESCE deja el DEFAULT 0, y el
    // estado 'failed' es lo que dice que esos ceros son «no se llegó a
    // contar» y no «corrió y no encontró nada».
    expect(params.slice(2, 9)).toEqual([null, null, null, null, null, null, null]);
    expect(sql).toMatch(/rules_count = COALESCE\(\$3::int, rules_count\)/);
    // Los borradores que sí alcanzaron a crearse quedan escritos: mil
    // quinientos borradores en la base ya no son cero filas de corrida.
    expect(params[10]).toBe(1500);
  });

  it('un cierre que tampoco puede escribirse AVISA en vez de tragarse', async () => {
    const avisos: string[] = [];
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // abre
      .mockRejectedValueOnce(new Error('conexión perdida')); // no cierra
    await expect(
      conCorridaRegistrada({
        ctx: CTX,
        apertura: APERTURA,
        cuerpo: async () => {
          throw new Error('OOM');
        },
        cierre: () => ({ ...CIERRE_COMPLETO, counts: undefined }),
        onAviso: (m) => avisos.push(m),
      })
    ).rejects.toThrow('OOM');
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toMatch(/no quedó registrada/);
  });
});

describe('el registro es best-effort, pero un registro fallido se VE', () => {
  it('ni siquiera un cierre que revienta al ARMARSE tumba la corrida', async () => {
    // `cierre()` es código del llamador. Si revienta —un filter sobre algo que
    // no está— no puede llevarse por delante una corrida que YA terminó bien:
    // los mil quinientos CFDI clasificados son verdad aunque la anotación no.
    const avisos: string[] = [];
    const r = await conCorridaRegistrada({
      ctx: CTX,
      apertura: APERTURA,
      cuerpo: async () => ({ counts: COUNTS }),
      cierre: () => {
        throw new Error('el contador que no existía');
      },
      onAviso: (m) => avisos.push(m),
    });
    expect(r).toEqual({ counts: COUNTS });
    expect(avisos[0]).toMatch(/el contador que no existía/);
  });

  it('la apertura que falla no tumba la corrida, y la rescata al terminar', async () => {
    const avisos: string[] = [];
    mockQuery
      .mockRejectedValueOnce(new Error('la base tosió')) // la apertura falla
      .mockResolvedValue({ rows: [], rowCount: 1 });
    let corrio = false;
    const r = await conCorridaRegistrada({
      ctx: CTX,
      apertura: APERTURA,
      cuerpo: async (corridaId) => {
        corrio = true;
        // Sin fila abierta no hay id que ligar a los eventos de sospecha.
        expect(corridaId).toBeNull();
        return { counts: COUNTS };
      },
      cierre: () => CIERRE_COMPLETO,
      onAviso: (m) => avisos.push(m),
    });
    expect(corrio, 'los CFDI son verdad aunque la anotación falle').toBe(true);
    expect(r).toEqual({ counts: COUNTS });
    expect(avisos[0]).toMatch(/no quedó ABIERTA/);
    // Rescate: sin id que cerrar, la corrida entera entra en un solo INSERT y
    // nace ya cerrada. Tarde es peor que a tiempo; infinitamente mejor que nunca.
    const { sql, params } = llamada(1);
    expect(sql).toMatch(/INSERT INTO ai_ingest_runs/);
    expect(params[21]).toBe('completed');
    expect(params.slice(6, 13)).toEqual([3, 0, 1495, 2, 0, 0, 0]);
  });
});

describe('cerrar una fila que no está abierta no escribe, y lo dice', () => {
  it('id ajeno, entidad ajena o fila ya cerrada: lanza en vez de callarse', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(
      cerrarCorridaIngesta(CTX, 'no-existe', CIERRE_COMPLETO)
    ).rejects.toThrow(/no hay corrida ABIERTA/);
  });

  it('una razón de muerte kilométrica se recorta antes de tocar la fila', async () => {
    await cerrarCorridaIngesta(CTX, 'c-1', { ...CIERRE_COMPLETO, error: 'x'.repeat(9000) });
    const { params } = llamada(0);
    expect((params[1] as string).length).toBeLessThan(2100);
    expect(params[1]).toMatch(/recortado/);
  });
});

// ============================================================
// LA MIGRACIÓN 058
// ============================================================

describe('la 058 distingue «murió a medias» de «corrió y no encontró nada»', () => {
  const RUTA = path.join(RAIZ, 'src', 'database', 'migrations', '058_la_corrida_que_se_abre_antes.sql');
  const sql = () => fs.readFileSync(RUTA, 'utf-8');

  it('añade el estado, la fecha de cierre y la razón', () => {
    const s = sql();
    expect(s).toMatch(/ADD COLUMN status VARCHAR\(20\) NOT NULL DEFAULT 'running'/);
    expect(s).toMatch(/ADD COLUMN closed_at TIMESTAMPTZ/);
    expect(s).toMatch(/ADD COLUMN error TEXT/);
    expect(s).toMatch(/CHECK \(status IN \('running', 'completed', 'failed'\)\)/);
  });

  it('ata el estado a la fecha: running ⟺ sin cierre, y un cierre a medias no cabe', () => {
    // Sin esta equivalencia el código podría escribir 'completed' sin fecha (o
    // fecha sin estado) y la fila volvería a mentir con aspecto de dato.
    expect(sql()).toMatch(/CHECK \(\(status = 'running'\) = \(closed_at IS NULL\)\)/);
  });

  it('rellena las filas viejas ANTES de poner el CHECK, o la migración no aplica', () => {
    // Las filas de la era 044 se escribían al TERMINAR: nacerían en 'running'
    // sin closed_at y el CHECK las rechazaría — la migración fallaría en toda
    // base con histórico. Y aunque pasara, un histórico entero quedaría
    // marcado como corridas muertas.
    const s = sql();
    const relleno = s.indexOf("UPDATE ai_ingest_runs SET status = 'completed', closed_at = created_at");
    const check = s.indexOf('ADD CONSTRAINT ai_ingest_runs_cierre_check');
    expect(relleno, 'falta el relleno de las filas de la 044').toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    expect(relleno).toBeLessThan(check);
  });

  it('y el UPDATE de cierre no choca con ningún disparador ni con el sólo-agregar', () => {
    // La 041 protege el mayor con disparadores BEFORE UPDATE OR DELETE. Este
    // censo afirma que ninguno cae sobre ai_ingest_runs — si alguien le pone
    // uno mañana, el cierre dejaría de escribirse y esto debe romper aquí.
    const dir = path.join(RAIZ, 'src', 'database', 'migrations');
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.sql'))) {
      const s = fs.readFileSync(path.join(dir, f), 'utf-8');
      expect(s, `${f} le pone disparador a ai_ingest_runs`).not.toMatch(
        /CREATE\s+TRIGGER[\s\S]{0,200}?ON\s+ai_ingest_runs/i
      );
    }
    // Y tampoco es bitácora de sólo agregar: si entrara al array, el GRANT
    // general le revocaría el UPDATE y el cierre moriría en silencio.
    const rls = fs.readFileSync(path.join(RAIZ, 'src', 'database', 'rls-policies.sql'), 'utf-8');
    const arr = /append_only text\[\] := ARRAY\[([^\]]*)\]/.exec(rls);
    expect(arr, 'no se encontró el array append_only').not.toBeNull();
    expect(arr![1]).not.toContain('ai_ingest_runs');
  });
});
