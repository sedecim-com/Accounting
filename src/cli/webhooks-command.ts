import type { Command } from 'commander';
import { resolveEntity, bootstrapTenant } from '../ai/context.js';
import { calendarDateTimeIn } from '../utils/calendar-date.js';
import { zoneFor } from '../services/policy/today.js';
import {
  issueWebhookToken,
  listWebhookTokens,
  disableWebhookToken,
  listDeliveries,
  WEBHOOK_SOURCE_KINDS,
  type WebhookSourceKind,
} from '../ai/webhooks/intake.js';
import { describeCommand, exitCodeFor, optionByKey, usageError, ExitCode } from './kernel/index.js';
import { t, type TranslationKey } from '../i18n/index.js';

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

const fmtDate = (d: Date | null, zone: string): string => (d ? calendarDateTimeIn(zone, d) : t('platform.webhooks.never'));

/** A column as wide as the English one, or as its label in the reader's language plus two. */
const column = (key: TranslationKey, width: number): number => Math.max(width, t(key).length + 2);

function parseSourceKind(value: string): WebhookSourceKind {
  const normalized = value.trim().toLowerCase() as WebhookSourceKind;
  if (!WEBHOOK_SOURCE_KINDS.includes(normalized)) {
    throw usageError({ key: 'platform.webhooks.source_invalid', params: { value, kinds: WEBHOOK_SOURCE_KINDS.join(', ') } });
  }
  return normalized;
}

