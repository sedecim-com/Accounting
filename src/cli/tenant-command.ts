import type { Command } from 'commander';
import { inquilinoDeLaSesion } from '../ai/context.js';
import { createTenant, listTenants } from '../services/tenant/tenant-service.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  render,
  withOutput,
  withSelection,
  exitCodeFor,
  globalsOf,
  usageError,
  describeCommand,
  optionByKey,
  argumentByKey,
} from './kernel/index.js';
import { t, type TranslationKey } from '../i18n/index.js';

// ============================================================
// mnemosine tenant  (#326 · MNE-001-085)
//
// The firm as something an operator can create and see without SQL. Before
// this family a tenant appeared only as a side effect of the first
// `entity create`, and a second firm on the same installation meant writing
// the INSERT by hand.
//
// Neither leaf is the agent's. `public.tenants` sits outside RLS, so both see
// every firm of the installation, and an agent runs inside one of them.
// ============================================================

const EXAMPLES = {
  list: `
Examples:
  # Every firm of this installation; the one in session carries a *.
  mnemosine tenant list
`,
  create: `
Examples:
  # A second firm on the same installation; its id goes to --tenant afterwards.
  mnemosine tenant create "Despacho Alameda"
  # Name the handle yourself when the derived one is taken.
  mnemosine tenant create "Despacho Alameda" --subdomain alameda-norte --json
`,
};

/** The lifecycle states of a tenant (tenants.is_active). */
const TENANT_STATES = ['active', 'archived'] as const;

export interface TenantCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
}

interface ListOpts {
  format?: string;
  json?: boolean;
  fields?: string | boolean;
  quiet?: boolean;
  output?: string;
  limit?: number;
  offset?: number;
  all?: boolean;
  status?: string[];
}

export function registerTenantCommand(program: Command, deps: TenantCommandDeps): void {
  // The help of this family is rendered by key (#314):
  // help.tenant.<leaf>.{description,option.<flag>,argument.<name>}.
  const tenant = describeCommand(program.command('tenant').alias('despacho'), 'help.tenant.description');

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };

  // ---- tenant list -------------------------------------------------
  const list = describeCommand(tenant.command('list').alias('listar'), 'help.tenant.list.description');
  withOutput(withSelection(list));
  // Reads, but across every firm: not the agent's, which works inside one.
  declareRisk(list, { risk: 'lectura', agent: false });
  list.addHelpText('after', EXAMPLES.list);
  list.action((_opts: ListOpts, command: Command) =>
    run(async () => {
      const opts = globalsOf<ListOpts>(command);
      const inSession = inquilinoDeLaSesion().tenantId;
      const wanted = opts.status?.map((s) => s.toLowerCase());
      // An unknown state would filter everything out and exit 0 with an empty
      // list, indistinguishable from "this installation has no such firm".
      const unknown = wanted?.filter((s) => !(TENANT_STATES as readonly string[]).includes(s)) ?? [];
      if (unknown.length > 0) {
        throw usageError({ key: 'platform.lifecycle.status_unknown', params: { unknown: unknown.join(', '), kind: 'tenant', first: TENANT_STATES[0], second: TENANT_STATES[1] } });
      }
      const all = (await listTenants())
        .map((t) => ({
          id: t.id,
          name: t.name,
          subdomain: t.subdomain,
          plan: t.plan,
          status: t.is_active ? 'active' : 'archived',
          // Not `active`: next to the lifecycle `status` it read as a contradiction.
          current: t.id === inSession ? '*' : '',
        }))
        .filter((t) => !wanted || wanted.includes(t.status));
      const offset = opts.offset ?? 0;
      const limit = opts.all ? all.length : (opts.limit ?? all.length);
      const rows = all.slice(offset, offset + limit);
      render(rows, { ...opts, total: all.length, idField: 'id' });
    })
  );

  // ---- tenant create -----------------------------------------------
  const create = describeCommand(
    argumentByKey(tenant.command('create').alias('crear'), '<name>', 'help.tenant.create.argument.name'),
    'help.tenant.create.description'
  );
  optionByKey(create, '--subdomain <handle>', 'help.tenant.create.option.subdomain');
  optionByKey(create, '--json', 'help.tenant.create.option.json');
  // Bringing a firm into existence is an operator's decision, never the agent's.
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'tenants, users (system account), audit_log' });
  create.addHelpText('after', EXAMPLES.create);
  create.action((name: string, _opts: unknown, command: Command) =>
    run(async () => {
      const opts = globalsOf<{ subdomain?: string; json?: boolean }>(command);
      const result = await createTenant({ name, subdomain: opts.subdomain });
      if (opts.json) {
        render([{ ...result }], { json: true });
        return;
      }
      const p = deps.palette;
      process.stdout.write(`${p.green('✔')} ${p.bold(result.name)} ${p.dim(`(${result.subdomain})`)}\n`);
      // The label column pads to the longest label of the language, plus two.
      const width = Math.max(...(['platform.label.tenant', 'platform.label.next'] as const).map((k) => t(k).length)) + 2;
      const label = (k: TranslationKey) => t(k).padEnd(width);
      process.stderr.write(p.dim(`  ${label('platform.label.tenant')}${result.tenantId}\n`));
      process.stderr.write(p.dim(`  ${label('platform.label.next')}mnemosine entity create <name> --tax-id <rfc> -t ${result.tenantId}\n`));
    })
  );
}
