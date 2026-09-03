import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { query, withTransaction } from '../../../database/connection.js';
import { taxRegistry } from '../tax-engine/tax-registry.js';
import { getEmployeeYtd, getEmployeeSutaYtd } from '../tax-engine/ytd-service.js';
import { calculateGarnishments } from '../usa/garnishments/garnishment-engine.js';
import {
  aplicarSubsidioAlEmpleo,
  leerRegistroDelSubsidio,
  notaDelSubsidioEntregado,
  type RegistroSubsidioLeido,
} from '../mx/subsidio-entregado.js';
import type { TaxInput, TaxOutput, PayFrequency } from '../tax-engine/tax-engine.interface.js';

// ============================================================
// PAYCHECK SERVICE
// Takes employee + pay period + earnings → computes gross to net.
// Dispatches to tax calculators per jurisdiction.
//
// F08a · DOS DEFECTOS QUE VIVÍAN AQUÍ, Y LO QUE LOS CORRIGE
//
// 1. EL DESGLOSE SE CALCULABA Y SE TIRABA. Cada componente —isr, subsidio,
//    imss del trabajador y del patrón, infonavit, fit, fica, futa, suta— se
//    calculaba con su base y su tasa, se resumía en un par de columnas de
//    `paychecks` y el detalle se perdía. `paycheck_taxes` existe desde la
//    008 con exactamente la forma que hacía falta y ningún camino la
//    escribía: los formularios que la leen reportaban CEROS con aspecto de
//    números. Ahora cada componente calculado deja su renglón, con base
//    gravable y tasa, DENTRO de la misma transacción que inserta el recibo.
//
// 2. EL SUBSIDIO QUE EL TRABAJADOR NO RECIBÍA. Ver `../mx/subsidio-entregado.ts`.
// ============================================================

export interface EarningLine {
  earning_type: string;
  hours?: number;
  rate?: number;
  amount: number;
  is_taxable_fit?: boolean;
  is_taxable_fica?: boolean;
  is_taxable_futa?: boolean;
  is_taxable_state?: boolean;
  is_taxable_isr?: boolean;
  is_taxable_imss?: boolean;
  is_supplemental?: boolean;
  cfdi_clave_sat?: string;
  description?: string;
}

export interface DeductionLine {
  deduction_type: string;
  is_pre_tax: boolean;
  is_employer_contribution?: boolean;
  amount: number;
  benefit_plan_id?: string;
  garnishment_id?: string;
  cfdi_clave_sat?: string;
  description?: string;
}

export interface PaycheckInput {
  tenant_id: string;
  pay_run_id: string;
  employee_id: string;
  pay_period_id: string;
  earnings: EarningLine[];
  deductions?: DeductionLine[];
  hours_worked?: number;
}

export interface CalculatedPaycheck {
  paycheck_id: string;
  gross_earnings: number;
  pre_tax_deductions: number;
  post_tax_deductions: number;
  employee_taxes: number;
  employer_taxes: number;
  net_pay: number;
  /**
   * Subsidio al empleo que excedió al ISR y que el patrón ENTREGA en efectivo
   * al trabajador. Va en cadena con cuatro decimales —y no en `number` como
   * el resto de esta interfaz, que es anterior a la regla— porque es dinero
   * que nace en este tramo y no hay razón para nacerlo mal.
   */
  subsidio_entregado_efectivo: string;
  breakdown: Record<string, number>;
}

/**
 * Un renglón de `paycheck_taxes` listo para escribirse: el componente tal
 * como lo calculó su calculadora, con la base sobre la que se aplicó.
 */
interface RenglonDeImpuesto {
  tax_type: string;
  jurisdiction: string;
  employee_employer: 'EE' | 'ER';
  taxable_wages: string;
  rate: string | null;
  tax_amount: string;
  is_credit: boolean;
  calculation_notes: string | null;
}

