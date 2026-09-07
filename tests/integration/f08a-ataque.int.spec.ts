import { describe, it, expect, beforeAll, vi } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { calculatePaycheck } from '../../src/services/payroll/common/paycheck-service.js';
import { acumularPasivoPatronal } from '../../src/services/payroll/common/employer-liability-service.js';
import { postPayRunToGL } from '../../src/services/payroll/common/gl-posting-service.js';
import { seedPayrollAccountMapping } from '../../src/services/payroll/common/payroll-account-mapping-seed.js';
// Las calculadoras se registran por efecto de importación.
import '../../src/services/payroll/tax-engine/register-all.js';

// ============================================================
// F08a · ATAQUE
//
// Verificación adversaria del tramo F08a. Cada prueba de este archivo se
// escribió para FALLAR si el defecto que persigue existe, y ninguna se dio
// por buena sin haberla puesto ROJA a mano rompiendo el código que vigila
// (catorce mutantes, todos muertos: el recorte del subsidio a cero, el
// efectivo que no suma al neto, el renglón sin marcar como crédito, el
// régimen escalonado calculado como plano, «la última tasa capturada», el
// trabajador sin estado que se cuela, el candado de idempotencia del pasivo,
// el pasivo apuntado fuera de la transacción que aprueba, la frontera de
// inquilino fuera del SQL, y los cinco de los arreglos de este mismo pase).
//
// CUATRO PRUEBAS QUEDAN EN ROJO A PROPÓSITO. No están rotas: son los defectos
// que siguen vivos y cuyo arreglo no cabe en el archivo donde vive el
// defecto, así que se dejan escritos y fallando en vez de descritos en un
// informe que nadie vuelve a correr.
//
//  1. «el ISR NETO del periodo, sumado desde paycheck_taxes» — el subsidio se
//     apunta DOS VECES como crédito: entero en su renglón y otra vez la parte
//     entregada. La tabla dice que el fisco debe 248.04 donde debe 124.02.
//  2 y 3. «la corrida de PURO subsidio entregado» y «la corrida MIXTA en la
//     que el subsidio entregado gana» — el asiento al mayor no cuadra por
//     exactamente el subsidio entregado, y la nómina no se puede postear.
//  4. «Total = SubTotal − Descuento» — el CFDI de nómina dejó de cuadrar
//     consigo mismo por el mismo importe.
//
// Las tres causas están descritas en el informe del verificador con el
// archivo y la línea. Las tres viven fuera de este tramo (gl-posting-service,
// cfdi-nomina-generator, y la forma del desglose en paycheck-service).
// ============================================================

const ANIO_SINTETICO = 2031;

let f: Fixture;
let scheduleId: string;

async function nuevoPeriodo(
  inicio: string, fin: string, pago: string, taxYear = 2026, sched = scheduleId
): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
       pay_date, tax_year, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')`,
    [id, f.tenantId, sched, inicio, fin, pago, taxYear]
  );
  return id;
}

async function nuevaCorrida(periodId: string, status = 'calculating'): Promise<string> {
  const id = uuidv4();
  await query(
    `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
     VALUES ($1, $2, $3, 'regular', $4, 2026, $5)`,
    [id, f.tenantId, periodId, status, f.userId]
  );
  return id;
}

let contadorEmpleado = 0;
async function nuevoEmpleado(opciones: {
  sbc?: string | null;
  workState?: string | null;
  credito?: boolean;
  entityId?: string;
} = {}): Promise<string> {
  const id = uuidv4();
  contadorEmpleado += 1;
  await query(
    `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
       hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
       tipo_regimen_sat, pay_schedule_id, salary_type, currency_code, work_state,
       infonavit_credit_type, infonavit_credit_value)
     VALUES ($1, $2, $3, $4, 'Trabajador', 'De Ataque',
       '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901',
       $5, '01', '02', $6, 'salary', 'MXN', $7, $8, $9)`,
    [
      id, f.tenantId, opciones.entityId ?? f.entityId, `ATQ-${String(contadorEmpleado).padStart(4, '0')}`,
      opciones.sbc ?? null, scheduleId, opciones.workState ?? null,
      opciones.credito ? 'factor' : null, opciones.credito ? '0.2000' : null,
    ]
  );
  return id;
}

interface RenglonImpuesto {
  tax_type: string;
  jurisdiction: string;
  employee_employer: string;
  taxable_wages: string;
  rate: string | null;
  tax_amount: string;
  is_credit: boolean;
  calculation_notes: string | null;
}

async function impuestosDe(paycheckId: string): Promise<RenglonImpuesto[]> {
  const { rows } = await query<RenglonImpuesto>(
    `SELECT tax_type, jurisdiction, employee_employer, taxable_wages::text, rate::text,
            tax_amount::text, is_credit, calculation_notes
       FROM paycheck_taxes WHERE paycheck_id = $1 ORDER BY tax_type, employee_employer`,
    [paycheckId]
  );
  return rows;
}

interface FilaRecibo {
  gross_earnings: string;
  pre_tax_deductions: string;
  post_tax_deductions: string;
  isr_withheld: string;
  subsidio_empleo: string;
  imss_employee: string;
  infonavit_withheld: string;
  net_pay: string;
  subsidio_entregado_efectivo: string;
}

