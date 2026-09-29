import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn() }));

import { classifyXml } from '../../src/services/xml-ingestion/cfdi-classifier.js';
import { ROLE_MAP } from '../../src/services/xml-ingestion/account-roles-seed.js';
import type { LegalParameterInForce } from '../../src/services/jurisdiction/legal-parameters.js';
import { WITHHOLDING_KEYS, type LegalParameterReader } from '../../src/services/xml-ingestion/withholding-law.js';

// ============================================================
// MNE-001-056 · #309: a legal entity withholds 10 % ISR and two thirds of the
// VAT from an individual's fees or lease, with the rates of legal_parameters.
// The law is injected here; the integration spec reads migration 129.
// ============================================================

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', name), 'utf-8');
const FEES = fixture('honorarios-pf-612.xml');
const LEASE = fixture('arrendamiento-pf-606.xml');
const ENTITY_RFC = 'EMP010101AB1';

const LAW: Record<string, string> = {
  [WITHHOLDING_KEYS.professionalFeesIsr]: '0.1000',
  [WITHHOLDING_KEYS.leaseIsr]: '0.1000',
  [WITHHOLDING_KEYS.vatThirds]: '2.0000',
};

function readerOf(law: Record<string, string>, calls: string[] = []): LegalParameterReader {
  return async (key, onDate) => {
    calls.push(`${key}@${onDate}`);
    return {
      jurisdiction: 'MX', key, value: law[key], unit: 'rate', effectiveFrom: '2014-01-01',
      sourceUrl: 'https://example.test/law', sourceNote: null,
    } satisfies LegalParameterInForce;
  };
}

const SEEDED = new Map(Object.entries(ROLE_MAP).map(([role, code]) => [role, { code, name: code }]));
const classify = (xml: string, read: LegalParameterReader, entityRfc = ENTITY_RFC) =>
  classifyXml(xml, {
    entityId: 'e1', entityRfc, roleMap: SEEDED, satStatus: 'vigente', vendorExists: true,
    periodOpen: true, readLegalParameter: read,
  });
const withheld = (c: Awaited<ReturnType<typeof classify>>) =>
  c.lines.filter((l) => l.role.endsWith('_retenido_por_pagar')).map((l) => [l.accountCode, l.credit]);

describe('withholdings on fees and leases, by law', () => {
  it('a lease: 10 % ISR and two thirds of the VAT, each on its own new role account', async () => {
    const calls: string[] = [];
    const c = await classify(LEASE, readerOf(LAW, calls));
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([['2141', 800], ['2142', 853.33]]);
    // The lease rate, not the fees one, read on the CFDI date.
    expect(calls).toEqual([
      `${WITHHOLDING_KEYS.leaseIsr}@2026-08-01`,
      `${WITHHOLDING_KEYS.vatThirds}@2026-08-01`,
    ]);
  });

  it('professional fees: the same figures of the law on 10 000', async () => {
    const c = await classify(FEES, readerOf(LAW));
    expect(c.verdict).toBe('ready');
    expect(withheld(c)).toEqual([['2141', 1000], ['2142', 1066.67]]);
  });

  it('the amounts are the law\'s, not the CFDI\'s: another rate books another figure and holds the entry', async () => {
    const c = await classify(LEASE, readerOf({ ...LAW, [WITHHOLDING_KEYS.leaseIsr]: '0.2000' }));
    expect(withheld(c)).toEqual([['2141', 1600], ['2142', 853.33]]);
    expect(c.verdict).toBe('needs_input');
    expect(c.warnings.join('\n')).toMatch(/ISR 1600\.00 and VAT 853\.33, but the CFDI declares ISR 800\.00/);
  });

  it('without the law in force, nothing is booked: the reader fails closed', async () => {
    const missing: LegalParameterReader = async (key) => {
      throw new Error(`no ${key}`);
    };
    await expect(classify(LEASE, missing)).rejects.toThrow(/no income_tax\.withholding\.lease_rate/);
  });

  it('an individual receiver does not withhold: the law is not read and the CFDI is booked as declared', async () => {
    const calls: string[] = [];
    const xml = LEASE.replace(/EMP010101AB1/g, 'XAXX010101000');
    const c = await classify(xml, readerOf(LAW, calls), 'XAXX010101000');
    expect(calls).toEqual([]);
    expect(withheld(c)).toEqual([['2141', 800], ['2142', 853.33]]);
  });

  it('a 612 sale of goods declaring no ISR withholding is not fees: nothing withheld, and it posts', async () => {
    // MNE-001-148: the same CFDI for legal services is held (fees-without-withholding.spec.ts).
    const calls: string[] = [];
    const goods = FEES.replace(/<cfdi:Retenciones>[\s\S]*?<\/cfdi:Retenciones>/g, '')
      .replace(' TotalImpuestosRetenidos="2066.67"', '')
      .replace('Total="9533.33"', 'Total="11600.00"')
      .replace('ClaveProdServ="80121600"', 'ClaveProdServ="44121600"');
    const c = await classify(goods, readerOf(LAW, calls));
    expect(calls).toEqual([]);
    expect(withheld(c)).toEqual([]);
    expect(c.verdict, c.reason).toBe('ready');
  });
});
