import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

/**
 * Los dos SDK, doblados en el MÓDULO — no inyectados por la prueba.
 *
 * Es la única forma de ejercer createLlmSession de verdad: la fábrica construye
 * `new OpenAI(...)` / `new Anthropic(...)` ella misma y no admite cliente por
 * parámetro. Doblar aquí el transporte deja el resto del camino intacto (perfil
 * resuelto, bloques de sistema, presupuesto, runner embarcado), que es
 * justamente lo que hay que cruzar. Los runners reciben su cliente por
 * constructor, así que estos dobles no tocan a las pruebas que los construyen
 * a mano más abajo.
 */
const sdk = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  anthropicToolRunner: vi.fn(),
  anthropicCreate: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: sdk.openaiCreate } };
  },
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    beta = { messages: { toolRunner: sdk.anthropicToolRunner, create: sdk.anthropicCreate } };
  },
}));

import {
  BUILTIN_PROFILES,
  compactacionParaPerfil,
  DEFAULT_COMPACTION_THRESHOLD_TOKENS,
  FRACCION_VENTANA_COMPACTABLE,
  MAX_DESCARGAS_MEMORIA_POR_SESION,
  resolveCompactionConfig,
  resolveProfile,
  ventanaDe,
  type PerfilDeFabrica,
} from '../../../src/ai/providers/config.js';
import { createLlmSession } from '../../../src/ai/providers/index.js';
import { DEFAULT_KEEP_RECENT_TOKENS, FLUSH_MARKER } from '../../../src/ai/compaction.js';
import { OpenAiCompatSession } from '../../../src/ai/providers/openai-compat.js';
import { MnemosineAgent } from '../../../src/ai/agent.js';
import { query } from '../../../src/database/connection.js';
import type { AgentContext } from '../../../src/ai/context.js';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';

// ============================================================
// A5·3 — LA COMPACTACIÓN SE DISPARA POR LA VENTANA DEL PERFIL
//
// Lo que estas pruebas ejercen es la RESOLUCIÓN y su EFECTO, no la forma del
// código: nadie lee aquí el texto de config.ts ni comprueba que exista un
// campo. Se pregunta qué umbral sale para cada perfil, y luego se hace correr
// a los DOS runners que se embarcan —con el perfil que devuelve resolveProfile,
// no con uno inventado en la prueba— para ver si la historia se compacta o no
// se compacta donde debe.
//
// Los mutantes que esto tiene que matar:
//  · que la ventana del perfil deje de mirarse (volver al umbral global);
//  · que el umbral se derive pero la COLA reciente no, con lo que el disparo
//    ocurriría y planCompaction no encontraría nunca nada que soltar;
//  · que LA COSTURA se anule — providers/index.ts resuelve la sección global y
//    se la pasa a los runners, y apagar ahí la marca `umbralDerivable` volvía
//    la pieza entera un no-op en producción con la suite unitaria COMPLETA en
//    verde. Por eso hay un bloque que construye la sesión por la VÍA REAL
//    (createLlmSession) en vez de instanciar el runner a mano: el llamador
//    tiene que PASARLE al llamado lo que promete, y eso no se ve probando cada
//    lado por separado;
//  · que la guarda de la ventana incoherente desaparezca: un umbral NaN no
//    apaga ruidosamente, apaga EN SILENCIO;
//  · que el tope de descargas de memoria se quite o se afloje: la frecuencia
//    con la que el sistema escribe memoria no puede depender de la ventana del
//    perfil (medido: 27 descargas donde el mismo trabajo daba 1).
// ============================================================

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

let tmpDir: string;
let fakeHome: string;

beforeEach(() => {
  mockQuery.mockReset();
  // buildSystemBlocks (catálogo de cuentas + digest de memoria) corre DENTRO de
  // createLlmSession: sin filas la sesión nace igual y no hay base aquí.
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  sdk.openaiCreate.mockReset();
  sdk.anthropicToolRunner.mockReset();
  sdk.anthropicCreate.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-ventana-'));
  // HOME vacío: sin esto, el ~/.mnemosine/config.json de la máquina de quien
  // corra la suite decidiría los umbrales y la prueba diría cosas distintas
  // en cada portátil.
  fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemosine-home-'));
  vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
  delete process.env.MNEMOSINE_PROVIDER;
  process.env.MINIMAX_API_KEY = 'sk-test';
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.MINIMAX_API_KEY;
});

const escribirConfig = (contenido: Record<string, unknown>): void =>
  fs.writeFileSync(path.join(tmpDir, 'mnemosine.config.json'), JSON.stringify(contenido));

/** El umbral efectivo de un perfil con el archivo del operador tal como esté. */
function umbralDe(nombre: string): number | undefined {
  return compactacionParaPerfil(
    nombre,
    resolveCompactionConfig(tmpDir),
    DEFAULT_KEEP_RECENT_TOKENS,
    tmpDir
  ).thresholdTokens;
}

function colaDe(nombre: string): number | undefined {
  return compactacionParaPerfil(
    nombre,
    resolveCompactionConfig(tmpDir),
    DEFAULT_KEEP_RECENT_TOKENS,
    tmpDir
  ).keepRecentTokens;
}

// ------------------------------------------------------------
// 1. La tabla de fábrica: los DOCE perfiles, uno por uno
// ------------------------------------------------------------

/** Ventanas declaradas, en tokens. Lo que NO está aquí dice que no lo sabe. */
const VENTANAS_DECLARADAS: Record<string, number> = {
  anthropic: 1_000_000,
  gemini: 1_048_576,
  hermes: 131_072,
  ollama: 32_768,
};

