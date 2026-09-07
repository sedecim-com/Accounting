import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Decimal from 'decimal.js';
import { v4 as uuidv4 } from 'uuid';
import { crearInquilino, crearEntidadHermana, fechaEnPeriodo, type Fixture } from './helpers/tenant-fixture.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { softClosePeriod, hardClosePeriod } from '../../src/services/accounting/period-close.js';
import {
  getTrialBalance,
  queryAccumulatedBalances,
  type TrialBalanceReport,
  type TrialBalanceReportRow,
} from '../../src/services/reporting/report-service.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { ValidationError } from '../../src/utils/errors.js';
import { JournalEntryType } from '../../src/types/index.js';

// ============================================================
// F07a · LA BALANZA DE CUATRO COLUMNAS, MEDIDA CONTRA POSTGRES.
//
// El nodo Ctas de la BalanzaComprobacion pide SaldoIni, Debe, Haber y
// SaldoFin, y la autoridad RECALCULA SaldoIni + Debe − Haber = SaldoFin sobre
// el archivo sellado con la e.firma. La única fuente de saldo inicial que
// existía —account_balances.beginning_balance— la siembra ÚNICAMENTE el cierre
// DURO: una entidad que cierra en suave habría entregado CEROS, o sea la
// declaración firmada de que abrió el mes en nada.
//
// Esto NO se puede demostrar con mocks. Un arnés que fabrica las filas sólo
// puede reproducir la resta que el código escribe; que el inicial de febrero
// sea el acumulado real de enero lo dice el mayor o no lo dice nadie. De ahí
// este archivo, en la línea de g1a-cifras-que-se-firman.
//
// EL EJERCICIO (cifras distintas entre sí, ninguna doble ni negativa de otra:
// con números simétricos, sumar donde había que restar pasa en verde):
//
//   ENERO    venta   1120 debe 7 000 · 4100 haber 7 000
//            costo   5100 debe 2 500 · 1120 haber 2 500
//   FEBRERO  venta   1120 debe 1 300 · 4100 haber 1 300
//            gasto   5100 debe   400 · 1120 haber   400
//
//   Balanza de FEBRERO, las cuatro columnas:
//     1120   SaldoIni  4 500   Debe 1 300   Haber   400   SaldoFin  5 400
//     4100   SaldoIni −7 000   Debe     0   Haber 1 300   SaldoFin −8 300
//     5100   SaldoIni  2 500   Debe   400   Haber     0   SaldoFin  2 900
//
// Enero se cierra en SUAVE. Con la fuente vieja las tres SaldoIni serían cero.
//
// Corre como superusuario a propósito: RLS queda inerte y lo que se comprueba
// es la aritmética del CÓDIGO (ver frontera-entidad-ten).
// ============================================================

let f: Fixture;

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

/** La fila de una cuenta en la balanza. */
function fila(tb: TrialBalanceReport, codigo: string): TrialBalanceReportRow {
  const r = tb.rows.find((x) => x.account_code === codigo);
  expect(r, `la balanza no trae la cuenta ${codigo}`).toBeDefined();
  return r!;
}

/** Las cuatro columnas del Anexo 24, a la escala del mayor. */
function cuatroColumnas(tb: TrialBalanceReport, codigo: string) {
  const r = fila(tb, codigo);
  return {
    ini: new Decimal(r.beginning_balance ?? 'NaN').toFixed(4),
    debe: new Decimal(r.debit_total).toFixed(4),
    haber: new Decimal(r.credit_total).toFixed(4),
    fin: new Decimal(r.final_balance ?? 'NaN').toFixed(4),
  };
}

/** El `beginning_balance` que el cierre DURO siembra, que es el otro origen. */
async function arrastreSembrado(fx: Fixture, periodId: string, accountId: string): Promise<string | null> {
  const r = await query<{ b: string }>(
    `SELECT beginning_balance::text AS b FROM account_balances
      WHERE entity_id = $1 AND fiscal_period_id = $2 AND account_id = $3`,
    [fx.entityId, periodId, accountId]
  );
  return r.rows[0] ? new Decimal(r.rows[0].b).toFixed(4) : null;
}