/** Lo que un renglón puede sobrescribir de la salida de su calculadora. */
interface AjustesDelRenglon {
  tax_type?: string;
  taxable_wages?: Decimal.Value;
  tax_amount?: Decimal.Value;
  is_credit?: boolean;
  notas?: string;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => new Decimal(a).plus(b).toNumber(), 0);
}

export async function calculatePaycheck(input: PaycheckInput): Promise<CalculatedPaycheck> {
  // Fetch employee + pay period
  //
  // LA FRONTERA DE INQUILINO VA EN EL SQL, no en un if de más abajo: el
  // recibo se inserta con el `tenant_id` que trae la petición, así que un
  // employee_id de OTRO inquilino producía un recibo entero —con sueldos y
  // retenciones de una empresa ajena— archivado bajo el inquilino que
  // preguntó. Con el filtro dentro de la consulta, ese caso es «no existe».
  const empResult = await query<{
    id: string;
    country_code: 'MX' | 'US';
    sbc: string | null;
    tipo_regimen_sat: string | null;
    riesgo_puesto: string | null;
    infonavit_credit_type: string | null;
    infonavit_credit_value: string | null;
    w4_data: Record<string, unknown>;
    work_state: string | null;
    residence_state: string | null;
    work_city: string | null;
  }>(
    `SELECT id, country_code, sbc, tipo_regimen_sat, riesgo_puesto,
            infonavit_credit_type, infonavit_credit_value,
            w4_data, work_state, residence_state, work_city
     FROM employees WHERE id = $1 AND tenant_id = $2`,
    [input.employee_id, input.tenant_id]
  );
  if (empResult.rows.length === 0) throw new Error('Employee not found');
  const emp = empResult.rows[0];

  // `entity_id` sale del calendario de pago —es donde vive— y hace falta para
  // acotar la política del subsidio a la entidad, igual que hace el posteo.
  const periodResult = await query<{
    period_start: string;
    period_end: string;
    pay_date: string;
    tax_year: number;
    frequency: PayFrequency;
    entity_id: string;
  }>(
    `SELECT pp.period_start, pp.period_end, pp.pay_date, pp.tax_year,
            ps.frequency, ps.entity_id
     FROM pay_periods pp JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id
     WHERE pp.id = $1 AND pp.tenant_id = $2`,
    [input.pay_period_id, input.tenant_id]
  );
  if (periodResult.rows.length === 0) throw new Error('Pay period not found');
  const period = periodResult.rows[0];

  // LA TERCERA LLAVE, QUE ES LA QUE FALTABA.
  //
  // Se acotaban `employees` y `pay_periods` por inquilino y se dejaba pasar
  // `pay_run_id` tal cual: el recibo se insertaba con la corrida que trajera
  // la petición, sin comprobar de quién era. Con eso, un inquilino podía
  // colgar un recibo suyo —con sus sueldos y su desglose— de la corrida de
  // OTRO, y el daño no se queda aquí: el agregado del que sale el asiento al
  // mayor es `SELECT ... FROM paychecks WHERE pay_run_id = $1`, sin una sola
  // mención del inquilino (gl-posting-service.ts), así que ese dinero ajeno
  // entra en la póliza de nómina del inquilino invadido. Y por el otro lado
  // desaparece: el pasivo patronal del inquilino dueño acota
  // `p.tenant_id AND p.pay_run_id`, y su corrida se quedó sin el recibo, de
  // modo que las cuotas patronales de ese trabajador no se acumulan en
  // ninguna parte y ni siquiera salta el aviso de `imss_patronal_en_cero`.
  //
  // El filtro va DENTRO del SQL, como las otras dos: así el caso es «no
  // existe» y no «existe pero no debería».
  const runResult = await query<{ id: string }>(
    `SELECT id FROM pay_runs WHERE id = $1 AND tenant_id = $2`,
    [input.pay_run_id, input.tenant_id]
  );
  if (runResult.rows.length === 0) throw new Error('Pay run not found');

  const daysInPeriod =
    (new Date(period.period_end).getTime() - new Date(period.period_start).getTime()) / 86400000 + 1;

  // --- Gross + deductions ---
  const grossEarnings = sum(input.earnings.map((e) => e.amount));
  const deductions = input.deductions || [];
  const preTaxDeductions = sum(
    deductions.filter((d) => d.is_pre_tax && !d.is_employer_contribution).map((d) => d.amount)
  );
  const postTaxDeductions = sum(
    deductions.filter((d) => !d.is_pre_tax && !d.is_employer_contribution).map((d) => d.amount)
  );

  // --- Taxable bases ---
  const taxableFit = sum(
    input.earnings.filter((e) => e.is_taxable_fit !== false).map((e) => e.amount)
  ) - preTaxDeductions;
  const taxableFica = sum(
    input.earnings.filter((e) => e.is_taxable_fica !== false).map((e) => e.amount)
  ) - sum(deductions.filter((d) => d.is_pre_tax && !d.is_employer_contribution && d.deduction_type !== '401k' && d.deduction_type !== 'roth_401k').map((d) => d.amount));
  // 401k is pre-tax for FIT but NOT for FICA
  const taxableFuta = taxableFica;
  const taxableState = taxableFit;
  const taxableIsr = sum(
    input.earnings.filter((e) => e.is_taxable_isr !== false).map((e) => e.amount)
  ) - preTaxDeductions;
  const taxableImss = taxableIsr;

  // --- YTD ---
  const ytd = await getEmployeeYtd(input.employee_id, period.tax_year, new Date(period.pay_date));

  const breakdown: Record<string, number> = {};

  // LOS ACUMULADORES DE IMPUESTO SON DECIMAL, no `number`.
  //
  // Eran `let x = 0; x += tax.tax_amount`, y sobre esa suma se calculan las
  // «disposable earnings» de los embargos: un centavo de coma flotante ahí
  // decide cuánto se le retiene a alguien por orden judicial.
  let employeeTaxes = new Decimal(0);
  let employerTaxes = new Decimal(0);

  // Lo que el trabajador ve descontado y NO es un impuesto retenido: hoy sólo
  // el crédito INFONAVIT (ver más abajo por qué no puede vivir con los
  // impuestos). Resta del neto igual, pero no del cálculo del embargo.
  let otrasRetencionesDelTrabajador = new Decimal(0);

  // --- Renglones de `paycheck_taxes` ---
  const renglones: RenglonDeImpuesto[] = [];

  /**
   * Apunta un componente calculado para que acabe en `paycheck_taxes`.
   *
   * Se llama junto a cada `breakdown.x = ...` a propósito: el defecto que se
   * está corrigiendo fue exactamente que el desglose se calculaba en un sitio
   * y no se persistía en ninguno, y dos bucles separados lo repetirían a la
   * primera calculadora nueva que alguien añada.
   */
  const apuntar = (out: TaxOutput, lado: 'EE' | 'ER', ajustes: AjustesDelRenglon = {}): void => {
    renglones.push({
      tax_type: ajustes.tax_type ?? out.tax_type,
      jurisdiction: out.jurisdiction,
      employee_employer: lado,
      taxable_wages: new Decimal(ajustes.taxable_wages ?? out.taxable_wages_used).toFixed(4),
      rate:
        out.rate_applied === undefined || out.rate_applied === null
          ? null
          : new Decimal(out.rate_applied).toFixed(6),
      tax_amount: new Decimal(ajustes.tax_amount ?? out.tax_amount).toFixed(4),
      is_credit: ajustes.is_credit ?? out.is_credit ?? false,
      calculation_notes: ajustes.notas ?? out.notes ?? null,
    });
  };

  const baseTaxInput: Omit<TaxInput, 'taxable_wages'> = {
    pay_frequency: period.frequency,
    tax_year: period.tax_year,
    w4_data: emp.w4_data as TaxInput['w4_data'],
    sbc_daily: emp.sbc ? parseFloat(emp.sbc) : undefined,
    days_in_period: Math.floor(daysInPeriod),
    riesgo_puesto: emp.riesgo_puesto || undefined,
    state: emp.work_state || undefined,
    residence_state: emp.residence_state || undefined,
    work_city: emp.work_city || undefined,
  };

  // Subsidio al empleo entregado en efectivo (México). Cero mientras el ISR
  // alcance a absorber el subsidio, que es el caso corriente.
  let subsidioEntregado = new Decimal(0);
  let registroDelSubsidio: RegistroSubsidioLeido | null = null;

  if (emp.country_code === 'US') {
    // FIT
    const fitCalc = taxRegistry.getRequired('US-FEDERAL', 'fit');
    const fit = await fitCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFit, ytd_wages: ytd.gross_wages });
    breakdown.fit = fit.tax_amount;
    employeeTaxes = employeeTaxes.plus(fit.tax_amount);
    apuntar(fit, 'EE', { taxable_wages: taxableFit });

    // FICA SS
    const ssCalc = taxRegistry.getRequired('US-FEDERAL', 'fica_ss');
    const ss = await ssCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica, ytd_wages: ytd.ss_taxable_wages });
    breakdown.fica_ss = ss.tax_amount;
    employeeTaxes = employeeTaxes.plus(ss.tax_amount);
    apuntar(ss, 'EE');

    const ssErCalc = taxRegistry.getRequired('US-FEDERAL', 'fica_ss_employer');
    const ssEr = await ssErCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica, ytd_wages: ytd.ss_taxable_wages });
    breakdown.fica_ss_employer = ssEr.tax_amount;
    employerTaxes = employerTaxes.plus(ssEr.tax_amount);
    apuntar(ssEr, 'ER', { tax_type: 'fica_ss' });

    // Medicare
    const medCalc = taxRegistry.getRequired('US-FEDERAL', 'fica_medicare');
    const med = await medCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica });
    breakdown.fica_medicare = med.tax_amount;
    employeeTaxes = employeeTaxes.plus(med.tax_amount);
    apuntar(med, 'EE');

    const medErCalc = taxRegistry.getRequired('US-FEDERAL', 'fica_medicare_employer');
    const medEr = await medErCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica });
    breakdown.fica_medicare_employer = medEr.tax_amount;
    employerTaxes = employerTaxes.plus(medEr.tax_amount);
    apuntar(medEr, 'ER', { tax_type: 'fica_medicare' });

    // Additional Medicare
    const addlCalc = taxRegistry.getRequired('US-FEDERAL', 'additional_medicare');
    const addl = await addlCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFica, ytd_wages: ytd.medicare_taxable_wages });
    breakdown.additional_medicare = addl.tax_amount;
    employeeTaxes = employeeTaxes.plus(addl.tax_amount);
    apuntar(addl, 'EE');

    // FUTA
    const futaCalc = taxRegistry.getRequired('US-FEDERAL', 'futa');
    const futa = await futaCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFuta, ytd_wages: ytd.futa_taxable_wages });
    breakdown.futa = futa.tax_amount;
    employerTaxes = employerTaxes.plus(futa.tax_amount);
    apuntar(futa, 'ER');

    // State SIT + SUTA + SDI (if state has them)
    if (emp.work_state) {
      const juris = `US-${emp.work_state}`;
      const sitCalc = taxRegistry.get(juris, 'sit');
      if (sitCalc) {
        const sit = await sitCalc.calculate({ ...baseTaxInput, taxable_wages: taxableState });
        breakdown.sit = sit.tax_amount;
        employeeTaxes = employeeTaxes.plus(sit.tax_amount);
        apuntar(sit, 'EE', { taxable_wages: taxableState });
      }
      const sutaCalc = taxRegistry.get(juris, 'suta');
      if (sutaCalc) {
        // Per-state SUTA YTD (each state has its own wage base)
        const sutaYtd = await getEmployeeSutaYtd(
          input.employee_id, period.tax_year, emp.work_state, new Date(period.pay_date)
        );
        const suta = await sutaCalc.calculate({ ...baseTaxInput, taxable_wages: taxableFuta, ytd_wages: sutaYtd });
        breakdown.suta = suta.tax_amount;
        employerTaxes = employerTaxes.plus(suta.tax_amount);
        apuntar(suta, 'ER');
      }
      const sdiCalc = taxRegistry.get(juris, 'sdi');
      if (sdiCalc) {
        const sdi = await sdiCalc.calculate({ ...baseTaxInput, taxable_wages: taxableState });
        if (sdi.tax_amount > 0) {
          breakdown.sdi = sdi.tax_amount;
          employeeTaxes = employeeTaxes.plus(sdi.tax_amount);
          apuntar(sdi, 'EE', { taxable_wages: taxableState });
        }
      }

      // Local (city) income taxes — try known locality codes for this state
      if (emp.work_city) {
        const cityCode3 = emp.work_city.toUpperCase().slice(0, 3);
        const localJuris = `US-${emp.work_state}-${cityCode3}`;
        const localCalc = taxRegistry.get(localJuris, 'local');
        if (localCalc) {
          const local = await localCalc.calculate({ ...baseTaxInput, taxable_wages: taxableState });
          if (local.tax_amount > 0) {
            breakdown.local = local.tax_amount;
            employeeTaxes = employeeTaxes.plus(local.tax_amount);
            apuntar(local, 'EE', { taxable_wages: taxableState });
          }
        }
      }
    }
  } else {
    // --- MEXICO ---
    const isrCalc = taxRegistry.getRequired('MX', 'isr');
    const isr = await isrCalc.calculate({ ...baseTaxInput, taxable_wages: taxableIsr });
    breakdown.isr = isr.tax_amount;

    const subCalc = taxRegistry.getRequired('MX', 'subsidio_empleo');
    const sub = await subCalc.calculate({ ...baseTaxInput, taxable_wages: taxableIsr });
    breakdown.subsidio_empleo = sub.tax_amount;

    // EL SUBSIDIO QUE EXCEDE AL ISR NO SE EVAPORA: SE ENTREGA.
    //
    // La línea era `Math.max(0, isr - sub)` con un comentario que prometía
    // «if negative, employee receives as cash». Nadie entregaba nada: el
    // recorte a cero era todo el tratamiento, y el excedente desaparecía del
    // recibo, del neto y de la contabilidad.
    const aplicado = aplicarSubsidioAlEmpleo(isr.tax_amount, sub.tax_amount);
    employeeTaxes = employeeTaxes.plus(aplicado.isrRetenido);
    subsidioEntregado = new Decimal(aplicado.entregadoEnEfectivo);

    apuntar(isr, 'EE', {
      taxable_wages: taxableIsr,
      notas: `${isr.notes ?? 'ISR del periodo'} · retenido tras acreditar el subsidio: ${aplicado.isrRetenido}`,
    });
    // EL RENGLÓN LLEVA LO ACREDITADO, NO EL SUBSIDIO ENTERO.
    //
    // El subsidio causado se parte en dos: lo que se acredita contra el ISR de
    // este trabajador y lo que se le entrega en efectivo porque ya no quedaba
    // ISR contra el que acreditarlo. Los dos renglones existen, y su SUMA es el
    // causado. Poner el causado en éste y el entregado en el otro contaba dos
    // veces la parte entregada: un verificador sumó los créditos de la tabla y
    // el ISR neto del periodo salió −248.04 donde el fisco ve −124.02.
    const subsidioAcreditado = new Decimal(isr.tax_amount).minus(aplicado.isrRetenido);
    apuntar(sub, 'EE', {
      tax_amount: subsidioAcreditado,
      taxable_wages: taxableIsr,
      is_credit: true,
      notas:
        `${sub.notes ?? 'Subsidio al empleo'} · causado ${new Decimal(sub.tax_amount).toFixed(2)}, ` +
        `acreditado contra el ISR del periodo ${subsidioAcreditado.toFixed(2)}`,
    });

    if (subsidioEntregado.greaterThan(0)) {
      // La política se lee SÓLO cuando hay algo que registrar: mientras el
      // ISR absorba el subsidio no gobierna nada y no hay por qué gastar una
      // consulta ni presentar un criterio que no aplica.
      registroDelSubsidio = await leerRegistroDelSubsidio({
        tenantId: input.tenant_id,
        entityId: period.entity_id,
      });
      apuntar(sub, 'EE', {
        tax_type: 'subsidio_entregado_efectivo',
        taxable_wages: taxableIsr,
        tax_amount: subsidioEntregado,
        is_credit: true,
        notas: notaDelSubsidioEntregado(registroDelSubsidio),
      });
    }

    // IMSS employee
    const imssEeCalc = taxRegistry.getRequired('MX', 'imss_employee');
    const imssEe = await imssEeCalc.calculate({ ...baseTaxInput, taxable_wages: taxableImss });
    breakdown.imss_employee = imssEe.tax_amount;
    employeeTaxes = employeeTaxes.plus(imssEe.tax_amount);
    apuntar(imssEe, 'EE', { tax_type: 'imss' });

    // IMSS employer
    const imssErCalc = taxRegistry.getRequired('MX', 'imss_employer');
    const imssEr = await imssErCalc.calculate({ ...baseTaxInput, taxable_wages: taxableImss });
    breakdown.imss_employer = imssEr.tax_amount;
    employerTaxes = employerTaxes.plus(imssEr.tax_amount);
    apuntar(imssEr, 'ER', { tax_type: 'imss' });

    // INFONAVIT employer (always)
    const infErCalc = taxRegistry.getRequired('MX', 'infonavit_employer');
    const infEr = await infErCalc.calculate({ ...baseTaxInput, taxable_wages: taxableImss });
    breakdown.infonavit_employer = infEr.tax_amount;
    employerTaxes = employerTaxes.plus(infEr.tax_amount);
    apuntar(infEr, 'ER', { tax_type: 'infonavit' });

    // INFONAVIT credit discount (only if employee has active credit)
    if (emp.infonavit_credit_type && emp.infonavit_credit_value) {
      const infCrCalc = taxRegistry.getRequired('MX', 'infonavit_credit');
      const infCr = await infCrCalc.calculate({
        ...baseTaxInput,
        taxable_wages: taxableImss,
        // @ts-expect-error — extended input for infonavit
        credit_type: emp.infonavit_credit_type,
        credit_value: parseFloat(emp.infonavit_credit_value),
      });
      breakdown.infonavit_credit = infCr.tax_amount;
      // EL DESCUENTO DE CRÉDITO INFONAVIT NO ES UN IMPUESTO RETENIDO.
      //
      // Sumaba a `employeeTaxes`, y `employeeTaxes` es la base de las
      // «disposable earnings» del motor de embargos: meter ahí una amortización
      // de vivienda reduce artificialmente el ingreso embargable, o sea que
      // decide cuánto cobra un acreedor con orden judicial. Resta del neto
      // igual —el trabajador sí lo ve descontado—, pero por la vía de las
      // retenciones que no son impuesto.
      otrasRetencionesDelTrabajador = otrasRetencionesDelTrabajador.plus(infCr.tax_amount);
      apuntar(infCr, 'EE', {
        tax_type: 'infonavit_credit',
        notas:
          `${infCr.notes ?? 'Crédito INFONAVIT'} · es una DEDUCCIÓN de vivienda, no un impuesto ` +
          'retenido: no entra en la base de las disposable earnings',
      });
    }
  }

  // --- Garnishments (USA) ---
  // Disposable earnings = gross − mandatory (tax) withholdings
  let garnishmentTotal = 0;
  const garnishmentDeductions: DeductionLine[] = [];
  if (emp.country_code === 'US') {
    const disposable = new Decimal(grossEarnings).minus(employeeTaxes).toNumber();
    const freqMap: Record<PayFrequency, 'weekly' | 'biweekly' | 'semimonthly' | 'monthly'> = {
      weekly: 'weekly', biweekly: 'biweekly', semimonthly: 'semimonthly',
      monthly: 'monthly', quincenal: 'semimonthly', annual: 'monthly',
    };
    const g = await calculateGarnishments({
      employee_id: input.employee_id,
      disposable_earnings: disposable,
      gross_wages: grossEarnings,
      pay_frequency: freqMap[period.frequency] || 'biweekly',
    });
    garnishmentTotal = g.total_withheld;
    breakdown.garnishments = garnishmentTotal;
    for (const po of g.per_order) {
      if (po.amount > 0) {
        garnishmentDeductions.push({
          deduction_type: po.type,
          is_pre_tax: false,
          amount: po.amount,
          garnishment_id: po.order_id,
          description: po.cap_applied ? `Cap: ${po.cap_applied}` : undefined,
        });
      }
    }
  }
  const totalPostTax = new Decimal(postTaxDeductions).plus(garnishmentTotal).toNumber();

  // --- Net pay ---
  //
  // El subsidio entregado SUMA: es la única partida del recibo que aumenta lo
  // que el trabajador se lleva sin ser una percepción gravable.
  const netPay = new Decimal(grossEarnings)
    .minus(preTaxDeductions)
    .minus(employeeTaxes)
    .minus(otrasRetencionesDelTrabajador)
    .minus(totalPostTax)
    .plus(subsidioEntregado)
    .toNumber();

  // El rastro de auditoría guarda, además del desglose, el importe entregado
  // y BAJO QUÉ CRITERIO se registró — incluida la advertencia de que nadie
  // contestó la política todavía, que es distinto de haberla contestado así.
  const detalleDelCalculo: Record<string, unknown> = {
    ...breakdown,
    subsidio_entregado_efectivo: subsidioEntregado.toFixed(4),
    subsidio_entregado_registro: registroDelSubsidio
      ? {
          valor: registroDelSubsidio.valor,
          decidido_por_el_despacho: registroDelSubsidio.decididoPorElDespacho,
        }
      : null,
  };

  // --- Persist ---
  const paycheckId = uuidv4();
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO paychecks (
        id, tenant_id, pay_run_id, employee_id,
        gross_earnings, pre_tax_deductions, post_tax_deductions,
        taxable_wages_fit, taxable_wages_fica, taxable_wages_futa, taxable_wages_state,
        taxable_wages_isr, taxable_wages_imss,
        fit_withheld, fica_ss_withheld, fica_medicare_withheld, additional_medicare_withheld,
        state_tax_withheld, sdi_withheld,
        fica_ss_employer, fica_medicare_employer, futa, suta,
        isr_withheld, subsidio_empleo, imss_employee, infonavit_withheld,
        imss_employer, infonavit_employer,
        net_pay, ytd_snapshot, calculation_details, hours_worked,
        local_tax_withheld, garnishments, subsidio_entregado_efectivo
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13,
        $14, $15, $16, $17,
        $18, $19,
        $20, $21, $22, $23,
        $24, $25, $26, $27,
        $28, $29,
        $30, $31::jsonb, $32::jsonb, $33,
        $34, $35, $36
      )`,
      [
        paycheckId, input.tenant_id, input.pay_run_id, input.employee_id,
        grossEarnings, preTaxDeductions, totalPostTax,
        taxableFit, taxableFica, taxableFuta, taxableState,
        taxableIsr, taxableImss,
        breakdown.fit || 0, breakdown.fica_ss || 0, breakdown.fica_medicare || 0, breakdown.additional_medicare || 0,
        breakdown.sit || 0, breakdown.sdi || 0,
        breakdown.fica_ss_employer || 0, breakdown.fica_medicare_employer || 0, breakdown.futa || 0, breakdown.suta || 0,
        breakdown.isr || 0, breakdown.subsidio_empleo || 0, breakdown.imss_employee || 0, breakdown.infonavit_credit || 0,
        breakdown.imss_employer || 0, breakdown.infonavit_employer || 0,
        netPay, JSON.stringify(ytd), JSON.stringify(detalleDelCalculo), input.hours_worked || null,
        // Tres columnas que existían desde la 008 y nadie escribía: el
        // impuesto local retenido y los embargos salían en CERO en el recibo
        // aunque el neto sí los descontara.
        breakdown.local || 0, garnishmentTotal, subsidioEntregado.toFixed(4),
      ]
    );

    for (const e of input.earnings) {
      await client.query(
        `INSERT INTO paycheck_earnings (paycheck_id, earning_type, hours, rate, amount,
          is_taxable_fit, is_taxable_state, is_taxable_fica, is_taxable_futa,
          is_taxable_isr, is_taxable_imss, is_supplemental, cfdi_clave_sat, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          paycheckId, e.earning_type, e.hours || null, e.rate || null, e.amount,
          e.is_taxable_fit !== false, e.is_taxable_state !== false, e.is_taxable_fica !== false, e.is_taxable_futa !== false,
          e.is_taxable_isr !== false, e.is_taxable_imss !== false, e.is_supplemental || false,
          e.cfdi_clave_sat || null, e.description || null,
        ]
      );
    }

    for (const d of [...deductions, ...garnishmentDeductions]) {
      await client.query(
        `INSERT INTO paycheck_deductions (paycheck_id, deduction_type, is_pre_tax, is_employer_contribution,
          amount, benefit_plan_id, garnishment_id, cfdi_clave_sat, description)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          paycheckId, d.deduction_type, d.is_pre_tax, d.is_employer_contribution || false,
          d.amount, d.benefit_plan_id || null, d.garnishment_id || null,
          d.cfdi_clave_sat || null, d.description || null,
        ]
      );
    }

    // EL DESGLOSE, EN LA MISMA TRANSACCIÓN QUE EL RECIBO.
    //
    // Va aquí y no en un paso posterior porque un recibo con la mitad de sus
    // impuestos apuntados es peor que uno sin ninguno: el formulario suma lo
    // que encuentra y no puede saber que falta algo.
    //
    // SIN `ON CONFLICT`, a propósito. El UNIQUE de la 067
    // (paycheck_id, tax_type, jurisdiction, employee_employer) está para que
    // apuntar dos veces el mismo impuesto sea un error ruidoso; taparlo con
    // DO NOTHING devolvería el silencio que la migración vino a quitar. Un
    // recibo es de un solo `paycheck_id` recién generado, así que un choque
    // aquí sólo puede venir de dos calculadoras declarando el mismo par —un
    // defecto de programación, no un reintento.
    for (const r of renglones) {
      await client.query(
        `INSERT INTO paycheck_taxes (
           paycheck_id, tax_type, jurisdiction, employee_employer,
           taxable_wages, rate, tax_amount, is_credit, calculation_notes
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          paycheckId, r.tax_type, r.jurisdiction, r.employee_employer,
          r.taxable_wages, r.rate, r.tax_amount, r.is_credit, r.calculation_notes,
        ]
      );
    }
  });

  return {
    paycheck_id: paycheckId,
    gross_earnings: grossEarnings,
    pre_tax_deductions: preTaxDeductions,
    post_tax_deductions: totalPostTax,
    employee_taxes: employeeTaxes.toNumber(),
    employer_taxes: employerTaxes.toNumber(),
    net_pay: netPay,
    subsidio_entregado_efectivo: subsidioEntregado.toFixed(4),
    breakdown,
  };
}
