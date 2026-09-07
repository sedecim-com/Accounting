import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  // G3: los cuatro escritores del catálogo auditan, y `tenantDe`
  // (services/audit/audit-log.ts) pregunta primero por el inquilino del
  // CONTEXTO. Devolverlo aquí evita encolar además el SELECT a legal_entities
  // en cada prueba.
  currentTenant: vi.fn(() => 'tenant-1'),
}));

import {
  listAccounts,
  getAccountById,
  resolveAccount,
  createAccount,
  updateAccount,
  deactivateAccount,
  UPDATABLE_FIELDS,
} from '../../../src/services/accounting/account-service.js';
import { query, withTransaction } from '../../../src/database/connection.js';
import { NotFoundError, ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;
const mockTx = withTransaction as unknown as Mock;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER = 'user-1';

beforeEach(() => {
  mockQuery.mockReset();
  mockTx.mockReset();
  // El cuerpo de la transacción corre contra un cliente cuyo query() es el
  // MISMO mock, para que las secuencias `mockResolvedValueOnce` y los índices
  // de `sql(n)`/`params(n)` sigan viendo las sentencias en orden de llamada.
  mockTx.mockImplementation((fn: (c: { query: unknown }) => unknown) => fn({ query: mockQuery }));
});

const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');
// Tipado como `unknown[]` y no dejado en `any`: sin esto cada `params(n)[i]`
// de este fichero cuenta una advertencia de acceso inseguro, y son decenas.
const params = (call: number): unknown[] => mockQuery.mock.calls[call][1] as unknown[];

describe('listAccounts', () => {
  it('reports the true total so a caller can detect truncation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '412' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ code: '1110' }] });
    const page = await listAccounts(ENTITY, { limit: 1 });
    expect(page.total).toBe(412);
    expect(page.rows).toHaveLength(1);
  });

  it('scopes every query to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listAccounts(ENTITY);
    expect(sql(0)).toMatch(/WHERE entity_id = \$1/);
    expect(params(0)[0]).toBe(ENTITY);
    expect(params(1)[0]).toBe(ENTITY);
  });

  it('matches the search term against both code and name', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '2' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listAccounts(ENTITY, { search: 'banco' });
    expect(sql(0)).toMatch(/\(code ILIKE \$2 OR name ILIKE \$2\)/);
    expect(params(0)[1]).toBe('%banco%');
  });

  it('combines filters without renumbering the placeholders wrongly', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listAccounts(ENTITY, { accountType: 'asset', isActive: true, parentId: 'p1', search: 'x' });
    expect(params(0)).toEqual([ENTITY, 'asset', true, 'p1', '%x%']);
    expect(sql(0)).toMatch(/account_type = \$2 AND is_active = \$3 AND parent_id = \$4/);
  });

  it('counts children in one pass rather than a query per row', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await listAccounts(ENTITY);
    expect(sql(1)).toMatch(/SELECT COUNT\(\*\) FROM accounts c WHERE c\.parent_id = a\.id/);
    expect(mockQuery.mock.calls).toHaveLength(2);
  });
});

describe('getAccountById', () => {
  it('returns null instead of throwing, so callers choose the error', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await getAccountById('x')).toBeNull();
  });

  it('computes balance as lifetime ACTIVITY, never a sum of ending balances', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1', code: '1110' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '1500.00' }] });
    const account = await getAccountById('a1', { includeBalance: true });
    expect(account?.current_balance).toBe('1500.00');
    // Summing ending_balance would double-count carried-forward periods.
    expect(sql(1)).toMatch(/SUM\(debit_total - credit_total\)/);
    expect(sql(1)).not.toMatch(/ending_balance/);
  });

  it('joins the parent only when the hierarchy was asked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1' }] });
    await getAccountById('a1');
    expect(sql(0)).not.toMatch(/LEFT JOIN/);

    mockQuery.mockReset();
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1' }] });
    await getAccountById('a1', { includeHierarchy: true });
    expect(sql(0)).toMatch(/LEFT JOIN accounts p ON p\.id = a\.parent_id/);
  });
});

