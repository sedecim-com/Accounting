import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfigFile } from '../providers/config.js';
import {
  evaluateGates,
  applyAllowlist,
  resolveProfileAllowlist,
  type SkillRequires,
} from './gating.js';

// ============================================================
// FIRM SKILLS STORE (progressive disclosure)
// A skill is a directory with a SKILL.md: YAML frontmatter
// (name/description/when_to_use/requires/references) + a
// markdown body. The system prompt carries only a compact
// index; skills_list shows the table; skill_view loads the
// body; readSkillReference loads companion files — the session
// pays context only for what it actually uses.
// Locations: ./skills/ (project) then ~/.mnemosine/skills/
// (user); the project wins on a name clash.
// Parsing is hand-rolled (no YAML dependency) and NEVER
// crashes: a malformed skill is listed as invalid with a
// reason, and invalid or gated skills are invisible to the
// model (see gating.ts).
// ============================================================

export interface SkillFrontmatter {
  name: string;
  description: string;
  whenToUse: string;
  requires: SkillRequires;
  /** Companion .md files (relative to the skill dir) readable on demand. */
  references: string[];
}

export interface ParsedSkill {
  valid: boolean;
  invalidReason?: string;
  frontmatter?: SkillFrontmatter;
  body: string;
}

/** One row of listSkills — diagnostics view (includes invalid/gated). */
export interface SkillListing {
  name: string;
  description: string;
  whenToUse: string;
  valid: boolean;
  invalidReason?: string;
  gated: boolean;
  gateReasons: string[];
}

/** Injectable environment so tests (and callers) control every input. */
export interface SkillStoreOptions {
  /** Defaults to os.homedir(); the user-level skills live under <home>/.mnemosine/skills. */
  homeDir?: string;
  /** Defaults to process.env (gates + PATH lookups). */
  env?: NodeJS.ProcessEnv;
  /** Loaded mnemosine config for requires.config gates + profile allowlist.
   *  When absent, the store loads it itself (a load FAILURE counts as "no
   *  config": config-gated skills stay gated — fail closed, never crash). */
  config?: unknown;
  /** Per-profile allowlist (FINAL set). When absent, derived from the
   *  active profile's `skills` key in the config, if any. */
  allowlist?: string[];
}

const TOP_KEYS = new Set(['name', 'description', 'when_to_use', 'requires', 'references']);
const REQUIRES_KEYS = new Set(['bins', 'env', 'config']);
const KEY_LINE_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/;

function unquote(s: string): string {
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}

/** `[a, b]` → string[]; anything else → the unquoted scalar. */
function parseInlineValue(raw: string): string | string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => unquote(s.trim())).filter((s) => s.length > 0);
  }
  return unquote(trimmed);
}

function invalid(reason: string, body = ''): ParsedSkill {
  return { valid: false, invalidReason: reason, body };
}

/**
 * Parses one SKILL.md: `---`-delimited frontmatter with flat keys plus one
 * nesting level (requires.bins/env/config; list blocks with `- item`).
 * Unknown keys are REJECTED (skill marked invalid, never silently ignored:
 * a typo like `when_to_us` would otherwise ship a half-configured skill).
 */
