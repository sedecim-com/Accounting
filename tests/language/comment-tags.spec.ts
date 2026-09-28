import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ESLint, Linter, RuleTester, type Rule } from 'eslint';
import { parser } from 'typescript-eslint';
import { commentTagsLanes, isUntaggedMarker, untaggedMarkers } from '../../scripts/language/lanes/comment-tags.js';
import { tsFiles, TREES } from '../../scripts/language/lanes/code.js';

// ============================================================
// A MARKER WITH NO ISSUE IS WORK NOBODY OWNS (#334)
//
// AGENTS.md allows six comment tags: TODO(#n):, FIXME(#n):, NOTE:, SECURITY:,
// CONTRACT: and AGENT-NO-TOUCH:. This file checks the gate that holds the
// first two to their issue, from four sides:
//
//   1. the definition, on the lines it must and must not catch;
//   2. the rule as ESLint loads it: on, in error, over the three trees;
//   3. the per-file quota of docs/language-baseline.json: old debt within its
//      quota stays quiet, one more marker does not;
//   4. conformance: the rule (JavaScript, eslint.config.mjs) and the meter's
//      lane (TypeScript, scripts/language/lanes/comment-tags.ts) count the same
//      thing in every file of the tree. They cannot share code, so this test
//      is what keeps them from drifting apart.
// ============================================================

const ROOT = path.join(__dirname, '..', '..');
const LANE_ID = 'untagged-comment-markers';

/** A file name with no baseline entry: every marker in it is over quota. */
const PROBE = 'src/comment-tags-probe.ts';

async function houseRule(): Promise<{ rule: Rule.RuleModule; severity: unknown }> {
  const resolved = (await new ESLint({ cwd: ROOT }).calculateConfigForFile('src/probe.ts')) as {
    rules?: Record<string, unknown>;
    plugins?: Record<string, { rules?: Record<string, Rule.RuleModule> }>;
  };
  const rule = resolved.plugins?.house?.rules?.['comment-tags'];
  if (!rule) throw new Error('house/comment-tags is not in the resolved config of src/: written but not wired.');
  return { rule, severity: resolved.rules?.['house/comment-tags'] };
}

const BASELINE = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'language-baseline.json'), 'utf8')) as {
  lanes: Record<string, number>;
  perFile: Record<string, Record<string, number>>;
};

describe('the definition', () => {
  it.each([
    'TODO: something',
    ' TODO(decision pending): something',
    'FIXME: broken',
    'XXX: look at this',
    'HACK(perf): skip it',
    ' * TODO: inside a block comment',
    'TODO (#12): the space before the parenthesis breaks the tag',
  ])('catches «%s»', (line) => {
    expect(isUntaggedMarker(line)).toBe(true);
  });

  it.each([
    'TODO(#12): tied to its issue',
    'FIXME(#3): known defect',
    'NOTE: a reason, not pending work',
    'SECURITY: validates the token',
    'TODO ES PURO: the Spanish word, not a marker',
    'MÉTODO: not a marker either',
    'see the TODO: in the middle of a sentence',
    'todo: lower case is prose',
  ])('lets «%s» through', (line) => {
    expect(isUntaggedMarker(line)).toBe(false);
  });

  it('reads comments, never strings or regex literals', () => {
    const source = [
      'const s = "// TODO: in a string";',
      'const r = /TODO:/;',
      '// TODO: a real one',
      '/**',
      ' * FIXME: another',
      ' */',
    ].join('\n');
    expect(untaggedMarkers(source).map((hit) => hit.line)).toEqual([3, 5]);
  });

  it('reads a file whose only markers are FIXME, XXX and HACK', () => {
    // The lane skips parsing a file with no marker word in it; a file with no
    // TODO at all must still be read.
    const source = ['// XXX: one', '/* HACK(fast): two */', 'export const x = 1; // FIXME: three'].join('\n');
    expect(untaggedMarkers(source).map((hit) => hit.line)).toEqual([1, 2, 3]);
  });
});