const SIN_VENTANA = [
  'hermes-agent',
  'openai',
  'grok',
  'minimax',
  'qwen',
  'openrouter',
  'copilot',
  'openclaw',
];

describe('ventana de contexto — la tabla de fábrica', () => {
  it('los doce perfiles declaran su ventana o confiesan no saberla', () => {
    const nombres = Object.keys(BUILTIN_PROFILES);
    // Si mañana entra un perfil nuevo, esta cuenta lo trae a esta prueba en vez
    // de dejarlo pasar de largo con la postura de otro.
    expect(nombres.sort()).toEqual(
      [...Object.keys(VENTANAS_DECLARADAS), ...SIN_VENTANA].sort()
    );

    for (const nombre of nombres) {
      const v = BUILTIN_PROFILES[nombre].ventana;
      const esperada = VENTANAS_DECLARADAS[nombre];
      expect(`${nombre}:${v.postura}`).toBe(
        `${nombre}:${esperada === undefined ? 'desconocida' : 'declarada'}`
      );
      expect(`${nombre}:${v.tokens ?? 'sin-tokens'}`).toBe(`${nombre}:${esperada ?? 'sin-tokens'}`);
      // Una postura sin motivo es una opinión: la razón tiene que decir algo.
      expect(`${nombre}:${v.razon.length > 80}`).toBe(`${nombre}:true`);
    }
  });

  it('ventanaDe lee el perfil que se va a usar, no la tabla de fábrica', () => {
    expect(ventanaDe('ollama', tmpDir)?.tokens).toBe(32_768);
    // Un perfil del archivo REEMPLAZA al de fábrica; no hereda su ventana.
    escribirConfig({
      providers: { ollama: { type: 'openai-compatible', model: 'otro', base_url: 'http://x/v1' } },
    });
    expect(ventanaDe('ollama', tmpDir)).toBeNull();
    expect(ventanaDe('un-perfil-que-nadie-definio', tmpDir)).toBeNull();
  });
});

// ------------------------------------------------------------
// 2. La resolución: el umbral sale de la ventana
// ------------------------------------------------------------

describe('umbral derivado de la ventana', () => {
  it('perfil pequeño → umbral pequeño; perfil grande → umbral grande', () => {
    // El mutante obligatorio (volver al umbral global) muere aquí, y el fallo
    // nombra al perfil pequeño en su propio mensaje.
    expect(`ollama:${umbralDe('ollama')}`).toBe('ollama:16384');
    expect(`hermes:${umbralDe('hermes')}`).toBe('hermes:65536');
    expect(`anthropic:${umbralDe('anthropic')}`).toBe('anthropic:500000');
    expect(`gemini:${umbralDe('gemini')}`).toBe('gemini:524288');

    // La fracción es la misma para todos y no es 1: compactar al 100% de la
    // ventana es reventar.
    expect(FRACCION_VENTANA_COMPACTABLE).toBeLessThan(1);
    for (const [nombre, ventana] of Object.entries(VENTANAS_DECLARADAS)) {
      expect(`${nombre}:${umbralDe(nombre)}`).toBe(
        `${nombre}:${Math.floor(ventana * FRACCION_VENTANA_COMPACTABLE)}`
      );
    }
    expect(umbralDe('ollama')!).toBeLessThan(umbralDe('anthropic')!);
  });

  it('el perfil que no declara ventana queda EXACTAMENTE como hoy', () => {
    for (const nombre of SIN_VENTANA) {
      expect(`${nombre}:${umbralDe(nombre)}`).toBe(`${nombre}:${DEFAULT_COMPACTION_THRESHOLD_TOKENS}`);
      // Y sin cola derivada: el compactador sigue usando su omisión.
      expect(`${nombre}:${colaDe(nombre)}`).toBe(`${nombre}:undefined`);
    }
    expect(DEFAULT_COMPACTION_THRESHOLD_TOKENS).toBe(150_000);
  });

  it('la cola reciente baja con el umbral para que la compactación sea ALCANZABLE', () => {
    // Un umbral de 16 384 con la cola por omisión de 20 000 dispararía la
    // compactación y planCompaction no encontraría nunca nada que soltar.
    expect(umbralDe('ollama')!).toBeLessThan(DEFAULT_KEEP_RECENT_TOKENS);
    expect(`ollama:${colaDe('ollama')}`).toBe('ollama:8192');
    expect(colaDe('ollama')!).toBeLessThan(umbralDe('ollama')!);
    // Donde el umbral es holgado, la cola no se toca.
    expect(`anthropic:${colaDe('anthropic')}`).toBe(`anthropic:${DEFAULT_KEEP_RECENT_TOKENS}`);
    expect(`gemini:${colaDe('gemini')}`).toBe(`gemini:${DEFAULT_KEEP_RECENT_TOKENS}`);
  });
});

// ------------------------------------------------------------
// 3. El archivo del operador manda sobre las dos
// ------------------------------------------------------------

