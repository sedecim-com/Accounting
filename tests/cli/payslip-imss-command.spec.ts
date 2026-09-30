import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import { payslipHeader, payslipLines, registerPayslipCommand } from '../../src/cli/payslip-command.js';
import { registerImssCommand, suaMonth } from '../../src/cli/imss-command.js';
import { ExitCode, type CliError } from '../../src/cli/kernel/index.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import type { PaycheckDetail } from '../../src/services/payroll/common/paycheck-read-service.js';

// ============================================================
// MNE-001-070 · THE PAYSLIP AND THE SUA LEAVES, BY THEIR PURE PIECES
//
// The fortnight from the terminal is proven against Postgres
// (tests/integration/mne-001-070-payslip-and-sua.int.spec.ts). Here: the
// month is parsed strictly, the payslip masks the identifiers, and each leaf
// declares the risk the catalog gives it.
// ============================================================

const paycheck: PaycheckDetail = {
  id: 'pc-1', employee_id: 'emp-1', gross_earnings: '6000.00', net_pay: '5100.00',
  isr_withheld: '700.00', imss_employee: '150.00', infonavit_withheld: '50.00',
  imss_employer: '900.00', infonavit_employer: '300.00', cfdi_status: null,
  earnings: [{ earning_type: 'salary', amount: '6000.00' }],
  deductions: [{ deduction_type: 'loan_repayment', amount: '100.00' }],
  taxes: [{ tax_type: 'isr', tax_amount: '700.00', employee_employer: 'EE', taxable_wages: '6000.00' }],
};
const employee = {
  employee_number: 'P-001', first_name: 'Ana', last_name: 'Ruiz',
  rfc: 'RUAA900101AB1', curp: 'RUAA900101MDFZNN09', nss: '12345678901',
};

describe('suaMonth', () => {
  it('reads YYYY-MM', () => {
    expect(suaMonth('2026-07')).toEqual({ year: 2026, month: 7 });
  });

  it.each([undefined, '2026-13', '2026-00', '2026-7', '07-2026', '2026-Q3'])('refuses %s as a usage error', (p) => {
    let err: CliError | undefined;
    try {
      suaMonth(p);
    } catch (e) {
      err = e as CliError;
    }
    expect(err?.exitCode).toBe(ExitCode.USAGE);
  });
});

describe('payslip show', () => {
  it('masks RFC, CURP and NSS to their last three characters', () => {
    const h = payslipHeader(paycheck, employee, false);
    expect([h.rfc, h.curp, h.nss]).toEqual(['••••AB1', '••••N09', '••••901']);
    expect(JSON.stringify(h)).not.toContain('RUAA900101');
  });

  it('--redacted hides them entirely', () => {
    const h = payslipHeader(paycheck, employee, true);
    expect([h.rfc, h.curp, h.nss]).toEqual(['(redacted)', '(redacted)', '(redacted)']);
  });

  it('prints every earning, deduction and tax line with the amount stored', () => {
    expect(payslipLines(paycheck)).toEqual([
      { kind: 'earning', concept: 'salary', amount: '6000.00', side: '', base: '' },
      { kind: 'deduction', concept: 'loan_repayment', amount: '100.00', side: '', base: '' },
      { kind: 'tax', concept: 'isr', amount: '700.00', side: 'EE', base: '6000.00' },
    ]);
  });
});

describe('risk declarations', () => {
  const program = new Command('mnemosine');
  const deps = { palette: {} as never, shutdown: () => undefined, reportError: () => undefined };
  registerPayslipCommand(program, deps);
  registerImssCommand(program, deps);
  const leaf = (...path: string[]): Command =>
    path.reduce<Command>((c, name) => c.commands.find((x) => x.name() === name)!, program);

  it('the payslip readers are lectura and open to the agent', () => {
    for (const name of ['list', 'show']) {
      expect(riskOf(leaf('payslip', name))).toMatchObject({ risk: 'lectura', agentAllowed: true });
    }
  });

  it('the SUA export writes and is closed to the agent: it carries the whole roll', () => {
    expect(riskOf(leaf('imss', 'sua', 'export'))).toMatchObject({ risk: 'escritura', agentAllowed: false });
  });
});
