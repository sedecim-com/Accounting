import type { Command } from 'commander';
import {
  listMemory, memoryStats, correctMemory, retireMemory, restoreMemory, teachMemory,
  detectMemoryConflicts, digestCoverage,
  type MemoryEntry, type MemoryConflict, type DigestCoverage,
} from '../ai/memory-service.js';
import { resolveEntity, bootstrapTenant } from '../ai/context.js';
import { calendarDateIn } from '../utils/calendar-date.js';
import { zoneFor } from '../services/policy/today.js';
import { resolveReviewer } from '../ai/draft-service.js';
import { argumentByKey, describeCommand, exitCodeFor, optionByKey } from './kernel/index.js';
import { t } from '../i18n/index.js';

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
  c: MemoryCliDeps['palette'],
  zone: string
): string[] {
  const out: string[] = ['', c.bold(t('platform.memory.title')), ''];

  if (entries.length === 0) {
    out.push(`  ${t('platform.memory.empty')}`);
    out.push(c.dim(`  ${t('platform.memory.empty_hint')}`));
    out.push(c.dim('    mnemosine memory teach "rule" "criterion"'));
    out.push('');
    return out;
  }

  for (const e of entries) {
    const date = calendarDateIn(zone, new Date(e.answered_at));
    const mark = e.is_precedent ? '' : c.dim(` ${t('platform.memory.retired_mark')}`);
    out.push(`  ${c.bold(e.answer)}${mark}`);
    out.push(c.dim(`    ← ${e.question}`));
    out.push(c.dim(`    ${date} · ${e.answered_by}${e.topic ? ` · ${e.topic}` : ''}`));
    out.push(c.dim(`    id: ${e.id}`));
    out.push('');
  }

  out.push(c.dim(`  ${t('platform.memory.stats', stats)}`));
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
  c: MemoryCliDeps['palette'],
  zone: string
): string[] {
  const out: string[] = ['', c.bold(t('platform.memory.conflicts.title')), ''];

  if (conflicts.length === 0) {
    out.push(`  ${scanned === 0 ? t('platform.memory.conflicts.none_active') : t('platform.memory.conflicts.none', { scanned })}`);
    out.push('');
    return out;
  }

  for (const k of conflicts) {
    const via = t('platform.memory.conflicts.via', { scope: k.scope });
    out.push(`  ${c.bold(k.key)}  ${c.dim(`(${via} · ${k.entityName})`)}`);
    for (const e of k.entries) {
      const date = calendarDateIn(zone, new Date(e.answered_at));
      out.push(`    ${c.cyan(e.answer)}`);
      out.push(c.dim(`      ${date} · ${e.answered_by} · id: ${e.id}`));
      out.push(c.dim(`      ${t('platform.memory.conflicts.retire_hint', { id: e.id })}`));
    }
    out.push('');
  }

  out.push(c.dim(`  ${t('platform.memory.conflicts.summary', { decisions: conflicts.length, scanned })}`));
  out.push(c.dim(`  ${t('platform.memory.conflicts.ai_applies_one')}`));
  // El sistema NO desempata. Se dice aquí, en la salida que lee el humano,
  // y no sólo en un comentario del código.
  out.push(c.dim(`  ${t('platform.memory.conflicts.you_decide')}`));
  out.push(c.dim(`  ${t('platform.memory.conflicts.correct_hint')}`));
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
    c.dim(`  ⚠ ${t('platform.memory.digest.hidden', { hidden: cov.hidden, active: cov.active, visible: cov.visible, max: cov.maxEntries })}`),
    c.dim(`    ${t('platform.memory.digest.retire_hint')}`),
    '',
  ];
}

