// ============================================================
// SKILL TRUST SCANNER
// Skills are EXECUTABLE CONFIG: a SKILL.md is a set of
// instructions a model will follow, so third-party skill
// content is UNTRUSTED CODE. This scanner runs over every
// proposed SKILL.md BEFORE a human sees the draft
// (createSkillDraft stores the report in scan_report) and
// flags the classic supply-chain tells:
//
//   - exfiltration: curl/wget/fetch pointed at non-localhost
//     URLs, base64-decode pipes;
//   - injection: "ignore previous instructions"-style phrases,
//     system-prompt override attempts, and the literal
//     untrusted-marker delimiters (<<< >>>) our prompts use to
//     fence third-party data;
//   - credential_harvesting: reading/echoing env vars, .env
//     files, SSH keys or API keys;
//   - destructive_shell: rm -rf, DROP TABLE, TRUNCATE;
//   - hidden_unicode: invisible characters used to hide
//     payloads from the human reviewer.
//
// Same detection ideas as scanImportedText in
// src/ai/ingest-service.ts, deliberately NOT imported: skills
// are a different domain (markdown instructions, not CFDI
// fields) with their own pattern set and per-line reporting.
//
// The scanner never blocks draft CREATION — flagged drafts are
// listed and reviewable — but approval of a non-clean draft
// requires an explicit --accept-risk, recorded in reviewed_by.
// ============================================================

export type SkillThreatKind =
  | 'exfiltration'
  | 'injection'
  | 'credential_harvesting'
  | 'destructive_shell'
  | 'hidden_unicode';

export interface SkillThreat {
  kind: SkillThreatKind;
  /** 1-based line number in the scanned content. */
  line: number;
  /** The offending line, invisible chars stripped, capped for display. */
  excerpt: string;
}

export interface SkillScanReport {
  threats: SkillThreat[];
  clean: boolean;
}

// Zero-width / directional / invisible characters used to hide or visually
// reorder payloads from a human reviewer. Covers, beyond the zero-width set:
//   - U+00AD soft hyphen, U+180E Mongolian vowel separator;
//   - U+202A\u2013202E bidi embedding/override (RLO scrambles a line in the
//     reviewer's terminal), U+2066\u20132069 bidi isolates;
//   - U+E0000\u2013E007F astral "tag characters" used in ASCII-smuggling prompt
//     injections \u2014 matchable only with the `u` flag.
const INVISIBLE_CLASS =
  '[\\u00AD\\u180E\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\uFEFF]|[\\u{E0000}-\\u{E007F}]';
const INVISIBLE_UNICODE = new RegExp(INVISIBLE_CLASS, 'u');
const INVISIBLE_UNICODE_ALL = new RegExp(INVISIBLE_CLASS, 'gu');

// Hosts that never count as exfiltration targets.
const LOCAL_HOST = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|0\.0\.0\.0|\[::1\])(:\d+)?$/i;

// curl/wget/fetch followed (same line) by a URL. The bounded quantifier
// keeps the scan linear on adversarial single-line input.
const NET_CMD_URL = /\b(curl|wget|fetch)\b[^\n]{0,300}?https?:\/\/([^\s/"'`)>]+)/gi;
// base64 decode on either side of a pipe: classic payload-smuggling step.
const BASE64_PIPE = /(\|[^\n|]{0,120}\bbase64\b[^\n|]{0,40}(-d|--decode)\b)|(\bbase64\b[^\n|]{0,40}(-d|--decode)\b[^\n|]{0,120}\|)/i;

// Instruction-override phrases (English + Spanish — despacho skills are
// likelier to smuggle Spanish payloads) and system-prompt override attempts.
const INJECTION_PHRASES: RegExp[] = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(all\s+)?(previous|prior)\s+(instructions|rules)/i,
  /you\s+are\s+now\s+(a|an|the)\b/i,
  /(override|replace|forget|reset)\s+(the\s+|your\s+)?system\s+prompt/i,
  /new\s+system\s+prompt\s*:/i,
  /<\|?\s*system\s*\|?>/i,
  // Spanish
  /ignor[ae]\s+(todas\s+)?(las\s+)?instrucciones\s+(anteriores|previas)/i,
  /olvida\s+(todas\s+)?(las\s+)?instrucciones/i,
  /haz\s+caso\s+omiso\s+(de\s+)?(las\s+)?instrucciones/i,
  /ahora\s+eres\s+(un|una|el|la)\b/i,
  /nuevas\s+instrucciones\s*:/i,
];

// The literal delimiters our prompts use to fence untrusted data. A skill
// containing them could open/close a fence and re-trust smuggled content.
const UNTRUSTED_MARKERS = /<<<|>>>/;

// Reading or shipping secrets: env vars, .env files, SSH keys, API keys.
const CREDENTIAL_PATTERNS: RegExp[] = [
  /\b(cat|echo|printf|printenv|env|curl|wget|grep|source)\b[^\n]{0,200}\.env\b/i,
  /\b(cat|echo|printf|curl|wget|grep|scp|base64)\b[^\n]{0,200}id_rsa/i,
  /\b(echo|printf|printenv|curl|wget)\b[^\n]{0,200}\$\{?[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i,
  /\b(send|post|share|paste|print|reveal|show|imprime|muestra|env[ií]a)\b[^\n]{0,120}\b(api[_ -]?keys?|tokens?|secrets?|credentials?|contrase[ñn]as?|claves?)\b/i,
];

// Destructive shell / SQL.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*r[a-z]*f|\brm\s+(-[a-z]*\s+)*-[a-z]*f[a-z]*r/i,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\b/i,
  /\bmkfs\b|\bdd\s+[^\n]{0,80}of=\/dev\//i,
];

const EXCERPT_MAX = 120;

function excerptOf(line: string): string {
  const visible = line.replace(INVISIBLE_UNICODE_ALL, '').trim();
  return visible.length > EXCERPT_MAX ? `${visible.slice(0, EXCERPT_MAX - 1)}…` : visible;
}

/** True when every URL host matched on the line is local. */
function hasNonLocalUrl(text: string): boolean {
  NET_CMD_URL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NET_CMD_URL.exec(text)) !== null) {
    if (!LOCAL_HOST.test(m[2])) return true;
  }
  return false;
}

