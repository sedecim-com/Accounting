import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { xsdVerdictOf, type XsdVerdict } from '../xsd-verdict.js';

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

/** The verdict of the shared reader of xmllint's exit code (../xsd-verdict.ts). */
export type Cfdi40Verdict = XsdVerdict;

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
  return xsdVerdictOf(run);
}
