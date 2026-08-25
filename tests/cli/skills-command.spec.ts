import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// The drafts review action pulls its data through these modules; mock them so
// the test drives only the command's own control flow (finding #9: a non-TTY
// stdin must not hang on the interactive prompt).
vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: vi.fn(),
  resolveEntity: vi.fn(async () => ({
    tenantId: 'tttttttt-tttt-tttt-tttt-tttttttttttt',
    entityId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    entityName: 'Acme MX',
  })),
}));
vi.mock('../../src/ai/draft-service.js', () => ({
  resolveReviewer: vi.fn(async () => ({ email: 'ana@despacho.mx' })),
}));
vi.mock('../../src/ai/skills/skill-drafts.js', () => ({
  approveSkillDraft: vi.fn(),
  rejectSkillDraft: vi.fn(),
  listSkillDrafts: vi.fn(),
  renderSkillDraftDiff: vi.fn(() => ['+ a line']),
}));
vi.mock('../../src/ai/skills/store.js', () => ({
  listSkills: vi.fn(() => []),
  viewSkill: vi.fn(),
}));

import { registerSkillsCommand } from '../../src/cli/skills-command.js';
import { resolveReviewer } from '../../src/ai/draft-service.js';
import { listSkillDrafts } from '../../src/ai/skills/skill-drafts.js';

const mockListDrafts = listSkillDrafts as unknown as ReturnType<typeof vi.fn>;
const mockResolveReviewer = resolveReviewer as unknown as ReturnType<typeof vi.fn>;

const id = (s: string): string => s;
const palette = {
  dim: id, bold: id, cyan: id, red: id, green: id, yellow: id,
} as unknown as import('../../src/cli/palette.js').Palette;

const PENDING = [
  {
    id: 'dddddddd-1111-2222-3333-444444444444',
    entity_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    skill_name: 'month-end-close',
    action: 'create' as const,
    content: '# x\n',
    previous_content: null,
    scan_report: { threats: [], clean: true },
    status: 'pending_review' as const,
    model: null,
    created_at: '2026-08-24T00:00:00Z',
    reviewed_by: null,
    reviewed_at: null,
  },
];

let origIsTTY: boolean | undefined;
let logSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  origIsTTY = process.stdin.isTTY;
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  (process.stdin as { isTTY?: boolean }).isTTY = origIsTTY;
  logSpy.mockRestore();
});

/** Runs `mnemosine skills drafts` with the given deps and returns when the
 *  command's shutdown fires — never blocking on an interactive prompt. */
async function runDrafts(shutdown: (code: number) => Promise<never>): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerSkillsCommand(program, { palette, shutdown, reportError: () => undefined });
  await program.parseAsync(['node', 'mnemosine', 'skills', 'drafts', '--entity', 'x']);
}

describe('skills drafts — non-TTY stdin', () => {
  it('prints the queue and exits instead of hanging on the interactive prompt', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = false;
    mockListDrafts.mockResolvedValue(PENDING);

    const codes: number[] = [];
    // shutdown unwinds the action by throwing; the first (code 0) is the
    // non-TTY exit we assert on.
    const shutdown = vi.fn(async (code: number) => {
      codes.push(code);
      throw new Error(`__shutdown_${code}__`);
    }) as unknown as (code: number) => Promise<never>;

    await expect(runDrafts(shutdown)).rejects.toThrow(/__shutdown_/);

    // Exited via the non-TTY path with code 0 — and BEFORE resolving a
    // reviewer / opening readline (which is where the hang used to be).
    expect(codes[0]).toBe(0);
    expect(mockResolveReviewer).not.toHaveBeenCalled();
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/stdin is not a terminal/);
  });

  it('does not short-circuit when stdin IS a TTY (would enter interactive review)', async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    mockListDrafts.mockResolvedValue([]); // empty queue → clean exit, no prompt

    const codes: number[] = [];
    const shutdown = vi.fn(async (code: number) => {
      codes.push(code);
      throw new Error(`__shutdown_${code}__`);
    }) as unknown as (code: number) => Promise<never>;

    await expect(runDrafts(shutdown)).rejects.toThrow(/__shutdown_/);
    expect(codes[0]).toBe(0);
    const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toMatch(/No skill drafts await review/);
  });
});
