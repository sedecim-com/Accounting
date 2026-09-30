import type { Command } from 'commander';
import { bootstrapTenant } from '../ai/context.js';
import { resolveAccount } from '../services/accounting/account-service.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { ValidationError } from '../utils/errors.js';
import {
  RULE_TYPES,
  createProcessingRule,
  listProcessingRules,
  parseRuleAction,
  parseRuleCondition,
  validateProcessingRule,
} from '../services/xml-ingestion/processing-rules.js';
import type { RuleActions, RuleCondition } from '../services/xml-ingestion/rules-engine.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withContext,
  withOutput,
  withSelection,
  requireExplicitEntity,
  resolveActiveEntity,
  usageError,
  describeCommand,
  optionByKey,
} from './kernel/index.js';

// ============================================================
// mnemosine bill rule — ING-2 · #319 (MNE-001-032)
//
// The firm's processing rules, until now only reachable through REST. A rule
// is the firm's criterion: it can code a CFDI and even send it straight to the
// ledger (`set_processing_mode=auto`) on the next ingest, so creating one is
// a write the agent may not invoke. Deleting and editing stay out of this
// slice (the /confirmar of 2026-09-27 leaves them to another task).
// ============================================================

export interface BillRuleDeps {
  palette: Palette;
  home?: string;
  run: (fn: () => Promise<void>) => Promise<void>;
}

interface RuleOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  json?: boolean;
  format?: string;
  output?: string;
  fields?: string | boolean;
  quiet?: boolean;
  type?: string;
  limit?: number;
  offset?: number;
  all?: boolean;
  status?: string[];
}

const EXAMPLES = {
  create: `
Examples:
  # Every CFDI from this vendor goes to 6100 and posts on ingest, with no model.
  mnemosine bill rule create --name "Consultoria SIN" --when "emisor_rfc equals SIN060101AB1" --then set_account=6100 --then set_processing_mode=auto
  # Code it, but hold it for an approval above 50 000.
  mnemosine bill rule create --name "Consultoria alta" --when "emisor_rfc equals SIN060101AB1" --when "total_amount greater_than 50000" --then set_account=6100 --then require_approval=true
`,
  list: `
Examples:
  # The rules in the order the engine evaluates them, and how often each fired.
  mnemosine bill rule list
  mnemosine bill rule list --type account_mapping --json
`,
} as const;

const describeCondition = (c: RuleCondition): string =>
  `${c.field} ${c.operator}${c.value === null ? '' : ` ${Array.isArray(c.value) ? c.value.join(',') : typeof c.value === 'string' ? c.value : JSON.stringify(c.value)}`}`;

/** One row of `bill rule list`: the rule as the person wrote it, the account by its code. */
export function summarizeRule(row: Record<string, unknown>): Record<string, unknown> {
  const conditions = (row.conditions ?? {}) as { all?: RuleCondition[]; any?: RuleCondition[] };
  const actions = { ...((row.actions ?? {}) as Record<string, unknown>) };
  if (actions.set_account && row.set_account_code) actions.set_account = row.set_account_code;
  return {
    priority: row.priority,
    name: row.rule_name,
    type: row.rule_type,
    when: [
      ...(conditions.all ?? []).map(describeCondition),
      ...(conditions.any ?? []).map((c) => `any: ${describeCondition(c)}`),
    ].join(' and '),
    then: Object.entries(actions).map(([k, v]) => `${k}=${String(v)}`).join(' '),
    active: row.is_active,
    matched: row.times_matched ?? 0,
    last_matched: row.last_matched_at ?? '',
    id: row.id,
  };
}

