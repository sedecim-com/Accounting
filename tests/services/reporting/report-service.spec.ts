import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// `currentTenant` lo usa report-service para resolver el inquilino de una
// política sin una segunda consulta. Devuelve un inquilino fijo: aquí no se
// prueba RLS, se prueba la balanza.
vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  currentTenant: vi.fn(() => 'ten-1'),
}));

// El origen del saldo inicial también sale del panel. Se sustituye por el
// lector, no por el valor, para poder afirmar CON QUÉ CLAVE se lee: una
// política sin lector es una pregunta que no cambia nada.
vi.mock('../../../src/services/policy/policy-service.js', () => ({ getPolicy: vi.fn() }));

// El criterio de los asientos de cierre lo decide una política, y leerla es un
// viaje a la base. Se sustituye por su valor POR OMISIÓN —el estado de
// resultados los excluye, la balanza los incluye— para que estas pruebas sigan
// contando consultas de informe y no de panel. `predicadoSinCierre` se deja
// REAL: es el SQL que las aserciones de abajo comprueban.
vi.mock('../../../src/services/reporting/criterio-cierre.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/reporting/criterio-cierre.js')>();
  return {
    ...actual,
    criterioDeCierreEnInformes: vi.fn(async () => ({
      valor: 'estado_sin_cierre_balanza_con_cierre',
      enEstadoDeResultados: false,
      enBalanza: true,
    })),
    avisoDeCierreEnRango: vi.fn(async () => null),
  };
});

// El criterio de los asientos de cierre lo decide una política, y leerla es un
// viaje a la base. Se sustituye por su valor POR OMISIÓN —el estado de
// resultados los excluye, la balanza los incluye— para que estas pruebas sigan
// contando consultas de informe y no de panel. `predicadoSinCierre` se deja
// REAL: es el SQL que las aserciones de abajo comprueban.
vi.mock('../../../src/services/reporting/criterio-cierre.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/reporting/criterio-cierre.js')>();
  return {
    ...actual,
    criterioDeCierreEnInformes: vi.fn(async () => ({
      valor: 'estado_sin_cierre_balanza_con_cierre',
      enEstadoDeResultados: false,
      enBalanza: true,
    })),
    avisoDeCierreEnRango: vi.fn(async () => null),
  };
});

// T13 · El criterio de las cuentas archivadas también sale del panel, y
// leerlo es otro viaje a la base. Se sustituye por su valor POR OMISIÓN
// —«retirar la archivada que no lleva nada»— para que estas pruebas sigan
// contando consultas de informe y no de panel. `predicadoDeCuentaEnBalanza`
// se deja REAL: es el SQL que las aserciones de abajo comprueban.
vi.mock('../../../src/services/reporting/criterio-archivadas.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/services/reporting/criterio-archivadas.js')>();
  return {
    ...actual,
    criterioDeCuentasArchivadas: vi.fn(async () => ({
      valor: 'retirar_cuando_no_tiene_nada',
      retirarSinCifras: true,
    })),
  };
});

import {
  resolvePeriodRange,
  queryTrialBalanceRows,
  queryAccumulatedBalances,
  totalTrialBalance,
  getTrialBalance,
  queryBalanceSheetRows,
  buildBalanceSheetSection,
  getBalanceSheet,
  queryUnclosedEarnings,
  queryIncomeStatementRows,
  buildIncomeStatementSection,
  getIncomeStatement,
  queryLedgerRows,
  countLedgerRows,
  getGeneralLedger,
  queryAgedReceivableRows,
  queryAgedPayableRows,
  getAgedReceivables,
  getAgedPayables,
} from '../../../src/services/reporting/report-service.js';
import { query, currentTenant } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';
import { criterioDeCierreEnInformes } from '../../../src/services/reporting/criterio-cierre.js';
import { criterioDeCuentasArchivadas } from '../../../src/services/reporting/criterio-archivadas.js';
import { ValidationError } from '../../../src/utils/errors.js';

const mockQuery = query as unknown as Mock;
const ENTITY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

beforeEach(() => mockQuery.mockReset());

const sql = (call: number) => String(mockQuery.mock.calls[call][0]).replace(/\s+/g, ' ');
const params = (call: number) => mockQuery.mock.calls[call][1];

/** A trial-balance row shaped the way Postgres hands it back: money as strings. */
const tbRow = (code: string, debit: string, credit: string) => ({
  account_id: `id-${code}`,
  account_code: code,
  account_name: `Account ${code}`,
  account_type: 'asset',
  debit_total: debit,
  credit_total: credit,
  ending_balance: String(Number(debit) - Number(credit)),
});

// ============================================================
// The properties worth pinning are the ones that produce a WRONG
// NUMBER when they break, not the ones that produce an error.
// ============================================================

describe('the (jel JOIN je) pair — the defect that must never come back', () => {
  it.each([
    ['trial balance', () => queryTrialBalanceRows(ENTITY)],
    ['balance sheet', () => queryBalanceSheetRows(ENTITY, '2026-12-31')],
    ['income statement', () => queryIncomeStatementRows(ENTITY, { startDate: '2026-01-01', endDate: '2026-12-31' })],
  ])('%s pre-filters the join instead of chaining two LEFT JOINs', async (_name, run) => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await run();
    // The pair is parenthesized and the status predicate lives INSIDE it.
    expect(sql(0)).toMatch(
      /LEFT JOIN \(journal_entry_lines jel JOIN journal_entries je ON je\.id = jel\.journal_entry_id AND je\.status = 'posted'/
    );
    // A second, chained LEFT JOIN onto journal_entries would let draft and
    // void lines survive the failed predicate and be summed.
    expect(sql(0)).not.toMatch(/LEFT JOIN journal_entries/);
  });
});