describe('la sección compaction del operador gana', () => {
  it('threshold_tokens explícito manda incluso por encima de la ventana del perfil', () => {
    escribirConfig({ compaction: { threshold_tokens: 200_000 } });
    // 200 000 sobre una ventana de 32 768 es una barbaridad — y es SU archivo.
    expect(`ollama:${umbralDe('ollama')}`).toBe('ollama:200000');
    expect(`anthropic:${umbralDe('anthropic')}`).toBe('anthropic:200000');
    expect(`ollama:${colaDe('ollama')}`).toBe('ollama:undefined');
  });

  it('threshold_tokens: 0 sigue siendo el apagado explícito, con ventana o sin ella', () => {
    escribirConfig({ compaction: { threshold_tokens: 0 } });
    for (const nombre of ['ollama', 'anthropic', 'minimax']) {
      expect(`${nombre}:${umbralDe(nombre)}`).toBe(`${nombre}:undefined`);
    }
  });

  it('keep_recent_tokens del operador gana sobre la cola derivada', () => {
    escribirConfig({ compaction: { keep_recent_tokens: 999 } });
    expect(`ollama:${umbralDe('ollama')}`).toBe('ollama:16384'); // el umbral sí se deriva
    expect(`ollama:${colaDe('ollama')}`).toBe('ollama:999'); // la cola no
  });

  it('la marca de derivable aparece si y sólo si el archivo calló', () => {
    // Es la costura por la que el runner distingue «lo escribió el operador»
    // de «nadie dijo nada»; sin ella recibiría 150 000 en los dos casos.
    expect(resolveCompactionConfig(tmpDir).umbralDerivable).toBe(true);
    escribirConfig({ compaction: { keep_recent_tokens: 5_000 } });
    expect(resolveCompactionConfig(tmpDir).umbralDerivable).toBe(true);
    escribirConfig({ compaction: { threshold_tokens: 90_000 } });
    expect(resolveCompactionConfig(tmpDir).umbralDerivable).toBeUndefined();
    escribirConfig({ compaction: { threshold_tokens: 0 } });
    expect(resolveCompactionConfig(tmpDir).umbralDerivable).toBeUndefined();
  });

  it('un umbral pasado a mano a la sesión (sin la marca de derivable) manda igual', () => {
    const aMano = compactacionParaPerfil(
      'ollama',
      { thresholdTokens: 1_500, keepRecentTokens: 600 },
      DEFAULT_KEEP_RECENT_TOKENS,
      tmpDir
    );
    expect(aMano.thresholdTokens).toBe(1_500);
    expect(aMano.keepRecentTokens).toBe(600);
    // Y «sin umbral y sin marca» sigue significando compactación automática
    // apagada, como antes de que existiera la ventana.
    expect(
      compactacionParaPerfil('ollama', {}, DEFAULT_KEEP_RECENT_TOKENS, tmpDir).thresholdTokens
    ).toBeUndefined();
  });
});

// ------------------------------------------------------------
// 4. EL EFECTO en los runners que se embarcan
// ------------------------------------------------------------

/**
 * Los perfiles de fábrica NO traen `stream: false`, así que el runner pide
 * streaming en los turnos y respuesta entera en la llamada de resumen. El
 * doble responde a las dos formas para que el camino ejercido sea el que
 * ollama recorre de verdad, no una variante cómoda.
 */
function fakeOpenAiClient() {
  const create = vi.fn(async (params: { stream?: boolean }) => {
    if (!params.stream) {
      return { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };
    }
    return {
      async *[Symbol.asyncIterator]() {
        yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
      },
    };
  });
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, create };
}

/** Todos los textos que salieron en una petición al proveedor. */
function textosDe(call: unknown[]): string[] {
  const params = call[0] as { messages: Array<{ content?: unknown }> };
  return params.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')));
}

describe('efecto — OpenAiCompatSession con el perfil de ventana pequeña', () => {
  /** ~7 000 tokens por turno: tres turnos pasan de 16 384 y no llegan a 150 000. */
  const GORDO = 'x'.repeat(28_000);

  async function correrCuatroTurnos(nombrePerfil: string) {
    const perfil = resolveProfile(nombrePerfil, undefined, tmpDir);
    const { client, create } = fakeOpenAiClient();
    const session = new OpenAiCompatSession(client, perfil, CTX, 'sistema', {}, {
      // Exactamente lo que el arnés le pasa en producción: la sección global
      // resuelta del archivo, con su marca de derivable.
      compaction: resolveCompactionConfig(tmpDir),
      cwd: tmpDir,
      grounding: { enabled: false },
    });
    await session.runTurn(`u1 ${GORDO}`);
    await session.runTurn(`u2 ${GORDO}`);
    await session.runTurn(`u3 ${GORDO}`);
    await session.runTurn('u4');
    return create;
  }

  it('ollama compacta a los ~21 000 tokens; el mismo historial con un perfil sin ventana no', async () => {
    const conVentana = await correrCuatroTurnos('ollama');
    // Cuatro turnos MÁS la descarga de memoria y el resumen de la compactación:
    // si el doble se hubiera cortado por lo sano, esta cuenta lo diría antes
    // que cualquier aserción sobre el contenido.
    expect(`ollama:${conVentana.mock.calls.length}`).toBe('ollama:6');
    const ultimaOllama = textosDe(conVentana.mock.calls[conVentana.mock.calls.length - 1]);
    expect(ultimaOllama.some((t) => t.includes('[COMPACTION SUMMARY]'))).toBe(true);
    // Y compactó DE VERDAD: el primer turno ya no viaja.
    expect(ultimaOllama.some((t) => t.startsWith('u1 '))).toBe(false);
    // ...pero el reciente SÍ. Esta línea es la que ve el TERCER ARGUMENTO que el
    // runner le presta a compactacionParaPerfil (DEFAULT_KEEP_RECENT_TOKENS):
    // ponerlo a 0 deriva una cola de 0, el plan se lleva la conversación entera
    // y sólo sobrevive el resumen. Sin esta aserción ese mutante pasaba en verde
    // —había [COMPACTION SUMMARY] y u1 tampoco viajaba—, que es la forma (i):
    // el llamado se ejerce con el argumento correcto y nadie mira que el
    // llamador se lo PASE.
    expect(ultimaOllama.some((t) => t.startsWith('u2 '))).toBe(true);

    // Mismo tamaño, mismo archivo, mismo runner: sólo cambia el perfil.
    const sinVentana = await correrCuatroTurnos('minimax');
    expect(`minimax:${sinVentana.mock.calls.length}`).toBe('minimax:4'); // cuatro turnos y nada más
    const todos = sinVentana.mock.calls.flatMap((c) => textosDe(c));
    expect(todos.some((t) => t.includes('[COMPACTION SUMMARY]'))).toBe(false);
    expect(textosDe(sinVentana.mock.calls[sinVentana.mock.calls.length - 1]).some((t) => t.startsWith('u1 '))).toBe(
      true
    );
  });

  it('con threshold_tokens del operador por encima de la ventana, ollama NO compacta', async () => {
    escribirConfig({ compaction: { threshold_tokens: 200_000 } });
    const create = await correrCuatroTurnos('ollama');
    const todos = create.mock.calls.flatMap((c) => textosDe(c));
    expect(todos.some((t) => t.includes('[COMPACTION SUMMARY]'))).toBe(false);
  });
});

