import { describe, expect, it } from 'vitest';
import {
  capKept, coveredCashOf, keptCashOf, keptIvaOf, restitutedByRow, restitutedOf, takeFromAdvance,
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

describe('coveredCashOf', () => {
  it.each([
    // 32 × 1,160 / 160 = 232.0000
    ['A1b: 32 restituted on S 1,160 / 160 covers 232', '32.0000', '1160.0000', '160.0000', '232.0000'],
    ['A1: 16 on S 116 / 16 covers the whole 116', '16.0000', '116.0000', '16.0000', '116.0000'],
    // 1 × 1,000 / 137.9310 = 7.2500018…
    ['at four decimals, half up', '1.0000', '1000.0000', '137.9310', '7.2500'],
    ['an invoice with no IVA covers nothing', '16.0000', '100.0000', '0.0000', '0.0000'],
  ] as const)('%s', (_case, restituted, total, tax, cash) => {
    expect(coveredCashOf(restituted, total, tax)).toBe(cash);
  });
});
