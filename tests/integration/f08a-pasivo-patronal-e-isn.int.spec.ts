import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../src/database/connection.js';
import { crearEntidadHermana, crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import {
  acumularPasivoPatronal,
  hallazgosQueBloquean,
} from '../../src/services/payroll/common/employer-liability-service.js';
import { approvePayRun } from '../../src/services/payroll/common/pay-run-service.js';

// ============================================================
// F08a · LO QUE EL PATRÓN DEBE, CONTRA UN POSTGRES DE VERDAD
//
// Dos defectos se prueban aquí y ninguno de los dos se puede probar con la
// consulta mockeada, porque los dos VIVEN en la base:
//
//  · FALTA UN IMPUESTO ENTERO. El ISN no aparecía en una línea de código. Lo
//    que esta prueba vigila no es que se calcule —eso lo cubren las unitarias—
//    sino que cuando la tasa NO está capturada el resultado sea un hallazgo con
//    el estado y el periodo escritos, y que la tabla de pasivos no reciba un
//    renglón en cero. Un cero aquí es indistinguible de un cálculo correcto.
//
//  · EL PASIVO NO SE APUNTABA. `employer_tax_liabilities` se leía y nadie la
//    escribía. Y el primer error de una tabla que empieza a escribirse es
//    escribirse dos veces: un reintento, un cierre repetido, un job que corre
//    dos veces. Que no se duplique depende del índice único parcial de la
//    migración 067 y del recálculo del renglón mensual — dos mecanismos que
//    sólo existen contra Postgres.
//
// Los recibos se insertan A MANO en vez de correr el motor de nómina: lo que
// se prueba es el acumulador, y hacerlo depender del cálculo de IMSS/ISR lo
// volvería una prueba de otra cosa que además se cae cuando esa otra cosa
// cambia.
// ============================================================

interface Corrida {
  payRunId: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
}

let f: Fixture;
let scheduleId: string;

/** Un trabajador mexicano con su estado de trabajo. */
async function crearTrabajador(estado: string | null, numero: string): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, rfc, work_state, sbc, pay_schedule_id, salary_type, currency_code)
     VALUES ($1, $2, $3, $4, 'Trabajador', $4, '2024-01-01', 'MX', 'XAXX010101000',
             $5, 500.0000, $6, 'salary', 'MXN')`,
    [id, f.tenantId, f.entityId, numero, estado, scheduleId]
  );
  return id;
}

/** Una corrida con su periodo, en estado `status`. */
async function crearCorrida(
  periodStart: string,
  periodEnd: string,
  payDate: string,
  status = 'approved'
): Promise<Corrida> {
  const periodId = uuidv4();
  const payRunId = uuidv4();
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year, status)
     VALUES ($1, $2, $3, $4::date, $5::date, $6::date, 2026, 'calculated')`,
    [periodId, f.tenantId, scheduleId, periodStart, periodEnd, payDate]
  );
  await query(
    `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used)
     VALUES ($1, $2, $3, 'regular', $4, 2026)`,
    [payRunId, f.tenantId, periodId, status]
  );
  return { payRunId, periodStart, periodEnd, payDate };
}

async function crearRecibo(
  payRunId: string,
  employeeId: string,
  bruto: string,
  imssPatronal: string,
  infonavitPatronal: string
): Promise<void> {
  await query(
    `INSERT INTO paychecks (id, tenant_id, pay_run_id, employee_id,
       gross_earnings, imss_employer, infonavit_employer, net_pay)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $5)`,
    [uuidv4(), f.tenantId, payRunId, employeeId, bruto, imssPatronal, infonavitPatronal]
  );
}

async function capturarTasa(
  estado: string,
  desde: string,
  hasta: string | null,
  tasa: string,
  regimen = 'tasa_plana',
  exencion: string | null = null
): Promise<void> {
  await query(
    `INSERT INTO mx_isn_tasas_estatales (estado, vigencia_desde, vigencia_hasta, tasa,
       regimen, exencion_mensual, fundamento)
     VALUES ($1, $2::date, $3::date, $4, $5, $6, $7)`,
    [estado, desde, hasta, tasa, regimen, exencion, `Ley de Hacienda de ${estado}, art. 39`]
  );
}

