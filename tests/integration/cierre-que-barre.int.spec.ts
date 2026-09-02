import { describe, it, expect, afterAll } from 'vitest';
import { crearInquilino, fechaEnPeriodo, saldoDe, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { softClosePeriod, hardClosePeriod } from '../../src/services/accounting/period-close.js';
import { reopenClosedPeriod } from '../../src/services/accounting/fiscal-calendar-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// G1a · EL CIERRE QUE BARRE DE VERDAD, CONTRA POSTGRES.
//
// El escenario es el del reconocimiento: ventas 10 000, devolución sobre
// ventas 2 000 (4400, contra-ingreso de saldo DEUDOR), costo 6 000 y
// devolución sobre compras 1 000 (5200, contra-gasto de saldo ACREEDOR).
// Utilidad real: (10 000 − 2 000) − (6 000 − 1 000) = 3 000.
//
// Con abs() las dos contra-naturales quedaban al DOBLE en vez de en cero y el
// resultado se publicaba como 5 000. Aquí se comprueba sobre el mayor real.
// ============================================================

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

async function asiento(f: Fixture, mes: number, desc: string, cargo: string, abono: string, monto: string) {
  return createJournalEntry(
    f.entityId, fechaEnPeriodo(mes, 10), JournalEntryType.STANDARD, desc,
    [
      { account_id: cargo, debit_amount: monto, credit_amount: null, description: desc },
      { account_id: abono, debit_amount: null, credit_amount: monto, description: desc },
    ],
    f.userId, { autoPost: true }
  );
}

/** Saldo de la cuenta acumulado sobre TODO el ejercicio (debe − haber). */
async function saldoDelEjercicio(f: Fixture, cuentaId: string): Promise<number> {
  const { rows } = await query<{ s: string }>(
    `SELECT COALESCE(SUM(ab.debit_total - ab.credit_total), 0)::text AS s
       FROM account_balances ab
       JOIN fiscal_periods fp ON fp.id = ab.fiscal_period_id
      WHERE ab.account_id = $1 AND ab.entity_id = $2 AND fp.fiscal_year_id = $3`,
    [cuentaId, f.entityId, f.fiscalYearId]
  );
  return Number(rows[0]?.s ?? 0);
}

/** El ejercicio del reconocimiento, posteado en diciembre. */
async function poblarEjercicio(f: Fixture) {
  await asiento(f, 12, 'Ventas', f.roles.banco, f.cuentas['4100'], '10000.0000');
  await asiento(f, 12, 'Devolución sobre ventas', f.cuentas['4400'], f.roles.banco, '2000.0000');
  await asiento(f, 12, 'Costo de ventas', f.cuentas['5100'], f.roles.banco, '6000.0000');
  await asiento(f, 12, 'Devolución sobre compras', f.roles.banco, f.cuentas['5200'], '1000.0000');
}

describe('el barrido anual con cuentas contra-naturales', () => {
  it('deja las cuatro cuentas de resultados en CERO y publica utilidad de 3 000', async () => {
    const f = await crearInquilino('Cierre que barre');
    enterTenant(f.tenantId);

    // Las dos contra-naturales existen en el catálogo base.
    expect(f.cuentas['4400'], 'falta Devoluciones sobre Ventas').toBeTruthy();
    expect(f.cuentas['5200'], 'falta Devoluciones sobre Compras').toBeTruthy();
    expect(f.cuentas['3300'], 'falta Resultado del Ejercicio').toBeTruthy();

    await poblarEjercicio(f);

    // Antes del cierre, los saldos son los que dicta la naturaleza de cada cuenta.
    expect(await saldoDelEjercicio(f, f.cuentas['4100'])).toBeCloseTo(-10000, 4);
    expect(await saldoDelEjercicio(f, f.cuentas['4400'])).toBeCloseTo(2000, 4);
    expect(await saldoDelEjercicio(f, f.cuentas['5100'])).toBeCloseTo(6000, 4);
    expect(await saldoDelEjercicio(f, f.cuentas['5200'])).toBeCloseTo(-1000, 4);

    await softClosePeriod(f.periodos[12], f.entityId, f.userId);
    await hardClosePeriod(f.periodos[12], f.entityId, f.userId, 'cierre del ejercicio');

    // NINGUNA cuenta de resultados sobrevive al cierre. Con abs(), la 4400
    // quedaba en 4 000 y la 5200 en −2 000: al doble, no en cero.
    for (const codigo of ['4100', '4400', '5100', '5200']) {
      expect(await saldoDelEjercicio(f, f.cuentas[codigo]), `${codigo} no barrió`).toBeCloseTo(0, 4);
    }
    // El resumen también queda en cero: lo suyo pasó al destino.
    expect(await saldoDelEjercicio(f, f.cuentas['3900'])).toBeCloseTo(0, 4);

    // Utilidad de 3 000 (saldo ACREEDOR = −3 000 en convención deudor-positivo),
    // no los 5 000 que producía abs().
    expect(await saldoDe(f.cuentas['3300'], f.periodos[12])).toBeCloseTo(-3000, 4);
  });

  it('con el defecto del panel el resultado va a 3300, y 3200 no se toca hasta la asamblea', async () => {
    const f = await crearInquilino('Cierre dos pasos');
    enterTenant(f.tenantId);
    await poblarEjercicio(f);
    await softClosePeriod(f.periodos[12], f.entityId, f.userId);
    await hardClosePeriod(f.periodos[12], f.entityId, f.userId);

    expect(await saldoDe(f.cuentas['3300'], f.periodos[12])).toBeCloseTo(-3000, 4);
    expect(await saldoDe(f.cuentas['3200'], f.periodos[12])).toBeCloseTo(0, 4);
    // Capital Social no se mueve por un cierre (NIF C-11).
    expect(await saldoDe(f.cuentas['3100'], f.periodos[12])).toBeCloseTo(0, 4);
  });

  it('con destino_del_resultado_del_ejercicio = directo_a_acumulados va a 3200', async () => {
    const f = await crearInquilino('Cierre directo');
    enterTenant(f.tenantId);
    await seedPolicies({ tenantId: f.tenantId });
    await resolvePolicy(
      { tenantId: f.tenantId },
      'destino_del_resultado_del_ejercicio',
      'directo_a_acumulados',
      f.userId
    );

    await poblarEjercicio(f);
    await softClosePeriod(f.periodos[12], f.entityId, f.userId);
    await hardClosePeriod(f.periodos[12], f.entityId, f.userId);

    expect(await saldoDe(f.cuentas['3200'], f.periodos[12])).toBeCloseTo(-3000, 4);
    expect(await saldoDe(f.cuentas['3300'], f.periodos[12])).toBeCloseTo(0, 4);
  });
});

describe('recierre de un periodo reabierto', () => {
  it('reversa el cierre anterior en vez de sumar un segundo: el resultado entra UNA vez', async () => {
    const f = await crearInquilino('Recierre');
    enterTenant(f.tenantId);
    await poblarEjercicio(f);

    await softClosePeriod(f.periodos[12], f.entityId, f.userId);
    await hardClosePeriod(f.periodos[12], f.entityId, f.userId);
    expect(await saldoDe(f.cuentas['3300'], f.periodos[12])).toBeCloseTo(-3000, 4);

    const cierresPrimera = await query<{ n: string }>(
      `SELECT count(*)::text n FROM journal_entries
        WHERE entity_id = $1 AND entry_type = 'closing' AND status = 'posted'`,
      [f.entityId]
    );

    // Se reabre y se vuelve a cerrar: es lo que `period reopen` hizo alcanzable.
    await reopenClosedPeriod(f.entityId, f.periodos[12], f.userId, 'ajuste tardío');
    await softClosePeriod(f.periodos[12], f.entityId, f.userId);
    await hardClosePeriod(f.periodos[12], f.entityId, f.userId, 'segundo cierre');

    // El resultado NO se duplicó: sigue siendo 3 000, no 6 000.
    expect(await saldoDe(f.cuentas['3300'], f.periodos[12])).toBeCloseTo(-3000, 4);
    for (const codigo of ['4100', '4400', '5100', '5200', '3900']) {
      expect(await saldoDelEjercicio(f, f.cuentas[codigo]), `${codigo} no barrió`).toBeCloseTo(0, 4);
    }

    // Y el primer cierre no se borró: quedó REVERSADO, con espejo propio (041).
    const reversados = await query<{ n: string }>(
      `SELECT count(*)::text n FROM journal_entries
        WHERE entity_id = $1 AND entry_type = 'closing' AND reversed_by_entry_id IS NOT NULL`,
      [f.entityId]
    );
    expect(reversados.rows[0].n).toBe(cierresPrimera.rows[0].n);

    const espejos = await query<{ n: string }>(
      `SELECT count(*)::text n FROM journal_entries
        WHERE entity_id = $1 AND entry_type = 'reversing' AND status = 'posted'
          AND description LIKE '%Recierre de periodo reabierto%'`,
      [f.entityId]
    );
    expect(Number(espejos.rows[0].n)).toBe(Number(cierresPrimera.rows[0].n));
  });

  it('con la política en prohibir, el segundo cierre se niega nombrando el asiento', async () => {
    const f = await crearInquilino('Recierre prohibido');
    enterTenant(f.tenantId);
    await seedPolicies({ tenantId: f.tenantId });
    await resolvePolicy(
      { tenantId: f.tenantId },
      'cierre_recierre_de_periodo_reabierto',
      'prohibir',
      f.userId
    );

    await poblarEjercicio(f);
    await softClosePeriod(f.periodos[12], f.entityId, f.userId);
    await hardClosePeriod(f.periodos[12], f.entityId, f.userId);

    await reopenClosedPeriod(f.entityId, f.periodos[12], f.userId, 'ajuste tardío');
    await softClosePeriod(f.periodos[12], f.entityId, f.userId);
    await expect(
      hardClosePeriod(f.periodos[12], f.entityId, f.userId, 'segundo cierre')
    ).rejects.toThrow(/ya emitió su cierre/i);

    // La transacción se revirtió entera: el periodo sigue en soft_close.
    const { rows } = await query<{ status: string }>(
      'SELECT status FROM fiscal_periods WHERE id = $1',
      [f.periodos[12]]
    );
    expect(rows[0].status).toBe('soft_close');
  });
});
