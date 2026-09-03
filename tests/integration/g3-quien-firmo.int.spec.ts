import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createVendor } from '../../src/services/ap/vendor-service.js';
import {
  createAccount,
  updateAccount,
  deactivateAccount,
  reactivateAccount,
  setAccountGovernance,
} from '../../src/services/accounting/account-service.js';
import { setAccountRole } from '../../src/services/accounting/account-roles-service.js';

/**
 * G3 · TRES CAMINOS QUE CAMBIABAN EL DESTINO DEL DINERO SIN DEJAR RASTRO.
 *
 * `createVendor`, `setAccountRole` y el servicio de cuentas escribían en las
 * tablas que deciden A DÓNDE va el dinero —la cuenta de gasto por omisión de
 * un proveedor, el rol contable por el que postean AR/AP/REP/nómina, y las
 * banderas de gobierno de la cuenta— y ninguno insertaba una fila en
 * `audit_log`. Quedaba `updated_by`, que es una foto del ÚLTIMO que tocó y se
 * pisa con cada cambio, no un rastro.
 *
 * Estas pruebas afirman CONDUCTA, no texto: llaman al servicio real contra
 * Postgres y luego preguntan a `audit_log` qué quedó. Una prueba que buscara
 * `registrarAuditoria` en el archivo pasaría igual si la llamada se moviera
 * fuera de la transacción, que es justo el defecto que importa.
 */

let f: Fixture;

const rastroDe = (entityType: string, entityId: string) =>
  query<{
    action: string;
    user_id: string;
    tenant_id: string;
    old_values: Record<string, unknown> | null;
    new_values: Record<string, unknown> | null;
    reason: string | null;
  }>(
    `SELECT action, user_id, tenant_id, old_values, new_values, reason
       FROM audit_log
      WHERE entity_type = $1 AND entity_id = $2
      ORDER BY timestamp, id`,
    [entityType, entityId]
  );

beforeAll(async () => {
  f = await crearInquilino('G3 · quién firmó');
});

afterAll(async () => {
  await closeDatabase();
});

describe('G3 · createVendor deja rastro', () => {
  it('el alta de un proveedor escribe quién, con qué valores y con su inquilino', async () => {
    const creado = await createVendor({
      entity_id: f.entityId,
      company_name: 'Refacciones del Bajío SA de CV',
      created_by: f.userId,
      tax_id: 'RBA850101AB1',
      tax_id_type: 'rfc',
      payment_terms: 'Net 30',
      currency_code: 'MXN',
      reason: 'alta pedida por compras',
    });

    const rastro = await rastroDe('vendor', creado.id as string);
    expect(rastro.rows).toHaveLength(1);
    const fila = rastro.rows[0];
    expect(fila.action).toBe('create');
    expect(fila.user_id).toBe(f.userId);
    expect(fila.tenant_id).toBe(f.tenantId);
    expect(fila.reason).toBe('alta pedida por compras');
    expect(fila.old_values).toBeNull();
    expect(fila.new_values).toMatchObject({
      company_name: 'Refacciones del Bajío SA de CV',
      tax_id: 'RBA850101AB1',
      payment_terms: 'Net 30',
      currency_code: 'MXN',
    });
  });

  /**
   * `audit_log` es de sólo agregar (033): un secreto que entra ahí no vuelve
   * a salir, ni rotando la llave de cifrado. Así que la parte bancaria del
   * alta —que el contrato REST acepta— no puede viajar al rastro NI SIQUIERA
   * cifrada: un blob cifrado sigue siendo el dato, y la bitácora lo conserva
   * más tiempo que la tabla.
   */
  it('la CLABE del alta no llega al rastro, ni en claro ni cifrada; sólo el hecho de que había datos', async () => {
    const clabe = '012180012345678901';
    const creado = await createVendor({
      entity_id: f.entityId,
      company_name: 'Proveedor con banco',
      created_by: f.userId,
      clabe,
      bank_account_number: '9876543210',
      bank_name: 'BBVA México',
    });

    const rastro = await rastroDe('vendor', creado.id as string);
    expect(rastro.rows).toHaveLength(1);
    const nuevos = rastro.rows[0].new_values!;
    const serializado = JSON.stringify(nuevos);

    expect(serializado).not.toContain(clabe);
    expect(serializado).not.toContain('9876543210');
    expect(Object.keys(nuevos)).not.toContain('clabe_encrypted');
    expect(Object.keys(nuevos)).not.toContain('bank_account_number_encrypted');
    // Lo que sí queda: que el alta traía datos bancarios. Es el hecho que un
    // investigador necesita para saber que hay que ir a mirar otra tabla.
    expect(nuevos.bank_details_on_file).toBe(true);
    expect(nuevos.bank_name).toBe('BBVA México');
  });

  /**
   * EL HECHO Y SU RASTRO SE CONFIRMAN JUNTOS, O NO SE CONFIRMA NINGUNO.
   *
   * Es la razón entera de que `createVendor` pasara de `query()` a
   * `withTransaction`: `query()` saca una conexión del pool POR SENTENCIA, de
   * modo que el proveedor y su renglón de auditoría se confirmaban en dos
   * transacciones distintas y un fallo entre medias dejaba uno sin el otro.
   *
   * La dirección que hay que probar es la difícil —falla el RASTRO, ¿se cae
   * el hecho?— y no se alcanza por la API: `audit_log.user_id` y `tenant_id`
   * no tienen clave foránea, así que no hay valor de entrada que reviente ese
   * INSERT. Se inyecta la falla donde de verdad vive, en la base, con un
   * disparador temporal que sólo reacciona a una razón centinela. Corre como
   * superusuario, así que un REVOKE no serviría; un disparador sí.
   */
  it('si el rastro no se puede escribir, el proveedor tampoco queda', async () => {
    await query(`
      CREATE OR REPLACE FUNCTION g3_detonar_rastro() RETURNS trigger AS $g3$
      BEGIN
        IF NEW.reason = 'DETONAR-G3' THEN
          RAISE EXCEPTION 'falla inyectada en el rastro (G3)';
        END IF;
        RETURN NEW;
      END
      $g3$ LANGUAGE plpgsql;
    `);
    await query(`
      CREATE TRIGGER g3_detonar BEFORE INSERT ON audit_log
        FOR EACH ROW EXECUTE FUNCTION g3_detonar_rastro();
    `);

    try {
      await expect(
        createVendor({
          entity_id: f.entityId,
          company_name: 'Proveedor que no debe quedar',
          created_by: f.userId,
          reason: 'DETONAR-G3',
        })
      ).rejects.toThrow(/falla inyectada en el rastro/);
    } finally {
      await query('DROP TRIGGER IF EXISTS g3_detonar ON audit_log');
      await query('DROP FUNCTION IF EXISTS g3_detonar_rastro()');
    }

    // Ni el proveedor, ni el rastro. Y el conteo de proveedores del alta —que
    // sale de COUNT(*)— tampoco se movió, así que el siguiente alta no se
    // salta un número.
    const quedo = await query<{ n: string }>(
      `SELECT count(*)::text n FROM vendors
        WHERE entity_id = $1 AND company_name = 'Proveedor que no debe quedar'`,
      [f.entityId]
    );
    expect(quedo.rows[0].n).toBe('0');
  });
});

