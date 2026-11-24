import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { isInstallationSecretVariable, listProfiles, userConfigPath } from './config.js';
import type { ProviderProfile } from './types.js';
import { t } from '../../i18n/index.js';

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
//   - it is advisory: nothing refuses to run because of it, except
//     chat's `/provider`, which keeps the current session rather than
//     switch to a profile with no credential (MNE-001-444). The live
//     calls (status's probe, init's probe, the session) still go
//     through resolveProfile, which runs the helper as today.
// It reads the environment the way resolveProfile does: an empty
// variable counts as unset, and the variable wins over the helper.
// For an `anthropic` profile it then looks where the Anthropic SDK looks
// (anthropicSdkSource, below), because the session builds `new Anthropic()`
// when the profile's own variable and helper give nothing (index.ts).
// (MNE-001-443 and MNE-001-444, #644.)
// ============================================================

/** Where the user gets each credential (deep-links). */
export const KEY_URLS: Record<string, string> = {
  // The page Anthropic's authentication docs name; the old console link 301s here (MNE-001-444).
  ANTHROPIC_API_KEY: 'https://platform.claude.com/settings/keys',
  OPENAI_API_KEY: 'https://platform.openai.com/api-keys',
  NOUS_API_KEY: 'https://portal.nousresearch.com',
  GEMINI_API_KEY: 'https://aistudio.google.com/apikey',
  XAI_API_KEY: 'https://console.x.ai',
  NVIDIA_API_KEY: 'https://build.nvidia.com (profile menu, Settings, API Keys)',
  MINIMAX_API_KEY: 'https://www.minimax.io/platform',
  DASHSCOPE_API_KEY: 'https://dashscope.console.aliyun.com',
  OPENROUTER_API_KEY: 'https://openrouter.ai/keys',
  HERMES_AGENT_KEY: 'API_SERVER_KEY in ~/.hermes/.env (run: hermes gateway)',
  OPENCLAW_GATEWAY_TOKEN: 'OpenClaw gateway token (local config)',
  COPILOT_API_TOKEN: 'GitHub OAuth flow — requires a copilot-api style proxy',
};

/** One of the Anthropic SDK's own sources, named but never read for its value. */
export type AnthropicSdkSource =
  /** ANTHROPIC_API_KEY, for a profile whose api_key_env names another variable. */
  | { via: 'api_key' }
  | { via: 'auth_token' }
  /** An auth line of ANTHROPIC_CUSTOM_HEADERS, which the SDK accepts as authentication. */
  | { via: 'custom_header'; header: 'x-api-key' | 'Authorization' }
  /** `<config_dir>/configs/<profile>.json`, as `ant auth login` leaves it. */
  | { via: 'profile'; profile: string; file: string }
  /** Workload identity federation from the environment: a workload's credential, not a person's. */
  | { via: 'federation' };

/** Where a profile's credential comes from, or what is missing. */
export type CredentialSource =
  | { kind: 'env'; variable: string }
  /** An `anthropic` profile with neither variable nor helper: a source the SDK reads on its own. */
  | { kind: 'anthropic'; sdk: AnthropicSdkSource }
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
  /** The operating system, which picks the Anthropic SDK's config root; default process.platform. */
  platform?: NodeJS.Platform;
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

