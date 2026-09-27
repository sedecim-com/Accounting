import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CRITERIOS, conFuenteMutada, crudoDe, type Criterio } from '../../src/plan/criterios.js';
import {
  CENSUS_FILE,
  instrumentFiles,
  measureCensus,
  renderCensus,
} from '../../src/plan/mutation-census.js';
import { checkCensus, liveCensus } from '../../scripts/mutation-census.js';

// ============================================================
// THE MUTATION CENSUS (#356) — the two hand-edited floors, MIRRORS_FLOOR and
// ANCHORS_HERE, became a generated census. This spec is where CI runs its
// `--check` (no workflow step of its own), and it pins the three promises of
// the issue: the census matches the tree, a vanished mirror or anchor is
// NAMED, and two PRs that add mirrors merge without anyone summing by hand.
// ============================================================

const committed = (): string => crudoDe(CENSUS_FILE);
const censusOf = (criteria: readonly Criterio[]): string =>
  renderCensus(measureCensus(criteria, instrumentFiles(), (f) => crudoDe(f)));

const extraMirror = (reason: string) => ({ archivo: 'nowhere.ts', de: 'x', a: 'y', porque: reason });

describe('mutation census', () => {
  it('the committed census is exactly the one the tree generates (the CI --check)', () => {
    const problems = checkCensus(committed(), liveCensus());
    expect(problems, `regenerate with npm run mutation:census:\n${problems.join('\n')}`).toEqual([]);
  });

  it('removing one mirror fails the check, naming the mirror', () => {
    const victim = CRITERIOS.find((c) => (c.mutantes?.length ?? 0) > 0)!;
    const removed = victim.mutantes![0]!;
    const without = CRITERIOS.map((c) => (c === victim ? { ...c, mutantes: c.mutantes!.slice(1) } : c));

    const problems = checkCensus(committed(), censusOf(without));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('vanished from the tree');
    expect(problems[0]).toContain(victim.id!);
    expect(problems[0]).toContain(removed.porque.replace(/\s+/g, ' ').trim());
  });

  it('commenting out a `de:` anchor fails the check, naming the anchor', async () => {
    const file = 'src/plan/criteria/e0-0.ts';
    const anchor = "        de: \".toBe('falla')\",";
    const mutated = crudoDe(file).replace(anchor, `// ${anchor}`);

    const problems = await conFuenteMutada({ [file]: mutated }, () => checkCensus(committed(), liveCensus()));

    expect(problems).toEqual([`vanished from the tree: anchor in ${file}: de: ".toBe('falla')",`]);
  });

  it('a mirror added without regenerating the census fails the check too', () => {
    const [first, ...rest] = CRITERIOS;
    const withExtra = [{ ...first!, mutantes: [...(first!.mutantes ?? []), extraMirror('brand new')] }, ...rest];

    const problems = checkCensus(committed(), censusOf(withExtra));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^not in the census yet: .*brand new$/);
  });

  it('the harness criterion goes red naming a mirror that left the code but not the census', async () => {
    const harness = CRITERIOS.find((c) => c.id === 'criteria-mutation-harness')!;
    const ghost = 'mirror\tmemory\tE0.0 ghost-criterion\tnowhere.ts\ta retired mirror\n';

    const result = await conFuenteMutada({ [CENSUS_FILE]: ghost + committed() }, () => harness.evaluar());

    expect(result.estado).toBe('falla');
    expect(result.detalle).toContain('mirror (memory) of E0.0 ghost-criterion on nowhere.ts: a retired mirror');
  });

  it('two PRs adding mirrors to different criteria merge cleanly into the regenerated census', () => {
    // The collision the issue is about: with a literal total, both PRs edit
    // the same line. With one line per mirror in source order, git's own
    // three-way merge must produce exactly what regenerating would.
    const first = CRITERIOS[0]!;
    const last = CRITERIOS[CRITERIOS.length - 1]!;
    const add = (c: Criterio, reason: string): Criterio => ({
      ...c,
      mutantes: [...(c.mutantes ?? []), extraMirror(reason)],
    });
    const prA = CRITERIOS.map((c) => (c === first ? add(c, 'mirror from PR A') : c));
    const prB = CRITERIOS.map((c) => (c === last ? add(c, 'mirror from PR B') : c));
    const both = CRITERIOS.map((c) =>
      c === first ? add(c, 'mirror from PR A') : c === last ? add(c, 'mirror from PR B') : c
    );

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-census-'));
    try {
      const write = (name: string, text: string) => {
        fs.writeFileSync(path.join(dir, name), text);
        return path.join(dir, name);
      };
      const ours = write('a.txt', censusOf(prA));
      const base = write('base.txt', censusOf(CRITERIOS));
      const theirs = write('b.txt', censusOf(prB));
      // `git merge-file -p` exits with the number of conflicts: non-zero throws.
      const merged = execFileSync('git', ['merge-file', '-p', ours, base, theirs], { encoding: 'utf-8' });
      expect(merged).toBe(censusOf(both));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
