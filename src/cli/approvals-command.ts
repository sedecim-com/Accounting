import type { Command } from 'commander';
import { resolveEntity, bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { FLOOR_MAX_AUTO_POST } from '../ai/floor.js';
import {
  grantApproval,
  revokeApproval,
  listApprovals,
  effectiveApprovalCap,
  type ApprovalMode,
  type ApprovalPattern,
  type ApprovalScope,
} from '../ai/approval-policy.js';

// ============================================================
// mnemosine approvals — graduated approval policies
// list / grant / revoke of pattern-based pre-authorizations for
// staged writes (drafts and outbox operations). Matching stays
// conservative and the FLOOR always wins (src/ai/floor.ts):
// no policy granted here can authorize above FLOOR_MAX_AUTO_POST.
// ============================================================

const SCOPES: ApprovalScope[] = ['draft', 'external_op'];
const MODES: ApprovalMode[] = ['once', 'session', 'always'];

export interface ApprovalsDeps {
  palette: { dim: (s: string) => string; bold: (s: string) => string; cyan: (s: string) => string };
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
}

function parseScope(value: string): ApprovalScope {
  if ((SCOPES as string[]).includes(value)) return value as ApprovalScope;
  throw new Error(`Invalid --scope "${value}"; expected one of: ${SCOPES.join(', ')}`);
}

function parseMode(value: string): ApprovalMode {
  if ((MODES as string[]).includes(value)) return value as ApprovalMode;
  throw new Error(`Invalid --mode "${value}"; expected one of: ${MODES.join(', ')}`);
}

interface GrantOpts {
  entity?: string;
  tenant?: string;
  scope: string;
  mode: string;
  kind?: string;
  maxAmount?: string;
  provider?: string;
  operation?: string;
  session?: string;
  user?: string;
}

function buildPattern(opts: GrantOpts): ApprovalPattern {
  const pattern: ApprovalPattern = {};
  if (opts.kind !== undefined) pattern.kind = opts.kind;
  if (opts.maxAmount !== undefined) pattern.max_amount = opts.maxAmount;
  if (opts.provider !== undefined) pattern.provider = opts.provider;
  if (opts.operation !== undefined) pattern.operation = opts.operation;
  if (Object.keys(pattern).length === 0) {
    throw new Error(
      'The pattern is empty; specify at least one of --kind, --max-amount, --provider, --operation'
    );
  }
  return pattern;
}

export function registerApprovalsCommand(program: Command, deps: ApprovalsDeps): void {
  const c = deps.palette;
  const approvals = program
    .command('approvals')
    .alias('aprobaciones')
    .description('Graduated approval policies for staged writes (once / session / always)');

  approvals
    .command('list')
    .description('List approval policies of the entity')
    .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
    .option('-t, --tenant <id>', 'Tenant')
    .option('--scope <scope>', `Filter by scope (${SCOPES.join(' | ')})`)
    .option('--all', 'Include revoked policies')
    .option('--json', 'JSON output')
    .action(async (opts: { entity?: string; tenant?: string; scope?: string; all?: boolean; json?: boolean }) => {
      try {
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const rows = await listApprovals(ctx, {
          scope: opts.scope !== undefined ? parseScope(opts.scope) : undefined,
          includeRevoked: opts.all === true,
        });
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
        } else if (rows.length === 0) {
          console.log(c.dim('No approval policies.'));
        } else {
          for (const row of rows) {
            const state = row.revoked_at ? 'revoked' : 'active';
            console.log(
              `${c.cyan(row.id)}  ${c.bold(row.scope)}  ${row.mode.padEnd(7)}  ${state.padEnd(7)}  ` +
                `${JSON.stringify(row.pattern)}  ${c.dim(`by ${row.created_by}`)}` +
                (row.last_used_at ? c.dim(`  last used ${new Date(row.last_used_at).toISOString()}`) : '')
            );
          }
        }
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });

  approvals
    .command('grant')
    .description('Grant a pattern-based approval policy (conservative matching; the floor always wins)')
    .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
    .option('-t, --tenant <id>', 'Tenant')
    .requiredOption('--scope <scope>', `Scope of the policy (${SCOPES.join(' | ')})`)
    .requiredOption('--mode <mode>', `Policy mode (${MODES.join(' | ')})`)
    .option(
      '--kind <kind>',
      "Match field: candidate kind. For drafts this is the draft payload's " +
        '"kind" (or "entry_type") field, falling back to "journal_entry" when ' +
        'absent — kinds in use today: journal_entry (default), payroll'
    )
    .option('--max-amount <amount>', 'Match field: maximum amount authorized (numeric string)')
    .option('--provider <provider>', 'Match field: external provider (e.g. contalink)')
    .option('--operation <operation>', 'Match field: external operation (e.g. create_policy)')
    .option('--session <id>', "Granting session id (required for --mode session)")
    .option('-u, --user <email>', 'Granting user (required when the tenant has several active users)')
    .action(async (opts: GrantOpts) => {
      try {
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const scope = parseScope(opts.scope);
        const mode = parseMode(opts.mode);
        const pattern = buildPattern(opts);
        const grantor = await resolveReviewer(ctx.tenantId, opts.user);

        const id = await grantApproval(ctx, {
          scope,
          pattern,
          mode,
          grantedBy: grantor.email,
          sessionId: opts.session,
        });

        console.log(`Approval policy granted: ${c.cyan(id)} (${scope}, ${mode})`);
        console.log(c.dim(`  pattern: ${JSON.stringify(pattern)}`));
        if (mode === 'always') {
          const cap = effectiveApprovalCap(
            pattern.max_amount !== undefined ? Number(pattern.max_amount) : undefined
          );
          console.log(
            c.bold(
              `Warning: an 'always' policy stays active until revoked. Amounts it can authorize ` +
                `are capped at ${cap.toLocaleString('en-US')} by the floor ` +
                `(FLOOR_MAX_AUTO_POST = ${FLOOR_MAX_AUTO_POST.toLocaleString('en-US')}); ` +
                `nothing can raise that limit.`
            )
          );
        }
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });

  approvals
    .command('revoke <id>')
    .description('Revoke an active approval policy')
    .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
    .option('-t, --tenant <id>', 'Tenant')
    .action(async (id: string, opts: { entity?: string; tenant?: string }) => {
      try {
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        await revokeApproval(ctx, id);
        console.log(`Approval policy ${c.cyan(id)} revoked.`);
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });
}
