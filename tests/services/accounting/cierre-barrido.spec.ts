import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import {
  barrerCuentasDeResultados,
  codigoDestinoDelResultado,
  accionDeRecierre,
  severidadDeResultadoSinBarrer,
  verificarQueElEjercicioBarrio,
  type LineaDeCierre,
  type SaldoDeResultados,
} from '../../../src/services/accounting/period-close.js';
import { clienteFalso } from '../../helpers/fake-pg.js';

// ============================================================
// G1a · LA ARITMÉTICA DEL BARRIDO ANUAL, SIN BASE DE DATOS.
//
// El saldo entra en la convención del mayor: DEUDOR POSITIVO
// (SUM(debit_total - credit_total)). Barrer es asentar lo CONTRARIO al saldo.
//
// Lo que estas pruebas congelan es justo lo que abs() rompía: la cuenta
// CONTRA-NATURAL. La 4400 «Devoluciones sobre Ventas» es revenue de saldo
// DEUDOR y la 5200 «Devoluciones sobre Compras» es expense de saldo ACREEDOR;
// con abs() las dos se asentaban del MISMO lado que su saldo y quedaban al
// DOBLE en vez de en cero, mientras el asiento seguía cuadrando.
// ============================================================

const PUENTE = '3900';

const puente = {
  account_id: PUENTE,
  descripcionCuenta: 'Close to Income Summary',
  descripcionPuente: 'Closed to Income Summary',
};

/** El efecto de una línea sobre el saldo de su cuenta, deudor positivo. */
function efecto(l: LineaDeCierre): Decimal {
  return new Decimal(l.debit_amount ?? 0).minus(l.credit_amount ?? 0);
}

function lineaDe(lineas: LineaDeCierre[], accountId: string): LineaDeCierre {
  const l = lineas.find((x) => x.account_id === accountId);
  if (!l) throw new Error(`no se emitió línea para ${accountId}`);
  return l;
}

function cuadra(lineas: LineaDeCierre[]): boolean {
  const suma = lineas.reduce((acc, l) => acc.plus(efecto(l)), new Decimal(0));
  return suma.isZero();
}

