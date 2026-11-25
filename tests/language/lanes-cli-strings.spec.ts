import { describe, expect, it, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import type { Lane } from '../../scripts/language/lane.js';
import { compare } from '../../scripts/language-status.js';
import {
  CLI_STRINGS_PER_ENTRY_RULE,
  cliStringsLanes,
  englishUserStrings,
  isEnglishProse,
} from '../../scripts/language/lanes/cli-strings.js';

// ============================================================
// THE `cli-user-strings-without-key` LANE (MNE-001-476, #150)
//
// Fragments of our own, so the rules of the count are pinned without the
// hundred files of `src/cli/`: English prose the CLI prints is counted, and
// what is a key, Spanish, a single word, help registration, risk metadata, a
// compared value or SQL is not. Every figure below is counted by hand from
// the fragment above it.
// ============================================================

const ROOT = path.resolve(__dirname, '..', '..');

function texts(code: string, file = 'src/cli/fragment.ts'): string[] {
  return englishUserStrings(code, file).map((hit) => hit.text);
}

describe('isEnglishProse', () => {
  it('needs two words, an English grammar word, and no Spanish majority', () => {
    expect(isEnglishProse('No pending external operations.')).toBe(true);
    expect(isEnglishProse('Dry run: nothing was written.')).toBe(true);
    expect(isEnglishProse('The fee is $1,000 for each of the filings.')).toBe(true);
    // One word is a value, not a message.
    expect(isEnglishProse('Balance')).toBe(false);
    // Two words and no grammar word: a label, outside the population by design.
    expect(isEnglishProse('Balance sheet')).toBe(false);
    // Spanish prose belongs to `spanish-user-strings-cli`, never to both lanes.
    expect(isEnglishProse('Sin cambios: el mayor no se tocó.')).toBe(false);
  });
});

describe('englishUserStrings: what is counted', () => {
  it('counts what console.log, CliError, out.write and an argParser error print, a joined message once', () => {
    const code = [
      "console.log('No drafts are waiting for review.');",
      "throw new CliError('The year must have four digits.');",
      "out.write('Showing the first ' + n + ' rows of the ledger.\\n');",
      "cmd.option('--limit <n>', 'rows', (raw) => { throw new InvalidArgumentError('it is not a number'); });",
    ].join('\n');
    expect(texts(code)).toEqual([
      'No drafts are waiting for review.',
      'The year must have four digits.',
      'Showing the first {n} rows of the ledger.\n',
      'it is not a number',
    ]);
  });
});

describe('englishUserStrings: what is not counted', () => {
  it('leaves out keys, Spanish, single words, help registration, writes, comparisons, SQL and its fragments', () => {
    const code = [
      "console.log(t('no_changes_ledger_untouched'));",
      "console.log('Sin cambios: el mayor no se tocó.');",
      "console.log('Balance');",
      "cmd.command('show').description('Show one period of the year');",
      "cmd.option('--year <y>', 'the year to show, as four digits');",
      "cmd.addOption(new Option('--all', 'show all of the rows'));",
      "opt.description = 'only entries written by this user';",
      "declareRisk(cmd, { risk: 'escritura', writes: 'the local credential (it deletes it)' });",
      "if (status === 'not yet open') return;",
      "db.query('SELECT id FROM periods WHERE name = $1 AND status IS NOT NULL');",
      "where.push(' AND pr.status = ANY($2::text[])');",
      "where.push('l.tenant_id = $1 AND l.entity_id IS NOT NULL');",
    ].join('\n');
    expect(texts(code)).toEqual([]);
  });

  it('leaves out a constant or a function handed to addHelpText in the same file', () => {
    const code = [
      'const EXAMPLES = {',
      '  show: `',
      'Examples:',
      '  # Show the period that is open now.',
      '  mnemosine period show 2026-01',
      '`,',
      '};',
      "function footer(): string { return 'Read the manual for all of the details.'; }",
      "show.addHelpText('after', EXAMPLES.show);",
      "show.addHelpText('after', footer());",
      "console.log('The period is open for posting.');",
    ].join('\n');
    expect(texts(code)).toEqual(['The period is open for posting.']);
  });

  it('skips the generated completion script only where it is generated', () => {
    const code = [
      'function bashScript(binary: string): string {',
      "  return ['# Regenerate after upgrading; do not edit by hand.'].join('\\n');",
      '}',
      "console.log('Unknown shell: use bash or zsh.');",
    ].join('\n');
    expect(texts(code, 'src/cli/completion-command.ts')).toEqual(['Unknown shell: use bash or zsh.']);
    // The same function name in another file is ordinary code, and counts.
    expect(texts(code, 'src/cli/other-command.ts')).toEqual([
      '# Regenerate after upgrading; do not edit by hand.',
      'Unknown shell: use bash or zsh.',
    ]);
  });
});

describe('cliStringsLanes', () => {
  let lane: Lane;
  beforeAll(() => {
    [lane] = cliStringsLanes();
  }, 120_000);

  it('publishes one ratcheted lane with a per-file breakdown that sums to its total', () => {
    expect(lane.id).toBe('cli-user-strings-without-key');
    expect(lane.informational).toBeUndefined();
    expect(lane.target).toBe(0);
    expect(lane.value).toBeGreaterThan(0);
    const sum = Object.values(lane.perFile ?? {}).reduce((a, b) => a + b, 0);
    expect(sum).toBe(lane.value);
    expect(Object.keys(lane.perFile ?? {}).every((file) => file.startsWith('src/cli/'))).toBe(true);
    expect(lane.perEntryRule).toBe(CLI_STRINGS_PER_ENTRY_RULE);
  });

  it('its command, through a pipe, gives its value, and its exit keeps an output larger than a pipe buffer', () => {
    expect(Number(execSync(lane.command, { cwd: ROOT, encoding: 'utf8' }).trim())).toBe(lane.value);
    // The listing shrinks as I8b pays the lane (under 64 KiB since MNE-001-802), so
    // the exit it ends with is checked on its own, with an output larger than a
    // pipe buffer: `process.exit` there cuts it at 65,536 bytes.
    const big = execSync(
      'npx tsx -e "const { exitWhenDrained } = require(\'./scripts/lib/exit-when-drained.ts\'); ' +
        'process.stdout.write(\'x\'.repeat(200000)); exitWhenDrained(0);" | wc -c',
      { cwd: ROOT, encoding: 'utf8' }
    );
    expect(Number(big.trim())).toBe(200_000);
  }, 120_000);

  it('the ratchet reports a file that grew over its floor and a new file born with debt', () => {
    const perFile = { ...(lane.perFile ?? {}) };
    const [grown] = Object.keys(perFile);
    const floors = { ...perFile, [grown]: perFile[grown] - 1 };
    const findings = compare([lane], {
      _: '',
      _por_que: '',
      seeded: '',
      lanes: { [lane.id]: lane.value },
      perFile: { [lane.id]: floors },
    });
    expect(findings.map((finding) => finding.detail)).toEqual([
      `${grown}: creció ${perFile[grown] - 1} → ${perFile[grown]}; ${CLI_STRINGS_PER_ENTRY_RULE}`,
    ]);

    const { [grown]: _dropped, ...withoutEntry } = perFile;
    const born = compare([lane], {
      _: '',
      _por_que: '',
      seeded: '',
      lanes: { [lane.id]: lane.value },
      perFile: { [lane.id]: withoutEntry },
    });
    expect(born.map((finding) => finding.detail)).toEqual([
      `${grown}: 0 → ${perFile[grown]} — sin entrada en la línea base; ${CLI_STRINGS_PER_ENTRY_RULE}`,
    ]);
  });
});
