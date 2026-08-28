import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../src/database/connection.js', () => ({
  query: vi.fn(),
  withTransaction: vi.fn(),
  enterTenant: vi.fn(),
  currentTenant: vi.fn(),
}));

// The wizard's finale runs the real doctor; these tests script its verdict.
vi.mock('../../../src/ai/doctor-service.js', () => ({
  runDoctor: vi.fn(),
}));

// runInitWizard builds the real sections; the wizard tests substitute stubs
// so no test depends on six sections' worth of query choreography.
const hoisted = vi.hoisted(() => ({
  sections: [] as unknown[],
  useStubs: false,
}));
vi.mock('../../../src/cli/init/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/cli/init/index.js')>();
  return {
    ...real,
    buildSections: (cwd?: string) =>
      hoisted.useStubs ? (hoisted.sections as ReturnType<typeof real.buildSections>) : real.buildSections(cwd),
  };
});

// The hatch needs an interactive terminal; readline is scripted.
const rlAnswers = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({
    question: async () => rlAnswers.queue.shift() ?? '',
    close: () => undefined,
  }),
}));

import { ImportSection, XML_FIRST_RUN_CAP } from '../../../src/cli/init/s5-import.js';
import {
  runInitWizard,
  resolveSectionId,
  type InitWizardResult,
} from '../../../src/cli/init-command.js';
import type { SectionContext, SetupSection, SectionStatus } from '../../../src/cli/init/section.js';
import type { AgentContext } from '../../../src/ai/context.js';
import { query } from '../../../src/database/connection.js';
import { runDoctor } from '../../../src/ai/doctor-service.js';

const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
const mockRunDoctor = runDoctor as unknown as ReturnType<typeof vi.fn>;

const ENTITY: AgentContext = {
  entityId: 'e1', entityName: 'Acme', tenantId: 't1', currency: 'MXN',
  country: 'MX', accountingStandard: 'NIF', taxId: 'AME010101AAA',
};
const REVIEWER = { userId: 'u1', email: 'jefa@acme.mx' };

/** Section context that captures output and answers a fixed script. */
function makeCtx(answers: {
  text?: (string | null)[]; confirms?: boolean[]; flags?: Record<string, unknown>;
} = {}): SectionContext & { lines: string[] } {
  const lines: string[] = [];
  const text = [...(answers.text ?? [])];
  const confirms = [...(answers.confirms ?? [])];
  return {
    rl: {} as never, // interactive unless the test overrides it
    flags: answers.flags ?? {},
    lines,
    print: (l?: string) => lines.push(l ?? ''),
    askText: async (_p: string, fallback?: string) =>
      text.length ? text.shift()! : (fallback ?? null),
    askSecret: async () => null,
    confirm: async (_p: string, d = true) => (confirms.length ? confirms.shift()! : d),
  };
}

function countsRow(entries: number, xmls: number, onboardingDrafts: number) {
  return {
    rows: [{
      entries: String(entries), xmls: String(xmls),
      onboarding_drafts: String(onboardingDrafts),
    }],
  };
}

function makeSection(overrides: Partial<Parameters<typeof deps>[0]> = {}) {
  return new ImportSection(deps(overrides));
}

function deps(overrides: {
  env?: NodeJS.ProcessEnv;
  plan?: ReturnType<typeof vi.fn>;
  execute?: ReturnType<typeof vi.fn>;
  ingest?: ReturnType<typeof vi.fn>;
  listXmlFiles?: (dir: string) => string[];
  resolveEntity?: () => Promise<AgentContext>;
}) {
  return {
    resolveEntity: overrides.resolveEntity ?? (async () => ENTITY),
    resolveReviewer: async () => REVIEWER,
    planOnboarding: (overrides.plan ?? vi.fn()) as never,
    executeOnboarding: (overrides.execute ?? vi.fn()) as never,
    ingest: (overrides.ingest ?? vi.fn()) as never,
    createSession: async () => ({ label: 'stub', runTurn: async () => '', reset: () => undefined }),
    env: overrides.env ?? {},
    listXmlFiles: overrides.listXmlFiles ?? (() => []),
  };
}