export function parseSkillMarkdown(raw: string): ParsedSkill {
  const lines = raw.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return invalid('missing frontmatter (file must start with ---)');
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return invalid('unterminated frontmatter (no closing ---)');
  const body = lines.slice(end + 1).join('\n').trim();

  const scalars: Record<string, string> = {};
  const requires: SkillRequires = { bins: [], env: [], config: [] };
  const references: string[] = [];
  // Parser context: which block is open, and which list the next `- item` feeds.
  let openBlock: 'requires' | 'references' | null = null;
  let openList: string[] | null = null;

  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indented = /^\s/.test(line);

    if (!indented) {
      openBlock = null;
      openList = null;
      const m = KEY_LINE_RE.exec(trimmed);
      if (!m) return invalid(`malformed frontmatter line ${i + 1}: "${trimmed}"`, body);
      const [, key, rest] = m;
      if (!TOP_KEYS.has(key)) return invalid(`unknown frontmatter key "${key}"`, body);
      const value = rest.trim();
      if (key === 'requires') {
        if (value !== '') return invalid('requires must be a nested block', body);
        openBlock = 'requires';
      } else if (key === 'references') {
        if (value === '') {
          openBlock = 'references';
          openList = references;
        } else {
          const parsed = parseInlineValue(value);
          if (!Array.isArray(parsed)) return invalid('references must be a list', body);
          references.push(...parsed);
        }
      } else {
        if (value === '') return invalid(`key "${key}" has no value`, body);
        scalars[key] = unquote(value);
      }
      continue;
    }

    // Indented line: list item or a requires sub-key.
    if (trimmed.startsWith('- ') || trimmed === '-') {
      const item = unquote(trimmed.replace(/^-\s*/, '').trim());
      if (!openList) return invalid(`list item outside a list block (line ${i + 1})`, body);
      if (item) openList.push(item);
      continue;
    }
    if (openBlock === 'requires') {
      const m = KEY_LINE_RE.exec(trimmed);
      if (!m) return invalid(`malformed requires line ${i + 1}: "${trimmed}"`, body);
      const [, sub, rest] = m;
      if (!REQUIRES_KEYS.has(sub)) return invalid(`unknown requires key "${sub}"`, body);
      const target = requires[sub as keyof SkillRequires];
      const value = rest.trim();
      if (value === '') {
        openList = target; // block list follows
      } else {
        const parsed = parseInlineValue(value);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        target.push(...items.filter((s) => s.length > 0));
        openList = null;
      }
      continue;
    }
    return invalid(`unexpected indented line ${i + 1}: "${trimmed}"`, body);
  }

  for (const required of ['name', 'description', 'when_to_use']) {
    if (!scalars[required]) return invalid(`missing required frontmatter key "${required}"`, body);
  }

  return {
    valid: true,
    body,
    frontmatter: {
      name: scalars.name,
      description: scalars.description,
      whenToUse: scalars.when_to_use,
      requires,
      references,
    },
  };
}

// ─── Discovery ───

export function skillDirs(cwd: string, homeDir: string): string[] {
  return [path.join(cwd, 'skills'), path.join(homeDir, '.mnemosine', 'skills')];
}

interface DiscoveredSkill {
  name: string;
  dir: string;
  parsed: ParsedSkill;
}

function discover(cwd: string, homeDir: string): DiscoveredSkill[] {
  const found: DiscoveredSkill[] = [];
  const seen = new Set<string>();
  for (const root of skillDirs(cwd, homeDir)) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue; // location absent: fine
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const skillFile = path.join(dir, 'SKILL.md');
      let parsed: ParsedSkill;
      try {
        parsed = parseSkillMarkdown(fs.readFileSync(skillFile, 'utf-8'));
      } catch {
        continue; // no SKILL.md: not a skill directory
      }
      // Identity: the frontmatter name when valid, the directory name as the
      // diagnostic fallback for invalid skills. Project wins on a clash.
      const name = parsed.frontmatter?.name ?? entry.name;
      if (seen.has(name)) continue;
      seen.add(name);
      found.push({ name, dir, parsed });
    }
  }
  return found;
}

// ─── Environment resolution ───

interface ResolvedEnvironment {
  env: NodeJS.ProcessEnv;
  config: unknown;
  allowlist: string[] | undefined;
  homeDir: string;
}

function resolveEnvironment(cwd: string, opts: SkillStoreOptions): ResolvedEnvironment {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? os.homedir();
  let config: unknown = opts.config;
  if (config === undefined && !('config' in opts)) {
    try {
      config = loadConfigFile(cwd).config;
    } catch {
      config = undefined; // unreadable config: config-gated skills stay gated
    }
  }
  let allowlist = opts.allowlist;
  if (allowlist === undefined && !('allowlist' in opts) && typeof config === 'object' && config !== null) {
    const cfg = config as { default_provider?: unknown; providers?: Record<string, unknown> };
    const profileName =
      env.MNEMOSINE_PROVIDER || (typeof cfg.default_provider === 'string' ? cfg.default_provider : '');
    if (profileName && cfg.providers && typeof cfg.providers === 'object') {
      allowlist = resolveProfileAllowlist(cfg.providers[profileName]);
    }
  }
  return { env, config, allowlist, homeDir };
}

