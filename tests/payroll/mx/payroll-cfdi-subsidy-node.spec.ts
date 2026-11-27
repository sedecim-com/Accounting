import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import Decimal from 'decimal.js';

// MNE-001-551 (#600, part 3 of 3) · When the employment subsidy exceeds the ISR
// the payroll complement declares OtroPago 002 with the cash the paycheck
// stored (0.00 from 1 May 2024) and the whole subsidy caused, and the result is
// checked against the SAT's own nomina12.xsd.

// The generator runs on one transaction since MNE-001-736: its client is this same double.
vi.mock('../../../src/database/connection.js', () => {
  const query = vi.fn();
  return { query, withTransaction: (fn: (tx: unknown) => unknown) => fn({ query, on: vi.fn(), off: vi.fn() }) };
});
vi.mock('../../../src/services/integrations/mexico/pac/pac-router.js', () => ({
  pacRouter: { stamp: vi.fn() },
}));

import {
  generateAndStampCfdiNomina,
  employmentSubsidyOtherPayment,
} from '../../../src/services/payroll/mx/cfdi-nomina-generator.js';
import { validateAgainstPayrollComplementXsd } from '../../../src/services/sat/cfdi40/official-xsd.js';
import { query } from '../../../src/database/connection.js';
import { pacRouter } from '../../../src/services/integrations/mexico/pac/pac-router.js';

const mockQuery = query as unknown as Mock;
const mockStamp = pacRouter.stamp as unknown as Mock;

/** A fortnight of 100.00 whose ISR is 10.00 (stored before the subsidy). */
async function xmlFor(over: Record<string, string>): Promise<string> {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/FROM paychecks p/.test(sql)) {
      return {
        rows: [{
          cfdi_uuid: null, cfdi_status: null, cfdi_stamped_at: null,
          paycheck_id: 'pc-1', tenant_id: 't-1', gross_earnings: '100.00', net_pay: '100.00',
          isr_withheld: '10.00', subsidio_empleo: '100.00', subsidio_entregado_efectivo: '0',
          imss_employee: '0', infonavit_withheld: '0',
          period_start: '2026-03-01', period_end: '2026-03-15', pay_date: '2026-03-15', tax_year: 2026,
          emp_first: 'Ana', emp_last: 'Prueba', emp_second_last: null, emp_rfc: null, emp_curp: null,
          emp_nss: null, emp_number: 'E1', tipo_regimen_sat: '02', tipo_contrato_sat: '01',
          tipo_jornada_sat: '01', riesgo_puesto: '1', puesto: null, hire_date: '2026-01-05',
          entity_tax_id: 'AAA010101AAA', entity_name: 'Empresa',
          run_id: 'run-1', run_status: 'approved', run_type: 'regular', pay_frequency: 'quincenal', ...over,
        }],
      };
    }
    if (/FROM paycheck_earnings/.test(sql)) {
      return {
        rows: [{
          cfdi_clave_sat: '001', amount: '100.00', description: 'Sueldo', earning_type: 'regular',
          is_taxable_isr: true, isr_exempt_amount: '0.00', isr_taxable_amount: '100.00',
        }],
      };
    }
    return { rows: [], rowCount: 1 };
  });
  const r = await generateAndStampCfdiNomina(
    'pc-1', { tenantId: 't-1', userId: 'u-1' },
    { kind: 'entity', tenantId: 't-1', entityId: 'ent-1' }
  );
  return r.xml;
}

const attr = (xml: string, name: string): Decimal => {
  const m = new RegExp(`\\b${name}="([0-9.]+)"`).exec(xml);
  expect(m, `the XML carries no ${name}`).toBeTruthy();
  return new Decimal(m![1]);
};

function expectTotalIdentity(xml: string): void {
  const sum = attr(xml, 'SubTotal').minus(attr(xml, 'Descuento')).plus(attr(xml, 'TotalOtrosPagos'));
  expect(attr(xml, 'Total').toFixed(2)).toBe(sum.toFixed(2));
}

/**
 * The generated OtrosPagos inside a minimal hand-written Nomina, as the plan
 * of #600 allows. The whole generated complement does not pass nomina12.xsd
 * yet for four reasons outside the subsidy node, all of them for #92
 * (MNE-001-278, MNE-001-279): the attribute is written `Antiguedad` and the
 * schema names it `Antigüedad`; `NumSeguridadSocial=""` when the worker has no
 * NSS; the fallback `RiesgoPuesto="01"` is not in c_RiesgoPuesto (1 to 5, 99);
 * and `Deducciones` has no `Deduccion` child when nothing is deducted.
 */
