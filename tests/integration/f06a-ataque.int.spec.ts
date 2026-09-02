import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { resolvePolicy, seedPolicies } from '../../src/services/policy/policy-service.js';
import { crearActivo, sembrarCategoriasDeActivo } from '../../src/services/assets/asset-service.js';
import { runMonthlyDepreciation } from '../../src/services/assets/depreciation.js';
import { planDeDepreciacion } from '../../src/services/assets/depreciation-plan.js';
import { DepreciationMethod } from '../../src/types/index.js';

/**
 * ATAQUE ADVERSARIAL A F06a.
 *
 * F06a abre la puerta de un solo sentido: hasta hoy no existía un solo activo,
 * así que el motor nunca posteó nada y los defectos del cálculo no habían
 * dejado rastro en el mayor. En cuanto el alta exista habrá filas de producción
 * indexadas con lo que este tramo decida, y el mayor de la 041 no admite UPDATE
 * ni DELETE: lo que se postee mal se corrige por reversa, no editando.
 *
 * EL OBJETIVO DEL ATAQUE ES UNO: QUE LA DEPRECIACIÓN MIENTA. Que doce meses no
 * consuman doce filas, que la suma de la vida no dé costo menos salvamento, que
 * el asiento caiga en un mes que no es el corrido, o que el mismo mes se cargue
 * dos veces. Todo lo demás es secundario.
 */

let A: Fixture;
let B: Fixture;
let categoriaA: string;
let categoriaB: string;

/** El id de la categoría de cómputo de una entidad, ya sembrada. */
async function categoriaDe(entityId: string, nombre = 'Equipo de Cómputo'): Promise<string> {
  const r = await query<{ id: string }>(
    'SELECT id FROM asset_categories WHERE entity_id = $1 AND name = $2',
    [entityId, nombre]
  );
  return r.rows[0].id;
}

/** Alta mínima: lo demás lo pone la categoría. */
async function alta(
  f: Fixture,
  categoria: string,
  over: Record<string, unknown> = {}
): Promise<{ id: string; asset_number: string }> {
  enterTenant(f.tenantId);
  const r = await crearActivo(
    f.entityId,
    {
      asset_name: `Activo ${uuidv4().slice(0, 8)}`,
      category_id: categoria,
      acquisition_date: '2026-01-01',
      acquisition_cost: '100000.0000',
      contabilizacion: 'ya_contabilizado',
      useful_life_months: 36,
      ...over,
    } as never,
    f.userId
  );
  return { id: r.id, asset_number: r.asset_number };
}

/** Lo posteado al mayor por la depreciación de un activo. */
async function posteadoDe(assetId: string): Promise<
  Array<{ entry_date: string; fiscal_period_id: string; debit: string; entry_id: string }>
> {
  const r = await query<{
    entry_date: string;
    fiscal_period_id: string;
    debit: string;
    entry_id: string;
  }>(
    `SELECT to_char(je.entry_date, 'YYYY-MM-DD') AS entry_date,
            je.fiscal_period_id,
            je.total_debits::text AS debit,
            je.id AS entry_id
       FROM journal_entries je
      WHERE je.source_type = 'depreciation' AND je.source_id = $1
        AND je.status = 'posted'
      ORDER BY je.entry_date`,
    [assetId]
  );
  return r.rows;
}

async function renglonesDe(assetId: string): Promise<
  Array<{
    schedule_type: string;
    depreciation_expense: string;
    depreciation_date: string;
    indice: number;
    is_posted: boolean;
    journal_entry_id: string | null;
  }>
> {
  const r = await query<{
    schedule_type: string;
    depreciation_expense: string;
    depreciation_date: string;
    indice: number;
    is_posted: boolean;
    journal_entry_id: string | null;
  }>(
    `SELECT schedule_type, depreciation_expense::text AS depreciation_expense,
            to_char(depreciation_date, 'YYYY-MM-DD') AS depreciation_date,
            (calculation_metadata->>'indice_calendario')::int AS indice,
            is_posted, journal_entry_id
       FROM depreciation_schedules
      WHERE asset_id = $1
      ORDER BY depreciation_date`,
    [assetId]
  );
  return r.rows;
}