// ─── Public API ───

/** Every discovered skill, including invalid and gated ones (diagnostics view
 *  for `doctor`/status; the model-facing surface is visibleSkills). */
export function listSkills(cwd = process.cwd(), opts: SkillStoreOptions = {}): SkillListing[] {
  const { env, config, allowlist, homeDir } = resolveEnvironment(cwd, opts);
  const listings = discover(cwd, homeDir).map((skill): SkillListing => {
    if (!skill.parsed.valid || !skill.parsed.frontmatter) {
      return {
        name: skill.name,
        description: '',
        whenToUse: '',
        valid: false,
        invalidReason: skill.parsed.invalidReason ?? 'invalid skill',
        gated: true, // an invalid skill is never usable
        gateReasons: [],
      };
    }
    const fm = skill.parsed.frontmatter;
    const gate = evaluateGates(fm.requires, { env, config });
    return {
      name: fm.name,
      description: fm.description,
      whenToUse: fm.whenToUse,
      valid: true,
      gated: gate.gated,
      gateReasons: gate.reasons,
    };
  });
  // The allowlist is the FINAL set — but only over the diagnostics dimension
  // of *which* skills exist for this profile; gating already happened above.
  return applyAllowlist(listings, allowlist);
}

/** The model-facing set: valid, gate-open, allowlist-surviving skills. */
export function visibleSkills(cwd = process.cwd(), opts: SkillStoreOptions = {}): SkillListing[] {
  return listSkills(cwd, opts).filter((s) => s.valid && !s.gated);
}

// ─── Untrusted skill-content fencing ───
// Skills are attacker-controllable input: any directory dropped into ./skills
// (a cloned repo, a shared skills pack) or ~/.mnemosine/skills bypasses the
// staged-draft trust scanner (which only governs AI-proposed writes). So a
// skill's author-controlled strings must NEVER sit unfenced in the trusted
// system prompt, nor impersonate system instructions in a tool result. Every
// surface neutralizes them the same way CFDI third-party data is fenced.
export const UNTRUSTED_SKILL_OPEN = '<<<UNTRUSTED_SKILL_DATA>>>';
export const UNTRUSTED_SKILL_CLOSE = '<<<END_UNTRUSTED_SKILL_DATA>>>';

/** Replace the ASCII marker delimiters with visually similar angle quotes so
 *  skill text can never open or close an UNTRUSTED block (a body containing the
 *  literal closing marker must not escape the wrapper). */
function neutralizeMarkerDelimiters(text: string): string {
  return text.replace(/<<</g, '‹‹‹').replace(/>>>/g, '›››');
}

/** Collapse newlines and control chars to spaces so a single skill-authored
 *  scalar cannot break out of its one line in the index or forge extra rows. */
function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** One-line, neutralized rendering of a skill-authored scalar (name /
 *  description / whenToUse) for inline use in the prompt index or tool rows. */
export function neutralizeSkillField(value: string): string {
  return neutralizeMarkerDelimiters(stripControlChars(value));
}

/** Fence a multi-line skill-authored block (a body or declared reference
 *  contents) between explicit start+end untrusted markers. Marker delimiters
 *  inside the content are neutralized first so the body cannot forge the
 *  closing fence; newlines are preserved (bodies are legitimately multi-line). */
export function fenceUntrustedSkillContent(content: string): string {
  return `${UNTRUSTED_SKILL_OPEN}\n${neutralizeMarkerDelimiters(content)}\n${UNTRUSTED_SKILL_CLOSE}`;
}

/** Uniform refusal: unknown, invalid, and gated skills are indistinguishable
 *  from the model's side — naming the difference would leak what exists. */
function unknownSkillError(name: string): Error {
  return new Error(`No skill named "${name}" is available. Use skills_list to see the available skills.`);
}