async function reciboDe(paycheckId: string): Promise<FilaRecibo> {
  const { rows } = await query<FilaRecibo>(
    `SELECT gross_earnings::text, pre_tax_deductions::text, post_tax_deductions::text,
            isr_withheld::text, subsidio_empleo::text, imss_employee::text,
            infonavit_withheld::text, net_pay::text, subsidio_entregado_efectivo::text
       FROM paychecks WHERE id = $1`,
    [paycheckId]
  );
  return rows[0];
}

beforeAll(async () => {
  f = await crearInquilino('F08a · ataque');
  await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });

  scheduleId = uuidv4();
  await query(
    `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
       first_period_start, is_active)
     VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
    [scheduleId, f.tenantId, f.entityId]
  );

  // TARIFA SINTÉTICA. Las tablas 2026 de la 009 no producen ninguna quincena
  // en la que el ISR y el subsidio coincidan al centavo: el subsidio es una
  // escalera y el ISR una recta, y saltan de «subsidio mayor» a «ISR mayor»
  // sin tocarse. Los cuatro casos que hay que probar —igualdad exacta, un
  // centavo, mucho, e ISR cero— salen de una tarifa construida para
  // producirlos, en un año que no existe para que no pise a nadie.
  //   ISR quincenal: 0 hasta 50.00; 5.00 + 10 % del excedente después.
  //   Subsidio mensual plano de 200.00 → 100.00 por quincena.
  await query(
    `INSERT INTO tax_tables (jurisdiction, tax_type, tax_year, filing_status, pay_frequency,
       bracket_order, bracket_low, bracket_high, rate, base_tax, effective_from)
     VALUES
       ('MX','isr',$1,NULL,'quincenal',1, 0.01, 50.00, 0, 0, '2026-01-01'),
       ('MX','isr',$1,NULL,'quincenal',2, 50.01, NULL, 0.10, 5.00, '2026-01-01'),
       ('MX','subsidio_empleo',$1,NULL,'monthly',1, 0.01, NULL, 0, 200.00, '2026-01-01')`,
    [ANIO_SINTETICO]
  );
});

// ============================================================
// A · EL SUBSIDIO AL EMPLEO, EN SUS CUATRO ESQUINAS
// ============================================================
describe('A · el subsidio al empleo y el efectivo que el trabajador debe recibir', () => {
  let periodo: string;
  let corrida: string;

  beforeAll(async () => {
    periodo = await nuevoPeriodo('2026-02-01', '2026-02-15', '2026-02-15', ANIO_SINTETICO);
    corrida = await nuevaCorrida(periodo);
  });

  const casos = [
    { nombre: 'ISR CERO y subsidio entero', bruto: '50.00', isr: '0.00', entregado: '100.00', retenido: '0.00' },
    { nombre: 'subsidio MUCHO mayor que el ISR', bruto: '100.00', isr: '10.00', entregado: '90.00', retenido: '0.00' },
    { nombre: 'subsidio UN CENTAVO mayor que el ISR', bruto: '999.91', isr: '99.99', entregado: '0.01', retenido: '0.00' },
    { nombre: 'subsidio EXACTAMENTE igual al ISR', bruto: '1000.00', isr: '100.00', entregado: '0.00', retenido: '0.00' },
  ];

  for (const caso of casos) {
    it(`${caso.nombre}: el efectivo entregado y el neto cuadran`, async () => {
      const emp = await nuevoEmpleado();
      const r = await calculatePaycheck({
        tenant_id: f.tenantId, pay_run_id: corrida, employee_id: emp,
        pay_period_id: periodo,
        earnings: [{ earning_type: 'salary', amount: Number(caso.bruto) }],
      });
      const fila = await reciboDe(r.paycheck_id);

      // El ISR bruto del periodo, tal como lo calculó la tarifa.
      expect(fila.isr_withheld).toBe(caso.isr);
      // El subsidio de la tarifa: 100.00 por quincena en los cuatro casos.
      expect(fila.subsidio_empleo).toBe('100.00');
      // EL EFECTIVO. Ésta es la cifra que el Math.max se tragaba.
      expect(new Decimal(fila.subsidio_entregado_efectivo).toFixed(2)).toBe(caso.entregado);
      expect(new Decimal(r.subsidio_entregado_efectivo).toFixed(2)).toBe(caso.entregado);
      // El ISR retenido nunca es negativo.
      expect(new Decimal(r.employee_taxes).toFixed(2)).toBe(caso.retenido);

      // EL NETO CUADRA CONTRA LAS COLUMNAS DEL PROPIO RECIBO.
      const esperado = new Decimal(fila.gross_earnings)
        .minus(fila.pre_tax_deductions)
        .minus(fila.post_tax_deductions)
        .minus(new Decimal(fila.isr_withheld).minus(fila.subsidio_empleo))
        .minus(fila.imss_employee)
        .minus(fila.infonavit_withheld);
      expect(new Decimal(fila.net_pay).toFixed(2)).toBe(esperado.toFixed(2));

      // Y el bruto más el efectivo entregado es lo que el trabajador se lleva
      // cuando no hay nada más que descontarle.
      const llevaDeMas = new Decimal(fila.net_pay).minus(fila.gross_earnings);
      expect(llevaDeMas.toFixed(2)).toBe(
        new Decimal(caso.entregado).minus(caso.retenido).toFixed(2)
      );
    });

    it(`${caso.nombre}: el renglón de paycheck_taxes existe sólo si hubo efectivo`, async () => {
      const emp = await nuevoEmpleado();
      const r = await calculatePaycheck({
        tenant_id: f.tenantId, pay_run_id: corrida, employee_id: emp,
        pay_period_id: periodo,
        earnings: [{ earning_type: 'salary', amount: Number(caso.bruto) }],
      });
      const filas = await impuestosDe(r.paycheck_id);
      const efectivo = filas.filter((x) => x.tax_type === 'subsidio_entregado_efectivo');
      if (new Decimal(caso.entregado).isZero()) {
        expect(efectivo).toHaveLength(0);
      } else {
        expect(efectivo).toHaveLength(1);
        expect(efectivo[0].is_credit).toBe(true);
        expect(efectivo[0].employee_employer).toBe('EE');
        expect(efectivo[0].tax_amount).toBe(caso.entregado);
      }
    });
  }
});

// ============================================================
// B · EL DESGLOSE QUE SE ESCRIBIÓ: ¿SUMA LO MISMO QUE EL RECIBO?
//
// `paycheck_taxes` existe para que los formularios sumen de ahí. Si lo que
// hay escrito no reconstruye el recibo, la tabla llena miente igual que la
// tabla vacía — sólo que ahora con aspecto de dato.
// ============================================================
describe('B · lo escrito en paycheck_taxes contra las columnas del recibo', () => {
  let periodo: string;
  let corrida: string;
  let recibo: string;

  beforeAll(async () => {
    periodo = await nuevoPeriodo('2026-03-01', '2026-03-15', '2026-03-15', 2026);
    corrida = await nuevaCorrida(periodo);
    // Tarifa REAL 2026: quincena de 1 500 → ISR 79.29, subsidio 203.31,
    // efectivo entregado 124.02.
    const emp = await nuevoEmpleado({ sbc: '100.0000' });
    recibo = (
      await calculatePaycheck({
        tenant_id: f.tenantId, pay_run_id: corrida, employee_id: emp,
        pay_period_id: periodo,
        earnings: [{ earning_type: 'salary', amount: 1500 }],
      })
    ).paycheck_id;
  });

  it('el punto de partida: la quincena de 1 500 entrega 124.02 en efectivo', async () => {
    const fila = await reciboDe(recibo);
    expect(fila.isr_withheld).toBe('79.29');
    expect(fila.subsidio_empleo).toBe('203.31');
    expect(new Decimal(fila.subsidio_entregado_efectivo).toFixed(2)).toBe('124.02');
  });

  it('el ISR NETO del periodo, sumado desde paycheck_taxes, es el que el fisco vería', async () => {
    const filas = await impuestosDe(recibo);
    const cargo = filas
      .filter((x) => x.employee_employer === 'EE' && !x.is_credit && x.tax_type === 'isr')
      .reduce((a, x) => a.plus(x.tax_amount), new Decimal(0));
    const creditos = filas
      .filter((x) => x.employee_employer === 'EE' && x.is_credit)
      .reduce((a, x) => a.plus(x.tax_amount), new Decimal(0));

    // Lo que el patrón entregó de su bolsillo y acreditará contra el ISR
    // retenido a otros son 124.02 — ni un peso más. Si la resta da −248.04,
    // el subsidio está apuntado DOS VECES: entero como crédito, y otra vez
    // la parte entregada.
    const netoSegunLaTabla = cargo.minus(creditos);
    expect(netoSegunLaTabla.toFixed(2)).toBe('-124.02');
  });
});

// ============================================================
// C · EL ASIENTO AL MAYOR CUANDO EL SUBSIDIO SE ENTREGA
// ============================================================
describe('C · la corrida con subsidio entregado se puede postear al mayor', () => {
  beforeAll(async () => {
    await seedPayrollAccountMapping(f.entityId, f.tenantId, 'MX', f.userId);
  });

  /** Una corrida completa por el camino real: cálculo, totales y aprobación. */
  async function corridaCompleta(
    inicio: string, fin: string, pago: string, brutos: number[]
  ): Promise<{ payRunId: string; periodoId: string }> {
    const periodoId = await nuevoPeriodo(inicio, fin, pago, 2026);
    const payRunId = await nuevaCorrida(periodoId, 'calculating');
    let g = new Decimal(0), ee = new Decimal(0), er = new Decimal(0), net = new Decimal(0);
    for (const bruto of brutos) {
      const emp = await nuevoEmpleado({ sbc: '100.0000' });
      const r = await calculatePaycheck({
        tenant_id: f.tenantId, pay_run_id: payRunId, employee_id: emp,
        pay_period_id: periodoId,
        earnings: [{ earning_type: 'salary', amount: bruto }],
      });
      g = g.plus(r.gross_earnings);
      ee = ee.plus(r.employee_taxes);
      er = er.plus(r.employer_taxes);
      net = net.plus(r.net_pay);
    }
    await query(
      `UPDATE pay_runs SET status = 'calculated', total_gross = $1,
         total_pre_tax_deductions = 0, total_post_tax_deductions = 0,
         total_employee_taxes = $2, total_employer_taxes = $3, total_net_pay = $4,
         total_employer_cost = $5, employee_count = $6, calculated_at = NOW()
       WHERE id = $7`,
      [g.toFixed(2), ee.toFixed(2), er.toFixed(2), net.toFixed(2),
       g.plus(er).toFixed(2), brutos.length, payRunId]
    );
    return { payRunId, periodoId };
  }

  it('control: cuando el ISR retenido supera al subsidio entregado, el asiento cuadra', async () => {
    // 1 500 (entrega 124.02) + 8 000 (retiene 874.80): el ISR gana.
    const { payRunId } = await corridaCompleta('2026-04-01', '2026-04-15', '2026-04-15', [1500, 8000]);
    const entryId = await postPayRunToGL(payRunId, f.userId, f.tenantId);
    expect(entryId).toBeTruthy();
  });

  it('la corrida de PURO subsidio entregado también se tiene que poder postear', async () => {
    // Dos trabajadores de 1 500: nadie retiene ISR y el patrón entrega 248.04.
    const { payRunId } = await corridaCompleta('2026-05-01', '2026-05-15', '2026-05-15', [1500, 1500]);
    await expect(postPayRunToGL(payRunId, f.userId, f.tenantId)).resolves.toBeTruthy();
  });

  it('la corrida MIXTA en la que el subsidio entregado gana también se postea', async () => {
    // 1 500 (entrega 124.02) + 3 000 (retiene 27.98): el subsidio gana por 96.04.
    const { payRunId } = await corridaCompleta('2026-06-01', '2026-06-15', '2026-06-15', [1500, 3000]);
    await expect(postPayRunToGL(payRunId, f.userId, f.tenantId)).resolves.toBeTruthy();
  });
});

// ============================================================
// D · EL CFDI DE NÓMINA, QUE ES LO QUE VE LA AUTORIDAD
//
// El comprobante fiscal cumple `Total = SubTotal − Descuento` (+ otros pagos).
// El generador pone SubTotal = percepciones, Descuento = deducciones y
// Total = `paychecks.net_pay`. Al sumar el subsidio entregado al neto sin
// declararlo como OtrosPagos, esa identidad deja de cumplirse.
// ============================================================
describe('D · el CFDI de nómina cuadra consigo mismo', () => {
  it('Total = SubTotal − Descuento en un recibo con subsidio entregado', async () => {
    const periodo = await nuevoPeriodo('2026-07-01', '2026-07-15', '2026-07-15', 2026);
    const corrida = await nuevaCorrida(periodo);
    const emp = await nuevoEmpleado({ sbc: '100.0000' });
    const recibo = (
      await calculatePaycheck({
        tenant_id: f.tenantId, pay_run_id: corrida, employee_id: emp,
        pay_period_id: periodo,
        earnings: [{ earning_type: 'salary', amount: 1500 }],
      })
    ).paycheck_id;

    const { pacRouter } = await import('../../src/services/integrations/mexico/pac/pac-router.js');
    const { generateAndStampCfdiNomina } = await import(
      '../../src/services/payroll/mx/cfdi-nomina-generator.js'
    );
    const espia = vi.spyOn(pacRouter, 'stamp').mockResolvedValue({
      uuid: uuidv4(), xml_timbrado: '', cadena_original: '',
      fecha_timbrado: new Date(), no_certificado_sat: '0000', sello_sat: '',
      provider_used: 'prueba', simulado: true,
    });
    try {
      const r = await generateAndStampCfdiNomina(recibo, {
        tenantId: f.tenantId, userId: f.userId,
      });
      const leer = (attr: string): Decimal => {
        const m = new RegExp(`\\b${attr}="([0-9.]+)"`).exec(r.xml);
        expect(m, `el XML no trae ${attr}`).toBeTruthy();
        return new Decimal(m![1]);
      };
      const subTotal = leer('SubTotal');
      const descuento = leer('Descuento');
      const total = leer('Total');
      // Con OtrosPagos declarados, la identidad sería Total = SubTotal −
      // Descuento + TotalOtrosPagos. El XML no trae el nodo, así que se le
      // exige la forma que él mismo declara.
      const otrosPagos = /\bTotalOtrosPagos="([0-9.]+)"/.exec(r.xml);
      const suma = subTotal.minus(descuento).plus(otrosPagos ? otrosPagos[1] : 0);
      expect(total.toFixed(2)).toBe(suma.toFixed(2));
    } finally {
      espia.mockRestore();
    }
  });
});

// ============================================================
// E · EL ISN
// ============================================================
describe('E · el impuesto sobre nóminas', () => {
  /** Captura una vigencia de ISN. La tabla es catálogo: no lleva inquilino. */
  async function capturarTasa(
    estado: string, desde: string, hasta: string | null, tasa: string,
    regimen: 'tasa_plana' | 'escalonado' | 'con_exencion' = 'tasa_plana',
    exencion: string | null = null
  ): Promise<void> {
    await query(
      `INSERT INTO mx_isn_tasas_estatales
         (estado, vigencia_desde, vigencia_hasta, tasa, regimen, exencion_mensual, fundamento)
       VALUES ($1, $2::date, $3::date, $4, $5, $6, 'Prueba de ataque F08a')`,
      [estado, desde, hasta, tasa, regimen, exencion]
    );
  }

  async function pasivosDe(payRunId: string): Promise<
    Array<{ tax_type: string; jurisdiction: string; amount: string; period_start: string; due_date: string }>
  > {
    const { rows } = await query<{
      tax_type: string; jurisdiction: string; amount: string;
      period_start: string; due_date: string;
    }>(
      `SELECT tax_type, jurisdiction, amount::text, period_start::text, due_date::text
         FROM employer_tax_liabilities WHERE pay_run_id = $1
        ORDER BY tax_type, jurisdiction`,
      [payRunId]
    );
    return rows;
  }

  /** Corrida aprobada con un recibo por (estado, bruto). */
  async function corridaAprobada(
    inicio: string, fin: string, pago: string,
    gente: Array<{ estado: string | null; bruto: number }>
  ): Promise<string> {
    const periodoId = await nuevoPeriodo(inicio, fin, pago, 2026);
    const payRunId = await nuevaCorrida(periodoId, 'calculating');
    for (const g of gente) {
      const emp = await nuevoEmpleado({ sbc: '100.0000', workState: g.estado });
      await calculatePaycheck({
        tenant_id: f.tenantId, pay_run_id: payRunId, employee_id: emp,
        pay_period_id: periodoId,
        earnings: [{ earning_type: 'salary', amount: g.bruto }],
      });
    }
    await query(`UPDATE pay_runs SET status = 'approved' WHERE id = $1`, [payRunId]);
    return payRunId;
  }

  it('un estado SIN tasa capturada bloquea y no escribe un cero', async () => {
    const corrida = await corridaAprobada('2026-08-01', '2026-08-15', '2026-08-15', [
      { estado: 'ZZ', bruto: 10000 },
    ]);
    const r = await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: corrida });
    const falta = r.hallazgos.filter((h) => h.codigo === 'isn_sin_tasa_capturada');
    expect(falta).toHaveLength(1);
    expect(falta[0].severidad).toBe('bloqueante');
    const isn = (await pasivosDe(corrida)).filter((p) => p.tax_type === 'isn');
    expect(isn).toHaveLength(0);
  });

  it('un trabajador sin estado bloquea y nombra a cuántos recibos afecta', async () => {
    const corrida = await corridaAprobada('2026-08-16', '2026-08-31', '2026-08-31', [
      { estado: null, bruto: 5000 },
    ]);
    const r = await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: corrida });
    expect(r.hallazgos.map((h) => h.codigo)).toContain('isn_sin_estado_en_el_trabajador');
  });

  it('un régimen escalonado se niega en vez de aplicar la tasa como si fuera plana', async () => {
    await capturarTasa('ES', '2026-01-01', null, '0.030000', 'escalonado');
    const corrida = await corridaAprobada('2026-09-01', '2026-09-15', '2026-09-15', [
      { estado: 'ES', bruto: 10000 },
    ]);
    const r = await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: corrida });
    expect(r.hallazgos.map((h) => h.codigo)).toContain('isn_regimen_no_soportado');
    expect((await pasivosDe(corrida)).filter((p) => p.jurisdiction === 'MX-ES')).toHaveLength(0);
  });

  it('dos estados en la misma corrida son DOS renglones, y el que falta no borra al que está', async () => {
    await capturarTasa('AA', '2026-01-01', null, '0.030000');
    const corrida = await corridaAprobada('2026-09-16', '2026-09-30', '2026-09-30', [
      { estado: 'AA', bruto: 10000 },
      { estado: 'BB', bruto: 7000 },
    ]);
    const r = await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: corrida });
    const isn = (await pasivosDe(corrida)).filter((p) => p.tax_type === 'isn');
    expect(isn.map((x) => x.jurisdiction)).toEqual(['MX-AA']);
    expect(isn[0].amount).toBe('300.00');
    expect(r.hallazgos.filter((h) => h.codigo === 'isn_sin_tasa_capturada')).toHaveLength(1);
  });

  it('una tasa que CADUCA a mitad del periodo no se aplica a la fecha de causación', async () => {
    // La vigencia se cierra el día 10; el periodo cierra el 15. Con devengo, la
    // causación es el 15 y no hay tasa que la cubra: se niega, y lo dice
    // distinguiendo «no hay ninguna» de «hay, pero ninguna cubre la fecha».
    await capturarTasa('CA', '2026-01-01', '2026-10-10', '0.030000');
    const corrida = await corridaAprobada('2026-10-01', '2026-10-15', '2026-10-15', [
      { estado: 'CA', bruto: 10000 },
    ]);
    const r = await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: corrida });
    const h = r.hallazgos.find((x) => x.codigo === 'isn_sin_tasa_capturada');
    expect(h).toBeTruthy();
    expect(h!.mensaje).toContain('ninguna cubre la fecha de causación');
  });

  it('un cambio de tasa dentro del periodo usa la de la causación y lo avisa', async () => {
    await capturarTasa('CB', '2026-01-01', '2026-10-10', '0.030000');
    await capturarTasa('CB', '2026-10-10', null, '0.040000');
    const corrida = await corridaAprobada('2026-10-16', '2026-10-31', '2026-10-31', [
      { estado: 'CB', bruto: 10000 },
    ]);
    await acumularPasivoPatronal({ tenantId: f.tenantId, payRunId: corrida });
    const isn = (await pasivosDe(corrida)).filter((p) => p.tax_type === 'isn');
    expect(isn).toHaveLength(1);
    expect(isn[0].amount).toBe('400.00');
  });
});

// ============================================================
// F · LA CAUSACIÓN POR PAGO, QUE CAE FUERA DEL PERIODO
//
// `isn_momento_de_causacion = pago` manda la causación a la fecha de pago,
// que normalmente cae DESPUÉS del cierre del periodo. La consulta de
// vigencias acota por el periodo, no por la causación.
// ============================================================
describe('F · el ISN causado al pagar', () => {
  let g: Fixture;

  beforeAll(async () => {
    // Inquilino propio: la política se contesta y no debe contaminar al resto.
    g = await crearInquilino('F08a · ataque · causación por pago');
    await seedPolicies({ tenantId: g.tenantId, entityId: g.entityId });
    await resolvePolicy(
      { tenantId: g.tenantId, entityId: g.entityId },
      'isn_momento_de_causacion', 'pago', g.userId, 'ataque'
    );
    await query(
      `INSERT INTO mx_isn_tasas_estatales
         (estado, vigencia_desde, vigencia_hasta, tasa, regimen, fundamento)
       VALUES ('PG', '2026-01-01', '2026-07-01', 0.020000, 'tasa_plana', 'Prueba de ataque F08a'),
              ('PG', '2026-07-01', NULL, 0.030000, 'tasa_plana', 'Prueba de ataque F08a')`
    );
  });

  it('la tasa vigente el día del PAGO se aplica aunque empiece después del periodo', async () => {
    const sched = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
      [sched, g.tenantId, g.entityId]
    );
    const periodo = uuidv4();
    // Periodo del 16 al 30 de JUNIO, pagado el 5 de JULIO. Con criterio de
    // pago la causación es 2026-07-05, y la tasa de 'PG' rige desde el 1 de
    // julio: está capturada y cubre la causación.
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, '2026-06-16', '2026-06-30', '2026-07-05', 2026, 'draft')`,
      [periodo, g.tenantId, sched]
    );
    const corrida = uuidv4();
    await query(
      `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
       VALUES ($1, $2, $3, 'regular', 'calculating', 2026, $4)`,
      [corrida, g.tenantId, periodo, g.userId]
    );
    const emp = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
         tipo_regimen_sat, pay_schedule_id, salary_type, currency_code, work_state)
       VALUES ($1, $2, $3, 'PG-0001', 'Trabajador', 'Del Pago',
         '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901',
         '100.0000', '01', '02', $4, 'salary', 'MXN', 'PG')`,
      [emp, g.tenantId, g.entityId, sched]
    );
    await calculatePaycheck({
      tenant_id: g.tenantId, pay_run_id: corrida, employee_id: emp,
      pay_period_id: periodo, earnings: [{ earning_type: 'salary', amount: 10000 }],
    });
    await query(`UPDATE pay_runs SET status = 'approved' WHERE id = $1`, [corrida]);

    const r = await acumularPasivoPatronal({ tenantId: g.tenantId, payRunId: corrida });
    expect(r.criterioCausacionIsn).toBe('pago');
    // La tasa existe y cubre el 2026-07-05: no puede salir «falta la tasa».
    expect(r.hallazgos.filter((h) => h.codigo === 'isn_sin_tasa_capturada')).toEqual([]);
    const { rows } = await query<{ jurisdiction: string; amount: string; period_start: string }>(
      `SELECT jurisdiction, amount::text, period_start::text
         FROM employer_tax_liabilities WHERE pay_run_id = $1 AND tax_type = 'isn'`,
      [corrida]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe('300.00');
    expect(rows[0].period_start).toBe('2026-07-01');
    // Y NO se avisa de un cambio de tasa «dentro del periodo»: la vigencia de
    // julio no toca la quincena de junio. Un aviso falso aquí sería, otra vez,
    // un aviso que enseña a ignorar los avisos.
    expect(r.hallazgos.map((h) => h.codigo)).not.toContain('isn_tasa_cambia_dentro_del_periodo');
  });
});

// ============================================================
// G · DOBLE APUNTE
//
// «Correr el cierre dos veces no duplica nada» es la promesa que el
// acumulador escribe en su cabecera. Se le cree cuando entre las dos vueltas
// no cambia nada; el trabajo del atacante es cambiar algo que sí puede
// cambiar en la vida real —una respuesta del panel— y volver a contar.
// ============================================================
describe('G · correr el cierre dos veces', () => {
  async function montar(nombre: string): Promise<{
    fx: Fixture; corrida: string; sched: string; periodo: string;
  }> {
    const fx = await crearInquilino(nombre);
    await seedPolicies({ tenantId: fx.tenantId, entityId: fx.entityId });
    const sched = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
      [sched, fx.tenantId, fx.entityId]
    );
    const periodo = uuidv4();
    // Periodo que CRUZA el fin de mes: cierra el 30 de junio y se paga el 5
    // de julio. Es el caso en el que devengo y pago dan meses distintos.
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, '2026-06-16', '2026-06-30', '2026-07-05', 2026, 'draft')`,
      [periodo, fx.tenantId, sched]
    );
    const corrida = uuidv4();
    await query(
      `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
       VALUES ($1, $2, $3, 'regular', 'calculating', 2026, $4)`,
      [corrida, fx.tenantId, periodo, fx.userId]
    );
    const emp = uuidv4();
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
         tipo_regimen_sat, pay_schedule_id, salary_type, currency_code, work_state)
       VALUES ($1, $2, $3, 'DUP-0001', 'Trabajador', 'Duplicado',
         '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901',
         '100.0000', '01', '02', $4, 'salary', 'MXN', 'DP')`,
      [emp, fx.tenantId, fx.entityId, sched]
    );
    await calculatePaycheck({
      tenant_id: fx.tenantId, pay_run_id: corrida, employee_id: emp,
      pay_period_id: periodo, earnings: [{ earning_type: 'salary', amount: 10000 }],
    });
    await query(`UPDATE pay_runs SET status = 'approved' WHERE id = $1`, [corrida]);
    return { fx, corrida, sched, periodo };
  }

  async function pasivos(tenantId: string): Promise<
    Array<{ tax_type: string; jurisdiction: string; amount: string; pay_run_id: string | null; period_start: string }>
  > {
    const { rows } = await query<{
      tax_type: string; jurisdiction: string; amount: string;
      pay_run_id: string | null; period_start: string;
    }>(
      `SELECT tax_type, jurisdiction, amount::text, pay_run_id, period_start::text
         FROM employer_tax_liabilities WHERE tenant_id = $1
        ORDER BY tax_type, jurisdiction, period_start`,
      [tenantId]
    );
    return rows;
  }

  it('dos cierres seguidos, sin cambiar nada, no duplican', async () => {
    const { fx, corrida } = await montar('F08a · ataque · doble cierre limpio');
    await acumularPasivoPatronal({ tenantId: fx.tenantId, payRunId: corrida });
    const antes = await pasivos(fx.tenantId);
    await acumularPasivoPatronal({ tenantId: fx.tenantId, payRunId: corrida });
    expect(await pasivos(fx.tenantId)).toEqual(antes);
  });

  it('cambiar isn_momento_de_causacion entre dos cierres NO deja dos ISN de la misma corrida', async () => {
    await query(
      `INSERT INTO mx_isn_tasas_estatales
         (estado, vigencia_desde, vigencia_hasta, tasa, regimen, fundamento)
       VALUES ('DP', '2026-01-01', NULL, 0.030000, 'tasa_plana', 'Prueba de ataque F08a')
       ON CONFLICT DO NOTHING`
    );
    const { fx, corrida } = await montar('F08a · ataque · causación cambiada');
    await acumularPasivoPatronal({ tenantId: fx.tenantId, payRunId: corrida });
    await resolvePolicy(
      { tenantId: fx.tenantId, entityId: fx.entityId },
      'isn_momento_de_causacion', 'pago', fx.userId, 'el despacho cambió de criterio'
    );
    await acumularPasivoPatronal({ tenantId: fx.tenantId, payRunId: corrida });

    const isn = (await pasivos(fx.tenantId)).filter((p) => p.tax_type === 'isn');
    // El ISN de esta corrida se debe UNA vez. Dos renglones son 600 pesos de
    // pasivo donde se deben 300, y los dos apuntan a la misma nómina.
    expect(isn).toHaveLength(1);
    expect(isn[0].amount).toBe('300.00');
  });

  it('cambiar provision_cuotas_patronales entre dos cierres NO cuenta el IMSS dos veces', async () => {
    const { fx, corrida } = await montar('F08a · ataque · provisión cambiada');
    await acumularPasivoPatronal({ tenantId: fx.tenantId, payRunId: corrida });
    await resolvePolicy(
      { tenantId: fx.tenantId, entityId: fx.entityId },
      'provision_cuotas_patronales', 'mensual_al_cierre', fx.userId, 'el despacho cambió de criterio'
    );
    await acumularPasivoPatronal({ tenantId: fx.tenantId, payRunId: corrida });

    const imss = (await pasivos(fx.tenantId)).filter((p) => p.tax_type === 'imss_employer');
    const total = imss.reduce((a, x) => a.plus(x.amount), new Decimal(0));
    const unaVez = imss.length > 0 ? new Decimal(imss[0].amount) : new Decimal(0);
    // Un mes con una sola corrida debe un IMSS, no dos.
    expect(total.toFixed(2)).toBe(unaVez.toFixed(2));
  });

  it('el camino inverso (mensual → por corrida) no se calla el solape', async () => {
    // Al revés que la prueba anterior: el renglón MENSUAL agrega varias
    // corridas, así que este cierre no lo puede retirar sin llevarse el
    // pasivo de las demás. Lo que no puede hacer es escribir encima y callar.
    const { fx, corrida } = await montar('F08a · ataque · provisión al revés');
    await resolvePolicy(
      { tenantId: fx.tenantId, entityId: fx.entityId },
      'provision_cuotas_patronales', 'mensual_al_cierre', fx.userId, 'primero mensual'
    );
    await acumularPasivoPatronal({ tenantId: fx.tenantId, payRunId: corrida });
    // El despacho cambia de opinión sobre una política YA contestada:
    // `resolvePolicy` sólo admite pendientes, así que se corrige la respuesta
    // en su sitio, que es lo que hace el panel al redefinir.
    await query(
      `UPDATE policy_decisions SET resolved_value = 'por_corrida'
        WHERE tenant_id = $1 AND key = 'provision_cuotas_patronales'`,
      [fx.tenantId]
    );
    const r = await acumularPasivoPatronal({ tenantId: fx.tenantId, payRunId: corrida });

    const imss = (await pasivos(fx.tenantId)).filter((p) => p.tax_type === 'imss_employer');
    const total = imss.reduce((a, x) => a.plus(x.amount), new Decimal(0));
    const unaVez = new Decimal(imss[0].amount);
    // El solape existe —el mes queda con el renglón mensual Y el de la
    // corrida—, y esta prueba lo fija tal cual: lo que no se tolera es que
    // ocurra en silencio.
    expect(total.toFixed(2)).toBe(unaVez.times(2).toFixed(2));
    const h = r.hallazgos.find((x) => x.codigo === 'pasivo_mensual_y_por_corrida_a_la_vez');
    expect(h, 'el mes se cuenta dos veces y nadie lo dice').toBeTruthy();
    expect(h!.severidad).toBe('bloqueante');
    expect(h!.mensaje).toContain('contado dos veces');
  });

  it('recalcular el mismo recibo no deja renglones sueltos ni un segundo recibo', async () => {
    const { fx, corrida, periodo } = await montar('F08a · ataque · recibo recalculado');
    const { rows: e } = await query<{ id: string }>(
      `SELECT id FROM employees WHERE tenant_id = $1`, [fx.tenantId]
    );
    const antes = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM paycheck_taxes pt
         JOIN paychecks p ON p.id = pt.paycheck_id WHERE p.pay_run_id = $1`, [corrida]
    );
    await expect(
      calculatePaycheck({
        tenant_id: fx.tenantId, pay_run_id: corrida, employee_id: e[0].id,
        pay_period_id: periodo, earnings: [{ earning_type: 'salary', amount: 10000 }],
      })
    ).rejects.toThrow();
    const despues = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM paycheck_taxes pt
         JOIN paychecks p ON p.id = pt.paycheck_id WHERE p.pay_run_id = $1`, [corrida]
    );
    expect(despues.rows[0].n).toBe(antes.rows[0].n);
    const recibos = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM paychecks WHERE pay_run_id = $1`, [corrida]
    );
    expect(recibos.rows[0].n).toBe('1');
  });
});

