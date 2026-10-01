import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

// ============================================================
// Validation against the SAT's official Anexo 24 XSDs (#397).
//
// The schemas are vendored byte for byte in src/services/sat/anexo24/xsd/,
// with their source URL, download date and SHA-256 in provenance.json. They
// import each other by absolute http URL: catalog.xml maps that prefix to the
// local copies, and --nonet turns any lookup that escapes the catalog into a
// failure instead of a request to sat.gob.mx.
//
// The validator is libxml2's xmllint, run as a process: no npm dependency.
// Without it this throws, never skips, because a validation that did not run
// must not read as a pass. Install it with libxml2-utils (apt) or libxml2
// (Homebrew).
//
// It lives in src/ since EFIRMA-4 (#442): the seal is refused unless the sealed
// document validates, so the same check the tests run guards what is handed
// to the taxpayer. `npm run build:api` copies `xsd/` next to this module.
// ============================================================

export const XSD_ROOT = path.join(__dirname, 'xsd');
export const XSD_CATALOG = path.join(XSD_ROOT, 'catalog.xml');

/** The five documents the Anexo 24 asks for, keyed by what they are. */
export const OFFICIAL_SCHEMAS = {
  chart: 'ContabilidadE/1_3/CatalogoCuentas/CatalogoCuentas_1_3.xsd',
  trialBalance: 'ContabilidadE/1_3/BalanzaComprobacion/BalanzaComprobacion_1_3.xsd',
  journal: 'ContabilidadE/1_3/PolizasPeriodo/PolizasPeriodo_1_3.xsd',
  accountAuxiliary: 'ContabilidadE/1_3/AuxiliarCtas/AuxiliarCtas_1_3.xsd',
  voucherAuxiliary: 'ContabilidadE/1_3/AuxiliarFolios/AuxiliarFolios_1_3.xsd',
} as const;

export type OfficialSchema = keyof typeof OFFICIAL_SCHEMAS;

export interface XsdVerdict {
  valid: boolean;
  /** xmllint's own lines, one per violation, with the stdin marker removed. */
  errors: string[];
}

// xmllint's exit codes: 0 valid, 1 the document is not well-formed, 3 it does
// not validate. Anything else (5: a schema failed to compile) is a broken
// setup, not a verdict on the document, so it throws.
const VERDICT_EXIT_CODES = new Set([0, 1, 3]);

export function validateAgainstOfficialXsd(xml: string, schema: OfficialSchema): XsdVerdict {
  const run = spawnSync(
    'xmllint',
    ['--nonet', '--noout', '--schema', path.join(XSD_ROOT, OFFICIAL_SCHEMAS[schema]), '-'],
    {
      input: xml,
      encoding: 'utf8',
      env: { ...process.env, XML_CATALOG_FILES: XSD_CATALOG },
    }
  );
  if (run.error) {
    throw new Error(
      `xmllint did not run (${run.error.message}). Install libxml2-utils (apt) or libxml2 ` +
        `(Homebrew): the Anexo 24 XML is checked against the SAT's official XSD.`
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
