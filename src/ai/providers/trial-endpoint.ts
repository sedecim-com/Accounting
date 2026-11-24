import { listProfiles } from './config.js';
import { AppError } from '../../utils/errors.js';
import { t, type TranslationKey } from '../../i18n/index.js';

// ============================================================
// NVIDIA's hosted API catalog is a trial (MNE-001-448, #644 P8)
//
// integrate.api.nvidia.com is for development and evaluation: NVIDIA's
// API Trial Terms of Service let it record what it receives, and ask
// not to send personal data. A client's books must never reach it, so
// whichever way a profile on that host was chosen (--provider,
// MNEMOSINE_PROVIDER, a default_provider in any file, a profile of any
// file):
//   - an unattended session (ingest, jobs run-due, init's import, all
//     of them grounding-off) never opens on it;
//   - an attended one (chat, ask) opens only after the terms were
//     printed and a person typed yes, once per process, which is one
//     chat or ask session; without a terminal it is refused;
//   - a failover walk never moves into it (index.ts);
//   - the eval, which sends only its synthetic golden set, passes an
//     explicit allowance.
// Self-hosted NIM is not this host and is not touched.
// ============================================================

/** The hosted catalog's host, as NVIDIA's API quickstart names it. */
export const NVIDIA_TRIAL_HOST = 'integrate.api.nvidia.com';

/** True when `baseUrl`'s host is the hosted catalog (by host, never by substring). */
export function isTrialEndpoint(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, '') === NVIDIA_TRIAL_HOST;
  } catch {
    return false;
  }
}

/** The one caller allowed past the guard unattended: the eval, over its synthetic golden set. */
export type TrialEndpointAllowance = 'synthetic-golden-set';

const REFUSALS = {
  unattended: 'providers.trial.refused.unattended',
  no_terminal: 'providers.trial.refused.no_terminal',
  declined: 'providers.trial.refused.declined',
  not_accepted: 'providers.trial.refused.not_accepted',
} as const satisfies Record<string, TranslationKey>;

export class TrialEndpointRefusedError extends AppError {
  constructor(reason: keyof typeof REFUSALS, profile: string) {
    super(403, 'AI_TRIAL_ENDPOINT_REFUSED', { key: REFUSALS[reason], params: { profile, host: NVIDIA_TRIAL_HOST } });
    this.name = 'TrialEndpointRefusedError';
  }
}

/** The terms, one line each, in the active language. */
export function trialTermsLines(profile: string): string[] {
  return [
    t('providers.trial.terms.what', { profile, host: NVIDIA_TRIAL_HOST }),
    t('providers.trial.terms.records'),
    t('providers.trial.terms.limits'),
  ];
}

// A yes typed at the keyboard in this process. A CLI process is one chat or
// ask session, so this is «once per session»; it never covers an unattended
// run, which is refused before it is read.
let acceptedInThisSession = false;

/**
 * SECURITY: the guard where every session is born (createLlmSession). Throws
 * before any client is built, so nothing reaches the host.
 */
export function assertTrialEndpointAllowed(
  profile: { name: string; base_url?: string },
  opts: { unattended: boolean; allowance?: TrialEndpointAllowance }
): void {
  if (!isTrialEndpoint(profile.base_url)) return;
  if (opts.allowance === 'synthetic-golden-set') return;
  if (opts.unattended) throw new TrialEndpointRefusedError('unattended', profile.name);
  if (!acceptedInThisSession) throw new TrialEndpointRefusedError('not_accepted', profile.name);
}

/**
 * Chat and ask, before their session: when the profile they would open is on
 * the hosted catalog, print the terms and ask, once per session. `confirm` is
 * null without a terminal, which refuses; a No refuses too.
 */
export async function acceptTrialTermsFor(
  profileName: string | undefined,
  io: { confirm: ((question: string) => Promise<boolean>) | null; print: (line: string) => void; cwd?: string }
): Promise<void> {
  if (acceptedInThisSession) return;
  const { profiles, defaultName } = listProfiles(io.cwd);
  const name = profileName || defaultName;
  if (!isTrialEndpoint(profiles[name]?.base_url)) return;
  if (!io.confirm) throw new TrialEndpointRefusedError('no_terminal', name);
  for (const line of trialTermsLines(name)) io.print(line);
  if (!(await io.confirm(t('providers.trial.accept_session', { profile: name })))) {
    throw new TrialEndpointRefusedError('declined', name);
  }
  acceptedInThisSession = true;
}

/** jobs run-due, before it claims a job: the tick's default profile must not be on the host. */
export function assertDefaultNotOnTrial(profileName?: string, cwd?: string): void {
  const { profiles, defaultName } = listProfiles(cwd);
  const name = profileName || defaultName;
  if (isTrialEndpoint(profiles[name]?.base_url)) throw new TrialEndpointRefusedError('unattended', name);
}
