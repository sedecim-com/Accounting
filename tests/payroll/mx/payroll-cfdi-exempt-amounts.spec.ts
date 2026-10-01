import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// ============================================================
// THE PAYROLL CFDI STATES THE EXEMPT PART IT COMPUTED (#297, MNE-001-063)
//
// The generator wrote `ImporteGravado` = the whole amount and
// `ImporteExento="0.00"` / `TotalExento="0.00"` as literals, so an aguinaldo
// exempted by the engine was declared to the SAT as taxed whole. The figures
// now come from the parts stored on each earning row (migration 094).
// ============================================================

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/services/integrations/mexico/pac/pac-router.js', () => ({
  pacRouter: { stamp: vi.fn() },
}));

import { generateAndStampCfdiNomina } from '../../../src/services/payroll/mx/cfdi-nomina-generator.js';
import { query } from '../../../src/database/connection.js';
import { pacRouter } from '../../../src/services/integrations/mexico/pac/pac-router.js';

const mockQuery = query as unknown as Mock;
const mockStamp = pacRouter.stamp as unknown as Mock;

interface EarningRow {
  earning_type: string;
  amount: string;
  is_taxable_isr: boolean;
  isr_exempt_amount: string | null;
  isr_taxable_amount: string | null;
}

function paycheckWith(earnings: EarningRow[]): void {
  const gross = earnings.reduce((s, e) => s + Number(e.amount), 0).toFixed(2);
  mockQuery.mockImplementation(async (sql: string) => {
    if (/FROM paychecks p/.test(sql)) {
      return {
        rows: [{
          paycheck_id: 'pc-1', tenant_id: 't-1', gross_earnings: gross, net_pay: gross,
          isr_withheld: '0', subsidio_empleo: '0', subsidio_entregado_efectivo: '0',
          imss_employee: '0', infonavit_withheld: '0',
          period_start: '2026-12-01', period_end: '2026-12-15', pay_date: '2026-12-15', tax_year: 2026,
          emp_first: 'Ana', emp_last: 'Prueba', emp_second_last: null, emp_rfc: null, emp_curp: null,
          emp_nss: null, emp_number: 'E1', tipo_regimen_sat: '02', tipo_contrato_sat: '01',
          tipo_jornada_sat: '01', riesgo_puesto: '01', puesto: null, hire_date: '2024-01-01',
          entity_tax_id: 'AAA010101AAA', entity_name: 'Empresa',
          run_type: 'regular', pay_frequency: 'quincenal',
        }],
      };
    }
    if (/FROM paycheck_earnings/.test(sql)) {
      return { rows: earnings.map((e) => ({ ...e, cfdi_clave_sat: null, description: null })) };
    }
    return { rows: [] };
  });
}

async function xml(): Promise<string> {
  const r = await generateAndStampCfdiNomina(
    'pc-1',
    { tenantId: 't-1', userId: 'u-1' },
    { kind: 'entity', tenantId: 't-1', entityId: 'ent-1' }
  );
  return r.xml;
}

function attr(doc: string, node: string, name: string): string[] {
  const re = new RegExp(`<nomina12:${node}\\b[^>]*\\b${name}="([^"]*)"`, 'g');
  return [...doc.matchAll(re)].map((m) => m[1]);
}

beforeEach(() => {
  mockQuery.mockReset();
  mockStamp.mockReset();
  mockStamp.mockResolvedValue({
    uuid: 'uuid-1', provider_used: 'prueba', fecha_timbrado: '2026-12-15T10:00:00',
    no_certificado_sat: '0000', simulado: true,
  });
});

describe('the payroll CFDI takes the exempt and taxable amounts from the calculation', () => {
  it('ACCEPTANCE (#297): each Percepcion and the totals carry the stored parts, not literals', async () => {
    paycheckWith([
      { earning_type: 'salary', amount: '8000.00', is_taxable_isr: true, isr_exempt_amount: '0.00', isr_taxable_amount: '8000.00' },
      { earning_type: 'aguinaldo', amount: '10000.00', is_taxable_isr: true, isr_exempt_amount: '3519.30', isr_taxable_amount: '6480.70' },
      { earning_type: 'prima_vacacional', amount: '1200.00', is_taxable_isr: true, isr_exempt_amount: '1200.00', isr_taxable_amount: '0.00' },
    ]);
    const doc = await xml();
    expect(attr(doc, 'Percepcion', 'ImporteGravado')).toEqual(['8000.00', '6480.70', '0.00']);
    expect(attr(doc, 'Percepcion', 'ImporteExento')).toEqual(['0.00', '3519.30', '1200.00']);
    expect(attr(doc, 'Percepciones', 'TotalGravado')).toEqual(['14480.70']);
    expect(attr(doc, 'Percepciones', 'TotalExento')).toEqual(['4719.30']);
  });

  it('a row written before migration 094 is declared as it was taxed: by its all-or-nothing flag', async () => {
    paycheckWith([
      { earning_type: 'salary', amount: '8000.00', is_taxable_isr: true, isr_exempt_amount: null, isr_taxable_amount: null },
      { earning_type: 'other', amount: '500.00', is_taxable_isr: false, isr_exempt_amount: null, isr_taxable_amount: null },
    ]);
    const doc = await xml();
    expect(attr(doc, 'Percepcion', 'ImporteGravado')).toEqual(['8000.00', '0.00']);
    expect(attr(doc, 'Percepcion', 'ImporteExento')).toEqual(['0.00', '500.00']);
    expect(attr(doc, 'Percepciones', 'TotalGravado')).toEqual(['8000.00']);
    expect(attr(doc, 'Percepciones', 'TotalExento')).toEqual(['500.00']);
  });
});