const SMALL_PLAN = {
  provider: 'contalink', startDate: '2026-01-01', cutoffDate: '2026-06-30',
  reference: 'onboarding:contalink:2026-06-30',
  remoteAccounts: 3, existingAccounts: 1,
  accountsToCreate: [{ code: '1000', name: 'Caja', account_type: 'asset', normal_balance: 'debit', confident: true }],
  openingLines: [{ account_code: '1000', debit: 100, description: 'Opening' }],
  totals: { debits: '100.00', credits: '100.00', imbalance: '0.00' },
  needsBalancingAccount: false,
};

beforeEach(() => {
  mockQuery.mockReset();
  mockRunDoctor.mockReset();
  hoisted.useStubs = false;
  hoisted.sections = [];
  rlAnswers.queue = [];
});

describe('S5 · status/verify truth table', () => {
  it('ok when the entity already has journal entries', async () => {
    mockQuery.mockResolvedValue(countsRow(5, 0, 0));
    expect(await makeSection().status()).toBe('ok');
  });

  it('ok when CFDIs were ingested even without entries', async () => {
    mockQuery.mockResolvedValue(countsRow(0, 3, 0));
    expect(await makeSection().status()).toBe('ok');
  });

  it('missing when the books are empty', async () => {
    mockQuery.mockResolvedValue(countsRow(0, 0, 0));
    expect(await makeSection().status()).toBe('missing');
  });

  it('partial while an onboarding draft awaits approval (import mid-flight)', async () => {
    mockQuery.mockResolvedValue(countsRow(0, 0, 1));
    expect(await makeSection().status()).toBe('partial');
  });

  it('missing when no entity resolves yet (nothing to import into)', async () => {
    const s = makeSection({ resolveEntity: async () => { throw new Error('no entity'); } });
    expect(await s.status()).toBe('missing');
  });

  it('verify points empty books at the import commands (no dead end)', async () => {
    mockQuery.mockResolvedValue(countsRow(0, 0, 0));
    const checks = await makeSection().verify();
    const data = checks.find((c) => c.name === 'Accounting data');
    expect(data?.level).toBe('warn');
    expect(data?.fix).toMatch(/mnemosine onboard/);
  });

  it('verify surfaces the pending onboarding draft with its next command', async () => {
    mockQuery.mockResolvedValue(countsRow(0, 0, 2));
    const checks = await makeSection().verify();
    const draft = checks.find((c) => c.name === 'Onboarding draft');
    expect(draft?.level).toBe('warn');
    expect(draft?.fix).toMatch(/mnemosine review/);
  });
});

