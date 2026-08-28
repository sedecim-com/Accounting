import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';

/**
 * LA BITÁCORA NO SE REESCRIBE.
 *
 * audit_log es lo que prueba quién hizo qué. Mientras se pudiera modificar
 * con un UPDATE valía lo mismo que no tenerla: quien pudo hacer el acto podía
 * maquillarlo después.
 *
 * Lo que se fija aquí es la capa FUERTE. La revocación de privilegios detiene
 * a mnemosine_app, pero el dueño del esquema y el superusuario ignoran los
 * privilegios de tabla — y esta suite corre precisamente como superusuario.
 * Que estas pruebas pasen significa que ni siquiera él puede reescribirla.
 */

let f: Fixture;
let renglon: string;

beforeAll(async () => {
  f = await crearInquilino('Bitácora');

  // Un asiento cualquiera deja rastro: es la fila con la que se intenta.
  await createJournalEntry(
    f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'Asiento con rastro',
    [
      { account_id: f.roles.banco, debit_amount: '10.00', credit_amount: null, description: 'cargo' },
      { account_id: f.roles.cxc, debit_amount: null, credit_amount: '10.00', description: 'abono' },
    ],
    f.userId, { autoPost: true }
  );

  const r = await query<{ id: string }>(
    `SELECT id FROM audit_log WHERE tenant_id = $1 ORDER BY timestamp LIMIT 1`,
    [f.tenantId]
  );
  expect(r.rows, 'el motor debe haber dejado rastro').toHaveLength(1);
  renglon = r.rows[0].id;
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

describe('audit_log sólo admite INSERT', () => {
  it('el motor de posteo sigue pudiendo escribir', async () => {
    const antes = await query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE tenant_id = $1`, [f.tenantId]
    );
    await createJournalEntry(
      f.entityId, fechaEnPeriodo(), JournalEntryType.STANDARD, 'Otro asiento',
      [
        { account_id: f.roles.banco, debit_amount: '5.00', credit_amount: null, description: 'cargo' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '5.00', description: 'abono' },
      ],
      f.userId, { autoPost: true }
    );
    const despues = await query<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log WHERE tenant_id = $1`, [f.tenantId]
    );
    expect(Number(despues.rows[0].n)).toBeGreaterThan(Number(antes.rows[0].n));
  });

  it('un UPDATE se rechaza, aunque lo intente el superusuario', async () => {
    await expect(
      query(`UPDATE audit_log SET reason = 'maquillado' WHERE id = $1`, [renglon])
    ).rejects.toThrow(/sólo escritura|insufficient_privilege|append/i);
  });

  it('cambiar el AUTOR de un hecho tampoco se puede', async () => {
    // El caso que importa: no es borrar la fila, es reasignarla a otro.
    await expect(
      query(`UPDATE audit_log SET user_id = $2 WHERE id = $1`, [renglon, f.userId])
    ).rejects.toThrow(/sólo escritura|insufficient_privilege|append/i);
  });

  it('un DELETE se rechaza', async () => {
    await expect(
      query(`DELETE FROM audit_log WHERE id = $1`, [renglon])
    ).rejects.toThrow(/sólo escritura|insufficient_privilege|append/i);
  });

  it('un DELETE masivo tampoco: no hay atajo por volumen', async () => {
    await expect(
      query(`DELETE FROM audit_log WHERE tenant_id = $1`, [f.tenantId])
    ).rejects.toThrow(/sólo escritura|insufficient_privilege|append/i);
  });

  it('TRUNCATE se rechaza: no dispara triggers de fila y necesita el suyo', async () => {
    await expect(query(`TRUNCATE audit_log`)).rejects.toThrow(
      /sólo escritura|insufficient_privilege|append/i
    );
  });

  it('el renglón sigue intacto tras los cinco intentos', async () => {
    const r = await query<{ id: string; reason: string | null; user_id: string }>(
      `SELECT id, reason, user_id FROM audit_log WHERE id = $1`, [renglon]
    );
    expect(r.rows, 'la fila no puede haber desaparecido').toHaveLength(1);
    expect(r.rows[0].reason).not.toBe('maquillado');
  });

  it('el mensaje explica por qué, no sólo que no se puede', async () => {
    try {
      await query(`DELETE FROM audit_log WHERE id = $1`, [renglon]);
      throw new Error('debió lanzar');
    } catch (e) {
      expect((e as Error).message).toMatch(/corrige con un renglón nuevo/i);
    }
  });
});