describe('G3 · setAccountRole deja rastro', () => {
  it('reapuntar un rol registra a qué cuenta apuntaba ANTES, que es el dato investigable', async () => {
    // La entidad nace con `banco` sembrado; se crea una segunda cuenta de
    // banco y se reapunta el rol, que es el acto que redirige el posteo.
    const destino = await createAccount({
      code: '1102-G3',
      name: 'Bancos · cuenta destino G3',
      account_type: 'asset',
      normal_balance: 'debit',
      entity_id: f.entityId,
      created_by: f.userId,
    });

    const anterior = await query<{ account_id: string }>(
      `SELECT account_id FROM account_roles
        WHERE entity_id = $1 AND role = 'banco' AND qualifier IS NULL`,
      [f.entityId]
    );
    expect(anterior.rows).toHaveLength(1);
    const cuentaVieja = anterior.rows[0].account_id;

    const res = await setAccountRole(f.entityId, f.tenantId, 'banco', destino.id, {
      userId: f.userId,
      reason: 'la cuenta operativa cambió de banco',
    });
    expect(res.accion).toBe('reapuntado');

    const fila = await query<{ id: string }>(
      `SELECT id FROM account_roles
        WHERE entity_id = $1 AND role = 'banco' AND qualifier IS NULL`,
      [f.entityId]
    );
    const rastro = await rastroDe('account_role', fila.rows[0].id);
    const reapunte = rastro.rows.filter((r) => r.action === 'update');
    expect(reapunte).toHaveLength(1);
    expect(reapunte[0].user_id).toBe(f.userId);
    expect(reapunte[0].reason).toBe('la cuenta operativa cambió de banco');
    expect(reapunte[0].old_values).toMatchObject({ role: 'banco', account_id: cuentaVieja });
    expect(reapunte[0].new_values).toMatchObject({ role: 'banco', account_id: destino.id });
    // Y el `old_values` NO es el mismo que el nuevo: un rastro que copiara el
    // estado final a las dos columnas pasaría todas las demás afirmaciones y
    // no probaría nada.
    expect((reapunte[0].old_values as Record<string, unknown>).account_id)
      .not.toBe((reapunte[0].new_values as Record<string, unknown>).account_id);
  });

  it('crear una variante por qualifier se registra como create, no como update', async () => {
    const destino = await createAccount({
      code: '1103-G3',
      name: 'Bancos · USD G3',
      account_type: 'asset',
      normal_balance: 'debit',
      entity_id: f.entityId,
      created_by: f.userId,
    });

    const res = await setAccountRole(f.entityId, f.tenantId, 'banco', destino.id, {
      qualifier: 'usd',
      userId: f.userId,
    });
    expect(res.accion).toBe('creado');

    const fila = await query<{ id: string }>(
      `SELECT id FROM account_roles
        WHERE entity_id = $1 AND role = 'banco' AND qualifier = 'usd'`,
      [f.entityId]
    );
    const rastro = await rastroDe('account_role', fila.rows[0].id);
    expect(rastro.rows).toHaveLength(1);
    expect(rastro.rows[0].action).toBe('create');
    expect(rastro.rows[0].old_values).toBeNull();
    expect(rastro.rows[0].new_values).toMatchObject({ qualifier: 'usd', account_id: destino.id });
  });
});

