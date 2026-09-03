import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(), enterTenant: vi.fn(), currentTenant: vi.fn(),
}));
vi.mock('../../src/ai/question-service.js', () => ({
  createQuestion: vi.fn(),
  recordAnsweredQuestion: vi.fn(),
  searchPrecedents: vi.fn(),
}));
// Sólo se sustituyen las dos puertas que necesitan una base viva; el resto
// del módulo se deja REAL, para que el árbol de comandos que se monta aquí
// sea el que monta el binario.
vi.mock('../../src/ai/context.js', async (original) => ({
  ...(await original<typeof import('../../src/ai/context.js')>()),
  bootstrapTenant: vi.fn(),
  resolveEntity: vi.fn(async () => ({
    entityId: 'ent-a', entityName: 'Acme SA', tenantId: 'tenant-1',
    currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA',
  })),
}));
vi.mock('../../src/ai/draft-service.js', async (original) => ({
  ...(await original<typeof import('../../src/ai/draft-service.js')>()),
  resolveReviewer: vi.fn(async () => ({ id: 'u-1', email: 'jefe@demo.com' })),
}));

import { Command } from 'commander';
import {
  groupConflicts,
  detectMemoryConflicts,
  detectPolicyContradictions,
  detectStrandedMemory,
  digestCoverage,
  retireMemory,
  buildMemoryDigest,
} from '../../src/ai/memory-service.js';
import { runDoctor, type DoctorReport } from '../../src/ai/doctor-service.js';
import {
  renderConflicts, renderDigestCoverage, registerMemoryCommand,
} from '../../src/cli/memory-command.js';
import { buildQuestionTools } from '../../src/ai/tools/question-tools.js';
import { searchPrecedents } from '../../src/ai/question-service.js';
import { query } from '../../src/database/connection.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { BetaTool, BetaToolResultContentBlockParam } from '@anthropic-ai/sdk/resources/beta';

const mockQuery = query as unknown as Mock;
const mockSearch = searchPrecedents as unknown as Mock;

// ============================================================
// A5·2 — LA MEMORIA NO TENÍA NI ÁRBITRO NI HIGIENE
//
// El digest entra en el prompt de CADA sesión. Dos precedentes activos que
// se contradicen no son ruido: son dos criterios contables incompatibles
// peleándose la misma decisión, y el modelo aplicará uno sin decir cuál ni
// por qué. Nada los miraba: un grep de «conflict» sobre memory-service.ts y
// question-tools.ts devolvía cero, y doctor no tenía una sola comprobación
// sobre precedentes.
//
// Estas pruebas ejercen las tres superficies por las que el hallazgo tiene
// que salir —doctor, el CLI y la herramienta que el modelo usa— y lo hacen
// contra las funciones que se EMBARCAN, con veintiún precedentes, no con
// uno. La discriminación es la mitad del trabajo: un detector que marcara
// los veintiuno sería tan inútil como el silencio que había antes.
// ============================================================

const CTX: AgentContext = {
  entityId: 'ent-a', entityName: 'Acme SA', tenantId: 'tenant-1',
  currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA',
};

interface FilaCruda {
  id: string;
  entity_id: string;
  entity_name: string;
  question: string;
  answer: string;
  topic: string | null;
  answered_by: string;
  answered_at: Date;
}

const fila = (
  id: string, entity: [string, string], topic: string | null,
  question: string, answer: string, fecha: string
): FilaCruda => ({
  id, entity_id: entity[0], entity_name: entity[1], topic, question, answer,
  answered_by: 'admin@demo.com', answered_at: new Date(fecha),
});

const ACME: [string, string] = ['ent-a', 'Acme SA'];
const BETA: [string, string] = ['ent-b', 'Beta SA'];

/**
 * Las líneas de CRITERIO que el digest lleva de verdad: sin la valla que lo
 * envuelve y sin el aviso de recorte, que no es un precedente. Se usa para
 * comparar, sobre las mismas filas, lo que el modelo recibe con lo que la
 * higiene dice que recibe.
 */
const lineasDelDigest = (digest: string): string[] =>
  digest === ''
    ? []
    : digest.split('\n').slice(1, -1).filter((l) => !l.startsWith('[memory truncated'));

/** El parámetro `n` (1-indexado, como en el SQL) de una consulta, si es texto. */
const paramTexto = (params: unknown[] | undefined, n: number): string => {
  const v = (params ?? [])[n - 1];
  return typeof v === 'string' ? v : '';
};

/** Un precedente de digest cuya respuesta ocupa `largo` caracteres. */
const filaDigest = (i: number, largo = 20) => ({
  topic: `t-${i}`, question: `q-${i}`, answer: 'x'.repeat(largo),
  answered_by: 'admin@demo.com', answered_at: new Date('2026-08-10'),
});

/**
 * VEINTIUNA FILAS, DOS CONFLICTOS REALES Y CUATRO CASI-CONFLICTOS.
 *
 * La producción no tiene una fila: tiene la memoria entera de un despacho,
 * con repeticiones, mayúsculas distintas, dos entidades y decenas de
 * criterios que conviven sin pelearse. Si la prueba ejerciera un par de
 * filas contradictorias, un detector que devolviera «todo es conflicto»
 * pasaría. Aquí tiene que acertar Y fallar en los sitios correctos.
 */
function memoriaDeUnDespacho(over: { telmexViejo?: string; gasolinaVieja?: string } = {}): FilaCruda[] {
  return [
    // ── Acme: EL conflicto por topic (el slug casa aunque la caja cambie) ──
    fila('a-01', ACME, 'clasificacion:telmex', '¿A qué cuenta va Telmex?', '6130 Servicios generales', '2026-08-01'),
    fila('a-02', ACME, 'clasificacion:Telmex', '¿Telmex es honorario?', over.telmexViejo ?? '5205 Honorarios', '2026-06-01'),

    // ── Acme: MISMO topic, misma respuesta con otra tipografía: repetición,
    //    no contradicción. Marcar esto sería el detector que se apaga solo.
    fila('a-03', ACME, 'clasificacion:CFE', '¿Recibo de luz?', '5210 Energía', '2026-07-01'),
    fila('a-04', ACME, 'clasificacion:CFE', '¿Recibo de luz de la nave?', '  5210   ENERGÍA  ', '2026-05-01'),

    // ── Acme: seis criterios que no se pelean con nadie ──
    fila('a-05', ACME, 'clasificacion:papeleria', '¿Papelería?', '5110 Papelería', '2026-07-11'),
    fila('a-06', ACME, 'clasificacion:renta', '¿Renta de oficina?', '5120 Arrendamiento', '2026-07-12'),
    fila('a-07', ACME, 'clasificacion:fletes', '¿Fletes?', '5130 Fletes', '2026-07-13'),
    fila('a-08', ACME, 'clasificacion:seguros', '¿Prima de seguro?', '5140 Seguros', '2026-07-14'),
    fila('a-09', ACME, 'clasificacion:viaticos', '¿Viáticos?', '5150 Viáticos', '2026-07-15'),
    fila('a-10', ACME, 'clasificacion:comisiones', '¿Comisión bancaria?', '5160 Comisiones', '2026-07-16'),

    // ── Acme: sin topic, la clave es la PREGUNTA. Misma pregunta, dos
    //    respuestas incompatibles: conflicto. ask_user trae el topic
    //    opcional, así que esta rama no es teórica.
    fila('a-11', ACME, null, '¿El IVA de gasolina se acredita?', 'Sí, con CFDI y pago con tarjeta', '2026-08-02'),
    fila('a-12', ACME, null, '  ¿El IVA de gasolina se acredita?  ', over.gasolinaVieja ?? 'No, se va al gasto', '2026-07-02'),

    // ── Acme: sin topic, misma pregunta y misma respuesta: no es conflicto.
    fila('a-13', ACME, null, '¿Depreciación de equipo de cómputo?', '25% ANUAL', '2026-04-01'),
    fila('a-14', ACME, null, '¿Depreciación de equipo de cómputo?', '  25%   anual  ', '2026-03-01'),

    // ── Beta: MISMO slug que el conflicto de Acme y respuesta distinta.
    //    Cruzar entidades inventaría un conflicto que no existe: cada
    //    entidad tiene su criterio y su digest.
    fila('b-01', BETA, 'clasificacion:telmex', '¿Telmex en Beta?', '9999 Cuenta puente', '2026-08-03'),
    fila('b-02', BETA, 'clasificacion:papeleria', '¿Papelería?', '5110 Papelería', '2026-07-21'),
    fila('b-03', BETA, 'clasificacion:renta', '¿Renta?', '5120 Arrendamiento', '2026-07-22'),
    fila('b-04', BETA, 'clasificacion:fletes', '¿Fletes?', '5130 Fletes', '2026-07-23'),
    fila('b-05', BETA, 'clasificacion:seguros', '¿Seguros?', '5140 Seguros', '2026-07-24'),
    fila('b-06', BETA, 'clasificacion:viaticos', '¿Viáticos?', '5150 Viáticos', '2026-07-25'),
    fila('b-07', BETA, 'clasificacion:comisiones', '¿Comisiones?', '5160 Comisiones', '2026-07-26'),
  ];
}

