import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../src/services/accounting/posting.js', () => ({
  createJournalEntry: vi.fn(async (_entity: string, _date: string, _type: string, _desc: string, _lines: unknown, _user: string,
    opts: { sourceId: string }) => ({ id: `pair:${opts.sourceId}` })),
}));

import type pg from 'pg';
import {
  followNoteReversal, HELD_RESTITUTION_REVERSAL_SOURCE, HELD_RESTITUTION_UNDONE_TAG,
} from '../../src/services/accounting/ar-ap-posting.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';

const mockCreate = createJournalEntry as unknown as ReturnType<typeof vi.fn>;

const ENTITY = 'e0000000-0000-0000-0000-000000000612';
const USER = 'u0000000-0000-0000-0000-000000000612';
const NOTE = { id: 'note-je', entity_id: ENTITY, entry_number: 'JE-2026-00031' };
const MIRROR = { id: 'mirror-je' };

// ============================================================
// MNE-001-612 · THE PAIR A HELD NOTE'S REVERSAL POSTS AFTER THE CASHING
//
// `followNoteReversal` reads, in one query, the note's `held_restitution`
// lines whose cheque the bank has cashed, and posts one DR 2150 / CR 2120
// per receipt. The guards live in that SQL, so the fake below answers BY
// THE SHAPE OF THE SQL: it drops a line for each guard only when the query
// states that guard, and dates each pair with GREATEST(mirror, cashing) only
// when the query asks for it. A guard taken out of the SQL lets its line
// through, and the test that names it goes red. The real query runs against
// Postgres in tests/integration/mne-001-612-held-note-reversed-after-cashing.int.spec.ts.
// ============================================================

/** One line of the reversed note's entry, and the state of the receipt and cashing its tag names. */
interface NoteLine {
  held: boolean;
  payment: string;
  invoice: string;
  /** The line's 2125 debit. */
  iva: string;
  receiptStatus: 'completed' | 'reversed';
  cashed: boolean;
  cashing: { posted: boolean; reversed: boolean; date: string } | null;
}

let noteLines: NoteLine[];
let mirrorDate: string;
let queries: Array<{ sql: string; params: unknown[] }>;

function line(overrides: Partial<NoteLine> = {}): NoteLine {
  return {
    held: true, payment: 'pay-A', invoice: 'inv-S', iva: '32.0000', receiptStatus: 'completed', cashed: true,
    cashing: { posted: true, reversed: false, date: '2026-06-01' }, ...overrides,
  };
}

function fakeClient(): pg.PoolClient {
  const query = async (text: string, params?: unknown[]): Promise<{ rows: unknown[] }> => {
    const sql = String(text).replace(/\s+/g, ' ');
    const p = params ?? [];
    queries.push({ sql, params: p });
    if (sql.includes('FROM account_roles')) {
      const roles = (p[1] ?? []) as string[];
      return { rows: roles.map((role) => ({ role, account_id: `acct:${role}` })) };
    }
    if (sql.includes('FROM journal_entry_lines l')) {
      const kept = noteLines.filter((l) =>
        (!sql.includes("WHERE l.tags ? 'held_restitution'") || l.held) &&
        (!sql.includes("cp.status = 'completed'") || l.receiptStatus === 'completed') &&
        (!sql.includes('cp.check_cashed_tx_id IS NOT NULL') || l.cashed) &&
        (!sql.includes("JOIN journal_entries c ON") || l.cashing !== null) &&
        (!sql.includes("c.status = 'posted'") || l.cashing?.posted === true) &&
        (!sql.includes('c.reversed_by_entry_id IS NULL') || l.cashing?.reversed === false));
      const byReceipt = new Map<string, { payment_id: string; payment_number: string; invoice_id: string; iva: number; day: string }>();
      for (const l of kept) {
        const day = sql.includes('GREATEST(m.entry_date, MAX(c.entry_date))') && l.cashing && l.cashing.date > mirrorDate
          ? l.cashing.date
          : mirrorDate;
        const row = byReceipt.get(l.payment) ?? { payment_id: l.payment, payment_number: `PMT-${l.payment}`, invoice_id: l.invoice, iva: 0, day };
        row.iva += Number(l.iva);
        byReceipt.set(l.payment, row);
      }
      return { rows: [...byReceipt.values()].map((r) => ({ ...r, iva: r.iva.toFixed(4) })) };
    }
    return { rows: [] };
  };
  return { query } as unknown as pg.PoolClient;
}

/** Each posted pair as [date, sourceId, lines as [account, debit, credit]]. */
function pairs(): Array<[string, string, Array<[string, string | null, string | null]>]> {
  return mockCreate.mock.calls.map((c) => [
    c[1] as string,
    (c[6] as { sourceId: string }).sourceId,
    (c[4] as Array<{ account_id: string; debit_amount: string | null; credit_amount: string | null }>)
      .map((l) => [l.account_id, l.debit_amount, l.credit_amount] as [string, string | null, string | null]),
  ]);
}

