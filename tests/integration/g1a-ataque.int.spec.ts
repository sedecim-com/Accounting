import { describe, it, expect, afterAll } from 'vitest';
import Decimal from 'decimal.js';
import {
  crearInquilino,
  crearEntidadHermana,
  fechaEnPeriodo,
  type Fixture,
} from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { softClosePeriod, hardClosePeriod } from '../../src/services/accounting/period-close.js';
import {
  reopenClosedPeriod,
  restorePeriodStatus,
} from '../../src/services/accounting/fiscal-calendar-service.js';
import { runLedgerChecks } from '../../src/services/accounting/ledger-checks.js';
import {
  getIncomeStatement,
  getTrialBalance,
  getBalanceSheet,
  getAuxiliaryView,
  queryUnclosedEarnings,
} from '../../src/services/reporting/report-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// G1a · EL ATAQUE. Lo que aquí se firma es el capital contable de un
// ejercicio: si una de estas afirmaciones se puede falsear, se firma.
//
// Las pruebas de la implementación miden el cierre en el instante justo
// después de emitirlo. Este archivo mide LO QUE PASA DESPUÉS: el informe que
// se imprime tras un recierre, el saldo inicial que hereda el mes siguiente
// cuando una corrección lleva una cuenta a cero, el cierre que se declara
// hecho sin haber emitido una sola línea, y la frontera de entidad en cada
// una de esas consultas.
//
// Corre como superusuario a propósito: RLS queda inerte y lo que se ataca es
// la aritmética del CÓDIGO (ver frontera-entidad-ten).
// ============================================================

const ANIO = { desde: '2026-01-01', hasta: '2026-12-31' };

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

async function asiento(
  f: Fixture,
  mes: number,
  desc: string,
  cargo: string,
  abono: string,
  monto: string
) {
  return createJournalEntry(
    f.entityId,
    fechaEnPeriodo(mes, 10),
    JournalEntryType.STANDARD,
    desc,
    [
      { account_id: cargo, debit_amount: monto, credit_amount: null, description: desc },
      { account_id: abono, debit_amount: null, credit_amount: monto, description: desc },
    ],
    f.userId,
    { autoPost: true }
  );
}

/** Saldo de la cuenta acumulado sobre TODO el ejercicio (debe − haber). */
async function saldoDelEjercicio(f: Fixture, cuentaId: string): Promise<string> {
  const { rows } = await query<{ s: string }>(
    `SELECT COALESCE(SUM(ab.debit_total - ab.credit_total), 0)::text AS s
       FROM account_balances ab
       JOIN fiscal_periods fp ON fp.id = ab.fiscal_period_id
      WHERE ab.account_id = $1 AND ab.entity_id = $2 AND fp.fiscal_year_id = $3`,
    [cuentaId, f.entityId, f.fiscalYearId]
  );
  return new Decimal(rows[0]?.s ?? 0).toFixed(4);
}

/** El saldo INICIAL que el arrastre sembró en un periodo (cadena, no actividad). */
async function inicialDe(cuentaId: string, periodoId: string): Promise<string> {
  const { rows } = await query<{ b: string }>(
    `SELECT COALESCE(beginning_balance, 0)::text AS b
       FROM account_balances WHERE account_id = $1 AND fiscal_period_id = $2`,
    [cuentaId, periodoId]
  );
  return new Decimal(rows[0]?.b ?? 0).toFixed(4);
}

/** El ejercicio del reconocimiento: utilidad de 3 000, con las dos contra-naturales. */
async function poblarEjercicio(f: Fixture) {
  await asiento(f, 12, 'Ventas', f.cuentas['1120'], f.cuentas['4100'], '10000.0000');
  await asiento(f, 12, 'Devolución sobre ventas', f.cuentas['4400'], f.cuentas['1120'], '2000.0000');
  await asiento(f, 12, 'Costo de ventas', f.cuentas['5100'], f.cuentas['1120'], '6000.0000');
  await asiento(f, 12, 'Devolución sobre compras', f.cuentas['1120'], f.cuentas['5200'], '1000.0000');
}

