import * as fs from 'node:fs';
import type { Command } from 'commander';
import { resolveReviewer } from '../ai/draft-service.js';
import { withTransaction } from '../database/connection.js';
import { createEmployee, type EmployeeInput } from '../services/payroll/common/employee-service.js';
import { ExitCode, declareRisk, gateMutation, render, usageError, withContext, withOutput } from './kernel/index.js';
import type { EmployeeCommonOpts, EmployeeLeafKit } from './employee-command.js';
import { maskIdentifier } from './employee-show-command.js';

// ============================================================
// employee create · empleado crear
//
// Registers one employee through `createEmployee`, the same writer as
// `POST /payroll/employees`.
//
// SECURITY: THE IDENTIFIERS COME FROM A FILE, NEVER FROM THE COMMAND LINE.
// RFC, CURP, NSS, SSN and the bank account would otherwise land in shell
// history and in `ps` output. `--file` is a JSON object with the service's
// own field names; only the three flags the catalog names (`--country`,
// `--hire-date`, `--pay-schedule`) override it.
//
// THE FILE CANNOT CHOOSE THE ENTITY. `tenant_id`, `entity_id` and
// `created_by` in the file are refused, not ignored: silently re-homing a
// record meant for another company would register it where its author did
// not expect. The entity is the one named or pinned (`requireExplicitEntity`).
//
// Agent ✗: a registration carries a person's identifiers and starts their
// pay; it is not a draft for review.
// ============================================================

/** Fields the file may carry: the writer's own names, minus the scope. */
const FILE_FIELDS = new Set<string>([
  'employee_number', 'first_name', 'last_name', 'second_last_name', 'email', 'phone',
  'hire_date', 'country_code', 'salary_type', 'annual_salary', 'hourly_rate',
  'currency_code', 'pay_schedule_id',
  'rfc', 'curp', 'nss', 'sbc', 'tipo_regimen_sat', 'tipo_contrato_sat', 'tipo_jornada_sat',
  'riesgo_puesto', 'infonavit_credit_number', 'infonavit_credit_type', 'infonavit_credit_value',
  'ssn', 'w4_data', 'work_state', 'residence_state', 'work_city',
  'bank_account', 'bank_name',
]);

const REQUIRED = ['employee_number', 'first_name', 'last_name', 'hire_date', 'country_code'] as const;

interface CreateOpts extends EmployeeCommonOpts {
  file?: string;
  country?: string;
  hireDate?: string;
  paySchedule?: string;
  dryRun?: boolean;
}

export type EmployeeDraft = Omit<EmployeeInput, 'tenant_id' | 'entity_id' | 'created_by'>;

/** The file plus the flags, checked before anything touches the database. */
export function readEmployeeDraft(raw: string, opts: CreateOpts): EmployeeDraft {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw usageError('--file is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw usageError('--file must hold ONE employee as a JSON object; bulk loading is `employee import`.');
  }
  const fields = parsed as Record<string, unknown>;
  const scoped = ['tenant_id', 'entity_id', 'created_by'].filter((k) => k in fields);
  if (scoped.length > 0) {
    throw usageError(`--file may not set ${scoped.join(', ')}: the entity is the one named with -e/--entity.`);
  }
  const unknown = Object.keys(fields).filter((k) => !FILE_FIELDS.has(k));
  if (unknown.length > 0) {
    throw usageError(`--file has unknown fields: ${unknown.join(', ')}.`);
  }
  const draft = { ...fields } as Record<string, unknown>;
  if (opts.country) draft.country_code = opts.country.toUpperCase();
  if (opts.hireDate) draft.hire_date = opts.hireDate;
  if (opts.paySchedule) draft.pay_schedule_id = opts.paySchedule;

  const missing = REQUIRED.filter((k) => draft[k] === undefined || draft[k] === null || draft[k] === '');
  if (missing.length > 0) throw usageError(`Missing ${missing.join(', ')}.`);
  if (draft.country_code !== 'MX' && draft.country_code !== 'US') {
    throw usageError(`country_code "${String(draft.country_code)}": use MX or US.`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(draft.hire_date))) {
    throw usageError(`hire_date "${String(draft.hire_date)}": use YYYY-MM-DD.`);
  }
  return draft as unknown as EmployeeDraft;
}

