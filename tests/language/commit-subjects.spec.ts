import { describe, it, expect } from 'vitest';
import {
  judgeCommit,
  judgeSubject,
  parseLog,
  SUBJECT_RULE_EFFECTIVE_FROM,
  type CommitRecord,
} from '../../scripts/language/commit-subjects.js';

// ============================================================
// I22 · the subject lint, exercised on its PURE half.
//
// `collect()` is the only impure function in the script — it shells out to
// `git log` — and it is deliberately NOT tested here. A spec that shells out
// measures the machine it runs on: the repository it happens to sit in, the
// refs that happen to be fetched, the history someone else happens to have
// pushed. What IS testable is the parser it feeds (`parseLog`) and the two
// judges it feeds into, so the git call is one line with nothing in it to get
// wrong, and everything else has a case below.
//
// If you are about to add a test that runs git: don't. Add a `parseLog` case.
// ============================================================

const CUTOFF = Date.parse(SUBJECT_RULE_EFFECTIVE_FROM) / 1000;

function commit(over: Partial<CommitRecord> = {}): CommitRecord {
  return {
    sha: 'a'.repeat(40),
    parents: 1,
    authoredAt: CUTOFF + 86_400,
    authorEmail: 'someone@example.com',
    authorName: 'Someone',
    subject: 'I22: commit subjects are born in English',
    ...over,
  };
}

describe('the cut-off constant', () => {
  // Everything in this file hangs off one string, so a typo in it is silent:
  // `2099-…` leaves the job green, running, and judging nothing at all.
  //
  // The bounds are FIXED INSTANTS and not `Date.now()` on purpose. A test that
  // compares against the clock passes today and starts failing on a date
  // nobody chose — the suite would break for whoever happens to run it after
  // the window closes, with a message about a constant they did not touch.
  it('parses, and sits in the window the tranche declared', () => {
    const at = Date.parse(SUBJECT_RULE_EFFECTIVE_FROM);
    expect(Number.isFinite(at)).toBe(true);
    expect(at).toBeGreaterThan(Date.parse('2026-09-01T00:00:00Z'));
    expect(at).toBeLessThan(Date.parse('2026-10-01T00:00:00Z'));
  });
});

describe('a Spanish subject is rejected', () => {
  it('by its accents', () => {
    const v = judgeSubject('X1c: la base admitía doce rubros, el código conocía once');
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('accent');
  });

  // THE CASE THAT PROVES ACCENTS ARE NOT ENOUGH. Of the 265 Spanish subjects
  // this gate rejects on `main`, 75 carry no accent at all — 28 % — so an
  // accent-only gate would wave better than one in four straight through. This
  // is why the script consumes `judgeLanguage` instead of a regex.
  it('by its prose, with no accent anywhere in it', () => {
    const v = judgeSubject('El trinquete absorbe los 41 del SUA');
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('spanish-prose');
  });

  it('by its prose, on a real subject from a live branch', () => {
    expect(judgeSubject('S4: el bloque del metro, esta vez commiteado').reason).toBe('spanish-prose');
  });
});

describe('an English subject is accepted', () => {
  it('in the house shape, with the tranche code', () => {
    expect(
      judgeSubject('I22: the kernel renders help by key, and the instruments keep measuring the English source').ok
    ).toBe(true);
  });

  it('with the squash suffix GitHub appends', () => {
    expect(judgeSubject("W1: the firm portfolio reads only the token's entities (#249)").ok).toBe(true);
  });

  it('with no tranche code at all — 165 of 295 subjects on main have none', () => {
    expect(judgeSubject('The gateway says why: an unmatched route mints no label').ok).toBe(true);
  });

  // `CI:` is a house tranche code and `ci:` is the conventional-commit prefix
  // CONTRIBUTING bans. BOTH live on `main`, which is why the prefix rule is
  // case-sensitive: an `/i` flag would reject the house's own shape.
  it('when an uppercase house code collides with a banned lowercase prefix', () => {
    expect(judgeSubject('CI: the mirror is dated in the period the test measures').ok).toBe(true);
    expect(judgeSubject('ci: triage determinista Witness').reason).toBe('conventional-prefix');
  });
});

