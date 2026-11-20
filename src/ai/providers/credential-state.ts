import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { isInstallationSecretVariable, listProfiles, userConfigPath } from './config.js';
import type { ProviderProfile } from './types.js';

// ============================================================
// «Is this provider ready?» — one answer for every surface
//
// SECURITY: this module decides what doctor, `mnemosine providers`,
// `mnemosine status`, the init wizard and the `jobs run-due` tick
// tell a person about a credential, so it holds three rules:
//   - it never runs an api_key_cmd (it only says that one exists and
//     in which file), so it can never print a helper's command, its
//     output or its stderr;
//   - it never prints a variable's VALUE, only its name;
//   - it is advisory: nothing refuses to run because of it. The live
//     calls (status's probe, init's probe, the session) still go
//     through resolveProfile, which runs the helper as today.
// It reads the environment the way resolveProfile does: an empty
// variable counts as unset, and the variable wins over the helper.
// (MNE-001-443, #644.)
// ============================================================

/** Where the user gets each credential (deep-links). */
export const KEY_URLS: Record<string, string> = {
  ANTHROPIC_API_KEY: 'https://console.anthropic.com/settings/keys',
  OPENAI_API_KEY: 'https://platform.openai.com/api-keys',
  NOUS_API_KEY: 'https://portal.nousresearch.com',
  GEMINI_API_KEY: 'https://aistudio.google.com/apikey',
  XAI_API_KEY: 'https://console.x.ai',
  MINIMAX_API_KEY: 'https://www.minimax.io/platform',
  DASHSCOPE_API_KEY: 'https://dashscope.console.aliyun.com',
  OPENROUTER_API_KEY: 'https://openrouter.ai/keys',
  HERMES_AGENT_KEY: 'API_SERVER_KEY in ~/.hermes/.env (run: hermes gateway)',
  OPENCLAW_GATEWAY_TOKEN: 'OpenClaw gateway token (local config)',
  COPILOT_API_TOKEN: 'GitHub OAuth flow — requires a copilot-api style proxy',
};

/** Where a profile's credential comes from, or what is missing. */
export type CredentialSource =
  | { kind: 'env'; variable: string }
  /** An api_key_cmd, in the config file it was read from; a project file is shared. */
  | { kind: 'helper'; file: string | null; shared: boolean }
  /** Neither a variable nor a helper: «local» only for a loopback base_url. */
  | { kind: 'none'; local: boolean }
  | { kind: 'missing'; variable: string; where: string | null }
  /** api_key_env names one of the installation's own secrets: resolveProfile refuses it (MNE-001-445). */
  | { kind: 'refused'; variable: string };

export interface CredentialState {
  source: CredentialSource;
  /** True unless the credential is missing or refused. Advisory only. */
  ready: boolean;
  /**
   * What the folder's ./.env says about the profile's variable: 'key' when it
   * defines a value (that key serves everyone who runs mnemosine there),
   * 'empty' when it defines it empty (which hides ~/.mnemosine/.env, since the
   * CLI loads ./.env first and keeps its value), null otherwise.
   */
  folderEnv: 'key' | 'empty' | null;
  /** The one sentence every surface prints. Never a value, never a command. */
  label: string;
}

export interface CredentialStateOptions {
  /** The folder whose ./.env is read; default process.cwd(). */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Home directory, to tell the user file from a project file; default os.homedir(). */
  home?: string;
  /** The config file the profile was read from (listProfiles().source). */
  source?: string | null;
}

/** True for localhost, 127.0.0.0/8 and ::1; false for anything else or no URL. */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

function collapseHome(p: string, home: string): string {
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** The folder's ./.env as dotenv parses it, or null when there is none. */
function readFolderEnv(cwd: string): Record<string, string> | null {
  const file = path.join(cwd, '.env');
  try {
    return dotenv.parse(fs.readFileSync(file));
  } catch {
    return null;
  }
}

/** The readiness answer for one profile. Pure apart from reading ./.env. */
export function credentialState(profile: ProviderProfile, options: CredentialStateOptions = {}): CredentialState {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const variable = profile.api_key_env;

  let source: CredentialSource;
  if (variable && isInstallationSecretVariable(variable)) {
    source = { kind: 'refused', variable };
  } else if (variable && env[variable]) {
    source = { kind: 'env', variable };
  } else if (profile.api_key_cmd) {
    const file = options.source ?? null;
    source = { kind: 'helper', file, shared: file !== null && file !== userConfigPath(home) };
  } else if (variable) {
    source = { kind: 'missing', variable, where: KEY_URLS[variable] ?? null };
  } else {
    source = { kind: 'none', local: isLoopbackUrl(profile.base_url) };
  }

  let folderEnv: CredentialState['folderEnv'] = null;
  if (variable && source.kind !== 'refused') {
    const parsed = readFolderEnv(cwd);
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, variable)) {
      folderEnv = parsed[variable] === '' ? 'empty' : 'key';
    }
  }

  let label: string;
  switch (source.kind) {
    case 'env':
      label = `${source.variable} set`;
      break;
    case 'helper':
      label = source.file ? `api_key_cmd in ${collapseHome(source.file, home)}` : 'api_key_cmd';
      if (source.shared) label += ', a project file shared by everyone who runs mnemosine in that folder';
      break;
    case 'none':
      label = source.local ? 'local, no credential' : 'no credential configured';
      break;
    case 'missing':
      label = `${source.variable} missing${source.where ? ` (get it at ${source.where})` : ''}`;
      break;
    case 'refused':
      label = `${source.variable} is not a provider credential`;
      break;
  }
  const folderFile = collapseHome(path.join(cwd, '.env'), home);
  if (folderEnv === 'key') {
    label += `; ${folderFile} defines it, so that key serves everyone who runs mnemosine in that folder`;
  } else if (folderEnv === 'empty') {
    label += `; the empty ${variable}= in ${folderFile} hides ~/.mnemosine/.env`;
  }

  return { source, ready: source.kind !== 'missing' && source.kind !== 'refused', folderEnv, label };
}

export interface ProviderReadiness {
  defaultName: string;
  /** The config file that wins here, or null for the built-ins alone. */
  source: string | null;
  profiles: Record<string, ProviderProfile>;
  states: Record<string, CredentialState>;
}

/** The answer for every profile of the config that wins in `cwd`. */
export function providerReadiness(options: Omit<CredentialStateOptions, 'source'> = {}): ProviderReadiness {
  const { profiles, defaultName, source } = listProfiles(options.cwd);
  const states: Record<string, CredentialState> = {};
  for (const [name, profile] of Object.entries(profiles)) {
    states[name] = credentialState(profile, { ...options, source });
  }
  return { defaultName, source, profiles, states };
}
