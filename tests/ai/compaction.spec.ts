import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

import {
  anthropicView,
  buildFlushPrompt,
  buildSummarizationRequest,
  compactView,
  DEFAULT_KEEP_RECENT_TOKENS,
  ensureIdentifiersSurvive,
  estimateViewTokens,
  extractIdentifiers,
  FLUSH_MARKER,
  openAiView,
  planCompaction,
  shouldFlush,
  summaryMessageText,
  type CompactableMessage,
} from '../../src/ai/compaction.js';
import {
  computeCompactReport,
  formatCompactReport,
  transcriptView,
} from '../../src/cli/compact-command.js';
import { OpenAiCompatSession } from '../../src/ai/providers/openai-compat.js';
import { query } from '../../src/database/connection.js';
import type { AgentContext } from '../../src/ai/context.js';
import type { MessageRow } from '../../src/ai/session-store.js';
import type { ResolvedProfile, TurnUsage } from '../../src/ai/providers/types.js';
import type OpenAI from 'openai';

const mockQuery = query as unknown as Mock;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function m(
  role: CompactableMessage['role'],
  chars: number,
  flags: Partial<Pick<CompactableMessage, 'opensToolUse' | 'isToolResult'>> = {},
  text = 'x'.repeat(chars)
): CompactableMessage {
  return {
    role,
    chars,
    opensToolUse: flags.opensToolUse ?? false,
    isToolResult: flags.isToolResult ?? false,
    text,
  };
}

/** The invariant every cut must satisfy: no tool_use/tool_result pair split. */
function assertCleanCut(view: CompactableMessage[], cutIndex: number): void {
  expect(view[cutIndex]?.isToolResult ?? false).toBe(false);
  expect(view[cutIndex - 1]?.opensToolUse ?? false).toBe(false);
}

const UUID = '12345678-abcd-4ef0-9876-1234567890ab';
const RFC = 'SIN010101AB9';

// ------------------------------------------------------------
// planCompaction
// ------------------------------------------------------------

describe('planCompaction', () => {
  it('keeps the recent tail intact per keepRecentTokens', () => {
    // 6 plain messages of 400 chars (~100 tokens each).
    const view = Array.from({ length: 6 }, (_, i) =>
      m(i % 2 === 0 ? 'user' : 'assistant', 400)
    );
    const plan = planCompaction(view, { keepRecentTokens: 250 });
    expect(plan).not.toBeNull();
    // Tail must hold at least 250 tokens: 3 messages (100 each) kept.
    expect(plan!.cutIndex).toBe(3);
    expect(plan!.keepTokens).toBeGreaterThanOrEqual(250);
    expect(plan!.dropTokens).toBe(300);
  });

  it('returns null when the conversation fits in the tail budget', () => {
    const view = [m('user', 100), m('assistant', 100)];
    expect(planCompaction(view, { keepRecentTokens: 20000 })).toBeNull();
  });

  it('returns null rather than dropping a single message', () => {
    const view = [m('user', 4000), m('assistant', 40), m('user', 40), m('assistant', 40)];
    // Naive cut would drop only messages[0].
    expect(planCompaction(view, { keepRecentTokens: 40 })).toBeNull();
  });

  it('never cuts between a tool_use and its tool_result (Anthropic shape)', () => {
    // The naive cut (keep ~50 tokens) lands exactly between the second
    // tool_use and its tool_result — the plan must move earlier.
    const view = [
      m('user', 400),
      m('assistant', 400, { opensToolUse: true }),
      m('user', 400, { isToolResult: true }),
      m('assistant', 400, { opensToolUse: true }),
      m('user', 100, { isToolResult: true }),
      m('assistant', 100),
    ];
    const plan = planCompaction(view, { keepRecentTokens: 50 });
    expect(plan).not.toBeNull();
    assertCleanCut(view, plan!.cutIndex);
    expect(plan!.cutIndex).toBe(3);
  });

  it('walks back through chained tool results (OpenAI parallel tool calls)', () => {
    const view = [
      m('user', 400),
      m('assistant', 400),
      m('assistant', 40, { opensToolUse: true }),
      m('tool', 400, { isToolResult: true }),
      m('tool', 400, { isToolResult: true }),
      m('assistant', 80),
    ];
    // Naive cut lands between the two tool results.
    const plan = planCompaction(view, { keepRecentTokens: 120 });
    expect(plan).not.toBeNull();
    assertCleanCut(view, plan!.cutIndex);
    expect(plan!.cutIndex).toBe(2);
  });

  it('holds the pair invariant across adversarial fuzzed sequences', () => {
    let seed = 42;
    const rand = () => {
      // Deterministic LCG so failures reproduce.
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 200; round++) {
      const view: CompactableMessage[] = [m('user', Math.ceil(rand() * 800))];
      const len = 3 + Math.floor(rand() * 20);
      while (view.length < len) {
        if (rand() < 0.4) {
          view.push(m('assistant', Math.ceil(rand() * 800), { opensToolUse: true }));
          const results = 1 + Math.floor(rand() * 3);
          for (let i = 0; i < results; i++) {
            view.push(m('tool', Math.ceil(rand() * 800), { isToolResult: true }));
          }
        } else if (rand() < 0.5) {
          view.push(m('assistant', Math.ceil(rand() * 800)));
        } else {
          view.push(m('user', Math.ceil(rand() * 800)));
        }
      }
      const keep = Math.ceil(rand() * estimateViewTokens(view));
      const plan = planCompaction(view, { keepRecentTokens: keep });
      if (plan) assertCleanCut(view, plan.cutIndex);
    }
  });

  it('uses ~20k tokens as the default tail', () => {
    expect(DEFAULT_KEEP_RECENT_TOKENS).toBe(20000);
    const view = Array.from({ length: 10 }, () => m('user', 4000)); // ~10k tokens
    expect(planCompaction(view)).toBeNull();
  });
});