beforeEach(() => {
  mockCreate.mockClear();
  queries = [];
  mirrorDate = '2026-07-10';
  noteLines = [line()];
});

describe('followNoteReversal · the pair', () => {
  it('a held line whose cheque was cashed: DR 2150 / CR 2120 32.0000, dated with the mirror, tagged and sourced on the receipt', async () => {
    const out = await followNoteReversal(fakeClient(), NOTE, MIRROR, USER);
    expect(pairs()).toEqual([[
      '2026-07-10', 'pay-A',
      [['acct:anticipo_clientes', '32.0000', null], ['acct:iva_trasladado', null, '32.0000']],
    ]]);
    const [, , type, , lines, user, opts] = mockCreate.mock.calls[0] as [
      string, string, string, string, Array<{ tags?: Record<string, unknown> }>, string, Record<string, unknown>,
    ];
    expect(type).toBe('auto_payment');
    expect(user).toBe(USER);
    expect(opts).toMatchObject({ autoPost: true, sourceType: HELD_RESTITUTION_REVERSAL_SOURCE, sourceId: 'pay-A', reference: NOTE.entry_number });
    expect(lines[0].tags).toEqual({ [HELD_RESTITUTION_UNDONE_TAG]: { payment_id: 'pay-A', invoice_id: 'inv-S', note_entry_id: NOTE.id } });
    expect(lines[1].tags).toBeUndefined();
    expect(out).toEqual([{ id: 'pair:pay-A' }]);
  });

  it('the query is scoped to the entity, the note and its mirror', async () => {
    await followNoteReversal(fakeClient(), NOTE, MIRROR, USER);
    const read = queries.find((q) => q.sql.includes('FROM journal_entry_lines l'));
    expect(read?.params).toEqual([ENTITY, NOTE.id, MIRROR.id]);
    expect(read?.sql).toMatch(/je\.id = \$2 AND je\.entity_id = \$1/);
    expect(read?.sql).toMatch(/m\.id = \$3 AND m\.entity_id = \$1/);
    expect(read?.sql).toMatch(/cp\.entity_id = \$1/);
    expect(read?.sql).toMatch(/c\.entity_id = \$1/);
  });

  it('a mirror dated before the cashing: the pair takes the cashing\'s day', async () => {
    mirrorDate = '2026-05-28';
    await followNoteReversal(fakeClient(), NOTE, MIRROR, USER);
    expect(pairs().map((p) => p[0])).toEqual(['2026-06-01']);
  });

  it('two cheques on one note: one pair per receipt, each with its own share, the two lines of one cheque summed', async () => {
    noteLines = [
      line({ payment: 'pay-A', iva: '12.8000' }),
      line({ payment: 'pay-B', iva: '10.0000' }),
      line({ payment: 'pay-B', iva: '9.2000' }),
    ];
    const out = await followNoteReversal(fakeClient(), NOTE, MIRROR, USER);
    expect(pairs().map(([date, source, lines]) => [date, source, lines[0][1], lines[1][2]])).toEqual([
      ['2026-07-10', 'pay-A', '12.8000', '12.8000'],
      ['2026-07-10', 'pay-B', '19.2000', '19.2000'],
    ]);
    expect(out.map((e) => e.id)).toEqual(['pair:pay-A', 'pair:pay-B']);
  });
});

describe('followNoteReversal · when nothing is posted', () => {
  it.each([
    ['the note has no held_restitution line', { held: false }],
    ['the cheque is not cashed yet: the cashing causes the whole marker', { cashed: false, cashing: null }],
    ['the receipt names no cashing, even with a cashing entry standing', { cashed: false }],
    ['the cashing entry was reversed', { cashing: { posted: true, reversed: true, date: '2026-06-01' } }],
    ['the receipt was reversed: its mirrors took out what the cashing caused', { receiptStatus: 'reversed' as const }],
  ])('%s', async (_why, overrides) => {
    noteLines = [line(overrides)];
    expect(await followNoteReversal(fakeClient(), NOTE, MIRROR, USER)).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
    // Nothing to post, so not even the accounts are read.
    expect(queries.some((q) => q.sql.includes('FROM account_roles'))).toBe(false);
  });

  it('a held line whose IVA nets to zero posts nothing, and a receipt with IVA beside it still gets its pair', async () => {
    noteLines = [line({ payment: 'pay-A', iva: '0.0000' }), line({ payment: 'pay-B', iva: '32.0000' })];
    await followNoteReversal(fakeClient(), NOTE, MIRROR, USER);
    expect(pairs().map((p) => p[1])).toEqual(['pay-B']);
  });
});
