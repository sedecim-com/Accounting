import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';

// MNE-001-453 (#646): `jobs run-due` runs, on its operator's credential, the
// jobs that operator chose. Two due jobs of one entity, two operators (two
// temporary homes), synthetic ids, and no model call: the gate finds no work.

const { JOB_A, JOB_B, JOB_NEW, store } = vi.hoisted(() => ({
  JOB_A: '00000000-0000-4000-8000-00000000000a',
  JOB_B: '00000000-0000-4000-8000-00000000000b',
  JOB_NEW: '00000000-0000-4000-8000-0000000000c1',
  store: { claimedFor: [] as string[][] },
}));

vi.mock('../../src/database/connection.js', () => ({
  query: vi.fn(), enterTenant: vi.fn(), currentTenant: vi.fn(), withTenant: vi.fn(), withTransaction: vi.fn(),
}));
vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: () => undefined,
  resolveEntity: () => Promise.resolve({ tenantId: 'T1', entityId: 'E1', entityName: 'Demo SA' }),
}));
vi.mock('../../src/services/policy/today.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/services/policy/today.js')>()),
  zoneFor: async () => 'America/Mexico_City',
}));
vi.mock('../../src/ai/jobs/wake-gate.js', () => ({
  checkForWork: async () => ({ hasWork: false, context: 'nothing to do', counts: {}, sampleIds: [] }),
}));
vi.mock('../../src/ai/jobs/job-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/ai/jobs/job-store.js')>();
  const due = new Date('2026-11-23T08:00:00Z');
  const row = (id: string, name: string) => ({
    id, entity_id: 'E1', name, kind: 'close_verification' as const, schedule: '0 2 * * *', enabled: true,
    consecutive_failures: 0, max_failures: 3, last_run_at: null, next_run_at: due,
    created_by: null, created_at: due,
  });
  const jobs = [row(JOB_A, 'nightly-close-a'), row(JOB_B, 'nightly-close-b')];
  return {
    ...real,
    listJobs: vi.fn(async () => jobs),
    getJob: vi.fn(async (_ctx: unknown, id: string) => jobs.find((j) => j.id === id) ?? null),
    createJob: vi.fn(async (_ctx: unknown, input: { name: string }) => ({ ...row(JOB_NEW, input.name) })),
    claimDueJobs: vi.fn(async (_ctx: unknown, _now?: Date, opts?: { only?: ReadonlySet<string> }) => {
      const claimed = jobs.filter((j) => !opts?.only || opts.only.has(j.id));
      store.claimedFor.push(claimed.map((j) => j.id));
      return claimed;
    }),
    recordRun: vi.fn(async () => ({ runId: 'run-1', autoDisabled: false })),
  };
});

import { registerJobsCommand } from '../../src/cli/jobs-command.js';
import { adoptJob, adoptionPath, adoptedJobIds } from '../../src/ai/jobs/adoption.js';
import { setLanguage, resetLanguage } from '../../src/i18n/index.js';

const plain = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };

let alice: string;
let bruno: string;
let cwd: string;

beforeEach(() => {
  alice = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-alice-'));
  bruno = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-bruno-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'jobs-cwd-'));
  vi.stubEnv('MNEMOSINE_PROVIDER', '');
  setLanguage('en');
  store.claimedFor.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetLanguage();
  for (const d of [alice, bruno, cwd]) fs.rmSync(d, { recursive: true, force: true });
});

function setting(home: string, value?: 'adopted' | 'all'): void {
  const file = path.join(home, '.mnemosine', 'config.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value ? { jobs: { run_due: value } } : {}));
}

interface Run { out: string[]; err: string; code: number | null; error: unknown }

/** One CLI invocation as the operator whose home is `home`. */
async function as(home: string, ...argv: string[]): Promise<Run> {
  const out: string[] = [];
  let err = '';
  let code: number | null = null;
  let error: unknown = null;
  const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
  // The leaf writes its lines to stdout, not console.log (MNE-001-587).
  const log = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out.push(String(c).replace(/\n$/, '')); return true; });
  const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    err += String(chunk);
    return true;
  });
  try {
    const program = new Command();
    program.exitOverride();
    registerJobsCommand(program, {
      palette: plain,
      shutdown: async (c: number) => { code = c; return undefined as never; },
      reportError: (e) => { error = e; },
      makeRunAgentTurn: vi.fn(),
    });
    await program.parseAsync(argv, { from: 'user' });
  } finally {
    write.mockRestore();
    log.mockRestore();
    cwdSpy.mockRestore();
    homedir.mockRestore();
  }
  return { out, err, code, error };
}

