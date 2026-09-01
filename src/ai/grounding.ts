// ============================================================
// GROUNDING GUARD
// The system prompt's PROTOCOL tells the model to consult
// read_docs before stating system facts — but a prompt is
// advisory. This guard is the deterministic backstop (same
// philosophy as floor.ts): when a turn produces a substantive
// answer with ZERO tool calls and the session has consulted no
// documentation at all, the harness injects ONE corrective turn
// that forces the model to ground itself — or to explicitly
// stand by an answer that needed no grounding. At most once per
// session: the guard closes the worst failure mode (a pure
// from-memory answer), it does not chase the model in a loop.
// ============================================================

/**
 * Answers shorter than this are assumed to be greetings, acks or
 * clarifying questions — nudging those would just produce noise.
 * A from-memory answer about system behavior (commands, flows,
 * endpoints) is reliably longer than a greeting.
 */
export const DEFAULT_MIN_ANSWER_CHARS = 240;

export interface GroundingOptions {
  /** Kill switch (tools:false channels, tests). Default: enabled. */
  enabled?: boolean;
  /** Override of DEFAULT_MIN_ANSWER_CHARS. */
  minAnswerChars?: number;
  /**
   * A2: se dispara cuando el guard emite el turno correctivo. El CLI lo
   * persiste como evento ('nudge' en ai_agent_events): cuántas veces el
   * modelo contestó de memoria es una métrica de salud del agente, no una
   * línea fugaz de stderr.
   */
  onNudge?: () => void;
}

/**
 * Injected as a user-role message so it works on every provider,
 * but explicitly labeled as coming from the harness, not the human.
 */
export const GROUNDING_NUDGE = `[MNEMOSINE HARNESS — automated grounding check, NOT the user] \
Your previous answer used no tool: no documentation was read and no live data was queried \
in this session, so any system fact in it (commands, flags, flows, endpoints, rules, \
figures) came from memory — which the protocol forbids. Do ONE of the following now: \
(a) if the answer stated system facts, consult read_docs for the relevant topic(s), verify \
every claim, and issue a corrected answer (start it with "Verificando la documentación:" / \
"Checking the documentation:" per your response language — do not apologize); or \
(b) if it genuinely contained no system facts (pure greeting or conversational reply), \
answer with ONLY the single line "(sin datos del sistema)" — nothing else. \
This is a VERIFICATION pass: use READ tools only (read_docs, searches, reports). Do NOT \
create drafts or questions and do NOT queue external writes here — if the original request \
needs a write, say so in your corrected answer and let the human ask for it.`;

export class GroundingGuard {
  private readonly enabled: boolean;
  private readonly minAnswerChars: number;
  private readonly onNudge?: () => void;
  private toolCallsThisTurn = 0;
  private docsReadsInSession = 0;
  private nudgedThisSession = false;

  constructor(options: GroundingOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.minAnswerChars = options.minAnswerChars ?? DEFAULT_MIN_ANSWER_CHARS;
    this.onNudge = options.onNudge;
  }

  /** Call at the start of every agentic loop run (real or corrective). */
  beginTurn(): void {
    this.toolCallsThisTurn = 0;
  }

  /**
   * Re-arm for a wiped conversation (\`/new\`): the docs the guard counted
   * are no longer in the model's context, and a spent latch must not leave
   * the fresh conversation permanently unguarded. Call from session.reset().
   */
  reset(): void {
    this.toolCallsThisTurn = 0;
    this.docsReadsInSession = 0;
    this.nudgedThisSession = false;
  }

  /**
   * Feed one SUCCESSFUL tool execution. Failed runs must not be fed: a
   * read_docs that threw (missing dist docs) put nothing in the model's
   * context, and counting it would disarm the guard exactly where every
   * answer is ungrounded.
   */
  onToolUse(toolName: string): void {
    this.toolCallsThisTurn += 1;
    if (toolName === 'read_docs') this.docsReadsInSession += 1;
  }

  /**
   * True when the finished turn deserves the corrective nudge:
   * nothing consulted this turn, nothing read all session, the
   * answer is long enough to be substantive, and the guard has
   * not already fired this session.
   */
  needsNudge(answerText: string): boolean {
    return (
      this.enabled &&
      !this.nudgedThisSession &&
      this.toolCallsThisTurn === 0 &&
      this.docsReadsInSession === 0 &&
      answerText.trim().length >= this.minAnswerChars
    );
  }

  /** The corrective prompt; marks the once-per-session latch. */
  buildNudge(): string {
    this.nudgedThisSession = true;
    this.onNudge?.();
    return GROUNDING_NUDGE;
  }
}
