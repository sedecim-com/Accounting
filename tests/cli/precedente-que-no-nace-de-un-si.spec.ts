import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Interface } from 'node:readline/promises';

// ============================================================
// D1 — TECLEAR «si» EN LA COLA DE PREGUNTAS PLANTABA UN PRECEDENTE FIRME.
//
// `mnemosine question answer` ofrecía «[answer / option number / s=skip /
// d=dismiss / q=quit]» y lo NO reconocido no repreguntaba: se tomaba como LA
// RESPUESTA. Y una respuesta ahí no es una respuesta cualquiera —
// answerQuestion la graba con is_precedent = true y el digest la mete en el
// prompt de todas las sesiones siguientes. El contador que tecleaba «si»
// creyendo que consentía sembraba un precedente FIRME cuyo criterio era la
// palabra «si».
//
// LAS DOS MITADES QUE ESTE ARCHIVO ATA, porque cada una sola es un guardián
// ciego:
//   · el BUCLE embarcado (se conduce `program.parseAsync`, no una copia) —
//     qué se le entrega a answerQuestion, y sobre todo CUÁNDO no se le
//     entrega nada;
//   · el SERVICIO real (`vi.importActual`) — que esos cuatro argumentos son
//     exactamente los que acaban en `is_precedent = true`. Sin esta mitad,
//     «no llamó a answerQuestion» sería una aserción sobre un doble y nadie
//     probaría por qué importa.
//
// Y las TRES bocas por las que se siembra memoria firme desde este archivo se
// ejercen con la misma palabra: la cola interactiva, `question answer <id>
// <texto>` y el canal de chat (makeAskUser). Arreglar una y dejar dos es
// exactamente la clase a medias que este encargo vino a cerrar.
// ============================================================

const guion = vi.hoisted(() => ({
  respuestas: [] as Array<string | null>,
  prompts: [] as string[],
}));

/**
 * readline doblado. `ask()` (mnemosine.ts) registra `once('close')` ANTES de
 * llamar a `question`, así que agotar el guion se simula emitiendo 'close':
 * es lo que hace una stdin que se acaba, y el bucle debe leerlo como EOF y
 * nunca como una respuesta.
 */
function readlineDoblado(): EventEmitter & {
  question: (p: string) => Promise<string>;
  close: () => void;
} {
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
}

vi.mock('node:readline/promises', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, createInterface: () => readlineDoblado() };
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

// Los dobles van en la FRONTERA del bucle: listQuestions para alimentarlo,
// answerQuestion/dismissQuestion para ver qué se les entregó. El resto del
// módulo corre real, y la ruta que importa —cómo answerQuestion convierte sus
// cuatro argumentos en is_precedent = true— se ejerce contra el módulo REAL
// más abajo, no contra este doble.
vi.mock('../../src/ai/question-service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    listQuestions: vi.fn(),
    answerQuestion: vi.fn(),
    dismissQuestion: vi.fn(),
  };
});

vi.mock('../../src/ai/draft-service.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real, resolveReviewer: vi.fn() };
});

import { program, makeAskUser } from '../../src/cli/mnemosine.js';
import {
  listQuestions,
  answerQuestion,
  dismissQuestion,
  type QuestionRow,
} from '../../src/ai/question-service.js';
import { resolveReviewer } from '../../src/ai/draft-service.js';
import { query } from '../../src/database/connection.js';
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

const mockList = listQuestions as unknown as Mock;
const mockAnswer = answerQuestion as unknown as Mock;
const mockDismiss = dismissQuestion as unknown as Mock;
const mockReviewer = resolveReviewer as unknown as Mock;
const mockQuery = query as unknown as Mock;

// Lecturas TIPADAS de lo que recibió el doble: `mock.calls` es `any[][]`, y
// leerlo a pelo apagaría el compilador justo en la línea que afirma la
// conducta. La firma es la del servicio: (ctx, id, answer, quién) — el quinto
// argumento, isPrecedent, NO se pasa desde el CLI, y ése es el punto.
type LlamadaRespuesta = [AgentContext, string, string, string];
const respuesta = (i = 0): LlamadaRespuesta => mockAnswer.mock.calls[i] as LlamadaRespuesta;

