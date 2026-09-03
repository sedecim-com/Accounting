import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';

// ============================================================
// A5·1 — EL RECHAZO QUE NO ENSEÑABA, Y EL «CORREGIR-Y-APROBAR» QUE NO EXISTÍA.
//
// Tres defectos del MISMO bucle, `mnemosine review`, que vive inline en la
// hoja y por eso se conduce entera con `program.parseAsync`:
//
//  (a) `rejectDraft` escribía el motivo en ai_drafts.review_notes y ahí moría.
//      El digest que entra al prompt de cada sesión sale SÓLO de ai_questions,
//      así que catorce rechazos con motivo escrito no llegaban a ningún lado y
//      el contador rechazaba el mismo error catorce veces.
//  (b) Sólo se podía aprobar tal cual o vetar. Un revisor que arregla una
//      cuenta y aprueba está enseñando —el diff modelo-vs-humano ES el
//      criterio— y ese gesto no existía.
//  (c) El menú ofrecía «[s]kip», que es lo que un contador que trabaja en
//      español teclea creyendo que dice «sí», y cualquier otra tecla saltaba
//      el borrador SIN IMPRIMIR NADA.
//
// POR QUÉ SE CONDUCE EL BUCLE Y NO UNA FUNCIÓN SUELTA: el defecto vive en el
// bucle. Una prueba de `rejectionPrecedent` a solas seguiría verde con el
// bucle que nunca la llama, y una de `reviewMenuChoice` a solas seguiría verde
// con el bucle que ignora su veredicto. Aquí se ejecuta la hoja real con el
// readline doblado y se mira QUÉ SE LLAMÓ.
//
// La otra mitad —lo que el servicio hace con la corrección— se ejerce contra
// el módulo REAL (`vi.importActual`), no contra el doble que el bucle usa.
// ============================================================

const guion = vi.hoisted(() => ({
  respuestas: [] as Array<string | null>,
  prompts: [] as string[],
}));

/**
 * readline doblado. `ask()` (mnemosine.ts) registra `once('close')` ANTES de
 * llamar a `question`, así que agotar el guion se simula emitiendo 'close':
 * es exactamente lo que hace una stdin que se acaba, y el bucle debe leerlo
 * como EOF, nunca como una respuesta.
 */
vi.mock('node:readline/promises', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    createInterface: () => {
      const rl = new EventEmitter() as EventEmitter & {
        question: (p: string) => Promise<string>;
        close: () => void;
      };
      rl.question = (prompt: string) => {
        guion.prompts.push(prompt);
        if (guion.respuestas.length === 0) {
          rl.emit('close');
          return new Promise<string>(() => undefined); // ya se resolvió por 'close'
        }
        const next = guion.respuestas.shift();
        if (next === null) {
          rl.emit('close');
          return new Promise<string>(() => undefined);
        }
        return Promise.resolve(next as string);
      };
      rl.close = () => {
        rl.emit('close');
      };
      return rl;
    },
  };
});

vi.mock('../../src/database/connection.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    query: vi.fn(),
    withTransaction: vi.fn(),
    initDatabase: vi.fn(async () => ({ tunneled: false })),
    closeDatabase: vi.fn(async () => undefined),
  };
});

vi.mock('../../src/services/accounting/posting.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    createJournalEntry: vi.fn(),
    attestEntryAsync: vi.fn(),
    drainAttestations: vi.fn(async () => undefined),
  };
});

vi.mock('../../src/ai/context.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, resolveEntity: () => Promise.resolve(CTX) };
});

// El doble se pone en la FRONTERA del bucle: listDrafts/resolveReviewer para
// alimentarlo, approveDraft/rejectDraft para ver qué le entregó. Todo lo demás
// del módulo —canonicalDraftHash, diffDraftPayloads, rejectionPrecedent— corre
// REAL, que es lo que hace falsable la aserción sobre el hash: si el bucle
// mandara un hash distinto del canónico de lo que se aprobó, se vería.
vi.mock('../../src/ai/draft-service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    listDrafts: vi.fn(),
    resolveReviewer: vi.fn(),
    approveDraft: vi.fn(),
    rejectDraft: vi.fn(),
  };
});

vi.mock('../../src/ai/memory-service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, teachMemory: vi.fn() };
});

