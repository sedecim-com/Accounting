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

import { cuentasDeEfectivo, ROLES_DE_EFECTIVO } from '../../../src/services/reporting/cash-flow-reconcile.js';
import { resolveCashAccounts } from '../../../src/services/reporting/cash-flow-service.js';
import { query } from '../../../src/database/connection.js';

const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const mockQuery = query as unknown as Mock;
const resolver = resolveCashAccounts as unknown as Mock;

beforeEach(() => {
  mockQuery.mockReset();
  resolver.mockClear();
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
