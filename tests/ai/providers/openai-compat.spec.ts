import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { OpenAiCompatSession, TruncatedEmptyTurnError } from '../../../src/ai/providers/openai-compat.js';
import { query } from '../../../src/database/connection.js';
import type { AgentContext } from '../../../src/ai/context.js';
import type { ResolvedProfile } from '../../../src/ai/providers/types.js';
import type OpenAI from 'openai';

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
  stream: false, // deterministic for tests
  apiKey: 'sk-test',
};

function fakeClient(responses: Array<Record<string, unknown>>) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, create };
}

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

describe('OpenAiCompatSession', () => {
  beforeEach(() => mockQuery.mockReset());

  it('declares the accounting tools as OpenAI function specs', async () => {
    const { client, create } = fakeClient([assistantMessage('hola')]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema');
    await session.runTurn('hola');

    const params = create.mock.calls[0][0];
    expect(params.model).toBe('Hermes-4-405B');
    expect(params.messages[0]).toEqual({ role: 'system', content: 'sistema' });
    const toolNames = params.tools.map((t: { function: { name: string } }) => t.function.name);
    expect(toolNames).toEqual(expect.arrayContaining(['search_accounts', 'draft_journal_entry', 'get_trial_balance']));
    const searchAccounts = params.tools.find((t: { function: { name: string } }) => t.function.name === 'search_accounts');
    expect(searchAccounts.function.parameters.type).toBe('object');
  });

  it('runs the tool loop: executes the tool and feeds the result back', async () => {
    const { client, create } = fakeClient([
      assistantMessage(null, [{ id: 'call_1', name: 'search_accounts', args: '{"search":"banco"}' }]),
      assistantMessage('La cuenta es 1110 Bancos.'),
    ]);
    mockQuery.mockResolvedValueOnce({
      rows: [{ code: '1110', name: 'Bancos', account_type: 'asset', account_subtype: null, normal_balance: 'debit', allow_manual_entries: true, fs_category: null }],
    });

    const seen: string[] = [];
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema', {
      onToolUse: (name) => seen.push(name),
    });
    const answer = await session.runTurn('¿qué cuenta uso para bancos?');

    expect(answer).toBe('La cuenta es 1110 Bancos.');
    expect(seen).toEqual(['search_accounts']);

    // Second request must include assistant tool_calls + tool result
    const secondParams = create.mock.calls[1][0];
    const roles = secondParams.messages.map((m: { role: string }) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool']);
    const toolMsg = secondParams.messages[3];
    expect(toolMsg.tool_call_id).toBe('call_1');
    expect(toolMsg.content).toMatch(/1110/);
  });

  it('returns malformed tool arguments to the model as an error result', async () => {
    const { client, create } = fakeClient([
      assistantMessage(null, [{ id: 'call_1', name: 'search_accounts', args: '{not json' }]),
      assistantMessage('ok'),
    ]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema');
    await session.runTurn('x');
    const toolMsg = create.mock.calls[1][0].messages[3];
    expect(toolMsg.content).toMatch(/are not valid JSON/);
  });

  it('handles unknown tools without crashing the loop', async () => {
    const { client, create } = fakeClient([
      assistantMessage(null, [{ id: 'call_1', name: 'no_existe', args: '{}' }]),
      assistantMessage('ok'),
    ]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema');
    await session.runTurn('x');
    const toolMsg = create.mock.calls[1][0].messages[3];
    expect(toolMsg.content).toMatch(/does not exist/);
  });

  it('with tools:false declares nothing and warns in the system prompt', async () => {
    const { client, create } = fakeClient([assistantMessage('hola')]);
    const session = new OpenAiCompatSession(
      client,
      { ...PROFILE, name: 'hermes-agent', model: 'hermes-agent', tools: false },
      CTX,
      'sistema'
    );
    await session.runTurn('hola');
    const params = create.mock.calls[0][0];
    expect(params.tools).toBeUndefined();
    expect(params.messages[0].content).toMatch(/NO access to ANY tool/);
    expect(params.messages[0].content).toMatch(/ignore the protocol/);
  });

  it('stops at max_iterations and leaves resumable history', async () => {
    const loop = assistantMessage(null, [{ id: 'c', name: 'no_existe', args: '{}' }]);
    const { client, create } = fakeClient([loop, loop, loop]);
    const session = new OpenAiCompatSession(client, { ...PROFILE, max_iterations: 3 }, CTX, 'sistema');
    const answer = await session.runTurn('x');
    expect(create).toHaveBeenCalledTimes(3);
    expect(answer).toMatch(/Maximum tool iterations/);
  });

  it('streamed requests ask for usage via stream_options.include_usage by default', async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: 'hola' } }] };
      yield { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2 } };
    }
    const create = vi.fn().mockResolvedValueOnce(chunks());
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const usages: unknown[] = [];
    const session = new OpenAiCompatSession(client, { ...PROFILE, stream: undefined }, CTX, 'sistema', {
      onUsage: (u) => usages.push(u),
    });
    await session.runTurn('x');
    const params = create.mock.calls[0][0];
    expect(params.stream).toBe(true);
    expect(params.stream_options).toEqual({ include_usage: true });
    expect(usages).toHaveLength(1); // the final-chunk usage reached the ledger
  });

  it('omits stream_options when the profile opts out with stream_usage: false', async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: 'hola' } }] };
    }
    const create = vi.fn().mockResolvedValueOnce(chunks());
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    // Old local servers 400 on unknown fields: the profile can opt out.
    // stream_usage is a field of ProviderProfile: no cast needed.
    const profile: ResolvedProfile = { ...PROFILE, stream: undefined, stream_usage: false };
    const session = new OpenAiCompatSession(client, profile, CTX, 'sistema');
    await session.runTurn('x');
    expect(create.mock.calls[0][0].stream_options).toBeUndefined();
  });

  it('never sends stream_options on non-streamed requests', async () => {
    const { client, create } = fakeClient([assistantMessage('hola')]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema'); // stream: false
    await session.runTurn('x');
    expect(create.mock.calls[0][0].stream_options).toBeUndefined();
  });

  it('accumulates streamed tool-call deltas across chunks', async () => {
    async function* chunks() {
      yield { choices: [{ delta: { content: 'Consulto… ' } }] };
      // The name arrives whole; some servers RESEND it in every chunk
      // (which is why it is assigned, not concatenated). The arguments do arrive in parts.
      yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_9', function: { name: 'search_accounts', arguments: '{"sea' } }] } }] };
      yield { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search_accounts', arguments: 'rch":"banco"}' } }] } }] };
    }
    const create = vi.fn()
      .mockResolvedValueOnce(chunks())
      .mockResolvedValueOnce(assistantMessage('listo'));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    mockQuery.mockResolvedValueOnce({ rows: [] });
    const deltas: string[] = [];
    const session = new OpenAiCompatSession(
      client,
      { ...PROFILE, stream: undefined }, // streaming by default…
      CTX,
      'sistema',
      { onText: (d) => deltas.push(d) }
    );
    // …first call streams, second call (after tool) also streams; make the
    // second response non-stream shaped by flipping the profile? Instead:
    // emulate second call returning an async iterable with only content.
    create.mockReset();
    async function* finalChunks() {
      yield { choices: [{ delta: { content: 'listo' } }] };
    }
    create.mockResolvedValueOnce(chunks()).mockResolvedValueOnce(finalChunks());

    const answer = await session.runTurn('x');
    expect(answer).toBe('listo');
    expect(deltas.join('')).toBe('Consulto… listo');
    // The accumulated tool call was executed (query ran) with merged name+args
    const secondParams = create.mock.calls[1][0];
    const assistantMsg = secondParams.messages.find((m: { role: string }) => m.role === 'assistant');
    expect(assistantMsg.tool_calls[0].function.name).toBe('search_accounts');
    expect(assistantMsg.tool_calls[0].function.arguments).toBe('{"search":"banco"}');
  });
});

// ============================================================
// MNE-001-442 · what current models need from the compatible adapter
// ============================================================

/** A fake thought signature: opaque bytes, as Google documents them. */
const SIGNATURE = 'CiQBjz1rX+firma/falsa==Zq8-_0';

/**
 * A Gemini 3 tool-call response on Google's OpenAI-compatible endpoint, in the
 * shape Google documents (ai.google.dev/gemini-api/docs/thought-signatures,
 * «OpenAI compatibility»): the first call of a step carries
 * extra_content.google.thought_signature; a parallel call after it carries none.
 */
function geminiToolCalls() {
  return {
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              extra_content: { google: { thought_signature: SIGNATURE } },
              function: { arguments: '{"search":"banco"}', name: 'search_accounts' },
              id: 'function-call-1',
              type: 'function',
            },
            {
              function: { arguments: '{"search":"caja"}', name: 'search_accounts' },
              id: 'function-call-2',
              type: 'function',
            },
          ],
        },
      },
    ],
  };
}

