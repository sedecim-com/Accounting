import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { createJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import {
  registrarPagoAnticipado,
  huecoDeAnticipados,
  respaldoDisponible,
  revisionDeAmortizacionAlCierre,
} from '../../src/services/accruals/prepaid-service.js';
import { runMonthlyAmortization } from '../../src/services/accruals/amortization-run.js';

/**
 * D1a · EL DEVENGO EXISTE, Y SE COMPRUEBA CONTRA EL MAYOR.
 *
 * La 1160 llevaba sembrada desde el principio con la descripción «se devengan
 * mes a mes», el clasificador del CFDI ofrecía la opción citando la NIF A-2, y
 * NO HABÍA NI TABLA. El camino de escritura vivo y el de lectura inexistente:
 * el saldo era cero por suerte, no por diseño.
 *
 * Lo que estas pruebas tienen que demostrar no es que las funciones existan
 * —eso lo dice el typecheck— sino las cuatro cosas que sólo se ven con el
 * mayor detrás:
 *
 *   1. Que doce meses corridos dejen la 1160 EN CERO y el gasto en resultados,
 *      sin un centavo de deriva.
 *   2. Que el mismo mes corrido dos veces NO cargue el gasto dos veces.
 *   3. Que no se pueda devengar más de lo que hay posteado en la cuenta.
 *   4. Que la corrida no cruce entidades.
 */

let A: Fixture;
let B: Fixture;

/** Carga la 1160 como lo haría el camino del CFDI: DR 1160 / CR banco, posteado. */
async function cargarAnticipado(f: Fixture, importe: string, fecha: string): Promise<string> {
  enterTenant(f.tenantId);
  const je = await createJournalEntry(
    f.entityId,
    new Date(`${fecha}T00:00:00`),
    JournalEntryType.STANDARD,
    'Pago de póliza anual',
    [
      {
        account_id: f.roles.gasto_anticipado,
        debit_amount: importe,
        credit_amount: null,
        description: 'Póliza anual',
      },
      {
        account_id: f.roles.banco,
        debit_amount: null,
        credit_amount: importe,
        description: 'Pago',
      },
    ],
    f.userId,
    { autoPost: true }
  );
  return je.id;
}

/** Saldo POSTEADO de una cuenta en el mayor de una entidad. */
async function saldoDe(entityId: string, accountId: string): Promise<string> {
  const r = await query<{ saldo: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.debit_amount,0) - COALESCE(jel.credit_amount,0)), 0)::text AS saldo
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = $2 AND je.entity_id = $1 AND je.status = 'posted'`,
    [entityId, accountId]
  );
  return new Decimal(r.rows[0].saldo).toFixed(4);
}

beforeAll(async () => {
  A = await crearInquilino('D1a devengo');
  B = await crearEntidadHermana(A, 'D1a hermana');
  await seedPolicies({ tenantId: A.tenantId, entityId: A.entityId });
  await seedPolicies({ tenantId: B.tenantId, entityId: B.entityId });
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

// ── 1 · DOCE MESES DEJAN LA 1160 EN CERO ────────────────────────────────
describe('la póliza anual se devenga entera y sin deriva', () => {
  it('doce corridas suman EXACTAMENTE el importe y vacían la cuenta de activo', async () => {
    enterTenant(A.tenantId);
    const asiento = await cargarAnticipado(A, '120000.0000', '2026-01-05');

    expect(await saldoDe(A.entityId, A.roles.gasto_anticipado)).toBe('120000.0000');

    const { anticipo, calendario } = await registrarPagoAnticipado({
      entityId: A.entityId,
      descripcion: 'Póliza de seguro 2026',
      importe: '120000.0000',
      inicio: '2026-01-01',
      fin: '2026-12-31',
      origen: 'cfdi',
      sourceJournalEntryId: asiento,
      createdBy: A.userId,
    });
    expect(calendario).toHaveLength(12);

    for (let mes = 1; mes <= 12; mes++) {
      const r = await runMonthlyAmortization(A.entityId, A.periodos[mes], A.userId);
      expect(r.errors).toEqual([]);
      expect(r.processed).toBe(1);
    }

    // EL MAYOR ES EL JUEZ. Doce asientos, y la 1160 en cero: ni un centavo de
    // deriva, que es lo que el tapón del último renglón compra.
    expect(await saldoDe(A.entityId, A.roles.gasto_anticipado)).toBe('0.0000');
    expect(await saldoDe(A.entityId, A.roles.gasto)).toBe('120000.0000');

    const renglones = await query<{ n: string; suma: string; posteados: string }>(
      `SELECT count(*)::text AS n,
              SUM(amortization_amount)::text AS suma,
              count(*) FILTER (WHERE is_posted AND journal_entry_id IS NOT NULL)::text AS posteados
         FROM prepaid_amortization_schedules WHERE prepaid_expense_id = $1`,
      [anticipo.id]
    );
    expect(renglones.rows[0].n).toBe('12');
    expect(new Decimal(renglones.rows[0].suma).toFixed(4)).toBe('120000.0000');
    // La 059 exige el asiento para `is_posted`: no hay renglón que afirme
    // estar en el mayor sin poder decir dónde.
    expect(renglones.rows[0].posteados).toBe('12');

    const ficha = await query<{ amortized: string; remaining: string; status: string }>(
      `SELECT amortized_to_date::text AS amortized, remaining_amount::text AS remaining, status
         FROM prepaid_expenses WHERE id = $1`,
      [anticipo.id]
    );
    expect(new Decimal(ficha.rows[0].amortized).toFixed(4)).toBe('120000.0000');
    expect(new Decimal(ficha.rows[0].remaining).toFixed(4)).toBe('0.0000');
    expect(ficha.rows[0].status).toBe('fully_amortized');
  }, 180_000);

  it('cada asiento cae en el periodo que se corrió, no en el del calendario', async () => {
    const r = await query<{ mismo: string }>(
      `SELECT count(*)::text AS mismo
         FROM prepaid_amortization_schedules s
         JOIN journal_entries je ON je.id = s.journal_entry_id
        WHERE s.entity_id = $1 AND je.fiscal_period_id = s.fiscal_period_id`,
      [A.entityId]
    );
    // El defecto B de F06a: `createJournalEntry` deduce el periodo DE LA FECHA,
    // así que una fecha del mes anterior colgaba el asiento de otro periodo que
    // el de su propia fila.
    expect(r.rows[0].mismo).toBe('12');
  });
});

// ── 2 · EL FRENO DE DOBLE CORRIDA ───────────────────────────────────────
describe('el mismo mes corrido dos veces', () => {
  it('no carga el gasto dos veces', async () => {
    enterTenant(A.tenantId);
    const asiento = await cargarAnticipado(A, '60000.0000', '2026-01-05');
    await registrarPagoAnticipado({
      entityId: A.entityId,
      descripcion: 'Renta anticipada semestral',
      importe: '60000.0000',
      inicio: '2026-01-01',
      fin: '2026-06-30',
      origen: 'manual',
      sourceJournalEntryId: asiento,
      createdBy: A.userId,
    });

    const antes = await saldoDe(A.entityId, A.roles.gasto);
    const primera = await runMonthlyAmortization(A.entityId, A.periodos[1], A.userId);
    const segunda = await runMonthlyAmortization(A.entityId, A.periodos[1], A.userId);
    const despues = await saldoDe(A.entityId, A.roles.gasto);

    expect(primera.processed).toBe(1);
    expect(segunda.processed).toBe(0);
    expect(segunda.skipped).toBeGreaterThan(0);
    // Un solo cargo de enero: 60.000 × 31/181.
    const cargado = new Decimal(despues).minus(antes);
    expect(cargado.toFixed(4)).toBe(primera.total);
    expect(cargado.greaterThan(0)).toBe(true);
  }, 120_000);
});

// ── 3 · NO SE DEVENGA LO QUE NO ESTÁ POSTEADO ───────────────────────────
describe('el respaldo en la cuenta', () => {
  it('rechaza adoptar dos veces el mismo saldo, que dejaría la 1160 en negativo', async () => {
    enterTenant(A.tenantId);
    const asiento = await cargarAnticipado(A, '30000.0000', '2026-02-02');
    await registrarPagoAnticipado({
      entityId: A.entityId,
      descripcion: 'Licencia anual',
      importe: '30000.0000',
      inicio: '2026-02-01',
      fin: '2027-01-31',
      origen: 'cfdi',
      sourceJournalEntryId: asiento,
      createdBy: A.userId,
    });

    await expect(
      registrarPagoAnticipado({
        entityId: A.entityId,
        descripcion: 'Licencia anual (otra vez)',
        importe: '30000.0000',
        inicio: '2026-02-01',
        fin: '2027-01-31',
        origen: 'cfdi',
        sourceJournalEntryId: asiento,
        createdBy: A.userId,
      })
    ).rejects.toThrow(/No hay saldo posteado que respalde/);
  }, 120_000);

  it('el umbral del panel detiene lo inmaterial, y forzarlo deja rastro', async () => {
    enterTenant(A.tenantId);
    const asiento = await cargarAnticipado(A, '900.0000', '2026-03-02');

    // `umbral_anticipado_mxn` vale 5.000 por defecto: 900 no se parte en doce.
    await expect(
      registrarPagoAnticipado({
        entityId: A.entityId,
        descripcion: 'Suscripción anual barata',
        importe: '900.0000',
        inicio: '2026-03-01',
        fin: '2027-02-28',
        origen: 'manual',
        createdBy: A.userId,
      })
    ).rejects.toThrow(/umbral/);

    const forzado = await registrarPagoAnticipado({
      entityId: A.entityId,
      descripcion: 'Suscripción anual barata',
      importe: '900.0000',
      inicio: '2026-03-01',
      fin: '2027-02-28',
      origen: 'cfdi',
      sourceJournalEntryId: asiento,
      createdBy: A.userId,
      forzarBajoUmbral: true,
    });
    expect(forzado.avisos.join(' ')).toMatch(/umbral/);
    expect(forzado.anticipo.notes).toMatch(/umbral/);
  }, 120_000);

  it('contestar la política cambia el umbral que se aplica', async () => {
    enterTenant(B.tenantId);
    await resolvePolicy({ tenantId: B.tenantId, entityId: B.entityId }, 'umbral_anticipado_mxn', '20000', B.userId);
    const asiento = await cargarAnticipado(B, '12000.0000', '2026-01-05');
    // 12.000 pasaba con el umbral por defecto de 5.000 y ya no pasa con 20.000:
    // el panel gobierna de verdad.
    await expect(
      registrarPagoAnticipado({
        entityId: B.entityId,
        descripcion: 'Seguro de flotilla',
        importe: '12000.0000',
        inicio: '2026-01-01',
        fin: '2026-12-31',
        origen: 'cfdi',
        sourceJournalEntryId: asiento,
        createdBy: B.userId,
      })
    ).rejects.toThrow(/20000\.00|20,000/);
  }, 120_000);
});

// ── 4 · LA FRONTERA DE ENTIDAD ──────────────────────────────────────────
describe('la corrida no cruza entidades', () => {
  it('rechaza el periodo fiscal de la entidad hermana', async () => {
    enterTenant(A.tenantId);
    await expect(runMonthlyAmortization(A.entityId, B.periodos[4], A.userId)).rejects.toThrow(
      /no existe o no es de esta entidad/
    );
  });

  it('la hermana no ve ni devenga los anticipos de la otra', async () => {
    enterTenant(A.tenantId);
    const r = await runMonthlyAmortization(B.entityId, B.periodos[5], B.userId);
    expect(r.processed).toBe(0);
    const filas = await query<{ n: string }>(
      'SELECT count(*)::text AS n FROM prepaid_amortization_schedules WHERE entity_id = $1',
      [B.entityId]
    );
    expect(filas.rows[0].n).toBe('0');
  }, 120_000);
});

// ── 5 · LA DEUDA HEREDADA ───────────────────────────────────────────────
describe('el hueco: saldo en la 1160 que ningún calendario reclama', () => {
  it('lo mide y lo desglosa por asiento', async () => {
    enterTenant(A.tenantId);
    const antes = await huecoDeAnticipados(A.entityId);

    // Un cargo del camino del CFDI SIN calendario: exactamente la deuda que
    // este tramo hereda.
    const huerfano = await cargarAnticipado(A, '45000.0000', '2026-04-10');

    const despues = await huecoDeAnticipados(A.entityId);
    expect(new Decimal(despues.hueco).minus(antes.hueco).toFixed(4)).toBe('45000.0000');
    expect(despues.hayHueco).toBe(true);
    expect(despues.asientos.map((a) => a.journal_entry_id)).toContain(huerfano);

    // Y adoptarlo lo cierra: el mismo saldo pasa a tener quién lo devengue.
    await registrarPagoAnticipado({
      entityId: A.entityId,
      descripcion: 'Póliza vieja adoptada',
      importe: '45000.0000',
      inicio: '2026-04-01',
      fin: '2026-09-30',
      origen: 'saldo_preexistente',
      sourceJournalEntryId: huerfano,
      createdBy: A.userId,
    });
    const cerrado = await huecoDeAnticipados(A.entityId);
    expect(new Decimal(cerrado.hueco).toFixed(4)).toBe(new Decimal(antes.hueco).toFixed(4));
    expect(cerrado.asientos.map((a) => a.journal_entry_id)).not.toContain(huerfano);
  }, 120_000);

  it('el respaldo distingue lo posteado de lo ya adoptado', async () => {
    enterTenant(A.tenantId);
    const r = await respaldoDisponible(A.entityId, A.roles.gasto_anticipado);
    expect(new Decimal(r.saldoPosteado).minus(r.yaAdoptado).toFixed(4)).toBe(
      new Decimal(r.disponible).toFixed(4)
    );
  });
});

// ── 6 · LA CASILLA DEL CIERRE ───────────────────────────────────────────
describe('la revisión del cierre', () => {
  it('nombra los anticipos sin correr y obedece a la política', async () => {
    enterTenant(A.tenantId);
    // Mayo: la póliza adoptada en abril cubre mayo y nadie la ha corrido.
    const aviso = await revisionDeAmortizacionAlCierre(A.entityId, A.periodos[5]);
    expect(aviso.pendientes.length).toBeGreaterThan(0);
    expect(aviso.reaccion).toBe('avisar');
    expect(aviso.bloquea).toBe(false);
    expect(aviso.mensaje).toMatch(/sin amortizar/);

    await resolvePolicy(
      { tenantId: A.tenantId, entityId: A.entityId },
      'amortizacion_faltante_al_cierre',
      'bloquear',
      A.userId
    );
    const bloqueo = await revisionDeAmortizacionAlCierre(A.entityId, A.periodos[5]);
    expect(bloqueo.bloquea).toBe(true);

    // Y corriendo el mes, la casilla se apaga.
    await runMonthlyAmortization(A.entityId, A.periodos[5], A.userId);
    const limpio = await revisionDeAmortizacionAlCierre(A.entityId, A.periodos[5]);
    expect(limpio.pendientes).toEqual([]);
    expect(limpio.bloquea).toBe(false);
  }, 180_000);
});