/**
 * La memoria del despacho MÁS un conflicto interno de la OTRA entidad.
 *
 * Sin esta fila, borrar la frontera de entidad no cambiaría una sola línea
 * impresa: en el aparejo base Beta no se contradice consigo misma, así que
 * el mutante sobreviviría por falta de material, no por estar vigilado.
 * Con ella, un comando que pregunte por todo el tenant enseña un conflicto
 * que no es de la entidad activa — y eso sí se ve.
 */
function memoriaDeDosDespachos(): FilaCruda[] {
  return [
    ...memoriaDeUnDespacho(),
    fila('b-08', BETA, 'clasificacion:papeleria', '¿Papelería en Beta?', '9998 Cuenta rara', '2026-07-27'),
  ];
}

beforeEach(() => mockQuery.mockReset());

// ============================================================
// EL AGRUPADOR, QUE ES LA CLASE
// ============================================================
describe('groupConflicts — qué es y qué no es un conflicto', () => {
  const p = (topic: string | null, question: string, answer: string) => ({ topic, question, answer });

  it('mismo topic y respuestas distintas: conflicto, con las respuestas EN CRUDO', () => {
    const g = groupConflicts([
      p('clasificacion:telmex', 'q1', '6130 Servicios'),
      p('clasificacion:telmex', 'q2', '5205 Honorarios'),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].scope).toBe('topic');
    expect(g[0].key).toBe('clasificacion:telmex');
    // Se compara normalizado y se MUESTRA lo que el precedente dice: un
    // informe que enseñara la versión aplanada no dejaría ver el criterio.
    expect(g[0].answers).toEqual(['6130 Servicios', '5205 Honorarios']);
    expect(g[0].entries).toHaveLength(2);
  });

  it('el topic casa aunque cambie la caja o los espacios: el slug es el mismo', () => {
    expect(groupConflicts([
      p('  Clasificacion:TELMEX ', 'q1', 'a'),
      p('clasificacion:telmex', 'q2', 'b'),
    ])).toHaveLength(1);
  });

  it('la MISMA respuesta escrita distinto es repetición, no contradicción', () => {
    expect(groupConflicts([
      p('clasificacion:cfe', 'q1', '5210 Energía'),
      p('clasificacion:cfe', 'q2', '  5210   ENERGÍA  '),
    ])).toEqual([]);
  });

  it('topics distintos no compiten aunque las respuestas difieran', () => {
    expect(groupConflicts([
      p('clasificacion:cfe', 'q1', '5210'),
      p('clasificacion:telmex', 'q2', '6130'),
    ])).toEqual([]);
  });

  it('sin topic la clave es la pregunta: misma pregunta, dos respuestas', () => {
    const g = groupConflicts([
      p(null, '¿El IVA de gasolina se acredita?', 'Sí'),
      p(null, '  ¿El IVA de gasolina se acredita?  ', 'No'),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].scope).toBe('question');
    expect(g[0].answers).toEqual(['Sí', 'No']);
  });

  it('preguntas distintas sin topic no compiten', () => {
    expect(groupConflicts([
      p(null, '¿IVA de gasolina?', 'Sí'),
      p(null, '¿IVA de casetas?', 'No'),
    ])).toEqual([]);
  });

  it('tres precedentes y dos respuestas distintas siguen siendo UN conflicto', () => {
    const g = groupConflicts([
      p('t', 'q1', 'A'), p('t', 'q2', 'B'), p('t', 'q3', 'a'),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].answers).toEqual(['A', 'B']);
    // Las tres filas van al informe: el humano tiene que poder retirar la
    // que sobra, y la tercera es una de las candidatas.
    expect(g[0].entries).toHaveLength(3);
  });
});

// ============================================================
// EL DETECTOR CONTRA LA BASE
// ============================================================
describe('detectMemoryConflicts', () => {
  it('sólo mira precedentes ACTIVOS y contestados, y nombra la entidad', async () => {
    mockQuery.mockResolvedValueOnce({ rows: memoriaDeUnDespacho() });
    const r = await detectMemoryConflicts({});
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/q\.status = 'answered'/);
    expect(sql).toMatch(/q\.is_precedent = true/);
    expect(sql).toMatch(/JOIN legal_entities/);
    expect(r.scanned).toBe(21);
  });

  it('sobre 21 precedentes encuentra los DOS que se contradicen y ninguno más', async () => {
    mockQuery.mockResolvedValueOnce({ rows: memoriaDeUnDespacho() });
    const { conflicts } = await detectMemoryConflicts({});

    expect(conflicts).toHaveLength(2);
    const claves = conflicts.map((c) => c.key).sort();
    expect(claves).toEqual(['clasificacion:telmex', '¿el iva de gasolina se acredita?']);

    const telmex = conflicts.find((c) => c.key === 'clasificacion:telmex')!;
    expect(telmex.entityName).toBe('Acme SA');
    expect(telmex.answers).toEqual(['6130 Servicios generales', '5205 Honorarios']);
    expect(telmex.entries.map((e) => e.id).sort()).toEqual(['a-01', 'a-02']);
  });

  it('dos entidades con el mismo slug NO forman un conflicto entre ellas', async () => {
    mockQuery.mockResolvedValueOnce({ rows: memoriaDeUnDespacho() });
    const { conflicts } = await detectMemoryConflicts({});
    // El slug 'clasificacion:telmex' existe en Acme y en Beta con respuestas
    // distintas; el único conflicto es el interno de Acme.
    expect(conflicts.every((c) => c.entityName === 'Acme SA')).toBe(true);
    expect(conflicts.flatMap((c) => c.entries).some((e) => e.id === 'b-01')).toBe(false);
  });

  it('acota por entidad cuando se le pide, dentro del SQL', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await detectMemoryConflicts({ entityId: 'ent-a' });
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/q\.entity_id = \$1/);
    expect(params).toEqual(['ent-a']);
  });

  it('DETECTA, no resuelve: no emite una sola escritura', async () => {
    mockQuery.mockResolvedValueOnce({ rows: memoriaDeUnDespacho() });
    await detectMemoryConflicts({});
    for (const call of mockQuery.mock.calls) {
      const sql = String(call[0]);
      expect(sql).not.toMatch(/UPDATE|DELETE|INSERT/i);
    }
  });
});

