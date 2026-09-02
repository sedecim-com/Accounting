import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { createJournalEntry, reverseJournalEntry } from '../../src/services/accounting/posting.js';
import { JournalEntryType } from '../../src/types/index.js';
import {
  registrarPagoAnticipado,
  huecoDeAnticipados,
  respaldoDisponible,
  revisionDeAmortizacionAlCierre,
} from '../../src/services/accruals/prepaid-service.js';
import { runMonthlyAmortization } from '../../src/services/accruals/amortization-run.js';
import { calcularAmortizacion } from '../../src/services/accruals/amortization-math.js';
import { calculateFiniquito } from '../../src/services/payroll/mx/finiquito-calculator.js';
import { diasDeVacacionesPorAnio } from '../../src/services/payroll/mx/finiquito-math.js';

/**
 * ATAQUE ADVERSARIAL A D1a · «EL DEVENGO EXISTE».
 *
 * Aquí hay DOS clases de dinero y las dos se atacan con números calculados a
 * mano, no con rangos:
 *
 *   · EL GASTO DE DOCE MESES DE UNA EMPRESA. La 1160 llevaba años con el
 *     camino de escritura vivo y ninguno de lectura. Lo que este tramo abre es
 *     una puerta de un solo sentido: en cuanto haya calendarios posteados, un
 *     importe mal repartido deja de ser una edición y pasa a ser una migración
 *     de asientos que el mayor (041) no deja tocar.
 *
 *   · EL FINIQUITO DE UNA PERSONA. Tres defectos que HOY pagan mal: la tabla
 *     del art. 76 desde el año 11, el aguinaldo que ignora la fecha de alta, y
 *     la cuota diaria tomada del SBC —el salario ya integrado—. Los tres se
 *     comprueban CONTRA POSTGRES y contra el panel de políticas de verdad, no
 *     contra un mock: lo que se ataca no es la aritmética (eso ya lo cubre
 *     `tests/payroll/mx/finiquito-math.spec.ts`) sino el CABLEADO — que el
 *     empleado que se lee sea el de este inquilino, que la política que rige
 *     sea la de la entidad del empleado, y que el número que sale del extremo
 *     de la cadena sea el calculado a mano.
 *
 * NINGUNA prueba de este archivo comprueba que una función exista. Todas
 * intentan hacerla MENTIR.
 */

let A: Fixture; // deriva de la póliza a caballo entre dos ejercicios
let B: Fixture; // la reversa
let C: Fixture; // orden de corrida, tarjeta y carrera de adopción
let D: Fixture; // periodos cerrados
let Z: Fixture; // OTRO inquilino: la frontera del empleado

/** Los doce periodos de un ejercicio nuevo para una entidad ya creada. */
async function crearEjercicio(f: Fixture, anio: number): Promise<Record<number, string>> {
  const fiscalYearId = uuidv4();
  await query(
    `INSERT INTO fiscal_years (id, entity_id, year_number, start_date, end_date, is_calendar_year, status)
     VALUES ($1, $2, $3, $4, $5, true, 'open')`,
    [fiscalYearId, f.entityId, anio, `${anio}-01-01`, `${anio}-12-31`]
  );
  const periodos: Record<number, string> = {};
  for (let m = 1; m <= 12; m++) {
    const id = uuidv4();
    const fin = new Date(Date.UTC(anio, m, 0)).toISOString().slice(0, 10);
    await query(
      `INSERT INTO fiscal_periods (id, fiscal_year_id, entity_id, period_number, period_name,
        start_date, end_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')`,
      [id, fiscalYearId, f.entityId, m, `Periodo ${m}/${anio}`,
       `${anio}-${String(m).padStart(2, '0')}-01`, fin]
    );
    periodos[m] = id;
  }
  return periodos;
}

/** Carga la 1160 como lo hace el camino del CFDI: DR 1160 / CR banco, posteado. */
async function cargarAnticipado(f: Fixture, importe: string, fecha: string): Promise<string> {
  enterTenant(f.tenantId);
  const je = await createJournalEntry(
    f.entityId,
    new Date(`${fecha}T00:00:00`),
    JournalEntryType.STANDARD,
    'Pago anticipado',
    [
      { account_id: f.roles.gasto_anticipado, debit_amount: importe, credit_amount: null,
        description: 'Anticipo' },
      { account_id: f.roles.banco, debit_amount: null, credit_amount: importe,
        description: 'Pago' },
    ],
    f.userId,
    { autoPost: true }
  );
  return je.id;
}

/** Saldo POSTEADO de una cuenta en el mayor. El juez de todo este archivo. */
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

interface RenglonFila {
  period_index: number;
  amortization_amount: string;
  is_posted: boolean;
  journal_entry_id: string | null;
  fiscal_period_id: string;
  reversado: boolean;
}

async function renglonesDe(prepaidId: string): Promise<RenglonFila[]> {
  const r = await query<RenglonFila>(
    `SELECT s.period_index, s.amortization_amount::text AS amortization_amount,
            s.is_posted, s.journal_entry_id, s.fiscal_period_id,
            (je.reversed_by_entry_id IS NOT NULL) AS reversado
       FROM prepaid_amortization_schedules s
       LEFT JOIN journal_entries je ON je.id = s.journal_entry_id
      WHERE s.prepaid_expense_id = $1
      ORDER BY s.period_index ASC`,
    [prepaidId]
  );
  return r.rows;
}

async function fichaDe(prepaidId: string): Promise<{
  amortized: string;
  remaining: string;
  status: string;
}> {
  const r = await query<{ amortized: string; remaining: string; status: string }>(
    `SELECT amortized_to_date::text AS amortized, remaining_amount::text AS remaining, status
       FROM prepaid_expenses WHERE id = $1`,
    [prepaidId]
  );
  return r.rows[0];
}