type SentMessage = { role: string; tool_calls?: Array<Record<string, unknown>> };
const assistantSent = (params: unknown) =>
  (params as { messages: SentMessage[] }).messages.find((m) => m.role === 'assistant' && m.tool_calls);

describe('reasoning_effort goes in the body only when the profile declares it', () => {
  beforeEach(() => mockQuery.mockReset());

  it('absent from turns when the profile does not declare it', async () => {
    const { client, create } = fakeClient([assistantMessage('hola')]);
    await new OpenAiCompatSession(client, PROFILE, CTX, 'sistema').runTurn('x');
    expect('reasoning_effort' in create.mock.calls[0][0]).toBe(false);
  });

  it('on every turn and on the compaction summary when it does', async () => {
    const create = vi.fn().mockResolvedValue(assistantMessage('respuesta corta'));
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const session = new OpenAiCompatSession(
      client, { ...PROFILE, reasoning_effort: 'low' }, CTX, 'sistema', {},
      { compaction: { keepRecentTokens: 1 }, grounding: { enabled: false } }
    );
    await session.runTurn('primera');
    await session.runTurn('segunda');
    expect(await session.compact()).not.toBeNull();

    const bodies = create.mock.calls.map((c) => c[0] as { reasoning_effort?: string; tools?: unknown });
    const summaries = bodies.filter((b) => b.tools === undefined);
    expect(summaries.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body.reasoning_effort).toBe('low');
  });
});

