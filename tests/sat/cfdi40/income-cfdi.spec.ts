import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildIncomeCfdiXml,
  buildValidatedIncomeCfdi,
  validateUnsealedCfdi,
  type IncomeCfdiInput,
} from '../../../src/services/sat/cfdi40/income-cfdi.js';
import { cfdiTimestamp } from '../../../src/services/sat/cfdi40/income-cfdi-service.js';
import { ValidationError } from '../../../src/utils/errors.js';

const XSD_DIR = path.join(__dirname, '../../../src/services/sat/cfdi40/xsd');

function input(over: Partial<IncomeCfdiInput> = {}): IncomeCfdiInput {
  return {
    issuedAt: '2026-09-30T12:00:00',
    invoice: { invoiceNumber: 'INV-2026-0001', currencyCode: 'MXN', exchangeRate: '1', subtotal: '300.00', totalAmount: '316.00' },
    issuer: { rfc: 'EKU9003173C9', name: 'ESCUELA KEMPER URGATE', taxRegime: '601', postalCode: '06600' },
    receiver: { rfc: 'URE180429TM6', name: 'ACEROS & CIA "SUR"', taxRegime: '601', postalCode: '65000', cfdiUse: 'G03' },
    lines: [
      { lineNumber: 1, description: 'Consultoria', quantity: '1.0000', unitPrice: '100.0000', taxCode: 'IVA16', taxRate: '16.00', productCode: '84111506', unitCode: 'E48' },
      { lineNumber: 2, description: 'Libro', quantity: '2.0000', unitPrice: '100.0000', taxCode: 'exento', taxRate: null, productCode: '55101500', unitCode: 'H87' },
    ],
    ...over,
  };
}

describe('CFDI 4.0 ingreso builder (MNE-001-295)', () => {
  it('builds a document that validates against the official XSD', () => {
    const xml = buildValidatedIncomeCfdi(input());
    expect(xml).toContain('TipoDeComprobante="I"');
    expect(xml).toContain('<cfdi:Emisor Rfc="EKU9003173C9"');
    expect(xml).toContain('UsoCFDI="G03"');
    expect(xml).toContain('TotalImpuestosTrasladados="16.00"');
    expect(xml).toMatch(/TipoFactor="Exento"\s*\/>/);
  });

  it('escapes names structurally', () => {
    const xml = buildIncomeCfdiXml(input());
    expect(xml).toContain('Nombre="ACEROS &amp; CIA &quot;SUR&quot;"');
    expect(validateUnsealedCfdi(xml).valid).toBe(true);
  });

  it('leaves the seal attributes out: only the checked copy gets stand-ins', () => {
    const xml = buildIncomeCfdiXml(input());
    expect(xml).not.toMatch(/Sello=|NoCertificado=|Certificado=/);
  });

  it('omits Impuestos for lines not subject to the tax (ObjetoImp 01)', () => {
    const base = input();
    const xml = buildValidatedIncomeCfdi(
      input({
        invoice: { ...base.invoice, subtotal: '100.00', totalAmount: '100.00' },
        lines: [{ ...base.lines[0], taxCode: null, taxRate: null }],
      })
    );
    expect(xml).toContain('ObjetoImp="01"');
    expect(xml).not.toContain('cfdi:Impuestos');
  });

  it('keeps a 0 % rate as Tasa, distinct from not subject', () => {
    const base = input();
    const xml = buildValidatedIncomeCfdi(
      input({
        invoice: { ...base.invoice, subtotal: '100.00', totalAmount: '100.00' },
        lines: [{ ...base.lines[0], taxRate: '0.00' }],
      })
    );
    expect(xml).toContain('TasaOCuota="0.000000"');
    expect(xml).toContain('TotalImpuestosTrasladados="0.00"');
  });

  it('rounds half up per concept and groups the tax by rate', () => {
    const base = input();
    const xml = buildValidatedIncomeCfdi(
      input({
        invoice: { ...base.invoice, subtotal: '0.10', totalAmount: '0.12' },
        lines: [
          { ...base.lines[0], quantity: '1', unitPrice: '0.0500', taxRate: '16.00' },
          { ...base.lines[0], lineNumber: 2, quantity: '1', unitPrice: '0.0500', taxRate: '16.00' },
        ],
      })
    );
    // 0.05 * 16 % = 0.008 -> 0.01 per concept, 0.02 in total (the SAT sums concepts):
    // two concept-level Traslado nodes and one grouped at the Comprobante.
    expect((xml.match(/<cfdi:Traslado /g) ?? []).length).toBe(3);
    expect(xml).toContain('TotalImpuestosTrasladados="0.02"');
  });

  it('adds TipoCambio for a foreign currency and omits it for MXN', () => {
    const base = input();
    const usd = buildValidatedIncomeCfdi(
      input({ invoice: { ...base.invoice, currencyCode: 'USD', exchangeRate: '17.5000000000' } })
    );
    expect(usd).toContain('TipoCambio="17.5"');
    expect(buildIncomeCfdiXml(input())).not.toContain('TipoCambio');
  });

  it('fails closed and names every missing datum', () => {
    const base = input();
    let error: unknown;
    try {
      buildIncomeCfdiXml(
        input({
          issuer: { ...base.issuer, taxRegime: null, postalCode: null },
          receiver: { ...base.receiver, cfdiUse: ' ' },
          lines: [{ ...base.lines[0], productCode: null }],
        })
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ValidationError);
    const message = (error as ValidationError).message;
    for (const gap of ['issuer.tax_regime', 'issuer.tax_postal_code', 'receiver.uso_cfdi', 'line 1.cfdi_product_code']) {
      expect(message).toContain(gap);
    }
  });

  it('refuses a document whose Total differs from the invoice', () => {
    const base = input();
    expect(() => buildIncomeCfdiXml(input({ invoice: { ...base.invoice, totalAmount: '349.00' } }))).toThrow(
      /does not match the invoice/
    );
  });

  it('reports an XSD violation instead of passing it on', () => {
    const base = input();
    expect(() =>
      buildValidatedIncomeCfdi(input({ receiver: { ...base.receiver, cfdiUse: 'ZZZ' } }))
    ).toThrow(/does not validate against the SAT's XSD/);
  });

  it('formats the Fecha on Mexico City wall clock', () => {
    expect(cfdiTimestamp(new Date('2026-09-30T05:30:00Z'))).toBe('2026-09-29T23:30:00');
  });

  it('vendors the SAT schemas byte for byte (hashes in provenance.json)', () => {
    const provenance = JSON.parse(fs.readFileSync(path.join(XSD_DIR, 'provenance.json'), 'utf8')) as {
      files: { path: string; sha256: string }[];
    };
    expect(provenance.files.length).toBe(3);
    for (const f of provenance.files) {
      const digest = createHash('sha256').update(fs.readFileSync(path.join(XSD_DIR, f.path))).digest('hex');
      expect(digest, f.path).toBe(f.sha256);
    }
  });
});