/** Un empleado mexicano mínimo. `sbc` y `annual_salary` a voluntad del ataque. */
async function altaEmpleado(
  f: Fixture,
  datos: { hire: string; annual?: string | null; sbc?: string | null }
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, rfc, sbc, annual_salary, salary_type, currency_code, status)
     VALUES ($1, $2, $3, $4, 'Prueba', 'Finiquito', $5, 'MX', 'XAXX010101000', $6, $7,
       'salary', 'MXN', 'active')`,
    [id, f.tenantId, f.entityId, `E-${id.slice(0, 8)}`, datos.hire,
     datos.sbc ?? null, datos.annual ?? null]
  );
  return id;
}

beforeAll(async () => {
  A = await crearInquilino('D1a ataque');
  B = await crearEntidadHermana(A, 'D1a ataque · reversa');
  C = await crearEntidadHermana(A, 'D1a ataque · orden');
  D = await crearEntidadHermana(A, 'D1a ataque · cierre');
  Z = await crearInquilino('D1a ataque · otro inquilino');
  for (const f of [A, B, C, D, Z]) {
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  }
}, 300_000);

afterAll(async () => {
  await closeDatabase();
});

// ════════════════════════════════════════════════════════════════════════
// I · LA DERIVA: TRECE RENGLONES QUE TIENEN QUE SUMAR LA PÓLIZA EXACTA
// ════════════════════════════════════════════════════════════════════════
describe('la póliza del 20 de marzo, a caballo entre dos ejercicios', () => {
  let periodos2027: Record<number, string>;
  let anticipoId: string;

  it('el calendario da TRECE renglones y el último es el tapón, no una división más', () => {
    // 120.000 del 20-mar-2026 al 19-mar-2027, por días. La ventana son 365
    // días: 12 de marzo, once meses enteros (287 − 12 + 31 + 28 = …) y 19 de
    // marzo del año siguiente.
    const cal = calcularAmortizacion({
      importe: '120000.0000',
      inicio: new Date(2026, 2, 20),
      fin: new Date(2027, 2, 19),
      convencion: 'proporcional_dias',
    });
    expect(cal).toHaveLength(13);
    expect(cal.reduce((s, f) => s + f.days_covered, 0)).toBe(365);

    // A MANO. 120.000 × 12/365 = 3.945,205479… → 3.945,2055
    expect(cal[0].amortization_amount).toBe('3945.2055');
    // 120.000 × 30/365 = 9.863,013698… → 9.863,0137
    expect(cal[1].amortization_amount).toBe('9863.0137');
    // 120.000 × 31/365 = 10.191,780821… → 10.191,7808
    expect(cal[2].amortization_amount).toBe('10191.7808');
    // 120.000 × 28/365 = 9.205,479452… → 9.205,4795
    expect(cal[11].amortization_amount).toBe('9205.4795');

    // EL ÚLTIMO RENGLÓN NO ES 120.000 × 19/365 = 6.246,5753. Es la RESTA
    // contra el importe: 120.000 − 113.753,4246 = 6.246,5754. La diezmilésima
    // de deriva cae ahí, una sola vez, y por eso la suma es exacta.
    expect(cal[12].amortization_amount).toBe('6246.5754');
    expect(cal[12].amortization_amount).not.toBe('6246.5753');

    const suma = cal.reduce((s, f) => s.plus(f.amortization_amount), new Decimal(0));
    expect(suma.toFixed(4)).toBe('120000.0000');
    expect(cal[12].remaining_balance).toBe('0.0000');
  });

  it('trece corridas reales dejan la 1160 en CERO, sin un centavo de deriva', async () => {
    enterTenant(A.tenantId);
    periodos2027 = await crearEjercicio(A, 2027);
    const asiento = await cargarAnticipado(A, '120000.0000', '2026-03-20');

    const { anticipo, calendario } = await registrarPagoAnticipado({
      entityId: A.entityId,
      descripcion: 'Póliza anual a caballo',
      importe: '120000.0000',
      inicio: '2026-03-20',
      fin: '2027-03-19',
      origen: 'cfdi',
      sourceJournalEntryId: asiento,
      createdBy: A.userId,
    });
    anticipoId = anticipo.id;
    expect(calendario).toHaveLength(13);

    for (let m = 3; m <= 12; m++) {
      const r = await runMonthlyAmortization(A.entityId, A.periodos[m], A.userId);
      expect(r.errors).toEqual([]);
      expect(r.processed).toBe(1);
    }
    for (let m = 1; m <= 3; m++) {
      const r = await runMonthlyAmortization(A.entityId, periodos2027[m], A.userId);
      expect(r.errors).toEqual([]);
      expect(r.processed).toBe(1);
    }

    // EL MAYOR ES EL JUEZ.
    expect(await saldoDe(A.entityId, A.roles.gasto_anticipado)).toBe('0.0000');
    expect(await saldoDe(A.entityId, A.roles.gasto)).toBe('120000.0000');

    const renglones = await renglonesDe(anticipoId);
    expect(renglones).toHaveLength(13);
    expect(renglones[0].amortization_amount).toBe('3945.2055');
    // EL ÚLTIMO RENGLÓN, comprobado en la base y no sólo en memoria.
    expect(renglones[12].amortization_amount).toBe('6246.5754');
    expect(renglones.map((r) => r.period_index)).toEqual([...Array(13).keys()]);

    const ficha = await fichaDe(anticipoId);
    expect(new Decimal(ficha.amortized).toFixed(4)).toBe('120000.0000');
    expect(new Decimal(ficha.remaining).toFixed(4)).toBe('0.0000');
    expect(ficha.status).toBe('fully_amortized');
  }, 300_000);

  it('la corrida número catorce no encuentra nada que devengar', async () => {
    enterTenant(A.tenantId);
    const r = await runMonthlyAmortization(A.entityId, periodos2027[4], A.userId);
    expect(r.processed).toBe(0);
    expect(r.errors).toEqual([]);
    expect(await saldoDe(A.entityId, A.roles.gasto)).toBe('120000.0000');
  }, 120_000);
});

// ════════════════════════════════════════════════════════════════════════
// II · LA REVERSA: EL ASIENTO SE DESHACE, ¿Y EL RENGLÓN?
// ════════════════════════════════════════════════════════════════════════
describe('reversar el asiento de una amortización', () => {
  let anticipoId: string;
  let asientoDevengo: string;

  beforeAll(async () => {
    enterTenant(B.tenantId);
    const asiento = await cargarAnticipado(B, '9000.0000', '2026-01-05');
    const { anticipo } = await registrarPagoAnticipado({
      entityId: B.entityId,
      descripcion: 'Renta trimestral',
      importe: '9000.0000',
      inicio: '2026-01-01',
      fin: '2026-03-31',
      origen: 'cfdi',
      sourceJournalEntryId: asiento,
      createdBy: B.userId,
    });
    anticipoId = anticipo.id;

    // Enero: 9.000 × 31/90 = 3.100,0000 exactos.
    const r = await runMonthlyAmortization(B.entityId, B.periodos[1], B.userId);
    expect(r.processed).toBe(1);
    expect(r.total).toBe('3100.0000');
    const renglones = await renglonesDe(anticipoId);
    asientoDevengo = renglones[0].journal_entry_id!;
  }, 180_000);

  it('la reversa devuelve el mayor a su sitio: el gasto de enero desaparece', async () => {
    enterTenant(B.tenantId);
    expect(await saldoDe(B.entityId, B.roles.gasto)).toBe('3100.0000');
    expect(await saldoDe(B.entityId, B.roles.gasto_anticipado)).toBe('5900.0000');

    // La reversa cae en el MISMO periodo: enero queda neto a cero, que es el
    // escenario limpio. Si la fecha fuera la de hoy, el ataque probaría además
    // el arrastre entre periodos y no se sabría cuál de los dos falló.
    await reverseJournalEntry(asientoDevengo, B.userId, {
      reason: 'devengo mal fechado',
      reversalDate: new Date(2026, 0, 31),
    });

    expect(await saldoDe(B.entityId, B.roles.gasto)).toBe('0.0000');
    expect(await saldoDe(B.entityId, B.roles.gasto_anticipado)).toBe('9000.0000');
  }, 120_000);

  it('el renglón NO queda posteado sin asiento: el CHECK de la 059 aguanta', async () => {
    const renglones = await renglonesDe(anticipoId);
    expect(renglones).toHaveLength(1);
    expect(renglones[0].is_posted).toBe(true);
    expect(renglones[0].journal_entry_id).not.toBeNull();
    // Pero el asiento al que apunta está anulado por su espejo.
    expect(renglones[0].reversado).toBe(true);
  });

  it('los instrumentos que guardan dinero dicen la verdad EN EL ACTO', async () => {
    enterTenant(B.tenantId);
    // Estas tres lecturas son las que autorizan gasto o dejan adoptar saldo, y
    // por eso no pueden esperar a la próxima corrida: se calculan en vivo.
    const r = await respaldoDisponible(B.entityId, B.roles.gasto_anticipado);
    expect(new Decimal(r.saldoPosteado).toFixed(4)).toBe('9000.0000');
    // 9.000 en el mayor y 9.000 por devengar: no queda NADA libre. Si
    // `disponible` sale 3.100, el sistema deja adoptar dos veces el mismo
    // cargo y la corrida acaba dejando la 1160 en negativo.
    expect(new Decimal(r.yaAdoptado).toFixed(4)).toBe('9000.0000');
    expect(new Decimal(r.disponible).toFixed(4)).toBe('0.0000');

    const hueco = await huecoDeAnticipados(B.entityId);
    expect(new Decimal(hueco.hueco).toFixed(4)).toBe('0.0000');
    expect(hueco.hayHueco).toBe(false);

    // Y la casilla del cierre vuelve a ver enero en rojo: el gasto de enero no
    // está en el resultado y la 1160 lo sigue mostrando como activo. Que exista
    // un renglón apuntando a un asiento ANULADO no es haber corrido el mes.
    const revision = await revisionDeAmortizacionAlCierre(B.entityId, B.periodos[1]);
    expect(revision.pendientes.map((p) => p.id)).toContain(anticipoId);
    expect(
      new Decimal(revision.pendientes.find((p) => p.id === anticipoId)!.remaining_amount).toFixed(4)
    ).toBe('9000.0000');
  });

  it('enero se puede volver a correr, y el gasto vuelve al resultado', async () => {
    enterTenant(B.tenantId);
    const r = await runMonthlyAmortization(B.entityId, B.periodos[1], B.userId);
    expect(r.errors).toEqual([]);
    expect(r.processed).toBe(1);
    expect(r.total).toBe('3100.0000');

    expect(await saldoDe(B.entityId, B.roles.gasto)).toBe('3100.0000');
    expect(await saldoDe(B.entityId, B.roles.gasto_anticipado)).toBe('5900.0000');

    const ficha = await fichaDe(anticipoId);
    expect(new Decimal(ficha.amortized).toFixed(4)).toBe('3100.0000');
    // Y el renglón anulado no se quedó de recuerdo bloqueando la UNIQUE.
    const renglones = await renglonesDe(anticipoId);
    expect(renglones).toHaveLength(1);
    expect(renglones[0].reversado).toBe(false);
  }, 120_000);

  it('y una vez repuesto, el freno de doble corrida vuelve a morder', async () => {
    enterTenant(B.tenantId);
    const r = await runMonthlyAmortization(B.entityId, B.periodos[1], B.userId);
    expect(r.processed).toBe(0);
    expect(await saldoDe(B.entityId, B.roles.gasto)).toBe('3100.0000');
  }, 120_000);

  it('LA TARJETA SALE DE LO VIGENTE: un mes reversado no la infla', async () => {
    enterTenant(B.tenantId);
    // Febrero: 9.000 × 28/90 = 2.800,0000
    await runMonthlyAmortization(B.entityId, B.periodos[2], B.userId);
    expect(new Decimal((await fichaDe(anticipoId)).amortized).toFixed(4)).toBe('5900.0000');

    const febrero = (await renglonesDe(anticipoId)).find((r) => r.period_index === 1)!;
    await reverseJournalEntry(febrero.journal_entry_id!, B.userId, {
      reason: 'febrero mal devengado',
      reversalDate: new Date(2026, 1, 28),
    });

    // Marzo se corre SIN reponer febrero: el tapón del calendario dice 3.100.
    const marzo = await runMonthlyAmortization(B.entityId, B.periodos[3], B.userId);
    expect(marzo.total).toBe('3100.0000');

    // La ficha tiene que decir enero + marzo, NO enero + febrero + marzo. Si
    // sumara `is_posted` a secas diría 9.000 y cerraría el anticipo con el
    // mayor debiéndole 2.800 de gasto.
    const ficha = await fichaDe(anticipoId);
    expect(new Decimal(ficha.amortized).toFixed(4)).toBe('6200.0000');
    expect(new Decimal(ficha.remaining).toFixed(4)).toBe('2800.0000');
    expect(ficha.status).toBe('active');
    expect(await saldoDe(B.entityId, B.roles.gasto)).toBe('6200.0000');
    expect(await saldoDe(B.entityId, B.roles.gasto_anticipado)).toBe('2800.0000');

    // Y febrero sigue en rojo en la casilla del cierre hasta que se reponga.
    const revision = await revisionDeAmortizacionAlCierre(B.entityId, B.periodos[2]);
    expect(revision.pendientes.map((p) => p.id)).toContain(anticipoId);
  }, 240_000);

  it('reponer el mes que faltaba cierra el anticipo y vacía la 1160', async () => {
    enterTenant(B.tenantId);
    const r = await runMonthlyAmortization(B.entityId, B.periodos[2], B.userId);
    expect(r.total).toBe('2800.0000');
    const ficha = await fichaDe(anticipoId);
    expect(new Decimal(ficha.amortized).toFixed(4)).toBe('9000.0000');
    expect(ficha.status).toBe('fully_amortized');
    expect(await saldoDe(B.entityId, B.roles.gasto_anticipado)).toBe('0.0000');
    expect(await saldoDe(B.entityId, B.roles.gasto)).toBe('9000.0000');
  }, 120_000);

  it('reversar el ÚLTIMO mes de un anticipo YA CERRADO lo devuelve a la corrida', async () => {
    enterTenant(B.tenantId);
    const marzo = (await renglonesDe(anticipoId)).find((r) => r.period_index === 2)!;
    await reverseJournalEntry(marzo.journal_entry_id!, B.userId, {
      reason: 'marzo mal devengado',
      reversalDate: new Date(2026, 2, 31),
    });

    // El anticipo está en 'fully_amortized'. Si la corrida se gobierna por esa
    // etiqueta y no por el mayor, marzo no vuelve JAMÁS: 3.100 de gasto que se
    // quedan en el balance para siempre, que es literalmente la promesa que
    // este tramo vino a cerrar.
    const revision = await revisionDeAmortizacionAlCierre(B.entityId, B.periodos[3]);
    expect(revision.pendientes.map((p) => p.id)).toContain(anticipoId);

    const r = await runMonthlyAmortization(B.entityId, B.periodos[3], B.userId);
    expect(r.errors).toEqual([]);
    expect(r.processed).toBe(1);
    expect(r.total).toBe('3100.0000');
    expect(await saldoDe(B.entityId, B.roles.gasto_anticipado)).toBe('0.0000');
    expect(await saldoDe(B.entityId, B.roles.gasto)).toBe('9000.0000');
    expect((await fichaDe(anticipoId)).status).toBe('fully_amortized');
  }, 240_000);
});

// ════════════════════════════════════════════════════════════════════════
// III · EL ORDEN DE LAS CORRIDAS Y LA TARJETA
// ════════════════════════════════════════════════════════════════════════
describe('correr los meses fuera de orden', () => {
  let anticipoId: string;

  it('la tarjeta sale de la SUMA POSTEADA, no del renglón teórico del mes', async () => {
    enterTenant(C.tenantId);
    const asiento = await cargarAnticipado(C, '9000.0000', '2026-01-05');
    const { anticipo } = await registrarPagoAnticipado({
      entityId: C.entityId,
      descripcion: 'Seguro trimestral',
      importe: '9000.0000',
      inicio: '2026-01-01',
      fin: '2026-03-31',
      origen: 'cfdi',
      sourceJournalEntryId: asiento,
      createdBy: C.userId,
    });
    anticipoId = anticipo.id;

    // Marzo, enero, febrero: el orden en que un despacho descubre que se le
    // olvidó un mes. Si la ficha copiara el acumulado del renglón, el último
    // UPDATE en ganar sería el que mandara.
    await runMonthlyAmortization(C.entityId, C.periodos[3], C.userId);
    let ficha = await fichaDe(anticipoId);
    expect(new Decimal(ficha.amortized).toFixed(4)).toBe('3100.0000'); // marzo, 31/90

    await runMonthlyAmortization(C.entityId, C.periodos[1], C.userId);
    ficha = await fichaDe(anticipoId);
    expect(new Decimal(ficha.amortized).toFixed(4)).toBe('6200.0000'); // + enero

    await runMonthlyAmortization(C.entityId, C.periodos[2], C.userId);
    ficha = await fichaDe(anticipoId);
    // Febrero es el ÚLTIMO renglón del calendario (el tapón) sólo por índice;
    // corrido en tercer lugar sigue valiendo 9.000 − 3.100 − 3.100 = 2.800.
    expect(new Decimal(ficha.amortized).toFixed(4)).toBe('9000.0000');
    expect(ficha.status).toBe('fully_amortized');

    expect(await saldoDe(C.entityId, C.roles.gasto_anticipado)).toBe('0.0000');
    expect(await saldoDe(C.entityId, C.roles.gasto)).toBe('9000.0000');

    // Y la ficha coincide con la suma de renglones posteados, que a su vez
    // coincide con el mayor. Los tres números o son el mismo o hay un
    // instrumento mintiendo.
    const suma = (await renglonesDe(anticipoId)).reduce(
      (s, r) => s.plus(r.amortization_amount),
      new Decimal(0)
    );
    expect(suma.toFixed(4)).toBe('9000.0000');
  }, 240_000);

  it('cambiar la convención del panel a mitad de vida NO recorta un calendario vivo', async () => {
    enterTenant(C.tenantId);
    const asiento = await cargarAnticipado(C, '12000.0000', '2026-04-02');
    const { anticipo } = await registrarPagoAnticipado({
      entityId: C.entityId,
      descripcion: 'Licencia semestral',
      importe: '12000.0000',
      inicio: '2026-04-01',
      fin: '2026-09-30',
      origen: 'cfdi',
      sourceJournalEntryId: asiento,
      createdBy: C.userId,
    });

    // Abril: 12.000 × 30/183 = 1.967,2131…
    const abril = await runMonthlyAmortization(C.entityId, C.periodos[4], C.userId);
    expect(abril.total).toBe('1967.2131');

    await resolvePolicy(
      { tenantId: C.tenantId, entityId: C.entityId },
      'amortizacion_anticipados_convencion',
      'meses_completos',
      C.userId
    );

    // Mayo sigue por DÍAS: 12.000 × 31/183 = 2.032,7869. Con meses completos
    // serían 2.000 clavados, y el total dejaría de cuadrar contra el cargo.
    const mayo = await runMonthlyAmortization(C.entityId, C.periodos[5], C.userId);
    expect(mayo.total).toBe('2032.7869');

    // Pero el renglón deja escrito que el panel dice hoy otra cosa.
    const meta = await query<{ m: { politicas: Record<string, { coincide: boolean; valor_del_panel: string }> } }>(
      `SELECT calculation_metadata AS m FROM prepaid_amortization_schedules
        WHERE prepaid_expense_id = $1 AND period_index = 1`,
      [anticipo.id]
    );
    const p = meta.rows[0].m.politicas.amortizacion_anticipados_convencion;
    expect(p.coincide).toBe(false);
    expect(p.valor_del_panel).toBe('meses_completos');

    // Y volver a correr mayo bajo la convención nueva NO carga el gasto otra
    // vez: es el ataque que en la depreciación (F06a) sí duplicaba, porque su
    // UNIQUE llevaba `schedule_type` dentro.
    const antes = await saldoDe(C.entityId, C.roles.gasto);
    const repetida = await runMonthlyAmortization(C.entityId, C.periodos[5], C.userId);
    expect(repetida.processed).toBe(0);
    expect(await saldoDe(C.entityId, C.roles.gasto)).toBe(antes);
  }, 240_000);

  it('con `meses_completos` la cola parcial no devenga, y el mes de más no se cuela', async () => {
    enterTenant(C.tenantId);
    // El panel de C ya dice `meses_completos` desde la prueba anterior, así que
    // el anticipo nace con esa convención congelada. Esta rama del calendario
    // no tenía NI UNA prueba contra Postgres: el reparto está comprobado en
    // memoria, pero lo que aquí puede romperse es el ÍNDICE — la corrida
    // resuelve el renglón por meses de calendario y el arreglo tiene un mes
    // MENOS que la ventana.
    const asiento = await cargarAnticipado(C, '12000.0000', '2026-03-20');
    const { anticipo, calendario } = await registrarPagoAnticipado({
      entityId: C.entityId,
      descripcion: 'Póliza por meses completos',
      importe: '12000.0000',
      inicio: '2026-03-20',
      fin: '2026-09-19',
      origen: 'cfdi',
      sourceJournalEntryId: asiento,
      createdBy: C.userId,
    });
    expect(anticipo.amortization_convention).toBe('meses_completos');
    // Siete meses toca la ventana; el de septiembre es parcial y se descarta,
    // así que son SEIS renglones de 12.000 / 6 = 2.000 clavados.
    expect(calendario).toHaveLength(6);
    expect(calendario.map((f) => f.amortization_amount)).toEqual(
      ['2000.0000', '2000.0000', '2000.0000', '2000.0000', '2000.0000', '2000.0000']
    );

    for (let m = 3; m <= 9; m++) {
      // Septiembre incluido: en la VENTANA existe, pero en el calendario no
      // —la cola parcial se descartó—, así que el índice cae fuera del
      // arreglo. Si en vez de saltarlo repitiera el último renglón, cargaría
      // 2.000 de más y dejaría la 1160 en −2.000.
      const r = await runMonthlyAmortization(C.entityId, C.periodos[m], C.userId);
      expect(r.errors).toEqual([]);
    }

    // El juicio es sobre ESTE anticipo: la entidad tiene otro corriendo en
    // paralelo por días, y el saldo de la cuenta mezcla los dos.
    const renglones = await renglonesDe(anticipo.id);
    expect(renglones).toHaveLength(6);
    expect(renglones.map((r) => r.period_index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(
      renglones.reduce((s, r) => s.plus(r.amortization_amount), new Decimal(0)).toFixed(4)
    ).toBe('12000.0000');

    const ficha = await fichaDe(anticipo.id);
    expect(new Decimal(ficha.amortized).toFixed(4)).toBe('12000.0000');
    expect(new Decimal(ficha.remaining).toFixed(4)).toBe('0.0000');
    expect(ficha.status).toBe('fully_amortized');
  }, 300_000);
});

// ════════════════════════════════════════════════════════════════════════
// IV · EL PERIODO CERRADO, Y LA CARRERA POR EL MISMO SALDO
// ════════════════════════════════════════════════════════════════════════
describe('el periodo que ya está cerrado', () => {
  let anticipoId: string;

  beforeAll(async () => {
    enterTenant(D.tenantId);
    const asiento = await cargarAnticipado(D, '9000.0000', '2026-01-05');
    const { anticipo } = await registrarPagoAnticipado({
      entityId: D.entityId,
      descripcion: 'Suscripción trimestral',
      importe: '9000.0000',
      inicio: '2026-01-01',
      fin: '2026-03-31',
      origen: 'cfdi',
      sourceJournalEntryId: asiento,
      createdBy: D.userId,
    });
    anticipoId = anticipo.id;
  }, 180_000);

  it('con el periodo en hard_close no postea NADA — ni asiento ni renglón', async () => {
    enterTenant(D.tenantId);
    await query(`UPDATE fiscal_periods SET status = 'hard_close' WHERE id = $1`, [D.periodos[1]]);

    const r = await runMonthlyAmortization(D.entityId, D.periodos[1], D.userId);
    expect(r.processed).toBe(0);
    expect(r.errors).toHaveLength(1);
    // El motivo tiene que estar en el informe de la corrida, no en un log.
    expect(r.errors[0]).toMatch(/Suscripción trimestral/);

    // Y la transacción entera se deshizo: ni medio renglón huérfano.
    expect(await renglonesDe(anticipoId)).toHaveLength(0);
    expect(await saldoDe(D.entityId, D.roles.gasto)).toBe('0.0000');
    expect(await saldoDe(D.entityId, D.roles.gasto_anticipado)).toBe('9000.0000');
    const ficha = await fichaDe(anticipoId);
    expect(new Decimal(ficha.amortized).toFixed(4)).toBe('0.0000');
  }, 120_000);

  it('con el periodo en locked tampoco, y por el mismo camino', async () => {
    enterTenant(D.tenantId);
    await query(`UPDATE fiscal_periods SET status = 'locked' WHERE id = $1`, [D.periodos[1]]);
    const r = await runMonthlyAmortization(D.entityId, D.periodos[1], D.userId);
    expect(r.processed).toBe(0);
    expect(r.errors).toHaveLength(1);
    expect(await renglonesDe(anticipoId)).toHaveLength(0);
  }, 120_000);

  it('reabierto el periodo, el mes se devenga como si nada hubiera pasado', async () => {
    enterTenant(D.tenantId);
    await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [D.periodos[1]]);
    const r = await runMonthlyAmortization(D.entityId, D.periodos[1], D.userId);
    expect(r.errors).toEqual([]);
    expect(r.total).toBe('3100.0000');
    expect(await saldoDe(D.entityId, D.roles.gasto)).toBe('3100.0000');
  }, 120_000);

  it('en soft_close SÍ devenga: un ajuste de cierre es justo lo que un cierre blando admite', async () => {
    enterTenant(D.tenantId);
    await query(`UPDATE fiscal_periods SET status = 'soft_close' WHERE id = $1`, [D.periodos[2]]);
    // Es deliberado y conviene dejarlo clavado: el posteo sólo rechaza
    // 'hard_close' y 'locked' (posting.ts) y la propia casilla del cierre lo
    // dice por escrito (period-close.ts:143). Un devengo de fin de mes ES un
    // asiento de ajuste; si el cierre blando lo rechazara, no se podría cerrar
    // nunca un mes cuyo devengo se descubre al revisar la casilla.
    const r = await runMonthlyAmortization(D.entityId, D.periodos[2], D.userId);
    expect(r.errors).toEqual([]);
    expect(r.total).toBe('2800.0000');
    await query(`UPDATE fiscal_periods SET status = 'open' WHERE id = $1`, [D.periodos[2]]);
  }, 120_000);
});

describe('dos altas simultáneas sobre el MISMO cargo a la 1160', () => {
  it('no pueden adoptar las dos: el activo acabaría con saldo acreedor', async () => {
    enterTenant(D.tenantId);
    const asiento = await cargarAnticipado(D, '24000.0000', '2026-06-02');
    const antes = await respaldoDisponible(D.entityId, D.roles.gasto_anticipado);
    expect(new Decimal(antes.disponible).toFixed(4)).toBe('24000.0000');

    const alta = (n: number) =>
      registrarPagoAnticipado({
        entityId: D.entityId,
        descripcion: `Póliza en carrera ${n}`,
        importe: '24000.0000',
        inicio: '2026-06-01',
        fin: '2026-11-30',
        origen: 'cfdi',
        sourceJournalEntryId: asiento,
        createdBy: D.userId,
      });

    const resultados = await Promise.allSettled([alta(1), alta(2)]);
    const aceptadas = resultados.filter((r) => r.status === 'fulfilled');

    // LA GUARDA EXISTE PARA ESTO. Medida y consumida en dos conexiones
    // distintas, los dos SELECT veían los 24.000 libres antes de que ninguno
    // escribiera y LAS DOS ALTAS PASABAN.
    expect(aceptadas).toHaveLength(1);
    const rechazada = resultados.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect((rechazada.reason as Error).message).toMatch(
      /No hay saldo posteado que respalde|no existe o no es de la entidad/
    );

    const despues = await respaldoDisponible(D.entityId, D.roles.gasto_anticipado);
    expect(new Decimal(despues.disponible).toFixed(4)).toBe('0.0000');
  }, 120_000);

  it('y el mayor lo confirma: seis corridas y la 1160 no baja de cero', async () => {
    enterTenant(D.tenantId);
    for (let m = 6; m <= 11; m++) {
      const r = await runMonthlyAmortization(D.entityId, D.periodos[m], D.userId);
      expect(r.errors).toEqual([]);
      // Y en ningún momento intermedio la cuenta de activo queda acreedora.
      expect(
        new Decimal(await saldoDe(D.entityId, D.roles.gasto_anticipado)).greaterThanOrEqualTo(0)
      ).toBe(true);
    }
    // 9.000 (trimestral) + 24.000 (póliza) cargados; 3.100 de enero, 2.800 de
    // febrero y 24.000 de la póliza devengados: quedan los 3.100 de marzo, que
    // nadie ha corrido. Con las dos altas dentro serían 48.000 abonados sobre
    // 24.000 cargados y la cuenta cerraría en −20.900.
    expect(await saldoDe(D.entityId, D.roles.gasto_anticipado)).toBe('3100.0000');
  }, 300_000);
});

// ════════════════════════════════════════════════════════════════════════
// V · LA FRONTERA DE ENTIDAD (serie TEN) — dos entidades del MISMO inquilino
// ════════════════════════════════════════════════════════════════════════
describe('la frontera de entidad', () => {
  it('la corrida rechaza el periodo fiscal de la entidad hermana', async () => {
    enterTenant(A.tenantId);
    await expect(runMonthlyAmortization(A.entityId, C.periodos[7], A.userId)).rejects.toThrow(
      /no existe o no es de esta entidad/
    );
  });

  it('la revisión de cierre rechaza el periodo de la hermana', async () => {
    enterTenant(A.tenantId);
    await expect(revisionDeAmortizacionAlCierre(A.entityId, C.periodos[7])).rejects.toThrow(
      /no existe o no es de esta entidad/
    );
  });

  it('un anticipo no puede nacer contra la cuenta 1160 de la hermana', async () => {
    enterTenant(A.tenantId);
    await cargarAnticipado(A, '30000.0000', '2026-07-02');

    // Primera línea: el respaldo. La cuenta de la hermana no tiene NADA
    // posteado dentro de esta entidad, así que no hay de dónde devengar.
    await expect(
      registrarPagoAnticipado({
        entityId: A.entityId,
        descripcion: 'Póliza con cuenta ajena',
        importe: '30000.0000',
        inicio: '2026-07-01',
        fin: '2026-12-31',
        origen: 'manual',
        createdBy: A.userId,
        cuentas: { prepaidAccountId: C.roles.gasto_anticipado },
      })
    ).rejects.toThrow();

    // Y segunda línea, la que no depende de que ninguna consulta se acuerde:
    // la foránea COMPUESTA (id, entity_id). Ni por SQL a mano.
    await expect(
      query(
        `INSERT INTO prepaid_expenses (
           entity_id, description, total_amount, coverage_start_date, coverage_end_date,
           prepaid_account_id, expense_account_id, amortization_convention, origin, created_by)
         VALUES ($1, 'Por SQL a mano', 1000, '2026-07-01', '2026-12-31', $2, $3,
                 'proporcional_dias', 'manual', $4)`,
        [A.entityId, C.roles.gasto_anticipado, A.roles.gasto, A.userId]
      )
    ).rejects.toThrow(/fk_prepaid_cuenta_anticipo_entidad|foreign key|llave foránea/i);
  }, 120_000);

  it('un renglón no puede colgarse del periodo fiscal de la hermana', async () => {
    // El otro extremo del par. La 059 lo escribe en el esquema con
    // fk_amortizacion_periodo_entidad, y por eso no depende del JOIN que la
    // depreciación tiene que recordar en cada consulta.
    const r = await query<{ id: string }>(
      'SELECT id FROM prepaid_expenses WHERE entity_id = $1 LIMIT 1',
      [A.entityId]
    );
    await expect(
      query(
        `INSERT INTO prepaid_amortization_schedules (
           entity_id, prepaid_expense_id, fiscal_period_id, amortization_date,
           period_index, days_covered, amortization_amount, accumulated_amortization,
           remaining_balance, is_posted)
         VALUES ($1, $2, $3, '2026-07-31', 0, 31, 100, 100, 0, false)`,
        [A.entityId, r.rows[0].id, C.periodos[7]]
      )
    ).rejects.toThrow(/fk_amortizacion_periodo_entidad|foreign key|llave foránea/i);
  });

  it('el hueco de una entidad no cuenta el saldo de la otra', async () => {
    enterTenant(A.tenantId);
    const huecoA = await huecoDeAnticipados(A.entityId);
    const huecoC = await huecoDeAnticipados(C.entityId);
    // A tiene 30.000 sin adoptar (el cargo del caso anterior); C no tiene nada.
    expect(new Decimal(huecoA.hueco).toFixed(4)).toBe('30000.0000');
    expect(new Decimal(huecoC.hueco).toFixed(4)).toBe('0.0000');
    const idsC = huecoC.asientos.map((a) => a.journal_entry_id);
    for (const a of huecoA.asientos) expect(idsC).not.toContain(a.journal_entry_id);
  });

  it('los renglones de cada entidad llevan SU entity_id, no el del vecino', async () => {
    const r = await query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM prepaid_amortization_schedules s
         JOIN prepaid_expenses pe ON pe.id = s.prepaid_expense_id
        WHERE s.entity_id <> pe.entity_id`,
      []
    );
    expect(r.rows[0].n).toBe('0');
  });
});

