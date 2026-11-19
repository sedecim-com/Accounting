import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import Decimal from 'decimal.js';

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
// Spied, not replaced: the real report-layer queries run against the mocked
// connection, and the spies prove the AP control reads them (T14 · #101,
// MNE-001-435), as tests/services/ar/ar-controls.spec.ts does for AR.
vi.mock('../../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/reporting/report-service.js')>();
  return {
    ...real,
    queryAccumulatedBalances: vi.fn(real.queryAccumulatedBalances),
    queryEntryMovementsOnAccount: vi.fn(real.queryEntryMovementsOnAccount),
  };
});
vi.mock('../../../src/services/accounting/fx-revaluation.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/accounting/fx-revaluation.js')>();
  return { ...real, revaluationOnAccount: vi.fn(async () => new Decimal(0)) };
});

import { apReconcile, ORIGENES_CXP } from '../../../src/services/ap/ap-controls.js';
import { query } from '../../../src/database/connection.js';
import {
  queryAccumulatedBalances,
  queryEntryMovementsOnAccount,
} from '../../../src/services/reporting/report-service.js';
import { FX_REVALUATION_SOURCE } from '../../../src/services/accounting/fx-revaluation.js';

const mockQuery = query as unknown as Mock;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CONTROL = 'acc-2110';
const flat = (s: unknown) => String(s).replace(/\s+/g, ' ');

interface Ledger {
  balance?: string;
  manual?: Record<string, unknown>[];
  bills?: Record<string, unknown>[];
  nets?: Record<string, unknown>[];
}

/**
 * Answers by SQL text, not by call order: the move changes the order and the
 * number of statements, and the figures must not depend on either.
 */
function books(l: Ledger): void {
  mockQuery.mockImplementation(async (raw: string) => {
    const sql = flat(raw);
    if (/FROM account_roles/.test(sql)) return { rows: [{ id: CONTROL, code: '2110', name: 'Proveedores' }] };
    if (/AS balance FROM accounts a/.test(sql)) {
      return { rows: l.balance ? [{ account_id: CONTROL, balance: l.balance }] : [] };
    }
    if (/AS total_entries/.test(sql)) return { rows: /AND je\.id = ANY/.test(sql) ? (l.nets ?? []) : (l.manual ?? []) };
    if (/FROM users/.test(sql)) return { rows: [{ id: 'u-1', email: 'ana@example.test' }] };
    if (/source_type = 'opening_balance'/.test(sql)) return { rows: [{ id: 'je-open' }] };
    if (/SUM\(b\.amount_due\)/.test(sql)) {
      return { rows: [{ currency: 'MXN', functional: true, foreign: '1250.0000', book: '1250.0000' }] };
    }
    if (/fecha_asiento/.test(sql)) return { rows: l.bills ?? [] };
    return { rows: [] };
  });
}

const bill = (n: number, entry: string) => ({
  bill_number: `B-${n}`,
  fecha: '2026-03-05',
  status: 'void',
  proveedor: 'Proveedor Sintético',
  journal_entry_id: entry,
  entry_number: `PD-${entry}`,
  fecha_asiento: '2026-03-05',
});

beforeEach(() => {
  mockQuery.mockReset();
  vi.mocked(queryAccumulatedBalances).mockClear();
  vi.mocked(queryEntryMovementsOnAccount).mockClear();
});