import { program } from '../../src/cli/mnemosine.js';
import {
  listDrafts,
  resolveReviewer,
  approveDraft,
  rejectDraft,
  canonicalDraftHash,
  diffDraftPayloads,
  rejectionPrecedent,
  type DraftRow,
  type DraftPayload,
  type DraftCorrection,
} from '../../src/ai/draft-service.js';
import { teachMemory } from '../../src/ai/memory-service.js';
import { query, withTransaction } from '../../src/database/connection.js';
import { createJournalEntry, attestEntryAsync } from '../../src/services/accounting/posting.js';
import type { AgentContext } from '../../src/ai/context.js';

const CTX: AgentContext = {
  entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  entityName: 'Acme MX',
  tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
  currency: 'MXN',
  country: 'MX',
  accountingStandard: 'mx_nif',
  taxId: 'AME010101AAA',
};

const REVISOR = { userId: 'uuuuuuuu-uuuu-uuuu-uuuu-uuuuuuuuuuuu', email: 'contador@despacho.mx' };

const mockListDrafts = listDrafts as unknown as Mock;
const mockResolveReviewer = resolveReviewer as unknown as Mock;
const mockApprove = approveDraft as unknown as Mock;
const mockReject = rejectDraft as unknown as Mock;
const mockTeach = teachMemory as unknown as Mock;

// Lecturas TIPADAS de lo que recibió cada doble. `mock.calls` es `any[][]`, y
// leerlo a pelo apaga el compilador justo en la línea donde se afirma la
// conducta: un cambio de firma dejaría la aserción compilando contra nada.
type LlamadaAprobacion = [
  AgentContext,
  string,
  { userId: string; email: string },
  string | undefined,
  string | undefined,
  DraftCorrection | undefined,
];
type LlamadaRechazo = [AgentContext, string, { userId: string; email: string }, string];
type LlamadaSiembra = [
  AgentContext,
  { rule: string; criterion: string; topic?: string; taughtBy: string },
];

const aprobacion = (i = 0): LlamadaAprobacion => mockApprove.mock.calls[i] as LlamadaAprobacion;
const rechazo = (i = 0): LlamadaRechazo => mockReject.mock.calls[i] as LlamadaRechazo;
const siembra = (i = 0): LlamadaSiembra => mockTeach.mock.calls[i] as LlamadaSiembra;

function borrador(n: number, over: Partial<DraftRow> = {}): DraftRow {
  const payload: DraftPayload = {
    entry_date: '2026-08-01',
    description: `Factura Telmex ${n}`,
    reference: `A-${n}`,
    lines: [
      { account_code: '5201', debit: 1160, description: 'Telefonia' },
      { account_code: '1101', credit: 1160 },
    ],
  };
  return {
    id: `draft-${n}`,
    entity_id: CTX.entityId,
    status: 'pending_review',
    payload,
    ai_confidence: '0.72',
    ai_reasoning: 'parece telefonia',
    ai_model: 'claude-opus-5',
    user_request: null,
    journal_entry_id: null,
    review_notes: null,
    reviewed_by: null,
    created_at: new Date('2026-08-01T00:00:00Z'),
    ...over,
  };
}

class SalidaSimulada extends Error {
  constructor(readonly codigo: number) {
    super(`shutdown(${codigo})`);
  }
}

/**
 * Ejecuta la HOJA REAL de `mnemosine review` con un guion de respuestas.
 * `shutdown()` acaba en `process.exit`, que en un worker de vitest mataría la
 * corrida entera: se dobla por una excepción que este arnés se traga.
 */
async function correrRevision(
  respuestas: Array<string | null>
): Promise<{ salida: string; prompts: string[] }> {
  guion.respuestas = [...respuestas];
  guion.prompts = [];
  const lineas: string[] = [];
  const recoge = (...a: unknown[]) => {
    lineas.push(a.map((x) => String(x)).join(' '));
  };
  const salida = vi.spyOn(process, 'exit').mockImplementation(((codigo?: number) => {
    throw new SalidaSimulada(codigo ?? 0);
  }) as never);
  const mudos = [
    vi.spyOn(console, 'log').mockImplementation(recoge),
    vi.spyOn(console, 'error').mockImplementation(recoge),
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => {
      recoge(s);
      return true;
    }) as never),
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => {
      recoge(s);
      return true;
    }) as never),
  ];
  try {
    await program.parseAsync(['node', 'mnemosine', 'review']);
  } catch (err) {
    if (!(err instanceof SalidaSimulada)) throw err;
  } finally {
    salida.mockRestore();
    for (const m of mudos) m.mockRestore();
  }
  return { salida: lineas.join('\n'), prompts: [...guion.prompts] };
}

