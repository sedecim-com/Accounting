import type { Command } from 'commander';
import {
  listMemory, memoryStats, correctMemory, retireMemory, restoreMemory, teachMemory,
  type MemoryEntry,
} from '../ai/memory-service.js';
import { resolveEntity, bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';

// ============================================================
// mnemosine memory
//   (no subcommand) lists the active precedents
//   teach    — seeds a criterion without waiting for the question
//   corrige  — changes the answer, preserving the previous one
//   retira   — the AI stops seeing it (not deleted)
//   restaura — reactivates it
// ============================================================

interface SubOpts {
  entity?: string;
  tenant?: string;
  user?: string;
  topic?: string;
}

export interface MemoryCliDeps {
  palette: { dim: (s: string) => string; bold: (s: string) => string; cyan: (s: string) => string };
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
}

export function renderMemory(
  entries: MemoryEntry[],
  stats: { active: number; retired: number; taught: number },
  c: MemoryCliDeps['palette']
): string[] {
  const out: string[] = ['', c.bold('Firm memory'), ''];

  if (entries.length === 0) {
    out.push('  No precedents yet.');
    out.push(c.dim('  They are created by answering questions (mnemosine questions) or directly:'));
    out.push(c.dim('    mnemosine memory teach "rule" "criterion"'));
    out.push('');
    return out;
  }

  for (const e of entries) {
    const date = new Date(e.answered_at).toISOString().split('T')[0];
    const mark = e.is_precedent ? '' : c.dim(' [retired]');
    out.push(`  ${c.bold(e.answer)}${mark}`);
    out.push(c.dim(`    ← ${e.question}`));
    out.push(c.dim(`    ${date} · ${e.answered_by}${e.topic ? ` · ${e.topic}` : ''}`));
    out.push(c.dim(`    id: ${e.id}`));
    out.push('');
  }

  out.push(
    c.dim(
      `  ${stats.active} active · ${stats.retired} retired · ${stats.taught} taught directly`
    )
  );
  out.push('');
  return out;
}

export function registerMemoryCommand(program: Command, deps: MemoryCliDeps): void {
  const mem = program
    .command('memory')
    .alias('memoria')
    .description('Firm precedents: what the AI learned and you control')
    .option('-e, --entity <idOrName>', 'Legal entity')
    .option('-t, --tenant <id>', 'Tenant')
    .option('-b, --search <text>', 'Filter by text')
    .option('--all', 'Include retired ones')
    .option('--json', 'JSON output')
    .action(async (opts: {
      entity?: string; tenant?: string; search?: string; all?: boolean; json?: boolean;
    }) => {
      try {
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const [entries, stats] = await Promise.all([
          listMemory(ctx, { search: opts.search, onlyActive: !opts.all }),
          memoryStats(ctx),
        ]);
        if (opts.json) {
          console.log(JSON.stringify({ stats, entries }, null, 2));
        } else {
          for (const l of renderMemory(entries, stats, deps.palette)) console.log(l);
          if (stats.topics.length > 0 && !opts.search) {
            console.log(deps.palette.dim('  Most frequent topics:'));
            for (const t of stats.topics.slice(0, 5)) {
              console.log(deps.palette.dim(`    ${t.count}× ${t.topic}`));
            }
            console.log('');
          }
        }
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });

  const withEntity = async (opts: SubOpts) => {
    bootstrapTenant(opts.tenant);
    const ctx = await resolveEntity(opts.entity);
    const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
    return { ctx, reviewer };
  };

  mem
    .command('teach')
    .aliases(['enseña', 'ensena'])
    .description('Seeds a firm criterion without waiting for the AI to ask')
    .argument('<rule>', 'The situation, e.g. "Telmex invoices"')
    .argument('<criterion>', 'What to do, e.g. "they go to 6130 Utilities"')
    .option('-u, --user <email>', 'Who teaches it')
    .option('--topic <slug>', 'Topic for grouping precedents')
    .action(async function (this: Command, rule: string, criterion: string) {
      try {
        const opts = this.optsWithGlobals() as SubOpts;
        const { ctx, reviewer } = await withEntity(opts);
        const id = await teachMemory(ctx, {
          rule, criterion, topic: opts.topic, taughtBy: reviewer.email,
        });
        console.log(`✔ Criterion saved. The AI will use it from now on.`);
        console.log(deps.palette.dim(`  id: ${id}`));
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });

  mem
    .command('correct')
    .aliases(['corrige'])
    .description('Changes the answer of a precedent (the previous one stays in the history)')
    .argument('<id>', 'Precedent id')
    .argument('<answer>', 'The correct answer')
    .option('-u, --user <email>', 'Who corrects')
    .action(async function (this: Command, id: string, answer: string) {
      try {
        const { ctx, reviewer } = await withEntity(this.optsWithGlobals() as SubOpts);
        const updated = await correctMemory(ctx, id, answer, reviewer.email);
        console.log(`✔ Precedent corrected: ${updated.answer}`);
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });

  mem
    .command('retire')
    .aliases(['retira'])
    .description('The AI stops using this precedent (not deleted: the history remains)')
    .argument('<id>', 'Precedent id')
    .option('-u, --user <email>', 'Who retires it')
    .action(async function (this: Command, id: string) {
      try {
        const { ctx, reviewer } = await withEntity(this.optsWithGlobals() as SubOpts);
        await retireMemory(ctx, id, reviewer.email);
        console.log('✔ Precedent retired. The AI will no longer see it.');
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });

  mem
    .command('restore')
    .aliases(['restaura'])
    .description('Reactivates a retired precedent')
    .argument('<id>', 'Precedent id')
    .action(async function (this: Command, id: string) {
      try {
        const opts = this.optsWithGlobals() as SubOpts;
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        await restoreMemory(ctx, id);
        console.log('✔ Precedent reactivated.');
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(1);
      }
    });
}
