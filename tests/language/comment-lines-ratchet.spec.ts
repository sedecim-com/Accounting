import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compare, tighten } from '../../scripts/language-status.js';
import { ROOT, SPANISH_COMMENT_PER_ENTRY_RULE, lanesFor } from '../../scripts/language/lanes/docs.js';
import { CRITERIOS } from '../../src/plan/criterios.js';
import type { Lane } from '../../scripts/language/lane.js';

// ============================================================
// THE SPANISH-COMMENT LANE IS A PER-FILE RATCHET (MNE-001-187 · #162)
//
// Until this task `src-spanish-comment-lines` was informational: measured,
// published, and never judged, so a new Spanish comment cost nothing and the
// count rose from 27,780 to 28,993. The owner answered «Correcto» to turning
// the gate on (#603, 18 Nov 2026). The lane is now judged like the others,
// file by file: `language:status --check` goes red when a file holds more
// Spanish comment lines than its floor, or when a file with no entry brings
// any. Translating the existing lines stays I20's work; this only stops the
// count from rising.
//
// The ratchet is exercised on a toy tree, so the test does not move every time
// someone translates a comment. The real tree is checked only for the contract:
// the lane is ratcheted, seeded per file, and E1.1 still means what it meant.
// ============================================================

const LANE = 'src-spanish-comment-lines';

describe('the comment lane, judged file by file on a toy tree', () => {
  let root = '';
  const write = (relative: string, content: string): void => {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const measure = (): Lane => {
    const lane = lanesFor(root).find((c) => c.id === LANE);
    if (lane === undefined) throw new Error(`no ${LANE} lane`);
    return lane;
  };
  // The baseline `--seed` would write for the comment lane on this tree.
  const seededFrom = (lane: Lane) => ({
    _: '',
    _por_que: '',
    seeded: '2026-11-24',
    lanes: { [LANE]: lane.value },
    perFile: { [LANE]: { ...(lane.perFile ?? {}) } },
  });

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-ratchet-'));
    // Two Spanish comment lines and one English one.
    write(
      'src/a.ts',
      ['// El saldo inicial de la cuenta.', '/* La comision del periodo. */', '// The opening balance.', 'export const a = 1;'].join('\n')
    );
    write('src/b.ts', '// Plain English note.\nexport const b = 2;\n');
    write('docs/x.md', '# x\n');
  });

  afterAll(() => {
    if (root !== '') fs.rmSync(root, { recursive: true, force: true });
  });

  it('is no longer informational, and says what to do when it grows', () => {
    const lane = measure();
    expect(lane.informational).toBeUndefined();
    expect(lane.perFile).toEqual({ 'src/a.ts': 2 });
    expect(lane.perEntryRule).toBe(SPANISH_COMMENT_PER_ENTRY_RULE);
  });

  it('a tree equal to its seed passes', () => {
    expect(compare([measure()], seededFrom(measure()))).toEqual([]);
  });

  it('A FILE THAT GAINS A SPANISH COMMENT LINE GOES RED, even when the total does not grow', () => {
    const base = seededFrom(measure());
    // Base: a.ts = 2. One more Spanish line in a.ts, and the lane total raised
    // by hand to 3, so only the per-file floor can catch it.
    base.lanes[LANE] = 3;
    const grown: Lane = { ...measure(), value: 3, perFile: { 'src/a.ts': 3 } };
    const findings = compare([grown], base);
    expect(findings).toHaveLength(1);
    expect(findings[0].lane).toBe(LANE);
    expect(findings[0].detail).toBe(`src/a.ts: creció 2 → 3; ${SPANISH_COMMENT_PER_ENTRY_RULE}`);
  });

  it('a Spanish comment written into a file with no entry goes red: its floor is zero', () => {
    const base = seededFrom(measure());
    write('src/b.ts', '// Plain English note.\n// El cliente paga a crédito.\nexport const b = 2;\n');
    try {
      const findings = compare([measure()], base);
      // 2 → 3 on the total, and b.ts 0 → 1 on the breakdown.
      expect(findings.map((f) => f.detail)).toEqual([
        'creció: 2 → 3 — src/a.ts:1  El saldo inicial de la cuenta. · src/a.ts:2  La comision del periodo. · src/b.ts:2  El cliente paga a crédito.',
        `src/b.ts: 0 → 1 — sin entrada en la línea base; ${SPANISH_COMMENT_PER_ENTRY_RULE}`,
      ]);
    } finally {
      write('src/b.ts', '// Plain English note.\nexport const b = 2;\n');
    }
  });

  it('an English comment costs nothing, and a translated line lowers the floor on --tighten', () => {
    const base = seededFrom(measure());
    write(
      'src/a.ts',
      ['// The opening balance of the account.', '/* La comision del periodo. */', '// The opening balance.', '// Another English line.', 'export const a = 1;'].join('\n')
    );
    try {
      const lane = measure();
      expect(compare([lane], base)).toEqual([]);
      const next = tighten([lane], base);
      expect(next.lanes[LANE]).toBe(1);
      expect(next.perFile[LANE]).toEqual({ 'src/a.ts': 1 });
    } finally {
      write(
        'src/a.ts',
        ['// El saldo inicial de la cuenta.', '/* La comision del periodo. */', '// The opening balance.', 'export const a = 1;'].join('\n')
      );
    }
  });
});

describe('the comment lane on the real tree', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'language-baseline.json'), 'utf8')) as {
    lanes: Record<string, number>;
    perFile: Record<string, Record<string, number>>;
  };

  it('has a ceiling and a per-file floor in the baseline', () => {
    expect(baseline.lanes[LANE]).toBeGreaterThan(0);
    const floors = baseline.perFile[LANE] ?? {};
    expect(Object.keys(floors).length).toBeGreaterThan(100);
    expect(Object.keys(floors).every((file) => file.startsWith('src/') && file.endsWith('.ts'))).toBe(true);
    // The per-file floors never add up to more than the ceiling: a seed writes
    // both from one measurement, and --tighten only lowers either.
    expect(Object.values(floors).reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(baseline.lanes[LANE]);
  });

  it('E1.1 stays green: the jurisdiction module weighs in the comment lane, and that lane is exempt by name', async () => {
    // The module's Spanish comments are blessed until I20 translates them, so
    // the comment lane becoming a ratchet must not turn I5's criterion red.
    const floors = baseline.perFile[LANE] ?? {};
    expect(floors['src/services/jurisdiction/jurisdiction.ts']).toBeGreaterThan(0);
    const criterion = CRITERIOS.find((c) => c.id === 'jurisdiction-module-born-english');
    expect(criterion).toBeDefined();
    const result = await criterion!.evaluar();
    expect(result.estado).toBe('ok');
    expect(result.detalle).toContain(LANE);
  }, 120_000);
});