describe('queryTrialBalanceRows', () => {
  // ══════════════════════════════════════════════════════════
  // T13 · ESTA PRUEBA AFIRMABA EL DEFECTO. Se reescribe, no se borra.
  //
  // Decía «scopes to the entity and to active accounts» y exigía, literal,
  // `WHERE a.entity_id = $1 AND a.is_active = true`. Su gemela de más abajo
  // —«keeps a retired account that still carries a balance»— exigía lo
  // CONTRARIO para el balance general. Entre las dos no describían un
  // criterio: describían una asimetría, y la sostenían en verde.
  //
  // Lo que esa asimetría costaba, medido: archivar sólo exige saldo de por
  // vida cero, que es exactamente lo que tiene una cuenta de resultados
  // barrida por el cierre. Así que `account archive 4100` pasaba sin
  // `--force` y el estado de resultados de un ejercicio FIRMADO pasaba de
  // Revenue 10 000 a 0.0000 —la utilidad de 6 000 a una pérdida de 4 000—
  // mientras el balance general al 31-dic seguía cuadrando. Ningún control
  // avisaba, y esta prueba estaba en verde durante todo el trayecto.
  //
  // Lo que se afirma ahora es la regla única: el informe enseña la cuenta que
  // lleva algo EN SU PERIODO. `is_active` no puede tapar dinero; sólo decide
  // el renglón vacío, y eso es lo que el panel bifurca.
  // ══════════════════════════════════════════════════════════
  it('acota a la entidad, y `is_active` deja de poder tapar una cuenta con movimiento', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY);
    // La cuenta VIVA entra siempre —la balanza conserva a propósito las que
    // no se movieron—; la ARCHIVADA entra cuando el mayor la respalda.
    expect(sql(0)).toMatch(/WHERE a\.entity_id = \$1 AND \(a\.is_active = true OR EXISTS \(/);
    // El `OR` es todo el arreglo. Convertido en `AND` se pierden las dos
    // propiedades a la vez, así que se afirma que NO es un `AND`.
    expect(sql(0)).not.toMatch(/a\.is_active = true AND EXISTS/);
    // Y el rescate mira el MAYOR, no el saldo: una cuenta con 100 al debe y
    // 100 al haber tiene saldo cero y SÍ se movió.
    expect(sql(0)).toMatch(
      /EXISTS \(SELECT 1 FROM journal_entry_lines arch_jel JOIN journal_entries arch_je ON arch_je\.id = arch_jel\.journal_entry_id WHERE arch_jel\.account_id = a\.id AND arch_je\.status = 'posted'\)/
    );
    // Sin tope no hay parámetro nuevo: el rescate reaprovecha el `$n` del
    // informe en vez de duplicar el corte.
    expect(params(0)).toEqual([ENTITY]);
  });

  it('el rescate de la archivada usa EL MISMO $n del corte, no una copia', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, { asOfDate: '2026-12-31' });
    // `$2` aparece dos veces —el recorte del movimiento y el tope del
    // rescate— y los parámetros siguen siendo dos. Un tercer parámetro con la
    // misma fecha sería una copia que un día se puede mover sola.
    expect(sql(0)).toMatch(/AND je\.entry_date <= \$2/);
    expect(sql(0)).toMatch(/AND arch_je\.entry_date <= \$2\)\)/);
    expect(params(0)).toEqual([ENTITY, '2026-12-31']);
  });

  it('con periodo fiscal, el tope del rescate es la FECHA FIN de ese periodo', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, { fiscalPeriodId: 'fp-3' });
    // El movimiento se recorta por `fiscal_period_id` y el arrastre por fecha:
    // el rescate tiene que traducir el periodo a su corte, o una archivada con
    // saldo arrastrado se caería de la balanza y con ella su SaldoIni.
    expect(sql(0)).toMatch(
      /AND arch_je\.entry_date <= \(SELECT fp\.end_date FROM fiscal_periods fp WHERE fp\.id = \$2\)/
    );
    expect(params(0)).toEqual([ENTITY, 'fp-3']);
  });

  it('`sinceDate` a solas NO hace de tope: es cota inferior, y borraría el arrastre', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, { sinceDate: '2026-03-01' });
    expect(sql(0)).toMatch(/AND je\.entry_date >= \$2/);
    expect(sql(0)).toMatch(/AND arch_je\.status = 'posted'\)\)/);
    expect(sql(0)).not.toMatch(/arch_je\.entry_date/);
  });

  it('EN CRUDO no hay criterio de catálogo: el cotejo ve todas las cuentas', async () => {
    // LA AFIRMACIÓN QUE ESTABA AQUÍ ERA FALSA, Y MEDIDA AL REVÉS. Decía «las
    // materializadas materializan TODO lo posteado»; no lo hacían: las dos
    // filtraban `a.is_active = true` (comprobado con `SELECT definition FROM
    // pg_matviews`). Dejar el mayor sin predicado contra unas vistas que sí
    // filtraban no quitaba una deriva inventada: la INTRODUCÍA, permanente,
    // en cualquier entidad con una cuenta archivada con movimiento, y
    // `report view show` pedía para siempre un «rebuild» que no arreglaba nada.
    //
    // Ahora es cierto, porque la migración 071 alinea las vistas con la regla:
    // los dos lados del cotejo leen el mismo juego de cuentas.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, { ignoreClosingPolicy: true });
    expect(sql(0)).toMatch(/WHERE a\.entity_id = \$1 GROUP BY/);
    expect(sql(0)).not.toMatch(/is_active/);
  });

  it('keeps zero-activity accounts: a missing row is not a zero balance', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY);
    expect(sql(0)).not.toMatch(/HAVING/);
  });

  it('filters by fiscal period id, inside the join', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, { fiscalPeriodId: 'fp-1' });
    expect(sql(0)).toMatch(/je\.status = 'posted' AND je\.fiscal_period_id = \$2\)/);
    expect(params(0)).toEqual([ENTITY, 'fp-1']);
  });

  it('numbers the level filter before the period filter, as the REST route always has', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, { maxLevel: 5, asOfDate: '2026-06-30' });
    expect(sql(0)).toMatch(/AND a\.account_level <= \$2/);
    expect(sql(0)).toMatch(/AND je\.entry_date <= \$3\)/);
    expect(params(0)).toEqual([ENTITY, 5, '2026-06-30']);
  });

  it('omits the level filter entirely when no level was asked for', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, {});
    expect(sql(0)).not.toMatch(/account_level/);
  });

  it('lets a date range replace the as-of cutoff for period activity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, { sinceDate: '2026-01-01', untilDate: '2026-03-31' });
    expect(sql(0)).toMatch(/AND je\.entry_date >= \$2 AND je\.entry_date <= \$3\)/);
    expect(params(0)).toEqual([ENTITY, '2026-01-01', '2026-03-31']);
  });

  it('prefers the fiscal period over the dates when both arrive', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryTrialBalanceRows(ENTITY, { fiscalPeriodId: 'fp-1', asOfDate: '2026-06-30', sinceDate: '2026-01-01' });
    expect(params(0)).toEqual([ENTITY, 'fp-1']);
  });
});

