import type { Command } from 'commander';
import { inquilinoDeLaSesion } from '../ai/context.js';
import { createTenant, listTenants } from '../services/tenant/tenant-service.js';
import type { Palette } from './palette.js';
import { declareRisk, render, withOutput, withSelection, exitCodeFor, globalsOf } from './kernel/index.js';

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
  const tenant = program
    .command('tenant')
    .alias('despacho')
    .description('Create and list the firms (tenants) of this installation');

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
  const list = tenant
    .command('list')
    .alias('listar')
    .description('List the tenants of this installation, archived ones included');
  withOutput(withSelection(list));
  // Reads, but across every firm: not the agent's, which works inside one.
  declareRisk(list, { risk: 'lectura', agent: false });
  list.addHelpText('after', EXAMPLES.list);
  list.action((_opts: ListOpts, command: Command) =>
    run(async () => {
      const opts = globalsOf<ListOpts>(command);
      const active = inquilinoDeLaSesion().tenantId;
      const wanted = opts.status?.map((s) => s.toLowerCase());
      const all = (await listTenants())
        .map((t) => ({
          id: t.id,
          name: t.name,
          subdomain: t.subdomain,
          plan: t.plan,
          status: t.is_active ? 'active' : 'archived',
          active: t.id === active ? '*' : '',
        }))
        .filter((t) => !wanted || wanted.includes(t.status));
      const offset = opts.offset ?? 0;
      const limit = opts.all ? all.length : (opts.limit ?? all.length);
      const rows = all.slice(offset, offset + limit);
      render(rows, { ...opts, total: all.length, idField: 'id' });
    })
  );

  // ---- tenant create -----------------------------------------------
  const create = tenant
    .command('create')
    .alias('crear')
    .argument('<name>', 'name of the firm')
    .description('Create a tenant for a new firm, with its system account')
    .option('--subdomain <handle>', 'unique handle of the firm (derived from the name when omitted)')
    .option('--json', 'JSON output');
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
      process.stderr.write(p.dim(`  tenant  ${result.tenantId}\n`));
      process.stderr.write(
        p.dim(`  next    mnemosine entity create <name> --tax-id <rfc> -t ${result.tenantId}\n`)
      );
    })
  );
}