// ============================================================
// LA PREMISA DEL AVISO, VERIFICADA
//
// El aviso afirma que el modelo lee los dos criterios de la misma memoria.
// Si eso no fuera cierto, todo lo anterior sería teatro: un detector
// perfecto de algo que no ocurre. Aquí se comprueba con el digest que se
// embarca — el mismo que system-prompt.ts monta en cada sesión — que las
// DOS respuestas enfrentadas viajan de verdad en el bloque estable.
// ============================================================
describe('el digest lleva de hecho las dos respuestas enfrentadas', () => {
  it('las dos versiones del criterio entran en el mismo prompt', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { topic: 'clasificacion:telmex', question: 'q1', answer: '6130 Servicios generales',
          answered_by: 'admin@demo.com', answered_at: new Date('2026-08-01') },
        { topic: 'clasificacion:Telmex', question: 'q2', answer: '5205 Honorarios',
          answered_by: 'jefe@demo.com', answered_at: new Date('2026-06-01') },
      ],
    });
    const digest = await buildMemoryDigest(CTX);
    expect(digest).toContain('6130 Servicios generales');
    expect(digest).toContain('5205 Honorarios');
    // Y bajo el mismo slug, que es lo que hace que compitan por la misma
    // decisión en vez de hablar de cosas distintas.
    expect(digest.toLowerCase().split('clasificacion:telmex')).toHaveLength(3);
  });

  it('el tope que anuncia digestCoverage es el que la consulta aplica de verdad', async () => {
    // `maxEntries` sale de una constante y el recorte real sale del SQL. Si
    // se separan, la medida de higiene informa de un presupuesto que la base
    // no respeta — y con un tope de uno el digest no podría llevar nunca dos
    // criterios en conflicto, que es la premisa de todo lo anterior.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '0' }] });
    const c = await digestCoverage(CTX);
    const sql = String(mockQuery.mock.calls[0][0]);
    const limite = /LIMIT (\d+)/.exec(sql)?.[1];
    expect(limite, 'la consulta del digest perdió su tope').toBeDefined();
    expect(Number(limite)).toBe(c.maxEntries);
    expect(c.maxEntries).toBeGreaterThan(1);
  });
});

// ============================================================
// LO QUE EL MODELO NO LLEGA A VER
// ============================================================
describe('digestCoverage', () => {
  const linea = filaDigest;

  it('lee el digest POR SU FUNCIÓN y no reimplementa su consulta', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [linea(1)] });          // buildMemoryDigest
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '1' }] });         // conteo de activos
    const c = await digestCoverage(CTX);
    // La primera consulta es la del digest, con sus columnas y su tope.
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/SELECT topic, question, answer, answered_by/);
    expect(c).toEqual({ active: 1, visible: 1, hidden: 0, truncated: false, maxEntries: 50 });
  });

  it('cuenta como OCULTOS los que el recorte REAL por caracteres deja fuera', async () => {
    // Cuarenta precedentes largos contra el presupuesto DE PRODUCCIÓN — no
    // contra uno de juguete que la prueba se traiga: medir con un
    // presupuesto propio es exactamente el defecto que esta pieza vigila.
    mockQuery.mockResolvedValueOnce({ rows: Array.from({ length: 40 }, (_, i) => filaDigest(i, 200)) });
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '40' }] });
    const c = await digestCoverage(CTX);
    expect(c.active).toBe(40);
    expect(c.visible).toBeGreaterThan(0);
    expect(c.visible).toBeLessThan(40);
    expect(c.hidden).toBe(40 - c.visible);
    expect(c.truncated).toBe(true);
  });

  // ── LA COSTURA, DE LADO A LADO ───────────────────────────────────────
  // Llamar a buildMemoryDigest es NECESARIO Y NO SUFICIENTE. Si la medida
  // se tomara con otro presupuesto, la llamada seguiría estando y el número
  // hablaría de un digest que ninguna sesión recibe. Aquí se monta el
  // digest con la MISMA llamada que hace system-prompt.ts —sin segundo
  // argumento— y se exige que la cifra de higiene sea la de ese digest.
  it('mide el digest que el modelo recibe, no uno con presupuesto propio', async () => {
    const filas = Array.from({ length: 40 }, (_, i) => filaDigest(i, 200));

    mockQuery.mockResolvedValueOnce({ rows: filas });
    const embarcado = lineasDelDigest(await buildMemoryDigest(CTX));
    // El presupuesto tiene que MORDER: si cupieran las cuarenta, cualquier
    // presupuesto mayor daría el mismo número y esto no probaría nada.
    expect(embarcado.length).toBeGreaterThan(0);
    expect(embarcado.length).toBeLessThan(filas.length);

    mockQuery.mockResolvedValueOnce({ rows: filas });
    mockQuery.mockResolvedValueOnce({ rows: [{ n: String(filas.length) }] });
    const c = await digestCoverage(CTX);
    expect(c.visible).toBe(embarcado.length);
    expect(c.hidden).toBe(filas.length - embarcado.length);
  });

  it('el aviso de recorte no se cuenta como precedente visible', async () => {
    // Cincuenta filas es exactamente el tope de la consulta del digest: éste
    // añade la nota aunque nada se cortara por caracteres, y esa nota no es
    // un criterio.
    mockQuery.mockResolvedValueOnce({ rows: Array.from({ length: 50 }, (_, i) => linea(i, 10)) });
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '73' }] });
    const c = await digestCoverage(CTX);
    expect(c.visible).toBe(50);
    expect(c.truncated).toBe(true);
    expect(c.hidden).toBe(23);
  });
});

// ============================================================
// UN PRECEDENTE CONTRA UNA POLÍTICA YA CONTESTADA
// ============================================================
describe('detectPolicyContradictions', () => {
  const filaPol = (over: Record<string, unknown> = {}) => ({
    policy_key: 'catalogo_entidad_no_mexicana',
    resolved_value: 'base_neutro',
    options: [{ value: 'base_neutro', label: 'x' }, { value: 'ninguno', label: 'y' }],
    precedent_id: 'p-1', entity_id: 'ent-a', entity_name: 'Acme SA',
    question: 'Para catalogo_entidad_no_mexicana, ¿qué hacemos?',
    answer: 'Se usa ninguno: la filial trae su propio catálogo',
    topic: null,
    ...over,
  });

  it('sólo mira políticas RESUELTAS y precedentes activos', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await detectPolicyContradictions({});
    const sql = String(mockQuery.mock.calls[0][0]);
    expect(sql).toMatch(/p\.status = 'resolved'/);
    expect(sql).toMatch(/q\.is_precedent = true/);
  });

  it('marca el precedente que nombra la clave y una opción distinta de la resuelta', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [filaPol()] });
    const r = await detectPolicyContradictions({});
    expect(r).toHaveLength(1);
    expect(r[0].policyKey).toBe('catalogo_entidad_no_mexicana');
    expect(r[0].resolvedValue).toBe('base_neutro');
    expect(r[0].namedInstead).toEqual(['ninguno']);
    expect(r[0].precedentAnswer).toMatch(/su propio catálogo/);
  });

  it('calla cuando el precedente repite lo que el panel ya contestó', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [filaPol({ answer: 'Se usa base_neutro, como dice el panel' })],
    });
    expect(await detectPolicyContradictions({})).toEqual([]);
  });

  it('calla cuando cita las dos opciones y se queda con la RESUELTA', async () => {
    // El caso que separa un detector útil de uno que grita: un precedente
    // que razona («valoramos ninguno, mandamos base_neutro») nombra las dos
    // opciones. Acusarlo es acusar a quien documentó bien la decisión, y un
    // aviso que castiga la buena documentación se apaga a la semana.
    mockQuery.mockResolvedValueOnce({
      rows: [filaPol({
        answer: 'Valoramos ninguno; para catalogo_entidad_no_mexicana mandamos base_neutro',
      })],
    });
    expect(await detectPolicyContradictions({})).toEqual([]);
  });

  it('calla cuando el precedente no nombra ninguna opción: no inventa semántica', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [filaPol({ answer: 'Preguntarle al socio antes de sembrar nada' })],
    });
    expect(await detectPolicyContradictions({})).toEqual([]);
  });

  it('no confunde una opción con un trozo de otra palabra', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [filaPol({ answer: 'El catálogo ningunoide no existe' })],
    });
    expect(await detectPolicyContradictions({})).toEqual([]);
  });
});

