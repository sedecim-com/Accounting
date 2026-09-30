import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Since 1 January 2023 the whole NIF A series is one standard, NIF A-1
 * "Marco Conceptual"; the basic postulates (accrual, economic duality,
 * matching of costs with revenue, and going concern itself) are its chapter
 * 20. Since 1 January 2026 the key "NIF A-2" belongs to a different, standing
 * norm: "Incertidumbres sobre negocio en marcha" (CINIF, promulgated December
 * 2024). A message that cites "NIF A-2" for a postulate now points the
 * accountant at the uncertainty standard (#133, MNE-001-077).
 *
 * Scope: every .ts and .sql under src/, and the agent manuals under
 * src/ai/docs. The only lines allowed to name the key without the new
 * standard's title are listed in ALLOWED, each with its reason.
 */
const ROOT = join(__dirname, '..', '..', 'src');

// Any spelling of the key: "NIF A-2", "NIF A2", "NIF A‑2" (non-breaking
// hyphen), "NIF A-2", and so on.
const CITES_A2 = /NIF\s*A\s*[-‐‑‒–]?\s*2\b/i;

// A line may name NIF A-2 only when it names the NEW standard by its title.
// «Negocio en marcha» alone is not enough: it is also a chapter 20 postulate.
const NEW_A2_TITLE = /incertidumbres? sobre (el )?negocio en marcha|going[- ]concern uncertaint/i;

const ALLOWED: Record<string, string> = {
  // Applied migrations are immutable (AGENTS.md). Its table comment still
  // says «la NIF A-2 obliga a devengar»; re-issuing it needs a new migration.
  [join('database', 'migrations', '059_la_promesa_que_se_devenga.sql') + ':9']: 'immutable header',
  [join('database', 'migrations', '059_la_promesa_que_se_devenga.sql') + ':200']:
    'immutable COMMENT ON TABLE, to be re-issued by a new migration',
  // The collision note tells the agent that accountants still say "NIF A-2";
  // the new A-2 fiche that rewrites it is MNE-001-078.
  [join('ai', 'docs', 'nif-marco.md') + ':12']: 'collision note, MNE-001-078',
  // The warning itself: «No los cites como "NIF A-2"».
  [join('ai', 'docs', 'nif-validaciones.md') + ':10']: 'the warning against the old key',
};

function scannedFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return scannedFiles(path);
    if (name.endsWith('.ts') || name.endsWith('.sql')) return [path];
    if (name.endsWith('.md') && path.includes(`${sep}ai${sep}docs${sep}`)) return [path];
    return [];
  });
}

function citesA2ForAPostulate(line: string): boolean {
  return CITES_A2.test(line) && !NEW_A2_TITLE.test(line);
}

describe('NIF citations in the engine', () => {
  it('no source line cites NIF A-2 for a postulate of NIF A-1 chapter 20', () => {
    const offenders = scannedFiles(ROOT).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .map((text, i) => ({ text, at: `${relative(ROOT, file)}:${i + 1}` }))
        .filter(({ text, at }) => citesA2ForAPostulate(text) && !(at in ALLOWED))
        .map(({ at }) => at)
    );
    expect(offenders).toEqual([]);
  });

  it('every allowlisted line still exists and still names the key', () => {
    for (const at of Object.keys(ALLOWED)) {
      const [file, line] = [at.slice(0, at.lastIndexOf(':')), Number(at.slice(at.lastIndexOf(':') + 1))];
      const text = readFileSync(join(ROOT, file), 'utf8').split('\n')[line - 1] ?? '';
      expect(CITES_A2.test(text), at).toBe(true);
    }
  });

  it('flags a postulate cited under the old key, in any spelling', () => {
    expect(citesA2ForAPostulate('[NIF A-2, negocio en marcha: se asume que la entidad continúa operando]')).toBe(true);
    expect(citesA2ForAPostulate('[NIF A-2, going concern]')).toBe(true);
    expect(citesA2ForAPostulate('NIF A‑2 devengación')).toBe(true);
    expect(citesA2ForAPostulate('NIF A2 devengación')).toBe(true);
    expect(citesA2ForAPostulate('NIF A-2 dualidad económica')).toBe(true);
  });

  it('lets through the new standard named by its title, and other keys', () => {
    expect(citesA2ForAPostulate('NIF A-2, Incertidumbres sobre negocio en marcha')).toBe(false);
    expect(citesA2ForAPostulate('NIF A-2 (going-concern uncertainties)')).toBe(false);
    expect(citesA2ForAPostulate('[NIF A-1, cap. 20, devengación contable]')).toBe(false);
    expect(citesA2ForAPostulate('NIF A-20')).toBe(false);
    expect(citesA2ForAPostulate('NIF A-1')).toBe(false);
  });
});
