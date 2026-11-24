import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  capKept, heldKeptByRow, issuedVatKeptOnAccount, keptCashOf, keptIvaOf, keptOnAccount, restitutedByRow, restitutedCash, restitutedOf, takeFromAdvance,
} from '../../../src/services/payments/customer-advance.js';

// MNE-001-574 (#792, part 1/3) · The IVA one allocation's unapply keeps caused
// on a receipt with no treatment, and how a later application takes it back.
// Figures by hand: a PPD invoice of 1,000.00 + 160.00.

describe('keptIvaOf', () => {
  it.each([
    ['a row that took no advance keeps its release whole', { amount: '1160.0000', plain: '1160.0000', released: '160.0000' }, '160.0000'],
    ['a half collected keeps its 80.00', { amount: '580.0000', plain: '580.0000', released: '80.0000' }, '80.0000'],
    // 240 × 580 / 1,740 = 80.0000
    ['a row that took 1,160 from the pool keeps its plain part\'s share', { amount: '1740.0000', plain: '580.0000', released: '240.0000' }, '80.0000'],
    // 137.9310 × 300 / 1,000 = 41.37930 → 41.3793
    ['the share is at four decimals, half up', { amount: '1000.0000', plain: '300.0000', released: '137.9310' }, '41.3793'],
    // 100 × 1 / 3 = 33.33333… → 33.3333; 200 × 1 / 3 = 66.66666… → 66.6667
    ['a third rounds down', { amount: '3.0000', plain: '1.0000', released: '100.0000' }, '33.3333'],
    ['two thirds round up', { amount: '3.0000', plain: '1.0000', released: '200.0000' }, '66.6667'],
    ['a row written before 049 keeps nothing: it is estimated and re-parked', { amount: '580.0000', plain: '580.0000', released: null }, '0.0000'],
    ['a PUE row, or one off Mexican books, released 0 and keeps 0', { amount: '1160.0000', plain: '1160.0000', released: '0.0000' }, '0.0000'],
    ['a row whose cash was all from the pool keeps nothing of its own', { amount: '300.0000', plain: '0.0000', released: '41.3793' }, '0.0000'],
  ] as const)('%s', (_case, row, kept) => {
    expect(keptIvaOf(row)).toBe(kept);
  });
});

describe('the cash an unapply kept on account, taken again by takeFromAdvance', () => {
  it('applied whole, it cancels exactly the IVA kept', () => {
    expect(takeFromAdvance({ total: '1160.0000', iva: '160.0000', consumed: '0', cancelled: '0', plain: '0', applied: '1160.0000' }))
      .toEqual({ plain: '0.0000', base: '1000.0000', iva: '160.0000' });
  });

  it('applied in two halves of 290.00 out of 580.00, the telescope cancels 40 and then the 40 left', () => {
    const first = takeFromAdvance({ total: '580.0000', iva: '80.0000', consumed: '0', cancelled: '0', plain: '0', applied: '290.0000' });
    expect(first).toEqual({ plain: '0.0000', base: '250.0000', iva: '40.0000' });
    expect(takeFromAdvance({ total: '580.0000', iva: '80.0000', consumed: '290.0000', cancelled: '40.0000', plain: '0', applied: '290.0000' }))
      .toEqual({ plain: '0.0000', base: '250.0000', iva: '40.0000' });
  });
});

// MNE-001-574 with MNE-001-581 (#792, decision (A)): after a credit note the cash keeps caused only what
// goes back to 2125 for the balance owed again.
describe('capKept', () => {
  it.each([
    ['under the cap, the rows as they are', ['160.0000'], '160.0000', ['160.0000']],
    ['U1: 160 kept, 128 back after a note of 32', ['160.0000'], '128.0000', ['128.0000']],
    ['U2: a note for the whole invoice leaves nothing to keep', ['16.0000'], '0.0000', ['0.0000']],
    // 40 × 50 / 80 = 25; the last row takes 50 − 25
    ['two rows share the cap, the last one takes the remainder', ['40.0000', '40.0000'], '50.0000', ['25.0000', '25.0000']],
    // 10 × 10 / 30 = 3.3333 twice; the last 10 − 6.6666 = 3.3334
    ['a cap that does not divide: the rows still add up to it', ['10.0000', '10.0000', '10.0000'], '10.0000', ['3.3333', '3.3333', '3.3334']],
    ['a row that kept nothing keeps nothing, and the last that kept takes the rest', ['30.0000', '0.0000'], '20.0000', ['20.0000', '0.0000']],
    ['a negative cap reads as none', ['16.0000'], '-4.0000', ['0.0000']],
  ] as const)('%s', (_case, kept, cap, out) => {
    expect(capKept(kept, cap)).toEqual(out);
  });
});

