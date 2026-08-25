import type { ProviderProfile } from './types.js';

// ============================================================
// ERROR-TYPED FAILOVER CHAINS (OpenClaw pattern)
//
// A provider error is first CLASSIFIED, then — only for the
// categories where switching provider can actually help — the
// chain walks to the next profile:
//
//   auth / rate_limit / server / timeout / billing → failover
//   overflow  → NEVER: the prompt is too big for ANY provider of
//               a similar window; that belongs to compaction.
//   refusal   → NEVER: a safety refusal must reach the human, not
//               be shopped around until some model complies.
//   aborted   → NEVER: a caller-initiated cancellation (Ctrl+C →
//               AbortController) is not a provider failure; retrying
//               it on the next provider would resume a run the human
//               just cancelled and trip cooldowns on healthy providers.
//   unknown   → NEVER: failing over on an unclassified error
//               hides bugs (fail loudly instead).
//
// Cooldowns are staggered per provider (30s first trip, doubling
// to a 5m cap, in-memory) and the walk always starts at the head
// of the chain: the moment the primary's cooldown expires, the
// next call re-probes it FIRST — fallbacks are temporary.
//
// Model attribution is the caller's job by construction: the
// attempt callback receives the ACTUAL profile used, so a draft
// created via the fallback model is attributed to that model.
// ============================================================

export type ProviderErrorCategory =
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'timeout'
  | 'billing'
  | 'overflow'
  | 'refusal'
  | 'aborted'
  | 'unknown';

/** Categories where trying the next provider in the chain can help. */
export const FAILOVER_ELIGIBLE: ReadonlySet<ProviderErrorCategory> = new Set([
  'auth',
  'rate_limit',
  'server',
  'timeout',
  'billing',
]);

export function isFailoverEligible(category: ProviderErrorCategory): boolean {
  return FAILOVER_ELIGIBLE.has(category);
}

// Message fingerprints, ordered by specificity. Billing outranks the 429
// status code: OpenAI reports exhausted quota as HTTP 429/insufficient_quota,
// and "add credit" is a very different operator action than "wait a minute".
const OVERFLOW_RE =
  /context.length|context.window|maximum.context|prompt is too long|too many tokens|token limit|tokens? exceed|input length and .?max_tokens.? exceed/i;
// Anchored on "refusal"/"model … refused" so network-level "connection
// refused" messages never masquerade as a model refusal.
const REFUSAL_RE = /\brefusal\b|\bmodel\b[\s\S]{0,40}\brefus(ed|es)\b|declined to (answer|respond)/i;
const BILLING_RE =
  /insufficient_quota|exceeded your current quota|billing|credit balance|insufficient credit|payment required|plan and billing/i;
const TIMEOUT_RE = /\btim(ed|e).?out\b|deadline exceeded/i;

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
// DOMException-style abort code: caller cancellation, NOT a timeout.
const ABORT_CODES = new Set(['ABORT_ERR']);
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND']);

