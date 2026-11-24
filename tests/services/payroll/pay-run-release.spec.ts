import { describe, it, expect } from 'vitest';
import { PAY_RUN_STATUSES } from '../../../src/database/enums.js';
import { runIsReleased, type PayRunStatus } from '../../../src/services/payroll/common/pay-run-release.js';

// MNE-001-720 (#601): which run states let a paycheck leave the system.
describe('runIsReleased', () => {
  it('releases the paychecks of an approved or a paid run, and of no other', () => {
    const released = PAY_RUN_STATUSES.filter((status) => runIsReleased(status));
    expect(released).toEqual(['approved', 'paid']);
  });

  it.each(['draft', 'calculating', 'calculated', 'voided'] as const)('a %s run releases nothing', (status) => {
    expect(runIsReleased(status)).toBe(false);
  });

  it('refuses a status this code does not know', () => {
    expect(runIsReleased('archived' as PayRunStatus)).toBe(false);
  });
});
