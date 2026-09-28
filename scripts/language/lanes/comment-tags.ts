/**
 * COMMENT MARKERS THAT POINT AT NO ISSUE (#334)
 *
 *   npx tsx scripts/language/lanes/comment-tags.ts           one line per marker: file:line text
 *   npx tsx scripts/language/lanes/comment-tags.ts | wc -l   the lane's number
 *
 * AGENTS.md allows six comment tags —TODO(#n):, FIXME(#n):, NOTE:, SECURITY:,
 * CONTRACT: and AGENT-NO-TOUCH:— and says a TODO without an issue does not get
 * in. A marker with no issue is work nobody owns: nothing lists it, nothing
 * closes it, and it outlives whoever wrote it.
 *
 * WHAT COUNTS. A comment line that STARTS with TODO, FIXME, XXX or HACK followed
 * by `:` or `(`, unless it is TODO(#n): or FIXME(#n):. Looking only at the start
 * of the line is what keeps out the Spanish word —«TODO ES PURO», «MÉTODO»—
 * and a marker merely quoted in a sentence. Upper case only, for the same
 * reason. Measured when this was written: 109 comment lines in src/, tests/
 * and scripts/ mention one of the four words, and exactly one of them was a
 * marker with no issue.
 *
 * WHY IN THE LANGUAGE METER. It is not about language, but the meter already
 * has what this needs: a per-file baseline that only shrinks, `--check` in CI
 * and `--tighten`. The owner chose it over a second ratchet file (#334).
 *
 * THE SAME TEST LIVES TWICE. `house/comment-tags` in eslint.config.mjs repeats
 * it in JavaScript, because the lint configuration cannot import TypeScript.
 * tests/language/comment-tags.spec.ts runs both over every file of the tree
 * and fails on the first file where they disagree.
 *
 * THE SAME COMMENTS, TOO. The comments come from the parser ESLint uses
 * (typescript-eslint), not from a scanner of our own: a hand-written one read
 * the quote inside `/'/` as the start of a string and joined two comments on
 * one line (Witness, WIT-01 on #396). Asking the same parser is what makes
 * «the lane counts what the rule counts» true by construction.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parser } from 'typescript-eslint';
import type { Lane, LaneMeter } from '../lane.js';
import { tsFiles, TREES } from './code.js';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EXAMPLE_COUNT = 8;

/** A work marker at the start of a comment line. */
const MARKER = /^(TODO|FIXME|XXX|HACK)\s*[:(]/;
/** The two forms AGENTS.md allows: the marker tied to its issue. */
const WITH_ISSUE = /^(TODO|FIXME)\(#\d+\):/;
/** MARKER without its anchor: what a file must contain to hold one at all. */
const ANYWHERE = /(TODO|FIXME|XXX|HACK)\s*[:(]/;

/** One comment line, without the `*` that starts the lines of a block comment. */
export function isUntaggedMarker(commentLine: string): boolean {
  const text = commentLine.replace(/^[\s*]*/, '');
  return MARKER.test(text) && !WITH_ISSUE.test(text);
}

/** The two fields of an ESTree comment this reads: its text without delimiters, and where it starts. */
interface ParsedComment {
  value: string;
  loc: { start: { line: number } };
}

export interface MarkerHit {
  file: string;
  line: number;
  text: string;
}

/**
 * Every untagged marker in one source text, line by line inside each comment,
 * as the rule reads `sourceCode.getAllComments()`. Strings, templates and
 * regex literals are not comments.
 */
export function untaggedMarkers(source: string, file = ''): MarkerHit[] {
  // Parsing every file tripled the meter's time. A marker needs its word
  // followed by `:` or `(` somewhere in the text, so a file without one has
  // no hits and is not parsed; the conformance test still covers every file.
  if (!ANYWHERE.test(source)) return [];
  // `parser` is typed as ESLint's minimal parser; ESLint reads `ast.comments`, and so does this.
  const { ast } = parser.parseForESLint(source) as { ast: { comments?: ParsedComment[] } };
  const hits: MarkerHit[] = [];
  for (const comment of ast.comments ?? []) {
    comment.value.split('\n').forEach((text, offset) => {
      if (isUntaggedMarker(text)) hits.push({ file, line: comment.loc.start.line + offset, text: text.trim() });
    });
  }
  return hits;
}

/** The whole population: the same three trees, and the same walk, as the identifier lanes. */
function markersInTree(): MarkerHit[] {
  return TREES.flatMap((tree) =>
    tsFiles(tree).flatMap((file) => untaggedMarkers(fs.readFileSync(path.join(ROOT, file), 'utf8'), file))
  );
}

export const commentTagsLanes: LaneMeter = () => {
  const hits = markersInTree();
  const perFile: Record<string, number> = {};
  for (const hit of hits) perFile[hit.file] = (perFile[hit.file] ?? 0) + 1;
  return [
    {
      id: 'untagged-comment-markers',
      title: 'TODO, FIXME, XXX and HACK comments with no issue under src/, tests/ and scripts/',
      value: hits.length,
      target: 0,
      command: 'npx tsx scripts/language/lanes/comment-tags.ts | wc -l',
      examples: hits.slice(0, EXAMPLE_COUNT).map((hit) => `${hit.file}:${hit.line} ${hit.text.slice(0, 64)}`),
      perFile,
    } satisfies Lane,
  ];
};

if (require.main === module) {
  for (const hit of markersInTree()) process.stdout.write(`${hit.file}:${hit.line}\t${hit.text}\n`);
}
