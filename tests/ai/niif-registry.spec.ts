import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DOC_TOPICS } from '../../src/ai/tools/docs-tools.js';
import { regenerateIndice } from '../../scripts/build-niif-indice.js';

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