// ============================================================
// THE ANTHROPIC SDK'S OWN SOURCES
//
// MIRRORS @anthropic-ai/sdk 0.128.0 (node_modules/@anthropic-ai/sdk). An SDK
// upgrade can add or reorder a source: re-read the files cited at each step
// and move this with it. The answer stays advisory, so a source the mirror
// misses makes it say «missing» while the session still works, never the
// other way round. Order, as the SDK resolves it:
//   1. ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN (client.js:70-81);
//   2. an x-api-key or Authorization line of ANTHROPIC_CUSTOM_HEADERS, which
//      validateHeaders accepts as authentication (client.js:116-126, :315-318);
//   3. the config root: ANTHROPIC_CONFIG_DIR; on Windows APPDATA\Anthropic,
//      else USERPROFILE\AppData\Roaming\Anthropic, else none; elsewhere
//      $XDG_CONFIG_HOME/anthropic, else $HOME/.config/anthropic, else none
//      (core/credentials.js:255-288). With no root nothing below is read;
//   4. <root>/configs/<profile>.json, the profile being ANTHROPIC_PROFILE, else
//      the contents of <root>/active_config, else `default` (:58-125, :289-310);
//   5. federation from the environment when that file is absent:
//      ANTHROPIC_FEDERATION_RULE_ID and ANTHROPIC_ORGANIZATION_ID (:112-138),
//      and ANTHROPIC_IDENTITY_TOKEN_FILE or ANTHROPIC_IDENTITY_TOKEN, without
//      which the chain throws (lib/credentials/credential-chain.js:61-120,
//      :155-185).
// SECURITY: it reads variables only to see whether they are set, checks that
// the profile file EXISTS without opening it, and never opens
// credentials/<profile>.json or the identity token file. It reads
// active_config, which holds a profile name and no secret.
// ============================================================

/** The SDK's readEnv: trimmed, and empty counts as unset (internal/utils/env.js:11-19). */
function sdkEnv(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/** The SDK's validateProfileName (core/credentials.js:43-57), as a predicate. */
function isSdkProfileName(name: string): boolean {
  return name !== '.' && name !== '..' && /^[A-Za-z0-9_.-]+$/.test(name);
}

/** The auth header an ANTHROPIC_CUSTOM_HEADERS value carries, parsed as the SDK parses it. */
function customAuthHeader(value: string | undefined): 'x-api-key' | 'Authorization' | null {
  if (!value) return null;
  const parsed: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const colon = line.indexOf(':');
    if (colon >= 0) parsed[line.substring(0, colon).trim()] = line.substring(colon + 1).trim();
  }
  let found: 'x-api-key' | 'Authorization' | null = null;
  for (const [name, headerValue] of Object.entries(parsed)) {
    if (!headerValue) continue;
    const lower = name.toLowerCase();
    if (lower === 'x-api-key') return 'x-api-key';
    if (lower === 'authorization') found = 'Authorization';
  }
  return found;
}

/** The SDK's config root, or null when it resolves none. */
export function anthropicConfigRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | null {
  const configDir = sdkEnv(env.ANTHROPIC_CONFIG_DIR);
  if (configDir) return configDir;
  if (platform === 'win32') {
    const appData = sdkEnv(env.APPDATA);
    if (appData) return path.join(appData, 'Anthropic');
    const userProfile = sdkEnv(env.USERPROFILE);
    if (userProfile) return path.join(userProfile, 'AppData', 'Roaming', 'Anthropic');
    return null;
  }
  const xdgConfigHome = sdkEnv(env.XDG_CONFIG_HOME);
  if (xdgConfigHome) return path.join(xdgConfigHome, 'anthropic');
  const homeDir = sdkEnv(env.HOME);
  if (homeDir) return path.join(homeDir, '.config', 'anthropic');
  return null;
}

