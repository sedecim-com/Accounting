import type { Command } from 'commander';
import { query } from '../database/connection.js';
import { t } from '../i18n/index.js';
import { riskOf } from './kernel/index.js';

// ============================================================
// THE FIRST WRITE OF A SESSION SAYS WHEN RLS IS NOT FILTERING (#326)
//
// Row level security is inert for a SUPERUSER or BYPASSRLS role. The server
// refuses to start in production under such a role (database/rls-guard.ts),
// but the CLI connects with whatever DATABASE_URL names, and until now only
// `doctor` said so. An operator writing a second firm's data as `postgres`
// learned nothing.
//
// Once per session (one CLI process, or one chat), on the first command that
// declares a write, and never on reads: a notice on every `list` would be
// noise that teaches people to skip it.
// ============================================================

export interface ConnectionRole {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
}

let noticeGiven = false;

/** Test seam: a new session. */
export function resetRlsBypassNotice(): void {
  noticeGiven = false;
}

export async function connectionRole(): Promise<ConnectionRole | null> {
  const r = await query<ConnectionRole>(
    `SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS "bypassRls"
       FROM pg_roles WHERE rolname = current_user`
  );
  return r.rows[0] ?? null;
}

/**
 * Writes the notice when `cmd` declares a write and the connection role
 * bypasses RLS, at most once per process. Returns whether it wrote. A failed
 * probe is not a reason to stop the command: it stays silent and may retry
 * on the next write.
 */
export async function noticeRlsBypassOnce(
  cmd: Command,
  write: (line: string) => void,
  probe: () => Promise<ConnectionRole | null> = connectionRole
): Promise<boolean> {
  if (noticeGiven) return false;
  const risk = riskOf(cmd)?.risk;
  if (!risk || risk === 'lectura') return false;
  let found: ConnectionRole | null;
  try {
    found = await probe();
  } catch {
    return false;
  }
  noticeGiven = true;
  if (!found || (!found.superuser && !found.bypassRls)) return false;
  write(`${t('cli.rls_bypass.notice', { role: found.role, reason: found.superuser ? 'SUPERUSER' : 'BYPASSRLS' })}\n`);
  return true;
}
