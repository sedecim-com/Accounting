import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Command } from 'commander';
import { registerEmployeeCommand } from '../../src/cli/employee-command.js';
import { readEmployeeDraft } from '../../src/cli/employee-create-command.js';
import { statusFilter } from '../../src/cli/employee-list-command.js';
import { maskIdentifier } from '../../src/cli/employee-show-command.js';
import { auditProgram } from '../../src/cli/kernel/audit.js';
import { riskOf } from '../../src/cli/kernel/risk.js';
import { CliError } from '../../src/cli/kernel/cli-error.js';
import { ExitCode } from '../../src/cli/kernel/exit.js';

// ============================================================
// MNE-001-066 (#306) · employee create|show|list.
//
// What these defend: tax identifiers never leave `show` whole, every leaf
// hands the service the entity scope (the predicate itself lives in the SQL
// and is proven against Postgres in
// tests/integration/mne-001-066-employee-roll.int.spec.ts), and `create`
// cannot be pointed at another entity by its input file.
// ============================================================

const getEmployee = vi.fn();
const listEmployees = vi.fn();
const createEmployee = vi.fn();

vi.mock('../../src/services/payroll/common/employee-service.js', () => ({
  getEmployee: (...a: unknown[]) => getEmployee(...a) as unknown,
  listEmployees: (...a: unknown[]) => listEmployees(...a) as unknown,
  createEmployee: (...a: unknown[]) => createEmployee(...a) as unknown,
}));

let rolledBack = false;
vi.mock('../../src/database/connection.js', () => ({
  withTransaction: async (fn: (client: unknown) => Promise<unknown>) => {
    try {
      return await fn({ fake: 'client' });
    } catch (err) {
      rolledBack = true;
      throw err;
    }
  },
  query: () => Promise.resolve({ rows: [], rowCount: 0 }),
}));

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
  resolveEntity: () => Promise.resolve({ tenantId: 'T1', entityId: 'E1', entityName: 'Acme SA' }),
  listEntities: () => Promise.resolve([{ id: 'E1', name: 'Acme SA' }]),
}));

vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: () => Promise.resolve({ userId: 'U1', email: 'a@b.c' }),
}));

const SCOPE = { kind: 'entity', tenantId: 'T1', entityId: 'E1' };
const RECORD = {
  id: '3b2f6f0e-1c1d-4f5e-9a0b-7d6c5e4f3a21',
  employee_number: 'E-0042',
  first_name: 'Ana',
  last_name: 'Ruiz',
  status: 'active',
  country_code: 'MX',
  hire_date: '2026-01-15',
  rfc: 'RUAA900101AB1',
  curp: 'RUAA900101MDFZNN09',
  nss: '12345678901',
  infonavit_credit_number: '1506123456',
  email: 'ana@example.test',
  phone: '5555555555',
  salary_type: 'salary',
  currency_code: 'MXN',
};

let exitCode: number | undefined;
let errors: unknown[] = [];
let out = '';
const deps = {
  palette: {
    dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s,
    red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s,
  },
  shutdown: (c: number) => { exitCode = c; },
  reportError: (e: unknown) => { errors.push(e); },
};

function build(): Command {
  const program = new Command('mnemosine').exitOverride();
  registerEmployeeCommand(program, deps as never);
  return program;
}

async function run(argv: string[]): Promise<void> {
  exitCode = undefined;
  errors = [];
  out = '';
  await build().parseAsync(['node', 'mnemosine', ...argv]);
}

function rowsOf(): Array<Record<string, string>> {
  return (JSON.parse(out) as { rows: Array<Record<string, string>> }).rows;
}

function leaf(name: string): Command {
  const family = build().commands.find((c) => c.name() === 'employee')!;
  return family.commands.find((c) => c.name() === name)!;
}

