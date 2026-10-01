import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

// ============================================================
// Validation against the SAT's official CFDI 4.0 XSD (#105 · MNE-001-295).
//
// Same mechanism as the Anexo 24 validator (anexo24/official-xsd.ts): the
// schemas are vendored byte for byte in ./xsd with their source URL and
// SHA-256 in provenance.json, catalog.xml maps the absolute http imports of
// cfdv40.xsd to the local copies, and --nonet turns any lookup that escapes the
// catalog into a failure. xmllint runs as a process: no npm dependency, and
// without it this throws, because a validation that did not run must not read
// as a pass.
//
// `npm run build:api` copies `xsd/` next to this module.
// ============================================================

export const CFDI40_XSD_ROOT = path.join(__dirname, 'xsd');
export const CFDI40_XSD_CATALOG = path.join(CFDI40_XSD_ROOT, 'catalog.xml');
export const CFDI40_SCHEMA = path.join(CFDI40_XSD_ROOT, 'cfd', '4', 'cfdv40.xsd');

export interface Cfdi40Verdict {
  valid: boolean;
  /** xmllint's own lines, one per violation, with the stdin marker removed. */
  errors: string[];
}

// 0 valid, 1 not well-formed, 3 does not validate. Anything else (5: a schema
// failed to compile) is a broken setup, not a verdict on the document.
const VERDICT_EXIT_CODES = new Set([0, 1, 3]);

export function validateAgainstCfdi40Xsd(xml: string): Cfdi40Verdict {
  const run = spawnSync('xmllint', ['--nonet', '--noout', '--schema', CFDI40_SCHEMA, '-'], {
    input: xml,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, XML_CATALOG_FILES: CFDI40_XSD_CATALOG },
  });
  if (run.error) {
    throw new Error(
      `xmllint did not run (${run.error.message}). Install libxml2-utils (apt) or libxml2 ` +
        `(Homebrew): the CFDI is checked against the SAT's official XSD.`
    );
  }
  if (run.status === null || !VERDICT_EXIT_CODES.has(run.status)) {
    throw new Error(`xmllint exited with ${String(run.status)}; this is a setup problem:\n${run.stderr}`);
  }
  const errors = run.stderr
    .split('\n')
    .filter((line) => line.startsWith('-:'))
    .map((line) => line.replace(/^-:/, 'line '));
  return { valid: run.status === 0, errors };
}
