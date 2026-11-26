import { describe, expect, it, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import type { Lane } from '../../scripts/language/lane.js';
import { compare } from '../../scripts/language-status.js';
import {
  HELP_EXAMPLES_PER_ENTRY_RULE,
  examplesBlocks,
  helpExamplesLanes,
} from '../../scripts/language/lanes/help-examples.js';

// ============================================================
// THE `help-examples-without-key` LANE (MNE-001-477, #150)
//
// Fragments of our own, so the rules of the count are pinned without the
// fifty files of `src/cli/`: a literal that opens an «Examples:» block is
// counted once, whatever shape it has, and a block drawn from a catalog key,
// a comment, a sentence that merely ends in «Examples:» and ordinary help
// are not. Every figure below is counted by hand from the fragment above it.
// ============================================================

const ROOT = path.resolve(__dirname, '..', '..');

function lines(code: string, file = 'src/cli/fragment.ts'): number[] {
  return examplesBlocks(code, file).map((hit) => hit.line);
}

describe('examplesBlocks: what is counted', () => {
  it('counts each literal that opens a block once: template, array element, joined, with substitutions, Spanish', () => {
    const code = [
      'const EXAMPLES = {', //                                          1
      '  show: `', //                                                    2  ← block 1
      'Examples:',
      '  # Show the period that is open now.',
      '  mnemosine period show 2026-01',
      '`,',
      '};',
      "cmd.addHelpText('after', ['', 'Examples:', '  mnemosine completion bash'].join('\\n'));", // 8 ← block 2
      "cmd.addHelpText('after', '\\nExamples:\\n' + '  mnemosine bill list --open\\n');", // 9 ← block 3 (once)
      'cmd.addHelpText(', //                                             10
      "  'after',",
      '  `\\nExamples:\\n  ${program.name()} report trial-balance --period ${period}\\n`', // 12 ← block 4
      ');',
      'const EJEMPLOS = `', //                                           14 ← block 5
      'Ejemplos:',
      '  mnemosine cuenta lista',
      '`;',
    ].join('\n');
    expect(lines(code)).toEqual([2, 8, 9, 12, 14]);
  });

  it('reports the file, the line and the block text with its header', () => {
    const [hit] = examplesBlocks("x.addHelpText('after', '\\nExamples:\\n  mnemosine ledger show');", 'src/cli/ledger-command.ts');
    expect(hit).toEqual({
      file: 'src/cli/ledger-command.ts',
      line: 1,
      text: '\nExamples:\n  mnemosine ledger show',
    });
  });
});

describe('examplesBlocks: what is not counted', () => {
  it('leaves out a keyed footer, comments, prose ending in «Examples:», descriptions and run-time text', () => {
    const code = [
      "const helpFooter = (): string => `\\n${t('help.filing.workpaper.generate.footer')}\\n`;",
      "cmd.addHelpText('after', helpFooter);",
      "cmd.addHelpText('after', t('help.annual.figure.record.footer'));",
      '// Examples:',
      '/* Examples:',
      '   mnemosine bank list */',
      "console.log(c.dim('Ask about your accounting in natural language. Examples:'));",
      "cmd.description('Show examples of a statement line');",
      "console.log('No examples were found for this command.');",
      "if (line === 'Examples') return;",
    ].join('\n');
    expect(lines(code)).toEqual([]);
  });
});

describe('helpExamplesLanes', () => {
  let lane: Lane;
  beforeAll(() => {
    [lane] = helpExamplesLanes();
  }, 120_000);

  it('publishes one ratcheted lane with a per-file breakdown that sums to its total', () => {
    expect(lane.id).toBe('help-examples-without-key');
    expect(lane.informational).toBeUndefined();
    expect(lane.target).toBe(0);
    expect(lane.value).toBeGreaterThan(0);
    const sum = Object.values(lane.perFile ?? {}).reduce((a, b) => a + b, 0);
    expect(sum).toBe(lane.value);
    expect(Object.keys(lane.perFile ?? {}).every((file) => file.startsWith('src/cli/'))).toBe(true);
    expect(lane.perEntryRule).toBe(HELP_EXAMPLES_PER_ENTRY_RULE);
  });

  it('its command gives its value, one line per block', () => {
    const listing = execSync(lane.command.replace(/\s*\|\s*wc -l$/, ''), {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    expect(listing.split('\n').filter((row) => row !== '')).toHaveLength(lane.value);
    expect(listing.split('\n').filter((row) => row !== '').every((row) => /^src\/cli\/\S+:\d+\t"/.test(row))).toBe(true);
    expect(Number(execSync(lane.command, { cwd: ROOT, encoding: 'utf8' }).trim())).toBe(lane.value);
  }, 120_000);

  it('the ratchet reports a file that grew over its floor and a new file born with a block', () => {
    const perFile = { ...(lane.perFile ?? {}) };
    const [grown] = Object.keys(perFile);
    const floors = { ...perFile, [grown]: perFile[grown] - 1 };
    const findings = compare([lane], {
      _: '',
      _por_que: '',
      seeded: '',
      lanes: { [lane.id]: lane.value },
      // A file translated since keeps its floor, so the summed ceiling (MNE-001-818) holds the total.
      perFile: { [lane.id]: { ...floors, 'translated-since.ts': 1 } },
    });
    expect(findings.map((finding) => finding.detail)).toEqual([
      `${grown}: creció ${perFile[grown] - 1} → ${perFile[grown]}; ${HELP_EXAMPLES_PER_ENTRY_RULE}`,
    ]);

    const { [grown]: _dropped, ...withoutEntry } = perFile;
    const born = compare([lane], {
      _: '',
      _por_que: '',
      seeded: '',
      lanes: { [lane.id]: lane.value },
      perFile: { [lane.id]: { ...withoutEntry, 'translated-since.ts': perFile[grown] } },
    });
    expect(born.map((finding) => finding.detail)).toEqual([
      `${grown}: 0 → ${perFile[grown]} — sin entrada en la línea base; ${HELP_EXAMPLES_PER_ENTRY_RULE}`,
    ]);
  });
});
