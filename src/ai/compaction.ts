// ============================================================
// SAFE COMPACTION (items 11 + 12)
// Compaction shrinks the MODEL'S IN-FLIGHT VIEW of a long
// conversation: older messages are replaced by one summary
// message. The full transcript in Postgres (ai_sessions /
// ai_messages) is never touched — this module only rewrites the
// message array a runner is about to send.
//
// Guarantees:
//  - the cut point NEVER splits a tool_use / tool_result pair;
//  - a recent tail (keepRecentTokens) survives intact;
//  - identifierPolicy 'strict': the model is instructed to keep
//    CFDI UUIDs, RFCs, folios, draft/question ids and amounts
//    VERBATIM. A deterministic backstop additionally greps the
//    source and re-appends every UUID (draft/question ids are
//    UUIDs), RFC, serie-folio token (e.g. "F-2041") and — desde S1
//    (auditoría 2026-08-31) — monetary amount the summary dropped.
//    En un agente CONTABLE el importe es la carga útil: protegerlo
//    «solo por instrucción» era el hueco que E5.1-c confesaba en
//    este mismo comentario;
//  - a memory-flush turn runs BEFORE compaction, once per WINDOW:
//    the flush gate looks only at messages newer than the last
//    flush marker (excluding the flush turn's own reply), so every
//    new stretch of assistant activity gets exactly one flush. The
//    agent persists unsaved precedents through the EXISTING staged
//    tools (ask_user → answered-precedent / pending question).
//    Human review is preserved: no new direct-write path is
//    introduced here.
// ============================================================

/** Rough chars-per-token used across the CLI (see prompt-size). */
const CHARS_PER_TOKEN = 4;

export const DEFAULT_KEEP_RECENT_TOKENS = 20000;

/**
 * Marker embedded in the flush prompt. Messages at or before the LAST
 * occurrence of the marker already went through a flush; only assistant
 * activity NEWER than it warrants another flush (every compaction window
 * gets exactly one). The marker is neutralized in summarization input so
 * it can never leak into a summary and permanently disable flushing.
 */
export const FLUSH_MARKER = '[mnemosine:memory-flush]';

/** Replacement used when neutralizing the marker in summarizer input. */
const NEUTRALIZED_MARKER = '[memory-flush]';

/** Strips the flush marker so it cannot survive into a summary. */
export function neutralizeFlushMarker(text: string): string {
  return text.split(FLUSH_MARKER).join(NEUTRALIZED_MARKER);
}

export const estimateTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

// ------------------------------------------------------------
// Provider-neutral view of a message array
// ------------------------------------------------------------

/** Provider-neutral projection of one wire message, for planning cuts. */
export interface CompactableMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  /** Serialized size basis for the token estimate. */
  chars: number;
  /** Assistant message that OPENS tool calls (results follow later). */
  opensToolUse: boolean;
  /** Message that CARRIES tool results (closes a pair). */
  isToolResult: boolean;
  /** Flattened text: summary source + marker/identifier scanning. */
  text: string;
}

interface AnthropicBlockLike {
  type?: string;
  text?: string;
  input?: unknown;
  content?: unknown;
  name?: string;
  /** thinking blocks carry their text here. */
  thinking?: string;
  /** redacted_thinking blocks carry an opaque payload here. */
  data?: string;
}

interface AnthropicMessageLike {
  role: string;
  content: string | AnthropicBlockLike[];
}

/** Projects Anthropic BetaMessageParam[] into the neutral shape. */
export function anthropicView(messages: readonly AnthropicMessageLike[]): CompactableMessage[] {
  return messages.map((m) => {
    const text = flattenAnthropic(m);
    const blocks = typeof m.content === 'string' ? [] : m.content;
    return {
      role: (m.role === 'assistant' ? 'assistant' : 'user') as CompactableMessage['role'],
      chars: text.length,
      opensToolUse: blocks.some((b) => b.type === 'tool_use'),
      isToolResult: blocks.some((b) => b.type === 'tool_result'),
      text,
    };
  });
}