/** Los prompts del menú, que es lo que se repregunta cuando no se entiende. */
const prompsDeMenu = (prompts: string[]) => prompts.filter((p) => p.includes('[a]pprove'));

beforeEach(() => {
  mockListDrafts.mockReset();
  mockResolveReviewer.mockReset().mockResolvedValue(REVISOR);
  mockApprove.mockReset().mockResolvedValue({ entryId: 'je-1', entryNumber: 'JE-2026-00001' });
  mockReject.mockReset().mockResolvedValue(undefined);
  mockTeach.mockReset().mockResolvedValue('mem-1');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// (a) EL RECHAZO QUE PODRÍA ENSEÑAR — Y QUE NO SIEMBRA SOLO.
// ============================================================

describe('un rechazo ofrece sembrar el precedente, y sólo el humano lo siembra', () => {
  it('con un sí explícito llama a teachMemory, atribuido al revisor y con el motivo como criterio', async () => {
    mockListDrafts.mockResolvedValue([borrador(1)]);

    const { salida, prompts } = await correrRevision(['r', 'Telmex va a 6130, no a 5201', 'si']);

    expect(mockReject).toHaveBeenCalledTimes(1);
    expect(rechazo()[3]).toBe('Telmex va a 6130, no a 5201');

    // LA SIEMBRA SE OFRECIÓ, y por el prompt que el humano vio.
    expect(prompts.some((p) => p.includes('Seed it as a firm criterion'))).toBe(true);

    // Y OCURRIÓ, por la vía humana que ya existía.
    expect(mockTeach).toHaveBeenCalledTimes(1);
    const [ctxUsado, entrada] = siembra();
    expect(ctxUsado).toBe(CTX);
    expect(entrada.taughtBy).toBe(REVISOR.email);
    expect(entrada.criterion).toBe('Telmex va a 6130, no a 5201');
    // La situación sale del borrador rechazado: sin ella el precedente sería
    // un criterio sin caso, y el digest imprimiría catorce líneas idénticas.
    expect(entrada.rule).toContain('Factura Telmex 1');
    expect(entrada.rule).toContain('5201');
    // Sin `topic`: buildMemoryDigest imprime `topic ?? question`, y un topic
    // común colapsaría todos estos precedentes a la misma línea.
    expect(entrada.topic).toBeUndefined();

    expect(salida).toContain('Criterion seeded by contador@despacho.mx');
  });

  it('un «no» deja el rechazo en pie y NO siembra nada', async () => {
    mockListDrafts.mockResolvedValue([borrador(1)]);

    const { salida } = await correrRevision(['r', 'no aplica', 'n']);

    expect(mockReject).toHaveBeenCalledTimes(1);
    expect(mockTeach).not.toHaveBeenCalled();
    expect(salida).toContain('Not seeded');
  });

  it('un EOF en la pregunta tampoco siembra: una stdin cerrada no consiente', async () => {
    mockListDrafts.mockResolvedValue([borrador(1)]);

    await correrRevision(['r', 'no aplica', null]);

    expect(mockReject).toHaveBeenCalledTimes(1);
    expect(mockTeach).not.toHaveBeenCalled();
  });

  it('una respuesta incomprendida repregunta y NO siembra si sigue sin entenderse', async () => {
    mockListDrafts.mockResolvedValue([borrador(1)]);

    const { prompts } = await correrRevision(['r', 'no aplica', 'quizas', 'tal vez']);

    expect(mockTeach).not.toHaveBeenCalled();
    // La repregunta existe y nombra lo que no entendió.
    expect(prompts.some((p) => p.includes('«quizas»'))).toBe(true);
  });

  it('si teachMemory falla, el rechazo sigue en pie y la cola continúa', async () => {
    mockListDrafts.mockResolvedValue([borrador(1), borrador(2)]);
    mockTeach.mockRejectedValueOnce(new Error('ai_questions no responde'));

    const { salida } = await correrRevision(['r', 'motivo', 'si', 'q']);

    expect(mockReject).toHaveBeenCalledTimes(1);
    expect(salida).toContain('the criterion was not seeded');
  });

  it('los CATORCE rechazos: la cola larga siembra catorce veces, una por rechazo', async () => {
    // El defecto del encargo dicho con su propio número. Una cola de 21 y
    // catorce rechazos seguidos: un bucle que sólo ofreciera la siembra en la
    // primera vuelta —o que perdiera la cuenta— se vería aquí y no con uno.
    mockListDrafts.mockResolvedValue(Array.from({ length: 21 }, (_, i) => borrador(i + 1)));

    const respuestas: string[] = [];
    for (let i = 1; i <= 14; i++) respuestas.push('r', `motivo ${i}`, 'si');
    respuestas.push('q');

    const { salida } = await correrRevision(respuestas);

    expect(mockReject).toHaveBeenCalledTimes(14);
    expect(mockTeach).toHaveBeenCalledTimes(14);
    // Cada precedente lleva SU motivo y SU borrador, no el del primero.
    expect(siembra(0)[1].criterion).toBe('motivo 1');
    expect(siembra(13)[1].criterion).toBe('motivo 14');
    expect(siembra(13)[1].rule).toContain('Factura Telmex 14');
    expect(rechazo(13)[1]).toBe('draft-14');
    expect(salida).toContain('14 rejected, 14 criteria seeded.');
  });

  it('el precedente que se propone es el que se siembra: lo que se imprime y lo que viaja coinciden', async () => {
    const d = borrador(7);
    mockListDrafts.mockResolvedValue([d]);

    const { salida } = await correrRevision(['r', 'va a 6130', 'si']);

    const esperado = rejectionPrecedent(d, 'va a 6130');
    expect(salida).toContain(esperado.rule);
    expect(siembra()[1].rule).toBe(esperado.rule);
  });
});

// ============================================================
// (c) LA MNEMOTECNIA: «s» YA NO DECIDE, Y NADA SE SALTA EN SILENCIO.
// ============================================================

describe('el menú no interpreta un «sí» ni decide por una tecla que no entendió', () => {
  it('«s» —que en español es «sí» y en inglés «skip»— repregunta el MISMO borrador', async () => {
    mockListDrafts.mockResolvedValue([borrador(1)]);

    const { salida, prompts } = await correrRevision(['s', 'a']);

    // Repreguntó: dos veces el menú para UN solo borrador.
    expect(prompsDeMenu(prompts)).toHaveLength(2);
    expect(salida).toContain('«s» is a yes');
    // Y la repregunta no es decorativa: la respuesta siguiente SÍ se honró
    // sobre ese mismo borrador.
    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(aprobacion()[1]).toBe('draft-1');
  });

  for (const dicho of ['si', 'sí', 'y', 'yes', 'S']) {
    it(`«${dicho}» tampoco aprueba ni salta: ni postea ni rechaza`, async () => {
      mockListDrafts.mockResolvedValue([borrador(1)]);

      await correrRevision([dicho, 'q']);

      expect(mockApprove).not.toHaveBeenCalled();
      expect(mockReject).not.toHaveBeenCalled();
    });
  }

  it('dos respuestas sin sentido no deciden: lo DICEN y pasan al siguiente borrador', async () => {
    mockListDrafts.mockResolvedValue([borrador(1), borrador(2)]);

    const { salida, prompts } = await correrRevision(['fjdk', 'lolo', 'a']);

    expect(salida).toContain('Nothing was done to this draft');
    // Dos menús para el primero + uno para el segundo.
    expect(prompsDeMenu(prompts)).toHaveLength(3);
    // Y el que se aprobó es el SEGUNDO: el primero quedó intacto.
    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(aprobacion()[1]).toBe('draft-2');
  });

  it('ENTER pasa al siguiente y lo dice; antes se saltaba sin imprimir nada', async () => {
    mockListDrafts.mockResolvedValue([borrador(1), borrador(2)]);

    const { salida } = await correrRevision(['', 'r', 'motivo', 'n']);

    expect(salida).toContain('Skipped: the draft stays pending.');
    expect(mockApprove).not.toHaveBeenCalled();
    expect(rechazo()[1]).toBe('draft-2');
  });

  it('«salir» sale de la cola, y «q» también', async () => {
    mockListDrafts.mockResolvedValue([borrador(1), borrador(2), borrador(3)]);

    await correrRevision(['salir']);
    expect(mockApprove).not.toHaveBeenCalled();

    mockApprove.mockClear();
    await correrRevision(['q']);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('la cola entera se recorre: tres borradores, tres decisiones distintas', async () => {
    mockListDrafts.mockResolvedValue([borrador(1), borrador(2), borrador(3)]);

    const { salida } = await correrRevision(['a', '', 'r', 'no aplica', 'n']);

    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(aprobacion()[1]).toBe('draft-1');
    expect(mockReject).toHaveBeenCalledTimes(1);
    expect(rechazo()[1]).toBe('draft-3');
    expect(salida).toContain('1 approved (0 corrected first), 1 rejected, 0 criteria seeded.');
  });
});

// ============================================================
// (b) CORREGIR-Y-APROBAR, Y EL HASH QUE NO PUEDE MENTIR.
// ============================================================

describe('corregir-y-aprobar: el diff viaja y el hash se ata a lo que el humano vio', () => {
  it('editar una cuenta y aprobar entrega la corrección, con el hash del borrador ORIGINAL como base', async () => {
    const d = borrador(1);
    mockListDrafts.mockResolvedValue([d]);

    // e → línea 1 → cuenta 6130 → importe igual → fin → sí.
    const { salida } = await correrRevision(['e', '1', '6130', '', '', 'y']);

    expect(mockApprove).toHaveBeenCalledTimes(1);
    const [, id, revisor, notas, expectedHash, correccion] = aprobacion();
    expect(id).toBe('draft-1');
    expect(revisor).toEqual(REVISOR);
    expect(notas).toBeUndefined();

    // El hash es el CANÓNICO de lo que el revisor vio, calculado con la
    // función real: la deriva se sigue detectando igual que sin editar.
    expect(expectedHash).toBe(canonicalDraftHash(d.payload));
    expect(correccion?.basedOnHash).toBe(canonicalDraftHash(d.payload));

    // Y lo que se aprueba es la versión del humano.
    expect(correccion?.payload.lines[0].account_code).toBe('6130');
    expect(correccion?.payload.lines[1].account_code).toBe('1101');
    expect(correccion?.payload.lines[0].debit).toBe(1160);
    // El borrador de la cola NO se tocó: es la evidencia de lo que propuso
    // el modelo, y de ahí sale el diff.
    expect(d.payload.lines[0].account_code).toBe('5201');

    expect(salida).toContain('line 1 account_code: "5201" → "6130"');
    expect(salida).toContain('1 approved (1 corrected first)');
  });

  it('el importe también se corrige, y el diff lo nombra', async () => {
    const d = borrador(1);
    mockListDrafts.mockResolvedValue([d]);

    const { salida } = await correrRevision(['e', '1', '', '2320', '2', '', '2320', '', 'y']);

    const correccion = aprobacion()[5];
    expect(correccion?.payload.lines[0].debit).toBe(2320);
    expect(correccion?.payload.lines[1].credit).toBe(2320);
    expect(salida).toContain('line 1 debit: 1160.00 → 2320.00');
    expect(salida).toContain('line 2 credit: 1160.00 → 2320.00');
  });

  it('un importe que no es un importe no se inventa: se dice y se conserva el que había', async () => {
    mockListDrafts.mockResolvedValue([borrador(1)]);

    const { salida } = await correrRevision(['e', '1', '', 'mil pesos', '', 'y']);

    expect(salida).toContain('is not a positive amount');
    // Nada cambió → no hay corrección que entregar.
    expect(aprobacion()[5]).toBeUndefined();
  });

  it('editar y no cambiar nada aprueba SIN corrección: no se registra un diff vacío', async () => {
    mockListDrafts.mockResolvedValue([borrador(1)]);

    const { salida } = await correrRevision(['e', '', 'y']);

    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(aprobacion()[5]).toBeUndefined();
    expect(salida).toContain('Nothing changed');
    expect(salida).toContain('1 approved (0 corrected first)');
  });

  it('corregir NO aprueba: un «no» en la confirmación descarta la edición y deja el borrador pendiente', async () => {
    mockListDrafts.mockResolvedValue([borrador(1)]);

    const { salida } = await correrRevision(['e', '1', '6130', '', '', 'n']);

    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockReject).not.toHaveBeenCalled();
    expect(salida).toContain('the correction is discarded and the draft stays pending');
  });

  it('un EOF a media corrección ni aprueba ni llega a PREGUNTAR si aprueba', async () => {
    // «No aprobó» a secas no probaba nada: con la stdin cerrada, el «[y/N]»
    // ya contesta que no por su cuenta (esNegativa(null)). Lo que sostiene la
    // garantía es que la corrección abandonada NO LLEGA a la pregunta —
    // preguntarle a una terminal muerta si postea al mayor es la forma de que
    // el día que `ask` devuelva '' en vez de null, eso se lea como un sí.
    mockListDrafts.mockResolvedValue([borrador(1), borrador(2)]);

    const { prompts } = await correrRevision(['e', '1', null]);

    expect(mockApprove).not.toHaveBeenCalled();
    expect(prompts.filter((p) => p.includes('Approve and post THIS version'))).toHaveLength(0);
    // Y la cola se detiene ahí: el segundo borrador ni se muestra.
    expect(prompsDeMenu(prompts)).toHaveLength(1);
  });

  it('la descripción también se corrige por su propia tecla', async () => {
    mockListDrafts.mockResolvedValue([borrador(1)]);

    const { salida } = await correrRevision(['e', 'd', 'Telefonia fija agosto', '', 'y']);

    expect(aprobacion()[5]?.payload.description).toBe('Telefonia fija agosto');
    expect(salida).toContain('description: "Factura Telmex 1" → "Telefonia fija agosto"');
  });

  it('un número de línea que no existe repregunta en vez de tocar otra línea', async () => {
    mockListDrafts.mockResolvedValue([borrador(1)]);

    const { salida } = await correrRevision(['e', '9', '', 'y']);

    expect(salida).toContain('I did not understand «9»');
    expect(aprobacion()[5]).toBeUndefined();
  });
});

// ============================================================
// EL SERVICIO REAL: qué hace approveDraft con una corrección.
//
// El bucle de arriba dobla approveDraft para VER qué le entrega. Aquí se
// ejerce el módulo de verdad (`vi.importActual`), porque la promesa que
// importa —el hash grabado es el de lo que el humano aprobó, no el de lo que
// propuso el modelo— vive dentro de la transacción, no en la hoja.
// ============================================================

type ServicioReal = typeof import('../../src/ai/draft-service.js');

const mockQuery = query as unknown as Mock;
const mockWithTransaction = withTransaction as unknown as Mock;
const mockCreateJE = createJournalEntry as unknown as Mock;
const mockAttest = attestEntryAsync as unknown as Mock;

describe('approveDraft con corrección: el hash grabado es el de lo que el humano aprobó', () => {
  const clientQuery = vi.fn();
  const client = { query: clientQuery };

  /** [entryId, reviewedBy, reviewNotes, approvedContentHash, draftId, entityId] */
  type ParamsUpdate = [string, string, string | null, string, string, string];
  const paramsDelUpdate = (): ParamsUpdate =>
    (clientQuery.mock.calls[1] as [string, ParamsUpdate])[1];

  type LineaPosteada = { account_id: string; debit_amount: string | null; credit_amount: string | null };
  const lineasPosteadas = (): LineaPosteada[] =>
    (mockCreateJE.mock.calls[0] as unknown[])[4] as LineaPosteada[];

  const PROPUESTO: DraftPayload = {
    entry_date: '2026-08-01',
    description: 'Factura Telmex',
    lines: [
      { account_code: '5201', debit: 1160 },
      { account_code: '1101', credit: 1160 },
    ],
  };
  const CORREGIDO: DraftPayload = {
    ...PROPUESTO,
    lines: [
      { account_code: '6130', debit: 1160 },
      { account_code: '1101', credit: 1160 },
    ],
  };
  const CUENTAS = {
    rows: [
      { id: 'acc-6130', code: '6130', is_active: true, is_header: false, allow_manual_entries: true },
      { id: 'acc-1101', code: '1101', is_active: true, is_header: false, allow_manual_entries: true },
    ],
  };

  let real: ServicioReal;

  beforeEach(async () => {
    real = await vi.importActual<ServicioReal>('../../src/ai/draft-service.js');
    mockQuery.mockReset();
    clientQuery.mockReset();
    mockCreateJE.mockReset();
    mockAttest.mockReset();
    mockWithTransaction
      .mockReset()
      .mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => fn(client));
  });

  const prepararFilaBloqueada = (payload: DraftPayload = PROPUESTO) => {
    clientQuery.mockResolvedValueOnce({
      rows: [{ id: 'draft-1', entity_id: CTX.entityId, status: 'pending_review', payload }],
    });
  };

  it('postea la versión del humano, graba SU hash y deja el diff en review_notes', async () => {
    prepararFilaBloqueada();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'fp-1' }] }); // periodo abierto
    mockQuery.mockResolvedValueOnce(CUENTAS);
    mockCreateJE.mockResolvedValueOnce({ id: 'je-9', entry_number: 'JE-2026-00099' });
    clientQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await real.approveDraft(CTX, 'draft-1', REVISOR, undefined, real.canonicalDraftHash(PROPUESTO), {
      payload: CORREGIDO,
      basedOnHash: real.canonicalDraftHash(PROPUESTO),
    });

    // Lo POSTEADO es la cuenta del humano.
    expect(lineasPosteadas()[0].account_id).toBe('acc-6130');

    const [, , notas, hashGrabado] = paramsDelUpdate();
    // EL HASH ES EL DE LO QUE EL HUMANO APROBÓ. Si aquí quedara el del
    // modelo, la columna juraría que consintió lo que él mismo tachó.
    expect(hashGrabado).toBe(real.canonicalDraftHash(CORREGIDO));
    expect(hashGrabado).not.toBe(real.canonicalDraftHash(PROPUESTO));
    // Y el diff queda escrito POR CONSTRUCCIÓN, con quién corrigió.
    expect(notas).toContain('corrected by contador@despacho.mx');
    expect(notas).toContain('line 1 account_code: "5201" → "6130"');
  });

  it('una corrección apoyada en OTRA versión se invalida: nada se postea', async () => {
    prepararFilaBloqueada();

    await expect(
      real.approveDraft(CTX, 'draft-1', REVISOR, undefined, undefined, {
        payload: CORREGIDO,
        basedOnHash: real.canonicalDraftHash(CORREGIDO), // no es lo que hay en la fila
      })
    ).rejects.toThrow(/based on another version/);

    expect(mockCreateJE).not.toHaveBeenCalled();
  });

  it('una corrección que no cambia nada se rechaza: no se registra una corrección vacía', async () => {
    prepararFilaBloqueada();

    await expect(
      real.approveDraft(CTX, 'draft-1', REVISOR, undefined, undefined, {
        payload: { ...PROPUESTO, lines: PROPUESTO.lines.map((l) => ({ ...l })) },
        basedOnHash: real.canonicalDraftHash(PROPUESTO),
      })
    ).rejects.toThrow(/changes nothing/);

    expect(mockCreateJE).not.toHaveBeenCalled();
  });

  it('la corrección pasa por el MISMO colador: una que no cuadra no postea', async () => {
    prepararFilaBloqueada();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'fp-1' }] });
    mockQuery.mockResolvedValueOnce(CUENTAS);

    await expect(
      real.approveDraft(CTX, 'draft-1', REVISOR, undefined, undefined, {
        payload: {
          ...PROPUESTO,
          lines: [
            { account_code: '6130', debit: 2320 },
            { account_code: '1101', credit: 1160 },
          ],
        },
        basedOnHash: real.canonicalDraftHash(PROPUESTO),
      })
    ).rejects.toBeInstanceOf(real.DraftValidationError);

    expect(mockCreateJE).not.toHaveBeenCalled();
  });

  it('sin corrección el camino es el de antes: mismo hash, mismas notas', async () => {
    prepararFilaBloqueada();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'fp-1' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'acc-5201', code: '5201', is_active: true, is_header: false, allow_manual_entries: true },
        { id: 'acc-1101', code: '1101', is_active: true, is_header: false, allow_manual_entries: true },
      ],
    });
    mockCreateJE.mockResolvedValueOnce({ id: 'je-9', entry_number: 'JE-2026-00099' });
    clientQuery.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await real.approveDraft(CTX, 'draft-1', REVISOR, 'ok');

    const params = paramsDelUpdate();
    expect(params[2]).toBe('ok');
    expect(params[3]).toBe(real.canonicalDraftHash(PROPUESTO));
  });
});