describe('detectStrandedMemory', () => {
  it('cuenta los precedentes anclados a una entidad DESACTIVADA', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ entity_name: 'Vieja SA', n: '7' }] });
    const r = await detectStrandedMemory();
    expect(String(mockQuery.mock.calls[0][0])).toMatch(/e\.is_active = false/);
    expect(r).toEqual([{ entityName: 'Vieja SA', count: 7 }]);
  });
});

// ============================================================
// EL MUTANTE OBLIGATORIO VIVE AQUÍ.
//
// Esto NO grepea el fuente: corre `runDoctor` —el que se embarca, el que
// llama `mnemosine doctor`— contra la memoria de un despacho de veintiún
// precedentes y exige que el hallazgo salga en el informe, con la entidad,
// con la decisión disputada y con las DOS respuestas enfrentadas tal como
// están escritas. Si la comprobación deja de mirar los conflictos, o si
// deja de estar enchufada a runDoctor, o si devuelve el hallazgo sin las
// respuestas, esto se pone rojo por CONDUCTA.
// ============================================================
describe('doctor devuelve el hallazgo de precedentes en conflicto', () => {
  let tmpDir: string;
  const ENV = { ...process.env };

  interface Sobre {
    precedentes?: FilaCruda[];
    digest?: unknown[];
    activos?: string;
    entidades?: Array<{ id: string; name: string }>;
    /**
     * Memoria POR ENTIDAD. La base real responde distinto a cada entidad y
     * un doble que contesta lo mismo a todas no puede distinguir un bucle
     * que recorre el despacho entero de uno que se para en la primera.
     */
    porEntidad?: Record<string, { digest?: unknown[]; activos?: string }>;
    varados?: Array<{ entity_name: string; n: string }>;
    politicas?: unknown[];
  }

  /** Responde por la CONSULTA y por SUS PARÁMETROS, como la base de verdad. */
  function mockDb(over: Sobre = {}) {
    mockQuery.mockImplementation((sql?: unknown, params?: unknown[]) => {
      const q = typeof sql === 'string' ? sql : '';
      const deQuien = paramTexto(params, 1);
      const suya = over.porEntidad?.[deQuien];
      const rows = (r: unknown[]) => Promise.resolve({ rows: r, rowCount: r.length });
      if (q.includes('version()')) return rows([{ v: 'PostgreSQL 15.17 on x86_64' }]);
      if (q.includes('public.migrations')) return rows([]);
      // ── memoria ── (antes de los comodines: comparten tablas)
      if (q.includes('policy_decisions')) return rows(over.politicas ?? []);
      if (q.includes('e.is_active = false')) return rows(over.varados ?? []);
      if (q.includes('FROM ai_questions q')) return rows(over.precedentes ?? []);
      if (q.includes('SELECT topic, question, answer, answered_by')) {
        return rows(suya?.digest ?? over.digest ?? []);
      }
      if (q.includes('count(*)::text AS n FROM ai_questions')) {
        return rows([{ n: suya?.activos ?? over.activos ?? '0' }]);
      }
      if (q.includes('SELECT id, name FROM legal_entities')) return rows(over.entidades ?? []);
      // ── el resto del doctor ──
      if (q.includes('legal_entities')) return rows([{ n: '1' }]);
      if (q.includes('pg_roles')) {
        return rows([{ current_user: 'app', is_super: false, bypass: false, rls_tables: '57' }]);
      }
      if (q.includes('ai_drafts')) return rows([{ drafts: '0', questions: '0', ops: '0' }]);
      if (q.includes('fiscal_credentials')) return rows([{ n: '0', soonest: null }]);
      return rows([]);
    });
  }

  const find = (r: DoctorReport, name: string) => {
    const c = r.checks.find((x) => x.name === name);
    if (!c) throw new Error(`doctor no devolvió la comprobación "${name}"`);
    return c;
  };

  beforeEach(() => {
    mockQuery.mockReset();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memoria-doctor-'));
    delete process.env.MNEMOSINE_PROVIDER;
    process.env.ENCRYPTION_KEY = 'a'.repeat(64);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.env = { ...ENV };
  });

  const correr = () => runDoctor({ migrationsDir: tmpDir, cwd: tmpDir });

  it('avisa, nombra la entidad y enseña las DOS respuestas enfrentadas', async () => {
    mockDb({ precedentes: memoriaDeUnDespacho() });
    const c = find(await correr(), 'Memory conflicts');

    expect(c.level).toBe('warn');
    expect(c.detail).toContain('Acme SA');
    expect(c.detail).toContain('clasificacion:telmex');
    // Sin las dos respuestas el aviso no dice qué está en disputa, y un
    // aviso que no lo dice obliga a ir a buscarlo: eso es el síntoma solo.
    expect(c.detail).toContain('6130 Servicios generales');
    expect(c.detail).toContain('5205 Honorarios');
    // El denominador: dos conflictos sobre veintiún precedentes activos.
    expect(c.detail).toContain('21');
    expect(c.detail).toMatch(/^2 decision\(s\)/);
  });

  it('no acusa a los casi-conflictos ni cruza entidades', async () => {
    mockDb({ precedentes: memoriaDeUnDespacho() });
    const c = find(await correr(), 'Memory conflicts');
    // La misma respuesta con otra tipografía (CFE), la depreciación repetida
    // y el mismo slug en otra entidad NO son hallazgos.
    expect(c.detail).not.toContain('5210');
    expect(c.detail).not.toContain('25%');
    expect(c.detail).not.toContain('Beta SA');
    expect(c.detail).not.toContain('9999 Cuenta puente');
  });

  it('da el comando exacto del remedio, y el remedio lo ejecuta un humano', async () => {
    mockDb({ precedentes: memoriaDeUnDespacho() });
    const c = find(await correr(), 'Memory conflicts');
    expect(c.fix).toContain('mnemosine memory --conflicts');
    expect(c.fix).toContain('mnemosine memory retire');
    expect(c.fix).toContain('--reason');
  });

  it('la MISMA memoria sin contradicción sale en verde, con el denominador', async () => {
    // Control: si el detector avisara siempre, esto también sería warn.
    mockDb({
      precedentes: memoriaDeUnDespacho({
        telmexViejo: '6130 Servicios generales',
        gasolinaVieja: 'Sí, con CFDI y pago con tarjeta',
      }),
    });
    const c = find(await correr(), 'Memory conflicts');
    expect(c.level).toBe('ok');
    expect(c.detail).toContain('21');
    expect(c.fix).toBeUndefined();
  });

  it('con memoria vacía lo dice, en vez de firmar un certificado de salud', async () => {
    mockDb({ precedentes: [] });
    const c = find(await correr(), 'Memory conflicts');
    expect(c.level).toBe('ok');
    expect(c.detail).toMatch(/no active precedents/);
  });

  it('un conflicto NO tumba el diagnóstico: doctor sigue enumerando y no falla', async () => {
    // Un proveedor local configurado: sin él el 'fail' del proveedor de
    // modelo taparía lo que esta prueba mide, que es que un criterio
    // contradictorio AVISA y no impide operar.
    fs.writeFileSync(path.join(tmpDir, 'mnemosine.config.json'), JSON.stringify({
      default_provider: 'local',
      providers: { local: { type: 'openai-compatible', model: 'm', base_url: 'http://x/v1' } },
    }));
    mockDb({ precedentes: memoriaDeUnDespacho() });
    const r = await correr();
    expect(r.checks.find((c) => c.name === 'Memory conflicts')!.level).toBe('warn');
    // Ningún fallo: el sistema opera con la memoria contradictoria — mal,
    // pero opera. Poner en rojo (y en código de salida 1) una instalación
    // que trabaja es lo que enseña a la gente a ignorar doctor.
    expect(r.checks.filter((c) => c.level === 'fail')).toEqual([]);
    expect(r.worst).toBe('warn');
    // Las comprobaciones posteriores siguen ahí: el modelo de doctor es
    // enumerar todo aunque algo anterior avise.
    expect(r.checks.find((c) => c.name === 'Fiscal credentials')).toBeDefined();
    expect(r.checks.find((c) => c.name === 'Encryption key')).toBeDefined();
  });

  it('avisa de los precedentes que no caben en el digest, con entidad y cifras', async () => {
    mockDb({
      entidades: [{ id: 'ent-a', name: 'Acme SA' }],
      digest: Array.from({ length: 50 }, (_, i) => ({
        topic: `t-${i}`, question: `q-${i}`, answer: 'y',
        answered_by: 'admin@demo.com', answered_at: new Date('2026-08-10'),
      })),
      activos: '64',
    });
    const c = find(await correr(), 'Memory in the prompt');
    expect(c.level).toBe('warn');
    expect(c.detail).toContain('Acme SA');
    expect(c.detail).toContain('14');   // 64 activos − 50 que caben
    expect(c.detail).toContain('64');
    expect(c.fix).toContain('mnemosine memory');
  });

  it('verde cuando toda la memoria activa cabe en el digest', async () => {
    mockDb({
      entidades: [{ id: 'ent-a', name: 'Acme SA' }],
      digest: [{
        topic: 't-1', question: 'q-1', answer: 'y',
        answered_by: 'admin@demo.com', answered_at: new Date('2026-08-10'),
      }],
      activos: '1',
    });
    const c = find(await correr(), 'Memory in the prompt');
    expect(c.level).toBe('ok');
    expect(c.detail).toContain('1 of 1');
  });

  // ── LA COSTURA, DESDE EL LADO DEL LLAMADOR ───────────────────────────
  // doctor llama a `digestCoverage`, y eso es necesario y no suficiente: si
  // midiera con otro presupuesto, la llamada seguiría ahí y la cifra
  // hablaría de un digest que ninguna sesión recibe. Aquí se monta primero
  // el digest EMBARCADO —la misma llamada de system-prompt.ts, sin
  // presupuesto— sobre las mismas filas, y se le exige a doctor esa cifra.
  it('la cifra que publica doctor es la del digest que viaja en la sesión', async () => {
    const filas = Array.from({ length: 40 }, (_, i) => filaDigest(i, 200));

    mockQuery.mockResolvedValueOnce({ rows: filas });
    const embarcado = lineasDelDigest(await buildMemoryDigest(CTX));
    expect(embarcado.length).toBeGreaterThan(0);
    // El presupuesto de producción muerde: sin eso, cualquier presupuesto
    // más generoso daría el mismo número y la prueba no vería la diferencia.
    expect(embarcado.length).toBeLessThan(filas.length);

    mockDb({
      entidades: [{ id: 'ent-a', name: 'Acme SA' }],
      digest: filas,
      activos: String(filas.length),
    });
    const c = find(await correr(), 'Memory in the prompt');
    expect(c.level).toBe('warn');
    expect(c.detail).toContain(`Acme SA: ${filas.length - embarcado.length} of 40 past the digest cut`);
  });

  // ── TODAS LAS ENTIDADES, NO LA PRIMERA ───────────────────────────────
  // El despacho tiene varias entidades y cada una tiene su digest. Con una
  // sola en el aparejo, un bucle que se rompe tras la primera desbordada se
  // ve idéntico al que recorre el censo entero.
  it('avisa de las CUATRO entidades desbordadas, no sólo de la primera', async () => {
    const lleno = Array.from({ length: 50 }, (_, i) => filaDigest(i, 10));
    mockDb({
      entidades: [
        { id: 'ent-a', name: 'Acme SA' },
        { id: 'ent-b', name: 'Beta SA' },
        { id: 'ent-c', name: 'Gamma SA' },
        { id: 'ent-d', name: 'Delta SA' },
      ],
      porEntidad: {
        'ent-a': { digest: lleno, activos: '64' },
        'ent-b': { digest: lleno, activos: '90' },
        'ent-c': { digest: lleno, activos: '55' },
        'ent-d': { digest: lleno, activos: '52' },
      },
    });
    const c = find(await correr(), 'Memory in the prompt');
    expect(c.level).toBe('warn');
    expect(c.detail).toContain('Acme SA: 14 of 64');
    expect(c.detail).toContain('Beta SA: 40 of 90');
    expect(c.detail).toContain('Gamma SA: 5 of 55');
    // La cuarta no cabe en el renglón, pero se DICE que está: cortar en tres
    // sin decirlo esconde entidades justo donde el aviso existe para no
    // esconderlas.
    expect(c.detail).toContain('(+1)');
  });

  it('la entidad desbordada se ve aunque la PRIMERA esté sana', async () => {
    mockDb({
      entidades: [
        { id: 'ent-a', name: 'Acme SA' },
        { id: 'ent-b', name: 'Beta SA' },
      ],
      porEntidad: {
        'ent-a': { digest: Array.from({ length: 3 }, (_, i) => filaDigest(i, 10)), activos: '3' },
        'ent-b': { digest: Array.from({ length: 50 }, (_, i) => filaDigest(i, 10)), activos: '90' },
      },
    });
    const c = find(await correr(), 'Memory in the prompt');
    expect(c.level).toBe('warn');
    expect(c.detail).toContain('Beta SA: 40 of 90');
    // Acme está sana: no se la nombra como desbordada.
    expect(c.detail).not.toContain('Acme SA:');
  });

  it('el verde suma TODAS las entidades, no informa sólo de la primera', async () => {
    mockDb({
      entidades: [
        { id: 'ent-a', name: 'Acme SA' },
        { id: 'ent-b', name: 'Beta SA' },
      ],
      porEntidad: {
        'ent-a': { digest: Array.from({ length: 3 }, (_, i) => filaDigest(i, 10)), activos: '3' },
        'ent-b': { digest: Array.from({ length: 5 }, (_, i) => filaDigest(i, 10)), activos: '5' },
      },
    });
    const c = find(await correr(), 'Memory in the prompt');
    expect(c.level).toBe('ok');
    // 3 + 5. Pararse en la primera diría «3 of 3» y sonaría igual de sano.
    expect(c.detail).toContain('8 of 8');
  });

  it('avisa de la memoria varada en una entidad desactivada', async () => {
    mockDb({
      entidades: [],
      varados: [{ entity_name: 'Vieja SA', n: '7' }],
    });
    const c = find(await correr(), 'Memory in the prompt');
    expect(c.level).toBe('warn');
    expect(c.detail).toContain('Vieja SA');
    expect(c.detail).toContain('7');
    expect(c.detail).toMatch(/no session can ever load them/);
  });

  it('avisa del precedente que reabre una política ya contestada en el panel', async () => {
    mockDb({
      politicas: [{
        policy_key: 'catalogo_entidad_no_mexicana',
        resolved_value: 'base_neutro',
        options: [{ value: 'base_neutro', label: 'x' }, { value: 'ninguno', label: 'y' }],
        precedent_id: 'p-1', entity_id: 'ent-a', entity_name: 'Acme SA',
        question: 'Sobre catalogo_entidad_no_mexicana',
        answer: 'Va con ninguno y ya',
        topic: null,
      }],
    });
    const c = find(await correr(), 'Memory vs policy panel');
    expect(c.level).toBe('warn');
    expect(c.detail).toContain('catalogo_entidad_no_mexicana');
    expect(c.detail).toContain('base_neutro');
    expect(c.detail).toContain('Va con ninguno y ya');
    // El remedio manda a donde viven las decisiones, no a un JSON.
    expect(c.fix).toContain('mnemosine pending');
  });
});

