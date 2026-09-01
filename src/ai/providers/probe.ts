import { classifyProviderError, type ProviderErrorCategory } from './failover.js';
import type { ResolvedProfile } from './types.js';

// ============================================================
// LAYERED LIVE PROBES (OpenClaw "Test connection" + Hermes status)
//
// A probe answers ONE question per provider — "can this profile
// serve a request right now?" — with the cheapest live call the
// endpoint offers and the error CATEGORIZED (auth vs billing vs
// timeout change what the operator does next):
//   - openai-compatible: GET {base_url}/models (free, no tokens).
//   - anthropic: POST /v1/messages with max_tokens: 1 (there is
//     no cheaper authenticated endpoint; one token is the floor).
// Hard 10s timeout; probes never retry and never fail each other
// (probeAll isolates per profile).
//
// REDACTION: probe results are built for `mnemosine status`,
// which is shareable in support tickets. detail must never carry
// credentials — any occurrence of the profile's key is scrubbed
// even if the endpoint echoes it back.
// ============================================================

export const PROBE_TIMEOUT_MS = 10_000;
const DETAIL_MAX_CHARS = 200;
const ANTHROPIC_DEFAULT_BASE = 'https://api.anthropic.com';

export interface ProbeResult {
  ok: boolean;
  /** Present only on failure: the classified error category. */
  category?: ProviderErrorCategory;
  latencyMs: number;
  /** Short, redacted human-readable detail. */
  detail: string;
}

export interface ProbeOptions {
  timeoutMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Scrubs the credential (if known), strips URL userinfo (network errors can
 * echo the full request URL — `https://user:secret@host/...` would leak the
 * embedded credential) and truncates: details are shareable.
 */
export function redactDetail(text: string, apiKey?: string, max = DETAIL_MAX_CHARS): string {
  let out = text.replace(/\s+/g, ' ').trim();
  if (apiKey && apiKey.length > 0) out = out.split(apiKey).join('[redacted]');
  out = out.replace(/\/\/[^\s/@]+@/g, '//[redacted]@');
  return out.slice(0, max);
}

interface HttpErrorLike extends Error {
  status: number;
}

function httpError(status: number, body: string): HttpErrorLike {
  const err = new Error(`HTTP ${status}: ${body}`) as HttpErrorLike;
  err.status = status;
  return err;
}

/**
 * One minimal live call against the profile's endpoint. Never throws:
 * every failure comes back as {ok: false} with the SAME error taxonomy
 * the failover chain uses (classifyProviderError).
 */
export async function probeProvider(
  profile: ResolvedProfile,
  options: ProbeOptions = {}
): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const start = now();
  try {
    let response: Response;
    if (profile.type === 'anthropic') {
      // Cheapest authenticated request the Messages API allows: 1 token out.
      const base = (profile.base_url ?? ANTHROPIC_DEFAULT_BASE).replace(/\/$/, '');
      response = await fetchImpl(`${base}/v1/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(profile.apiKey ? { 'x-api-key': profile.apiKey } : {}),
          ...(profile.headers ?? {}),
        },
        body: JSON.stringify({
          model: profile.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
    } else {
      // Model-list endpoint: authenticated but token-free.
      const base = (profile.base_url ?? '').replace(/\/$/, '');
      if (!base) {
        return { ok: false, category: 'unknown', latencyMs: 0, detail: 'profile has no base_url' };
      }
      response = await fetchImpl(`${base}/models`, {
        method: 'GET',
        signal: controller.signal,
        headers: {
          ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
          ...(profile.headers ?? {}),
        },
      });
    }

    const latencyMs = now() - start;
    if (response.ok) {
      return { ok: true, latencyMs, detail: `HTTP ${response.status}` };
    }
    const body = await response.text().catch(() => '');
    const err = httpError(response.status, body);
    return {
      ok: false,
      category: classifyProviderError(err),
      latencyMs,
      detail: redactDetail(`HTTP ${response.status} ${body}`, profile.apiKey),
    };
  } catch (err) {
    const latencyMs = now() - start;
    // Our own abort is a timeout by definition; everything else is classified.
    const category: ProviderErrorCategory = controller.signal.aborted
      ? 'timeout'
      : classifyProviderError(err);
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      category,
      latencyMs,
      detail: redactDetail(
        category === 'timeout' ? `no response within ${timeoutMs}ms` : message,
        profile.apiKey
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface NamedProbeResult extends ProbeResult {
  name: string;
}

/**
 * Probes profiles SEQUENTIALLY (parallel probes against local gateways can
 * themselves trip rate limits) with per-probe isolation: one profile's
 * unexpected exception becomes its own failed row, never aborts the rest.
 */
export async function probeAll(
  profiles: Array<ResolvedProfile>,
  options: ProbeOptions = {}
): Promise<NamedProbeResult[]> {
  const results: NamedProbeResult[] = [];
  for (const profile of profiles) {
    try {
      results.push({ name: profile.name, ...(await probeProvider(profile, options)) });
    } catch (err) {
      results.push({
        name: profile.name,
        ok: false,
        category: 'unknown',
        latencyMs: 0,
        detail: redactDetail(err instanceof Error ? err.message : String(err), profile.apiKey),
      });
    }
  }
  return results;
}