/** The rehearsal sentinel: thrown to abort the transaction `--dry-run` opens. */
class RehearsedRegistration extends Error {
  constructor(readonly id: string) {
    super('employee registration rehearsed');
    this.name = 'RehearsedRegistration';
  }
}

const EXAMPLES = `
Examples:
  # The record lives in a file so RFC, CURP and NSS never reach shell history:
  #   {"employee_number":"E-0042","first_name":"Ana","last_name":"Ruiz",
  #    "rfc":"RUAA900101AB1","curp":"RUAA900101MDFZNN09","nss":"12345678901",
  #    "sbc":450.25,"salary_type":"salary","annual_salary":180000}
  mnemosine employee create --file ana.json --country MX --hire-date 2026-10-01
  # Rehearse it: the real writer runs and is rolled back. Nothing is saved.
  mnemosine employee create --file ana.json --country MX --hire-date 2026-10-01 --dry-run
  # Join a pay schedule of this same entity (another entity's is refused).
  mnemosine employee create --file ana.json --pay-schedule 0b7e2c9a-5d41-4f3e-8a6b-1c2d3e4f5a6b
`;

export function registerEmployeeCreate(family: Command, kit: EmployeeLeafKit): void {
  const create = family
    .command('create')
    .alias('crear')
    .description('Register one employee from a JSON file with their tax identifiers');
  withContext(create);
  withOutput(create);
  create
    .option('--file <path>', 'JSON object with the employee record (required)')
    .option('--country <MX|US>', 'the country whose payroll applies; overrides the file')
    .option('--hire-date <date>', 'hire date (YYYY-MM-DD); overrides the file')
    .option('--pay-schedule <id>', 'a pay schedule of this entity; overrides the file')
    .option('--dry-run', 'run the real writer and roll it back: nothing is saved');
  declareRisk(create, {
    risk: 'escritura',
    agent: false,
    writes: 'employees (one row) and employee_compensation_history (its initial row); no journal entry',
  });
  create.addHelpText('after', EXAMPLES);
  create.action((opts: CreateOpts, cmd: Command) =>
    kit.run(async () => {
      const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
      if (!opts.file) throw usageError('Missing --file: identifiers are read from a file, never from flags.');
      const draft = readEmployeeDraft(fs.readFileSync(opts.file, 'utf8'), opts);

      const scope = await kit.scopeForWrite(opts);
      const reviewer = await resolveReviewer(scope.tenantId, opts.user);
      const input: EmployeeInput = {
        ...draft,
        tenant_id: scope.tenantId,
        entity_id: scope.entityId,
        created_by: reviewer.userId,
      };

      let id: string;
      if (dryRun) {
        try {
          id = await withTransaction(async (client) => {
            throw new RehearsedRegistration(await createEmployee(input, { client }));
          });
        } catch (err) {
          if (!(err instanceof RehearsedRegistration)) throw err;
          id = err.id;
        }
      } else {
        id = await createEmployee(input);
      }

      render(
        [
          {
            number: input.employee_number,
            name: [input.first_name, input.last_name, input.second_last_name].filter(Boolean).join(' '),
            country: input.country_code,
            hire_date: input.hire_date,
            rfc: maskIdentifier(input.rfc, false),
            status: dryRun ? 'rehearsed' : 'active',
            id,
          },
        ],
        { ...opts, idField: 'id' }
      );
      if (dryRun) {
        process.stderr.write(kit.deps.palette.dim('Rehearsal: the transaction was undone. No employee was saved.\n'));
      }
      return ExitCode.OK;
    })
  );
}