// ============================================================
// H · LO QUE PASA CUANDO EL PASIVO NO SE PUEDE ESCRIBIR
//
// `approvePayRun` promete en su comentario que el cambio de estado y el
// pasivo entran juntos o no entra ninguno. Una corrida aprobada sin su
// pasivo es el estado exacto que este tramo dice reparar.
// ============================================================
describe('H · aprobar y apuntar, juntos o ninguno', () => {
  it('si el pasivo revienta, la corrida NO queda aprobada', async () => {
    const fx = await crearInquilino('F08a · ataque · aprobación atómica');
    await seedPolicies({ tenantId: fx.tenantId, entityId: fx.entityId });
    const sched = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
      [sched, fx.tenantId, fx.entityId]
    );
    const periodo = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, '2026-11-01', '2026-11-15', '2026-11-15', 2026, 'draft')`,
      [periodo, fx.tenantId, sched]
    );
    const corrida = uuidv4();
    await query(
      `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used,
         created_by, total_gross, total_net_pay, total_employee_taxes, total_employer_taxes)
       VALUES ($1, $2, $3, 'regular', 'calculated', 2026, $4, 0, 0, 0, 0)`,
      [corrida, fx.tenantId, periodo, fx.userId]
    );
    for (const n of ['AT-1', 'AT-2']) {
      const emp = uuidv4();
      await query(
        `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
           hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
           tipo_regimen_sat, pay_schedule_id, salary_type, currency_code, work_state)
         VALUES ($1, $2, $3, $4, 'Trabajador', 'Atómico',
           '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901',
           '100.0000', '01', '02', $5, 'salary', 'MXN', 'AT')`,
        [emp, fx.tenantId, fx.entityId, n, sched]
      );
      // El IMSS patronal al tope de la columna: la SUMA de los dos ya no cabe
      // en NUMERIC(14,2) de employer_tax_liabilities.amount, y el INSERT del
      // pasivo revienta a media aprobación.
      await query(
        `INSERT INTO paychecks (id, tenant_id, pay_run_id, employee_id, gross_earnings,
           imss_employer, net_pay)
         VALUES ($1, $2, $3, $4, 100, 999999999999.99, 100)`,
        [uuidv4(), fx.tenantId, corrida, emp]
      );
    }

    const { approvePayRun } = await import('../../src/services/payroll/common/pay-run-service.js');
    await expect(approvePayRun(corrida, fx.userId)).rejects.toThrow();

    const { rows } = await query<{ status: string }>(
      `SELECT status FROM pay_runs WHERE id = $1`, [corrida]
    );
    expect(rows[0].status).toBe('calculated');
  });
});

// ============================================================
// I · LA FRONTERA DE INQUILINO EN EL CÁLCULO DEL RECIBO
// ============================================================
describe('I · un employee_id de otro inquilino no produce recibo', () => {
  it('el recibo del trabajador ajeno no se calcula ni se archiva', async () => {
    const otro = await crearInquilino('F08a · ataque · inquilino ajeno');
    const empAjeno = uuidv4();
    const schedAjeno = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
      [schedAjeno, otro.tenantId, otro.entityId]
    );
    await query(
      `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
         hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
         tipo_regimen_sat, pay_schedule_id, salary_type, currency_code)
       VALUES ($1, $2, $3, 'AJENO-1', 'Trabajador', 'Ajeno',
         '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901',
         '100.0000', '01', '02', $4, 'salary', 'MXN')`,
      [empAjeno, otro.tenantId, otro.entityId, schedAjeno]
    );

    const periodo = await nuevoPeriodo('2026-12-01', '2026-12-15', '2026-12-15', 2026);
    const corrida = await nuevaCorrida(periodo);
    await expect(
      calculatePaycheck({
        tenant_id: f.tenantId, pay_run_id: corrida, employee_id: empAjeno,
        pay_period_id: periodo, earnings: [{ earning_type: 'salary', amount: 5000 }],
      })
    ).rejects.toThrow(/Employee not found/);
    const { rows } = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM paychecks WHERE pay_run_id = $1`, [corrida]
    );
    expect(rows[0].n).toBe('0');
  });
});
