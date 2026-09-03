import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Command } from 'commander';
import type { Palette } from './palette.js';
import { resolveEntity, bootstrapTenant } from '../ai/context.js';
import { resolveReviewer } from '../ai/draft-service.js';
import {
  approveSkillDraft,
  listSkillDrafts,
  rejectSkillDraft,
  renderSkillDraftDiff,
  type SkillDraftRow,
} from '../ai/skills/skill-drafts.js';
import type { SkillScanReport } from '../ai/skills/trust-scanner.js';
import { listSkills, viewSkill, visibleSkills } from '../ai/skills/store.js';
import { exitCodeFor, notFound } from './kernel/index.js';

// ============================================================
// mnemosine skills (alias: habilidades)
// Surface over firm skills and their staged writes:
//   - list:   visible skills + how many drafts await review;
//   - drafts: queue review (diff + scan report card, then
//             [a]pprove / [r]eject / [s]kip). Drafts flagged by
//             the trust scanner are UNTRUSTED CODE: approving
//             them requires an explicit --accept-risk, recorded
//             in reviewed_by;
//   - view:   print one skill's SKILL.md.
// Reading goes through the skills store; the ONLY write path is
// approveSkillDraft (src/ai/skills/skill-drafts.ts).
// ============================================================

export interface SkillsCommandDeps {
  palette: Palette;
  shutdown: (code: number) => Promise<never>;
  reportError: (err: unknown) => void;
}

/** Renders the scanner verdict as a small card for the review UI. */
export function formatScanReportCard(report: SkillScanReport | null, c: Palette): string[] {
  const out: string[] = [];
  const threats = report && Array.isArray(report.threats) ? report.threats : null;
  if (threats === null) {
    out.push(c.red('  ⚠ scan report missing or malformed — treat as flagged'));
    return out;
  }
  if (threats.length === 0) {
    out.push(c.green('  ✔ trust scan: clean'));
    return out;
  }
  out.push(c.red(`  ⚠ trust scan: ${threats.length} threat(s) — approval requires --accept-risk`));
  for (const t of threats) {
    out.push(c.red(`    [${t.kind}] line ${t.line}: `) + c.dim(t.excerpt));
  }
  return out;
}

/** Colorized diff lines for one draft. Pure formatting — no I/O. */
export function formatDraftDiff(draft: SkillDraftRow, c: Palette): string[] {
  return renderSkillDraftDiff(draft).map((line) => {
    if (line.startsWith('+')) return c.green(line);
    if (line.startsWith('-')) return c.red(line);
    return c.dim(line);
  });
}

function draftHeader(draft: SkillDraftRow, c: Palette): string {
  const model = draft.model ? ` · ${draft.model}` : '';
  return `${c.bold(`${draft.action} ${draft.skill_name}`)} ${c.dim(`(${draft.id}${model})`)}`;
}

/**
 * `viewSkill` habla para el MODELO: su negativa es UNIFORME a propósito —no
 * existe, es inválida y está vetada dan el mismo texto, porque distinguirlas
 * filtraría qué hay instalado— y por eso no lleva código de salida. Esa
 * uniformidad es correcta allí y muda aquí: en la frontera del CLI esa
 * negativa concreta es NOT_FOUND, y sólo ella.
 *
 * La clasificación NO se hace leyendo el texto del mensaje (que el almacén
 * puede reescribir mañana) sino preguntándole al mismo almacén si el nombre
 * es visible. Así un fallo de lectura o de parseo de un SKILL.md que SÍ
 * existe sigue saliendo por su propio código en vez de disfrazarse de 3.
 */
function leerHabilidad(name: string): ReturnType<typeof viewSkill> {
  try {
    return viewSkill(name);
  } catch (err) {
    if (visibleSkills().some((s) => s.name === name)) throw err;
    throw notFound(err instanceof Error ? err.message : String(err));
  }
}

