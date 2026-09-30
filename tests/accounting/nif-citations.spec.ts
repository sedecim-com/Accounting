import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Since 1 January 2023 the whole NIF A series is one standard, NIF A-1
 * "Marco Conceptual"; the basic postulates (accrual, economic duality,
 * matching of costs with revenue) are its chapter 20. Since 1 January 2026
 * the key "NIF A-2" belongs to a different, standing norm: "Incertidumbres
 * sobre negocio en marcha" (CINIF, promulgated December 2024). A message
 * that cites "NIF A-2" for a postulate now points the accountant at the
 * going-concern standard (#133, MNE-001-077).
 *
 * Scope: the engine (every .ts under src/). The agent corpus in src/ai/docs
 * is MNE-001-078, and applied migrations are immutable (AGENTS.md).
 */
const ROOT = join(__dirname, '..', '..', 'src');

function typescriptFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return typescriptFiles(path);
    return name.endsWith('.ts') ? [path] : [];
  });
}

// A line may still name NIF A-2 when it talks about the going-concern norm.
const GOING_CONCERN = /negocio en marcha|going concern/i;

describe('NIF citations in the engine', () => {
  it('no source line cites NIF A-2 for a postulate of NIF A-1 chapter 20', () => {
    const offenders = typescriptFiles(ROOT).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((text, i) => ({ text, at: `${relative(ROOT, file)}:${i + 1}` }))
        .filter(({ text }) => /NIF A-2\b/.test(text) && !GOING_CONCERN.test(text))
        .map(({ at }) => at)
    );
    expect(offenders).toEqual([]);
  });
});
