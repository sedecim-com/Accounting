// ============================================================
// THE SUBJECT OF A NEW COMMIT IS BORN IN ENGLISH (I22 · issue #165)
//
// The repository ordered the opposite, in writing, in two places
// (`CONTRIBUTING.md` and `docs/PROCESS.md`), and 193 of the 295 non-merge
// subjects on `main` carry an accent as a result. Changing the written order is
// what makes new work stop being born in Spanish; this file is what keeps the
// order from being a suggestion.
//
// EVERY FIGURE IN THIS FILE WAS MEASURED AT `4901620` and is re-derivable with
// `git log`. They drift as `main` grows, which is the point of saying where
// they came from: a number with no commit behind it cannot be checked, and an
// unchecked number is how a document starts lying.
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

export type Skip = false | 'merge' | 'bot' | 'revert' | 'before-cutoff';

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
 * Everything that must look the same is made to look the same, BEFORE anything
 * else reads the text. Three problems, one seam.
 *
 * CURLY QUOTES. A macOS browser field turns `token's` into `token’s` and
 * `"asiento"` into `“asiento”`, so a gate that only knows straight quotes
 * judges the same sentence differently depending on where it was typed. And
 * U+2019 is both the closing single quote and the apostrophe, so any rule that
 * reads it as a delimiter eats possessives. Folding first means ONE set of
 * guarded rules below decides both cases.
 *
 * UNICODE FORM, which is the same bug on a second axis and the more dangerous
 * one. macOS also emits decomposed text: `ó` as `o` + U+0301. That turns off
 * BOTH halves of the Spanish test at once — `ACCENT` below only lists
 * precomposed codepoints, and `judgeLanguage` splits tokens on
 * `[^A-Za-zÀ-ɏ]+`, where a combining mark (U+0301 = 769) sits above `ɏ` (591)
 * and therefore acts as a word BOUNDARY: `póliza` becomes `po` + `liza`, which
 * is neither a function word nor a lexicon root. A subject that reads as
 * Spanish to a human passed as English. This repository already knows the
 * problem — `tests/cli/kernel/presentation.spec.ts` has a case named «póliza»
 * en NFD (como la emite macOS) — and normalizing here is what makes the rest
 * of this file able to assume one form.
 */
function foldText(text: string): string {
  return text.normalize('NFC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
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
  const raw = foldText(subject).trim();
  if (raw.length === 0) return verdict('empty', 'the subject is empty');

  const withoutSquash = raw.replace(SQUASH_SUFFIX, '');
  if (withoutSquash.length > MAX_SUBJECT) {
    // Deliberately not a style rule. The longest subject the house has ever
    // written is 135 characters and the median is 73; a 72-character cap would
    // reject 157 of the 295 non-merge subjects. This catches one accident —
    // `git commit -m "$(cat notes.txt)"` — and nothing else.
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
    // Of the 265 Spanish subjects this gate rejects on `main`, 75 carry NO
    // accent at all — 28 %. An accent-only check would wave better than one in
    // four straight through, which is why this half exists.
    return verdict('spanish-prose', 'the subject reads as Spanish prose');
  }
  return verdict('ok', 'born English');
}

/**
 * One record, with the exemptions decided before anything is read as prose.
 *
 * THREE OF THE FOUR ARE STRUCTURAL — a parent count, an author identity, a
 * date — and cannot be typed into a subject. That matters: a `^Merge `
 * exemption would be a bypass one keystroke wide, and it would also be wrong,
 * because 32 of `main`'s 108 merges do not start with `Merge`. Same for
 * `^Bump `: the exemption is dependabot's identity, not its habit.
 *
 * THE FOURTH IS NOT, AND SAYING OTHERWISE WOULD BE THE LIE THIS FILE EXISTS TO
 * PREVENT. A revert's subject is written by git as `Revert "<the old one>"`,
 * and the old one may be pre-cut-off Spanish that no rule should force anyone
 * to retype — rewriting the quote would misreport what was reverted. So the
 * shape is matched, and matching a shape is typeable by definition. It is
 * narrowed to git's exact output — `Revert "` … `"` and nothing after the
 * closing quote — so the bypass carries only what git itself would write, and
 * `Revert "algo" y además esto` is judged like any other subject. It is a real
 * hole, it is declared in the PR body, and it is the price of not lying about
 * history.
 *
 * `fixup!` and `squash!` are NOT exempt. They are meant to be autosquashed
 * before review; one that reaches the gate has already failed to be, and
 * exempting them would hand out the same typeable prefix for free.
 */
export function judgeCommit(record: CommitRecord, cutoffEpoch: number): Verdict {
  if (record.parents > 1) return { ok: true, skipped: 'merge', reason: 'ok', detail: 'merge commit' };
  if (isBot(record)) return { ok: true, skipped: 'bot', reason: 'ok', detail: 'written by a bot' };
  if (/^Revert "[^"]*"$/.test(record.subject)) {
    return { ok: true, skipped: 'revert', reason: 'ok', detail: 'git quotes the reverted subject verbatim' };
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

  // A RANGE THAT RESOLVES TO NOTHING IS NOT A PASS, and this is checked BEFORE
  // the title is added.
  //
  // `origin/main..HEAD` on a shallow clone, a wrong base ref or a fetch that
  // silently failed all produce zero commits. The first draft appended the
  // title first and then asked whether anything was left, which made the guard
  // unreachable in the only configuration CI actually runs: a PR always has a
  // title, so the count was never zero and a broken range printed a green tick
  // for a gate that had looked at no commit at all. Every other instrument in
  // this house fails when it cannot see; so does this one.
  if (records.length === 0) {
    process.stderr.write(
      `commit subjects: the range "${range}" resolved to no commit.\n` +
        'That is not a pass: the gate could not see anything. Check fetch-depth and the base ref.\n'
    );
    return 2;
  }

  const title = process.env.PR_TITLE;
  if (title !== undefined && title.trim() !== '') {
    const openedAt = prOpenedAt();
    // FAIL CLOSED WHEN THE TITLE CANNOT BE PLACED IN TIME. A title arrives with
    // no date of its own, so `PR_CREATED_AT` is what decides whether the rule
    // reaches it. Absent or unparseable, the first draft silently skipped the
    // title — which means deleting one `env:` line from the workflow turned off
    // the check on the one string a squash writes into `main`, with the job and
    // the criterion both still green. A gate that cannot tell whether something
    // is in scope has not checked it.
    if (openedAt === null) {
      process.stderr.write(
        'commit subjects: PR_TITLE is set but PR_CREATED_AT is missing or unparseable, so the title ' +
          'cannot be placed against the cut-off.\nThat is not a pass: pass PR_CREATED_AT, or pass no title.\n'
      );
      return 2;
    }
    if (openedAt >= cutoffEpoch) records.push(titleRecord(title, cutoffEpoch));
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
function prOpenedAt(): number | null {
  const createdAt = process.env.PR_CREATED_AT;
  if (createdAt === undefined || createdAt.trim() === '') return null;
  const parsed = Date.parse(createdAt);
  return Number.isNaN(parsed) ? null : parsed / 1000;
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
