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
    // It can be answered: the options are the panel key's, the default holds.
    expect(c.decisions[0].options.map((o) => o.value))
      .toEqual(['request_substitute_cfdi', 'withhold_by_law', 'record_as_issued']);
    expect(c.decisions[0].default).toBe('request_substitute_cfdi');
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
    const xml = cfdiOf(CARRIER, [
      { code: '78101802', amount: 10000, vat: 16, vatWithheld: 400 },
      { code: '44121600', amount: 1000, vat: 16 },
    ]);
    const c = await classify(xml, readerOf(LAW, calls));
    expect(calls).toEqual([]);
    // Not the law's case: what the carrier declares is booked.
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([['2142', 400]]);
  });

  it('freight next to a service (loading) is not freight either: it posts as declared, even with nothing withheld', async () => {
    const calls: string[] = [];
    const c = await classify(cfdiOf(CARRIER, [
      { code: '78101802', amount: 10000, vat: 16 },
      { code: '78141500', amount: 500, vat: 16 },
    ]), readerOf(LAW, calls));
    expect(calls).toEqual([]);
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([]);
  });
});

// ── Review of PR #525 ────────────────────────────────────────

const CARRIER = { rfc: 'TCA010101AB2', regime: '601' };
const RESICO_PF = { rfc: 'MOPL800101HB3', regime: '626' };

interface ConceptSpec { code: string; amount: number; vat?: 16 | 8 | 0; isrWithheld?: number; vatWithheld?: number }

const money = (n: number) => n.toFixed(2);

function conceptXml(k: ConceptSpec): string {
  const transfer = k.vat === undefined
    ? ''
    : `<cfdi:Traslados><cfdi:Traslado Base="${money(k.amount)}" Impuesto="002" TipoFactor="Tasa" ` +
      `TasaOCuota="${(k.vat / 100).toFixed(6)}" Importe="${money((k.amount * k.vat) / 100)}"/></cfdi:Traslados>`;
  const rets =
    (k.isrWithheld ? `<cfdi:Retencion Base="${money(k.amount)}" Impuesto="001" TipoFactor="Tasa" TasaOCuota="0.012500" Importe="${money(k.isrWithheld)}"/>` : '') +
    (k.vatWithheld ? `<cfdi:Retencion Base="${money(k.amount)}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="0.040000" Importe="${money(k.vatWithheld)}"/>` : '');
  return `<cfdi:Concepto ClaveProdServ="${k.code}" ClaveUnidad="E48" Unidad="Servicio" Descripcion="x" Cantidad="1" ` +
    `ValorUnitario="${money(k.amount)}" Importe="${money(k.amount)}" ObjetoImp="${k.vat === undefined ? '01' : '02'}">` +
    `<cfdi:Impuestos>${transfer}${rets ? `<cfdi:Retenciones>${rets}</cfdi:Retenciones>` : ''}</cfdi:Impuestos></cfdi:Concepto>`;
}

