import Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from './context.js';
import { buildTools, type ToolObserver, type AskUserFn, type DraftCreatedInfo } from './tools/index.js';
import type { LlmSession, TurnRecord, TurnToolUse, TurnUsage } from './providers/types.js';
import {
  anthropicView,
  buildFlushPrompt,
  compactView,
  estimateViewTokens,
  planCompaction,
  shouldFlush,
  type CompactionConfig,
  type CompactionResult,
} from './compaction.js';
import { GroundingGuard, type GroundingOptions } from './grounding.js';

// ============================================================
// MNEMOSINE AGENT
// One instance per CLI session. Each user turn runs the SDK's
// BetaToolRunner (agentic loop: modelo → tools → modelo) with
// streaming; conversation history persists across turns so the
// prompt-cached prefix (system + historia) is reused.
// ============================================================

export const DEFAULT_MODEL = 'claude-opus-5';
const MAX_TOKENS = 16000;
const MAX_ITERATIONS = 25;

export interface AgentCallbacks {
  /** Called with each streamed text delta of the assistant's visible answer. */
  onText?: (delta: string) => void;
  /** Called when the agent invokes a tool (before it runs). */
  onToolUse?: ToolObserver;
  /** Interactive human channel for ask_user (chat mode only). */
  askUser?: AskUserFn;
  /** Harness hook: fires when the agent creates a draft (ingest thresholds). */
  onDraftCreated?: (info: DraftCreatedInfo) => void;
  /** Fires once at the end of each turn with the provider-independent record. */
  onTurnComplete?: (record: TurnRecord) => void;
  /** Fires once per completed MODEL CALL with normalized token counts. */
  onUsage?: (usage: TurnUsage) => void;
}

export interface AgentOptions {
  /** History compaction; automatic only when thresholdTokens is set. */
  compaction?: CompactionConfig;
  /** Grounding backstop (see grounding.ts); enabled by default. */
  grounding?: GroundingOptions;
  /** Lista blanca de herramientas (tools/superficie.ts); sin ella, todas. */
  herramientas?: readonly string[];
}

/** max_tokens of the tool-less summarization call during compaction. */
const SUMMARY_MAX_TOKENS = 4000;

export class MnemosineAgent implements LlmSession {
  readonly label: string;
  private messages: Anthropic.Beta.BetaMessageParam[] = [];
  private readonly tools: ReturnType<typeof buildTools>;
  // Shared with draft tools so ai_drafts.user_request records the actual
  // user turn that motivated each draft (audit trail).
  private readonly userRequestRef: { current?: string } = {};
  private readonly grounding: GroundingGuard;

  constructor(
    private readonly client: Anthropic,
    ctx: AgentContext,
    private readonly systemBlocks: Anthropic.Beta.BetaTextBlockParam[],
    private readonly callbacks: AgentCallbacks = {},
    private readonly model: string = DEFAULT_MODEL,
    private readonly providerName = 'anthropic',
    private readonly options: AgentOptions = {}
  ) {
    this.label = `${providerName} · ${model}`;
    this.grounding = new GroundingGuard(options.grounding);
    this.tools = buildTools(
      ctx,
      {
        model,
        observe: callbacks.onToolUse,
        userRequestRef: this.userRequestRef,
        askUser: callbacks.askUser,
        onDraftCreated: callbacks.onDraftCreated,
      },
      options.herramientas
    );
  }

