import type { SpawnSyncReturns } from 'node:child_process';

// ============================================================
// What an xmllint run says about the document it was given (#397, #105).
//
// Both official-XSD validators (anexo24/official-xsd.ts and
// cfdi40/official-xsd.ts) feed the document on stdin and read xmllint's exit
// code. The code for a document that cannot be parsed is not stable across
// libxml2 releases: 2.9.14 exits 1 ("unclassified"), 2.15.2 exits 4 ("error
// reading the document"). The CI runner moved from the first to the second
// when ubuntu-latest became 26.04, and a document that is not well-formed
// started to read as a broken setup instead of a verdict.
//
// So a 1 or a 4 is a verdict only when xmllint named a line of the document:
// its diagnostics about stdin start with "-:". With no such line it judged
// nothing, and a validation that did not run must not read as a verdict.
// 3 is "does not validate". Anything else (5: a schema failed to compile) is
// a broken setup, and throws.
// ============================================================

export interface XsdVerdict {
  valid: boolean;
  /** xmllint's own lines, one per violation, with the stdin marker removed. */
  errors: string[];
}

const VALID = 0;
const DOES_NOT_VALIDATE = 3;
const UNPARSEABLE = new Set([1, 4]);

export function xsdVerdictOf(run: Pick<SpawnSyncReturns<string>, 'status' | 'stderr'>): XsdVerdict {
  const errors = run.stderr
    .split('\n')
    .filter((line) => line.startsWith('-:'))
    .map((line) => line.replace(/^-:/, 'line '));
  if (run.status === VALID) return { valid: true, errors };
  if (run.status === DOES_NOT_VALIDATE) return { valid: false, errors };
  if (run.status !== null && UNPARSEABLE.has(run.status) && errors.length > 0) {
    return { valid: false, errors };
  }
  throw new Error(`xmllint exited with ${String(run.status)}; this is a setup problem:\n${run.stderr}`);
}
