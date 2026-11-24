import { providerReadiness, type CredentialState, type CredentialStateOptions } from '../ai/providers/credential-state.js';
import { MissingProviderCredentialError, approveProjectProfile, resolveProfile } from '../ai/providers/config.js';
import type { ProviderProfile, ResolvedProfile } from '../ai/providers/types.js';
import { t } from '../i18n/index.js';

// ============================================================
// The readiness answer, as `mnemosine providers` and the
// `jobs run-due` tick print it (MNE-001-443). Both read
// credential-state, the module doctor, status and init read too,
// so every surface gives the same answer. Neither runs a helper.
//
// MNE-001-444 adds what chat and ask say when the credential is
// missing: the same answer, with where to get it, the alternative
// and `mnemosine init --section ai`, and chat's `/provider`, which
// keeps the current session instead of switching to a profile that
// cannot answer.
// ============================================================

export interface ReadinessPalette {
  dim: (s: string) => string;
  bold: (s: string) => string;
  cyan: (s: string) => string;
}

type ReadinessOptions = Omit<CredentialStateOptions, 'source'>;

function mark(state: CredentialState): string {
  if (!state.ready) return '✘';
  return state.source.kind === 'none' && !state.source.local ? '○' : '✔';
}

/** The lines of `mnemosine providers`: every profile with its credential answer. */
export function providerLines(c: ReadinessPalette, options: ReadinessOptions = {}): string[] {
  const { profiles, states, defaultName, source } = providerReadiness(options);
  const out: string[] = [];
  for (const [name, p] of Object.entries(profiles)) {
    const state = states[name];
    const isDefault = name === defaultName ? c.cyan(' ← default') : '';
    const key = `${mark(state)} ${state.label}`;
    out.push(`${c.bold(name)}${isDefault}`);
    out.push(c.dim(`  ${p.type} · ${p.model}${p.base_url ? ` · ${p.base_url}` : ''} · ${p.tools === false ? 'no tools' : 'tools'} · `) + key);
    if (p.note) out.push(c.dim(`  ${p.note}`));
  }
  out.push(
    c.dim(
      source
        ? `\nConfig: ${source}`
        : '\nUsing built-in profiles. Customize with mnemosine.config.json (or ~/.mnemosine/config.json) ' +
            'and pick the default with "default_provider", MNEMOSINE_PROVIDER or --provider.'
    )
  );
  return out;
}

/**
 * What `mnemosine providers approve <name>` prints (MNE-001-452, #645): what
 * was approved, for which file and host, and never the command itself.
 */
export function approveProfileLines(name: string, c: Pick<ReadinessPalette, 'dim'>, cwd?: string): string[] {
  const r = approveProjectProfile(name, cwd);
  if (r.file === null) return [t('provider.approve.builtin', { name })];
  if (!r.shared) return [t('provider.approve.own_file', { name, file: r.file })];
  if (r.approved.length === 0) return [t('provider.approve.nothing', { name, file: r.file })];
  const out: string[] = [];
  if (r.approved.includes('helper')) {
    out.push(t('provider.approve.helper', { name, file: r.file, host: r.host }));
    if (r.never) out.push(c.dim(t('provider.approve.never')));
  }
  if (r.approved.includes('pair')) {
    out.push(t('provider.approve.pair', { name, file: r.file, variable: r.variable ?? '', host: r.host }));
  }
  return out;
}

/**
 * The tick's first line: which profile it opens sessions on and where that
 * credential comes from. The tick spends the credential of whoever runs it on
 * every due job of the entity, including jobs someone else created (#644,
 * question 3; the adoption policy is #646), so it says so before any job runs.
 */
export function tickCredentialLine(options: ReadinessOptions = {}): string {
  let readiness: ReturnType<typeof providerReadiness>;
  try {
    readiness = providerReadiness(options);
  } catch {
    // Fixed text: the loader's error names files, and the tick's output is logged.
    return 'provider: the configuration does not load (mnemosine doctor says why)';
  }
  const { defaultName, states } = readiness;
  const state = states[defaultName];
  if (!state) return `provider ${defaultName} does not exist (mnemosine doctor says more)`;
  return `provider ${defaultName} · ${state.label} · the credential of the user running this tick`;
}

