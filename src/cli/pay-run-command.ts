import { readFileSync } from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { InvalidArgumentError, type Command } from 'commander';
import { z } from 'zod';
import { bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { entityScope, type EntityScope } from '../database/scope.js';
import { PAY_RUN_TYPES } from '../database/enums.js';
import { conLlave, hashDeCarga, mirarLlave } from '../services/idempotency/idempotency-store.js';
import {
  approvePayRun,
  calculatePayRun,
  createPayRun,
  getPayRun,
  type EmployeePayInput,
  type PayRunSummary,
} from '../services/payroll/common/pay-run-service.js';
import { hallazgosQueBloquean } from '../services/payroll/common/employer-liability-service.js';
import type { ResultadoAcumulacion } from '../services/payroll/common/employer-liability-service.js';
import { ConflictError } from '../utils/errors.js';
import { t } from '../i18n/index.js';
import { confirmarConReintento, noEntendi } from './kernel/confirmacion.js';
import type { Palette } from './palette.js';
import {
  ExitCode,
  abortedByUser,
  blockedByState,
  declareRisk,
  exitCodeFor,
  gateMutation,
  legible,
  render,
  requireExplicitEntity,
  usageError,
  withContext,
  withOutput,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine pay-run · corrida — MNE-001-068 (#306, part 2/4)
//
// The run of a pay period from the terminal: create, calculate, approve. Each
// leaf calls the SAME service the REST routes call (pay-run-service.ts); none
// of them computes a peso. The nouns and verbs are the catalog rows
// (docs/cli-command-catalog.md, «Orquestación de la corrida»).
//
// - `create` writes a draft run over a pay period of the entity. The service
//   reads the period inside the entity scope, so a sibling's period is a 404.
// - `calculate` takes the per-employee inputs from a JSON file, the same shape
//   the REST body carries (`employee_inputs`). There is no input stage yet
//   (`pay-run input import` is its own row), and inventing a salary-to-period
//   rule here would be a second payroll engine.
// - `approve` is IRREVERSIBLE: it seals the totals and writes the employer
//   liability (IMSS, INFONAVIT, state payroll tax). Its dry run is the real
//   approval rolled back, so what it shows is what would be written. Posting
//   the run to the ledger is `pay-run post` (MNE-001-069), not this.
//
// Neither write is open to the agent: the kernel only lets it write into a
// review queue, and a pay run is not one.
// ============================================================

export interface PayRunCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
  /** Test seam: answers the confirmation of `pay-run approve`. */
  confirm?: (question: string) => Promise<boolean>;
}

interface CommonOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
}

const earningSchema = z
  .object({ earning_type: z.string().min(1), amount: z.number().finite() })
  .passthrough();
const deductionSchema = z
  .object({ deduction_type: z.string().min(1), is_pre_tax: z.boolean(), amount: z.number().finite() })
  .passthrough();
const employeeInputSchema = z
  .object({
    employee_id: z.string().uuid(),
    earnings: z.array(earningSchema).min(1),
    deductions: z.array(deductionSchema).optional(),
    hours_worked: z.number().finite().optional(),
  })
  .strict();
const inputsSchema = z.union([
  z.array(employeeInputSchema).min(1),
  z.object({ employee_inputs: z.array(employeeInputSchema).min(1) }).passthrough(),
]);

/**
 * The inputs of a calculation, read from the text of a file.
 *
 * Validated before anything is written: the service calculates employee by
 * employee, each in its own transaction, so a bad line in the middle leaves
 * the first half of the run written. A repeated employee is refused here for
 * the same reason, since the second paycheck would hit UNIQUE(pay_run_id,
 * employee_id) after the first one was already in.
 */
export function parseEmployeeInputs(text: string, path: string): EmployeePayInput[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw usageError({ key: 'payrun.file_invalid', params: { path, detail: (err as Error).message } });
  }
  const parsed = inputsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = `${issue.path.join('.') || '(root)'}: ${issue.message}`;
    throw usageError({ key: 'payrun.file_invalid', params: { path, detail } });
  }
  const inputs = (Array.isArray(parsed.data) ? parsed.data : parsed.data.employee_inputs) as EmployeePayInput[];
  const seen = new Set<string>();
  for (const i of inputs) {
    if (seen.has(i.employee_id)) {
      throw usageError({ key: 'payrun.file_duplicate_employee', params: { path, employee: i.employee_id } });
    }
    seen.add(i.employee_id);
  }
  return inputs;
}

/** The run as one printable row. */
export function payRunRow(r: PayRunSummary): Row {
  return {
    id: r.id,
    status: r.status,
    type: r.run_type,
    tax_year: r.tax_year_used,
    employees: r.employee_count,
    gross: r.total_gross,
    employee_taxes: r.total_employee_taxes,
    employer_taxes: r.total_employer_taxes,
    net_pay: r.total_net_pay,
    employer_cost: r.total_employer_cost,
  };
}