// ------------------------------------------------------------
// Views (provider projections)
// ------------------------------------------------------------

describe('views', () => {
  it('anthropicView counts thinking-block text toward the token estimate', () => {
    const view = anthropicView([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'T'.repeat(400) },
          { type: 'text', text: 'hi' },
        ],
      },
    ]);
    // Thinking blocks are replayed and billed as input on every later call:
    // leaving them out would fire auto-compaction too late (fail-open).
    expect(view[0].chars).toBeGreaterThanOrEqual(400);
  });

  it('anthropicView flags tool_use and tool_result blocks', () => {
    const view = anthropicView([
      { role: 'user', content: 'hola' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'searching' },
          { type: 'tool_use', name: 'search_accounts', input: { search: 'banco' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', content: [{ type: 'text', text: `cfdi ${UUID}` }] }],
      },
    ]);
    expect(view.map((v) => v.opensToolUse)).toEqual([false, true, false]);
    expect(view.map((v) => v.isToolResult)).toEqual([false, false, true]);
    expect(view[1].text).toContain('search_accounts');
    expect(view[2].text).toContain(UUID);
  });

  it('openAiView flags tool roles and tool_calls', () => {
    const view = openAiView([
      { role: 'user', content: 'hola' },
      { role: 'assistant', content: null, tool_calls: [{ function: { name: 'search_accounts', arguments: '{}' } }] },
      { role: 'tool', content: `rfc ${RFC}` },
      { role: 'assistant', content: 'done' },
    ]);
    expect(view.map((v) => v.opensToolUse)).toEqual([false, true, false, false]);
    expect(view.map((v) => v.isToolResult)).toEqual([false, false, true, false]);
    expect(view[2].text).toContain(RFC);
  });
});

// ------------------------------------------------------------
// Identifier policy 'strict'
// ------------------------------------------------------------

