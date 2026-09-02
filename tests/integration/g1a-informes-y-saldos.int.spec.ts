import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import {
  getIncomeStatement,
  getTrialBalance,
  queryIncomeStatementRows,
  getAuxiliaryView,
} from '../../src/services/reporting/report-service.js';
import { runLedgerChecks } from '../../src/services/accounting/ledger-checks.js';
import { softClosePeriod, hardClosePeriod } from '../../src/services/accounting/period-close.js';
import {
  reopenClosedPeriod,
  restorePeriodStatus,
} from '../../src/services/accounting/fiscal-calendar-service.js';
import {
  seedPolicies,
  resolvePolicy,
  reopenPolicy,
} from '../../src/services/policy/policy-service.js';
import { JournalEntryType } from '../../src/types/index.js';

/**
 * G1a · LOS INFORMES QUE NO CONTABAN EL CIERRE, Y LOS SALDOS QUE NADIE
 * VERIFICABA.
 *
 * Todo lo de aquí produce CIFRAS QUE SE FIRMAN, así que la prueba es de
 * conducta contra Postgres y no de forma: un regex sobre el SQL habría pasado
 * igual de verde con la aritmética mal.
 *
 * Corre como superusuario a propósito: RLS queda inerte y lo que se comprueba
 * es la frontera del CÓDIGO (ver frontera-entidad-ten).
 */

let f: Fixture;

/** Un asiento posteado del tipo que se pida, fechado donde diga la prueba. */
async function asiento(
  fx: Fixture,
  fecha: string,
  tipo: JournalEntryType,
  cargo: string,
  abono: string,
  monto: string,
  descripcion: string
) {
  return createJournalEntry(
    fx.entityId,
    new Date(`${fecha}T00:00:00Z`),
    tipo,
    descripcion,
    [
      { account_id: fx.cuentas[cargo], debit_amount: monto, credit_amount: null, description: 'cargo' },
      { account_id: fx.cuentas[abono], debit_amount: null, credit_amount: monto, description: 'abono' },
    ],
    fx.userId,
    { autoPost: true }
  );
}

const politica = (valor: string) =>
  resolvePolicy(
    { tenantId: f.tenantId, entityId: f.entityId },
    'informes_asientos_de_cierre',
    valor,
    f.userId,
    'fijada por la prueba de integración'
  );

beforeAll(async () => {
  f = await crearInquilino('G1a informes y saldos');

  // El ejercicio 2026: 10 000 de ventas en enero y 6 000 de costo en marzo.
  // Utilidad de 4 000, y es la cifra que el estado de resultados tiene que
  // seguir diciendo después de cerrar.
  await asiento(f, '2026-01-15', JournalEntryType.STANDARD, '1120', '4100', '10000.0000', 'Venta del ejercicio');
  await asiento(f, '2026-03-10', JournalEntryType.STANDARD, '5100', '1120', '6000.0000', 'Costo del ejercicio');

  // EL CIERRE, A MANO Y FECHADO EL ÚLTIMO DÍA DEL EJERCICIO.
  //
  // Se emite aquí en vez de llamar a hardClosePeriod porque lo que se prueba
  // son los INFORMES: basta con que exista un asiento 'closing' dentro del
  // rango, que es exactamente la situación que hacía imprimir «Net income
  // 0.0000». Barre las dos cuentas de resultados contra 3900.
  await createJournalEntry(
    f.entityId,
    new Date('2026-12-31T00:00:00Z'),
    JournalEntryType.CLOSING,
    'Year-end closing entries',
    [
      { account_id: f.cuentas['4100'], debit_amount: '10000.0000', credit_amount: null, description: 'cierra ventas' },
      { account_id: f.cuentas['5100'], debit_amount: null, credit_amount: '6000.0000', description: 'cierra costo' },
      { account_id: f.cuentas['3900'], debit_amount: null, credit_amount: '4000.0000', description: 'resultado' },
    ],
    f.userId,
    { autoPost: true }
  );

  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
});

afterAll(async () => {
  await drainAttestations(2000);
  await closeDatabase();
});

// ============================================================
// 1 · EL EJERCICIO QUE GANÓ 4 000 Y SE PUBLICABA EN CERO
// ============================================================

