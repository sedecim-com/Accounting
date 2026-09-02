import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import {
  createJournalEntry,
  reverseJournalEntry,
  drainAttestations,
} from '../../src/services/accounting/posting.js';
import { checkLedgerIntegrity } from '../../src/ai/doctor-service.js';
import { JournalEntryType } from '../../src/types/index.js';

/**
 * EL MAYOR ES INVIOLABLE (R1, migración 041).
 *
 * La 033 blindó la bitácora; el mayor —lo que la bitácora protege— seguía
 * siendo físicamente reescribible: un UPDATE que cambiara cuenta o monto de
 * una línea posteada manteniendo el par balanceado no violaba ningún CHECK y
 * desalineaba account_balances sin rastro. Esta suite corre como SUPERUSUARIO
 * a propósito: que estas pruebas pasen significa que ni siquiera él puede.
 *
 * Y la lista blanca es igual de importante que el rechazo: la reversa, la
 * anotación de anulación y la atestación SÍ escriben sobre posteados — un
 * candado que rompiera al escritor legítimo sería peor que no tenerlo.
 */

let f: Fixture;
let posteadoId: string;
let lineaId: string;

const asiento = async (monto: string, autoPost: boolean) =>
  createJournalEntry(
    f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, `Asiento ${monto}`,
    [
      { account_id: f.roles.banco, debit_amount: monto, credit_amount: null, description: 'cargo' },
      { account_id: f.roles.cxc, debit_amount: null, credit_amount: monto, description: 'abono' },
    ],
    f.userId, { autoPost }
  );

