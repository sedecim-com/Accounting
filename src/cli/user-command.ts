import type { Command } from 'commander';
import { inquilinoDeLaSesion } from '../ai/context.js';
import { archiveUser, createUser, listUsers, resolveUserTenant } from '../services/user/user-service.js';
import type { Palette } from './palette.js';
import {
  declareRisk,
  gateMutation,
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

// ============================================================
// mnemosine user  (#326 · MNE-001-086)
//
// The logins of a firm, managed without a terminal. The wizard
// (`init --section users`) reads the password with hidden echo, so a script
// could not create a user at all.
//
// SECURITY: there is no `--password <value>` and there never will be: argv is
// visible to every local account in `ps` and lands in shell history. The
// password comes from stdin (`--password-stdin`), from MNEMOSINE_USER_PASSWORD,
// or, on a real terminal, from a prompt with echo off. It is never printed.
//
// No leaf is the agent's: a login is an access decision, which is a person's.
// ============================================================

/** The variable a provisioning script sets instead of piping the password. */
export const PASSWORD_ENV = 'MNEMOSINE_USER_PASSWORD';

const EXAMPLES = {
  list: `
Examples:
  mnemosine user list
  mnemosine user list --status archived --json
`,
  create: `
Examples:
  # From a script, the password piped on stdin: printf '%s' "$PASSWORD" | …
  mnemosine user create --email ana@example.com --role contador --password-stdin
  # Or with MNEMOSINE_USER_PASSWORD set in the environment.
  mnemosine user create --email ana@example.com --role viewer
`,
  archive: `
Examples:
  mnemosine user archive ana@example.com --reason "left the firm"
`,
};

const USER_STATES = ['active', 'archived'] as const;

export interface UserCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<void> | void;
  reportError: (err: unknown) => void;
  /**
   * Hidden-echo prompt for a real terminal; injectable for tests. It must
   * write to stderr, so `--json` on stdout stays parseable.
   */
  readSecret: (prompt: string) => Promise<string | null>;
  stdin?: NodeJS.ReadableStream & { isTTY?: boolean };
  env?: NodeJS.ProcessEnv;
}

/** Everything piped in, minus the one line ending `echo` or a heredoc adds. */
async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/, '');
}

/**
 * The password, from exactly one source. Two sources at once is refused
 * rather than resolved by precedence: the operator meant one of them and we
 * cannot know which.
 */
