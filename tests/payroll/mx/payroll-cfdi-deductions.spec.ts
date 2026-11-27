import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import Decimal from 'decimal.js';

// MNE-001-279 (#92) · The Deducciones node of the payroll CFDI adds up to its
// own children: the worker's IMSS (TipoDeduccion 001) and the INFONAVIT credit
// (010) are written as Deduccion nodes, and a TipoRegimen 02 receipt always
// declares OtroPago 002 with its SubsidioCausado (NOM105 of the SAT's matrix).

// The generator runs on one transaction since MNE-001-736: its client is this same double.
vi.mock('../../../src/database/connection.js', () => {
  const query = vi.fn();
  return { query, withTransaction: (fn: (tx: unknown) => unknown) => fn({ query, on: vi.fn(), off: vi.fn() }) };
});
vi.mock('../../../src/services/integrations/mexico/pac/pac-router.js', () => ({
  pacRouter: { stamp: vi.fn() },
}));

import { generateAndStampCfdiNomina } from '../../../src/services/payroll/mx/cfdi-nomina-generator.js';
import { validateAgainstPayrollComplementXsd } from '../../../src/services/sat/cfdi40/official-xsd.js';
import { query } from '../../../src/database/connection.js';
import { pacRouter } from '../../../src/services/integrations/mexico/pac/pac-router.js';

const mockQuery = query as unknown as Mock;
const mockStamp = pacRouter.stamp as unknown as Mock;

/**
 * A fortnight of 3,000.00, by hand. ISR before the subsidy 250.00, subsidy
 * caused 180.00, so 70.00 is retained. IMSS 71.25, INFONAVIT credit 300.00 and
 * a savings fund of 50.00 (the one row of paycheck_deductions):
 *   other deductions 71.25 + 300.00 + 50.00 = 421.25
 *   all deductions   421.25 + 70.00         = 491.25
 *   net pay          3,000.00 − 491.25      = 2,508.75
 */
const ORDINARY = {
  gross_earnings: '3000.00', isr_withheld: '250.00', subsidio_empleo: '180.00',
  subsidio_entregado_efectivo: '0.0000', imss_employee: '71.25', infonavit_withheld: '300.00',
  net_pay: '2508.75',
};
const SAVINGS = { cfdi_clave_sat: null, amount: '50.00', description: 'Fondo de ahorro', deduction_type: 'savings_fund' };

async function xmlFor(over: Record<string, string | null>, deductions: unknown[] = [SAVINGS]): Promise<string> {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/FROM paychecks p/.test(sql)) {
      return {
        rows: [{
          cfdi_uuid: null, cfdi_status: null, cfdi_stamped_at: null, paycheck_id: 'pc-1', tenant_id: 't-1',
          period_start: '2026-03-01', period_end: '2026-03-15', pay_date: '2026-03-15', tax_year: 2026,
          emp_first: 'Ana', emp_last: 'Prueba', emp_second_last: null, emp_rfc: null, emp_curp: null,
          emp_nss: null, emp_number: 'E1', tipo_regimen_sat: '02', tipo_contrato_sat: '01',
          tipo_jornada_sat: '01', riesgo_puesto: '1', puesto: null, hire_date: '2026-01-05',
          entity_tax_id: 'AAA010101AAA', entity_name: 'Empresa',
          run_id: 'run-1', run_status: 'approved', run_type: 'regular', pay_frequency: 'quincenal',
          ...ORDINARY, ...over,
        }],
      };
    }
    if (/FROM paycheck_earnings/.test(sql)) {
      return {
        rows: [{
          cfdi_clave_sat: '001', amount: '3000.00', description: 'Sueldo', earning_type: 'regular',
          is_taxable_isr: true, isr_exempt_amount: '0.00', isr_taxable_amount: '3000.00',
        }],
      };
    }
    if (/FROM paycheck_deductions/.test(sql)) return { rows: deductions };
    return { rows: [], rowCount: 1 };
  });
  const r = await generateAndStampCfdiNomina(
    'pc-1', { tenantId: 't-1', userId: 'u-1' },
    { kind: 'entity', tenantId: 't-1', entityId: 'ent-1' }
  );
  return r.xml;
}

const attr = (xml: string, name: string): string => {
  const m = new RegExp(`\\b${name}="([0-9.]+)"`).exec(xml);
  expect(m, `the XML carries no ${name}`).toBeTruthy();
  return m![1];
};

/** The Deduccion nodes as written: [TipoDeduccion, Importe]. */
const deductionNodes = (xml: string): [string, string][] =>
  [...xml.matchAll(/<nomina12:Deduccion TipoDeduccion="(\d{3})"[^>]* Importe="([0-9.]+)"\/>/g)].map(
    (m) => [m[1], m[2]]
  );

const sumOf = (nodes: [string, string][]): string => Decimal.sum(0, ...nodes.map(([, amount]) => amount)).toFixed(2);

