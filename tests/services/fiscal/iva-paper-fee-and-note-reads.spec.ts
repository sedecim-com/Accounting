import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ============================================================
// MNE-001-623 (#101) · THE IVA PAPER'S BANK FEES AND ISSUED NOTES SUM THE LEDGER THROUGH REPORT-SERVICE
//
// The creditable side's bank fees (what each fee entry moved on 1130) and the
// charged side's issued credit notes (what each note's entry moved on 2120 and
// 2125) read their sums through report-service, on the paper's own client.
// Hand figures. The two readers are spied, not replaced: their SQL still
// reaches the fake client, which answers each statement by the words that tell
// it apart; the pool is never asked.
// ============================================================

vi.mock('../../../src/database/connection.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/database/connection.js')>();
  return { ...real, query: vi.fn(), withTransaction: vi.fn() };
});
vi.mock('../../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/reporting/report-service.js')>();
  return {
    ...real,
    queryBankFeeVatEntriesInRange: vi.fn(real.queryBankFeeVatEntriesInRange),
    queryIssuedCreditNoteEntriesInRange: vi.fn(real.queryIssuedCreditNoteEntriesInRange),
  };
});

import { query } from '../../../src/database/connection.js';
import {
  queryBankFeeVatEntriesInRange,
  queryIssuedCreditNoteEntriesInRange,
} from '../../../src/services/reporting/report-service.js';
import { bankFeesOfRange } from '../../../src/services/fiscal/bank-fee-iva.js';
import { issuedCreditNotesOfRange } from '../../../src/services/fiscal/issued-credit-notes.js';

const ENTITY = 'b2c3d4e5-0000-4000-8000-000000000623';
const JUNE = { desde: '2026-06-01', hasta: '2026-06-30' };
const pool = query as unknown as Mock;
const fees = queryBankFeeVatEntriesInRange as unknown as Mock;
const notes = queryIssuedCreditNoteEntriesInRange as unknown as Mock;

/** A client that answers each statement by the first words that tell it apart, and nothing else. */
function clientAnswering(answers: Array<[RegExp, unknown[]]>) {
  return {
    query: vi.fn(async (sql: string) => {
      const hit = answers.find(([re]) => re.test(sql));
      if (!hit) throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
      return { rows: hit[1] };
    }),
  };
}

beforeEach(() => {
  pool.mockReset();
  fees.mockClear();
  notes.mockClear();
});

