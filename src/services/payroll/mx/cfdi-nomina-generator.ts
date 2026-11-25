import Decimal from 'decimal.js';
import type { PoolClient } from 'pg';
import { withTransaction } from '../../../database/connection.js';
import { daysBetween, toCalendarDate } from '../../../utils/calendar-date.js';
import type { Scope } from '../../../database/scope.js';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../../../utils/errors.js';
import { logger } from '../../../utils/logger.js';
import { pacRouter } from '../../integrations/mexico/pac/pac-router.js';
import { estadoParaPersistir } from '../../integrations/mexico/pac/simulacion.js';
import { CFDI_STATUSES, PAY_RUN_TYPES } from '../../../database/enums.js';
import type { PayFrequency } from '../tax-engine/tax-engine.interface.js';
import { storedIsrParts } from './isr-exemption.js';
import { runIsReleased, type PayRunStatus } from '../common/pay-run-release.js';

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

type CfdiStatus = (typeof CFDI_STATUSES)[number];

/**
 * CONTRACT: a paycheck that holds a payroll CFDI is not stamped again
 * (MNE-001-736, #601). A second stamp is a second CFDI before the SAT for the
 * same payment, and it took the first UUID off the paycheck, the only place
 * that remembered it.
 *
 * `stamped` holds one. The other three do not: a paycheck with no status is
 * shown as `pending` (paycheck-read-service.ts); `failed` is how the UUID a
 * simulated adapter made up is stored, and the SAT never saw it; a `cancelled`
 * CFDI is replaced by a new one. No door cancels a payroll CFDI yet: this is
 * the door left for it.
 *
 * A record with every status on purpose: one added to CFDI_STATUSES does not
 * compile until someone decides it here. The column has no CHECK, so a value
 * this code does not know is refused: it is not known to be free.
 */
const HOLDS_A_PAYROLL_CFDI: Record<CfdiStatus, boolean> = {
  pending: false,
  stamped: true,
  cancelled: false,
  failed: false,
};
const FREE_TO_STAMP = CFDI_STATUSES.filter((status) => !HOLDS_A_PAYROLL_CFDI[status]);

export function paycheckIsFreeToStamp(status: string | null): boolean {
  return status === null || (FREE_TO_STAMP as readonly string[]).includes(status);
}

/** What the PAC answered, kept outside the transaction that writes it down. */
interface Issued {
  cfdi?: { uuid: string; provider: string };
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
  // ONE TRANSACTION, AND THE PAYCHECK'S ROW HELD FROM THE READ TO THE WRITE
  // (MNE-001-736, #601). Two stamps of one paycheck at once both read it
  // unstamped and both reached the PAC. The lock is released by the COMMIT, or
  // by Postgres if the process dies, so no marker is left that someone has to
  // clear; the price is one pooled connection and one row for as long as the
  // PAC takes. The other stamp waits for it, bounded by the pool's
  // `lock_timeout`, and then reads the row as the first one left it.
  const issued: Issued = {};
  try {
    return await withTransaction((tx) => stampHoldingThePaycheck(tx, paycheckId, context, scope, issued));
  } catch (error) {
    // Nothing reached the PAC, or the refusal is already the one below.
    if (!issued.cfdi || (error instanceof AppError && error.code === 'PAYROLL_CFDI_NOT_RECORDED')) throw error;
    throw stampNotRecorded(paycheckId, issued.cfdi, error);
  }
}

/**
 * The PAC issued a CFDI and the paycheck does not carry its UUID: the write
 * failed, or the transaction was lost while the PAC worked. The UUID is said
 * here, in the answer and in the log, because nothing else remembers it.
 */
function stampNotRecorded(
  paycheckId: string,
  cfdi: { uuid: string; provider: string },
  cause: unknown
): AppError {
  logger.error('payroll_cfdi_stamped_not_recorded', {
    paycheckId,
    cfdiUuid: cfdi.uuid,
    provider: cfdi.provider,
    error: cause instanceof Error ? cause.message : 'the write of the UUID touched no row',
  });
  return new AppError(500, 'PAYROLL_CFDI_NOT_RECORDED', {
    key: 'payrun.cfdi.stamped_not_recorded',
    params: { id: paycheckId, uuid: cfdi.uuid, provider: cfdi.provider },
  });
}