describe('barrerCuentasDeResultados — la tabla de casos', () => {
  interface Caso {
    nombre: string;
    saldos: SaldoDeResultados[];
    /** Lado y monto esperados por cuenta barrida. */
    esperado: Record<string, { debit: string | null; credit: string | null }>;
    total: string;
    /** Lado y monto de la línea puente, o null si no debe emitirse. */
    puente: { debit: string | null; credit: string | null } | null;
  }

  const casos: Caso[] = [
    {
      nombre: 'ingreso de naturaleza normal (4100, saldo acreedor): se CARGA',
      saldos: [{ account_id: '4100', code: '4100', balance: '-10000.0000' }],
      esperado: { '4100': { debit: '10000.0000', credit: null } },
      total: '-10000.0000',
      puente: { debit: null, credit: '10000.0000' },
    },
    {
      nombre: 'CONTRA-INGRESO 4400 «Devoluciones sobre Ventas» (saldo DEUDOR): se ABONA',
      saldos: [{ account_id: '4400', code: '4400', balance: '2000.0000' }],
      esperado: { '4400': { debit: null, credit: '2000.0000' } },
      total: '2000.0000',
      puente: { debit: '2000.0000', credit: null },
    },
    {
      nombre: 'ingreso y su contra-ingreso: la devolución RESTA (10 000 − 2 000 = 8 000)',
      saldos: [
        { account_id: '4100', code: '4100', balance: '-10000.0000' },
        { account_id: '4400', code: '4400', balance: '2000.0000' },
      ],
      esperado: {
        '4100': { debit: '10000.0000', credit: null },
        '4400': { debit: null, credit: '2000.0000' },
      },
      // Con abs() el total era 12 000: la devolución INFLABA el ingreso.
      total: '-8000.0000',
      puente: { debit: null, credit: '8000.0000' },
    },
    {
      nombre: 'gasto de naturaleza normal (5100, saldo deudor): se ABONA',
      saldos: [{ account_id: '5100', code: '5100', balance: '6000.0000' }],
      esperado: { '5100': { debit: null, credit: '6000.0000' } },
      total: '6000.0000',
      puente: { debit: '6000.0000', credit: null },
    },
    {
      nombre: 'CONTRA-GASTO 5200 «Devoluciones sobre Compras» (saldo ACREEDOR): se CARGA',
      saldos: [{ account_id: '5200', code: '5200', balance: '-1000.0000' }],
      esperado: { '5200': { debit: '1000.0000', credit: null } },
      // Total NEGATIVO legítimo: el guarda viejo greaterThan(0) omitía aquí la
      // línea puente y el asiento salía descuadrado.
      total: '-1000.0000',
      puente: { debit: null, credit: '1000.0000' },
    },
    {
      nombre: 'gasto y su contra-gasto: la devolución RESTA (6 000 − 1 000 = 5 000)',
      saldos: [
        { account_id: '5100', code: '5100', balance: '6000.0000' },
        { account_id: '5200', code: '5200', balance: '-1000.0000' },
      ],
      esperado: {
        '5100': { debit: null, credit: '6000.0000' },
        '5200': { debit: '1000.0000', credit: null },
      },
      // Con abs() el total era 7 000.
      total: '5000.0000',
      puente: { debit: '5000.0000', credit: null },
    },
    {
      nombre: 'total cero con líneas: se barre igual y NO lleva puente',
      saldos: [
        { account_id: '4100', code: '4100', balance: '-10000.0000' },
        { account_id: '4400', code: '4400', balance: '10000.0000' },
      ],
      esperado: {
        '4100': { debit: '10000.0000', credit: null },
        '4400': { debit: null, credit: '10000.0000' },
      },
      total: '0.0000',
      puente: null,
    },
    {
      nombre: 'una cuenta en cero no se barre: no ensucia el asiento',
      saldos: [
        { account_id: '4100', code: '4100', balance: '-500.0000' },
        { account_id: '4200', code: '4200', balance: '0' },
      ],
      esperado: { '4100': { debit: '500.0000', credit: null } },
      total: '-500.0000',
      puente: { debit: null, credit: '500.0000' },
    },
    {
      nombre: 'los centavos no se truncan a dos decimales',
      saldos: [{ account_id: '4100', code: '4100', balance: '-1234.5678' }],
      esperado: { '4100': { debit: '1234.5678', credit: null } },
      total: '-1234.5678',
      puente: { debit: null, credit: '1234.5678' },
    },
  ];

  for (const caso of casos) {
    it(caso.nombre, () => {
      const { lineas, total } = barrerCuentasDeResultados(caso.saldos, puente);

      expect(total).toBe(caso.total);

      for (const [cuenta, lado] of Object.entries(caso.esperado)) {
        const l = lineaDe(lineas, cuenta);
        expect(l.debit_amount, `${cuenta} cargo`).toBe(lado.debit);
        expect(l.credit_amount, `${cuenta} abono`).toBe(lado.credit);

        // LA PRUEBA DE FUEGO: saldo + efecto de la línea = 0. Con abs() esto
        // daba el DOBLE del saldo en las contra-naturales.
        const saldo = caso.saldos.find((s) => s.account_id === cuenta)!.balance;
        expect(
          new Decimal(saldo).plus(efecto(l)).toFixed(4),
          `${cuenta} no quedó en cero`
        ).toBe('0.0000');
      }

      const lineasPuente = lineas.filter((l) => l.account_id === PUENTE);
      if (caso.puente === null) {
        expect(lineasPuente).toHaveLength(0);
      } else {
        expect(lineasPuente).toHaveLength(1);
        expect(lineasPuente[0].debit_amount).toBe(caso.puente.debit);
        expect(lineasPuente[0].credit_amount).toBe(caso.puente.credit);
      }

      // El asiento cuadra en todos los casos, con puente o sin él.
      expect(cuadra(lineas), 'el asiento no cuadra').toBe(true);
    });
  }
});