describe('what the subject cites is not what the subject says', () => {
  it('accepts the issue\'s own example', () => {
    expect(judgeSubject("I23: rename account_roles 'contador' to 'accountant'").ok).toBe(true);
  });

  it('accepts an accent inside backticks', () => {
    expect(judgeSubject('I24: the `año` column of poliza rows becomes `year`').ok).toBe(true);
  });

  it('accepts a quoted Spanish phrase inside an English sentence', () => {
    expect(judgeSubject("I24: rename 'año fiscal' to 'fiscal year' everywhere the report reads it").ok).toBe(true);
  });

  // THE GUARD, AND WHY IT IS THERE.
  //
  // An unguarded `/'[^']*'/g` matches from the apostrophe of `runner's` to the
  // apostrophe of `token's` and deletes the English between them — and the
  // subject is then rejected for a reason that is not true, which is the worst
  // kind of false positive because the author cannot act on the message. The
  // opening quote must start a word and the closing quote must end one.
  it('does not read two possessives as one citation', () => {
    expect(judgeSubject("W2: the runner's cache and the token's scope stay apart").ok).toBe(true);
  });

  // The same sentence typed in a browser field, where macOS substitutes curly
  // quotes. A gate that judges the two differently judges where you typed.
  it('treats curly quotes exactly like straight ones, in both roles', () => {
    expect(judgeSubject('W2: the runner’s cache and the token’s scope stay apart').ok).toBe(true);
    expect(judgeSubject('I20: the “asiento” comment becomes “entry” in the ledger writers').ok).toBe(true);
  });

  // THE BYPASS THE CITATION EXEMPTION OPENS, AND THE RULE THAT CLOSES IT.
  // Without a floor of prose words, anyone can quote the whole subject.
  it('rejects a subject that is nothing but a citation, in all three delimiters', () => {
    for (const quoted of [
      "I22: 'los commits nacen en inglés'",
      'I22: "los commits nacen en inglés"',
      'I22: `los commits nacen en inglés`',
    ]) {
      expect(judgeSubject(quoted).reason).toBe('all-citation');
    }
  });

  // THE DECLARED FALSE POSITIVE, pinned so it cannot change in silence.
  // A subject must carry two words of its own. The repair is to write
  // `I24: the 'póliza' column becomes 'journal entry'`, which passes.
  it('rejects a rename subject with only one word of its own, and accepts it with two', () => {
    expect(judgeSubject("I24: 'póliza' becomes 'journal entry'").reason).toBe('all-citation');
    expect(judgeSubject("I24: the 'póliza' column becomes 'journal entry'").ok).toBe(true);
  });
});

describe('the shapes the format rule rejects', () => {
  it('an empty subject', () => {
    expect(judgeSubject('').reason).toBe('empty');
  });

  it('emoji, which CONTRIBUTING bans by name', () => {
    expect(judgeSubject('I22: ✨ commits are born English').reason).toBe('emoji');
  });

  it('every lowercase conventional-commit type, not just the two named', () => {
    for (const prefix of ['feat', 'fix', 'chore', 'docs', 'refactor', 'test', 'build', 'perf']) {
      expect(judgeSubject(`${prefix}: commits are born English`).reason).toBe('conventional-prefix');
    }
  });

  it('a code with no space after its colon, which otherwise never strips', () => {
    expect(judgeSubject('I22:commits are born English').reason).toBe('no-space-after-code');
  });

  it('a subject too short to say what changed', () => {
    expect(judgeSubject('fix typo').reason).toBe('too-few-words');
  });

  // The cap is an accident guard, not a style rule: the longest subject in the
  // whole history is 135 characters. A 72-character cap would reject 157 of
  // 295 real subjects, because the house writes long subjects on purpose.
  it('a subject past the cap, while the longest real one passes', () => {
    expect(judgeSubject(`I22: ${'word '.repeat(40)}`).reason).toBe('too-long');
    const longest =
      '#211: a journal entry dated March 1st was stored on February 28th west of Greenwich — and so were the entries of payments and receipts (#240)';
    expect(judgeSubject(longest).ok).toBe(true);
  });
});

