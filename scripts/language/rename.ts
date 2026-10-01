// ============================================================
// THE RENAME CODEMOD (I12 · issue #154, rector §5)
//
// A mass rename by hand is impossible (8 343 identifiers, 737 import sites, 31
// criteria), so the tool comes first and is proven on a synthetic project.
//
// WHAT `tsc` SEES, ts-morph REWRITES: `SourceFile.move()` fixes every import
// and export specifier of `src`, `tests` and `scripts` in one call.
//
// WHAT `tsc` DOES NOT SEE, THIS FILE REWRITES IN THE SAME RUN:
//   · module specifiers held in strings: `vi.mock('…')`, `vi.importActual`,
//     dynamic `import('…')` and `typeof import('…')`;
//   · the repo-relative path quoted in text files: criteria paths and regexes,
//     the coverage-threshold keys of the vitest configs, `ci.yml`, CODEOWNERS,
//     `package.json`, the docs.
//
// It touches specifiers and paths only. A rename PR changes no other string
// literal, so a domain literal (an error code, a SAT label) can never move.
// `verify-rename.ts` then proves the old name is gone.
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Node, Project, SyntaxKind, type SourceFile } from 'ts-morph';

/** Trees whose TypeScript is parsed, so that imports follow the file. */
export const CODE_TREES = ['src', 'tests', 'scripts'];

/** Text files whose quoted paths are rewritten. Directories are walked. */
export const TEXT_TARGETS = [
  'src/plan',
  'tests',
  'vitest.config.ts',
  'vitest.integration.config.ts',
  'package.json',
  '.github',
  'docs',
  'AGENTS.md',
  'CONTRIBUTING.md',
];

/** History is a record and a record is not retouched. */
export const HISTORY_EXCLUDES = ['migrations/', 'docs/auditorias/', 'docs/archive/', 'HISTORY.md'];

const MOCK_CALLEES = new Set(['vi.mock', 'vi.doMock', 'vi.unmock', 'vi.importActual', 'vi.importMock']);

export interface RenameOptions {
  root: string;
  /** Repo-relative path of the file to move, e.g. `src/a/old.ts`. */
  from: string;
  /** Repo-relative destination. */
  to: string;
  /** Overrides {@link TEXT_TARGETS}. */
  textTargets?: string[];
}

export interface RenameResult {
  /** Files in which a string specifier was rewritten. */
  specifierFiles: string[];
  /** Text files in which the quoted path was rewritten. */
  textFiles: string[];
}

export const isExcluded = (rel: string): boolean => HISTORY_EXCLUDES.some((x) => rel.includes(x));

const stem = (p: string): string => p.replace(/\.ts$/, '');
const posix = (p: string): string => p.split(path.sep).join('/');

function walk(root: string, rel: string, out: string[]): void {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return;
  if (fs.statSync(abs).isFile()) {
    out.push(rel);
    return;
  }
  for (const e of fs.readdirSync(abs)) {
    if (e === 'node_modules' || e === '.git') continue;
    walk(root, posix(path.join(rel, e)), out);
  }
}

/** The module-specifier string literals `tsc` does not follow. */
function looseSpecifiers(sf: SourceFile): Node[] {
  const out: Node[] = [];
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    const isImport = callee.getKind() === SyntaxKind.ImportKeyword;
    if (!isImport && !MOCK_CALLEES.has(callee.getText())) continue;
    const arg = call.getArguments()[0];
    if (arg && Node.isStringLiteral(arg)) out.push(arg);
  }
  for (const t of sf.getDescendantsOfKind(SyntaxKind.ImportType)) {
    const lit = t.getArgument().getFirstDescendantByKind(SyntaxKind.StringLiteral);
    if (lit) out.push(lit);
  }
  return out;
}

/**
 * `move()` writes `./facts`; NodeNext needs `./facts.js`. An extensionless
 * relative specifier that resolves to a file is invalid in this repo, so the
 * extension goes back wherever ts-morph dropped it.
 */
function restoreJsExtensions(files: SourceFile[]): void {
  for (const sf of files) {
    for (const d of [...sf.getImportDeclarations(), ...sf.getExportDeclarations()]) {
      const v = d.getModuleSpecifierValue();
      if (v?.startsWith('.') && !/\.(js|json)$/.test(v) && d.getModuleSpecifierSourceFile()) d.setModuleSpecifier(`${v}.js`);
    }
  }
}

