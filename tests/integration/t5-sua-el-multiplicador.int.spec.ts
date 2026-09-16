import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query, closeDatabase } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { generateSuaFile } from '../../src/services/payroll/mx/sua-generator.js';

/**
 * T5·SUA (#92) · EL ARCHIVO QUE SE LE ENTREGA AL IMSS MULTIPLICA LAS CUOTAS.
 *
 * Esto no necesita un atacante ni un dato mal tecleado: está roto por omisión,
 * para todo el mundo, desde la línea base. `sua-generator.ts` acota el mes y el
 * estado de la corrida en los `ON` de dos `LEFT JOIN` POSTERIORES al de los
 * recibos, así que esas condiciones no descartan el recibo: lo dejan con
 * `pr`/`pp` en NULL y `p` intacto. Los `SUM(p.imss_*)` suman la historia entera
 * del empleado; los días salen de `pp`, que sí se anula, y por eso SÍ quedan
 * acotados al mes.
 *
 * La asimetría es el síntoma legible: 31 días cotizados junto a la cuota de
 * N quincenas. Y ese archivo es el que el patrón carga en el SUA para pagarle
 * al IMSS y al INFONAVIT.
 */

let f: Fixture;
const EMPLEADO = randomUUID();
const HORARIO = randomUUID();
/** Sólo tiene un recálculo en borrador: no le corresponde cuota ninguna. */
const SOLO_BORRADOR = randomUUID();
/** Calendario SEMANAL, para la semana que cruza el cambio de mes. */
const SEMANAL = randomUUID();
const A_CABALLO = randomUUID();

const CUOTA = { imssEe: '100.00', imssEr: '500.00', infEe: '50.00', infEr: '250.00' };

async function altaEmpleado(
  id: string,
  nombre: string,
  rfc: string,
  curp: string,
  nss: string
): Promise<void> {
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, rfc, curp, nss, sbc, annual_salary, status)
     VALUES ($1,$2,$3,$4,$5,'Hopper','2024-01-01','MX',$6,$7,$8, 500, 182500, 'active')`,
    [id, f.tenantId, f.entityId, `E-${id.slice(0, 8)}`, nombre, rfc, curp, nss]
  );
}

/** Una corrida con su recibo sobre un periodo YA creado. */
async function corridaSobre(
  periodo: string,
  estado: 'approved' | 'paid' | 'draft',
  empleado: string = EMPLEADO
): Promise<void> {
  const corrida = randomUUID();
  await query(
    `INSERT INTO pay_runs (id, tenant_id, pay_period_id, status, tax_year_used,
       total_gross, total_pre_tax_deductions, total_net_pay, total_employee_taxes,
       total_employer_taxes, total_post_tax_deductions)
     VALUES ($1,$2,$3,$4,2026, 10000, 0, 8500, 1500, 0, 0)`,
    [corrida, f.tenantId, periodo, estado]
  );
  await query(
    `INSERT INTO paychecks (id, tenant_id, pay_run_id, employee_id, gross_earnings, net_pay,
       imss_employee, imss_employer, infonavit_withheld, infonavit_employer)
     VALUES ($1,$2,$3,$4, 10000, 8500, $5, $6, $7, $8)`,
    [randomUUID(), f.tenantId, corrida, empleado, CUOTA.imssEe, CUOTA.imssEr, CUOTA.infEe, CUOTA.infEr]
  );
}

/**
 * Una quincena cerrada: su periodo, su corrida y su recibo.
 *
 * El periodo se crea aquí y se devuelve porque `pay_periods` lleva único sobre
 * `(pay_schedule_id, period_start)`: un calendario no puede tener dos quincenas
 * que empiecen el mismo día. Una segunda corrida del MISMO periodo —un
 * recálculo en borrador— cuelga del periodo que esto devuelve.
 */
async function quincena(
  inicio: string,
  fin: string,
  estado: 'approved' | 'paid' | 'draft'
): Promise<string> {
  const periodo = randomUUID();
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year)
     VALUES ($1,$2,$3,$4,$5,$5,2026)`,
    [periodo, f.tenantId, HORARIO, inicio, fin]
  );
  await corridaSobre(periodo, estado);
  return periodo;
}