describe('apReconcile reads the ledger through report-service (MNE-001-435)', () => {
  it('the control balance, the manual entries and the per-bill net come from the report layer', async () => {
    books({
      // Debit-positive in the layer: a liability of 1 000 reads −1 000.
      balance: '-1000.0000',
      manual: [
        { journal_entry_id: 'je-m1', entry_number: 'PD-0002', entry_date: new Date(2026, 2, 20), description: 'Ajuste',
          created_by: 'u-1', amount: '-750.0000', total_amount: '-550.0000', total_entries: 3 },
        { journal_entry_id: 'je-m2', entry_number: 'PD-0001', entry_date: new Date(2026, 2, 10), description: null,
          created_by: 'u-2', amount: '200.0000', total_amount: '-550.0000', total_entries: 3 },
      ],
      bills: [bill(3, 'je-a'), bill(2, 'je-b'), bill(1, 'je-c')],
      // je-b nets to zero on the control and je-c has no line on it: neither is listed.
      nets: [
        { journal_entry_id: 'je-a', amount: '-300.0000' },
        { journal_entry_id: 'je-b', amount: '0.0000' },
      ],
    });

    const r = await apReconcile(ENTITY, { asOf: '2026-03-31' });

    expect(queryAccumulatedBalances).toHaveBeenCalledWith(
      ENTITY,
      { date: '2026-03-31', inclusive: true },
      { ignoreClosingPolicy: true, accountId: CONTROL }
    );
    expect(queryEntryMovementsOnAccount).toHaveBeenCalledWith(ENTITY, CONTROL, {
      excludeSourceTypes: [...ORIGENES_CXP, FX_REVALUATION_SOURCE],
      excludeEntryIds: ['je-open'],
      asOf: '2026-03-31',
      order: 'newest',
      limit: 200,
    });
    expect(queryEntryMovementsOnAccount).toHaveBeenCalledWith(ENTITY, CONTROL, { entryIds: ['je-a', 'je-b', 'je-c'] });

    // By hand: subledger 1 250 − ledger 1 000 = 250. The manual entries net
    // 550 of credit over all three (two listed): −750 + 200. The dead bill
    // je-a leaves 300 of credit: −300. Explained −850, unexplained 1 100.
    expect(r.mayor).toBe('1000.00');
    expect(r.subdiario).toBe('1250.00');
    expect(r.diferencia).toBe('250.00');
    expect(r.cuadra).toBe(false);
    expect(r.partidas.map((p) => [p.tipo, p.referencia, p.fecha, p.importe])).toEqual([
      ['asiento-manual', 'PD-0002', '2026-03-20', '-750.00'],
      ['asiento-manual', 'PD-0001', '2026-03-10', '200.00'],
      ['asiento-sin-gasto', 'B-3', '2026-03-05', '-300.00'],
      ['residuo', 'sin explicar', null, '1100.00'],
    ]);
    expect(r.explicado).toBe('-850.00');
    expect(r.sinExplicar).toBe('1100.00');
    expect(r.omitidas).toBe(1);
    // The creator: the email when the user exists, the uuid when it does not.
    expect(r.partidas[0].detalle).toContain('ana@example.test');
    expect(r.partidas[1].detalle).toContain('u-2');
  });

  it('the per-bill total and count are over every live bill, and the list stops at the cap', async () => {
    const bills = Array.from({ length: 201 }, (_, i) => bill(201 - i, `je-${i}`));
    books({
      balance: '-1250.0000',
      bills,
      nets: bills.map((b) => ({ journal_entry_id: b.journal_entry_id, amount: '-1.0000' })),
    });

    const r = await apReconcile(ENTITY, { asOf: '2026-03-31' });

    // 201 dead bills of 1 each: −201 explained over all of them, 200 listed
    // in SQL order (B-201 first), one omitted, and the residue is the 201.
    const listed = r.partidas.filter((p) => p.tipo === 'asiento-sin-gasto');
    expect(listed).toHaveLength(200);
    expect(listed[0].referencia).toBe('B-201');
    expect(listed[199].referencia).toBe('B-2');
    expect(r.diferencia).toBe('0.00');
    expect(r.explicado).toBe('-201.00');
    expect(r.sinExplicar).toBe('201.00');
    expect(r.omitidas).toBe(1);
  });

  it('with no manual entry and no dead bill, it asks for no user and no net', async () => {
    books({ balance: '-1250.0000' });

    const r = await apReconcile(ENTITY, { asOf: '2026-03-31' });

    expect(r.cuadra).toBe(true);
    expect(r.partidas).toEqual([]);
    expect(queryEntryMovementsOnAccount).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls.some(([s]) => /FROM users/.test(flat(s)))).toBe(false);
  });
});
