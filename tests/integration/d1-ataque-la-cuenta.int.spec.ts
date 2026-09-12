import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { runMonthlyProvisions } from '../../src/services/accruals/provisions-run.js';

/**
 * D1 · LOS CINCO CAMINOS DEL MOTOR DE PROVISIONES QUE NADIE MEDÍA.
 *
 * `d1-provisiones.int.spec.ts` demuestra que la corrida calcula, y
 * `d1-ataque-provisiones.int.spec.ts` que no calcula de más. Este archivo
 * cubre lo que quedaba fuera de los dos: cinco defensas que el motor DECLARA
 * por escrito en sus comentarios y que ninguna prueba ejercitaba. Las cinco se
 * encontraron rompiéndolas a mano —cambiando una línea del motor y viendo que
 * las dos suites seguían verdes—, y por eso están escritas: un comentario que
 * explica una defensa que nadie mide es una promesa, no una defensa.
 *
 *   1. `termination_date >= inicio_del_periodo`. Cambiarlo por `>` deja fuera
 *      al que se fue el DÍA 1 y le borra el día que sí trabajó. Es el defecto
 *      que el propio motor dice haber reparado pasando cadenas en vez de
 *      `Date`, y no había caso que lo sujetara.
 *   2. `hire_date <= fin_del_periodo`. Con `<`, el que entra el último día del
 *      mes no devenga nada.
 *   3. `country_code = 'MX'`. Sin él, una entidad con nómina mixta le inventa
 *      aguinaldo de la LFT a un trabajador de Texas. El motor lo argumenta en
 *      su cabecera; borrar la línea no ponía roja ninguna prueba.
 *   4. La base salarial INTEGRADA de punta a punta. Ni la suite unitaria ni la
 *      de integración llegaban a correrla: la unitaria pasa `sbc` O
 *      `salario_diario`, nunca los dos, y la de integración jamás captura un
 *      SBC. La precedencia «si el despacho tiene el SBC capturado, ÉSE manda»
 *      sólo se puede ver con los dos presentes, que es la forma que tiene la
 *      ficha de un trabajador de verdad.
 *   5. La convención `aniversario` contra el mayor. El panel la ofrece y once
 *      meses de cada doce hace que las vacaciones valgan cero — el camino por
 *      el que el asiento sale con DOS líneas en vez de cuatro, porque los
 *      CHECK de `journal_entry_lines` no admiten importes en cero.
 *
 * LA ARITMÉTICA VA ESCRITA A MANO, con la derivación encima de cada literal.
 * Recomponerla con las funciones del módulo que se prueba deja pasar la cuenta
 * equivocada — el defecto que G1a documentó en report-service.
 */
let BAJA1: Fixture;
let ALTAULT: Fixture;
let MIXTA: Fixture;
let INTEG: Fixture;
let ANIV: Fixture;

/**
 * Un trabajador con TODO lo que la ficha real puede traer: la baja, el país, el
 * sueldo anual y el SBC. Los dos últimos a la vez a propósito: es la forma
 * normal de una ficha capturada, y es la única en la que se puede ver cuál de
 * los dos manda.
 *
 * El CHECK de la 008 exige `rfc` al mexicano y `ssn_encrypted` al
 * estadounidense; sin los dos ramales no se puede sembrar una nómina mixta.
 */
async function alta(
  f: Fixture,
  d: {
    hire: string;
    term?: string | null;
    annual?: string | null;
    sbc?: string | null;
    pais?: string;
    numero: string;
    status?: string;
  }
): Promise<string> {
  const id = uuidv4();
  const pais = d.pais ?? 'MX';
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, termination_date, country_code, rfc, ssn_encrypted, sbc, annual_salary, salary_type, currency_code, status)
     VALUES ($1,$2,$3,$4,'Ataque','D1',$5,$6,$7,$11,$12,$8,$9,'salary','MXN',$10)`,
    [
      id,
      f.tenantId,
      f.entityId,
      d.numero,
      d.hire,
      d.term ?? null,
      pais,
      d.sbc ?? null,
      d.annual ?? null,
      d.status ?? 'active',
      pais === 'MX' ? 'XAXX010101000' : null,
      pais === 'US' ? 'cifrado' : null,
    ]
  );
  return id;
}

/**
 * Saldo POSTEADO de una cuenta en la convención acreedora: haber − debe, de
 * modo que una provisión abonada salga positiva. El juez de todo lo que este
 * archivo afirma es el mayor, no el objeto que devuelve la corrida: un motor
 * que devolviera el número correcto y posteara otro pasaría cualquier prueba
 * escrita sobre su propio resultado.
 */
async function saldoAcreedor(entityId: string, accountId: string): Promise<string> {
  const r = await query<{ saldo: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.credit_amount,0)-COALESCE(jel.debit_amount,0)),0)::text AS saldo
       FROM journal_entry_lines jel JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id=$2 AND je.entity_id=$1 AND je.status='posted'`,
    [entityId, accountId]
  );
  return new Decimal(r.rows[0].saldo).toFixed(4);
}