interface ErrorShape {
  status?: unknown;
  statusCode?: unknown;
  code?: unknown;
  type?: unknown;
  name?: unknown;
  message?: unknown;
  error?: unknown;
  cause?: unknown;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Wire-level error type: Anthropic nests it at error.error.type, OpenAI SDKs surface it at error.type or error.error.type. */
function wireType(err: ErrorShape): string {
  const nested = (err.error ?? {}) as ErrorShape;
  const inner = (nested.error ?? {}) as ErrorShape;
  for (const t of [err.type, nested.type, inner.type]) {
    if (typeof t === 'string') return t;
  }
  return '';
}

function fullText(err: ErrorShape): string {
  const parts: string[] = [];
  if (typeof err.message === 'string') parts.push(err.message);
  const nested = (err.error ?? {}) as ErrorShape;
  if (typeof nested.message === 'string') parts.push(nested.message);
  const inner = (nested.error ?? {}) as ErrorShape;
  if (typeof inner.message === 'string') parts.push(inner.message);
  return parts.join(' | ');
}

/**
 * Maps any provider error to a category. Inspection order matters:
 * overflow/refusal fingerprints run FIRST — they usually arrive as
 * HTTP 400s, and misreading them as generic client errors (or worse,
 * letting a 4xx fall into a failover-eligible bucket) would either
 * hide a compaction problem or shop a refusal to another model.
 */
export function classifyProviderError(err: unknown): ProviderErrorCategory {
  if (err == null) return 'unknown';
  const e = (typeof err === 'object' ? err : { message: String(err) }) as ErrorShape;
  const type = wireType(e);
  const text = `${type} ${fullText(e)}`;

  if (OVERFLOW_RE.test(text)) return 'overflow';
  if (REFUSAL_RE.test(text)) return 'refusal';
  if (BILLING_RE.test(text)) return 'billing';

  // SDK / wire error types.
  if (/authentication_error|permission_error|invalid_api_key/.test(type)) return 'auth';
  if (/rate_limit_error|rate_limit_exceeded/.test(type)) return 'rate_limit';
  if (/overloaded_error|api_error|server_error/.test(type)) return 'server';
  if (e.name === 'AuthenticationError' || e.name === 'PermissionDeniedError') return 'auth';
  if (e.name === 'RateLimitError') return 'rate_limit';
  if (e.name === 'APIConnectionTimeoutError') return 'timeout';
  if (e.name === 'InternalServerError') return 'server';

  // HTTP status codes.
  const status = firstNumber(e.status, e.statusCode, (e.error as ErrorShape | undefined)?.status);
  if (status !== undefined) {
    if (status === 401 || status === 403) return 'auth';
    if (status === 402) return 'billing';
    if (status === 429) return 'rate_limit';
    if (status === 408) return 'timeout';
    if (status >= 500 && status <= 599) return 'server';
  }

  // Node/undici network codes (also on the cause of a fetch TypeError).
  const codes = [e.code, (e.cause as ErrorShape | undefined)?.code].filter(
    (c): c is string => typeof c === 'string'
  );
  for (const code of codes) {
    if (TIMEOUT_CODES.has(code)) return 'timeout';
    if (CONNECTION_CODES.has(code)) return 'server';
  }
  // Timeout markers first: a deadline-driven abort (AbortSignal.timeout →
  // DOMException 'TimeoutError', or "timed out" text) IS a timeout. Only
  // then does a bare AbortError read as a caller-initiated cancellation —
  // classifying user Ctrl+C as 'timeout' would make it failover-eligible.
  if (e.name === 'TimeoutError' || TIMEOUT_RE.test(text)) return 'timeout';
  if (e.name === 'AbortError' || codes.some((c) => ABORT_CODES.has(c))) return 'aborted';
  if (e.name === 'APIConnectionError') return 'server';

  return 'unknown';
}

// ─── Per-provider staggered cooldowns ───

export const COOLDOWN_INITIAL_MS = 30_000;
export const COOLDOWN_CAP_MS = 5 * 60_000;

interface CooldownState {
  /** Timestamp (ms) until which the provider is skipped. */
  untilMs: number;
  /** Duration of the LAST trip; the next trip doubles it (capped). */
  durationMs: number;
}

/**
 * In-memory cooldown registry keyed by provider profile NAME. Process-local
 * on purpose: a CLI process serves one operator, and persisting backoff
 * state would turn a transient outage into a sticky one.
 */
export class CooldownRegistry {
  private readonly state = new Map<string, CooldownState>();

  constructor(private readonly now: () => number = Date.now) {}

  isCooling(provider: string, nowMs = this.now()): boolean {
    const s = this.state.get(provider);
    return s !== undefined && nowMs < s.untilMs;
  }

  /** Remaining cooldown in ms (0 when none). */
  remainingMs(provider: string, nowMs = this.now()): number {
    const s = this.state.get(provider);
    return s ? Math.max(0, s.untilMs - nowMs) : 0;
  }

