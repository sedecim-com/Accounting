import { afterEach, beforeEach, describe, it, expect, vi, type MockInstance } from 'vitest';
import { Command } from 'commander';

// ============================================================
// I8.6 · platform 3/3, part 1: what `jobs` prints comes from the catalogue
// (MNE-001-587, #268)
//
// Every line `jobs list`, `history`, `create`, `enable`, `disable` and
// `run-due` write to a person is a key of the I8.6 block, written with
// process.stdout.write and never with console.log (#268's console clause).
// The English is today's text byte for byte, «(s)» included; Spanish takes
// the ICU plural. Texts by hand, before the code.
// ============================================================

vi.mock('../../src/ai/context.js', () => ({
  bootstrapTenant: vi.fn(),
  resolveEntity: vi.fn(async () => ({ entityId: 'E1', entityName: 'Demo', tenantId: 'T1' })),
}));
vi.mock('../../src/ai/jobs/job-store.js', async (original) => ({
  ...(await original<typeof import('../../src/ai/jobs/job-store.js')>()),
  createJob: vi.fn(),
  listJobs: vi.fn(async () => []),
  getJob: vi.fn(),
  setEnabled: vi.fn(),
  listRuns: vi.fn(async () => []),
}));
vi.mock('../../src/ai/jobs/adoption.js', () => ({
  adoptJob: vi.fn(() => ({ file: '/h/.mnemosine/adopted-jobs.json', already: false })),
  unadoptJob: vi.fn(),
  adoptedJobIds: vi.fn(() => new Set<string>()),
  readAdoptions: vi.fn(() => []),
  adoptionPath: vi.fn(() => '/h/.mnemosine/adopted-jobs.json'),
}));
vi.mock('../../src/ai/providers/config.js', async (original) => ({
  ...(await original<typeof import('../../src/ai/providers/config.js')>()),
  readRunDueScope: vi.fn(() => ({ scope: 'all', file: '/h/.mnemosine/config.json', projectCarriesKey: false })),
}));
vi.mock('../../src/ai/jobs/runner.js', () => ({ runDueJobs: vi.fn(async () => []) }));
vi.mock('../../src/services/policy/today.js', () => ({ zoneFor: vi.fn(async () => 'America/Mexico_City') }));
vi.mock('../../src/cli/provider-readiness.js', () => ({ tickCredentialLine: vi.fn(() => 'profile line') }));
vi.mock('../../src/ai/providers/trial-endpoint.js', () => ({ assertDefaultNotOnTrial: vi.fn() }));

import { registerJobsCommand } from '../../src/cli/jobs-command.js';
import * as store from '../../src/ai/jobs/job-store.js';
import * as runner from '../../src/ai/jobs/runner.js';
import { resetDeclarations } from '../../src/cli/kernel/risk.js';
import { resetLanguage, setLanguage } from '../../src/i18n/index.js';

const PALETTE = { dim: (s: string) => s, bold: (s: string) => s, cyan: (s: string) => s };
const NEXT = new Date('2026-11-24T08:15:00Z'); // 02:15 in Mexico City
const PAST = new Date('2026-01-01T00:00:00Z');
const ID1 = '00000000-0000-4000-8000-000000000001';
const ID2 = '00000000-0000-4000-8000-000000000002';

function job(id: string, name: string, over: Partial<store.JobRow> = {}): store.JobRow {
  return {
    id, entity_id: 'E1', name, kind: 'close_verification', schedule: '0 2 * * *', enabled: true,
    consecutive_failures: 0, max_failures: 3, last_run_at: null, next_run_at: NEXT, created_by: null,
    created_at: NEXT, ...over,
  };
}

function outcome(over: Partial<runner.JobRunOutcome>): runner.JobRunOutcome {
  return { jobId: ID1, name: 'nightly', status: 'ok', detail: 'done', draftsCreated: 0, autoDisabled: false, ...over } as runner.JobRunOutcome;
}

let consoleLog: MockInstance<typeof console.log>;

async function jobs(...args: string[]): Promise<{ out: string; err: string; codes: number[] }> {
  resetDeclarations();
  let out = '';
  let err = '';
  const codes: number[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out += String(c); return true; });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err += String(c); return true; });
  try {
    const program = new Command('mnemosine').exitOverride();
    registerJobsCommand(program, {
      palette: PALETTE,
      shutdown: async (c: number) => { codes.push(c); return undefined as never; },
      reportError: (e) => { throw e; },
      makeRunAgentTurn: vi.fn(),
    });
    await program.parseAsync(['node', 'mnemosine', 'jobs', ...args]);
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
  }
  return { out, err, codes };
}

beforeEach(() => {
  setLanguage('en');
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  // #268's console clause: nothing of this leaf goes through console.log.
  expect(consoleLog).not.toHaveBeenCalled();
  consoleLog.mockRestore();
  resetLanguage();
});

