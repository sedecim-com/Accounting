import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase } from '../../src/database/connection.js';
import { getPeriodCloseStatus, softClosePeriod } from '../../src/services/accounting/period-close.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';

// ============================================================
// El checklist del cierre daba verde por VACUIDAD: con cero
// cuentas bancarias el COUNT de «sin conciliar» era 0, y el
// cierre se firmaba con «Bank reconciliations complete» sin que
// nadie hubiera mirado nada. Igual su gemelo de depreciación con
// cero activos. Estas pruebas clavan la distinción: un universo
// vacío NO es «revisado y bien» —el item lo confiesa— pero
// tampoco bloquea el cierre, porque impedir cerrar por no tener
// banco registrado sería una decisión de producto que el código
// no toma solo.
// ============================================================

let f: Fixture;

beforeAll(async () => {
  f = await crearInquilino('Checklist honesto ante el vacío');
});

afterAll(async () => {
  await closeDatabase();
});

type Item = { item: string; is_complete: boolean; details?: string };

async function checklistDe(mes: number): Promise<{ items: Record<string, Item>; can_close: boolean; warnings: string[] }> {
  const st = await getPeriodCloseStatus(f.periodos[mes], f.entityId);
  const items: Record<string, Item> = {};
  for (const i of st.checklist) items[i.item] = i;
  return { items, can_close: st.can_close, warnings: st.warnings };
}

describe('universo vacío: el item confiesa que no comprobó nada', () => {
  it('con cero cuentas bancarias, conciliación NO es «complete» y su texto lo explica', async () => {
    const { items } = await checklistDe(1);
    const banco = items['Bank reconciliations complete'];
    expect(banco.is_complete).toBe(false);
    expect(banco.details).toBe('0 cuentas bancarias registradas: no se pudo comprobar');
  });

  it('con cero activos fijos, depreciación NO es «complete» y su texto lo explica', async () => {
    const { items } = await checklistDe(1);
    const dep = items['Depreciation calculated and posted'];
    expect(dep.is_complete).toBe(false);
    expect(dep.details).toBe('0 activos fijos registrados: no se pudo comprobar');
  });

  it('el vacío no bloquea ni avisa: el periodo cierra en suave de todos modos', async () => {
    const { can_close, warnings } = await checklistDe(1);
    expect(can_close).toBe(true);
    expect(warnings.some((w) => /reconcil/i.test(w))).toBe(false);
    expect(warnings.some((w) => /depreciation/i.test(w))).toBe(false);

    const p = await softClosePeriod(f.periodos[1], f.entityId, f.userId);
    expect(p.status).toBe('soft_close');
    // Y lo que queda escrito en el periodo es la confesión, no el verde.
    const guardado = (await query<{ close_checklist: Item[] }>(
      'SELECT close_checklist FROM fiscal_periods WHERE id = $1',
      [f.periodos[1]]
    )).rows[0].close_checklist;
    const banco = guardado.find((i) => i.item === 'Bank reconciliations complete')!;
    expect(banco.is_complete).toBe(false);
    expect(banco.details).toMatch(/no se pudo comprobar/);
  });
});