export function registerMemoryCommand(program: Command, deps: MemoryCliDeps): void {
  const mem = describeCommand(program.command('memory').alias('memoria'), 'help.memory.description');
  optionByKey(mem, '-e, --entity <idOrName>', 'help.memory.option.entity');
  optionByKey(mem, '-t, --tenant <id>', 'help.memory.option.tenant');
  optionByKey(mem, '-b, --search <text>', 'help.memory.option.search');
  optionByKey(mem, '--all', 'help.memory.option.all');
  optionByKey(mem, '--conflicts', 'help.memory.option.conflicts');
  optionByKey(mem, '--json', 'help.memory.option.json');
  mem
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
            for (const l of renderConflicts(report.conflicts, report.scanned, deps.palette, await zoneFor(ctx))) {
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
          for (const l of renderMemory(entries, stats, deps.palette, await zoneFor(ctx))) console.log(l);
          // La higiene se dice donde el humano ya está mirando, no sólo en
          // `doctor`: un aviso al que hay que ir a buscar no avisa.
          for (const l of renderDigestCoverage(coverage, deps.palette)) console.log(l);
          if (conflicts.conflicts.length > 0) {
            console.log(deps.palette.dim(`  ⚠ ${t('platform.memory.conflicts.warning', { decisions: conflicts.conflicts.length })}`));
            console.log(deps.palette.dim('    mnemosine memory --conflicts'));
            console.log('');
          }
          if (stats.topics.length > 0 && !opts.search) {
            console.log(deps.palette.dim(`  ${t('platform.memory.topics')}`));
            for (const topic of stats.topics.slice(0, 5)) {
              console.log(deps.palette.dim(`    ${topic.count}× ${topic.topic}`));
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

  const teach = describeCommand(mem.command('teach').aliases(['enseña', 'ensena']), 'help.memory.teach.description');
  argumentByKey(teach, '<rule>', 'help.memory.teach.argument.rule');
  argumentByKey(teach, '<criterion>', 'help.memory.teach.argument.criterion');
  optionByKey(teach, '-u, --user <email>', 'help.memory.teach.option.user');
  optionByKey(teach, '--topic <slug>', 'help.memory.teach.option.topic');
  teach
    .action(async function (this: Command, rule: string, criterion: string) {
      try {
        const opts = this.optsWithGlobals();
        const { ctx, reviewer } = await withEntity(opts);
        const id = await teachMemory(ctx, {
          rule, criterion, topic: opts.topic, taughtBy: reviewer.email,
        });
        console.log(`✔ ${t('platform.memory.taught')}`);
        console.log(deps.palette.dim(`  id: ${id}`));
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });

  const correct = describeCommand(mem.command('correct').aliases(['corrige']), 'help.memory.correct.description');
  argumentByKey(correct, '<id>', 'help.memory.correct.argument.id');
  argumentByKey(correct, '<answer>', 'help.memory.correct.argument.answer');
  optionByKey(correct, '-u, --user <email>', 'help.memory.correct.option.user');
  correct
    .action(async function (this: Command, id: string, answer: string) {
      try {
        const { ctx, reviewer } = await withEntity(this.optsWithGlobals());
        const updated = await correctMemory(ctx, id, answer, reviewer.email);
        console.log(`✔ ${t('platform.memory.corrected', { answer: updated.answer })}`);
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });

  const retire = describeCommand(mem.command('retire').aliases(['retira']), 'help.memory.retire.description');
  argumentByKey(retire, '<id>', 'help.memory.retire.argument.id');
  optionByKey(retire, '-u, --user <email>', 'help.memory.retire.option.user');
  // El motivo es lo que convierte «lo apagué» en rastro auditable, y es lo
  // que un conflicto resuelto necesita: contra qué otro criterio perdió.
  optionByKey(retire, '--reason <text>', 'help.memory.retire.option.reason');
  retire
    .action(async function (this: Command, id: string) {
      try {
        const opts: SubOpts & { reason?: string } = this.optsWithGlobals();
        const { ctx, reviewer } = await withEntity(opts);
        await retireMemory(ctx, id, reviewer.email, opts.reason);
        console.log(`✔ ${t('platform.memory.retired')}`);
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });

  const restore = describeCommand(mem.command('restore').aliases(['restaura']), 'help.memory.restore.description');
  argumentByKey(restore, '<id>', 'help.memory.restore.argument.id');
  restore
    .action(async function (this: Command, id: string) {
      try {
        const opts = this.optsWithGlobals();
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        await restoreMemory(ctx, id);
        console.log(`✔ ${t('platform.memory.restored')}`);
        await deps.shutdown(0);
      } catch (err) {
        deps.reportError(err);
        await deps.shutdown(exitCodeFor(err));
      }
    });
}