describe('totalTrialBalance — the footing', () => {
  it('adds money with Decimal, so a cent never evaporates', () => {
    const rows = Array.from({ length: 10 }, () => ({ debit_total: '0.10', credit_total: '0.10' }));
    const totals = totalTrialBalance(rows);
    // 0.1 * 10 in binary floating point is 0.9999999999999999.
    expect(totals.total_debits).toBe('1.0000');
    expect(totals.is_balanced).toBe(true);
  });

  it('returns strings, never numbers', () => {
    const totals = totalTrialBalance([{ debit_total: '5', credit_total: '5' }]);
    expect(typeof totals.total_debits).toBe('string');
    expect(typeof totals.total_credits).toBe('string');
  });

  it('tolerates a cent and refuses two', () => {
    expect(totalTrialBalance([{ debit_total: '100.01', credit_total: '100.00' }]).is_balanced).toBe(true);
    expect(totalTrialBalance([{ debit_total: '100.02', credit_total: '100.00' }]).is_balanced).toBe(false);
  });

  it('honours the caller scale, so the agent can round without the API doing so', () => {
    expect(totalTrialBalance([{ debit_total: '1.5', credit_total: '1.5' }], 2).total_debits).toBe('1.50');
  });
});

describe('getTrialBalance — truncation must never change the answer', () => {
  it('foots over EVERY account and pages only what is displayed', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [tbRow('1000', '100', '0'), tbRow('2000', '0', '60'), tbRow('3000', '0', '40')],
    });
    const report = await getTrialBalance(ENTITY, { limit: 1 });
    expect(report.rows).toHaveLength(1);
    // total is what makes render() announce the cut instead of lying.
    expect(report.total).toBe(3);
    // The footing covers all three rows, not the single displayed one.
    expect(report.totals.total_debits).toBe('100.0000');
    expect(report.totals.total_credits).toBe('100.0000');
    expect(report.totals.is_balanced).toBe(true);
  });

  it('offsets without losing the total', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [tbRow('1000', '10', '0'), tbRow('2000', '20', '0'), tbRow('3000', '30', '0')],
    });
    const report = await getTrialBalance(ENTITY, { limit: 1, offset: 1 });
    expect(report.rows[0].account_code).toBe('2000');
    expect(report.total).toBe(3);
  });

  it('excludeZero drops zero-balance accounts and the total follows', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [tbRow('1000', '100', '0'), tbRow('1500', '0', '0'), tbRow('2000', '0', '100')],
    });
    const report = await getTrialBalance(ENTITY, { excludeZero: true });
    expect(report.rows.map((r) => r.account_code)).toEqual(['1000', '2000']);
    expect(report.total).toBe(2);
  });

  it('returns every account when no limit is given: a statement is not a page', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [tbRow('1000', '1', '0'), tbRow('2000', '0', '1')] });
    const report = await getTrialBalance(ENTITY);
    expect(report.rows).toHaveLength(2);
    expect(report.total).toBe(2);
  });
});

// ============================================================
// F07a · LA CUARTA COLUMNA
//
// Lo que se fija aquí es la ARITMÉTICA y la forma de las consultas. Que las
// cifras sean las del mayor lo sostiene
// tests/integration/f07a-balanza-de-cuatro-columnas.int.spec.ts, contra
// Postgres: con un arnés que fabrica las filas, un saldo inicial derivado del
// mayor no se puede demostrar —sólo se puede reproducir la resta—.
// ============================================================

/** Una fila del índice de acumulados, tal y como la devuelve Postgres. */
const accRow = (code: string, balance: string) => ({ account_id: `id-${code}`, balance });

const DERIVAR = {
  key: 'anexo24_balanza_saldo_inicial',
  value: 'derivar_del_mayor',
  defined: false,
  question: '',
  rationale: null,
};

describe('queryAccumulatedBalances — la suma del mayor para TODAS las cuentas', () => {
  beforeEach(() => vi.mocked(criterioDeCierreEnInformes).mockClear());

  it('el inicial es ESTRICTAMENTE anterior al corte y el final lo incluye', async () => {
    // La diferencia entre `<` y `<=` es el movimiento del propio periodo
    // contado dentro de su saldo inicial.
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAccumulatedBalances(ENTITY, { date: '2026-03-01', inclusive: false });
    expect(sql(0)).toMatch(/AND je\.entry_date < \$2/);
    expect(params(0)).toEqual([ENTITY, '2026-03-01']);

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAccumulatedBalances(ENTITY, { date: '2026-03-31', inclusive: true });
    expect(sql(1)).toMatch(/AND je\.entry_date <= \$2/);
  });

  it('sin corte suma la historia posteada entera', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAccumulatedBalances(ENTITY, { inclusive: true });
    expect(sql(0)).not.toMatch(/entry_date/);
    expect(params(0)).toEqual([ENTITY]);
  });

  it('acota por entidad DENTRO del SQL y sólo cuenta lo posteado', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAccumulatedBalances(ENTITY, { date: '2026-03-01', inclusive: false });
    expect(sql(0)).toMatch(/WHERE a\.entity_id = \$1/);
    expect(sql(0)).toMatch(/je\.status = 'posted'/);
    expect(sql(0)).toMatch(/GROUP BY jel\.account_id/);
  });

  it('lleva el mismo criterio de asientos de cierre que la balanza', async () => {
    // Las tres columnas tienen que hablar del mismo libro: un inicial que
    // cuenta el cierre del ejercicio dentro de una balanza que no lo cuenta
    // arrastra al mes de enero el ejercicio ya barrido.
    vi.mocked(criterioDeCierreEnInformes).mockResolvedValueOnce({
      valor: 'excluir_siempre',
      enEstadoDeResultados: false,
      enBalanza: false,
    });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAccumulatedBalances(ENTITY, { date: '2026-03-01', inclusive: false });
    expect(sql(0)).toMatch(/AND NOT \(je\.entry_type = 'closing'/);
  });

  it('y el cotejo de las vistas lo puede saltar, como en la balanza', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAccumulatedBalances(ENTITY, { inclusive: true }, { ignoreClosingPolicy: true });
    expect(criterioDeCierreEnInformes).not.toHaveBeenCalled();
    expect(sql(0)).not.toMatch(/entry_type/);
  });
});