// ============================================================
// LA EQUIVALENCIA QUE SOSTIENE LAS DOS ANTERIORES.
//
// «esta corrección no cambia nada» y «el contenido no cambió» tienen que ser
// la MISMA verdad. Si el diff normalizara de más —recortando espacios, por
// ejemplo— habría correcciones que cambian el hash y no aparecen en ninguna
// nota: el registro del cambio se perdería en silencio.
// ============================================================

describe('diff vacío ⟺ mismo hash canónico', () => {
  const BASE: DraftPayload = {
    entry_date: '2026-08-01',
    description: 'Factura Telmex',
    reference: 'A-1',
    lines: [
      { account_code: '5201', debit: 1160, description: 'Telefonia' },
      { account_code: '1101', credit: 1160 },
    ],
  };

  const variantes: Array<{ nombre: string; payload: DraftPayload; cambia: boolean }> = [
    { nombre: 'idéntico', payload: { ...BASE, lines: BASE.lines.map((l) => ({ ...l })) }, cambia: false },
    {
      nombre: 'el mismo importe con otra forma (1160 vs 1160.00)',
      payload: { ...BASE, lines: [{ ...BASE.lines[0], debit: 1160.0 }, { ...BASE.lines[1] }] },
      cambia: false,
    },
    {
      nombre: 'un espacio al final de la descripción',
      payload: { ...BASE, description: 'Factura Telmex ', lines: BASE.lines.map((l) => ({ ...l })) },
      cambia: true,
    },
    {
      nombre: 'otra cuenta',
      payload: { ...BASE, lines: [{ ...BASE.lines[0], account_code: '6130' }, { ...BASE.lines[1] }] },
      cambia: true,
    },
    {
      nombre: 'un céntimo de más',
      payload: { ...BASE, lines: [{ ...BASE.lines[0], debit: 1160.01 }, { ...BASE.lines[1] }] },
      cambia: true,
    },
    {
      nombre: 'otra fecha',
      payload: { ...BASE, entry_date: '2026-08-02', lines: BASE.lines.map((l) => ({ ...l })) },
      cambia: true,
    },
    {
      nombre: 'la referencia borrada',
      payload: { entry_date: BASE.entry_date, description: BASE.description, lines: BASE.lines.map((l) => ({ ...l })) },
      cambia: true,
    },
    {
      nombre: 'una línea de más',
      payload: { ...BASE, lines: [...BASE.lines.map((l) => ({ ...l })), { account_code: '2101', credit: 1 }] },
      cambia: true,
    },
    {
      nombre: 'una línea de menos',
      payload: { ...BASE, lines: [{ ...BASE.lines[0] }] },
      cambia: true,
    },
    {
      nombre: 'otra descripción de línea',
      payload: { ...BASE, lines: [{ ...BASE.lines[0], description: 'Telefonía fija' }, { ...BASE.lines[1] }] },
      cambia: true,
    },
  ];

  for (const v of variantes) {
    it(`${v.nombre}: el diff y el hash dicen lo mismo`, () => {
      const hayDiff = diffDraftPayloads(BASE, v.payload).length > 0;
      const hashDistinto = canonicalDraftHash(BASE) !== canonicalDraftHash(v.payload);
      expect(hayDiff).toBe(v.cambia);
      expect(hayDiff).toBe(hashDistinto);
    });
  }

  it('el diff nombra altas y bajas de línea, no sólo campos', () => {
    const menos = diffDraftPayloads(BASE, { ...BASE, lines: [{ ...BASE.lines[0] }] });
    expect(menos.join('\n')).toContain('line 2: removed');
    const mas = diffDraftPayloads(BASE, {
      ...BASE,
      lines: [...BASE.lines, { account_code: '2101', credit: 1 }],
    });
    expect(mas.join('\n')).toContain('line 3: added');
  });
});