  /**
   * Run one user turn through the agentic loop. Returns the final
   * assistant text (already streamed via onText, if provided).
   */
  async runTurn(userInput: string, signal?: AbortSignal): Promise<string> {
    // Auto-compaction happens BEFORE the new user message enters the view,
    // and only when a threshold is configured (default off).
    const threshold = this.options.compaction?.thresholdTokens;
    if (threshold !== undefined && estimateViewTokens(anthropicView(this.messages)) > threshold) {
      await this.compact(signal);
    }
    this.grounding.beginTurn();
    const text = await this.runLoop(userInput, false, signal);
    // Grounding backstop: a substantive answer produced with zero tool
    // calls (nothing read, nothing queried — pure memory) gets ONE
    // corrective turn. The nudge streams like any turn, so the user sees
    // the correction happen; the transcript records both (audit trail).
    if (this.grounding.needsNudge(text)) {
      this.grounding.beginTurn();
      if (this.callbacks.onText) this.callbacks.onText('\n\n');
      try {
        // userRequestOverride: drafts/questions born in the corrective run
        // are attributed to the REAL user request, never to the nudge text.
        return await this.runLoop(this.grounding.buildNudge(), false, signal, userInput);
      } catch (err) {
        // The original turn ALREADY completed, streamed, and was recorded:
        // a provider error during the extra verification call must not
        // retro-fail it (under failover it would even re-run the whole
        // turn on another provider). Abort stays cooperative, though.
        if (signal?.aborted) throw err;
        return text;
      }
    }
    return text;
  }

  /**
   * Manual compaction (`/compact` in the REPL) and the automatic path.
   * Runs the memory-flush turn first (once per window), then replaces the
   * older slice of the in-flight view with one summary message. The full
   * transcript in Postgres is untouched. Returns null when there is
   * nothing to compact.
   */
  async compact(signal?: AbortSignal): Promise<CompactionResult | null> {
    // Nothing to drop → no flush turn either: burning a model round-trip
    // (and injecting a prompt into the history) for a compaction that will
    // be a no-op helps nobody. compactView re-plans after the flush.
    const preView = anthropicView(this.messages);
    if (!planCompaction(preView, { keepRecentTokens: this.options.compaction?.keepRecentTokens })) {
      return null;
    }

    // Memory flush (item 12): one silent turn so the agent can persist
    // unsaved precedents through the STAGED tools before they leave the
    // model's view. Once per window (see shouldFlush).
    if (shouldFlush(preView)) {
      await this.runLoop(buildFlushPrompt(), true, signal);
    }

    const compacted = await compactView<Anthropic.Beta.BetaMessageParam>({
      messages: this.messages,
      view: anthropicView(this.messages),
      keepRecentTokens: this.options.compaction?.keepRecentTokens,
      identifierPolicy: this.options.compaction?.identifierPolicy,
      complete: (instruction, sourceText) => this.summarize(instruction, sourceText, signal),
      makeSummaryMessage: (text) => ({ role: 'user', content: [{ type: 'text', text }] }),
    });
    if (!compacted) return null;
    this.messages = compacted.messages;
    return compacted.result;
  }

  /** Tool-less, non-streaming summarization call for compaction. */
  private async summarize(
    instruction: string,
    sourceText: string,
    signal?: AbortSignal
  ): Promise<string> {
    const response = await this.client.beta.messages.create(
      {
        model: this.model,
        max_tokens: SUMMARY_MAX_TOKENS,
        system: instruction,
        messages: [{ role: 'user', content: sourceText }],
      },
      { signal }
    );
    const usage = response.usage;
    if (usage) this.emitUsage(usage);
    return extractText(response);
  }

  private emitUsage(usage: Anthropic.Beta.BetaUsage): void {
    this.callbacks.onUsage?.({
      provider: this.providerName,
      model: this.model,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? undefined,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? undefined,
    });
  }