beforeAll(async () => {
  BAJA1 = await crearInquilino('ATAQUE baja dia 1');
  ALTAULT = await crearEntidadHermana(BAJA1, 'ATAQUE alta ultimo dia');
  MIXTA = await crearEntidadHermana(BAJA1, 'ATAQUE nomina mixta');
  INTEG = await crearEntidadHermana(BAJA1, 'ATAQUE base integrada');
  ANIV = await crearEntidadHermana(BAJA1, 'ATAQUE convencion aniversario');
  for (const f of [BAJA1, ALTAULT, MIXTA, INTEG, ANIV])
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
}, 300_000);
afterAll(async () => {
  await closeDatabase();
});

describe('ATAQUE · los bordes del filtro SQL', () => {
  it('la baja del DÍA 1 del periodo devenga ese día — no cero', async () => {
    enterTenant(BAJA1.tenantId);
    // Alta 2021-03-10 (veterana), baja el 1 de MARZO de 2026: trabajó UN día.
    // Su año de servicio 5 (2025-03-10 → 2026-03-09) → art. 76: 20 días.
    //   aguinaldo:  1000×15×60/365 − 1000×15×59/365 = 2465.7534 − 2424.6575 = 41.0959
    //   vacaciones: 1000×20×357/365 − 1000×20×356/365 = 19561.6438 − 19506.8493 = 54.7945
    //   prima:      1000×5×357/365 − 1000×5×356/365   =  4890.4110 −  4876.7123 = 13.6987
    await alta(BAJA1, {
      hire: '2021-03-10',
      term: '2026-03-01',
      annual: '365000.00',
      numero: 'B1',
      status: 'terminated',
    });
    const r = await runMonthlyProvisions(BAJA1.entityId, BAJA1.periodos[3], BAJA1.userId);
    expect(r.errors).toEqual([]);
    expect(r.processed).toBe(1);
    expect(r.aguinaldo).toBe('41.0959');
    expect(r.vacaciones).toBe('54.7945');
    expect(r.prima_vacacional).toBe('13.6987');
    expect(await saldoAcreedor(BAJA1.entityId, BAJA1.roles.provision_aguinaldo)).toBe('41.0959');
    const c = await query<{ days_accrued: number }>(
      `SELECT days_accrued FROM benefit_provision_schedules WHERE entity_id=$1 AND fiscal_period_id=$2`,
      [BAJA1.entityId, BAJA1.periodos[3]]
    );
    expect(c.rows[0].days_accrued).toBe(1);
  });

  it('el alta del ÚLTIMO día del periodo devenga ese día — no cero', async () => {
    enterTenant(ALTAULT.tenantId);
    // Alta 2026-03-31: un solo día, año de servicio 1 (12 días de vacaciones).
    //   aguinaldo:  500×15×1/365 = 20.5479
    //   vacaciones: 500×12×1/365 = 16.4384
    //   prima:      500× 3×1/365 =  4.1096
    await alta(ALTAULT, { hire: '2026-03-31', annual: '182500.00', numero: 'U1' });
    const r = await runMonthlyProvisions(ALTAULT.entityId, ALTAULT.periodos[3], ALTAULT.userId);
    expect(r.errors).toEqual([]);
    expect(r.processed).toBe(1);
    expect(r.aguinaldo).toBe('20.5479');
    expect(r.vacaciones).toBe('16.4384');
    expect(r.prima_vacacional).toBe('4.1096');
  });

  it('un trabajador de nómina EXTRANJERA en la misma entidad no devenga aguinaldo', async () => {
    enterTenant(MIXTA.tenantId);
    await alta(MIXTA, { hire: '2021-03-10', annual: '365000.00', numero: 'M-MX' });
    await alta(MIXTA, { hire: '2021-03-10', annual: '365000.00', numero: 'M-US', pais: 'US' });
    const r = await runMonthlyProvisions(MIXTA.entityId, MIXTA.periodos[3], MIXTA.userId);
    expect(r.errors).toEqual([]);
    // SÓLO el mexicano. El aguinaldo (LFT 87) no existe en Texas.
    expect(r.processed).toBe(1);
    const cedula = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM benefit_provision_schedules WHERE entity_id=$1`,
      [MIXTA.entityId]
    );
    expect(cedula.rows[0].n).toBe('1');
  });
});

describe('ATAQUE · la base salarial INTEGRADA de punta a punta', () => {
  it('con el panel en `integrado` y el SBC capturado, manda el SBC y no el reconstruido', async () => {
    enterTenant(INTEG.tenantId);
    await resolvePolicy(
      { tenantId: INTEG.tenantId, entityId: INTEG.entityId },
      'provision_base_salarial',
      'integrado',
      INTEG.userId,
      'ataque D1'
    );
    // Ana con annual_salary 365 000 (diario 1 000) Y sbc capturado en 1 200:
    // el 1 200 es el número que el IMSS conoce; reconstruirlo con el factor
    // daría 1 000 × 1.0575 = 1 057.5000 y son 142.50 diarios de diferencia.
    await alta(INTEG, { hire: '2021-03-10', annual: '365000.00', sbc: '1200.0000', numero: 'I-1' });
    const r = await runMonthlyProvisions(INTEG.entityId, INTEG.periodos[6], INTEG.userId);
    expect(r.errors).toEqual([]);
    expect(r.processed).toBe(1);
    const meta = await query<{ calculation_metadata: { tramos: Array<{ base_diaria: string }> } }>(
      `SELECT calculation_metadata FROM benefit_provision_schedules WHERE entity_id=$1`,
      [INTEG.entityId]
    );
    expect(meta.rows[0].calculation_metadata.tramos[0].base_diaria).toBe('1200.0000');
    // Junio de 2026, 30 días, año de servicio 6:
    //   aguinaldo: 1200×15×181/365 − 1200×15×151/365 = 8926.0274 − 7446.5753 = 1479.4521
    expect(r.aguinaldo).toBe('1479.4521');
  });
});

describe('ATAQUE · la convención `aniversario` contra el mayor', () => {
  it('once meses abonan sólo aguinaldo, y el mes del aniversario abona el año entero', async () => {
    enterTenant(ANIV.tenantId);
    await resolvePolicy(
      { tenantId: ANIV.tenantId, entityId: ANIV.entityId },
      'devengo_vacaciones',
      'aniversario',
      ANIV.userId,
      'ataque D1'
    );
    // Alta 2021-03-10, diario 1 000. Bajo `aniversario` el derecho del art. 76
    // nace el día en que el año de servicio queda cumplido — la VÍSPERA del
    // aniversario, el 9 de marzo de 2026— y no se reparte.
    await alta(ANIV, { hire: '2021-03-10', annual: '365000.00', numero: 'AN-1' });

    // ── FEBRERO: un mes sin aniversario. Vacaciones y prima en CERO, y el
    //    asiento no puede llevar líneas de importe cero (los CHECK de
    //    journal_entry_lines exigen importes estrictamente positivos).
    //    aguinaldo: 1000×15×59/365 − 1000×15×31/365 = 2424.6575 − 1273.9726 = 1150.6849
    const feb = await runMonthlyProvisions(ANIV.entityId, ANIV.periodos[2], ANIV.userId);
    expect(feb.errors).toEqual([]);
    expect(feb.aguinaldo).toBe('1150.6849');
    expect(feb.vacaciones).toBe('0.0000');
    expect(feb.prima_vacacional).toBe('0.0000');
    const lineasFeb = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entry_lines WHERE journal_entry_id = $1`,
      [feb.journalEntryId]
    );
    expect(lineasFeb.rows[0].n).toBe('2'); // un cargo y UN abono

    // ── MARZO: el año de servicio 5 se cumple el 9. Se reconoce ENTERO:
    //    vacaciones 1000×20 = 20 000.0000 y prima 1000×5 = 5 000.0000.
    //    El tramo del año 6 (del 10 al 31) aún no cumple: cero.
    //    aguinaldo: 1000×15×90/365 − 1000×15×59/365 = 3698.6301 − 2424.6575 = 1273.9726
    const mar = await runMonthlyProvisions(ANIV.entityId, ANIV.periodos[3], ANIV.userId);
    expect(mar.errors).toEqual([]);
    expect(mar.aguinaldo).toBe('1273.9726');
    expect(mar.vacaciones).toBe('20000.0000');
    expect(mar.prima_vacacional).toBe('5000.0000');
    const lineasMar = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entry_lines WHERE journal_entry_id = $1`,
      [mar.journalEntryId]
    );
    expect(lineasMar.rows[0].n).toBe('4');

    // EL SALDO ACUMULADO EN EL MAYOR, que es el juez.
    expect(await saldoAcreedor(ANIV.entityId, ANIV.roles.provision_aguinaldo)).toBe('2424.6575');
    expect(await saldoAcreedor(ANIV.entityId, ANIV.roles.provision_vacaciones)).toBe('20000.0000');
    expect(await saldoAcreedor(ANIV.entityId, ANIV.roles.provision_prima_vacacional)).toBe(
      '5000.0000'
    );
  });
});