describe('resolveAccount — what a person types vs what the tables hold', () => {
  it('looks up a code, scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1', code: '1110' }] });
    await resolveAccount(ENTITY, '1110');
    expect(sql(0)).toMatch(/WHERE code = \$1 AND entity_id = \$2/);
    expect(params(0)).toEqual(['1110', ENTITY]);
  });

  it('looks up a uuid by id, still scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: ENTITY }] });
    await resolveAccount(ENTITY, ENTITY);
    expect(sql(0)).toMatch(/WHERE id = \$1 AND entity_id = \$2/);
  });

  it('throws NotFound naming what was looked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(resolveAccount(ENTITY, '9999')).rejects.toThrow(
      expect.objectContaining({ name: 'NotFoundError', message: expect.stringContaining('9999') })
    );
  });
});

describe('createAccount', () => {
  const base = {
    code: '5100', name: 'Gastos', account_type: 'expense' as const,
    normal_balance: 'debit' as const, entity_id: ENTITY, created_by: USER,
  };

  it('rejects a duplicate code as a conflict, not a raw constraint error', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'existing' }] });
    await expect(createAccount(base)).rejects.toThrow(
      expect.objectContaining({ name: 'ConflictError', message: expect.stringContaining('"5100" already exists') })
    );
  });

  it('makes a header account reject manual entries, satisfying the table CHECK', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new', code: '5100' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // G3: el INSERT del rastro
    await createAccount({ ...base, is_header: true });
    // allow_manual_entries is the 11th parameter, is_header the 12th
    expect(params(1)[10]).toBe(false);
    expect(params(1)[11]).toBe(true);
  });

  it('refuses the contradiction rather than letting the database raise it', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      createAccount({ ...base, is_header: true, allow_manual_entries: true })
    ).rejects.toThrow(ValidationError);
  });

  it('leaves a postable account accepting manual entries', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await createAccount(base);
    expect(params(1)[10]).toBe(true);
    expect(params(1)[11]).toBe(false);
  });

  // G3: una cuenta es el DESTINO del dinero; crearla sin decir quién es el
  // hueco que el argumento de venta del producto no puede permitirse.
  it('leaves an audit row, in the same transaction, with the account it created', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'new', code: '5100', is_active: true }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await createAccount(base);

    expect(mockTx).toHaveBeenCalledTimes(1);
    expect(sql(2)).toMatch(/INSERT INTO audit_log/);
    const p = params(2);
    expect(p[1]).toBe(USER);
    expect(p[2]).toBe('tenant-1');
    expect(p[3]).toBe('create');
    expect(p[4]).toBe('account');
    expect(p[5]).toBe('new');
    expect(p[6]).toBeNull();                 // old_values: no había antes
    expect(String(p[7])).toContain('"code":"5100"');
  });
});

describe('updateAccount', () => {
  // G3: la secuencia lleva delante un SELECT ... FOR UPDATE. No es un viaje
  // de más: es a la vez el `old_values` del rastro —sin él la bitácora diría
  // «cambió el nombre» sin decir desde cuál— y el candado que impide que dos
  // ediciones simultáneas dejen el estado de una y el antes de la otra.
  it('locks and reads the before-image before writing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1', entity_id: 'e-1', name: 'Viejo' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1', name: 'Nuevo' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await updateAccount('a1', { name: 'Nuevo' }, USER);
    expect(sql(0)).toMatch(/SELECT \* FROM accounts WHERE id = \$1 FOR UPDATE/);
  });

  it('writes only whitelisted fields', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1', entity_id: 'e-1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await updateAccount('a1', { name: 'Nuevo', is_active: false }, USER);
    expect(sql(1)).toMatch(/SET name = \$1, is_active = \$2, updated_at = NOW\(\), updated_by = \$3/);
  });

  it('names the updatable fields when given none of them', async () => {
    await expect(updateAccount('a1', {}, USER)).rejects.toThrow(
      new RegExp(UPDATABLE_FIELDS.join(', '))
    );
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('serialises tags as JSON, matching the JSONB column', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1', entity_id: 'e-1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'a1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await updateAccount('a1', { tags: ['a', 'b'] }, USER);
    expect(params(1)[0]).toBe('["a","b"]');
  });

  it('throws NotFound when the row does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(updateAccount('gone', { name: 'x' }, USER)).rejects.toThrow(NotFoundError);
    // Y no llegó a intentar el UPDATE: la fila inexistente se detecta al
    // leerla, no por un rowCount después de escribir.
    expect(mockQuery.mock.calls).toHaveLength(1);
  });

  // G3: sólo los campos TOCADOS, con su antes y su después. El documento
  // entero en cada edición haría ilegible la pregunta que el rastro contesta.
  it('audits only the fields that changed, with the value before and after', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'a1', entity_id: 'e-1', name: 'Viejo', description: 'igual' }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'a1', entity_id: 'e-1', name: 'Nuevo', description: 'igual' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await updateAccount('a1', { name: 'Nuevo' }, USER, 'error de captura');

    expect(sql(2)).toMatch(/INSERT INTO audit_log/);
    const p = params(2);
    expect(JSON.parse(String(p[6]))).toEqual({ name: 'Viejo' });
    expect(JSON.parse(String(p[7]))).toEqual({ name: 'Nuevo' });
    expect(p[8]).toBe('error de captura');
  });
});