describe('el estado de resultados no cuenta el asiento que guarda el resultado', () => {
  it('un ejercicio con 10 000 de ventas ya no imprime «Net income 0.0000»', async () => {
    const is = await getIncomeStatement(f.entityId, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    // Sin el filtro, el asiento de cierre —fechado el 31 de diciembre, DENTRO
    // del rango— cancelaba exactamente lo que el informe acababa de sumar.
    expect(is.revenue.total).toBe('10000.0000');
    expect(is.expenses.total).toBe('6000.0000');
    expect(is.net_income).toBe('4000.0000');
  });

  it('y lo dice: el rango contiene el cierre del ejercicio', async () => {
    const is = await getIncomeStatement(f.entityId, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    expect(is.closing).toBeDefined();
    expect(is.closing!.entries).toBe(1);
    expect(is.closing!.included).toBe(false);
    expect(is.closing!.note).toMatch(/close of the fiscal year/i);
  });

  it('un rango sin cierre dentro no arrastra ninguna nota', async () => {
    const is = await getIncomeStatement(f.entityId, {
      startDate: '2026-01-01',
      endDate: '2026-06-30',
    });
    expect(is.closing).toBeUndefined();
    expect(is.net_income).toBe('4000.0000');
  });

  it('el filtro no depende de `include`: la superficie del agente obtiene lo mismo', async () => {
    // report-tools pasa 'any-activity' y la CLI 'nonzero-net'. Si el filtro
    // del cierre colgara de ese parámetro, las dos superficies volverían a
    // contestar cifras distintas sobre el mismo ejercicio.
    const filas = await queryIncomeStatementRows(f.entityId, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      include: 'any-activity',
    });
    const ventas = filas.find((r) => r.code === '4100');
    const costo = filas.find((r) => r.code === '5100');
    expect(ventas?.credit_total).toBe('10000.0000');
    expect(ventas?.debit_total).toBe('0');
    expect(costo?.debit_total).toBe('6000.0000');
  });
});

// ============================================================
// 2 · LA BALANZA SÍ LOS CUENTA, Y LO DICE
// ============================================================

describe('la balanza cuenta el cierre y lo advierte', () => {
  it('las cuentas de resultados aparecen barridas y la nota lo anuncia', async () => {
    const tb = await getTrialBalance(f.entityId, {
      sinceDate: '2026-01-01',
      untilDate: '2026-12-31',
    });
    const ventas = tb.rows.find((r) => r.account_code === '4100');
    // 10 000 al haber por la venta y 10 000 al debe por el cierre: la balanza
    // enseña las dos, que es lo que la ata con el mayor.
    expect(ventas?.credit_total).toBe('10000.0000');
    expect(ventas?.debit_total).toBe('10000.0000');
    expect(tb.closing).toBeDefined();
    expect(tb.closing!.included).toBe(true);
    expect(tb.closing!.note).toMatch(/counted here/i);
  });

  it('y sigue cuadrando', async () => {
    const tb = await getTrialBalance(f.entityId, {
      sinceDate: '2026-01-01',
      untilDate: '2026-12-31',
    });
    expect(tb.totals.is_balanced).toBe(true);
  });
});

// ============================================================
// 3 · LA POLÍTICA TIENE LECTOR: CONTESTARLA CAMBIA LAS CIFRAS
// ============================================================

describe('informes_asientos_de_cierre manda de verdad', () => {
  afterAll(async () => {
    // El resto del archivo trabaja con el criterio por omisión.
    await reopenPolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'informes_asientos_de_cierre');
  });

  it('«excluir_siempre» saca el cierre también de la balanza', async () => {
    await politica('excluir_siempre');
    const tb = await getTrialBalance(f.entityId, {
      sinceDate: '2026-01-01',
      untilDate: '2026-12-31',
    });
    const ventas = tb.rows.find((r) => r.account_code === '4100');
    expect(ventas?.debit_total).toBe('0');
    expect(tb.closing!.included).toBe(false);
  });

  it('«incluir_siempre_y_advertir» devuelve el cero al estado de resultados, pero avisado', async () => {
    await reopenPolicy({ tenantId: f.tenantId, entityId: f.entityId }, 'informes_asientos_de_cierre');
    await politica('incluir_siempre_y_advertir');
    const is = await getIncomeStatement(f.entityId, {
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    expect(is.net_income).toBe('0.0000');
    // La diferencia con el defecto original no es la cifra: es que ahora la
    // cifra viene acompañada del motivo, y es una decisión de alguien.
    expect(is.closing!.included).toBe(true);
    expect(is.closing!.note).toMatch(/counted here/i);
  });
});

// ============================================================
// 4 · checkBalance DEJA DE SER CIEGO A ending_balance
// ============================================================

describe('el chequeo «balance» mira las columnas que el cierre escribe', () => {
  const hallazgosBalance = async () =>
    (await runLedgerChecks(f.entityId, ['balance'])).filter((h) => h.check === 'balance');

  it('parte de un mayor limpio', async () => {
    expect(await hallazgosBalance()).toEqual([]);
  });

  it('inyectar 99 999 en ending_balance da hallazgo, con cuenta y periodo', async () => {
    // debit_total y credit_total quedan INTACTOS: el contraste contra las
    // líneas —lo único que había— sigue viendo un mayor sano, y ésa es la
    // razón por la que este defecto vivió tanto.
    await query(
      `UPDATE account_balances SET ending_balance = 99999
        WHERE account_id = $1 AND fiscal_period_id = $2`,
      [f.cuentas['1120'], f.periodos[1]]
    );

    const hallazgos = await hallazgosBalance();
    expect(hallazgos.length).toBeGreaterThan(0);
    const h = hallazgos.find((x) => x.referencia.startsWith('1120'));
    expect(h, 'el hallazgo tiene que nombrar la cuenta 1120').toBeDefined();
    expect(h!.referencia).toContain('Periodo 1/2026');
    expect(h!.detalle).toContain('99999');
    expect(h!.severity).toBe('blocking');

    // El filtro por cuenta lo encuentra igual (y no se vuelve estéril).
    const porCuenta = await runLedgerChecks(f.entityId, ['balance'], { account: '1120' });
    expect(porCuenta.length).toBeGreaterThan(0);

    await query(
      `UPDATE account_balances
          SET ending_balance = beginning_balance + debit_total - credit_total
        WHERE account_id = $1 AND fiscal_period_id = $2`,
      [f.cuentas['1120'], f.periodos[1]]
    );
    expect(await hallazgosBalance()).toEqual([]);
  });

  it('un arrastre que no encadena sale nombrado por sus dos periodos', async () => {
    // Cierre duro REAL de enero: es lo que siembra el saldo inicial de
    // febrero, y por tanto lo único que hace exigible el encadenamiento.
    await softClosePeriod(f.periodos[1], f.entityId, f.userId);
    await hardClosePeriod(f.periodos[1], f.entityId, f.userId, 'cierre de enero');
    expect(await hallazgosBalance()).toEqual([]);

    const antes = await saldo(f.cuentas['1120'], f.periodos[2]);
    expect(antes?.beginning).toBe('10000.0000');

    // Se rompe SÓLO la cadena: el invariante dentro del renglón se mantiene,
    // así que el hallazgo no puede venir del otro contraste.
    await query(
      `UPDATE account_balances
          SET beginning_balance = 1,
              ending_balance = 1 + debit_total - credit_total
        WHERE account_id = $1 AND fiscal_period_id = $2`,
      [f.cuentas['1120'], f.periodos[2]]
    );

    const hallazgos = await hallazgosBalance();
    const h = hallazgos.find((x) => x.detalle.includes('no encadena'));
    expect(h, 'la rotura del arrastre tiene que salir').toBeDefined();
    expect(h!.referencia).toContain('Periodo 1/2026');
    expect(h!.referencia).toContain('Periodo 2/2026');

    await query(
      `UPDATE account_balances
          SET beginning_balance = 10000, ending_balance = 10000 + debit_total - credit_total
        WHERE account_id = $1 AND fiscal_period_id = $2`,
      [f.cuentas['1120'], f.periodos[2]]
    );
    expect(await hallazgosBalance()).toEqual([]);
  });
});

async function saldo(accountId: string, periodId: string) {
  const r = await query<{ beginning: string; ending: string }>(
    `SELECT beginning_balance::text AS beginning, ending_balance::text AS ending
       FROM account_balances WHERE account_id = $1 AND fiscal_period_id = $2`,
    [accountId, periodId]
  );
  return r.rows[0];
}

// ============================================================
// 5 · EL SALDO INICIAL LO JURA EL PERIODO ANTERIOR
// ============================================================

describe('inicial_confiable', () => {
  it('febrero tiene inicial de fiar porque ENERO cerró duro, no porque febrero esté abierto', async () => {
    const aux = await getAuxiliaryView(f.entityId, '1120', 'Periodo 2/2026');
    expect(aux.period_status).toBe('open');
    expect(aux.inicial).toBe('10000.0000');
    // Antes juraba por el periodo consultado: febrero abierto daba `false`
    // sobre un inicial perfectamente arrastrado.
    expect(aux.inicial_confiable).toBe(true);
    expect(aux.periodo_anterior?.period_name).toBe('Periodo 1/2026');
  });

  it('un mes cerrado cuyo anterior sigue abierto NO tiene inicial de fiar', async () => {
    // Se cierra abril con marzo abierto — se cierra fuera de orden más a
    // menudo de lo que se admite, y el XML del Anexo 24 atesta este campo.
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [f.periodos[4]]);
    const aux = await getAuxiliaryView(f.entityId, '1120', 'Periodo 4/2026');
    expect(aux.period_status).toBe('hard_close');
    // Antes: `true`, porque miraba el estado de abril.
    expect(aux.inicial_confiable).toBe(false);
    expect(aux.periodo_anterior).toEqual({ period_name: 'Periodo 3/2026', status: 'open' });
    await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [f.periodos[4]]);
  });

  it('el primer periodo del ejercicio no finge un acumulado que nadie arrastró', async () => {
    const aux = await getAuxiliaryView(f.entityId, '1120', 'Periodo 1/2026');
    expect(aux.periodo_anterior).toBeNull();
    expect(aux.inicial_confiable).toBe(false);
  });
});