export function registerSkillsCommand(program: Command, deps: SkillsCommandDeps): void {
  const { palette: c, shutdown, reportError } = deps;

  const skills = program
    .command('skills')
    .alias('habilidades')
    .description('Firm skills: list, review staged changes, view content');

  skills
    .command('list')
    .description('Visible skills and how many staged changes await review')
    .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
    .option('-t, --tenant <id>', 'Tenant')
    .option('--json', 'JSON output')
    .action(async (opts: { entity?: string; tenant?: string; json?: boolean }) => {
      try {
        bootstrapTenant(opts.tenant);
        const ctx = await resolveEntity(opts.entity);
        const skillsFound = listSkills();
        const pending = await listSkillDrafts(ctx, { status: 'pending_review' });
        if (opts.json) {
          console.log(JSON.stringify({ skills: skillsFound, pendingDrafts: pending.length }, null, 2));
        } else {
          console.log('');
          console.log(c.bold('Skills'));
          if (skillsFound.length === 0) {
            console.log(c.dim('  No skills are visible for this entity.'));
          }
          for (const s of skillsFound) {
            const description = s.description ? c.dim(` — ${s.description}`) : '';
            const flag = !s.valid
              ? c.red(' [invalid]')
              : s.gated
                ? c.dim(' [gated]')
                : '';
            console.log(`  ${c.cyan(s.name)}${flag}${description}`);
          }
          console.log('');
          if (pending.length > 0) {
            console.log(
              c.yellow(`${pending.length} staged change(s) await review: mnemosine skills drafts`)
            );
            console.log('');
          }
        }
        await shutdown(0);
      } catch (err) {
        reportError(err);
        await shutdown(exitCodeFor(err));
      }
    });

  skills
    .command('drafts')
    .description('Review staged skill changes: diff + trust-scan report, approve or reject')
    .option('-e, --entity <idOrName>', 'Legal entity (id, RFC or name fragment)')
    .option('-t, --tenant <id>', 'Tenant')
    .option('-u, --user <email>', 'Reviewer')
    .option(
      '--accept-risk',
      'Allow approving drafts the trust scanner flagged (recorded in the audit trail)'
    )
    .option(
      '--override-drift',
      'Approve even if the skill file drifted from the draft diff base (recorded in the audit trail)'
    )
    .option('--json', 'List pending drafts as JSON (no interactive review)')
    .action(
      async (opts: {
        entity?: string;
        tenant?: string;
        user?: string;
        acceptRisk?: boolean;
        overrideDrift?: boolean;
        json?: boolean;
      }) => {
        let rl: readline.Interface | undefined;
        try {
          bootstrapTenant(opts.tenant);
          const ctx = await resolveEntity(opts.entity);
          const pending = await listSkillDrafts(ctx, { status: 'pending_review' });

          if (opts.json) {
            console.log(JSON.stringify(pending, null, 2));
            await shutdown(0);
          }
          if (pending.length === 0) {
            console.log(c.dim('\nNo skill drafts await review.'));
            await shutdown(0);
          }

          // Interactive review needs a real terminal to answer the prompt.
          // On a non-TTY stdin (cron, CI, a pipe) rl.question would never
          // settle after EOF and the process would hang forever with drafts
          // pending and the DB pool held open. Mirror the review-queue
          // pattern: print the queue non-interactively and exit instead.
          if (!stdin.isTTY) {
            console.log(
              c.yellow(
                `\n${pending.length} skill draft(s) await review, but stdin is not a terminal.`
              )
            );
            for (const draft of pending) {
              console.log(`\n${draftHeader(draft, c)}`);
              for (const l of formatScanReportCard(draft.scan_report, c)) console.log(l);
            }
            console.log(
              c.dim(
                '\nRun in a terminal to approve/reject interactively, or use --json for machine output.'
              )
            );
            await shutdown(0);
          }

          const reviewer = await resolveReviewer(ctx.tenantId, opts.user);
          rl = readline.createInterface({ input: stdin, output: stdout });

          for (const draft of pending) {
            console.log(`\n${draftHeader(draft, c)}`);
            for (const l of formatScanReportCard(draft.scan_report, c)) console.log(l);
            console.log('');
            for (const l of formatDraftDiff(draft, c)) console.log(l);
            console.log('');

            const answer = (
              await rl.question(c.cyan('[a]pprove / [r]eject / [s]kip / [q]uit > '))
            )
              .trim()
              .toLowerCase();
            if (answer === 'q') break;
            if (answer === 'a') {
              try {
                await approveSkillDraft(ctx, draft.id, reviewer.email, {
                  acceptRisk: opts.acceptRisk,
                  overrideDrift: opts.overrideDrift,
                });
                console.log(c.green(`✔ Approved and written: skills/${draft.skill_name}`));
              } catch (err) {
                // Typically: flagged threats without --accept-risk. Keep
                // reviewing the rest of the queue.
                console.log(c.red(`✘ ${err instanceof Error ? err.message : String(err)}`));
              }
            } else if (answer === 'r') {
              await rejectSkillDraft(ctx, draft.id, reviewer.email);
              console.log(c.dim('✘ Rejected.'));
            } else {
              console.log(c.dim('Skipped; still pending.'));
            }
          }

          rl.close();
          await shutdown(0);
        } catch (err) {
          rl?.close();
          reportError(err);
          await shutdown(exitCodeFor(err));
        }
      }
    );

  skills
    .command('view')
    .description("Print one skill's SKILL.md")
    .argument('<name>', 'Skill name')
    .action(async (name: string) => {
      try {
        const skill = leerHabilidad(name);
        console.log(c.bold(skill.frontmatter.name));
        if (skill.frontmatter.description) console.log(c.dim(skill.frontmatter.description));
        console.log('');
        console.log(skill.body);
        await shutdown(0);
      } catch (err) {
        reportError(err);
        await shutdown(exitCodeFor(err));
      }
    });
}
