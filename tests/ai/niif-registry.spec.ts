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

  it('the 2026 agenda-decision updates are reflected on the five affected cards', () => {
    const card = (code: string) => registry.standards.find((s) => s.code === code);
    const text = (code: string) => JSON.stringify(card(code));
    // NIIF 20 was issued 27-may-2026 with a single weak source (the monthly news listing).
    const ifrs20 = card('NIIF 20 / IFRS 20');
    expect(ifrs20?.confidence).toBe('high');
    expect(ifrs20?.sources).toContain('https://www.ifrs.org/news-and-events/news/2026/05/iasb-issues-ifrs-20/');
    expect(ifrs20?.sources).toContain('https://www.ifrs.org/projects/completed-projects/2026/rate-regulated-activities/');
    expect(ifrs20?.sources).not.toContain('https://www.ifrs.org/news-and-events/news/2026/05/');
    // The Vol. 14 compilation (May 2026) is cited by every card it touches.
    const vol14 = 'https://www.ifrs.org/news-and-events/news/2026/05/compilation-of-agenda-decisions-volume-14-published/';
    for (const code of ['NIIF 18 / IFRS 18', 'NIC 7 / IAS 7', 'NIIF 9 / IFRS 9']) {
      expect(card(code)?.sources, code).toContain(vol14);
    }
    // IAS 7: the reverse-factoring agenda decision was withdrawn in July 2026.
    expect(text('NIC 7 / IAS 7')).toContain('21-jul-2026');
    // IFRS 18 / IAS 12 narrow-scope project on substitute taxes (ED expected Q4 2026).
    for (const code of ['NIIF 18 / IFRS 18', 'NIC 12 / IAS 12']) {
      expect(text(code), code).toContain('Presentation of Taxes or Other Charges');
    }
    expect(text('NIIF 18 / IFRS 18')).toContain('26-jun-2026');
    expect(text('NIIF 9 / IFRS 9')).toContain('Embedded Prepayment Option');
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
