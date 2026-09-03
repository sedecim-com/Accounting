import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { Command } from 'commander';
import { query } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { calculatePaycheck } from '../../src/services/payroll/common/paycheck-service.js';
import { acumularPasivoPatronal } from '../../src/services/payroll/common/employer-liability-service.js';
import { approvePayRun } from '../../src/services/payroll/common/pay-run-service.js';
import { registerPayrollIsnCommands } from '../../src/cli/payroll-isn-command.js';
// Las calculadoras se registran por efecto de importación: sin esto el
// registro está vacío y `getRequired('MX','isr')` truena.
import '../../src/services/payroll/tax-engine/register-all.js';

// ============================================================
// F08a · ATAQUE (2) · LA FRONTERA, LA TRANSACCIÓN Y LO QUE LA POLÍTICA FIRMA
//
// Este archivo es el SEGUNDO de la verificación adversaria del tramo —el
// primero, f08a-ataque.int.spec.ts, lo tomó el otro verificador— y ataca un
// frente distinto: dónde se cruza la frontera de inquilino, qué queda escrito
// cuando una escritura falla a mitad, y qué firma el sistema como «criterio
// del despacho».
//
// Ninguna prueba de aquí confía en la lectura del código: cada caso ejecuta el
// camino real contra Postgres y mira lo que QUEDÓ en la base. Y cada una se
// rompió a mano antes de darse por buena, porque una prueba que nunca pudo
// fallar no prueba nada.
// ============================================================

interface Escenario {
  f: Fixture;
  scheduleId: string;
  periodId: string;
  payRunId: string;
  empleadoId: string;
}

async function montar(
  nombre: string,
  opciones: {
    periodStart?: string;
    periodEnd?: string;
    payDate?: string;
    workState?: string | null;
    sbc?: string;
    estadoCorrida?: string;
  } = {}
): Promise<Escenario> {
  const f = await crearInquilino(nombre);
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });

  const scheduleId = uuidv4();
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
       first_period_start, is_active)
     VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
    [scheduleId, f.tenantId, f.entityId]
  );

  const periodId = uuidv4();
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
       pay_date, tax_year, status)
     VALUES ($1, $2, $3, $4::date, $5::date, $6::date, 2026, 'draft')`,
    [
      periodId,
      f.tenantId,
      scheduleId,
      opciones.periodStart ?? '2026-01-01',
      opciones.periodEnd ?? '2026-01-15',
      opciones.payDate ?? '2026-01-15',
    ]
  );

  const payRunId = uuidv4();
  await query(
    `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
     VALUES ($1, $2, $3, 'regular', $4, 2026, $5)`,
    [payRunId, f.tenantId, periodId, opciones.estadoCorrida ?? 'calculating', f.userId]
  );

  const empleadoId = uuidv4();
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto, tipo_regimen_sat,
       work_state, pay_schedule_id, salary_type, currency_code)
     VALUES ($1, $2, $3, $4, 'Trabajador', 'De Ataque', '2024-01-01', 'active', 'MX',
       'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901', $5, '01', '02', $6, $7,
       'salary', 'MXN')`,
    [
      empleadoId,
      f.tenantId,
      f.entityId,
      `ATQ2-${empleadoId.slice(0, 8)}`,
      opciones.sbc ?? '300.0000',
      opciones.workState === undefined ? 'JA' : opciones.workState,
      scheduleId,
    ]
  );

  return { f, scheduleId, periodId, payRunId, empleadoId };
}