/** The employer liability an approval writes, one row per tax and period. */
export function liabilityRows(r: ResultadoAcumulacion): Row[] {
  return r.renglones.map((l) => ({
    tax_type: l.taxType,
    jurisdiction: l.jurisdiction,
    period: `${l.periodStart}..${l.periodEnd}`,
    amount: l.importe,
    due_date: l.fechaLimite,
    action: l.accion,
  }));
}

const RUN_NUMERIC = ['gross', 'employee_taxes', 'employer_taxes', 'net_pay', 'employer_cost'];

const EXAMPLES = {
  create: `
Examples:
  # A regular run over a pay period of the active entity.
  mnemosine pay-run create --period 3f0c2a1e-5b7d-4c89-a1e2-6d4f8b9c0a17
  # A year-end bonus run over the same period.
  mnemosine pay-run create --period 3f0c2a1e-5b7d-4c89-a1e2-6d4f8b9c0a17 --type bonus --json
`,
  calculate: `
Examples:
  # Gross to net for every employee in the file: [{"employee_id": "…",
  # "earnings": [{"earning_type": "salary", "amount": 7500}]}, …]
  mnemosine pay-run calculate 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d --file quincena-2026-07-1.json
`,
  approve: `
Examples:
  # ALWAYS this one first: the real approval, rolled back. It shows the employer
  # liability the approval would write and any blocking finding.
  mnemosine pay-run approve 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d --dry-run
  # The approval, with a key: a retry returns the recorded result.
  mnemosine pay-run approve 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d --yes --idempotency-key corrida-2026-07-1
`,
};

function runType(value: string): string {
  if (!(PAY_RUN_TYPES as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`expected one of ${PAY_RUN_TYPES.join(', ')}`);
  }
  return value;
}

/** A state refusal of the service is exit 5 (blocked by state), not 6 (key conflict). */
async function blockedOnConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ConflictError) throw blockedByState(err.message);
    throw err;
  }
}

