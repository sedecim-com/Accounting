import { describe, expect, it, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import * as path from 'node:path';
import type { Lane } from '../../scripts/language/lane.js';
import { compare } from '../../scripts/language-status.js';
import { userStringsUnder } from '../../scripts/language/extract.js';
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
    expect(Object.keys(SERVICE_EXCLUDED)).toEqual([SAT_CATALOGUE]);
    expect(SERVICE_EXCLUDED[SAT_CATALOGUE]).toMatch(/SAT/);
    expect(userStringsUnder(SAT_CATALOGUE).length).toBeGreaterThan(0);
    expect(serviceUserStringsUnder(SAT_CATALOGUE)).toEqual([]);
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
      perFile: { [lane.id]: floors },
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
      perFile: { [lane.id]: withoutEntry },
    });
    expect(born.map((finding) => finding.detail)).toEqual([
      `${grown}: 0 → ${perFile[grown]} — sin entrada en la línea base; ${SERVICE_STRINGS_PER_ENTRY_RULE}`,
    ]);
  });
});
