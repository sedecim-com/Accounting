import { describe, it, expect, vi } from 'vitest';
import { requiredParameter, requiredRates } from '../../src/services/payroll/tax-engine/tax-tables.js';
import { MexicoImssEmployerCalculator } from '../../src/services/payroll/mx/imss-calculator.js';
import { validFilingStatus } from '../../src/services/payroll/usa/federal/fit-calculator.js';
import { desiredAmount } from '../../src/services/payroll/usa/garnishments/garnishment-engine.js';

/**
 * EL PRINCIPIO DE T20, EN UN SOLO SITIO: ANTE UN DATO AUSENTE, NEGARSE.
 *
 * #127 describe cuatro caminos que ante un dato ausente o desconocido
 * devolvían **cero o un valor quemado** en vez de fallar, y el propio issue
 * nombra el modelo a seguir: el ISR, que ya lanzaba.
 *
 * Lo que hace peligroso a un cero de estos no es la cifra: es que sea
 * INDISTINGUIBLE de una retención legítima. Un recibo con `days_worked`
 * correctos y cuota cero parece un recibo bueno; lo firma el despacho, viaja
 * en el CFDI de nómina y se paga en la línea de captura.
 */

describe('un parámetro fiscal ausente se nombra, no se sustituye', () => {
  it('lanza diciendo cuál falta', () => {
    expect(() => requiredParameter({}, 'uma_daily', 'MX', 2027)).toThrow(/uma_daily/);
    expect(() => requiredParameter({}, 'uma_daily', 'MX', 2027)).toThrow(/2027/);
  });

  it('y el mensaje dice por qué importa, no sólo que falta', () => {
    // Un error que no explica la consecuencia se silencia con un valor por
    // omisión la próxima vez que estorbe.
    expect(() => requiredParameter({}, 'infonavit_employer_rate', 'MX', 2027)).toThrow(
      /recibo.*CFDI.*línea de captura/s
    );
  });

  it('acepta el número venga como número o como cadena', () => {
    expect(requiredParameter({ uma_daily: 117.31 }, 'uma_daily', 'MX', 2026)).toBe(117.31);
    expect(requiredParameter({ uma_daily: '117.31' }, 'uma_daily', 'MX', 2026)).toBe(117.31);
  });

  it('pero un cero SÍ es un valor: no se confunde con la ausencia', () => {
    // Es la mitad sutil: `|| 0` trataba el cero legítimo y el hueco igual.
    expect(requiredParameter({ tasa: 0 }, 'tasa', 'MX', 2026)).toBe(0);
  });
});

describe('un bloque de tasas incompleto dice QUÉ tasa falta', () => {
  const RAMOS = ['enfermedades_maternidad', 'prestaciones_dinero'] as const;

  it('nombra las que faltan', () => {
    expect(() => requiredRates({ imss_employee: { enfermedades_maternidad: 0.004 } }, 'imss_employee', RAMOS, 2027))
      .toThrow(/prestaciones_dinero/);
  });

  it('y si falta el bloque entero, lo dice en vez de cifrar cero', () => {
    // `params.imss_employee || {}` seguido de `|| 0` en cada ramo daba una
    // cuota de CERO con los días cotizados correctos.
    expect(() => requiredRates({}, 'imss_employee', RAMOS, 2027)).toThrow(/imss_employee/);
    expect(() => requiredRates({}, 'imss_employee', RAMOS, 2027)).toThrow(/creíble y falso/);
  });

  it('con el bloque completo devuelve los números', () => {
    const r = requiredRates(
      { imss_employee: { enfermedades_maternidad: 0.004, prestaciones_dinero: '0.0025' } },
      'imss_employee', RAMOS, 2026
    );
    expect(r).toEqual({ enfermedades_maternidad: 0.004, prestaciones_dinero: 0.0025 });
  });
});

// Only the row lookup is replaced; `requiredParameter`/`requiredRates` stay real.
const mxRow = vi.hoisted(() => ({ params: {} as Record<string, unknown> }));
vi.mock('../../src/services/payroll/tax-engine/tax-tables.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/payroll/tax-engine/tax-tables.js')>()),
  getTaxParameters: vi.fn(async () => mxRow.params),
}));

describe('la cuota patronal del IMSS no sale en cero por falta de su bloque (#296)', () => {
  // Synthetic rates, not the seeded ones: only the shape matters here.
  const EMPLOYER_RATES = {
    enfermedades_maternidad_fija: 0.2, enfermedades_maternidad_excedente: 0.01,
    prestaciones_dinero: 0.007, gastos_medicos_pensionados: 0.01, invalidez_vida: 0.0175,
    guarderias: 0.01, riesgo_trabajo_clase_1: 0.005, riesgo_trabajo_clase_2: 0.01,
    riesgo_trabajo_clase_3: 0.025, riesgo_trabajo_clase_4: 0.045, riesgo_trabajo_clase_5: 0.075,
    cesantia_vejez: 0.03, retiro: 0.02,
  };
  const calculate = (params: Record<string, unknown>) => {
    mxRow.params = params;
    return new MexicoImssEmployerCalculator().calculate({
      pay_frequency: 'quincenal', tax_year: 2027, taxable_wages: 0,
      sbc_daily: 500, days_in_period: 15, riesgo_puesto: '01',
    });
  };

  it('una fila sin «imss_employer» lanza en vez de cifrar 0.00', async () => {
    await expect(calculate({ uma_daily: 100 })).rejects.toThrow(/imss_employer/);
  });

  it('una rama en null lanza nombrando la rama', async () => {
    await expect(calculate({ uma_daily: 100, imss_employer: { ...EMPLOYER_RATES, retiro: null } }))
      .rejects.toThrow(/imss_employer.*retiro/s);
  });

  it('con el bloque completo, el retiro es 2 % del SBC del periodo', async () => {
    // Pins every rate being read: `(er.retiro || 0)` with a present rate
    // still yields the right number, so the absent cases above are the guard.
    const out = await calculate({ uma_daily: 100, imss_employer: EMPLOYER_RATES });
    expect(out.breakdown?.retiro).toBeCloseTo(500 * 0.02 * 15, 6);
    expect(out.taxable_wages_used).toBe(7500);
  });
});

describe('el estado civil del W-4 se valida', () => {
  it('un valor desconocido lanza, en vez de retener cero todo el año', () => {
    // Caía en `getBrackets` → tabla vacía → `applyBrackets` → 0.00, y el
    // patrón queda como retenedor omiso ante el IRS.
    expect(() => validFilingStatus('mfs')).toThrow(/Unknown filing_status/);
    expect(() => validFilingStatus('soltero')).toThrow(/married_jointly/);
  });

  it('no declararlo sigue siendo «single», que es el supuesto del propio W-4', () => {
    expect(validFilingStatus(undefined)).toBe('single');
    expect(validFilingStatus(null)).toBe('single');
  });

  it('los cuatro del catálogo pasan', () => {
    for (const s of ['single', 'married_jointly', 'head_of_household', 'married_separately']) {
      expect(validFilingStatus(s)).toBe(s);
    }
  });
});

describe('el importe de un embargo con vocabulario desconocido', () => {
  it('lanza en vez de retener cero', () => {
    expect(() => desiredAmount('percentage', 25, 2000, 2500)).toThrow(/Unknown garnishment amount_type/);
  });
});