// ============================================================
// LA SUPERFICIE HUMANA: OFRECER, NO DECIDIR
// ============================================================
describe('mnemosine memory --conflicts', () => {
  const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };

  const conflictos = async () => {
    mockQuery.mockResolvedValueOnce({ rows: memoriaDeUnDespacho() });
    return detectMemoryConflicts({});
  };

  it('imprime cada precedente en disputa con su id y el comando que lo retira', async () => {
    const { conflicts, scanned } = await conflictos();
    const txt = renderConflicts(conflicts, scanned, plain).join('\n');

    expect(txt).toContain('6130 Servicios generales');
    expect(txt).toContain('5205 Honorarios');
    // El comando exacto, con el id concreto: el modelo de doctor.
    expect(txt).toContain('mnemosine memory retire a-01 --reason');
    expect(txt).toContain('mnemosine memory retire a-02 --reason');
    expect(txt).toContain('21');
  });

  it('dice por escrito que el sistema NO desempata', async () => {
    const { conflicts, scanned } = await conflictos();
    const txt = renderConflicts(conflicts, scanned, plain).join('\n');
    expect(txt).toMatch(/Nobody but you decides which one stands/);
    expect(txt).toContain('mnemosine memory correct');
  });

  it('sin conflictos lo dice con el denominador delante', () => {
    const txt = renderConflicts([], 21, plain).join('\n');
    expect(txt).toMatch(/the 21 active precedent\(s\) do not contradict each other/);
  });

  // ── QUE EXISTA LA BANDERA NO ES QUE SE ALCANCE ───────────────────────
  // Lo anterior prueba el renderizador. Esto monta el comando REAL con
  // `registerMemoryCommand` y lo hace correr: si `--conflicts` quedara
  // declarada y la acción no se bifurcara por ella, el informe no saldría
  // por ninguna parte y nadie se enteraría.
  it('la bandera --conflicts alcanza el informe de verdad, no sólo se declara', async () => {
    const impreso: string[] = [];
    const salir = new Error('shutdown');
    const codigos: number[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      impreso.push(a.map(String).join(' '));
    });
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program, {
      palette: plain,
      shutdown: async (code: number) => { codigos.push(code); throw salir; },
      reportError: () => {},
    });

    mockQuery.mockResolvedValue({ rows: memoriaDeUnDespacho(), rowCount: 21 });
    await expect(
      program.parseAsync(['node', 'mnemosine', 'memory', '--conflicts'])
    ).rejects.toBe(salir);
    spy.mockRestore();

    const txt = impreso.join('\n');
    expect(txt).toContain('Precedents in conflict');
    expect(txt).toContain('6130 Servicios generales');
    expect(txt).toContain('mnemosine memory retire a-02 --reason');
    // Listar conflictos no es un fallo del comando: se listó lo que había.
    expect(codigos[0]).toBe(0);
  });

  it('el --reason que el informe sugiere llega hasta el UPDATE, no se queda en la ayuda', async () => {
    // El informe imprime `--reason "<por qué>"`. Si la bandera se declarara
    // y la acción no la reenviara, el humano escribiría el motivo y el
    // rastro del precedente no lo tendría: la resolución perdería su porqué
    // y nadie lo notaría hasta la siguiente auditoría.
    const salir = new Error('shutdown');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program, {
      palette: plain,
      shutdown: async () => { throw salir; },
      reportError: () => {},
    });

    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(
      program.parseAsync([
        'node', 'mnemosine', 'memory', 'retire', 'a-02',
        '--reason', 'perdió contra a-01 en clasificacion:telmex',
      ])
    ).rejects.toBe(salir);
    spy.mockRestore();

    const update = mockQuery.mock.calls.find((c) => /SET is_precedent = false/.test(String(c[0])));
    expect(update, 'el comando no llegó a retirar nada').toBeDefined();
    expect(update![1]).toContain('perdió contra a-01 en clasificacion:telmex');
  });

  it('el motivo de un retiro viaja al rastro del precedente, no se pierde', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await retireMemory(
      { entityId: 'ent-a', entityName: 'Acme SA', tenantId: 'tenant-1',
        currency: 'MXN', country: 'MX', accountingStandard: 'mx_nif', taxId: 'AME010101AAA' },
      'a-02', 'jefe@demo.com', 'perdió contra a-01 en clasificacion:telmex'
    );
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/SET is_precedent = false/);
    expect(sql).not.toMatch(/DELETE/);
    // El motivo entra parametrizado y se concatena al rastro: sin él la
    // bitácora dice quién apagó el criterio y no contra qué perdió.
    expect(params).toEqual([
      'jefe@demo.com', 'a-02', 'ent-a', 'perdió contra a-01 en clasificacion:telmex',
    ]);
    expect(sql).toMatch(/\$4/);
  });

  it('el renglón de higiene calla cuando todo cabe y habla cuando no', () => {
    expect(renderDigestCoverage(
      { active: 3, visible: 3, hidden: 0, truncated: false, maxEntries: 50 }, plain
    )).toEqual([]);
    const txt = renderDigestCoverage(
      { active: 64, visible: 50, hidden: 14, truncated: true, maxEntries: 50 }, plain
    ).join('\n');
    expect(txt).toContain('14 of 64');
    expect(txt).toContain('mnemosine memory retire');
  });
});