describe('getTrialBalance — el saldo inicial que el Anexo 24 exige', () => {
  beforeEach(() => {
    vi.mocked(getPolicy).mockReset();
    vi.mocked(getPolicy).mockResolvedValue(DERIVAR);
    vi.mocked(criterioDeCierreEnInformes).mockClear();
  });

  /** El guion de consultas de una balanza por rango de fechas. */
  const conRango = (opts: {
    filas: ReturnType<typeof tbRow>[];
    previo?: { period_name: string; status: string } | null;
    iniciales?: ReturnType<typeof accRow>[];
    finales?: ReturnType<typeof accRow>[];
  }) => {
    mockQuery.mockResolvedValueOnce({ rows: opts.filas });
    mockQuery.mockResolvedValueOnce({ rows: opts.previo ? [opts.previo] : [] });
    mockQuery.mockResolvedValueOnce({ rows: opts.iniciales ?? [] });
    mockQuery.mockResolvedValueOnce({ rows: opts.finales ?? [] });
  };

  const MARZO = { sinceDate: '2026-03-01', untilDate: '2026-03-31' };

  it('una balanza sin un ANTES no inventa la columna: se queda en tres', async () => {
    // `asOfDate` y la historia completa arrancan en el origen de los libros.
    // Una columna de ceros ahí se leería como arrastre, y además costaría dos
    // consultas por informe a las superficies que hoy hacen una.
    mockQuery.mockResolvedValueOnce({ rows: [tbRow('1120', '100', '0')] });
    const report = await getTrialBalance(ENTITY, { asOfDate: '2026-06-30' });
    expect(report.inicial).toBeUndefined();
    expect(report.rows[0].beginning_balance).toBeUndefined();
    expect(mockQuery.mock.calls).toHaveLength(1);
  });

  it('la balanza de un rango publica SaldoIni y SaldoFin, y cuadra', async () => {
    conRango({
      filas: [tbRow('1120', '30', '10')],
      previo: { period_name: 'Periodo 2/2026', status: 'hard_close' },
      iniciales: [accRow('1120', '100')],
      finales: [accRow('1120', '120')],
    });
    const report = await getTrialBalance(ENTITY, MARZO);
    const fila = report.rows[0];
    expect(fila.beginning_balance).toBe('100.0000');
    expect(fila.debit_total).toBe('30');
    expect(fila.credit_total).toBe('10');
    expect(fila.final_balance).toBe('120.0000');
    expect(fila.cuadra).toBe(true);
    expect(report.inicial!.descuadres).toEqual([]);
    // Y `ending_balance` sigue siendo lo que era: el movimiento neto del rango.
    expect(fila.ending_balance).toBe('20');
  });

  it('el SaldoFin se pide aparte: no se recompone, y por eso puede acusar', async () => {
    // Escrito como inicial + debe − haber, el recálculo del SAT saldría bien
    // SIEMPRE. Aquí el mayor dice otra cosa y la cuenta se señala en vez de
    // absorberse.
    conRango({
      filas: [tbRow('1120', '30', '10')],
      previo: { period_name: 'Periodo 2/2026', status: 'hard_close' },
      iniciales: [accRow('1120', '100')],
      finales: [accRow('1120', '999')],
    });
    const report = await getTrialBalance(ENTITY, MARZO);
    expect(report.rows[0].final_balance).toBe('999.0000');
    expect(report.rows[0].cuadra).toBe(false);
    expect(report.inicial!.descuadres).toEqual([
      {
        account_id: 'id-1120',
        account_code: '1120',
        esperado: '120.0000',
        obtenido: '999.0000',
        diferencia: '-879.0000',
      },
    ]);
    expect(report.inicial!.note).toMatch(/1 account\(s\) fail SaldoIni \+ Debe − Haber = SaldoFin/);
  });

  it('la cuenta que no aparece en el acumulado vale cero, no desaparece', async () => {
    conRango({
      filas: [tbRow('1120', '30', '10')],
      previo: { period_name: 'Periodo 2/2026', status: 'hard_close' },
      iniciales: [],
      finales: [accRow('1120', '20')],
    });
    const report = await getTrialBalance(ENTITY, MARZO);
    expect(report.rows[0].beginning_balance).toBe('0.0000');
    expect(report.rows[0].cuadra).toBe(true);
  });

  it('el dinero sale como cadena de cuatro decimales, nunca como número', async () => {
    conRango({
      filas: [tbRow('1120', '0.1', '0')],
      previo: { period_name: 'Periodo 2/2026', status: 'hard_close' },
      iniciales: [accRow('1120', '0.2')],
      finales: [accRow('1120', '0.3')],
    });
    const report = await getTrialBalance(ENTITY, MARZO);
    expect(typeof report.rows[0].beginning_balance).toBe('string');
    expect(report.rows[0].beginning_balance).toBe('0.2000');
    // 0.2 + 0.1 en coma flotante es 0.30000000000000004: con Decimal cuadra.
    expect(report.rows[0].cuadra).toBe(true);
  });

  it('FIRME lo jura el periodo ANTERIOR, no el consultado', async () => {
    conRango({
      filas: [tbRow('1120', '30', '10')],
      previo: { period_name: 'Periodo 2/2026', status: 'open' },
      iniciales: [accRow('1120', '100')],
      finales: [accRow('1120', '120')],
    });
    const abierto = await getTrialBalance(ENTITY, MARZO);
    expect(abierto.inicial!.firme).toBe(false);
    expect(abierto.inicial!.periodo_anterior).toEqual({
      period_name: 'Periodo 2/2026',
      status: 'open',
    });
    // Calculable y no firme: la cifra existe y todavía puede cambiar. Decirlo
    // es la mitad del trabajo, porque esto se firma.
    expect(abierto.inicial!.note).toMatch(/derived from the ledger/);
    expect(abierto.inicial!.note).toMatch(/NOT firm/);

    mockQuery.mockReset();
    conRango({
      filas: [tbRow('1120', '30', '10')],
      previo: { period_name: 'Periodo 2/2026', status: 'hard_close' },
      iniciales: [accRow('1120', '100')],
      finales: [accRow('1120', '120')],
    });
    const cerrado = await getTrialBalance(ENTITY, MARZO);
    expect(cerrado.inicial!.firme).toBe(true);
    expect(cerrado.inicial!.note).toMatch(/Firm: Periodo 2\/2026 is hard_close/);
  });

  it('sin periodo anterior el inicial debería ser cero, y si no lo es lo dice', async () => {
    conRango({
      filas: [tbRow('1120', '30', '10')],
      previo: null,
      iniciales: [accRow('1120', '100')],
      finales: [accRow('1120', '120')],
    });
    const report = await getTrialBalance(ENTITY, MARZO);
    expect(report.inicial!.firme).toBe(false);
    expect(report.inicial!.periodo_anterior).toBeNull();
    expect(report.inicial!.note).toMatch(/No earlier fiscal period/);
    expect(report.inicial!.note).toMatch(/1 account\(s\) already carry a balance/);
  });

  it('el periodo fiscal fecha la balanza con su propio rango, y acotado a la entidad', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [tbRow('1120', '30', '10')] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'fp-3', period_name: 'Periodo 3/2026', start_date: '2026-03-01', end_date: '2026-03-31' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ period_name: 'Periodo 2/2026', status: 'hard_close' }] });
    mockQuery.mockResolvedValueOnce({ rows: [accRow('1120', '100')] });
    mockQuery.mockResolvedValueOnce({ rows: [accRow('1120', '120')] });

    const report = await getTrialBalance(ENTITY, { fiscalPeriodId: 'fp-3' });
    // Un id de periodo de OTRA entidad no puede fechar esta balanza.
    expect(sql(1)).toMatch(/FROM fiscal_periods WHERE id = \$1 AND entity_id = \$2/);
    expect(params(1)).toEqual(['fp-3', ENTITY]);
    expect(params(3)).toEqual([ENTITY, '2026-03-01']); // inicial: antes del día 1
    expect(params(4)).toEqual([ENTITY, '2026-03-31']); // final: hasta el último
    expect(report.inicial!.desde).toBe('2026-03-01');
  });

  it('un periodo que no es de esta entidad no produce saldo inicial ninguno', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [tbRow('1120', '0', '0')] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    const report = await getTrialBalance(ENTITY, { fiscalPeriodId: 'de-otra-entidad' });
    expect(report.inicial).toBeUndefined();
    expect(mockQuery.mock.calls).toHaveLength(2);
  });

  it('--exclude-zero ya no tira la cuenta que arrastra saldo sin haberse movido', async () => {
    // Es justo la cuenta que el Anexo 24 necesita: el SAT recalcula sobre su
    // SaldoIni. Filtrando por el movimiento —que es cero— desaparecía.
    conRango({
      filas: [tbRow('1120', '0', '0'), tbRow('1130', '0', '0')],
      previo: { period_name: 'Periodo 2/2026', status: 'hard_close' },
      iniciales: [accRow('1120', '500')],
      finales: [accRow('1120', '500')],
    });
    const report = await getTrialBalance(ENTITY, { ...MARZO, excludeZero: true });
    expect(report.rows.map((r) => r.account_code)).toEqual(['1120']);
    expect(report.total).toBe(1);
  });

  it('lee la política del panel con su clave literal', async () => {
    conRango({
      filas: [tbRow('1120', '0', '0')],
      previo: { period_name: 'Periodo 2/2026', status: 'hard_close' },
    });
    const report = await getTrialBalance(ENTITY, MARZO);
    expect(getPolicy).toHaveBeenCalledWith(
      { tenantId: 'ten-1', entityId: ENTITY },
      'anexo24_balanza_saldo_inicial'
    );
    expect(report.inicial!.criterio).toBe('derivar_del_mayor');
    expect(report.inicial!.origen).toBe('mayor');
  });

  it('sin contexto de inquilino, lo resuelve por la entidad antes de leer el panel', async () => {
    // El CLI y el REST fijan el contexto RLS; un trabajo de fondo no. El
    // patrón de la casa es el mismo de criterio-cierre: contexto, y si no,
    // legal_entities.
    vi.mocked(currentTenant).mockReturnValueOnce(undefined);
    mockQuery.mockResolvedValueOnce({ rows: [tbRow('1120', '0', '0')] });
    mockQuery.mockResolvedValueOnce({ rows: [{ tenant_id: 'ten-de-la-entidad' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await getTrialBalance(ENTITY, MARZO);
    expect(sql(1)).toMatch(/SELECT tenant_id FROM legal_entities WHERE id = \$1/);
    expect(getPolicy).toHaveBeenCalledWith(
      { tenantId: 'ten-de-la-entidad', entityId: ENTITY },
      'anexo24_balanza_saldo_inicial'
    );
  });

  it('una entidad sin inquilino no revienta el informe: aplica el criterio por omisión', async () => {
    // Un informe no debe morir por no poder leer una política, que es la misma
    // regla que criterio-cierre declara para el criterio del cierre.
    vi.mocked(currentTenant).mockReturnValueOnce(undefined);
    mockQuery.mockResolvedValueOnce({ rows: [tbRow('1120', '0', '0')] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const report = await getTrialBalance(ENTITY, MARZO);
    expect(getPolicy).not.toHaveBeenCalled();
    expect(report.inicial!.criterio).toBe('derivar_del_mayor');
    expect(report.inicial!.origen).toBe('mayor');
  });

  it('exigir_cierre_duro lee el arrastre que sembró el cierre, no el mayor', async () => {
    vi.mocked(getPolicy).mockResolvedValue({ ...DERIVAR, value: 'exigir_cierre_duro' });
    mockQuery.mockResolvedValueOnce({ rows: [tbRow('1120', '30', '10')] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'fp-3', period_name: 'Periodo 3/2026', start_date: '2026-03-01', end_date: '2026-03-31' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ period_name: 'Periodo 2/2026', status: 'hard_close' }] });
    mockQuery.mockResolvedValueOnce({ rows: [accRow('1120', '100')] });
    mockQuery.mockResolvedValueOnce({ rows: [accRow('1120', '120')] });

    const report = await getTrialBalance(ENTITY, { fiscalPeriodId: 'fp-3' });
    expect(sql(3)).toMatch(/beginning_balance::text AS balance FROM account_balances/);
    expect(params(3)).toEqual([ENTITY, 'fp-3']);
    expect(report.inicial!.origen).toBe('arrastre_del_cierre');
    expect(report.rows[0].beginning_balance).toBe('100.0000');
    expect(report.inicial!.note).toMatch(/carried forward by the hard close of Periodo 2\/2026/);
  });

  it('exigir_cierre_duro se NIEGA en vez de publicar ceros cuando no hay arrastre', async () => {
    // El criterio que el usuario eligió dice exactamente esto. La alternativa
    // —un cero— es una declaración firmada de que la empresa abrió el mes en
    // nada, y ésa es la mentira que F07a vino a quitar del suelo.
    vi.mocked(getPolicy).mockResolvedValue({ ...DERIVAR, value: 'exigir_cierre_duro' });
    mockQuery.mockResolvedValueOnce({ rows: [tbRow('1120', '30', '10')] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'fp-3', period_name: 'Periodo 3/2026', start_date: '2026-03-01', end_date: '2026-03-31' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ period_name: 'Periodo 2/2026', status: 'soft_close' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const err = await getTrialBalance(ENTITY, { fiscalPeriodId: 'fp-3' }).then(
      () => null,
      (e: Error) => e
    );
    expect(err).toBeInstanceOf(ValidationError);
    expect(err!.message).toMatch(/anexo24_balanza_saldo_inicial.*exigir_cierre_duro/);
    expect(err!.message).toMatch(/Periodo 2\/2026 está en 'soft_close'/);
    expect(err!.message).toMatch(/derivar_del_mayor/);
  });
});

describe('buildBalanceSheetSection — contra accounts NET, they do not inflate', () => {
  const rows = [
    { id: 'a', code: '1200', name: 'Equipo', account_type: 'asset', fs_category: 'fixed_assets', balance: '1000.0000' },
    { id: 'b', code: '1290', name: 'Depreciación Acumulada', account_type: 'contra_asset', fs_category: 'fixed_assets', balance: '-400.0000' },
  ];

  it('subtracts accumulated depreciation instead of adding its absolute value', () => {
    const section = buildBalanceSheetSection(rows, ['asset', 'contra_asset'], 'Assets', 1);
    expect(section.total).toBe('600.0000');
    expect(section.subsections[0].accounts.map((a) => a.balance)).toEqual(['1000.0000', '-400.0000']);
  });

  it('flips the sign for credit-natural sections rather than taking abs()', () => {
    const liabilities = [
      { id: 'c', code: '2110', name: 'Proveedores', account_type: 'liability', fs_category: 'current_liabilities', balance: '-16008.0000' },
    ];
    const section = buildBalanceSheetSection(liabilities, ['liability', 'contra_liability'], 'Liabilities', -1);
    expect(section.total).toBe('16008.0000');
  });

  it('groups accounts with no fs_category under "Other" rather than dropping them', () => {
    const orphan = [{ id: 'd', code: '1999', name: 'Sin categoría', account_type: 'asset', fs_category: null, balance: '5.0000' }];
    const section = buildBalanceSheetSection(orphan, ['asset'], 'Assets', 1);
    expect(section.subsections[0].name).toBe('Other');
    expect(section.total).toBe('5.0000');
  });

  it('every amount it produces is a string', () => {
    const section = buildBalanceSheetSection(rows, ['asset', 'contra_asset'], 'Assets', 1);
    expect(typeof section.total).toBe('string');
    expect(typeof section.subsections[0].total).toBe('string');
    expect(typeof section.subsections[0].accounts[0].balance).toBe('string');
  });
});

describe('queryBalanceSheetRows / getBalanceSheet', () => {
  it('cuts at the as-of date and only on permanent accounts', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryBalanceSheetRows(ENTITY, '2026-12-31');
    expect(sql(0)).toMatch(/AND je\.entry_date <= \$2/);
    expect(sql(0)).toMatch(/a\.account_type IN \('asset', 'liability', 'equity', 'contra_asset', 'contra_liability', 'contra_equity'\)/);
    expect(params(0)).toEqual([ENTITY, '2026-12-31']);
  });

  it('adds liabilities and equity into the balancing figure', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'a', code: '1110', name: 'Bancos', account_type: 'asset', fs_category: 'current_assets', balance: '100.0000' },
        { id: 'b', code: '2110', name: 'Proveedores', account_type: 'liability', fs_category: 'current_liabilities', balance: '-60.0000' },
        { id: 'c', code: '3100', name: 'Capital', account_type: 'equity', fs_category: 'equity', balance: '-40.0000' },
      ],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] }); // nothing unclosed
    const bs = await getBalanceSheet(ENTITY, { asOfDate: '2026-12-31' });
    expect(bs.assets.total).toBe('100.0000');
    expect(bs.total_liabilities_and_equity).toBe('100.0000');
    expect(bs.is_balanced).toBe(true);
    expect(bs.out_of_balance).toBe('0.0000');
  });
});