// ════════════════════════════════════════════════════════════════════════
// VI · EL FINIQUITO: TRES DEFECTOS QUE HOY PAGAN MAL A PERSONAS
// ════════════════════════════════════════════════════════════════════════

/** 500,00 al día exactos: 182.500 / 365. */
const ANUAL_500 = '182500.00';
/** El MISMO sueldo, ya integrado (FI con 15 días y 12 de vacaciones al 25 %). */
const SBC_INTEGRADO = '524.6575';

describe('LFT art. 76 — la tabla que pagaba dos días de menos', () => {
  it('la tabla pura: 11 a 15 años de servicio son VEINTICUATRO días', () => {
    for (const anio of [11, 12, 13, 14, 15]) {
      expect(diasDeVacacionesPorAnio(anio)).toBe(24);
    }
    // Y los escalones de alrededor, para que 24 no sea una constante feliz.
    expect([6, 7, 8, 9, 10].map(diasDeVacacionesPorAnio)).toEqual([22, 22, 22, 22, 22]);
    expect([16, 20, 21, 25, 26, 30].map(diasDeVacacionesPorAnio)).toEqual([26, 26, 28, 28, 30, 30]);
    expect([1, 2, 3, 4, 5].map(diasDeVacacionesPorAnio)).toEqual([12, 14, 16, 18, 20]);
  });

  it('el finiquito REAL de cinco antigüedades distintas da 24 en las cinco', async () => {
    enterTenant(A.tenantId);
    // Baja el 30-jun-2026 y alta el 15-ene de cada año: la antigüedad cumplida
    // es 10, 11, 12, 13 y 14, o sea los años de servicio 11 a 15.
    for (const [altaAnio, cumplidos] of [
      [2016, 10], [2015, 11], [2014, 12], [2013, 13], [2012, 14],
    ] as Array<[number, number]>) {
      const emp = await altaEmpleado(A, { hire: `${altaAnio}-01-15`, annual: ANUAL_500 });
      const f = await calculateFiniquito(
        {
          employee_id: emp,
          termination_date: '2026-06-30',
          last_paid_through: '2026-06-15',
        },
        { tenantId: A.tenantId, entityId: A.entityId }
      );
      expect(f.basis.years_of_service).toBe(cumplidos);
      expect(f.basis.service_year).toBe(cumplidos + 1);
      // La versión anterior contaba los quinquenios desde el año 9 y devolvía
      // 22 en CUATRO de estos cinco casos: dos días de vacaciones de menos son
      // dos días de prima vacacional de menos en cada finiquito.
      expect(f.basis.vacation_days_art_76).toBe(24);
    }
  }, 120_000);
});

