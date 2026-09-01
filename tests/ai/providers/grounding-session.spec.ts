import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { OpenAiCompatSession } from '../../../src/ai/providers/openai-compat.js';
import { MnemosineAgent } from '../../../src/ai/agent.js';
import { GROUNDING_NUDGE } from '../../../src/ai/grounding.js';
import { query } from '../../../src/database/connection.js';
import type { AgentContext } from '../../../src/ai/context.js';
import type { ResolvedProfile } from '../../../src/ai/providers/types.js';
import type OpenAI from 'openai';
import type Anthropic from '@anthropic-ai/sdk';

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

const PROFILE: ResolvedProfile = {
  name: 'hermes',
  type: 'openai-compatible',
  model: 'Hermes-4-405B',
  base_url: 'https://inference-api.nousresearch.com/v1',
  stream: false,
  apiKey: 'sk-test',
};

// Long enough to look substantive to the guard (> 240 chars).
const FROM_MEMORY =
  'Para timbrar un CFDI el sistema expone el endpoint /v1/invoices/:id/stamp con failover ' +
  'multi-PAC; primero corres mnemosine ingest y luego apruebas con mnemosine review. '.repeat(3);
const CORRECTED = 'Checking the documentation: el flujo real es este.';

function assistantMessage(content: string | null, toolCalls?: Array<{ id: string; name: string; args: string }>) {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content,
          tool_calls: toolCalls?.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.args },
          })),
        },
        finish_reason: toolCalls?.length ? 'tool_calls' : 'stop',
      },
    ],
  };
}

function fakeClient(responses: Array<Record<string, unknown>>) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, create };
}

