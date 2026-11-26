import { describe, expect, it, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import type { Lane } from '../../scripts/language/lane.js';
import { compare } from '../../scripts/language-status.js';
import { judgeLanguage, userStringsUnder } from '../../scripts/language/extract.js';
import { SAT_CATALOGS } from '../../src/services/xml-ingestion/sat-catalogs.js';
import {
  SERVICE_EXCLUDED,
  SERVICE_STRINGS_PER_ENTRY_RULE,
  SERVICE_SURFACES,
  serviceStringsLanes,
  serviceUserStrings,
  serviceUserStringsUnder,
} from '../../scripts/language/lanes/service-strings.js';

// ============================================================
// THE `spanish-user-strings-services` LANE (MNE-001-153, #151)
//
// The recognizer is `extract.ts`'s and its rules are pinned in
// `extract.spec.ts`. What this file pins is what the lane adds on top: which
// folders it walks, the one file it leaves out, and that its command and its
// ratchet say the same as its number. Every figure in a fragment is counted by
// hand from the fragment above it.
// ============================================================

const ROOT = path.resolve(__dirname, '..', '..');
const SAT_CATALOGUE = 'src/services/accounting/sat-agrupadores-catalogo.ts';
const LAW_SEED = 'src/services/jurisdiction/legal-parameters-seed.ts';
const CFDI_CATALOGUES = 'src/services/xml-ingestion/sat-catalogs.ts';

describe('serviceUserStrings: what is counted', () => {
  it('counts Spanish prose whether it reaches the error directly or through a variable, and logs too', () => {
    const code = [
      "import { ValidationError, AppError } from '../../utils/errors.js';", //   1
      'export function check(total: number): void {', //                         2
      "  if (total < 0) throw new ValidationError('La póliza no cuadra por la diferencia');", // 3 ← 1
      "  const motivo = 'El periodo ya está cerrado para esta entidad';", //    4 ← 2
      '  if (total === 0) throw new AppError(409, "PERIOD_CLOSED", motivo);', //  5
      "  logger.warn('No se encontró el tipo de cambio del día');", //          6 ← 3
      "  throw new ValidationError('The entry does not balance by the difference');", // 7
      "  throw new ValidationError({ key: 'error.PERIOD_ALREADY_OPEN' });", //   8
      "  if (estado === 'sin cotejar con el banco') return;", //                 9
      '}',
    ].join('\n');
    expect(serviceUserStrings(code, 'src/services/accounting/fragment.ts').map((hit) => hit.line)).toEqual([3, 4, 6]);
  });

  it('counts nothing in the SAT grouping catalogue, which the shared recognizer does count', () => {
    const code = "export const ROWS = [['101', 'Caja y efectivo de la entidad', 1]];";
    expect(serviceUserStrings(code, 'src/services/accounting/elsewhere.ts')).toHaveLength(1);
    expect(serviceUserStrings(code, SAT_CATALOGUE)).toEqual([]);
    expect(Object.keys(SERVICE_EXCLUDED)).toEqual([SAT_CATALOGUE, LAW_SEED, CFDI_CATALOGUES]);
    expect(SERVICE_EXCLUDED[SAT_CATALOGUE]).toMatch(/SAT/);
    expect(userStringsUnder(SAT_CATALOGUE).length).toBeGreaterThan(0);
    expect(serviceUserStringsUnder(SAT_CATALOGUE)).toEqual([]);
  });
});

describe('the law seed is left out only for its verbatim quotes', () => {
  it('every string the shared recognizer finds there is English once its «…» quotes are removed', () => {
    const hits = userStringsUnder(LAW_SEED);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.text, `${hit.file}:${hit.line}`).toMatch(/«[^»]+»/);
      const withoutQuotes = hit.text.replace(/«[^»]*»/g, ' ');
      expect(judgeLanguage(withoutQuotes).spanish, `${hit.file}:${hit.line} ${withoutQuotes}`).toBe(false);
    }
    expect(serviceUserStringsUnder(LAW_SEED)).toEqual([]);
    expect(SERVICE_EXCLUDED[LAW_SEED]).toMatch(/verbatim/);
  });

  it('would still see Spanish prose outside a quote, so the exclusion is not a blanket one', () => {
    const prose = "LFT art. 87: «por lo menos». El mínimo es de la ley y vive en el panel del despacho.";
    expect(judgeLanguage(prose.replace(/«[^»]*»/g, ' ')).spanish).toBe(true);
  });
});

