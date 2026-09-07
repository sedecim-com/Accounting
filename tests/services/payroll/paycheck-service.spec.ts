import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { ITaxCalculator, TaxOutput } from '../../../src/services/payroll/tax-engine/tax-engine.interface.js';

// ============================================================
// EL DESGLOSE QUE SE CALCULABA Y SE TIRABA, Y EL SUBSIDIO QUE NO LLEGABA
//
// Estas pruebas miran lo que el servicio ESCRIBE, no lo que devuelve: el
// defecto que corrigen consistía precisamente en calcular bien y no persistir
// nada. Por eso el cliente de la transacción es un espía y las aserciones
// caen sobre los INSERT.
//
// Las calculadoras se sustituyen por dobles con importes fijos a propósito:
// lo que se prueba aquí es el reparto y el apunte, no las tarifas —ésas
// tienen sus propias pruebas y su propia tabla—.
// ============================================================

const clienteEspia = { query: vi.fn() };

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(async (fn: (c: unknown) => Promise<unknown>) => fn(clienteEspia)),
}));

vi.mock('../../../src/services/payroll/tax-engine/ytd-service.js', () => ({
  getEmployeeYtd: vi.fn(async () => ({
    gross_wages: 0, ss_taxable_wages: 0, medicare_taxable_wages: 0, futa_taxable_wages: 0,
  })),
  getEmployeeSutaYtd: vi.fn(async () => 0),
}));

const calculadoras = new Map<string, ITaxCalculator>();
vi.mock('../../../src/services/payroll/tax-engine/tax-registry.js', () => ({
  taxRegistry: {
    get: (j: string, t: string) => calculadoras.get(`${j}:${t}`) ?? null,
    getRequired: (j: string, t: string) => {
      const c = calculadoras.get(`${j}:${t}`);
      if (!c) throw new Error(`sin calculadora de prueba para ${j}:${t}`);
      return c;
    },
  },
}));

vi.mock('../../../src/services/policy/policy-service.js', () => ({
  getPolicy: vi.fn(),
}));

import { calculatePaycheck } from '../../../src/services/payroll/common/paycheck-service.js';
import { query } from '../../../src/database/connection.js';
import { getPolicy } from '../../../src/services/policy/policy-service.js';

const mockQuery = query as unknown as Mock;
const mockGetPolicy = getPolicy as unknown as Mock;

/** Doble de calculadora: devuelve siempre el mismo importe. */
function doble(jurisdiction: string, taxType: string, salida: Partial<TaxOutput>): void {
  calculadoras.set(`${jurisdiction}:${taxType}`, {
    jurisdiction,
    taxType,
    calculate: async (input): Promise<TaxOutput> => ({
      jurisdiction,
      tax_type: taxType,
      tax_amount: 0,
      taxable_wages_used: input.taxable_wages,
      ...salida,
    }),
  });
}

/** Los renglones que el servicio mandó a `paycheck_taxes`, por tax_type. */
interface RenglonEscrito {
  tax_type: string;
  jurisdiction: string;
  lado: string;
  taxable_wages: string;
  rate: string | null;
  tax_amount: string;
  is_credit: boolean;
  notas: string | null;
}

function renglonesEscritos(): RenglonEscrito[] {
  return clienteEspia.query.mock.calls
    .filter((c) => /INSERT INTO paycheck_taxes/.test(String(c[0])))
    .map((c) => {
      const p = c[1] as [
        string, string, string, string, string, string | null, string, boolean, string | null,
      ];
      return {
        tax_type: p[1], jurisdiction: p[2], lado: p[3],
        taxable_wages: p[4], rate: p[5], tax_amount: p[6], is_credit: p[7], notas: p[8],
      };
    });
}

function insercionDelRecibo(): { sql: string; params: unknown[] } {
  const c = clienteEspia.query.mock.calls.find((x) => /INSERT INTO paychecks/.test(String(x[0])));
  if (!c) throw new Error('el recibo no se insertó');
  return { sql: String(c[0]), params: c[1] as unknown[] };
}

const EMPLEADO_MX = {
  id: 'emp-1', country_code: 'MX', sbc: '500', tipo_regimen_sat: '02', riesgo_puesto: '01',
  infonavit_credit_type: 'factor', infonavit_credit_value: '0.2',
  w4_data: {}, work_state: null, residence_state: null, work_city: null,
};

const PERIODO = {
  period_start: '2026-01-01', period_end: '2026-01-15', pay_date: '2026-01-15',
  tax_year: 2026, frequency: 'quincenal', entity_id: 'ent-1',
};