/** A balanced CFDI received by ENTITY_RFC with the given concepts. */
function cfdiOf(issuer: { rfc: string; regime: string }, concepts: ConceptSpec[]): string {
  const sum = (f: (k: ConceptSpec) => number) => concepts.reduce((s, k) => s + f(k), 0);
  const subtotal = sum((k) => k.amount);
  const vat = sum((k) => (k.vat === undefined ? 0 : (k.amount * k.vat) / 100));
  const isr = sum((k) => k.isrWithheld ?? 0);
  const vatWithheld = sum((k) => k.vatWithheld ?? 0);
  const rates = [...new Set(concepts.map((k) => k.vat).filter((r): r is 16 | 8 | 0 => r !== undefined))];
  const globalTransfers = rates.map((r) => {
    const base = sum((k) => (k.vat === r ? k.amount : 0));
    return `<cfdi:Traslado Base="${money(base)}" Impuesto="002" TipoFactor="Tasa" TasaOCuota="${(r / 100).toFixed(6)}" Importe="${money((base * r) / 100)}"/>`;
  }).join('');
  const globalWithholdings =
    (isr ? `<cfdi:Retencion Impuesto="001" Importe="${money(isr)}"/>` : '') +
    (vatWithheld ? `<cfdi:Retencion Impuesto="002" Importe="${money(vatWithheld)}"/>` : '');
  return `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="4.0" Serie="T" Folio="1" Fecha="2026-08-05T10:00:00" FormaPago="03" MetodoPago="PUE" TipoDeComprobante="I" Moneda="MXN" SubTotal="${money(subtotal)}" Total="${money(subtotal + vat - isr - vatWithheld)}" LugarExpedicion="64000">
  <cfdi:Emisor Rfc="${issuer.rfc}" Nombre="Emisor Sintetico" RegimenFiscal="${issuer.regime}"/>
  <cfdi:Receptor Rfc="${ENTITY_RFC}" Nombre="Empresa Sintetica SA de CV" UsoCFDI="G03" DomicilioFiscalReceptor="06600" RegimenFiscalReceptor="601"/>
  <cfdi:Conceptos>${concepts.map(conceptXml).join('')}</cfdi:Conceptos>
  <cfdi:Impuestos${isr + vatWithheld ? ` TotalImpuestosRetenidos="${money(isr + vatWithheld)}"` : ''} TotalImpuestosTrasladados="${money(vat)}">${globalWithholdings ? `<cfdi:Retenciones>${globalWithholdings}</cfdi:Retenciones>` : ''}${globalTransfers ? `<cfdi:Traslados>${globalTransfers}</cfdi:Traslados>` : ''}</cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital Version="1.1" UUID="5C0E0A56-0001-4057-8057-000000000999" FechaTimbrado="2026-08-05T10:05:00" RfcProvCertif="SAT970701NN3" SelloCFD="s" NoCertificadoSAT="30001000000500000001" SelloSAT="s"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;
}

const answering = (xml: string, answer: string) =>
  classifyXml(xml, {
    entityId: 'e1', entityRfc: ENTITY_RFC, roleMap: SEEDED, satStatus: 'vigente', vendorExists: true,
    periodOpen: true, readLegalParameter: readerOf(LAW), answers: { withholding_mismatch: answer },
  });

describe('withholding_mismatch: the question has answers, and the panel gives them', () => {
  const sixPercent = () => freightDeclaring('600.00');

  it('request_substitute_cfdi holds the CFDI with nothing proposed and asks nothing more', async () => {
    const c = await answering(sixPercent(), 'request_substitute_cfdi');
    expect(c.verdict).toBe('needs_input');
    expect(c.reason).toMatch(/withholding_mismatch=request_substitute_cfdi: ask the vendor for a substitute CFDI/);
    expect(c.lines).toEqual([]);
    expect(c.decisions).toEqual([]);
  });

  it("withhold_by_law proposes the law's figure and holds it for review", async () => {
    const c = await answering(sixPercent(), 'withhold_by_law');
    expect(c.verdict).toBe('needs_input');
    expect(c.reason).toMatch(/^Held for review by policy withholding_mismatch=withhold_by_law/);
    expect(c.decisions).toEqual([]);
    expect(withheld(c)).toEqual([['2142', 400]]);
  });

  it('record_as_issued RELEASES the CFDI: it posts as declared, marked for the close, with the warning kept', async () => {
    const c = await answering(sixPercent(), 'record_as_issued');
    expect(c.verdict, c.reason).toBe('ready');
    expect(c.decisions).toEqual([]);
    expect(withheld(c)).toEqual([['2142', 600]]);
    expect(c.facts.withholdingMismatch).toBe('record_as_issued');
    expect(c.warnings.join('\n')).toMatch(/Recorded as declared by policy withholding_mismatch=record_as_issued.*CFF 26-I/);
  });

  it('an unknown answer is no answer: the CFDI stays held and the question is asked', async () => {
    const c = await answering(sixPercent(), 'anything');
    expect(c.verdict).toBe('needs_input');
    expect(c.decisions.map((d) => d.id)).toEqual(['withholding_mismatch']);
  });

  it('a RESICO consultant declaring no withholding follows the panel: held by default, released by record_as_issued', async () => {
    const xml = cfdiOf(RESICO_PF, [{ code: '80101500', amount: 10000, vat: 16 }]);
    const held = await classify(xml, readerOf(LAW));
    expect(held.verdict).toBe('needs_input');
    expect(held.decisions.map((d) => d.id)).toEqual(['withholding_mismatch']);
    const released = await answering(xml, 'record_as_issued');
    expect(released.verdict, released.reason).toBe('ready');
    expect(withheld(released)).toEqual([]);
  });

  it('a 612 fee with no ISR withheld keeps following fees_without_withholding, whatever withholding_mismatch says', async () => {
    const xml = cfdiOf({ rfc: 'MOPL800101HB3', regime: '612' }, [{ code: '80101500', amount: 10000, vat: 16 }]);
    const c = await answering(xml, 'record_as_issued');
    expect(c.verdict).toBe('needs_input');
    expect(c.reason).toMatch(/fees_without_withholding=request_substitute_cfdi/);
  });
});

describe('freight VAT is withheld only on the VAT the carrier transferred', () => {
  it('zero-rated international freight (LIVA 29-V) with no VAT and no withholding posts with none', async () => {
    const calls: string[] = [];
    const c = await classify(cfdiOf(CARRIER, [{ code: '78101806', amount: 10000, vat: 0 }]), readerOf(LAW, calls));
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('only the concepts that carry VAT are the base: a zero-rated leg next to a taxed one', async () => {
    const c = await classify(cfdiOf(CARRIER, [
      { code: '78101802', amount: 1000, vat: 16, vatWithheld: 40 },
      { code: '78101806', amount: 4000, vat: 0 },
    ]), readerOf(LAW));
    // 4 % of the whole consideration (200) would even exceed the 160 of VAT charged.
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([['2142', 40]]);
  });

  it('freight at the 8 % border rate is not computed: the declared figure stands and the classifier says why', async () => {
    const calls: string[] = [];
    const xml = cfdiOf(CARRIER, [{ code: '78101802', amount: 10000, vat: 8, vatWithheld: 400 }]);
    const c = await classify(xml, readerOf(LAW, calls));
    expect(calls).toEqual([]);
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([['2142', 400]]);
    expect(c.warnings.join('\n')).toMatch(/8 % border VAT rate: no legal_parameters row/);
  });
});

describe('RESICO: two thirds of the VAT come from the concepts, never from what the CFDI declares', () => {
  it('a RESICO sale of goods that declares 2/3 of the VAT withheld is a discrepancy, not the law', async () => {
    const xml = cfdiOf(RESICO_PF, [{ code: '44121600', amount: 10000, vat: 16, isrWithheld: 125, vatWithheld: 1066.67 }]);
    const c = await classify(xml, readerOf(LAW));
    expect(c.verdict).toBe('needs_input');
    expect(c.reason).toMatch(/ISR 125\.00 and VAT 0\.00, but the CFDI declares ISR 125\.00 and VAT 1066\.67/);
    expect(c.decisions.map((d) => d.id)).toEqual(['withholding_mismatch']);
  });
});

describe('by_concept layout: RESICO ISR withheld lands where the layout declares', () => {
  const byConceptMap = new Map([
    ...SEEDED,
    ['isr_retenido_por_pagar', { code: '2145', name: 'ISR Retenido por Servicios Profesionales' }],
    ['isr_retenido_por_pagar:lease', { code: '2144', name: 'ISR Retenido por Arrendamiento' }],
  ]);
  const byConcept = (xml: string) =>
    classifyXml(xml, {
      entityId: 'e1', entityRfc: ENTITY_RFC, roleMap: byConceptMap, satStatus: 'vigente', vendorExists: true,
      periodOpen: true, readLegalParameter: readerOf(LAW),
    });

  it('a RESICO real-estate lease is a lease: 2144 (216.03)', async () => {
    const xml = cfdiOf(RESICO_PF, [{ code: '80131502', amount: 10000, vat: 16, isrWithheld: 125, vatWithheld: 1066.67 }]);
    const c = await byConcept(xml);
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([['2144', 125], ['2142', 1066.67]]);
  });

  it('a RESICO sale of goods falls back to the default ISR mapping: 2145, as the layout text says', async () => {
    const c = await byConcept(cfdiOf(RESICO_PF, [{ code: '44121600', amount: 10000, vat: 16, isrWithheld: 125 }]));
    expect(c.verdict, c.reason).toBe('ready');
    expect(withheld(c)).toEqual([['2145', 125]]);
  });
});