describe('I8.6 · jobs list and history speak by key', () => {
  it('jobs list with no job', async () => {
    expect((await jobs('list')).out).toBe('No jobs configured. Create one with `mnemosine jobs create`.\n');
    setLanguage('es');
    expect((await jobs('list')).out).toBe('No hay trabajos configurados. Crea uno con `mnemosine jobs create`.\n');
  });

  it('jobs list: the headers and yes/no, aligned as before in English', async () => {
    vi.mocked(store.listJobs).mockResolvedValueOnce([
      job(ID1, 'nightly-close'),
      job(ID2, 'weekly', { enabled: false, next_run_at: null, consecutive_failures: 3 }),
    ]);
    const { out } = await jobs('list');
    expect(out.split('\n')).toEqual([
      '  ID                                    NAME                      KIND                  SCHEDULE        ENABLED   FAILS   NEXT RUN        ',
      `  ${ID1}  nightly-close             close_verification    0 2 * * *       yes       0/3     2026-11-24 02:15`,
      `  ${ID2}  weekly                    close_verification    0 2 * * *       no        3/3     —               `,
      '',
    ]);
  });

  it('jobs list in Spanish: the headers, «sí» and «no»', async () => {
    setLanguage('es');
    vi.mocked(store.listJobs).mockResolvedValueOnce([job(ID1, 'nightly-close'), job(ID2, 'weekly', { enabled: false })]);
    const lines = (await jobs('list')).out.split('\n');
    expect(lines[0]).toBe(
      '  ID                                    NOMBRE                    TIPO                  CALENDARIO      ACTIVO    FALLOS  PRÓXIMA CORRIDA '
    );
    expect(lines[1]).toContain('0 2 * * *       sí        0/3');
    expect(lines[2]).toContain('0 2 * * *       no        0/3');
  });

  it('jobs history with no run', async () => {
    expect((await jobs('history')).out).toBe('No runs recorded yet.\n');
    setLanguage('es');
    expect((await jobs('history')).out).toBe('Todavía no hay corridas registradas.\n');
  });

  it('jobs history: the headers in both languages, and BORRADORES widens its column', async () => {
    const runs: store.JobRunRow[] = [
      { id: 'r1', job_id: ID1, job_name: 'nightly', started_at: NEXT, finished_at: NEXT, status: 'ok', detail: { summary: 'closed' }, drafts_created: 2 },
    ];
    vi.mocked(store.listRuns).mockResolvedValue(runs);
    expect((await jobs('history')).out).toBe(
      '  STARTED           JOB                       STATUS            DRAFTS  DETAIL\n' +
        '  2026-11-24 02:15  nightly                   ok                2       closed\n'
    );
    setLanguage('es');
    expect((await jobs('history')).out).toBe(
      '  INICIO            TRABAJO                   ESTADO            BORRADORES  DETALLE\n' +
        '  2026-11-24 02:15  nightly                   ok                2           closed\n'
    );
    vi.mocked(store.listRuns).mockResolvedValue([]);
  });
});

describe('I8.6 · jobs create, enable and disable speak by key', () => {
  beforeEach(() => {
    vi.mocked(store.createJob).mockResolvedValue(job(ID1, 'nightly-close'));
    vi.mocked(store.setEnabled).mockResolvedValue(job(ID1, 'nightly-close'));
  });
  const create = ['create', '--name', 'nightly-close', '--kind', 'close_verification', '--schedule', '0 2 * * *'];

  it('jobs create: the receipt, the summary and the tick hint', async () => {
    expect((await jobs(...create)).out).toBe(
      `Job created: ${ID1}\n` +
        '  nightly-close (close_verification) · schedule 0 2 * * * · next run 2026-11-24 02:15\n' +
        '  Adopted for you: with jobs.run_due set to "adopted", your tick runs it.\n' +
        '  Wire the tick: schedule `mnemosine jobs run-due` in cron/launchd.\n'
    );
    setLanguage('es');
    const { out } = await jobs(...create);
    expect(out).toContain(`Trabajo creado: ${ID1}\n`);
    expect(out).toContain('  nightly-close (close_verification) · calendario 0 2 * * * · próxima corrida 2026-11-24 02:15\n');
    expect(out).toContain('  Conecta el tic: programa `mnemosine jobs run-due` en cron/launchd.\n');
  });

  it('jobs enable and disable', async () => {
    expect((await jobs('enable', ID1)).out).toBe('Job "nightly-close" enabled · next run 2026-11-24 02:15\n');
    expect((await jobs('disable', ID1)).out).toBe('Job "nightly-close" disabled.\n');
    setLanguage('es');
    expect((await jobs('enable', ID1)).out).toBe('Trabajo "nightly-close" habilitado · próxima corrida 2026-11-24 02:15\n');
    expect((await jobs('disable', ID1)).out).toBe('Trabajo "nightly-close" deshabilitado.\n');
  });
});