describe('el ejercicio completo del reconocimiento', () => {
  // Ventas 10 000, devolución sobre ventas 2 000, costo 6 000, devolución
  // sobre compras 1 000. Utilidad real: (10 000 − 2 000) − (6 000 − 1 000) = 3 000.
  const ingresos: SaldoDeResultados[] = [
    { account_id: '4100', code: '4100', balance: '-10000.0000' },
    { account_id: '4400', code: '4400', balance: '2000.0000' },
  ];
  const gastos: SaldoDeResultados[] = [
    { account_id: '5100', code: '5100', balance: '6000.0000' },
    { account_id: '5200', code: '5200', balance: '-1000.0000' },
  ];

  it('el resumen queda con 3 000 acreedor: UTILIDAD de 3 000, no 5 000', () => {
    const bi = barrerCuentasDeResultados(ingresos, puente);
    const bg = barrerCuentasDeResultados(gastos, puente);

    // El saldo de la 3900 tras los dos puentes, en la misma convención.
    const saldoResumen = new Decimal(bi.total).plus(bg.total);
    expect(saldoResumen.toFixed(4)).toBe('-3000.0000'); // acreedor = utilidad
    expect(saldoResumen.negated().toFixed(4)).toBe('3000.0000');

    // Con abs(): totalRevenue = 12 000, totalExpenses = 7 000, resultado 5 000.
    const conAbs = ingresos
      .reduce((a, s) => a.plus(new Decimal(s.balance).abs()), new Decimal(0))
      .minus(gastos.reduce((a, s) => a.plus(new Decimal(s.balance).abs()), new Decimal(0)));
    expect(conAbs.toFixed(4)).toBe('5000.0000');
    expect(conAbs.toFixed(4)).not.toBe(saldoResumen.negated().toFixed(4));
  });

  it('las cuatro cuentas quedan en CERO, ninguna al doble', () => {
    const lineas = [
      ...barrerCuentasDeResultados(ingresos, puente).lineas,
      ...barrerCuentasDeResultados(gastos, puente).lineas,
    ];
    for (const saldo of [...ingresos, ...gastos]) {
      const l = lineaDe(lineas, saldo.account_id);
      expect(
        new Decimal(saldo.balance).plus(efecto(l)).toFixed(4),
        `${saldo.code} no barrió`
      ).toBe('0.0000');
    }
    expect(cuadra(lineas)).toBe(true);
  });

  it('el barrido del resumen es el mismo acto: lo contrario a su saldo', () => {
    const bi = barrerCuentasDeResultados(ingresos, puente);
    const bg = barrerCuentasDeResultados(gastos, puente);
    const saldoResumen = new Decimal(bi.total).plus(bg.total);

    const destino = barrerCuentasDeResultados(
      [{ account_id: PUENTE, balance: saldoResumen.toFixed(4) }],
      { account_id: '3300', descripcionCuenta: 'Close Income Summary', descripcionPuente: 'Net income' }
    );

    // Utilidad: se CARGA el resumen y se ABONA el destino.
    expect(lineaDe(destino.lineas, PUENTE).debit_amount).toBe('3000.0000');
    expect(lineaDe(destino.lineas, '3300').credit_amount).toBe('3000.0000');
    expect(new Decimal(saldoResumen).plus(efecto(lineaDe(destino.lineas, PUENTE))).toFixed(4)).toBe('0.0000');
    expect(cuadra(destino.lineas)).toBe(true);
  });

  it('con pérdida el asiento se invierte: se ABONA el resumen', () => {
    // Sólo costo 6 000 contra ventas 1 000: pérdida de 5 000.
    const bi = barrerCuentasDeResultados(
      [{ account_id: '4100', balance: '-1000.0000' }],
      puente
    );
    const bg = barrerCuentasDeResultados([{ account_id: '5100', balance: '6000.0000' }], puente);
    const saldoResumen = new Decimal(bi.total).plus(bg.total);
    expect(saldoResumen.toFixed(4)).toBe('5000.0000'); // deudor = pérdida

    const destino = barrerCuentasDeResultados(
      [{ account_id: PUENTE, balance: saldoResumen.toFixed(4) }],
      { account_id: '3300', descripcionCuenta: 'Close Income Summary', descripcionPuente: 'Net loss' }
    );
    expect(lineaDe(destino.lineas, PUENTE).credit_amount).toBe('5000.0000');
    expect(lineaDe(destino.lineas, '3300').debit_amount).toBe('5000.0000');
  });
});