describe('identifier backstop', () => {
  it('extracts CFDI UUIDs and RFCs, deduplicated', () => {
    const text = `factura ${UUID} de ${RFC}, otra vez ${RFC} y ${UUID.toUpperCase()}`;
    expect(extractIdentifiers(text)).toEqual([UUID, RFC]);
  });

  it('appends missed identifiers to the summary on an Identifiers line', () => {
    const source = `The vendor ${RFC} issued CFDI ${UUID} for $1,160.00`;
    const summary = 'The vendor issued an invoice that was classified as rent expense.';
    const out = ensureIdentifiersSurvive(summary, source);
    expect(out).toContain(summary);
    expect(out).toMatch(/Identifiers: /);
    expect(out).toContain(UUID);
    expect(out).toContain(RFC);
  });

  it('leaves the summary untouched when every identifier survived', () => {
    const source = `CFDI ${UUID}`;
    const summary = `Recorded CFDI ${UUID} as paid.`;
    expect(ensureIdentifiersSurvive(summary, source)).toBe(summary);
  });

  it('los importes tienen backstop determinista (S1): el resumen que los tira los recupera', () => {
    // El hueco confesado de E5.1-c: «monetary amounts are protected by
    // instruction ONLY». En un agente contable el importe es la carga útil.
    const source = 'factura por 19720.00 con IVA de $3,155.20 sobre subtotal 1,234.56';
    expect(extractIdentifiers(source)).toEqual(['19720.00', '3,155.20', '1,234.56']);
    const out = ensureIdentifiersSurvive('resumen sin números.', source);
    expect(out).toContain('19720.00');
    expect(out).toContain('3,155.20');
    expect(out).toContain('1,234.56');
  });

  it('el regex de importes es deliberadamente conservador: tasas y números chicos no son dinero', () => {
    // Dos decimales y ≥3 dígitos (o miles): un backstop que re-adjunta cada
    // «16.00» de IVA engorda el resumen con ruido — la asimetría es a
    // propósito y el modelo sigue instruido a conservarlos todos.
    expect(extractIdentifiers('tasa 16.00 % y 0.08 de IEPS, versión 1.0.4')).toEqual([]);
    expect(extractIdentifiers('monto 928.00 pagado')).toEqual(['928.00']);
    // Dentro de otro número/token no se recorta un pedazo.
    expect(extractIdentifiers('cadena 123456.789')).toEqual([]);
  });

  it('matches RFCs with Ñ/& initial characters and lowercase (custom boundaries, not \\b)', () => {
    expect(extractIdentifiers('pago de ÑAB010101AB1 hoy')).toEqual(['ÑAB010101AB1']);
    expect(extractIdentifiers('proveedor &BC010101AB1.')).toEqual(['&BC010101AB1']);
    expect(extractIdentifiers('rfc sin010101ab9 en minusculas')).toEqual(['sin010101ab9']);
    // Embedded inside a longer token: not an RFC.
    expect(extractIdentifiers('XSIN010101AB9X')).toEqual([]);
  });

  it('extracts serie-folio tokens but never segments of an uppercase UUID', () => {
    expect(extractIdentifiers('factura F-2041 pendiente')).toEqual(['F-2041']);
    expect(extractIdentifiers('folio FAC-123')).toEqual(['FAC-123']);
    const upperUuid = '12345678-ABCD-4EF0-9876-1234567890AB';
    expect(extractIdentifiers(`cfdi ${upperUuid}`)).toEqual([upperUuid]);
  });

  it('backstops a dropped serie-folio like a UUID or RFC', () => {
    const source = 'Se registró la factura F-2041 como gasto.';
    const out = ensureIdentifiersSurvive('The invoice was recorded as an expense.', source);
    expect(out).toContain('F-2041');
  });

  it('strict instruction demands verbatim survival of SAT identifiers', () => {
    const req = buildSummarizationRequest('slice', { identifierPolicy: 'strict' });
    expect(req.instruction).toMatch(/VERBATIM/);
    expect(req.instruction).toMatch(/CFDI UUID/);
    expect(req.instruction).toMatch(/RFC/);
    expect(req.instruction).toMatch(/folio/);
    expect(req.instruction).toMatch(/draft id/);
    expect(req.instruction).toMatch(/amount/);
    expect(req.sourceText).toBe('slice');
  });
});

// ------------------------------------------------------------
// compactView orchestration
// ------------------------------------------------------------