function flattenAnthropic(m: AnthropicMessageLike): string {
  if (typeof m.content === 'string') return m.content;
  return m.content
    .map((b) => {
      if (b.type === 'text') return b.text ?? '';
      if (b.type === 'tool_use') return `[tool_use ${b.name ?? ''}] ${JSON.stringify(b.input ?? {})}`;
      if (b.type === 'tool_result') return `[tool_result] ${flattenUnknown(b.content)}`;
      // Thinking blocks are replayed and billed as input on every subsequent
      // call: leaving them out would make the token estimate lag the real
      // prompt by tens of thousands of tokens on thinking-heavy sessions and
      // fire the auto-compaction threshold too late (fail-open). They count
      // toward the estimate but are excluded from summarizer source text at
      // a higher level only via the cut, not here.
      if (b.type === 'thinking') return b.thinking ?? b.text ?? '';
      if (b.type === 'redacted_thinking') return b.data ?? '';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function flattenUnknown(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('');
  }
  return JSON.stringify(content);
}

interface OpenAiMessageLike {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
}

/** Projects OpenAI Chat Completions history into the neutral shape. */
export function openAiView(messages: readonly OpenAiMessageLike[]): CompactableMessage[] {
  return messages.map((m) => {
    const calls = (m.tool_calls ?? [])
      .map((raw) => {
        const tc = raw as { function?: { name?: string; arguments?: string } };
        return `[tool_use ${tc.function?.name ?? ''}] ${tc.function?.arguments ?? ''}`;
      })
      .join('\n');
    const text = [flattenUnknown(m.content), calls].filter(Boolean).join('\n');
    const role: CompactableMessage['role'] =
      m.role === 'assistant' ? 'assistant' : m.role === 'tool' ? 'tool' : m.role === 'system' ? 'system' : 'user';
    return {
      role,
      chars: text.length,
      opensToolUse: (m.tool_calls ?? []).length > 0,
      isToolResult: m.role === 'tool',
      text,
    };
  });
}

// ------------------------------------------------------------
// Cut-point planning (pure)
// ------------------------------------------------------------

export interface PlanOptions {
  /** Intact recent tail the compaction must keep (default ~20k tokens). */
  keepRecentTokens?: number;
  /** Don't bother compacting fewer messages than this (default 2). */
  minDropMessages?: number;
}

export interface CompactionPlan {
  /** Index of the FIRST KEPT message; [0, cutIndex) gets summarized. */
  cutIndex: number;
  dropTokens: number;
  keepTokens: number;
}

/**
 * Chooses where to cut. Walks from the end until the kept tail reaches
 * keepRecentTokens, then repairs the boundary so it never splits a
 * tool_use / tool_result pair: while the first kept message carries tool
 * results, or the last dropped message opens tool calls (whose results
 * would then be kept orphaned), the cut moves EARLIER (dropping less).
 * Returns null when there is nothing worthwhile to compact.
 */
export function planCompaction(
  messages: readonly CompactableMessage[],
  opts: PlanOptions = {}
): CompactionPlan | null {
  const keepTarget = opts.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS;
  const minDrop = opts.minDropMessages ?? 2;

  let cutIndex = messages.length;
  let keptTokens = 0;
  while (cutIndex > 0 && keptTokens < keepTarget) {
    cutIndex--;
    keptTokens += estimateTokens(messages[cutIndex].chars);
  }

  // Boundary repair: never split a tool_use/tool_result pair.
  while (
    cutIndex > 0 &&
    (messages[cutIndex]?.isToolResult || messages[cutIndex - 1]?.opensToolUse)
  ) {
    cutIndex--;
  }

  if (cutIndex < minDrop) return null;

  const tokensOf = (slice: readonly CompactableMessage[]): number =>
    slice.reduce((sum, m) => sum + estimateTokens(m.chars), 0);
  return {
    cutIndex,
    dropTokens: tokensOf(messages.slice(0, cutIndex)),
    keepTokens: tokensOf(messages.slice(cutIndex)),
  };
}

/** Estimated tokens of a whole view (auto-compaction threshold check). */
export function estimateViewTokens(messages: readonly CompactableMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.chars), 0);
}

// ------------------------------------------------------------
// Identifier policy 'strict' (deterministic backstop)
// ------------------------------------------------------------

