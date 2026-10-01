import Decimal from 'decimal.js';
import { query } from '../../../database/connection.js';
import { daysBetween } from '../../../utils/calendar-date.js';
import type { Scope } from '../../../database/scope.js';
import { NotFoundError, ValidationError } from '../../../utils/errors.js';
import { pacRouter } from '../../integrations/mexico/pac/pac-router.js';
import { estadoParaPersistir } from '../../integrations/mexico/pac/simulacion.js';
import { PAY_RUN_TYPES } from '../../../database/enums.js';
import type { PayFrequency } from '../tax-engine/tax-engine.interface.js';
import { storedIsrParts } from './isr-exemption.js';

// ============================================================
// CFDI 4.0 PAYROLL — voucher type N (Comprobante Tipo N) + Nomina 1.2 complement
// Generates XML, stamps via multi-PAC router, persists UUID.
// ============================================================

interface CfdiStampResult {
  cfdi_uuid: string;
  provider_used: string;
  xml: string;
  fecha_timbrado: string | Date;
  no_certificado_sat: string;
}

/**
 * EL TIMBRE ES IRREVERSIBLE Y SALE DEL SISTEMA, y la consulta decía
 * `WHERE p.id = $1` (T9c · #96).
 *
 * Recibía `tenantId` en el contexto y NO lo usaba en el SQL: un id de recibo
 * bastaba para armar el CFDI de nómina de cualquier despacho —con el RFC, la
 * CURP y el NSS de su empleado dentro— y mandarlo a timbrar. Medido, una
 * sesión de la sociedad A sobre el recibo de la B llegaba hasta el final y
 * sólo la paraba el guardián del PAC simulado, que es otra puerta que da la
 * casualidad de estar en medio: con un PAC de verdad configurado, el
 * comprobante se emitía.
 *
 * El `JOIN employees e` ya estaba: la entidad no necesita camino aquí, sólo
 * la columna que el JOIN ya trae.
 */