describe('compactView', () => {
  it('replaces the dropped slice with one summary message and backstops identifiers', async () => {
    const messages = ['u1 ' + `cfdi ${UUID} `.padEnd(400, 'x'), 'a1 ' + 'y'.repeat(400), 'u2', 'a2'];
    const view: CompactableMessage[] = [
      m('user', 400, {}, messages[0]),
      m('assistant', 400, {}, messages[1]),
      m('user', 4, {}, 'u2'),
      m('assistant', 4, {}, 'a2'),
    ];
    const complete = vi.fn().mockResolvedValue('Summary without the folio.');
    const out = await compactView<string>({
      messages,
      view,
      keepRecentTokens: 2,
      complete,
      makeSummaryMessage: (text) => text,
    });
    expect(out).not.toBeNull();
    expect(out!.messages).toHaveLength(3);
    expect(out!.messages[0]).toContain('[COMPACTION SUMMARY]');
    expect(out!.messages[0]).toContain(UUID); // deterministic backstop
    expect(out!.messages.slice(1)).toEqual(['u2', 'a2']);
    expect(out!.result.droppedMessages).toBe(2);
    // The summarizer received the instruction + the dropped slice only.
    const [instruction, sourceText] = complete.mock.calls[0];
    expect(instruction).toMatch(/VERBATIM/);
    expect(sourceText).toContain(UUID);
    expect(sourceText).not.toContain('u2');
  });

  it('neutralizes the flush marker in the summarizer source text', async () => {
    const dropped = `flush prompt ${FLUSH_MARKER} please persist ${'x'.repeat(400)}`;
    const view: CompactableMessage[] = [
      m('user', 400, {}, dropped),
      m('assistant', 400, {}, 'a'.repeat(400)),
      m('user', 4, {}, 'u2'),
      m('assistant', 4, {}, 'a2'),
    ];
    const complete = vi.fn().mockResolvedValue('Summary.');
    await compactView<string>({
      messages: ['m0', 'm1', 'u2', 'a2'],
      view,
      keepRecentTokens: 2,
      complete,
      makeSummaryMessage: (t) => t,
    });
    const [, sourceText] = complete.mock.calls[0];
    // The raw marker must never reach the summarizer (a summary carrying it
    // would read as "already flushed" and suppress future flushes).
    expect(sourceText).not.toContain(FLUSH_MARKER);
    expect(sourceText).toContain('[memory-flush]');
  });

  it('returns null (and never calls the model) when there is nothing to compact', async () => {
    const complete = vi.fn();
    const out = await compactView<string>({
      messages: ['u1', 'a1'],
      view: [m('user', 2), m('assistant', 2)],
      keepRecentTokens: 20000,
      complete,
      makeSummaryMessage: (t) => t,
    });
    expect(out).toBeNull();
    expect(complete).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------
// Memory flush gating
// ------------------------------------------------------------

describe('memory flush', () => {
  it('flushes only after AI activity and only once per window', () => {
    expect(shouldFlush([m('user', 10)])).toBe(false); // no assistant turn yet
    expect(shouldFlush([m('user', 10), m('assistant', 10)])).toBe(true);
    const flushed = [m('user', 10), m('assistant', 10), m('user', 20, {}, buildFlushPrompt())];
    expect(shouldFlush(flushed)).toBe(false); // marker already in the window
  });

  it('flushes again in a NEW window after a previous flush turn', () => {
    const flushTurn = [
      m('user', 20, {}, buildFlushPrompt()),
      m('assistant', 10, {}, 'nothing to persist'),
    ];
    // The flush turn's own reply is not fresh activity.
    expect(shouldFlush([m('user', 10), m('assistant', 10), ...flushTurn])).toBe(false);
    // Assistant activity NEWER than the marker opens a new window.
    expect(shouldFlush([...flushTurn, m('user', 10), m('assistant', 10)])).toBe(true);
    // Only the slice after the LAST marker matters — a marker surviving in
    // the tail must not disable flushing forever.
    expect(
      shouldFlush([
        m('user', 10),
        ...flushTurn,
        m('user', 10),
        m('assistant', 10),
        ...flushTurn,
        m('user', 10),
        m('assistant', 10),
      ])
    ).toBe(true);
  });

  it('ignores tool traffic of the flush turn itself (no double flush)', () => {
    const view = [
      m('user', 10),
      m('assistant', 10),
      m('user', 20, {}, buildFlushPrompt()),
      m('assistant', 10, { opensToolUse: true }, '[tool_use ask_user] {}'),
      m('tool', 10, { isToolResult: true }, 'ok'),
      m('assistant', 10, {}, 'nothing to persist'),
    ];
    expect(shouldFlush(view)).toBe(false);
  });

  it('flush prompt routes persistence through the staged ask_user path', () => {
    const prompt = buildFlushPrompt();
    expect(prompt).toContain(FLUSH_MARKER);
    expect(prompt).toMatch(/ask_user/);
    expect(prompt).toMatch(/mnemosine questions/);
    expect(prompt).not.toMatch(/draft_journal_entry/); // no ledger writes invited
  });
});

// ------------------------------------------------------------
// OpenAiCompatSession integration (flush + compact + usage)
// ------------------------------------------------------------

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

function fakeClient(responses: Array<Record<string, unknown>>) {
  const create = vi.fn();
  for (const r of responses) create.mockResolvedValueOnce(r);
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, create };
}

function assistantMessage(content: string, usage?: Record<string, unknown>) {
  return {
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(usage ? { usage } : {}),
  };
}

describe('OpenAiCompatSession compaction', () => {
  beforeEach(() => mockQuery.mockReset());

  it('runs the flush turn once, then compacts the view, keeping the tail', async () => {
    const long = 'x'.repeat(4000); // ~1000 tokens: the old turn dominates
    const mid = 'y'.repeat(1000); // ~250 tokens: recent turn stays in the tail
    const { client, create } = fakeClient([
      assistantMessage(`a1 CFDI ${UUID} vendor ${RFC} ${long}`),
      assistantMessage(`a2 short answer ${mid}`),
      assistantMessage('nothing to persist'), // flush turn
      assistantMessage('Summary of the early conversation.'), // summarization
    ]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema', {}, {
      grounding: { enabled: false }, // these specs pin compaction call order
      compaction: { keepRecentTokens: 450 },
    });
    await session.runTurn(`u1 classify this invoice ${long}`);
    await session.runTurn(`u2 thanks ${mid}`);

    const result = await session.compact();
    expect(result).not.toBeNull();
    expect(result!.droppedMessages).toBe(2);
    // Backstop: the mocked summary dropped the identifiers — they must survive.
    expect(result!.summary).toContain(UUID);
    expect(result!.summary).toContain(RFC);

    // Call 3 was the flush turn: last message is the marker prompt, with the
    // STAGED tools (ask_user) still declared — no new direct-write tool.
    const flushParams = create.mock.calls[2][0];
    const flushLast = flushParams.messages[flushParams.messages.length - 1];
    expect(flushLast.role).toBe('user');
    expect(flushLast.content).toContain(FLUSH_MARKER);
    const toolNames = flushParams.tools.map((t: { function: { name: string } }) => t.function.name);
    expect(toolNames).toContain('ask_user');

    // Call 4 was the tool-less summarization with the strict instruction.
    const sumParams = create.mock.calls[3][0];
    expect(sumParams.tools).toBeUndefined();
    expect(sumParams.messages[0].role).toBe('system');
    expect(sumParams.messages[0].content).toMatch(/VERBATIM/);
    expect(sumParams.messages[1].content).toContain(UUID);

    // The next real turn ships summary + intact tail (u2/a2 + flush pair).
    create.mockResolvedValueOnce(assistantMessage('next'));
    await session.runTurn('u3');
    const nextParams = create.mock.calls[4][0];
    const texts = nextParams.messages.map((mm: { content?: unknown }) => String(mm.content ?? ''));
    expect(texts[1]).toContain('[COMPACTION SUMMARY]');
    expect(texts.some((t: string) => t.includes('u2 thanks'))).toBe(true);
    expect(texts.some((t: string) => t.startsWith('u1 classify'))).toBe(false);
  });

  it('does not repeat the flush when the window already carries the marker', async () => {
    const long = 'x'.repeat(4000);
    const mid = 'y'.repeat(1000);
    const { client, create } = fakeClient([
      assistantMessage(`a1 ${long}`),
      assistantMessage(`a2 ${mid}`),
      assistantMessage('nothing to persist'),
      assistantMessage('Summary.'),
    ]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema', {}, {
      grounding: { enabled: false }, // these specs pin compaction call order
      compaction: { keepRecentTokens: 450 },
    });
    await session.runTurn(`u1 ${long}`);
    await session.runTurn(`u2 ${mid}`);
    expect(await session.compact()).not.toBeNull();

    // Second /compact: marker is in the kept tail → no flush turn, and the
    // remaining window is too small to compact again.
    const callsBefore = create.mock.calls.length;
    const again = await session.compact();
    expect(again).toBeNull();
    expect(create.mock.calls.length).toBe(callsBefore);
  });

  it('every compaction window gets its own flush (two cycles both flush)', async () => {
    const long = 'x'.repeat(4000);
    const mid = 'y'.repeat(1000);
    const { client, create } = fakeClient([
      assistantMessage(`a1 ${long}`),
      assistantMessage(`a2 ${mid}`),
      assistantMessage('nothing to persist'), // flush 1
      assistantMessage('Summary one.'), // summarization 1
      assistantMessage(`a3 ${long}`),
      assistantMessage(`a4 ${mid}`),
      assistantMessage('nothing to persist'), // flush 2 — a marker surviving
      assistantMessage('Summary two.'), // in the view must not block this
    ]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema', {}, {
      grounding: { enabled: false }, // these specs pin compaction call order
      compaction: { keepRecentTokens: 450 },
    });
    await session.runTurn(`u1 ${long}`);
    await session.runTurn(`u2 ${mid}`);
    expect(await session.compact()).not.toBeNull();
    await session.runTurn(`u3 ${long}`);
    await session.runTurn(`u4 ${mid}`);
    expect(await session.compact()).not.toBeNull();

    // Both compaction cycles ran their own flush turn.
    const flushCalls = create.mock.calls.filter((c) => {
      const msgs = (c[0] as { messages: Array<{ content?: unknown }> }).messages;
      const last = msgs[msgs.length - 1];
      return typeof last.content === 'string' && last.content.includes(FLUSH_MARKER);
    });
    expect(flushCalls).toHaveLength(2);

    // Neutralization end-to-end: cycle 2's summarizer source covers the
    // first flush turn, but never carries the raw marker.
    const sumParams = create.mock.calls[7][0] as { messages: Array<{ role: string; content: string }> };
    expect(sumParams.messages[0].role).toBe('system');
    expect(sumParams.messages[1].content).not.toContain(FLUSH_MARKER);
    expect(sumParams.messages[1].content).toContain('[memory-flush]');
  });

  it('skips the flush turn entirely when there is nothing to compact', async () => {
    const { client, create } = fakeClient([assistantMessage('a1')]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema', {}, {
      grounding: { enabled: false }, // these specs pin compaction call order
      compaction: { keepRecentTokens: 20000 },
    });
    await session.runTurn('u1');
    const callsBefore = create.mock.calls.length;
    // Assistant activity exists, but the compaction would drop nothing:
    // burning a flush round-trip for a no-op is not allowed.
    expect(await session.compact()).toBeNull();
    expect(create.mock.calls.length).toBe(callsBefore);
  });

  it('auto-compacts before the turn when the threshold is exceeded', async () => {
    const long = 'x'.repeat(2000);
    const { client, create } = fakeClient([
      assistantMessage(`a1 ${long}`),
      assistantMessage(`a2 ${long}`),
      assistantMessage('nothing to persist'),
      assistantMessage('Summary.'),
      assistantMessage('answer'),
    ]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema', {}, {
      grounding: { enabled: false }, // these specs pin compaction call order
      compaction: { thresholdTokens: 1500, keepRecentTokens: 600 },
    });
    await session.runTurn(`u1 ${long}`); // ~1000 tokens: below threshold
    await session.runTurn(`u2 ${long}`); // still below at turn start
    const answer = await session.runTurn('u3'); // 2000 tokens in view → compact first
    expect(answer).toBe('answer');
    // The u3 request went out over a compacted history.
    const lastParams = create.mock.calls[create.mock.calls.length - 1][0];
    const texts = lastParams.messages.map((mm: { content?: unknown }) => String(mm.content ?? ''));
    expect(texts.some((t: string) => t.includes('[COMPACTION SUMMARY]'))).toBe(true);
    expect(texts.some((t: string) => t.startsWith('u1 '))).toBe(false);
  });

  it('threshold unset = automatic compaction off, however long the history', async () => {
    const long = 'x'.repeat(5000);
    const { client, create } = fakeClient([
      assistantMessage(`a1 ${long}`),
      assistantMessage('a2'),
    ]);
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema', {}, {
      grounding: { enabled: false }, // this spec counts model calls exactly
    });
    await session.runTurn(`u1 ${long}`);
    await session.runTurn('u2');
    // Only the two turn calls — no flush, no summarization.
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('normalizes OpenAI usage into the shared TurnUsage shape', async () => {
    const { client } = fakeClient([
      assistantMessage('hola', {
        prompt_tokens: 120,
        completion_tokens: 30,
        prompt_tokens_details: { cached_tokens: 100 },
      }),
    ]);
    const usages: TurnUsage[] = [];
    const session = new OpenAiCompatSession(client, PROFILE, CTX, 'sistema', {
      onUsage: (u) => usages.push(u),
    });
    await session.runTurn('hola');
    expect(usages).toEqual([
      {
        provider: 'hermes',
        model: 'Hermes-4-405B',
        inputTokens: 120,
        outputTokens: 30,
        cacheReadInputTokens: 100,
        cacheCreationInputTokens: undefined,
        // A2: el runner mide alrededor de la llamada; con el cliente mockeado
        // el reloj casi no avanza, pero el campo VIAJA.
        durationMs: expect.any(Number),
      },
    ]);
  });
});