// ============================================================
// The identity A = L + E, which the statement used to violate and then
// explain away. The number that closed the gap on real data was exactly
// the unclosed result of the period: assets -261.12 against liabilities
// plus equity 16,008.00, a gap of 16,269.12 — the P&L nobody had swept.
// ============================================================

describe('the result of the period belongs to equity', () => {
  const PERMANENT = [
    { id: 'a', code: '1110', name: 'Bancos', account_type: 'asset', fs_category: 'current_assets', balance: '100.0000' },
    { id: 'b', code: '2110', name: 'Proveedores', account_type: 'liability', fs_category: 'current_liabilities', balance: '-70.0000' },
  ];

  it('makes the statement foot when a period is still open', async () => {
    mockQuery.mockResolvedValueOnce({ rows: PERMANENT });
    // Revenue 50 credit, expense 20 debit → debit-positive net of -30.
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '-30.0000' }] });

    const bs = await getBalanceSheet(ENTITY, { asOfDate: '2026-06-30' });
    expect(bs.equity.subsections.map((s) => s.name)).toContain('Result Of The Period');
    expect(bs.equity.total).toBe('30.0000');
    expect(bs.total_liabilities_and_equity).toBe('100.0000');
    expect(bs.assets.total).toBe('100.0000');
    expect(bs.is_balanced).toBe(true);
  });

  it('sums temporary accounts from INCEPTION, so a closed year cannot double count', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] });
    await getBalanceSheet(ENTITY, { asOfDate: '2026-12-31' });

    const earningsSql = sql(1);
    expect(earningsSql).toMatch(/account_type IN \('revenue', 'expense', 'contra_revenue'\)/);
    // A closing entry debits revenue and credits expense, so a closed year
    // nets to zero here on its own. Bounding by a fiscal-year start would
    // double count it against retained earnings.
    expect(earningsSql).not.toMatch(/fiscal_year|start_date/);
    expect(params(1)).toEqual([ENTITY, '2026-12-31']);
  });

  it('omits the line entirely when there is nothing unclosed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: PERMANENT });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] });
    const bs = await getBalanceSheet(ENTITY, { asOfDate: '2026-12-31' });
    expect(bs.equity.subsections.map((s) => s.name)).not.toContain('Result Of The Period');
  });

  it('reports the gap instead of hiding it when the ledger is genuinely inconsistent', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'a', code: '1110', name: 'Bancos', account_type: 'asset', fs_category: 'current_assets', balance: '100.0000' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ balance: '0' }] });
    const bs = await getBalanceSheet(ENTITY, { asOfDate: '2026-12-31' });
    expect(bs.is_balanced).toBe(false);
    expect(bs.out_of_balance).toBe('100.0000');
  });

  // ══════════════════════════════════════════════════════════
  // T13 · LA OTRA MITAD DE LA ASIMETRÍA, tambien reescrita.
  //
  // Esta prueba decía «keeps a retired account that still carries a balance on
  // the statement» y afirmaba `not.toMatch(/a.is_active/)` como si fuera una
  // particularidad DEL BALANCE GENERAL —su comentario lo justificaba caso por
  // caso: «filtering by is_active removed real money»—, mientras su gemela de
  // arriba exigía el filtro para la balanza. Cada una era razonable a solas y
  // juntas fijaban dos contabilidades dentro del mismo servicio.
  //
  // No era una preferencia: era la misma regla vista desde un lado. Aquí se
  // afirma la regla ENTERA y sobre las TRES consultas que la comparten, que es
  // lo que ninguna de las dos hacía — y el estado de resultados, que es por
  // donde salía el daño, no tenía NI UNA prueba sobre esto.
  // ══════════════════════════════════════════════════════════
  it.each([
    ['balance general', () => getBalanceSheet(ENTITY, { asOfDate: '2026-12-31' }), 2],
    [
      'estado de resultados',
      () => queryIncomeStatementRows(ENTITY, { startDate: '2026-01-01', endDate: '2026-12-31' }),
      1,
    ],
    ['arrastre del resultado', () => queryUnclosedEarnings(ENTITY, '2026-12-31'), 1],
  ])(
    '%s: ninguna cuenta se cae por estar archivada — lo que decide es llevar cifra',
    async (_nombre, correr, consultas) => {
      for (let n = 0; n < consultas; n++) {
        mockQuery.mockResolvedValueOnce({ rows: n === 1 ? [{ balance: '0' }] : [] });
      }
      await correr();
      // Filtrar por `is_active` aquí sólo puede borrar una cuenta que SÍ
      // llevaba cifra: el HAVING (o el JOIN interno) ya dejó fuera a las que
      // no. Es lo que imprimía Revenue 0.0000 sobre un ejercicio firmado.
      expect(sql(0)).not.toMatch(/a\.is_active/);
    }
  );

  it('el estado de resultados no consulta el panel de cuentas archivadas', async () => {
    // Su HAVING ya incluye exactamente a las cuentas con actividad en el
    // rango: no queda nada que un despacho pueda preferir. La bifurcación
    // existe SÓLO en la balanza, que es la que conserva renglones vacíos.
    vi.mocked(criterioDeCuentasArchivadas).mockClear();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryIncomeStatementRows(ENTITY, { startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(criterioDeCuentasArchivadas).not.toHaveBeenCalled();
  });
});