// ============================================================
// LA COSTURA DEL CLI, DE LADO A LADO
//
// Había dos pruebas de un solo lado: una llamaba a `detectMemoryConflicts`
// a pelo y comprobaba que su SQL lleva `q.entity_id = $1`; otra montaba el
// comando de verdad contra un doble que devolvía las mismas filas dijera lo
// que dijera la consulta. Ninguna de las dos —ni las dos juntas— comprueba
// que el COMANDO le PASE la entidad al detector: quitar el `entityId` de la
// llamada las dejaba a las dos en verde.
//
// Aquí el comando que monta el binario corre contra un doble que VERIFICA
// EL ARGUMENTO con el que fue llamado: lee la frontera del SQL, responde
// como respondería Postgres —las filas de esa entidad, o las de todo el
// tenant si nadie la acotó— y apunta con qué entidad se le pidió. Así el
// mutante muere por tres sitios: el espía, el SQL y lo que el humano lee.
// ============================================================
describe('la frontera de entidad del CLI de memoria llega hasta el SQL', () => {
  const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };

  interface Espia {
    /** Ids de entidad con los que se acotó la consulta de conflictos. */
    acotadaCon: string[];
    /** Veces que esa consulta llegó SIN frontera de entidad. */
    sinFrontera: number;
  }

  function montar(memoria: FilaCruda[]): Espia {
    const espia: Espia = { acotadaCon: [], sinFrontera: 0 };
    mockQuery.mockImplementation((sql?: unknown, params?: unknown[]) => {
      const q = typeof sql === 'string' ? sql : '';
      const p = (params ?? []) as unknown[];
      const rows = (r: unknown[]) => Promise.resolve({ rows: r, rowCount: r.length });

      // LA CONSULTA DE CONFLICTOS.
      if (q.includes('FROM ai_questions q') && q.includes('JOIN legal_entities')) {
        const m = /q\.entity_id = \$(\d+)/.exec(q);
        if (!m) {
          espia.sinFrontera += 1;
          return rows(memoria); // todo el tenant, como haría la base
        }
        const id = paramTexto(p, Number(m[1]));
        espia.acotadaCon.push(id);
        return rows(memoria.filter((r) => r.entity_id === id));
      }
      if (q.includes('count(*) FILTER (WHERE is_precedent)')) {
        return rows([{ active: '14', retired: '0', taught: '0' }]);
      }
      if (q.includes('GROUP BY topic')) return rows([]);
      if (q.includes('SELECT topic, question, answer, answered_by')) return rows([]);
      if (q.includes('count(*)::text AS n FROM ai_questions')) return rows([{ n: '0' }]);
      if (q.includes('FROM ai_questions')) {
        const id = paramTexto(p, 1);
        return rows(
          memoria
            .filter((r) => r.entity_id === id)
            .map((r) => ({
              id: r.id, question: r.question, answer: r.answer, context: null,
              topic: r.topic, answered_by: r.answered_by, answered_at: r.answered_at,
              is_precedent: true,
            }))
        );
      }
      return rows([]);
    });
    return espia;
  }

  /** Monta el árbol de comandos REAL y lo hace correr, como el binario. */
  const correrCli = async (args: string[]) => {
    const impreso: string[] = [];
    // Los errores NO van a la salida impresa: `shutdown` sale lanzando y el
    // propio catch del comando lo recoge, así que mezclarlos ensuciaría el
    // texto (y el JSON) que esta prueba lee.
    const errores: unknown[] = [];
    const salir = new Error('shutdown');
    const codigos: number[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      impreso.push(a.map(String).join(' '));
    });
    const program = new Command();
    program.exitOverride();
    registerMemoryCommand(program, {
      palette: plain,
      shutdown: async (code: number) => { codigos.push(code); throw salir; },
      reportError: (err) => { errores.push(err); },
    });
    await expect(program.parseAsync(['node', 'mnemosine', ...args])).rejects.toBe(salir);
    spy.mockRestore();
    // Lo único que puede haber fallado es el `shutdown` de mentira.
    expect(errores.filter((e) => e !== salir)).toEqual([]);
    return { txt: impreso.join('\n'), codigos };
  };

  /** La consulta de conflictos tal y como salió del comando. */
  const consultaDeConflictos = () =>
    mockQuery.mock.calls.find(
      (c) => /FROM ai_questions q/.test(String(c[0])) && /JOIN legal_entities/.test(String(c[0]))
    ) as [string, unknown[]] | undefined;

  it('--conflicts le PASA la entidad al detector, y la otra no entra', async () => {
    const espia = montar(memoriaDeDosDespachos());
    const { txt, codigos } = await correrCli(['memory', '--conflicts']);

    // (1) Lo que el humano lee, PRIMERO: el conflicto de Acme sale; el de
    //     Beta, que existe en la tabla, no; y el denominador es el de Acme
    //     (14 precedentes), no el de las dos entidades (22). Va delante a
    //     propósito, para que la prueba muera por la consecuencia y no sólo
    //     por la instrumentación.
    expect(txt).toContain('clasificacion:telmex');
    expect(txt).toContain('6130 Servicios generales');
    expect(txt).not.toContain('9998 Cuenta rara');
    expect(txt).not.toContain('Beta SA');
    expect(txt).toContain('2 decision(s) with contradicting criteria, out of 14 active');
    expect(codigos[0]).toBe(0);

    // (2) El SQL que salió de verdad lleva la frontera y su parámetro.
    const consulta = consultaDeConflictos();
    expect(consulta, 'el comando no llegó a buscar conflictos').toBeDefined();
    expect(consulta![0]).toMatch(/q\.entity_id = \$1/);
    expect(consulta![1]).toEqual(['ent-a']);

    // (3) Y el doble dice con qué se le llamó de verdad.
    expect(espia.sinFrontera).toBe(0);
    expect(espia.acotadaCon).toEqual(['ent-a']);
  });

  it('--conflicts --json entrega el informe de UNA entidad, con su denominador', async () => {
    const espia = montar(memoriaDeDosDespachos());
    const { txt } = await correrCli(['memory', '--conflicts', '--json']);
    const informe = JSON.parse(txt) as {
      scanned: number;
      conflicts: Array<{ entityId: string; entityName: string; key: string }>;
    };
    expect(espia.acotadaCon).toEqual(['ent-a']);
    expect(informe.scanned).toBe(14);
    expect(informe.conflicts.map((c) => c.entityId)).toEqual(['ent-a', 'ent-a']);
    expect(informe.conflicts.map((c) => c.key).sort())
      .toEqual(['clasificacion:telmex', '¿el iva de gasolina se acredita?']);
    expect(informe.conflicts.some((c) => c.entityName === 'Beta SA')).toBe(false);
  });

  it('el listado normal acota igual: cuenta los conflictos de ESTA entidad', async () => {
    // Segunda llamada, segundo sitio donde la frontera se puede caer sola.
    const espia = montar(memoriaDeDosDespachos());
    const { txt } = await correrCli(['memory']);

    // Dos: los de Acme. Sin frontera serían tres, y el humano leería un
    // recuento de contradicciones que no son de su entidad.
    expect(txt).toContain('2 decision(s) have contradicting precedents');
    expect(txt).not.toContain('3 decision(s) have contradicting precedents');

    const consulta = consultaDeConflictos();
    expect(consulta, 'el listado no llegó a buscar conflictos').toBeDefined();
    expect(consulta![0]).toMatch(/q\.entity_id = \$1/);
    expect(consulta![1]).toEqual(['ent-a']);

    expect(espia.sinFrontera).toBe(0);
    expect(espia.acotadaCon).toEqual(['ent-a']);
  });
});

