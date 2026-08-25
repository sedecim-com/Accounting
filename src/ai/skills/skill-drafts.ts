import * as fs from 'node:fs';
import * as path from 'node:path';
import { query, withTransaction } from '../../database/connection.js';
import type { AgentContext } from '../context.js';
import { scanSkillContent, type SkillScanReport } from './trust-scanner.js';

// ============================================================
// SKILL DRAFTS — staged skill writes
// Skills are EXECUTABLE CONFIG, so the AI never touches
// ./skills/<name>/SKILL.md directly. Every change is staged in
// skill_drafts (migration 027), ALWAYS trust-scanned first
// (scan_report), and only materialized on disk by
// approveSkillDraft — the ONLY code path that writes skill
// files. Transitions are guarded UPDATEs (status predicate +
// entity/tenant scoping + rowCount), same idiom as ai_drafts.
//
// A draft with scanner threats can be listed and reviewed, but
// approving it requires acceptRisk (the CLI's --accept-risk),
// and the acceptance is recorded in reviewed_by as
// "<reviewer> (accepted N flagged risks)".
// ============================================================

export type SkillDraftAction = 'create' | 'update' | 'delete';
export type SkillDraftStatus = 'pending_review' | 'approved' | 'rejected';

export interface SkillDraftRow {
  id: string;
  entity_id: string;
  skill_name: string;
  action: SkillDraftAction;
  content: string | null;
  previous_content: string | null;
  scan_report: SkillScanReport;
  status: SkillDraftStatus;
  model: string | null;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
}

export interface CreateSkillDraftInput {
  skillName: string;
  action: SkillDraftAction;
  /** Full proposed SKILL.md. Required for create/update; must be absent for delete. */
  content?: string | null;
  /** Model that proposed the change (audit trail). */
  model?: string;
}

export interface SkillDraftOptions {
  /** Root of the skills tree. Injectable for tests; defaults to ./skills. */
  skillsRoot?: string;
}

// The skills tree lives at <projectRoot>/skills. Resolving it from
// process.cwd() is a bug: approve/delete would then write to $PWD/skills and
// the diff base would be read from the wrong tree depending on where the
// operator happens to run mnemosine (see finding #6). Instead we resolve the
// project root deterministically from this module's own location, walking up
// to the nearest package.json, and cache it. Tests inject opts.skillsRoot.
//
// INTEGRATION: the skills store (src/ai/skills/store.ts) still derives its
// discovery root from cwd via skillDirs(cwd, homeDir); it must share THIS
// resolver so a draft's diff base and the served skill are the same file.
let cachedSkillsRoot: string | null = null;

function findProjectRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return startDir; // reached the filesystem root: give up
    dir = parent;
  }
}

/** Absolute <projectRoot>/skills, independent of process.cwd(). */
export function resolveSkillsRoot(): string {
  if (cachedSkillsRoot === null) {
    cachedSkillsRoot = path.join(findProjectRoot(__dirname), 'skills');
  }
  return cachedSkillsRoot;
}

// Fail closed on AI/third-party-controlled names: a skill name is a single
// directory segment, never a path. Anything else could escape skillsRoot.
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/i;

function assertSkillName(name: string): void {
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(
      `Invalid skill name "${name}": use letters, digits, "-" or "_" only (max 100 chars).`
    );
  }
}

function skillFilePath(skillsRoot: string, skillName: string): string {
  return path.join(skillsRoot, skillName, 'SKILL.md');
}