describe('the CFDI catalogues are left out only for the SAT\'s own names (MNE-001-728)', () => {
  it('every string the shared recognizer finds there is a value of SAT_CATALOGS', () => {
    const names = new Set<string>(
      Object.values(SAT_CATALOGS).flatMap((table) => Object.values(table as Record<string, string>))
    );
    const hits = userStringsUnder(CFDI_CATALOGUES);
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) expect(names.has(hit.text), `${hit.file}:${hit.line} ${hit.text}`).toBe(true);
    expect(serviceUserStringsUnder(CFDI_CATALOGUES)).toEqual([]);
    expect(SERVICE_EXCLUDED[CFDI_CATALOGUES]).toMatch(/SAT/);
  });
});

describe('serviceStringsLanes', () => {
  let lane: Lane;
  beforeAll(() => {
    [lane] = serviceStringsLanes();
  }, 120_000);

  it('publishes one ratcheted lane over the five folders, per file, summing to its total', () => {
    expect(SERVICE_SURFACES).toEqual(['src/services', 'src/api', 'src/ai', 'src/auth', 'src/database']);
    expect(lane.id).toBe('spanish-user-strings-services');
    expect(lane.informational).toBeUndefined();
    expect(lane.target).toBe(0);
    expect(lane.value).toBeGreaterThan(0);
    const perFile = lane.perFile ?? {};
    expect(Object.values(perFile).reduce((a, b) => a + b, 0)).toBe(lane.value);
    expect(Object.keys(perFile).every((file) => SERVICE_SURFACES.some((dir) => file.startsWith(`${dir}/`)))).toBe(true);
    expect(perFile[SAT_CATALOGUE]).toBeUndefined();
    expect(perFile[LAW_SEED]).toBeUndefined();
    expect(perFile[CFDI_CATALOGUES]).toBeUndefined();
    expect(lane.perEntryRule).toBe(SERVICE_STRINGS_PER_ENTRY_RULE);
  });

  it('counts with the shared recognizer, file by file', () => {
    const tally: Record<string, number> = {};
    for (const hit of userStringsUnder('src/auth')) tally[hit.file] = (tally[hit.file] ?? 0) + 1;
    const fromLane = Object.fromEntries(
      Object.entries(lane.perFile ?? {}).filter(([file]) => file.startsWith('src/auth/'))
    );
    expect(fromLane).toEqual(tally);
  });

  it('its command gives its value through a pipe, one line per string', () => {
    const listing = execSync(lane.command.replace(/\s*\|\s*wc -l$/, ''), {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    });
    const rows = listing.split('\n').filter((row) => row !== '');
    expect(rows).toHaveLength(lane.value);
    expect(rows.every((row) => /^src\/(services|api|ai|auth|database)\/\S+:\d+\t"/.test(row))).toBe(true);
    expect(Number(execSync(lane.command, { cwd: ROOT, encoding: 'utf8' }).trim())).toBe(lane.value);
  }, 120_000);

  it('the ratchet reports a file that grew over its floor and a new file born with Spanish', () => {
    const perFile = { ...(lane.perFile ?? {}) };
    const [grown] = Object.keys(perFile);
    const floors = { ...perFile, [grown]: perFile[grown] - 1 };
    const findings = compare([lane], {
      _: '',
      _por_que: '',
      seeded: '',
      lanes: { [lane.id]: lane.value },
      // A file translated since keeps its floor, so the summed ceiling (MNE-001-818) holds the total.
      perFile: { [lane.id]: { ...floors, 'translated-since.ts': 1 } },
    });
    expect(findings.map((finding) => finding.detail)).toEqual([
      `${grown}: creció ${perFile[grown] - 1} → ${perFile[grown]}; ${SERVICE_STRINGS_PER_ENTRY_RULE}`,
    ]);

    const { [grown]: _dropped, ...withoutEntry } = perFile;
    const born = compare([lane], {
      _: '',
      _por_que: '',
      seeded: '',
      lanes: { [lane.id]: lane.value },
      perFile: { [lane.id]: { ...withoutEntry, 'translated-since.ts': perFile[grown] } },
    });
    expect(born.map((finding) => finding.detail)).toEqual([
      `${grown}: 0 → ${perFile[grown]} — sin entrada en la línea base; ${SERVICE_STRINGS_PER_ENTRY_RULE}`,
    ]);
  });
});
