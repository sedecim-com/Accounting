import { describe, it, expect } from 'vitest';
import { CRITERIOS, conFuenteMutada, consumidoresDe, crudoDe } from '../../src/plan/criterios.js';

// MNE-001-693. `agent-tools-from-risk-registry` used to turn green as soon as
// any file outside `src/cli/kernel/` NAMED `allDeclarations`. The command
// manifest names it, so the board would have said «the bridge exists» while
// the agent's tools were still written by hand.
//
// The criterion is red on this tree, so its mirrors in `mutacion.spec.ts` pass
// whatever it measures. This file is what gives them teeth: it builds the tree
// in which the criterion IS green, and shows that each near miss, one step
// away from that tree, is red.
const criterion = CRITERIOS.find((c) => c.id === 'agent-tools-from-risk-registry')!;
const FACTORY = 'src/ai/tools/index.ts';
/** A module the factory imports, and one of which it imports only the types. */
const IMPORTED = 'src/ai/tools/docs-tools.ts';
const TYPES_ONLY = 'src/ai/tools/observer.ts';

const IMPORT = "import { allDeclarations } from '../../cli/kernel/risk.js';\n";
const CALL = '\nexport const declared = allDeclarations();\n';

const evaluateWith = (overlay: Record<string, string>) => conFuenteMutada(overlay, () => criterion.evaluar());
const appended = (file: string, text: string): Record<string, string> => ({ [file]: IMPORT + crudoDe(file) + text });

describe('E5.1 agent-tools-from-risk-registry stays red until the tools come from the registry', () => {
  it('is red on this tree although a file outside the kernel names the registry', async () => {
    const outside = consumidoresDe('allDeclarations', 'risk.ts').filter((f) => !f.startsWith('src/cli/kernel/'));
    expect(outside).toContain('src/cli/command-manifest.ts');

    const r = await criterion.evaluar();
    expect(r.estado).toBe('falla');
    expect(r.detalle).toContain('MNE-001-391');
  });

  it('is green when the tool factory calls the registry', async () => {
    const r = await evaluateWith(appended(FACTORY, CALL));
    expect(r.estado).toBe('ok');
    expect(r.detalle).toContain(FACTORY);
  });

  it('is green when a module the factory imports calls the registry', async () => {
    expect(crudoDe(FACTORY)).toContain("from './docs-tools.js'");
    const r = await evaluateWith(appended(IMPORTED, CALL));
    expect(r.estado).toBe('ok');
    expect(r.detalle).toContain(IMPORTED);
  });

  it.each([
    ['a re-export', "\nexport { allDeclarations } from '../../cli/kernel/risk.js';\n"],
    ['an import that is never called', '\nexport const registry = allDeclarations;\n'],
    ['a call inside a comment', '\n// const declared = allDeclarations();\n'],
    ['a call inside a string', "\nexport const note = 'allDeclarations()';\n"],
  ])('stays red when the factory holds %s', async (_what, text) => {
    const r = await evaluateWith(appended(FACTORY, text));
    expect(r.estado).toBe('falla');
  });

  it('stays red when the call lives in a module of which the factory imports only the types', async () => {
    expect(crudoDe(FACTORY)).toContain("import type { ToolDeps } from './observer.js'");
    const r = await evaluateWith(appended(TYPES_ONLY, CALL));
    expect(r.estado).toBe('falla');
    expect(r.detalle).toContain(TYPES_ONLY);
  });

  it('declares its mirrors, which the old condition did not survive', async () => {
    expect(criterion.mutantes?.map((m) => m.archivo)).toEqual([FACTORY, TYPES_ONLY]);
    for (const m of criterion.mutantes!) {
      const mutated = { [m.archivo]: crudoDe(m.archivo).replace(m.de, m.a!) };
      const named = await conFuenteMutada(mutated, () => consumidoresDe('allDeclarations', 'risk.ts'));
      expect(named).toContain(m.archivo);
      expect((await evaluateWith(mutated)).estado).toBe('falla');
    }
  });
});