describe('efecto — MnemosineAgent con el perfil de ventana grande', () => {
  function fakeAnthropicClient() {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'resumen' }],
      usage: undefined,
    });
    const toolRunner = vi.fn((params: { messages: Array<{ role: string; content: unknown }> }) => {
      const final = { content: [{ type: 'text', text: 'ok' }], usage: undefined };
      return {
        async *[Symbol.asyncIterator]() {
          yield { on: () => {}, finalMessage: async () => final };
        },
        done: async () => final,
        params: { messages: [...params.messages, { role: 'assistant', content: final.content }] },
      };
    });
    const client = { beta: { messages: { toolRunner, create } } } as unknown as Anthropic;
    return { client, create, toolRunner };
  }

  /** ~55 000 tokens por turno: tres turnos pasan de 150 000 y no llegan a 500 000. */
  const ENORME = 'y'.repeat(220_000);

  function agenteReal(cwd: string) {
    const perfil = resolveProfile('anthropic', undefined, cwd);
    const { client, create, toolRunner } = fakeAnthropicClient();
    const agent = new MnemosineAgent(client, CTX, [], {}, perfil.model, perfil.name, {
      compaction: resolveCompactionConfig(cwd),
      cwd,
      grounding: { enabled: false },
    });
    return { agent, create, toolRunner };
  }

  async function correr(cwd: string) {
    const { agent, create, toolRunner } = agenteReal(cwd);
    await agent.runTurn(`u1 ${ENORME}`);
    await agent.runTurn(`u2 ${ENORME}`);
    await agent.runTurn(`u3 ${ENORME}`);
    await agent.runTurn('u4');
    return { create, toolRunner };
  }

  it('a 165 000 tokens NO compacta: la ventana es de un millón y ese contexto cabía', async () => {
    const { create, toolRunner } = await correr(tmpDir);
    // La llamada de resumen es la huella de que hubo compactación.
    expect(create).not.toHaveBeenCalled();
    // Cuatro turnos, ni una vuelta extra de descarga de memoria.
    expect(toolRunner).toHaveBeenCalledTimes(4);
    const ultima = toolRunner.mock.calls[3][0] as { messages: Array<{ content: unknown }> };
    expect(JSON.stringify(ultima.messages).includes('[COMPACTION SUMMARY]')).toBe(false);
  });

  it('el mismo historial SÍ compacta cuando el operador baja el umbral a mano', async () => {
    escribirConfig({ compaction: { threshold_tokens: 150_000 } });
    const { create } = await correr(tmpDir);
    expect(create).toHaveBeenCalled();
  });

  it('la cola derivada llega al compactador: el turno reciente sobrevive a /compact', async () => {
    // El mismo hueco de la forma (i) que la cola de ollama, en el OTRO runner:
    // agent.ts también le presta a compactacionParaPerfil la cola por omisión
    // del compactador, y aquí el mínimo la elige (min(20 000, 250 000)). Con ese
    // argumento a 0 el plan se lleva TODO y no queda cola: droppedMessages sube,
    // keepTokens cae a cero y el último turno deja de viajar. Ninguna prueba
    // anterior lo miraba porque el único caso anthropic que compactaba tenía
    // umbral del OPERADOR, y ese camino ni siquiera deriva.
    const { agent, toolRunner } = agenteReal(tmpDir);
    await agent.runTurn(`u1 ${ENORME}`);
    await agent.runTurn(`u2 ${ENORME}`);
    await agent.runTurn(`u3 ${ENORME}`);

    const r = await agent.compact();
    expect(r).not.toBeNull();
    // El último turno entero (~55 000 tokens) se queda: no «algo», el turno.
    expect(r!.keepTokens).toBeGreaterThan(50_000);
    expect(`sobrevivio:${r!.keepTokens > 0}`).toBe('sobrevivio:true');

    await agent.runTurn('u4');
    const ultima = toolRunner.mock.calls[toolRunner.mock.calls.length - 1][0] as {
      messages: Array<{ content: unknown }>;
    };
    const textos = JSON.stringify(ultima.messages);
    expect(textos.includes('[COMPACTION SUMMARY]')).toBe(true);
    expect(textos.includes('u3 ')).toBe(true);
    expect(textos.includes('u1 ')).toBe(false);
  });
});

// ------------------------------------------------------------
// 5. LA COSTURA — la sesión que el arnés construye DE VERDAD
//
// Todo lo de arriba prueba los dos lados: compactacionParaPerfil deriva bien, y
// los runners compactan bien cuando se les entrega la sección con su marca. Lo
// que no probaba nada era el ENLACE. La derivación vive dentro de los runners,
// pero quien resuelve la sección global y se la pasa es providers/index.ts, en
// una sola expresión:
//
//     const compaction = opts.compaction ?? resolveCompactionConfig(opts.cwd);
//
// Cambiarla por `{ ...resolveCompactionConfig(), umbralDerivable: false }` deja
// la pieza entera en NO-OP en producción —todo perfil vuelve a 150 000, ollama
// sigue reventando por contexto— y la suite unitaria COMPLETA seguía en verde:
// el llamado se ejercía con el argumento correcto y el llamador contra un doble
// que devolvía lo mismo dijera lo que dijera. Aquí se cruza de lado a lado: se
// pide la sesión por la vía real y se mira DÓNDE compacta.
// ------------------------------------------------------------

