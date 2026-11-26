import { describe, it, expect } from 'vitest';
import { calcularAmortizacion } from '../../../src/services/accruals/amortization-math.js';
import { entryOfKind, SOURCE_TYPE_OF_KIND } from '../../../src/services/accruals/amortization-run.js';
import { CLOSE_CHECK_ITEMS, deferredRevenueCheck } from '../../../src/services/accounting/period-close.js';
import { REMEDIO_DE } from '../../../src/services/accounting/close-explain.js';
import { CLOSING_STEPS } from '../../../src/services/accounting/closing-conductor.js';

// MNE-001-299 (#111). An annual support contract of 120 000.00 (base, no IVA),
// rendered 20 Mar 2026 → 19 Mar 2027, 365 days. Figures by hand in
// tests/integration/deferred-revenue-calendar.int.spec.ts.

describe('the calendar of a deferred revenue (hand figures)', () => {
  const byDays = calcularAmortizacion({
    importe: '120000',
    inicio: new Date(2026, 2, 20),
    fin: new Date(2027, 2, 19),
    convencion: 'proporcional_dias',
  });

  it('by days: thirteen rows, 2026 recognizes 94 356.1643 and the plug lands in March 2027', () => {
    expect(byDays).toHaveLength(13);
    expect(byDays.map((r) => r.amortization_amount).slice(0, 3)).toEqual(['3945.2055', '9863.0137', '10191.7808']);
    expect(byDays[9].accumulated_amortization).toBe('94356.1643');
    expect(byDays[9].remaining_balance).toBe('25643.8357');
    expect(byDays[11].amortization_amount).toBe('9205.4795');
    expect(byDays[12].amortization_amount).toBe('6246.5754');
    expect(byDays[12].remaining_balance).toBe('0.0000');
  });

  it('whole months: twelve rows of 10 000, and 2026 recognizes 100 000 before it is rendered', () => {
    const whole = calcularAmortizacion({
      importe: '120000',
      inicio: new Date(2026, 2, 20),
      fin: new Date(2027, 2, 19),
      convencion: 'meses_completos',
    });
    expect(whole).toHaveLength(12);
    expect(new Set(whole.map((r) => r.amortization_amount))).toEqual(new Set(['10000.0000']));
    expect(whole[9].accumulated_amortization).toBe('100000.0000');
  });
});

describe('entryOfKind: the direction of each kind', () => {
  const header = { description: 'Soporte anual', prepaid_account_id: 'L2158', expense_account_id: 'R4100' };

  it('a deferred revenue debits the contract liability and credits revenue, with no IVA line', () => {
    const e = entryOfKind({ ...header, kind: 'deferred_revenue' }, '3945.2055', 'Marzo 2026');
    expect(e.sourceType).toBe('deferred_revenue_recognition');
    expect(e.lines).toEqual([
      expect.objectContaining({ account_id: 'L2158', debit_amount: '3945.2055', credit_amount: null }),
      expect.objectContaining({ account_id: 'R4100', debit_amount: null, credit_amount: '3945.2055' }),
    ]);
  });

  it('a prepaid keeps its entry: DR expense / CR 1160, source prepaid_amortization', () => {
    const e = entryOfKind(
      { description: 'Póliza', prepaid_account_id: 'A1160', expense_account_id: 'E6100', kind: 'prepaid_expense' },
      '100.0000',
      'Enero 2026'
    );
    expect(e.sourceType).toBe(SOURCE_TYPE_OF_KIND.prepaid_expense);
    expect(e.description).toBe('Prepaid amortization Enero 2026 - Póliza');
    expect(e.lines.map((l) => [l.account_id, l.debit_amount, l.credit_amount])).toEqual([
      ['E6100', '100.0000', null],
      ['A1160', null, '100.0000'],
    ]);
  });
});

describe('deferredRevenueCheck: the balance against the calendar', () => {
  const review = (reaction: string, pending: number) => ({
    periodo: 'Diciembre 2026',
    reaccion: reaction,
    reaccionDefinida: true,
    pendientes: Array.from({ length: pending }, (_, i) => ({ id: `d${i}`, description: 'x', remaining_amount: '1' })),
    bloquea: false,
    mensaje: null,
  });
  const backed = [{ accountId: '2158', ledger: '25643.8357', scheduled: '25643.8357' }];

  it('green when every schedule ran and the liability equals what is left to recognize', () => {
    const c = deferredRevenueCheck(review('bloquear', 0), backed);
    expect(c).toMatchObject({ codigo: 'deferred-revenue-recognized', is_complete: true, severity: 'blocking' });
    expect(c.item).toBe(CLOSE_CHECK_ITEMS['deferred-revenue-recognized']);
    expect(c.details).toBeUndefined();
  });

  it('a schedule not run weighs what amortizacion_faltante_al_cierre says', () => {
    expect(deferredRevenueCheck(review('avisar', 1), backed)).toMatchObject({ is_complete: false, severity: 'warning' });
    expect(deferredRevenueCheck(review('bloquear', 1), backed)).toMatchObject({ is_complete: false, severity: 'blocking' });
  });

  it('a balance apart from its schedules warns with both figures, either way', () => {
    const above = deferredRevenueCheck(review('bloquear', 0), [{ accountId: '2158', ledger: '35643.8357', scheduled: '25643.8357' }]);
    expect(above).toMatchObject({ is_complete: false, severity: 'warning' });
    expect(above.details).toBe('2158: 35643.8357 in the ledger, 25643.8357 scheduled (10000.0000 apart)');
    const below = deferredRevenueCheck(review('avisar', 0), [{ accountId: '2158', ledger: '0.0000', scheduled: '500.0000' }]);
    expect(below.details).toContain('(-500.0000 apart)');
  });

  it('nothing deferred is green, and the box has its remedy and its step', () => {
    expect(deferredRevenueCheck(review('avisar', 0), []).is_complete).toBe(true);
    expect(REMEDIO_DE['deferred-revenue-recognized']).toMatch(/^mnemosine deferred-revenue run --period/);
    expect(CLOSING_STEPS.indexOf('recognize-deferred-revenue')).toBe(CLOSING_STEPS.indexOf('amortize-prepaids') + 1);
  });
});