describe('income statement', () => {
  it('keeps the historical HAVING by default and widens it only on request', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryIncomeStatementRows(ENTITY, { startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(sql(0)).toMatch(/HAVING COALESCE\(SUM\(COALESCE\(jel\.debit_amount, 0\) - COALESCE\(jel\.credit_amount, 0\)\), 0\) != 0/);

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryIncomeStatementRows(ENTITY, { startDate: '2026-01-01', endDate: '2026-12-31', include: 'any-activity' });
    expect(sql(1)).toMatch(/HAVING COALESCE\(SUM\(COALESCE\(jel\.debit_amount, 0\)\), 0\) != 0 OR/);
  });

  it('bounds the range with BETWEEN in parameter order', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryIncomeStatementRows(ENTITY, { startDate: '2026-01-01', endDate: '2026-03-31' });
    expect(sql(0)).toMatch(/je\.entry_date BETWEEN \$2 AND \$3/);
    expect(params(0)).toEqual([ENTITY, '2026-01-01', '2026-03-31']);
  });

  it('reports revenue positive even though it is credit-natural', () => {
    const section = buildIncomeStatementSection(
      [{ id: 'r', code: '4100', name: 'Ventas', account_type: 'revenue', fs_category: null, debit_total: '0', credit_total: '1000' }],
      'revenue'
    );
    expect(section.total).toBe('1000.0000');
    expect(section.accounts[0].amount).toBe('1000.0000');
  });

  it('does not let a sales return inflate revenue the way abs() would', () => {
    const section = buildIncomeStatementSection(
      [
        { id: 'r', code: '4100', name: 'Ventas', account_type: 'revenue', fs_category: null, debit_total: '0', credit_total: '1000' },
        { id: 'x', code: '4400', name: 'Devoluciones', account_type: 'revenue', fs_category: null, debit_total: '300', credit_total: '0' },
      ],
      'revenue'
    );
    // Netted: 1000 − 300. abs() would have said 1300.
    expect(section.total).toBe('700.0000');
    expect(section.accounts[1].amount).toBe('-300.0000');
  });

  it('nets income as revenue minus expenses, as strings', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'r', code: '4100', name: 'Ventas', account_type: 'revenue', fs_category: null, debit_total: '0', credit_total: '1000' },
        { id: 'e', code: '6100', name: 'Gastos', account_type: 'expense', fs_category: null, debit_total: '400', credit_total: '0' },
      ],
    });
    const is = await getIncomeStatement(ENTITY, { startDate: '2026-01-01', endDate: '2026-12-31' });
    expect(is.net_income).toBe('600.0000');
    expect(typeof is.net_income).toBe('string');
  });
});

