import { describe, it, expect, vi, type Mock } from 'vitest';

vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));

import { getPolicy } from '../../../src/services/policy/policy-service.js';
import {
  FILING_ROUNDING_POLICY,
  priorBalanceOf,
  readFilingRounding,
  saleFromCfdi,
  roundToWhole,
  settleIva,
  type IvaWorkpaperFigures,
} from '../../../src/services/fiscal/iva-workpaper.js';
import { desglosarDocumento, desgloseCero } from '../../../src/services/sat/diot/index.js';
import { ValidationError } from '../../../src/utils/errors.js';
import { POLICY_CATALOG } from '../../../src/services/policy/pending-catalog.js';

/**
 * THE IVA WORKPAPER'S ARITHMETIC (#308, MNE-001-058).
 *
 * CFF art. 20 adjusts to whole with 1–50 cents down and 51–99 up, after the
 * ledger's four decimals are rounded to the cent. The policy
 * `declaracion_redondeo_a_pesos` (owner, MNE-001-004) decides whether every
 * line is adjusted (default) or only the result.
 */

const mockGetPolicy = getPolicy as unknown as Mock;

describe('roundToWhole follows CFF art. 20, not half up', () => {
  it.each([
    ['10.5000', '10'], // 50 cents go down: half up would say 11
    ['10.5100', '11'],
    ['10.0100', '10'],
    ['10.9900', '11'],
    ['10.5049', '10'], // the cent first: 10.50, then down
    ['10.5050', '11'], // 10.51 at the cent
    ['-10.5000', '-10'],
    ['-10.5100', '-11'],
  ])('%s → %s', (amount, whole) => {
    expect(roundToWhole(amount).toFixed(0)).toBe(whole);
  });
});

/** A month worked by hand, with cents that make the two options differ. */
function month(): IvaWorkpaperFigures {
  const charged = desgloseCero();
  charged.tasa16 = { base: '1000.3125', iva: '160.0500' };
  charged.tasa8 = { base: '500.0000', iva: '40.5000' };
  const creditable = desgloseCero();
  creditable.tasa16 = { base: '600.0000', iva: '96.5000' };
  return {
    charged,
    chargedNotSubject: '0.0000',
    creditable,
    withheldByCustomers: '10.2600',
    withheldToRemit: '5.3333',
    priorBalanceInFavor: '0.0000',
  };
}

describe('settleIva', () => {
  it('cada_renglon adds whole whole: 160 + 40 − 96 − 10 = 94', () => {
    const s = settleIva(month(), 'cada_renglon');
    const line = (k: string) => s.lines.find((l) => l.key === k)!;
    expect(line('charged.tasa16.iva')).toMatchObject({ cents: '160.05', whole: '160', sign: 1 });
    expect(line('charged.tasa8.iva')).toMatchObject({ cents: '40.50', whole: '40', sign: 1 });
    expect(line('charged.tasa16.base')).toMatchObject({ cents: '1000.31', whole: '1000', sign: 0 });
    expect(line('creditable.tasa16.iva')).toMatchObject({ cents: '96.50', whole: '96', sign: -1 });
    expect(line('withheld_by_customers')).toMatchObject({ cents: '10.26', whole: '10', sign: -1 });
    // Shown, never netted: the entity's own withholdings are #309's return.
    expect(line('withheld_to_remit')).toMatchObject({ cents: '5.33', whole: '5', sign: 0 });
    // 160.05 + 40.50 − 96.50 − 10.26 = 93.79 in cents.
    expect(s.resultCents).toBe('93.79');
    expect(s.resultWhole).toBe('94');
  });

  it('solo_el_pago adjusts only the result: 93.79 → 94, and 93.50 → 93', () => {
    expect(settleIva(month(), 'solo_el_pago').resultWhole).toBe('94');
    const f = month();
    f.withheldByCustomers = '10.5500'; // cents: 160.05 + 40.50 − 96.50 − 10.55 = 93.50
    expect(settleIva(f, 'solo_el_pago').resultCents).toBe('93.50');
    expect(settleIva(f, 'solo_el_pago').resultWhole).toBe('93');
    // Line by line: 160 + 40 − 96 − 11 = 93 as well; the prior balance breaks the tie.
    f.priorBalanceInFavor = '0.5100';
    expect(settleIva(f, 'solo_el_pago').resultWhole).toBe('93'); // 92.99 → 93
    expect(settleIva(f, 'cada_renglon').resultWhole).toBe('92'); // 93 − 1
  });

  it('the no objeto base is a line of its own, shown and never netted', () => {
    const f = month();
    f.chargedNotSubject = '250.5100';
    const s = settleIva(f, 'cada_renglon');
    expect(s.lines.find((l) => l.key === 'charged.no_objeto.base')).toMatchObject({ cents: '250.51', whole: '251', sign: 0 });
    expect(s.resultWhole).toBe('94');
  });

  it('a balance in favor comes out negative', () => {
    const f = month();
    f.priorBalanceInFavor = '500.0000';
    expect(settleIva(f, 'cada_renglon').resultWhole).toBe('-406');
  });
});