describe('S5 · configure choices', () => {
  it('Enter defaults to [3] start fresh — never a surprise import', async () => {
    const plan = vi.fn();
    const ingest = vi.fn();
    const ctx = makeCtx({ text: [] }); // Enter on the choice → fallback '3'
    await makeSection({ plan, ingest }).configure(ctx);
    const out = ctx.lines.join('\n');
    expect(out).toMatch(/Starting fresh/);
    expect(out).toMatch(/mnemosine onboard --help/);
    expect(plan).not.toHaveBeenCalled();
    expect(ingest).not.toHaveBeenCalled();
  });

  it('explains why it asks and that nothing posts without a human, BEFORE asking', async () => {
    const ctx = makeCtx({ text: ['3'] });
    await makeSection({}).configure(ctx);
    const out = ctx.lines.join('\n');
    expect(out).toMatch(/Why I ask: mnemosine is most useful when it sees your real books/);
    expect(out).toMatch(/nothing posts without you/);
  });

  it('--yes never imports: starts fresh and says how to import later', async () => {
    const plan = vi.fn();
    const ctx = makeCtx({ flags: { yes: true } });
    await makeSection({ plan }).configure(ctx);
    expect(ctx.lines.join('\n')).toMatch(/Non-interactive mode: starting fresh/);
    expect(plan).not.toHaveBeenCalled();
  });

  it('[1] without CONTALINK_API_KEY: exact env line, exact resume command, no call', async () => {
    const plan = vi.fn();
    const ctx = makeCtx({ text: ['1'] }); // provider Enter → contalink default
    await makeSection({ plan, env: {} }).configure(ctx);
    const out = ctx.lines.join('\n');
    expect(out).toMatch(/CONTALINK_API_KEY=<your key>/);
    expect(out).toMatch(/mnemosine init --section import/);
    expect(out).toMatch(/incomplete/);
    expect(plan).not.toHaveBeenCalled();
  });

  it('[1] rejects a malformed cutoff before touching the remote system', async () => {
    const plan = vi.fn();
    const ctx = makeCtx({ text: ['1', 'contalink', 'junio'] });
    await makeSection({ plan, env: { CONTALINK_API_KEY: 'k' } }).configure(ctx);
    expect(ctx.lines.join('\n')).toMatch(/must be YYYY-MM-DD/);
    expect(plan).not.toHaveBeenCalled();
  });

  it('[1] plan → confirm → execute as a DRAFT (postNow off), then review pointer', async () => {
    const plan = vi.fn().mockResolvedValue(SMALL_PLAN);
    const execute = vi.fn().mockResolvedValue({ accountsCreated: 1, draftId: 'd1' });
    const ctx = makeCtx({ text: ['1', 'contalink', '2026-06-30'], confirms: [true] });
    await makeSection({ plan, execute, env: { CONTALINK_API_KEY: 'k' } }).configure(ctx);

    expect(plan).toHaveBeenCalledWith(ENTITY, 'contalink', '2026-01-01', '2026-06-30');
    expect(execute).toHaveBeenCalledWith(
      ENTITY, SMALL_PLAN, REVIEWER,
      expect.objectContaining({ postNow: false })
    );
    expect(ctx.lines.join('\n')).toMatch(/Review the drafts: mnemosine review/);
  });

  it('[1] declining the confirmation executes nothing (default is No)', async () => {
    const plan = vi.fn().mockResolvedValue(SMALL_PLAN);
    const execute = vi.fn();
    // no confirms scripted → ctx.confirm returns the default, which is false
    const ctx = makeCtx({ text: ['1', 'contalink', '2026-06-30'] });
    await makeSection({ plan, execute, env: { CONTALINK_API_KEY: 'k' } }).configure(ctx);
    expect(execute).not.toHaveBeenCalled();
    expect(ctx.lines.join('\n')).toMatch(/Cancelled/);
  });

  it('[2] caps the first run at 50 files with a note and the follow-up command', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `/facturas/f${i}.xml`);
    const ingest = vi.fn().mockResolvedValue({
      results: [],
      counts: { rules: 0, auto_post: 0, draft: 50, blocked: 0, duplicate: 0, invalid: 0, error: 0 },
    });
    const ctx = makeCtx({ text: ['2', '/facturas'] });
    await makeSection({ ingest, listXmlFiles: () => many }).configure(ctx);

    expect(ingest).toHaveBeenCalledOnce();
    const call = ingest.mock.calls[0][0];
    expect(call.files).toHaveLength(XML_FIRST_RUN_CAP);
    expect(call.thresholds.autoPost).toBe(false);
    const out = ctx.lines.join('\n');
    expect(out).toMatch(/taking the first 50 on this first run/);
    expect(out).toMatch(/mnemosine ingest/);
    expect(out).toMatch(/Review the drafts: mnemosine review/);
  });

  it('[2] with an empty folder points at mnemosine ingest instead of dead-ending', async () => {
    const ingest = vi.fn();
    const ctx = makeCtx({ text: ['2', '/vacia'] });
    await makeSection({ ingest, listXmlFiles: () => [] }).configure(ctx);
    expect(ingest).not.toHaveBeenCalled();
    expect(ctx.lines.join('\n')).toMatch(/No \*\.xml files found.*mnemosine ingest/);
  });
});

describe('--section aliases', () => {
  it('accepts import and importar for the new section', () => {
    expect(resolveSectionId('import')).toBe('importar');
    expect(resolveSectionId('importar')).toBe('importar');
  });
});

// ─── runInitWizard contract ───

function stubSection(id: string, status: SectionStatus): SetupSection {
  return {
    id: id as never,
    title: id,
    required: false,
    status: async () => status,
    configure: async () => undefined,
    verify: async () => [],
  };
}

/** All sections already configured; import's status drives the seed choice. */
function healthySections(importStatus: SectionStatus): SetupSection[] {
  return [
    stubSection('infra', 'ok'), stubSection('identidad', 'ok'),
    stubSection('usuarios', 'ok'), stubSection('ia', 'ok'),
    stubSection('politicas', 'ok'), stubSection('importar', importStatus),
  ];
}