export function registerWebhooksCommand(program: Command, deps: WebhooksCommandDeps): void {
  const c = deps.palette;

  const webhooks = describeCommand(program.command('webhooks').alias('ganchos'), 'help.webhooks.description');

  const create = describeCommand(webhooks.command('create <name>').alias('crear'), 'help.webhooks.create.description');
  optionByKey(create, '-e, --entity <idOrName>', 'help.webhooks.create.option.entity');
  optionByKey(create, '-t, --tenant <id>', 'help.webhooks.create.option.tenant');
  optionByKey(create, '--source <kind>', 'help.webhooks.create.option.source', {
    params: { kinds: WEBHOOK_SOURCE_KINDS.join(', ') },
    defaultValue: 'generic',
  });
  create.action(async (name: string, opts: { entity?: string; tenant?: string; source: string }) => {
      try {
        const sourceKind = parseSourceKind(opts.source);
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const createdBy = process.env.USER || process.env.USERNAME || 'cli';
        const issued = await issueWebhookToken(ctx, { name, sourceKind, createdBy });

        console.log('');
        console.log(c.bold(t('platform.webhooks.created', { name: issued.token.name, source: sourceKind })));
        console.log('');
        const width = Math.max(t('platform.label.endpoint').length, t('platform.label.header').length) + 2;
        console.log(`  ${t('platform.label.endpoint').padEnd(width)}POST /v1/ai/webhooks/${issued.token.name}`);
        console.log(`  ${t('platform.label.header').padEnd(width)}Authorization: Bearer ${c.cyan(issued.rawToken)}`);
        console.log('');
        console.log(c.yellow(`  ${t('platform.webhooks.save_token')}`));
        console.log('');
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });

  const list = describeCommand(webhooks.command('list').alias('listar'), 'help.webhooks.list.description');
  optionByKey(list, '-e, --entity <idOrName>', 'help.webhooks.list.option.entity');
  optionByKey(list, '-t, --tenant <id>', 'help.webhooks.list.option.tenant');
  optionByKey(list, '--json', 'help.webhooks.list.option.json');
  list.action(async (opts: { entity?: string; tenant?: string; json?: boolean }) => {
      try {
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const tokens = await listWebhookTokens(ctx);
        if (opts.json) {
          console.log(JSON.stringify(tokens, null, 2));
        } else {
          console.log('');
          if (tokens.length === 0) {
            console.log(c.dim(`  ${t('platform.webhooks.none')}`));
          } else {
            const [name, source, state] = [column('platform.webhooks.column.name', 24), column('platform.webhooks.column.source', 20), column('platform.webhooks.column.state', 10)];
            console.log(c.bold(`  ${t('platform.webhooks.column.name').padEnd(name)}${t('platform.webhooks.column.source').padEnd(source)}` +
              `${t('platform.webhooks.column.state').padEnd(state)}${t('platform.webhooks.column.last_used')}`));
            const zone = await zoneFor(ctx);
            for (const tok of tokens) {
              const label = t('platform.webhooks.state', { enabled: String(tok.enabled) });
              console.log(
                `  ${tok.name.padEnd(name)}${tok.source_kind.padEnd(source)}${(tok.enabled ? label : c.dim(label)).padEnd(state)}${fmtDate(tok.last_used_at, zone)}`
              );
            }
          }
          console.log('');
        }
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });

  const disable = describeCommand(webhooks.command('disable <name>').alias('desactivar'), 'help.webhooks.disable.description');
  optionByKey(disable, '-e, --entity <idOrName>', 'help.webhooks.disable.option.entity');
  optionByKey(disable, '-t, --tenant <id>', 'help.webhooks.disable.option.tenant');
  disable.action(async (name: string, opts: { entity?: string; tenant?: string }) => {
      try {
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const disabled = await disableWebhookToken(ctx, name);
        if (disabled) {
          console.log(t('platform.webhooks.disabled', { name }));
          await deps.shutdown(0);
        } else {
          console.log(c.yellow(t('platform.webhooks.not_found', { name })));
          await deps.shutdown(ExitCode.NOT_FOUND);
        }
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });

  const deliveries = describeCommand(webhooks.command('deliveries').alias('entregas'), 'help.webhooks.deliveries.description');
  optionByKey(deliveries, '-e, --entity <idOrName>', 'help.webhooks.deliveries.option.entity');
  optionByKey(deliveries, '-t, --tenant <id>', 'help.webhooks.deliveries.option.tenant');
  optionByKey(deliveries, '-n, --limit <n>', 'help.webhooks.deliveries.option.limit', { defaultValue: '20' });
  optionByKey(deliveries, '--json', 'help.webhooks.deliveries.option.json');
  deliveries.action(async (opts: { entity?: string; tenant?: string; limit: string; json?: boolean }) => {
      try {
        const limit = Number.parseInt(opts.limit, 10);
        if (!Number.isFinite(limit) || limit < 1) {
          throw usageError({ key: 'platform.limit_invalid', params: { limit: opts.limit } });
        }
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const rows = await listDeliveries(ctx, { limit });
        if (opts.json) {
          console.log(JSON.stringify(rows, null, 2));
        } else {
          console.log('');
          if (rows.length === 0) {
            console.log(c.dim(`  ${t('platform.webhooks.no_deliveries')}`));
          } else {
            // TOKEN is the same word in both languages, so it stays fixed text.
            const widths = [column('platform.webhooks.column.received', 18), 20, column('platform.webhooks.column.status', 11), column('platform.webhooks.column.drafts', 8)];
            const heads = [t('platform.webhooks.column.received'), 'TOKEN', t('platform.webhooks.column.status'), t('platform.webhooks.column.drafts')];
            console.log(c.bold(`  ${heads.map((h, i) => h.padEnd(widths[i])).join('')}${t('platform.webhooks.column.document')}`));
            const zone = await zoneFor(ctx);
            for (const d of rows) {
              const suspicious = Array.isArray(d.suspicion) && d.suspicion.length > 0;
              const doc = d.document_key.length > 44 ? `${d.document_key.slice(0, 43)}…` : d.document_key;
              console.log(
                `  ${fmtDate(d.received_at, zone).padEnd(widths[0])}${d.token_name.padEnd(widths[1])}` +
                  `${d.status.padEnd(widths[2])}${String(d.drafts_created).padEnd(widths[3])}${doc}` +
                  (suspicious ? ` ${c.yellow(t('platform.webhooks.suspicious'))}` : '')
              );
            }
          }
          console.log('');
        }
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });
}