async function cerrarEjercicio(f: Fixture, motivo?: string) {
  await softClosePeriod(f.periodos[12], f.entityId, f.userId);
  await hardClosePeriod(f.periodos[12], f.entityId, f.userId, motivo);
}

// ============================================================
// 1 · EL INFORME QUE SE IMPRIME DESPUÉS DE UN RECIERRE
//
// `reversar_y_reemitir` (el defecto) emite el ESPEJO del cierre anterior, y
// ese espejo nace con entry_type='reversing' — no 'closing'. El filtro de
// informes deja fuera 'closing' y nada más, así que el espejo entra al estado
// de resultados como si fuera actividad del negocio: devuelve al ingreso y al
// gasto exactamente lo que el cierre reversado les quitó.
// ============================================================

describe('el estado de resultados de un ejercicio que se reabrió y se recerró', () => {
  it('sigue diciendo 3 000: el espejo del cierre reversado no es actividad del negocio', async () => {
    const f = await crearInquilino('Ataque recierre informe');
    enterTenant(f.tenantId);
    await poblarEjercicio(f);
    await cerrarEjercicio(f, 'primer cierre');

    const antes = await getIncomeStatement(f.entityId, {
      startDate: ANIO.desde,
      endDate: ANIO.hasta,
    });
    expect(antes.net_income).toBe('3000.0000');

    await reopenClosedPeriod(f.entityId, f.periodos[12], f.userId, 'ajuste tardío');
    await cerrarEjercicio(f, 'segundo cierre');

    // El mayor sigue barrido —eso ya lo prueba cierre-que-barre— pero el
    // DOCUMENTO que se firma es éste.
    const despues = await getIncomeStatement(f.entityId, {
      startDate: ANIO.desde,
      endDate: ANIO.hasta,
    });
    expect(despues.revenue.total).toBe('8000.0000');
    expect(despues.expenses.total).toBe('5000.0000');
    expect(despues.net_income).toBe('3000.0000');
  });

  it('y la reversa de un asiento NORMAL sí resta, que es lo que la distingue', async () => {
    // El filtro no puede ser «fuera todo lo reversante»: una devolución
    // instrumentada como reversa de la venta es actividad real y tiene que
    // bajar el ingreso.
    const f = await crearInquilino('Ataque reversa normal');
    enterTenant(f.tenantId);
    const venta = await asiento(f, 6, 'Venta', f.cuentas['1120'], f.cuentas['4100'], '1000.0000');

    const { reverseJournalEntry } = await import('../../src/services/accounting/posting.js');
    await reverseJournalEntry(venta.id, f.userId, {
      reason: 'venta cancelada',
      reversalDate: fechaEnPeriodo(6, 20),
    });

    const is = await getIncomeStatement(f.entityId, {
      startDate: ANIO.desde,
      endDate: ANIO.hasta,
    });
    expect(is.revenue.total).toBe('0.0000');
    expect(is.net_income).toBe('0.0000');
  });
});

// ============================================================
// 2 · EL SALDO QUE SE FUE A CERO Y EL MES SIGUIENTE NO SE ENTERÓ
//
// carryForwardBalances siembra el inicial del periodo siguiente con
// `AND ab.ending_balance <> 0`. Una corrección que lleva una cuenta a cero
// dentro de un periodo reabierto no tiene fila que sembrar, y el ON CONFLICT
// nunca corre: el inicial VIEJO sobrevive. Es exactamente el defecto que
// restorePeriodStatus dice haber cerrado, por la puerta de al lado.
// ============================================================