  /**
   * The agentic loop shared by real user turns and the silent memory-flush
   * turn (silent = no text streaming; the turn record still fires so the
   * Postgres transcript keeps it).
   */
  private async runLoop(
    userInput: string,
    silent: boolean,
    signal?: AbortSignal,
    userRequestOverride?: string
  ): Promise<string> {
    this.userRequestRef.current = userRequestOverride ?? userInput;

    // Everything the runner appends from here on belongs to THIS turn —
    // the slice is what onTurnComplete summarizes.
    const turnStart = this.messages.length;

    // Move the message-level cache breakpoint to the end of the history: the
    // system breakpoint alone would leave every prior turn (and its tool
    // results) re-billed as uncached input on each request.
    stripCacheMarks(this.messages);
    this.messages.push({
      role: 'user',
      content: [{ type: 'text', text: userInput, cache_control: { type: 'ephemeral' } }],
    });

    const runner = this.client.beta.messages.toolRunner(
      {
        model: this.model,
        max_tokens: MAX_TOKENS,
        thinking: { type: 'adaptive' },
        system: this.systemBlocks,
        messages: this.messages,
        tools: this.tools,
        max_iterations: MAX_ITERATIONS,
        stream: true,
      },
      { signal }
    );

    for await (const stream of runner) {
      if (!silent && this.callbacks.onText) stream.on('text', this.callbacks.onText);
      const message = await stream.finalMessage();
      if (message.usage) this.emitUsage(message.usage);
    }

    const final = await runner.done();

    // Persist the runner's history as-is: it already ends with the assistant
    // message on every normal termination, and on the max_iterations exit it
    // ends with the tool_result user message — re-appending the assistant
    // message there would duplicate tool_use ids and 400 the next turn.
    this.messages = [...runner.params.messages];

    const text = extractText(final);
    const turnSlice = this.messages.slice(turnStart);
    // Feed the grounding guard from the settled history, not from a
    // pre-execution observer: only tool calls whose result came back
    // WITHOUT is_error actually put material in the model's context.
    for (const name of successfulToolNames(turnSlice)) {
      this.grounding.onToolUse(name);
    }
    this.callbacks.onTurnComplete?.({
      userInput,
      assistantText: text,
      // The runner's history already carries every tool_use/tool_result of
      // the loop: extracting from it avoids wrapping the tools' run().
      toolUses: collectToolUses(turnSlice),
    });
    return text;
  }

  /** Discard conversation history (\`/new\` in the REPL). */
  reset(): void {
    this.messages = [];
    // The docs the guard counted left the context with the history, and a
    // spent latch must not leave the fresh conversation unguarded.
    this.grounding.reset();
  }

  /** Real user turns — excludes the runner's tool_result carrier messages. */
  get turnCount(): number {
    return this.messages.filter(
      (m) =>
        m.role === 'user' &&
        (typeof m.content === 'string' || !m.content.some((b) => b.type === 'tool_result'))
    ).length;
  }
}

const RESULT_PREVIEW_CHARS = 500;

/**
 * Names of the tool calls whose tool_result came back without is_error —
 * the only ones that actually grounded the model in real material.
 */
function successfulToolNames(messages: Anthropic.Beta.BetaMessageParam[]): string[] {
  const nameById = new Map<string, string>();
  const names: string[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type === 'tool_use') {
        nameById.set(block.id, block.name);
      } else if (block.type === 'tool_result' && block.is_error !== true) {
        const name = nameById.get(block.tool_use_id);
        if (name) names.push(name);
      }
    }
  }
  return names;
}

/**
 * Pairs tool_use blocks (assistant messages) with their tool_result blocks
 * (the following user message, matched by id), in invocation order.
 */
function collectToolUses(messages: Anthropic.Beta.BetaMessageParam[]): TurnToolUse[] {
  const uses: TurnToolUse[] = [];
  const byId = new Map<string, TurnToolUse>();
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const block of m.content) {
      if (block.type === 'tool_use') {
        const use: TurnToolUse = { name: block.name, input: block.input, resultPreview: '' };
        uses.push(use);
        byId.set(block.id, use);
      } else if (block.type === 'tool_result') {
        const use = byId.get(block.tool_use_id);
        if (use) use.resultPreview = previewToolResult(block.content);
      }
    }
  }
  return uses;
}

function previewToolResult(content: unknown): string {
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((b) =>
              b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''
            )
            .join('')
        : content == null
          ? ''
          : JSON.stringify(content);
  return text.slice(0, RESULT_PREVIEW_CHARS);
}

function stripCacheMarks(messages: Anthropic.Beta.BetaMessageParam[]): void {
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const block of m.content) {
      if ('cache_control' in block && block.cache_control) {
        delete (block as { cache_control?: unknown }).cache_control;
      }
    }
  }
}

function extractText(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}
