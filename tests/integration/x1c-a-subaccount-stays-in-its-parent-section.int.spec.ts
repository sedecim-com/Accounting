import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createAccount, updateAccount } from '../../src/services/accounting/account-service.js';
import { coherenceOfOwnRow, sectionOfCategory } from '../../src/services/accounting/parent-child-coherence.js';
import { ValidationError } from '../../src/utils/errors.js';

// ============================================================
// X1c · A SUBACCOUNT STAYS IN ITS PARENT'S SECTION
//
// Nothing tied a child account's `fs_category` to its parent's, so an expense
// account could hang under an asset and every statement would still foot: the
// amount just lands in the wrong section of a document somebody signs.
//
// The rule is SAME SECTION and not same category, and that is measured rather
// than argued — the first assertion below re-measures it against the seeded
// catalogue on every run, so the claim cannot rot the way a comment would.
// ============================================================

let fx: Fixture;

async function accountsOf(entityId: string) {
  const { rows } = await query<{
    code: string;
    account_type: string;
    fs_category: string | null;
    parent_code: string | null;
    parent_fs: string | null;
  }>(
    `SELECT a.code, a.account_type, a.fs_category,
            p.code AS parent_code, p.fs_category AS parent_fs
       FROM accounts a LEFT JOIN accounts p ON p.id = a.parent_id
      WHERE a.entity_id = $1`,
    [entityId]
  );
  return rows;
}

beforeAll(async () => {
  fx = await crearInquilino('x1c-coherencia');
});

afterAll(async () => {
  await closeDatabase();
});

describe('the rule the seeded catalogue actually satisfies', () => {
  it('same SECTION holds for every seeded edge; same CATEGORY does not', async () => {
    const rows = await accountsOf(fx.entityId);
    const edges = rows.filter((r) => r.parent_code !== null && r.fs_category && r.parent_fs);
    expect(edges.length).toBeGreaterThan(20);

    const sameCategory = edges.filter((r) => r.fs_category === r.parent_fs);
    const sameSection = edges.filter(
      (r) => sectionOfCategory(r.fs_category) === sectionOfCategory(r.parent_fs)
    );

    // Esto es el hallazgo, medido en cada corrida y no citado de memoria: la
    // igualdad es FALSA en el catálogo que el propio producto siembra.
    expect(sameCategory.length).toBeLessThan(edges.length);
    expect(sameSection.length).toBe(edges.length);
  });

  it('the section map agrees with the partition account_type already draws', async () => {
    // El apoyo INDEPENDIENTE del mapa: no se comprueba contra las mismas filas
    // que lo motivaron, sino contra cada cuenta del catálogo.
    const rows = await accountsOf(fx.entityId);
    const disagreeing = rows.filter((r) => !coherenceOfOwnRow(r.account_type, r.fs_category));
    expect(disagreeing).toEqual([]);
  });
});

describe('creating an account', () => {
  it('refuses a child whose category lands in another section, and names both', async () => {
    const parent = await createAccount({
      code: 'X1C-100', name: 'Padre activo', account_type: 'asset',
      normal_balance: 'debit', fs_category: 'current_assets',
      entity_id: fx.entityId, created_by: fx.userId, is_header: true, allow_manual_entries: false,
    });

    await expect(
      createAccount({
        code: 'X1C-110', name: 'Hija gasto', account_type: 'expense',
        normal_balance: 'debit', fs_category: 'operating_expenses',
        parent_id: parent.id, entity_id: fx.entityId, created_by: fx.userId,
      })
    ).rejects.toThrow(ValidationError);
  });

  it('accepts a child in another CATEGORY of the same section', async () => {
    const parent = await createAccount({
      code: 'X1C-200', name: 'Activo', account_type: 'asset',
      normal_balance: 'debit', fs_category: 'current_assets',
      entity_id: fx.entityId, created_by: fx.userId, is_header: true, allow_manual_entries: false,
    });
    const child = await createAccount({
      code: 'X1C-210', name: 'Activo fijo', account_type: 'asset',
      normal_balance: 'debit', fs_category: 'non_current_assets',
      parent_id: parent.id, entity_id: fx.entityId, created_by: fx.userId,
    });
    expect(child.fs_category).toBe('non_current_assets');
  });

  it('does not judge an edge whose parent has no category', async () => {
    // La importación del SAT deja la columna vacía en los DOS lados de cada
    // arista que crea: una regla que leyera la ausencia como falta impediría
    // a un despacho migrar su propio catálogo.
    const parent = await createAccount({
      code: 'X1C-300', name: 'Sin categoría', account_type: 'asset',
      normal_balance: 'debit', entity_id: fx.entityId, created_by: fx.userId,
      is_header: true, allow_manual_entries: false,
    });
    const child = await createAccount({
      code: 'X1C-310', name: 'Hija de una sin categoría', account_type: 'expense',
      normal_balance: 'debit', fs_category: 'operating_expenses',
      parent_id: parent.id, entity_id: fx.entityId, created_by: fx.userId,
    });
    expect(child.fs_category).toBe('operating_expenses');
  });
});

describe('editing a category has two sides', () => {
  it('refuses an edit that would break the edge with its PARENT', async () => {
    const parent = await createAccount({
      code: 'X1C-400', name: 'Activo', account_type: 'asset',
      normal_balance: 'debit', fs_category: 'current_assets',
      entity_id: fx.entityId, created_by: fx.userId, is_header: true, allow_manual_entries: false,
    });
    const child = await createAccount({
      code: 'X1C-410', name: 'Hija', account_type: 'asset',
      normal_balance: 'debit', fs_category: 'non_current_assets',
      parent_id: parent.id, entity_id: fx.entityId, created_by: fx.userId,
    });

    await expect(
      updateAccount(fx.entityId, child.id, { fs_category: 'operating_expenses' }, fx.userId)
    ).rejects.toThrow(ValidationError);
  });

  it('refuses an edit that would break the edge with its CHILDREN', async () => {
    // El lado que nadie miraba: editar el PADRE deja huérfanas de sección a sus
    // hijas, y ninguna consulta del árbol preguntaba por ellas.
    const parent = await createAccount({
      code: 'X1C-500', name: 'Activo', account_type: 'asset',
      normal_balance: 'debit', fs_category: 'current_assets',
      entity_id: fx.entityId, created_by: fx.userId, is_header: true, allow_manual_entries: false,
    });
    await createAccount({
      code: 'X1C-510', name: 'Hija', account_type: 'asset',
      normal_balance: 'debit', fs_category: 'non_current_assets',
      parent_id: parent.id, entity_id: fx.entityId, created_by: fx.userId,
    });

    await expect(
      updateAccount(fx.entityId, parent.id, { fs_category: 'revenue' }, fx.userId)
    ).rejects.toThrow(ValidationError);
  });

  it('allows an edit that keeps every edge inside its section', async () => {
    const parent = await createAccount({
      code: 'X1C-600', name: 'Activo', account_type: 'asset',
      normal_balance: 'debit', fs_category: 'current_assets',
      entity_id: fx.entityId, created_by: fx.userId, is_header: true, allow_manual_entries: false,
    });
    const child = await createAccount({
      code: 'X1C-610', name: 'Hija', account_type: 'asset',
      normal_balance: 'debit', fs_category: 'current_assets',
      parent_id: parent.id, entity_id: fx.entityId, created_by: fx.userId,
    });

    const updated = await updateAccount(
      fx.entityId, child.id, { fs_category: 'non_current_assets' }, fx.userId
    );
    expect(updated.fs_category).toBe('non_current_assets');
  });
});