export function registerBillRuleCommands(bill: Command, deps: BillRuleDeps): void {
  // The help of these leaves is rendered by key (#314):
  // help.bill.rule.<leaf>.{description,option.<flag>}.
  const rule = describeCommand(bill.command('rule').alias('regla'), 'help.bill.rule.description');

  // ---- bill rule create -------------------------------------------
  const create = describeCommand(rule.command('create').alias('crear'), 'help.bill.rule.create.description');
  withContext(create);
  optionByKey(create, '--name <text>', 'help.bill.rule.create.option.name', { mandatory: true });
  optionByKey(create, '--when <condition...>', 'help.bill.rule.create.option.when');
  optionByKey(create, '--then <action...>', 'help.bill.rule.create.option.then');
  optionByKey(create, '--type <type>', 'help.bill.rule.create.option.type', {
    params: { types: RULE_TYPES.join(', ') },
    defaultValue: 'account_mapping',
  });
  optionByKey(create, '--priority <n>', 'help.bill.rule.create.option.priority', { defaultValue: '100' });
  optionByKey(create, '--description <text>', 'help.bill.rule.create.option.description');
  optionByKey(create, '--dry-run', 'help.bill.rule.create.option.dry_run');
  optionByKey(create, '--json', 'help.bill.rule.create.option.json');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'processing_rules' });
  create.addHelpText('after', EXAMPLES.create);
  create.action(
    (opts: RuleOpts & {
      name: string; when?: string[]; then?: string[]; priority: string; description?: string; dryRun?: boolean;
    }) =>
      deps.run(async () => {
        bootstrapTenant(opts.tenant);
        const ctx = await requireExplicitEntity({ entity: opts.entity }, { home: deps.home });
        // A rule with no condition matches every CFDI of the entity.
        if (!opts.when?.length) throw usageError('A rule needs at least one --when "<field> <operator> <value>".');
        if (!opts.then?.length) throw usageError('A rule needs at least one --then "<action>=<value>".');
        const priority = Number(opts.priority);
        if (!Number.isInteger(priority)) throw usageError(`--priority must be an integer; got "${opts.priority}".`);

        const all = opts.when.map(parseRuleCondition);
        const actions: RuleActions = Object.assign({}, ...opts.then.map(parseRuleAction)) as RuleActions;
        if (actions.set_account) {
          // An account of another entity, a header or an inactive one would
          // only fail later, at posting time, on every CFDI the rule caught.
          const account = await resolveAccount(ctx.entityId, actions.set_account);
          if (account.is_header || !account.is_active) {
            throw new ValidationError(`Account ${account.code} is not postable (header or inactive).`, 'set_account');
          }
          actions.set_account = account.id;
        }
        const input = validateProcessingRule({
          rule_name: opts.name, rule_type: opts.type, priority, description: opts.description,
          conditions: { all }, actions,
        });

        if (opts.dryRun) {
          process.stdout.write(`${JSON.stringify(input, null, 2)}\n`);
          process.stderr.write(deps.palette.dim('  Dry run: nothing written.\n'));
          return;
        }
        const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
        const created = await createProcessingRule(ctx.entityId, reviewer.userId, input);
        if (opts.json) {
          render([created], { json: true });
          return;
        }
        process.stdout.write(
          `${deps.palette.green('✔')} rule ${deps.palette.bold(String(created.rule_name))} ` +
            deps.palette.dim(`· priority ${String(created.priority)} · ${String(created.id)}`) + '\n'
        );
        process.stderr.write(deps.palette.dim('  The next `mnemosine ingest` applies it.\n'));
      })
  );

  // ---- bill rule list ---------------------------------------------
  const list = describeCommand(rule.command('list').alias('listar'), 'help.bill.rule.list.description');
  withOutput(withSelection(withContext(list)));
  optionByKey(list, '--type <type>', 'help.bill.rule.list.option.type', { params: { types: RULE_TYPES.join(', ') } });
  declareRisk(list, { risk: 'lectura', agent: true });
  list.addHelpText('after', EXAMPLES.list);
  list.action((opts: RuleOpts) =>
    deps.run(async () => {
      bootstrapTenant(opts.tenant);
      const { ctx } = await resolveActiveEntity(
        { entity: opts.entity },
        { home: deps.home, warn: (m) => process.stderr.write(deps.palette.yellow(`${m}\n`)) }
      );
      if (opts.type && !(RULE_TYPES as readonly string[]).includes(opts.type)) {
        throw usageError(`--type is one of ${RULE_TYPES.join(', ')}; got "${opts.type}".`);
      }
      // --status is active or inactive: a rule has no other state.
      const status = [...new Set(opts.status ?? [])];
      if (status.some((st) => st !== 'active' && st !== 'inactive')) {
        throw usageError(`--status is active or inactive; got "${status.join(',')}".`);
      }
      const { rows, total } = await listProcessingRules(ctx.entityId, {
        ruleType: opts.type,
        active: status.length === 1 ? status[0] === 'active' : undefined,
        limit: opts.all ? undefined : (opts.limit ?? 50),
        offset: opts.offset,
      });
      render(rows.map(summarizeRule), { ...opts, total, idField: 'id' });
    })
  );
}