function prepararLecturas(empleado: Record<string, unknown> = EMPLEADO_MX): void {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/FROM employees/.test(sql)) return { rows: [empleado] };
    if (/FROM pay_periods/.test(sql)) return { rows: [PERIODO] };
    // La tercera llave de la frontera: la corrida también se acota por
    // inquilino antes de escribir nada. Ver la prueba de más abajo.
    if (/FROM pay_runs/.test(sql)) return { rows: [{ id: 'run-1' }] };
    throw new Error(`consulta inesperada en la prueba: ${sql.slice(0, 60)}`);
  });
}

const ENTRADA = {
  tenant_id: 'tenant-1',
  pay_run_id: 'run-1',
  employee_id: 'emp-1',
  pay_period_id: 'per-1',
  earnings: [{ earning_type: 'salary', amount: 3000 }],
};

beforeEach(() => {
  clienteEspia.query.mockReset();
  clienteEspia.query.mockResolvedValue({ rows: [], rowCount: 1 });
  mockQuery.mockReset();
  mockGetPolicy.mockReset();
  calculadoras.clear();
  // Importes fijos: ISR menor que el subsidio, que es el caso que el
  // Math.max se tragaba.
  doble('MX', 'isr', { tax_amount: 158.57, rate_applied: 0.064, notes: 'Art. 96 LISR quincenal' });
  doble('MX', 'subsidio_empleo', { tax_amount: 406.62, is_credit: true, notes: 'Subsidio al empleo' });
  doble('MX', 'imss_employee', { tax_amount: 75.5, taxable_wages_used: 7500, notes: 'SBC 500 × 15' });
  doble('MX', 'imss_employer', { tax_amount: 300, taxable_wages_used: 7500 });
  doble('MX', 'infonavit_employer', { tax_amount: 150, rate_applied: 0.05, taxable_wages_used: 7500 });
  doble('MX', 'infonavit_credit', { tax_amount: 60, notes: 'Crédito INFONAVIT tipo factor' });
  mockGetPolicy.mockResolvedValue({
    key: 'subsidio_al_empleo_entregado_registro',
    value: 'cuenta_por_cobrar_fisco', defined: false, question: 'q', rationale: null,
  });
  prepararLecturas();
});

describe('el recibo escribe el desglose que antes tiraba', () => {
  it('deja un renglón de paycheck_taxes por cada componente calculado', async () => {
    await calculatePaycheck(ENTRADA);
    const porTipo = Object.fromEntries(renglonesEscritos().map((r) => [r.tax_type, r]));
    expect(Object.keys(porTipo).sort()).toEqual([
      'imss', 'infonavit', 'infonavit_credit', 'isr',
      'subsidio_empleo', 'subsidio_entregado_efectivo',
    ]);
  });

  it('apunta la base gravable y la tasa de cada componente, no sólo el importe', async () => {
    await calculatePaycheck(ENTRADA);
    const isr = renglonesEscritos().find((r) => r.tax_type === 'isr')!;
    expect(isr.taxable_wages).toBe('3000.0000');
    expect(isr.rate).toBe('0.064000');
    expect(isr.tax_amount).toBe('158.5700');
    expect(isr.jurisdiction).toBe('MX');
    expect(isr.lado).toBe('EE');

    // El IMSS se calcula sobre el SBC del periodo, no sobre el sueldo: la
    // base que se apunta es la que la calculadora USÓ.
    const imssPatronal = renglonesEscritos().find((r) => r.tax_type === 'imss' && r.lado === 'ER')!;
    expect(imssPatronal.taxable_wages).toBe('7500.0000');
    expect(imssPatronal.tax_amount).toBe('300.0000');
  });

  it('separa lo del trabajador de lo del patrón en la misma clave de impuesto', async () => {
    await calculatePaycheck(ENTRADA);
    const imss = renglonesEscritos().filter((r) => r.tax_type === 'imss');
    expect(imss.map((r) => r.lado).sort()).toEqual(['EE', 'ER']);
  });

  it('no repite la llave que el UNIQUE de la 067 protege', async () => {
    await calculatePaycheck(ENTRADA);
    const llaves = renglonesEscritos().map((r) => `${r.tax_type}|${r.jurisdiction}|${r.lado}`);
    expect(new Set(llaves).size).toBe(llaves.length);
  });

  it('inserta sin ON CONFLICT: un duplicado tiene que ser un error ruidoso', async () => {
    await calculatePaycheck(ENTRADA);
    const sql = clienteEspia.query.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => /INSERT INTO paycheck_taxes/.test(s));
    expect(sql.length).toBeGreaterThan(0);
    for (const s of sql) expect(s).not.toMatch(/ON CONFLICT/i);
  });

  it('escribe el desglose en la MISMA transacción que el recibo', async () => {
    await calculatePaycheck(ENTRADA);
    // Todo pasa por el cliente de la transacción; ninguna de las escrituras
    // sale por `query`, que es la conexión suelta del pool.
    for (const c of mockQuery.mock.calls) {
      expect(String(c[0])).not.toMatch(/INSERT INTO/i);
    }
    expect(renglonesEscritos().length).toBeGreaterThan(0);
  });
});

