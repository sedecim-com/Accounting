import { inject } from 'vitest';
import { CRITERIOS, type Criterio, type Resultado } from '../../src/plan/criterios.js';
import {
  groupIntoPackages,
  identidadDe,
  resultOfThrow,
  type Paquete,
} from '../../src/plan/status.js';
import type { CheckResult } from '../../src/ai/doctor-service.js';

// ============================================================
// THE BOARD IS EVALUATED ONCE PER RUN, AND THIS IS HOW A TEST READS IT (#293)
//
// `tests/helpers/unit-global-setup.ts` runs every criterion of
// src/plan/criterios.ts once, before any test file starts, and hands the
// results to the workers through vitest's provide/inject. Before this, every
// file that needed the board ran it whole on its own —status.spec.ts six
// times, criterios.spec.ts twice— and each copy paid a `git check-ignore`
// subprocess, a Postgres socket and a full read of the tree. Under the whole
// suite in parallel that went past every ceiling it was given, and each new
// ceiling bought one more CI cycle.
//
// What crosses the process boundary is DATA ONLY: a criterion is an object
// with functions and cannot be serialized, so it travels as its position in
// CRITERIOS plus its identity, and this module joins it back to the real
// criterion object here, in the worker. A board that changed between the
// setup and the worker —it cannot, within one run, but a stale mapping must
// never be read as a result— is refused, not reinterpreted.
//
// This shares RESULTS of the real tree, never the instruments: the mutation
// harness (tests/plan/mutacion.spec.ts, `npm run mutantes`) still evaluates
// each criterion itself under its in-memory overlay, and the `sinComentarios`
// cache stays keyed by content.
// ============================================================

/** One criterion's outcome, in CRITERIOS order, as it crosses processes. */
export interface BoardEntry {
  identity: string;
  /** Present when `evaluar()` returned. */
  result?: Resultado;
  /** Present, with its message, when `evaluar()` threw. */
  threw?: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    board: BoardEntry[];
    /** `checkOrphanedCapability({ cwd: process.cwd() })` over this repository. */
    orphanedCapability: CheckResult;
    /** `checkConsistenciaCli()`: the cold start of `runDoctor`. */
    cliConsistency: CheckResult;
  }
}

export interface SharedRun {
  criterion: Criterio;
  result?: Resultado;
  threw?: string;
}

function provided<K extends 'board' | 'orphanedCapability' | 'cliConsistency'>(key: K) {
  const value = inject(key);
  if (value === undefined) {
    throw new Error(
      `nothing was provided under "${key}": this file needs the globalSetup of vitest.config.ts ` +
        '(tests/helpers/unit-global-setup.ts), which evaluates it once per run'
    );
  }
  return value;
}

/** The board of this run, joined back to the real criterion objects. */
export function sharedBoard(): SharedRun[] {
  const entries = provided('board');
  if (entries.length !== CRITERIOS.length) {
    throw new Error(
      `the shared board has ${entries.length} entries and CRITERIOS has ${CRITERIOS.length}: ` +
        'the setup and this worker did not load the same board'
    );
  }
  return CRITERIOS.map((criterion, i) => {
    const entry = entries[i];
    if (entry.identity !== identidadDe(criterion)) {
      throw new Error(
        `shared board entry ${i} is «${entry.identity}» and CRITERIOS[${i}] is «${identidadDe(criterion)}»`
      );
    }
    return { criterion, result: entry.result, threw: entry.threw };
  });
}

/** What `evaluar()` from src/plan/status.ts would return for this run. */
export function sharedPackages(): Paquete[] {
  return groupIntoPackages(
    sharedBoard().map((r) => ({
      criterio: r.criterion,
      resultado: r.result ?? resultOfThrow(r.threw ?? 'no result was recorded'),
    }))
  );
}

export const sharedOrphanedCapability = (): CheckResult => provided('orphanedCapability');
export const sharedCliConsistency = (): CheckResult => provided('cliConsistency');
