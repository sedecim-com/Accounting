// ============================================================
// THE SUBJECT OF A NEW COMMIT IS BORN IN ENGLISH (I22 · issue #165)
//
// The repository ordered the opposite, in writing, in two places
// (`CONTRIBUTING.md` and `docs/PROCESS.md`), and 184 of the 284 non-merge
// subjects on `main` carry an accent as a result. Changing the written order
// is what makes new work stop being born in Spanish; this file is what keeps
// the order from being a suggestion.
//
// WHAT IT DOES NOT DO, said here because the rest of the file reads like it
// does more: it does not verify that the English is good English, that the
// subject says what changed, or that the body explains why. It rejects Spanish
// and it rejects six shapes. Review does the rest.
//
// THE HISTORY IS NOT REWRITTEN. Everything authored before
// SUBJECT_RULE_EFFECTIVE_FROM is skipped and counted. A commit message is a
// record, and a record is not retouched.
// ============================================================

import { execFileSync } from 'node:child_process';
import { judgeLanguage } from './extract.js';

/**
 * The instant the rule takes effect, compared against each commit's AUTHOR
 * date. It never moves forward: moving it forgives, in silence, everything
 * this tranche came to reject — which is why a mutant that moves it turns the
 * criterion red, and why `CONTRIBUTING.md` cites this same string and another
 * check asserts the two still agree.
 *
 * WHY THIS INSTANT AND NOT MIDNIGHT TODAY. It is the first moment after every
 * commit that existed on any branch when the rule was written — measured, not
 * assumed: `git log --format=%at --all` had zero commits at or after it. The
 * first draft used midnight UTC of the day the tranche was written, and that
 * was wrong in a way worth recording: four commits of PR #232 were authored on
 * the evening of the 15th at UTC−6, which is the small hours of the 16th in
 * UTC, so a midnight-today cut-off reached backwards into work written the
 * previous evening and reddened a PR for commits that predate the rule. A
 * cut-off is a promise that nothing already written is judged; it has to clear
 * the whole history, in the timezone the comparison is actually made in.
 */
export const SUBJECT_RULE_EFFECTIVE_FROM = '2026-09-17T00:00:00Z';

/** One commit as the gate sees it. A PR title arrives in the same shape. */
export interface CommitRecord {
  /** Empty for a PR title. */
  sha: string;
  /** Parent count: >1 is a merge. A PR title has 0. */
  parents: number;
  /** Author date in epoch seconds (`%at`), never the committer date. */
  authoredAt: number;
  authorEmail: string;
  authorName: string;
  subject: string;
}

export type Reason =
  | 'ok'
  | 'empty'
  | 'too-long'
  | 'emoji'
  | 'conventional-prefix'
  | 'no-space-after-code'
  | 'too-few-words'
  | 'all-citation'
  | 'accent'
  | 'spanish-prose';

export type Skip = false | 'merge' | 'bot' | 'revert' | 'fixup' | 'before-cutoff';

export interface Verdict {
  ok: boolean;
  skipped: Skip;
  reason: Reason;
  /** What to print when it fails. It must be enough to act on. */
  detail: string;
}

/** Longest subject in the whole history is 135 characters. See the comment. */
const MAX_SUBJECT = 150;

/**
 * Lowercase only, and that is not fussiness: `main` carries both
 * `ci: triage determinista Witness…` (the banned conventional form) and
 * `CI: el espejo se fecha en el periodo…` (a house tranche code). An `/i` flag
 * would reject the house's own shape.
 */
const CONVENTIONAL_PREFIX =
  /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert|merge|lint)(\([^)]*\))?!?:/;

const EMOJI = /\p{Extended_Pictographic}/u;

/** Sentence punctuation that only Spanish writes. Never a citation delimiter. */
const SPANISH_PUNCTUATION = /[¿¡]/;

/** After citations are stripped, one of these is a near-perfect signal. */
const ACCENT = /[áéíóúüñ]/i;

