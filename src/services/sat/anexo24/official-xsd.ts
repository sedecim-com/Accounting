import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { AppError } from '../../../utils/errors.js';
import { xsdVerdictOf, type XsdVerdict } from '../xsd-verdict.js';

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
// Without it `validateAgainstOfficialXsd` throws, never skips, because a
// validation that did not run must not read as a pass. Install it with
// libxml2-utils (apt) or libxml2 (Homebrew).
//
// It lives in src/ since EFIRMA-4 (#442): the seal is refused unless the sealed
// document validates, so the same check the tests run guards what is handed
// to the taxpayer. `npm run build:api` copies `xsd/` next to this module.
//
// Since #608 the generators pass their finished file through
// `officialXsdRefusal` too: a file this schema does not accept, or one that
// could not be validated, is never reported as deliverable.
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

export type { XsdVerdict };

// What each xmllint exit code means, and why a document that is not
// well-formed can come back as 1 or as 4, is in ../xsd-verdict.ts.

/** xmllint could not be started, so nothing was judged. Any other failure of the run is a broken setup. */
export class XmllintDidNotRun extends Error {
  constructor(readonly spawnError: string) {
    super(
      `xmllint did not run (${spawnError}). Install libxml2-utils (apt) or libxml2 ` +
        `(Homebrew): the Anexo 24 XML is checked against the SAT's official XSD.`
    );
    this.name = 'XmllintDidNotRun';
  }
}

export function validateAgainstOfficialXsd(xml: string, schema: OfficialSchema): XsdVerdict {
  const run = spawnSync(
    'xmllint',
    ['--nonet', '--noout', '--schema', path.join(XSD_ROOT, OFFICIAL_SCHEMAS[schema]), '-'],
    {
      input: xml,
      encoding: 'utf8',
      // NOTE: no cap on stderr. One c_CodAgrup error is 15 KB, so a chart with
      // 70 of them passed the default 1 MB and read as "xmllint did not run".
      maxBuffer: Infinity,
      env: { ...process.env, XML_CATALOG_FILES: XSD_CATALOG },
    }
  );
  if (run.error) throw new XmllintDidNotRun(run.error.message);
  return xsdVerdictOf(run);
}

/** The libxml release of the xmllint on the PATH, or null when there is none. What `doctor` reports. */
export function xmllintVersion(): string | null {
  const run = spawnSync('xmllint', ['--version'], { encoding: 'utf8' });
  if (run.error || run.status !== 0) return null;
  return /version (\d+)/.exec(`${run.stderr}${run.stdout}`)?.[1] ?? 'unknown';
}

// One enumeration error of the chart's schema lists the whole c_CodAgrup: 15 KB
// in one line. A finding shows this much, and says how many lines it left out.
const SHOWN_LINES = 5;
const SHOWN_CHARACTERS = 300;

/**
 * Why a generated file cannot be handed over, by catalogue key.
 * `rejected`: the schema judged the bytes and refused them (a document that is
 * not well formed included). `not_validated`: xmllint did not run.
 * `not_built`: there were no bytes, the builder refused them (`balance check`,
 * MNE-001-774); the gate below never returns it.
 */
export class OfficialXsdRefusal extends AppError {
  constructor(
    readonly reason: 'rejected' | 'not_validated' | 'not_built',
    params: Record<string, string | number>
  ) {
    const key =
      reason === 'rejected'
        ? 'anexo24.xsd.rejected'
        : reason === 'not_validated'
          ? 'anexo24.xsd.not_validated'
          : 'anexo24.xsd.not_built';
    super(422, 'VALIDATION_ERROR', { key, params });
    this.name = 'OfficialXsdRefusal';
  }
}

/**
 * CONTRACT: the gate between a generator and a SAT deliverable (#608). Null
 * when the official XSD accepts `xml`; otherwise the refusal, which the
 * generator adds to its findings or throws. It never corrects the document.
 */
export function officialXsdRefusal(xml: string, schema: OfficialSchema): OfficialXsdRefusal | null {
  const file = path.basename(OFFICIAL_SCHEMAS[schema]);
  let verdict: XsdVerdict;
  try {
    verdict = validateAgainstOfficialXsd(xml, schema);
  } catch (err) {
    if (err instanceof XmllintDidNotRun) {
      return new OfficialXsdRefusal('not_validated', { schema: file, cause: err.spawnError });
    }
    throw err;
  }
  if (verdict.valid) return null;
  const shown = verdict.errors
    .slice(0, SHOWN_LINES)
    .map((line) => (line.length > SHOWN_CHARACTERS ? `${line.slice(0, SHOWN_CHARACTERS - 1)}…` : line));
  return new OfficialXsdRefusal('rejected', {
    schema: file,
    errors: shown.join('; '),
    more: verdict.errors.length - shown.length,
  });
}