describe('deactivateAccount — retiring is not deleting', () => {
  it('refuses an account with history by default (the DELETE rule)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    await expect(deactivateAccount('a1', USER)).rejects.toThrow(ValidationError);
    // Nothing was written.
    expect(mockQuery.mock.calls).toHaveLength(1);
  });

  // F01: entre el conteo de historia y el UPDATE viaja ahora la consulta del
  // saldo de por vida (la regla del archivado); la secuencia lo refleja.
  // G3: la escritura viaja ahora en transacción y lleva delante el
  // SELECT ... FOR UPDATE de la fila anterior (candado + `old_values`) y
  // detrás el INSERT del rastro. La secuencia lo refleja.
  const ANTES = { rows: [{ entity_id: 'e-1', code: '5100', is_active: true }] };

  it('allows it when the caller can justify itself, and reports history and balance', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '150.0000' }] });
    mockQuery.mockResolvedValueOnce(ANTES);
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const result = await deactivateAccount('a1', USER, { allowWithHistory: true });
    expect(result.hadHistory).toBe(true);
    expect(result.balance).toBe('150.0000');
    expect(sql(3)).toMatch(/SET is_active = false/);
  });

  it('never issues a DELETE — history has to survive', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] });
    mockQuery.mockResolvedValueOnce(ANTES);
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await deactivateAccount('a1', USER);
    expect(sql(3)).not.toMatch(/DELETE/i);
    // Y el rastro llama al acto 'update', no 'delete': archivar no borra, y
    // un lector que filtre por acción no puede leer una cosa por la otra.
    expect(params(4)[3]).toBe('update');
  });

  it('throws NotFound when the account is gone', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(deactivateAccount('gone', USER)).rejects.toThrow(NotFoundError);
  });

  // G3: el rastro guarda el saldo y si había historia — las dos condiciones
  // que el archivado evalúa— para no tener que recalcularlas medio año
  // después, cuando alguien pregunte por qué se archivó con saldo vivo.
  it('records the balance and the history flag it decided on', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '150.0000' }] });
    mockQuery.mockResolvedValueOnce(ANTES);
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await deactivateAccount('a1', USER, { allowWithHistory: true, reason: 'cierre' });

    expect(sql(4)).toMatch(/INSERT INTO audit_log/);
    const nuevos = JSON.parse(String(params(4)[7])) as Record<string, unknown>;
    expect(nuevos.is_active).toBe(false);
    expect(nuevos.had_history).toBe(true);
    expect(nuevos.balance_at_archive).toBe('150.0000');
    expect(nuevos.forced_with_balance).toBe(true);
    expect(params(4)[8]).toBe('cierre');
  });

  it('F01: la regla del archivado — saldo vivo bloquea salvo fuerza, y dry-run no escribe', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '150.0000' }] });
    await expect(
      deactivateAccount('a1', USER, { allowWithHistory: true, enforceZeroBalance: true })
    ).rejects.toThrow(/saldo vivo/);
    expect(mockQuery.mock.calls).toHaveLength(2); // nada se escribió

    mockQuery.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '7' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0.0000' }] });
    const seco = await deactivateAccount('a1', USER, {
      allowWithHistory: true, enforceZeroBalance: true, dryRun: true,
    });
    expect(seco.balance).toBe('0.0000');
    expect(mockQuery.mock.calls).toHaveLength(2); // dry-run: sin UPDATE
  });
});