describe('house/comment-tags, as ESLint loads it', () => {
  it('is on, in error, over src/, tests/ and scripts/', async () => {
    const eslint = new ESLint({ cwd: ROOT });
    for (const tree of TREES) {
      const config = (await eslint.calculateConfigForFile(`${tree}/probe.ts`)) as { rules?: Record<string, unknown> };
      const severity = config.rules?.['house/comment-tags'];
      expect([2, 'error'], `${tree}/`).toContainEqual(Array.isArray(severity) ? severity[0] : severity);
    }
  });

  it('reports each marker in a file with no quota, and passes the tagged ones', async () => {
    const { rule } = await houseRule();
    new RuleTester({ languageOptions: { parser } }).run('house/comment-tags', rule, {
      valid: [
        { filename: PROBE, code: '// TODO(#12): tied to an issue\nexport const x = 1;' },
        { filename: PROBE, code: '// NOTE: a reason\nconst r = /TODO:/;\nexport { r };' },
        { filename: PROBE, code: '// TODO ES PURO\nexport const y = "// FIXME: in a string";' },
      ],
      invalid: [
        { filename: PROBE, code: '// TODO: nobody owns this\nexport const x = 1;', errors: [{ messageId: 'untagged' }] },
        {
          filename: PROBE,
          code: '/**\n * XXX: one\n * HACK(fast): two\n */\nexport const x = 1;',
          errors: [{ messageId: 'untagged' }, { messageId: 'untagged' }],
        },
      ],
    });
  });

  it('forgives what the baseline forgives in that file, and not one more', async () => {
    const { rule } = await houseRule();
    const [file, quota] = Object.entries(BASELINE.perFile[LANE_ID] ?? {})[0] ?? [];
    if (file === undefined || quota === undefined) {
      throw new Error(`the ${LANE_ID} lane has no file with a quota: if it reached zero, drop this test.`);
    }
    const markers = (n: number): string => Array.from({ length: n }, (_u, i) => `// TODO: pending ${i}`).join('\n');
    new RuleTester({ languageOptions: { parser } }).run('house/comment-tags', rule, {
      valid: [{ filename: path.join(ROOT, file), code: `${markers(quota)}\nexport const x = 1;` }],
      invalid: [
        {
          filename: path.join(ROOT, file),
          code: `${markers(quota + 1)}\nexport const x = 1;`,
          errors: [{ messageId: 'overBaseline' }],
        },
      ],
    });
  });
});

describe('the rule and the lane count the same thing', () => {
  const ruleConfig = (rule: Rule.RuleModule): Linter.Config[] => [
    {
      files: ['**/*.ts'],
      languageOptions: { parser },
      plugins: { house: { rules: { 'comment-tags': rule } } },
      rules: { 'house/comment-tags': 'error' },
    },
  ];

  // Sources the tree does not have yet, where a hand-written comment scanner
  // goes wrong: a regex literal holding a quote, and two comments on one line
  // and a comment inside a template's interpolation (Witness, WIT-01 on
  // #396). Each count is what ESLint's parser sees.
  it.each([
    ["const re = /'/; // TODO: real debt\nexport { re };", 1],
    ['/* NOTE: context */ /* TODO: real debt */\nexport const x = 1;', 1],
    ["const re = /'/; const text = '// TODO: not a comment';\nexport { re, text };", 0],
    ['const t = `${1} // TODO: in a template`; // FIXME: after it\nexport { t };', 1],
    ['const r = /[/*TODO:]/;\nexport { r };', 0],
    ['const s = `value ${1 /* TODO: pending */}`;\nexport { s };', 1],
  ] as const)('%j: both count %i', async (source, expected) => {
    const { rule } = await houseRule();
    const byRule = new Linter({ configType: 'flat' })
      .verify(source, ruleConfig(rule), { filename: PROBE })
      .filter((m) => m.ruleId === 'house/comment-tags').length;
    expect(byRule, 'the rule').toBe(expected);
    expect(untaggedMarkers(source).length, 'the lane').toBe(expected);
  });

  it('file by file, over the whole tree', async () => {
    const { rule } = await houseRule();
    const lane = commentTagsLanes().find((one) => one.id === LANE_ID);
    expect(lane, `the meter publishes no ${LANE_ID} lane`).toBeDefined();
    const linter = new Linter({ configType: 'flat' });
    const config = ruleConfig(rule);

    const disagreements: string[] = [];
    let examined = 0;
    for (const tree of TREES) {
      for (const file of tsFiles(tree)) {
        const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
        // Both sides need a marker word to count anything; the rest is 0 = 0.
        if (!/\b(TODO|FIXME|XXX|HACK)\b/.test(source)) continue;
        examined++;
        // Under a name with no quota the rule reports every marker it sees,
        // which is the raw count the lane publishes for the real file.
        const byRule = linter
          .verify(source, config, { filename: PROBE })
          .filter((m) => m.ruleId === 'house/comment-tags').length;
        const byLane = lane?.perFile?.[file] ?? 0;
        if (byRule !== byLane) disagreements.push(`${file}: rule ${byRule}, lane ${byLane}`);
      }
    }
    expect(examined).toBeGreaterThan(0);
    expect(disagreements).toEqual([]);
  }, 120_000);
});