describe('el subsidio que excede al ISR llega al trabajador', () => {
  it('entrega la diferencia en efectivo y la suma al neto', async () => {
    const r = await calculatePaycheck(ENTRADA);
    // 406.62 − 158.57 = 248.05 de subsidio entregado.
    expect(r.subsidio_entregado_efectivo).toBe('248.0500');
    // Neto = 3000 − ISR retenido (0) − IMSS 75.50 − crédito INFONAVIT 60 + 248.05
    expect(r.net_pay).toBeCloseTo(3112.55, 4);
    expect(r.employee_taxes).toBeCloseTo(75.5, 4);
  });

  it('lo guarda en paychecks.subsidio_entregado_efectivo', async () => {
    await calculatePaycheck(ENTRADA);
    const { sql, params } = insercionDelRecibo();
    expect(sql).toMatch(/subsidio_entregado_efectivo/);
    expect(params[35]).toBe('248.0500');
  });

  it('deja su renglón marcado como crédito, con la política que lo gobierna', async () => {
    await calculatePaycheck(ENTRADA);
    const entregado = renglonesEscritos().find((r) => r.tax_type === 'subsidio_entregado_efectivo')!;
    expect(entregado.is_credit).toBe(true);
    expect(entregado.lado).toBe('EE');
    expect(entregado.tax_amount).toBe('248.0500');
    expect(mockGetPolicy).toHaveBeenCalledWith(
      { tenantId: 'tenant-1', entityId: 'ent-1' },
      'subsidio_al_empleo_entregado_registro',
      undefined
    );
    // Nadie contestó la política: la nota lo dice en vez de presentarlo como
    // criterio del despacho.
    expect(entregado.notas).toMatch(/cuenta por cobrar al fisco/);
    expect(entregado.notas).toMatch(/sigue sin contestar/);
  });

  it('registra en el rastro de auditoría si el criterio lo decidió el despacho', async () => {
    mockGetPolicy.mockResolvedValue({
      key: 'subsidio_al_empleo_entregado_registro',
      value: 'gasto_del_patron', defined: true, question: 'q', rationale: null,
    });
    await calculatePaycheck(ENTRADA);
    const detalle = JSON.parse(insercionDelRecibo().params[31] as string) as {
      subsidio_entregado_efectivo: string;
      subsidio_entregado_registro: { valor: string; decidido_por_el_despacho: boolean } | null;
    };
    expect(detalle.subsidio_entregado_efectivo).toBe('248.0500');
    expect(detalle.subsidio_entregado_registro).toEqual({
      valor: 'gasto_del_patron',
      decidido_por_el_despacho: true,
    });
  });

  it('no consulta la política cuando el ISR absorbe el subsidio', async () => {
    doble('MX', 'isr', { tax_amount: 800, rate_applied: 0.1088 });
    doble('MX', 'subsidio_empleo', { tax_amount: 300, is_credit: true });
    const r = await calculatePaycheck(ENTRADA);
    expect(r.subsidio_entregado_efectivo).toBe('0.0000');
    expect(mockGetPolicy).not.toHaveBeenCalled();
    // ISR retenido 500 + IMSS 75.50; el crédito INFONAVIT no es impuesto.
    expect(r.employee_taxes).toBeCloseTo(575.5, 4);
    expect(r.net_pay).toBeCloseTo(2364.5, 4);
    expect(renglonesEscritos().some((x) => x.tax_type === 'subsidio_entregado_efectivo')).toBe(false);
  });

  it('apunta el ISR completo y el subsidio ACREDITADO por separado, no el neteado', async () => {
    // El renglón del subsidio llevaba el CAUSADO (406.62) y el del efectivo
    // entregado su parte, los dos marcados como crédito: sumados contaban dos
    // veces lo entregado y el ISR neto del periodo salía −248.04 donde el
    // fisco ve −124.02. Un verificador adversarial lo midió sumando la tabla.
    //
    // Ahora el causado se PARTE en sus dos mitades reales —lo acreditado
    // contra el ISR de este trabajador y lo entregado en efectivo porque ya no
    // quedaba ISR contra el que acreditarlo— y la SUMA de los dos renglones
    // sigue siendo el causado, así que nada se pierde y nada se cuenta dos
    // veces. Con ISR 158.57 y subsidio 406.62, lo acreditado es el ISR entero.
    await calculatePaycheck(ENTRADA);
    const rs = renglonesEscritos();
    expect(rs.find((r) => r.tax_type === 'isr')!.tax_amount).toBe('158.5700');
    const sub = rs.find((r) => r.tax_type === 'subsidio_empleo')!;
    expect(sub.tax_amount).toBe('158.5700');
    expect(sub.is_credit).toBe(true);
    const entregado = rs.find((r) => r.tax_type === 'subsidio_entregado_efectivo')!;
    expect(entregado.tax_amount).toBe('248.0500');
    // La suma de las dos mitades ES el subsidio causado.
    expect(Number(sub.tax_amount) + Number(entregado.tax_amount)).toBeCloseTo(406.62, 4);
  });
});

