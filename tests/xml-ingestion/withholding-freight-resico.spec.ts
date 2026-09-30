import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn() }));

import { classifyXml } from '../../src/services/xml-ingestion/cfdi-classifier.js';
import { ROLE_MAP } from '../../src/services/xml-ingestion/account-roles-seed.js';
import type { LegalParameterInForce } from '../../src/services/jurisdiction/legal-parameters.js';
import { WITHHOLDING_KEYS, type LegalParameterReader } from '../../src/services/xml-ingestion/withholding-law.js';

// ============================================================
// MNE-001-057 · #309: freight (4 % VAT) and RESICO (1.25 % ISR) are withheld
// by law, and a CFDI whose declared withholding differs from the law's is
// held with a question to the accountant, never corrected. The law is
// injected here; the integration spec reads migration 175.
// ============================================================

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', name), 'utf-8');
const FREIGHT = fixture('fletes-pm.xml');
const RESICO = fixture('resico-pf-626.xml');
const LEASE = fixture('arrendamiento-pf-606.xml');
const ENTITY_RFC = 'EMP010101AB1';

const LAW: Record<string, string> = {
  [WITHHOLDING_KEYS.professionalFeesIsr]: '0.1000',
  [WITHHOLDING_KEYS.leaseIsr]: '0.1000',
  [WITHHOLDING_KEYS.vatThirds]: '2.0000',
  [WITHHOLDING_KEYS.freightVat]: '0.0400',
  [WITHHOLDING_KEYS.resicoIsr]: '0.0125',
};

