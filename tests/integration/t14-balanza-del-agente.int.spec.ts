import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { createJournalEntry, drainAttestations } from '../../src/services/accounting/posting.js';
import { buildReportTools } from '../../src/ai/tools/report-tools.js';
import { getBalanceSheet } from '../../src/services/reporting/report-service.js';
import { JournalEntryType } from '../../src/types/index.js';
import type { AgentContext } from '../../src/ai/context.js';
import { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from '../../src/ai/untrusted.js';

/**
 * T14a · LA BALANZA DEL AGENTE, QUE ERA LA ÚNICA QUE SE CALCULABA SOLA.
 *
 * De las tres superficies del balance —CLI, REST y la herramienta del agente—
 * sólo ésta ensamblaba su propio total: hacía UNA consulta, no llamaba a
 * `queryUnclosedEarnings`, y publicaba `total_liabilities_and_equity = pasivo +
 * capital`. Sobre un mayor SANO de activo 100 000 con 6 000 de resultado sin
 * barrer publicaba 94 000.00 contra 100 000.00, y ningún campo con el que
 * notarlo. La CLI, sobre esos mismos datos, firmaba 100 000.00 — así que no era
 * un desacuerdo sobre el libro: era una superficie con su propia aritmética.
 *
 * Todo lo de aquí produce CIFRAS QUE SE FIRMAN, así que se mide contra Postgres
 * y no contra un mock. La prueba unitaria que había (tools.spec.ts) montaba un
 * juego de datos que CUADRA POR CONSTRUCCIÓN —sin una sola cuenta de
 * resultados— así que no podía ponerse roja ni con el defecto delante.
 */

let f: Fixture;
let ctx: AgentContext;

function herramienta(nombre: string) {
  const t = buildReportTools(ctx).find((x) => x.name === nombre);
  if (!t) throw new Error(`no existe la herramienta ${nombre}`);
  return t;
}

/**
 * El JSON que publica una herramienta, venga desnudo o dentro del sobre de
 * datos de terceros — las de terceros (CxC, CxP, mayor) lo envuelven entre
 * marcadores para que el modelo no confunda dato con instrucción.
 */
async function llamar(nombre: string, input: unknown): Promise<Record<string, unknown>> {
  const crudo = (await herramienta(nombre).run(input as never)) as string;
  const i = crudo.indexOf(UNTRUSTED_OPEN);
  const cuerpo =
    i < 0
      ? crudo
      : crudo.slice(i + UNTRUSTED_OPEN.length, crudo.indexOf(UNTRUSTED_CLOSE));
  return JSON.parse(cuerpo) as Record<string, unknown>;
}

/** Dos cuentas de gasto REALES del catálogo, por su tipo y no por su código. */
async function dosCuentasDeGasto(): Promise<[string, string]> {
  const r = await query<{ code: string }>(
    `SELECT code FROM accounts
      WHERE entity_id = $1 AND account_type = 'expense' AND allow_manual_entries = true
      ORDER BY code LIMIT 2`,
    [f.entityId]
  );
  if (r.rows.length < 2) throw new Error('el catálogo sembrado no tiene dos cuentas de gasto');
  return [r.rows[0].code, r.rows[1].code];
}

/**
 * Un asiento posteado y cuadrado, del importe y las cuentas que se pidan.
 *
 * La fecha se construye a MEDIANOCHE LOCAL, no en `Z`. No es un detalle de
 * estilo: `entry_date` es DATE y el driver la escribe con los componentes
 * locales del Date, así que `2026-03-01T00:00:00Z` se guarda como 2026-02-28 en
 * UTC−6 — el asiento cae en otro mes y en otro periodo fiscal. Medido aquí, y
 * es un defecto VIVO del camino de escritura (`new Date(entry_date)` en
 * src/api/rest/routes/journal-entries.ts:211) que va a su propia issue: no se
 * ve en CI porque allí el reloj es UTC.
 */
async function asiento(fecha: string, cargo: string, abono: string, monto: string, desc: string) {
  await createJournalEntry(
    f.entityId,
    new Date(`${fecha}T00:00:00`),
    JournalEntryType.STANDARD,
    desc,
    [
      { account_id: f.cuentas[cargo], debit_amount: monto, credit_amount: null, description: 'cargo' },
      { account_id: f.cuentas[abono], debit_amount: null, credit_amount: monto, description: 'abono' },
    ],
    f.userId,
    { autoPost: true }
  );
  await drainAttestations();
}

/** Todo número publicado, con su ruta, para poder afirmar sobre TODOS. */
function importesDe(o: unknown, ruta = ''): Array<[string, string]> {
  const salida: Array<[string, string]> = [];
  const mirar = (v: unknown, r: string) => {
    if (typeof v === 'string' && /^-?\d+\.\d+$/.test(v)) salida.push([r, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => mirar(x, `${r}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) mirar(x, r ? `${r}.${k}` : k);
    }
  };
  mirar(o, ruta);
  return salida;
}

beforeAll(async () => {
  f = await crearInquilino('T14 la balanza del agente');
  ctx = {
    entityId: f.entityId,
    entityName: 'T14',
    tenantId: f.tenantId,
    currency: 'MXN',
    country: 'MX',
    accountingStandard: 'mx_nif',
    taxId: 'AAA010101AAA',
  };

  // Activo 100 000 · pasivo 70 000 · capital 24 000 · resultado 6 000 sin barrer.
  await asiento('2026-02-01', '1110', '3100', '24000.0000', 'Capital');
  await asiento('2026-02-02', '1110', '2110', '70000.0000', 'Proveedores');
  await asiento('2026-02-03', '1110', '4100', '10000.0000', 'Venta');
  const [gastoA] = await dosCuentasDeGasto();
  await asiento('2026-02-04', gastoA, '1110', '4000.0000', 'Gasto');
}, 180_000);

describe('el balance del agente cuadra, y dice cuándo no', () => {
  it('publica el mismo total que firma la CLI, no el que le sale a él solo', async () => {
    const bs = await llamar('get_balance_sheet', { as_of_date: '2026-02-28' });
    // Antes: 94000.00 contra un activo de 100000.00.
    expect((bs.assets as Record<string, string>).total).toBe('100000.00');
    expect(bs.total_liabilities_and_equity).toBe('100000.00');
  });

  it('el resultado no barrido va DENTRO del capital, y se nombra', async () => {
    const bs = await llamar('get_balance_sheet', { as_of_date: '2026-02-28' });
    const capital = bs.equity as Record<string, unknown>;
    expect(capital.result_of_the_period).toBe('6000.00');
    // 24 000 de capital social + 6 000 de resultado.
    expect(capital.total).toBe('30000.00');
  });

  it('publica con qué notar un descuadre, que es lo que no tenía', async () => {
    const bs = await llamar('get_balance_sheet', { as_of_date: '2026-02-28' });
    expect(bs.out_of_balance).toBe('0.00');
    expect(bs.is_balanced).toBe(true);
  });

  it('y coincide con el informe que firman la CLI y el REST, no sólo consigo mismo', async () => {
    // La identidad es el punto del tramo: una balanza, un solo sitio.
    const bs = await llamar('get_balance_sheet', { as_of_date: '2026-02-28' });
    const servicio = await getBalanceSheet(f.entityId, { asOfDate: '2026-02-28' });
    expect(Number(bs.total_liabilities_and_equity)).toBe(Number(servicio.total_liabilities_and_equity));
    expect(bs.is_balanced).toBe(servicio.is_balanced);
  });

  it('conserva la categoría cruda que ya publicaba', async () => {
    const bs = await llamar('get_balance_sheet', { as_of_date: '2026-02-28' });
    const cuentas = (bs.assets as { accounts: Array<Record<string, string>> }).accounts;
    expect(cuentas.every((c) => /^[a-z_]+$/.test(c.category))).toBe(true);
  });
});

describe('el estado de resultados suma el libro, no sus propios redondeos', () => {
  it('el total es el redondeo de la suma, no la suma de los redondeos', async () => {
    // DOS IMPORTES QUE REDONDEAN HACIA ARRIBA, que es lo que discrimina las dos
    // aritméticas: con 0.0200 en cada cuenta las dos dan 0.04 y la prueba no
    // probaría nada — comprobado mutando el código, el mutante sobrevivía.
    // Con 0.0250 cada una: en crudo suman 0.05, y redondeadas una a una antes
    // de sumar dan 0.03 + 0.03 = 0.06, que es lo que publicaba.
    const [gastoA, gastoB] = await dosCuentasDeGasto();
    await asiento('2026-03-01', gastoA, '1110', '0.0250', 'medio centavo A');
    await asiento('2026-03-02', gastoB, '1110', '0.0250', 'medio centavo B');

    const is = await llamar('get_income_statement', { start_date: '2026-03-01', end_date: '2026-03-31' });
    expect((is.expenses as Record<string, string>).total).toBe('0.05');
    expect(is.net_income).toBe('-0.05');
  });

  it('y el centavo que las filas llevan de más se NOMBRA', async () => {
    // Las dos filas publicadas suman 0.06 y el total del libro es 0.05. La
    // diferencia no se reparte ni se esconde: se publica.
    const is = await llamar('get_income_statement', { start_date: '2026-03-01', end_date: '2026-03-31' });
    const filas = (is.expenses as { accounts: Array<Record<string, string>> }).accounts;
    const suma = filas.reduce((a, r) => a + Math.round(Number(r.amount) * 100), 0) / 100;
    const residuo = Number((is.rounding_residual as Record<string, string>)?.expenses ?? 0);
    expect(suma).toBe(0.06);
    expect(residuo).toBe(0.01);
    expect(Number(((suma - residuo)).toFixed(2))).toBe(Number((is.expenses as Record<string, string>).total));
  });
});

describe('ningún importe publicado inventa precisión', () => {
  const llamadas: Array<[string, unknown]> = [
    ['get_trial_balance', { as_of_date: '2026-03-31' }],
    ['get_balance_sheet', { as_of_date: '2026-03-31' }],
    ['get_income_statement', { start_date: '2026-01-01', end_date: '2026-12-31' }],
    ['get_general_ledger', { account_code: '1110' }],
  ];

  it('todo lo que sale lleva exactamente dos decimales', async () => {
    for (const [nombre, input] of llamadas) {
      const r = await llamar(nombre, input);
      const malos = importesDe(r).filter(([, v]) => (v.split('.')[1] ?? '').length !== 2);
      expect(malos, `${nombre} publica importes fuera de escala: ${JSON.stringify(malos)}`).toEqual([]);
    }
  });

  it('las fechas son el día que guarda la columna, no una marca de tiempo', async () => {
    const gl = await llamar('get_general_ledger', { account_code: '1110' });
    const movs = gl.movements as Array<Record<string, string>>;
    expect(movs.length).toBeGreaterThan(0);
    for (const m of movs) expect(m.entry_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // La primera es la del asiento de capital: si se leyera en UTC saldría el
    // día anterior en cualquier zona al este de Greenwich.
    expect(movs.map((m) => m.entry_date)).toContain('2026-02-01');
  });
});

describe('cuando las filas no suman el total, se dice', () => {
  it('el total es el del libro y el residuo se NOMBRA en vez de repartirse', async () => {
    const tb = (await llamar('get_trial_balance', { as_of_date: '2026-03-31', only_with_balance: true })) as {
      accounts: Array<Record<string, string>>;
      totals: Record<string, string>;
      rounding_residual?: Record<string, string | null>;
    };
    const sumaFilas = tb.accounts.reduce((s, a) => s + Math.round(Number(a.debit_total) * 100), 0) / 100;
    const total = Number(tb.totals.total_debits);
    const residuo = Number(tb.rounding_residual?.debit_total ?? 0);
    // La identidad que impide «arreglar» esto redondeando sólo el detalle.
    expect(Number((sumaFilas - residuo).toFixed(2))).toBe(total);
  });

  it('y se omite cuando es cero, que es lo normal', async () => {
    const bs = await llamar('get_balance_sheet', { as_of_date: '2026-02-28' });
    expect(bs.rounding_residual).toBeUndefined();
  });
});

describe('la base es la que dice la prueba', () => {
  it('el mayor tiene los cuatro asientos posteados', async () => {
    const r = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries WHERE entity_id = $1 AND status = 'posted'`,
      [f.entityId]
    );
    expect(Number(r.rows[0].n)).toBeGreaterThanOrEqual(4);
  });
});