describe('Gemini 3 thought signatures come back byte for byte', () => {
  beforeEach(() => mockQuery.mockReset());

  it('non-streamed: the next request carries each tool call\'s extra_content unchanged', async () => {
    const { client, create } = fakeClient([geminiToolCalls(), assistantMessage('listo')]);
    mockQuery.mockResolvedValue({ rows: [] });
    await new OpenAiCompatSession(client, PROFILE, CTX, 'sistema').runTurn('x');

    const sent = assistantSent(create.mock.calls[1][0]);
    expect(sent?.tool_calls?.[0]).toEqual({
      id: 'function-call-1',
      type: 'function',
      function: { name: 'search_accounts', arguments: '{"search":"banco"}' },
      extra_content: { google: { thought_signature: SIGNATURE } },
    });
    expect((sent?.tool_calls?.[0].extra_content as { google: { thought_signature: string } }).google.thought_signature)
      .toBe(SIGNATURE);
    // A call that brought none gets none.
    expect('extra_content' in (sent?.tool_calls?.[1] ?? {})).toBe(false);
  });

  it('streamed: the signature in the call\'s delta is kept and sent back', async () => {
    async function* chunks() {
      yield {
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            tool_calls: [{
              index: 0, id: 'function-call-1', type: 'function',
              function: { name: 'search_accounts', arguments: '{"search":"banco"}' },
              extra_content: { google: { thought_signature: SIGNATURE } },
            }],
          },
        }],
      };
      yield { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] };
    }
    async function* final() {
      yield { choices: [{ index: 0, delta: { content: 'listo' }, finish_reason: 'stop' }] };
    }
    const create = vi.fn().mockResolvedValueOnce(chunks()).mockResolvedValueOnce(final());
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    mockQuery.mockResolvedValue({ rows: [] });
    await new OpenAiCompatSession(client, { ...PROFILE, stream: undefined }, CTX, 'sistema').runTurn('x');

    const sent = assistantSent(create.mock.calls[1][0]);
    expect(sent?.tool_calls?.[0].extra_content).toEqual({ google: { thought_signature: SIGNATURE } });
  });
});

describe('a turn cut by the output cap with nothing in it is an error', () => {
  beforeEach(() => mockQuery.mockReset());
  const truncated = (content: string | null) => ({
    choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content } }],
  });

  it('non-streamed: throws a typed error naming the cap and the profile\'s reasoning_effort', async () => {
    const { client } = fakeClient([truncated(null)]);
    const session = new OpenAiCompatSession(client, { ...PROFILE, reasoning_effort: 'high' }, CTX, 'sistema');
    const err = await session.runTurn('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TruncatedEmptyTurnError);
    expect((err as Error).message).toContain('8192');
    expect((err as Error).message).toContain('hermes');
    expect((err as Error).message).toContain('reasoning_effort "high"');
  });

  it('streamed: same error', async () => {
    async function* chunks() {
      yield { choices: [{ index: 0, delta: { role: 'assistant' } }] };
      yield { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] };
    }
    const create = vi.fn().mockResolvedValueOnce(chunks());
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const session = new OpenAiCompatSession(client, { ...PROFILE, stream: undefined }, CTX, 'sistema');
    await expect(session.runTurn('x')).rejects.toBeInstanceOf(TruncatedEmptyTurnError);
  });

  it('a truncated turn WITH text is returned as before', async () => {
    const { client } = fakeClient([truncated('media respuesta')]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema', {}, { grounding: { enabled: false } });
    expect(await session.runTurn('x')).toBe('media respuesta');
  });
});
