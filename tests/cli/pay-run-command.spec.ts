import { describe, it, expect } from 'vitest';
import { Command } from 'commander';
import {
  liabilityRows,
  parseEmployeeInputs,
  payRunRow,
  registerPayRunCommand,
} from '../../src/cli/pay-run-command.js';
import { ExitCode, type CliError } from '../../src/cli/kernel/index.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import type { ResultadoAcumulacion } from '../../src/services/payroll/common/employer-liability-service.js';

// ============================================================
// MNE-001-068 · THE PAY RUN LEAVES, BY THEIR PURE PIECES
//
// The run itself is proven against Postgres
// (tests/integration/mne-001-068-pay-run-terminal.int.spec.ts). Here: the
// inputs file is refused before anything is written, and each leaf declares
// the risk it has.
// ============================================================

const EMP_A = '3f0c2a1e-5b7d-4c89-a1e2-6d4f8b9c0a17';
const EMP_B = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d';
const line = (id: string) => ({ employee_id: id, earnings: [{ earning_type: 'salary', amount: 7500 }] });

function refused(fn: () => unknown): CliError {
  try {
    fn();
  } catch (err) {
    return err as CliError;
  }
  throw new Error('expected a refusal');
}

describe('parseEmployeeInputs', () => {
  it('takes a bare array and the REST body shape alike', () => {
    expect(parseEmployeeInputs(JSON.stringify([line(EMP_A)]), 'x.json')).toHaveLength(1);
    const body = { pay_period_id: 'ignored', employee_inputs: [line(EMP_A), line(EMP_B)] };
    expect(parseEmployeeInputs(JSON.stringify(body), 'x.json').map((i) => i.employee_id)).toEqual([EMP_A, EMP_B]);
  });

  it('keeps the tax flags of an earning line', () => {
    const [i] = parseEmployeeInputs(
      JSON.stringify([{ employee_id: EMP_A, earnings: [{ earning_type: 'bonus', amount: 1, is_taxable_isr: false }] }]),
      'x.json'
    );
    expect(i.earnings[0].is_taxable_isr).toBe(false);
  });

  it.each([
    ['text that is not JSON', '{nope'],
    ['an empty list', '[]'],
    ['an employee id that is not a uuid', JSON.stringify([{ employee_id: 'E-1', earnings: [{ earning_type: 'salary', amount: 1 }] }])],
    ['an amount as text', JSON.stringify([{ employee_id: EMP_A, earnings: [{ earning_type: 'salary', amount: '1' }] }])],
    ['an employee without earnings', JSON.stringify([{ employee_id: EMP_A, earnings: [] }])],
    ['a misspelled field', JSON.stringify([{ ...line(EMP_A), hours: 80 }])],
  ])('refuses %s with a usage error naming the file', (_why, text) => {
    const err = refused(() => parseEmployeeInputs(text, 'quincena.json'));
    expect(err.exitCode).toBe(ExitCode.USAGE);
    expect(JSON.stringify(err)).toContain('quincena.json');
  });

  it.each([
    ['a bare array', (l: unknown) => [l], '0.employee_id: Invalid uuid'],
    ['the REST body shape', (l: unknown) => ({ employee_inputs: [l] }), 'employee_inputs.0.employee_id: Invalid uuid'],
  ])('names the wrong field in %s, in the adapter wording (#367)', (_shape, wrap, detail) => {
    const bad = { employee_id: 'E-1', earnings: [{ earning_type: 'salary', amount: 1 }] };
    const err = refused(() => parseEmployeeInputs(JSON.stringify(wrap(bad)), 'q.json'));
    expect(err.exitCode).toBe(ExitCode.USAGE);
    expect(JSON.stringify(err)).toContain(detail);
  });

  it('refuses an employee listed twice, which would fail halfway through the run', () => {
    const err = refused(() => parseEmployeeInputs(JSON.stringify([line(EMP_A), line(EMP_A)]), 'q.json'));
    expect(err.exitCode).toBe(ExitCode.USAGE);
    expect(JSON.stringify(err)).toContain(EMP_A);
  });
});

describe('the printed rows', () => {
  it('a run row carries its totals as the service read them', () => {
    const row = payRunRow({
      id: 'r', pay_period_id: 'p', run_type: 'regular', status: 'calculated', tax_year_used: 2026,
      employee_count: 2, total_gross: '15750.00', total_employee_taxes: '1800.10',
      total_employer_taxes: '2400.55', total_net_pay: '13949.90', total_employer_cost: '18150.55',
    });
    expect(row).toMatchObject({ status: 'calculated', employees: 2, net_pay: '13949.90', tax_year: 2026 });
  });

  it('a liability row names its tax, period and due date', () => {
    const r = {
      renglones: [{
        taxType: 'imss_employer', jurisdiction: 'MX', periodStart: '2026-07-01', periodEnd: '2026-07-31',
        importe: '2400.55', fechaLimite: '2026-08-17', frecuencia: 'monthly', payRunId: null, accion: 'creado',
      }],
      hallazgos: [],
    } as unknown as ResultadoAcumulacion;
    expect(liabilityRows(r)).toEqual([{
      tax_type: 'imss_employer', jurisdiction: 'MX', period: '2026-07-01..2026-07-31',
      amount: '2400.55', due_date: '2026-08-17', action: 'creado',
    }]);
  });
});

describe('the risk each leaf declares', () => {
  const program = new Command('mnemosine');
  registerPayRunCommand(program, {
    palette: { dim: (x) => x, bold: (x) => x, cyan: (x) => x, red: (x) => x, green: (x) => x, yellow: (x) => x },
    shutdown: () => undefined,
    reportError: () => undefined,
  });
  const leaf = (name: string): Command => {
    const payRun = program.commands.find((c) => c.name() === 'pay-run')!;
    return payRun.commands.find((c) => c.name() === name)!;
  };

  it('create and calculate write outside a review queue, so the agent is kept out', () => {
    for (const name of ['create', 'calculate']) {
      expect(riskOf(leaf(name))).toMatchObject({ risk: 'escritura', agentAllowed: false });
    }
  });

  it('approve is irreversible, human only, and honors its key under its own scope', () => {
    const r = riskOf(leaf('approve'))!;
    expect(r).toMatchObject({ risk: 'irreversible', agentAllowed: false, llave: { scope: 'pay-run approve' } });
    const flags = leaf('approve').options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--dry-run', '--yes', '--idempotency-key']));
  });

  it('post (MNE-001-069) is irreversible by its --post road, human only, and honors its key', () => {
    const r = riskOf(leaf('post'))!;
    expect(r).toMatchObject({ risk: 'irreversible', agentAllowed: false, llave: { scope: 'pay-run post' } });
    const flags = leaf('post').options.map((o) => o.long);
    expect(flags).toEqual(expect.arrayContaining(['--post', '--dry-run', '--yes', '--idempotency-key']));
  });

  it('the Spanish aliases are the catalog ones', () => {
    expect(program.commands.find((c) => c.name() === 'pay-run')!.aliases()).toEqual(['corrida']);
    expect(['create', 'calculate', 'approve', 'post'].map((n) => leaf(n).aliases()[0])).toEqual([
      'crear', 'calcular', 'aprobar', 'contabilizar',
    ]);
  });
});