describe('G3 · el servicio de cuentas deja rastro', () => {
  it('crear, editar, archivar, restaurar y gobernar dejan cinco filas con su antes y su después', async () => {
    const cuenta = await createAccount({
      code: '6100-G3',
      name: 'Gastos de prueba G3',
      account_type: 'expense',
      normal_balance: 'debit',
      entity_id: f.entityId,
      created_by: f.userId,
      reason: 'apertura de línea de gasto',
    });

    await updateAccount(cuenta.id, { name: 'Gastos de prueba G3 (renombrada)' }, f.userId, 'error de captura');
    await setAccountGovernance(cuenta.id, { allow_manual_entries: false }, f.userId, 'se posteará sólo por regla');
    await deactivateAccount(cuenta.id, f.userId, {
      allowWithHistory: true,
      reason: 'cierre de ejercicio',
    });
    await reactivateAccount(cuenta.id, f.userId, 'se volvió a necesitar');

    const rastro = await rastroDe('account', cuenta.id);
    expect(rastro.rows).toHaveLength(5);

    const [alta, renombre, gobierno, archivado, restauracion] = rastro.rows;

    expect(alta.action).toBe('create');
    expect(alta.old_values).toBeNull();
    expect(alta.new_values).toMatchObject({ code: '6100-G3', account_type: 'expense', is_active: true });
    expect(alta.reason).toBe('apertura de línea de gasto');

    // Sólo los campos TOCADOS: un rastro que copiara el documento entero en
    // cada edición haría ilegible la pregunta que contesta.
    expect(renombre.action).toBe('update');
    expect(Object.keys(renombre.new_values!)).toEqual(['name']);
    expect(renombre.old_values).toMatchObject({ name: 'Gastos de prueba G3' });
    expect(renombre.new_values).toMatchObject({ name: 'Gastos de prueba G3 (renombrada)' });
    expect(renombre.reason).toBe('error de captura');

    expect(gobierno.action).toBe('update');
    expect(gobierno.old_values).toMatchObject({ allow_manual_entries: true });
    expect(gobierno.new_values).toMatchObject({ allow_manual_entries: false });

    // Archivar es 'update', no 'delete': la cuenta sigue ahí. Y el rastro
    // dice el saldo y si había historia, que son las dos condiciones que el
    // archivado evalúa — para no tener que recalcularlas seis meses después.
    expect(archivado.action).toBe('update');
    expect(archivado.old_values).toMatchObject({ is_active: true });
    expect(archivado.new_values).toMatchObject({ is_active: false, had_history: false });
    expect(archivado.new_values).toHaveProperty('balance_at_archive');
    expect(archivado.reason).toBe('cierre de ejercicio');

    expect(restauracion.action).toBe('update');
    expect(restauracion.old_values).toMatchObject({ is_active: false });
    expect(restauracion.new_values).toMatchObject({ is_active: true });
    expect(restauracion.reason).toBe('se volvió a necesitar');
  });

  it('un archivado en dry-run no escribe rastro: lo que no ocurre no se audita', async () => {
    const cuenta = await createAccount({
      code: '6101-G3',
      name: 'Gastos dry-run G3',
      account_type: 'expense',
      normal_balance: 'debit',
      entity_id: f.entityId,
      created_by: f.userId,
    });

    await deactivateAccount(cuenta.id, f.userId, {
      allowWithHistory: true,
      dryRun: true,
      reason: 'sólo mirando',
    });

    const rastro = await rastroDe('account', cuenta.id);
    expect(rastro.rows).toHaveLength(1);
    expect(rastro.rows[0].action).toBe('create');

    const cuentaAhora = await query<{ is_active: boolean }>(
      'SELECT is_active FROM accounts WHERE id = $1', [cuenta.id]
    );
    expect(cuentaAhora.rows[0].is_active).toBe(true);
  });

  /**
   * Una edición que muere no puede dejar rastro de un cambio que no pasó.
   * `setAccountGovernance` valida el CHECK de la 001 DENTRO de la
   * transacción; si la validación cae, ni la cuenta cambia ni la bitácora
   * crece.
   */
  it('una bandera de gobierno rechazada no deja rastro', async () => {
    const cuenta = await createAccount({
      code: '4000-G3',
      name: 'Agrupador G3',
      account_type: 'revenue',
      normal_balance: 'credit',
      entity_id: f.entityId,
      created_by: f.userId,
      is_header: true,
      allow_manual_entries: false,
    });

    await expect(
      setAccountGovernance(cuenta.id, { allow_manual_entries: true }, f.userId)
    ).rejects.toThrow(/agrupadora/i);

    const rastro = await rastroDe('account', cuenta.id);
    expect(rastro.rows).toHaveLength(1);
    expect(rastro.rows[0].action).toBe('create');
  });
});