describe('LFT art. 87 — el aguinaldo tiene que mirar la fecha de alta', () => {
  it('quien entró el 1 de julio cobra la mitad, no el año entero', async () => {
    enterTenant(A.tenantId);
    const nuevo = await altaEmpleado(A, { hire: '2026-07-01', annual: ANUAL_500 });
    const veterano = await altaEmpleado(A, { hire: '2019-03-04', annual: ANUAL_500 });
    const ctx = { tenantId: A.tenantId, entityId: A.entityId };
    const comun = { termination_date: '2026-12-31', last_paid_through: '2026-12-15' };

    const f = await calculateFiniquito({ employee_id: nuevo, ...comun }, ctx);
    const v = await calculateFiniquito({ employee_id: veterano, ...comun }, ctx);

    // A MANO. Del 1-jul al 31-dic inclusive son 184 días.
    //   15 × 184 / 365 = 7,561643835… → 7,5616 días
    //   7,561643835… × 500 = 3.780,821917… → 3.780,8219
    expect(f.basis.aguinaldo_days_worked).toBe(184);
    expect(f.aguinaldo_days).toBe('7.5616');
    expect(f.aguinaldo_amount).toBe('3780.8219');

    // El veterano, con el mismo sueldo y la misma baja, cobra el año entero.
    expect(v.basis.aguinaldo_days_worked).toBe(365);
    expect(v.aguinaldo_days).toBe('15.0000');
    expect(v.aguinaldo_amount).toBe('7500.0000');

    // El defecto era éste: los dos cobraban lo mismo.
    expect(f.aguinaldo_amount).not.toBe(v.aguinaldo_amount);

    // Y el total, concepto a concepto, calculado a mano:
    //   salario   16 días × 500                     = 8.000,0000
    //   aguinaldo                                    = 3.780,8219
    //   prima     12 × 184/365 × 500 × 0,25          =   756,1644
    expect(f.salary_pending_days).toBe(16);
    expect(f.salary_pending_amount).toBe('8000.0000');
    expect(f.prima_vacacional_days).toBe('6.0493');
    expect(f.prima_vacacional_amount).toBe('756.1644');
    expect(f.total).toBe('12536.9863');
  }, 120_000);
});