describe('las políticas del cierre, leídas por su literal', () => {
  it('el destino del resultado: sólo un literal funde el año con los anteriores', () => {
    expect(codigoDestinoDelResultado('directo_a_acumulados')).toBe('3200');
    expect(codigoDestinoDelResultado('dos_pasos_hasta_asamblea')).toBe('3300');
    // Desconocido → el camino reversible.
    expect(codigoDestinoDelResultado('lo_que_sea')).toBe('3300');
    expect(codigoDestinoDelResultado('')).toBe('3300');
  });

  it('el recierre: desconocido cae en incremental, que no escribe por su cuenta', () => {
    expect(accionDeRecierre('reversar_y_reemitir')).toBe('reversar');
    expect(accionDeRecierre('incremental')).toBe('incremental');
    expect(accionDeRecierre('prohibir')).toBe('prohibir');
    expect(accionDeRecierre('reversar')).toBe('incremental');
    expect(accionDeRecierre('')).toBe('incremental');
  });

  it('el residuo sin barrer: bloquean el literal y tolerancia (que hoy vale cero)', () => {
    expect(severidadDeResultadoSinBarrer('bloquear_cierre')).toBe('bloquear');
    expect(severidadDeResultadoSinBarrer('tolerancia')).toBe('bloquear');
    expect(severidadDeResultadoSinBarrer('avisar')).toBe('avisar');
    // Un valor raro no congela el cierre de un despacho.
    expect(severidadDeResultadoSinBarrer('bloquear')).toBe('avisar');
    expect(severidadDeResultadoSinBarrer('')).toBe('avisar');
  });
});

describe('verificarQueElEjercicioBarrio — el centinela que faltaba', () => {
  const ENTIDAD = '11111111-1111-1111-1111-111111111111';
  const PERIODO = '22222222-2222-2222-2222-222222222222';

  const residuos = [
    { code: '4400', name: 'Devoluciones y Descuentos sobre Ventas', balance: '4000.0000' },
    { code: '5200', name: 'Devoluciones y Descuentos sobre Compras', balance: '-2000.0000' },
  ];

  const arnes = (rows: unknown[]) =>
    clienteFalso([{ cuando: /FROM account_balances ab/, responde: { rows } }]);

  it('con el defecto del panel lanza, y el error NOMBRA las cuentas con su saldo', async () => {
    const avisos: string[] = [];
    const { client } = arnes(residuos);
    await expect(
      verificarQueElEjercicioBarrio(client, ENTIDAD, PERIODO, 'bloquear_cierre', avisos)
    ).rejects.toThrow(/4400 Devoluciones y Descuentos sobre Ventas: 4000\.0000/);
    expect(avisos).toHaveLength(0);
  });

  it('el error nombra TODAS las que no barrieron, no sólo la primera', async () => {
    const { client } = arnes(residuos);
    let mensaje = '';
    try {
      await verificarQueElEjercicioBarrio(client, ENTIDAD, PERIODO, 'bloquear_cierre', []);
    } catch (e) {
      mensaje = (e as Error).message;
    }
    expect(mensaje).toContain('5200 Devoluciones y Descuentos sobre Compras: -2000.0000');
    expect(mensaje).toMatch(/2 cuenta\(s\)/);
  });

  it("con 'avisar' no lanza: deja el aviso para el rastro", async () => {
    const avisos: string[] = [];
    const { client } = arnes(residuos);
    await verificarQueElEjercicioBarrio(client, ENTIDAD, PERIODO, 'avisar', avisos);
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain('4400');
    expect(avisos[0]).toContain('5200');
  });

  it('sin residuos no lanza ni avisa: el ejercicio quedó en cero', async () => {
    const avisos: string[] = [];
    const { client } = arnes([]);
    await verificarQueElEjercicioBarrio(client, ENTIDAD, PERIODO, 'bloquear_cierre', avisos);
    expect(avisos).toHaveLength(0);
  });

  it('acota por entidad DENTRO del SQL y por el ejercicio del periodo', async () => {
    const arnesConRegistro = clienteFalso([
      { cuando: /FROM account_balances ab/, responde: { rows: [] } },
    ]);
    await verificarQueElEjercicioBarrio(arnesConRegistro.client, ENTIDAD, PERIODO, 'avisar', []);
    const [consulta] = arnesConRegistro.coincidencias(/FROM account_balances ab/);
    expect(consulta.sql).toContain('a.entity_id = $1');
    expect(consulta.sql).toContain('ab.entity_id = $1');
    expect(consulta.sql).toContain('fp.fiscal_year_id =');
    expect(consulta.params).toEqual([ENTIDAD, PERIODO]);
  });
});
