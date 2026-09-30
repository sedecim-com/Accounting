import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Command } from 'commander';
import { declareRisk } from '../../src/cli/kernel/index.js';
import { noticeRlsBypassOnce, resetRlsBypassNotice, type ConnectionRole } from '../../src/cli/rls-bypass-notice.js';

// MNE-001-086 (#326): a write under a role RLS does not filter says so, once
// per session; reads never do.

const SUPER: ConnectionRole = { role: 'postgres', superuser: true, bypassRls: true };

function leaf(risk: 'lectura' | 'escritura' | 'irreversible'): Command {
  const cmd = new Command('x');
  declareRisk(cmd, { risk });
  return cmd;
}

beforeEach(() => resetRlsBypassNotice());

describe('noticeRlsBypassOnce', () => {
  it('warns on the first write of the session and not on the second', async () => {
    const lines: string[] = [];
    const probe = vi.fn(async () => SUPER);
    expect(await noticeRlsBypassOnce(leaf('escritura'), (l) => lines.push(l), probe)).toBe(true);
    expect(await noticeRlsBypassOnce(leaf('irreversible'), (l) => lines.push(l), probe)).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('postgres');
    expect(lines[0]).toContain('SUPERUSER');
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('names BYPASSRLS when the role is not a superuser', async () => {
    const lines: string[] = [];
    await noticeRlsBypassOnce(leaf('escritura'), (l) => lines.push(l), async () => ({ role: 'r', superuser: false, bypassRls: true }));
    expect(lines[0]).toContain('BYPASSRLS');
  });

  it('never probes for a read or an undeclared command', async () => {
    const probe = vi.fn(async () => SUPER);
    expect(await noticeRlsBypassOnce(leaf('lectura'), () => {}, probe)).toBe(false);
    expect(await noticeRlsBypassOnce(new Command('y'), () => {}, probe)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('stays silent under a role that RLS filters', async () => {
    const lines: string[] = [];
    await noticeRlsBypassOnce(leaf('escritura'), (l) => lines.push(l), async () => ({ role: 'mnemosine_app', superuser: false, bypassRls: false }));
    expect(lines).toEqual([]);
  });

  it('a failed probe does not stop the command, and the next write tries again', async () => {
    const lines: string[] = [];
    expect(await noticeRlsBypassOnce(leaf('escritura'), (l) => lines.push(l), async () => { throw new Error('down'); })).toBe(false);
    expect(await noticeRlsBypassOnce(leaf('escritura'), (l) => lines.push(l), async () => SUPER)).toBe(true);
  });
});