/** Current on-disk content of the skill, or null when the file does not exist. */
function readCurrentSkill(skillsRoot: string, skillName: string): string | null {
  const file = skillFilePath(skillsRoot, skillName);
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Stages a skill change. ALWAYS runs the trust scanner over the proposed
 * content (and, for delete drafts, over nothing — a delete carries none)
 * and stores the report; a threatening draft is still created, because
 * the human review queue is exactly where threats must surface.
 */
export async function createSkillDraft(
  ctx: AgentContext,
  input: CreateSkillDraftInput,
  opts: SkillDraftOptions = {}
): Promise<SkillDraftRow> {
  assertSkillName(input.skillName);
  const skillsRoot = opts.skillsRoot ?? resolveSkillsRoot();

  const content = input.content ?? null;
  if (input.action === 'delete') {
    if (content !== null) throw new Error('A delete draft must not carry content.');
  } else if (content === null || content.trim() === '') {
    throw new Error(`A ${input.action} draft requires the full proposed SKILL.md content.`);
  }

  // The diff base is whatever is on disk RIGHT NOW; for a create draft of
  // a skill that already exists, the previous content still lands here so
  // the reviewer sees what would be overwritten.
  const previousContent = readCurrentSkill(skillsRoot, input.skillName);

  // ALWAYS scan before anything is stored: the report travels with the
  // draft so review never depends on re-running the scanner.
  const scanReport: SkillScanReport =
    content !== null ? scanSkillContent(content) : { threats: [], clean: true };

  const result = await query<SkillDraftRow>(
    `INSERT INTO skill_drafts
       (tenant_id, entity_id, skill_name, action, content, previous_content, scan_report, status, model)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending_review', $8)
     RETURNING *`,
    [
      ctx.tenantId,
      ctx.entityId,
      input.skillName,
      input.action,
      content,
      previousContent,
      JSON.stringify(scanReport),
      input.model ?? null,
    ]
  );
  return result.rows[0];
}

export interface ApproveSkillDraftOptions extends SkillDraftOptions {
  /** Explicit acknowledgement of scanner threats (--accept-risk). */
  acceptRisk?: boolean;
  /** Approve even though the file drifted from the draft's diff base
   *  (--override-drift). Recorded in reviewed_by like acceptRisk. */
  overrideDrift?: boolean;
}

/**
 * Approves a draft and materializes it on disk — the ONLY code path that
 * writes skill files.
 *
 * Ordering (finding #4): the DB COMMIT is the point of no return. The guarded
 * pending_review→approved transition runs (and commits) FIRST, under a row
 * lock; only after the transaction resolves is the filesystem touched. A
 * commit failure therefore leaves NO orphan file on disk. If the filesystem
 * write fails AFTER the commit, the row stays approved and we surface a clear
 * "materialization pending" error rather than silently diverging disk and DB.
 *
 * TOCTOU (finding #8): before committing, the current on-disk content is
 * re-read and compared to the draft's previous_content (the diff base the
 * reviewer saw). A mismatch — a concurrent draft already applied, or an
 * out-of-band edit — refuses the approval unless overrideDrift is set.
 *
 * A draft whose scan_report carries threats REQUIRES acceptRisk; the
 * acceptance is recorded in reviewed_by as
 * "<reviewer> (accepted N flagged risks)".
 */
export async function approveSkillDraft(
  ctx: AgentContext,
  draftId: string,
  reviewer: string,
  opts: ApproveSkillDraftOptions = {}
): Promise<SkillDraftRow> {
  const skillsRoot = opts.skillsRoot ?? resolveSkillsRoot();

  const { draft, reviewedBy } = await withTransaction(async (client) => {
    const locked = await client.query<SkillDraftRow>(
      `SELECT * FROM skill_drafts WHERE id = $1 AND entity_id = $2 FOR UPDATE`,
      [draftId, ctx.entityId]
    );
    const row = locked.rows[0];
    if (!row) throw new Error(`Skill draft ${draftId} does not exist in this entity.`);
    if (row.status !== 'pending_review') {
      throw new Error(`The skill draft was already ${row.status}.`);
    }

    // Fail closed: a missing or malformed scan_report counts as threatening.
    const threats = Array.isArray(row.scan_report?.threats) ? row.scan_report.threats : null;
    const threatCount = threats === null ? Number.NaN : threats.length;
    let reviewedByLabel = reviewer;
    if (threats === null || threatCount > 0) {
      if (!opts.acceptRisk) {
        throw new Error(
          threats === null
            ? 'This draft has no valid scan report; re-create it, or approve with --accept-risk.'
            : `This draft has ${threatCount} flagged threat(s); approving it requires --accept-risk.`
        );
      }
      reviewedByLabel = `${reviewer} (accepted ${threats === null ? 'unknown' : threatCount} flagged risks)`;
    }

    // Defense in depth: the name was validated at creation, but the row is
    // data — re-validate before it becomes a filesystem path.
    assertSkillName(row.skill_name);

    // TOCTOU: the reviewer approved a diff computed against previous_content
    // snapshotted at draft time. Refuse if the file drifted since (unless
    // overrideDrift). This runs BEFORE the commit, so a drift aborts cleanly
    // with nothing written and the draft still pending.
    if (!opts.overrideDrift) {
      const current = readCurrentSkill(skillsRoot, row.skill_name);
      if (current !== (row.previous_content ?? null)) {
        throw new Error(
          `The skill "${row.skill_name}" changed on disk since this draft was staged; ` +
            're-create the draft, or approve with --override-drift.'
        );
      }
    }

    const updated = await client.query(
      `UPDATE skill_drafts
       SET status = 'approved', reviewed_by = $1, reviewed_at = NOW()
       WHERE id = $2 AND entity_id = $3 AND status = 'pending_review'`,
      [reviewedByLabel, draftId, ctx.entityId]
    );
    if (updated.rowCount !== 1) {
      throw new Error(`Skill draft ${draftId} changed status during approval; nothing was written.`);
    }

    return { draft: row, reviewedBy: reviewedByLabel };
  });

  // COMMIT succeeded above — the point of no return. Materialize on disk now.
  // If this throws, the row is already approved: surface a clear error and do
  // NOT silently diverge (the audit trail records the approval).
  try {
    const dir = path.join(skillsRoot, draft.skill_name);
    if (draft.action === 'delete') {
      fs.rmSync(dir, { recursive: true, force: true });
    } else {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), draft.content ?? '', 'utf-8');
    }
  } catch (err) {
    throw new Error(
      `Skill draft ${draftId} was approved (recorded in the audit trail) but writing it to disk ` +
        `failed: ${err instanceof Error ? err.message : String(err)}. Materialization is pending — ` +
        'fix the filesystem and re-run, or reject and re-stage.'
    );
  }

  return { ...draft, status: 'approved' as const, reviewed_by: reviewedBy };
}

