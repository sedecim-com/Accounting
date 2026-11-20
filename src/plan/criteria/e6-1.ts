import { codigoDe, type Criterio, existe, falla, ok } from './shared.js';

// ============================================================
// THE E6.1 CRITERIA · THE MVP (MNE-001-098, #311)
//
// docs/MVP.md §1 defines the MVP as nine steps a firm runs from the terminal,
// and tests/integration/mvp-month-end-to-end.int.spec.ts is that definition
// made executable: one synthetic company's December 2025, through the real
// binary. The skeleton (MNE-001-097) began with an `it.todo` per step that did
// not work yet, so the route to the MVP was that list and it emptied itself.
//
// A package of its own, as decided on 15 Nov 2026 in #311 (answer 6): E5.1
// cannot close before the MVP, and this one has to be able to enter `--exigir`
// the day it is green. E6.1 and not a name: the board's package ids are
// `E<stage>.<n>` (tests/plan/criterios.spec.ts), and the MVP is the stage after
// the five of docs/plan-cierre-brechas.md. The `--exigir` line of ci.yml is approved apart, in
// this task's pull request, because ci.yml has an owner in CODEOWNERS.
// ============================================================

const MONTH_SPEC = 'tests/integration/mvp-month-end-to-end.int.spec.ts';

/** The nine steps of docs/MVP.md §1, as the spec's sections are numbered. */
const STEPS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];

export const E6_1: Criterio[] = [
  {
    paquete: 'E6.1',
    id: 'mvp-month-spec-has-no-todo',
    enunciado: 'The month of an SME runs every one of its nine steps: the MVP acceptance spec holds no todo and skips nothing',
    mutantes: [
      {
        archivo: MONTH_SPEC,
        de: "    it('the journal XML of the month (`voucher generate`)",
        a: "    it.todo('the journal XML of the month (`voucher generate`)",
        porque: 'a step goes back to a todo: the month would pass in CI with the journal XML of December never generated, which is the hole #311 exists to close',
      },
    ],
    evaluar: () => {
      if (!existe(MONTH_SPEC)) return falla(`${MONTH_SPEC} does not exist: the MVP has no acceptance test`);
      // Comments are left out: the spec's own header explains what an
      // `it.todo` was, and prose runs nothing.
      const spec = codigoDe(MONTH_SPEC);
      // Not vacuous: the nine sections of docs/MVP.md §1 must be there, with
      // at least as many tests as steps, before the absence of a todo means
      // anything (tests/plan/vacuity.spec.ts empties the tree).
      const sections = [...spec.matchAll(/^\s*describe\('(\d) · /gm)].map((m) => m[1]);
      const missing = STEPS.filter((s) => !sections.includes(s));
      if (missing.length > 0) {
        return falla(`the month spec lacks the section(s) ${missing.join(', ')} of the nine steps of docs/MVP.md §1`);
      }
      const tests = (spec.match(/^\s*it\(/gm) ?? []).length;
      if (tests < STEPS.length) return falla(`the month spec runs ${tests} test(s), fewer than its nine steps`);
      // A skipped step is the same hole as a todo: it is reported as not run
      // and the suite stays green.
      const holes = [...spec.matchAll(/\b(?:it|test|describe)\.(todo|skip|skipIf|runIf|only)\s*\(/g)].map((m) => m[1]);
      return holes.length === 0
        ? ok(`the nine steps run ${tests} tests, with no todo and nothing skipped`)
        : falla(`the month spec still holds ${holes.length} ${[...new Set(holes)].join('/')}: a step that does not run is a task, not a todo`);
    },
  },
];