interface FilaPasivo {
  tax_type: string;
  jurisdiction: string;
  amount: string;
  period_start: string;
  period_end: string;
  due_date: string;
  deposit_frequency: string | null;
  pay_run_id: string | null;
}

async function pasivosDe(payRunId: string | null): Promise<FilaPasivo[]> {
  const { rows } = await query<FilaPasivo>(
    `SELECT tax_type, jurisdiction, amount::text AS amount,
            period_start::text AS period_start, period_end::text AS period_end,
            due_date::text AS due_date, deposit_frequency, pay_run_id
       FROM employer_tax_liabilities
      WHERE tenant_id = $1 AND entity_id = $2
        AND ($3::uuid IS NULL OR pay_run_id = $3::uuid)
      ORDER BY tax_type, jurisdiction`,
    [f.tenantId, f.entityId, payRunId]
  );
  return rows;
}

beforeAll(async () => {
  f = await crearInquilino('F08a · pasivo patronal e ISN');
  scheduleId = uuidv4();
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start)
     VALUES ($1, $2, $3, 'Quincenal MX', 'quincenal', 'MX', '2026-01-01')`,
    [scheduleId, f.tenantId, f.entityId]
  );
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });
});

describe('sin tasa capturada el resultado es un hallazgo con nombre, no un cero', () => {
  let corrida: Corrida;

  beforeAll(async () => {
    corrida = await crearCorrida('2026-03-01', '2026-03-15', '2026-03-16');
    const emp = await crearTrabajador('JA', 'SIN-TASA-1');
    await crearRecibo(corrida.payRunId, emp, '50000.00', '5000.00', '2500.00');
  });

  it('nombra el estado y el periodo que le faltan', async () => {
    const r = await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: corrida.payRunId });

    const bloqueantes = hallazgosQueBloquean(r.hallazgos);
    expect(bloqueantes).toHaveLength(1);
    expect(bloqueantes[0].codigo).toBe('isn_sin_tasa_capturada');
    expect(bloqueantes[0].estado).toBe('JA');
    expect(bloqueantes[0].mensaje).toContain('JA');
    expect(bloqueantes[0].mensaje).toContain('2026-03-01 a 2026-03-15');
  });

  it('NO deja un renglón de ISN en cero, que es la forma silenciosa del mismo defecto', async () => {
    const filas = await pasivosDe(corrida.payRunId);
    expect(filas.filter((x) => x.tax_type === 'isn')).toEqual([]);
  });

  it('y aun así apunta lo que sí sabe: IMSS e INFONAVIT patronales con su fecha límite', async () => {
    // Que falte la tasa de un estado no puede borrar las cuotas que sí se
    // calcularon: sería cambiar una omisión por otra más grande.
    const filas = await pasivosDe(corrida.payRunId);
    expect(filas.map((x) => [x.tax_type, x.amount, x.due_date, x.deposit_frequency])).toEqual([
      ['imss_employer', '5000.00', '2026-04-17', 'monthly'],
      // Marzo cierra el bimestre mar-abr: vence el 17 de mayo, no el 17 de abril.
      ['infonavit_employer', '2500.00', '2026-05-17', 'bimestral'],
    ]);
  });
});

describe('con la tasa capturada: un pasivo POR ESTADO, y la tasa que rige la fecha', () => {
  let corrida: Corrida;

  beforeAll(async () => {
    // Dos vigencias de Jalisco. «La última capturada» daría 4%; la que rige el
    // periodo de marzo es la de 3%. La diferencia son 300 pesos que nadie
    // volvería a mirar porque el importe tiene la magnitud correcta.
    await capturarTasa('JA', '2025-01-01', '2026-06-01', '0.030000');
    await capturarTasa('JA', '2026-06-01', null, '0.040000');
    await capturarTasa('NL', '2025-01-01', null, '0.020000');

    corrida = await crearCorrida('2026-03-16', '2026-03-31', '2026-04-01');
    const jal = await crearTrabajador('JA', 'CON-TASA-JA');
    const nle = await crearTrabajador('NL', 'CON-TASA-NL');
    await crearRecibo(corrida.payRunId, jal, '30000.00', '3000.00', '1500.00');
    await crearRecibo(corrida.payRunId, nle, '20000.00', '2000.00', '1000.00');
  });

  it('escribe un renglón por estado, cada uno con su tasa y su jurisdicción', async () => {
    const r = await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: corrida.payRunId });
    expect(hallazgosQueBloquean(r.hallazgos)).toEqual([]);

    const isn = (await pasivosDe(corrida.payRunId)).filter((x) => x.tax_type === 'isn');
    expect(isn.map((x) => [x.jurisdiction, x.amount])).toEqual([
      // 30 000 × 3% — la vigencia de marzo, no la de junio.
      ['MX-JA', '900.00'],
      // 20 000 × 2% — Nuevo León audita el suyo, y por eso es otro renglón.
      ['MX-NL', '400.00'],
    ]);
  });

  it('fecha el ISN en el MES de causación, con su día 17', async () => {
    const isn = (await pasivosDe(corrida.payRunId)).filter((x) => x.tax_type === 'isn');
    for (const fila of isn) {
      // Devengo (la omisión): el mes en que cierra el periodo, completo,
      // porque la declaración estatal es mensual y no quincenal.
      expect([fila.period_start, fila.period_end, fila.due_date]).toEqual([
        '2026-03-01', '2026-03-31', '2026-04-17',
      ]);
    }
  });

  it('correr el cierre dos veces no duplica el pasivo', async () => {
    const antes = await pasivosDe(corrida.payRunId);
    const r = await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: corrida.payRunId });

    // La segunda vuelta no crea nada: refresca los mismos renglones.
    expect(r.renglones.every((x) => x.accion === 'actualizado')).toBe(true);
    const despues = await pasivosDe(corrida.payRunId);
    expect(despues).toEqual(antes);
    expect(despues).toHaveLength(4); // imss + infonavit + dos estados
  });

  it('el candado es de la base: un INSERT crudo repetido lo rompe', async () => {
    // La idempotencia de arriba no depende de que el servicio se porte bien.
    // Si alguien escribe por otro camino —y este proyecto ya demostró que se
    // le llama por dos—, el índice único parcial de la 067 se planta.
    const fila = (await pasivosDe(corrida.payRunId)).find((x) => x.jurisdiction === 'MX-JA')!;
    await expect(
      query(
        `INSERT INTO employer_tax_liabilities (tenant_id, entity_id, pay_run_id, tax_type,
           jurisdiction, period_start, period_end, amount, due_date)
         VALUES ($1, $2, $3, 'isn', 'MX-JA', $4::date, $5::date, $6, $7::date)`,
        [f.tenantId, f.entityId, corrida.payRunId, fila.period_start, fila.period_end,
         fila.amount, fila.due_date]
      )
    ).rejects.toThrow(/employer_tax_liab_una_por_corrida/);
  });
});

describe('un régimen que el motor no sabe calcular se niega contra la base real', () => {
  it('el escalonado no se cobra como si fuera plano', async () => {
    await capturarTasa('CH', '2025-01-01', null, '0.030000', 'escalonado');
    const corrida = await crearCorrida('2026-04-01', '2026-04-15', '2026-04-16');
    const emp = await crearTrabajador('CH', 'ESCALONADO-1');
    await crearRecibo(corrida.payRunId, emp, '40000.00', '4000.00', '2000.00');

    const r = await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: corrida.payRunId });

    const bloqueantes = hallazgosQueBloquean(r.hallazgos);
    expect(bloqueantes[0].codigo).toBe('isn_regimen_no_soportado');
    expect(bloqueantes[0].mensaje).toContain('escalonado');
    const filas = await pasivosDe(corrida.payRunId);
    expect(filas.filter((x) => x.tax_type === 'isn')).toEqual([]);
  });
});

describe('provision_cuotas_patronales · mensual al cierre', () => {
  let primera: Corrida;
  let segunda: Corrida;

  beforeAll(async () => {
    await resolvePolicy(
      { tenantId: f.tenantId, entityId: f.entityId },
      'provision_cuotas_patronales',
      'mensual_al_cierre',
      'prueba de integración'
    );
    const emp = await crearTrabajador('NL', 'MENSUAL-1');
    primera = await crearCorrida('2026-05-01', '2026-05-15', '2026-05-16');
    // La segunda nace sin aprobar: el renglón del mes sólo cuenta corridas
    // cerradas, y aprobarla después es lo que hace visible el RECÁLCULO.
    segunda = await crearCorrida('2026-05-16', '2026-05-31', '2026-06-01', 'calculated');
    await crearRecibo(primera.payRunId, emp, '10000.00', '1000.00', '500.00');
    await crearRecibo(segunda.payRunId, emp, '10000.00', '1000.00', '500.00');
  });

  it('apunta un renglón del MES, sin corrida, y lo recalcula en vez de sumarlo', async () => {
    await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: primera.payRunId });
    const trasPrimera = (await pasivosDe(null)).filter(
      (x) => x.pay_run_id === null && x.period_start === '2026-05-01'
    );
    expect(trasPrimera.map((x) => [x.tax_type, x.amount])).toEqual([
      ['imss_employer', '1000.00'],
      ['infonavit_employer', '500.00'],
    ]);

    // La segunda corrida del mismo mes no añade un segundo renglón: reescribe
    // el del mes con el total recalculado desde los recibos ya cerrados.
    await approvePayRun(segunda.payRunId, f.userId);
    const trasSegunda = (await pasivosDe(null)).filter(
      (x) => x.pay_run_id === null && x.period_start === '2026-05-01'
    );
    expect(trasSegunda.map((x) => [x.tax_type, x.amount])).toEqual([
      ['imss_employer', '2000.00'],
      ['infonavit_employer', '1000.00'],
    ]);
  });

  it('repetir el cierre de la misma corrida deja el mes igual', async () => {
    await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: segunda.payRunId });
    await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: segunda.payRunId });
    const filas = (await pasivosDe(null)).filter(
      (x) => x.pay_run_id === null && x.period_start === '2026-05-01'
    );
    expect(filas.map((x) => [x.tax_type, x.amount])).toEqual([
      ['imss_employer', '2000.00'],
      ['infonavit_employer', '1000.00'],
    ]);
  });

  it('el ISN sigue siendo por corrida: esa política no habla de él', async () => {
    // `provision_cuotas_patronales` gobierna las cuotas de seguridad social.
    // El ISN es un impuesto estatal con su propia declaración y su propia
    // política de causación; meterlo en el renglón mensual lo escondería.
    const isn = (await pasivosDe(segunda.payRunId)).filter((x) => x.tax_type === 'isn');
    expect(isn.map((x) => [x.jurisdiction, x.amount, x.period_start])).toEqual([
      ['MX-NL', '200.00', '2026-05-01'],
    ]);
  });
});

describe('isn_momento_de_causacion · pago', () => {
  it('mueve el ISN al mes en que sale el dinero', async () => {
    await resolvePolicy(
      { tenantId: f.tenantId, entityId: f.entityId },
      'isn_momento_de_causacion',
      'pago',
      'prueba de integración'
    );
    // Periodo que CRUZA el fin de mes: es el único caso donde las dos
    // respuestas de la política dan meses distintos.
    const corrida = await crearCorrida('2026-06-16', '2026-06-30', '2026-07-03');
    const emp = await crearTrabajador('NL', 'PAGO-1');
    await crearRecibo(corrida.payRunId, emp, '10000.00', '1000.00', '500.00');

    const r = await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: corrida.payRunId });
    expect(r.criterioCausacionIsn).toBe('pago');

    const isn = (await pasivosDe(corrida.payRunId)).filter((x) => x.tax_type === 'isn');
    expect(isn.map((x) => [x.period_start, x.period_end, x.due_date])).toEqual([
      // Julio, el mes del pago — no junio, el mes en que se devengó.
      ['2026-07-01', '2026-07-31', '2026-08-17'],
    ]);
  });
});

describe('aprobar la corrida es lo que apunta el pasivo', () => {
  it('la aprobación y el pasivo entran juntos', async () => {
    const corrida = await crearCorrida('2026-08-01', '2026-08-15', '2026-08-16', 'calculated');
    const emp = await crearTrabajador('NL', 'APROBAR-1');
    await crearRecibo(corrida.payRunId, emp, '10000.00', '1000.00', '500.00');

    expect(await pasivosDe(corrida.payRunId)).toEqual([]);

    const r = await approvePayRun(corrida.payRunId, f.userId);
    expect(r.entityId).toBe(f.entityId);

    const { rows } = await query<{ status: string }>(
      `SELECT status FROM pay_runs WHERE id = $1 AND tenant_id = $2`,
      [corrida.payRunId, f.tenantId]
    );
    expect(rows[0].status).toBe('approved');
    // Una corrida aprobada sin su pasivo es justo el estado que este tramo
    // repara: las formas que suman esta tabla reportaban ceros.
    const isn = (await pasivosDe(corrida.payRunId)).filter((x) => x.tax_type === 'isn');
    expect(isn.map((x) => [x.jurisdiction, x.amount])).toEqual([['MX-NL', '200.00']]);
  });

  it('no se apunta el pasivo de una corrida que todavía puede cambiar', async () => {
    const corrida = await crearCorrida('2026-09-01', '2026-09-15', '2026-09-16', 'draft');
    await expect(
      acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: corrida.payRunId })
    ).rejects.toThrow(/draft/);
  });

  it('un recibo de otra entidad no acumula en silencio: se cuenta y se avisa', async () => {
    // El pasivo es de UNA entidad —la del calendario de la corrida— y acotar
    // por ella es obligatorio. Lo que no puede pasar es que el recibo de una
    // entidad hermana quede fuera sin que nadie lo diga: sería la misma
    // omisión que esta pieza repara, en pequeño.
    const hermana = await crearEntidadHermana(f, 'F08a · entidad hermana');
    const corrida = await crearCorrida('2026-10-01', '2026-10-15', '2026-10-16');
    const propio = await crearTrabajador('NL', 'MIXTA-PROPIO');
    await crearRecibo(corrida.payRunId, propio, '10000.00', '1000.00', '500.00');

    const ajeno = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, country_code, rfc, work_state, salary_type, currency_code)
       VALUES ($1, $2, $3, 'MIXTA-AJENO', 'Trabajador', 'Ajeno', '2024-01-01', 'MX',
               'XAXX010101000', 'NL', 'salary', 'MXN')`,
      [ajeno, f.tenantId, hermana.entityId]
    );
    await crearRecibo(corrida.payRunId, ajeno, '99999.00', '9999.00', '9999.00');

    const r = await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: corrida.payRunId });

    const aviso = r.hallazgos.find((x) => x.codigo === 'recibos_de_otra_entidad_en_la_corrida');
    expect(aviso?.severidad).toBe('aviso');
    expect(aviso?.mensaje).toContain('1 recibo(s)');
    // Y el pasivo lleva SÓLO lo de esta entidad. El ISN va por corrida:
    // 10 000 × 2%, no los 109 999 de las dos entidades juntas.
    const isn = (await pasivosDe(corrida.payRunId)).filter((x) => x.tax_type === 'isn');
    expect(isn.map((x) => [x.jurisdiction, x.amount])).toEqual([['MX-NL', '200.00']]);
    // Las cuotas van al renglón del mes, porque la política de este inquilino
    // ya quedó en `mensual_al_cierre` unas pruebas más arriba.
    const mensual = (await pasivosDe(null)).find(
      (x) => x.pay_run_id === null && x.period_start === '2026-10-01' && x.tax_type === 'imss_employer'
    );
    expect(mensual?.amount).toBe('1000.00');
  });

  it('la frontera de inquilino va dentro del SQL: otra corrida no se alcanza', async () => {
    const otro = await crearInquilino('F08a · inquilino vecino');
    await expect(
      acumularPasivoPatronal({ tenantId: otro.tenantId, payRunId: uuidv4() })
    ).rejects.toThrow(/No existe la corrida/);
  });
});
