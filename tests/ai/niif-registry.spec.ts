import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DOC_TOPICS } from '../../src/ai/tools/docs-tools.js';
import {
  freshnessProblem, monthsSince, parseFreshnessMaxMonths, readFreshnessMaxMonths, regenerateIndice,
} from '../../scripts/build-niif-indice.js';

// __dirname instead of import.meta.url: the test project compiles as CommonJS,
// where import.meta is a syntax error. Same directory either way, and it is what
// src/ai/tools/docs-tools.ts already uses to find this very folder.
const DOCS = path.join(__dirname, '..', '..', 'src', 'ai', 'docs');

interface RegistryEntry {
  code: string;
  title_es: string;
  status: string;
  effective: string;
  topic: string;
  confidence: string;
  sources: string[];
  amendments?: string[];
}

const registry = JSON.parse(fs.readFileSync(path.join(DOCS, 'ifrs-registry.json'), 'utf-8')) as {
  verified_at: string;
  scope: string;
  standards: RegistryEntry[];
};

describe('ifrs-registry.json — la fuente de verdad del corpus NIIF', () => {
  it('has a parseable verification date and a declared scope', () => {
    expect(registry.verified_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number.isNaN(Date.parse(registry.verified_at))).toBe(false);
    expect(registry.scope).toContain('ISSB');
  });

  it('every entry is complete and points to a registered, existing doc topic', () => {
    expect(registry.standards.length).toBeGreaterThanOrEqual(70);
    for (const s of registry.standards) {
      expect(s.code, s.code).toBeTruthy();
      expect(['vigente', 'sustituida_pendiente', 'futura', 'derogada']).toContain(s.status);
      expect(s.effective, s.code).toBeTruthy();
      expect(Object.keys(DOC_TOPICS), `${s.code} → topic ${s.topic}`).toContain(s.topic);
      expect(fs.existsSync(path.join(DOCS, `${s.topic}.md`)), `${s.topic}.md`).toBe(true);
      expect(s.sources.length, `${s.code} sin fuentes`).toBeGreaterThan(0);
    }
  });

  it('covers the corpus backbone (spot checks)', () => {
    const codes = registry.standards.map((s) => s.code);
    for (const must of [
      'NIIF 9 / IFRS 9', 'NIIF 15 / IFRS 15', 'NIIF 16 / IFRS 16', 'NIIF 18 / IFRS 18',
      'NIIF 20 / IFRS 20', 'NIC 12 / IAS 12', 'NIC 21 / IAS 21', 'CINIIF 23 / IFRIC 23',
      'NIIF para las PyMEs (3a ed.)',
    ]) {
      expect(codes, must).toContain(must);
    }
    // IAS 1 must carry its replacement marker (IFRS 18, 2027)
    const ias1 = registry.standards.find((s) => s.code === 'NIC 1 / IAS 1');
    expect(ias1?.status).toBe('sustituida_pendiente');
  });

  it('the 2026 agenda-decision updates are reflected on the affected cards, backed by official sources', () => {
    const card = (code: string) => registry.standards.find((s) => s.code === code);
    const official = (code: string) =>
      (card(code)?.sources ?? []).filter((u: string) => u.startsWith('https://www.ifrs.org/'));
    const affected = [
      'NIIF 18 / IFRS 18',
      'NIC 7 / IAS 7',
      'NIIF 9 / IFRS 9',
      'NIC 12 / IAS 12',
      'NIIF 20 / IFRS 20',
      'AD: Depósitos a la vista con restricciones de uso (IAS 7)',
    ];
    for (const code of affected) {
      expect(card(code), code).toBeDefined();
      expect(official(code).length, code).toBeGreaterThanOrEqual(1);
    }
    // NIIF 20 left its single weak listing source behind and is now high confidence.
    expect(card('NIIF 20 / IFRS 20')?.confidence).toBe('high');
    expect(card('NIIF 20 / IFRS 20')?.sources).not.toContain('https://www.ifrs.org/news-and-events/news/2026/05/');
    // The Vol. 14 compilation (May 2026) is cited by every card it touches.
    const vol14 = 'https://www.ifrs.org/news-and-events/news/2026/05/compilation-of-agenda-decisions-volume-14-published/';
    for (const code of ['NIIF 18 / IFRS 18', 'NIC 7 / IAS 7', 'NIIF 9 / IFRS 9', affected[5]!]) {
      expect(card(code)?.sources, code).toContain(vol14);
    }
    // The IFRS 18 / IAS 12 substitute-tax project is cited by both cards.
    const taxProject =
      'https://www.ifrs.org/projects/work-plan/presentation-taxes-other-changes-not-income-taxes-scope-ias-12-ifrs-18/';
    for (const code of ['NIIF 18 / IFRS 18', 'NIC 12 / IAS 12']) {
      expect(card(code)?.sources, code).toContain(taxProject);
    }
    // The new amendments entries are counted, not matched by prose.
    const amendmentCount = (code: string) => card(code)?.amendments?.length ?? 0;
    expect(amendmentCount('NIIF 18 / IFRS 18')).toBeGreaterThanOrEqual(5);
    expect(amendmentCount('NIC 7 / IAS 7')).toBeGreaterThanOrEqual(5);
    expect(amendmentCount('NIIF 9 / IFRS 9')).toBeGreaterThanOrEqual(6);
    expect(amendmentCount('NIC 12 / IAS 12')).toBeGreaterThanOrEqual(6);
    // The IAS 7 withdrawal of the reverse-factoring decision is sourced to the July 2026 IASB Update.
    expect(card('NIC 7 / IAS 7')?.sources).toContain(
      'https://www.ifrs.org/news-and-events/updates/iasb/2026/iasb-update-july-2026/',
    );
  });

  it('niif-indice.md is in sync with the registry (regenerating changes nothing)', () => {
    const { changed } = regenerateIndice();
    expect(changed, 'corre: npx tsx scripts/build-niif-indice.ts').toBe(false);
  });

  it('every niif-* doc topic registered in DOC_TOPICS has a file with real content', () => {
    const niifTopics = Object.keys(DOC_TOPICS).filter((t) => t.startsWith('niif-'));
    expect(niifTopics.length).toBe(10);
    for (const topic of niifTopics) {
      const file = path.join(DOCS, `${topic}.md`);
      expect(fs.existsSync(file), file).toBe(true);
      const content = fs.readFileSync(file, 'utf-8');
      expect(content.length, `${topic}.md muy corto`).toBeGreaterThan(1500);
      expect(content.startsWith('# NIIF'), `${topic}.md sin título NIIF`).toBe(true);
    }
  });
});

