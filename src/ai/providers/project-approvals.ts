import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';

// ============================================================
// WHAT A PERSON APPROVED OF A SHARED PROJECT FILE (MNE-001-452, #645)
//
// A project's mnemosine.config.json is versioned and shared with whoever
// clones it. What it asks this person's mnemosine to run, or where it asks to
// send their key, is approved once by that person with
// `mnemosine providers approve <profile>`, as `direnv allow` approves an
// .envrc, and recorded here, under THEIR home directory: never in the
// project, never in the database.
//
// SECURITY: the store holds a SHA-256 of what was approved, never the
// command itself, so nothing here can print or leak a helper's text. A
// changed command, file or host is another hash, so it asks again. A store
// that does not parse is never overwritten, and reading it throws by its
// path: the gate fails closed.
// ============================================================

export type ApprovalKind = 'helper' | 'pair';

const fileSchema = z
  .object({
    approvals: z.record(
      z.string(),
      z.object({ kind: z.enum(['helper', 'pair']), file: z.string(), approved_at: z.string() }).strict()
    ),
  })
  .strict();

type ApprovalFile = z.infer<typeof fileSchema>;

export function projectApprovalsPath(home = os.homedir()): string {
  return path.join(home, '.mnemosine', 'project-approvals.json');
}

/** The project file as approved: its real path, so a symlink is the same file. */
function canonical(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/** The hash of one approval: the kind, the project file, and what it runs or sends where. */
export function approvalKey(kind: ApprovalKind, file: string, what: string, host: string): string {
  return crypto.createHash('sha256').update(JSON.stringify([kind, canonical(file), what, host])).digest('hex');
}

function load(file: string): ApprovalFile {
  if (!fs.existsSync(file)) return { approvals: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    raw = null;
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`The project approvals in ${file} do not parse. Fix or move the file; nothing is approved until then.`);
  }
  return parsed.data;
}

export function isApproved(key: string, home = os.homedir()): boolean {
  return Object.prototype.hasOwnProperty.call(load(projectApprovalsPath(home)).approvals, key);
}

/** Records the approvals, replacing the store atomically, 0600 in a 0700 directory. */
export function recordApprovals(
  entries: ReadonlyArray<{ key: string; kind: ApprovalKind; file: string }>,
  home = os.homedir(),
  now: Date = new Date()
): string {
  const file = projectApprovalsPath(home);
  const content = load(file);
  for (const e of entries) {
    content.approvals[e.key] = { kind: e.kind, file: canonical(e.file), approved_at: now.toISOString() };
  }
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
  return file;
}