/**
 * Whole-content view with shell line-continuations (backslash-newline) folded
 * away and every remaining run of whitespace collapsed to a single space, so a
 * command/URL/credential pattern deliberately split across physical lines is
 * still seen as one string. `lineOf(index)` maps a collapsed offset back to the
 * 1-based source line of the character it came from, for the threat report.
 */
function collapseContent(content: string): { collapsed: string; lineOf: (i: number) => number } {
  let collapsed = '';
  const map: number[] = []; // map[collapsedIndex] = source line (1-based)
  let line = 1;
  let lastWasSpace = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    // Shell line-continuation: "\" immediately followed by (\r)?\n joins the
    // two physical lines with nothing between them (so "cu\<newline>rl" → "curl").
    if (ch === '\\' && (content[i + 1] === '\n' || (content[i + 1] === '\r' && content[i + 2] === '\n'))) {
      i += content[i + 1] === '\r' ? 2 : 1;
      line++;
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') {
      const terminatedLine = line;
      if (ch === '\n') line++;
      if (!lastWasSpace) {
        collapsed += ' ';
        map.push(terminatedLine);
        lastWasSpace = true;
      }
      continue;
    }
    collapsed += ch;
    map.push(line);
    lastWasSpace = false;
  }
  const lineOf = (idx: number): number => map[Math.max(0, Math.min(idx, map.length - 1))] ?? 1;
  return { collapsed, lineOf };
}

/** The full source line for `n` (1-based), for a whole-content threat excerpt. */
function sourceLine(content: string, n: number): string {
  return content.split('\n')[n - 1] ?? '';
}

/**
 * Scans a proposed SKILL.md. A per-line pass reports same-line matches with a
 * precise line number and excerpt; a second whole-content pass (continuations
 * folded, whitespace collapsed) catches exfiltration/credential/base64 patterns
 * split across lines to dodge the per-line scan, attributing each to the source
 * line where the match begins. Threats are deduped by (kind, line).
 */
export function scanSkillContent(content: string): SkillScanReport {
  const threats: SkillThreat[] = [];
  const seen = new Set<string>();
  const push = (kind: SkillThreatKind, line: number, excerpt: string) => {
    const key = `${kind}@${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    threats.push({ kind, line, excerpt });
  };

  const lines = content.split('\n');
  lines.forEach((line, i) => {
    const n = i + 1;
    const add = (kind: SkillThreatKind) => push(kind, n, excerptOf(line));

    if (hasNonLocalUrl(line) || BASE64_PIPE.test(line)) add('exfiltration');
    if (INJECTION_PHRASES.some((re) => re.test(line)) || UNTRUSTED_MARKERS.test(line)) add('injection');
    if (CREDENTIAL_PATTERNS.some((re) => re.test(line))) add('credential_harvesting');
    if (DESTRUCTIVE_PATTERNS.some((re) => re.test(line))) add('destructive_shell');
    if (INVISIBLE_UNICODE.test(line)) add('hidden_unicode');
  });

  // Whole-content pass: catch split exfiltration / credential / base64 tells.
  const { collapsed, lineOf } = collapseContent(content);
  const addWhole = (kind: SkillThreatKind, index: number) => {
    const line = lineOf(index);
    push(kind, line, excerptOf(sourceLine(content, line)));
  };

  NET_CMD_URL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NET_CMD_URL.exec(collapsed)) !== null) {
    if (!LOCAL_HOST.test(m[2])) addWhole('exfiltration', m.index);
  }
  const base64 = collapsed.match(BASE64_PIPE);
  if (base64 && base64.index !== undefined) addWhole('exfiltration', base64.index);
  for (const re of CREDENTIAL_PATTERNS) {
    const cm = collapsed.match(re);
    if (cm && cm.index !== undefined) addWhole('credential_harvesting', cm.index);
  }

  return { threats, clean: threats.length === 0 };
}
