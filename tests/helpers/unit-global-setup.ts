import type { TestProject } from 'vitest/node';
import type { BoardEntry } from './shared-board.js';

// ============================================================
// WHAT THE UNIT SUITE COMPUTES ONCE PER RUN (#293)
//
// Three things, each expensive and each needed by more than one test file:
//
//  · the whole criteria board of src/plan/criterios.ts, ~9 s alone and 15 to
//    23 s per copy under the full suite, which status.spec.ts paid six times
//    and criterios.spec.ts twice;
//  · `checkOrphanedCapability` over this repository: it reads src/, scripts/
//    and tests/ whole. It took ~16 s until this same change made its export
//    count one pass instead of one per export; it is ~1.5 s now, and it stays
//    here so that no test ceiling is exposed to the tree growing again;
//  · `checkConsistenciaCli`, the cold start of `runDoctor`: it loads the whole
//    CLI, ~5 s the first time in every file that called runDoctor.
//
// Here they run before any worker starts, and no test timeout is charged for
// them: the cost is paid once and is visible, instead of being paid N times
// inside tests whose ceilings kept going up ("Hook timed out" names nobody).
//
// THE SETUP RUNS IN ANOTHER PROCESS, SO IT REPRODUCES THE WORKER'S ENVIRONMENT
// AND THEN LEAVES NO TRACE. A criterion reads the environment —the conducta
// gate checks VITEST, the locale lives in `test.env`— so both are set exactly
// as a worker would see them. And whatever the imported modules add to
// process.env (src/config loads .env) is rolled back afterwards: the workers
// are forked from this process, and a variable leaked here would reach every
// test file, including the ones that assert its absence.
// ============================================================

export default async function setup(project: TestProject): Promise<void> {
  const before = { ...process.env };
  Object.assign(process.env, project.config.env ?? {});
  process.env.VITEST ??= 'true';

  try {
    const criteria = await import('../../src/plan/criterios.js');
    const status = await import('../../src/plan/status.js');

    const board: BoardEntry[] = [];
    for (const criterion of criteria.CRITERIOS) {
      const identity = status.identidadDe(criterion);
      try {
        const r = await criterion.evaluar();
        // Only the two declared fields cross the process boundary.
        board.push({ identity, result: { estado: r.estado, detalle: r.detalle } });
      } catch (err) {
        // The same text `evaluar()` in status.ts would print for it.
        board.push({ identity, threw: `${(err as Error).message}` });
      }
    }
    project.provide('board', board);

    const doctor = await import('../../src/ai/doctor-service.js');
    project.provide('orphanedCapability', doctor.checkOrphanedCapability({ cwd: process.cwd() }));
    project.provide('cliConsistency', await doctor.checkConsistenciaCli());
  } finally {
    // A criterion that needs the database leaves a pool open in THIS process.
    const { closeDatabase } = await import('../../src/database/connection.js');
    await closeDatabase();

    for (const key of Object.keys(process.env)) {
      if (!(key in before)) delete process.env[key];
    }
    Object.assign(process.env, before);
  }
}