/** Una remuneración ya calculada, insertada a mano: aquí se prueba el acumulador. */
async function reciboManual(
  e: Escenario,
  bruto: string,
  imssPatronal = '0',
  infonavitPatronal = '0',
  empleadoId?: string
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO paychecks (id, tenant_id, pay_run_id, employee_id,
       gross_earnings, imss_employer, infonavit_employer, net_pay)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $5)`,
    [id, e.f.tenantId, e.payRunId, empleadoId ?? e.empleadoId, bruto, imssPatronal, infonavitPatronal]
  );
  return id;
}

// ============================================================
// 1 · LA FRONTERA DE INQUILINO DEL RECIBO ESTABA A MEDIAS
//
// `calculatePaycheck` acotaba `employees` y `pay_periods` por tenant_id —su
// comentario de cabecera celebraba justamente eso— y NO acotaba `pay_run_id`:
// el recibo se insertaba con la corrida que trajera la petición, sin
// comprobar de quién era. Medido contra Postgres antes del arreglo: el recibo
// entraba, el agregado del asiento al mayor lo sumaba en la póliza del
// inquilino invadido, y el pasivo del inquilino DUEÑO se quedaba sin él.
// ============================================================
describe('1 · la corrida de otro inquilino no admite recibos ajenos', () => {
  let a: Escenario;
  let b: Escenario;

  beforeAll(async () => {
    a = await montar('F08a ataque2 · inquilino A');
    b = await montar('F08a ataque2 · inquilino B');
  });

  it('el recibo con la corrida del OTRO inquilino se rechaza', async () => {
    // El único dato ajeno es el pay_run_id: trabajador y periodo son propios,
    // así que las dos fronteras que el tramo sí puso no intervienen. Si sólo
    // ellas existieran, esto escribiría un recibo entero.
    await expect(
      calculatePaycheck({
        tenant_id: a.f.tenantId,
        pay_run_id: b.payRunId, // ← corrida del OTRO inquilino
        employee_id: a.empleadoId,
        pay_period_id: a.periodId,
        earnings: [{ earning_type: 'salary', amount: 9000 }],
      })
    ).rejects.toThrow(/Pay run not found/);
  });

  it('y el agregado del que sale el asiento al mayor no ve dinero ajeno', async () => {
    // Éste es el SQL literal de gl-posting-service.ts (`FROM paychecks WHERE
    // pay_run_id = $1`): agrega por corrida y no menciona el inquilino ni una
    // vez. Es la razón por la que la frontera tiene que estar arriba: aquí ya
    // no hay dónde ponerla.
    const { rows } = await query<{ bruto: string; recibos: string }>(
      `SELECT COALESCE(SUM(gross_earnings), 0)::text AS bruto, COUNT(*)::text AS recibos
         FROM paychecks WHERE pay_run_id = $1`,
      [b.payRunId]
    );
    expect(rows[0]).toEqual({ recibos: '0', bruto: '0' });
  });

  it('ni cuelga de esa corrida un solo renglón de desglose ajeno', async () => {
    // `paycheck_taxes` se aísla por su padre. Con el padre archivado bajo la
    // corrida equivocada, la herencia lleva el desglose al sitio equivocado:
    // el aislamiento transitivo sólo vale lo que valga la fila de arriba.
    const { rows } = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n
         FROM paycheck_taxes pt JOIN paychecks p ON p.id = pt.paycheck_id
        WHERE p.pay_run_id = $1 AND p.tenant_id <> $2`,
      [b.payRunId, b.f.tenantId]
    );
    expect(rows[0].n).toBe('0');
  });

  it('y el recibo puesto en SU corrida sí acumula el pasivo de su inquilino', async () => {
    // La otra mitad del daño: con el recibo emigrado, la corrida de A se
    // quedaba vacía, su IMSS patronal no se acumulaba en ninguna parte y ni
    // siquiera saltaba el aviso `imss_patronal_en_cero`, que sólo dispara
    // cuando HAY recibos mexicanos. Aquí se comprueba que el camino correcto
    // sí deja rastro.
    await calculatePaycheck({
      tenant_id: a.f.tenantId,
      pay_run_id: a.payRunId,
      employee_id: a.empleadoId,
      pay_period_id: a.periodId,
      earnings: [{ earning_type: 'salary', amount: 9000 }],
    });
    await query(`UPDATE pay_runs SET status = 'approved' WHERE id = $1`, [a.payRunId]);
    const r = await acumularPasivoPatronal({ tenantId: a.f.tenantId, payRunId: a.payRunId });
    expect(r.renglones.map((x) => x.taxType)).toContain('imss_employer');
  });
});

// ============================================================
// 2 · ATOMICIDAD DEL RECIBO Y SU DESGLOSE
//
// Se provoca el fallo A MITAD con un disparador que revienta en el renglón del
// IMSS —que se apunta después de que el recibo, sus percepciones y los dos
// primeros renglones ya están insertados— y se mira qué sobrevive.
// ============================================================
describe('2 · el recibo no sobrevive al fallo de su desglose', () => {
  let e: Escenario;

  beforeAll(async () => {
    e = await montar('F08a ataque2 · atomicidad del recibo');
    await query(`
      CREATE OR REPLACE FUNCTION ataque2_revienta_imss() RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.tax_type = 'imss' THEN
          RAISE EXCEPTION 'ataque2: fallo a mitad del desglose';
        END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql`);
    await query(`
      CREATE TRIGGER trg_ataque2_revienta_imss BEFORE INSERT ON paycheck_taxes
      FOR EACH ROW EXECUTE FUNCTION ataque2_revienta_imss()`);
  });

  afterAll(async () => {
    await query(`DROP TRIGGER IF EXISTS trg_ataque2_revienta_imss ON paycheck_taxes`);
    await query(`DROP FUNCTION IF EXISTS ataque2_revienta_imss()`);
  });

  it('la llamada falla en el renglón del IMSS, que va después del recibo', async () => {
    await expect(
      calculatePaycheck({
        tenant_id: e.f.tenantId,
        pay_run_id: e.payRunId,
        employee_id: e.empleadoId,
        pay_period_id: e.periodId,
        earnings: [{ earning_type: 'salary', amount: 9000 }],
      })
    ).rejects.toThrow(/ataque2: fallo a mitad del desglose/);
  });

  it('y no deja ni recibo, ni percepciones, ni renglones de impuesto sueltos', async () => {
    const { rows } = await query<{ recibos: string; percep: string; imp: string }>(
      `SELECT (SELECT COUNT(*) FROM paychecks WHERE pay_run_id = $1)::text AS recibos,
              (SELECT COUNT(*) FROM paycheck_earnings pe
                 JOIN paychecks p ON p.id = pe.paycheck_id WHERE p.pay_run_id = $1)::text AS percep,
              (SELECT COUNT(*) FROM paycheck_taxes pt
                 JOIN paychecks p ON p.id = pt.paycheck_id WHERE p.pay_run_id = $1)::text AS imp`,
      [e.payRunId]
    );
    expect(rows[0]).toEqual({ recibos: '0', percep: '0', imp: '0' });
  });
});

// ============================================================
// 3 · ATOMICIDAD DE LA APROBACIÓN
//
// `approvePayRun` promete que el pasivo y el cambio de estado entran juntos o
// no entra ninguno. Se revienta la escritura del pasivo y se mira el estado.
// ============================================================
describe('3 · una corrida no queda aprobada sin su pasivo', () => {
  let e: Escenario;

  beforeAll(async () => {
    e = await montar('F08a ataque2 · atomicidad de la aprobación', {
      estadoCorrida: 'calculated',
    });
    await reciboManual(e, '30000.00', '3000.00', '1500.00');
    await query(`
      CREATE OR REPLACE FUNCTION ataque2_revienta_pasivo() RETURNS TRIGGER AS $$
      BEGIN RAISE EXCEPTION 'ataque2: el pasivo no se puede escribir'; END; $$ LANGUAGE plpgsql`);
    await query(`
      CREATE TRIGGER trg_ataque2_revienta_pasivo BEFORE INSERT ON employer_tax_liabilities
      FOR EACH ROW EXECUTE FUNCTION ataque2_revienta_pasivo()`);
  });

  afterAll(async () => {
    await query(`DROP TRIGGER IF EXISTS trg_ataque2_revienta_pasivo ON employer_tax_liabilities`);
    await query(`DROP FUNCTION IF EXISTS ataque2_revienta_pasivo()`);
  });

  it('la aprobación falla y la corrida sigue en calculated', async () => {
    await expect(approvePayRun(e.payRunId, e.f.userId)).rejects.toThrow(
      /el pasivo no se puede escribir/
    );
    const { rows } = await query<{ status: string }>(`SELECT status FROM pay_runs WHERE id = $1`, [
      e.payRunId,
    ]);
    expect(rows[0].status).toBe('calculated');
  });
});

// ============================================================
// 4 · LA VENTANA DE BÚSQUEDA TIENE QUE CONTENER A LA FECHA QUE DECIDE
//
// `vigenciasDeIsn` prefiltraba con `vigencia_desde <= periodoFin`, y después
// `vigenteEn(tasas, fechaCausacion)` escogía. Con `isn_momento_de_causacion =
// pago` la causación es el pay_date, que por definición cae DESPUÉS del cierre
// del periodo, y una tasa que entra en vigor entre el corte y el pago —que es
// cuándo entran en vigor, el día 1— no llegaba al selector. Medido antes del
// arreglo: hallazgo bloqueante `isn_sin_tasa_capturada` sobre DOS tasas
// capturadas, y ni un peso de ISN apuntado.
// ============================================================
describe('4 · con causación al PAGO, la tasa que entra en vigor entre el corte y el pago sí se aplica', () => {
  let e: Escenario;

  beforeAll(async () => {
    e = await montar('F08a ataque2 · causación al pago', {
      periodStart: '2026-06-16',
      periodEnd: '2026-06-30',
      payDate: '2026-07-05',
      workState: 'ZX',
      estadoCorrida: 'approved',
    });
    await reciboManual(e, '100000.00');
    // El estado sube la tasa el 1 de julio. Las DOS vigencias están capturadas
    // con su fundamento; no falta ningún dato.
    await query(
      `INSERT INTO mx_isn_tasas_estatales (estado, vigencia_desde, vigencia_hasta, tasa, fundamento)
       VALUES ('ZX', '2025-01-01', '2026-07-01', 0.020000, 'Ley de Hacienda ZX art. 1 (2025)'),
              ('ZX', '2026-07-01', NULL,          0.030000, 'Ley de Hacienda ZX art. 1 (reforma 2026)')`
    );
    await resolvePolicy(
      { tenantId: e.f.tenantId, entityId: e.f.entityId },
      'isn_momento_de_causacion',
      'pago',
      'ataque@example.test'
    );
  });

  it('no se declara «falta la tasa» sobre dos tasas capturadas', async () => {
    const r = await acumularPasivoPatronal({ tenantId: e.f.tenantId, payRunId: e.payRunId });
    expect(r.criterioCausacionIsn).toBe('pago');
    expect(r.hallazgos.filter((h) => h.severidad === 'bloqueante').map((h) => h.codigo)).toEqual([]);
  });

  it('y el ISN se apunta con la tasa que rige el día del pago, en el mes del pago', async () => {
    const { rows } = await query<{ jurisdiction: string; amount: string; period_start: string }>(
      `SELECT jurisdiction, amount::text AS amount, period_start::text AS period_start
         FROM employer_tax_liabilities
        WHERE tenant_id = $1 AND pay_run_id = $2 AND tax_type = 'isn'`,
      [e.f.tenantId, e.payRunId]
    );
    // 100 000 al 3 % —la vigencia que rige el 5 de julio—, en el mes de julio.
    expect(rows).toEqual([
      { jurisdiction: 'MX-ZX', amount: '3000.00', period_start: '2026-07-01' },
    ]);
  });
});

// ============================================================
// 5 · UNA OMISIÓN FIRMADA COMO CRITERIO DEL DESPACHO
//
// `pending define` acepta valor libre a propósito («A free-form value is
// accepted», policy-service.ts): el despacho puede contestar `pagos` y la fila
// queda 'resolved' con ese valor. Los tres lectores de F08a colapsaban con un
// ternario cualquier valor que no reconocían al de OMISIÓN, y seguían
// informando `defined: true` — el despacho contestó una cosa, el motor hizo
// otra, y el resultado firmó esa otra como criterio del despacho.
//
// El módulo hermano del mismo tramo, `leerRegistroDelSubsidio`, hace lo
// contrario y se niega («CERRADO AL DECLARAR»). La asimetría dentro del mismo
// tramo era la prueba de que aquí faltaba la guarda, no de que sobrara allá.
// ============================================================
describe('5 · una respuesta que el lector no entiende no se colapsa a la omisión', () => {
  /** Un escenario con su tasa capturada y un periodo que cruza el fin de mes. */
  async function conRespuesta(
    nombre: string,
    clave: string,
    valor: string,
    estado: string
  ): Promise<Escenario> {
    const e = await montar(nombre, {
      periodStart: '2026-06-16',
      periodEnd: '2026-06-30',
      payDate: '2026-07-05',
      workState: estado,
      estadoCorrida: 'approved',
    });
    await reciboManual(e, '100000.00', '5000.00', '2500.00');
    await query(
      `INSERT INTO mx_isn_tasas_estatales (estado, vigencia_desde, vigencia_hasta, tasa, fundamento)
       VALUES ($1, '2025-01-01', NULL, 0.030000, 'Ley de Hacienda art. 1')
       ON CONFLICT DO NOTHING`,
      [estado]
    );
    await resolvePolicy(
      { tenantId: e.f.tenantId, entityId: e.f.entityId },
      clave,
      valor,
      'ataque@example.test'
    );
    return e;
  }

  async function pasivosDe(e: Escenario): Promise<Array<Record<string, string>>> {
    const { rows } = await query<{ tax_type: string; period_start: string; due_date: string }>(
      `SELECT tax_type, period_start::text AS period_start, due_date::text AS due_date
         FROM employer_tax_liabilities
        WHERE tenant_id = $1 AND pay_run_id = $2 ORDER BY tax_type`,
      [e.f.tenantId, e.payRunId]
    );
    return rows;
  }

  it('«pagos» por «pago» se acusa nombrando la clave y el valor escrito', async () => {
    const e = await conRespuesta(
      'F08a ataque2 · causación mal escrita', 'isn_momento_de_causacion', 'pagos', 'ZY'
    );
    await expect(
      acumularPasivoPatronal({ tenantId: e.f.tenantId, payRunId: e.payRunId })
    ).rejects.toThrow(/isn_momento_de_causacion vale "pagos"/);
    // Y no deja medio pasivo escrito con el criterio que no era.
    expect(await pasivosDe(e)).toEqual([]);
  });

  it('y contestada bien, el ISN cae en el mes que el despacho pidió', async () => {
    const e = await conRespuesta(
      'F08a ataque2 · causación bien escrita', 'isn_momento_de_causacion', 'pago', 'ZY'
    );
    await acumularPasivoPatronal({ tenantId: e.f.tenantId, payRunId: e.payRunId });
    const isn = (await pasivosDe(e)).filter((r) => r.tax_type === 'isn');
    // Julio —el mes del pago—, con su fecha límite del 17 de agosto. Con la
    // omisión (devengo) habría caído en junio y vencido el 17 de julio.
    expect(isn).toEqual([{ tax_type: 'isn', period_start: '2026-07-01', due_date: '2026-08-17' }]);
  });

  it('«mensual» por «mensual_al_cierre» tampoco se adivina', async () => {
    const e = await conRespuesta(
      'F08a ataque2 · provisión mal escrita', 'provision_cuotas_patronales', 'mensual', 'ZY'
    );
    await expect(
      acumularPasivoPatronal({ tenantId: e.f.tenantId, payRunId: e.payRunId })
    ).rejects.toThrow(/provision_cuotas_patronales vale "mensual"/);
    expect(await pasivosDe(e)).toEqual([]);
  });

  it('«domicilio» por «domicilio_fiscal» tampoco: de eso depende a qué estado se declara', async () => {
    const e = await conRespuesta(
      'F08a ataque2 · estado mal escrito', 'isn_estado_que_causa', 'domicilio', 'ZY'
    );
    await expect(
      acumularPasivoPatronal({ tenantId: e.f.tenantId, payRunId: e.payRunId })
    ).rejects.toThrow(/isn_estado_que_causa vale "domicilio"/);
    expect(await pasivosDe(e)).toEqual([]);
  });
});

// ============================================================
// 6 · LA SUPERFICIE DEL CLI, CONTRA LA BASE
//
// Las guardas puras ya están probadas sin Postgres en
// tests/cli/payroll-isn-command.spec.ts. Lo que aquí se ataca es lo que sólo
// se puede comprobar con la tabla delante: que una captura rechazada no deje
// fila, que la confirmación se pida ANTES de escribir, y que el solape muera
// tanto en la capa como en el disparador.
// ============================================================
describe('6 · `isn rate set` contra la tabla de verdad', () => {
  let e: Escenario;
  let correo: string;

  const CITA = 'Ley de Hacienda del Estado ZW art. 41, POE 2025-12-15';

  interface Corrida {
    salida: number;
    dicho: string;
    stdout: string;
    /** Cuántas veces se le preguntó al operador. Cero es un dato, no un vacío. */
    preguntas: number;
  }

  /** Corre la hoja de verdad, con la confirmación amarrada a `responde`. */
  async function correr(argv: string[], responde: boolean | null = true): Promise<Corrida> {
    let salida = -1;
    let preguntas = 0;
    const dicho: string[] = [];
    const stdout: string[] = [];
    const espia = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: unknown): boolean => {
        stdout.push(String(chunk));
        return true;
      });
    const p = new Command('mnemosine');
    registerPayrollIsnCommands(p, {
      palette: {
        dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
        red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
      },
      shutdown: (code: number) => {
        salida = code;
      },
      reportError: (err: unknown) => {
        dicho.push(err instanceof Error ? err.message : String(err));
      },
      ...(responde === null
        ? {}
        : {
            confirm: async () => {
              preguntas += 1;
              return responde;
            },
          }),
    });
    try {
      await p.parseAsync(['node', 'mnemosine', ...argv]);
    } finally {
      espia.mockRestore();
    }
    return { salida, dicho: dicho.join('\n'), stdout: stdout.join(''), preguntas };
  }

  function comunes(): string[] {
    return ['--tenant', e.f.tenantId, '--entity', e.f.entityId, '--user', correo];
  }

  async function vigenciasZW(): Promise<Array<{ desde: string; tasa: string }>> {
    const { rows } = await query<{ desde: string; tasa: string }>(
      `SELECT vigencia_desde::text AS desde, tasa::text AS tasa
         FROM mx_isn_tasas_estatales WHERE estado = 'ZW' ORDER BY vigencia_desde`
    );
    return rows;
  }

  beforeAll(async () => {
    e = await montar('F08a ataque2 · CLI', { workState: 'ZW' });
    const { rows } = await query<{ email: string }>(`SELECT email FROM users WHERE id = $1`, [
      e.f.userId,
    ]);
    correo = rows[0].email;
  });

  it('sin fundamento no escribe nada, y la columna NOT NULL no habría parado la cadena vacía', async () => {
    const r = await correr([
      'isn', 'rate', 'set', 'ZW', '3%',
      '--effective-from', '2026-01-01',
      '--legal-basis', '   ',
      ...comunes(),
    ]);
    expect(r.salida).toBe(2);
    expect(r.dicho).toMatch(/--legal-basis is required/);
    expect(await vigenciasZW()).toEqual([]);
  });

  it('una tasa del 40 % no llega a la base: el CHECK habría dado un error de driver', async () => {
    const r = await correr([
      'isn', 'rate', 'set', 'ZW', '40%',
      '--effective-from', '2026-01-01',
      '--legal-basis', CITA,
      ...comunes(),
    ]);
    expect(r.salida).toBe(2);
    expect(r.dicho).toMatch(/above the 0\.15 ceiling/);
    expect(await vigenciasZW()).toEqual([]);
  });

  it('sin un «sí» no se captura: la confirmación va ANTES de la escritura', async () => {
    const r = await correr(
      ['isn', 'rate', 'set', 'ZW', '3%', '--effective-from', '2026-01-01',
       '--legal-basis', CITA, ...comunes()],
      false
    );
    expect(r.salida).toBe(10);
    expect(await vigenciasZW()).toEqual([]);
  });

  it('con el «sí» sí captura, y una sola vez', async () => {
    const r = await correr(
      ['isn', 'rate', 'set', 'ZW', '3%', '--effective-from', '2026-01-01',
       '--legal-basis', CITA, ...comunes()],
      true
    );
    expect(r.salida).toBe(0);
    expect(await vigenciasZW()).toEqual([{ desde: '2026-01-01', tasa: '0.030000' }]);
  });

  it('una vigencia solapada se rechaza SIN gastar la confirmación, y no deja fila', async () => {
    // Confirmación amarrada a «sí»: si la guarda de solape no existiera, esto
    // escribiría y el disparador de la 067 sería quien lo parase — con el mismo
    // código de salida. Lo que distingue una cosa de la otra es que la capa
    // NOMBRA la vigencia con la que se choca y NO gasta la pregunta: el
    // disparador no puede hacer ni lo uno ni lo otro. Sin estas dos
    // aserciones, borrar la guarda no rompería nada.
    const r = await correr(
      ['isn', 'rate', 'set', 'ZW', '4%', '--effective-from', '2026-06-01',
       '--legal-basis', CITA, ...comunes()],
      true
    );
    expect(r.salida).toBe(4);
    expect(r.preguntas).toBe(0);
    expect(r.dicho).toMatch(/overlapping 2026-06-01 onwards/);
    expect(r.dicho).toMatch(/2026-01-01->\(open\) at 0\.030000/);
    expect(await vigenciasZW()).toEqual([{ desde: '2026-01-01', tasa: '0.030000' }]);
  });

  it('la vigencia ADYACENTE —la que cierra el día en que abre la siguiente— sí entra', async () => {
    // El disparador declara el intervalo SEMIABIERTO. Si la capa fuese más
    // estricta que la base, el operador no podría capturar un cambio de tasa.
    await query(
      `UPDATE mx_isn_tasas_estatales SET vigencia_hasta = '2026-07-01'
        WHERE estado = 'ZW' AND vigencia_desde = '2026-01-01'`
    );
    const r = await correr(
      ['isn', 'rate', 'set', 'ZW', '4%', '--effective-from', '2026-07-01',
       '--legal-basis', CITA, ...comunes()],
      true
    );
    expect(r.salida).toBe(0);
    expect(await vigenciasZW()).toEqual([
      { desde: '2026-01-01', tasa: '0.030000' },
      { desde: '2026-07-01', tasa: '0.040000' },
    ]);
  });

  it('el inquilino de la sesión no puede nombrar la entidad de otro', async () => {
    const otro = await montar('F08a ataque2 · CLI · el otro inquilino');
    const r = await correr([
      'isn', 'rate', 'set', 'ZV', '3%',
      '--effective-from', '2026-01-01',
      '--legal-basis', CITA,
      '--tenant', e.f.tenantId,
      '--entity', otro.f.entityId,
      '--user', correo,
    ]);
    // Se exige el MENSAJE de la guarda de contexto y no un «falló y ya»:
    // debajo hay una red genérica (el usuario de --user tampoco existe en el
    // otro inquilino) que rechaza igual y no dice nada de la frontera. Sin
    // esta aserción, quitar la guarda no rompería la prueba.
    expect(r.salida).not.toBe(0);
    expect(r.dicho).toContain(otro.f.tenantId);
    expect(r.dicho).toContain(e.f.tenantId);
    expect(r.dicho).toMatch(/pertenece al inquilino/);
    const { rows } = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM mx_isn_tasas_estatales WHERE estado = 'ZV'`
    );
    expect(rows[0].n).toBe('0');
  });
});

// ============================================================
// 7 · LO QUE SÍ AGUANTA: EL PASIVO PATRONAL NO CRUZA EL INQUILINO
//
// El recibo ajeno del bloque 1 se cuela en la corrida, pero el acumulador lo
// deja fuera porque su suma lleva `p.tenant_id = $1` DENTRO del SQL. Se
// comprueba con el recibo ajeno ya colado, que es el único caso en que la
// diferencia se puede medir.
// ============================================================
describe('7 · el pasivo patronal no se cruza entre inquilinos', () => {
  let uno: Escenario;
  let dos: Escenario;

  beforeAll(async () => {
    uno = await montar('F08a ataque2 · pasivo A', { estadoCorrida: 'approved' });
    dos = await montar('F08a ataque2 · pasivo B');
    await reciboManual(uno, '80000.00', '8888.11', '4444.22');
    // El recibo del inquilino DOS, colado en la corrida del inquilino UNO por
    // el agujero del bloque 1. Su IMSS patronal es reconocible al centavo.
    await query(
      `INSERT INTO paychecks (id, tenant_id, pay_run_id, employee_id,
         gross_earnings, imss_employer, infonavit_employer, net_pay)
       VALUES ($1, $2, $3, $4, 10000, 7777.77, 3333.33, 9000)`,
      [uuidv4(), dos.f.tenantId, uno.payRunId, dos.empleadoId]
    );
  });

  it('el IMSS patronal del recibo ajeno NO entra en el pasivo del que cierra', async () => {
    const r = await acumularPasivoPatronal({ tenantId: uno.f.tenantId, payRunId: uno.payRunId });
    const imss = r.renglones.find((x) => x.taxType === 'imss_employer');
    // 8888.11 y no 16665.88: la suma acota el inquilino dentro de la consulta.
    expect(imss?.importe).toBe('8888.11');
  });

  it('y una acumulación no alcanza la corrida de otro inquilino', async () => {
    await expect(
      acumularPasivoPatronal({ tenantId: dos.f.tenantId, payRunId: uno.payRunId })
    ).rejects.toThrow(/No existe la corrida/);
  });
});