describe('la costura — la sesión que sale de createLlmSession', () => {
  /** ~7 000 tokens por turno. */
  const GORDO = 'x'.repeat(28_000);
  /** ~150 001 tokens por turno: dos turnos pasan de 150 000 y no de 500 000. */
  const DESCOMUNAL = 'y'.repeat(600_000);

  function armarOpenAi(): void {
    sdk.openaiCreate.mockImplementation(async (params: { stream?: boolean }) => {
      if (!params.stream) {
        return { choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] };
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
  }

  function armarAnthropic(): void {
    sdk.anthropicCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'resumen' }],
      usage: undefined,
    });
    sdk.anthropicToolRunner.mockImplementation(
      (params: { messages: Array<{ role: string; content: unknown }> }) => {
        const final = { content: [{ type: 'text', text: 'ok' }], usage: undefined };
        return {
          async *[Symbol.asyncIterator]() {
            yield { on: () => {}, finalMessage: async () => final };
          },
          done: async () => final,
          params: { messages: [...params.messages, { role: 'assistant', content: final.content }] },
        };
      }
    );
  }

  /** La vía real: perfil resuelto del archivo → fábrica → runner embarcado. */
  const sesionReal = (nombrePerfil: string) =>
    createLlmSession(resolveProfile(nombrePerfil, undefined, tmpDir), CTX, {}, {
      cwd: tmpDir,
      grounding: { enabled: false },
    });

  it('la sesión de ventana pequeña compacta donde manda SU ventana, no el respaldo global', async () => {
    armarOpenAi();
    const session = await sesionReal('ollama');
    await session.runTurn(`u1 ${GORDO}`);
    await session.runTurn(`u2 ${GORDO}`);
    await session.runTurn(`u3 ${GORDO}`);
    await session.runTurn('u4');

    // Cuatro turnos + la descarga de memoria + el resumen de la compactación.
    // Con la costura anulada serían cuatro y nada más: 21 000 tokens no llegan
    // a 150 000 ni de lejos.
    expect(`peticiones:${sdk.openaiCreate.mock.calls.length}`).toBe('peticiones:6');
    const ultima = textosDe(sdk.openaiCreate.mock.calls[sdk.openaiCreate.mock.calls.length - 1]);
    expect(ultima.some((t) => t.includes('[COMPACTION SUMMARY]'))).toBe(true);
    expect(ultima.some((t) => t.startsWith('u1 '))).toBe(false);
    expect(ultima.some((t) => t.startsWith('u2 '))).toBe(true);
  });

  it('la sesión de ventana grande NO compacta a 300 000 tokens: el respaldo global sí lo haría', async () => {
    armarAnthropic();
    const session = await sesionReal('anthropic');
    await session.runTurn(`u1 ${DESCOMUNAL}`);
    await session.runTurn(`u2 ${DESCOMUNAL}`);
    await session.runTurn(`u3 ${DESCOMUNAL}`);

    // La otra dirección de la misma costura, y en el OTRO runner: con la marca
    // apagada la sesión habría compactado en el tercer turno (300 000 > 150 000)
    // tirando historia que en un millón de ventana cabía de sobra. La llamada de
    // resumen es la huella de que hubo compactación.
    expect(sdk.anthropicCreate).not.toHaveBeenCalled();
    expect(`turnos:${sdk.anthropicToolRunner.mock.calls.length}`).toBe('turnos:3');
  });

  it('el threshold_tokens del operador sigue mandando a través de la fábrica', async () => {
    escribirConfig({ compaction: { threshold_tokens: 200_000 } });
    armarOpenAi();
    const session = await sesionReal('ollama');
    await session.runTurn(`u1 ${GORDO}`);
    await session.runTurn(`u2 ${GORDO}`);
    await session.runTurn(`u3 ${GORDO}`);
    await session.runTurn('u4');
    // 200 000 sobre una ventana de 32 768 es una barbaridad, y es SU archivo:
    // la fábrica no puede pisárselo con la ventana del perfil.
    expect(`peticiones:${sdk.openaiCreate.mock.calls.length}`).toBe('peticiones:4');
    const todos = sdk.openaiCreate.mock.calls.flatMap((c) => textosDe(c));
    expect(todos.some((t) => t.includes('[COMPACTION SUMMARY]'))).toBe(false);
  });

  it('la fábrica lee la SECCIÓN compaction del mismo archivo que el presupuesto', async () => {
    // `opts.cwd` manda: el presupuesto ya leía de ahí (assertWithinBudget) y la
    // sección compaction salía de process.cwd(). Con dos directorios distintos,
    // un trabajo lanzado sobre otra carpeta obedecía un archivo para el tope de
    // gasto y otro para el umbral. El archivo de ESTE directorio apaga la
    // compactación; si la fábrica leyera otro, ollama compactaría igual.
    escribirConfig({ compaction: { threshold_tokens: 0 } });
    armarOpenAi();
    const session = await sesionReal('ollama');
    await session.runTurn(`u1 ${GORDO}`);
    await session.runTurn(`u2 ${GORDO}`);
    await session.runTurn(`u3 ${GORDO}`);
    await session.runTurn('u4');
    expect(`peticiones:${sdk.openaiCreate.mock.calls.length}`).toBe('peticiones:4');
  });

  it('y le pasa ese mismo directorio al runner, que es quien resuelve la VENTANA', async () => {
    // La otra mitad de lo mismo: el runner deriva con `options.cwd`. Aquí el
    // archivo del directorio REDEFINE el perfil ollama —otro servidor, otra
    // ventana que nadie declaró—, así que no hay derivación y manda el respaldo
    // global. Si el runner mirase process.cwd() heredaría en silencio la ventana
    // del perfil de fábrica y compactaría a 16 384 sobre un montaje del que no
    // sabe nada.
    escribirConfig({
      providers: { ollama: { type: 'openai-compatible', model: 'otro', base_url: 'http://x/v1' } },
    });
    armarOpenAi();
    const session = await sesionReal('ollama');
    await session.runTurn(`u1 ${GORDO}`);
    await session.runTurn(`u2 ${GORDO}`);
    await session.runTurn(`u3 ${GORDO}`);
    await session.runTurn('u4');
    expect(`peticiones:${sdk.openaiCreate.mock.calls.length}`).toBe('peticiones:4');
  });

  it('lo mismo por el camino Anthropic: el perfil redefinido no hereda la ventana de fábrica', async () => {
    escribirConfig({ providers: { anthropic: { type: 'anthropic', model: 'otro' } } });
    armarAnthropic();
    const session = await sesionReal('anthropic');
    await session.runTurn(`u1 ${DESCOMUNAL}`);
    await session.runTurn(`u2 ${DESCOMUNAL}`);
    await session.runTurn(`u3 ${DESCOMUNAL}`);
    // Sin ventana declarada manda el respaldo global de 150 000, y 300 000 lo
    // pasa: ESTA sesión sí compacta. Con la ventana de fábrica heredada por
    // error (un millón → 500 000) no compactaría, que es el mutante.
    expect(sdk.anthropicCreate).toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
// 6. LA VENTANA INCOHERENTE — la guarda que impide un apagado silencioso
// ------------------------------------------------------------

describe('una ventana incoherente cae al respaldo, nunca a NaN', () => {
  const GORDO = 'x'.repeat(28_000);

  /** Mete un perfil en la TABLA EMBARCADA y lo saca pase lo que pase. */
  async function conPerfilDeFabrica(
    nombre: string,
    ventana: PerfilDeFabrica['ventana'],
    cuerpo: () => void | Promise<void>
  ): Promise<void> {
    BUILTIN_PROFILES[nombre] = { ...BUILTIN_PROFILES.ollama, ventana };
    try {
      await cuerpo();
    } finally {
      delete BUILTIN_PROFILES[nombre];
    }
  }

  it('«declarada» sin tokens y «declarada» con NaN dan el umbral global, no NaN', async () => {
    // No es un objeto paralelo: entra en BUILTIN_PROFILES, que es de donde
    // ventanaDe lo saca en producción (vía listProfiles, cuyo cast a
    // Partial<PerfilDeFabrica> AFIRMA la forma en vez de probarla).
    const incoherentes: Array<[string, PerfilDeFabrica['ventana']]> = [
      ['sin-tokens', { postura: 'declarada', razon: 'declara y se calla el número' } as unknown as PerfilDeFabrica['ventana']],
      ['tokens-nan', { postura: 'declarada', tokens: Number.NaN, razon: 'el número no es número' }],
      ['tokens-infinito', { postura: 'declarada', tokens: Number.POSITIVE_INFINITY, razon: 'sin fin' }],
    ];
    for (const [nombre, ventana] of incoherentes) {
      await conPerfilDeFabrica(nombre, ventana, () => {
        const c = compactacionParaPerfil(
          nombre,
          resolveCompactionConfig(tmpDir),
          DEFAULT_KEEP_RECENT_TOKENS,
          tmpDir
        );
        expect(`${nombre}:${c.thresholdTokens}`).toBe(`${nombre}:${DEFAULT_COMPACTION_THRESHOLD_TOKENS}`);
        expect(`${nombre}:${Number.isFinite(c.thresholdTokens)}`).toBe(`${nombre}:true`);
        // Y sin cola derivada: cae ENTERO al respaldo, no a medias.
        expect(`${nombre}:${c.keepRecentTokens}`).toBe(`${nombre}:undefined`);
      });
    }
    // La ventana coherente sigue derivando: la guarda no apaga la pieza.
    await conPerfilDeFabrica('coherente', { postura: 'declarada', tokens: 32_768, razon: 'x' }, () => {
      const c = compactacionParaPerfil(
        'coherente',
        resolveCompactionConfig(tmpDir),
        DEFAULT_KEEP_RECENT_TOKENS,
        tmpDir
      );
      expect(`coherente:${c.thresholdTokens}`).toBe('coherente:16384');
    });
  });

  it('un umbral NaN apaga la compactación EN SILENCIO — que es lo que la guarda evita', async () => {
    // El motivo de la guarda, ejecutado en el runner embarcado y no argumentado:
    // `vista > NaN` es siempre falso, así que la sesión no compacta NUNCA y no
    // hay error, ni aviso, ni nada que mirar. Es el modo de fallo que esta pieza
    // existe para cerrar, alcanzado por dentro.
    const perfil = resolveProfile('ollama', undefined, tmpDir);
    const conNaN = fakeOpenAiClient();
    const sesionNaN = new OpenAiCompatSession(conNaN.client, perfil, CTX, 'sistema', {}, {
      compaction: { thresholdTokens: Number.NaN }, // sin la marca: manda tal cual
      cwd: tmpDir,
      grounding: { enabled: false },
    });
    for (const i of [1, 2, 3, 4]) await sesionNaN.runTurn(`u${i} ${GORDO}`);
    expect(`nan:${conNaN.create.mock.calls.length}`).toBe('nan:4');
    expect(conNaN.create.mock.calls.flatMap((c) => textosDe(c)).some((t) => t.includes('[COMPACTION SUMMARY]'))).toBe(
      false
    );

    // El mismo historial con el par que la ventana deriva (16 384 de disparo y
    // 8 192 de cola) sí compacta: lo que apaga es el NaN, no el tamaño.
    const conUmbral = fakeOpenAiClient();
    const sesionOk = new OpenAiCompatSession(conUmbral.client, perfil, CTX, 'sistema', {}, {
      compaction: compactacionParaPerfil(
        'ollama',
        resolveCompactionConfig(tmpDir),
        DEFAULT_KEEP_RECENT_TOKENS,
        tmpDir
      ),
      cwd: tmpDir,
      grounding: { enabled: false },
    });
    for (const i of [1, 2, 3, 4]) await sesionOk.runTurn(`u${i} ${GORDO}`);
    expect(`ok:${conUmbral.create.mock.calls.length}`).toBe('ok:6');
  });

  it('la tabla de fábrica no PUEDE declarar una ventana incoherente (lo sostiene el typecheck)', () => {
    // Anclas de TIPO, no de ejecución: `npm run typecheck:tests` falla si alguna
    // de estas tres deja de ser un error. types.ts afirma en un comentario que
    // `tokens` está «presente si y sólo si postura === declarada»; su tipo no lo
    // sostenía, y config.ts sí con VentanaDeFabrica.
    // @ts-expect-error — «declarada» sin tokens: derivaría Math.floor(undefined * 0.5) = NaN.
    const sinTokens: PerfilDeFabrica['ventana'] = { postura: 'declarada', razon: 'x' };
    // @ts-expect-error — «desconocida» CON tokens: un número que nadie declara no es un dato.
    const conTokens: PerfilDeFabrica['ventana'] = { postura: 'desconocida', tokens: 32_768, razon: 'x' };
    const sinVentana: Omit<PerfilDeFabrica, 'ventana'> = BUILTIN_PROFILES.ollama;
    // @ts-expect-error — un perfil de fábrica que se calla la ventana no compila,
    // que es lo que la cabecera de types.ts afirma. Comprobado, no prometido.
    const mudo: PerfilDeFabrica = sinVentana;
    expect([sinTokens.postura, conTokens.postura, mudo.type]).toEqual([
      'declarada',
      'desconocida',
      'openai-compatible',
    ]);
  });
});

// ------------------------------------------------------------
// 7. CUÁNTAS VECES ESCRIBE MEMORIA LA SESIÓN — el efecto que nadie decidió
//
// Antes de esta pieza el umbral era único y la descarga de memoria corría una
// vez por compactación. Derivar el umbral de la ventana multiplica esa cadencia
// por veintisiete en el perfil pequeño, y cada descarga es un bucle agéntico con
// la superficie completa cuyo prompt instruye EXPLÍCITAMENTE a persistir
// criterio. La decisión y su porqué están escritos en config.ts junto a
// MAX_DESCARGAS_MEMORIA_POR_SESION; esto es lo que la sostiene.
// ------------------------------------------------------------

type PeticionOpenAi = { stream?: boolean; messages: Array<{ role: string; content?: unknown }> };

/** Peticiones, compactaciones (la llamada de resumen no va en streaming) y
 *  DESCARGAS (la petición cuyo último mensaje es el prompt de descarga). */
function cuentasDe(create: Mock): { peticiones: number; compactaciones: number; descargas: number } {
  const calls = create.mock.calls as unknown as Array<[PeticionOpenAi]>;
  return {
    peticiones: calls.length,
    compactaciones: calls.filter((c) => !c[0].stream).length,
    descargas: calls.filter((c) => {
      const ms = c[0].messages;
      const ultimo = ms[ms.length - 1];
      return typeof ultimo.content === 'string' && ultimo.content.includes(FLUSH_MARKER);
    }).length,
  };
}

describe('la frecuencia de la descarga de memoria — acotada y declarada', () => {
  /** ~7 000 tokens por turno, los mismos de la medición. */
  const GORDO = 'x'.repeat(28_000);

  async function treintaTurnos(nombrePerfil: string) {
    const perfil = resolveProfile(nombrePerfil, undefined, tmpDir);
    const { client, create } = fakeOpenAiClient();
    const session = new OpenAiCompatSession(client, perfil, CTX, 'sistema', {}, {
      compaction: resolveCompactionConfig(tmpDir),
      cwd: tmpDir,
      grounding: { enabled: false },
    });
    for (let i = 1; i <= 30; i++) await session.runTurn(`u${i} ${GORDO}`);
    return { session, create };
  }

  it('treinta turnos contra ollama: veintisiete compactaciones y CINCO descargas', async () => {
    const { create } = await treintaTurnos('ollama');
    const c = cuentasDe(create);
    // La compactación NO se toca: respetar una ventana de 32 768 obliga a
    // compactar mucho, y eso está bien.
    expect(`compactaciones:${c.compactaciones}`).toBe('compactaciones:27');
    // Lo acotado es lo otro. Sin tope serían 27 —una por compactación—, y el
    // mismo trabajo con el umbral global de hoy da 1 (el caso de abajo).
    expect(`descargas:${c.descargas}`).toBe('descargas:5');
    expect(`descargas:${c.descargas}`).toBe(`descargas:${MAX_DESCARGAS_MEMORIA_POR_SESION}`);
    expect(`peticiones:${c.peticiones}`).toBe('peticiones:62'); // 30 turnos + 27 resúmenes + 5 descargas
  });

  it('sin tope serían veintisiete: el número que el tope corta es ÉSE', async () => {
    // El contrafactual medido, ejecutado. Sin esto, «5» podría venir de que la
    // sesión sólo compactara cinco veces, y no de que el tope muerda.
    escribirConfig({ compaction: { max_memory_flushes: 1_000 } });
    const { create } = await treintaTurnos('ollama');
    const c = cuentasDe(create);
    expect(`compactaciones:${c.compactaciones}`).toBe('compactaciones:27');
    expect(`descargas:${c.descargas}`).toBe('descargas:27');
  });

  it('el mismo trabajo con el umbral global de hoy da una compactación y una descarga', async () => {
    // La medición que hace del 27 una ampliación y no una constante del sistema.
    escribirConfig({ compaction: { threshold_tokens: 150_000 } });
    const { create } = await treintaTurnos('ollama');
    const c = cuentasDe(create);
    expect(`compactaciones:${c.compactaciones}`).toBe('compactaciones:1');
    expect(`descargas:${c.descargas}`).toBe('descargas:1');
  });

  it('max_memory_flushes: 0 apaga el barrido automático sin tocar la compactación', async () => {
    escribirConfig({ compaction: { max_memory_flushes: 0 } });
    const { create } = await treintaTurnos('ollama');
    const c = cuentasDe(create);
    expect(`compactaciones:${c.compactaciones}`).toBe('compactaciones:27');
    expect(`descargas:${c.descargas}`).toBe('descargas:0');
  });

  it('el tope es POR SESIÓN: reset() empieza otra y le devuelve su barrido', async () => {
    escribirConfig({ compaction: { max_memory_flushes: 1 } });
    const perfil = resolveProfile('ollama', undefined, tmpDir);
    const { client, create } = fakeOpenAiClient();
    const session = new OpenAiCompatSession(client, perfil, CTX, 'sistema', {}, {
      compaction: resolveCompactionConfig(tmpDir),
      cwd: tmpDir,
      grounding: { enabled: false },
    });
    for (let i = 1; i <= 8; i++) await session.runTurn(`u${i} ${GORDO}`);
    const primera = cuentasDe(create);
    expect(`descargas:${primera.descargas}`).toBe('descargas:1');
    expect(primera.compactaciones).toBeGreaterThan(1); // hubo más ventanas que descargas

    session.reset();
    for (let i = 1; i <= 8; i++) await session.runTurn(`v${i} ${GORDO}`);
    // Un tope gastado no puede dejar a la conversación NUEVA sin barrido.
    expect(`descargas:${cuentasDe(create).descargas}`).toBe('descargas:2');
  });

  it('el tope vale también en el runner Anthropic, no sólo en el compatible', async () => {
    // La misma decisión, el OTRO runner: agent.ts lleva su propio contador y
    // quitárselo dejaba la mitad de la pieza sin ancla (forma (i) otra vez, esta
    // vez entre dos hermanos). La ventana no hace falta aquí: con el umbral del
    // operador se fuerzan muchas ventanas de compactación baratas y lo que se
    // mira es el tope.
    escribirConfig({ compaction: { threshold_tokens: 4_000, keep_recent_tokens: 1_000 } });
    const perfil = resolveProfile('anthropic', undefined, tmpDir);
    const create = vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'resumen' }],
      usage: undefined,
    });
    const toolRunner = vi.fn((params: { messages: Array<{ role: string; content: unknown }> }) => {
      const final = { content: [{ type: 'text', text: 'ok' }], usage: undefined };
      return {
        async *[Symbol.asyncIterator]() {
          yield { on: () => {}, finalMessage: async () => final };
        },
        done: async () => final,
        params: { messages: [...params.messages, { role: 'assistant', content: final.content }] },
      };
    });
    const client = { beta: { messages: { toolRunner, create } } } as unknown as Anthropic;
    const agent = new MnemosineAgent(client, CTX, [], {}, perfil.model, perfil.name, {
      compaction: resolveCompactionConfig(tmpDir),
      cwd: tmpDir,
      grounding: { enabled: false },
    });
    const MEDIANO = 'z'.repeat(5_000); // ~1 250 tokens por turno
    for (let i = 1; i <= 20; i++) await agent.runTurn(`u${i} ${MEDIANO}`);

    const descargas = (): number =>
      toolRunner.mock.calls.filter((c) => {
        const ms = c[0].messages;
        return JSON.stringify(ms[ms.length - 1].content).includes(FLUSH_MARKER);
      }).length;
    // Muchas más ventanas de compactación que descargas: eso es el tope mordiendo.
    expect(create.mock.calls.length).toBeGreaterThan(MAX_DESCARGAS_MEMORIA_POR_SESION);
    expect(`descargas:${descargas()}`).toBe(`descargas:${MAX_DESCARGAS_MEMORIA_POR_SESION}`);

    // Y aquí también el tope es POR SESIÓN: reset() empieza otra.
    agent.reset();
    for (let i = 1; i <= 20; i++) await agent.runTurn(`v${i} ${MEDIANO}`);
    expect(`descargas:${descargas()}`).toBe(`descargas:${2 * MAX_DESCARGAS_MEMORIA_POR_SESION}`);
  });

  it('el default declarado es 5, y es el que gobierna cuando el archivo calla', () => {
    expect(MAX_DESCARGAS_MEMORIA_POR_SESION).toBe(5);
    expect(resolveCompactionConfig(tmpDir).maxDescargasMemoria).toBeUndefined();
    escribirConfig({ compaction: { max_memory_flushes: 2 } });
    expect(resolveCompactionConfig(tmpDir).maxDescargasMemoria).toBe(2);
  });
});
