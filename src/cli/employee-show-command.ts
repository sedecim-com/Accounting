import type { Command } from 'commander';
import { getEmployee } from '../services/payroll/common/employee-service.js';
import { ExitCode, dateOnly, declareRisk, render, withContext, withOutput, type Row } from './kernel/index.js';
import type { EmployeeCommonOpts, EmployeeLeafKit } from './employee-command.js';

// ============================================================
// employee show · empleado ver
//
// One employee record, read through `getEmployee`, whose entity predicate is
// inside the SQL: an employee of the sister company answers 404, the same as
// one that does not exist.
//
// SECURITY: tax identifiers are ALWAYS masked. RFC, CURP, NSS and the
// INFONAVIT credit number leave this leaf as their last three characters and
// nothing more; there is no flag that prints them whole. `--redacted` (the
// registry's flag for every command that can print a person's identifiers)
// drops even those three characters, plus e-mail and phone, for a screen that
// is shared or output pasted into a ticket. The agent may call this leaf
// because of what it materializes — one person, masked — not because of the
// value of a flag (registry §6.11).
// ============================================================

/** Hidden is a word, not a blank: «none on file» and «not shown» differ. */
const HIDDEN = '(redacted)';

/** The tail that lets a person recognize their own identifier, and no more. */
export function maskIdentifier(value: unknown, redacted: boolean): string {
  const s = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  if (s === '') return '';
  if (redacted) return HIDDEN;
  return s.length <= 3 ? '••••' : `••••${s.slice(-3)}`;
}

export function employeeRecordRow(e: Record<string, unknown>, redacted: boolean): Row {
  const contact = (v: unknown): unknown => (redacted && v ? HIDDEN : (v ?? ''));
  return {
    number: e.employee_number,
    name: [e.first_name, e.last_name, e.second_last_name].filter(Boolean).join(' '),
    status: e.status,
    country: e.country_code,
    hire_date: dateOnly(e.hire_date),
    termination_date: dateOnly(e.termination_date),
    rfc: maskIdentifier(e.rfc, redacted),
    curp: maskIdentifier(e.curp, redacted),
    nss: maskIdentifier(e.nss, redacted),
    infonavit_credit: maskIdentifier(e.infonavit_credit_number, redacted),
    sbc: e.sbc ?? '',
    sat_regime: e.tipo_regimen_sat ?? '',
    risk_class: e.riesgo_puesto ?? '',
    work_state: e.work_state ?? '',
    salary_type: e.salary_type,
    annual_salary: e.annual_salary ?? '',
    hourly_rate: e.hourly_rate ?? '',
    currency: e.currency_code,
    pay_schedule_id: e.pay_schedule_id ?? '',
    bank: e.bank_name ?? '',
    email: contact(e.email),
    phone: contact(e.phone),
    id: e.id,
  };
}

const EXAMPLES = `
Examples:
  # One record by the number on the payslip; RFC, CURP and NSS show only
  # their last three characters.
  mnemosine employee show E-0042
  # For a shared screen: identifiers, e-mail and phone are hidden entirely.
  mnemosine employee show E-0042 --redacted
  # The same record as JSON, by id, for a script.
  mnemosine employee show 3b2f6f0e-1c1d-4f5e-9a0b-7d6c5e4f3a21 --json
`;

export function registerEmployeeShow(family: Command, kit: EmployeeLeafKit): void {
  const show = family
    .command('show')
    .alias('ver')
    .argument('<employee>', 'employee number or id')
    .description('Show one employee record with tax identifiers masked');
  withOutput(withContext(show));
  show.option('--redacted', 'hide identifiers, e-mail and phone entirely, for a shared screen');
  declareRisk(show, { risk: 'lectura', agent: true });
  show.addHelpText('after', EXAMPLES);
  show.action((ref: string, opts: EmployeeCommonOpts & { redacted?: boolean }) =>
    kit.run(async () => {
      const scope = await kit.scopeForRead(opts);
      const record = await getEmployee(ref, scope);
      render([employeeRecordRow(record, opts.redacted === true)], {
        ...opts,
        idField: 'id',
        numeric: ['sbc', 'annual_salary', 'hourly_rate'],
      });
      return ExitCode.OK;
    })
  );
}