export async function generateAndStampCfdiNomina(
  paycheckId: string,
  context: { tenantId: string; userId: string },
  scope: Scope
): Promise<CfdiStampResult> {
  // El eje de entidad va sobre `employees`, que el JOIN ya trae. Un alcance de
  // inquilino no añade nada: `p.tenant_id` ya lo acota.
  const predicadoEntidad =
    scope.kind === 'entity'
      ? { sql: 'e.entity_id = $3', valores: [scope.entityId] }
      : { sql: 'TRUE', valores: [] as string[] };
  const result = await query<{
    paycheck_id: string;
    tenant_id: string;
    gross_earnings: string;
    net_pay: string;
    isr_withheld: string;
    subsidio_empleo: string;
    subsidio_entregado_efectivo: string;
    imss_employee: string;
    infonavit_withheld: string;
    period_start: string;
    period_end: string;
    pay_date: string;
    tax_year: number;
    emp_first: string;
    emp_last: string;
    emp_second_last: string | null;
    emp_rfc: string | null;
    emp_curp: string | null;
    emp_nss: string | null;
    emp_number: string;
    tipo_regimen_sat: string | null;
    tipo_contrato_sat: string | null;
    tipo_jornada_sat: string | null;
    riesgo_puesto: string | null;
    puesto: string | null;
    hire_date: string;
    entity_tax_id: string;
    entity_name: string;
    run_type: PayRunType;
    pay_frequency: Exclude<PayFrequency, 'annual'>;
  }>(
    `SELECT p.id AS paycheck_id, p.tenant_id,
            p.gross_earnings, p.net_pay,
            p.isr_withheld, p.subsidio_empleo, p.subsidio_entregado_efectivo,
            p.imss_employee, p.infonavit_withheld,
            pp.period_start, pp.period_end, pp.pay_date, pp.tax_year,
            e.first_name AS emp_first, e.last_name AS emp_last, e.second_last_name AS emp_second_last,
            e.rfc AS emp_rfc, e.curp AS emp_curp, e.nss AS emp_nss,
            e.employee_number AS emp_number,
            e.tipo_regimen_sat, e.tipo_contrato_sat, e.tipo_jornada_sat,
            e.riesgo_puesto, e.puesto, e.hire_date,
            ent.tax_id AS entity_tax_id, ent.name AS entity_name,
            pr.run_type, ps.frequency AS pay_frequency
     FROM paychecks p
     JOIN pay_runs pr ON pr.id = p.pay_run_id
     JOIN pay_periods pp ON pp.id = pr.pay_period_id
     JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id
     JOIN employees e ON e.id = p.employee_id
     JOIN legal_entities ent ON ent.id = e.entity_id
     WHERE p.id = $1 AND p.tenant_id = $2 AND ${predicadoEntidad.sql}`,
    [paycheckId, scope.tenantId, ...predicadoEntidad.valores]
  );
  if (result.rows.length === 0) throw new NotFoundError('Paycheck', paycheckId);
  const r = result.rows[0];

  // Load earnings and deductions
  const earnings = await query<{
    cfdi_clave_sat: string | null;
    amount: string;
    description: string | null;
    earning_type: string;
    is_taxable_isr: boolean;
    isr_exempt_amount: string | null;
    isr_taxable_amount: string | null;
  }>(
    `SELECT cfdi_clave_sat, amount, description, earning_type,
            is_taxable_isr, isr_exempt_amount, isr_taxable_amount
       FROM paycheck_earnings WHERE paycheck_id = $1`,
    [paycheckId]
  );
  const deductions = await query<{ cfdi_clave_sat: string | null; amount: string; description: string | null; deduction_type: string }>(
    `SELECT cfdi_clave_sat, amount, description, deduction_type FROM paycheck_deductions WHERE paycheck_id = $1 AND NOT is_employer_contribution`,
    [paycheckId]
  );

  const totalPercepciones = parseFloat(r.gross_earnings);
  const isrNet = Math.max(0, parseFloat(r.isr_withheld) - parseFloat(r.subsidio_empleo));
  const totalImpRetenidos = isrNet;
  const totalOtrasDeducciones = parseFloat(r.imss_employee) + parseFloat(r.infonavit_withheld) +
    deductions.rows.reduce((s, d) => s + parseFloat(d.amount), 0);
  const totalDeducciones = totalImpRetenidos + totalOtrasDeducciones;

  // EL SUBSIDIO ENTREGADO SE DECLARA, O EL COMPROBANTE NO CUADRA CONSIGO MISMO.
  //
  // Desde F08a el trabajador recibe en efectivo el subsidio que excedió a su
  // ISR, y ese importe entra en `net_pay` —que es el `Total` del comprobante—.
  // Sin el nodo OtrosPagos, Total ≠ SubTotal − Descuento y el CFDI se cae en la
  // validación del PAC: un verificador lo midió en 1 588.39 contra 1 464.37,
  // exactamente los 124.02 entregados.
  //
  // El `SubsidioCausado` del nodo NO es el importe entregado sino el que la
  // tabla del subsidio arroja para el periodo, que es lo que guarda la columna
  // `subsidio_empleo`. Los dos números conviven en el mismo nodo a propósito:
  // el SAT cruza el causado contra lo entregado.
  const subsidioEntregado = parseFloat(r.subsidio_entregado_efectivo ?? '0');
  const subsidioCausado = parseFloat(r.subsidio_empleo);
  const otrosPagosXml =
    subsidioEntregado > 0
      ? `      <nomina12:OtrosPagos>
        <nomina12:OtroPago TipoOtroPago="002" Clave="002" Concepto="Subsidio para el empleo (efectivamente entregado al trabajador)" Importe="${subsidioEntregado.toFixed(2)}">
          <nomina12:SubsidioAlEmpleo SubsidioCausado="${subsidioCausado.toFixed(2)}"/>
        </nomina12:OtroPago>
      </nomina12:OtrosPagos>
`
      : '';

  // Days worked in period (inclusive)
  // #243 · Días de calendario, inclusive: este número viaja en el XML que se
  // le timbra al SAT.
  const days = daysBetween(r.period_start, r.period_end) + 1;

  // THE EXEMPT PART IS THE ONE THE ISR WAS COMPUTED WITH (#297, MNE-001-063).
  // It was a literal zero, so an aguinaldo the engine exempted was declared to
  // the SAT as taxed whole. `storedIsrParts` reads back what the row stored.
  const isrParts = earnings.rows.map(storedIsrParts);
  const totalTaxable = Decimal.sum(0, ...isrParts.map((p) => p.taxable));
  const totalExempt = Decimal.sum(0, ...isrParts.map((p) => p.exempt));

  const percepcionesXml = earnings.rows.map((e, i) => `    <nomina12:Percepcion TipoPercepcion="${e.cfdi_clave_sat || '001'}" Clave="${e.earning_type}" Concepto="${escapeXml(e.description || e.earning_type)}" ImporteGravado="${isrParts[i].taxable.toFixed(2)}" ImporteExento="${isrParts[i].exempt.toFixed(2)}"/>`).join('\n');
  const deduccionesXml = deductions.rows.map((d) => `    <nomina12:Deduccion TipoDeduccion="${d.cfdi_clave_sat || '004'}" Clave="${d.deduction_type}" Concepto="${escapeXml(d.description || d.deduction_type)}" Importe="${parseFloat(d.amount).toFixed(2)}"/>`).join('\n');

  const payrollType = payrollTypeForRunType(r.run_type);
  const paymentPeriodicity = paymentPeriodicityFor(payrollType, r.pay_frequency);
  const seniority = seniorityWeeks(r.hire_date, r.period_end);

  // Build minimal CFDI 4.0 payroll (Nomina) XML
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:nomina12="http://www.sat.gob.mx/nomina12"
  Version="4.0" TipoDeComprobante="N" Folio="NOM-${r.emp_number}-${r.pay_date}"
  Fecha="${r.pay_date}T10:00:00" FormaPago="99" SubTotal="${totalPercepciones.toFixed(2)}"
  Descuento="${totalDeducciones.toFixed(2)}" Total="${parseFloat(r.net_pay).toFixed(2)}"
  Moneda="MXN" LugarExpedicion="00000" Exportacion="01" MetodoPago="PUE">
  <cfdi:Emisor Rfc="${r.entity_tax_id || 'XAXX010101000'}" Nombre="${escapeXml(r.entity_name)}" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="${r.emp_rfc || 'XAXX010101000'}" Nombre="${escapeXml(r.emp_first + ' ' + r.emp_last)}"
    DomicilioFiscalReceptor="00000" RegimenFiscalReceptor="605" UsoCFDI="CN01"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="84111505" Cantidad="1" ClaveUnidad="ACT" Descripcion="Pago de nómina"
      ValorUnitario="${totalPercepciones.toFixed(2)}" Importe="${totalPercepciones.toFixed(2)}" Descuento="${totalDeducciones.toFixed(2)}" ObjetoImp="01"/>
  </cfdi:Conceptos>
  <cfdi:Complemento>
    <nomina12:Nomina Version="1.2" TipoNomina="${payrollType}"
      FechaPago="${r.pay_date}" FechaInicialPago="${r.period_start}" FechaFinalPago="${r.period_end}"
      NumDiasPagados="${days}" TotalPercepciones="${totalPercepciones.toFixed(2)}"
      TotalDeducciones="${totalDeducciones.toFixed(2)}"${subsidioEntregado > 0 ? ` TotalOtrosPagos="${subsidioEntregado.toFixed(2)}"` : ''}>
      <nomina12:Emisor RegistroPatronal="B0000000000"/>
      <nomina12:Receptor Curp="${r.emp_curp || 'XAXX010101HDFNNN00'}" NumSeguridadSocial="${r.emp_nss || ''}"
        FechaInicioRelLaboral="${r.hire_date}" Antiguedad="${seniority}"
        TipoContrato="${r.tipo_contrato_sat || '01'}" TipoJornada="${r.tipo_jornada_sat || '01'}"
        TipoRegimen="${r.tipo_regimen_sat || '02'}" NumEmpleado="${r.emp_number}"
        Puesto="${escapeXml(r.puesto || 'Empleado')}" RiesgoPuesto="${r.riesgo_puesto || '01'}"
        PeriodicidadPago="${paymentPeriodicity}" ClaveEntFed="MEX"/>
      <nomina12:Percepciones TotalGravado="${totalTaxable.toFixed(2)}" TotalExento="${totalExempt.toFixed(2)}" TotalSueldos="${totalPercepciones.toFixed(2)}">
${percepcionesXml}
      </nomina12:Percepciones>
      <nomina12:Deducciones TotalOtrasDeducciones="${totalOtrasDeducciones.toFixed(2)}" TotalImpuestosRetenidos="${totalImpRetenidos.toFixed(2)}">
${deduccionesXml}
        ${totalImpRetenidos > 0 ? `<nomina12:Deduccion TipoDeduccion="002" Clave="ISR" Concepto="ISR" Importe="${totalImpRetenidos.toFixed(2)}"/>` : ''}
      </nomina12:Deducciones>
${otrosPagosXml}    </nomina12:Nomina>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

  // Stamp via multi-PAC router (reuses existing integration — failover Finkok → SW Sapien → Edicom)
  const stamp = await pacRouter.stamp(xml, {
    tenantId: context.tenantId,
    userId: context.userId,
  });

  // Un folio simulado no se guarda como timbrado: ver el cerrojo en
  // services/integrations/mexico/pac/simulacion.ts.
  const { cfdi_status } = estadoParaPersistir(stamp);

  await query(
    `UPDATE paychecks SET cfdi_uuid = $1, cfdi_status = $2, cfdi_provider = $3, cfdi_stamped_at = NOW()
     WHERE id = $4`,
    [stamp.uuid, cfdi_status, stamp.provider_used, paycheckId]
  );

  return {
    cfdi_uuid: stamp.uuid,
    provider_used: stamp.provider_used,
    xml,
    fecha_timbrado: stamp.fecha_timbrado,
    no_certificado_sat: stamp.no_certificado_sat,
  };
}

