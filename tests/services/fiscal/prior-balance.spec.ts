import { describe, it, expect } from 'vitest';
import {
  availableOf,
  overrideFindings,
  proposePriorCredit,
} from '../../../src/services/fiscal/prior-balance.js';
import type { BalanceInFavorSource } from '../../../src/services/fiscal/filed-returns.js';

// ============================================================
// MNE-001-386 · #308 — what the record of filed returns leaves to credit, and
// how much of it one month takes: LIVA art. 6 (only against the tax payable,
// in later months; a balance whose refund was requested is gone), CFF art. 23
// (what was compensated is gone), 23/IVA/N (each remnant under its own
// return), oldest first. Every figure is worked by hand in its comment.
// ============================================================

const source = (period: string, balance: string, more: Partial<BalanceInFavorSource> = {}): BalanceInFavorSource => ({
  acknowledgementNumber: `OP-SYN-${period.slice(5)}`, period, filedOn: `${period}-28`, balanceInFavor: balance,
  credited: '0.00', compensated: '0.00', refundRequested: '0.00', ...more,
});

describe('what each balance still holds', () => {
  it('a refund request leaves nothing to credit, whatever it states (LIVA art. 6)', () => {
    expect(availableOf(source('2026-04', '300.00', { refundRequested: '120.00' })).toFixed(2)).toBe('0.00');
  });

  it('500 − 200 compensated − 100 credited elsewhere = 200', () => {
    expect(availableOf(source('2026-05', '500.00', { compensated: '200.00', credited: '100.00' })).toFixed(2)).toBe('200.00');
  });

  it('an amendment that lowered a used balance leaves 0, and says by how much it is overdrawn', () => {
    // 800 in force, 900 already credited: −100, floored at 0.
    const p = proposePriorCredit([source('2026-06', '800.00', { credited: '900.00' })], '1000', 'cada_renglon');
    expect(p.available).toBe('0.00');
    expect(p.balances[0].available).toBe('0.00');
    const found = p.findings.find((h) => h.codigo === 'IVA-WP-PRIOR-BALANCE-OVERDRAWN');
    expect(found?.severidad).toBe('aviso');
    expect(found?.mensaje).toMatch(/OP-SYN-06.*100\.00/);
  });
});

describe('the month takes up to its tax payable, oldest first', () => {
  // May 200, June 550, July 2,000 = 2,750 available; 1,600 payable.
  const sources = [
    source('2026-07', '2000.00'),
    source('2026-05', '500.00', { compensated: '200.00', credited: '100.00' }),
    source('2026-06', '800.00', { credited: '250.00' }),
  ];

  it('credits 1,600 = 200 + 550 + 850, and July keeps 1,150', () => {
    const p = proposePriorCredit(sources, '1600', 'cada_renglon');
    expect(p).toMatchObject({ cap: '1600.00', available: '2750.00', credited: '1600.00' });
    expect(p.balances.map((b) => [b.period, b.creditedHere, b.remnant])).toEqual([
      ['2026-05', '200.00', '0.00'],
      ['2026-06', '550.00', '0.00'],
      ['2026-07', '850.00', '1150.00'],
    ]);
  });

  it('the first credit of a balance warns that its remnant can no longer be refunded (23/IVA/N)', () => {
    const first = proposePriorCredit(sources, '1600', 'cada_renglon').findings
      .filter((h) => h.codigo === 'IVA-WP-PRIOR-BALANCE-FIRST-CREDIT');
    // May and June were credited before; July is credited here for the first time.
    expect(first.map((h) => h.severidad)).toEqual(['aviso']);
    expect(first[0].mensaje).toMatch(/OP-SYN-07.*23\/IVA\/N/);
  });

  it('a month with no tax payable credits nothing, and a balance in favour of its own stays its own', () => {
    for (const payable of ['0', '-406']) {
      const p = proposePriorCredit(sources, payable, 'cada_renglon');
      expect(p).toMatchObject({ cap: '0.00', credited: '0.00' });
      expect(p.balances.map((b) => b.remnant)).toEqual(['200.00', '550.00', '2000.00']);
      expect(p.findings).toEqual([]);
    }
  });

  it('cada_renglon credits whole pesos it holds; solo_el_pago credits the cents', () => {
    // 1,000.60 + 500.70 = 1,501.30 available against 5,000 payable.
    const cents = [source('2026-05', '1000.60'), source('2026-06', '500.70')];
    const whole = proposePriorCredit(cents, '5000', 'cada_renglon');
    expect(whole.credited).toBe('1501.00');
    expect(whole.balances.map((b) => [b.creditedHere, b.remnant])).toEqual([['1000.60', '0.00'], ['500.40', '0.30']]);
    expect(proposePriorCredit(cents, '5000.00', 'solo_el_pago').credited).toBe('1501.30');
  });
});

describe('an override, with its reason', () => {
  const proposal = proposePriorCredit([source('2026-07', '2000.00')], '1600', 'cada_renglon');

  it('is named with its reason and the figure the record proposed', () => {
    const [h] = overrideFindings('1000.0000', 'Saldo de una declaración anterior al sistema', proposal, 'cada_renglon');
    expect(h).toMatchObject({ codigo: 'IVA-WP-PRIOR-BALANCE-OVERRIDE', severidad: 'aviso' });
    expect(h.mensaje).toMatch(/1000\.00.*anterior al sistema.*1600\.00/);
  });

  it('above what the record holds, says by how much: 2,500 − 2,000 = 500', () => {
    const big = proposePriorCredit([source('2026-07', '2000.00')], '3000', 'cada_renglon');
    const [h] = overrideFindings('2500.0000', 'motivo', big, 'cada_renglon');
    expect(h.mensaje).toMatch(/supera en 500\.00 /);
  });

  it('above the tax payable blocks: 1,700 > 1,600 would create a balance of this month', () => {
    const codes = overrideFindings('1700.0000', 'motivo', proposal, 'cada_renglon').map((h) => [h.codigo, h.severidad]);
    expect(codes).toContainEqual(['IVA-WP-PRIOR-BALANCE-ABOVE-PAYABLE', 'bloqueante']);
    // In the result's column: 1,600.49 rounds to 1,600 whole under cada_renglon, and is above 1,600.00 in cents.
    expect(overrideFindings('1600.4900', 'motivo', proposal, 'cada_renglon').map((h) => h.codigo))
      .not.toContain('IVA-WP-PRIOR-BALANCE-ABOVE-PAYABLE');
    const inCents = proposePriorCredit([source('2026-07', '2000.00')], '1600.00', 'solo_el_pago');
    expect(overrideFindings('1600.4900', 'motivo', inCents, 'solo_el_pago').map((h) => h.codigo))
      .toContain('IVA-WP-PRIOR-BALANCE-ABOVE-PAYABLE');
  });
});