export function registerPayRunCommand(program: Command, deps: PayRunCommandDeps): void {
  const p = deps.palette;
  const payRun = program
    .command('pay-run')
    .alias('corrida')
    .description('Payroll runs of a pay period: create, calculate gross to net, approve');

  const run = async (fn: () => Promise<ExitCodeValue | void>): Promise<void> => {
    try {
      const code = await fn();
      await deps.shutdown(code ?? 0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  /** A write names its entity; the tenant goes first because entity lookup runs under RLS. */
  const scopeForWrite = async (opts: CommonOpts): Promise<EntityScope> => {
    bootstrapTenant(opts.tenant);
    const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
    return entityScope(ctx.tenantId, ctx.entityId);
  };

  const ask = async (question: string): Promise<boolean> => {
    if (deps.confirm) return deps.confirm(question);
    if (!stdin.isTTY) return false;
    const rl = readline.createInterface({ input: stdin, output: stdout });
    try {
      const answer = await confirmarConReintento(
        (q) => rl.question(q).catch(() => null),
        p.cyan(`${question} [y/N] `)
      );
      if (answer.incomprendida !== undefined) process.stderr.write(`${noEntendi(answer.incomprendida)}\n`);
      return answer.si;
    } finally {
      rl.close();
    }
  };

  // ---- pay-run create ------------------------------------------------
  const create = payRun
    .command('create')
    .alias('crear')
    .description('Create a draft run over a pay period; the tax year is fixed from the period');
  withContext(create);
  withOutput(create);
  create
    .option('--period <id>', 'pay period of the active entity (its id)')
    .option('--type <type>', `run type: ${PAY_RUN_TYPES.join(' | ')}`, runType, 'regular');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'pay_runs (one draft row)' });
  create.addHelpText('after', EXAMPLES.create);
  create.action((opts: CommonOpts & { period?: string; type: string }) =>
    run(async () => {
      if (!opts.period) throw usageError({ key: 'payrun.create.period_required' });
      const scope = await scopeForWrite(opts);
      const reviewer = await resolveReviewer(scope.tenantId, opts.user);
      const id = await createPayRun(
        {
          tenant_id: scope.tenantId,
          pay_period_id: opts.period,
          run_type: opts.type as (typeof PAY_RUN_TYPES)[number],
          employee_inputs: [],
          created_by: reviewer.userId,
        },
        scope
      );
      render([payRunRow(await getPayRun(id, scope))], { ...opts, idField: 'id', numeric: RUN_NUMERIC });
      if (legible(opts)) process.stderr.write(p.dim(`  ${t('payrun.create.next', { id })}\n`));
    })
  );

  // ---- pay-run calculate ---------------------------------------------
  const calculate = payRun
    .command('calculate')
    .alias('calcular')
    .argument('<id>', 'pay run to calculate')
    .description('Calculate gross to net for each employee in the inputs file and total the run');
  withContext(calculate);
  withOutput(calculate);
  calculate.option('--file <path>', 'JSON with the employee inputs: an array, or {"employee_inputs": [...]}');
  declareRisk(calculate, {
    risk: 'escritura',
    agent: false,
    writes: 'paychecks with their earnings, deductions and taxes; pay_runs totals; NEVER journal_entries',
  });
  calculate.addHelpText('after', EXAMPLES.calculate);
  calculate.action((id: string, opts: CommonOpts & { file?: string }) =>
    run(async () => {
      if (!opts.file) throw usageError({ key: 'payrun.calculate.file_required' });
      let text: string;
      try {
        text = readFileSync(opts.file, 'utf8');
      } catch (err) {
        throw usageError({ key: 'payrun.file_invalid', params: { path: opts.file, detail: (err as Error).message } });
      }
      const inputs = parseEmployeeInputs(text, opts.file);
      const scope = await scopeForWrite(opts);
      const reviewer = await resolveReviewer(scope.tenantId, opts.user);
      const before = await getPayRun(id, scope);
      await blockedOnConflict(() =>
        calculatePayRun(
          id,
          {
            tenant_id: scope.tenantId,
            pay_period_id: before.pay_period_id,
            employee_inputs: inputs,
            created_by: reviewer.userId,
          },
          scope
        )
      );
      render([payRunRow(await getPayRun(id, scope))], { ...opts, idField: 'id', numeric: RUN_NUMERIC });
      if (legible(opts)) process.stderr.write(p.dim(`  ${t('payrun.calculate.next', { id })}\n`));
    })
  );

  // ---- pay-run approve -----------------------------------------------
  const approve = payRun
    .command('approve')
    .alias('aprobar')
    .argument('<id>', 'calculated pay run to approve')
    .description('Approve a calculated run, sealing its totals and writing the employer liability; irreversible');
  withContext(approve);
  withOutput(approve);
  declareRisk(approve, {
    risk: 'irreversible',
    agent: false,
    llave: { scope: 'pay-run approve' },
    writes:
      'pay_runs (status calculated → approved, approved_by/at); employer_tax_liabilities ' +
      '(IMSS, INFONAVIT and state payroll tax of the run); NEVER journal_entries',
  });
  approve.addHelpText('after', EXAMPLES.approve);
  approve.action(
    (
      id: string,
      opts: CommonOpts & { dryRun?: boolean; yes?: boolean; idempotencyKey?: string },
      cmd: Command
    ) =>
      run(async () => {
        const { dryRun } = gateMutation(cmd, opts as unknown as Record<string, unknown>);
        const scope = await scopeForWrite(opts);
        const reviewer = await resolveReviewer(scope.tenantId, opts.user);
        const runBefore = await getPayRun(id, scope);
        type Recorded = { result: ResultadoAcumulacion } & Record<string, unknown>;
        const key = { scope: 'pay-run approve', clave: opts.idempotencyKey, payloadHash: hashDeCarga(scope.entityId, id) };

        // The key is looked at BEFORE the rehearsal: a retry finds the run
        // already approved, and the rehearsal would refuse it instead of
        // returning the recorded result the key promises.
        const recorded = dryRun ? undefined : await mirarLlave<Recorded>({ tenantId: scope.tenantId }, key);
        let result: ResultadoAcumulacion;
        let repeated = recorded !== undefined;
        if (recorded !== undefined) {
          result = recorded.result;
        } else {
          result = await blockedOnConflict(() => approvePayRun(id, reviewer.userId, scope, { dryRun: true }));
        }
        if (!dryRun && !repeated) {
          if (opts.yes !== true) {
            const ok = await ask(
              t('payrun.approve.confirm', {
                id,
                employees: runBefore.employee_count,
                net: runBefore.total_net_pay,
              })
            );
            if (!ok) throw abortedByUser({ key: 'payrun.approve.aborted' });
          }
          const done = await conLlave<Recorded>(
            { tenantId: scope.tenantId, entityId: scope.entityId },
            key,
            async () => ({
              result: await blockedOnConflict(() => approvePayRun(id, reviewer.userId, scope)),
            })
          );
          result = done.resultado.result;
          repeated = done.repetido;
        }

        const blocking = hallazgosQueBloquean(result.hallazgos);
        const runAfter = await getPayRun(id, scope);
        if (!legible(opts)) {
          render(
            [
              {
                ...payRunRow(runAfter),
                dry_run: dryRun,
                repeated,
                liabilities: liabilityRows(result),
                findings: result.hallazgos.map((h) => ({ code: h.codigo, severity: h.severidad, message: h.mensaje })),
              },
            ],
            { ...opts, idField: 'id' }
          );
        } else {
          render(liabilityRows(result), { ...opts, idField: 'tax_type', numeric: ['amount'] });
          for (const h of result.hallazgos) process.stderr.write(p.yellow(`  ⚠ ${h.codigo}: ${h.mensaje}\n`));
          const done = dryRun ? 'payrun.approve.dry_run' : repeated ? 'payrun.approve.repeated' : 'payrun.approve.done';
          process.stderr.write(`${dryRun ? p.yellow('◑') : p.green('✔')} ${t(done, { id, status: runAfter.status })}\n`);
        }
        // Approved with a blocking finding is still approved, but a script
        // reading the exit code must not take it for a clean run; the dry run
        // exits with the code the approval would.
        return blocking.length > 0 ? ExitCode.VALIDATION : ExitCode.OK;
      })
  );
}