describe('the panel key and its reader', () => {
  it('declares both values, cada_renglon by default, citing CFF art. 20', () => {
    const spec = POLICY_CATALOG.find((p) => p.key === FILING_ROUNDING_POLICY)!;
    expect(spec.options.map((o) => o.value)).toEqual(['cada_renglon', 'solo_el_pago']);
    expect(spec.defaultValue).toBe('cada_renglon');
    expect(spec.defaultRationale).toMatch(/CFF art\. 20/);
  });

  it('does not state the unverified premise about the portal as a fact', () => {
    // Owner's note on #308: the current Declaraciones y Pagos form is not confirmed.
    const spec = POLICY_CATALOG.find((p) => p.key === FILING_ROUNDING_POLICY)!;
    expect(spec.defaultRationale).not.toMatch(/portal captures/i);
    expect(spec.defaultRationale).toMatch(/Unverified assumption/);
    expect(spec.ifSkipped).not.toMatch(/portal/i);
  });

  it('reads a known value and refuses an unknown one', async () => {
    mockGetPolicy.mockResolvedValueOnce({ key: FILING_ROUNDING_POLICY, value: 'solo_el_pago', defined: true });
    await expect(readFilingRounding({ tenantId: 't', entityId: 'e' })).resolves.toBe('solo_el_pago');
    mockGetPolicy.mockResolvedValueOnce({ key: FILING_ROUNDING_POLICY, value: 'half_up', defined: true });
    await expect(readFilingRounding({ tenantId: 't', entityId: 'e' })).rejects.toThrow(/half_up/);
  });
});

describe('a sale born from its CFDI is split by the CFDI', () => {
  // 2 000 at 16 % (320), 1 000 exempt, 500 no objeto (in no Traslado): subtotal 3 500.
  const taxes = {
    traslados: [
      { impuesto: '002', tipoFactor: 'Tasa', tasaOCuota: 0.16, base: 2000, importe: 320 },
      { impuesto: '002', tipoFactor: 'Exento', base: 1000 },
      { impuesto: '003', tipoFactor: 'Tasa', tasaOCuota: 0.08, base: 3500, importe: 280 }, // IEPS: never IVA
    ],
    retenciones: [],
  };

  it('each IVA Traslado is a line, and what the subtotal carries beyond their bases is no objeto', () => {
    const sale = saleFromCfdi(taxes, '3500.00', '0');
    expect(sale.fromCfdi).toBe(true);
    expect(sale.notSubject).toBe('500.0000');
    expect(sale.lines).toEqual([
      { tipoFactor: 'tasa', tasa: '16.00', valorActos: '2000.0000', importe: '2000.0000', iva: '320.0000' },
      { tipoFactor: 'exento', tasa: null, valorActos: '1000.0000', importe: '1000.0000', iva: '0.0000' },
    ]);
    const r = desglosarDocumento({
      documentId: 'i', documentNumber: 'INV-1', renglones: sale.lines, ivaCabecera: '320', ivaPagado: '320',
      porcion: { aplicadoPrevio: '0', aplicadoAhora: '3820', totalDocumento: '3820' },
      politicaBaseExenta: 'exigir_base', documentKind: 'invoice',
    });
    expect(r.hallazgos).toEqual([]);
    expect(r.desglose.tasa16).toEqual({ base: '2000.0000', iva: '320.0000' });
    expect(r.desglose.exento).toEqual({ base: '1000.0000', iva: '0.0000' });
  });

  it('the discount is not no objeto, and an unknown base leaves no objeto at zero', () => {
    expect(saleFromCfdi(taxes, '3600.00', '100').notSubject).toBe('500.0000');
    const unknown = { traslados: [{ impuesto: '002', tipoFactor: 'Exento' }], retenciones: [] };
    expect(saleFromCfdi(unknown, '1000.00', '0').notSubject).toBe('0.0000');
  });

  it('a finding on a sale names the sale and invoice_lines, never a bill', () => {
    const r = desglosarDocumento({
      documentId: 'i', documentNumber: 'INV-9',
      renglones: [{ tipoFactor: 'tasa', tasa: null, valorActos: null, importe: '1000', iva: '0' }],
      ivaCabecera: '160', ivaPagado: '160',
      porcion: { aplicadoPrevio: '0', aplicadoAhora: '1160', totalDocumento: '1160' },
      politicaBaseExenta: 'exigir_base', documentKind: 'invoice',
    });
    expect(r.hallazgos[0].mensaje).toMatch(/^La factura de venta INV-9/);
    const exempt = desglosarDocumento({
      documentId: 'i', documentNumber: 'INV-9',
      renglones: [{ tipoFactor: 'exento', tasa: null, valorActos: null, importe: '1000', iva: '0' }],
      ivaCabecera: '0', ivaPagado: '0',
      porcion: { aplicadoPrevio: '0', aplicadoAhora: '1000', totalDocumento: '1000' },
      politicaBaseExenta: 'exigir_base', documentKind: 'invoice',
    });
    expect(exempt.hallazgos[0].mensaje).toMatch(/de la factura de venta INV-9/);
    expect(exempt.hallazgos[0].mensaje).toMatch(/invoice_lines/);
    expect(exempt.hallazgos[0].mensaje).not.toMatch(/gasto|bill_lines|La DIOT/);
  });
});

describe('the prior balance in favor is captured by a person and validated', () => {
  it('accepts zero or more, four decimals', () => {
    expect(priorBalanceOf(undefined)).toBe('0.0000');
    expect(priorBalanceOf('12.5')).toBe('12.5000');
  });

  it.each(['-1', 'abc', 'NaN', 'Infinity'])('refuses %s with a ValidationError', (raw) => {
    expect(() => priorBalanceOf(raw)).toThrow(ValidationError);
  });
});