describe('the exemptions are structural, never a string anyone can type', () => {
  // 32 of main's 108 merges do NOT start with `Merge ` — `Fusión con main:`,
  // `Fusiona main:`, `merge: traer main…`. A `^Merge ` exemption would miss
  // them all AND hand everyone a four-letter bypass.
  it('a merge is exempt by its parent count, and the same subject is not', () => {
    const subject = 'Fusión con main: I11 trae su criterio';
    expect(judgeCommit(commit({ subject, parents: 2 }), CUTOFF).skipped).toBe('merge');
    expect(judgeCommit(commit({ subject, parents: 1 }), CUTOFF).ok).toBe(false);
  });

  // Dependabot writes `Bump …`. The exemption is the AUTHOR'S IDENTITY and
  // never the `^Bump ` text, because a text exemption is a bypass anyone can
  // type: write `Bump` at the head and the rest of the subject is unjudged.
  // Proven with a subject that is genuinely Spanish and still starts with it.
  it('a bot is exempt by its identity, and a human writing the same subject is not', () => {
    const subject = 'Bump el grupo de menores y parches a sus seis versiones nuevas';
    const bot = { subject, authorEmail: '49699333+dependabot[bot]@users.noreply.github.com' };
    expect(judgeCommit(commit(bot), CUTOFF).skipped).toBe('bot');
    expect(judgeCommit(commit({ subject }), CUTOFF).reason).toBe('spanish-prose');
  });

  // And the ones dependabot ACTUALLY writes pass on their own merits anyway:
  // `Bump the menores-y-parches group with 6 updates` is an English sentence
  // carrying a Spanish group name from `.github/dependabot.yml`, and one
  // Spanish marker against two English ones is not Spanish prose. Measured, so
  // that nobody "fixes" the detector into rejecting it.
  it('does not call an English sentence Spanish for naming one Spanish thing', () => {
    expect(judgeSubject('Bump the menores-y-parches group with 6 updates').ok).toBe(true);
    expect(judgeSubject('Bump the acciones group with 3 updates').ok).toBe(true);
  });

  // THE ONE EXEMPTION THAT IS A SHAPE AND NOT A STRUCTURE, kept narrow and
  // declared. Git writes a revert's subject as `Revert "<the old one>"`, and
  // the old one may be pre-cut-off Spanish that no rule should force anyone to
  // retype. So the shape is matched — but only git's exact output. Anything
  // after the closing quote is somebody writing their own subject, and it is
  // judged like any other.
  it('exempts git\'s exact revert shape and nothing wider', () => {
    expect(judgeCommit(commit({ subject: 'Revert "X1c: la base admitía doce rubros"' }), CUTOFF).skipped).toBe('revert');
    const widened = commit({ subject: 'Revert "algo" y además esto que escribí yo' });
    expect(judgeCommit(widened, CUTOFF).skipped).toBe(false);
    expect(judgeCommit(widened, CUTOFF).ok).toBe(false);
  });

  // `fixup!` and `squash!` are NOT exempt. They are meant to be autosquashed
  // before review, so one that reaches the gate has already failed to be — and
  // exempting them would hand out a typeable prefix for free, which is the
  // thing the block above refuses to do.
  it('does not exempt fixup! or squash!, which would be a free prefix', () => {
    for (const subject of [
      'fixup! X1c: la base admitía doce rubros',
      'squash! el tipo de cambio dejó de elegirse por el orden',
    ]) {
      const v = judgeCommit(commit({ subject }), CUTOFF);
      expect(v.skipped).toBe(false);
      expect(v.ok).toBe(false);
    }
  });
});

