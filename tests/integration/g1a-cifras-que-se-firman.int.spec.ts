import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Decimal from 'decimal.js';
import { crearInquilino, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { softClosePeriod, hardClosePeriod } from '../../src/services/accounting/period-close.js';
import {
  getIncomeStatement,
  getTrialBalance,
  getBalanceSheet,
  queryUnclosedEarnings,
  type TrialBalanceReport,
} from '../../src/services/reporting/report-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// G1a · LAS CIFRAS QUE SE FIRMAN, MEDIDAS CONTRA POSTGRES.
//
// report-service.ts exhibía 88% de cobertura y NO tocaba Postgres ni una vez:
// todo su banco de pruebas mockea `query` y le devuelve filas fabricadas —una
// de las cuales RECOMPONE la resta que la consulta declara
// (`ending_balance: String(Number(debit) - Number(credit))`)—. Una prueba que
// se inventa la respuesta del motor no puede acusar al motor: con ese arnés,
// invertir el signo de CUALQUIERA de las sumas firmadas de report-service
// pasaba las 3 500 unitarias en verde.
//
// Este archivo es la conducta que faltaba. No hay un solo mock: el ejercicio
// se postea, se cierra con `hardClosePeriod` de verdad, y los tres estados se
// leen del mismo servicio que firman las tres superficies.
//
// EL EJERCICIO (el del reconocimiento, con las dos contra-naturales):
//   4100 Ventas                       10 000 al haber
//   4400 Devoluciones sobre Ventas     2 000 al DEBE   (revenue deudora)
//   5100 Costo de Ventas               6 000 al debe
//   5200 Devoluciones sobre Compras    1 000 al HABER  (expense acreedora)
//   Utilidad = (10 000 − 2 000) − (6 000 − 1 000) = 3 000
//
// Las cuatro cifras del escenario son distintas entre sí y ninguna es el
// doble ni el negativo de otra a propósito: con 3 000 de utilidad, el abs()
// publicaba 5 000 y la pérdida falsa era 2 000. Una prueba con números
// simétricos habría pasado con los tres.
//
// Corre como superusuario a propósito: RLS queda inerte y lo que se comprueba
// es la aritmética del CÓDIGO (ver frontera-entidad-ten).
// ============================================================

const ANIO = { desde: '2026-01-01', hasta: '2026-12-31' };

let f: Fixture;

/** Un asiento posteado de dos líneas, en el periodo que se pida. */
async function asiento(
  fx: Fixture,
  mes: number,
  descripcion: string,
  cargo: string,
  abono: string,
  monto: string
) {
  return createJournalEntry(
    fx.entityId,
    fechaEnPeriodo(mes, 10),
    JournalEntryType.STANDARD,
    descripcion,
    [
      { account_id: cargo, debit_amount: monto, credit_amount: null, description: descripcion },
      { account_id: abono, debit_amount: null, credit_amount: monto, description: descripcion },
    ],
    fx.userId,
    { autoPost: true }
  );
}

/** El saldo deudor-positivo que la balanza publica para una cuenta. */
function saldoEnBalanza(tb: TrialBalanceReport, codigo: string): string {
  const fila = tb.rows.find((r) => r.account_code === codigo);
  expect(fila, `la balanza no trae la cuenta ${codigo}`).toBeDefined();
  return new Decimal(fila!.ending_balance).toFixed(4);
}

/** El importe con que una sección del estado de resultados presenta una cuenta. */
function enSeccion(
  seccion: { accounts: Array<{ code: string; amount: string }> },
  codigo: string
): string {
  const fila = seccion.accounts.find((a) => a.code === codigo);
  expect(fila, `la sección no trae la cuenta ${codigo}`).toBeDefined();
  return fila!.amount;
}

/** Lo que los asientos de CIERRE movieron en cada cuenta, por lado. */
async function movimientoDelCierre(
  fx: Fixture
): Promise<Record<string, { debe: string; haber: string }>> {
  const { rows } = await query<{ code: string; debe: string; haber: string }>(
    `SELECT a.code,
            COALESCE(SUM(COALESCE(jel.debit_amount, 0)), 0)::text  AS debe,
            COALESCE(SUM(COALESCE(jel.credit_amount, 0)), 0)::text AS haber
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
       JOIN accounts a ON a.id = jel.account_id
      WHERE je.entity_id = $1 AND je.entry_type = 'closing' AND je.status = 'posted'
      GROUP BY a.code`,
    [fx.entityId]
  );
  return Object.fromEntries(
    rows.map((r) => [
      r.code,
      { debe: new Decimal(r.debe).toFixed(4), haber: new Decimal(r.haber).toFixed(4) },
    ])
  );
}

/** El ejercicio completo, sin cerrar todavía. */
async function poblarEjercicio(fx: Fixture) {
  await asiento(fx, 12, 'Ventas del ejercicio', fx.cuentas['1120'], fx.cuentas['4100'], '10000.0000');
  await asiento(fx, 12, 'Devolución sobre ventas', fx.cuentas['4400'], fx.cuentas['1120'], '2000.0000');
  await asiento(fx, 12, 'Costo de ventas', fx.cuentas['5100'], fx.cuentas['1120'], '6000.0000');
  await asiento(fx, 12, 'Devolución sobre compras', fx.cuentas['1120'], fx.cuentas['5200'], '1000.0000');
}

beforeAll(async () => {
  f = await crearInquilino('G1a cifras que se firman');
  enterTenant(f.tenantId);
  expect(f.cuentas['4400'], 'falta 4400 Devoluciones sobre Ventas').toBeTruthy();
  expect(f.cuentas['5200'], 'falta 5200 Devoluciones sobre Compras').toBeTruthy();
  await poblarEjercicio(f);
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

// ============================================================
// 1 · ANTES DEL CIERRE — LOS TRES ESTADOS, CON DEVOLUCIONES
// ============================================================

describe('antes del cierre, report-service ya tiene que decir 3 000', () => {
  it('el estado de resultados neta las devoluciones en vez de sumarlas', async () => {
    const is = await getIncomeStatement(f.entityId, {
      startDate: ANIO.desde,
      endDate: ANIO.hasta,
    });
    expect(is.revenue.total).toBe('8000.0000'); // 10 000 − 2 000, no 12 000
    expect(is.expenses.total).toBe('5000.0000'); // 6 000 − 1 000, no 7 000
    expect(is.net_income).toBe('3000.0000');
  });

  it('y las presenta con el signo que las hace restar, no en valor absoluto', async () => {
    // Es la mitad que abs() borraba: una contra-natural presentada en positivo
    // se lee como una venta más y como un gasto más, y las dos secciones se
    // inflan aunque el neto salga por casualidad.
    const is = await getIncomeStatement(f.entityId, {
      startDate: ANIO.desde,
      endDate: ANIO.hasta,
    });
    expect(enSeccion(is.revenue, '4100')).toBe('10000.0000');
    expect(enSeccion(is.revenue, '4400')).toBe('-2000.0000');
    expect(enSeccion(is.expenses, '5100')).toBe('6000.0000');
    expect(enSeccion(is.expenses, '5200')).toBe('-1000.0000');
  });

  it('sin cierre en el rango, ningún informe arrastra la nota del cierre', async () => {
    const is = await getIncomeStatement(f.entityId, { startDate: ANIO.desde, endDate: ANIO.hasta });
    const tb = await getTrialBalance(f.entityId, { sinceDate: ANIO.desde, untilDate: ANIO.hasta });
    expect(is.closing).toBeUndefined();
    expect(tb.closing).toBeUndefined();
  });

  it('la balanza publica el saldo DEUDOR-POSITIVO de cada cuenta', async () => {
    // EL ANCLA DEL SIGNO EN report-service (`ending_balance`). El banco de
    // pruebas unitario fabrica esta columna a mano, así que invertir la resta
    // en la consulta no rompía nada. Aquí la columna viene de Postgres: si
    // alguien la escribe `credit − debit`, las cuatro cambian de lado.
    const tb = await getTrialBalance(f.entityId, { sinceDate: ANIO.desde, untilDate: ANIO.hasta });
    expect(saldoEnBalanza(tb, '4100')).toBe('-10000.0000'); // ingreso: acreedor
    expect(saldoEnBalanza(tb, '4400')).toBe('2000.0000'); //  contra-ingreso: DEUDOR
    expect(saldoEnBalanza(tb, '5100')).toBe('6000.0000'); //  gasto: deudor
    expect(saldoEnBalanza(tb, '5200')).toBe('-1000.0000'); //  contra-gasto: ACREEDOR
    expect(saldoEnBalanza(tb, '1120')).toBe('3000.0000'); //  el efectivo que quedó
    expect(tb.totals.is_balanced).toBe(true);
  });

  it('el balance general lleva la utilidad no barrida al capital, y cuadra', async () => {
    // queryUnclosedEarnings devuelve el neto DEUDOR-POSITIVO de las temporales:
    // una utilidad es negativa ahí y entra al capital con el signo cambiado.
    // Invertir esa resta convierte 3 000 de utilidad en 3 000 de pérdida y el
    // estado deja de cuadrar por 6 000 — que es el doble de la utilidad, no un
    // redondeo.
    expect(new Decimal(await queryUnclosedEarnings(f.entityId, ANIO.hasta)).toFixed(4)).toBe(
      '-3000.0000'
    );

    const bs = await getBalanceSheet(f.entityId, { asOfDate: ANIO.hasta });
    expect(bs.assets.total).toBe('3000.0000');
    const resultado = bs.equity.subsections.find((s) => s.name === 'Result Of The Period');
    expect(resultado, 'el resultado no barrido no aparece en el capital').toBeDefined();
    expect(resultado!.total).toBe('3000.0000');
    expect(bs.equity.total).toBe('3000.0000');
    expect(bs.out_of_balance).toBe('0.0000');
    expect(bs.is_balanced).toBe(true);
  });
});

// ============================================================
// 2 · EL CIERRE, Y LOS MISMOS TRES ESTADOS DESPUÉS
// ============================================================

describe('después de cerrar el ejercicio de verdad', () => {
  beforeAll(async () => {
    await softClosePeriod(f.periodos[12], f.entityId, f.userId);
    await hardClosePeriod(f.periodos[12], f.entityId, f.userId, 'cierre del ejercicio 2026');
  });

  it('el cierre asienta cada cuenta del lado CONTRARIO a su saldo', async () => {
    // EL ANCLA DEL SIGNO EN period-close (`SUM(ab.debit_total −
    // ab.credit_total)`). Con abs() —y con la resta invertida— las cuatro
    // caían del mismo lado: siempre cargar el ingreso y siempre abonar el
    // gasto. Las dos contra-naturales son las que lo delatan, porque son las
    // únicas cuyo lado correcto es el que la intuición no espera.
    const mov = await movimientoDelCierre(f);
    expect(mov['4100']).toEqual({ debe: '10000.0000', haber: '0.0000' });
    expect(mov['4400']).toEqual({ debe: '0.0000', haber: '2000.0000' });
    expect(mov['5100']).toEqual({ debe: '0.0000', haber: '6000.0000' });
    expect(mov['5200']).toEqual({ debe: '1000.0000', haber: '0.0000' });
    // El resultado entra UNA vez al capital, y por el neto.
    expect(mov['3300']).toEqual({ debe: '0.0000', haber: '3000.0000' });
  });

  it('el estado de resultados sigue diciendo 3 000, no «Net income 0.0000»', async () => {
    const is = await getIncomeStatement(f.entityId, {
      startDate: ANIO.desde,
      endDate: ANIO.hasta,
    });
    expect(is.revenue.total).toBe('8000.0000');
    expect(is.expenses.total).toBe('5000.0000');
    expect(is.net_income).toBe('3000.0000');
  });

  it('y lo advierte: el rango contiene los dos asientos del cierre', async () => {
    const is = await getIncomeStatement(f.entityId, {
      startDate: ANIO.desde,
      endDate: ANIO.hasta,
    });
    expect(is.closing).toBeDefined();
    expect(is.closing!.entries).toBe(2); // resultados → 3900, y 3900 → destino
    expect(is.closing!.included).toBe(false);
    expect(is.closing!.note).toMatch(/left out of this statement/i);
  });

  it('la balanza los cuenta, lo dice, y enseña el ejercicio barrido a cero', async () => {
    const tb = await getTrialBalance(f.entityId, { sinceDate: ANIO.desde, untilDate: ANIO.hasta });
    expect(tb.closing!.included).toBe(true);
    expect(tb.closing!.note).toMatch(/counted here/i);
    for (const codigo of ['4100', '4400', '5100', '5200', '3900']) {
      expect(saldoEnBalanza(tb, codigo), `${codigo} no quedó en cero`).toBe('0.0000');
    }
    // Con abs() estas dos quedaban al DOBLE de su saldo, no en cero:
    // 4400 en 4 000 y 5200 en −2 000.
    expect(saldoEnBalanza(tb, '3300')).toBe('-3000.0000');
    expect(tb.totals.is_balanced).toBe(true);
  });

  it('el balance general publica UTILIDAD de 3 000, no pérdida de 2 000', async () => {
    // El titular de la auditoría III: una utilidad de 3 000 se publicaba como
    // pérdida de 2 000 y el estado seguía diciendo `is_balanced: true`, porque
    // el renglón del resultado cancelaba exactamente el exceso. Cuadrar no es
    // estar bien: por eso aquí se afirma la CIFRA además del cuadre.
    const bs = await getBalanceSheet(f.entityId, { asOfDate: ANIO.hasta });
    expect(bs.assets.total).toBe('3000.0000');
    expect(bs.equity.total).toBe('3000.0000');
    // Ya no queda resultado sin barrer: el cierre lo mudó a una cuenta real.
    expect(new Decimal(await queryUnclosedEarnings(f.entityId, ANIO.hasta)).toFixed(4)).toBe(
      '0.0000'
    );
    expect(bs.equity.subsections.some((s) => s.name === 'Result Of The Period')).toBe(false);
    const capital = bs.equity.subsections.flatMap((s) => s.accounts).find((a) => a.code === '3300');
    expect(capital?.balance).toBe('3000.0000');
    expect(bs.out_of_balance).toBe('0.0000');
    expect(bs.is_balanced).toBe(true);
  });
});

// ============================================================
// 3 · CONTESTAR LA POLÍTICA CAMBIA LA CIFRA FIRMADA
// ============================================================

describe('informes_asientos_de_cierre, sobre un cierre REAL', () => {
  it('«incluir_siempre_y_advertir» devuelve el cero, ya como decisión de alguien', async () => {
    // Inquilino propio: la política es del inquilino y contestarla aquí
    // cambiaría las cifras de los describes de arriba si compartieran fixture.
    const g = await crearInquilino('G1a cierre incluido');
    enterTenant(g.tenantId);
    await seedPolicies({ tenantId: g.tenantId, entityId: g.entityId });
    await resolvePolicy(
      { tenantId: g.tenantId, entityId: g.entityId },
      'informes_asientos_de_cierre',
      'incluir_siempre_y_advertir',
      g.userId,
      'fijada por la prueba de integración'
    );

    await poblarEjercicio(g);
    await softClosePeriod(g.periodos[12], g.entityId, g.userId);
    await hardClosePeriod(g.periodos[12], g.entityId, g.userId);

    const is = await getIncomeStatement(g.entityId, {
      startDate: ANIO.desde,
      endDate: ANIO.hasta,
    });
    // El cero vuelve —el cierre cancela lo que el informe acaba de sumar— pero
    // ahora viene con el motivo impreso al lado, que es la diferencia entera.
    expect(is.net_income).toBe('0.0000');
    expect(is.closing!.included).toBe(true);
    expect(is.closing!.note).toMatch(/counted here/i);

    enterTenant(f.tenantId); // el resto del archivo trabaja sobre el primero
  });
});

// ============================================================
// 4 · EL BARRIDO POR SIGNO, SIN LA RED DE LA COMPROBACIÓN DE RESIDUO
// ============================================================

describe('el barrido es por SIGNO, y se sostiene solo', () => {
  it('con severidad_resultado_sin_barrer en «avisar», el cierre sigue cayendo del lado correcto', async () => {
    // DOS DIENTES INDEPENDIENTES, A PROPÓSITO.
    //
    // Con el defecto del panel, invertir la resta de la consulta de saldos
    // hace que `verificarQueElEjercicioBarrio` reviente el cierre entero: la
    // prueba se pone roja, pero por la comprobación de residuo. Un despacho
    // que conteste «avisar» apaga esa red —es una opción legítima del panel— y
    // entonces el cierre TERMINA con las cuentas al doble.
    //
    // Aquí se afirma el lado de cada línea sin esa red debajo: es la única
    // afirmación del archivo que sigue mordiendo cuando el residuo sólo avisa.
    const h = await crearInquilino('G1a barrido por signo');
    enterTenant(h.tenantId);
    await seedPolicies({ tenantId: h.tenantId, entityId: h.entityId });
    await resolvePolicy(
      { tenantId: h.tenantId, entityId: h.entityId },
      'severidad_resultado_sin_barrer',
      'avisar',
      h.userId,
      'fijada por la prueba de integración'
    );

    await poblarEjercicio(h);
    await softClosePeriod(h.periodos[12], h.entityId, h.userId);
    await hardClosePeriod(h.periodos[12], h.entityId, h.userId);

    const mov = await movimientoDelCierre(h);
    // Saldo acreedor → se CARGA. Saldo deudor → se ABONA. Las contra-naturales
    // van al revés que sus hermanas del mismo tipo, que es justo lo que abs()
    // —y una resta invertida— no pueden expresar.
    expect(mov['4100']).toEqual({ debe: '10000.0000', haber: '0.0000' });
    expect(mov['4400']).toEqual({ debe: '0.0000', haber: '2000.0000' });
    expect(mov['5100']).toEqual({ debe: '0.0000', haber: '6000.0000' });
    expect(mov['5200']).toEqual({ debe: '1000.0000', haber: '0.0000' });

    const tb = await getTrialBalance(h.entityId, { sinceDate: ANIO.desde, untilDate: ANIO.hasta });
    for (const codigo of ['4100', '4400', '5100', '5200', '3900']) {
      expect(saldoEnBalanza(tb, codigo), `${codigo} no quedó en cero`).toBe('0.0000');
    }
    expect(saldoEnBalanza(tb, '3300')).toBe('-3000.0000');

    enterTenant(f.tenantId);
  });
});