const specifierFor = (fromDir: string, target: string): string => {
  const rel = posix(path.relative(fromDir, target));
  return `${rel.startsWith('.') ? rel : `./${rel}`}.js`;
};

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The regex sources (valid in JS and PCRE) that match `p` standing alone as a
 * path: plain, and as written inside a regex literal (`a\/b\.ts`).
 */
export function pathPatterns(p: string): string[] {
  const inRegex = p.replaceAll('/', '\\/').replaceAll('.', '\\.');
  // In a regex literal the path may follow the `/` delimiter; plain, it may not.
  return [`(?<![\\w./-])${escapeRe(p)}(?![\\w-])`, `(?<![\\w.-])${escapeRe(inRegex)}(?![\\w-])`];
}

/** Replace `old` by `next` where it stands alone as a path (not inside a longer one). */
export function replacePath(text: string, old: string, next: string): string {
  const inRegex = (v: string): string => v.replaceAll('/', '\\/').replaceAll('.', '\\.');
  const from = pathPatterns(old);
  return [old, inRegex(old)].reduce(
    (out, a, i) => out.replace(new RegExp(from[i], 'g'), () => (i === 0 ? next : inRegex(next))),
    text,
  );
}

export function renameModule(opts: RenameOptions): RenameResult {
  const { root, from, to } = opts;
  const absFrom = path.join(root, from);
  const absTo = path.join(root, to);
  if (!from.endsWith('.ts') || !to.endsWith('.ts')) throw new Error('rename: both paths must be .ts files');
  if (!fs.existsSync(absFrom)) throw new Error(`rename: ${from} does not exist`);
  if (fs.existsSync(absTo)) throw new Error(`rename: ${to} already exists`);

  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { module: 100 /* NodeNext */, moduleResolution: 99 /* NodeNext */, allowJs: false },
  });
  for (const t of CODE_TREES) {
    if (fs.existsSync(path.join(root, t))) project.addSourceFilesAtPaths(posix(path.join(root, t, '**/*.ts')));
  }
  const moved = project.getSourceFileOrThrow(absFrom);

  // 1. Find the string specifiers that point at the OLD location (by their
  //    order in the file: the count does not change when imports are rewritten).
  const pending = new Map<SourceFile, number[]>();
  for (const sf of project.getSourceFiles()) {
    const hits: number[] = [];
    looseSpecifiers(sf).forEach((lit, i) => {
      if (!Node.isStringLiteral(lit)) return;
      const v = lit.getLiteralValue();
      if (!v.startsWith('.')) return;
      if (path.resolve(path.dirname(sf.getFilePath()), v.replace(/\.js$/, '')) === stem(absFrom)) hits.push(i);
    });
    if (hits.length) pending.set(sf, hits);
  }

  // 2. Imports and exports: the one call that does the work for `tsc`.
  moved.move(absTo);
  restoreJsExtensions(project.getSourceFiles());

  // 3. Then the strings (ts-morph tracks dynamic-import literals and breaks
  //    if they are edited before the move).
  const specifierFiles: string[] = [];
  for (const [sf, hits] of pending) {
    const lits = looseSpecifiers(sf);
    for (const i of hits) {
      const lit = lits[i];
      if (lit && Node.isStringLiteral(lit)) lit.setLiteralValue(specifierFor(path.dirname(sf.getFilePath()), stem(absTo)));
    }
    specifierFiles.push(posix(path.relative(root, sf.getFilePath())));
  }
  project.saveSync();

  // 4. Quoted paths in text files.
  const files: string[] = [];
  for (const t of opts.textTargets ?? TEXT_TARGETS) walk(root, t, files);
  const textFiles: string[] = [];
  for (const rel of files) {
    if (isExcluded(rel) || !/\.(ts|mjs|js|json|yml|yaml|md|txt)$|CODEOWNERS$/.test(rel)) continue;
    const abs = path.join(root, rel);
    const before = fs.readFileSync(abs, 'utf8');
    const after = replacePath(replacePath(before, from, to), stem(from), stem(to));
    if (after !== before) {
      fs.writeFileSync(abs, after);
      textFiles.push(rel);
    }
  }
  return { specifierFiles: specifierFiles.sort(), textFiles: textFiles.sort() };
}

// ---------- CLI ----------
if (process.argv[1] && /(^|[\\/])rename\.ts$/.test(process.argv[1])) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to) {
    process.stderr.write('usage: tsx scripts/language/rename.ts <from.ts> <to.ts>\n');
    process.exit(2);
  }
  const r = renameModule({ root: process.cwd(), from, to });
  process.stdout.write(`${JSON.stringify(r, null, 2)}\nnext: npx tsx scripts/language/verify-rename.ts ${from}\n`);
}
