/**
 * Publishes the command manifest, generated from the CLI's risk registry.
 *
 *   npx tsx scripts/command-manifest.ts            write docs/command-manifest.json
 *   npx tsx scripts/command-manifest.ts --check    exit 1 if the published file is stale
 *   npx tsx scripts/command-manifest.ts --stdout   print it without touching the disk
 *
 * The manifest says, per leaf of the shipped tree, what a program other than
 * this binary needs in order to call it: path, aliases, risk class, whether
 * the agent may use it, what it does with `--idempotency-key`, its arguments
 * and options, and its output formats; and once, the exit codes of the binary
 * (MNE-001-693, #952 stage 1, PRD-003 RF-41). It is built by
 * `src/cli/command-manifest.ts` from the Commander tree and `allDeclarations()`,
 * so nothing in the file is written by hand and nothing in it is prose.
 *
 * The file carries no date and no version: it changes only when a command
 * does. `tests/cli/command-manifest.spec.ts` compares the published file with
 * the tree in every unit run, so a stale file is red in CI even where this
 * `--check` is not a step of its own.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildCommandManifest, CommandManifestError, renderCommandManifest } from '../src/cli/command-manifest.js';
import { program } from '../src/cli/mnemosine.js';
import { exitWhenDrained } from './lib/exit-when-drained.js';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'command-manifest.json');
const SHOWN = path.relative(ROOT, OUT);

const REFUSALS: Record<CommandManifestError['code'], string> = {
  'undeclared-leaf': 'these leaves have no declareRisk, so the manifest cannot say what they are',
  'declared-group': 'these groups carry a declaration that no leaf would publish',
  'unserialisable-default': 'these defaults are not plain JSON and would differ between machines',
};

export function main(args: readonly string[]): number {
  let text: string;
  try {
    text = renderCommandManifest(buildCommandManifest(program));
  } catch (error) {
    if (!(error instanceof CommandManifestError)) throw error;
    process.stderr.write(`No manifest: ${REFUSALS[error.code]}.\n${error.subjects.map((s) => `  ${s}\n`).join('')}`);
    return 1;
  }

  if (args.includes('--stdout')) {
    process.stdout.write(text);
    return 0;
  }

  if (args.includes('--check')) {
    const published = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
    if (published === text) {
      process.stdout.write(`${SHOWN} is up to date.\n`);
      return 0;
    }
    process.stderr.write(`${SHOWN} does not match the command tree.\nRegenerate it with:  npm run command:manifest\n`);
    return 1;
  }

  fs.writeFileSync(OUT, text);
  process.stdout.write(`Wrote ${SHOWN}.\n`);
  return 0;
}

if (require.main === module) {
  exitWhenDrained(main(process.argv.slice(2)));
}