describe('general ledger', () => {
  it('filters by account id, code and dates in a stable parameter order', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryLedgerRows(ENTITY, { accountId: 'acc-1', startDate: '2026-01-01', endDate: '2026-03-31', limit: 50, offset: 10 });
    expect(sql(0)).toMatch(/WHERE a\.entity_id = \$1 AND je\.status = 'posted' AND a\.id = \$2 AND je\.entry_date >= \$3 AND je\.entry_date <= \$4/);
    expect(params(0)).toEqual([ENTITY, 'acc-1', '2026-01-01', '2026-03-31', 50, 10]);
  });

  it('accepts an account code, which is what a person types', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryLedgerRows(ENTITY, { accountCode: '1110', limit: 101 });
    expect(sql(0)).toMatch(/AND a\.code = \$2/);
    expect(params(0)).toEqual([ENTITY, '1110', 101, 0]);
  });

  it('counts with exactly the same predicate it selects with', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '412' }] });
    await countLedgerRows(ENTITY, { accountCode: '1110', startDate: '2026-01-01' });
    expect(sql(0)).toMatch(/SELECT COUNT\(\*\) as count/);
    expect(sql(0)).toMatch(/AND a\.code = \$2 AND je\.entry_date >= \$3/);
    expect(params(0)).toEqual([ENTITY, '1110', '2026-01-01']);
  });

  it('reports the true total next to a short page', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '412' }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ debit_amount: '10.0000', credit_amount: null }, { debit_amount: null, credit_amount: '4.0000' }],
    });
    const gl = await getGeneralLedger(ENTITY, { limit: 2 });
    expect(gl.total).toBe(412);
    expect(gl.rows).toHaveLength(2);
    expect(gl.period_debits).toBe('10.0000');
    expect(gl.period_credits).toBe('4.0000');
  });

  it('treats a null amount as zero without turning it into NaN', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ debit_amount: null, credit_amount: null }] });
    const gl = await getGeneralLedger(ENTITY, { limit: 10 });
    expect(gl.period_debits).toBe('0.0000');
  });
});

