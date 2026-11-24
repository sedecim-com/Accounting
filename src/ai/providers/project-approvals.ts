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
// SECURITY: the store holds a key DERIVED from what was approved, never the
// command itself, so nothing here can print or leak a helper's text. The key
// is scrypt (N 2^14, r 8, p 1) over the material with a random 16-byte salt
// kept in the store, so whoever reads the store cannot confirm a guessed
// command offline at the speed of a plain hash. A store with no salt reads as
// nothing approved. A changed command, file or host is other material, so it
// asks again. A store that does not parse is never overwritten, and reading it
// throws by its path: the gate fails closed.
// ============================================================

export type ApprovalKind = 'helper' | 'pair';

const fileSchema = z
  .object({
    salt: z.string().regex(/^[0-9a-f]{32}$/).optional(),
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

/** What one approval binds: the kind, the project file, and what it runs or sends where. */
export function approvalMaterial(kind: ApprovalKind, file: string, what: string, host: string): string {
  return JSON.stringify([kind, canonical(file), what, host]);
}

/** ~30-50 ms on a laptop: run once per material per resolution, never in a loop over the store. */
const SCRYPT_PARAMS: crypto.ScryptOptions = { N: 2 ** 14, r: 8, p: 1 };

function deriveKey(material: string, saltHex: string): string {
  return crypto.scryptSync(material, Buffer.from(saltHex, 'hex'), 32, SCRYPT_PARAMS).toString('hex');
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

export function isApproved(material: string, home = os.homedir()): boolean {
  const store = load(projectApprovalsPath(home));
  if (!store.salt || Object.keys(store.approvals).length === 0) return false;
  return Object.prototype.hasOwnProperty.call(store.approvals, deriveKey(material, store.salt));
}

/** isApproved for an async caller (a renewal): the derivation does not block the event loop. */
export async function isApprovedAsync(material: string, home = os.homedir()): Promise<boolean> {
  const store = load(projectApprovalsPath(home));
  if (!store.salt || Object.keys(store.approvals).length === 0) return false;
  const salt = Buffer.from(store.salt, 'hex');
  const key = await new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(material, salt, 32, SCRYPT_PARAMS, (err, derived) => (err ? reject(err) : resolve(derived)))
  );
  return Object.prototype.hasOwnProperty.call(store.approvals, key.toString('hex'));
}

/** Records the approvals, replacing the store atomically, 0600 in a 0700 directory. */
export function recordApprovals(
  entries: ReadonlyArray<{ material: string; kind: ApprovalKind; file: string }>,
  home = os.homedir(),
  now: Date = new Date()
): string {
  const file = projectApprovalsPath(home);
  const content = load(file);
  // A store without a salt approved nothing that can be checked: start anew.
  if (!content.salt) {
    content.salt = crypto.randomBytes(16).toString('hex');
    content.approvals = {};
  }
  for (const e of entries) {
    content.approvals[deriveKey(e.material, content.salt)] = {
      kind: e.kind, file: canonical(e.file), approved_at: now.toISOString(),
    };
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
