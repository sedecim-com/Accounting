import { describe, it, expect } from 'vitest';
import { advanceSourceNote, backAsAdvance, splitAdvance } from '../../../src/services/payments/customer-advance.js';
import { treatmentOfSale } from '../../../src/services/fiscal/sale-sources.js';
import type { RenglonDeGasto } from '../../../src/services/sat/diot/index.js';

// MNE-001-462 (#623) · the treatment the excess of a collection takes, and the
// cash an unapply puts back as an advance, by hand.

const line = (amount: string, iva: string, rate: string | null, factor: RenglonDeGasto['tipoFactor'] = 'tasa'): RenglonDeGasto =>
  ({ tipoFactor: factor, tasa: rate, valorActos: amount, importe: amount, iva });

describe('treatmentOfSale', () => {
  it('one rate is that rate, with nothing assumed', () => {
    expect(treatmentOfSale({ lines: [line('1000', '160', '16.0000')], notSubject: '0' })).toEqual({ treatment: '16', assumed: null });
    expect(treatmentOfSale({ lines: [line('1000', '80', '8.00')], notSubject: '0' })).toEqual({ treatment: '8', assumed: null });
    expect(treatmentOfSale({ lines: [line('1000', '0', '0.0000')], notSubject: '0' })).toEqual({ treatment: '0', assumed: null });
    expect(treatmentOfSale({ lines: [line('1000', '0', null, 'exento')], notSubject: '0' })).toEqual({ treatment: 'exempt', assumed: null });
  });

  it('a typed line with no rate and no IVA reads as 0 %, as the IVA paper boxes it', () => {
    expect(treatmentOfSale({ lines: [line('1000', '0', null)], notSubject: '0' })).toEqual({ treatment: '0', assumed: null });
  });

  it('a CFDI outside the object of IVA is not-subject', () => {
    expect(treatmentOfSale({ lines: [], notSubject: '1000.0000' })).toEqual({ treatment: 'not-subject', assumed: null });
  });

  it('several rates take the highest that carries IVA, said as assumed', () => {
    const mixed = [line('1000', '160', '16'), line('500', '0', '0'), line('300', '24', '8')];
    expect(treatmentOfSale({ lines: mixed, notSubject: '200' })).toEqual({ treatment: '16', assumed: 'highest' });
    expect(treatmentOfSale({ lines: [line('500', '0', '0'), line('300', '24', '8')], notSubject: '0' }))
      .toEqual({ treatment: '8', assumed: 'highest' });
  });

  it('several treatments with no IVA take exempt, which credits the least (LIVA art. 5 fr. V)', () => {
    expect(treatmentOfSale({ lines: [line('500', '0', '0'), line('300', '0', null, 'exento')], notSubject: '0' }))
      .toEqual({ treatment: 'exempt', assumed: 'exempt' });
    expect(treatmentOfSale({ lines: [line('500', '0', '0')], notSubject: '100' })).toEqual({ treatment: 'exempt', assumed: 'exempt' });
  });

  it('a rate an advance does not take reads as the general one, said as the highest', () => {
    expect(treatmentOfSale({ lines: [line('1000', '110', '11.00')], notSubject: '0' })).toEqual({ treatment: '16', assumed: 'highest' });
  });

  it('a sale that says nothing gives no treatment, and a line of zero says nothing', () => {
    expect(treatmentOfSale({ lines: [], notSubject: '0' })).toBeNull();
    expect(treatmentOfSale({ lines: [line('0', '0', '16')], notSubject: '0' })).toBeNull();
  });
});

describe('backAsAdvance', () => {
  it('the 1,160.00 back at 16 % is 1,000.00 and 160.00, as the advance itself splits', () => {
    expect(backAsAdvance(['1160.0000'], '16')).toEqual({ cash: '1160.0000', base: '1000.0000', iva: '160.0000' });
    expect(splitAdvance('1160.00', '16')).toMatchObject({ base: '1000.00', iva: '160.00' });
  });

  it('row by row, each rounded as its own split, and what took the advance adds nothing', () => {
    // 340 / 1.16 = 293.10 and 46.90; 1,160 / 1.16 = 1,000.00 and 160.00; a row that was all advance has 0 plain.
    expect(backAsAdvance(['340.0000', '1160.0000', '0.0000'], '16')).toEqual({ cash: '1500.0000', base: '1293.1000', iva: '206.9000' });
  });

  it('exempt, not-subject and 0 % carry no IVA back', () => {
    for (const t of ['exempt', 'not-subject', '0'] as const) {
      expect(backAsAdvance(['1160.0000'], t)).toEqual({ cash: '1160.0000', base: '1160.0000', iva: '0.0000' });
    }
  });
});

describe('advanceSourceNote', () => {
  const at16 = splitAdvance('340.00', '16');
  it('says nothing when the treatment was stated', () => {
    expect(advanceSourceNote(at16)).toBe('');
  });

  it('names the invoice, and what was assumed', () => {
    expect(advanceSourceNote({ ...at16, from: { invoices: 'INV-1', assumed: null } }))
      .toBe(' · excess on account is an advance at 16 %, from INV-1');
    expect(advanceSourceNote({ ...at16, from: { invoices: 'INV-1', assumed: 'highest' } }))
      .toBe(' · excess on account is an advance at 16 %, from INV-1 (several rates: the highest assumed)');
    expect(advanceSourceNote({ treatment: 'exempt', from: { invoices: 'INV-2', assumed: 'exempt' } }))
      .toBe(' · excess on account is an advance, exempt, from INV-2 (several treatments, none with IVA: exempt assumed)');
  });
});
