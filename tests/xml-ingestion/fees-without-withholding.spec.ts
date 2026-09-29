import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn() }));

import { classifyXml } from '../../src/services/xml-ingestion/cfdi-classifier.js';
import { DEFAULT_THRESHOLDS } from '../../src/services/xml-ingestion/cfdi-decisions.js';
import { ROLE_MAP } from '../../src/services/xml-ingestion/account-roles-seed.js';
import { WITHHOLDING_KEYS, type LegalParameterReader } from '../../src/services/xml-ingestion/withholding-law.js';

// ============================================================
// MNE-001-148 · #309: an individual (regime 612) bills a legal entity for
// professional services and declares no ISR withheld. The firm's
// `fees_without_withholding` policy decides: hold it and ask for a substitute
// CFDI (default), compute the law's withholding and hold the entry, or record
// it as issued with a warning. A purchase of goods from a 612 issuer is never
// taken for fees. The law is injected; the integration spec reads Postgres.
// ============================================================

const FEES = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'honorarios-pf-612.xml'), 'utf-8');
/** The same legal-services CFDI, with no withholding declared and its total adjusted. */
const SILENT = FEES.replace(/<cfdi:Retenciones>[\s\S]*?<\/cfdi:Retenciones>/g, '')
  .replace(' TotalImpuestosRetenidos="2066.67"', '')
  .replace('Total="9533.33"', 'Total="11600.00"');
const CONCEPT = /<cfdi:Concepto [\s\S]*?<\/cfdi:Concepto>/.exec(SILENT)![0];
const withKey = (key: string, xml = SILENT) => xml.replace('ClaveProdServ="80121600"', `ClaveProdServ="${key}"`);
/** Two concepts of 5 000: the legal service and a good. */
const half = (key: string) =>
  withKey(key, CONCEPT).replaceAll('10000.00', '5000.00').replaceAll('1600.00', '800.00');
const MIXED = SILENT.replace(CONCEPT, half('80121600') + half('44121600'));

const LAW: Record<string, string> = {
  [WITHHOLDING_KEYS.professionalFeesIsr]: '0.1000',
  [WITHHOLDING_KEYS.leaseIsr]: '0.1000',
  [WITHHOLDING_KEYS.vatThirds]: '2.0000',
};
function reader(calls: string[]): LegalParameterReader {
  return async (key) => {
    calls.push(key);
    return {
      jurisdiction: 'MX', key, value: LAW[key], unit: 'rate', effectiveFrom: '2014-01-01',
      sourceUrl: 'https://example.test/law', sourceNote: null,
    };
  };
}

const SEEDED = new Map(Object.entries(ROLE_MAP).map(([role, code]) => [role, { code, name: code }]));
async function classify(xml: string, policy?: string, calls: string[] = []) {
  return classifyXml(xml, {
    entityId: 'e1', entityRfc: 'EMP010101AB1', roleMap: SEEDED, satStatus: 'vigente', vendorExists: true,
    periodOpen: true, readLegalParameter: reader(calls),
    thresholds: policy === undefined ? undefined : { ...DEFAULT_THRESHOLDS, unwithheldFees: policy },
  });
}
const withheld = (c: Awaited<ReturnType<typeof classify>>) =>
  c.lines.filter((l) => l.role.endsWith('_retenido_por_pagar')).map((l) => [l.accountCode, l.credit]);

describe('professional fees from regime 612 that declare no ISR withheld', () => {
  it('DEFAULT: held with a finding that asks the vendor for a substitute CFDI, and nothing proposed', async () => {
    const calls: string[] = [];
    const c = await classify(SILENT, undefined, calls);
    expect(c.verdict).toBe('needs_input');
    expect(c.reason).toMatch(/substitute CFDI/);
    expect(c.reason).toMatch(/GOMJ800101HA5/);
    expect(c.lines).toEqual([]);
    expect(calls).toEqual([]);
    expect(c.facts.feesWithoutWithholding).toBe('request_substitute_cfdi');
  });

  it('an answer the panel does not know holds it the same way: an odd value never posts', async () => {
    const c = await classify(SILENT, 'post_it_anyway');
    expect(c.verdict).toBe('needs_input');
    expect(c.lines).toEqual([]);
    expect(c.facts.feesWithoutWithholding).toBe('request_substitute_cfdi');
  });

  it("withhold_by_law: the fees rate is read, the law's withholding is proposed and the entry is held", async () => {
    const calls: string[] = [];
    const c = await classify(SILENT, 'withhold_by_law', calls);
    expect(calls).toEqual([WITHHOLDING_KEYS.professionalFeesIsr, WITHHOLDING_KEYS.vatThirds]);
    expect(withheld(c)).toEqual([['2141', 1000], ['2142', 1066.67]]);
    expect(c.verdict).toBe('needs_input');
    expect(c.reason).toMatch(/held for review/);
    expect(c.reason).toMatch(/ISR 1000\.00 and VAT 1066\.67/);
    expect(c.facts.feesWithoutWithholding).toBe('withhold_by_law');
  });

  it('record_as_issued: it posts as declared, with the LISR 27-V warning and the mark the close reads', async () => {
    const calls: string[] = [];
    const c = await classify(SILENT, 'record_as_issued', calls);
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([]);
    expect(calls).toEqual([]);
    expect(c.warnings.join('\n')).toMatch(/LISR 27-V/);
    expect(c.facts.feesWithoutWithholding).toBe('record_as_issued');
  });
});

describe('what is NOT taken for professional fees', () => {
  it('a purchase of goods from a 612 issuer is not flagged under the default', async () => {
    const c = await classify(withKey('44121600'), undefined);
    expect(c.verdict, c.reason).toBe('ready');
    expect(c.facts.feesWithoutWithholding).toBeUndefined();
  });

  it('a CFDI mixing a service and a good is not flagged: every concept must be a professional service', async () => {
    const c = await classify(MIXED, undefined);
    expect(c.verdict, c.reason).toBe('ready');
    expect(c.facts.feesWithoutWithholding).toBeUndefined();
  });

  it('an advance (84111506) is not flagged, although its family is accounting services', async () => {
    const c = await classify(withKey('84111506'), undefined);
    expect(c.facts.feesWithoutWithholding).toBeUndefined();
  });

  it('fees that DO declare the ISR withheld keep the behaviour of MNE-001-056 under the default', async () => {
    const c = await classify(FEES, undefined);
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([['2141', 1000], ['2142', 1066.67]]);
    expect(c.facts.feesWithoutWithholding).toBeUndefined();
  });
});
