import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { crearInquilino, fechaEnPeriodo, saldoDe, type Fixture } from './helpers/tenant-fixture.js';
import { query, withTransaction, closeDatabase } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import {
  getPeriodCloseStatus,
  softClosePeriod,
  hardClosePeriod,
  carryForwardBalances,
} from '../../src/services/accounting/period-close.js';
import { JournalEntryType } from '../../src/types/index.js';

let f: Fixture;

beforeAll(async () => {
  f = await crearInquilino('Cierre de periodo');
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

async function postear(mes: number, monto: string, cargo: string, abono: string) {
  return createJournalEntry(
    f.entityId, fechaEnPeriodo(mes, 10), JournalEntryType.STANDARD, `Movimiento ${mes}`,
    [
      { account_id: cargo, debit_amount: monto, credit_amount: null, description: 'cargo' },
      { account_id: abono, debit_amount: null, credit_amount: monto, description: 'abono' },
    ],
    f.userId, { autoPost: true }
  );
}

describe('checklist de cierre', () => {
  it('bloquea el cierre mientras haya borradores sin postear', async () => {
    await createJournalEntry(
      f.entityId, fechaEnPeriodo(1, 5), JournalEntryType.STANDARD, 'Borrador pendiente',
      [
        { account_id: f.roles.banco, debit_amount: '10.00', credit_amount: null, description: 'x' },
        { account_id: f.roles.cxc, debit_amount: null, credit_amount: '10.00', description: 'y' },
      ],
      f.userId
    );
    const st = await getPeriodCloseStatus(f.periodos[1], f.entityId);
    expect(st.can_close).toBe(false);
    expect(st.blocking_issues.some((b) => /unposted/i.test(b))).toBe(true);
  });

  it('un periodo sin pendientes puede cerrarse en suave', async () => {
    await postear(2, '500.00', f.roles.banco, f.roles.ingreso);
    const st = await getPeriodCloseStatus(f.periodos[2], f.entityId);
    expect(st.can_close).toBe(true);

    const p = await softClosePeriod(f.periodos[2], f.entityId, f.userId);
    expect(p.status).toBe('soft_close');
  });

  it('el cierre duro exige pasar antes por el suave', async () => {
    await expect(hardClosePeriod(f.periodos[3], f.entityId, f.userId)).rejects.toThrow(
      /soft_close/i
    );
  });
});

describe('arrastre de saldos', () => {
  it('lleva el saldo final de las cuentas de balance al periodo siguiente', async () => {
    // Banco es cuenta de balance: su saldo debe arrastrarse.
    await postear(4, '1000.00', f.roles.banco, f.roles.ingreso);
    const finalAbril = await saldoDe(f.roles.banco, f.periodos[4]);
    expect(finalAbril).toBeGreaterThan(0);

    const arrastradas = await withTransaction((c) =>
      carryForwardBalances(c, f.entityId, f.periodos[4])
    );
    expect(arrastradas).toBeGreaterThan(0);

    const { rows } = await query<{ beginning_balance: string; ending_balance: string }>(
      `SELECT beginning_balance::text, ending_balance::text
       FROM account_balances WHERE account_id = $1 AND fiscal_period_id = $2`,
      [f.roles.banco, f.periodos[5]]
    );
    expect(Number(rows[0].beginning_balance)).toBeCloseTo(finalAbril, 4);
  });

  it('NO arrastra cuentas de resultados: se cierran contra el ejercicio', async () => {
    await postear(6, '300.00', f.roles.banco, f.roles.ingreso);
    await withTransaction((c) => carryForwardBalances(c, f.entityId, f.periodos[6]));

    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text n FROM account_balances
       WHERE account_id = $1 AND fiscal_period_id = $2`,
      [f.roles.ingreso, f.periodos[7]]
    );
    expect(rows[0].n).toBe('0');
  });

  it('es idempotente: repetirlo no duplica el saldo inicial', async () => {
    await postear(9, '250.00', f.roles.banco, f.roles.ingreso);
    await withTransaction((c) => carryForwardBalances(c, f.entityId, f.periodos[9]));
    const primera = (await query<{ b: string }>(
      `SELECT beginning_balance::text b FROM account_balances
       WHERE account_id = $1 AND fiscal_period_id = $2`,
      [f.roles.banco, f.periodos[10]]
    )).rows[0].b;

    await withTransaction((c) => carryForwardBalances(c, f.entityId, f.periodos[9]));
    const segunda = (await query<{ b: string }>(
      `SELECT beginning_balance::text b FROM account_balances
       WHERE account_id = $1 AND fiscal_period_id = $2`,
      [f.roles.banco, f.periodos[10]]
    )).rows[0].b;

    expect(Number(segunda)).toBeCloseTo(Number(primera), 4);
  });
});

describe('asientos de cierre anual', () => {
  it('barre el resultado al Resultado del Ejercicio (3300), NUNCA a Capital Social (3100)', async () => {
    // El catálogo base debe traer las cuatro cuentas del cierre.
    expect(f.cuentas['3900'], 'falta Resumen de Ingresos y Gastos').toBeTruthy();
    expect(f.cuentas['3200'], 'falta Resultado de Ejercicios Anteriores').toBeTruthy();
    expect(f.cuentas['3300'], 'falta Resultado del Ejercicio').toBeTruthy();
    expect(f.cuentas['3100'], 'falta Capital Social').toBeTruthy();

    const capitalSocialAntes = await saldoDe(f.cuentas['3100'], f.periodos[12]);

    // Resultado del ejercicio en el último periodo, y cierre duro del año.
    await postear(12, '800.00', f.roles.banco, f.roles.ingreso);
    await softClosePeriod(f.periodos[12], f.entityId, f.userId);
    await hardClosePeriod(f.periodos[12], f.entityId, f.userId);

    const cierres = await query<{ id: string }>(
      `SELECT id FROM journal_entries
       WHERE entity_id = $1 AND entry_type = 'closing' AND status = 'posted'`,
      [f.entityId]
    );
    expect(cierres.rows.length).toBeGreaterThan(0);

    // Capital Social no se mueve por un cierre: solo por acto formal (NIF C-11).
    expect(await saldoDe(f.cuentas['3100'], f.periodos[12])).toBeCloseTo(capitalSocialAntes, 4);

    // El resultado llegó a la 3300 «Resultado del Ejercicio», que es el destino
    // por omisión del panel (destino_del_resultado_del_ejercicio =
    // dos_pasos_hasta_asamblea): el año se mantiene identificable hasta que la
    // asamblea resuelva, y sólo entonces se reclasifica a 3200.
    const resultadoDelEjercicio = await saldoDe(f.cuentas['3300'], f.periodos[12]);
    expect(resultadoDelEjercicio).not.toBe(0);
    expect(await saldoDe(f.cuentas['3200'], f.periodos[12])).toBe(0);
  });
});
