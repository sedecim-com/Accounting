import type { Command } from 'commander';
import { listEmployees } from '../services/payroll/common/employee-service.js';
import { ExitCode, dateOnly, declareRisk, render, usageError, withContext, withOutput, withSelection } from './kernel/index.js';
import type { EmployeeCommonOpts, EmployeeLeafKit } from './employee-command.js';

// ============================================================
// employee list · empleado listar
//
// The roll of ONE entity. The entity goes into `listEmployees` as
// `entity_id = $n` inside the SQL; `--all-entities` (catalog row) is not
// offered in this part, so the leaf can never return a sister company's staff.
//
// It prints no tax identifier at all — the service's projection carries none —
// which is what lets the agent call it (registry §6.12: an identifier of more
// than one person is never materialized for the agent).
// ============================================================

/** The published states of `employees.status` (008_payroll.sql CHECK). */
export const EMPLOYEE_STATES = ['active', 'on_leave', 'terminated', 'suspended'] as const;

interface ListOpts extends EmployeeCommonOpts {
  status?: string[];
  all?: boolean;
  country?: string;
  limit?: number;
  offset?: number;
}

const EXAMPLES = `
Examples:
  # Active employees of the entity in use.
  mnemosine employee list
  # Everyone, terminated included, as JSON.
  mnemosine employee list --all --json
  # Only the Mexican roll, numbers only, to pipe into employee show.
  mnemosine employee list --country MX -q
`;

/** The status filter: none given means active, and `--all` means any. */
export function statusFilter(opts: { status?: string[]; all?: boolean }): string | undefined {
  const states = (opts.status ?? []).map((s) => s.trim().toLowerCase());
  const unknown = states.filter((s) => !(EMPLOYEE_STATES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw usageError(`--status ${unknown.join(', ')}: use one of ${EMPLOYEE_STATES.join(', ')}.`);
  }
  if (states.length > 1) {
    throw usageError('--status takes one state at a time; use -a/--all for every state.');
  }
  if (opts.all) return undefined;
  return states[0] ?? 'active';
}

export function registerEmployeeList(family: Command, kit: EmployeeLeafKit): void {
  const list = family
    .command('list')
    .alias('listar')
    .description('List the employees of the entity, active by default, with no tax identifiers');
  withContext(list);
  withSelection(list);
  withOutput(list);
  list.option('--country <MX|US>', 'only employees of this country');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EXAMPLES);
  list.action((opts: ListOpts) =>
    kit.run(async () => {
      const status = statusFilter(opts);
      const scope = await kit.scopeForRead(opts);
      const rows = await listEmployees(scope.tenantId, {
        entity_id: scope.entityId,
        status,
        country: opts.country?.toUpperCase(),
        limit: opts.limit,
        offset: opts.offset,
      });
      render(
        rows.map((e) => ({
          number: e.employee_number,
          name: [e.first_name, e.last_name].filter(Boolean).join(' '),
          status: e.status,
          country: e.country_code,
          hire_date: dateOnly(e.hire_date),
          salary_type: e.salary_type,
          currency: e.currency_code,
          id: e.id,
        })),
        { ...opts, idField: 'number' }
      );
      if (rows.length === 0) {
        process.stderr.write(kit.deps.palette.dim('No employees matched in this entity.\n'));
      }
      return ExitCode.OK;
    })
  );
}
