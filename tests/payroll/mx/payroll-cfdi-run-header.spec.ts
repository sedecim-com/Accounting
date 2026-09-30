import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// MNE-001-277 · TipoNomina, PeriodicidadPago and Antiguedad come from the run,
// the pay schedule and the hire date, not from literals or the surname.

vi.mock('../../../src/database/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../../src/services/integrations/mexico/pac/pac-router.js', () => ({
  pacRouter: { stamp: vi.fn() },
}));

import {
  generateAndStampCfdiNomina,
  payrollTypeForRunType,
  paymentPeriodicityFor,
  seniorityWeeks,
} from '../../../src/services/payroll/mx/cfdi-nomina-generator.js';
import { query } from '../../../src/database/connection.js';
import { pacRouter } from '../../../src/services/integrations/mexico/pac/pac-router.js';

const mockQuery = query as unknown as Mock;
const mockStamp = pacRouter.stamp as unknown as Mock;

async function xmlFor(over: Record<string, string | null>): Promise<string> {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/FROM paychecks p/.test(sql)) {
      return {
        rows: [{
          paycheck_id: 'pc-1', tenant_id: 't-1', gross_earnings: '100.00', net_pay: '100.00',
          isr_withheld: '0', subsidio_empleo: '0', subsidio_entregado_efectivo: '0',
          imss_employee: '0', infonavit_withheld: '0',
          period_start: '2026-03-02', period_end: '2026-03-08', pay_date: '2026-03-08', tax_year: 2026,
          emp_first: 'Ana', emp_last: 'Prueba', emp_second_last: null, emp_rfc: null, emp_curp: null,
          emp_nss: null, emp_number: 'E1', tipo_regimen_sat: '02', tipo_contrato_sat: '01',
          tipo_jornada_sat: '01', riesgo_puesto: '01', puesto: null, hire_date: '2026-01-05',
          entity_tax_id: 'AAA010101AAA', entity_name: 'Empresa',
          run_type: 'regular', pay_frequency: 'weekly', ...over,
        }],
      };
    }
    return { rows: [] };
  });
  const r = await generateAndStampCfdiNomina(
    'pc-1', { tenantId: 't-1', userId: 'u-1' },
    { kind: 'entity', tenantId: 't-1', entityId: 'ent-1' }
  );
  return r.xml;
}

beforeEach(() => {
  mockQuery.mockReset();
  mockStamp.mockReset();
  mockStamp.mockResolvedValue({
    uuid: 'u', provider_used: 'p', fecha_timbrado: '2026-03-08T10:00:00', no_certificado_sat: '0', simulado: true,
  });
});

describe('payroll CFDI header attributes', () => {
  it('a regular weekly run is O / 02 with seniority in weeks to period end', async () => {
    const doc = await xmlFor({});
    expect(doc).toContain('TipoNomina="O"');
    expect(doc).toContain('PeriodicidadPago="02"');
    // 2026-01-05 .. 2026-03-08 inclusive = 63 days = 9 weeks
    expect(doc).toContain('Antiguedad="P9W"');
  });

  it('an off-cycle run is E / 99 whatever the employee surname says', async () => {
    const doc = await xmlFor({ run_type: 'off_cycle', emp_second_last: 'EXTRAORDINARIA' });
    expect(doc).toContain('TipoNomina="E"');
    expect(doc).toContain('PeriodicidadPago="99"');
  });

  it('a surname of EXTRAORDINARIA no longer makes a regular run extraordinary', async () => {
    const doc = await xmlFor({ emp_second_last: 'EXTRAORDINARIA' });
    expect(doc).toContain('TipoNomina="O"');
  });
});

describe('catalog helpers', () => {
  it('maps run types', () => {
    expect(['regular', 'correction', 'bonus', 'final', 'off_cycle'].map(payrollTypeForRunType))
      .toEqual(['O', 'O', 'E', 'E', 'E']);
    expect(() => payrollTypeForRunType('x')).toThrow();
  });
  it('maps schedule frequencies', () => {
    expect(['weekly', 'biweekly', 'semimonthly', 'quincenal', 'monthly'].map((f) => paymentPeriodicityFor('O', f)))
      .toEqual(['02', '03', '04', '04', '05']);
    expect(() => paymentPeriodicityFor('O', 'x')).toThrow();
  });
  it('seniority is at least one week', () => {
    expect(seniorityWeeks('2026-03-08', '2026-03-08')).toBe('P1W');
    expect(seniorityWeeks('2026-03-01', '2026-03-08')).toBe('P1W');
  });
});
