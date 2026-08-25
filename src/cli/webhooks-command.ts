import type { Command } from 'commander';
import { resolveEntity, bootstrapTenant } from '../ai/context.js';
import {
  issueWebhookToken,
  listWebhookTokens,
  disableWebhookToken,
  listDeliveries,
  WEBHOOK_SOURCE_KINDS,
  type WebhookSourceKind,
} from '../ai/webhooks/intake.js';

// ============================================================
// mnemosine webhooks (alias: ganchos)
// Management surface for inbound webhook tokens (item 22):
//   create      — issues a token and prints the RAW value ONCE
//   list        — names, kinds and last use (never tokens/hashes)
//   disable     — revokes a token by name
//   deliveries  — recent delivery log (status, drafts, suspicion)
// The raw token is never stored: only its sha256 hash lands in
// ai_webhook_tokens, so `create` is the only chance to copy it.
// ============================================================

export interface WebhooksPalette {
  dim: (s: string) => string;
  bold: (s: string) => string;
  cyan: (s: string) => string;
  yellow: (s: string) => string;
}

export interface WebhooksCommandDeps {
  palette: WebhooksPalette;
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
}

const fmtDate = (d: Date | null): string =>
  d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : 'never';

function parseSourceKind(value: string): WebhookSourceKind {
  const normalized = value.trim().toLowerCase() as WebhookSourceKind;
  if (!WEBHOOK_SOURCE_KINDS.includes(normalized)) {
    throw new Error(`Invalid --source "${value}". Use one of: ${WEBHOOK_SOURCE_KINDS.join(', ')}.`);
  }
  return normalized;
}

export function registerWebhooksCommand(program: Command, deps: WebhooksCommandDeps): void {
  const c = deps.palette;

  const webhooks = program
    .command('webhooks')
    .alias('ganchos')
    .description('Inbound webhook tokens: dedicated credentials that wake a restricted reader agent');

  webhooks
    .command('create <name>')
    .alias('crear')
    .description('Create a webhook token (the raw token is shown ONCE and never stored)')
    .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
    .option('-t, --tenant <id>', 'Tenant')
    .option('--source <kind>', `Source kind: ${WEBHOOK_SOURCE_KINDS.join(', ')}`, 'generic')
    .action(async (name: string, opts: { entity?: string; tenant?: string; source: string }) => {
      try {
        const sourceKind = parseSourceKind(opts.source);
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const createdBy = process.env.USER || process.env.USERNAME || 'cli';
        const issued = await issueWebhookToken(ctx, { name, sourceKind, createdBy });

        console.log('');
        console.log(c.bold(`Webhook token "${issued.token.name}" created (${sourceKind}).`));
        console.log('');
        console.log(`  Endpoint:  POST /v1/ai/webhooks/${issued.token.name}`);
        console.log(`  Header:    Authorization: Bearer ${c.cyan(issued.rawToken)}`);
        console.log('');
        console.log(
          c.yellow(
            '  SAVE THE TOKEN NOW. It is shown only this once: the database keeps only ' +
              'its hash and it cannot be recovered. If lost, disable this token and create a new one.'
          )
        );
        console.log('');
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });

  webhooks
    .command('list')
    .alias('listar')
    .description('List webhook tokens (names and usage — never token values)')
    .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
    .option('-t, --tenant <id>', 'Tenant')
    .option('--json', 'JSON output')
    .action(async (opts: { entity?: string; tenant?: string; json?: boolean }) => {
      try {
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const tokens = await listWebhookTokens(ctx);
        if (opts.json) {
          console.log(JSON.stringify(tokens, null, 2));
        } else {
          console.log('');
          if (tokens.length === 0) {
            console.log(c.dim('  No webhook tokens. Create one with `mnemosine webhooks create <name>`.'));
          } else {
            console.log(
              c.bold(`  ${'NAME'.padEnd(24)}${'SOURCE'.padEnd(20)}${'STATE'.padEnd(10)}LAST USED`)
            );
            for (const t of tokens) {
              const state = t.enabled ? 'enabled' : c.dim('disabled');
              console.log(
                `  ${t.name.padEnd(24)}${t.source_kind.padEnd(20)}${state.padEnd(10)}${fmtDate(t.last_used_at)}`
              );
            }
          }
          console.log('');
        }
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });

  webhooks
    .command('disable <name>')
    .alias('desactivar')
    .description('Disable a webhook token (deliveries with it start failing with 401)')
    .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
    .option('-t, --tenant <id>', 'Tenant')
    .action(async (name: string, opts: { entity?: string; tenant?: string }) => {
      try {
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const disabled = await disableWebhookToken(ctx, name);
        if (disabled) {
          console.log(`Webhook token "${name}" disabled.`);
          await deps.shutdown(0);
        } else {
          console.log(c.yellow(`No enabled webhook token named "${name}" in this entity.`));
          await deps.shutdown(1);
        }
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });

  webhooks
    .command('deliveries')
    .alias('entregas')
    .description('Recent inbound deliveries: status, drafts created and suspicion flags')
    .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
    .option('-t, --tenant <id>', 'Tenant')
    .option('-n, --limit <n>', 'Rows to show (1-200)', '20')
    .option('--json', 'JSON output')
    .action(async (opts: { entity?: string; tenant?: string; limit: string; json?: boolean }) => {
      try {
        const limit = Number.parseInt(opts.limit, 10);
        if (!Number.isFinite(limit) || limit < 1) {
          throw new Error(`Invalid --limit "${opts.limit}": use a positive number.`);
        }
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const rows = await listDeliveries(ctx, { limit });
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
        } else {
          console.log('');
          if (rows.length === 0) {
            console.log(c.dim('  No webhook deliveries recorded for this entity.'));
          } else {
            console.log(
              c.bold(
                `  ${'RECEIVED'.padEnd(18)}${'TOKEN'.padEnd(20)}${'STATUS'.padEnd(11)}${'DRAFTS'.padEnd(8)}DOCUMENT`
              )
            );
            for (const d of rows) {
              const suspicious = Array.isArray(d.suspicion) && d.suspicion.length > 0;
              const doc = d.document_key.length > 44 ? `${d.document_key.slice(0, 43)}…` : d.document_key;
              console.log(
                `  ${fmtDate(d.received_at).padEnd(18)}${d.token_name.padEnd(20)}` +
                  `${d.status.padEnd(11)}${String(d.drafts_created).padEnd(8)}${doc}` +
                  (suspicious ? ` ${c.yellow('[suspicious content]')}` : '')
              );
            }
          }
          console.log('');
        }
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });
}