describe('la cuota diaria es el salario diario, NO el SBC', () => {
  it('con los dos capturados gana el salario contratado', async () => {
    enterTenant(A.tenantId);
    const emp = await altaEmpleado(A, {
      hire: '2019-03-04',
      annual: ANUAL_500,
      sbc: SBC_INTEGRADO,
    });
    const f = await calculateFiniquito(
      { employee_id: emp, termination_date: '2026-12-31', last_paid_through: '2026-12-31' },
      { tenantId: A.tenantId, entityId: A.entityId }
    );

    expect(f.basis.daily_wage).toBe('500.0000');
    expect(f.basis.daily_wage_source).toBe('annual_salary');
    // El aguinaldo de un año entero: 15 × 500 = 7.500 exactos. Tomando el SBC
    // —que ya lleva DENTRO el aguinaldo prorrateado— salían 15 × 524,6575 =
    // 7.869,86: aguinaldo sobre el aguinaldo, y la empresa pagando de más
    // sobre una base que no es la de la LFT.
    expect(f.aguinaldo_amount).toBe('7500.0000');
    expect(f.aguinaldo_amount).not.toBe(
      new Decimal(SBC_INTEGRADO).times(15).toFixed(4)
    );
  }, 120_000);

  it('sin salario contratado se DES-INTEGRA el SBC, y queda por debajo de él', async () => {
    enterTenant(A.tenantId);
    const emp = await altaEmpleado(A, { hire: '2019-03-04', annual: null, sbc: SBC_INTEGRADO });
    const f = await calculateFiniquito(
      { employee_id: emp, termination_date: '2026-12-31', last_paid_through: '2026-12-31' },
      { tenantId: A.tenantId, entityId: A.entityId }
    );
    expect(f.basis.daily_wage_source).toBe('sbc_desintegrado');
    // FI = (365 + 15 + 20 × 0,25) / 365 = 385/365 (año de servicio 8 → 22 días…
    // el factor lo arma el módulo con los días del art. 76 del año en curso).
    expect(new Decimal(f.basis.daily_wage).lessThan(SBC_INTEGRADO)).toBe(true);
    // Y el salario reconstruido, multiplicado por el factor, vuelve al SBC.
    const dias = f.basis.vacation_days_art_76;
    const fi = new Decimal(365)
      .plus(new Decimal(f.basis.aguinaldo_days_per_year))
      .plus(new Decimal(dias).times(f.basis.prima_vacacional_pct))
      .dividedBy(365);
    expect(new Decimal(f.basis.daily_wage).times(fi).toFixed(2)).toBe(
      new Decimal(SBC_INTEGRADO).toFixed(2)
    );
  }, 120_000);
});