describe('ageing', () => {
  it('receivables: only open invoices with something still due', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAgedReceivableRows(ENTITY, { asOfDate: '2026-08-25' });
    expect(sql(0)).toMatch(/i\.status IN \('sent', 'viewed', 'partially_paid', 'overdue'\)/);
    expect(sql(0)).toMatch(/AND i\.amount_due > 0/);
    expect(sql(0)).toMatch(/\(\$2::date - i\.due_date\) as days_overdue/);
    expect(params(0)).toEqual([ENTITY, '2026-08-25']);
  });

  it('payables: only bills that are approved, posted or partly paid', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAgedPayableRows(ENTITY, { asOfDate: '2026-08-25' });
    expect(sql(0)).toMatch(/b\.status IN \('approved', 'posted', 'partially_paid'\)/);
    expect(sql(0)).toMatch(/AND b\.amount_due > 0/);
  });

  it('orders by party for the API and by age for a human chasing money', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAgedPayableRows(ENTITY, { asOfDate: '2026-08-25', order: 'party' });
    expect(sql(0)).toMatch(/ORDER BY v\.company_name, b\.due_date/);

    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAgedPayableRows(ENTITY, { asOfDate: '2026-08-25', order: 'overdue' });
    expect(sql(1)).toMatch(/ORDER BY days_overdue DESC, v\.company_name/);
  });

  it('the order option cannot smuggle SQL in: it is a closed choice', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await queryAgedPayableRows(ENTITY, { asOfDate: '2026-08-25', order: 'x; DROP TABLE bills' as never });
    expect(sql(0)).toMatch(/ORDER BY v\.company_name, b\.due_date$/);
    expect(sql(0)).not.toMatch(/DROP TABLE/);
  });

  it('totals the amount due over every open document, not over the page', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { amount_due: '1000.0000' }, { amount_due: '2000.0000' }, { amount_due: '3000.0000' },
      ],
    });
    const aging = await getAgedReceivables(ENTITY, { asOfDate: '2026-08-25', limit: 1 });
    expect(aging.rows).toHaveLength(1);
    expect(aging.total).toBe(3);
    expect(aging.total_due).toBe('6000.0000');
  });

  it('payables total the same way', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ amount_due: '1160.0000' }, { amount_due: '2900.0000' }] });
    const aging = await getAgedPayables(ENTITY, { asOfDate: '2026-08-25' });
    expect(aging.total_due).toBe('4060.0000');
  });
});

describe('resolvePeriodRange — the entity owns the definition of a period', () => {
  it('prefers a fiscal period matched by name over calendar arithmetic', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'fp-8', period_name: 'August 2026', start_date: '2026-08-01', end_date: '2026-08-31' }],
    });
    const range = await resolvePeriodRange(ENTITY, 'August 2026');
    expect(range.fiscal_period_id).toBe('fp-8');
    expect(range.matched_fiscal_period).toBe(true);
    expect(params(0)).toEqual([ENTITY, 'August 2026']);
  });

  it('falls back to the calendar month and SAYS it did not match a period', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no period named 2026-02
    mockQuery.mockResolvedValueOnce({ rows: [] }); // none with those exact bounds
    const range = await resolvePeriodRange(ENTITY, '2026-02');
    expect(range).toMatchObject({
      start_date: '2026-02-01',
      end_date: '2026-02-28',
      matched_fiscal_period: false,
    });
  });

  it('gets February right in a leap year', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect((await resolvePeriodRange(ENTITY, '2028-02')).end_date).toBe('2028-02-29');
  });

  it('adopts a fiscal period whose bounds coincide with the calendar expression', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'fp-1', period_name: '2026-01', start_date: '2026-01-01', end_date: '2026-01-31' }],
    });
    const range = await resolvePeriodRange(ENTITY, '2026-01');
    expect(range.fiscal_period_id).toBe('fp-1');
    expect(range.matched_fiscal_period).toBe(true);
  });

  it('understands quarters and fiscal years', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await resolvePeriodRange(ENTITY, '2026-Q3')).toMatchObject({ start_date: '2026-07-01', end_date: '2026-09-30' });
    expect(await resolvePeriodRange(ENTITY, 'FY2026')).toMatchObject({ start_date: '2026-01-01', end_date: '2026-12-31' });
  });

  it('spans a..b by taking the start of one and the end of the other', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const range = await resolvePeriodRange(ENTITY, '2026-01..2026-06');
    expect(range).toMatchObject({ start_date: '2026-01-01', end_date: '2026-06-30' });
  });

  it('refuses a range that runs backwards instead of returning nothing', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await expect(resolvePeriodRange(ENTITY, '2026-06..2026-01')).rejects.toThrow(ValidationError);
  });

  it('names the periods it knows when nothing matches', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // exact
    mockQuery.mockResolvedValueOnce({ rows: [] }); // fuzzy
    mockQuery.mockResolvedValueOnce({ rows: [{ period_name: 'January 2026' }] });
    await expect(resolvePeriodRange(ENTITY, 'brumario')).rejects.toThrow(/Known periods: January 2026/);
  });

  it('spans several periods when one name matches many', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no exact match
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 'fp-1', period_name: 'Q1 M1', start_date: '2026-01-01', end_date: '2026-01-31' },
        { id: 'fp-2', period_name: 'Q1 M2', start_date: '2026-02-01', end_date: '2026-02-28' },
      ],
    });
    const range = await resolvePeriodRange(ENTITY, 'Q1');
    expect(range).toMatchObject({ start_date: '2026-01-01', end_date: '2026-02-28', matched_fiscal_period: false });
    // Without a single period there is no id to hand on: saying so beats guessing.
    expect(range.fiscal_period_id).toBeUndefined();
  });

  it('every period lookup is scoped to the entity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await resolvePeriodRange(ENTITY, '2026-03');
    for (const call of mockQuery.mock.calls) {
      expect(String(call[0])).toMatch(/entity_id = \$1/);
      expect((call[1] as unknown[])[0]).toBe(ENTITY);
    }
  });
});