// ============================================================
// 6 · restorePeriodStatus VUELVE A ARRASTRAR
// ============================================================

describe('volver a cerrar un periodo reabierto rehace el arrastre', () => {
  it('lo posteado durante la reapertura llega al saldo inicial del mes siguiente', async () => {
    // Enero quedó en hard_close arriba, y febrero abre en 10 000.
    expect((await saldo(f.cuentas['1120'], f.periodos[2]))?.beginning).toBe('10000.0000');

    const r = await reopenClosedPeriod(
      f.entityId,
      f.periodos[1],
      f.userId,
      'corrección que sólo cabe en enero'
    );
    expect(r.previousStatus).toBe('hard_close');

    await asiento(f, '2026-01-20', JournalEntryType.CORRECTION, '1120', '4100', '500.0000', 'Corrección de enero');

    await restorePeriodStatus(
      f.entityId,
      f.periodos[1],
      r.previousStatus,
      f.userId,
      'Cierre restaurado tras la corrección.'
    );

    // ANTES: un UPDATE pelado del status devolvía la etiqueta y dejaba a
    // febrero abriendo en 10 000 — la corrección se quedaba dentro de enero y
    // desaparecía del ejercicio a partir de febrero.
    const despues = await saldo(f.cuentas['1120'], f.periodos[2]);
    expect(despues?.beginning).toBe('10500.0000');
    expect(despues?.ending).toBe('10500.0000');

    // Y el mayor lo confirma por su cuenta: sin re-arrastre, el chequeo del
    // encadenamiento habría cazado exactamente esto.
    const hallazgos = await runLedgerChecks(f.entityId, ['balance']);
    expect(hallazgos).toEqual([]);

    const periodo = await query<{ status: string }>(
      'SELECT status FROM fiscal_periods WHERE id = $1',
      [f.periodos[1]]
    );
    expect(periodo.rows[0].status).toBe('hard_close');
  });

  it('deja constancia de cuántas cuentas volvió a arrastrar', async () => {
    const r = await query<{ new_values: { carried_accounts?: number } }>(
      `SELECT new_values FROM audit_log
        WHERE entity_type = 'fiscal_period' AND entity_id = $1 AND action = 'close'
        ORDER BY timestamp DESC, id DESC
        LIMIT 1`,
      [f.periodos[1]]
    );
    expect(r.rows[0]?.new_values?.carried_accounts).toBeGreaterThan(0);
  });
});
