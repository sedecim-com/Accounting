import { describe, it, expect } from 'vitest';
import { convertirAFuncional, desgloseCambiarioDelPago } from '../../../src/services/accounting/moneda-origen.js';
import {
  convertirImporte,
  minorUnitDecimals,
  minorUnitDecimalsSql,
  verificarOrigenFx,
} from '../../../src/services/fx/conversion.js';
import { verificarRedondeo, type CuentaDeBalanza } from '../../../src/services/sat/anexo24/balanza-invariantes.js';
import { bookAmountDueSql } from '../../../src/services/reporting/report-service.js';
import { discountVatShare } from '../../../src/services/accounting/iva-cash-basis.js';

/**
 * MNE-001-862 (#1066) · A FUNCTIONAL AMOUNT IS BOOKED AT ITS CURRENCY'S MINOR UNIT.
 *
 * The failing case of the standards review of 27 Nov 2026 (report 01, G01),
 * by hand:
 *
 *   January   USD 33.35 × 17.1141 = 570.755235   → 570.76 (was 570.7552)
 *   February  USD  5.85 × 17.0950 = 100.005750   → 100.01 (was 100.0058)
 *
 * At four decimals the account ends February at 670.7610: the Anexo 24
 * declares 570.76 + 100.01 and a closing balance of 670.76, and refuses.
 */

const account = (opening: string, debit: string, closing: string): CuentaDeBalanza => ({
  account_id: 'a',
  num_cta: '105.01',
  natur: 'D',
  saldo_ini_mayor: opening,
  debe: debit,
  haber: '0',
  saldo_fin_mayor: closing,
  codigo_agrupador: null,
  natur_del_agrupador: null,
});
const context = (c: CuentaDeBalanza) => ({ cuentas: [c], descuadres: [], catalogo: null, criterio_sellado: 'x', sellada: false });

describe('the conversion rounds half-up to the minor unit of the functional currency', () => {
  it('the January and February invoices are booked to the cent', () => {
    expect(convertirAFuncional('33.35', '17.1141', 'MXN')).toBe('570.7600');
    expect(convertirAFuncional('5.85', '17.0950', 'MXN')).toBe('100.0100');
  });

  it("February's trial balance adds up after rounding: 570.76 + 100.01 = 670.77", () => {
    expect(verificarRedondeo(context(account('570.7600', '100.0100', '670.7700')))).toEqual([]);
    // The figures the ledger held before: the same account, refused.
    expect(verificarRedondeo(context(account('570.7552', '100.0058', '670.7610')))).toHaveLength(1);
  });

  it('the peso is the default where the caller holds no currency, and half a cent goes up', () => {
    expect(convertirAFuncional('33.35', '17.1141')).toBe('570.7600');
    expect(convertirAFuncional('0.50', '0.01')).toBe('0.0100'); // 0.005 exactly
    expect(convertirAFuncional('0.49', '0.01')).toBe('0.0000'); // 0.0049
  });

  it('a currency with no minor unit is booked in whole units, one with three decimals in thousandths', () => {
    expect(minorUnitDecimals('MXN')).toBe(2);
    expect(minorUnitDecimals('JPY')).toBe(0);
    expect(minorUnitDecimals('KWD')).toBe(3);
    expect(convertirImporte('10.00', '149.256', 'JPY')).toBe('1493.0000'); // 1 492.56
    expect(convertirImporte('10.00', '0.30755', 'KWD')).toBe('3.0760'); // 3.0755
  });

  it('there is one arithmetic: the engine check and the engines call the same function', () => {
    for (const [amount, rate] of [['33.33', '17.1141'], ['5.33', '17.1141'], ['999999999999.99', '18.1234567891']]) {
      expect(convertirAFuncional(amount, rate, 'MXN')).toBe(convertirImporte(amount, rate, 'MXN'));
    }
  });

  it('a payment breaks down at the cent, and the realised difference is what makes it foot', () => {
    // Liability 33.35 × 17.1141 → 570.76; cash 33.35 × 17.0950 = 570.118250 → 570.12; gain 0.64.
    const d = desgloseCambiarioDelPago('33.35', {
      moneda: 'USD', monedaFuncional: 'MXN', tasaPago: '17.0950', fuenteTasa: 'dof',
      aplicaciones: [{ billId: 'b1', numero: 'B-1', aplicado: '33.35', descuento: '0', tasaHistorica: '17.1141' }],
    });
    expect(d.pasivos[0].montoFuncional).toBe('570.7600');
    expect(d.bancoFuncional).toBe('570.1200');
    expect(d.diferencia).toEqual({ tipo: 'utilidad', montoFuncional: '0.6400' });
  });

  it('a bill paid in parts is settled telescopically: the payable born at 98.47 ends at zero', () => {
    // USD 5.40 at 18.2345 = 98.4663 → 98.47. Each half is 2.70 → 49.23315 → 49.23:
    // the second one takes 98.47 − 49.23 = 49.24, a cent more than its own product.
    const half = (priorApplied: string) =>
      desgloseCambiarioDelPago('2.70', {
        moneda: 'USD', monedaFuncional: 'MXN', tasaPago: '18.2345', fuenteTasa: 'dof',
        aplicaciones: [{ billId: 'b1', numero: 'B-1', aplicado: '2.70', descuento: '0', tasaHistorica: '18.2345', priorApplied }],
      });
    const first = half('0');
    expect(first.pasivos[0]).toMatchObject({ montoFuncional: '49.2300', rounding: '0.0000' });
    expect(first.diferencia.tipo).toBe('ninguna');
    const second = half('2.70');
    expect(second.pasivos[0]).toMatchObject({ montoFuncional: '49.2300', extranjero: '2.7000', rounding: '0.0100' });
    // The cash is 49.23 and the payable gives up 49.24: the cent is realised gain.
    expect(second.diferencia).toEqual({ tipo: 'utilidad', montoFuncional: '0.0100' });
  });

  it("an early-payment discount's VAT share at the bill's rate is a figure in cents", () => {
    // 10 of discount over 116 with 16 of VAT: 1.3793 in dollars; × 17.1141 = 23.6054... → 23.61.
    expect(discountVatShare({ discount: '10', taxAmount: '16', totalAmount: '116', remainder: '500', closes: false, rate: '17.1141' }))
      .toBe('23.6100');
  });
});

