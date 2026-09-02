import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
}));
vi.mock('../../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(),
  getPolicyNumber: vi.fn(),
}));

import { calculateFiniquito } from '../../../src/services/payroll/mx/finiquito-calculator.js';
import { query } from '../../../src/database/connection.js';
import { getPolicy, getPolicyNumber } from '../../../src/services/policy/policy-service.js';

const mockQuery = query as unknown as Mock;
const mockGetPolicy = getPolicy as unknown as Mock;
const mockGetPolicyNumber = getPolicyNumber as unknown as Mock;

const CTX = { tenantId: 't1', entityId: 'e-de-la-peticion' };

/** Lo que el panel contesta cuando nadie ha tocado las políticas. */
function panelPorDefecto(): void {
  mockGetPolicyNumber.mockResolvedValue(15);
  mockGetPolicy.mockResolvedValue({
    key: 'prima_vacacional_pct',
    value: '0.25',
    defined: false,
    question: '',
    rationale: null,
  });
}

// ============================================================
// La CÁSCARA del finiquito: Postgres y el panel de políticas.
// La aritmética se comprueba en finiquito-math.spec.ts, que no necesita
// mockear nada — que es justamente por lo que se separó.
// ============================================================
describe('Finiquito MX — la cáscara (LFT Art. 76, 79, 80, 87)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockGetPolicy.mockReset();
    mockGetPolicyNumber.mockReset();
    panelPorDefecto();
  });

  const EMPLEADO = {
    sbc: '528.7671',
    hire_date: '2014-07-16',
    annual_salary: '182500', // 500.00 al día
    entity_id: 'e-del-empleado',
  };

  it('el inquilino va dentro del SQL, no en un filtro posterior', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [EMPLEADO] });
    await calculateFiniquito(
      { employee_id: 'emp1', termination_date: '2026-09-30', last_paid_through: '2026-09-15' },
      CTX
    );
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/tenant_id = \$2/);
    expect(params).toEqual(['emp1', 't1']);
  });

  it('lee los dos parámetros del panel, que antes estaban muertos', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [EMPLEADO] });
    await calculateFiniquito(
      { employee_id: 'emp1', termination_date: '2026-09-30', last_paid_through: '2026-09-15' },
      CTX
    );
    expect(mockGetPolicyNumber).toHaveBeenCalledWith(expect.anything(), 'dias_aguinaldo');
    expect(mockGetPolicy).toHaveBeenCalledWith(expect.anything(), 'prima_vacacional_pct');
  });

  it('la política se resuelve en la entidad DEL EMPLEADO, no en la de la petición', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [EMPLEADO] });
    await calculateFiniquito(
      { employee_id: 'emp1', termination_date: '2026-09-30', last_paid_through: '2026-09-15' },
      CTX
    );
    expect(mockGetPolicyNumber).toHaveBeenCalledWith(
      { tenantId: 't1', entityId: 'e-del-empleado' },
      'dias_aguinaldo'
    );
  });

  it('contestar el panel cambia el importe', async () => {
    // 30 días de aguinaldo y 100 % de prima: el doble y el cuádruple.
    mockQuery.mockResolvedValue({ rows: [EMPLEADO] });
    const conMinimos = await calculateFiniquito(
      { employee_id: 'emp1', termination_date: '2026-09-30', last_paid_through: '2026-09-15' },
      CTX
    );
    mockGetPolicyNumber.mockResolvedValue(30);
    mockGetPolicy.mockResolvedValue({ value: '1.00', key: '', defined: true, question: '', rationale: null });
    const conElContrato = await calculateFiniquito(
      { employee_id: 'emp1', termination_date: '2026-09-30', last_paid_through: '2026-09-15' },
      CTX
    );
    expect(conMinimos.aguinaldo_amount).toBe('5609.5890');
    expect(conElContrato.aguinaldo_amount).toBe('11219.1781');
    expect(conElContrato.basis.aguinaldo_days_per_year).toBe(30);
    expect(conElContrato.basis.prima_vacacional_pct).toBe('1.00');
  });

  it('el llamador puede sobrescribir el panel con el dato del contrato', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [EMPLEADO] });
    const r = await calculateFiniquito(
      {
        employee_id: 'emp1',
        termination_date: '2026-09-30',
        last_paid_through: '2026-09-15',
        aguinaldo_days_per_year: 20,
        prima_vacacional_pct: 0.5,
      },
      CTX
    );
    expect(mockGetPolicyNumber).not.toHaveBeenCalled();
    expect(mockGetPolicy).not.toHaveBeenCalled();
    expect(r.basis.aguinaldo_days_per_year).toBe(20);
    expect(r.basis.prima_vacacional_pct).toBe('0.5');
  });

  it('el salario diario sale del contrato, NO del SBC', async () => {
    // El empleado trae los dos. El cálculo anterior prefería el SBC —el
    // salario INTEGRADO— y cobraba aguinaldo sobre el aguinaldo.
    mockQuery.mockResolvedValueOnce({ rows: [EMPLEADO] });
    const r = await calculateFiniquito(
      { employee_id: 'emp1', termination_date: '2026-09-30', last_paid_through: '2026-09-15' },
      CTX
    );
    expect(r.basis.daily_wage).toBe('500.0000');
    expect(r.basis.daily_wage_source).toBe('annual_salary');
    // 15 días pendientes × 500. Con el SBC eran 7 931.5065.
    expect(r.salary_pending_amount).toBe('7500.0000');
  });

  it('sin salario contratado, des-integra el SBC en vez de usarlo tal cual', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...EMPLEADO, annual_salary: null }] });
    const r = await calculateFiniquito(
      { employee_id: 'emp1', termination_date: '2026-09-30', last_paid_through: '2026-09-15' },
      CTX
    );
    // 528.7671 / ((365 + 15 + 24 × 0.25) / 365) = 500.0000
    expect(r.basis.daily_wage).toBe('500.0000');
    expect(r.basis.daily_wage_source).toBe('sbc_desintegrado');
  });

  it('sin salario ni SBC el finiquito es cero, no NaN', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...EMPLEADO, annual_salary: null, sbc: null }],
    });
    const r = await calculateFiniquito(
      { employee_id: 'emp1', termination_date: '2026-09-30', last_paid_through: '2026-09-15' },
      CTX
    );
    expect(r.total).toBe('0.0000');
  });

  it('devuelve la base del cálculo: antigüedad, tabla y salario', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [EMPLEADO] });
    const r = await calculateFiniquito(
      { employee_id: 'emp1', termination_date: '2026-09-30', last_paid_through: '2026-09-15' },
      CTX
    );
    expect(r.basis.years_of_service).toBe(12);
    expect(r.basis.service_year).toBe(13);
    expect(r.basis.vacation_days_art_76).toBe(24); // la tabla vieja decía 22
    expect(r.total).toBe('13742.4657');
  });

  it('los importes son cadenas de cuatro decimales, no números', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [EMPLEADO] });
    const r = await calculateFiniquito(
      {
        employee_id: 'emp1',
        termination_date: '2026-09-30',
        last_paid_through: '2026-09-15',
        pending_vacation_days: 5,
      },
      CTX
    );
    for (const v of [
      r.salary_pending_amount,
      r.aguinaldo_amount,
      r.prima_vacacional_amount,
      r.vacation_pending_amount,
      r.total,
    ]) {
      expect(typeof v).toBe('string');
      expect(v).toMatch(/^-?\d+\.\d{4}$/);
    }
  });

  it('un empleado de otro inquilino no existe: 404, no 500', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    await expect(
      calculateFiniquito(
        { employee_id: 'missing', termination_date: '2026-01-15', last_paid_through: '2026-01-01' },
        CTX
      )
    ).rejects.toThrow('Employee not found');
  });

  it('acepta el hire_date como Date, que es lo que devuelve el driver', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ ...EMPLEADO, hire_date: new Date(2014, 6, 16) }],
    });
    const r = await calculateFiniquito(
      { employee_id: 'emp1', termination_date: '2026-09-30', last_paid_through: '2026-09-15' },
      CTX
    );
    expect(r.basis.years_of_service).toBe(12);
    expect(r.total).toBe('13742.4657');
  });
});
