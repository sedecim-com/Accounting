import OpenAI from 'openai';
import type { AgentContext } from '../context.js';
import { buildTools } from '../tools/index.js';
import type { LlmSession, ResolvedProfile, SessionCallbacks, TurnToolUse } from './types.js';
import {
  buildFlushPrompt,
  compactView,
  DEFAULT_KEEP_RECENT_TOKENS,
  estimateViewTokens,
  openAiView,
  planCompaction,
  shouldFlush,
  type CompactionConfig,
  type CompactionResult,
} from '../compaction.js';
import {
  compactacionParaPerfil,
  MAX_DESCARGAS_MEMORIA_POR_SESION,
  type ResolvedCompactionConfig,
} from './config.js';
import { GroundingGuard, type GroundingOptions } from '../grounding.js';

// ============================================================
// OPENAI-COMPATIBLE PROVIDER
// A single adapter covers: Nous Portal (Hermes 4), Hermes Agent
// gateway, Ollama, LM Studio, vLLM, OpenAI, Groq, etc. — anything
// that speaks Chat Completions. The harness owns the agentic
// loop: the model requests tool calls, the accounting tools are
// executed here and the results are fed back.
// ============================================================

const DEFAULT_MAX_ITERATIONS = 25;
const MAX_TOKENS = 8192;
const RESULT_PREVIEW_CHARS = 500;

/** Tool input for the turn record: parsed JSON, or the raw string if invalid. */
function parseArgsForRecord(raw: string): unknown {
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return raw;
  }
}

// Minimal structural shape of the harness tools (betaZodTool objects
// satisfy it: name/description/input_schema JSON Schema + run/parse) —
// this way the adapter does not depend on Anthropic types.
interface RunnableToolLike {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run: (args: any) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parse: (content: unknown) => any;
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface OpenAiCompatSessionOptions {
  /**
   * History compaction; automatic only when thresholdTokens is set.
   *
   * `umbralDerivable` lo pone resolveCompactionConfig cuando el archivo del
   * operador NO fijó `threshold_tokens`, y es lo único que autoriza a este
   * runner a sustituir el umbral global por el que se deriva de la ventana de
   * su perfil. Quien construya la sesión a mano y pase un umbral sin esa
   * bandera manda igual que el operador.
   */
  compaction?: CompactionConfig & Pick<ResolvedCompactionConfig, 'umbralDerivable'>;
  /** Directorio del mnemosine.config.json para resolver la ventana del perfil. */
  cwd?: string;
  /** Grounding backstop (see grounding.ts); enabled by default. */
  grounding?: GroundingOptions;
  /** Lista blanca de herramientas (tools/superficie.ts); sin ella, todas. */
  herramientas?: readonly string[];
}

export class OpenAiCompatSession implements LlmSession {
  readonly label: string;
  private history: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  private readonly tools: RunnableToolLike[];
  private readonly toolSpecs: OpenAI.Chat.Completions.ChatCompletionTool[] | undefined;
  private readonly maxIterations: number;
  private readonly userRequestRef: { current?: string } = {};
  private readonly grounding: GroundingGuard;
  /**
   * La compactación EFECTIVA de esta sesión: la del archivo del operador si la
   * fijó, y si no la derivada de la ventana que declara el perfil. Se resuelve
   * UNA VEZ, al construir: releerla en cada turno haría que un cambio del
   * archivo a mitad de sesión moviera el umbral bajo los pies del historial
   * que ya se acumuló.
   */
  private readonly compactacion: ResolvedCompactionConfig;
  /**
   * Turnos de descarga de memoria ya corridos en ESTA sesión, y su tope.
   * El tope es la decisión de autonomía que config.ts declara junto a
   * MAX_DESCARGAS_MEMORIA_POR_SESION: la frecuencia con la que el sistema
   * escribe memoria no puede depender de lo pequeña que sea la ventana del
   * perfil — y es este runner, con ollama, el que la tenía multiplicada por 27.
   */
  private descargasDeMemoria = 0;
  private readonly maxDescargasDeMemoria: number;
  /** True while the silent memory-flush turn runs (mutes onText). */
  private muteText = false;