function pregunta(n: number, over: Partial<QuestionRow> = {}): QuestionRow {
  return {
    id: `q-${n}`,
    entity_id: CTX.entityId,
    status: 'pending',
    question: `¿A qué cuenta va la factura ${n} de Telmex?`,
    context: 'Factura A-1160, IVA 16%',
    options: null,
    topic: `clasificacion:Telmex-${n}`,
    answer: null,
    answered_by: null,
    answered_at: null,
    is_precedent: false,
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
 * Ejecuta la HOJA REAL con un guion de respuestas. `shutdown()` acaba en
 * `process.exit`, que en un worker de vitest mataría la corrida entera: se
 * dobla por una excepción que este arnés se traga.
 */
async function correr(
  argv: string[],
  respuestas: Array<string | null> = []
): Promise<{ salida: string; prompts: string[]; codigo: number | null }> {
  guion.respuestas = [...respuestas];
  guion.prompts = [];
  const lineas: string[] = [];
  let codigo: number | null = null;
  const recoge = (...a: unknown[]) => {
    lineas.push(a.map((x) => String(x)).join(' '));
  };
  const salida = vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    codigo = c ?? 0;
    throw new SalidaSimulada(codigo);
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
    await program.parseAsync(['node', 'mnemosine', ...argv]);
  } catch (err) {
    if (!(err instanceof SalidaSimulada)) throw err;
  } finally {
    salida.mockRestore();
    for (const m of mudos) m.mockRestore();
  }
  return { salida: lineas.join('\n'), prompts: [...guion.prompts], codigo };
}

const cola = (respuestas: Array<string | null>) => correr(['question', 'answer'], respuestas);

/** Los prompts del menú: lo que se repregunta cuando no se pudo leer. */
const prompsDeMenu = (prompts: string[]) => prompts.filter((p) => p.includes('[answer / option number'));

beforeEach(() => {
  mockList.mockReset().mockResolvedValue([pregunta(1)]);
  mockAnswer.mockReset().mockResolvedValue(undefined);
  mockDismiss.mockReset().mockResolvedValue(undefined);
  mockReviewer.mockReset().mockResolvedValue(REVISOR);
  mockQuery.mockReset().mockResolvedValue({ rowCount: 1, rows: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================
// POR QUÉ IMPORTA: la otra mitad de la costura, contra el módulo REAL.
// ============================================================

describe('lo que el bucle graba es memoria FIRME', () => {
  it('answerQuestion con cuatro argumentos escribe is_precedent = true', async () => {
    const real = await vi.importActual<typeof import('../../src/ai/question-service.js')>(
      '../../src/ai/question-service.js'
    );
    mockQuery.mockResolvedValue({ rowCount: 1, rows: [] });

    // Los MISMOS cuatro argumentos que pasa el CLI: sin quinto.
    await real.answerQuestion(CTX, 'q-1', 'Va a 6130', REVISOR.email);

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('is_precedent = $3');
    expect(params[2]).toBe(true);
    expect(params[0]).toBe('Va a 6130');
  });
});

// ============================================================
// EL DEFECTO DEL ENCARGO: «si» ya no se convierte en criterio.
// ============================================================

describe('una palabra de consentimiento no puede ser el criterio de un precedente', () => {
  for (const dicho of ['si', 'sí', 'SI', 'Sí', 's', 'S', 'y', 'yes', 'n', 'no', 'NO']) {
    it(`«${dicho}» no se graba: se repregunta y la pregunta queda pendiente`, async () => {
      const { salida, prompts } = await cola([dicho, 'q']);

      expect(mockAnswer).not.toHaveBeenCalled();
      expect(mockDismiss).not.toHaveBeenCalled();
      // La repregunta existe y nombra lo que no pudo leer.
      expect(prompsDeMenu(prompts).length).toBeGreaterThanOrEqual(2);
      expect(salida).toContain(`«${dicho}» is a bare yes/no`);
    });
  }

  it('la repregunta no es decorativa: el criterio en palabras SÍ se graba, sobre esa misma pregunta', async () => {
    const { salida } = await cola(['si', 'sí, se deduce al 100% por ser gasolina de reparto']);

    expect(mockAnswer).toHaveBeenCalledTimes(1);
    const [ctxUsado, id, answer, quien] = respuesta();
    expect(ctxUsado).toBe(CTX);
    expect(id).toBe('q-1');
    expect(answer).toBe('sí, se deduce al 100% por ser gasolina de reparto');
    expect(quien).toBe(REVISOR.email);
    expect(salida).toContain('Answered and saved as a precedent');
  });

  it('INSISTIR no es consentir: «si» dos veces no siembra nada y la pregunta sigue pendiente', async () => {
    const { salida } = await cola(['si', 'si']);

    expect(mockAnswer).not.toHaveBeenCalled();
    expect(mockDismiss).not.toHaveBeenCalled();
    expect(salida).toContain('Nothing recorded');
    expect(salida).toContain('the question stays pending');
  });

  it('el aviso enseña las dos salidas cuando la pregunta trae opciones', async () => {
    mockList.mockResolvedValue([pregunta(1, { options: ['6130 Teléfonos', '5201 Servicios'] })]);

    const { salida } = await cola(['si', 'q']);

    expect(salida).toContain('an option number (1-2)');
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('un EOF a la primera no graba nada: una stdin cerrada no contesta', async () => {
    const { prompts } = await cola([null]);

    expect(mockAnswer).not.toHaveBeenCalled();
    expect(prompsDeMenu(prompts)).toHaveLength(1);
  });

  it('un EOF en la REPREGUNTA tampoco: se corta la cola sin escribir', async () => {
    mockList.mockResolvedValue([pregunta(1), pregunta(2)]);

    await cola(['si', null]);

    expect(mockAnswer).not.toHaveBeenCalled();
  });
});

// ============================================================
// LO QUE NO SE PUEDE ROMPER: aquí el TEXTO LIBRE es la respuesta legítima.
// ============================================================

describe('el texto libre sigue siendo la respuesta, que es para lo que existe el comando', () => {
  it('graba el texto tal cual, sin tocarlo', async () => {
    await cola(['Va a 6130 Teléfonos: es servicio, no equipo']);

    expect(respuesta()[2]).toBe('Va a 6130 Teléfonos: es servicio, no equipo');
  });

  it('un número dentro del rango graba el TEXTO de la opción, no el número', async () => {
    mockList.mockResolvedValue([pregunta(1, { options: ['6130 Teléfonos', '5201 Servicios'] })]);

    await cola(['2']);

    expect(respuesta()[2]).toBe('5201 Servicios');
  });

  it('sin opciones, un número es texto libre: una cuenta se graba como se tecleó', async () => {
    await cola(['5201']);

    expect(respuesta()[2]).toBe('5201');
  });

  it('una respuesta que EMPIEZA por sí no es un sí desnudo: se graba entera', async () => {
    await cola(['sí pero sólo la parte del servicio, el equipo capitaliza']);

    expect(respuesta()[2]).toBe('sí pero sólo la parte del servicio, el equipo capitaliza');
  });

  it('ENTER salta y lo DICE; la pregunta queda pendiente', async () => {
    const { salida } = await cola(['', 'q']);

    expect(mockAnswer).not.toHaveBeenCalled();
    expect(salida).toContain('Skipped: the question stays pending.');
  });

  it('«d» descarta y «q» corta la cola', async () => {
    mockList.mockResolvedValue([pregunta(1), pregunta(2), pregunta(3)]);

    const { salida } = await cola(['d', 'q']);

    expect(mockDismiss).toHaveBeenCalledTimes(1);
    expect((mockDismiss.mock.calls[0] as unknown[])[1]).toBe('q-1');
    expect(mockAnswer).not.toHaveBeenCalled();
    expect(salida).toContain('1 dismissed');
  });
});

// ============================================================
// EL NÚMERO FUERA DE RANGO: tiene contenido, así que se pregunta, no se veta.
// ============================================================

describe('un número que no nombra ninguna opción se repregunta antes de grabarse', () => {
  const conOpciones = () =>
    mockList.mockResolvedValue([
      pregunta(1, { options: ['6130 Teléfonos', '5201 Servicios', '1101 Bancos'] }),
    ]);

  it('«5» con tres opciones no entra a la primera: nombra el rango y espera', async () => {
    conOpciones();

    const { salida } = await cola(['5', 'q']);

    expect(mockAnswer).not.toHaveBeenCalled();
    expect(salida).toContain('There is no option «5»');
    expect(salida).toContain('1-3');
  });

  it('repetirlo tras el aviso es una confirmación informada: se graba literal', async () => {
    conOpciones();

    await cola(['5201', '5201']);

    expect(mockAnswer).toHaveBeenCalledTimes(1);
    expect(respuesta()[2]).toBe('5201');
  });

  it('corregir al índice bueno graba la opción, no el número que se avisó', async () => {
    conOpciones();

    await cola(['5', '2']);

    expect(respuesta()[2]).toBe('5201 Servicios');
  });

  it('la puerta del «repetir» NO la cruza un sí: insistir en «si» sigue sin grabar', async () => {
    conOpciones();

    await cola(['si', 'si']);

    expect(mockAnswer).not.toHaveBeenCalled();
  });
});

// ============================================================
// LA COLA LARGA: veintiuna preguntas, no una.
// ============================================================

describe('la cola entera, con dedazos intercalados', () => {
  it('veintiuna preguntas: catorce respuestas de verdad, y los «si» no ensucian ninguna', async () => {
    mockList.mockResolvedValue(Array.from({ length: 21 }, (_, i) => pregunta(i + 1)));

    const respuestas: string[] = [];
    for (let i = 1; i <= 14; i++) {
      // En cada pregunta se teclea primero «si» —el gesto del encargo— y
      // luego el criterio de verdad. Si el aviso no repreguntara SOBRE LA
      // MISMA pregunta, los criterios se correrían de fila y se vería aquí.
      respuestas.push('si', `criterio ${i}`);
    }
    respuestas.push('q');

    const { salida } = await cola(respuestas);

    expect(mockAnswer).toHaveBeenCalledTimes(14);
    expect(respuesta(0)[1]).toBe('q-1');
    expect(respuesta(0)[2]).toBe('criterio 1');
    expect(respuesta(13)[1]).toBe('q-14');
    expect(respuesta(13)[2]).toBe('criterio 14');
    expect(salida).toContain('14 answered, 0 dismissed');
  });

  it('una cola de «si» a secas no graba NADA y las veintiuna siguen pendientes', async () => {
    mockList.mockResolvedValue(Array.from({ length: 21 }, (_, i) => pregunta(i + 1)));

    const { salida } = await cola(Array.from({ length: 42 }, () => 'si'));

    expect(mockAnswer).not.toHaveBeenCalled();
    expect(salida).toContain('0 answered, 0 dismissed');
  });
});

// ============================================================
// LA MISMA REGLA POR LA OTRA BOCA: `question answer <id> <texto>`.
// ============================================================

describe('la ruta por argumento siembra el mismo precedente, y se guarda igual', () => {
  const conPendiente = (over: Partial<QuestionRow> = {}) =>
    mockList.mockResolvedValue([pregunta(1, over)]);

  for (const dicho of ['si', 'sí', 'y', 'no']) {
    it(`«${dicho}» por argumento no se graba: sale 2 (usage) y enseña cómo se dice`, async () => {
      conPendiente();

      const { salida, codigo } = await correr(['question', 'answer', 'q-1', dicho]);

      expect(mockAnswer).not.toHaveBeenCalled();
      expect(codigo).toBe(2);
      expect(salida).toContain('SAVED AS A FIRM PRECEDENT');
    });
  }

  it('un argumento en blanco tampoco: hasta hoy entraba como respuesta vacía', async () => {
    conPendiente();

    const { codigo } = await correr(['question', 'answer', 'q-1', '   ']);

    expect(mockAnswer).not.toHaveBeenCalled();
    expect(codigo).toBe(2);
  });

  it('el texto de verdad sigue pasando', async () => {
    conPendiente();

    await correr(['question', 'answer', 'q-1', 'Va', 'a', '6130']);

    expect(respuesta()[2]).toBe('Va a 6130');
  });

  it('elegir una opción por su número es inequívoco AUNQUE la opción se llame «Sí»', async () => {
    // La salida honesta para una pregunta de sí/no: el filtro mira el texto
    // libre, no la opción elegida, así que el «sí» del catálogo sí entra.
    conPendiente({ options: ['Sí, se deduce al 100%', 'No, sólo el 50%'] });

    await correr(['question', 'answer', 'q-1', '1']);

    expect(respuesta()[2]).toBe('Sí, se deduce al 100%');
  });
});

// ============================================================
// Y POR LA TERCERA: el canal de chat, que graba el precedente en el acto.
// ============================================================

describe('makeAskUser: el ask_user de chat tampoco acepta un sí desnudo', () => {
  const conGuion = (respuestas: Array<string | null>) => {
    guion.respuestas = [...respuestas];
    guion.prompts = [];
    const rl = readlineDoblado();
    return makeAskUser(() => rl as unknown as Interface);
  };

  const mudo = () => [
    vi.spyOn(console, 'log').mockImplementation(() => undefined),
    vi.spyOn(process.stdout, 'write').mockImplementation((() => true) as never),
  ];

  it('«si» repregunta y la segunda respuesta en palabras es la que viaja', async () => {
    const espias = mudo();
    const askUser = conGuion(['si', 'sí, es deducible al 100%']);

    const r = await askUser({ question: '¿Se deduce la gasolina?' });

    expect(r).toBe('sí, es deducible al 100%');
    expect(guion.prompts).toHaveLength(2);
    for (const e of espias) e.mockRestore();
  });

  it('insistir en «si» deja la duda PENDIENTE (null), que es no sembrar nada', async () => {
    const espias = mudo();
    const askUser = conGuion(['si', 'sí']);

    const r = await askUser({ question: '¿Se deduce la gasolina?' });

    expect(r).toBeNull();
    for (const e of espias) e.mockRestore();
  });

  it('el texto normal y el número de opción siguen funcionando', async () => {
    const espias = mudo();
    const askUser1 = conGuion(['Va a 6130']);
    expect(await askUser1({ question: '¿A qué cuenta?' })).toBe('Va a 6130');

    const askUser2 = conGuion(['2']);
    expect(
      await askUser2({ question: '¿A qué cuenta?', options: ['6130 Teléfonos', '5201 Servicios'] })
    ).toBe('5201 Servicios');
    for (const e of espias) e.mockRestore();
  });
});