function readerOf(law: Record<string, string>, calls: string[] = []): LegalParameterReader {
  return async (key, onDate) => {
    calls.push(`${key}@${onDate}`);
    return {
      jurisdiction: 'MX', key, value: law[key], unit: 'rate', effectiveFrom: '2006-12-05',
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

/** Rewrites the declared VAT withheld of the freight fixture, keeping the CFDI balanced. */
function freightDeclaring(vat: string): string {
  const total = (11600 - Number(vat)).toFixed(2);
  return FREIGHT.replace(/Importe="400\.00"/g, `Importe="${vat}"`)
    .replace('TotalImpuestosRetenidos="400.00"', `TotalImpuestosRetenidos="${vat}"`)
    .replace('Total="11200.00"', `Total="${total}"`);
}

describe('withholdings on freight and RESICO, by law', () => {
  it('freight to a legal entity: 4 % of the consideration as VAT, whoever the carrier is, and no ISR', async () => {
    const calls: string[] = [];
    const c = await classify(FREIGHT, readerOf(LAW, calls));
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([['2142', 400]]);
    expect(calls).toEqual([`${WITHHOLDING_KEYS.freightVat}@2026-08-03`]);
  });

  it('an individual in RESICO: 1.25 % ISR and two thirds of the VAT on a professional service', async () => {
    const calls: string[] = [];
    const c = await classify(RESICO, readerOf(LAW, calls));
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([['2141', 125], ['2142', 1066.67]]);
    expect(calls).toEqual([
      `${WITHHOLDING_KEYS.resicoIsr}@2026-08-04`,
      `${WITHHOLDING_KEYS.vatThirds}@2026-08-04`,
    ]);
  });

  it('a RESICO sale of goods: 1.25 % ISR and no VAT withheld, and it posts', async () => {
    const goods = RESICO.replace(/\s*<cfdi:Retencion [^>]*Impuesto="002"[^>]*\/>/g, '')
      .replace('TotalImpuestosRetenidos="1191.67"', 'TotalImpuestosRetenidos="125.00"')
      .replace('Total="10408.33"', 'Total="11475.00"')
      .replace('ClaveProdServ="80101500"', 'ClaveProdServ="44121600"');
    const c = await classify(goods, readerOf(LAW));
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([['2141', 125]]);
  });

  it('a RESICO carrier: the freight VAT and the RESICO ISR together', async () => {
    const xml = freightDeclaring('400.00')
      .replace('Rfc="TCA010101AB2" Nombre="Transportes de Carga Sinteticos SA de CV" RegimenFiscal="601"',
        'Rfc="MOPL800101HB3" Nombre="Lucia Morales Pena" RegimenFiscal="626"')
      .replace('<cfdi:Retencion Base="10000.00" Impuesto="002"',
        '<cfdi:Retencion Base="10000.00" Impuesto="001" TipoFactor="Tasa" TasaOCuota="0.012500" Importe="125.00"/>\n' +
        '          <cfdi:Retencion Base="10000.00" Impuesto="002"')
      .replace('<cfdi:Retencion Impuesto="002"', '<cfdi:Retencion Impuesto="001" Importe="125.00"/><cfdi:Retencion Impuesto="002"')
      .replace('TotalImpuestosRetenidos="400.00"', 'TotalImpuestosRetenidos="525.00"')
      .replace('Total="11200.00"', 'Total="11075.00"');
    const c = await classify(xml, readerOf(LAW));
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([['2141', 125], ['2142', 400]]);
  });

  it('ACCEPTANCE: a CFDI withholding that differs from the computed one is flagged, held and asked, not corrected', async () => {
    // The carrier declares 6 % instead of the 4 % of RLIVA 3-II.
    const c = await classify(freightDeclaring('600.00'), readerOf(LAW));
    expect(c.verdict).toBe('needs_input');
    // The reason of the hold names both figures, not an entry that fails to balance.
    expect(c.reason).toMatch(/VAT 400\.00, but the CFDI declares ISR 0\.00 and VAT 600\.00/);
    expect(c.decisions.map((d) => [d.id, d.severity])).toEqual([['withholding_mismatch', 'blocking']]);
    expect(c.decisions[0].question).toMatch(/TCA010101AB2/);
    expect(c.decisions[0].context).toMatch(/vat\.withholding\.freight_rate = 0\.0400/);
    // The law's amount is what would be booked; the CFDI's 600 is never taken.
    expect(withheld(c)).toEqual([['2142', 400]]);
  });

  it('a RESICO CFDI declaring the 10 % of an ordinary individual is flagged the same way', async () => {
    const xml = RESICO.replace(/Importe="125\.00"/g, 'Importe="1000.00"')
      .replace('TotalImpuestosRetenidos="1191.67"', 'TotalImpuestosRetenidos="2066.67"')
      .replace('Total="10408.33"', 'Total="9533.33"');
    const c = await classify(xml, readerOf(LAW));
    expect(c.verdict).toBe('needs_input');
    expect(c.reason).toMatch(/ISR 125\.00 and VAT 1066\.67, but the CFDI declares ISR 1000\.00/);
    expect(c.decisions.map((d) => d.id)).toContain('withholding_mismatch');
  });

  it('a lease\'s discrepancy (MNE-001-056) is now said as the reason too, not as an unbalanced entry', async () => {
    const c = await classify(LEASE, readerOf({ ...LAW, [WITHHOLDING_KEYS.leaseIsr]: '0.2000' }));
    expect(c.verdict).toBe('needs_input');
    expect(c.reason).toMatch(/^Withholding by law on a lease CFDI: ISR 1600\.00/);
    expect(c.decisions.map((d) => d.id)).toEqual(['withholding_mismatch']);
  });

  it('within the rounding the CFDI\'s cents stand and nothing is asked', async () => {
    const c = await classify(freightDeclaring('400.01'), readerOf(LAW));
    expect(c.verdict, c.reason).toBe('ready');
    expect(c.decisions).toEqual([]);
    expect(withheld(c)).toEqual([['2142', 400.01]]);
  });

  it('freight to an individual is not withheld: the law is not read', async () => {
    const calls: string[] = [];
    const xml = FREIGHT.replace(/EMP010101AB1/g, 'XAXX010101000');
    await classify(xml, readerOf(LAW, calls), 'XAXX010101000');
    expect(calls).toEqual([]);
  });

  it('freight next to a good is not taken for freight: every concept must be land freight', async () => {
    const calls: string[] = [];
    const xml = FREIGHT.replace('ClaveProdServ="78101802"', 'ClaveProdServ="44121600"');
    await classify(xml, readerOf(LAW, calls));
    expect(calls).toEqual([]);
  });
});
