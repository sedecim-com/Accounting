import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { VERBS, isVerb, OBJECTLESS_COMMANDS, LEGACY_PLURALS } from '../../../src/cli/kernel/vocabulary.js';
import { FLAG_DICTIONARY, BANNED_FLAGS, withReadFlags, withContext, withOutput, withSelection } from '../../../src/cli/kernel/flags.js';
import { declareRisk, riskOf, resetDeclarations } from '../../../src/cli/kernel/risk.js';

// ============================================================
// THE CONSISTENCY TEST (rulebook R12)
//
// This is the only thing that will keep 1,700 commands coherent
// while many sessions edit them. It walks a Commander program and
// asserts the rules that make the surface learnable:
//   - every verb comes from the closed list
//   - every flag comes from the single dictionary
//   - no banned spelling reappears
//   - nouns are singular, depth stays ≤ 3
//   - a mutating command carries the safety flags its risk requires
//   - a list command can be paged and formatted
//
// It is exported as `auditProgram` so the real CLI can be audited
// by the suite that builds it, and so `mnemosine doctor` can run
// the same check against the shipped program.
// ============================================================

export interface Violation {
  command: string;
  rule: string;
  detail: string;
}

const SHORT_FLAG_RE = /^-([a-zA-Z])\b/;

function pathOf(cmd: Command): string {
  const parts: string[] = [];
  for (let c: Command | null = cmd; c && c.parent; c = c.parent) parts.unshift(c.name());
  return parts.join(' ');
}

export function auditProgram(program: Command): Violation[] {
  const violations: Violation[] = [];
  const shortFlags = new Map<string, string>();

  const visit = (cmd: Command) => {
    const children = cmd.commands ?? [];
    const full = pathOf(cmd);
    if (full) {
      const tokens = full.split(' ');

      // R1: depth
      if (tokens.length > 3) {
        violations.push({ command: full, rule: 'R1 depth', detail: `${tokens.length} tokens; max is 3` });
      }

      // R3/R4: leaf commands end in a verb from the closed list.
      const isLeaf = children.length === 0;
      const last = tokens[tokens.length - 1];
      if (isLeaf && tokens.length > 1 && !isVerb(last)) {
        violations.push({
          command: full,
          rule: 'R3 closed verb list',
          detail: `"${last}" is not a verb in the registry. Use one of the ${Object.keys(VERBS).length} canonical verbs, or add it to vocabulary.ts deliberately.`,
        });
      }
      if (isLeaf && tokens.length === 1 && !OBJECTLESS_COMMANDS.includes(last)) {
        violations.push({
          command: full,
          rule: 'R1 objectless allowlist',
          detail: `"${last}" is a top-level command with no object and is not in OBJECTLESS_COMMANDS.`,
        });
      }

      // R2: nouns are singular.
      const noun = tokens[0];
      if (noun.endsWith('s') && !isVerb(noun) && !LEGACY_PLURALS.includes(noun) && !OBJECTLESS_COMMANDS.includes(noun)) {
        violations.push({ command: full, rule: 'R2 singular nouns', detail: `"${noun}" looks plural` });
      }

      // R6: flags come from the dictionary; banned spellings never reappear.
      for (const opt of cmd.options) {
        const long = opt.long ?? '';
        const negated = long.startsWith('--no-') ? long : null;
        if ((BANNED_FLAGS as readonly string[]).includes(long)) {
          violations.push({ command: full, rule: 'R6 banned spelling', detail: `${long} is banned` });
          continue;
        }
        // Command-specific value flags are allowed; the dictionary governs
        // the shared vocabulary, so only flags whose CONCEPT it defines are
        // checked for spelling and short-form drift.
        if (long && Object.prototype.hasOwnProperty.call(FLAG_DICTIONARY, long)) {
          const expectedShort = FLAG_DICTIONARY[long];
          if ((opt.short ?? null) !== expectedShort) {
            violations.push({
              command: full,
              rule: 'R6 short flag',
              detail: `${long} should use ${expectedShort ?? 'no short form'}, found ${opt.short ?? 'none'}`,
            });
          }
        }
        if (opt.short && !negated) {
          const letter = SHORT_FLAG_RE.exec(opt.short)?.[1];
          if (letter === 'f') {
            violations.push({ command: full, rule: 'R6 -f is reserved', detail: `${long} claims -f` });
          }
          const key = `${full}|${opt.short}`;
          if (shortFlags.has(key)) {
            violations.push({ command: full, rule: 'R6 short flag collision', detail: opt.short });
          }
          shortFlags.set(key, long);
        }
      }

      const longs = new Set(cmd.options.map((o) => o.long));

      // R11: a declared mutation carries the flags its risk class requires.
      const risk = riskOf(cmd);
      if (risk?.requiresDryRun) {
        for (const required of ['--dry-run', '--yes', '--idempotency-key']) {
          if (!longs.has(required)) {
            violations.push({
              command: full,
              rule: 'R11 risk flags',
              detail: `risk "${risk.risk}" requires ${required}`,
            });
          }
        }
      }
      if (risk?.requiresLiveGate && !longs.has('--live')) {
        violations.push({ command: full, rule: 'R11 live gate', detail: 'external effects require --live' });
      }

      // Every list command must be pageable and formattable, or it will
      // silently truncate someone's financial statement one day.
      if (isLeaf && last === 'list') {
        for (const required of ['--limit', '--format']) {
          if (!longs.has(required)) {
            violations.push({ command: full, rule: 'list contract', detail: `missing ${required}` });
          }
        }
      }
    }
    for (const child of children) visit(child);
  };

  visit(program);
  return violations;
}

