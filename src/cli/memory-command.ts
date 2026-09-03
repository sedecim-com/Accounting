import type { Command } from 'commander';
import {
  listMemory, memoryStats, correctMemory, retireMemory, restoreMemory, teachMemory,
  detectMemoryConflicts, digestCoverage,
  type MemoryEntry, type MemoryConflict, type DigestCoverage,
} from '../ai/memory-service.js';
import { resolveEntity, bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { exitCodeFor } from './kernel/index.js';

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

// ============================================================
// EL INFORME DE CONFLICTOS, Y POR QUÉ NO HAY «RESOLVER»
//
// Ofrecer que un humano resuelva no es lo mismo que resolver por él. Aquí
// se enumeran los precedentes que se pelean una decisión y se imprime, al
// lado de cada uno, el comando EXACTO que lo retira o lo corrige — el
// modelo de `doctor`: nunca el síntoma solo.
//
// Lo que NO hay es un verbo que retire «los perdedores»: quien decide cuál
// manda es el despacho, escribiendo el comando y firmándolo con su usuario
// y su motivo. Un `memory resolve --keep <id>` ahorraría dos líneas de
// teclado y a cambio pondría al sistema a apagar criterios contables en
// lote a partir de una elección que nadie revisó dos veces.
// ============================================================

export function renderConflicts(
  conflicts: MemoryConflict[],
  scanned: number,
  c: MemoryCliDeps['palette']
): string[] {
  const out: string[] = ['', c.bold('Precedents in conflict'), ''];

  if (conflicts.length === 0) {
    out.push(
      scanned === 0
        ? '  No active precedents yet: nothing can contradict anything.'
        : `  None: the ${scanned} active precedent(s) do not contradict each other.`
    );
    out.push('');
    return out;
  }

  for (const k of conflicts) {
    const via = k.scope === 'topic' ? 'topic' : 'same question';
    out.push(`  ${c.bold(k.key)}  ${c.dim(`(${via} · ${k.entityName})`)}`);
    for (const e of k.entries) {
      const date = new Date(e.answered_at).toISOString().split('T')[0];
      out.push(`    ${c.cyan(e.answer)}`);
      out.push(c.dim(`      ${date} · ${e.answered_by} · id: ${e.id}`));
      out.push(
        c.dim(`      → mnemosine memory retire ${e.id} --reason "lost to a conflicting precedent"`)
      );
    }
    out.push('');
  }

  out.push(
    c.dim(
      `  ${conflicts.length} decision(s) with contradicting criteria, out of ${scanned} active precedent(s).`
    )
  );
  out.push(
    c.dim(
      '  The AI reads all of them from the same memory: it will apply one and will not say which.'
    )
  );
  // El sistema NO desempata. Se dice aquí, en la salida que lee el humano,
  // y no sólo en un comentario del código.
  out.push(c.dim('  Nobody but you decides which one stands: retire the others, or correct this one'));
  out.push(c.dim('  (mnemosine memory correct <id> "<the answer that holds>").'));
  out.push('');
  return out;
}

/**
 * El renglón de higiene del listado normal: cuántos precedentes ACTIVOS
 * viajan de verdad en el prompt. Los que caen fuera del corte siguen aquí
 * y siguen siendo buscables, pero dejan de aplicarse solos — y eso, sin
 * decirlo, se lee como que el criterio se olvidó.
 */
export function renderDigestCoverage(
  cov: DigestCoverage,
  c: MemoryCliDeps['palette']
): string[] {
  if (cov.hidden === 0) return [];
  return [
    c.dim(
      `  ⚠ ${cov.hidden} of ${cov.active} active precedent(s) fall outside the session digest ` +
        `(it carries ${cov.visible}, max ${cov.maxEntries}): the AI only sees them if it searches.`
    ),
    c.dim('    Retire what no longer applies so what does fits: mnemosine memory retire <id> --reason "<why>"'),
    '',
  ];
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
    .option('--conflicts', 'Only the precedents that contradict each other, and how to resolve them')
    .option('--json', 'JSON output')
    .action(async (opts: {
      entity?: string; tenant?: string; search?: string; all?: boolean;
      conflicts?: boolean; json?: boolean;
    }) => {
      try {
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);

        if (opts.conflicts) {
          // LA ENTIDAD VIAJA HASTA EL SQL. `detectMemoryConflicts` sin
          // `entityId` barre todo el tenant —así lo quiere `doctor`— y aquí
          // eso enseñaría contradicciones de otra entidad como si fueran de
          // ésta. La prueba lo ejerce de lado a lado: comando real contra un
          // doble que lee la frontera del SQL con el que se le llamó.
          const report = await detectMemoryConflicts({ entityId: ctx.entityId });
          if (opts.json) {
            console.log(JSON.stringify(report, null, 2));
          } else {
            for (const l of renderConflicts(report.conflicts, report.scanned, deps.palette)) {
              console.log(l);
            }
          }
          // Un conflicto no es un fallo del comando: se listó lo que había.
          await deps.shutdown(0);
        }

        const [entries, stats, conflicts, coverage] = await Promise.all([
          listMemory(ctx, { search: opts.search, onlyActive: !opts.all }),
          memoryStats(ctx),
          // Misma frontera que arriba: el recuento del aviso es de ESTA
          // entidad, no del tenant.
          detectMemoryConflicts({ entityId: ctx.entityId }),
          digestCoverage(ctx),
        ]);
        if (opts.json) {
          console.log(JSON.stringify({ stats, digest: coverage, conflicts, entries }, null, 2));
        } else {
          for (const l of renderMemory(entries, stats, deps.palette)) console.log(l);
          // La higiene se dice donde el humano ya está mirando, no sólo en
          // `doctor`: un aviso al que hay que ir a buscar no avisa.
          for (const l of renderDigestCoverage(coverage, deps.palette)) console.log(l);
          if (conflicts.conflicts.length > 0) {
            console.log(
              deps.palette.dim(
                `  ⚠ ${conflicts.conflicts.length} decision(s) have contradicting precedents; ` +
                  'the AI applies one without saying which.'
              )
            );
            console.log(deps.palette.dim('    mnemosine memory --conflicts'));
            console.log('');
          }
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
        await deps.shutdown(exitCodeFor(err));
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
        const opts = this.optsWithGlobals();
        const { ctx, reviewer } = await withEntity(opts);
        const id = await teachMemory(ctx, {
          rule, criterion, topic: opts.topic, taughtBy: reviewer.email,
        });
        console.log(`✔ Criterion saved. The AI will use it from now on.`);
        console.log(deps.palette.dim(`  id: ${id}`));
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
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
        const { ctx, reviewer } = await withEntity(this.optsWithGlobals());
        const updated = await correctMemory(ctx, id, answer, reviewer.email);
        console.log(`✔ Precedent corrected: ${updated.answer}`);
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });

  mem
    .command('retire')
    .aliases(['retira'])
    .description('The AI stops using this precedent (not deleted: the history remains)')
    .argument('<id>', 'Precedent id')
    .option('-u, --user <email>', 'Who retires it')
    // El motivo es lo que convierte «lo apagué» en rastro auditable, y es lo
    // que un conflicto resuelto necesita: contra qué otro criterio perdió.
    .option('--reason <text>', 'Why it no longer applies (kept in the precedent history)')
    .action(async function (this: Command, id: string) {
      try {
        const opts: SubOpts & { reason?: string } = this.optsWithGlobals();
        const { ctx, reviewer } = await withEntity(opts);
        await retireMemory(ctx, id, reviewer.email, opts.reason);
        console.log('✔ Precedent retired. The AI will no longer see it.');
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });

  mem
    .command('restore')
    .aliases(['restaura'])
    .description('Reactivates a retired precedent')
    .argument('<id>', 'Precedent id')
    .action(async function (this: Command, id: string) {
      try {
        const opts = this.optsWithGlobals();
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        await restoreMemory(ctx, id);
        console.log('✔ Precedent reactivated.');
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });
}