export async function readPassword(opts: { passwordStdin?: boolean }, deps: UserCommandDeps): Promise<string> {
  const env = deps.env ?? process.env;
  const stdin = deps.stdin ?? process.stdin;
  const fromEnv = env[PASSWORD_ENV];
  if (opts.passwordStdin && fromEnv !== undefined) {
    throw usageError(`--password-stdin and ${PASSWORD_ENV} are both set; use one.`);
  }
  if (opts.passwordStdin) {
    // On a terminal, reading stdin in cooked mode echoes every character
    // typed (#326). --password-stdin is the script's door; a person at a
    // terminal gets the hidden prompt by leaving the flag out.
    if (stdin.isTTY) {
      throw usageError('--password-stdin expects a pipe; run without it on a terminal for a hidden prompt.');
    }
    return readAll(stdin);
  }
  if (fromEnv !== undefined) {
    // Not inherited by anything this process spawns afterwards.
    delete env[PASSWORD_ENV];
    return fromEnv;
  }
  if (stdin.isTTY) {
    const typed = await deps.readSecret('  Password: ');
    if (typed === null) throw usageError('Cancelled; nothing was created.');
    return typed;
  }
  throw usageError(
    `No password: pipe it with --password-stdin or set ${PASSWORD_ENV}. ` +
      'It is never accepted as an argument, where ps would show it.'
  );
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

export function registerUserCommand(program: Command, deps: UserCommandDeps): void {
  // Help by key (#314): help.user.<leaf>.{description,option.<flag>,argument.<name>}.
  const user = describeCommand(program.command('user').alias('usuario'), 'help.user.description');

  const run = async (fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      await deps.shutdown(0);
    } catch (err) {
      deps.reportError(err);
      await deps.shutdown(exitCodeFor(err));
    }
  };
  const tenant = (): Promise<string> => resolveUserTenant(inquilinoDeLaSesion().tenantId);
  // Every leaf acts on ONE firm; the preAction hook reads -t into the session.
  const scoped = (cmd: Command): Command => optionByKey(cmd, '-t, --tenant <id>', 'cli.flag.tenant_scope');

  // ---- user list ---------------------------------------------------
  const list = describeCommand(user.command('list').alias('listar'), 'help.user.list.description');
  withOutput(withSelection(scoped(list)));
  // Emails of the firm's staff are not the agent's to read.
  declareRisk(list, { risk: 'lectura', agent: false });
  list.addHelpText('after', EXAMPLES.list);
  list.action((_opts: ListOpts, command: Command) =>
    run(async () => {
      const opts = globalsOf<ListOpts>(command);
      const wanted = opts.status?.map((s) => s.toLowerCase());
      const unknown = wanted?.filter((s) => !(USER_STATES as readonly string[]).includes(s)) ?? [];
      if (unknown.length > 0) {
        throw usageError(`--status ${unknown.join(', ')}: a user is either ${USER_STATES.join(' or ')}.`);
      }
      const all = (await listUsers(await tenant()))
        .map((u) => ({
          id: u.id,
          email: u.email,
          roles: u.roles.join(', '),
          status: u.is_active ? 'active' : 'archived',
          last_login_at: u.last_login_at,
        }))
        .filter((u) => !wanted || wanted.includes(u.status));
      const offset = opts.offset ?? 0;
      const limit = opts.all ? all.length : (opts.limit ?? all.length);
      render(all.slice(offset, offset + limit), { ...opts, total: all.length, idField: 'id' });
    })
  );

  // ---- user create -------------------------------------------------
  const create = describeCommand(user.command('create').alias('crear'), 'help.user.create.description');
  scoped(create);
  optionByKey(create, '--email <address>', 'help.user.create.option.email');
  optionByKey(create, '--role <name>', 'help.user.create.option.role');
  optionByKey(create, '--password-stdin', 'help.user.create.option.password_stdin');
  optionByKey(create, '--json', 'help.user.create.option.json');
  declareRisk(create, { risk: 'escritura', agent: false, writes: 'users, audit_log' });
  create.addHelpText('after', EXAMPLES.create);
  create.action((_opts: unknown, command: Command) =>
    run(async () => {
      const opts = globalsOf<{ email?: string; role?: string; passwordStdin?: boolean; json?: boolean }>(command);
      if (!opts.email) throw usageError('--email is required.');
      if (!opts.role) throw usageError('--role is required: a login never gets a role by default.');
      const tenantId = await tenant();
      const password = await readPassword(opts, deps);
      const result = await createUser({ tenantId, email: opts.email, role: opts.role, password });
      if (opts.json) {
        render([{ ...result, tenantId }], { json: true });
        return;
      }
      const p = deps.palette;
      process.stdout.write(`${p.green('✔')} ${p.bold(result.email)} ${p.dim(`(${result.role})`)}\n`);
    })
  );

  // ---- user archive ------------------------------------------------
  // `archive`, as the catalog names it (R4: the same operation as entity
  // archive, is_active = false). `disable` is the word of #326 and stays an alias.
  const archive = describeCommand(
    argumentByKey(user.command('archive').aliases(['archivar', 'disable', 'desactivar']), '<email>', 'help.user.archive.argument.email'),
    'help.user.archive.description'
  );
  scoped(archive);
  // --reason is declareRisk's: archive is an undo verb, so the reason is required.
  declareRisk(archive, { risk: 'escritura', agent: false, writes: 'users.is_active, audit_log' });
  archive.addHelpText('after', EXAMPLES.archive);
  archive.action((email: string, _opts: unknown, command: Command) =>
    run(async () => {
      const opts = globalsOf<{ reason?: string }>(command);
      const { reason } = gateMutation(archive, opts);
      const result = await archiveUser({ tenantId: await tenant(), email, reason: reason ?? '' });
      process.stdout.write(`${deps.palette.green('✔')} ${result.email} archived.\n`);
    })
  );
}