type PayRunType = (typeof PAY_RUN_TYPES)[number];

/**
 * TipoNomina comes from the run, not from the employee's surname. SAT payroll
 * complement guide: E (extraordinaria) is for a payment outside the ordinary
 * cadence (bonus, final settlement, off-cycle), O for the ordinary one.
 * A correction is refused: it may re-issue an ordinary run (O) or a bonus,
 * final or off-cycle one (E), and pay_runs holds no pointer to the corrected
 * run, so the type cannot be derived.
 */
export function payrollTypeForRunType(runType: PayRunType): 'O' | 'E' {
  switch (runType) {
    case 'regular':
      return 'O';
    case 'bonus':
    case 'final':
    case 'off_cycle':
      return 'E';
    case 'correction':
      throw new ValidationError(
        'A correction run cannot be stamped as a payroll CFDI: its TipoNomina depends on the run it corrects, which is not recorded',
        'run_type'
      );
    default: {
      const unreachable: never = runType;
      throw new ValidationError(`Unknown pay run type for CFDI TipoNomina: ${String(unreachable)}`, 'run_type');
    }
  }
}

/**
 * PeriodicidadPago from the pay schedule, per c_PeriodicidadPago (02 weekly,
 * 03 biweekly, 04 semimonthly, 05 monthly). SAT payroll complement guide: when
 * TipoNomina is E the value is 99, an extraordinary payment has no periodicity.
 */
