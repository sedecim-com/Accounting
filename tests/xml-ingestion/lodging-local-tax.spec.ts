import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../src/database/connection.js', () => ({ query: vi.fn() }));

import { CFDIParser } from '../../src/services/xml-ingestion/cfdi-parser.js';
import { classifyXml } from '../../src/services/xml-ingestion/cfdi-classifier.js';
import { ROLE_MAP } from '../../src/services/xml-ingestion/account-roles-seed.js';

// ============================================================
// MNE-001-033 · #102 — A HOTEL CFDI REACHES THE LEDGER.
//
// A lodging CFDI carries the state lodging tax (ISH) in the ImpuestosLocales
// complement, not in the Impuestos node: 1 000 + 160 IVA + 30 ISH = 1 190.
// The parser never read that complement, so the upload was refused as
// «Total calculation mismatch» and the classifier blocked it as unbalanced;
// and an ISSUED lodging CFDI had no line for the local tax it transfers.
// The figures below are the fixture's, written by hand.
// ============================================================

const XML = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'cfdi', 'hospedaje-ish-4001.xml'), 'utf-8');
const GUEST_RFC = 'XAXX010101000';
const HOTEL_RFC = 'HOS060101AB1';

/** The chart the seed gives a Mexican entity, as the classifier reads it. */
const SEEDED = new Map(Object.entries(ROLE_MAP).map(([role, code]) => [role, { code, name: `Account ${code}` }]));

const classify = (entityRfc: string, roleMap = SEEDED) =>
  classifyXml(XML, {
    entityId: 'e1', entityRfc, roleMap, satStatus: 'vigente', vendorExists: true, periodOpen: true,
  });

const entry = (c: Awaited<ReturnType<typeof classify>>) =>
  c.lines.map((l) => ({ role: l.role, code: l.accountCode, debit: l.debit, credit: l.credit }));

describe('the ImpuestosLocales complement', () => {
  it('is read by the parser, so the lodging CFDI passes the upload validation', () => {
    const parser = new CFDIParser();
    const parsed = parser.parse(XML);
    expect(parsed.complementos.find((c) => c.type === 'ImpuestosLocales')?.data).toEqual({
      TotaldeTraslados: 30,
      TotaldeRetenciones: 0,
    });
    expect(parser.validate(parsed)).toEqual({ valid: true, errors: [] });
  });

  it('a local withholding lowers the total the upload expects', () => {
    const parser = new CFDIParser();
    const withheld = XML.replace('Total="1190.00"', 'Total="1150.00"')
      .replace('TotaldeRetenciones="0.00"', 'TotaldeRetenciones="40.00"');
    expect(parser.validate(parser.parse(withheld))).toEqual({ valid: true, errors: [] });
  });
});

describe('a RECEIVED lodging CFDI', () => {
  it('is not blocked and posts the ISH on its own line, under its own role', async () => {
    const c = await classify(GUEST_RFC);
    expect(c.verdict).toBe('ready');
    expect(entry(c)).toEqual([
      { role: 'gasto', code: ROLE_MAP.gasto, debit: 1000, credit: null },
      { role: 'impuestos_locales_gasto', code: ROLE_MAP.impuestos_locales_gasto, debit: 30, credit: null },
      { role: 'iva_acreditable', code: '1130', debit: 160, credit: null },
      { role: 'cxp', code: '2110', debit: null, credit: 1190 },
    ]);
  });

  it('the ISH follows whatever account the entity maps to the local-tax role', async () => {
    const own = new Map(SEEDED).set('impuestos_locales_gasto', { code: '6155', name: 'ISH' });
    const c = await classify(GUEST_RFC, own);
    expect(c.lines.find((l) => l.role === 'impuestos_locales_gasto')).toMatchObject({ accountCode: '6155', debit: 30 });
    expect(c.lines.find((l) => l.role === 'gasto')).toMatchObject({ accountCode: ROLE_MAP.gasto, debit: 1000 });
  });
});

describe('an ISSUED lodging CFDI', () => {
  it('PUE: the local tax it transfers lands on 2190 «Impuestos Locales por Pagar»', async () => {
    const c = await classify(HOTEL_RFC);
    expect(c.verdict).toBe('ready');
    expect(entry(c)).toEqual([
      { role: 'cxc', code: '1120', debit: 1190, credit: null },
      { role: 'ingreso', code: ROLE_MAP.ingreso, debit: null, credit: 1000 },
      { role: 'iva_trasladado', code: '2120', debit: null, credit: 160 },
      { role: 'impuestos_locales_por_pagar', code: '2190', debit: null, credit: 30 },
    ]);
  });

  it('PPD: the same, with the IVA left uncollected', async () => {
    const c = await classifyXml(XML.replace('MetodoPago="PUE"', 'MetodoPago="PPD"'), {
      entityId: 'e1', entityRfc: HOTEL_RFC, roleMap: SEEDED, satStatus: 'vigente', vendorExists: true, periodOpen: true,
    });
    expect(c.verdict).toBe('ready');
    expect(c.lines.find((l) => l.role === 'impuestos_locales_por_pagar')).toMatchObject({ accountCode: '2190', credit: 30 });
    expect(c.lines.find((l) => l.role === 'iva_trasladado_no_cobrado')).toMatchObject({ credit: 160 });
  });
});