/**
 * Builds a multi-token command the way Commander actually models one:
 * as nested subcommands. `.command('account list')` would declare a
 * command named "account" taking a positional argument, which is a
 * different thing entirely — and an easy mistake to make when writing
 * these, which is part of why the audit walks the real tree.
 */
function mk(program: Command, path: string): Command {
  let node = program;
  for (const token of path.split(' ')) {
    const existing = node.commands.find((c) => c.name() === token);
    node = existing ?? node.command(token).description(`${token}`);
  }
  return node;
}

describe('auditProgram — the rules it enforces', () => {
  it('accepts a command built from the kernel', () => {
    const program = new Command('mnemosine');
    withReadFlags(mk(program, 'account list'));
    expect(auditProgram(program)).toEqual([]);
  });

  it('rejects a verb outside the closed list', () => {
    const program = new Command('mnemosine');
    withReadFlags(mk(program, 'account fetch'));
    const v = auditProgram(program);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toBe('R3 closed verb list');
    expect(v[0].detail).toMatch(/"fetch" is not a verb/);
  });

  it('rejects a plural noun', () => {
    const program = new Command('mnemosine');
    withReadFlags(mk(program, 'accounts list'));
    expect(auditProgram(program).some((x) => x.rule === 'R2 singular nouns')).toBe(true);
  });

  it('tolerates the plurals the repo already shipped', () => {
    const program = new Command('mnemosine');
    withReadFlags(mk(program, 'drafts list'));
    expect(auditProgram(program).some((x) => x.rule === 'R2 singular nouns')).toBe(false);
  });

  it('rejects a banned spelling', () => {
    const program = new Command('mnemosine');
    mk(program, 'entry post').option('--dryrun', 'nope');
    expect(auditProgram(program).some((x) => x.rule === 'R6 banned spelling')).toBe(true);
  });

  it('rejects -f, which reads as both --file and --force', () => {
    const program = new Command('mnemosine');
    mk(program, 'entry post').option('-f, --force', 'nope');
    expect(auditProgram(program).some((x) => x.rule === 'R6 -f is reserved')).toBe(true);
  });

  it('rejects a dictionary flag that drifted to another short form', () => {
    const program = new Command('mnemosine');
    mk(program, 'entry list').option('-l, --limit <n>', 'wrong short');
    expect(auditProgram(program).some((x) => x.rule === 'R6 short flag')).toBe(true);
  });

  it('requires a list command to be pageable and formattable', () => {
    const program = new Command('mnemosine');
    mk(program, 'entry list');
    const rules = auditProgram(program).filter((x) => x.rule === 'list contract').map((x) => x.detail);
    expect(rules).toEqual(['missing --limit', 'missing --format']);
  });

  it('requires depth to stay within three tokens', () => {
    const program = new Command('mnemosine');
    withReadFlags(mk(program, 'sat download request list'));
    expect(auditProgram(program).some((x) => x.rule === 'R1 depth')).toBe(true);
  });

  it('requires an irreversible command to carry its safety flags', () => {
    resetDeclarations();
    const program = new Command('mnemosine');
    const cmd = mk(program, 'entry post');
    declareRisk(cmd, { risk: 'irreversible' });
    // Simulate a hand-rolled command that lost one of its required flags.
    // Commander types `options` as a readonly property holding a readonly
    // array, so neither reassigning it nor splicing it typechecks as written;
    // both fail `npm run typecheck:tests`. The cast is confined to this one
    // line, and the mutation is what the simulation needs: the live array
    // auditProgram will walk loses --yes.
    const yesIndex = cmd.options.findIndex((o) => o.long === '--yes');
    (cmd.options as unknown as unknown[]).splice(yesIndex, 1);
    const risky = auditProgram(program).filter((x) => x.rule === 'R11 risk flags');
    expect(risky.map((x) => x.detail)).toEqual(['risk "irreversible" requires --yes']);
    resetDeclarations();
  });
});