describe('the same sentence is judged the same wherever it was typed', () => {
  // THE SECOND AXIS OF THE CURLY-QUOTE PROBLEM, and the more dangerous one.
  // macOS emits decomposed text, where `ó` is `o` + U+0301. That silences BOTH
  // halves of the Spanish test at once: the accent class lists only precomposed
  // codepoints, and `judgeLanguage` treats a combining mark as a word boundary,
  // so `póliza` shreds into `po` + `liza` and matches no root. A subject that
  // reads as Spanish to a human passed as English.
  it('judges decomposed text exactly like its precomposed twin', () => {
    for (const subject of [
      'J3: revisión periódica del régimen fiscal',
      'I24: creación automática según el catálogo jerárquico',
      'X1c: la base admitía doce rubros, el código conocía once',
    ]) {
      expect(subject.normalize('NFD')).not.toBe(subject); // the input really is different bytes
      expect(judgeSubject(subject.normalize('NFD'))).toEqual(judgeSubject(subject));
      expect(judgeSubject(subject.normalize('NFD')).ok).toBe(false);
    }
  });

  // English `no` used to count as a Spanish marker, so the house's own terse
  // shape was rejected as Spanish prose — with a message its author could not
  // act on, because there was no Spanish in it. The word now cancels instead of
  // accruing, and a Spanish sentence carrying `no` is still caught by the rest.
  it('does not read an emphatic English "no, no, no" as Spanish', () => {
    expect(judgeSubject('W1: pure — no git, no clock, no environment').ok).toBe(true);
    expect(judgeSubject('W3: no retry, no backoff, no timeout in the network client').ok).toBe(true);
    expect(judgeSubject('El saldo no cuadra y la balanza no lo dice').reason).toBe('spanish-prose');
  });
});

describe('the cut-off, which is what keeps history from being rewritten', () => {
  const spanish = 'X1c: la base admitía doce rubros';

  it('skips a Spanish commit authored one second before it', () => {
    expect(judgeCommit(commit({ subject: spanish, authoredAt: CUTOFF - 1 }), CUTOFF).skipped).toBe('before-cutoff');
  });

  it('judges one authored exactly at it — the boundary is inclusive and pinned', () => {
    const v = judgeCommit(commit({ subject: spanish, authoredAt: CUTOFF }), CUTOFF);
    expect(v.skipped).toBe(false);
    expect(v.ok).toBe(false);
  });
});

describe('parseLog', () => {
  const UNIT = '\x1f';
  const RECORD = '\x1e';
  const line = (fields: string[]) => fields.join(UNIT) + RECORD;

  it('reads the fields git writes, and counts parents', () => {
    const text =
      line(['a'.repeat(40), '', '1758000000', 'x@y.z', 'X', 'Root commit here']) +
      '\n' +
      line(['b'.repeat(40), 'p1 p2', '1758000001', 'q@r.s', 'Q', 'Merge of two']);
    const records = parseLog(text);
    expect(records).toHaveLength(2);
    expect(records[0]?.parents).toBe(0);
    expect(records[1]?.parents).toBe(2);
    expect(records[1]?.subject).toBe('Merge of two');
  });

  // The separators are control bytes precisely because a subject may contain
  // any printable character. If a subject could ever carry one of them, the
  // parse would silently split a subject into fields.
  it('keeps a subject that contains the separators themselves in one piece', () => {
    const records = parseLog(line(['c'.repeat(40), '', '1758000000', 'x@y.z', 'X', `weird${UNIT}subject`]));
    expect(records[0]?.subject).toBe(`weird${UNIT}subject`);
  });

  it('returns nothing for an empty range, which the caller treats as a failure', () => {
    expect(parseLog('')).toEqual([]);
  });
});