  /**
   * Records a failover-eligible failure: first trip 30s, each subsequent
   * trip doubles the previous duration up to the 5m cap. Doubling is only
   * reset by a SUCCESS (clear), not by mere expiry: a provider flapping
   * every few minutes keeps escalating instead of hammering at 30s forever.
   */
  trip(provider: string, nowMs = this.now()): number {
    const prev = this.state.get(provider);
    const durationMs = prev ? Math.min(prev.durationMs * 2, COOLDOWN_CAP_MS) : COOLDOWN_INITIAL_MS;
    this.state.set(provider, { untilMs: nowMs + durationMs, durationMs });
    return durationMs;
  }

  /** A successful call fully rehabilitates the provider. */
  clear(provider: string): void {
    this.state.delete(provider);
  }
}

/** Shared registry for the process (tests inject their own). */
export const defaultCooldowns = new CooldownRegistry();

export interface FailoverEvent {
  provider: string;
  errorType: ProviderErrorCategory;
  /** Next profile that will be attempted, if any remains. */
  nextProvider?: string;
}

export interface RunWithFailoverOptions {
  /** Warning-line hook: "provider X failed (rate_limit), trying Y". */
  onFailover?: (event: FailoverEvent) => void;
  cooldowns?: CooldownRegistry;
  now?: () => number;
  /**
   * The caller's cancellation signal (e.g. Ctrl+C AbortController). When it
   * is aborted, ANY attempt failure re-throws immediately — no cooldown
   * trip, no failover: the human cancelled the run, the provider did not
   * fail. (Ownership check mirroring probe.ts's controller.signal.aborted.)
   */
  signal?: AbortSignal;
}

export type NamedProfile = ProviderProfile & { name: string };

export class AllProvidersFailedError extends Error {
  constructor(
    message: string,
    readonly failures: Array<{ provider: string; category: ProviderErrorCategory; error: unknown }>
  ) {
    super(message);
    this.name = 'AllProvidersFailedError';
  }
}

/**
 * Walks the chain in order and runs `attemptFn` against the first available
 * profile, failing over ONLY on failover-eligible categories.
 *
 *  - Chain order is authoritative and re-evaluated on EVERY call: providers
 *    in active cooldown are skipped, so once the primary's cooldown expires
 *    the next call automatically re-probes it first.
 *  - If every profile is cooling down, the cooldowns are ignored and the
 *    chain is walked anyway: availability beats backoff politeness.
 *  - Non-eligible categories (overflow / refusal / aborted / unknown)
 *    re-throw IMMEDIATELY: overflow belongs to compaction, a cancellation
 *    belongs to the human who issued it, and a refusal or an unclassified
 *    bug must surface, not be retried on another model.
 *
 * Returns the result AND the profile that produced it, so the caller can
 * attribute the actual model used (drafts made by a fallback model are on
 * the record as such).
 */
export async function runWithFailover<T>(
  chain: NamedProfile[],
  attemptFn: (profile: NamedProfile) => Promise<T>,
  options: RunWithFailoverOptions = {}
): Promise<{ result: T; profile: NamedProfile }> {
  if (chain.length === 0) throw new Error('runWithFailover requires a non-empty provider chain');
  const cooldowns = options.cooldowns ?? defaultCooldowns;
  const now = options.now ?? Date.now;

  let candidates = chain.filter((p) => !cooldowns.isCooling(p.name, now()));
  if (candidates.length === 0) candidates = [...chain];

  const failures: AllProvidersFailedError['failures'] = [];
  for (let i = 0; i < candidates.length; i++) {
    const profile = candidates[i];
    try {
      const result = await attemptFn(profile);
      cooldowns.clear(profile.name);
      return { result, profile };
    } catch (err) {
      // Caller cancelled: the error (whatever shape the SDK gave it) is a
      // consequence of the abort, never a provider fault. Fail closed.
      if (options.signal?.aborted) throw err;
      const category = classifyProviderError(err);
      if (!isFailoverEligible(category)) throw err;
      cooldowns.trip(profile.name, now());
      failures.push({ provider: profile.name, category, error: err });
      options.onFailover?.({
        provider: profile.name,
        errorType: category,
        nextProvider: candidates[i + 1]?.name,
      });
    }
  }

  throw new AllProvidersFailedError(
    `All providers in the failover chain failed: ${failures
      .map((f) => `${f.provider} (${f.category})`)
      .join(', ')}`,
    failures
  );
}