describe('rehacer el arrastre cuando la corrección deja la cuenta en CERO', () => {
  it('el inicial del mes siguiente baja a cero en vez de conservar el acumulado viejo', async () => {
    const f = await crearInquilino('Ataque arrastre a cero');
    enterTenant(f.tenantId);

    // Junio: una cuenta por cobrar de 3 000 contra una cuenta por pagar.
    await asiento(f, 6, 'Alta de cuenta por cobrar', f.cuentas['1120'], f.cuentas['2110'], '3000.0000');
    await softClosePeriod(f.periodos[6], f.entityId, f.userId);
    await hardClosePeriod(f.periodos[6], f.entityId, f.userId, 'cierre de junio');
    expect(await inicialDe(f.cuentas['1120'], f.periodos[7])).toBe('3000.0000');

    // Se reabre junio y se CANCELA la cuenta por cobrar: junio cierra en cero.
    const { previousStatus } = await reopenClosedPeriod(
      f.entityId,
      f.periodos[6],
      f.userId,
      'la factura nunca existió'
    );
    await asiento(f, 6, 'Cancelación', f.cuentas['2110'], f.cuentas['1120'], '3000.0000');
    await restorePeriodStatus(
      f.entityId,
      f.periodos[6],
      previousStatus,
      f.userId,
      'se vuelve a cerrar tras la corrección'
    );

    // Julio no puede abrir en 3 000 cuando junio cerró en 0.
    expect(await inicialDe(f.cuentas['1120'], f.periodos[7])).toBe('0.0000');
    expect(await inicialDe(f.cuentas['2110'], f.periodos[7])).toBe('0.0000');
  });

  it('y si sobrevive, el chequeo «balance» tiene que denunciarlo por su nombre', async () => {
    // La red de seguridad de la red: aunque el arrastre falle, el mayor no
    // puede declararse íntegro.
    const f = await crearInquilino('Ataque arrastre a cero, visto por el chequeo');
    enterTenant(f.tenantId);
    await asiento(f, 6, 'Alta', f.cuentas['1120'], f.cuentas['2110'], '3000.0000');
    await softClosePeriod(f.periodos[6], f.entityId, f.userId);
    await hardClosePeriod(f.periodos[6], f.entityId, f.userId);

    const { previousStatus } = await reopenClosedPeriod(f.entityId, f.periodos[6], f.userId, 'x');
    await asiento(f, 6, 'Cancelación', f.cuentas['2110'], f.cuentas['1120'], '3000.0000');
    await restorePeriodStatus(f.entityId, f.periodos[6], previousStatus, f.userId, 'y');

    const hallazgos = await runLedgerChecks(f.entityId, ['balance']);
    expect(hallazgos, JSON.stringify(hallazgos)).toHaveLength(0);
  });
});

// ============================================================
// 3 · EL CIERRE QUE SE DECLARA HECHO SIN EMITIR UNA LÍNEA
//
// generateClosingEntries devuelve temprano si no encuentra 3900/3200 — ANTES
// de leer la política y ANTES de la comprobación de residuo. El periodo pasa
// a hard_close con el ejercicio ENTERO sin barrer, sin error y sin aviso, que
// es precisamente el caso para el que se escribió severidad_resultado_sin_barrer.
// ============================================================

describe('el cierre sin cuentas de sistema', () => {
  it('se niega (o al menos avisa) en vez de declarar cerrado un ejercicio intacto', async () => {
    const f = await crearInquilino('Ataque sin cuentas de sistema');
    enterTenant(f.tenantId);
    await poblarEjercicio(f);

    // El catálogo pierde la marca de sistema de la 3900 — un catálogo tocado a
    // mano, o migrado desde otro sistema, llega así.
    await query('UPDATE accounts SET is_system_account = false WHERE entity_id = $1 AND code = $2', [
      f.entityId,
      '3900',
    ]);

    await softClosePeriod(f.periodos[12], f.entityId, f.userId);
    await expect(
      hardClosePeriod(f.periodos[12], f.entityId, f.userId, 'cierre sin resumen')
    ).rejects.toThrow(/RESULTADO_SIN_BARRER|no dejó el ejercicio en cero/i);

    const { rows } = await query<{ status: string }>(
      'SELECT status FROM fiscal_periods WHERE id = $1',
      [f.periodos[12]]
    );
    expect(rows[0].status).toBe('soft_close');
    expect(await saldoDelEjercicio(f, f.cuentas['4100'])).toBe('-10000.0000');
  });
});

// ============================================================
// 4 · LOS GUARDAS DEL PUENTE, CON EL TOTAL NEGATIVO Y CON EL TOTAL CERO
// ============================================================