// MNE-001-591 (#792, decision (A), follow-up 1): after a note caps what a row keeps caused, only part of
// its plain cash carries that IVA. Figures by hand: S 1,000.00 + 160.00, a note of 200.00 + 32.00.
describe('keptCashOf', () => {
  it.each([
    // 1,160 × 128 / 160 = 928.0000
    ['U1: the 1,160 back on account carries the 128 kept in 928 of it', { amount: '1160.0000', plain: '1160.0000', released: '160.0000', kept: '128.0000' }, '928.0000'],
    // 580 × 48 / 80 = 348.0000
    ['U5\'s first unapply: 580 keeps 48 of its 80, carried by 348', { amount: '580.0000', plain: '580.0000', released: '80.0000', kept: '48.0000' }, '348.0000'],
    ['a row the note did not cap: all its plain cash', { amount: '1160.0000', plain: '1160.0000', released: '160.0000', kept: '160.0000' }, '1160.0000'],
    ['a row that kept nothing is not in the pool', { amount: '1160.0000', plain: '1160.0000', released: '160.0000', kept: null }, '0.0000'],
    // its full share is 160 × 580 / 1,160 = 80, so 580 × 48 / 80 = 348.0000
    ['a row whose plain cash is half its amount scales by its plain part\'s share', { amount: '1160.0000', plain: '580.0000', released: '160.0000', kept: '48.0000' }, '348.0000'],
    // 1,000 × 0.0002 / 160 = 0.00125 → 0.0013, half up (half even would give 0.0012)
    ['at four decimals, half up', { amount: '1000.0000', plain: '1000.0000', released: '160.0000', kept: '0.0002' }, '0.0013'],
  ] as const)('%s', (_case, row, cash) => {
    expect(keptCashOf(row)).toBe(cash);
  });
});

// MNE-001-592 (#814, decision (A)): after a credit note, cash that carried an advance's IVA keeps caused only
// the IVA of the balance owed again; what the note restituted is not caused again (LIVA art. 7).
describe('restitutedOf', () => {
  it.each([
    ['A1: a note for the whole sale restitutes the advance\'s 16', ['16.0000', '16.0000', '16.0000'], { restituted: '16.0000', kept: '0.0000', back: '0.0000' }],
    ['A1b and A1p: a note of 32 on an advance IVA of 160', ['160.0000', '160.0000', '32.0000'], { restituted: '32.0000', kept: '128.0000', back: '128.0000' }],
    // c 160 against an invoice's g 80 and a note's 16: only the note leaves, c − g stays caused (MNE-001-461).
    ['mixed rates: c 160, g 80, a note of 16 keeps 144, not the 64 that goes back', ['160.0000', '80.0000', '16.0000'], { restituted: '16.0000', kept: '144.0000', back: '64.0000' }],
    ['no note: nothing restituted, the advance\'s IVA back whole', ['16.0000', '16.0000', '0'], { restituted: '0.0000', kept: '16.0000', back: '16.0000' }],
    ['no advance IVA: nothing to restitute, whatever the note kept', ['0', '160.0000', '32.0000'], { restituted: '0.0000', kept: '0.0000', back: '128.0000' }],
  ] as const)('%s', (_case, [advanceIva, released, noteKept], out) => {
    expect(restitutedOf(advanceIva, released, noteKept)).toEqual(out);
  });
});

describe('restitutedByRow', () => {
  it.each([
    // 16 × 10 / 32 = 5; the last row takes 16 − 5
    ['two rows split 16 by their c of 10 and 22', ['10.0000', '22.0000'], '16.0000', ['5.0000', '11.0000']],
    // a treated receipt's record-time cash (backAsAdvance, MNE-001-462) weighs like c: 32 × 16 / 160 = 3.2
    ['a row\'s backAsAdvance IVA weighs with its c', ['144.0000', '16.0000'], '32.0000', ['28.8000', '3.2000']],
    // 10 × 10 / 30 = 3.3333 twice; the last 10 − 6.6666 = 3.3334
    ['a share that does not divide: the rows still add up to it', ['10.0000', '10.0000', '10.0000'], '10.0000', ['3.3333', '3.3333', '3.3334']],
    ['a row that carried no advance IVA stores none', ['16.0000', '0.0000'], '16.0000', ['16.0000', '0.0000']],
    ['nothing restituted, nothing stored', ['16.0000'], '0.0000', ['0.0000']],
  ] as const)('%s', (_case, weights, restituted, out) => {
    expect(restitutedByRow(weights, restituted)).toEqual(out);
  });
});

// The cash the restitution covers, as `advanceLeft` and the paper read it (`restitutedCash`, shared with 593).
describe('restitutedCash, for an unapply after a note', () => {
  it.each([
    // 32 × 1,160 / 160 = 232.0000
    ['A1b: 32 restituted on S 1,160 / 160 covers 232', '32.0000', '1160.0000', '160.0000', '232.0000'],
    ['A1: 16 on S 116 / 16 covers the whole 116', '16.0000', '116.0000', '16.0000', '116.0000'],
    // 1 × 1,000 / 137.9310 = 7.2500018…
    ['at four decimals, half up', '1.0000', '1000.0000', '137.9310', '7.2500'],
    ['an invoice with no IVA covers nothing', '16.0000', '100.0000', '0.0000', '0.0000'],
  ] as const)('%s', (_case, restituted, total, tax, cash) => {
    expect(restitutedCash(restituted, total, tax)).toBe(cash);
  });
});