describe('the verb table is a bijection', () => {
  it('maps every English verb to exactly one Spanish word, never shared', () => {
    const spanish = Object.values(VERBS);
    const duplicated = spanish.filter((w, i) => spanish.indexOf(w) !== i);
    expect(duplicated).toEqual([]);
  });

  it('has no empty or multi-word entries', () => {
    for (const [en, es] of Object.entries(VERBS)) {
      expect(en, `English verb "${en}"`).toMatch(/^[a-z][a-z-]*$/);
      expect(es, `Spanish alias for "${en}"`).toMatch(/^[a-zá-úñ][a-zá-úñ-]*$/);
    }
  });
});

describe('declareRisk refuses unsafe declarations at registration time', () => {
  it('refuses to give the agent an irreversible command', () => {
    resetDeclarations();
    const cmd = new Command('entry post');
    expect(() => declareRisk(cmd, { risk: 'irreversible', agent: true })).toThrow(
      /permission must never depend on the value of a flag/
    );
  });

  it('refuses to give the agent an external command', () => {
    resetDeclarations();
    const cmd = new Command('cfdi stamp');
    expect(() => declareRisk(cmd, { risk: 'externo', agent: true })).toThrow(/may never post to the ledger/);
  });

  it('refuses an agent write that does not assert draftOnly', () => {
    resetDeclarations();
    const cmd = new Command('entry create');
    expect(() => declareRisk(cmd, { risk: 'escritura', agent: true })).toThrow(/without asserting draftOnly/);
  });

  it('allows an agent write that lands in a review queue', () => {
    resetDeclarations();
    const cmd = new Command('entry create');
    expect(() => declareRisk(cmd, { risk: 'escritura', agent: true, draftOnly: true })).not.toThrow();
    expect(riskOf(cmd)?.agentAllowed).toBe(true);
  });

  it('applies the safety flags an irreversible command requires', () => {
    resetDeclarations();
    const cmd = new Command('entry post');
    declareRisk(cmd, { risk: 'irreversible' });
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--dry-run');
    expect(longs).toContain('--yes');
    expect(longs).toContain('--idempotency-key');
    expect(longs).not.toContain('--live');
  });

  it('adds the live gate only to external commands', () => {
    resetDeclarations();
    const cmd = new Command('cfdi stamp');
    declareRisk(cmd, { risk: 'externo' });
    expect(cmd.options.map((o) => o.long)).toContain('--live');
  });

  it('adds --reason to undo verbs', () => {
    resetDeclarations();
    const cmd = new Command('reverse');
    declareRisk(cmd, { risk: 'irreversible' });
    expect(cmd.options.map((o) => o.long)).toContain('--reason');
  });
});

describe('flag appliers stay inside the dictionary', () => {
  it('every flag the kernel applies is in FLAG_DICTIONARY', () => {
    const program = new Command('t');
    const cmd = withOutput(withSelection(withContext(program.command('account list'))));
    const unknown = cmd.options
      .map((o) => o.long)
      .filter((l): l is string => !!l && !Object.prototype.hasOwnProperty.call(FLAG_DICTIONARY, l));
    expect(unknown).toEqual([]);
  });
});