// CFDI UUIDs (folio fiscal) and generic uuids — draft/question ids included.
const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
// Mexican RFC: 3 letters (persona moral) or 4 (persona física) + yymmdd + homoclave.
// \b is useless next to Ñ/& (non-word chars in JS regex): custom lookaround
// boundaries instead, and the 'i' flag accepts lowercase RFCs (ñ folds too).
const RFC_RE = /(?<![A-ZÑ&0-9])[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}(?![A-ZÑ&0-9])/gi;
// Importes monetarios: 1,234.56 · 19720.00 · $1,234.56 — exige DOS decimales
// y al menos tres dígitos enteros (o separador de miles), para no re-adjuntar
// cada «16.00» de una tasa de IVA ni números sueltos que no son dinero. La
// asimetría es deliberada: un importe chico perdido cuesta menos que un
// backstop que engorde cada resumen con ruido — y el modelo sigue instruido
// a conservarlos TODOS verbatim.
const MONTO_RE = /(?<![\d.,])(?:\d{1,3}(?:,\d{3})+|\d{3,})\.\d{2}(?![\d])/g;
// Serie-folio tokens like "F-2041" / "FAC-123". Uppercase-only on purpose
// (cheap, low false-positive rate); the hyphen exclusion in the boundaries
// keeps it from matching segments INSIDE an uppercase UUID.
const FOLIO_RE = /(?<![\w-])[A-Z]{1,5}-\d{1,7}(?![\w-])/g;

/** UUID/RFC/serie-folio/importe tokens in order of appearance, deduplicated. */
export function extractIdentifiers(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  for (const re of [UUID_RE, RFC_RE, FOLIO_RE, MONTO_RE]) {
    for (const match of text.match(re) ?? []) {
      const key = match.toUpperCase();
      if (!seen.has(key)) {
        seen.add(key);
        found.push(match);
      }
    }
  }
  return found;
}

/**
 * Deterministic backstop for identifierPolicy 'strict': any UUID (CFDI
 * folio fiscal, draft id, question id), RFC, serie-folio token or monetary
 * amount (MONTO_RE — dos decimales, ≥3 dígitos o miles) present in the
 * source slice but missing from the summary is appended on an
 * 'Identifiers:' line. The model is instructed to keep them, but
 * survival must not depend on the model alone.
 */
export function ensureIdentifiersSurvive(summary: string, sourceText: string): string {
  const upperSummary = summary.toUpperCase();
  const missing = extractIdentifiers(sourceText).filter(
    (id) => !upperSummary.includes(id.toUpperCase())
  );
  if (missing.length === 0) return summary;
  return `${summary}\n\nIdentifiers: ${missing.join(', ')}`;
}

// ------------------------------------------------------------
// Summarization request
// ------------------------------------------------------------

export type IdentifierPolicy = 'strict';

export interface SummarizeOptions {
  identifierPolicy?: IdentifierPolicy;
}

export interface SummarizationRequest {
  /** System-level instruction for the summarizer call. */
  instruction: string;
  /** The transcript slice to summarize (user-role content). */
  sourceText: string;
}

// Instruction to the summarizer. Everything listed here is ALSO enforced by
// the deterministic backstop (ensureIdentifiersSurvive: UUIDs — draft/
// question ids included — RFCs, serie-folio tokens y, desde S1, importes que
// pasan MONTO_RE); los importes chicos que el regex deja fuera dependen de
// esta instrucción.
const STRICT_IDENTIFIER_RULE =
  'CRITICAL — identifier policy is STRICT: every CFDI UUID (folio fiscal), RFC, serie-folio ' +
  '(e.g. F-2041), draft id, question id and monetary amount that appears in the transcript MUST ' +
  'appear VERBATIM in your summary, character for character. Never paraphrase, truncate or round them.';

export function buildSummarizationRequest(
  sourceText: string,
  opts: SummarizeOptions = {}
): SummarizationRequest {
  const policy = opts.identifierPolicy ?? 'strict';
  const lines = [
    'You are compacting the older part of an accounting agent conversation. Write a dense summary',
    'that lets the agent continue seamlessly: decisions taken and their rationale, classification',
    'criteria and precedents established, drafts created and their review status, pending questions,',
    'open tasks, and any constraint or instruction from the user that still applies.',
  ];
  if (policy === 'strict') lines.push(STRICT_IDENTIFIER_RULE);
  lines.push('Answer with the summary only — no preamble.');
  return { instruction: lines.join('\n'), sourceText };
}

/**
 * Runs the summarization through the provided model call and applies the
 * deterministic identifier backstop. `complete` is provider-supplied
 * (Anthropic messages.create or an OpenAI chat completion) — no tools.
 */
export async function summarizeForCompaction(
  sourceText: string,
  complete: (instruction: string, sourceText: string) => Promise<string>,
  opts: SummarizeOptions = {}
): Promise<string> {
  const request = buildSummarizationRequest(sourceText, opts);
  const summary = await complete(request.instruction, request.sourceText);
  return (opts.identifierPolicy ?? 'strict') === 'strict'
    ? ensureIdentifiersSurvive(summary, sourceText)
    : summary;
}

