import { query } from '../../../database/connection.js';
import { pacRouter } from '../../integrations/mexico/pac/pac-router.js';
import { estadoParaPersistir } from '../../integrations/mexico/pac/simulacion.js';

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

export async function generateAndStampCfdiNomina(
  paycheckId: string,
  context: { tenantId: string; userId: string }
): Promise<CfdiStampResult> {
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
            ent.tax_id AS entity_tax_id, ent.name AS entity_name
     FROM paychecks p
     JOIN pay_runs pr ON pr.id = p.pay_run_id
     JOIN pay_periods pp ON pp.id = pr.pay_period_id
     JOIN employees e ON e.id = p.employee_id
     JOIN legal_entities ent ON ent.id = e.entity_id
     WHERE p.id = $1`,
    [paycheckId]
  );
  if (result.rows.length === 0) throw new Error('Paycheck not found');
  const r = result.rows[0];

  // Load earnings and deductions
  const earnings = await query<{ cfdi_clave_sat: string | null; amount: string; description: string | null; earning_type: string }>(
    `SELECT cfdi_clave_sat, amount, description, earning_type FROM paycheck_earnings WHERE paycheck_id = $1`,
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
  const days = Math.floor(
    (new Date(r.period_end).getTime() - new Date(r.period_start).getTime()) / 86400000
  ) + 1;

  const percepcionesXml = earnings.rows.map((e) => `    <nomina12:Percepcion TipoPercepcion="${e.cfdi_clave_sat || '001'}" Clave="${e.earning_type}" Concepto="${escapeXml(e.description || e.earning_type)}" ImporteGravado="${parseFloat(e.amount).toFixed(2)}" ImporteExento="0.00"/>`).join('\n');
  const deduccionesXml = deductions.rows.map((d) => `    <nomina12:Deduccion TipoDeduccion="${d.cfdi_clave_sat || '004'}" Clave="${d.deduction_type}" Concepto="${escapeXml(d.description || d.deduction_type)}" Importe="${parseFloat(d.amount).toFixed(2)}"/>`).join('\n');

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
    <nomina12:Nomina Version="1.2" TipoNomina="${r.emp_second_last === 'EXTRAORDINARIA' ? 'E' : 'O'}"
      FechaPago="${r.pay_date}" FechaInicialPago="${r.period_start}" FechaFinalPago="${r.period_end}"
      NumDiasPagados="${days}" TotalPercepciones="${totalPercepciones.toFixed(2)}"
      TotalDeducciones="${totalDeducciones.toFixed(2)}"${subsidioEntregado > 0 ? ` TotalOtrosPagos="${subsidioEntregado.toFixed(2)}"` : ''}>
      <nomina12:Emisor RegistroPatronal="B0000000000"/>
      <nomina12:Receptor Curp="${r.emp_curp || 'XAXX010101HDFNNN00'}" NumSeguridadSocial="${r.emp_nss || ''}"
        FechaInicioRelLaboral="${r.hire_date}" Antiguedad="P0W"
        TipoContrato="${r.tipo_contrato_sat || '01'}" TipoJornada="${r.tipo_jornada_sat || '01'}"
        TipoRegimen="${r.tipo_regimen_sat || '02'}" NumEmpleado="${r.emp_number}"
        Puesto="${escapeXml(r.puesto || 'Empleado')}" RiesgoPuesto="${r.riesgo_puesto || '01'}"
        PeriodicidadPago="04" ClaveEntFed="MEX"/>
      <nomina12:Percepciones TotalGravado="${totalPercepciones.toFixed(2)}" TotalExento="0.00" TotalSueldos="${totalPercepciones.toFixed(2)}">
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

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