function expectTotalIdentity(xml: string): void {
  const sum = new Decimal(attr(xml, 'SubTotal')).minus(attr(xml, 'Descuento')).plus(attr(xml, 'TotalOtrosPagos'));
  expect(attr(xml, 'Total')).toBe(sum.toFixed(2));
}

beforeEach(() => {
  mockQuery.mockReset();
  mockStamp.mockReset();
  mockStamp.mockResolvedValue({
    uuid: 'u', provider_used: 'p', fecha_timbrado: '2026-03-15T10:00:00', no_certificado_sat: '0', simulado: true,
  });
});

describe('the Deducciones node of the payroll CFDI', () => {
  it('writes the IMSS of the worker as Deduccion 001 and the INFONAVIT credit as Deduccion 010', async () => {
    const xml = await xmlFor({});
    expect(xml).toContain(
      '<nomina12:Deduccion TipoDeduccion="001" Clave="IMSS" Concepto="Seguridad social" Importe="71.25"/>'
    );
    expect(xml).toContain(
      '<nomina12:Deduccion TipoDeduccion="010" Clave="INFONAVIT" Concepto="Pago por crédito de vivienda" Importe="300.00"/>'
    );
    expect(xml).toContain('<nomina12:Deduccion TipoDeduccion="002" Clave="ISR" Concepto="ISR" Importe="70.00"/>');
    expect(xml).toContain('TipoDeduccion="004" Clave="savings_fund" Concepto="Fondo de ahorro" Importe="50.00"');
  });

  it('TotalOtrasDeducciones and TotalImpuestosRetenidos are the sums of the nodes written', async () => {
    const xml = await xmlFor({});
    const nodes = deductionNodes(xml);
    expect(nodes).toHaveLength(4);
    expect(attr(xml, 'TotalOtrasDeducciones')).toBe(sumOf(nodes.filter(([type]) => type !== '002')));
    expect(attr(xml, 'TotalImpuestosRetenidos')).toBe(sumOf(nodes.filter(([type]) => type === '002')));
    expect(attr(xml, 'TotalOtrasDeducciones')).toBe('421.25');
    expect(attr(xml, 'TotalImpuestosRetenidos')).toBe('70.00');
    expect(attr(xml, 'TotalDeducciones')).toBe('491.25');
    expect(attr(xml, 'Descuento')).toBe('491.25');
  });

  it('a paycheck with no IMSS and no INFONAVIT writes neither node: Importe must be above zero', async () => {
    const xml = await xmlFor({ imss_employee: '0.00', infonavit_withheld: '0.00', net_pay: '2930.00' }, []);
    expect(deductionNodes(xml)).toEqual([['002', '70.00']]);
    expect(attr(xml, 'TotalOtrasDeducciones')).toBe('0.00');
    expectTotalIdentity(xml);
  });

  // MNE-001-923 (#1076). Standard of the complement (revision C, 29 Dec 2021, read 2026-11-27),
  // TotalImpuestosRetenidos: «Si no existen deducciones con clave "002", este atributo no debe
  // existir.» It was written as 0.00, which is every receipt of a worker with no ISR withheld.
  it('with no Deduccion 002 the receipt carries no TotalImpuestosRetenidos, and TotalDeducciones is the other deductions', async () => {
    // The subsidy (180.00) above the ISR (120.00), and no ISR at all (LISR art. 96, first paragraph).
    for (const over of [{ isr_withheld: '120.00', net_pay: '2578.75' }, { isr_withheld: '0.00', net_pay: '2578.75' }]) {
      const xml = await xmlFor(over);
      expect(deductionNodes(xml).map(([type]) => type)).toEqual(['001', '010', '004']);
      expect(xml).not.toContain('TotalImpuestosRetenidos');
      expect(xml).toContain('<nomina12:Deducciones TotalOtrasDeducciones="421.25">');
      expect(attr(xml, 'TotalDeducciones')).toBe('421.25');
      expectTotalIdentity(xml);
    }
  });

  it('a stored deduction keyed 002 counts as tax withheld, not as another deduction', async () => {
    const xml = await xmlFor({ net_pay: '2478.75' }, [
      { cfdi_clave_sat: '002', amount: '80.00', description: 'ISR de ajuste', deduction_type: 'isr_adjust' },
    ]);
    // 70.00 + 80.00 retained; 71.25 + 300.00 of other deductions.
    expect(attr(xml, 'TotalImpuestosRetenidos')).toBe('150.00');
    expect(attr(xml, 'TotalOtrasDeducciones')).toBe('371.25');
    expectTotalIdentity(xml);
  });
});

