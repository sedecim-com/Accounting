import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));

import { OpenAiCompatSession } from '../../../src/ai/providers/openai-compat.js';
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
    const profile = { ...PROFILE, stream: undefined, stream_usage: false } as ResolvedProfile;
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