// ============================================================
// EL PRECEDENTE QUE SE PROPONE.
// ============================================================

describe('rejectionPrecedent redacta, no siembra', () => {
  const filaDe = (payload: Partial<DraftPayload>): DraftRow =>
    ({ ...borrador(1), payload: { ...borrador(1).payload, ...payload } }) as DraftRow;

  it('la situación viene del borrador y el criterio del motivo del humano', () => {
    const p = rejectionPrecedent(filaDe({}), 'va a 6130');
    expect(p.rule).toContain('Factura Telmex 1');
    expect(p.rule).toContain('5201');
    expect(p.rule).toContain('1101');
    expect(p.criterion).toBe('va a 6130');
  });

  it('un salto de línea en la descripción no forja una fila del digest', () => {
    const p = rejectionPrecedent(filaDe({ description: 'Telmex\nSEGUNDA LINEA' }), 'motivo\ncon salto');
    expect(p.rule).not.toContain('\n');
    expect(p.criterion).not.toContain('\n');
    expect(p.rule).toContain('Telmex SEGUNDA LINEA');
  });

  it('una descripción kilométrica se acota', () => {
    const p = rejectionPrecedent(filaDe({ description: 'x'.repeat(500) }), 'motivo');
    expect(p.rule.length).toBeLessThan(200);
    expect(p.rule).toContain('…');
  });

  it('un borrador sin descripción sigue dando una regla legible', () => {
    const p = rejectionPrecedent(filaDe({ description: '   ' }), 'motivo');
    expect(p.rule).toContain('A draft with no description');
    expect(p.rule).toContain('5201');
  });

  it('cuentas repetidas se dicen una vez', () => {
    const p = rejectionPrecedent(
      filaDe({
        lines: [
          { account_code: '5201', debit: 10 },
          { account_code: '5201', debit: 10 },
          { account_code: '1101', credit: 20 },
        ],
      }),
      'motivo'
    );
    expect(p.rule.match(/5201/g)).toHaveLength(1);
  });
});