describe('los céntimos que un float redondea mal', () => {
  it('dos centavos que la coma flotante se comía, en un sueldo perfectamente normal', async () => {
    enterTenant(A.tenantId);
    // Sueldo anual 100.385,02 → 100.385,02 / 365 = 275,027452054… al día, que
    // a cuatro decimales es 275,0275. Alta el 3-oct-2026 y baja el 31-dic:
    // noventa días trabajados en el ejercicio.
    const emp = await altaEmpleado(A, { hire: '2026-10-03', annual: '100385.02' });
    const f = await calculateFiniquito(
      { employee_id: emp, termination_date: '2026-12-31', last_paid_through: '2026-12-28' },
      { tenantId: A.tenantId, entityId: A.entityId }
    );

    expect(f.basis.daily_wage).toBe('275.0275');
    expect(f.basis.aguinaldo_days_worked).toBe(90);

    // A MANO, con la aritmética exacta:
    //   salario    3 × 275,0275                          =   825,0825
    //   aguinaldo  15 × 90/365 × 275,0275 = 371.287,125/365 = 1.017,2250
    //   prima      12 × 90/365 × 275,0275 × 0,25         =   203,4450
    //   total                                             = 2.045,7525
    expect(f.salary_pending_days).toBe(3);
    expect(f.salary_pending_amount).toBe('825.0825');
    expect(f.aguinaldo_days).toBe('3.6986');
    expect(f.aguinaldo_amount).toBe('1017.2250');
    expect(f.prima_vacacional_days).toBe('2.9589');
    expect(f.prima_vacacional_amount).toBe('203.4450');
    expect(f.total).toBe('2045.7525');

    // LO QUE HACÍA EL CÓDIGO ANTERIOR, reproducido aquí con los MISMOS
    // números: coma flotante y `Math.round(x * 100) / 100`. No es un redondeo
    // de presentación — son dos centavos que no se le depositan a una persona,
    // y salen del error de representación, no del truncamiento.
    const diarioF = 275.0275;
    const aguinaldoF = ((15 * 90) / 365) * diarioF; // 1017.2249999999999
    const primaF = ((12 * 90) / 365) * diarioF * 0.25; // 203.44499999999996
    expect(Math.round(aguinaldoF * 100) / 100).toBe(1017.22); // debía ser 1017,23
    expect(Math.round(primaF * 100) / 100).toBe(203.44); //     debía ser  203,45
    expect(new Decimal(f.aguinaldo_amount).minus(1017.22).toFixed(4)).toBe('0.0050');
    expect(new Decimal(f.prima_vacacional_amount).minus(203.44).toFixed(4)).toBe('0.0050');

    // Y todos los importes salen como CADENA de cuatro decimales, no como number.
    for (const v of [
      f.salary_pending_amount, f.aguinaldo_amount, f.prima_vacacional_amount,
      f.vacation_pending_amount, f.total, f.basis.daily_wage,
    ]) {
      expect(typeof v).toBe('string');
      expect(v).toMatch(/^-?\d+\.\d{4}$/);
    }

    // El total es la suma EXACTA de los cuatro conceptos que el recibo enumera.
    const suma = [
      f.salary_pending_amount, f.aguinaldo_amount,
      f.prima_vacacional_amount, f.vacation_pending_amount,
    ].reduce((s, x) => s.plus(x), new Decimal(0));
    expect(suma.toFixed(4)).toBe(f.total);
  }, 120_000);
});

