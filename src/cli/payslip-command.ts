import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { entityScope, type EntityScope } from '../database/scope.js';
import { getEmployee } from '../services/payroll/common/employee-service.js';
import {
  PAYCHECK_CFDI_STATES,
  getPaycheck,
  listPaychecks,
  type PaycheckCfdiState,
  type PaycheckDetail,
} from '../services/payroll/common/paycheck-read-service.js';
import type { Palette } from './palette.js';
import { maskIdentifier } from './employee-show-command.js';
import {
  ExitCode,
  argumentByKey,
  declareRisk,
  describeCommand,
  exitCodeFor,
  legible,
  optionByKey,
  render,
  resolveActiveEntity,
  usageError,
  withContext,
  withOutput,
  withSelection,
  type ExitCodeValue,
  type Row,
} from './kernel/index.js';

// ============================================================
// mnemosine payslip · recibo — MNE-001-070 (#306, part 4/4)
//
//   payslip list --run <id> · recibo listar — the paychecks of a run
//   payslip show <id>       · recibo ver    — one paycheck with its lines
//
// Both read through paycheck-read-service.ts, the service behind GET
// /v1/payroll/paychecks/:id, with the entity predicate inside the SQL. The
// payroll CFDI (generate, stamp) is not here: it belongs to the stamping
// work (#92, #105).
//
// SECURITY: `show` prints ONE person's RFC, CURP and NSS masked to their last
// three characters, as `employee show` does; `--redacted` hides them entirely.
// `list` prints no identifier. Both are therefore open to the agent by what
// they materialize, not by the value of a flag (registry §6.11).
// ============================================================

export interface PayslipCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  home?: string;
}

interface PayslipOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  run?: string;
  redacted?: boolean;
  limit?: number;
  offset?: number;
  status?: string[];
  all?: boolean;
}

/**
 * `--status` filters by stamp state; none given, or `--all`, means every
 * paycheck of the run (a run is read whole by default, unlike the roll).
 */
export function paycheckStatusFilter(opts: { status?: string[]; all?: boolean }): PaycheckCfdiState[] {
  if (opts.all) return [];
  const states = (opts.status ?? []).flatMap((s) => s.split(',')).map((s) => s.trim().toLowerCase());
  const unknown = states.filter((s) => !(PAYCHECK_CFDI_STATES as readonly string[]).includes(s));
  if (unknown.length > 0) {
    throw usageError({
      key: 'payslip.status_invalid',
      params: { status: unknown.join(', '), states: PAYCHECK_CFDI_STATES.join(', ') },
    });
  }
  return states as PaycheckCfdiState[];
}

/** Every line of the paycheck in one table: earnings, deductions, taxes. */
export function payslipLines(pc: PaycheckDetail): Row[] {
  const text = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
  return [
    ...pc.earnings.map((l) => ({
      kind: 'earning', concept: text(l.earning_type), amount: text(l.amount), side: '', base: '',
    })),
    ...pc.deductions.map((l) => ({
      kind: 'deduction', concept: text(l.deduction_type), amount: text(l.amount), side: '', base: '',
    })),
    ...pc.taxes.map((l) => ({
      kind: 'tax', concept: text(l.tax_type), amount: text(l.tax_amount),
      side: text(l.employee_employer), base: text(l.taxable_wages),
    })),
  ];
}

/** The paycheck's header: who, and the totals from gross to net. */
export function payslipHeader(pc: PaycheckDetail, e: Record<string, unknown>, redacted: boolean): Row {
  return {
    id: pc.id,
    employee: e.employee_number,
    name: [e.first_name, e.last_name, e.second_last_name].filter(Boolean).join(' '),
    rfc: maskIdentifier(e.rfc, redacted),
    curp: maskIdentifier(e.curp, redacted),
    nss: maskIdentifier(e.nss, redacted),
    gross: pc.gross_earnings,
    isr_withheld: pc.isr_withheld,
    subsidy_in_cash: pc.subsidio_entregado_efectivo ?? '',
    imss_employee: pc.imss_employee,
    infonavit_withheld: pc.infonavit_withheld,
    net_pay: pc.net_pay,
    imss_employer: pc.imss_employer,
    infonavit_employer: pc.infonavit_employer,
    cfdi_status: pc.cfdi_status ?? '',
  };
}

