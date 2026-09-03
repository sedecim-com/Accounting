import { describe, it, expect, beforeAll } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../../src/database/connection.js';
import { crearInquilino, type Fixture } from './helpers/tenant-fixture.js';
import { seedPolicies, resolvePolicy } from '../../src/services/policy/policy-service.js';
import { calculatePaycheck } from '../../src/services/payroll/common/paycheck-service.js';
// Las calculadoras se registran por efecto de importación; sin esto el
// registro está vacío y `getRequired('MX','isr')` truena.
import '../../src/services/payroll/tax-engine/register-all.js';

// ============================================================
// F08a · EL SUBSIDIO QUE EL TRABAJADOR NO RECIBÍA, Y EL DESGLOSE QUE SE TIRABA
//
// Dos defectos que sólo se ven contra Postgres de verdad:
//
//  1. `paycheck_taxes` existe desde la 008 y ningún camino la escribía. Los
//     formularios que la leen reportaban ceros con aspecto de números. Aquí
//     se cuenta lo que quedó ESCRITO, no lo que la función devolvió.
//
//  2. `Math.max(0, isr − subsidio)`. Cuando el subsidio al empleo supera al
//     ISR del periodo, el patrón entrega la diferencia EN EFECTIVO al
//     trabajador. El Math.max la recortaba a cero: gente real cobrando de
//     menos, todos los periodos, sin una sola fila que lo delatara.
//
// Los importes salen de las tarifas 2026 sembradas por la migración 009:
// quincena de 1 500, ISR 79.29, subsidio 203.31 → 124.02 que hasta hoy se
// evaporaban.
// ============================================================

const CLAVE_SUBSIDIO = 'subsidio_al_empleo_entregado_registro';

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
    `SELECT tax_type, jurisdiction, employee_employer,
            taxable_wages::text, rate::text, tax_amount::text, is_credit, calculation_notes
       FROM paycheck_taxes WHERE paycheck_id = $1
      ORDER BY tax_type, employee_employer`,
    [paycheckId]
  );
  return rows;
}