/** Text of the single message that replaces the compacted slice. */
export function summaryMessageText(summary: string): string {
  return (
    '[COMPACTION SUMMARY] Earlier turns of this conversation were compacted into the summary ' +
    'below. The full transcript remains in the session log (`mnemosine sessions`).\n\n' +
    summary
  );
}

// ------------------------------------------------------------
// Memory flush (item 12)
// ------------------------------------------------------------

/**
 * One silent agent turn runs with this prompt IMMEDIATELY before
 * compaction. It invites the agent to persist unsaved precedents through
 * the EXISTING staged path (ask_user → answered precedent when the human
 * confirms inline, or a pending question for `mnemosine questions`
 * otherwise). Human review is preserved by construction; there is no
 * direct write to memory here.
 */
export function buildFlushPrompt(): string {
  return (
    `${FLUSH_MARKER} The conversation is about to be compacted. Before that happens, review this ` +
    'session for classification decisions, vendor/customer treatments or accounting criteria that ' +
    'were settled here but are NOT yet saved as precedents (check with search_precedents when ' +
    'unsure). Persist each one through the ask_user tool with a clear question, context and topic ' +
    'slug — the human confirms inline or reviews it later in `mnemosine questions`. Do NOT invent ' +
    'decisions and do NOT restate precedents that already exist. If there is nothing to persist, ' +
    'answer exactly: nothing to persist.'
  );
}

/**
 * Flush runs once per WINDOW, not once per session: the gate only looks at
 * messages NEWER than the last flush marker, so after a compaction cycle the
 * next stretch of assistant activity triggers its own flush (checking the
 * whole view would let one surviving marker disable flushing forever). The
 * flush turn's own reply (assistant/tool traffic up to the next real user
 * message) is skipped — it must not count as fresh activity, or every window
 * would flush twice.
 */
export function shouldFlush(view: readonly CompactableMessage[]): boolean {
  let start = 0;
  for (let i = view.length - 1; i >= 0; i--) {
    if (view[i].text.includes(FLUSH_MARKER)) {
      start = i + 1;
      break;
    }
  }
  // Skip the flush turn's own reply: everything after the marker up to the
  // next plain user message (tool results are carrier messages, not turns).
  if (start > 0) {
    while (start < view.length && (view[start].role !== 'user' || view[start].isToolResult)) {
      start++;
    }
  }
  return view.slice(start).some((m) => m.role === 'assistant');
}

// ------------------------------------------------------------
// Shared orchestration for both runners
// ------------------------------------------------------------

/** Runner-facing compaction configuration. */
export interface CompactionConfig {
  /**
   * Auto-compact when the estimated in-flight prompt exceeds this many
   * tokens. Absent/undefined = automatic compaction OFF (manual /compact
   * still works).
   */
  thresholdTokens?: number;
  keepRecentTokens?: number;
  identifierPolicy?: IdentifierPolicy;
}

export interface CompactionResult {
  droppedMessages: number;
  dropTokens: number;
  keepTokens: number;
  summary: string;
}

/**
 * Applies one compaction to a runner's native message array. `view` must
 * be the projection of `messages` (same indices). Returns the replacement
 * array plus the result, or null when there is nothing to compact.
 */
export async function compactView<M>(args: {
  messages: readonly M[];
  view: readonly CompactableMessage[];
  keepRecentTokens?: number;
  identifierPolicy?: IdentifierPolicy;
  complete: (instruction: string, sourceText: string) => Promise<string>;
  makeSummaryMessage: (text: string) => M;
}): Promise<{ messages: M[]; result: CompactionResult } | null> {
  const plan = planCompaction(args.view, { keepRecentTokens: args.keepRecentTokens });
  if (!plan) return null;

  // The flush marker is neutralized BEFORE summarization: were it to leak
  // into the summary, the surviving marker would keep reading as "this
  // window already flushed" and could suppress future flushes.
  const sourceText = args.view
    .slice(0, plan.cutIndex)
    .map((m) => `${m.role}: ${neutralizeFlushMarker(m.text)}`)
    .join('\n');
  const summary = await summarizeForCompaction(sourceText, args.complete, {
    identifierPolicy: args.identifierPolicy ?? 'strict',
  });

  return {
    messages: [
      args.makeSummaryMessage(summaryMessageText(summary)),
      ...args.messages.slice(plan.cutIndex),
    ],
    result: {
      droppedMessages: plan.cutIndex,
      dropTokens: plan.dropTokens,
      keepTokens: plan.keepTokens,
      summary,
    },
  };
}
