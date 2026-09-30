import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import {
  paycheckStatusFilter,
  payslipHeader,
  payslipLines,
  registerPayslipCommand,
} from '../../src/cli/payslip-command.js';
import {
  assertSuaDestination,
  registerImssCommand,
  suaFindingRow,
  suaFindingText,
  suaMonth,
  writeSuaFile,
} from '../../src/cli/imss-command.js';
import { ExitCode, exitCodeFor, type CliError } from '../../src/cli/kernel/index.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { entityScope } from '../../src/database/scope.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';
import {
  getPaycheck,
  listPaychecks,
  type PaycheckDetail,
} from '../../src/services/payroll/common/paycheck-read-service.js';
import type { HallazgoSua } from '../../src/services/payroll/mx/sua-generator.js';
import { NotFoundError } from '../../src/utils/errors.js';

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

// ============================================================
// REVIEW FIXES (PR #513)
// ============================================================

const usageOf = (fn: () => unknown): number | undefined => {
  try {
    fn();
  } catch (e) {
    return (e as CliError).exitCode;
  }
  return undefined;
};

describe('payslip list selection', () => {
  const program = new Command('mnemosine');
  registerPayslipCommand(program, { palette: {} as never, shutdown: () => undefined, reportError: () => undefined });
  const list = program.commands.find((c) => c.name() === 'payslip')!.commands.find((c) => c.name() === 'list')!;

  it('carries the list contract: --limit, --offset, --status and --all', () => {
    const longs = list.options.map((o) => o.long);
    expect(longs).toEqual(expect.arrayContaining(['--limit', '--offset', '--status', '--all']));
  });

  it('--status filters by stamp state, and none or --all means the whole run', () => {
    expect(paycheckStatusFilter({})).toEqual([]);
    expect(paycheckStatusFilter({ status: ['pending', 'stamped'], all: true })).toEqual([]);
    expect(paycheckStatusFilter({ status: ['Pending,failed'] })).toEqual(['pending', 'failed']);
    expect(usageOf(() => paycheckStatusFilter({ status: ['paid'] }))).toBe(ExitCode.USAGE);
  });
});

describe('a non-UUID id is not found, not a Postgres 22P02', () => {
  const scope = entityScope('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002');

  it('payslip show abc exits 3', async () => {
    const err = await getPaycheck('abc', scope).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(exitCodeFor(err)).toBe(ExitCode.NOT_FOUND);
  });

  it('payslip list --run abc exits 3', async () => {
    const err = await listPaychecks('abc', scope).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(exitCodeFor(err)).toBe(ExitCode.NOT_FOUND);
  });
});

describe('imss sua export: the file and where it goes', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'sua-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('--yes over an existing 0644 file leaves it 0600 with the new content', () => {
    const f = path.join(dir, 'SUA.txt');
    writeFileSync(f, 'old', { mode: 0o644 });
    chmodSync(f, 0o644);
    writeSuaFile(f, 'new\r\n', true);
    expect(readFileSync(f, 'utf8')).toBe('new\r\n');
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('without --yes the open itself refuses an existing file, and leaves it intact', () => {
    const f = path.join(dir, 'SUA.txt');
    writeFileSync(f, 'keep');
    expect(usageOf(() => writeSuaFile(f, 'new', false))).toBe(ExitCode.USAGE);
    expect(readFileSync(f, 'utf8')).toBe('keep');
  });

  it('a new file is created 0600', () => {
    const f = path.join(dir, 'sub', 'SUA.txt');
    writeSuaFile(f, 'x', false);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it('refuses to print the roll to an interactive terminal; pipes, -o and --dry-run pass', () => {
    expect(usageOf(() => assertSuaDestination({}, true))).toBe(ExitCode.USAGE);
    expect(usageOf(() => assertSuaDestination({}, false))).toBeUndefined();
    expect(usageOf(() => assertSuaDestination({ output: 'SUA.txt' }, true))).toBeUndefined();
    expect(usageOf(() => assertSuaDestination({ dryRun: true }, true))).toBeUndefined();
  });

  it('declares --dry-run', () => {
    const program = new Command('mnemosine');
    registerImssCommand(program, { palette: {} as never, shutdown: () => undefined, reportError: () => undefined });
    const exp = program.commands[0].commands[0].commands[0];
    expect(exp.options.map((o) => o.long)).toContain('--dry-run');
  });
});

describe('imss sua export: findings by key, not by Spanish prose', () => {
  const mismatch: HallazgoSua = {
    codigo: 'el_archivo_no_cuadra_con_el_pasivo', concepto: 'imss_employer',
    detalle: 'prosa en español', bloquea: true, file_amount: '1000.00', ledger_amount: '1500.00',
  };
  afterEach(() => resetLanguage());

  it('renders in the session language with both figures', () => {
    setLanguage('en');
    const en = suaFindingText(mismatch);
    expect(en).toContain('1000.00');
    expect(en).toContain('1500.00');
    expect(en).not.toContain('prosa');
    setLanguage('es');
    expect(suaFindingText(mismatch)).toMatch(/el archivo declara 1000\.00/);
  });

  it('the JSON carries the code and concept, not the sentence', () => {
    expect(suaFindingRow(mismatch)).toEqual({
      code: 'el_archivo_no_cuadra_con_el_pasivo', concept: 'imss_employer',
      file_amount: '1000.00', ledger_amount: '1500.00', blocking: true,
    });
  });
});

describe('the payroll manual names the terminal leaves', () => {
  const manual = readFileSync(path.resolve(__dirname, '../../src/ai/docs/payroll.md'), 'utf8');

  it('no longer says there are no payroll tools, and names the new commands', () => {
    expect(manual).not.toMatch(/no payroll tools yet/);
    expect(manual).toContain('mnemosine payslip list --run <id>|show <id>');
    expect(manual).toContain('mnemosine imss sua export --period YYYY-MM -o <file>');
  });
});