describe('universo poblado: la semántica de siempre sigue intacta', () => {
  let cuentaBancaria: string;
  let activo: string;

  beforeAll(async () => {
    cuentaBancaria = uuidv4();
    await query(
      `INSERT INTO bank_accounts (id, entity_id, account_name, bank_name, gl_account_id, currency_code, is_active)
       VALUES ($1, $2, 'Operativa', 'Banco de prueba', $3, 'MXN', true)`,
      [cuentaBancaria, f.entityId, f.roles.banco]
    );

    const categoria = uuidv4();
    await query(
      `INSERT INTO asset_categories (id, entity_id, name) VALUES ($1, $2, 'Equipo de cómputo')`,
      [categoria, f.entityId]
    );
    activo = uuidv4();
    await query(
      `INSERT INTO fixed_assets (id, entity_id, asset_number, asset_name, category_id,
         acquisition_date, acquisition_cost, salvage_value, useful_life_years, useful_life_months,
         depreciation_method, depreciation_start_date, current_book_value,
         asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
         status, created_by)
       VALUES ($1, $2, 'AF-001', 'Laptop', $3,
         '2026-01-15', '20000.0000', '0', 3, 36,
         'straight_line', '2026-02-01', '20000.0000',
         $4, $5, $6, 'active', $7)`,
      [activo, f.entityId, categoria, f.roles.banco, f.roles.cxc, f.roles.ingreso, f.userId]
    );
  });

  it('una cuenta sin conciliar sigue saliendo en el item y en los avisos', async () => {
    const { items, warnings, can_close } = await checklistDe(2);
    const banco = items['Bank reconciliations complete'];
    expect(banco.is_complete).toBe(false);
    expect(banco.details).toBe('1 accounts not reconciled');
    expect(warnings).toContain('1 bank accounts not reconciled');
    expect(can_close).toBe(true); // sigue siendo aviso, no bloqueo
  });

  it('un activo sin depreciación posteada sigue saliendo en el item y en los avisos', async () => {
    const { items, warnings } = await checklistDe(2);
    const dep = items['Depreciation calculated and posted'];
    expect(dep.is_complete).toBe(false);
    expect(dep.details).toBe('1 assets without depreciation');
    expect(warnings).toContain('1 assets without depreciation posted');
  });

  it('conciliado y depreciado, los items dan verde DE VERDAD: hubo algo que mirar y se miró', async () => {
    await query(
      // `arithmetic_computed_at` no es adorno del fixture: F05c añadió el CHECK
      // `sesion_balanceada_con_aritmetica`, que impide marcar una sesión como
      // «balanced» sin haber recalculado los dos lados. Esta prueba afirma que
      // «hubo algo que mirar y SE MIRÓ», así que su sesión tiene que haberse
      // mirado de verdad — antes se firmaba el cuadre con dos ceros.
      `INSERT INTO reconciliation_sessions (bank_account_id, entity_id, start_date, end_date,
         beginning_balance, ending_balance_per_bank, status, arithmetic_computed_at)
       VALUES ($1, $2, '2026-02-01', '2026-12-31', '0', '0', 'balanced', NOW())`,
      [cuentaBancaria, f.entityId]
    );
    const asiento = await createJournalEntry(
      f.entityId,
      new Date('2026-02-28'),
      'standard' as never,
      'Depreciación de febrero',
      [
        { account_id: f.cuentas['6100'], debit_amount: '555.5600', credit_amount: null, description: 'gasto' },
        { account_id: f.cuentas['1110'], debit_amount: null, credit_amount: '555.5600', description: 'contra' },
      ] as never,
      f.userId
    );
    await query(
      // Y el renglón posteado necesita SU asiento: F06a añadió el CHECK
      // `depreciacion_posteada_con_asiento`, que impide marcar `is_posted` sin
      // decir con qué se posteó. Antes bastaba con el booleano, y un renglón
      // podía declararse en el mayor sin estar en el mayor.
      `INSERT INTO depreciation_schedules (asset_id, fiscal_period_id, depreciation_date,
         depreciation_expense, accumulated_depreciation, book_value, is_posted, journal_entry_id)
       VALUES ($1, $2, '2026-02-28', '555.5600', '555.5600', '19444.4400', true, $3)`,
      [activo, f.periodos[2], asiento.id]
    );

    const { items } = await checklistDe(2);
    const banco = items['Bank reconciliations complete'];
    const dep = items['Depreciation calculated and posted'];
    expect(banco.is_complete).toBe(true);
    expect(banco.details).toBeUndefined();
    expect(dep.is_complete).toBe(true);
    expect(dep.details).toBeUndefined();
  });
});
