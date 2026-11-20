import { providerReadiness, type CredentialState, type CredentialStateOptions } from '../ai/providers/credential-state.js';

// ============================================================
// The readiness answer, as `mnemosine providers` and the
// `jobs run-due` tick print it (MNE-001-443). Both read
// credential-state, the module doctor, status and init read too,
// so every surface gives the same answer. Neither runs a helper.
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
