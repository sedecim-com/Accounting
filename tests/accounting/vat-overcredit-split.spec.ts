import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/database/connection.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/database/connection.js')>();
  return { ...real, query: vi.fn(), withTransaction: vi.fn() };
});
// MNE-001-619: the census's bills, with what corrections already put back in
// 1135, are read through report-service. The real helper runs (its SQL reaches
// the fake transaction client below), wrapped in a spy so a test can say which
// layer was asked, with what, and on which client.
vi.mock('../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/services/reporting/report-service.js')>();
  return { ...real, queryVatOvercreditBills: vi.fn(real.queryVatOvercreditBills) };
});

import type pg from 'pg';
import { censusVatOvercredit, splitOvercredit } from '../../src/services/accounting/vat-overcredit.js';
import { query, withTransaction } from '../../src/database/connection.js';
import { queryVatOvercreditBills } from '../../src/services/reporting/report-service.js';

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

describe('censusVatOvercredit reads its bills through report-service, on the census\'s client (MNE-001-619)', () => {
  const TENANT = 'tttttttt-0000-0000-0000-000000000619';
  const ENTITY = 'eeeeeeee-0000-0000-0000-000000000619';
  const bills = vi.mocked(queryVatOvercreditBills);
  const KEYS = {
    noteSource: 'vendor_credit_note',
    correctionSource: 'vat_overcredit_correction',
    pendingRole: 'iva_pendiente_acreditar',
    creditableRole: 'iva_acreditable',
  };
  // The issue's CFDI with its header already corrected to the VAT: 172.80 of
  // VAT and 80.00 of IEPS on SubTotal 1,000.00, paid in full.
  const bill = (corrected: string) => ({
    tenant_id: TENANT, bill_id: 'bill-619', entity_id: ENTITY, entity_name: 'Synthetic SA', bill_number: 'B-619',
    cfdi_uuid: null, header: '172.8000', total: '1252.8000', amount_due: '0.0000', currency_code: 'MXN',
    functional_currency: 'MXN', xml_taxes: '252.8000',
    tax_breakdown: { traslados: [{ impuesto: '002', importe: '172.80' }, { impuesto: '003', importe: '80.00' }] },
    has_note: false, corrected, correction_entries: 'JE-619', roles: 2,
  });
  const halves = [
    { application_id: 'app-1', bill_id: 'bill-619', payment_id: 'pay-1', payment_number: 'VP-1', credit_date: '2026-07-15', applied: '626.4000', stored: '126.4000' },
    { application_id: 'app-2', bill_id: 'bill-619', payment_id: 'pay-2', payment_number: 'VP-2', credit_date: '2026-08-14', applied: '626.4000', stored: '126.4000' },
  ];

  /** A transaction client that answers each statement of the census by its text, and refuses any other. */
  function census(world: { bills: unknown[] }) {
    const seen: string[] = [];
    const q = vi.fn(async (text: string) => {
      const s = String(text);
      seen.push(s);
      if (s.includes('AS corrected')) return { rows: world.bills };
      if (s.includes('AS application_id')) return { rows: halves };
      // writtenOffOf: 1,252.80 explained by the two halves, nothing written off.
      if (s.includes('AS s')) return { rows: [{ s: '1252.8000' }] };
      throw new Error(`unexpected statement: ${s.slice(0, 80)}`);
    });
    const client = { query: q } as unknown as pg.PoolClient;
    vi.mocked(withTransaction).mockImplementation(async (fn) => fn(client));
    return { client, seen };
  }

  it('asks queryVatOvercreditBills once with the tenant and the four keys, and nets what corrections put back: 80.0000 − 30.0000 = 50.0000 open', async () => {
    bills.mockClear();
    vi.mocked(query).mockReset();
    const { client, seen } = census({ bills: [bill('30.0000')] });
    const [finding] = await censusVatOvercredit(TENANT);
    expect(bills.mock.calls).toEqual([[TENANT, { entityId: null, billId: null }, KEYS, client]]);
    expect(seen.filter((s) => s.includes('AS corrected'))).toHaveLength(1);
    expect(query).not.toHaveBeenCalled();
    // By hand: each half of 626.40 stored 126.4000 and owed 172.80 × 626.40 / 1,252.80 = 86.4000.
    expect(finding).toMatchObject({
      billId: 'bill-619', released: '252.8000', should: '172.8000', excess: '80.0000',
      corrected: '30.0000', open: '50.0000', reasons: [], correctable: true,
      byMonth: [{ month: '2026-07', excess: '40.0000' }, { month: '2026-08', excess: '40.0000' }],
    });
  });

  it('no bill with IEPS: an empty census, and no application is read', async () => {
    bills.mockClear();
    const { client, seen } = census({ bills: [] });
    expect(await censusVatOvercredit(TENANT, ENTITY)).toEqual([]);
    expect(bills.mock.calls).toEqual([[TENANT, { entityId: ENTITY, billId: null }, KEYS, client]]);
    expect(seen.some((s) => s.includes('AS application_id'))).toBe(false);
  });
});