export function paymentPeriodicityFor(
  kind: 'O' | 'E',
  frequency: Exclude<PayFrequency, 'annual'>
): string {
  if (kind === 'E') return '99';
  switch (frequency) {
    case 'weekly': return '02';
    case 'biweekly': return '03';
    case 'semimonthly':
    case 'quincenal': return '04';
    case 'monthly': return '05';
    default: {
      const unreachable: never = frequency;
      throw new ValidationError(
        `Unknown pay schedule frequency for CFDI PeriodicidadPago: ${String(unreachable)}`,
        'frequency'
      );
    }
  }
}

/**
 * Antiguedad as P{n}W: whole weeks from hire date to the end of the paid
 * period, both days counted. A hire date after the period end, or less than a
 * full week of seniority, is refused by naming the dates: a stamped CFDI cannot
 * be taken back, so no week is invented.
 */
export function seniorityWeeks(hireDate: string | Date, periodEnd: string | Date): string {
  const days = daysBetween(hireDate, periodEnd) + 1;
  if (days < 1) {
    throw new ValidationError(
      `Hire date ${String(hireDate)} is after the period end ${String(periodEnd)}`,
      'hire_date'
    );
  }
  const weeks = Math.floor(days / 7);
  if (weeks < 1) {
    throw new ValidationError(
      `Seniority from hire date ${String(hireDate)} to period end ${String(periodEnd)} is under one week, which Antiguedad P{n}W cannot state`,
      'hire_date'
    );
  }
  return `P${weeks}W`;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
