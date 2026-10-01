import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renameModule, replacePath } from '../../scripts/language/rename.js';
import { verifyRename } from '../../scripts/language/verify-rename.js';

// ============================================================
// THE CODEMOD ON A SYNTHETIC PROJECT (I12 · issue #154)
//
// One module, `src/svc/hechos.ts`, is referenced in every way the repo does it:
// a relative import, a re-export, `vi.mock` by string, a dynamic import, a
// `typeof import()`, a criteria path and regex, a threshold key, a CODEOWNERS
// line, and a migration that must stay untouched. After the move every one of
// them names `facts`, `verify-rename` finds 0, and no other literal changed.
// ============================================================

const OLD = 'src/svc/hechos.ts';
const NEW = 'src/svc/facts.ts';

const FILES: Record<string, string> = {
  [OLD]: "export const label = 'hechos pagados';\n",
  'src/svc/report.ts': "import { label } from './hechos.js';\nexport const r = label;\n",
  'src/index.ts': "export * from './svc/hechos.js';\n",
  'src/other/deep.ts': "import type * as H from '../svc/hechos.js';\nexport type T = typeof H;\nexport type U = typeof import('../svc/hechos.js');\nexport const load = () => import('../svc/hechos.js');\n",
  'tests/report.spec.ts':
    "import { vi } from 'vitest';\nvi.mock('../src/svc/hechos.js', () => ({ label: 'hechos' }));\nconst x = 'hechos';\nexport { x };\n",
  'src/plan/criterios.ts':
    "export const PATH = 'src/svc/hechos.ts';\nexport const RX = /src\\/svc\\/hechos\\.ts/;\nexport const OTHER = 'src/svc/hechos-extra.ts';\n",
  'vitest.config.ts': "export default { thresholds: { 'src/svc/hechos.ts': { lines: 90 } } };\n",
  '.github/CODEOWNERS': 'src/svc/hechos.ts @owner\n',
  'migrations/001_a.sql': '-- touches src/svc/hechos.ts\n',
};

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rename-spec-'));
  for (const [rel, body] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

describe('renameModule', () => {
  it('moves the file and rewrites imports, exports and string specifiers', () => {
    const r = renameModule({ root, from: OLD, to: NEW });
    expect(fs.existsSync(path.join(root, OLD))).toBe(false);
    expect(read(NEW)).toContain('hechos pagados'); // content untouched
    expect(read('src/svc/report.ts')).toContain("from './facts.js'");
    expect(read('src/index.ts')).toContain("'./svc/facts.js'");
    const deep = read('src/other/deep.ts');
    expect(deep).toContain("import type * as H from '../svc/facts.js'");
    expect(deep).toContain("typeof import('../svc/facts.js')");
    expect(deep).toContain("import('../svc/facts.js')");
    expect(read('tests/report.spec.ts')).toContain("vi.mock('../src/svc/facts.js'");
    expect(r.specifierFiles).toEqual(['src/other/deep.ts', 'tests/report.spec.ts']);
  });

  it('rewrites criteria paths, regexes and threshold keys, and only those', () => {
    const r = renameModule({ root, from: OLD, to: NEW });
    const crit = read('src/plan/criterios.ts');
    expect(crit).toContain("'src/svc/facts.ts'");
    expect(crit).toContain('/src\\/svc\\/facts\\.ts/');
    expect(crit).toContain("'src/svc/hechos-extra.ts'"); // a longer name is another file
    expect(read('vitest.config.ts')).toContain("'src/svc/facts.ts': { lines: 90 }");
    expect(read('.github/CODEOWNERS')).toBe('src/svc/facts.ts @owner\n');
    expect(r.textFiles).toEqual(['.github/CODEOWNERS', 'src/plan/criterios.ts', 'vitest.config.ts']);
  });

  it('touches no other string literal and leaves migrations alone', () => {
    renameModule({ root, from: OLD, to: NEW });
    expect(read('tests/report.spec.ts')).toContain("label: 'hechos'");
    expect(read('tests/report.spec.ts')).toContain("const x = 'hechos'");
    expect(read('migrations/001_a.sql')).toBe(FILES['migrations/001_a.sql']);
  });

  it('refuses a missing source and an existing destination', () => {
    expect(() => renameModule({ root, from: 'src/nope.ts', to: NEW })).toThrow(/does not exist/);
    fs.writeFileSync(path.join(root, NEW), '');
    expect(() => renameModule({ root, from: OLD, to: NEW })).toThrow(/already exists/);
    expect(() => renameModule({ root, from: OLD, to: 'src/x.js' })).toThrow(/\.ts files/);
  });
});

describe('verifyRename', () => {
  it('finds the old name before the rename and 0 after it', () => {
    const before = verifyRename(root, OLD);
    expect(before.some((l) => l.includes('criterios.ts'))).toBe(true);
    expect(before.some((l) => l.includes('migrations/'))).toBe(false); // excluded
    renameModule({ root, from: OLD, to: NEW });
    expect(verifyRename(root, OLD)).toEqual([]);
  });
});

describe('replacePath', () => {
  it('does not rewrite a path that merely contains the old one', () => {
    expect(replacePath('a/src/x.ts src/x.ts src/x.tsx', 'src/x.ts', 'src/y.ts')).toBe('a/src/x.ts src/y.ts src/x.tsx');
  });
});
