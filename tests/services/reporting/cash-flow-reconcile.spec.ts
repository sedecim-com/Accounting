import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ============================================================
// MNE-001-438 (#101) · THE TIE-OUT READS THE STATEMENT'S CASH ACCOUNTS
//
// «Which accounts are cash» was written twice, once for the statement and
// once for its tie-out against the ledger. Now the tie-out asks the
// statement's one resolver, and keeps its own shape: { account_id, code,
// name, via }, and an empty set handed back for its caller to refuse.
//
// The tie-out module is imported FIRST here, ahead of the statement it now
// imports: the two modules import each other, and this spec pins that the
// cycle resolves in this order too (cash-flow-service.spec.ts loads the other).
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  currentTenant: vi.fn(() => 'tenant-1'),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));
vi.mock('../../../src/services/reporting/cash-flow-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/reporting/cash-flow-service.js')>();
  return { ...real, resolveCashAccounts: vi.fn(real.resolveCashAccounts) };
});
// MNE-001-433: the real cash movement reads the ledger through report-service.
// The real helper runs (its SQL reaches the mocked `query`), wrapped in a spy
// so a test can say which layer was asked, with what, and how many times.
vi.mock('../../../src/services/reporting/report-service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/services/reporting/report-service.js')>();
  return { ...real, queryOpeningAndMovement: vi.fn(real.queryOpeningAndMovement) };
});

import {
  cuentasDeEfectivo,
  movimientoRealDeEfectivo,
  ROLES_DE_EFECTIVO,
} from '../../../src/services/reporting/cash-flow-reconcile.js';
import { resolveCashAccounts } from '../../../src/services/reporting/cash-flow-service.js';
import { queryOpeningAndMovement } from '../../../src/services/reporting/report-service.js';
import { query } from '../../../src/database/connection.js';

const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const mockQuery = query as unknown as Mock;
const resolver = resolveCashAccounts as unknown as Mock;
const cashReader = queryOpeningAndMovement as unknown as Mock;

beforeEach(() => {
  mockQuery.mockReset();
  resolver.mockClear();
  cashReader.mockClear();
});

describe('cuentasDeEfectivo — the tie-out asks the statement\'s resolver', () => {
  it('calls the one resolver and maps its rows to the tie-out\'s shape', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'id-1110', code: '1110', name: 'Caja y Bancos', via: 'rol' },
        { id: 'id-1185', code: '1185', name: 'Banco Extranjero', via: 'cuenta_bancaria' },
      ],
    });
    expect(await cuentasDeEfectivo(ENTITY, 'rol')).toEqual([
      { account_id: 'id-1110', code: '1110', name: 'Caja y Bancos', via: 'rol' },
      { account_id: 'id-1185', code: '1185', name: 'Banco Extranjero', via: 'cuenta_bancaria' },
    ]);
    expect(resolver.mock.calls).toEqual([[ENTITY, 'rol']]);
    expect(mockQuery.mock.calls[0][1]).toEqual([ENTITY, ROLES_DE_EFECTIVO]);
  });

  it('hands an empty set back without refusing it: movimientoRealDeEfectivo names the way out', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await cuentasDeEfectivo(ENTITY, 'subtipo')).toEqual([]);
    expect(resolver.mock.calls).toEqual([[ENTITY, 'subtipo']]);
  });

  it('refuses «lista» with the one message, before any query', async () => {
    await expect(cuentasDeEfectivo(ENTITY, 'lista')).rejects.toThrow(/cashflow category set/);
    await expect(cuentasDeEfectivo(ENTITY, 'lista')).rejects.toThrow(/pending define flujo_efectivo_cuentas_de_efectivo/);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});

describe('movimientoRealDeEfectivo — the tie-out reads its cash through report-service (MNE-001-433)', () => {
  const CASH = [
    { id: 'id-1110', code: '1110', name: 'Caja y Bancos', via: 'rol' },
    { id: 'id-1111', code: '1111', name: 'Bancos', via: 'rol' },
  ];

  it('asks queryOpeningAndMovement once, with the cash ids and the range, and keeps its shape', async () => {
    // February by hand: 3 800.00 before the 1st; +900.00 collected and +77.00
    // of a closing-type entry inside, which counts: 977.00, ending at 4 777.00.
    mockQuery
      .mockResolvedValueOnce({ rows: CASH })
      .mockResolvedValueOnce({ rows: [{ opening: '3800.0000', movement: '977.0000' }] });
    const m = await movimientoRealDeEfectivo(ENTITY, {
      startDate: '2026-02-01',
      endDate: '2026-02-28',
      criterio: 'rol',
    });
    expect(cashReader.mock.calls).toEqual([
      [ENTITY, { accountIds: ['id-1110', 'id-1111'], startDate: '2026-02-01', endDate: '2026-02-28' }],
    ]);
    // The cash accounts, then ONE ledger statement: one snapshot, never one per account.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(m).toEqual({
      criterio: 'rol',
      criterio_definido: true,
      cuentas: [
        { account_id: 'id-1110', code: '1110', name: 'Caja y Bancos', via: 'rol' },
        { account_id: 'id-1111', code: '1111', name: 'Bancos', via: 'rol' },
      ],
      saldo_inicial: '3800.0000',
      saldo_final: '4777.0000',
      variacion: '977.0000',
    });
  });

  it('a range that ends before it starts is passed on as given: the opening at the end, no movement', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: CASH })
      .mockResolvedValueOnce({ rows: [{ opening: '5000.0000', movement: '0' }] });
    const m = await movimientoRealDeEfectivo(ENTITY, {
      startDate: '2026-03-01',
      endDate: '2026-01-15',
      criterio: 'rol',
    });
    expect(cashReader.mock.calls[0][1]).toEqual({
      accountIds: ['id-1110', 'id-1111'],
      startDate: '2026-03-01',
      endDate: '2026-01-15',
    });
    expect([m.saldo_inicial, m.variacion, m.saldo_final]).toEqual(['5000.0000', '0.0000', '5000.0000']);
  });

  it('an empty cash set is refused before the ledger is read', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      movimientoRealDeEfectivo(ENTITY, { startDate: '2026-01-01', endDate: '2026-01-31', criterio: 'rol' })
    ).rejects.toThrow(/account role set efectivo/);
    expect(cashReader).not.toHaveBeenCalled();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});