describe('jobs run-due with jobs.run_due unset', () => {
  it('runs every due job, as today, and names on stderr the one its operator has not adopted', async () => {
    setting(alice);
    adoptJob({ id: JOB_A, entityId: 'E1' }, alice);
    const r = await as(alice, 'jobs', 'run-due');
    expect(store.claimedFor).toEqual([[JOB_A, JOB_B]]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(`nightly-close-b (${JOB_B})`);
    expect(r.err).not.toContain(`(${JOB_A})`);
    expect(r.err).toContain('jobs.run_due');
    expect(r.err).toContain('"adopted"');
    expect(r.err).toContain('"all"');
    expect(r.err).toContain('~/.mnemosine/config.json');
  });

  it('says nothing when every job it ran is adopted', async () => {
    adoptJob({ id: JOB_A, entityId: 'E1' }, alice);
    adoptJob({ id: JOB_B, entityId: 'E1' }, alice);
    const r = await as(alice, 'jobs', 'run-due');
    expect(r.err).not.toContain('jobs.run_due');
  });

  it('a broken adoption file warns and the tick still runs every job', async () => {
    fs.mkdirSync(path.dirname(adoptionPath(alice)), { recursive: true });
    fs.writeFileSync(adoptionPath(alice), '{ broken');
    const r = await as(alice, 'jobs', 'run-due');
    expect(store.claimedFor).toEqual([[JOB_A, JOB_B]]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(adoptionPath(alice));
  });

  it('a project file that sets the key is not read, and the tick says so', async () => {
    fs.writeFileSync(path.join(cwd, 'mnemosine.config.json'), JSON.stringify({ jobs: { run_due: 'all' } }));
    const r = await as(alice, 'jobs', 'run-due');
    expect(r.err).toContain('mnemosine.config.json');
    expect(r.err).toContain(`nightly-close-a (${JOB_A})`);
  });
});

describe('jobs run-due with jobs.run_due = adopted', () => {
  it('of two due jobs runs only the adopted one, and lists the other with its id and the command that adopts it', async () => {
    setting(alice, 'adopted');
    adoptJob({ id: JOB_A, entityId: 'E1' }, alice);
    const r = await as(alice, 'jobs', 'run-due');
    expect(store.claimedFor).toEqual([[JOB_A]]);
    const text = r.out.join('\n');
    expect(text).toContain(JOB_B);
    expect(text).toContain(`mnemosine jobs adopt ${JOB_B}`);
    expect(text).not.toContain(`mnemosine jobs adopt ${JOB_A}`);
    expect(r.err).not.toContain('jobs.run_due');
  });

  it('is per operator: Bruno does not run the job Alice adopted', async () => {
    adoptJob({ id: JOB_A, entityId: 'E1' }, alice);
    setting(bruno, 'adopted');
    adoptJob({ id: JOB_B, entityId: 'E1' }, bruno);
    await as(bruno, 'jobs', 'run-due');
    expect(store.claimedFor).toEqual([[JOB_B]]);
  });

  it('with nothing adopted, claims nothing and does not say «No jobs due.»', async () => {
    setting(bruno, 'adopted');
    const r = await as(bruno, 'jobs', 'run-due');
    expect(store.claimedFor).toEqual([[]]);
    const text = r.out.join('\n');
    expect(text).not.toContain('No jobs due.');
    expect(text).toContain(`mnemosine jobs adopt ${JOB_A}`);
    expect(text).toContain(`mnemosine jobs adopt ${JOB_B}`);
  });

  it('a broken adoption file stops the tick, naming the file, before anything is claimed', async () => {
    setting(alice, 'adopted');
    fs.mkdirSync(path.dirname(adoptionPath(alice)), { recursive: true });
    fs.writeFileSync(adoptionPath(alice), '{ broken');
    const r = await as(alice, 'jobs', 'run-due');
    expect(store.claimedFor).toEqual([]);
    expect(r.code).not.toBe(0);
    expect(String((r.error as Error).message)).toContain(adoptionPath(alice));
  });

  it('--dry-run applies the same choice', async () => {
    setting(alice, 'adopted');
    adoptJob({ id: JOB_A, entityId: 'E1' }, alice);
    const r = await as(alice, 'jobs', 'run-due', '--dry-run');
    const text = r.out.join('\n');
    expect(text).toMatch(/would run: nightly-close-a/);
    expect(text).not.toMatch(/would run: nightly-close-b/);
    expect(text).toContain(`mnemosine jobs adopt ${JOB_B}`);
    expect(store.claimedFor).toEqual([]);
  });
});

describe('jobs run-due with jobs.run_due = all', () => {
  it('runs every job, says first that it spends the operator\'s credential on other people\'s jobs, and gives no hint', async () => {
    setting(bruno, 'all');
    const r = await as(bruno, 'jobs', 'run-due');
    expect(store.claimedFor).toEqual([[JOB_A, JOB_B]]);
    expect(r.out[0]).toMatch(/your credential/);
    expect(r.out[0]).toMatch(/other people created/);
    expect(r.err).not.toContain('jobs.run_due');
  });
});

describe('jobs adopt, adopt --list, unadopt', () => {
  it('adopt records it under the operator\'s home, --list shows it, unadopt removes it', async () => {
    let r = await as(alice, 'jobs', 'adopt', JOB_A);
    expect(r.code).toBe(0);
    expect(adoptedJobIds('E1', alice).has(JOB_A)).toBe(true);
    expect(adoptedJobIds('E1', bruno).has(JOB_A)).toBe(false);
    expect(r.out.join('\n')).toContain('nightly-close-a');

    r = await as(alice, 'jobs', 'adopt', '--list');
    const listed = r.out.join('\n');
    expect(listed).toContain(JOB_A);
    expect(listed).toContain('nightly-close-a');
    expect(listed).not.toContain(JOB_B);
    expect(listed).toMatch(/jobs\.run_due.*unset/);

    r = await as(alice, 'jobs', 'unadopt', JOB_A);
    expect(r.code).toBe(0);
    expect(adoptedJobIds('E1', alice).has(JOB_A)).toBe(false);
  });

  it('adopt of a job this entity does not have is refused and records nothing', async () => {
    const r = await as(alice, 'jobs', 'adopt', JOB_NEW);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(adoptionPath(alice))).toBe(false);
  });

  it('adopt with both an id and --list, or with neither, is a usage error', async () => {
    expect((await as(alice, 'jobs', 'adopt', JOB_A, '--list')).code).toBe(2);
    expect((await as(alice, 'jobs', 'adopt')).code).toBe(2);
  });

  it('unadopt of a job that was not adopted says so and exits 0', async () => {
    const r = await as(alice, 'jobs', 'unadopt', JOB_B);
    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain(JOB_B);
  });
});

describe('jobs create adopts the job for whoever creates it', () => {
  it('the creator\'s adopted tick keeps running it; the other operator\'s does not', async () => {
    const r = await as(alice, 'jobs', 'create', '--name', 'my-close', '--kind', 'close_verification', '--schedule', '0 2 * * *');
    expect(r.code).toBe(0);
    expect(adoptedJobIds('E1', alice).has(JOB_NEW)).toBe(true);
    expect(adoptedJobIds('E1', bruno).has(JOB_NEW)).toBe(false);
  });
});

describe('no credential is stored with a job', () => {
  it('the adoption file holds ids and dates, nothing else', async () => {
    await as(alice, 'jobs', 'adopt', JOB_A);
    const raw = fs.readFileSync(adoptionPath(alice), 'utf-8');
    const stored = JSON.parse(raw) as { adopted: Record<string, object> };
    expect(Object.keys(stored.adopted[JOB_A]).sort()).toEqual(['adopted_at', 'entity_id']);
  });
});