/** The SDK's active profile name under `root`, or null when the SDK would throw on it. */
function activeAnthropicProfile(root: string, env: NodeJS.ProcessEnv): string | null {
  let name = sdkEnv(env.ANTHROPIC_PROFILE);
  if (!name) {
    try {
      name = fs.readFileSync(path.join(root, 'active_config'), 'utf-8').trim() || 'default';
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') return null;
      name = 'default';
    }
  }
  return isSdkProfileName(name) ? name : null;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** The first of the SDK's own sources that is present, in the SDK's order, or null. */
export function anthropicSdkSource(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform
): AnthropicSdkSource | null {
  if (sdkEnv(env.ANTHROPIC_API_KEY)) return { via: 'api_key' };
  if (sdkEnv(env.ANTHROPIC_AUTH_TOKEN)) return { via: 'auth_token' };
  const header = customAuthHeader(sdkEnv(env.ANTHROPIC_CUSTOM_HEADERS));
  if (header) return { via: 'custom_header', header };

  const root = anthropicConfigRoot(env, platform);
  if (root === null) return null;
  const profile = activeAnthropicProfile(root, env);
  if (profile === null) return null;
  const file = path.join(root, 'configs', `${profile}.json`);
  if (isFile(file)) return { via: 'profile', profile, file };

  const federation =
    sdkEnv(env.ANTHROPIC_FEDERATION_RULE_ID) &&
    sdkEnv(env.ANTHROPIC_ORGANIZATION_ID) &&
    (sdkEnv(env.ANTHROPIC_IDENTITY_TOKEN_FILE) || sdkEnv(env.ANTHROPIC_IDENTITY_TOKEN));
  return federation ? { via: 'federation' } : null;
}

function anthropicLabel(sdk: AnthropicSdkSource, home: string): string {
  switch (sdk.via) {
    case 'api_key':
      return t('provider.credential.anthropic.api_key');
    case 'auth_token':
      return t('provider.credential.anthropic.auth_token');
    case 'custom_header':
      return t('provider.credential.anthropic.custom_header', { header: sdk.header });
    case 'profile':
      return t('provider.credential.anthropic.profile', { profile: sdk.profile, file: collapseHome(sdk.file, home) });
    case 'federation':
      return t('provider.credential.anthropic.federation');
  }
}

/** The readiness answer for one profile. Pure apart from reading ./.env. */
export function credentialState(profile: ProviderProfile, options: CredentialStateOptions = {}): CredentialState {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const isAnthropic = profile.type === 'anthropic';
  // An anthropic profile that names no variable still reads ANTHROPIC_API_KEY,
  // because the session then builds `new Anthropic()`, which reads it.
  const variable = profile.api_key_env ?? (isAnthropic ? 'ANTHROPIC_API_KEY' : undefined);

  let source: CredentialSource;
  let sdk: AnthropicSdkSource | null = null;
  if (variable && isInstallationSecretVariable(variable)) {
    source = { kind: 'refused', variable };
  } else if (variable && env[variable]) {
    source = { kind: 'env', variable };
  } else if (profile.api_key_cmd) {
    const file = options.source ?? null;
    source = { kind: 'helper', file, shared: file !== null && file !== userConfigPath(home) };
  } else if (isAnthropic && (sdk = anthropicSdkSource(env, options.platform))) {
    source = { kind: 'anthropic', sdk };
  } else if (variable) {
    const where = KEY_URLS[variable] ?? (isAnthropic ? KEY_URLS.ANTHROPIC_API_KEY : undefined) ?? null;
    source = { kind: 'missing', variable, where };
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
      label = t('provider.credential.env', { variable: source.variable });
      break;
    case 'helper':
      label = !source.file
        ? t('provider.credential.helper')
        : t(source.shared ? 'provider.credential.helper_in_shared' : 'provider.credential.helper_in', {
            file: collapseHome(source.file, home),
          });
      break;
    case 'anthropic':
      label = anthropicLabel(source.sdk, home);
      break;
    case 'none':
      label = t(source.local ? 'provider.credential.local' : 'provider.credential.none');
      break;
    case 'missing':
      label = source.where
        ? t('provider.credential.missing_at', { variable: source.variable, where: source.where })
        : t('provider.credential.missing', { variable: source.variable });
      break;
    case 'refused':
      label = t('provider.credential.refused', { variable: source.variable });
      break;
  }
  const folderFile = collapseHome(path.join(cwd, '.env'), home);
  if (folderEnv === 'key') {
    label = t('provider.credential.folder_key', { label, file: folderFile });
  } else if (folderEnv === 'empty') {
    label = t('provider.credential.folder_empty', { label, variable: variable ?? '', file: folderFile });
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