// ============================================================
// DONDE EL MODELO SE LOS ENCUENTRA
//
// doctor los ve cuando alguien corre doctor. El modelo se los topa AQUÍ,
// clasificando una factura, y hasta ahora la regla «prevalece el más
// reciente» le resolvía la contradicción en silencio.
// ============================================================
describe('search_precedents marca el conflicto en el momento de usarlo', () => {
  type ToolHandle<I> = BetaTool & {
    run: (input: I) => Promise<string | BetaToolResultContentBlockParam[]>;
  };
  /** La forma exacta del tool_result que el modelo recibe. */
  interface Salida {
    count: number;
    conflicts?: Array<{ competing_for: string; grouped_by: string; answers: string[] }>;
    conflict_note?: string;
    precedents: Array<{ answer: string | null }>;
  }
  const correr = async (busqueda: string): Promise<Salida> =>
    JSON.parse((await herramienta().run({ search: busqueda })) as string) as Salida;
  const herramienta = () =>
    buildQuestionTools(CTX, { model: 'claude-opus-5' })
      .find((t) => t.name === 'search_precedents')! as ToolHandle<{ search: string }>;

  const precedente = (over: Record<string, unknown>) => ({
    id: 'q-1', entity_id: 'ent-a', status: 'answered', question: '¿Telmex?',
    context: null, options: null, topic: 'clasificacion:telmex', answer: '6130',
    answered_by: 'admin@demo.com', answered_at: new Date('2026-08-01'),
    is_precedent: true, created_at: new Date('2026-08-01'), ...over,
  });

  beforeEach(() => mockSearch.mockReset());

  it('devuelve el conflicto y le prohíbe elegir por su cuenta', async () => {
    mockSearch.mockResolvedValueOnce([
      precedente({ id: 'q-1', answer: '6130 Servicios generales' }),
      precedente({ id: 'q-2', answer: '5205 Honorarios' }),
    ]);
    const salida = await correr('telmex');

    expect(salida.conflicts).toHaveLength(1);
    expect(salida.conflicts![0].competing_for).toBe('clasificacion:telmex');
    expect(salida.conflicts![0].answers).toEqual(['6130 Servicios generales', '5205 Honorarios']);
    expect(salida.conflict_note).toMatch(/Do NOT/);
    expect(salida.conflict_note).toMatch(/most recent/);
    expect(salida.conflict_note).toMatch(/ask_user/);
    // Los precedentes siguen llegando enteros y EN EL ORDEN en que la
    // consulta los devolvió: reordenarlos ya sería insinuar un ganador.
    expect(salida.precedents).toHaveLength(2);
    expect(salida.precedents.map((p) => p.answer))
      .toEqual(['6130 Servicios generales', '5205 Honorarios']);
  });

  // ── LA FORMA CERRADA, NO SÓLO POBLADA ────────────────────────────────
  //
  // Todo lo anterior son aserciones POSITIVAS: comprueban que está lo que
  // tiene que estar. Con sólo eso, añadir aquí un campo `prevailing` con el
  // precedente más reciente pasaría entero: el sistema le entregaría al
  // modelo un GANADOR calculado por fecha dentro del mismo objeto en el que
  // le dice, por escrito, que sólo un humano resuelve el conflicto — y el
  // modelo obedece al campo, no a la nota. La autonomía se amplía así: por
  // un campo de conveniencia que nadie decidió añadir.
  //
  // Por eso el juego de claves se cierra a CUALQUIER profundidad. Una clave
  // nueva, se llame como se llame y cuelgue de donde cuelgue, pone esto en
  // rojo.
  const clavesDe = (v: unknown, prefijo = ''): string[] => {
    if (Array.isArray(v)) return v.flatMap((x) => clavesDe(x, `${prefijo}[]`));
    if (v !== null && typeof v === 'object') {
      return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => [
        `${prefijo}.${k}`,
        ...clavesDe(x, `${prefijo}.${k}`),
      ]);
    }
    return [];
  };
  const clavesUnicas = (v: unknown): string[] => [...new Set(clavesDe(v))].sort();

  const CLAVES_PRECEDENTE = [
    '.precedents',
    '.precedents[].answer',
    '.precedents[].answered_at',
    '.precedents[].answered_by',
    '.precedents[].context',
    '.precedents[].question',
    '.precedents[].topic',
  ];

  it('en conflicto entrega EXACTAMENTE estas claves, ni una más', async () => {
    mockSearch.mockResolvedValueOnce([
      precedente({ id: 'q-1', answer: '6130 Servicios generales' }),
      precedente({ id: 'q-2', answer: '5205 Honorarios', answered_at: new Date('2026-06-01') }),
    ]);
    expect(clavesUnicas(await correr('telmex'))).toEqual([
      '.conflict_note',
      '.conflicts',
      '.conflicts[].answers',
      '.conflicts[].competing_for',
      '.conflicts[].grouped_by',
      '.count',
      ...CLAVES_PRECEDENTE,
    ]);
  });

  it('sin conflicto tampoco aparece nada nuevo', async () => {
    mockSearch.mockResolvedValueOnce([precedente({ id: 'q-1', answer: '6130 Servicios' })]);
    expect(clavesUnicas(await correr('telmex'))).toEqual(['.count', ...CLAVES_PRECEDENTE]);
  });

  it('ninguna clave corona un precedente: el resultado no trae ganador', async () => {
    mockSearch.mockResolvedValueOnce([
      precedente({ id: 'q-1', answer: '6130 Servicios generales' }),
      precedente({ id: 'q-2', answer: '5205 Honorarios', answered_at: new Date('2026-06-01') }),
    ]);
    const salida = await correr('telmex');
    // La clase, dicha por su nombre: nada de desempate en la forma. El juego
    // de claves de arriba ya lo cierra; esto nombra lo que se está evitando,
    // para que quien añada el campo lea por qué no.
    for (const k of clavesDe(salida)) {
      expect(k, `la forma del tool_result coronó un precedente: ${k}`)
        .not.toMatch(/prevail|winner|ganador|suggested|chosen|stands|applies|effective|newest|most_recent/i);
    }
    // Y el desempate se sigue mandando al humano, por escrito.
    expect(salida.conflict_note).toMatch(/only a human resolves|a human decides which one stands/i);
  });

  it('un precedente sin contexto ni topic conserva la misma forma', async () => {
    // Los campos vacíos viajan como null, no desaparecen: si la forma
    // cambiara según el contenido, cerrarla en un caso no la cerraría.
    mockSearch.mockResolvedValueOnce([
      precedente({ id: 'q-1', topic: null, context: null, answer: 'Sí' }),
      precedente({ id: 'q-2', topic: null, context: null, answer: 'No' }),
    ]);
    const salida = await correr('gasolina');
    expect(clavesUnicas(salida)).toEqual([
      '.conflict_note',
      '.conflicts',
      '.conflicts[].answers',
      '.conflicts[].competing_for',
      '.conflicts[].grouped_by',
      '.count',
      ...CLAVES_PRECEDENTE,
    ]);
    // Y el grupo se formó por la PREGUNTA, que es la otra rama de la clave.
    expect(salida.conflicts![0].grouped_by).toBe('question');
  });

  it('no inventa conflicto cuando los precedentes concuerdan', async () => {
    mockSearch.mockResolvedValueOnce([
      precedente({ id: 'q-1', answer: '6130 Servicios' }),
      precedente({ id: 'q-2', answer: '  6130   SERVICIOS ' }),
    ]);
    const salida = await correr('telmex');
    expect(salida.conflicts).toBeUndefined();
    expect(salida.conflict_note).toBeUndefined();
    expect(salida.count).toBe(2);
  });

  it('la descripción de la herramienta ya no manda desempatar por fecha a ciegas', () => {
    const desc = String(herramienta().description);
    expect(desc).toMatch(/EXCEPT when the result flags a conflict/);
    expect(desc).toMatch(/only a human resolves them/);
  });
});