describe('grounding gate — OpenAiCompatSession', () => {
  beforeEach(() => mockQuery.mockReset());

  it('bounces a substantive tool-less answer back with the harness nudge', async () => {
    const { client, create } = fakeClient([
      assistantMessage(FROM_MEMORY),
      assistantMessage(CORRECTED),
    ]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema');
    const answer = await session.runTurn('¿cómo timbro un CFDI?');

    expect(create).toHaveBeenCalledTimes(2);
    const secondMessages = create.mock.calls[1][0].messages;
    const lastUser = [...secondMessages].reverse().find((m: { role: string }) => m.role === 'user');
    expect(lastUser.content).toBe(GROUNDING_NUDGE);
    // The ungrounded answer STAYS in the history the nudge sees (the model
    // must know what it is correcting; the transcript keeps both).
    const nudgeIdx = secondMessages.findIndex((m: { content?: unknown }) => m.content === GROUNDING_NUDGE);
    expect(secondMessages[nudgeIdx - 1]).toMatchObject({ role: 'assistant', content: FROM_MEMORY });
    // The corrected answer is the authoritative return value.
    expect(answer).toBe(CORRECTED);
  });

  it('emits a stream separator before the corrective answer (ask stdout contract)', async () => {
    const { client } = fakeClient([assistantMessage(FROM_MEMORY), assistantMessage(CORRECTED)]);
    const deltas: string[] = [];
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema', {
      onText: (d) => deltas.push(d),
    });
    await session.runTurn('¿cómo timbro un CFDI?');
    expect(deltas).toEqual([FROM_MEMORY, '\n\n', CORRECTED]);
  });

  it('a provider error during the corrective turn falls back to the original answer', async () => {
    const create = vi.fn()
      .mockResolvedValueOnce(assistantMessage(FROM_MEMORY))
      .mockRejectedValueOnce(Object.assign(new Error('rate limited'), { status: 429 }));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const turns: unknown[] = [];
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema', {
      onTurnComplete: (r) => turns.push(r),
    });
    // The original turn completed, streamed and was recorded — the extra
    // verification call failing must NOT retro-fail it (under failover it
    // would even re-run the whole turn on another provider).
    const answer = await session.runTurn('¿cómo timbro un CFDI?');
    expect(answer).toBe(FROM_MEMORY);
    expect(turns).toHaveLength(1); // no duplicate turn record from the failed nudge
  });

  it('a FAILED tool run does not count as grounding (the nudge still fires)', async () => {
    const { client, create } = fakeClient([
      assistantMessage(null, [{ id: 'c1', name: 'search_accounts', args: '{"search":"banco"}' }]),
      assistantMessage(FROM_MEMORY), // model answers long despite the tool error
      assistantMessage(CORRECTED),
    ]);
    mockQuery.mockRejectedValueOnce(new Error('connection refused')); // tool run throws
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema');
    const answer = await session.runTurn('¿qué cuenta uso?');
    expect(create).toHaveBeenCalledTimes(3); // loop (2) + corrective turn (1)
    expect(answer).toBe(CORRECTED);
  });

  it('reset() re-arms the guard for the wiped conversation (/new)', async () => {
    const { client, create } = fakeClient([
      assistantMessage(null, [{ id: 'c1', name: 'read_docs', args: '{"topic":"mnemosine"}' }]),
      assistantMessage('El doc dice X.'),
      assistantMessage(FROM_MEMORY), // after /new: docs are gone from context
      assistantMessage(CORRECTED),
    ]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema');
    await session.runTurn('¿qué haces tú?'); // reads docs
    session.reset(); // /new — context wiped, docs counter must not survive
    const answer = await session.runTurn('¿cómo timbro un CFDI?');
    expect(create).toHaveBeenCalledTimes(4); // the nudge fired post-reset
    expect(answer).toBe(CORRECTED);
  });

  it('nudges only once per session even if the model stays tool-less', async () => {
    const { client, create } = fakeClient([
      assistantMessage(FROM_MEMORY),
      assistantMessage(FROM_MEMORY), // corrective turn also refuses to use tools
      assistantMessage(FROM_MEMORY), // second user turn
    ]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema');
    await session.runTurn('¿cómo timbro un CFDI?');
    const second = await session.runTurn('¿y la nómina?');
    expect(create).toHaveBeenCalledTimes(3); // no second nudge
    expect(second).toBe(FROM_MEMORY);
  });

  it('does not nudge when the turn used a tool', async () => {
    const { client, create } = fakeClient([
      assistantMessage(null, [{ id: 'call_1', name: 'search_accounts', args: '{"search":"banco"}' }]),
      assistantMessage(FROM_MEMORY),
    ]);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema');
    const answer = await session.runTurn('¿qué cuenta uso?');
    expect(create).toHaveBeenCalledTimes(2); // loop only, no corrective turn
    expect(answer).toBe(FROM_MEMORY);
  });

  it('does not nudge short answers (greetings)', async () => {
    const { client, create } = fakeClient([assistantMessage('¡Hola! ¿En qué te ayudo?')]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema');
    await session.runTurn('hola');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('is force-disabled on tools:false channels', async () => {
    const { client, create } = fakeClient([assistantMessage(FROM_MEMORY)]);
    const session = new OpenAiCompatSession(
      client,
      { ...PROFILE, name: 'hermes-agent', tools: false },
      CTX,
      'sistema'
    );
    const answer = await session.runTurn('¿cómo timbro un CFDI?');
    expect(create).toHaveBeenCalledTimes(1); // nudging a channel with no tools is absurd
    expect(answer).toBe(FROM_MEMORY);
  });

  it('a read_docs earlier in the session exempts later tool-less turns', async () => {
    const { client, create } = fakeClient([
      assistantMessage(null, [{ id: 'c1', name: 'read_docs', args: '{"topic":"mnemosine"}' }]),
      assistantMessage('El doc dice X.'),
      assistantMessage(FROM_MEMORY), // follow-up turn, no tools
    ]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema');
    await session.runTurn('¿qué haces tú y qué hago yo?');
    const followUp = await session.runTurn('dame más detalle');
    expect(create).toHaveBeenCalledTimes(3); // no nudge on the follow-up
    expect(followUp).toBe(FROM_MEMORY);
  });
});

describe('grounding gate — MnemosineAgent (Anthropic runner)', () => {
  function fakeAnthropicClient(texts: string[]) {
    const toolRunnerCalls: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let call = 0;
    const client = {
      beta: {
        messages: {
          toolRunner: (params: { messages: Array<{ role: string; content: unknown }> }) => {
            toolRunnerCalls.push(params);
            const text = texts[Math.min(call, texts.length - 1)];
            call += 1;
            const final = { content: [{ type: 'text', text }], usage: undefined };
            return {
              async *[Symbol.asyncIterator]() {
                yield { on: () => {}, finalMessage: async () => final };
              },
              done: async () => final,
              params: {
                messages: [...params.messages, { role: 'assistant', content: final.content }],
              },
            };
          },
        },
      },
    } as unknown as Anthropic;
    return { client, toolRunnerCalls };
  }

  it('bounces a substantive tool-less answer and returns the corrected one', async () => {
    const { client, toolRunnerCalls } = fakeAnthropicClient([FROM_MEMORY, CORRECTED]);
    const agent = new MnemosineAgent(client, CTX, [{ type: 'text', text: 'sistema' }]);
    const answer = await agent.runTurn('¿cómo timbro un CFDI?');

    expect(toolRunnerCalls).toHaveLength(2);
    const secondMessages = toolRunnerCalls[1].messages;
    const lastUser = [...secondMessages].reverse().find((m) => m.role === 'user');
    const lastUserText = Array.isArray(lastUser?.content)
      ? (lastUser.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('')
      : String(lastUser?.content);
    expect(lastUserText).toBe(GROUNDING_NUDGE);
    expect(answer).toBe(CORRECTED);
  });

  it('does not nudge short answers and never nudges twice', async () => {
    const { client, toolRunnerCalls } = fakeAnthropicClient(['hola', FROM_MEMORY, FROM_MEMORY]);
    const agent = new MnemosineAgent(client, CTX, [{ type: 'text', text: 'sistema' }]);
    await agent.runTurn('hola'); // short → no nudge
    expect(toolRunnerCalls).toHaveLength(1);
    await agent.runTurn('¿cómo timbro?'); // long from-memory → nudge (2 calls)
    expect(toolRunnerCalls).toHaveLength(3);
    await agent.runTurn('¿y la nómina?'); // latch: no more nudges
    expect(toolRunnerCalls).toHaveLength(4);
  });

  it('can be disabled via options', async () => {
    const { client, toolRunnerCalls } = fakeAnthropicClient([FROM_MEMORY]);
    const agent = new MnemosineAgent(
      client,
      CTX,
      [{ type: 'text', text: 'sistema' }],
      {},
      'claude-opus-5',
      'anthropic',
      { grounding: { enabled: false } }
    );
    const answer = await agent.runTurn('¿cómo timbro un CFDI?');
    expect(toolRunnerCalls).toHaveLength(1);
    expect(answer).toBe(FROM_MEMORY);
  });

  // Turn shape helpers: the real BetaToolRunner leaves the loop's tool_use /
  // tool_result pairs in params.messages — the guard is fed from there.
  function toolTurn(text: string, isError: boolean, toolName = 'search_accounts') {
    return [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tu_1', name: toolName, input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu_1', content: 'r', ...(isError ? { is_error: true } : {}) },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text }] },
    ];
  }

  function fakeClientWithTurns(turns: Array<Array<{ role: string; content: unknown }>>) {
    const toolRunnerCalls: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
    let call = 0;
    const client = {
      beta: {
        messages: {
          toolRunner: (params: { messages: Array<{ role: string; content: unknown }> }) => {
            toolRunnerCalls.push(params);
            const appended = turns[Math.min(call, turns.length - 1)];
            call += 1;
            const last = appended[appended.length - 1];
            const final = { content: last.content, usage: undefined };
            return {
              async *[Symbol.asyncIterator]() {
                yield { on: () => {}, finalMessage: async () => final };
              },
              done: async () => final,
              params: { messages: [...params.messages, ...appended] },
            };
          },
        },
      },
    } as unknown as Anthropic;
    return { client, toolRunnerCalls };
  }

  it('a SUCCESSFUL tool in the runner history counts as grounding (no nudge)', async () => {
    const { client, toolRunnerCalls } = fakeClientWithTurns([toolTurn(FROM_MEMORY, false)]);
    const agent = new MnemosineAgent(client, CTX, [{ type: 'text', text: 'sistema' }]);
    const answer = await agent.runTurn('¿qué cuenta uso?');
    expect(toolRunnerCalls).toHaveLength(1); // grounded by the tool — no nudge
    expect(answer).toBe(FROM_MEMORY);
  });

  it('a tool_result with is_error does NOT count as grounding (nudge fires)', async () => {
    const { client, toolRunnerCalls } = fakeClientWithTurns([
      toolTurn(FROM_MEMORY, true),
      [{ role: 'assistant', content: [{ type: 'text', text: CORRECTED }] }],
    ]);
    const agent = new MnemosineAgent(client, CTX, [{ type: 'text', text: 'sistema' }]);
    const answer = await agent.runTurn('¿qué cuenta uso?');
    expect(toolRunnerCalls).toHaveLength(2); // failed tool grounded nothing
    expect(answer).toBe(CORRECTED);
  });

  it('a provider error during the corrective turn falls back to the original answer', async () => {
    let call = 0;
    const client = {
      beta: {
        messages: {
          toolRunner: (params: { messages: unknown[] }) => {
            call += 1;
            if (call === 2) throw Object.assign(new Error('overloaded'), { status: 529 });
            const final = { content: [{ type: 'text', text: FROM_MEMORY }], usage: undefined };
            return {
              async *[Symbol.asyncIterator]() {
                yield { on: () => {}, finalMessage: async () => final };
              },
              done: async () => final,
              params: { messages: [...(params.messages), { role: 'assistant', content: final.content }] },
            };
          },
        },
      },
    } as unknown as Anthropic;
    const agent = new MnemosineAgent(client, CTX, [{ type: 'text', text: 'sistema' }]);
    const answer = await agent.runTurn('¿cómo timbro un CFDI?');
    expect(answer).toBe(FROM_MEMORY); // completed turn not retro-failed
  });

  it('reset() re-arms the guard (/new wipes context AND guard state)', async () => {
    const { client, toolRunnerCalls } = fakeClientWithTurns([
      toolTurn('leído', false, 'read_docs'), // turn 1: session docs counter = 1
      [{ role: 'assistant', content: [{ type: 'text', text: FROM_MEMORY }] }],
      [{ role: 'assistant', content: [{ type: 'text', text: CORRECTED }] }],
    ]);
    const agent = new MnemosineAgent(client, CTX, [{ type: 'text', text: 'sistema' }]);
    await agent.runTurn('lee el doc');
    agent.reset();
    const answer = await agent.runTurn('¿cómo timbro un CFDI?');
    expect(toolRunnerCalls).toHaveLength(3); // post-reset nudge fired
    expect(answer).toBe(CORRECTED);
  });
});