function findVisible(
  name: string,
  cwd: string,
  opts: SkillStoreOptions
): { dir: string; parsed: ParsedSkill } {
  const visible = new Set(visibleSkills(cwd, opts).map((s) => s.name));
  if (!visible.has(name)) throw unknownSkillError(name);
  const found = discover(cwd, opts.homeDir ?? os.homedir()).find((s) => s.name === name);
  if (!found || !found.parsed.valid) throw unknownSkillError(name);
  return found;
}

/** Full body of a visible skill (progressive disclosure step 2). */
export function viewSkill(
  name: string,
  cwd = process.cwd(),
  opts: SkillStoreOptions = {}
): { frontmatter: SkillFrontmatter; body: string } {
  const { parsed } = findVisible(name, cwd, opts);
  return { frontmatter: parsed.frontmatter as SkillFrontmatter, body: parsed.body };
}

/**
 * A companion reference file (progressive disclosure step 3). Traversal-safe
 * by construction: the file must be DECLARED in the frontmatter references,
 * must be relative with no `..` segments, and must resolve inside the skill
 * directory — each check independent, all fail closed.
 */
export function readSkillReference(
  name: string,
  file: string,
  cwd = process.cwd(),
  opts: SkillStoreOptions = {}
): string {
  const { dir, parsed } = findVisible(name, cwd, opts);
  const fm = parsed.frontmatter as SkillFrontmatter;
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) {
    throw new Error(`Invalid reference path "${file}": references are relative files inside the skill.`);
  }
  if (!fm.references.includes(file)) {
    throw new Error(
      `Skill "${name}" declares no reference "${file}". Declared: ${fm.references.join(', ') || '(none)'}.`
    );
  }
  const resolved = path.resolve(dir, file);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error(`Invalid reference path "${file}": it escapes the skill directory.`);
  }
  // Symlinks INSIDE the skill dir are followed by readFileSync, so a declared
  // reference could point at process-readable secrets (loaded config, .env) or
  // another tenant's files that the skill author cannot read. Realpath both
  // sides and require the real target to stay inside the real skill dir. Fail
  // CLOSED on any realpath error (a missing file included).
  let realResolved: string;
  let realDir: string;
  try {
    realResolved = fs.realpathSync(resolved);
    realDir = fs.realpathSync(dir);
  } catch {
    throw new Error(`Invalid reference path "${file}": it could not be resolved.`);
  }
  if (realResolved !== realDir && !realResolved.startsWith(realDir + path.sep)) {
    throw new Error(`Invalid reference path "${file}": it escapes the skill directory.`);
  }
  return fs.readFileSync(realResolved, 'utf-8');
}

// ─── System-prompt index ───

export const SKILLS_INDEX_MAX_CHARS = 600;

/**
 * Compact index for the CACHED stable block of the system prompt: one line
 * per visible skill, capped so a large skill library cannot bloat every
 * session. Returns '' when nothing is visible (the caller omits the section
 * entirely). Never throws: a broken skills dir must not break the session.
 */
export function skillsPromptIndex(
  cwd = process.cwd(),
  opts: SkillStoreOptions = {},
  maxChars = SKILLS_INDEX_MAX_CHARS
): string {
  let skills: SkillListing[];
  try {
    skills = visibleSkills(cwd, opts);
  } catch {
    return '';
  }
  if (skills.length === 0) return '';
  const lines: string[] = [];
  let used = 0;
  let shown = 0;
  for (const s of skills) {
    // Skill name/description are author-controlled: neutralize markers and
    // strip newlines/control chars so a malicious skill cannot poison the
    // cached trusted block or forge extra index rows. The whole index is then
    // fenced (below) so even the neutralized text sits inside an untrusted
    // block, never as unfenced trusted prose.
    const line = `- ${neutralizeSkillField(s.name)} — ${neutralizeSkillField(s.description)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown === 0) return ''; // pathological: even one line exceeds the cap
  const rest = skills.length - shown;
  if (rest > 0) lines.push(`(+${rest} more via skills_list)`);
  return `${UNTRUSTED_SKILL_OPEN}\n${lines.join('\n')}\n${UNTRUSTED_SKILL_CLOSE}`;
}
