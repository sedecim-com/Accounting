import { describe, expect, it } from 'vitest';
import { splitOvercredit } from '../../src/services/accounting/vat-overcredit.js';

// MNE-001-562 · #725: what each live payment of a CFDI bill with IEPS should
// have released from 1135, read on the CFDI's VAT (002) alone, against what it
// stored. The CFDI is the issue's: SubTotal 1,000.00, IEPS 80.00, VAT 172.80,
// Total 1,252.80; the old header held 252.80. Figures worked by hand in the plan.

const VAT = '172.80';
const TOTAL = '1252.80';
const OLD = '252.80';
const row = (applied: string, stored: string | null, held = false) => ({ applied, stored, held });

describe('splitOvercredit', () => {
  it('H1 · two halves on the old header: 40.0000 each, 80.0000 in all', () => {
    const r = splitOvercredit({ vat: VAT, total: TOTAL, oldVat: OLD, rows: [row('626.40', '126.4000'), row('626.40', '126.4000')] });
    expect(r.rows.map((x) => [x.should, x.excess, x.capped])).toEqual([
      ['86.4000', '40.0000', false],
      ['86.4000', '40.0000', false],
    ]);
    expect([r.released, r.should, r.excess]).toEqual(['252.8000', '172.8000', '80.0000']);
  });

  it('H2 · the header corrected between the two: the second owes nothing', () => {
    const r = splitOvercredit({ vat: VAT, total: TOTAL, oldVat: OLD, rows: [row('626.40', '126.4000'), row('626.40', '86.4000')] });
    expect(r.rows.map((x) => x.excess)).toEqual(['40.0000', '0.0000']);
    expect(r.excess).toBe('40.0000');
  });

  it('H3 · three unequal payments split the same 80.0000 by their cumulative targets', () => {
    const r = splitOvercredit({
      vat: VAT, total: TOTAL, oldVat: OLD,
      rows: [row('300.00', '60.5364'), row('400.00', '80.7152'), row('552.80', '111.5484')],
    });
    expect(r.rows.map((x) => x.should)).toEqual(['41.3793', '55.1724', '76.2483']);
    expect(r.rows.map((x) => x.excess)).toEqual(['19.1571', '25.5428', '35.3001']);
    expect(r.excess).toBe('80.0000');
  });

  it('H4 · a release the parked cap trimmed is marked capped, and its excess is what the ledger moved', () => {
    const r = splitOvercredit({
      vat: VAT, total: TOTAL, oldVat: OLD,
      rows: [row('1000.00', '172.8000'), row('200.00', '40.3576'), row('52.80', '10.6544')],
    });
    expect(r.rows.map((x) => [x.should, x.excess, x.capped])).toEqual([
      ['137.9310', '34.8690', true],
      ['27.5862', '12.7714', false],
      ['7.2828', '3.3716', false],
    ]);
    expect(r.excess).toBe('51.0120');
  });

  it('a cheque that still holds its VAT owes nothing, and its cash still counts before the next payment', () => {
    const r = splitOvercredit({ vat: VAT, total: TOTAL, oldVat: OLD, rows: [row('626.40', '0.0000', true), row('626.40', '126.4000')] });
    expect(r.rows.map((x) => [x.should, x.excess])).toEqual([
      ['0.0000', '0.0000'],
      ['86.4000', '40.0000'],
    ]);
  });

  it('a row that stored no release has no excess, and the totals read the rows that did', () => {
    const r = splitOvercredit({ vat: VAT, total: TOTAL, rows: [row('626.40', null), row('626.40', '126.4000')] });
    expect(r.rows.map((x) => x.excess)).toEqual([null, '40.0000']);
    expect([r.released, r.should, r.excess]).toEqual(['126.4000', '86.4000', '40.0000']);
  });

  it('no rows, no excess', () => {
    expect(splitOvercredit({ vat: VAT, total: TOTAL, rows: [] })).toEqual({
      rows: [], released: '0.0000', should: '0.0000', excess: '0.0000',
    });
  });
});