describe('el panel gobierna el finiquito de verdad', () => {
  it('`dias_aguinaldo` a 30 duplica el aguinaldo, y la política es la de la ENTIDAD DEL EMPLEADO', async () => {
    enterTenant(B.tenantId);
    // El empleado es de B; la petición viene con el alcance de A. La política
    // que tiene que regir es la de B, o un despacho con dos sociedades paga
    // con el criterio de la de al lado.
    await resolvePolicy(
      { tenantId: B.tenantId, entityId: B.entityId },
      'dias_aguinaldo',
      '30',
      B.userId
    );
    const emp = await altaEmpleado(B, { hire: '2019-03-04', annual: ANUAL_500 });
    const f = await calculateFiniquito(
      { employee_id: emp, termination_date: '2026-12-31', last_paid_through: '2026-12-31' },
      { tenantId: B.tenantId, entityId: A.entityId }
    );
    expect(f.basis.aguinaldo_days_per_year).toBe(30);
    expect(f.aguinaldo_days).toBe('30.0000');
    expect(f.aguinaldo_amount).toBe('15000.0000');

    // La misma alta en A, donde nadie ha contestado, sigue en el mínimo legal.
    const enA = await altaEmpleado(A, { hire: '2019-03-04', annual: ANUAL_500 });
    const g = await calculateFiniquito(
      { employee_id: enA, termination_date: '2026-12-31', last_paid_through: '2026-12-31' },
      { tenantId: A.tenantId, entityId: A.entityId }
    );
    expect(g.basis.aguinaldo_days_per_year).toBe(15);
    expect(g.aguinaldo_amount).toBe('7500.0000');
  }, 120_000);

  it('`prima_vacacional_pct` al 50 % dobla la prima', async () => {
    enterTenant(C.tenantId);
    await resolvePolicy(
      { tenantId: C.tenantId, entityId: C.entityId },
      'prima_vacacional_pct',
      '0.50',
      C.userId
    );
    // Alta el 1-ene-2019, baja el 31-dic-2026: año de servicio 8 → 22 días.
    const emp = await altaEmpleado(C, { hire: '2019-01-01', annual: ANUAL_500 });
    const f = await calculateFiniquito(
      { employee_id: emp, termination_date: '2026-12-31', last_paid_through: '2026-12-31' },
      { tenantId: C.tenantId, entityId: C.entityId }
    );
    expect(f.basis.prima_vacacional_pct).toBe('0.50');
    expect(f.basis.vacation_days_art_76).toBe(22);
    // El año de servicio corre del 1-ene-2026 al 31-dic-2026: 365 de 365 días.
    //   22 × 500 × 0,50 = 5.500,0000
    expect(f.prima_vacacional_days).toBe('22.0000');
    expect(f.prima_vacacional_amount).toBe('5500.0000');
  }, 120_000);
});

