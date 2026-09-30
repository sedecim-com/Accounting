import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DOC_TOPICS } from '../../src/ai/tools/docs-tools.js';
import { monthsSince, regenerateIndice } from '../../scripts/build-niif-indice.js';

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

describe('freshness of the normative corpus (docs/PROCESS.md)', () => {
  const processMd = fs.readFileSync(path.join(DOCS, '..', '..', '..', 'docs', 'PROCESS.md'), 'utf-8');
  const maxMonths = Number(/^FRESCURA_MESES:\s*(\d+)\s*$/m.exec(processMd)?.[1]);

  it('PROCESS.md declares N as a positive whole number of months', () => {
    expect(Number.isInteger(maxMonths) && maxMonths > 0).toBe(true);
  });

  it('counts whole months from verified_at', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    expect(monthsSince('2026-09-30', now)).toBe(0);
    expect(monthsSince('2026-03-30', now)).toBe(6);
    expect(monthsSince('2026-03-31', now)).toBe(5);
    expect(monthsSince('2025-09-30', now)).toBe(12);
  });

  it('verified_at is no older than N months (renew the corpus, then bump the date)', () => {
    const age = monthsSince(registry.verified_at, new Date());
    expect(
      age,
      `verified_at ${registry.verified_at} is ${age} months old; max ${maxMonths} (docs/PROCESS.md)`
    ).toBeLessThanOrEqual(maxMonths);
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
