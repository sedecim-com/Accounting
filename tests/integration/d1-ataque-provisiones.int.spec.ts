import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, closeDatabase, enterTenant } from '../../src/database/connection.js';
import { crearInquilino, crearEntidadHermana, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies } from '../../src/services/policy/policy-service.js';
import { runMonthlyProvisions } from '../../src/services/accruals/provisions-run.js';

/**
 * D1 · ATAQUE AL MOTOR DE PROVISIONES: EL BORDE Y LA REPETICIÓN.
 *
 * `d1-provisiones.int.spec.ts` prueba que el motor calcula. Este archivo prueba
 * lo contrario: que NO calcula de más. Son seis maneras distintas de inventar
 * un pasivo, y las seis dejan el balance cuadrado —por eso ninguna se ve
 * mirando el asiento, y todas se ven mirando el SALDO—:
 *
 *   1. Correr el mes tres veces y que el pasivo crezca tres veces.
 *   2. Seguir devengándole al que ya se fue: pasivo por alguien que no trabaja.
 *   3. Devengarle el mes entero al que entró el día 10: servicio no prestado.
 *   4. Barrer a los trabajadores de la entidad hermana: la frontera que RLS no
 *      defiende, porque su predicado es el inquilino y no la entidad.
 *   5. Tocar la 2205 con la PTU apagada, o callarse sobre ella.
 *   6. Postear un asiento en cero cuando no hay a quién devengar.
 *
 * TODA AFIRMACIÓN SE MIDE EN EL MAYOR, no en el contador que devuelve la
 * función. Un motor que devolviera `processed: 0` y posteara igual pasaría
 * cualquier prueba escrita sobre su propio resultado; aquí el juez es el saldo
 * de la cuenta y el número de filas de la cédula.
 *
 * LA ARITMÉTICA VA ESCRITA A MANO, con la derivación en el comentario. Ninguna
 * cifra sale de llamar al módulo que se está probando.
 */

let A: Fixture; // la corrida repetida y el que se va
let ENTRA: Fixture; // el alta a mitad de mes
let HERMANA: Fixture; // el otro lado de la frontera
let SECA: Fixture; // plantilla que existe pero no devenga
let ANIO: Fixture; // los doce meses corridos de seguido

/** Un trabajador mexicano mínimo. `annual / 365` es su salario diario. */
async function altaEmpleado(
  f: Fixture,
  datos: {
    hire: string;
    annual?: string | null;
    baja?: string | null;
    estado?: string;
    numero: string;
  }
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, termination_date, country_code, rfc, annual_salary, salary_type,
       currency_code, status)
     VALUES ($1, $2, $3, $4, 'Ataque', 'Provisión', $5, $6, 'MX', 'XAXX010101000', $7,
       'salary', 'MXN', $8)`,
    [
      id,
      f.tenantId,
      f.entityId,
      datos.numero,
      datos.hire,
      datos.baja ?? null,
      datos.annual ?? null,
      datos.estado ?? 'active',
    ]
  );
  return id;
}

/** Saldo POSTEADO de una cuenta: haber − debe, para que un pasivo salga positivo. */
async function saldoAcreedor(entityId: string, accountId: string): Promise<string> {
  const r = await query<{ saldo: string }>(
    `SELECT COALESCE(SUM(COALESCE(jel.credit_amount,0) - COALESCE(jel.debit_amount,0)), 0)::text
              AS saldo
       FROM journal_entry_lines jel
       JOIN journal_entries je ON je.id = jel.journal_entry_id
      WHERE jel.account_id = $2 AND je.entity_id = $1 AND je.status = 'posted'`,
    [entityId, accountId]
  );
  return new Decimal(r.rows[0].saldo).toFixed(4);
}

/**
 * Los tres saldos de provisión de una entidad, de una vez.
 *
 * Se piden POR ROL y no por código: preguntar por el '2202' en la prueba
 * dejaría pasar un motor que cablea el código, que es exactamente lo que el
 * encargo prohíbe.
 */
async function pasivo(f: Fixture): Promise<Record<string, string>> {
  return {
    aguinaldo: await saldoAcreedor(f.entityId, f.roles.provision_aguinaldo),
    vacaciones: await saldoAcreedor(f.entityId, f.roles.provision_vacaciones),
    prima: await saldoAcreedor(f.entityId, f.roles.provision_prima_vacacional),
  };
}

/** Cuántos asientos de esta corrida hay en el mayor de una entidad. */
async function asientos(entityId: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM journal_entries
      WHERE entity_id = $1 AND source_type = 'benefit_provision'`,
    [entityId]
  );
  return Number(r.rows[0].n);
}