describe('un ejercicio con PÉRDIDA', () => {
  it('cuadra el asiento y lleva la pérdida al capital por el lado deudor', async () => {
    const f = await crearInquilino('Ataque pérdida');
    enterTenant(f.tenantId);
    await asiento(f, 12, 'Ventas', f.cuentas['1120'], f.cuentas['4100'], '4000.0000');
    await asiento(f, 12, 'Sueldos', f.cuentas['6110'], f.cuentas['1120'], '9000.0000');
    await cerrarEjercicio(f);

    expect(await saldoDelEjercicio(f, f.cuentas['4100'])).toBe('0.0000');
    expect(await saldoDelEjercicio(f, f.cuentas['6110'])).toBe('0.0000');
    expect(await saldoDelEjercicio(f, f.cuentas['3900'])).toBe('0.0000');
    // Pérdida: saldo DEUDOR en el destino.
    expect(await saldoDelEjercicio(f, f.cuentas['3300'])).toBe('5000.0000');

    const is = await getIncomeStatement(f.entityId, { startDate: ANIO.desde, endDate: ANIO.hasta });
    expect(is.net_income).toBe('-5000.0000');

    const bs = await getBalanceSheet(f.entityId, { asOfDate: ANIO.hasta });
    expect(bs.out_of_balance).toBe('0.0000');
  });

  it('un ejercicio de PURAS contra-naturales: los dos totales cambian de signo a la vez', async () => {
    // El caso que rompe los dos guardas `greaterThan(0)` al mismo tiempo: el
    // total de ingresos sale DEUDOR (sólo devoluciones) y el de gastos sale
    // ACREEDOR (sólo devoluciones sobre compras).
    const f = await crearInquilino('Ataque puras contra-naturales');
    enterTenant(f.tenantId);
    await asiento(f, 12, 'Devolución sobre ventas', f.cuentas['4400'], f.cuentas['1120'], '2000.0000');
    await asiento(f, 12, 'Devolución sobre compras', f.cuentas['1120'], f.cuentas['5200'], '500.0000');
    await cerrarEjercicio(f);

    expect(await saldoDelEjercicio(f, f.cuentas['4400'])).toBe('0.0000');
    expect(await saldoDelEjercicio(f, f.cuentas['5200'])).toBe('0.0000');
    expect(await saldoDelEjercicio(f, f.cuentas['3900'])).toBe('0.0000');
    // Ingresos netos −2 000, gastos netos −500 → pérdida de 1 500, deudora.
    expect(await saldoDelEjercicio(f, f.cuentas['3300'])).toBe('1500.0000');

    // Y cada asiento del cierre cuadra por sí mismo.
    const { rows } = await query<{ d: string; c: string }>(
      `SELECT total_debits::text AS d, total_credits::text AS c
         FROM journal_entries
        WHERE entity_id = $1 AND entry_type = 'closing' AND status = 'posted'`,
      [f.entityId]
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(new Decimal(r.d).equals(new Decimal(r.c))).toBe(true);
  });

  it('un ejercicio cuyo resultado es CERO exacto no emite puente y deja todo en cero', async () => {
    const f = await crearInquilino('Ataque resultado cero');
    enterTenant(f.tenantId);
    await asiento(f, 12, 'Ventas', f.cuentas['1120'], f.cuentas['4100'], '7000.0000');
    await asiento(f, 12, 'Costo', f.cuentas['5100'], f.cuentas['1120'], '7000.0000');
    await cerrarEjercicio(f);

    expect(await saldoDelEjercicio(f, f.cuentas['4100'])).toBe('0.0000');
    expect(await saldoDelEjercicio(f, f.cuentas['5100'])).toBe('0.0000');
    expect(await saldoDelEjercicio(f, f.cuentas['3900'])).toBe('0.0000');
    expect(await saldoDelEjercicio(f, f.cuentas['3300'])).toBe('0.0000');
    expect(await saldoDelEjercicio(f, f.cuentas['3200'])).toBe('0.0000');
  });
});

// ============================================================
// 5 · EL CENTAVO, Y LA CUENTA QUE NETEA A CERO SIN ESTAR VACÍA
// ============================================================

describe('el residuo más pequeño que se puede firmar', () => {
  it('un centavo de diezmilésima barre igual que diez mil pesos', async () => {
    const f = await crearInquilino('Ataque centavo');
    enterTenant(f.tenantId);
    // 4100 netea a CERO con movimiento en los dos lados: no debe generar
    // línea de cierre, pero tampoco puede quedar fuera del barrido si queda
    // un residuo. 4200 lleva la diezmilésima.
    await asiento(f, 12, 'Venta', f.cuentas['1120'], f.cuentas['4100'], '1234.5678');
    await asiento(f, 12, 'Cancelación', f.cuentas['4100'], f.cuentas['1120'], '1234.5678');
    await asiento(f, 12, 'Servicio mínimo', f.cuentas['1120'], f.cuentas['4200'], '0.0001');
    await cerrarEjercicio(f);

    expect(await saldoDelEjercicio(f, f.cuentas['4100'])).toBe('0.0000');
    expect(await saldoDelEjercicio(f, f.cuentas['4200'])).toBe('0.0000');
    expect(await saldoDelEjercicio(f, f.cuentas['3900'])).toBe('0.0000');
    expect(await saldoDelEjercicio(f, f.cuentas['3300'])).toBe('-0.0001');

    // La cuenta que neteó a cero no ensucia el asiento con una línea de 0.
    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 AND je.entry_type = 'closing' AND jel.account_id = $2`,
      [f.entityId, f.cuentas['4100']]
    );
    expect(rows[0].n).toBe('0');
  });

  it('cuatro decimales que suman distinto según el orden salen iguales', async () => {
    // Tres importes cuya suma en punto flotante depende del orden. El total
    // del barrido tiene que ser exacto a cuatro decimales, en decimal.
    const f = await crearInquilino('Ataque redondeo');
    enterTenant(f.tenantId);
    await asiento(f, 12, 'Venta A', f.cuentas['1120'], f.cuentas['4100'], '0.1000');
    await asiento(f, 12, 'Venta B', f.cuentas['1120'], f.cuentas['4200'], '0.2000');
    await asiento(f, 12, 'Venta C', f.cuentas['1120'], f.cuentas['4300'], '0.3000');
    await asiento(f, 12, 'Gasto', f.cuentas['6110'], f.cuentas['1120'], '0.6000');
    await cerrarEjercicio(f);

    for (const c of ['4100', '4200', '4300', '6110', '3900', '3300']) {
      expect(await saldoDelEjercicio(f, f.cuentas[c]), `${c} no quedó en cero`).toBe('0.0000');
    }
    const is = await getIncomeStatement(f.entityId, { startDate: ANIO.desde, endDate: ANIO.hasta });
    expect(is.net_income).toBe('0.0000');
  });
});

// ============================================================
// 6 · EL CHEQUEO «balance» CONTRA LAS DOS COLUMNAS Y CONTRA LA CADENA
// ============================================================

describe('checkBalance ve las tres mentiras, cada una con su cuenta y su periodo', () => {
  it('99 999 en beginning_balance da hallazgo, no silencio', async () => {
    const f = await crearInquilino('Ataque beginning');
    enterTenant(f.tenantId);
    await asiento(f, 6, 'Alta', f.cuentas['1120'], f.cuentas['2110'], '1000.0000');
    expect(await runLedgerChecks(f.entityId, ['balance'])).toHaveLength(0);

    await query(
      `UPDATE account_balances SET beginning_balance = 99999
        WHERE account_id = $1 AND fiscal_period_id = $2`,
      [f.cuentas['1120'], f.periodos[6]]
    );
    const hallazgos = await runLedgerChecks(f.entityId, ['balance']);
    expect(hallazgos.length).toBeGreaterThan(0);
    expect(hallazgos.some((h) => h.referencia.startsWith('1120') && /Periodo 6/.test(h.referencia))).toBe(
      true
    );
    expect(hallazgos.every((h) => h.severity === 'blocking')).toBe(true);
  });

  it('99 999 en ending_balance da hallazgo, y nombra el invariante', async () => {
    const f = await crearInquilino('Ataque ending');
    enterTenant(f.tenantId);
    await asiento(f, 6, 'Alta', f.cuentas['1120'], f.cuentas['2110'], '1000.0000');
    await query(
      `UPDATE account_balances SET ending_balance = 99999
        WHERE account_id = $1 AND fiscal_period_id = $2`,
      [f.cuentas['1120'], f.periodos[6]]
    );
    const hallazgos = await runLedgerChecks(f.entityId, ['balance']);
    expect(hallazgos.some((h) => /ending_balance dice 99999/.test(h.detalle))).toBe(true);
  });

  it('romper el encadenamiento entre dos periodos sale nombrado por los dos', async () => {
    const f = await crearInquilino('Ataque cadena');
    enterTenant(f.tenantId);
    await asiento(f, 6, 'Alta', f.cuentas['1120'], f.cuentas['2110'], '1000.0000');
    await softClosePeriod(f.periodos[6], f.entityId, f.userId);
    await hardClosePeriod(f.periodos[6], f.entityId, f.userId);
    expect(await runLedgerChecks(f.entityId, ['balance'])).toHaveLength(0);

    // La deriva SIMÉTRICA: se mueve el inicial de julio y su final con él, de
    // modo que el invariante de la fila sigue cuadrando y sólo la CADENA
    // delata la mentira.
    await query(
      `UPDATE account_balances
          SET beginning_balance = beginning_balance + 500,
              ending_balance = ending_balance + 500
        WHERE account_id = $1 AND fiscal_period_id = $2`,
      [f.cuentas['1120'], f.periodos[7]]
    );
    const hallazgos = await runLedgerChecks(f.entityId, ['balance']);
    const cadena = hallazgos.find((h) => /arrastre no encadena/.test(h.detalle));
    expect(cadena, JSON.stringify(hallazgos)).toBeDefined();
    expect(cadena!.referencia).toMatch(/1120/);
    expect(cadena!.referencia).toMatch(/Periodo 6\/2026 → Periodo 7\/2026/);
  });
});

// ============================================================
// 7 · LA FRONTERA DE ENTIDAD (serie TEN) EN TODO ESTE TRAMO
//
// Dos entidades legales del MISMO inquilino: es el eje que RLS no acota,
// porque su predicado es el inquilino.
// ============================================================

describe('un cierre de la entidad A no ve ni toca a la B', () => {
  it('barre A, deja B intacta y no cruza ni una línea', async () => {
    const a = await crearInquilino('Ataque frontera A');
    enterTenant(a.tenantId);
    const b = await crearEntidadHermana(a, 'Ataque frontera B');

    await poblarEjercicio(a);
    await poblarEjercicio(b);

    await softClosePeriod(a.periodos[12], a.entityId, a.userId);
    await hardClosePeriod(a.periodos[12], a.entityId, a.userId, 'sólo A cierra');

    // A barrió.
    expect(await saldoDelEjercicio(a, a.cuentas['4100'])).toBe('0.0000');
    expect(await saldoDelEjercicio(a, a.cuentas['3300'])).toBe('-3000.0000');

    // B no se movió: ni una línea de cierre, ni un peso en su capital.
    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries
        WHERE entity_id = $1 AND entry_type IN ('closing', 'reversing')`,
      [b.entityId]
    );
    expect(rows[0].n).toBe('0');
    expect(await saldoDelEjercicio(b, b.cuentas['4100'])).toBe('-10000.0000');
    expect(await saldoDelEjercicio(b, b.cuentas['3300'])).toBe('0.0000');

    // Y ninguna línea del cierre de A aterrizó en una cuenta de B.
    const cruce = await query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
         JOIN accounts ac ON ac.id = jel.account_id
        WHERE je.entity_id = $1 AND ac.entity_id <> $1`,
      [a.entityId]
    );
    expect(cruce.rows[0].n).toBe('0');
  });

  it('los informes de B no cuentan el cierre de A, ni el chequeo de B ve la corrupción de A', async () => {
    const a = await crearInquilino('Ataque frontera informes A');
    enterTenant(a.tenantId);
    const b = await crearEntidadHermana(a, 'Ataque frontera informes B');

    await poblarEjercicio(a);
    await poblarEjercicio(b);
    await softClosePeriod(a.periodos[12], a.entityId, a.userId);
    await hardClosePeriod(a.periodos[12], a.entityId, a.userId);

    // B no tiene cierre en su rango: no arrastra la nota de A.
    const isB = await getIncomeStatement(b.entityId, {
      startDate: ANIO.desde,
      endDate: ANIO.hasta,
    });
    expect(isB.closing).toBeUndefined();
    expect(isB.net_income).toBe('3000.0000');

    const tbB = await getTrialBalance(b.entityId, { sinceDate: ANIO.desde, untilDate: ANIO.hasta });
    expect(tbB.closing).toBeUndefined();
    expect(tbB.rows.some((r) => r.account_code === '3300' && !new Decimal(r.ending_balance).isZero())).toBe(
      false
    );

    // Se corrompe una fila de A; el chequeo de B tiene que seguir limpio.
    await query(
      `UPDATE account_balances SET ending_balance = 99999
        WHERE account_id = $1 AND fiscal_period_id = $2`,
      [a.cuentas['1120'], a.periodos[12]]
    );
    expect(await runLedgerChecks(b.entityId, ['balance'])).toHaveLength(0);
    expect((await runLedgerChecks(a.entityId, ['balance'])).length).toBeGreaterThan(0);

    // Y el auxiliar de B habla de periodos de B.
    const aux = await getAuxiliaryView(b.entityId, '1120', 'Periodo 12/2026');
    expect(aux.periodo_anterior?.period_name).toBe('Periodo 11/2026');
    expect(aux.inicial_confiable).toBe(false);
  });

  it('la política de la entidad A no gobierna los informes de la B', async () => {
    const a = await crearInquilino('Ataque frontera política A');
    enterTenant(a.tenantId);
    const b = await crearEntidadHermana(a, 'Ataque frontera política B');
    await seedPolicies({ tenantId: a.tenantId, entityId: a.entityId });
    await resolvePolicy(
      { tenantId: a.tenantId, entityId: a.entityId },
      'informes_asientos_de_cierre',
      'incluir_siempre_y_advertir',
      a.userId,
      'sólo para A'
    );

    await poblarEjercicio(a);
    await poblarEjercicio(b);
    await softClosePeriod(a.periodos[12], a.entityId, a.userId);
    await hardClosePeriod(a.periodos[12], a.entityId, a.userId);
    await softClosePeriod(b.periodos[12], b.entityId, b.userId);
    await hardClosePeriod(b.periodos[12], b.entityId, b.userId);

    const isA = await getIncomeStatement(a.entityId, { startDate: ANIO.desde, endDate: ANIO.hasta });
    const isB = await getIncomeStatement(b.entityId, { startDate: ANIO.desde, endDate: ANIO.hasta });
    expect(isA.net_income).toBe('0.0000'); // A pidió contarlos
    expect(isB.net_income).toBe('3000.0000'); // B se queda con el defecto
  });
});

// ============================================================
// 8 · EL BALANCE GENERAL NO PUEDE CUADRAR MINTIENDO
// ============================================================

describe('el capital después del cierre', () => {
  it('recibe el resultado UNA vez aunque el periodo se reabra dos veces', async () => {
    const f = await crearInquilino('Ataque capital una vez');
    enterTenant(f.tenantId);
    await poblarEjercicio(f);
    await cerrarEjercicio(f, 'primero');
    await reopenClosedPeriod(f.entityId, f.periodos[12], f.userId, 'a');
    await cerrarEjercicio(f, 'segundo');
    await reopenClosedPeriod(f.entityId, f.periodos[12], f.userId, 'b');
    await cerrarEjercicio(f, 'tercero');

    expect(await saldoDelEjercicio(f, f.cuentas['3300'])).toBe('-3000.0000');
    expect(await saldoDelEjercicio(f, f.cuentas['3900'])).toBe('0.0000');
    for (const c of ['4100', '4400', '5100', '5200']) {
      expect(await saldoDelEjercicio(f, f.cuentas[c]), `${c} no barrió`).toBe('0.0000');
    }

    const bs = await getBalanceSheet(f.entityId, { asOfDate: ANIO.hasta });
    expect(bs.out_of_balance).toBe('0.0000');
    expect(bs.equity.total).toBe('3000.0000');
    expect(new Decimal(await queryUnclosedEarnings(f.entityId, ANIO.hasta)).toFixed(4)).toBe('0.0000');
  });
});
