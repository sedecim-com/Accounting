import type { AskUserFn, DraftCreatedInfo, ToolObserver } from '../tools/observer.js';
import type { CompactionResult } from '../compaction.js';

// ============================================================
// PROVIDER ABSTRACTION
// The harness (CLI + accounting tools) is model-agnostic.
// Each provider implements LlmSession: a conversation with its
// own history in its native format. Switching providers
// = creating a new session (history is not portable across
// different wire formats).
// ============================================================

/** One tool call as it happened during a turn (provider-independent). */
export interface TurnToolUse {
  name: string;
  input: unknown;
  /** First 500 chars of the tool result. */
  resultPreview: string;
}

/**
 * Normalized token usage of ONE completed model call (not one turn: an
 * agentic turn fires it once per model round-trip). Anthropic usage
 * fields and OpenAI-compat usage ({prompt_tokens, completion_tokens,
 * prompt_tokens_details.cached_tokens}) both map into this shape — the
 * usage ledger consumes it provider-independently.
 */
export interface TurnUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  /**
   * A2: wall-clock de ESTA llamada al modelo, medido por el runner alrededor
   * de la petición. Opcional porque llega de código, no del proveedor — un
   * emisor viejo que no lo mida deja la columna NULL, nunca un cero falso.
   */
  durationMs?: number;
}

/**
 * What happened in one completed turn, independent of any provider wire
 * format. This is what the transcript (session-store) persists.
 */
export interface TurnRecord {
  userInput: string;
  assistantText: string;
  toolUses: TurnToolUse[];
}

export interface SessionCallbacks {
  /** Visible assistant text deltas (streaming). */
  onText?: (delta: string) => void;
  /** Called when a tool is invoked (before executing it). */
  onToolUse?: ToolObserver;
  /** Interactive channel for ask_user (chat mode only). */
  askUser?: AskUserFn;
  /** Harness hook: fires when the agent creates a draft. */
  onDraftCreated?: (info: DraftCreatedInfo) => void;
  /** Fires once at the end of each turn with the provider-independent record. */
  onTurnComplete?: (record: TurnRecord) => void;
  /** Fires once per completed MODEL CALL with normalized token counts. */
  onUsage?: (usage: TurnUsage) => void;
}

export interface LlmSession {
  /** Human-readable label: "hermes · Hermes-4-405B". */
  readonly label: string;
  /** Runs a full turn (agentic loop included). Returns the final text. */
  runTurn(userInput: string, signal?: AbortSignal): Promise<string>;
  /** Discards the conversation history. */
  reset(): void;
  /**
   * Manual compaction (`/compact`): memory flush + summarize older
   * messages in the in-flight view. Returns null when there is nothing
   * to compact. Optional — sessions without history compaction omit it.
   */
  compact?(signal?: AbortSignal): Promise<CompactionResult | null>;
}

export type ProviderType = 'anthropic' | 'openai-compatible';

// ============================================================
// VENTANA DE CONTEXTO DEL PERFIL
//
// La compactación automática se dispara por un número de tokens. Ese número
// sólo significa algo CONTRA UNA VENTANA: 150 000 es prudente para un modelo
// de un millón y es una mentira para un llama3.1 servido en local, que revienta
// por contexto antes de que el umbral se acerque. El operador ve entonces un
// error del proveedor donde había un problema de diseño del arnés.
//
// Por eso la ventana viaja EN EL PERFIL, junto al modelo que la determina, y
// no en la sección global del archivo. La postura es obligatoria en los
// perfiles de fábrica (config.ts la exige en el tipo): un perfil nuevo que se
// calle no compila. Y `desconocida` es una respuesta legítima —lo ilegítimo es
// inventar un número—: quien no la sabe lo dice, y el arnés cae al respaldo
// global, que es exactamente lo que hacía antes de existir este campo.
// ============================================================

/**
 * `declarada`   — se conoce el número de tokens; `tokens` lo dice.
 * `desconocida` — no se puede fijar desde aquí (lo elige una pasarela, un
 *                 enrutador o el `num_ctx` de un servidor local), o el
 *                 proveedor lo publica y nadie lo ha establecido todavía.
 *                 `razon` dice cuál de las dos.
 */
export type PosturaVentana = 'declarada' | 'desconocida';

export interface VentanaContexto {
  postura: PosturaVentana;
  /** Tokens de ventana. Presente si y sólo si postura === 'declarada'. */
  tokens?: number;
  /** Por qué. Obligatoria y sustantiva: un número sin origen no es un dato. */
  razon: string;
}

/** Provider profile as it lives in the configuration. */
export interface ProviderProfile {
  type: ProviderType;
  model: string;
  /** openai-compatible only: base URL of the endpoint (…/v1). */
  base_url?: string;
  /**
   * Name of the ENVIRONMENT VARIABLE that holds the API key.
   * Keys are never stored in the configuration file.
   */
  api_key_env?: string;
  /**
   * Credential helper (git/kubectl/aws pattern): shell command that prints
   * the credential. Runs only if the environment variable is not set.
   * Ideal for OAuth tokens of already-logged-in subscriptions (Codex CLI,
   * vaults like `op read`, keychains). Lives in YOUR config — same trust
   * level as your shell.
   */
  api_key_cmd?: string;
  /** false = the endpoint does not support streaming; use full response. */
  stream?: boolean;
  /**
   * Name of the token-limit parameter. Default 'max_tokens' (Ollama,
   * Nous, LM Studio); OpenAI reasoning models require
   * 'max_completion_tokens'.
   */
  max_tokens_param?: 'max_tokens' | 'max_completion_tokens';
  /**
   * false = do not declare tools to the model (endpoints without function
   * calling, or agents like hermes-agent that run their own tools
   * server-side and do not return tool calls to the client).
   */
  tools?: boolean;
  /** Extra per-request headers (e.g. X-Hermes-Session-Key). */
  headers?: Record<string, string>;
  max_iterations?: number;
  /** Note shown in `mnemosine providers`. */
  note?: string;
}

export interface ResolvedProfile extends ProviderProfile {
  name: string;
  /** API key already resolved from the environment (undefined if N/A or missing). */
  apiKey?: string;
}