/** Cuántas filas de cédula tiene una entidad (opcionalmente, en un periodo). */
async function filasDeCedula(entityId: string, periodoId?: string): Promise<number> {
  const r = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM benefit_provision_schedules
      WHERE entity_id = $1 AND ($2::uuid IS NULL OR fiscal_period_id = $2)`,
    [entityId, periodoId ?? null]
  );
  return Number(r.rows[0].n);
}

beforeAll(async () => {
  A = await crearInquilino('D1 ataque · repetición y baja');
  ENTRA = await crearEntidadHermana(A, 'D1 ataque · alta a mitad de mes');
  HERMANA = await crearEntidadHermana(A, 'D1 ataque · la otra entidad');
  SECA = await crearEntidadHermana(A, 'D1 ataque · plantilla que no devenga');
  ANIO = await crearEntidadHermana(A, 'D1 ataque · el ejercicio entero');
  for (const f of [A, ENTRA, HERMANA, SECA, ANIO]) {
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
  }
}, 300_000);

afterAll(async () => {
  await closeDatabase();
});

// ── 1 · LA DOBLE CORRIDA, Y LA TERCERA ──────────────────────────────────
describe('correr el mismo mes tres veces', () => {
  it('deja el pasivo donde estaba: el saldo del mayor, no el contador de la respuesta', async () => {
    enterTenant(A.tenantId);
    // MARINA · alta 2025-01-01, sueldo anual 365 000 → 1 000.0000 diarios.
    // En marzo de 2026 corre su AÑO DE SERVICIO 2 (cumplió uno el 2026-01-01),
    // así que el art. 76 le da 14 días y no hay aniversario dentro del mes.
    await altaEmpleado(A, { hire: '2025-01-01', annual: '365000.00', numero: 'AT-MARINA' });

    const primera = await runMonthlyProvisions(A.entityId, A.periodos[3], A.userId);
    expect(primera.errors).toEqual([]);
    expect(primera.processed).toBe(1);

    // MARZO ENTERO, 31 días. Todo importe es la diferencia de dos acumulados:
    //   ejercicio 2026 = 365 días; del 1-ene al 31-mar son 90 días, al 28-feb 59.
    //   aguinaldo (15 d):  1000×15×90/365 − 1000×15×59/365
    //                      = 3698.6301 − 2424.6575 = 1273.9726
    //   vacaciones (14 d): 1000×14×90/365 − 1000×14×59/365
    //                      = 3452.0548 − 2263.0137 = 1189.0411
    //   prima (3.5 d):     1000×3.5×90/365 − 1000×3.5×59/365
    //                      =  863.0137 −  565.7534 =  297.2603
    const MARZO = { aguinaldo: '1273.9726', vacaciones: '1189.0411', prima: '297.2603' };
    expect(await pasivo(A)).toEqual(MARZO);
    expect(await asientos(A.entityId)).toBe(1);
    expect(await filasDeCedula(A.entityId, A.periodos[3])).toBe(1);

    // SEGUNDA Y TERCERA. Ni un peso más, ni un asiento más, ni una fila más.
    for (const vuelta of [2, 3]) {
      const otra = await runMonthlyProvisions(A.entityId, A.periodos[3], A.userId);
      expect(otra.errors, `vuelta ${vuelta}`).toEqual([]);
      expect(otra.processed, `vuelta ${vuelta}`).toBe(0);
      expect(otra.skipped, `vuelta ${vuelta}`).toBe(1);
      expect(otra.journalEntryId, `vuelta ${vuelta}`).toBeNull();
      expect(await pasivo(A), `vuelta ${vuelta}`).toEqual(MARZO);
      expect(await asientos(A.entityId), `vuelta ${vuelta}`).toBe(1);
      expect(await filasDeCedula(A.entityId, A.periodos[3]), `vuelta ${vuelta}`).toBe(1);
    }

    // Y EL MES SIGUIENTE SÍ TIENE QUE CRECER: un freno que bloqueara abril
    // sería tan defecto como uno que duplicara marzo.
    //   abril, 30 días; del 1-ene al 30-abr son 120 días.
    //   aguinaldo:  1000×15×120/365 − 1000×15×90/365 = 4931.5068 − 3698.6301 = 1232.8767
    //   vacaciones: 1000×14×120/365 − 1000×14×90/365 = 4602.7397 − 3452.0548 = 1150.6849
    //   prima:      1000×3.5×120/365 − 1000×3.5×90/365 = 1150.6849 − 863.0137 = 287.6712
    const abril = await runMonthlyProvisions(A.entityId, A.periodos[4], A.userId);
    expect(abril.processed).toBe(1);
    expect(abril.aguinaldo).toBe('1232.8767');
    expect(abril.vacaciones).toBe('1150.6849');
    expect(abril.prima_vacacional).toBe('287.6712');
    expect(await pasivo(A)).toEqual({
      aguinaldo: '2506.8493', // 1273.9726 + 1232.8767
      vacaciones: '2339.7260', // 1189.0411 + 1150.6849
      prima: '584.9315', //  297.2603 +  287.6712
    });
    expect(await asientos(A.entityId)).toBe(2);
  });
});

// ── 2 · EL QUE YA NO TRABAJA NO DEVENGA ─────────────────────────────────
describe('el trabajador dado de baja', () => {
  it('devenga hasta el día de la baja y NI UN DÍA DESPUÉS', async () => {
    enterTenant(A.tenantId);
    // BRUNO · misma alta y mismo sueldo que Marina, pero se va el 20 de mayo.
    // Se le da de alta después de que marzo y abril ya están corridos, así que
    // su primer mes provisionado es mayo, que es justo el mes de su baja.
    await altaEmpleado(A, {
      hire: '2025-01-01',
      annual: '365000.00',
      baja: '2026-05-20',
      estado: 'terminated',
      numero: 'AT-BRUNO',
    });

    const antesDeMayo = await pasivo(A);

    // MAYO: Marina el mes entero (31 días) y Bruno SÓLO VEINTE.
    //   Del 1-ene al 31-may son 151 días; al 30-abr, 120; al 20-may, 140.
    //   Marina: ag 1000×15×151/365 − 1000×15×120/365 = 6205.4795 − 4931.5068 = 1273.9727
    //           va 1000×14×151/365 − 1000×14×120/365 = 5791.7808 − 4602.7397 = 1189.0411
    //           pr 1000×3.5×151/365 − 1000×3.5×120/365 = 1447.9452 − 1150.6849 =  297.2603
    //   Bruno:  ag 1000×15×140/365 − 1000×15×120/365 = 5753.4247 − 4931.5068 =  821.9179
    //           va 1000×14×140/365 − 1000×14×120/365 = 5369.8630 − 4602.7397 =  767.1233
    //           pr 1000×3.5×140/365 − 1000×3.5×120/365 = 1342.4658 − 1150.6849 =  191.7809
    //
    // El aguinaldo de Marina en mayo termina en …9727 y en marzo en …9726, con
    // el mismo salario y los mismos treinta y un días: es la marca de que el
    // importe se saca de DOS ACUMULADOS y no de una división del mes. El resto
    // de cada división cae en el mes siguiente en vez de perderse, que es lo
    // que hace que los doce meses sumen el anual exacto.
    const mayo = await runMonthlyProvisions(A.entityId, A.periodos[5], A.userId);
    expect(mayo.errors).toEqual([]);
    expect(mayo.processed).toBe(2);
    expect(mayo.aguinaldo).toBe('2095.8906'); // 1273.9727 + 821.9179
    expect(mayo.vacaciones).toBe('1956.1644'); // 1189.0411 + 767.1233
    expect(mayo.prima_vacacional).toBe('489.0412'); //  297.2603 + 191.7809

    // LOS VEINTE DÍAS, ESCRITOS EN LA CÉDULA. Es la única manera de ver desde
    // la tabla que no se le cobró el mes entero.
    const dias = await query<{ employee_number: string; days_accrued: number }>(
      `SELECT e.employee_number, s.days_accrued
         FROM benefit_provision_schedules s JOIN employees e ON e.id = s.employee_id
        WHERE s.entity_id = $1 AND s.fiscal_period_id = $2
        ORDER BY e.employee_number`,
      [A.entityId, A.periodos[5]]
    );
    expect(dias.rows).toEqual([
      { employee_number: 'AT-BRUNO', days_accrued: 20 },
      { employee_number: 'AT-MARINA', days_accrued: 31 },
    ]);

    // El pasivo creció EXACTAMENTE lo de los dos, medido contra el saldo previo.
    const conMayo = await pasivo(A);
    expect(conMayo).toEqual({
      aguinaldo: new Decimal(antesDeMayo.aguinaldo).plus('2095.8906').toFixed(4),
      vacaciones: new Decimal(antesDeMayo.vacaciones).plus('1956.1644').toFixed(4),
      prima: new Decimal(antesDeMayo.prima).plus('489.0412').toFixed(4),
    });

    // ── JUNIO: BRUNO YA NO ESTÁ ──
    //
    // Aquí está el defecto que esta prueba caza: un pasivo por aguinaldo de
    // alguien que en junio no prestó un solo día de servicio. Cuadraría el
    // balance, pasaría el cierre y sólo se vería el día en que alguien sumara
    // la cédula del año contra el finiquito que ya se pagó.
    //   Junio, 30 días; del 1-ene al 30-jun son 181 días.
    //   Marina: ag 1000×15×181/365 − 1000×15×151/365 = 7438.3562 − 6205.4795 = 1232.8767
    //           va 1000×14×181/365 − 1000×14×151/365 = 6942.4658 − 5791.7808 = 1150.6850
    //           pr 1000×3.5×181/365 − 1000×3.5×151/365 = 1735.6164 − 1447.9452 = 287.6712
    const junio = await runMonthlyProvisions(A.entityId, A.periodos[6], A.userId);
    expect(junio.errors).toEqual([]);
    // UNO, no dos.
    expect(junio.processed).toBe(1);
    expect(junio.aguinaldo).toBe('1232.8767');

    const cedulaJunio = await query<{ employee_number: string }>(
      `SELECT e.employee_number
         FROM benefit_provision_schedules s JOIN employees e ON e.id = s.employee_id
        WHERE s.entity_id = $1 AND s.fiscal_period_id = $2`,
      [A.entityId, A.periodos[6]]
    );
    expect(cedulaJunio.rows.map((f) => f.employee_number)).toEqual(['AT-MARINA']);

    // Y el pasivo creció EXACTAMENTE lo de Marina, no lo de dos personas.
    expect(await pasivo(A)).toEqual({
      aguinaldo: new Decimal(conMayo.aguinaldo).plus('1232.8767').toFixed(4),
      vacaciones: new Decimal(conMayo.vacaciones).plus('1150.6850').toFixed(4),
      prima: new Decimal(conMayo.prima).plus('287.6712').toFixed(4),
    });
  });

  it('el que se va el día 1 devenga ese día, y el que se fue el 31 anterior no devenga nada', async () => {
    enterTenant(SECA.tenantId);
    // EL BORDE POR SUS DOS LADOS, que es donde vive el error de un día:
    //   · CIERRA se va el 2026-02-28: en marzo no puede aparecer.
    //   · ABRE se va el 2026-03-01: trabajó UN día de marzo y lo cobra.
    await altaEmpleado(SECA, {
      hire: '2025-01-01',
      annual: '365000.00',
      baja: '2026-02-28',
      estado: 'terminated',
      numero: 'SE-CIERRA',
    });
    await altaEmpleado(SECA, {
      hire: '2025-01-01',
      annual: '365000.00',
      baja: '2026-03-01',
      estado: 'terminated',
      numero: 'SE-ABRE',
    });

    const r = await runMonthlyProvisions(SECA.entityId, SECA.periodos[3], SECA.userId);
    expect(r.errors).toEqual([]);
    expect(r.processed).toBe(1);

    const filas = await query<{ employee_number: string; days_accrued: number }>(
      `SELECT e.employee_number, s.days_accrued
         FROM benefit_provision_schedules s JOIN employees e ON e.id = s.employee_id
        WHERE s.entity_id = $1 AND s.fiscal_period_id = $2`,
      [SECA.entityId, SECA.periodos[3]]
    );
    expect(filas.rows).toEqual([{ employee_number: 'SE-ABRE', days_accrued: 1 }]);

    // UN día del ejercicio: del 1-ene al 1-mar son 60 días, al 28-feb 59.
    //   aguinaldo:  1000×15×60/365 − 1000×15×59/365   = 2465.7534 − 2424.6575 = 41.0959
    //   vacaciones: 1000×14×60/365 − 1000×14×59/365   = 2301.3699 − 2263.0137 = 38.3562
    //   prima:      1000×3.5×60/365 − 1000×3.5×59/365 =  575.3425 −  565.7534 =  9.5891
    expect(r.aguinaldo).toBe('41.0959');
    expect(r.vacaciones).toBe('38.3562');
    expect(r.prima_vacacional).toBe('9.5891');
    expect(await saldoAcreedor(SECA.entityId, SECA.roles.provision_aguinaldo)).toBe('41.0959');
  });
});

// ── 3 · EL ALTA A MITAD DE MES ──────────────────────────────────────────
describe('el trabajador que entra el día 10', () => {
  it('devenga veintidós días, no treinta y uno', async () => {
    enterTenant(ENTRA.tenantId);
    // NOÉ · alta 2026-03-10, sueldo anual 365 000 → 1 000.0000 diarios.
    // Su PRIMER año de servicio: art. 76 → 12 días. Y su ejercicio de aguinaldo
    // arranca el día del alta (LFT 87, «en proporción al tiempo que hubiere
    // trabajado»), así que a la víspera del 10 lleva CERO devengado:
    //   aguinaldo:  1000×15×22/365 − 0 =  904.1096
    //   vacaciones: 1000×12×22/365 − 0 =  723.2877
    //   prima:      1000× 3×22/365 − 0 =  180.8219
    // Devengarle el mes entero daría 1273.9726 / 1019.1781 / 254.7945: cobrarle
    // al patrón nueve días de servicio que nadie prestó.
    await altaEmpleado(ENTRA, { hire: '2026-03-10', annual: '365000.00', numero: 'EN-NOE' });

    const r = await runMonthlyProvisions(ENTRA.entityId, ENTRA.periodos[3], ENTRA.userId);
    expect(r.errors).toEqual([]);
    expect(r.processed).toBe(1);
    expect(r.aguinaldo).toBe('904.1096');
    expect(r.vacaciones).toBe('723.2877');
    expect(r.prima_vacacional).toBe('180.8219');

    expect(await pasivo(ENTRA)).toEqual({
      aguinaldo: '904.1096',
      vacaciones: '723.2877',
      prima: '180.8219',
    });

    const fila = await query<{ days_accrued: number }>(
      `SELECT days_accrued FROM benefit_provision_schedules
        WHERE entity_id = $1 AND fiscal_period_id = $2`,
      [ENTRA.entityId, ENTRA.periodos[3]]
    );
    expect(fila.rows[0].days_accrued).toBe(22);
  });

  it('el que todavía no entra no aparece en la corrida ni con una fila en cero', async () => {
    enterTenant(ENTRA.tenantId);
    // Alta en noviembre: para el motor no existe en ninguno de los meses que
    // este archivo corre sobre esta entidad (febrero, marzo y julio).
    await altaEmpleado(ENTRA, { hire: '2026-11-01', annual: '365000.00', numero: 'EN-FUTURO' });

    const febrero = await runMonthlyProvisions(ENTRA.entityId, ENTRA.periodos[2], ENTRA.userId);
    // NADIE devenga febrero: Noé entra el 10 de marzo y el otro en junio.
    expect(febrero.errors).toEqual([]);
    expect(febrero.processed).toBe(0);
    expect(febrero.journalEntryId).toBeNull();
    expect(await filasDeCedula(ENTRA.entityId, ENTRA.periodos[2])).toBe(0);
    // Y el pasivo de marzo, intacto: una corrida vacía no puede mover el mayor.
    expect(await pasivo(ENTRA)).toEqual({
      aguinaldo: '904.1096',
      vacaciones: '723.2877',
      prima: '180.8219',
    });
  });
});

// ── 4 · LA FRONTERA DE ENTIDAD, DENTRO DEL SQL ──────────────────────────
describe('dos entidades del mismo inquilino', () => {
  it('la corrida de una no devenga a los trabajadores de la otra', async () => {
    enterTenant(A.tenantId);
    // EL SUELDO DE LA HERMANA ES ABSURDO A PROPÓSITO: 3 650 000 al año son
    // 10 000 diarios, diez veces el de nadie más. Si la consulta se colara por
    // encima de la entidad, el importe no sería «un poco distinto» sino
    // imposible de confundir con un error de redondeo.
    await altaEmpleado(HERMANA, {
      hire: '2025-01-01',
      annual: '3650000.00',
      numero: 'HE-GIGANTE',
    });
    // Y la entidad que corre tiene un trabajador propio, para que la prueba no
    // pase por el motivo trivial de que no había a quién devengar.
    await altaEmpleado(ENTRA, { hire: '2025-01-01', annual: '365000.00', numero: 'EN-PROPIO' });

    const antesHermana = await pasivo(HERMANA);
    expect(antesHermana).toEqual({
      aguinaldo: '0.0000',
      vacaciones: '0.0000',
      prima: '0.0000',
    });

    // Julio de ENTRA: Noé (alta 10-mar, año 1 → 12 días) y el propio (alta
    // 1-ene-2025, año 2 → 14 días). Del gigante, ni un peso.
    //   Del 1-ene al 31-jul son 212 días; al 30-jun, 181.
    //   Propio: ag 1000×15×212/365 − 1000×15×181/365 = 8712.3288 − 7438.3562 = 1273.9726
    //   Noé:    su ejercicio arranca el 10-mar; del 10-mar al 31-jul son 144
    //           días y al 30-jun, 113.
    //           ag 1000×15×144/365 − 1000×15×113/365 = 5917.8082 − 4643.8356 = 1273.9726
    const julio = await runMonthlyProvisions(ENTRA.entityId, ENTRA.periodos[7], ENTRA.userId);
    expect(julio.errors).toEqual([]);
    expect(julio.processed).toBe(2);
    expect(julio.aguinaldo).toBe('2547.9452'); // 1273.9726 × 2, y nada de 10 000 diarios

    // LA HERMANA, INTACTA POR LOS TRES LADOS: ni saldo, ni cédula, ni asiento.
    expect(await pasivo(HERMANA)).toEqual(antesHermana);
    expect(await filasDeCedula(HERMANA.entityId)).toBe(0);
    expect(await asientos(HERMANA.entityId)).toBe(0);

    // Y la cédula de quien sí corrió nombra a los suyos y sólo a los suyos.
    const quienes = await query<{ employee_number: string }>(
      `SELECT e.employee_number
         FROM benefit_provision_schedules s JOIN employees e ON e.id = s.employee_id
        WHERE s.entity_id = $1 AND s.fiscal_period_id = $2
        ORDER BY e.employee_number`,
      [ENTRA.entityId, ENTRA.periodos[7]]
    );
    expect(quienes.rows.map((f) => f.employee_number)).toEqual(['EN-NOE', 'EN-PROPIO']);

    // Y AL REVÉS: la hermana corre lo suyo y no toca lo de ENTRA.
    const suyo = await runMonthlyProvisions(HERMANA.entityId, HERMANA.periodos[7], HERMANA.userId);
    expect(suyo.processed).toBe(1);
    // 10 000 diarios × 15 días × (212 − 181) / 365, por diferencia de acumulados:
    //   10000×15×212/365 − 10000×15×181/365 = 87123.2877 − 74383.5616 = 12739.7261
    expect(suyo.aguinaldo).toBe('12739.7261');
    expect(await filasDeCedula(HERMANA.entityId)).toBe(1);
  });
});

// ── 5 · LA PTU APAGADA: NI UN RENGLÓN, Y DICHO ──────────────────────────
describe('la frontera de entidad, comprobada contra POSTGRES y no contra la consulta', () => {
  it('una cédula de una entidad NO puede apuntar al asiento de su hermana', async () => {
    // WIT-01 de #180. La cédula apuntaba al asiento con una foránea SIMPLE
    // —`REFERENCES journal_entries(id)`—, y eso deja pasar lo que las otras dos
    // foráneas de la misma tabla ya impiden. RLS no lo tapa: acota por
    // INQUILINO, y estas dos entidades viven bajo el mismo. Un despacho con dos
    // sociedades es el caso normal, no el raro.
    //
    // SE ATACA POR SQL CRUDO A PROPÓSITO. Lo que se afirma no es que el motor
    // escriba bien —eso ya lo miden las pruebas de arriba—, sino que la BASE se
    // niegue aunque el código se equivoque. Si esto se comprobara llamando al
    // motor, mediría la consulta y no la frontera.
    enterTenant(A.tenantId);

    // Un asiento REAL de la hermana, con su propia entidad.
    const { rows: deLaHermana } = await query<{ id: string }>(
      `SELECT id FROM journal_entries WHERE entity_id = $1 LIMIT 1`,
      [HERMANA.entityId]
    );
    const asientoAjeno = deLaHermana[0]?.id;
    expect(asientoAjeno, 'la hermana no tiene ningún asiento que intentar robar').toBeDefined();

    // Y un trabajador y un periodo PROPIOS de A, para que lo único ajeno sea
    // el asiento: si fallara por otra cosa, la prueba no diría nada.
    const { rows: propios } = await query<{ emp: string; per: string }>(
      `SELECT e.id AS emp, fp.id AS per
         FROM employees e
         JOIN fiscal_periods fp ON fp.entity_id = e.entity_id
        WHERE e.entity_id = $1 AND fp.period_number = 11
        LIMIT 1`,
      [A.entityId]
    );
    expect(propios[0], 'el escenario de A no tiene trabajador y periodo propios').toBeDefined();

    await expect(
      query(
        `INSERT INTO benefit_provision_schedules
           (id, entity_id, employee_id, fiscal_period_id, provision_date, days_accrued,
            aguinaldo_amount, vacaciones_amount, prima_vacacional_amount,
            is_posted, journal_entry_id)
         VALUES ($1, $2, $3, $4, '2026-11-30', 30,
                 '100.0000', '100.0000', '25.0000', true, $5)`,
        [uuidv4(), A.entityId, propios[0].emp, propios[0].per, asientoAjeno]
      ),
      'Postgres aceptó una cédula de A colgada del asiento de su hermana: la frontera de ' +
        'entidad no está en el esquema, sólo en la consulta que alguien recuerde escribir'
    ).rejects.toThrow(/fk_provision_asiento_entidad|foreign key|violates/i);
  });
});

describe('la PTU con el panel en su valor por omisión', () => {
  it('no aparece en ninguna línea del mayor de la entidad, y el resultado lo declara', async () => {
    enterTenant(A.tenantId);
    const cuentaPtu = A.cuentas['2205'];
    expect(cuentaPtu).toBeDefined();

    // A lleva cuatro corridas posteadas (marzo, abril, mayo, junio). Si alguna
    // hubiera tocado la 2205, aquí saldría.
    const lineas = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entry_lines jel
         JOIN journal_entries je ON je.id = jel.journal_entry_id
        WHERE je.entity_id = $1 AND jel.account_id = $2`,
      [A.entityId, cuentaPtu]
    );
    expect(lineas.rows[0].n).toBe('0');
    expect(await saldoAcreedor(A.entityId, cuentaPtu)).toBe('0.0000');

    // Y NO SE CALLA: la corrida siguiente lo dice en su propio resultado. Un
    // cero mudo y una ausencia declarada no son el mismo hecho.
    const agosto = await runMonthlyProvisions(A.entityId, A.periodos[8], A.userId);
    expect(agosto.ptu.panel).toBe('no');
    expect(agosto.ptu.encendida).toBe(false);
    expect(agosto.ptu.provisionada).toBe(false);
    expect(agosto.ptu.cuenta_tocada).toBe(false);
    expect(agosto.ptu.nota.length).toBeGreaterThan(0);
    expect(await saldoAcreedor(A.entityId, cuentaPtu)).toBe('0.0000');
  });
});

