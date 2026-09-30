// ============================================================
// THE PROOF THAT A RENAME LEFT NOTHING BEHIND (I12 · issue #154)
//
// `git grep` of the old repo-relative path (extension or not, plain or
// regex-escaped) outside the records that are not retouched: migrations,
// `docs/auditorias`, `docs/archive` and HISTORY. The answer must be 0.
// ============================================================

import { execFileSync } from 'node:child_process';
import { HISTORY_EXCLUDES, pathPatterns } from './rename.js';

export function verifyRename(root: string, oldPath: string): string[] {
  const oldStem = oldPath.replace(/\.ts$/, '');
  const hits = new Set<string>();
  for (const needle of [...pathPatterns(oldStem), ...pathPatterns(oldPath)]) {
    const args = [
      'grep',
      '--untracked',
      '-n',
      '-P',
      '-e',
      needle,
      '--',
      '.',
      ...HISTORY_EXCLUDES.map((x) => `:(exclude,glob)**/${x}**`),
    ];
    try {
      const out = execFileSync('git', args, { cwd: root, encoding: 'utf8' });
      for (const l of out.split('\n').filter(Boolean)) hits.add(l);
    } catch (e) {
      if ((e as { status?: number }).status !== 1) throw e; // 1 = no match
    }
  }
  return [...hits].sort();
}

if (process.argv[1] && /verify-rename\.ts$/.test(process.argv[1])) {
  const old = process.argv[2];
  if (!old) {
    process.stderr.write('usage: tsx scripts/language/verify-rename.ts <old-path.ts>\n');
    process.exit(2);
  }
  const hits = verifyRename(process.cwd(), old);
  process.stdout.write(`${hits.join('\n')}${hits.length ? '\n' : ''}verify-rename: ${hits.length} occurrence(s) of ${old}\n`);
  process.exit(hits.length === 0 ? 0 : 1);
}