const SQUASH_SUFFIX = /\s*\(#\d+\)$/;

/** `CODE:` at the head, where CODE has no space and no colon. */
const CODE_PREFIX = /^[^\s:]{1,12}:\s*/;

/**
 * Curly quotes folded to straight BEFORE anything else looks at the text.
 *
 * Two problems collapse into one rule. A macOS browser field turns `token's`
 * into `token’s` and `"asiento"` into `“asiento”`, so a gate that only knows
 * straight quotes treats the same sentence differently depending on where it
 * was typed. And U+2019 is both the closing single quote and the apostrophe,
 * so any rule that reads it as a delimiter eats possessives. Folding first
 * means ONE set of guarded rules below decides both cases.
 */
function foldQuotes(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
}

/**
 * Remove what the subject CITES, so that naming a Spanish artifact in an
 * English sentence is not read as writing Spanish. The epic's next nineteen
 * tranches rename Spanish things; `I23: rename account_roles 'contador' to
 * 'accountant'` is the modal subject, not an edge case.
 *
 * THE SINGLE-QUOTE RULE IS GUARDED, and the guard is the whole point. An
 * unguarded `/'[^']*'/g` over
 *
 *     W2: the runner's cache and the token's scope stay apart
 *
 * matches from the apostrophe of `runner's` to the apostrophe of `token's` and
 * DELETES the English between them. The subject is then rejected for a reason
 * that is not true, which is the worst kind of false positive: the author
 * cannot act on the message. So an opening quote must start a word and a
 * closing quote must end one.
 */
function stripCitations(text: string): string {
  return (
    text
      // Backticked spans. `judgeLanguage`'s own `proseOf` also strips these;
      // doing it here too means the accent rule sees the same text it does.
      .replace(/`[^`]*`/g, ' ')
      // Guarded single quotes: opener preceded by a boundary, closer followed
      // by one. `don't`, `it's`, `token's` never match.
      .replace(/(^|[\s([{])'([^']*)'(?=$|[\s,.;:)\]}!?])/g, '$1 ')
      .replace(/"[^"]*"/g, ' ')
      .replace(/«[^»]*»/g, ' ')
      // Identifier-shaped tokens, dropped whole.
      .split(/\s+/)
      .filter((token) => !isIdentifierShaped(token))
      .join(' ')
  );
}

/**
 * A token that names a thing rather than saying something. Bare hyphenated
 * lowercase words are deliberately NOT here: `plan-catalogo` stays in the
 * prose, because dropping them would swallow a Spanish subject written as a
 * slug, and the occasional false positive is repaired by one pair of backticks.
 */
function isIdentifierShaped(token: string): boolean {
  const bare = token.replace(/[.,;:!?)\]}]+$/, '').replace(/^[([{]+/, '');
  if (bare.length === 0) return false;
  if (bare.includes('_')) return true;
  if (bare.includes('/')) return true;
  if (/\.(ts|js|mjs|cjs|json|md|sql|yml|yaml|tsv|csv|sh)$/.test(bare)) return true;
  if (/^[A-Za-z][\w-]*:[A-Za-z][\w-]*$/.test(bare)) return true;
  if (/^[a-z]+[A-Z]/.test(bare)) return true;
  if (/^[A-Z][a-z]+[A-Z]/.test(bare)) return true;
  return false;
}

function wordsIn(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

function verdict(reason: Reason, detail: string): Verdict {
  return { ok: reason === 'ok', skipped: false, reason, detail };
}

/**
 * Format and language, on one subject. Pure: no git, no clock, no environment.
 * This is what the spec exercises.
 */
export function judgeSubject(subject: string): Verdict {
  const raw = foldQuotes(subject).trim();
  if (raw.length === 0) return verdict('empty', 'the subject is empty');

  const withoutSquash = raw.replace(SQUASH_SUFFIX, '');
  if (withoutSquash.length > MAX_SUBJECT) {
    // Deliberately not a style rule. The longest subject the house has ever
    // written is 135 characters and the median is 73; a 72-character cap would
    // reject 151 of 284. This catches one accident — `git commit -m "$(cat
    // notes.txt)"` — and nothing else.
    return verdict('too-long', `${withoutSquash.length} characters, over ${MAX_SUBJECT}`);
  }
  if (EMOJI.test(withoutSquash)) return verdict('emoji', 'CONTRIBUTING.md: "Nada de emoji"');
  if (CONVENTIONAL_PREFIX.test(withoutSquash)) {
    return verdict('conventional-prefix', 'CONTRIBUTING.md: "Nada de `feat:` ni `chore:`"');
  }
  if (/^[^\s:]{1,12}:(?!\s)/.test(withoutSquash)) {
    return verdict('no-space-after-code', 'the tranche code needs a space after its colon');
  }

  const body = withoutSquash.replace(CODE_PREFIX, '');
  if (wordsIn(body) < 3) {
    return verdict('too-few-words', 'a subject says what changed; three words is the floor');
  }

  const prose = stripCitations(body);
  if (wordsIn(prose) < 2) {
    // The rule that closes the quoting bypass: without it, anyone can quote the
    // whole subject and write Spanish through the citation exemption.
    return verdict('all-citation', 'a subject must carry two words of its own outside what it quotes');
  }
  if (ACCENT.test(prose) || SPANISH_PUNCTUATION.test(prose)) {
    return verdict('accent', 'an accent outside a citation — quote the cited term with backticks');
  }
  if (judgeLanguage(prose).spanish) {
    // 73 of the 284 Spanish subjects on `main` carry NO accent. An accent-only
    // check would wave 28 % of them through, which is why this half exists.
    return verdict('spanish-prose', 'the subject reads as Spanish prose');
  }
  return verdict('ok', 'born English');
}

/**
 * One record, with the exemptions that are decided before anything is read as
 * prose. Every exemption here is STRUCTURAL — a parent count, an author
 * identity, a date — and not a string anybody can type. A `^Merge ` or
 * `^Bump ` exemption would be a bypass one keystroke wide, and it would also
 * be wrong: 32 of `main`'s 108 merges do not start with `Merge`.
 */
export function judgeCommit(record: CommitRecord, cutoffEpoch: number): Verdict {
  if (record.parents > 1) return { ok: true, skipped: 'merge', reason: 'ok', detail: 'merge commit' };
  if (isBot(record)) return { ok: true, skipped: 'bot', reason: 'ok', detail: 'written by a bot' };
  if (/^Revert "/.test(record.subject)) {
    return { ok: true, skipped: 'revert', reason: 'ok', detail: 'git quotes the reverted subject' };
  }
  if (/^(fixup|squash)! /.test(record.subject)) {
    return { ok: true, skipped: 'fixup', reason: 'ok', detail: 'git quotes the target subject' };
  }
  if (record.authoredAt < cutoffEpoch) {
    return { ok: true, skipped: 'before-cutoff', reason: 'ok', detail: 'authored before the rule' };
  }
  return judgeSubject(record.subject);
}

function isBot(record: CommitRecord): boolean {
  return /\[bot\]@/.test(record.authorEmail) || /\[bot\]$/.test(record.authorName);
}

const UNIT = '\x1f';
const RECORD = '\x1e';

/**
 * Parse `git log`'s output. Split out from the git call so the separator
 * choice is testable: a subject may contain any printable character, so the
 * fields are separated by control bytes that a subject cannot carry — the same
 * choice `scripts/costo-por-fila.ts` already makes.
 */
export function parseLog(text: string): CommitRecord[] {
  return text
    .split(RECORD)
    .map((chunk) => chunk.replace(/^\n/, ''))
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [sha, parents, authoredAt, authorEmail, authorName, ...rest] = chunk.split(UNIT);
      return {
        sha: sha ?? '',
        parents: (parents ?? '').trim() === '' ? 0 : (parents ?? '').trim().split(' ').length,
        authoredAt: Number.parseInt(authoredAt ?? '0', 10),
        authorEmail: authorEmail ?? '',
        authorName: authorName ?? '',
        subject: rest.join(UNIT),
      };
    });
}

/** The only impure function in the file, and the only one the spec does not reach. */
function collect(range: string): CommitRecord[] {
  const format = ['%H', '%P', '%at', '%ae', '%an', '%s'].join(UNIT) + RECORD;
  // `--no-merges` is deliberately NOT passed: the merge exemption lives in
  // `judgeCommit`, where a unit test can reach it, not in a flag no test covers.
  return parseLog(execFileSync('git', ['log', `--format=${format}`, range], { encoding: 'utf-8' }));
}

function main(argv: string[]): number {
  const cutoffEpoch = Date.parse(SUBJECT_RULE_EFFECTIVE_FROM) / 1000;
  const asJson = argv.includes('--json');

  const oneSubject = valueOf(argv, '--subject');
  if (oneSubject !== undefined) {
    const v = judgeSubject(oneSubject);
    report([{ label: 'subject', record: titleRecord(oneSubject, cutoffEpoch), verdict: v }], asJson, v.ok ? 0 : 1);
    return v.ok ? 0 : 1;
  }

  const range = valueOf(argv, '--range');
  if (range === undefined) {
    process.stderr.write('usage: commit-subjects.ts --range <a..b> | --subject "<text>"\n');
    return 2;
  }

  const records = collect(range);
  const title = process.env.PR_TITLE;
  const titleIsJudged = title !== undefined && title.trim() !== '' && prTitleInScope(cutoffEpoch);
  if (titleIsJudged) records.push(titleRecord(title, cutoffEpoch));

  // A RANGE THAT RESOLVES TO NOTHING IS NOT A PASS.
  //
  // `origin/main..HEAD` on a shallow clone, a wrong base ref or a fetch that
  // silently failed all produce zero records, and zero records with no title
  // to judge prints a green tick for a gate that looked at nothing. Every
  // other instrument in this house fails when it cannot see; so does this one.
  if (records.length === 0) {
    process.stderr.write(
      `commit subjects: the range "${range}" resolved to no commit and there was no title to judge.\n` +
        'That is not a pass: the gate could not see anything. Check fetch-depth and the base ref.\n'
    );
    return 2;
  }

  const judged = records.map((record) => ({
    label: record.sha === '' ? 'PR title' : record.sha.slice(0, 8),
    record,
    verdict: judgeCommit(record, cutoffEpoch),
  }));
  const failed = judged.filter((entry) => !entry.verdict.ok);
  report(judged, asJson, failed.length);
  return failed.length > 0 ? 1 : 0;
}

/**
 * The PR title is judged because GitHub's squash writes THE TITLE into `main`
 * when a PR carries more than one commit — so a PR whose commits are all
 * English can still land a Spanish subject.
 *
 * It is judged only when the PR was OPENED after the cutoff. A title has no
 * author date of its own, and without this the rule would reach backwards into
 * pull requests that were already open when it landed — which is the one thing
 * the cutoff exists to prevent. Same principle as the commits, applied to the
 * only date a title has.
 */
function prTitleInScope(cutoffEpoch: number): boolean {
  const createdAt = process.env.PR_CREATED_AT;
  if (createdAt === undefined || createdAt.trim() === '') return false;
  const parsed = Date.parse(createdAt);
  if (Number.isNaN(parsed)) return false;
  return parsed / 1000 >= cutoffEpoch;
}

function titleRecord(subject: string, cutoffEpoch: number): CommitRecord {
  return {
    sha: '',
    parents: 0,
    authoredAt: cutoffEpoch,
    authorEmail: process.env.PR_AUTHOR ?? '',
    authorName: process.env.PR_AUTHOR ?? '',
    subject,
  };
}

function valueOf(argv: string[], flag: string): string | undefined {
  const at = argv.indexOf(flag);
  return at === -1 ? undefined : argv[at + 1];
}

function report(
  judged: { label: string; record: CommitRecord; verdict: Verdict }[],
  asJson: boolean,
  failures: number
): void {
  if (asJson) {
    process.stdout.write(JSON.stringify({ judged, failures }, null, 2) + '\n');
    return;
  }
  const skipped = judged.filter((entry) => entry.verdict.skipped !== false);
  const looked = judged.length - skipped.length;
  for (const { label, record, verdict: v } of judged) {
    if (v.ok) continue;
    process.stdout.write(`  ✖ ${label}  [${v.reason}]  ${record.subject}\n      ${v.detail}\n`);
  }
  // AN INSTRUMENT THAT SAYS WHAT IT DID NOT JUDGE IS A GATE; one that only
  // says "ok" is a green light.
  const byReason = new Map<string, number>();
  for (const entry of skipped) {
    const key = String(entry.verdict.skipped);
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  const notLooked =
    byReason.size === 0
      ? 'none skipped'
      : [...byReason].map(([reason, count]) => `${count} ${reason}`).join(', ');
  process.stdout.write(
    failures === 0
      ? `commit subjects: ${looked} judged, all born English (${notLooked}).\n`
      : `commit subjects: ${failures} of ${looked} judged subject(s) are not English (${notLooked}).\n` +
          `The rule runs from ${SUBJECT_RULE_EFFECTIVE_FROM}; see "Mensajes de commit" in CONTRIBUTING.md.\n`
  );
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