describe('la frontera del empleado', () => {
  it('un id de otro inquilino no devuelve el empleado, ni su sueldo', async () => {
    enterTenant(Z.tenantId);
    const ajeno = await altaEmpleado(Z, { hire: '2019-03-04', annual: '999999.00' });
    enterTenant(A.tenantId);
    await expect(
      calculateFiniquito(
        { employee_id: ajeno, termination_date: '2026-12-31', last_paid_through: '2026-12-15' },
        { tenantId: A.tenantId, entityId: A.entityId }
      )
    ).rejects.toThrow();
  }, 120_000);
});

// ════════════════════════════════════════════════════════════════════════
// VII · LOS INVARIANTES, SOBRE TODO LO QUE ESTE ARCHIVO DEJÓ ESCRITO
// ════════════════════════════════════════════════════════════════════════
//
// Van al final a propósito: recorren TODAS las filas que las secciones
// anteriores crearon —cuatro entidades, once anticipos, cuarenta y tantos
// renglones y sus reversas— en vez de comprobar un caso más.
describe('invariantes del devengo', () => {
  it('ningún asiento cuelga de un periodo distinto que el de su renglón', async () => {
    const r = await query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM prepaid_amortization_schedules s
         JOIN journal_entries je ON je.id = s.journal_entry_id
        WHERE je.fiscal_period_id <> s.fiscal_period_id OR je.entity_id <> s.entity_id`,
      []
    );
    expect(r.rows[0].n).toBe('0');
  });

  it('ninguna ficha afirma un devengo que el mayor no respalde', async () => {
    // La columna es una caché de una suma sobre el mayor. Aquí, con todo
    // corrido, las dos tienen que coincidir hasta el diezmilésimo.
    const r = await query<{ id: string; ficha: string; vigente: string }>(
      `SELECT pe.id, pe.amortized_to_date::text AS ficha,
              COALESCE((
                SELECT SUM(s.amortization_amount)
                  FROM prepaid_amortization_schedules s
                  JOIN journal_entries je ON je.id = s.journal_entry_id
                 WHERE s.prepaid_expense_id = pe.id AND s.entity_id = pe.entity_id
                   AND s.is_posted AND je.status = 'posted'
                   AND je.reversed_by_entry_id IS NULL
              ), 0)::text AS vigente
         FROM prepaid_expenses pe`,
      []
    );
    expect(r.rows.length).toBeGreaterThan(0);
    for (const f of r.rows) {
      expect(`${f.id}: ${new Decimal(f.ficha).toFixed(4)}`).toBe(
        `${f.id}: ${new Decimal(f.vigente).toFixed(4)}`
      );
    }
  });

  it('ninguna 1160 quedó con saldo acreedor', async () => {
    for (const f of [A, B, C, D]) {
      const saldo = new Decimal(await saldoDe(f.entityId, f.roles.gasto_anticipado));
      expect(`${f.entityId}: ${saldo.greaterThanOrEqualTo(0)}`).toBe(`${f.entityId}: true`);
    }
  });

  it('la suma de los renglones vigentes de cada anticipo nunca pasa de su total', async () => {
    const r = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM prepaid_expenses pe
        WHERE pe.total_amount < COALESCE((
                SELECT SUM(s.amortization_amount)
                  FROM prepaid_amortization_schedules s
                  JOIN journal_entries je ON je.id = s.journal_entry_id
                 WHERE s.prepaid_expense_id = pe.id AND s.is_posted
                   AND je.status = 'posted' AND je.reversed_by_entry_id IS NULL
              ), 0)`,
      []
    );
    expect(r.rows[0].n).toBe('0');
  });

  it('todo asiento de devengo mueve exactamente el par de cuentas de su anticipo', async () => {
    // DR gasto / CR 1160, y ninguna otra cuenta. Un devengo que tocara una
    // tercera cuenta estaría contando otra historia.
    const r = await query<{ n: string }>(
      `SELECT count(*)::text AS n
         FROM prepaid_amortization_schedules s
         JOIN prepaid_expenses pe ON pe.id = s.prepaid_expense_id
         JOIN journal_entry_lines jel ON jel.journal_entry_id = s.journal_entry_id
        WHERE jel.account_id NOT IN (pe.prepaid_account_id, pe.expense_account_id)`,
      []
    );
    expect(r.rows[0].n).toBe('0');
  });
});