beforeAll(async () => {
  f = await crearInquilino('T5 SUA');
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, country_code, rfc, curp, nss, sbc, annual_salary, status)
     VALUES ($1,$2,$3,$4,'Ada','Lovelace','2024-01-01','MX','AAAA010101AAA',
             'AAAA010101HDFAAA01','12345678901', 500, 182500, 'active')`,
    [EMPLEADO, f.tenantId, f.entityId, `E-${EMPLEADO.slice(0, 8)}`]
  );
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start)
     VALUES ($1,$2,$3,'Quincenal','quincenal','MX','2026-01-01')`,
    [HORARIO, f.tenantId, f.entityId]
  );

  // Las DOS quincenas de marzo: lo único que el archivo de marzo debe declarar.
  const primeraDeMarzo = await quincena('2026-03-01', '2026-03-15', 'approved');
  await quincena('2026-03-16', '2026-03-31', 'approved');
  // Enero y febrero: meses ya declarados y pagados. No son de este archivo.
  await quincena('2026-01-01', '2026-01-15', 'paid');
  await quincena('2026-01-16', '2026-01-31', 'paid');
  await quincena('2026-02-01', '2026-02-15', 'paid');
  await quincena('2026-02-16', '2026-02-28', 'paid');
  // Y un RECÁLCULO en borrador sobre la primera quincena de marzo: es la forma
  // normal de tener dos corridas sobre un mismo periodo, y un borrador no se le
  // paga al IMSS.
  await corridaSobre(primeraDeMarzo, 'draft');

  // Un segundo empleado cuyo ÚNICO movimiento de marzo es ese borrador. Sin
  // él, «el borrador no entra» se cumpliría por accidente en cuanto el total
  // del primero fuese correcto por otras razones.
  await altaEmpleado(SOLO_BORRADOR, 'Grace', 'BBBB010101BBB', 'BBBB010101HDFBBB02', '10987654321');
  await corridaSobre(primeraDeMarzo, 'draft', SOLO_BORRADOR);

  // Y un tercero en calendario SEMANAL con una semana a caballo entre febrero
  // y marzo. Esto NO es el defecto que este tramo arregla: se mide para saber
  // si existe.
  await altaEmpleado(A_CABALLO, 'Edith', 'CCCC010101CCC', 'CCCC010101HDFCCC03', '11223344556');
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code, first_period_start)
     VALUES ($1,$2,$3,'Semanal','weekly','MX','2026-01-01')`,
    [SEMANAL, f.tenantId, f.entityId]
  );
  const semana = randomUUID();
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end, pay_date, tax_year)
     VALUES ($1,$2,$3,'2026-02-25','2026-03-03','2026-03-03',2026)`,
    [semana, f.tenantId, SEMANAL]
  );
  await corridaSobre(semana, 'approved', A_CABALLO);
}, 180_000);

afterAll(async () => {
  await closeDatabase();
});

/** Los enteros de centavos que el archivo escribe, por posición fija. */
function cuotasDelArchivo(contenido: string, nss = '12345678901'): {
  dias: number;
  imssEr: number;
  imssEe: number;
  infEr: number;
  infEe: number;
} {
  const l = contenido.split('\r\n').find((x) => x.startsWith(nss));
  if (!l) throw new Error(`el archivo no trae renglón para el NSS ${nss}`);
  // 11 NSS + 13 RFC + 18 CURP + 27×3 nombres = 123; SBC 8; días 2; luego 4×10.
  const base = 123 + 8;
  return {
    dias: parseInt(l.slice(base, base + 2), 10),
    imssEr: parseInt(l.slice(base + 2, base + 12), 10),
    imssEe: parseInt(l.slice(base + 12, base + 22), 10),
    infEr: parseInt(l.slice(base + 22, base + 32), 10),
    infEe: parseInt(l.slice(base + 32, base + 42), 10),
  };
}

describe('el archivo del SUA declara lo del mes, y sólo lo del mes', () => {
  it('las cuotas son las de marzo, no las de toda la historia del empleado', async () => {
    const { content } = await generateSuaFile(f.tenantId, f.entityId, 2026, 3);
    const v = cuotasDelArchivo(content);

    // Dos quincenas aprobadas de marzo × 500.00 patronales = 1 000.00 → 100000 centavos.
    expect(v.imssEr, 'IMSS patronal').toBe(100000);
    expect(v.imssEe, 'IMSS obrero').toBe(20000);
    expect(v.infEr, 'INFONAVIT patronal').toBe(50000);
    expect(v.infEe, 'INFONAVIT obrero').toBe(10000);
  }, 120_000);

  it('los días y las cuotas hablan del MISMO mes', async () => {
    // La asimetría es el síntoma legible: los días salen de `pay_periods`, que
    // sí se acota, y las cuotas de `paychecks`, que no. 31 días junto a la
    // cuota de seis quincenas es un archivo que se contradice a sí mismo.
    const { content } = await generateSuaFile(f.tenantId, f.entityId, 2026, 3);
    const v = cuotasDelArchivo(content);
    expect(v.dias, 'días cotizados de marzo').toBe(31);
    // 31 días son dos quincenas: la cuota no puede ser de más de dos.
    expect(v.imssEr / 50000, 'quincenas implicadas por la cuota patronal').toBe(2);
  }, 120_000);

  it('una corrida en borrador no se le paga al IMSS, ni siquiera cuando es lo único que hay', async () => {
    const { content } = await generateSuaFile(f.tenantId, f.entityId, 2026, 3);
    // El empleado cuyo único movimiento de marzo es un recálculo en borrador
    // sale en el archivo —la plantilla no se encoge— y sale EN CEROS.
    const v = cuotasDelArchivo(content, '10987654321');
    expect(v.imssEr, 'el borrador se declaró como cuota').toBe(0);
    expect(v.imssEe).toBe(0);
    expect(v.dias, 'días de un borrador').toBe(0);
  }, 120_000);
});

