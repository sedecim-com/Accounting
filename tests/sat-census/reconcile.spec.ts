import { describe, it, expect } from 'vitest';
import { censusBox } from '../../src/services/accounting/period-close.js';
import { gapsOf, severityOfCensusGap, type CensusItem, type CensusReconciliation } from '../../src/services/sat-census/reconcile.js';
import { findingRows, monthBounds } from '../../src/cli/sat-census-command.js';

// MNE-001-119 (#312): the judgement of the census against the books, without a
// database: how a gap weighs by direction, when the close box is complete, and
// the shape of what the CLI lists.

const item = (direction: 'issued' | 'received', n = 1): CensusItem => ({
  uuid: `aaaaaaaa-0000-4000-8000-00000000000${n}`, direction, cfdiType: 'I', issuedAt: '2026-08-10 10:00:00', amount: '1160.00',
});
const rec = (over: Partial<CensusReconciliation> = {}): CensusReconciliation => ({
  from: '2026-08-01', to: '2026-08-31', types: ['I', 'E', 'P'], covered: { issued: true, received: true },
  hasLoads: true, toFetch: [], toPost: [], cancelledBooked: [], surplus: [], matched: 0, cancelledUnbooked: 0, ...over,
});

describe('severityOfCensusGap', () => {
  it('by default an issued gap blocks and a received one warns', () => {
    expect(severityOfCensusGap('issued_blocks', 'issued')).toBe('blocking');
    expect(severityOfCensusGap('issued_blocks', 'received')).toBe('warning');
  });
  it('both_block blocks both directions, both_warn warns both', () => {
    expect(severityOfCensusGap('both_block', 'received')).toBe('blocking');
    expect(severityOfCensusGap('both_warn', 'issued')).toBe('warning');
  });
  it('a value the panel does not know only warns', () => {
    expect(severityOfCensusGap('whatever', 'issued')).toBe('warning');
  });
});

describe('censusBox', () => {
  it('is complete only when nothing is missing and both directions were loaded', () => {
    expect(censusBox(rec({ matched: 3 }), 'issued_blocks')).toMatchObject({ is_complete: true, details: undefined });
    const unloaded = censusBox(rec({ covered: { issued: false, received: true } }), 'issued_blocks');
    expect(unloaded.is_complete).toBe(false);
    expect(unloaded.details).toContain('no SAT census loaded for issued');
    // Not loaded is not a gap: it cannot block.
    expect(unloaded.severity).toBe('warning');
  });
  it('weighs as its heaviest direction', () => {
    const received = rec({ toFetch: [item('received')] });
    expect(censusBox(received, 'issued_blocks').severity).toBe('warning');
    expect(censusBox(rec({ toFetch: [item('received'), item('issued', 2)] }), 'issued_blocks').severity).toBe('blocking');
    expect(censusBox(received, 'both_block').severity).toBe('blocking');
  });
  it('counts a cancelled-but-posted CFDI as a gap of its direction', () => {
    const r = rec({ cancelledBooked: [item('issued')] });
    expect(gapsOf(r, 'issued')).toBe(1);
    expect(gapsOf(r, 'received')).toBe(0);
  });
});

describe('the terminal surface', () => {
  it('reads a month as YYYY-MM and refuses anything else', () => {
    expect(monthBounds('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(monthBounds('2028-02').to).toBe('2028-02-29');
    for (const bad of ['2026-13', '2026-8', 'agosto', '']) expect(() => monthBounds(bad)).toThrow();
  });
  it('lists every finding with its status', () => {
    const rows = findingRows(rec({
      toFetch: [item('issued')], toPost: [item('received', 2)], cancelledBooked: [item('issued', 3)],
      surplus: [{ uuid: 'x', direction: 'received', source: 'bill', date: '2026-08-02', amount: '5.00' }],
    }));
    expect(rows.map((r) => r.status)).toEqual(['to_fetch', 'to_post', 'cancelled_booked', 'surplus']);
  });
});