describe('la nómina mexicana escribe su desglose y entrega el subsidio', () => {
  let f: Fixture;
  let payRunId: string;
  let payPeriodId: string;
  /** Recibo de la quincena de 1 500: el subsidio supera al ISR. */
  let reciboConEfectivo: string;
  /** Recibo de la quincena de 8 000: el ISR absorbe todo el subsidio. */
  let reciboSinEfectivo: string;

  beforeAll(async () => {
    f = await crearInquilino('F08a · subsidio entregado y desglose');
    await seedPolicies({ tenantId: f.tenantId, entityId: f.entityId });

    const scheduleId = uuidv4();
    await query(
      `INSERT INTO pay_schedules (id, tenant_id, entity_id, name, frequency, country_code,
         first_period_start, is_active)
       VALUES ($1, $2, $3, 'Quincenal', 'quincenal', 'MX', '2026-01-01', true)`,
      [scheduleId, f.tenantId, f.entityId]
    );

    payPeriodId = uuidv4();
    await query(
      `INSERT INTO pay_periods (id, tenant_id, pay_schedule_id, period_start, period_end,
         pay_date, tax_year, status)
       VALUES ($1, $2, $3, '2026-01-01', '2026-01-15', '2026-01-15', 2026, 'draft')`,
      [payPeriodId, f.tenantId, scheduleId]
    );

    payRunId = uuidv4();
    await query(
      `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
       VALUES ($1, $2, $3, 'regular', 'calculating', 2026, $4)`,
      [payRunId, f.tenantId, payPeriodId, f.userId]
    );

    const altaEmpleado = async (
      numero: string, sbcDiario: string, conCredito: boolean
    ): Promise<string> => {
      const id = uuidv4();
      await query(
        `INSERT INTO employees (id, tenant_id, entity_id, employee_number, first_name, last_name,
           hire_date, status, country_code, rfc, curp, nss, sbc, riesgo_puesto,
           tipo_regimen_sat, pay_schedule_id, salary_type, currency_code,
           infonavit_credit_type, infonavit_credit_value)
         VALUES ($1, $2, $3, $4, 'Trabajador', 'De Prueba',
           '2024-01-01', 'active', 'MX', 'XAXX010101000', 'XAXX010101HDFXXX01', '12345678901',
           $5, '01', '02', $6, 'salary', 'MXN', $7, $8)`,
        [id, f.tenantId, f.entityId, numero, sbcDiario, scheduleId,
         conCredito ? 'factor' : null, conCredito ? '0.2000' : null]
      );
      return id;
    };

    // 1 500 quincenales: el caso para el que el subsidio existe.
    const empBajo = await altaEmpleado('MX-0001', '100.0000', true);
    // 8 000 quincenales: sin subsidio en la tarifa.
    const empAlto = await altaEmpleado('MX-0002', '533.3333', false);

    reciboConEfectivo = (
      await calculatePaycheck({
        tenant_id: f.tenantId, pay_run_id: payRunId, employee_id: empBajo,
        pay_period_id: payPeriodId,
        earnings: [{ earning_type: 'salary', amount: 1500 }],
      })
    ).paycheck_id;

    reciboSinEfectivo = (
      await calculatePaycheck({
        tenant_id: f.tenantId, pay_run_id: payRunId, employee_id: empAlto,
        pay_period_id: payPeriodId,
        earnings: [{ earning_type: 'salary', amount: 8000 }],
      })
    ).paycheck_id;
  });

  it('escribe un renglón de paycheck_taxes por cada componente calculado', async () => {
    // La tabla llevaba desde la 008 sin un solo escritor.
    const rs = await impuestosDe(reciboConEfectivo);
    const claves = rs.map((r) => `${r.tax_type}:${r.employee_employer}`).sort();
    expect(claves).toEqual([
      'imss:EE', 'imss:ER', 'infonavit:ER', 'infonavit_credit:EE',
      'isr:EE', 'subsidio_empleo:EE', 'subsidio_entregado_efectivo:EE',
    ]);
    for (const r of rs) expect(r.jurisdiction).toBe('MX');
  });

  it('guarda la base gravable y la tasa, no sólo el importe', async () => {
    const isr = (await impuestosDe(reciboConEfectivo)).find((r) => r.tax_type === 'isr')!;
    expect(Number(isr.taxable_wages)).toBeCloseTo(1500, 2);
    expect(Number(isr.rate)).toBeCloseTo(0.064, 6);
    expect(Number(isr.tax_amount)).toBeCloseTo(79.29, 2);
  });

  it('DEJA EL EFECTIVO EN LA MANO DEL TRABAJADOR: el excedente suma al neto', async () => {
    const { rows } = await query<{
      subsidio_entregado_efectivo: string; net_pay: string; gross_earnings: string;
      isr_withheld: string; subsidio_empleo: string; imss_employee: string;
      infonavit_withheld: string;
    }>(
      `SELECT subsidio_entregado_efectivo::text, net_pay::text, gross_earnings::text,
              isr_withheld::text, subsidio_empleo::text, imss_employee::text,
              infonavit_withheld::text
         FROM paychecks WHERE id = $1`,
      [reciboConEfectivo]
    );
    const p = rows[0];

    // Subsidio 203.31 − ISR 79.29 = 124.02 que antes desaparecían.
    expect(Number(p.isr_withheld)).toBeCloseTo(79.29, 2);
    expect(Number(p.subsidio_empleo)).toBeCloseTo(203.31, 2);
    expect(Number(p.subsidio_entregado_efectivo)).toBeCloseTo(124.02, 2);

    // Y el neto lo refleja: bruto − IMSS − crédito INFONAVIT + subsidio
    // entregado. El ISR retenido es CERO porque el subsidio lo absorbió.
    const esperado =
      Number(p.gross_earnings) -
      Number(p.imss_employee) -
      Number(p.infonavit_withheld) +
      Number(p.subsidio_entregado_efectivo);
    expect(Number(p.net_pay)).toBeCloseTo(esperado, 2);
    expect(Number(p.net_pay)).toBeGreaterThan(Number(p.gross_earnings) - Number(p.imss_employee) - Number(p.infonavit_withheld));
  });

  it('deja el renglón del efectivo entregado marcado como crédito del trabajador', async () => {
    const r = (await impuestosDe(reciboConEfectivo)).find(
      (x) => x.tax_type === 'subsidio_entregado_efectivo'
    )!;
    expect(r.employee_employer).toBe('EE');
    expect(r.is_credit).toBe(true);
    expect(Number(r.tax_amount)).toBeCloseTo(124.02, 2);
  });

  it('dice en la nota que el criterio es el de omisión mientras nadie conteste', async () => {
    // Una política sin responder devuelve su default, y eso NO es una
    // decisión del despacho. El renglón lo declara para quien audite.
    const r = (await impuestosDe(reciboConEfectivo)).find(
      (x) => x.tax_type === 'subsidio_entregado_efectivo'
    )!;
    expect(r.calculation_notes).toMatch(/cuenta por cobrar al fisco/);
    expect(r.calculation_notes).toMatch(/sigue sin contestar/);

    const { rows } = await query<{ detalle: Record<string, unknown> }>(
      `SELECT calculation_details AS detalle FROM paychecks WHERE id = $1`,
      [reciboConEfectivo]
    );
    expect(rows[0].detalle.subsidio_entregado_registro).toEqual({
      valor: 'cuenta_por_cobrar_fisco',
      decidido_por_el_despacho: false,
    });
  });

  it('no entrega nada cuando el ISR absorbe el subsidio', async () => {
    const { rows } = await query<{ entregado: string; isr: string }>(
      `SELECT subsidio_entregado_efectivo::text AS entregado, isr_withheld::text AS isr
         FROM paychecks WHERE id = $1`,
      [reciboSinEfectivo]
    );
    expect(Number(rows[0].entregado)).toBe(0);
    expect(Number(rows[0].isr)).toBeGreaterThan(0);
    const rs = await impuestosDe(reciboSinEfectivo);
    expect(rs.some((r) => r.tax_type === 'subsidio_entregado_efectivo')).toBe(false);
    // Sin crédito de vivienda no hay renglón de crédito INFONAVIT.
    expect(rs.some((r) => r.tax_type === 'infonavit_credit')).toBe(false);
  });

  it('el crédito INFONAVIT baja el neto sin contar como impuesto retenido', async () => {
    const cr = (await impuestosDe(reciboConEfectivo)).find(
      (r) => r.tax_type === 'infonavit_credit'
    )!;
    expect(cr.employee_employer).toBe('EE');
    expect(Number(cr.tax_amount)).toBeGreaterThan(0);
    expect(cr.calculation_notes).toMatch(/DEDUCCIÓN/);
    const { rows } = await query<{ infonavit: string }>(
      `SELECT infonavit_withheld::text AS infonavit FROM paychecks WHERE id = $1`,
      [reciboConEfectivo]
    );
    expect(Number(rows[0].infonavit)).toBeCloseTo(Number(cr.tax_amount), 2);
  });

  it('la base impide apuntar dos veces el mismo impuesto (UNIQUE de la 067)', async () => {
    // El candado no es del servicio: es de la tabla, y por eso sobrevive a un
    // reintento, a un recálculo y a un job que corre dos veces.
    await expect(
      query(
        `INSERT INTO paycheck_taxes (paycheck_id, tax_type, jurisdiction, employee_employer,
           taxable_wages, tax_amount)
         VALUES ($1, 'isr', 'MX', 'EE', 1500, 79.29)`,
        [reciboConEfectivo]
      )
    ).rejects.toThrow(/paycheck_taxes_un_renglon_por_impuesto|duplicate key/i);
  });

  it('un recibo de otro inquilino no se calcula: la frontera va en el SQL', async () => {
    const ajeno = await crearInquilino('F08a · inquilino ajeno');
    await expect(
      calculatePaycheck({
        tenant_id: ajeno.tenantId, pay_run_id: payRunId,
        employee_id: (await query<{ id: string }>(
          `SELECT id FROM employees WHERE tenant_id = $1 LIMIT 1`, [f.tenantId]
        )).rows[0].id,
        pay_period_id: payPeriodId,
        earnings: [{ earning_type: 'salary', amount: 1500 }],
      })
    ).rejects.toThrow(/Employee not found/);
  });

  it('cuando el despacho SÍ contesta la política, el recibo lo registra así', async () => {
    await resolvePolicy(
      { tenantId: f.tenantId, entityId: f.entityId },
      CLAVE_SUBSIDIO, 'gasto_del_patron', f.userId, 'Los importes son menores'
    );

    // Corrida aparte: el UNIQUE(pay_run_id, employee_id) de paychecks impide
    // recalcular al mismo trabajador dentro de la misma.
    const otraCorrida = uuidv4();
    await query(
      `INSERT INTO pay_runs (id, tenant_id, pay_period_id, run_type, status, tax_year_used, created_by)
       VALUES ($1, $2, $3, 'correction', 'calculating', 2026, $4)`,
      [otraCorrida, f.tenantId, payPeriodId, f.userId]
    );
    const empId = (await query<{ id: string }>(
      `SELECT id FROM employees WHERE tenant_id = $1 AND employee_number = 'MX-0001'`,
      [f.tenantId]
    )).rows[0].id;

    const r = await calculatePaycheck({
      tenant_id: f.tenantId, pay_run_id: otraCorrida, employee_id: empId,
      pay_period_id: payPeriodId,
      earnings: [{ earning_type: 'salary', amount: 1500 }],
    });
    expect(r.subsidio_entregado_efectivo).toBe('124.0200');

    const renglon = (await impuestosDe(r.paycheck_id)).find(
      (x) => x.tax_type === 'subsidio_entregado_efectivo'
    )!;
    expect(renglon.calculation_notes).toMatch(/gasto del patrón/);
    expect(renglon.calculation_notes).toMatch(/criterio del despacho/);

    const { rows } = await query<{ detalle: Record<string, unknown> }>(
      `SELECT calculation_details AS detalle FROM paychecks WHERE id = $1`,
      [r.paycheck_id]
    );
    expect(rows[0].detalle.subsidio_entregado_registro).toEqual({
      valor: 'gasto_del_patron',
      decidido_por_el_despacho: true,
    });
  });
});
