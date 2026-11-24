/**
 * SPANISH PROSE STILL WRITTEN IN THE SERVICES, THE API, THE AGENT, AUTH AND
 * THE DATABASE LAYER (MNE-001-153, #151)
 *
 *   npx tsx scripts/language/lanes/service-strings.ts           one line per string: file:line, text
 *   npx tsx scripts/language/lanes/service-strings.ts | wc -l   the lane's number
 *   npx tsx scripts/language/lanes/service-strings.ts <path>    the same for one file or folder
 *
 * `extract.ts` left `src/services/` out of `spanish-user-strings-cli` until I9
 * gave `AppError` a key, and said the services lane would then be born next to
 * it with its own number. I9·1 (#248) did: an error can carry `{ key, params }`
 * (`src/utils/errors.ts`) and each surface renders it in the reader's language.
 * This is that lane. It counts per file, so I9 by folder (MNE-001-154 for
 * `src/services/accounting`, MNE-001-480 for the rest) can pay it one folder at
 * a time, and no new message can be born in Spanish without the ratchet seeing
 * it. It is step S11 of the D14 plan on #141, widened there to `src/ai`,
 * `src/auth` and `src/database`.
 *
 * THE SAME RECOGNIZER AS THE CLI LANE, NOT A NARROWER ONE. A literal counts when
 * `userStrings` in `../extract.ts` counts it: Spanish prose of two words or
 * more, outside a data position (an import specifier, a property key, a literal
 * type, a `case` label, a side of `===`, a member of a compared list, the first
 * argument of `t()`) and not SQL. It is not narrowed to the arguments of `new
 * …Error(…)`: a message reaches the error, the response or the screen through
 * variables and local helpers, and a list of sinks that falls short makes a file
 * publish zero with Spanish in it (`extract.ts` explains it for the CLI, and it
 * holds here). Measured on 16 Nov 2026, only 695 of the 1,654 service hits were
 * direct arguments of an error constructor. Keeping the population exactly the
 * extractor's also keeps «this file is at zero» meaning «the extractor has
 * nothing left to do here».
 *
 * LOG LINES ARE COUNTED. There were six when the lane was written, three of
 * them `logger.warn` in `src/services/accounting/period-close.ts` that tell
 * the user which panel command to run. Leaving logs out would need a list of sinks, the thing this
 * lane does not keep; turning one into English needs no key.
 *
 * ONE FILE IS LEFT OUT, by name and with its reason in `SERVICE_EXCLUDED`.
 *
 * The lanes are disjoint: `spanish-user-strings-cli` walks `src/cli/`, this
 * one the five folders of `SERVICE_SURFACES`, and the two English CLI lanes
 * only `src/cli/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Lane, LaneMeter } from '../lane.js';
import { tsFilesUnder, userStrings, type UserString } from '../extract.js';
import { exitWhenDrained } from '../../lib/exit-when-drained.js';

/** The repository root: this file lives in `scripts/language/lanes/`. */
const ROOT = path.resolve(__dirname, '..', '..', '..');

const LANE_ID = 'spanish-user-strings-services';
const EXAMPLE_COUNT = 8;

/** The folders the lane walks, in the order they are listed. */
export const SERVICE_SURFACES = ['src/services', 'src/api', 'src/ai', 'src/auth', 'src/database'] as const;

/**
 * The files the lane does not count, each with the reason. Adding one changes
 * the population of a published lane, so it is done in view, with its reason.
 */
export const SERVICE_EXCLUDED: Readonly<Record<string, string>> = {
  'src/services/accounting/sat-agrupadores-catalogo.ts':
    'generated data: the official names of the SAT grouping code (c_CodAgrup, Anexo 24 of the RMF 2026, ' +
    'DOF 13 Jan 2026), which go to the authority as published and are never translated',
};

/**
 * What the ratchet tells the author of a PR that trips this lane, appended to
 * the finding (the surrounding message is `language-status.ts`'s, in Spanish).
 */
export const SERVICE_STRINGS_PER_ENTRY_RULE =
  'la prosa nueva de un servicio nace en inglés, y la que llega a quien hace la petición, con clave: ' +
  'AppError({ key, params }) de src/i18n/en.ts (docs/language.md)';

/** The Spanish user strings of ONE file, in reading order; none for an excluded file. */
export function serviceUserStrings(code: string, file: string): UserString[] {
  return file in SERVICE_EXCLUDED ? [] : userStrings(code, file);
}

/** The same for a path, file or folder, in walk order. */
export function serviceUserStringsUnder(target: string): UserString[] {
  const out: UserString[] = [];
  for (const file of tsFilesUnder(target)) {
    if (file in SERVICE_EXCLUDED) continue;
    out.push(...serviceUserStrings(fs.readFileSync(path.join(ROOT, file), 'utf8'), file));
  }
  return out;
}

/** One line per string, as the command prints it and `wc -l` counts it. */
function row(hit: UserString): string {
  return `${hit.file}:${hit.line}\t${JSON.stringify(hit.text)}`;
}

/** An example fits in one line: collapsed whitespace, cut at 64 characters (as in `code.ts`). */
function example(hit: UserString): string {
  const flat = hit.text.replace(/\s+/g, ' ').trim();
  return `${hit.file}:${hit.line} ${flat.length > 64 ? `${flat.slice(0, 63)}…` : flat}`;
}

export const serviceStringsLanes: LaneMeter = () => {
  const hits = SERVICE_SURFACES.flatMap((surface) => serviceUserStringsUnder(surface));
  const tally: Record<string, number> = {};
  for (const hit of hits) tally[hit.file] = (tally[hit.file] ?? 0) + 1;
  const perFile: Record<string, number> = {};
  for (const file of Object.keys(tally).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) perFile[file] = tally[file];
  return [
    {
      id: LANE_ID,
      title: `Spanish user-facing strings still written in ${SERVICE_SURFACES.join('/, ')}/, per file`,
      value: hits.length,
      target: 0,
      command: 'npx tsx scripts/language/lanes/service-strings.ts | wc -l',
      examples: hits.slice(0, EXAMPLE_COUNT).map(example),
      perFile,
      perEntryRule: SERVICE_STRINGS_PER_ENTRY_RULE,
    } satisfies Lane,
  ];
};

function main(args: string[]): number {
  const targets = args.length > 0 ? args : [...SERVICE_SURFACES];
  // One write for the whole list, not one per line (#659): the listing is
  // larger than a pipe buffer.
  const hits = targets.flatMap((target) => serviceUserStringsUnder(target));
  process.stdout.write(hits.map((hit) => `${row(hit)}\n`).join(''));
  return 0;
}

if (require.main === module) {
  exitWhenDrained(main(process.argv.slice(2)));
}