const LIST_EXAMPLES = `
Examples:
  # The paychecks of a run, by employee number; no tax identifier is printed.
  mnemosine payslip list --run 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d
  # Only the paychecks whose CFDI is still to stamp, twenty at a time.
  mnemosine payslip list --run 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d --status pending -n 20
  # As JSON, to pick the id of one paycheck.
  mnemosine payslip list --run 9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d --json
`;

const SHOW_EXAMPLES = `
Examples:
  # One paycheck: the totals, then every earning, deduction and tax line.
  mnemosine payslip show 5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b
  # For a shared screen: RFC, CURP and NSS hidden entirely.
  mnemosine payslip show 5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b --redacted
`;

export function registerPayslipCommand(program: Command, deps: PayslipCommandDeps): void {
  const run = async (fn: () => Promise<ExitCodeValue>): Promise<void> => {
    try {
      await deps.shutdown(await fn());
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };
  // Tenant FIRST: entity resolution is itself bounded by RLS.
  const scopeFor = async (opts: PayslipOpts): Promise<EntityScope> => {
    bootstrapTenant(opts.tenant);
    const { ctx } = await resolveActiveEntity({ entity: opts.entity }, { home: deps.home });
    return entityScope(ctx.tenantId, ctx.entityId);
  };

  const payslip = describeCommand(program.command('payslip').alias('recibo'), 'help.payslip.description');

  const list = describeCommand(payslip.command('list').alias('listar'), 'help.payslip.list.description');
  withOutput(withSelection(withContext(list)));
  optionByKey(list, '--run <id>', 'help.payslip.list.option.run');
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', LIST_EXAMPLES);
  list.action((opts: PayslipOpts) =>
    run(async () => {
      if (!opts.run) throw usageError({ key: 'payslip.run_required' });
      const cfdiStatus = paycheckStatusFilter(opts);
      const rows = await listPaychecks(opts.run, await scopeFor(opts), {
        limit: opts.limit,
        offset: opts.offset,
        cfdiStatus,
      });
      render(
        rows.map((r) => ({
          employee: r.employee_number, name: r.employee_name, gross: r.gross_earnings, net_pay: r.net_pay,
          payment_method: r.payment_method ?? '', cfdi_status: r.cfdi_status ?? '', id: r.id,
        })),
        { ...opts, idField: 'id', numeric: ['gross', 'net_pay'] }
      );
      return ExitCode.OK;
    })
  );

  const show = describeCommand(
    argumentByKey(payslip.command('show').alias('ver'), '<id>', 'help.payslip.show.argument.id'),
    'help.payslip.show.description'
  );
  withOutput(withContext(show));
  optionByKey(show, '--redacted', 'help.payslip.show.option.redacted');
  declareRisk(show, { risk: 'lectura', agent: true });
  show.addHelpText('after', SHOW_EXAMPLES);
  show.action((id: string, opts: PayslipOpts) =>
    run(async () => {
      const scope = await scopeFor(opts);
      const pc = await getPaycheck(id, scope);
      const header = payslipHeader(pc, await getEmployee(pc.employee_id, scope), opts.redacted === true);
      if (!legible(opts)) {
        render([{ ...header, lines: payslipLines(pc) }], { ...opts, idField: 'id' });
        return ExitCode.OK;
      }
      render([header], { ...opts, idField: 'id' });
      render(payslipLines(pc), { ...opts, idField: 'concept', numeric: ['amount', 'base'] });
      return ExitCode.OK;
    })
  );
}