// MNE-001-593 (#814, decision (A)): a credit note issued after the unapply restitutes from 2120 the IVA of the
// price whose cash is still kept on account. Figures by hand: S 1,000.00 + 160.00, P 1,160 unapplied, N 200 + 32.
describe('restitutedCash', () => {
  it.each([
    ['U4: 32 restituted covers 32 × 1,160 / 160', '32.0000', '1160.0000', '160.0000', '232.0000'],
    // 10 × 1,160 / 160 = 72.5; 0.01 × 1,160 / 160 = 0.0725
    ['four decimals, half up', '0.0100', '1160.0000', '160.0000', '0.0725'],
    ['an invoice with no IVA covers none', '32.0000', '1000.0000', '0.0000', '0.0000'],
  ] as const)('%s', (_case, iva, total, tax, cash) => {
    expect(restitutedCash(iva, total, tax)).toBe(cash);
  });
});

/** A client that answers the pool's queries by shape: P's rows on S, N's restitution, and what P's live rows took. */
function poolClient(o: { restituted: string | null; took: string; status?: string }): pg.PoolClient {
  const query = async (text: string) => {
    const sql = String(text).replace(/\s+/g, ' ');
    if (sql.includes('AS marked')) return { rows: o.status === 'reversed' ? [] : [{ payment_id: 'P', payment_number: 'PMT-1', marked: '160.0000' }] };
    if (sql.includes('AS note_number')) {
      return { rows: o.restituted === null ? [] : [{ invoice_id: 'S', note_number: 'CN-1', iva: o.restituted, total: '1160.0000', tax: '160.0000' }] };
    }
    if (sql.includes('AS kept')) return { rows: [{ invoice_id: 'S', amount: '1160.0000', plain: '1160.0000', released: '160.0000', kept: '160.0000' }] };
    if (sql.includes('AS took')) return { rows: [{ took: o.took }] };
    return { rows: [] };
  };
  return { query } as unknown as pg.PoolClient;
}

describe('keptOnAccount after a restitution, and H', () => {
  it('U4: the pool loses the 32 and the 232 it covers, and S joins the invoices that take it first', async () => {
    const pool = await keptOnAccount(poolClient({ restituted: '32.0000', took: '0' }), 'E', 'P');
    expect([pool.cash, pool.iva, [...pool.own]]).toEqual(['928.0000', '128.0000', ['S']]);
  });

  it('before the note H is the 160 the unapply kept; after it, what is left of the marker, 128', async () => {
    expect(await issuedVatKeptOnAccount(poolClient({ restituted: null, took: '0' }), 'E', 'S'))
      .toEqual([{ paymentId: 'P', paymentNumber: 'PMT-1', iva: '160.0000' }]);
    expect((await issuedVatKeptOnAccount(poolClient({ restituted: '32.0000', took: '0' }), 'E', 'S'))[0].iva).toBe('128.0000');
  });

  it('U4p: T took c = 80 of the pool, so it holds 80; once S took all of it, H is none', async () => {
    expect((await issuedVatKeptOnAccount(poolClient({ restituted: null, took: '80.0000' }), 'E', 'S'))[0].iva).toBe('80.0000');
    expect(await issuedVatKeptOnAccount(poolClient({ restituted: '32.0000', took: '128.0000' }), 'E', 'S')).toEqual([]);
  });
});

// MNE-001-586 (#792, part 3/3) · What a held cheque's unapply keeps for the cashing, split by plain cash.
describe('heldKeptByRow', () => {
  it('one plain row keeps the whole share: 160.0000 of 1,160.00, 80.0000 of 580.00', () => {
    expect(heldKeptByRow('160.0000', [{ amount: '1160.0000', plain: '1160.0000' }])).toEqual(['160.0000']);
    expect(heldKeptByRow('80.0000', [{ amount: '580.0000', plain: '580.0000' }])).toEqual(['80.0000']);
  });

  it('three rows of 1.00 share 0.1379 as 0.0460, 0.0460 and the remainder 0.0459', () => {
    // 0.1379 / 3 = 0.045966… → 0.0460 twice, and 0.1379 − 0.0920 = 0.0459 for the last.
    const rows = [1, 2, 3].map(() => ({ amount: '1.0000', plain: '1.0000' }));
    expect(heldKeptByRow('0.1379', rows)).toEqual(['0.0460', '0.0460', '0.0459']);
  });

  it('a row that took 1,160.00 of 1,740.00 from the pool keeps only its plain part: 240 × 580 / 1,740 = 80.0000', () => {
    expect(heldKeptByRow('240.0000', [{ amount: '1740.0000', plain: '580.0000' }])).toEqual(['80.0000']);
  });

  it('nothing to keep: no share, or no plain cash', () => {
    expect(heldKeptByRow('0', [{ amount: '1160.0000', plain: '1160.0000' }])).toEqual(['0.0000']);
    expect(heldKeptByRow('-1.0000', [{ amount: '1160.0000', plain: '1160.0000' }])).toEqual(['0.0000']);
    expect(heldKeptByRow('160.0000', [{ amount: '1160.0000', plain: '0.0000' }])).toEqual(['0.0000']);
  });
});