describe('el crédito INFONAVIT es una deducción, no un impuesto retenido', () => {
  it('no entra en employee_taxes, que es la base de las disposable earnings', async () => {
    const r = await calculatePaycheck(ENTRADA);
    // Antes valía 135.50: 75.50 de IMSS + 60 de amortización de vivienda.
    expect(r.employee_taxes).toBeCloseTo(75.5, 4);
  });

  it('sigue descontándose del neto que el trabajador recibe', async () => {
    const r = await calculatePaycheck(ENTRADA);
    const sinCredito = 3000 - 75.5 + 248.05;
    expect(r.net_pay).toBeCloseTo(sinCredito - 60, 4);
  });

  it('deja constancia de que no es impuesto en el renglón que apunta', async () => {
    await calculatePaycheck(ENTRADA);
    const cr = renglonesEscritos().find((r) => r.tax_type === 'infonavit_credit')!;
    expect(cr.is_credit).toBe(false);
    expect(cr.notas).toMatch(/DEDUCCIÓN/);
    expect(cr.notas).toMatch(/disposable earnings/);
  });
});

describe('la frontera de inquilino', () => {
  it('va dentro del SQL que busca al trabajador, a su periodo y a su corrida', async () => {
    await calculatePaycheck(ENTRADA);
    const empleados = mockQuery.mock.calls.find((c) => /FROM employees/.test(String(c[0])))!;
    expect(String(empleados[0])).toMatch(/tenant_id = \$2/);
    expect(empleados[1]).toEqual(['emp-1', 'tenant-1']);
    const periodos = mockQuery.mock.calls.find((c) => /FROM pay_periods/.test(String(c[0])))!;
    expect(String(periodos[0])).toMatch(/pp\.tenant_id = \$2/);
    expect(periodos[1]).toEqual(['per-1', 'tenant-1']);
    // LA TERCERA, que faltaba. `pay_run_id` se insertaba tal cual: un recibo
    // podía quedar colgado de la corrida de OTRO inquilino, entrar en el
    // agregado del que sale su asiento al mayor —`FROM paychecks WHERE
    // pay_run_id = $1`, sin inquilino— y desaparecer del pasivo patronal del
    // suyo. Está medido contra Postgres en
    // tests/integration/f08a-ataque-2.int.spec.ts.
    const corridas = mockQuery.mock.calls.find((c) => /FROM pay_runs/.test(String(c[0])))!;
    expect(String(corridas[0])).toMatch(/tenant_id = \$2/);
    expect(corridas[1]).toEqual(['run-1', 'tenant-1']);
  });

  it('no calcula nada si la corrida no es de ese inquilino', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM employees/.test(sql)) return { rows: [EMPLEADO_MX] };
      if (/FROM pay_periods/.test(sql)) return { rows: [PERIODO] };
      return { rows: [] };
    });
    await expect(calculatePaycheck(ENTRADA)).rejects.toThrow(/Pay run not found/);
    expect(clienteEspia.query).not.toHaveBeenCalled();
  });

  it('no calcula nada si el trabajador no es de ese inquilino', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FROM employees/.test(sql)) return { rows: [] };
      return { rows: [PERIODO] };
    });
    await expect(calculatePaycheck(ENTRADA)).rejects.toThrow(/Employee not found/);
    expect(clienteEspia.query).not.toHaveBeenCalled();
  });
});