// ── 6 · SIN NADIE A QUIEN DEVENGAR, NINGÚN ASIENTO ──────────────────────
describe('la corrida que no tiene a quién devengar', () => {
  it('con la plantilla entera fuera del mes no postea, no escribe y no falla', async () => {
    enterTenant(SECA.tenantId);
    // SECA tiene dos fichas, y las dos con la baja antes de agosto: la consulta
    // devuelve cero filas y el motor no llega ni a pedir las cuentas por rol.
    const antes = await pasivo(SECA);
    const asientosAntes = await asientos(SECA.entityId);

    const r = await runMonthlyProvisions(SECA.entityId, SECA.periodos[8], SECA.userId);
    expect(r.errors).toEqual([]);
    expect(r.processed).toBe(0);
    expect(r.skipped).toBe(0);
    expect(r.total).toBe('0.0000');
    expect(r.journalEntryId).toBeNull();

    expect(await pasivo(SECA)).toEqual(antes);
    expect(await asientos(SECA.entityId)).toBe(asientosAntes);
    expect(await filasDeCedula(SECA.entityId, SECA.periodos[8])).toBe(0);

    // NINGÚN ASIENTO EN CERO, tampoco de una sola línea descuadrada: la
    // pregunta se le hace al mayor entero de la entidad y no al contador.
    const enCero = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM journal_entries
        WHERE entity_id = $1 AND total_debits = 0 AND total_credits = 0`,
      [SECA.entityId]
    );
    expect(enCero.rows[0].n).toBe('0');
  });
});

// ── 7 · LOS DOCE MESES SUMAN EL ANUAL, AL CENTAVO ───────────────────────
//
// Es la propiedad que justifica todo el diseño, y la única que no se ve
// corriendo un mes: la repetición doce veces seguidas contra el mayor.
describe('el ejercicio corrido mes a mes', () => {
  it('deja en el pasivo el anual EXACTO, sin la diezmilésima que ningún cierre limpia', async () => {
    enterTenant(ANIO.tenantId);
    // AÑO · alta 2025-01-01, sueldo anual 365 000 → 1 000.0000 diarios. Su
    // aniversario cae el 1 de enero, así que durante todo 2026 corre un solo
    // año de servicio —el 2, con 14 días del art. 76— y ningún mes se parte.
    // Con eso el anual es un número redondo y la prueba puede exigirlo entero:
    //   aguinaldo  1000 × 15   = 15 000.0000
    //   vacaciones 1000 × 14   = 14 000.0000
    //   prima      1000 × 3.5  =  3 500.0000
    await altaEmpleado(ANIO, { hire: '2025-01-01', annual: '365000.00', numero: 'AN-DOCE' });

    for (let mes = 1; mes <= 12; mes++) {
      const r = await runMonthlyProvisions(ANIO.entityId, ANIO.periodos[mes], ANIO.userId);
      expect(r.errors, `mes ${mes}`).toEqual([]);
      expect(r.processed, `mes ${mes}`).toBe(1);
    }

    // DOCE ASIENTOS, DOCE FILAS DE CÉDULA, Y UN PASIVO REDONDO.
    expect(await asientos(ANIO.entityId)).toBe(12);
    expect(await filasDeCedula(ANIO.entityId)).toBe(12);

    // AQUÍ ESTÁ LO QUE SE PRUEBA. Doce divisiones independientes —el atajo
    // obvio, `salario × días del beneficio × días del mes / 365` mes a mes—
    // suman 14 999.9999 de aguinaldo, 13 999.9999 de vacaciones y 3 500.0001
    // de prima: tres diezmilésimas que se quedan VIVAS en la cuenta de pasivo
    // y que ningún cierre puede limpiar, porque no son de nadie. Con el
    // importe sacado de la DIFERENCIA DE DOS ACUMULADOS la serie telescopia y
    // el resto de cada división cae en el mes siguiente, una sola vez.
    expect(await pasivo(ANIO)).toEqual({
      aguinaldo: '15000.0000',
      vacaciones: '14000.0000',
      prima: '3500.0000',
    });

    // Y el cargo, la suma exacta de los tres.
    const gasto = await saldoAcreedor(ANIO.entityId, ANIO.roles.provision_prestaciones_gasto);
    expect(new Decimal(gasto).negated().toFixed(4)).toBe('32500.0000');

    // La cédula, sumada por su columna GENERADA, tiene que dar lo mismo que el
    // mayor: si discreparan, una de las dos estaría mintiendo.
    const suma = await query<{ total: string }>(
      `SELECT COALESCE(SUM(total_amount),0)::text AS total
         FROM benefit_provision_schedules WHERE entity_id = $1`,
      [ANIO.entityId]
    );
    expect(new Decimal(suma.rows[0].total).toFixed(4)).toBe('32500.0000');
  });
});