beforeAll(async () => {
  f = await crearInquilino('F07a balanza de cuatro columnas');
  enterTenant(f.tenantId);
  await asiento(f, 1, 'Venta de enero', f.cuentas['1120'], f.cuentas['4100'], '7000.0000');
  await asiento(f, 1, 'Costo de enero', f.cuentas['5100'], f.cuentas['1120'], '2500.0000');
  await asiento(f, 2, 'Venta de febrero', f.cuentas['1120'], f.cuentas['4100'], '1300.0000');
  await asiento(f, 2, 'Gasto de febrero', f.cuentas['5100'], f.cuentas['1120'], '400.0000');
  // SUAVE. Es el caso obligatorio: carryForwardBalances no corre, así que
  // nadie siembra el inicial de febrero.
  await softClosePeriod(f.periodos[1], f.entityId, f.userId, 'cierre suave de enero');
});

afterAll(async () => {
  await drainAttestations(3000);
  await closeDatabase();
});

// ============================================================
// 1 · CIERRE SUAVE: EL INICIAL SALE DEL MAYOR, Y NO ES CERO
// ============================================================

describe('un mes cuyo anterior sólo cerró en SUAVE', () => {
  it('la fuente vieja dice cero: es la declaración que F07a vino a impedir', async () => {
    // No es que falte la fila —posting la crea con cada asiento—: es que la
    // columna del arrastre vale 0 porque sólo la escribe el cierre duro.
    expect(await arrastreSembrado(f, f.periodos[2], f.cuentas['1120'])).toBe('0.0000');
    expect(await arrastreSembrado(f, f.periodos[2], f.cuentas['4100'])).toBe('0.0000');
  });

  it('y la balanza publica las cuatro columnas con el inicial DERIVADO', async () => {
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: f.periodos[2] });
    expect(tb.inicial, 'la balanza de un periodo tiene que traer su saldo inicial').toBeDefined();
    expect(tb.inicial!.origen).toBe('mayor');
    expect(tb.inicial!.desde).toBe('2026-02-01');

    expect(cuatroColumnas(tb, '1120')).toEqual({
      ini: '4500.0000', debe: '1300.0000', haber: '400.0000', fin: '5400.0000',
    });
    // El ingreso es ACREEDOR: su inicial es negativo en la convención
    // deudor-positiva del mayor. Un abs() aquí lo publicaría como 7 000 al
    // debe y el SaldoFin del SAT saldría por 14 300.
    expect(cuatroColumnas(tb, '4100')).toEqual({
      ini: '-7000.0000', debe: '0.0000', haber: '1300.0000', fin: '-8300.0000',
    });
    expect(cuatroColumnas(tb, '5100')).toEqual({
      ini: '2500.0000', debe: '400.0000', haber: '0.0000', fin: '2900.0000',
    });
  });

  it('el invariante que el SAT recalcula se cumple en TODAS las cuentas', async () => {
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: f.periodos[2] });
    for (const r of tb.rows) {
      const esperado = new Decimal(r.beginning_balance!).plus(r.debit_total).minus(r.credit_total);
      expect(esperado.toFixed(4), `SaldoIni + Debe − Haber ≠ SaldoFin en ${r.account_code}`).toBe(
        new Decimal(r.final_balance!).toFixed(4)
      );
      expect(r.cuadra).toBe(true);
    }
    expect(tb.inicial!.descuadres).toEqual([]);
    expect(tb.totals.is_balanced).toBe(true);
  });

  it('el inicial es CALCULABLE y todavía NO es FIRME, y lo dice', async () => {
    // La distinción que se firma: la cifra existe y es correcta hoy, y enero
    // sigue admitiendo posteos —soft_close no los impide— así que mañana puede
    // ser otra. Con el arrastre duro esto no pasaba porque no había cifra.
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: f.periodos[2] });
    expect(tb.inicial!.firme).toBe(false);
    expect(tb.inicial!.periodo_anterior).toEqual({
      period_name: 'Periodo 1/2026',
      status: 'soft_close',
    });
    expect(tb.inicial!.note).toMatch(/NOT firm/);
  });

  it('el saldo inicial es ESTRICTAMENTE anterior: el mes no entra en su propio inicial', async () => {
    // La diferencia entre `<` y `<=` son los 1 300 de la venta de febrero.
    const antes = await queryAccumulatedBalances(f.entityId, { date: '2026-02-01', inclusive: false });
    const hasta = await queryAccumulatedBalances(f.entityId, { date: '2026-02-28', inclusive: true });
    const de = (rows: { account_id: string; balance: string }[], id: string) =>
      new Decimal(rows.find((r) => r.account_id === id)?.balance ?? 0).toFixed(4);
    expect(de(antes, f.cuentas['1120'])).toBe('4500.0000');
    expect(de(hasta, f.cuentas['1120'])).toBe('5400.0000');
  });
});

