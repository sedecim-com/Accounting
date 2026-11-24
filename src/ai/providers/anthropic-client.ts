import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import type { ResolvedProfile } from './types.js';

// ============================================================
// The one place an Anthropic client is built (sessions and the
// `mnemosine status` probe), so the probe sends what the session
// sends, to the host the session uses (MNE-001-447, #644).
//
// SECURITY: the client takes the profile's own key and nothing else
// from the profile. With no key it is `new Anthropic()`, which reads
// the person's own sources (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN as
// a bearer token, ANTHROPIC_CUSTOM_HEADERS, `ant auth login`'s profile)
// and ANTHROPIC_BASE_URL. A profile's `base_url` and `headers` never
// reach it: the session never sent them, so neither does the probe.
//
// CONTRACT (catalog-info.yaml, model-providers): the session and the
// `status` probe send the same credential, headers and host.
// ============================================================

/** What a caller may tune; never the host, the headers or a credential. */
export type AnthropicClientOptions = Pick<ClientOptions, 'fetch' | 'maxRetries'>;

export function createAnthropicClient(
  profile: Pick<ResolvedProfile, 'apiKey'>,
  opts: AnthropicClientOptions = {}
): Anthropic {
  return profile.apiKey ? new Anthropic({ ...opts, apiKey: profile.apiKey }) : new Anthropic(opts);
}