// An official page on every card (MNE-001-367, #133; acceptance amended by its
// /confirmar of 2026-11-15). What counts as official depends on the kind of card.
// The bare list-of-standards/ index counts for no card, and the cinif.org.mx
// homepage counts for no NIF card; nor do the ifrs.org homepage and the CINIF
// pages behind a sign-up screen. The cards' pages come from table §8.1 of
// docs/investigacion/2026-09-06-normas-y-motores/normas/ifrs-nif-delta.md, where
// each one answered HTTP 200 on 2026-09-06.
const IFRS_HOST = 'www.ifrs.org';
const STANDARDS_INDEX = '/issued-standards/list-of-standards/';
const SMES_PAGE = 'https://www.ifrs.org/issued-standards/ifrs-for-smes/';
const CINIF_HOSTS = ['www.cinif.org.mx', 'cinif.org.mx'];
/**
 * cinif.org.mx paths that hold no document: the homepage under both of its
 * paths, and the two pages that answer HTTP 200 with a sign-up screen (report §1
 * and §8.2), so a reader without an account sees no standard there.
 */
const CINIF_NOT_DOCUMENTS = ['/', '/index.php', '/normatividad_listadonormas.php', '/normatividad_plandetrabajo.php'];

interface OfficialRule {
  /** What the card is missing, as the failure names it. */
  readonly needs: string;
  readonly accepts: (url: string) => boolean;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * The card's own page under list-of-standards/. `slugStart` is `ias-10-` for a
 * numbered standard, whose slug goes on with at least one word of its title, or
 * `conceptual-framework/` for a page with a fixed slug. A slug is lowercase words
 * joined by single hyphens, so neither the bare index nor the bare prefix
 * (`ias-10-/`) matches.
 */
function ownStandardPage(slugStart: string): OfficialRule {
  const base = `https://${IFRS_HOST}${STANDARDS_INDEX}`;
  return {
    needs: slugStart.endsWith('/') ? base + slugStart : `${base}${slugStart}…/`,
    accepts: (url) => {
      const u = parseUrl(url);
      if (u?.protocol !== 'https:' || u.hostname !== IFRS_HOST) return false;
      if (!u.pathname.startsWith(STANDARDS_INDEX)) return false;
      const slug = u.pathname.slice(STANDARDS_INDEX.length);
      return /^[a-z0-9]+(?:-[a-z0-9]+)*\/$/.test(slug) && slug.startsWith(slugStart);
    },
  };
}

const SMES_RULE: OfficialRule = { needs: SMES_PAGE, accepts: (url) => url === SMES_PAGE };

const IFRS_SOURCE: OfficialRule = {
  needs: 'a source on www.ifrs.org other than its homepage or the bare list-of-standards/ index',
  accepts: (url) => {
    const u = parseUrl(url);
    if (u?.protocol !== 'https:' || u.hostname !== IFRS_HOST) return false;
    const pathname = `${u.pathname.replace(/\/+$/, '')}/`;
    return pathname !== '/' && pathname !== STANDARDS_INDEX;
  },
};

const CINIF_DOCUMENT: OfficialRule = {
  needs: 'a document on www.cinif.org.mx, not its homepage nor a page behind its sign-up screen',
  accepts: (url) => {
    const u = parseUrl(url);
    if (u?.protocol !== 'https:' || !CINIF_HOSTS.includes(u.hostname)) return false;
    const pathname = u.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    return !CINIF_NOT_DOCUMENTS.includes(pathname);
  },
};

/** Cards whose page has a fixed slug instead of one derived from a number. */
const FIXED_SLUGS: Record<string, string> = {
  'Marco Conceptual / Conceptual Framework': 'conceptual-framework/',
  'IFRS Practice Statement 1': 'management-commentary-practice-statement/',
  'IFRS Practice Statement 2': 'materiality-practice-statement/',
  // NOTE: MAPA is a NIF-IFRS map, not a standard. It is held to the IFRS 18 page
  // it cites, by the ifrs.org rule and not the NIF one, because its only CINIF
  // source is the homepage and its rewrite belongs to another task.
  'MAPA NIF-IFRS': 'ifrs-18-',
};

/** The rule for a card, by what its code says it is; undefined for an unknown kind. */
function officialRule(code: string): OfficialRule | undefined {
  const numbered = /^(?:NIC|NIIF|CINIIF|SIC) \d+ \/ (IAS|IFRS|IFRIC|SIC)[ -](\d+)$/.exec(code);
  if (numbered) return ownStandardPage(`${numbered[1]!.toLowerCase()}-${numbered[2]!}-`);
  const fixedSlug = FIXED_SLUGS[code];
  if (fixedSlug) return ownStandardPage(fixedSlug);
  if (code.startsWith('NIIF para las PyMEs')) return SMES_RULE;
  if (code.startsWith('AD: ')) return IFRS_SOURCE;
  if (/^(?:NIF [A-E]-\d+|ONIF \d+|SUPLETORIEDAD)$/.test(code)) return CINIF_DOCUMENT;
  return undefined;
}

/**
 * Cards that cannot meet the rule of their kind today, each with its reason
 * (#133, answer 3 of 2026-11-15). An exemption that stops being needed fails
 * the test below, so it gets removed instead of hiding a card.
 */
const EXEMPT: Record<string, string> = {
  'NIIF 20 / IFRS 20':
    'ifrs.org has no list-of-standards page for it (the report records 404s); its four sources are ifrs.org pages',
  'ONIF 7': "its text is only in CINIF's paid section, so there is no open cinif.org.mx document to cite",
  SUPLETORIEDAD:
    "its only cinif.org.mx source is the homepage (its other four are secondary) and the standard sits in CINIF's paid book",
};

describe('an official page on every card (MNE-001-367)', () => {
  it('every card cites the official page its kind calls for', () => {
    const missing: string[] = [];
    for (const s of registry.standards) {
      if (s.code in EXEMPT) continue;
      const rule = officialRule(s.code);
      if (!rule) missing.push(`${s.code}: no rule for this kind of card`);
      else if (!s.sources.some(rule.accepts)) missing.push(`${s.code}: needs ${rule.needs}`);
    }
    expect(missing, `${missing.length} cards without their official page`).toEqual([]);
  });

  it('the bare list-of-standards index, both homepages and the CINIF pages behind sign-up count for no card', () => {
    const notOfficial = [
      'https://www.ifrs.org/issued-standards/list-of-standards/',
      'https://www.ifrs.org/issued-standards/list-of-standards',
      'https://www.ifrs.org/',
      'https://www.ifrs.org',
      'https://www.cinif.org.mx/',
      'https://www.cinif.org.mx',
      'https://www.cinif.org.mx/index.php',
      'https://www.cinif.org.mx/normatividad_listadonormas.php',
      'https://www.cinif.org.mx/normatividad_plandetrabajo.php',
    ];
    for (const s of registry.standards) {
      const rule = officialRule(s.code);
      expect(rule, s.code).toBeDefined();
      for (const url of notOfficial) expect(rule?.accepts(url), `${s.code} ← ${url}`).toBe(false);
    }
  });

  it("a standard's page has words after its number, and the number is the card's own", () => {
    // Not in the list above: the AD rule takes any other ifrs.org page, these included.
    const page = (slug: string) => `https://${IFRS_HOST}${STANDARDS_INDEX}${slug}/`;
    const accepts = (code: string, slug: string) => officialRule(code)?.accepts(page(slug));
    expect(accepts('NIC 10 / IAS 10', 'ias-10-events-after-the-reporting-period')).toBe(true);
    expect(accepts('NIC 10 / IAS 10', 'ias-10-'), 'the bare prefix').toBe(false);
    expect(accepts('NIC 10 / IAS 10', 'ias-10'), 'no title').toBe(false);
    expect(accepts('NIC 1 / IAS 1', 'ias-10-events-after-the-reporting-period'), "IAS 10's page").toBe(false);
    expect(accepts('MAPA NIF-IFRS', 'ifrs-18-'), 'the bare prefix').toBe(false);
  });

  it('each exemption names a real card that still lacks its official page', () => {
    for (const [code, reason] of Object.entries(EXEMPT)) {
      const card = registry.standards.find((s) => s.code === code);
      expect(card, `${code} is not in the registry`).toBeDefined();
      expect(reason.length, code).toBeGreaterThan(30);
      const rule = officialRule(code);
      expect(rule, code).toBeDefined();
      const hasPage = card?.sources.some((url) => rule?.accepts(url) ?? false);
      expect(hasPage, `${code} has its page now: drop the exemption`).toBe(false);
    }
  });
});

describe('freshness of the normative corpus (docs/PROCESS.md)', () => {
  it('PROCESS.md declares N as a positive whole number of months', () => {
    // Throws when the line is missing or malformed: there is no default N.
    const maxMonths = readFreshnessMaxMonths();
    expect(Number.isInteger(maxMonths) && maxMonths > 0).toBe(true);
  });

  it('reads N from exactly one FRESHNESS_MAX_MONTHS line, and anything else is an error', () => {
    expect(parseFreshnessMaxMonths('## Frescura\n\nFRESHNESS_MAX_MONTHS: 6\n')).toBe(6);
    expect(parseFreshnessMaxMonths('FRESHNESS_MAX_MONTHS:12')).toBe(12);
    const invalid = ['', '- **Plazo máximo (N): 6 meses.**', 'see `FRESHNESS_MAX_MONTHS: 6`', 'FRESHNESS_MAX_MONTHS: 0',
      'FRESHNESS_MAX_MONTHS: -6', 'FRESHNESS_MAX_MONTHS: 6.5', 'FRESHNESS_MAX_MONTHS: 6\nFRESHNESS_MAX_MONTHS: 12'];
    for (const text of invalid) expect(() => parseFreshnessMaxMonths(text), JSON.stringify(text)).toThrow(/FRESHNESS_MAX_MONTHS/);
  });

  it('counts whole months from verified_at', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    expect(monthsSince('2026-09-30', now)).toBe(0);
    expect(monthsSince('2026-03-30', now)).toBe(6);
    expect(monthsSince('2026-03-31', now)).toBe(5);
    expect(monthsSince('2025-09-30', now)).toBe(12);
  });

  it('the guard fails at N+1 months, passes at N, and rejects a future or malformed date', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    expect(freshnessProblem('2026-03-30', now, 6)).toBeNull(); // exactly N
    expect(freshnessProblem('2026-02-28', now, 6)).toMatch(/7 months old; max 6/); // N+1
    expect(freshnessProblem('2026-10-01', now, 6)).toMatch(/future/);
    expect(freshnessProblem('2026-9-1', now, 6)).toMatch(/not a YYYY-MM-DD/);
    expect(freshnessProblem('2026-13-45', now, 6)).toMatch(/not a YYYY-MM-DD/);
  });

  // Goes red on its own: for verified_at 2026-09-06 and N = 6 on 2027-04-06 (UTC),
  // the date scripts/corpus-renewal.ts prints (on 2027-03-06, exactly six months
  // old, it still passes). Renew as docs/RUNBOOK.md says, then bump the date.
  it('verified_at is no older than N months (renew the corpus, then bump the date)', () => {
    expect(freshnessProblem(registry.verified_at, new Date(), readFreshnessMaxMonths())).toBeNull();
  });

  it('indexes the new NIF A-2 and ONIF 7 (MNE-001-078)', () => {
    const indexDoc = fs.readFileSync(path.join(DOCS, 'niif-indice.md'), 'utf-8');
    for (const code of ['NIF A-2', 'ONIF 7']) {
      expect(registry.standards.map((s) => s.code), code).toContain(code);
      expect(indexDoc, code).toContain(`| ${code} |`);
    }
    const frameworkDoc = fs.readFileSync(path.join(DOCS, 'nif-marco.md'), 'utf-8');
    expect(frameworkDoc).toContain('Incertidumbres sobre negocio en marcha');
  });
});