beforeAll(async () => {
  A = await crearInquilino('F06a ataque');
  B = await crearEntidadHermana(A, 'F06a hermana');
  await seedPolicies({ tenantId: A.tenantId, entityId: A.entityId });
  await seedPolicies({ tenantId: B.tenantId, entityId: B.entityId });
  await sembrarCategoriasDeActivo(A.entityId);
  await sembrarCategoriasDeActivo(B.entityId);
  categoriaA = await categoriaDe(A.entityId);
  categoriaB = await categoriaDe(B.entityId);
}, 120_000);

afterAll(async () => {
  await closeDatabase();
});

// ── 1 · EL CALENDARIO: DOCE MESES SON DOCE FILAS ────────────────────────
describe('el índice del calendario', () => {
  it('doce meses corridos consumen doce filas DISTINTAS y ninguna se repite', async () => {
    enterTenant(A.tenantId);
    const activo = await alta(A, categoriaA, {
      acquisition_cost: '120000.0000',
      useful_life_months: 12,
      useful_life_years: 1,
    });

    for (let mes = 1; mes <= 12; mes++) {
      const r = await runMonthlyDepreciation(A.entityId, A.periodos[mes], A.userId);
      expect(r.errors, `mes ${mes}`).toEqual([]);
      expect(r.processed, `mes ${mes}`).toBe(1);
    }

    const filas = await renglonesDe(activo.id);
    expect(filas).toHaveLength(12);
    // El defecto A hacía que marzo repitiera el índice de febrero y que desde
    // abril quedara atrasado: once índices para doce meses.
    expect(filas.map((f) => f.indice)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    // Y la vida entera suma EXACTAMENTE costo menos salvamento (defecto C).
    const suma = filas.reduce((a, f) => a.plus(f.depreciation_expense), new Decimal(0));
    expect(suma.toFixed(4)).toBe('120000.0000');

    // Lo posteado al mayor coincide peso por peso con el calendario.
    const asientos = await posteadoDe(activo.id);
    expect(asientos).toHaveLength(12);
    const posteado = asientos.reduce((a, e) => a.plus(e.debit), new Decimal(0));
    expect(posteado.toFixed(4)).toBe('120000.0000');
  });

  it('la vida de un activo que no divide exacto también cierra en el peso', async () => {
    enterTenant(A.tenantId);
    // 100000/7 no es exacto: 14285.7142857… El tapón del último mes tiene que
    // absorber la diferencia o el mayor queda con milésimas de nadie.
    const activo = await alta(A, categoriaA, {
      acquisition_cost: '100000.0000',
      useful_life_months: 7,
      useful_life_years: 1,
    });

    for (let mes = 1; mes <= 7; mes++) {
      await runMonthlyDepreciation(A.entityId, A.periodos[mes], A.userId);
    }

    const filas = await renglonesDe(activo.id);
    expect(filas).toHaveLength(7);
    const suma = filas.reduce((a, f) => a.plus(f.depreciation_expense), new Decimal(0));
    expect(suma.toFixed(4)).toBe('100000.0000');

    // Y el valor en libros del activo llega a cero exacto, no a 0.0002.
    const r = await query<{ v: string; a: string }>(
      'SELECT current_book_value::text AS v, accumulated_depreciation::text AS a FROM fixed_assets WHERE id = $1',
      [activo.id]
    );
    expect(new Decimal(r.rows[0].v).toFixed(4)).toBe('0.0000');
    expect(new Decimal(r.rows[0].a).toFixed(4)).toBe('100000.0000');
  });
});

// ── 2 · EL MES DEL ASIENTO ──────────────────────────────────────────────
describe('la fecha del asiento', () => {
  it('cae DENTRO del periodo corrido, en enero y en junio', async () => {
    enterTenant(A.tenantId);
    const activo = await alta(A, categoriaA, { acquisition_cost: '36000.0000' });

    // Enero y junio son donde la medianoche UTC se lleva el asiento al mes
    // anterior — y en enero, además, al EJERCICIO anterior.
    for (const mes of [1, 6]) {
      await runMonthlyDepreciation(A.entityId, A.periodos[mes], A.userId);
    }

    const asientos = await posteadoDe(activo.id);
    expect(asientos).toHaveLength(2);
    expect(asientos[0].entry_date).toBe('2026-01-31');
    expect(asientos[1].entry_date).toBe('2026-06-30');
    // Y el asiento cuelga del MISMO periodo fiscal que se corrió: el defecto B
    // no era una etiqueta torcida, era el asiento en otro periodo.
    expect(asientos[0].fiscal_period_id).toBe(A.periodos[1]);
    expect(asientos[1].fiscal_period_id).toBe(A.periodos[6]);

    const filas = await renglonesDe(activo.id);
    expect(filas.map((f) => f.depreciation_date)).toEqual(['2026-01-31', '2026-06-30']);
  });
});

// ── 3 · CORRER DOS VECES ────────────────────────────────────────────────
describe('la corrida repetida', () => {
  it('el mismo periodo dos veces no postea dos asientos', async () => {
    enterTenant(A.tenantId);
    const activo = await alta(A, categoriaA, { acquisition_cost: '48000.0000' });

    // `processed` cuenta TODOS los activos activos de la entidad, que este
    // archivo va acumulando; lo que se afirma es sobre ESTE activo.
    const uno = await runMonthlyDepreciation(A.entityId, A.periodos[3], A.userId);
    const dos = await runMonthlyDepreciation(A.entityId, A.periodos[3], A.userId);
    expect(uno.errors).toEqual([]);
    expect(dos.errors).toEqual([]);
    expect(dos.processed).toBe(0);

    expect(await posteadoDe(activo.id)).toHaveLength(1);
    expect(await renglonesDe(activo.id)).toHaveLength(1);
  });

  it('la UNIQUE de la 003 rechaza el renglón duplicado por SQL directo', async () => {
    enterTenant(A.tenantId);
    const activo = await alta(A, categoriaA, { acquisition_cost: '24000.0000' });
    await runMonthlyDepreciation(A.entityId, A.periodos[4], A.userId);

    const fila = (
      await query<{ id: string; journal_entry_id: string }>(
        'SELECT id, journal_entry_id FROM depreciation_schedules WHERE asset_id = $1',
        [activo.id]
      )
    ).rows[0];

    await expect(
      query(
        `INSERT INTO depreciation_schedules
           (asset_id, fiscal_period_id, depreciation_date, depreciation_expense,
            accumulated_depreciation, book_value, schedule_type, is_posted, journal_entry_id)
         VALUES ($1, $2, '2026-04-30', 1, 1, 1, 'book', true, $3)`,
        [activo.id, A.periodos[4], fila.journal_entry_id]
      )
    ).rejects.toThrow(/duplicate key|unique/i);
  });
});

// ── 4 · EL CHECK DE LA 056 ──────────────────────────────────────────────
describe('«posteada» sin el asiento que lo prueba', () => {
  it('el CHECK de la 056 rechaza is_posted con journal_entry_id nulo', async () => {
    enterTenant(A.tenantId);
    const activo = await alta(A, categoriaA, { acquisition_cost: '12000.0000' });

    await expect(
      query(
        `INSERT INTO depreciation_schedules
           (asset_id, fiscal_period_id, depreciation_date, depreciation_expense,
            accumulated_depreciation, book_value, schedule_type, is_posted, journal_entry_id)
         VALUES ($1, $2, '2026-05-31', 100, 100, 100, 'book', true, NULL)`,
        [activo.id, A.periodos[5]]
      )
    ).rejects.toThrow(/depreciacion_posteada_con_asiento/);
  });

  it('todo renglón escrito por el motor trae su asiento atado (defecto D)', async () => {
    enterTenant(A.tenantId);
    const activo = await alta(A, categoriaA, { acquisition_cost: '60000.0000' });
    await runMonthlyDepreciation(A.entityId, A.periodos[7], A.userId);

    const filas = await renglonesDe(activo.id);
    expect(filas).toHaveLength(1);
    expect(filas[0].is_posted).toBe(true);
    expect(filas[0].journal_entry_id).not.toBeNull();

    const meta = (
      await query<{ m: Record<string, unknown> }>(
        'SELECT calculation_metadata AS m FROM depreciation_schedules WHERE asset_id = $1',
        [activo.id]
      )
    ).rows[0].m;
    expect(meta).not.toBeNull();
    expect(meta.base).toBe('vida_util_nif');
    expect(meta.convencion).toBe('mes_completo');
  });
});

// ── 5 · LA FRONTERA DE ENTIDAD ──────────────────────────────────────────
describe('dos entidades del mismo inquilino', () => {
  it('A no puede dar de alta un activo con la categoría de B', async () => {
    enterTenant(A.tenantId);
    await expect(
      crearActivo(
        A.entityId,
        {
          asset_name: 'Fuga por categoría',
          category_id: categoriaB,
          acquisition_date: '2026-01-01',
          acquisition_cost: '1000.0000',
          contabilizacion: 'ya_contabilizado',
        } as never,
        A.userId
      )
    ).rejects.toThrow();
  });

  it('A no puede dar de alta un activo con las cuentas de B', async () => {
    enterTenant(A.tenantId);
    await expect(
      crearActivo(
        A.entityId,
        {
          asset_name: 'Fuga por cuenta',
          category_id: categoriaA,
          acquisition_date: '2026-01-01',
          acquisition_cost: '1000.0000',
          contabilizacion: 'ya_contabilizado',
          depreciation_expense_account_id: B.cuentas['6140'],
        } as never,
        A.userId
      )
    ).rejects.toThrow(/no están en el catálogo de esta entidad/);
  });

  it('A no puede correr la depreciación contra un periodo de B', async () => {
    enterTenant(A.tenantId);
    await expect(runMonthlyDepreciation(A.entityId, B.periodos[8], A.userId)).rejects.toThrow(
      /no cruza entidades/
    );
  });

  it('correr en A no toca un solo activo de B', async () => {
    enterTenant(A.tenantId);
    const deB = await alta(B, categoriaB, { acquisition_cost: '99000.0000' });

    await runMonthlyDepreciation(A.entityId, A.periodos[9], A.userId);

    expect(await renglonesDe(deB.id)).toHaveLength(0);
    expect(await posteadoDe(deB.id)).toHaveLength(0);
  });
});

// ── 6 · EL ALTA NO DUPLICA LA COMPRA ────────────────────────────────────
describe('el alta', () => {
  it('no postea un solo asiento', async () => {
    enterTenant(A.tenantId);
    const antes = (
      await query<{ n: string }>(
        'SELECT count(*)::text AS n FROM journal_entries WHERE entity_id = $1',
        [A.entityId]
      )
    ).rows[0].n;

    await alta(A, categoriaA, { acquisition_cost: '77000.0000' });
    await alta(A, categoriaA, {
      acquisition_cost: '77000.0000',
      contabilizacion: 'sin_contabilizar',
    });

    const despues = (
      await query<{ n: string }>(
        'SELECT count(*)::text AS n FROM journal_entries WHERE entity_id = $1',
        [A.entityId]
      )
    ).rows[0].n;
    expect(despues).toBe(antes);
  });
});

// ── 7 · LAS POLÍTICAS SE LEEN DE VERDAD ─────────────────────────────────
describe('el panel', () => {
  it('las dos convenciones dan el MISMO total de vida', async () => {
    const C = await crearEntidadHermana(A, 'F06a convención');
    await seedPolicies({ tenantId: C.tenantId, entityId: C.entityId });
    await sembrarCategoriasDeActivo(C.entityId);
    const catC = await categoriaDe(C.entityId);
    enterTenant(C.tenantId);

    await resolvePolicy(
      { tenantId: C.tenantId, entityId: C.entityId },
      'convencion_primer_mes',
      'proporcional_dias',
      C.userId
    );

    // Compra a mitad de mes: es donde la convención cambia el reparto.
    const activo = await alta(C, catC, {
      acquisition_date: '2026-01-20',
      acquisition_cost: '120000.0000',
      useful_life_months: 6,
      useful_life_years: 1,
    });

    const plan = await planDeDepreciacion(C.entityId, C.periodos[1]);
    expect(plan.convencion).toBe('proporcional_dias');
    const primero = plan.renglones.find((r) => r.asset_id === activo.id);
    expect(primero).toBeDefined();
    // 12 de 31 días de enero sobre 20000 mensuales = 7741.9355, no 20000.
    expect(new Decimal(primero!.depreciacion).lessThan(20000)).toBe(true);

    for (let mes = 1; mes <= 7; mes++) {
      await runMonthlyDepreciation(C.entityId, C.periodos[mes], C.userId);
    }
    const filas = await renglonesDe(activo.id);
    const suma = filas.reduce((a, f) => a.plus(f.depreciation_expense), new Decimal(0));
    // El total de la VIDA es idéntico al de `mes_completo`: la convención mueve
    // qué periodo carga cada peso, no cuántos pesos hay.
    expect(suma.toFixed(4)).toBe('120000.0000');
  });

  it('con `tasa_lisr` el importe mensual es distinto del contable', async () => {
    const D = await crearEntidadHermana(A, 'F06a base');
    await seedPolicies({ tenantId: D.tenantId, entityId: D.entityId });
    await sembrarCategoriasDeActivo(D.entityId);
    const catD = await categoriaDe(D.entityId);
    enterTenant(D.tenantId);

    // El mismo activo con los dos métodos declarados: contable acelerado
    // (NIF C-6 admite saldos decrecientes), fiscal en línea recta (LISR art. 31).
    const activo = await alta(D, catD, {
      acquisition_cost: '120000.0000',
      useful_life_months: 48,
      useful_life_years: 4,
      book_depreciation_method: DepreciationMethod.DECLINING_BALANCE_200,
      tax_depreciation_method: DepreciationMethod.STRAIGHT_LINE,
    });

    const contable = await planDeDepreciacion(D.entityId, D.periodos[1]);
    const importeContable = contable.renglones.find((r) => r.asset_id === activo.id)!.depreciacion;
    expect(contable.base).toBe('vida_util_nif');
    expect(contable.tipo_calendario).toBe('book');

    await resolvePolicy(
      { tenantId: D.tenantId, entityId: D.entityId },
      'base_depreciacion',
      'tasa_lisr',
      D.userId
    );
    const fiscal = await planDeDepreciacion(D.entityId, D.periodos[1]);
    const importeFiscal = fiscal.renglones.find((r) => r.asset_id === activo.id)!.depreciacion;
    expect(fiscal.base).toBe('tasa_lisr');
    expect(fiscal.tipo_calendario).toBe('tax');

    // Si salen iguales, la política no se está leyendo.
    expect(importeFiscal).not.toBe(importeContable);
  });
});

// ── 8 · LA FICHA DEL ACTIVO CONTRA EL MAYOR ─────────────────────────────
describe('la ficha del activo', () => {
  it('dice lo mismo que el mayor aunque los meses se corran fuera de orden', async () => {
    const F = await crearEntidadHermana(A, 'F06a desorden');
    await seedPolicies({ tenantId: F.tenantId, entityId: F.entityId });
    await sembrarCategoriasDeActivo(F.entityId);
    const catF = await categoriaDe(F.entityId);
    enterTenant(F.tenantId);

    const activo = await alta(F, catF, {
      acquisition_cost: '120000.0000',
      useful_life_months: 12,
      useful_life_years: 1,
    });

    // Nada obliga a correr los meses en orden: se onboardea a mitad de año, o
    // sencillamente se olvida enero. La ficha copiaba el renglón TEÓRICO del
    // calendario, así que el último UPDATE en ganar era el de febrero y la
    // acumulada se quedaba un mes por debajo del mayor, para siempre.
    for (const mes of [3, 1, 2]) {
      const r = await runMonthlyDepreciation(F.entityId, F.periodos[mes], F.userId);
      expect(r.errors, `mes ${mes}`).toEqual([]);

      const ficha = (
        await query<{ v: string; ac: string }>(
          `SELECT current_book_value::text AS v, accumulated_depreciation::text AS ac
             FROM fixed_assets WHERE id = $1`,
          [activo.id]
        )
      ).rows[0];
      const mayor = (
        await posteadoDe(activo.id)
      ).reduce((a, e) => a.plus(e.debit), new Decimal(0));

      // Peso por peso, en cada paso.
      expect(new Decimal(ficha.ac).toFixed(4)).toBe(mayor.toFixed(4));
      expect(new Decimal(ficha.v).toFixed(4)).toBe(
        new Decimal('120000.0000').minus(mayor).toFixed(4)
      );
    }

    // Y la fecha de la última depreciación no retrocede al correr un mes viejo.
    const ultima = (
      await query<{ d: string }>(
        `SELECT to_char(last_depreciation_date, 'YYYY-MM-DD') AS d FROM fixed_assets WHERE id = $1`,
        [activo.id]
      )
    ).rows[0].d;
    expect(ultima).toBe('2026-03-31');
  });
});

// ── 9 · EL PLAN, QUE ES LO QUE EL OPERADOR LEE ANTES DE DECIR QUE SÍ ─────
describe('el plan de la corrida', () => {
  it('resuelve las cuentas contra el catálogo y no revienta', async () => {
    const G = await crearEntidadHermana(A, 'F06a plan');
    await seedPolicies({ tenantId: G.tenantId, entityId: G.entityId });
    await sembrarCategoriasDeActivo(G.entityId);
    const catG = await categoriaDe(G.entityId);
    enterTenant(G.tenantId);
    const activo = await alta(G, catG, { acquisition_cost: '36000.0000' });

    // `depreciation run` y `depreciation post` entran los dos por aquí: una
    // columna mal nombrada en este SELECT deja la familia entera sin poder
    // correr, y ninguna prueba unitaria lo ve porque no toca Postgres.
    const plan = await planDeDepreciacion(G.entityId, G.periodos[2]);
    const renglon = plan.renglones.find((r) => r.asset_id === activo.id);
    expect(renglon).toBeDefined();
    expect(renglon!.cuenta_gasto).toBe('6140');
    expect(renglon!.cuenta_acumulada).toBe('1290');
    expect(plan.fecha_del_asiento).toBe('2026-02-28');
    expect(new Decimal(plan.total).greaterThan(0)).toBe(true);
  });
});

// ── 10 · EL LIBRO FISCAL NO PUEDE VOLVER A CARGAR EL MISMO GASTO ────────
describe('cambiar de base entre corridas', () => {
  it('no carga el gasto del mismo mes dos veces al mayor', async () => {
    const E = await crearEntidadHermana(A, 'F06a doble');
    await seedPolicies({ tenantId: E.tenantId, entityId: E.entityId });
    await sembrarCategoriasDeActivo(E.entityId);
    const catE = await categoriaDe(E.entityId);
    enterTenant(E.tenantId);

    const activo = await alta(E, catE, {
      acquisition_cost: '120000.0000',
      useful_life_months: 12,
      useful_life_years: 1,
    });

    // Se corre marzo con la base contable, que es el defecto declarado.
    const uno = await runMonthlyDepreciation(E.entityId, E.periodos[3], E.userId);
    expect(uno.processed).toBe(1);

    // El despacho contesta el panel y elige la base fiscal. Marzo YA ESTÁ
    // contabilizado: volver a correrlo no puede cargar el gasto otra vez.
    await resolvePolicy(
      { tenantId: E.tenantId, entityId: E.entityId },
      'base_depreciacion',
      'tasa_lisr',
      E.userId
    );
    await runMonthlyDepreciation(E.entityId, E.periodos[3], E.userId);

    // Y el plan —lo que `post` enseña antes de escribir— tiene que decir lo
    // mismo, o `run` prometería un renglón que la corrida ya no hace.
    const plan = await planDeDepreciacion(E.entityId, E.periodos[3]);
    expect(plan.renglones.find((r) => r.asset_id === activo.id)).toBeUndefined();
    expect(plan.omitidos.find((o) => o.asset_id === activo.id)?.motivo).toBe('ya_corrido');

    const asientos = await posteadoDe(activo.id);
    const cargado = asientos.reduce((a, e) => a.plus(e.debit), new Decimal(0));
    // Un solo mes de marzo en el mayor: 120000/12 = 10000.
    expect(cargado.toFixed(4)).toBe('10000.0000');
    expect(asientos).toHaveLength(1);
  });
});