async function stampHoldingThePaycheck(
  tx: PoolClient,
  paycheckId: string,
  context: { tenantId: string; userId: string },
  scope: Scope,
  issued: Issued
): Promise<CfdiStampResult> {
  // El eje de entidad va sobre `employees`, que el JOIN ya trae. Un alcance de
  // inquilino no añade nada: `p.tenant_id` ya lo acota.
  const predicadoEntidad =
    scope.kind === 'entity'
      ? { sql: 'e.entity_id = $3', valores: [scope.entityId] }
      : { sql: 'TRUE', valores: [] as string[] };
  const result = await tx.query<{
    paycheck_id: string;
    tenant_id: string;
    cfdi_uuid: string | null;
    cfdi_status: string | null;
    cfdi_stamped_at: Date | null;
    gross_earnings: string;
    net_pay: string;
    isr_withheld: string;
    subsidio_empleo: string;
    subsidio_entregado_efectivo: string;
    imss_employee: string;
    infonavit_withheld: string;
    // The driver hands a DATE column over as a `Date`, not as text.
    period_start: Date;
    period_end: Date;
    pay_date: Date;
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
    hire_date: Date;
    entity_tax_id: string;
    entity_name: string;
    run_id: string;
    run_status: PayRunStatus;
    run_type: PayRunType;
    pay_frequency: Exclude<PayFrequency, 'annual'>;
  }>(
    `SELECT p.id AS paycheck_id, p.tenant_id,
            p.cfdi_uuid, p.cfdi_status, p.cfdi_stamped_at,
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
            pr.id AS run_id, pr.status AS run_status, pr.run_type, ps.frequency AS pay_frequency
     FROM paychecks p
     JOIN pay_runs pr ON pr.id = p.pay_run_id
     JOIN pay_periods pp ON pp.id = pr.pay_period_id
     JOIN pay_schedules ps ON ps.id = pp.pay_schedule_id
     JOIN employees e ON e.id = p.employee_id
     JOIN legal_entities ent ON ent.id = e.entity_id
     WHERE p.id = $1 AND p.tenant_id = $2 AND ${predicadoEntidad.sql}
       FOR NO KEY UPDATE OF p`,
    [paycheckId, scope.tenantId, ...predicadoEntidad.valores]
  ).catch((error: unknown) => {
    // 55P03 lock_not_available: `lock_timeout` ran out while another stamp, or
    // another writer of the paycheck, held the row. This attempt sent nothing.
    if ((error as { code?: string }).code === '55P03') {
      throw new ConflictError({ key: 'payrun.cfdi.stamp_in_progress', params: { id: paycheckId } });
    }
    throw error;
  });
  if (result.rows.length === 0) throw new NotFoundError('Paycheck', paycheckId);
  const r = result.rows[0];

  // THE RUN'S STATUS, BEFORE ANYTHING ELSE IS READ OR SENT (MNE-001-720, #601).
  // It rides in the statement above, after the scope: a paycheck outside it is
  // still a 404 in any state. A paycheck of a run nobody approved was stamped
  // like any other, and a stamp is cancelled before the SAT, not erased here.
  if (!runIsReleased(r.run_status)) {
    throw new ConflictError({
      key: 'payrun.cfdi.run_not_approved',
      params: { id: paycheckId, run: r.run_id, status: r.run_status },
    });
  }

  // THE PAYCHECK'S OWN CFDI, READ UNDER THE LOCK IN THE STATEMENT ABOVE
  // (MNE-001-736). After the run's status, so a paycheck of an unapproved run
  // still answers that; before anything else is read or sent. A stamp that
  // waited for another one reads the row as that one left it.
  if (!paycheckIsFreeToStamp(r.cfdi_status)) {
    throw new ConflictError({
      key: 'payrun.cfdi.already_stamped',
      params: {
        id: paycheckId,
        uuid: r.cfdi_uuid ?? '-',
        status: r.cfdi_status ?? '-',
        stamped_at: r.cfdi_stamped_at?.toISOString() ?? '-',
      },
    });
  }

  // THE FOUR DATES, AS THE CALENDAR DAYS THE COLUMNS STORE (MNE-001-735, #601).
  // The driver builds a `Date` at local midnight from a DATE column, and a
  // template writes a `Date` as «Fri Aug 14 2026 00:00:00 GMT+0000 (…)»: that
  // text went into the voucher's own number and issue date and into the four
  // dates of the complement, and the unit specs, which hand over strings, never
  // saw it. `toCalendarDate` reads the stored day in any zone and refuses what
  // is not a day, here, before anything is sent: a stamp is not taken back.
  // CONTRACT: the issue date is tdCFDI:t_FechaH, AAAA-MM-DDThh:mm:ss
  // (cfdv40.xsd:729); FechaPago, FechaInicialPago, FechaFinalPago and
  // FechaInicioRelLaboral are AAAA-MM-DD (the complement's schema, lines 657,
  // 662, 667 and 111).
  const payDate = toCalendarDate(r.pay_date);
  const periodStart = toCalendarDate(r.period_start);
  const periodEnd = toCalendarDate(r.period_end);
  const hireDate = toCalendarDate(r.hire_date);

  // Load earnings and deductions
  const earnings = await tx.query<{
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
  const deductions = await tx.query<{ cfdi_clave_sat: string | null; amount: string; description: string | null; deduction_type: string }>(
    `SELECT cfdi_clave_sat, amount, description, deduction_type FROM paycheck_deductions WHERE paycheck_id = $1 AND NOT is_employer_contribution`,
    [paycheckId]
  );

  const totalPercepciones = parseFloat(r.gross_earnings);
  const isrNet = Math.max(0, parseFloat(r.isr_withheld) - parseFloat(r.subsidio_empleo));
  const totalImpRetenidos = isrNet;
  const totalOtrasDeducciones = parseFloat(r.imss_employee) + parseFloat(r.infonavit_withheld) +
    deductions.rows.reduce((s, d) => s + parseFloat(d.amount), 0);
  const totalDeducciones = totalImpRetenidos + totalOtrasDeducciones;

  const subsidyOtherPayment = employmentSubsidyOtherPayment({
    isr: r.isr_withheld,
    subsidyCaused: r.subsidio_empleo,
    cashHandedOver: r.subsidio_entregado_efectivo ?? '0',
  });

  // Days worked in period (inclusive)
  // #243 · Días de calendario, inclusive: este número viaja en el XML que se
  // le timbra al SAT.
  const days = daysBetween(periodStart, periodEnd) + 1;

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
  const seniority = seniorityWeeks(hireDate, periodEnd);

  // Build minimal CFDI 4.0 payroll (Nomina) XML
  // NOTE: the hour of the issue date is a literal, not a clock. cfdv40.xsd:731
  // asks for the local time of the place of issue; MNE-001-735 left it as is.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" xmlns:nomina12="http://www.sat.gob.mx/nomina12"
  Version="4.0" TipoDeComprobante="N" Folio="NOM-${r.emp_number}-${payDate}"
  Fecha="${payDate}T10:00:00" FormaPago="99" SubTotal="${totalPercepciones.toFixed(2)}"
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
      FechaPago="${payDate}" FechaInicialPago="${periodStart}" FechaFinalPago="${periodEnd}"
      NumDiasPagados="${days}" TotalPercepciones="${totalPercepciones.toFixed(2)}"
      TotalDeducciones="${totalDeducciones.toFixed(2)}"${subsidyOtherPayment ? ` TotalOtrosPagos="${subsidyOtherPayment.total}"` : ''}>
      <nomina12:Emisor RegistroPatronal="B0000000000"/>
      <nomina12:Receptor Curp="${r.emp_curp || 'XAXX010101HDFNNN00'}" NumSeguridadSocial="${r.emp_nss || ''}"
        FechaInicioRelLaboral="${hireDate}" Antiguedad="${seniority}"
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
${subsidyOtherPayment?.xml ?? ''}    </nomina12:Nomina>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

  // Stamp via multi-PAC router (reuses existing integration — failover Finkok → SW Sapien → Edicom)
  //
  // The transaction is open and idle while the PAC works. `pg` hands the loss
  // of a connection somebody holds to its `error` event, and with nobody
  // listening Node ends the process: the listener is what lets the write below
  // fail and say which UUID it could not record. A lost connection keeps it,
  // because the driver reports the loss twice and is then dropped by the pool.
  let lost = false;
  const connectionLost = (): void => {
    lost = true;
  };
  tx.on('error', connectionLost);
  const stamp = await pacRouter
    .stamp(xml, { tenantId: context.tenantId, userId: context.userId })
    .finally(() => {
      if (!lost) tx.off('error', connectionLost);
    });
  issued.cfdi = { uuid: stamp.uuid, provider: stamp.provider_used };

  // Un folio simulado no se guarda como timbrado: ver el cerrojo en
  // services/integrations/mexico/pac/simulacion.ts.
  const { cfdi_status } = estadoParaPersistir(stamp);

  // The write names its paycheck by the scope and by the state it was read in.
  // The lock makes any other count unreachable; it is checked all the same,
  // because a UUID that is not written down is a CFDI nobody can cancel.
  const written = await tx.query(
    `UPDATE paychecks SET cfdi_uuid = $1, cfdi_status = $2, cfdi_provider = $3, cfdi_stamped_at = NOW()
     WHERE id = $4 AND tenant_id = $5
       AND (cfdi_status IS NULL OR cfdi_status = ANY($6::text[]))
       AND ($7::uuid IS NULL OR EXISTS (
             SELECT 1 FROM employees e WHERE e.id = paychecks.employee_id AND e.entity_id = $7::uuid))`,
    [
      stamp.uuid, cfdi_status, stamp.provider_used, paycheckId, scope.tenantId,
      FREE_TO_STAMP, scope.kind === 'entity' ? scope.entityId : null,
    ]
  );
  if (written.rowCount !== 1) throw stampNotRecorded(paycheckId, issued.cfdi, undefined);

  return {
    cfdi_uuid: stamp.uuid,
    provider_used: stamp.provider_used,
    xml,
    fecha_timbrado: stamp.fecha_timbrado,
    no_certificado_sat: stamp.no_certificado_sat,
  };
}

/**
 * CONTRACT: the employment subsidy node of the payroll CFDI (#600, MNE-001-551).
 *
 * When the subsidy caused exceeds the ISR of the paycheck, the complement
 * declares OtroPago 002 with the cash the paycheck stored. That cash is the law
 * of the payment date, already applied by the calculation
 * (`employment_subsidy.excess_over_isr_paid_share`): the excess until
 * 30 April 2024, 0.00 from 1 May 2024. Nothing is decided here.
 *
 * What the SAT's documents say, as read on 2026-11-19:
 * - Guide («Guía de llenado del comprobante del recibo de pago de nómina y su
 *   complemento», CFDI 4.0 / complement 1.2, last change 16 Jan 2026), field
 *   SubsidioCausado: «Se debe registrar el subsidio causado conforme a la
 *   normatividad vigente. El valor de este dato debe ser mayor o igual que el
 *   valor del campo "Importe" de la Información de OtroPago.» So it is the
 *   whole subsidy of the period (`paychecks.subsidio_empleo`), not the part
 *   the ISR absorbed.
 * - Standard of the complement (revision C, 29 Dec 2021), OtroPago.Importe:
 *   «Si el valor del atributo TipoOtroPago es "002", este atributo debe ser
 *   menor o igual que el valor del atributo SubsidioCausado», and only the
 *   other keys must be above zero. Importe="0.00" is therefore valid, and
 *   TotalOtrosPagos must exist whenever OtrosPagos does.
 *
 * With the ISR at or above the subsidy no node is written, as before: that
 * band belongs to MNE-001-279 (#92). A cash amount with no excess (a stored
 * paycheck that does not add up) is still declared, so Total keeps its
 * identity; one above the subsidy caused is refused, because a stamped CFDI
 * cannot be taken back.
 */
export function employmentSubsidyOtherPayment(p: {
  isr: string;
  subsidyCaused: string;
  cashHandedOver: string;
}): { xml: string; total: string } | null {
  const caused = new Decimal(p.subsidyCaused);
  const cash = new Decimal(p.cashHandedOver);
  if (!caused.greaterThan(p.isr) && !cash.greaterThan(0)) return null;
  if (cash.greaterThan(caused)) {
    throw new ValidationError(
      `The employment subsidy handed over in cash (${cash.toFixed(2)}) is above the subsidy caused ` +
        `(${caused.toFixed(2)}): OtroPago 002 cannot state it`,
      'subsidio_entregado_efectivo'
    );
  }
  const total = cash.toFixed(2);
  const xml = `      <nomina12:OtrosPagos>
        <nomina12:OtroPago TipoOtroPago="002" Clave="002" Concepto="Subsidio para el empleo (efectivamente entregado al trabajador)" Importe="${total}">
          <nomina12:SubsidioAlEmpleo SubsidioCausado="${caused.toFixed(2)}"/>
        </nomina12:OtroPago>
      </nomina12:OtrosPagos>
`;
  return { xml, total };
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