beforeAll(async () => {
  f = await crearInquilino('Mayor inviolable');
  const e = await asiento('100.00', true);
  posteadoId = e.id;
  const l = await query<{ id: string }>(
    `SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number LIMIT 1`,
    [posteadoId]
  );
  lineaId = l.rows[0].id;
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('lo posteado rechaza, incluso al superusuario', () => {
  it('cambiar el monto de una línea posteada revienta aunque el par siga balanceado', async () => {
    await expect(
      query(`UPDATE journal_entry_lines SET debit_amount = '999.00' WHERE id = $1`, [lineaId])
    ).rejects.toThrow(/POSTEADO no se edita/);
  });

  it('cambiar la cuenta de una línea posteada revienta', async () => {
    await expect(
      query(`UPDATE journal_entry_lines SET account_id = $1 WHERE id = $2`, [f.roles.cxc, lineaId])
    ).rejects.toThrow(/POSTEADO no se edita/);
  });

  it('editar el hecho contable del asiento (monto, fecha, estado) revienta', async () => {
    await expect(
      query(`UPDATE journal_entries SET description = 'maquillado' WHERE id = $1`, [posteadoId])
    ).rejects.toThrow(/POSTEADO no se edita/);
    await expect(
      query(`UPDATE journal_entries SET status = 'draft' WHERE id = $1`, [posteadoId])
    ).rejects.toThrow(/POSTEADO no se edita/);
  });

  it('borrar un asiento posteado o su línea revienta', async () => {
    await expect(
      query(`DELETE FROM journal_entries WHERE id = $1`, [posteadoId])
    ).rejects.toThrow(/POSTEADO no se borra/);
    await expect(
      query(`DELETE FROM journal_entry_lines WHERE id = $1`, [lineaId])
    ).rejects.toThrow(/POSTEADO no se borra/);
  });

  it('TRUNCATE del libro revienta a nivel sentencia', async () => {
    // LAS TRES FORMAS, Y LA DEL MEDIO ES LA QUE IMPORTA.
    //
    // `TRUNCATE journal_entry_lines` a secas dejó de llegar al trigger cuando
    // la 053 le colgó una clave foránea (`reconciling_items.journal_entry_line_id`):
    // Postgres rechaza antes, con «cannot truncate a table referenced in a
    // foreign key constraint». El libro sigue sin poder vaciarse, pero quien
    // lo impide ya no es el guardia sino un accidente del esquema — y un
    // accidente se puede quitar mañana con un `DROP CONSTRAINT` que nadie
    // relacione con el mayor.
    //
    // Por eso la aserción fuerte va con CASCADE, que aparta la objeción de la
    // foránea y deja hablar a `ledger_sin_truncate`. Si esta prueba sólo
    // afirmara la primera línea, el día que la foránea desapareciera seguiría
    // en verde por la razón equivocada.
    await expect(query('TRUNCATE journal_entry_lines', [])).rejects.toThrow();
    await expect(query('TRUNCATE journal_entry_lines CASCADE', [])).rejects.toThrow(/no se trunca/);
    await expect(query('TRUNCATE journal_entries CASCADE', [])).rejects.toThrow(/no se trunca/);
  });
});

describe('la lista blanca deja pasar a los escritores legítimos', () => {
  it('la anotación (notes) y la marca de conciliación escriben sobre posteados', async () => {
    await expect(
      query(`UPDATE journal_entries SET notes = COALESCE(notes, '') || ' [anotado]' WHERE id = $1`, [posteadoId])
    ).resolves.toBeTruthy();
    // LAS TRES COLUMNAS DEL SELLO, JUNTAS. La 041 abre las tres —y sólo las
    // tres— sobre una línea posteada; la 052 añadió el CHECK
    // `jel_sello_coherente`, que además exige que se muevan A LA VEZ. Esta
    // prueba escribía dos y pasaba porque nadie había escrito nunca el sello:
    // el día que F05b lo escribió de verdad, la mitad de sello que afirmaba
    // aquí dejó de ser válida.
    await expect(
      query(
        `UPDATE journal_entry_lines
            SET is_reconciled = true, reconciled_at = NOW(), reconciliation_id = uuid_generate_v4()
          WHERE id = $1`,
        [lineaId]
      )
    ).resolves.toBeTruthy();
  });

  it('media marca de conciliación NO pasa: el sello es de tres columnas o de ninguna', async () => {
    // La lista blanca de la 041 dice QUÉ columnas se pueden tocar; el CHECK de
    // la 052 dice que no se tocan por separado. Sin esta segunda mitad, una
    // línea podría quedar `is_reconciled = true` sin fecha ni dueño, que es
    // exactamente la marca que nadie puede explicar después.
    //
    // Sobre una línea SIN SELLAR: la de arriba ya quedó con las tres puestas, y
    // ahí volver a poner una sola no rompe nada porque las otras dos siguen.
    const otro = await asiento('77.00', true);
    const virgen = (await query<{ id: string }>(
      `SELECT id FROM journal_entry_lines WHERE journal_entry_id = $1 ORDER BY line_number LIMIT 1`,
      [otro.id]
    )).rows[0].id;

    await expect(
      query(`UPDATE journal_entry_lines SET is_reconciled = true WHERE id = $1`, [virgen])
    ).rejects.toThrow(/jel_sello_coherente/);
    await expect(
      query(`UPDATE journal_entry_lines SET reconciled_at = NOW() WHERE id = $1`, [virgen])
    ).rejects.toThrow(/jel_sello_coherente/);
  });

  it('la reversa completa sigue funcionando: liga el espejo sobre el original posteado', async () => {
    const original = await asiento('50.00', true);
    const espejo = await reverseJournalEntry(original.id, f.userId, { reason: 'prueba R1' });
    const liga = await query<{ reversed_by_entry_id: string }>(
      `SELECT reversed_by_entry_id FROM journal_entries WHERE id = $1`,
      [original.id]
    );
    expect(liga.rows[0].reversed_by_entry_id).toBe(espejo.id);
  });

  it('un borrador sigue siendo editable y borrable (con sus líneas en cascada)', async () => {
    const draft = await asiento('10.00', false);
    await expect(
      query(`UPDATE journal_entries SET description = 'borrador editado' WHERE id = $1`, [draft.id])
    ).resolves.toBeTruthy();
    await expect(query(`DELETE FROM journal_entries WHERE id = $1`, [draft.id])).resolves.toBeTruthy();
    const restos = await query(`SELECT 1 FROM journal_entry_lines WHERE journal_entry_id = $1`, [draft.id]);
    expect(restos.rows).toHaveLength(0);
  });
});

describe('doctor: la integridad del mayor es fail, no opinión', () => {
  it('con el mayor sano, el chequeo pasa', async () => {
    const r = await checkLedgerIntegrity();
    expect(r.level, r.detail).toBe('ok');
  });

  it('una deriva inyectada en account_balances se detecta como fail', async () => {
    // account_balances no tiene trigger a propósito: es tabla derivada. La
    // deriva se inyecta ahí — exactamente el desalineamiento que el UPDATE
    // balanceado habría causado antes de la 041.
    await query(
      `UPDATE account_balances SET debit_total = debit_total + 7
        WHERE account_id = $1 AND entity_id = $2`,
      [f.roles.banco, f.entityId]
    );
    const r = await checkLedgerIntegrity();
    expect(r.level).toBe('fail');
    expect(r.detail).toMatch(/account_balances ≠ Σ/);
    await query(
      `UPDATE account_balances SET debit_total = debit_total - 7
        WHERE account_id = $1 AND entity_id = $2`,
      [f.roles.banco, f.entityId]
    );
    expect((await checkLedgerIntegrity()).level).toBe('ok');
  });
});
