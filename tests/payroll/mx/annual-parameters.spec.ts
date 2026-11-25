import { describe, it, expect } from 'vitest';
import { lastDueOnOrBefore, MX_ANNUAL_PARAMETERS } from '../../../src/services/payroll/mx/annual-parameters.js';
import { staleParameterText } from '../../../src/cli/pay-run-command.js';

// MNE-001-636 (#953): the due day of a yearly parameter, on or before a pay date.
describe('lastDueOnOrBefore', () => {
  it('the minimum wages are due on 1 January of the pay year', () => {
    expect(lastDueOnOrBefore('01-01', '2027-01-01')).toBe('2027-01-01');
    expect(lastDueOnOrBefore('01-01', '2027-12-31')).toBe('2027-01-01');
  });

  it('the UMA is due on 1 February: in January the due day is last year\'s', () => {
    expect(lastDueOnOrBefore('02-01', '2027-01-31')).toBe('2026-02-01');
    expect(lastDueOnOrBefore('02-01', '2027-02-01')).toBe('2027-02-01');
    expect(lastDueOnOrBefore('02-01', '2028-02-29')).toBe('2028-02-01');
  });
});

describe('MX_ANNUAL_PARAMETERS', () => {
  it('declares the minimum wages from 1 January and both UMAs from 1 February, each once', () => {
    expect(MX_ANNUAL_PARAMETERS.map((p) => `${p.table}:${p.key} ${p.dueEachYear}`)).toEqual([
      'tax_parameters:salario_minimo_general_diario 01-01',
      'tax_parameters:salario_minimo_frontera_diario 01-01',
      'tax_parameters:uma_daily 02-01',
      'legal_parameters:uma.monthly 02-01',
    ]);
  });

  it('the terminal names every one of them by its catalogue label, never by its raw key', () => {
    for (const p of MX_ANNUAL_PARAMETERS) {
      const text = staleParameterText({
        table: p.table, key: p.key, value: '1.00', since: '2026-01-01', dueFrom: '2027-01-01', payDate: '2027-01-15',
      });
      expect(text.startsWith(`${p.key}:`), text).toBe(false);
      expect(text).toContain('1.00');
      expect(text).toContain('2026-01-01');
      expect(text).toContain('2027-01-01');
      expect(text).toContain('2027-01-15');
    }
  });
});