describe('Total = SubTotal − Descuento + TotalOtrosPagos, with the subsidy on both sides of the ISR', () => {
  // The subsidy above the ISR: ISR 120.00, so nothing is retained and the
  // deductions are the 421.25 of the others. Net 3,000.00 − 421.25 = 2,578.75;
  // under the rule before 1 May 2024 the 60.00 of excess is handed over: 2,638.75.
  it.each([
    ['below the ISR', {}, '491.25', '0.00', '2508.75'],
    ['above the ISR, from 1 May 2024', { isr_withheld: '120.00', net_pay: '2578.75' }, '421.25', '0.00', '2578.75'],
    [
      'above the ISR, before 1 May 2024',
      { isr_withheld: '120.00', subsidio_entregado_efectivo: '60.0000', net_pay: '2638.75' },
      '421.25', '60.00', '2638.75',
    ],
  ])('subsidy %s', async (_name, over, discount, otherPayments, total) => {
    const xml = await xmlFor(over);
    expect(xml).toMatch(new RegExp(`<nomina12:OtroPago TipoOtroPago="002"[^>]* Importe="${otherPayments}">`));
    expect(xml).toContain('<nomina12:SubsidioAlEmpleo SubsidioCausado="180.00"/>');
    expect(attr(xml, 'SubTotal')).toBe('3000.00');
    expect(attr(xml, 'Descuento')).toBe(discount);
    expect(attr(xml, 'TotalOtrosPagos')).toBe(otherPayments);
    expect(attr(xml, 'Total')).toBe(total);
    expectTotalIdentity(xml);
  });

  it('a TipoRegimen 02 receipt with no subsidy caused still declares OtroPago 002, with 0.00', async () => {
    const xml = await xmlFor({ subsidio_empleo: '0.00', net_pay: '2328.75' });
    expect(xml).toMatch(/<nomina12:OtroPago TipoOtroPago="002"[^>]* Importe="0\.00">/);
    expect(xml).toContain('<nomina12:SubsidioAlEmpleo SubsidioCausado="0.00"/>');
    expect(xml).toContain('<nomina12:Deduccion TipoDeduccion="002" Clave="ISR" Concepto="ISR" Importe="250.00"/>');
    expectTotalIdentity(xml);
  });

  it('a regime other than 02 with no subsidy carries no OtrosPagos: the key 002 is not allowed there', async () => {
    const xml = await xmlFor({ tipo_regimen_sat: '09', subsidio_empleo: '0.00', net_pay: '2328.75' });
    expect(xml).not.toMatch(/OtrosPagos|OtroPago/);
    expect(attr(xml, 'Total')).toBe(new Decimal(attr(xml, 'SubTotal')).minus(attr(xml, 'Descuento')).toFixed(2));
  });
});

describe('the nodes against the SAT nomina12.xsd', () => {
  // One xmllint run over the SAT's schemas takes over a second on an idle machine.
  const XSD_TIMEOUT = 20_000;

  /**
   * The generated Deducciones and OtrosPagos inside a minimal hand-written
   * Nomina, as payroll-cfdi-subsidy-node.spec.ts does: the Receptor the
   * generator writes still fails the schema outside these two nodes (#92).
   */
  function minimalComplementWith(xml: string): string {
    const nodes = /<nomina12:Deducciones[\s\S]*<\/nomina12:OtrosPagos>/.exec(xml);
    expect(nodes, 'the XML carries no Deducciones followed by OtrosPagos').toBeTruthy();
    return `<nomina12:Nomina xmlns:nomina12="http://www.sat.gob.mx/nomina12" Version="1.2" TipoNomina="O"
  FechaPago="2026-03-15" FechaInicialPago="2026-03-01" FechaFinalPago="2026-03-15" NumDiasPagados="15"
  TotalDeducciones="${attr(xml, 'TotalDeducciones')}" TotalOtrosPagos="${attr(xml, 'TotalOtrosPagos')}">
  <nomina12:Receptor Curp="AAAA800101HDFBBB09" TipoContrato="01" TipoRegimen="02"
    NumEmpleado="E1" PeriodicidadPago="04" ClaveEntFed="MEX"/>
  ${nodes![0]}
</nomina12:Nomina>`;
  }

  it('Deducciones with 001, 002, 004 and 010 and the OtroPago 002 of the ordinary band pass the schema', async () => {
    const verdict = validateAgainstPayrollComplementXsd(minimalComplementWith(await xmlFor({})));
    expect(verdict.errors).toEqual([]);
    expect(verdict.valid).toBe(true);
  }, XSD_TIMEOUT);

  it('Deducciones with no ISR node and no TotalImpuestosRetenidos passes the schema too', async () => {
    const verdict = validateAgainstPayrollComplementXsd(
      minimalComplementWith(await xmlFor({ isr_withheld: '0.00', net_pay: '2578.75' }))
    );
    expect(verdict.errors).toEqual([]);
    expect(verdict.valid).toBe(true);
  }, XSD_TIMEOUT);

  it('the schema is the one that judges: a key outside c_TipoDeduccion is refused', async () => {
    const broken = minimalComplementWith(await xmlFor({})).replace('TipoDeduccion="010"', 'TipoDeduccion="ZZZ"');
    const verdict = validateAgainstPayrollComplementXsd(broken);
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.join('\n')).toMatch(/TipoDeduccion/);
  }, XSD_TIMEOUT);
});