describe('runInitWizard contract', () => {
  let logs: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let ttyDescriptor: PropertyDescriptor | undefined;

  function setStdinTty(value: boolean) {
    Object.defineProperty(process.stdin, 'isTTY', { value, configurable: true });
  }

  beforeEach(() => {
    logs = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((l?: unknown) => {
      logs.push(String(l ?? ''));
    }) as never;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    hoisted.useStubs = true;
    mockRunDoctor.mockResolvedValue({ worst: 'ok', checks: [] });
  });

  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
    if (ttyDescriptor) Object.defineProperty(process.stdin, 'isTTY', ttyDescriptor);
    else setStdinTty(false);
  });

  it('rescue + healthy + accounting data: offers chat with the books-check seed', async () => {
    hoisted.sections = healthySections('ok');
    setStdinTty(true);
    rlAnswers.queue = ['']; // Enter on "Start chatting now? [Y/n]" → yes

    const result: InitWizardResult = await runInitWizard({ rescue: true });

    expect(result).toEqual({
      completed: true,
      offerChat: true,
      seedMessage: 'Say hello and give me a quick health check of my books.',
    });
    const out = logs.join('\n');
    // The hatch is ANNOUNCED before returning: no silent auto-actions.
    expect(out).toMatch(/I'll open the chat and send your first message/);
    expect(out).toMatch(/The agent reads your real data/);
  });

  it('rescue without accounting data: the seed asks what the agent can do later', async () => {
    hoisted.sections = healthySections('missing');
    setStdinTty(true);
    rlAnswers.queue = [''];

    const result = await runInitWizard({ rescue: true });
    expect(result.offerChat).toBe(true);
    expect(result.seedMessage).toBe(
      'Say hello and tell me what you can do once I load my accounting.'
    );
  });

  it('command mode (no rescue): a yes prints the receipt and NEVER offers auto-launch', async () => {
    hoisted.sections = healthySections('ok');
    setStdinTty(true);
    rlAnswers.queue = [''];

    const result = await runInitWizard({});
    expect(result).toEqual({ completed: true, offerChat: false });
    expect(logs.join('\n')).toMatch(/Open the chat with: mnemosine/);
  });

  it('declining the hatch prints the journey footer instead', async () => {
    hoisted.sections = healthySections('ok');
    setStdinTty(true);
    rlAnswers.queue = ['n'];

    const result = await runInitWizard({ rescue: true });
    expect(result).toEqual({ completed: true, offerChat: false });
    const out = logs.join('\n');
    expect(out).toMatch(/Ready\. Try:/);
    expect(out).toMatch(/mnemosine chat/);
    expect(out).toMatch(/mnemosine review/);
    expect(out).toMatch(/mnemosine status/);
  });

  it('--yes never hatches: completes without asking anything', async () => {
    hoisted.sections = healthySections('ok');
    setStdinTty(true);
    rlAnswers.queue = []; // nothing scripted: any question would return ''

    const result = await runInitWizard({ yes: true });
    expect(result).toEqual({ completed: true, offerChat: false });
    expect(logs.join('\n')).not.toMatch(/Start chatting now/);
  });

  it('an unhealthy doctor verdict returns incomplete and never offers chat', async () => {
    hoisted.sections = healthySections('ok');
    setStdinTty(true);
    mockRunDoctor.mockResolvedValue({ worst: 'fail', checks: [] });

    const result = await runInitWizard({ rescue: true });
    expect(result).toEqual({ completed: false, offerChat: false });
    expect(logs.join('\n')).toMatch(/Run again: mnemosine init/);
  });

  it('rescue skips the setup header and shows the warmer resume-for-free intro', async () => {
    hoisted.sections = healthySections('ok');
    setStdinTty(true);
    rlAnswers.queue = ['n'];

    await runInitWizard({ rescue: true });
    const out = logs.join('\n');
    expect(out).toMatch(/Let's get you set up/);
    expect(out).toMatch(/state lives in the system, not a file/);
    expect(out).not.toMatch(/Mnemosine setup/);
  });

  it('an unknown --section names the options and reports not-completed', async () => {
    hoisted.useStubs = true;
    hoisted.sections = healthySections('ok');
    const result = await runInitWizard({ section: 'nope' });
    expect(result).toEqual({ completed: false, offerChat: false });
  });
});