/**
 * LO QUE ESTE TRAMO NO ARREGLA, MEDIDO Y ESCRITO.
 *
 * Un periodo que cruza el cambio de mes no cumple `period_start >= $3` para el
 * mes que termina ni `period_end <= $4` para el que empieza, así que sus cuotas
 * no se declaran en NINGUNO de los dos. No es el defecto de este tramo —aquél
 * declaraba de MÁS, éste declara de MENOS— y no se arregla aquí porque cómo se
 * reparte una semana a caballo es una decisión CONTABLE, no una de programación:
 * a prorrata por días, al mes de la fecha de pago, o al mes en que inicia. En
 * esta casa una bifurcación de criterio no se elige en el código, se añade al
 * panel. Esta prueba fija lo que hoy pasa para que el día que se conteste se
 * vea cambiar.
 */
describe('la semana a caballo entre dos meses: no se arregla aquí, pero no se calla', () => {
  it('sus cuotas no entran en el archivo de ningún mes', async () => {
    const marzo = await generateSuaFile(f.tenantId, f.entityId, 2026, 3);
    const febrero = await generateSuaFile(f.tenantId, f.entityId, 2026, 2);
    expect(cuotasDelArchivo(marzo.content, '11223344556').imssEr, 'marzo').toBe(0);
    expect(cuotasDelArchivo(febrero.content, '11223344556').imssEr, 'febrero').toBe(0);
    // Y el recibo existe y está aprobado: 500.00 patronales de nadie.
    const { rows } = await query<{ suma: string }>(
      `SELECT COALESCE(SUM(p.imss_employer), 0)::text AS suma
         FROM paychecks p
         JOIN pay_runs pr ON pr.id = p.pay_run_id
        WHERE p.employee_id = $1 AND pr.status = 'approved'`,
      [A_CABALLO]
    );
    expect(rows[0].suma).toBe('500.00');
  }, 120_000);

  it('y en cuanto el pasivo del mes está apuntado, el archivo se NIEGA a salir', async () => {
    // El acumulador atribuye el periodo al mes por su fecha de CIERRE, así que
    // la semana del 25-feb al 3-mar es marzo para los libros y de nadie para el
    // archivo. Con el renglón apuntado, el cotejo lo ve y no entrega nada:
    // entregar un archivo que contradice los propios libros del patrón es
    // exactamente lo que este cotejo existe para impedir.
    const declaraciones = async (): Promise<number> => {
      const { rows } = await query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM tax_form_filings
          WHERE tenant_id = $1 AND form_type = 'sua' AND period = '03'`,
        [f.tenantId]
      );
      return Number(rows[0].n);
    };
    // Las pruebas de arriba ya escribieron las suyas: lo que se afirma es que
    // ESTA llamada no añade ninguna, no que no haya ninguna.
    const antes = await declaraciones();
    await query(
      `INSERT INTO employer_tax_liabilities (tenant_id, entity_id, pay_run_id, tax_type,
         jurisdiction, period_start, period_end, amount, due_date, deposit_frequency, status)
       VALUES ($1,$2,NULL,'imss_employer','MX','2026-03-01','2026-03-31',$3,'2026-04-17','monthly','pending')`,
      [f.tenantId, f.entityId, '1500.00']
    );
    try {
      await expect(generateSuaFile(f.tenantId, f.entityId, 2026, 3)).rejects.toThrow(
        /no cuadra con el pasivo patronal/
      );
      // Y no queda declaración escrita: un 'draft' descuadrado es el archivo
      // que alguien acaba subiendo al SUA sin volver a mirarlo.
      expect(await declaraciones(), 'se persistió una declaración descuadrada').toBe(antes);
    } finally {
      // En `finally` a propósito: si la aserción de arriba cae, el renglón
      // tiene que desaparecer igual o contamina la prueba siguiente — que es
      // exactamente lo que pasó la primera vez que escribí esto.
      await query(`DELETE FROM employer_tax_liabilities WHERE tenant_id = $1`, [f.tenantId]);
    }
  }, 120_000);

  it('sin pasivo apuntado se avisa, pero no se bloquea: ausencia no es discrepancia', async () => {
    const r = await generateSuaFile(f.tenantId, f.entityId, 2026, 3);
    const aviso = r.hallazgos.find((h) => h.codigo === 'sin_pasivo_que_cotejar');
    expect(aviso, 'nadie avisó de que la cifra no la confirma nadie').toBeTruthy();
    expect(aviso!.bloquea).toBe(false);
  }, 120_000);
});