let tmp: string;
function file(content: unknown): string {
  const p = path.join(tmp, `e-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content));
  return p;
}

const DRAFT = {
  employee_number: 'E-0042', first_name: 'Ana', last_name: 'Ruiz',
  rfc: 'RUAA900101AB1', curp: 'RUAA900101MDFZNN09', nss: '12345678901',
};

beforeEach(() => {
  process.env.MNEMOSINE_ENTITY = 'E1';
  getEmployee.mockReset();
  listEmployees.mockReset();
  createEmployee.mockReset();
  rolledBack = false;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'employee-cli-'));
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.MNEMOSINE_ENTITY;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the employee family obeys the rulebook', () => {
  it('has create, show and list with their Spanish aliases and no audit violation', () => {
    const program = build();
    const family = program.commands.find((c) => c.name() === 'employee')!;
    expect(family.aliases()).toEqual(['empleado']);
    expect(family.commands.map((c) => [c.name(), c.aliases()[0]])).toEqual([
      ['create', 'crear'],
      ['show', 'ver'],
      ['list', 'listar'],
    ]);
    expect(auditProgram(program)).toEqual([]);
  });

  it('create is a write the agent may not call; show and list are reads it may', () => {
    expect(riskOf(leaf('create'))).toMatchObject({ risk: 'escritura', agent: false });
    expect(riskOf(leaf('show'))).toMatchObject({ risk: 'lectura', agent: true });
    expect(riskOf(leaf('list'))).toMatchObject({ risk: 'lectura', agent: true });
  });

  it('no leaf takes a tax identifier as a flag', () => {
    for (const name of ['create', 'show', 'list']) {
      const longs = leaf(name).options.map((o) => o.long);
      for (const pii of ['--rfc', '--curp', '--nss', '--ssn', '--clabe']) expect(longs).not.toContain(pii);
    }
  });
});

describe('employee show masks tax identifiers', () => {
  it('keeps only the last three characters of RFC, CURP, NSS and the INFONAVIT credit', async () => {
    getEmployee.mockResolvedValue(RECORD);
    await run(['employee', 'show', 'E-0042', '--json']);
    expect(exitCode).toBe(ExitCode.OK);
    expect(getEmployee).toHaveBeenCalledWith('E-0042', SCOPE);
    for (const whole of [RECORD.rfc, RECORD.curp, RECORD.nss, RECORD.infonavit_credit_number]) {
      expect(out).not.toContain(whole);
    }
    const [row] = rowsOf();
    expect(row.rfc).toBe('••••AB1');
    expect(row.curp).toBe('••••N09');
    expect(row.nss).toBe('••••901');
    expect(row.infonavit_credit).toBe('••••456');
    expect(row.email).toBe(RECORD.email);
  });

  it('--redacted hides the identifiers, e-mail and phone entirely', async () => {
    getEmployee.mockResolvedValue(RECORD);
    await run(['employee', 'show', 'E-0042', '--redacted', '--json']);
    const [row] = rowsOf();
    expect([row.rfc, row.curp, row.nss, row.email, row.phone]).toEqual(Array(5).fill('(redacted)'));
    expect(out).not.toContain('AB1');
  });

  it('an absent identifier prints empty, never as a mask of nothing', () => {
    expect(maskIdentifier(null, false)).toBe('');
    expect(maskIdentifier('', true)).toBe('');
    expect(maskIdentifier('AB', false)).toBe('••••');
  });

  it('an employee outside the scope surfaces the service 404 as a failure', async () => {
    getEmployee.mockRejectedValue(Object.assign(new Error('Employee not found'), { statusCode: 404 }));
    await run(['employee', 'show', 'E-9999']);
    expect(errors).toHaveLength(1);
    expect(exitCode).not.toBe(ExitCode.OK);
  });
});

describe('employee list', () => {
  it('always passes the entity to the service and prints no identifier', async () => {
    listEmployees.mockResolvedValue([{ ...RECORD }]);
    await run(['employee', 'list', '--json', '-n', '5']);
    expect(exitCode).toBe(ExitCode.OK);
    expect(listEmployees).toHaveBeenCalledWith('T1', {
      entity_id: 'E1', status: 'active', country: undefined, limit: 5, offset: undefined,
    });
    expect(out).not.toContain(RECORD.rfc);
    expect(out).not.toContain(RECORD.email);
  });

  it('--all drops the status filter and --country is normalized', async () => {
    listEmployees.mockResolvedValue([]);
    await run(['employee', 'list', '--all', '--country', 'mx']);
    expect(listEmployees.mock.calls[0][1]).toMatchObject({ entity_id: 'E1', status: undefined, country: 'MX' });
  });

  it('refuses a state the schema does not have, and more than one state', () => {
    expect(() => statusFilter({ status: ['fired'] })).toThrow(CliError);
    expect(() => statusFilter({ status: ['active', 'terminated'] })).toThrow(/one state/);
    expect(statusFilter({ status: ['Terminated'] })).toBe('terminated');
  });
});

describe('employee create', () => {
  it('reads the record from the file, stamps the scope and the user, and masks the echo', async () => {
    createEmployee.mockResolvedValue('new-id');
    await run(['employee', 'create', '--file', file(DRAFT), '--country', 'mx', '--hire-date', '2026-10-01', '--json']);
    expect(errors).toEqual([]);
    expect(exitCode).toBe(ExitCode.OK);
    expect(createEmployee).toHaveBeenCalledWith({
      ...DRAFT, country_code: 'MX', hire_date: '2026-10-01',
      tenant_id: 'T1', entity_id: 'E1', created_by: 'U1',
    });
    expect(out).not.toContain(DRAFT.rfc);
    expect(rowsOf()[0]).toMatchObject({ id: 'new-id', rfc: '••••AB1', status: 'active' });
  });

  it('--dry-run runs the real writer on a transaction and rolls it back', async () => {
    createEmployee.mockResolvedValue('rehearsed-id');
    await run(['employee', 'create', '--file', file(DRAFT), '--country', 'MX', '--hire-date', '2026-10-01', '--dry-run', '--json']);
    expect(errors).toEqual([]);
    expect(createEmployee.mock.calls[0][1]).toEqual({ client: { fake: 'client' } });
    expect(rolledBack).toBe(true);
    expect(rowsOf()[0]).toMatchObject({ id: 'rehearsed-id', status: 'rehearsed' });
  });

  it('without --file it refuses before touching the database', async () => {
    await run(['employee', 'create', '--country', 'MX']);
    expect((errors[0] as CliError).exitCode).toBe(ExitCode.USAGE);
    expect(createEmployee).not.toHaveBeenCalled();
  });

  it('the file cannot choose the entity, the tenant or the author', () => {
    for (const k of ['entity_id', 'tenant_id', 'created_by']) {
      expect(() => readEmployeeDraft(JSON.stringify({ ...DRAFT, [k]: 'x' }), {})).toThrow(/may not set/);
    }
  });

  it('refuses unknown fields, missing ones, a bad country, a bad date and a non-object', () => {
    const ok = { ...DRAFT, country_code: 'MX', hire_date: '2026-10-01' };
    expect(() => readEmployeeDraft(JSON.stringify({ ...ok, frist_name: 'A' }), {})).toThrow(/unknown fields: frist_name/);
    expect(() => readEmployeeDraft(JSON.stringify(DRAFT), {})).toThrow(/Missing hire_date, country_code/);
    expect(() => readEmployeeDraft(JSON.stringify({ ...ok, country_code: 'CA' }), {})).toThrow(/use MX or US/);
    expect(() => readEmployeeDraft(JSON.stringify({ ...ok, hire_date: '01/10/2026' }), {})).toThrow(/YYYY-MM-DD/);
    expect(() => readEmployeeDraft('[]', {})).toThrow(/ONE employee/);
    expect(() => readEmployeeDraft('{', {})).toThrow(/not valid JSON/);
    expect(readEmployeeDraft(JSON.stringify(ok), { paySchedule: 'PS1' })).toMatchObject({ pay_schedule_id: 'PS1' });
  });
});
