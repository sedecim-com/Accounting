/**
 * Generates —and checks— the mutation census (#356).
 *
 *   npx tsx scripts/mutation-census.ts            writes src/plan/mutation-census.txt
 *   npx tsx scripts/mutation-census.ts --check    exits 1 if the census and the tree differ
 *
 * The census is the list of mirrors and `de:` anchors that `MIRRORS_FLOOR` and
 * `ANCHORS_HERE` used to count by hand; see src/plan/mutation-census.ts for why.
 *
 * WHERE CI RUNS THE CHECK. Not in its own workflow step: the unit suite calls
 * `checkCensus()` (tests/plan/mutation-census.spec.ts), and the
 * `criteria-mutation-harness` criterion of E0.0 —which `plan:status --exigir`
 * requires— fails when a committed entry vanishes. Both already run in CI.
 */
import * as fs from 'node:fs';
import { CRITERIOS } from '../src/plan/criterios.js';
import { crudoDe, rutaDe } from '../src/plan/criteria/shared.js';
import {
  CENSUS_FILE,
  censusDrift,
  describeEntry,
  instrumentFiles,
  measureCensus,
  parseCensus,
  renderCensus,
} from '../src/plan/mutation-census.js';

/** The census measured on the current tree, rendered as it is committed. */
export function liveCensus(): string {
  return renderCensus(measureCensus(CRITERIOS, instrumentFiles(), (f) => crudoDe(f)));
}

/**
 * The problems `--check` reports, empty when the committed census is exactly
 * the live one. A vanished entry is named first: that is the loss the census
 * exists to catch. An unrecorded one only asks for a regeneration.
 */
export function checkCensus(committed: string, live: string): string[] {
  if (committed === live) return [];
  const drift = censusDrift(parseCensus(committed), parseCensus(live));
  const problems = [
    ...drift.vanished.map((e) => `vanished from the tree: ${describeEntry(e)}`),
    ...drift.unrecorded.map((e) => `not in the census yet: ${describeEntry(e)}`),
  ];
  // Same entries, different text (order, header): still stale.
  return problems.length > 0 ? problems : ['the census is out of order or its header changed'];
}

export function main(argv: string[]): number {
  const live = liveCensus();
  const target = rutaDe(CENSUS_FILE);
  if (argv.includes('--check')) {
    const committed = fs.existsSync(target) ? fs.readFileSync(target, 'utf-8') : '';
    const problems = checkCensus(committed, live);
    if (problems.length === 0) {
      process.stdout.write('The mutation census is up to date.\n');
      return 0;
    }
    process.stderr.write(
      `The mutation census (${CENSUS_FILE}) does not match the tree:\n` +
        problems.map((p) => `  ${p}`).join('\n') +
        '\n\nIf a mirror or anchor was retired on purpose, or new ones were added, regenerate it:\n' +
        '  npm run mutation:census\n'
    );
    return 1;
  }
  fs.writeFileSync(target, live);
  process.stdout.write(`Mutation census regenerated in ${CENSUS_FILE}.\n`);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