// ============================================================
// 2 · EL CIERRE DURO NO CAMBIA LA CIFRA: LA VUELVE FIRME
// ============================================================

describe('después del cierre DURO de enero', () => {
  beforeAll(async () => {
    await hardClosePeriod(f.periodos[1], f.entityId, f.userId, 'cierre duro de enero');
  });

  it('el inicial derivado vale lo mismo, y ahora es firme', async () => {
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: f.periodos[2] });
    expect(cuatroColumnas(tb, '1120').ini).toBe('4500.0000');
    expect(tb.inicial!.firme).toBe(true);
    expect(tb.inicial!.note).toMatch(/Firm: Periodo 1\/2026 is hard_close/);
  });

  it('el arrastre sembrado cubre el balance y NO las cuentas de resultados', async () => {
    // carryForwardBalances siembra sólo cuentas de balance —las de resultados
    // «se reinician con el cierre del ejercicio»—, así que el otro origen
    // posible del SaldoIni queda incompleto para el Anexo 24 incluso DESPUÉS
    // de cerrar en duro: para el SAT, el SaldoIni de una cuenta de resultados
    // en febrero es el acumulado del ejercicio, no cero.
    expect(await arrastreSembrado(f, f.periodos[2], f.cuentas['1120'])).toBe('4500.0000');
    expect(await arrastreSembrado(f, f.periodos[2], f.cuentas['4100'])).toBe('0.0000');
    expect(await arrastreSembrado(f, f.periodos[2], f.cuentas['5100'])).toBe('0.0000');
  });
});

// ============================================================
// 3 · DÓNDE NO HAY SALDO INICIAL, Y DE QUIÉN ES EL PERIODO
// ============================================================

describe('la balanza acumulada y la frontera de entidad', () => {
  it('una balanza acumulada no tiene un ANTES: se queda en tres columnas', async () => {
    // `asOfDate` arranca en el origen de los libros. Una columna de ceros ahí
    // se leería como arrastre, que es exactamente la mentira que se persigue.
    const tb = await getTrialBalance(f.entityId, { asOfDate: '2026-02-28' });
    expect(tb.inicial).toBeUndefined();
    expect(fila(tb, '1120').beginning_balance).toBeUndefined();
    // Y el acumulado sigue siendo el de siempre, en su columna de siempre.
    expect(new Decimal(fila(tb, '1120').ending_balance).toFixed(4)).toBe('5400.0000');
  });

  it('un periodo de la entidad HERMANA no fecha esta balanza', async () => {
    // Mismo inquilino, otra entidad: el eje que RLS no defiende. Sin el
    // `AND entity_id` dentro del SQL, el periodo de la hermana habría fechado
    // el saldo inicial de ésta.
    const hermana = await crearEntidadHermana(f, 'Hermana de F07a');
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: hermana.periodos[2] });
    expect(tb.inicial).toBeUndefined();
  });
});