/**
 * What a person with no usable credential for `name` reads, or null when
 * there is nothing to say. Built from the readiness answer alone, so it never
 * runs a helper. `keyless` also speaks for a remote profile that names no
 * credential at all (chat's `/provider` refuses it; startup does not).
 *
 * Every hint names `api_key_env`, `api_key_cmd` or Anthropic, so the broken
 * startup's repair line (repairCommandFor in mnemosine.ts) maps it to
 * `mnemosine init --section ai` in either language.
 */
export function missingCredentialHint(
  name: string,
  profile: ProviderProfile,
  state: CredentialState,
  options: { keyless?: boolean } = {}
): string | null {
  const { source } = state;
  if (source.kind === 'refused') {
    return t('provider.credential.hint.refused', { name, variable: source.variable });
  }
  if (source.kind === 'unapproved') {
    if (source.variable) {
      return t('provider.credential.hint.unapproved_pair', {
        name, file: source.file, variable: source.variable, host: source.host ?? '',
      });
    }
    return t(source.never ? 'provider.credential.hint.unapproved_never' : 'provider.credential.hint.unapproved', {
      name,
      file: source.file,
    });
  }
  if (source.kind === 'missing') {
    const problem = source.where
      ? t('provider.credential.hint.missing_at', { name, variable: source.variable, where: source.where })
      : t('provider.credential.hint.missing', { name, variable: source.variable });
    const alternative = t(
      profile.type === 'anthropic'
        ? 'provider.credential.hint.anthropic_alternative'
        : 'provider.credential.hint.helper_alternative'
    );
    return `${problem} ${alternative}`;
  }
  if (options.keyless && source.kind === 'none' && !source.local) {
    return t('provider.credential.hint.keyless', { name });
  }
  return null;
}

/**
 * The lines chat and ask print when a session could not start, or its first
 * turn could not authenticate, for lack of a credential: the hint and
 * `mnemosine init --section ai`. Null for any other error, or when the
 * readiness answer sees a credential (then the error is printed as it came).
 */
export function credentialErrorHint(
  err: unknown,
  providerName: string | undefined,
  options: ReadinessOptions = {}
): string[] | null {
  const message = err instanceof Error ? err.message : String(err);
  const isMissing =
    err instanceof MissingProviderCredentialError || /could not resolve authentication method/i.test(message);
  if (!isMissing) return null;
  let readiness: ReturnType<typeof providerReadiness>;
  try {
    readiness = providerReadiness(options);
  } catch {
    return null;
  }
  const name = providerName || readiness.defaultName;
  const profile = readiness.profiles[name];
  const state = readiness.states[name];
  if (!profile || !state) return null;
  const hint = missingCredentialHint(name, profile, state);
  return hint ? [hint, t('provider.credential.hint.init')] : null;
}

export type ProviderSwitch<S> =
  /** `credential` is the readiness answer the new session runs with. */
  | { switched: true; session: S; profile: ResolvedProfile; credential: string }
  | { switched: false; message: string };

/**
 * Chat's `/provider <name>`. When the readiness answer says the profile has no
 * credential (or, for a remote profile, names none), it says what is missing
 * and keeps the current session; otherwise it resolves the profile (running
 * its helper, as any session does) and opens a new session on it. An unknown
 * name throws resolveProfile's own error, as before.
 */
export async function switchProvider<S>(
  target: string,
  deps: { currentLabel: string; open: (profile: ResolvedProfile) => Promise<S>; readiness?: ReadinessOptions }
): Promise<ProviderSwitch<S>> {
  const readiness = providerReadiness(deps.readiness);
  const profile = readiness.profiles[target];
  const state = readiness.states[target];
  if (profile && state) {
    const hint = missingCredentialHint(target, profile, state, { keyless: true });
    if (hint) {
      return { switched: false, message: `${hint} ${t('provider.switch.kept', { current: deps.currentLabel })}` };
    }
  }
  const resolved = resolveProfile(target, undefined, deps.readiness?.cwd);
  return { switched: true, session: await deps.open(resolved), profile: resolved, credential: state?.label ?? '' };
}