describe('I8.6 · jobs run-due speaks by key', () => {
  const ALL = 'jobs.run_due is "all": this tick runs every due job of the entity on your credential, including jobs that other people created.\n';

  it('the dry run: nothing due, then one, with the key note on stderr', async () => {
    expect((await jobs('run-due', '--dry-run')).out).toBe(`${ALL}No jobs due.\n`);
    vi.mocked(store.listJobs).mockResolvedValue([job(ID1, 'nightly', { next_run_at: PAST })]);
    const r = await jobs('run-due', '--dry-run', '--idempotency-key', 'k1');
    expect(r.err).toBe(
      '  --idempotency-key does not apply to the tick: each due job is claimed atomically, and ' +
        'deduplicating ticks would silently skip legitimate runs.\n'
    );
    expect(r.out).toBe(
      `${ALL}  would run: nightly                   close_verification  next_run 2025-12-31 18:00\n` +
        '\n(dry-run: 1 job(s) due; nothing was claimed or run)\n'
    );
  });

  it('the dry run in Spanish, with its plural', async () => {
    setLanguage('es');
    vi.mocked(store.listJobs).mockResolvedValue([job(ID1, 'nightly', { next_run_at: PAST })]);
    let r = await jobs('run-due', '--dry-run', '--idempotency-key', 'k1');
    expect(r.err).toContain('--idempotency-key no aplica al tic');
    expect(r.out).toContain('  correría: nightly                   close_verification  próxima corrida 2025-12-31 18:00\n');
    expect(r.out).toContain('\n(--dry-run: 1 trabajo vencido; no se reclamó ni corrió nada)\n');
    vi.mocked(store.listJobs).mockResolvedValue([
      job(ID1, 'nightly', { next_run_at: PAST }), job(ID2, 'weekly', { next_run_at: PAST }),
    ]);
    r = await jobs('run-due', '--dry-run');
    expect(r.out).toContain('(--dry-run: 2 trabajos vencidos;');
    vi.mocked(store.listJobs).mockResolvedValue([]);
    expect((await jobs('run-due', '--dry-run')).out).toContain('Ningún trabajo está vencido.\n');
  });

  it('a sandbox tick that finds nothing', async () => {
    expect((await jobs('run-due', '--yes')).out).toBe(
      ALL +
        'sandbox: jobs run without the external reads (external_pull / external_diff_trial_balance). ' +
        'A reconciliation cron needs the full surface: schedule `mnemosine jobs run-due --live`.\n' +
        'profile line\nNo jobs due.\n'
    );
    setLanguage('es');
    expect((await jobs('run-due', '--yes')).out).toContain(
      'sandbox: los trabajos corren sin las lecturas externas (external_pull / external_diff_trial_balance). ' +
        'Un cron de conciliación necesita la superficie completa: programa `mnemosine jobs run-due --live`.\n'
    );
  });

  it('a live tick: each outcome, the auto-disable and record warnings, and the drafts', async () => {
    vi.mocked(runner.runDueJobs).mockResolvedValue([
      outcome({ draftsCreated: 2 }),
      outcome({ jobId: ID2, name: 'weekly', status: 'error', detail: 'boom', draftsCreated: 1, autoDisabled: true, recordError: 'db down' }),
    ]);
    expect((await jobs('run-due', '--live', '--yes')).out).toBe(
      `${ALL}profile line\n` +
        '  nightly                   ok                drafts: 2  done\n' +
        '  weekly                    error             drafts: 1  boom\n' +
        `  ⚠ Job "weekly" reached its failure limit and was auto-disabled. Re-enable with: mnemosine jobs enable ${ID2}\n` +
        '  ⚠ Run of "weekly" could not be recorded in the history: db down\n' +
        '\n3 draft(s) created — review them with `mnemosine review`.\n'
    );
    setLanguage('es');
    const { out } = await jobs('run-due', '--live', '--yes');
    expect(out).toContain('  nightly                   ok                borradores: 2  done\n');
    expect(out).toContain(
      `  ⚠ El trabajo "weekly" llegó a su límite de fallos y se deshabilitó solo. Vuelve a habilitarlo con: mnemosine jobs enable ${ID2}\n`
    );
    expect(out).toContain('  ⚠ La corrida de "weekly" no se pudo registrar en el historial: db down\n');
    expect(out).toContain('\n3 borradores creados: se revisan con `mnemosine review`.\n');
    vi.mocked(runner.runDueJobs).mockResolvedValue([outcome({ draftsCreated: 1 })]);
    expect((await jobs('run-due', '--live', '--yes')).out).toContain('\n1 borrador creado: se revisa con `mnemosine review`.\n');
    setLanguage('en');
    expect((await jobs('run-due', '--live', '--yes')).out).toContain('\n1 draft(s) created — review them with `mnemosine review`.\n');
    vi.mocked(runner.runDueJobs).mockResolvedValue([]);
  });
});
