import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';

// ============================================================
// THE JOBS AN OPERATOR ADOPTED (MNE-001-453, #646)
//
// `jobs run-due` runs on the credential of whoever runs it. With
// `jobs.run_due = adopted` in their own ~/.mnemosine/config.json, it runs only
// the jobs they adopted. The list lives under THEIR home directory, the unit
// that already owns the credential (~/.mnemosine/.env, the user config):
// never in the database, never in a project file. It holds job ids, entity ids
// and a date, nothing else, and no credential.
//
// `created_by` on ai_jobs is audit text nobody authenticates, so filtering on
// it would look like a guarantee without being one; an adoption is a choice
// recorded on the operator's own machine, by the operator's own account.
// ============================================================

const fileSchema = z
  .object({
    adopted: z.record(
      z.string(),
      z.object({ entity_id: z.string(), adopted_at: z.string() }).strict()
    ),
  })
  .strict();

type AdoptionFile = z.infer<typeof fileSchema>;

export interface Adoption {
  readonly jobId: string;
  readonly entityId: string;
  readonly adoptedAt: string;
}

export function adoptionPath(home = os.homedir()): string {
  return path.join(home, '.mnemosine', 'adopted-jobs.json');
}

/** The file as stored; absent is empty. A file that does not parse throws by its path. */
function load(file: string): AdoptionFile {
  if (!fs.existsSync(file)) return { adopted: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`The list of adopted jobs in ${file} does not parse: ${(err as Error).message}. Fix or move the file.`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`The list of adopted jobs in ${file} is not in the expected shape. Fix or move the file.`);
  }
  return parsed.data;
}

/** Replaced atomically, 0600 in a 0700 directory: it is the operator's own. */
function save(file: string, content: AdoptionFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(content, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

export function readAdoptions(home = os.homedir()): Adoption[] {
  return Object.entries(load(adoptionPath(home)).adopted).map(([jobId, a]) => ({
    jobId, entityId: a.entity_id, adoptedAt: a.adopted_at,
  }));
}

/** The ids this operator adopted among one entity's jobs. */
export function adoptedJobIds(entityId: string, home = os.homedir()): Set<string> {
  return new Set(readAdoptions(home).filter((a) => a.entityId === entityId).map((a) => a.jobId));
}

export function adoptJob(
  job: { id: string; entityId: string },
  home = os.homedir(),
  now: Date = new Date()
): { file: string; already: boolean } {
  const file = adoptionPath(home);
  const content = load(file);
  if (content.adopted[job.id]) return { file, already: true };
  content.adopted[job.id] = { entity_id: job.entityId, adopted_at: now.toISOString() };
  save(file, content);
  return { file, already: false };
}

export function unadoptJob(jobId: string, home = os.homedir()): { file: string; removed: boolean } {
  const file = adoptionPath(home);
  const content = load(file);
  if (!content.adopted[jobId]) return { file, removed: false };
  delete content.adopted[jobId];
  save(file, content);
  return { file, removed: true };
}