  constructor(
    private readonly client: OpenAI,
    private readonly profile: ResolvedProfile,
    ctx: AgentContext,
    private readonly systemText: string,
    private readonly callbacks: SessionCallbacks = {},
    private readonly options: OpenAiCompatSessionOptions = {}
  ) {
    this.label = `${profile.name} · ${profile.model}`;
    this.maxIterations = profile.max_iterations ?? DEFAULT_MAX_ITERATIONS;
    this.compactacion = compactacionParaPerfil(
      profile.name,
      options.compaction ?? {},
      DEFAULT_KEEP_RECENT_TOKENS,
      options.cwd
    );
    this.maxDescargasDeMemoria =
      this.compactacion.maxDescargasMemoria ?? MAX_DESCARGAS_MEMORIA_POR_SESION;
    // A tools:false channel CANNOT ground itself (its note already says so):
    // nudging it would demand the impossible. Force-disable the guard there.
    this.grounding = new GroundingGuard(
      profile.tools === false ? { ...options.grounding, enabled: false } : options.grounding
    );

    if (profile.tools === false) {
      this.tools = [];
      this.toolSpecs = undefined;
      this.systemText +=
        '\n\nCHANNEL NOTE: in this session you have NO access to ANY tool (neither read_docs ' +
        'nor accounting queries) — ignore the protocol and any rules that ask you to call them. Do not cite ' +
        'figures, endpoints or flows as if they were real; make that clear when applicable.';
    } else {
      this.tools = buildTools(
        ctx,
        {
          model: profile.model,
          observe: callbacks.onToolUse,
          userRequestRef: this.userRequestRef,
          askUser: callbacks.askUser,
          onDraftCreated: callbacks.onDraftCreated,
        },
        options.herramientas
      ) as unknown as RunnableToolLike[];
      this.toolSpecs = this.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.input_schema,
        },
      }));
    }
  }

  async runTurn(userInput: string, signal?: AbortSignal): Promise<string> {
    // Auto-compaction happens BEFORE the new user message enters the view,
    // and only when a threshold is configured (default off).
    const threshold = this.compactacion.thresholdTokens;
    if (threshold !== undefined && estimateViewTokens(openAiView(this.history)) > threshold) {
      await this.compact(signal);
    }
    this.grounding.beginTurn();
    const text = await this.runLoop(userInput, signal);
    // Grounding backstop: a substantive answer produced with zero tool
    // calls (nothing read, nothing queried — pure memory) gets ONE
    // corrective turn. See grounding.ts.
    if (this.grounding.needsNudge(text)) {
      this.grounding.beginTurn();
      if (!this.muteText) this.callbacks.onText?.('\n\n');
      try {
        // userRequestOverride: drafts/questions born in the corrective run
        // are attributed to the REAL user request, never to the nudge text.
        return await this.runLoop(this.grounding.buildNudge(), signal, userInput);
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
   * Manual compaction (`/compact`) and the automatic path: memory-flush
   * turn first (once per window, through the STAGED tools only), then the
   * older slice of the in-flight history is replaced by one summary
   * message. The Postgres transcript is untouched. Returns null when
   * there is nothing to compact.
   */
  async compact(signal?: AbortSignal): Promise<CompactionResult | null> {
    // Nothing to drop → no flush turn either (a flush for a no-op
    // compaction wastes a round-trip). compactView re-plans after the flush.
    const preView = openAiView(this.history);
    if (!planCompaction(preView, { keepRecentTokens: this.compactacion.keepRecentTokens })) {
      return null;
    }

    // Once per window (shouldFlush) y como mucho maxDescargasDeMemoria veces
    // por sesión: config.ts declara la medición y por qué el tope existe.
    if (shouldFlush(preView) && this.descargasDeMemoria < this.maxDescargasDeMemoria) {
      this.descargasDeMemoria++;
      this.muteText = true;
      try {
        await this.runLoop(buildFlushPrompt(), signal);
      } finally {
        this.muteText = false;
      }
    }

    const compacted = await compactView<OpenAI.Chat.Completions.ChatCompletionMessageParam>({
      messages: this.history,
      view: openAiView(this.history),
      keepRecentTokens: this.compactacion.keepRecentTokens,
      identifierPolicy: this.compactacion.identifierPolicy,
      complete: (instruction, sourceText) => this.summarize(instruction, sourceText, signal),
      makeSummaryMessage: (text) => ({ role: 'user', content: text }),
    });
    if (!compacted) return null;
    this.history = compacted.messages;
    return compacted.result;
  }

  /** Tool-less, non-streaming summarization call for compaction. */
  private async summarize(
    instruction: string,
    sourceText: string,
    signal?: AbortSignal
  ): Promise<string> {
    const summarizeStart = Date.now();
    const response = await this.client.chat.completions.create(
      {
        model: this.profile.model,
        messages: [
          { role: 'system', content: instruction },
          { role: 'user', content: sourceText },
        ],
        ...this.tokenLimitParam(),
        stream: false,
      },
      { signal }
    );
    if (response.usage) this.emitUsage(response.usage, Date.now() - summarizeStart);
    return response.choices[0]?.message?.content ?? '';
  }

  private emitUsage(usage: OpenAI.Completions.CompletionUsage, durationMs?: number): void {
    this.callbacks.onUsage?.({
      provider: this.profile.name,
      model: this.profile.model,
      inputTokens: usage.prompt_tokens ?? 0,
      outputTokens: usage.completion_tokens ?? 0,
      cacheReadInputTokens: usage.prompt_tokens_details?.cached_tokens ?? undefined,
      durationMs,
    });
  }

  private tokenLimitParam(): Record<string, number> {
    return this.profile.max_tokens_param === 'max_completion_tokens'
      ? { max_completion_tokens: MAX_TOKENS }
      : { max_tokens: MAX_TOKENS };
  }

  private async runLoop(
    userInput: string,
    signal?: AbortSignal,
    userRequestOverride?: string
  ): Promise<string> {
    this.userRequestRef.current = userRequestOverride ?? userInput;
    this.history.push({ role: 'user', content: userInput });

    // Provider-independent record of the turn for onTurnComplete: the loop
    // has the results in hand, so they are captured as they happen.
    const toolUses: TurnToolUse[] = [];
    const finishTurn = (assistantText: string): string => {
      this.callbacks.onTurnComplete?.({ userInput, assistantText, toolUses });
      return assistantText;
    };

    let lastContent = '';
    for (let iteration = 0; iteration < this.maxIterations; iteration++) {
      const { content, toolCalls } = await this.complete(signal);
      lastContent = content;

      if (toolCalls.length === 0) {
        this.history.push({ role: 'assistant', content });
        return finishTurn(content);
      }

      this.history.push({
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });

      for (const tc of toolCalls) {
        const result = await this.executeTool(tc);
        toolUses.push({
          name: tc.name,
          input: parseArgsForRecord(tc.arguments),
          resultPreview: result.slice(0, RESULT_PREVIEW_CHARS),
        });
        this.history.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        });
      }
    }

    // Iteration cap: history ends in tool results, which is valid to resume.
    return finishTurn(
      lastContent || '(Maximum tool iterations reached without a final answer.)'
    );
  }

  reset(): void {
    this.history = [];
    // El tope de descargas es POR SESIÓN, y reset() empieza una: un tope gastado
    // dejaría a la conversación nueva sin barrido de criterio ninguno.
    this.descargasDeMemoria = 0;
    // The docs the guard counted left the context with the history, and a
    // spent latch must not leave the fresh conversation unguarded.
    this.grounding.reset();
  }

  private async executeTool(tc: AccumulatedToolCall): Promise<string> {
    const tool = this.tools.find((t) => t.name === tc.name);
    if (!tool) return `Error: tool "${tc.name}" does not exist`;

    let args: unknown;
    try {
      args = tc.arguments.trim() ? JSON.parse(tc.arguments) : {};
    } catch {
      return `Error: the arguments of ${tc.name} are not valid JSON`;
    }

    try {
      // Tools already notify onToolUse internally (buildTools observer)
      const parsed = tool.parse(args);
      const result = await tool.run(parsed);
      // Grounding counts only SUCCESSFUL executions: a tool that threw put
      // no material in the model's context (see grounding.ts).
      this.grounding.onToolUse(tc.name);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      // Same contract as the Anthropic runner: the error goes back to the
      // model as a result so it can correct and retry.
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /** One model call; accumulates streaming if the profile allows it. */
  private async complete(
    signal?: AbortSignal
  ): Promise<{ content: string; toolCalls: AccumulatedToolCall[] }> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: this.systemText },
      ...this.history,
    ];
    // OpenAI deprecates max_tokens (reasoning models reject it with 400)
    // but old local servers do not accept max_completion_tokens: the profile
    // chooses; default max_tokens which is what Ollama/Nous/LM Studio accept.
    const limit = this.tokenLimitParam();
    const base = {
      model: this.profile.model,
      messages,
      ...limit,
      ...(this.toolSpecs ? { tools: this.toolSpecs } : {}),
    };

    // A2: la duración de la llamada, del create al último chunk — la
    // granularidad de la fila de ai_usage.
    const llamadaInicio = Date.now();

    if (this.profile.stream === false) {
      const response = await this.client.chat.completions.create(
        { ...base, stream: false },
        { signal }
      );
      const choice = response.choices[0];
      if (response.usage) this.emitUsage(response.usage, Date.now() - llamadaInicio);
      const content = choice?.message?.content ?? '';
      if (content && !this.muteText) this.callbacks.onText?.(content);
      const toolCalls: AccumulatedToolCall[] = (choice?.message?.tool_calls ?? [])
        .filter((tc): tc is OpenAI.Chat.Completions.ChatCompletionMessageFunctionToolCall => tc.type === 'function')
        .map((tc) => ({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }));
      return { content, toolCalls };
    }

    // stream_options.include_usage makes compliant servers report token
    // usage on the final chunk of a streamed response (without it the usage
    // ledger under-counts every streamed turn). Some old local servers 400
    // on unknown fields: profiles can opt out with stream_usage: false.
    const streamUsage =
      (this.profile as ResolvedProfile & { stream_usage?: boolean }).stream_usage !== false;
    const stream = await this.client.chat.completions.create(
      {
        ...base,
        stream: true,
        ...(streamUsage ? { stream_options: { include_usage: true } } : {}),
      },
      { signal }
    );

    let content = '';
    let usage: OpenAI.Completions.CompletionUsage | undefined;
    const byIndex = new Map<number, AccumulatedToolCall>();
    for await (const chunk of stream) {
      // Servers that report streamed usage put it on the final chunk.
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        if (!this.muteText) this.callbacks.onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const acc = byIndex.get(tc.index) ?? { id: '', name: '', arguments: '' };
        if (tc.id) acc.id = tc.id;
        // The name arrives WHOLE (some servers resend it in every chunk):
        // assignment, not concatenation. The arguments do arrive in
        // fragments and are concatenated.
        if (tc.function?.name) acc.name = tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        byIndex.set(tc.index, acc);
      }
    }

    if (usage) this.emitUsage(usage, Date.now() - llamadaInicio);
    const toolCalls = [...byIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tc], i) => ({ ...tc, id: tc.id || `call_${i}` }));
    return { content, toolCalls };
  }
}