function minimalComplementWith(xml: string): string {
  const node = /<nomina12:OtrosPagos>[\s\S]*<\/nomina12:OtrosPagos>/.exec(xml);
  expect(node, 'the XML carries no OtrosPagos').toBeTruthy();
  const total = /\bTotalOtrosPagos="[0-9.]+"/.exec(xml)![0];
  return `<nomina12:Nomina xmlns:nomina12="http://www.sat.gob.mx/nomina12" Version="1.2" TipoNomina="O"
  FechaPago="2026-03-15" FechaInicialPago="2026-03-01" FechaFinalPago="2026-03-15"
  NumDiasPagados="15" ${total}>
  <nomina12:Receptor Curp="AAAA800101HDFBBB09" TipoContrato="01" TipoRegimen="02"
    NumEmpleado="E1" PeriodicidadPago="04" ClaveEntFed="MEX"/>
  ${node![0]}
</nomina12:Nomina>`;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockStamp.mockReset();
  mockStamp.mockResolvedValue({
    uuid: 'u', provider_used: 'p', fecha_timbrado: '2026-03-15T10:00:00', no_certificado_sat: '0', simulado: true,
  });
});

describe('the employment subsidy node of the payroll CFDI', () => {
  it('T10 · excess under the rule of 1 May 2024: OtroPago 002 with Importe 0.00 and the whole subsidy caused', async () => {
    const xml = await xmlFor({});
    expect(xml).toMatch(/<nomina12:OtroPago TipoOtroPago="002"[^>]* Importe="0\.00">/);
    expect(xml).toContain('<nomina12:SubsidioAlEmpleo SubsidioCausado="100.00"/>');
    expect(xml).toContain('TotalOtrosPagos="0.00"');
    expect(xml).not.toMatch(/TipoDeduccion="002"/);
    // With no Deduccion 002 the attribute must not exist (standard, revision C; MNE-001-923).
    expect(xml).not.toContain('TotalImpuestosRetenidos');
    expectTotalIdentity(xml);
  });

  it('T11 · excess under the rule before it: Importe and TotalOtrosPagos are the 90.00 handed over', async () => {
    const xml = await xmlFor({ subsidio_entregado_efectivo: '90.00', net_pay: '190.00' });
    expect(xml).toMatch(/<nomina12:OtroPago TipoOtroPago="002"[^>]* Importe="90\.00">/);
    expect(xml).toContain('<nomina12:SubsidioAlEmpleo SubsidioCausado="100.00"/>');
    expect(xml).toContain('TotalOtrosPagos="90.00"');
    expect(xml).not.toMatch(/TipoDeduccion="002"/);
    expectTotalIdentity(xml);
  });

  it('T12 · the node of both rules passes the SAT nomina12.xsd', async () => {
    const rules: Record<string, string>[] = [{}, { subsidio_entregado_efectivo: '90.00', net_pay: '190.00' }];
    for (const over of rules) {
      const verdict = validateAgainstPayrollComplementXsd(minimalComplementWith(await xmlFor(over)));
      expect(verdict.errors).toEqual([]);
      expect(verdict.valid).toBe(true);
    }
  });

  it('T12 · the schema is the one that judges: a key outside c_TipoOtroPago is refused', async () => {
    const broken = minimalComplementWith(await xmlFor({})).replace('TipoOtroPago="002"', 'TipoOtroPago="ZZZ"');
    const verdict = validateAgainstPayrollComplementXsd(broken);
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/TipoOtroPago/);
  });

  // MNE-001-279 (#92) reversed the first half of T13: a TipoRegimen 02 receipt
  // always declares OtroPago 002 (NOM105), so the ordinary band carries it too.
  it('T13 · ISR above the subsidy: OtroPago 002 with Importe 0.00, and the ISR deduction is the difference', async () => {
    const xml = await xmlFor({ isr_withheld: '150.00', net_pay: '50.00' });
    expect(xml).toMatch(/<nomina12:OtroPago TipoOtroPago="002"[^>]* Importe="0\.00">/);
    expect(xml).toContain('<nomina12:SubsidioAlEmpleo SubsidioCausado="100.00"/>');
    expect(xml).toContain('TotalOtrosPagos="0.00"');
    expect(xml).toContain('<nomina12:Deduccion TipoDeduccion="002" Clave="ISR" Concepto="ISR" Importe="50.00"/>');
    expectTotalIdentity(xml);
    const ordinary = { subsidyCaused: '100.00', cashHandedOver: '0' };
    expect(employmentSubsidyOtherPayment({ isr: '150.00', ...ordinary, regime: '02' })?.total).toBe('0.00');
    expect(employmentSubsidyOtherPayment({ isr: '100.00', ...ordinary, regime: '02' })?.total).toBe('0.00');
    // Outside TipoRegimen 02 the key 002 is not allowed (NOM106): no node, as before.
    expect(employmentSubsidyOtherPayment({ isr: '150.00', ...ordinary, regime: '09' })).toBeNull();
    expect(employmentSubsidyOtherPayment({ isr: '100.00', ...ordinary, regime: '09' })).toBeNull();
  });

  it('the pure function states the cash it is given and never more than the subsidy caused', () => {
    const excess = { isr: '10.00', subsidyCaused: '100.00', regime: '02' };
    expect(employmentSubsidyOtherPayment({ ...excess, cashHandedOver: '0' })?.total).toBe('0.00');
    expect(employmentSubsidyOtherPayment({ ...excess, cashHandedOver: '90' })?.total).toBe('90.00');
    expect(() => employmentSubsidyOtherPayment({ ...excess, cashHandedOver: '100.01' })).toThrow(/100\.01.*100\.00/);
  });
});
