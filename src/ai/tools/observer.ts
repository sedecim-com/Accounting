// Callback the CLI passes down so the user sees which tool the agent is
// calling (and with what input) while the loop runs.
export type ToolObserver = (toolName: string, input: unknown) => void;

export interface AskUserPrompt {
  question: string;
  context?: string;
  options?: string[];
}

/**
 * Interactive channel to the human: resolves with their answer, or null when
 * nobody is available (one-shot/batch mode, EOF, or declined). Provided by
 * the CLI in chat mode; absent elsewhere.
 */
export type AskUserFn = (prompt: AskUserPrompt) => Promise<string | null>;

export interface DraftCreatedInfo {
  draftId: string;
  confidence: number;
  totalDebits: string;
  totalCredits: string;
}

/** Dependencies threaded from the session into the tool set. */
export interface ToolDeps {
  model: string;
  observe?: ToolObserver;
  /** Records the user turn that motivated each draft/question (audit). */
  userRequestRef?: { current?: string };
  askUser?: AskUserFn;
  /**
   * Harness hook: fires when the agent successfully creates a draft. The
   * ingest pipeline uses it to decide auto-post by thresholds.
   */
  onDraftCreated?: (info: DraftCreatedInfo) => void;
}