describe('the engine verifies a foreign line against the same rounding', () => {
  const line = (credit: string) => ({
    debit_amount: null, credit_amount: credit, currency_code: 'USD', foreign_credit: '33.35', exchange_rate: '17.1141',
  });

  it('accepts 570.76 and refuses the four-decimal product, naming the minor unit', () => {
    expect(() => verificarOrigenFx(line('570.7600'), 'MXN', 1)).not.toThrow();
    expect(() => verificarOrigenFx(line('570.7552'), 'MXN', 1)).toThrow(/570\.7600 .*2 decimales.*MXN/);
  });

  it('judges by the functional currency of the entity, not by the peso', () => {
    const yen = { debit_amount: '1493.0000', credit_amount: null, currency_code: 'USD', foreign_debit: '10.00', exchange_rate: '149.256' };
    expect(() => verificarOrigenFx(yen, 'JPY', 1)).not.toThrow();
    expect(() => verificarOrigenFx({ ...yen, debit_amount: '1492.5600' }, 'JPY', 1)).toThrow(/0 decimales.*JPY/);
  });
});

describe('the book value the reports weigh is rounded as the posting is', () => {
  it('rounds amount_due × rate to the minor unit of the functional currency, kept at the ledger scale', () => {
    const sql = bookAmountDueSql('i', '$1');
    expect(sql).toContain(`ROUND(i.amount_due * i.exchange_rate, ${minorUnitDecimalsSql('(SELECT functional_currency FROM legal_entities WHERE id = $1)')})::numeric(19,4)`);
    expect(sql).not.toMatch(/exchange_rate, 4\)/);
  });

  it('the SQL twin names every currency whose minor unit is not two, from the same table', () => {
    const sql = minorUnitDecimalsSql('le.functional_currency');
    expect(sql).toMatch(/^CASE le\.functional_currency WHEN /);
    expect(sql).toContain("WHEN 'JPY' THEN 0");
    expect(sql).toContain("WHEN 'KWD' THEN 3");
    expect(sql).not.toContain("'MXN'");
    expect(sql).toMatch(/ ELSE 2 END$/);
  });
});