// ------------------------------------------------------------
// compact-command (offline dry-run helpers)
// ------------------------------------------------------------

describe('compact-command helpers', () => {
  const row = (seq: number, role: MessageRow['role'], content: string, toolCalls: unknown = null): MessageRow =>
    ({
      id: `id-${seq}`,
      session_id: 'sess-1',
      seq,
      role,
      content,
      tool_name: null,
      tool_calls: toolCalls,
      token_count: null,
      created_at: new Date('2026-08-24T00:00:00Z'),
    });

  it('projects transcript rows and never splits assistant→tool sequences', () => {
    const rows = [
      row(1, 'user', 'x'.repeat(400)),
      row(2, 'tool', 'result '.repeat(60), { name: 'search_accounts', input: {} }),
      row(3, 'tool', 'result '.repeat(60), { name: 'get_trial_balance', input: {} }),
      row(4, 'assistant', 'a'.repeat(40)),
    ];
    const view = transcriptView(rows);
    expect(view.map((v) => v.isToolResult)).toEqual([false, true, true, false]);
    const report = computeCompactReport('sess-1', null, view, 120);
    if (report.plan) assertCleanCut(view, report.plan.cutIndex);
  });

  it('reports drop/keep numbers and renders the dry-run note', () => {
    const rows = Array.from({ length: 6 }, (_, i) =>
      row(i + 1, i % 2 === 0 ? 'user' : 'assistant', 'x'.repeat(400))
    );
    const report = computeCompactReport('sess-1', 'Cierre julio', transcriptView(rows), 250);
    expect(report.messages).toBe(6);
    expect(report.plan).not.toBeNull();
    expect(report.plan!.cutIndex).toBe(3);
    const id = (s: string) => s;
    const lines = formatCompactReport(report, { dim: id, bold: id, cyan: id }).join('\n');
    expect(lines).toContain('sess-1');
    expect(lines).toContain('summarize 3 older messages');
    expect(lines).toContain('/compact');
    expect(lines).toContain('never modified');
  });

  it('says so when there is nothing to compact', () => {
    const report = computeCompactReport('sess-1', null, transcriptView([row(1, 'user', 'hola')]), 20000);
    expect(report.plan).toBeNull();
    const id = (s: string) => s;
    const lines = formatCompactReport(report, { dim: id, bold: id, cyan: id }).join('\n');
    expect(lines).toContain('Nothing to compact');
  });
});

// ------------------------------------------------------------
// summaryMessageText
// ------------------------------------------------------------

describe('summaryMessageText', () => {
  it('labels the summary and points at the durable transcript', () => {
    const text = summaryMessageText('the summary');
    expect(text).toContain('[COMPACTION SUMMARY]');
    expect(text).toContain('full transcript');
    expect(text).toContain('the summary');
  });
});