describe('bankFeesOfRange — the month\'s bank fees, read through report-service', () => {
  const fee = (o: Record<string, string | null>) => ({
    mirror_number: null, mirror_date: null, fee_base: null, fee_parked: null, ...o,
  });

  it('credits 300.00 of base and 48.00 of IVA at 16 %, and names the fee reversed in June, on the paper\'s client', async () => {
    // By hand, June 2026:
    //   a released fee: its bank_fee entry debited 6310 by 250.00 and parked 40.00 in 1135,
    //     and the release moved 40.00 to 1130         → base 40 × 250 / 40 = 250.00 at 16 %
    //   an iva-comision adjustment moved 8.00 to 1130 → base 8 / 0.16 = 50.00 at 16 %, derived
    //   a May fee entry of 12.00, its mirror dated 10 June → takes 12.00 out of 1130 in June, a cause of +12.00
    //   box 16 %: base 250 + 50 = 300.00, IVA 40 + 8 = 48.00.
    const client = clientAnswering([[/WITH fee AS/, [
      fee({ fee_id: 'mov-9', kind: 'release', entry_id: 'je-may', entry_number: 'JE-0090', entry_date: '2026-05-28',
        mirror_number: 'JE-0110', mirror_date: '2026-06-10', iva: '12.0000' }),
      fee({ fee_id: 'mov-1', kind: 'release', entry_id: 'je-1', entry_number: 'JE-0101', entry_date: '2026-06-12',
        iva: '40.0000', fee_base: '250.0000', fee_parked: '40.0000' }),
      fee({ fee_id: 'adj-1', kind: 'adjustment', entry_id: 'je-2', entry_number: 'JE-0102', entry_date: '2026-06-30',
        iva: '8.0000' }),
    ]]]);

    const out = await bankFeesOfRange(client as never, ENTITY, JUNE as never);

    expect(out.breakdown.tasa16).toEqual({ base: '300.0000', iva: '48.0000' });
    expect(out.breakdown.tasa8).toEqual({ base: '0.0000', iva: '0.0000' });
    expect(out.contributions.map((c) => [c.documentId, c.entryIds, c.breakdown.tasa16])).toEqual([
      ['mov-1', ['je-1'], { base: '250.0000', iva: '40.0000' }],
      ['adj-1', ['je-2'], { base: '50.0000', iva: '8.0000' }],
    ]);
    expect(out.causes.map((c) => c.amount.toFixed(4))).toEqual(['12.0000']);
    expect(out.causes[0].text).toContain('JE-0090');
    // One notice, naming the adjustment whose base was derived (read as text: its shape is not this test's).
    expect(out.findings).toHaveLength(1);
    expect(JSON.stringify(out.findings[0])).toContain('IVA-WP-BANK-FEE-CFDI');
    expect(JSON.stringify(out.findings[0])).toContain('JE-0102');

    expect(fees.mock.calls).toEqual([
      [ENTITY, '2026-06-01', '2026-06-30', { release: 'bank_fee_vat_release', fee: 'bank_fee' }, client],
    ]);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(pool).not.toHaveBeenCalled();
  });
});

describe('issuedCreditNotesOfRange — the month\'s issued notes, read through report-service', () => {
  const note = (o: Record<string, string | null>) => ({
    invoice_id: null, mirror_number: null, mirror_date: null, parked: '0', invoice_number: null,
    invoice_total: null, invoice_tax: null, invoice_rate: null, terms: null, memo: null, cfdi_uuid: null, ...o,
  });

  it('subtracts 1 000.00 and 160.00 at 16 %, and names the note voided in June, on the paper\'s client', async () => {
    // By hand, June 2026:
    //   NC-0001, no invoice: 1 000.00 + 160.00; its entry debited 2120 by 160.00 → base −1 000.00, IVA −160.00 at 16 %
    //   NC-0002, voided: its entry of 5 June debited 2120 by 80.00             → counts nowhere, a cause of +80.00
    const client = clientAnswering([[/FROM credit_notes cn/, [
      note({ id: 'cn-1', credit_note_number: 'NC-0001', status: 'issued', subtotal: '1000.0000', tax_amount: '160.0000',
        total_amount: '1160.0000', entry_id: 'je-1', entry_number: 'JE-0201', entry_date: '2026-06-15', iva: '160.0000' }),
      note({ id: 'cn-2', credit_note_number: 'NC-0002', status: 'void', subtotal: '500.0000', tax_amount: '80.0000',
        total_amount: '580.0000', entry_id: 'je-2', entry_number: 'JE-0202', entry_date: '2026-06-05', iva: '80.0000' }),
    ]]]);

    const out = await issuedCreditNotesOfRange(client as never, ENTITY, JUNE as never);

    expect(out.breakdown.tasa16).toEqual({ base: '-1000.0000', iva: '-160.0000' });
    expect(out.contributions.map((c) => [c.documentId, c.documentKind, c.entryIds])).toEqual([['cn-1', 'credit_note', ['je-1']]]);
    expect(out.causes.map((c) => c.amount.toFixed(4))).toEqual(['80.0000']);
    expect(out.causes[0].text).toContain('NC-0002, anulada');

    expect(notes.mock.calls).toEqual([[ENTITY, '2026-06-01', '2026-06-30', client]]);
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(pool).not.toHaveBeenCalled();
  });
});
