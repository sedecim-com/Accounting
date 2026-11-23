import OpenAI, { type ClientOptions } from 'openai';
import type { ResolvedProfile } from './types.js';

// ============================================================
// The one place an OpenAI-compatible client is built (sessions and
// the init probe).
//
// SECURITY: the `openai` SDK reads OPENAI_ORG_ID, OPENAI_PROJECT_ID
// and OPENAI_CUSTOM_HEADERS from the environment on its own and sends
// them with every request, whatever host the client points at, and a
// custom `Authorization` line replaces the profile's own key
// (node_modules/openai/client.js:184, :254-264, :1405-1421 in 7.57.0).
// Toward xAI, Google, NVIDIA, Ollama or any other host that would hand
// an OpenAI organization id, project id or token to a third party, so
// those headers are dropped unless the client's RESOLVED base URL is
// one of OpenAI's own hosts. The resolved URL already falls back to
// OPENAI_BASE_URL inside the SDK, so this module reads no variable.
//
// CONTRACT (catalog-info.yaml, model-providers): `OpenAI-Organization`,
// `OpenAI-Project` and the headers of OPENAI_CUSTOM_HEADERS reach only
// the hosts below; anywhere else a request carries the profile's own
// key and `headers`, nothing more (MNE-001-445, #644).
// ============================================================

/**
 * OpenAI's own API hosts: the data-residency table of `openai` 7.57.0
 * (node_modules/openai/internal/data-residency.js:8-16). Mirrored, because the
 * SDK does not export it; tests/ai/providers/client-headers.spec.ts walks it.
 */
export const OPENAI_API_HOSTS: ReadonlySet<string> = new Set([
  'api.openai.com',
  'us.api.openai.com',
  'eu.api.openai.com',
  'ae.api.openai.com',
  'au.api.openai.com',
  'in.api.openai.com',
  'jp.api.openai.com',
]);

/** True only for https on one of OpenAI's own hosts; anything unparsable is not. */
export function isOpenAiHost(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && OPENAI_API_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The SDK client, with the environment's OpenAI headers scoped to OpenAI. The
 * check runs after `super`, on the URL the SDK resolved, and the subclass keeps
 * the constructor's signature so the SDK's own `withOptions` rebuilds it alike.
 */
class HostScopedOpenAI extends OpenAI {
  constructor(options: ClientOptions) {
    super(options);
    if (isOpenAiHost(this.baseURL)) return;
    this.organization = null;
    this.project = null;
    // The SDK merged OPENAI_CUSTOM_HEADERS under these; put back the profile's alone.
    this._options = { ...this._options, organization: null, project: null, defaultHeaders: options.defaultHeaders };
  }
}

export function createOpenAiClient(profile: Pick<ResolvedProfile, 'base_url' | 'apiKey' | 'headers'>): OpenAI {
  return new HostScopedOpenAI({
    baseURL: profile.base_url,
    // Local endpoints (Ollama, LM Studio) require no key, but the SDK
    // demands a string — a placeholder is the standard practice.
    apiKey: profile.apiKey ?? 'not-needed',
    defaultHeaders: profile.headers,
  });
}