// ============================================================
// 4 · CUANDO LOS DOS EJES NO DICEN LO MISMO, LA CUENTA SE SEÑALA
// ============================================================

describe('el SaldoFin se pide aparte, y por eso puede acusar', () => {
  let ajustes: string;

  beforeAll(async () => {
    // Un periodo de AJUSTES que comparte fechas con febrero: el caso real
    // donde el eje de la fecha y el eje del periodo fiscal dejan de coincidir
    // (posting asigna por fecha y gana el period_number menor). El movimiento
    // de la balanza se filtra por fiscal_period_id y el acumulado por fecha:
    // si el SaldoFin se hubiera escrito como inicial + debe − haber, esto
    // habría cuadrado por construcción y nadie se habría enterado.
    ajustes = uuidv4();
    await query(
      `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name,
         start_date, end_date, period_type, status)
       VALUES ($1, $2, $3, 13, 'Ajustes 2026', '2026-02-01', '2026-02-28', 'adjustment', 'open')`,
      [ajustes, f.fiscalYearId, f.entityId]
    );
  });

  it('nombra la cuenta y su diferencia en vez de absorberla', async () => {
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: ajustes });
    const c1120 = fila(tb, '1120');
    expect(c1120.cuadra).toBe(false);
    expect(cuatroColumnas(tb, '1120')).toEqual({
      ini: '4500.0000', debe: '0.0000', haber: '0.0000', fin: '5400.0000',
    });

    const d = tb.inicial!.descuadres.find((x) => x.account_code === '1120');
    expect(d, 'la cuenta descuadrada no aparece señalada').toBeDefined();
    expect(d).toMatchObject({
      esperado: '4500.0000',
      obtenido: '5400.0000',
      diferencia: '-900.0000',
    });
    expect(tb.inicial!.note).toMatch(/fail SaldoIni \+ Debe − Haber = SaldoFin/);
  });
});

// ============================================================
// 5 · EL CRITERIO DEL PANEL MANDA (Y SE LEE DE LA BASE)
// ============================================================

describe('anexo24_balanza_saldo_inicial', () => {
  beforeAll(async () => {
    // Se siembra y se resuelve en el MISMO alcance —el del inquilino—: una
    // decisión se contesta donde se midió su evidencia.
    await seedPolicies({ tenantId: f.tenantId });
    await resolvePolicy(
      { tenantId: f.tenantId },
      'anexo24_balanza_saldo_inicial',
      'exigir_cierre_duro',
      f.userId,
      'prueba de integración F07a'
    );
  });

  it('con exigir_cierre_duro el inicial sale del arrastre, y el hueco se ve', async () => {
    // La contra-demostración del defecto: el arrastre existe para 1120 porque
    // enero cerró en duro, y NO existe para las de resultados. La balanza no
    // lo tapa: 4100 y 5100 quedan señaladas.
    const tb = await getTrialBalance(f.entityId, { fiscalPeriodId: f.periodos[2] });
    expect(tb.inicial!.criterio).toBe('exigir_cierre_duro');
    expect(tb.inicial!.origen).toBe('arrastre_del_cierre');
    expect(cuatroColumnas(tb, '1120').ini).toBe('4500.0000');
    expect(cuatroColumnas(tb, '4100').ini).toBe('0.0000');
    expect(tb.inicial!.descuadres.map((d) => d.account_code).sort()).toEqual(['4100', '5100']);
  });

  it('y sin arrastre sembrado se NIEGA, en vez de firmar ceros', async () => {
    const ajustes = await query<{ id: string }>(
      `SELECT id FROM fiscal_periods WHERE entity_id = $1 AND period_number = 13`,
      [f.entityId]
    );
    await expect(
      getTrialBalance(f.entityId, { fiscalPeriodId: ajustes.rows[0].id })
    ).rejects.toThrow(ValidationError);
  });
});
