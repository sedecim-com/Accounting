import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// CONTRACT: src/utils/zod-client-errors.ts is the only place where a Zod
// issue becomes client prose (#367). A second place that reads `error.issues`
// would word its messages however the installed Zod does, and the next Zod
// upgrade would change them without touching the adapter that pins them.

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const ADAPTER = path.join(SRC, 'utils', 'zod-client-errors.ts');
// The agent tools are parsed by @anthropic-ai/sdk, not by this code, and
// their errors go to the model rather than to a client.
const SDK_PARSED = path.join(SRC, 'ai', 'tools');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return full === SDK_PARSED ? [] : sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('zod issues reach a client only through the adapter', () => {
  it('no source file outside the adapter reads error.issues or error.errors', () => {
    const readers = sourceFiles(SRC)
      .filter((file) => file !== ADAPTER)
      .filter((file) => /\.error\.(issues|errors)\b/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(ROOT, file));
    expect(readers).toEqual([]);
  });
});