/** Guarded pending_review→rejected. Never touches the filesystem. */
export async function rejectSkillDraft(
  ctx: AgentContext,
  draftId: string,
  reviewer: string
): Promise<void> {
  const result = await query(
    `UPDATE skill_drafts
     SET status = 'rejected', reviewed_by = $1, reviewed_at = NOW()
     WHERE id = $2 AND entity_id = $3 AND status = 'pending_review'`,
    [reviewer, draftId, ctx.entityId]
  );
  if (result.rowCount === 0) {
    throw new Error(`Skill draft ${draftId} is not pending review in this entity.`);
  }
}

export async function listSkillDrafts(
  ctx: AgentContext,
  filter: { status?: SkillDraftStatus } = {}
): Promise<SkillDraftRow[]> {
  if (filter.status) {
    const result = await query<SkillDraftRow>(
      `SELECT * FROM skill_drafts
       WHERE entity_id = $1 AND status = $2
       ORDER BY created_at DESC`,
      [ctx.entityId, filter.status]
    );
    return result.rows;
  }
  const result = await query<SkillDraftRow>(
    `SELECT * FROM skill_drafts WHERE entity_id = $1 ORDER BY created_at DESC`,
    [ctx.entityId]
  );
  return result.rows;
}

// ─── Diff rendering ───

// LCS beyond this many lines is not worth the quadratic table; a SKILL.md
// this large is itself suspicious, and a whole-file view still works.
const MAX_DIFF_LINES = 2000;

/**
 * Hand-rolled unified-ish line diff between previous_content and content
 * for the review UI. No context folding (skills are short); unchanged
 * lines are prefixed "  ", removals "- ", additions "+ ".
 */
export function renderSkillDraftDiff(
  draft: Pick<SkillDraftRow, 'previous_content' | 'content'>
): string[] {
  const before = (draft.previous_content ?? '').split('\n');
  const after = (draft.content ?? '').split('\n');
  if (draft.previous_content === null && draft.content === null) return [];
  if (draft.previous_content === null) return after.map((l) => `+ ${l}`);
  if (draft.content === null) return before.map((l) => `- ${l}`);

  if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) {
    return [
      `- [${before.length} lines replaced]`,
      `+ [${after.length} lines — file too large for a line diff]`,
    ];
  }

  // Classic LCS table over lines.
  const n = before.length;
  const m = after.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) {
      out.push(`  ${before[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${before[i]}`);
      i++;
    } else {
      out.push(`+ ${after[j]}`);
      j++;
    }
  }
  while (i < n) out.push(`- ${before[i++]}`);
  while (j < m) out.push(`+ ${after[j++]}`);
  return out;
}
