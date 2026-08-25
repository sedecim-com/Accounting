import fs from 'node:fs';
import path from 'node:path';
import { query } from '../../database/connection.js';
import { resolveEntity, type AgentContext } from '../../ai/context.js';
import { resolveReviewer, type Reviewer } from '../../ai/draft-service.js';
import {
  planOnboarding,
  executeOnboarding,
  type OnboardingPlan,
  type OnboardingResult,
} from '../../ai/onboarding-service.js';
import { ingestCfdiFiles, type DraftCapture, type IngestReport } from '../../ai/ingest-service.js';
import {
  createLlmSession,
  resolveProfile,
  type LlmSession,
} from '../../ai/providers/index.js';
import { resolveIngestThresholds } from '../../ai/providers/config.js';
import type { CheckResult } from '../../ai/doctor-service.js';
import type { SectionContext, SectionStatus, SetupSection } from './section.js';

// ============================================================
// S5 · BRING YOUR ACCOUNTING IN
// The friendliest possible on-ramp: the system is most useful
// when it sees real books, so the wizard closes by offering to
// load them. Three doors, none of them scary:
//   1. Import from another accounting system by API (Contalink)
//      — plan → confirm → execute, on top of the EXISTING
//      onboarding service (thin orchestration only).
//   2. Ingest CFDI XML files from a folder — the EXISTING ingest
//      pipeline, auto-post OFF: everything lands as drafts.
//   3. Start fresh — the default. Never surprise-import.
// Everything lands as reviewable drafts; nothing posts without a
// human. No secrets are prompted here: the Contalink key lives
// in .env, never in the config.
// ============================================================

/** First-run cap so an accidental point at a huge folder stays reviewable. */
export const XML_FIRST_RUN_CAP = 50;

interface ImportCounts {
  entries: number;
  xmls: number;
  onboardingDrafts: number;
}

export interface ImportSectionDeps {
  resolveEntity?: typeof resolveEntity;
  resolveReviewer?: (tenantId: string, email?: string) => Promise<Reviewer>;
  planOnboarding?: (
    ctx: AgentContext, provider: string, startDate: string, cutoffDate: string
  ) => Promise<OnboardingPlan>;
  executeOnboarding?: (
    ctx: AgentContext, plan: OnboardingPlan, reviewer: Reviewer,
    opts?: { balanceAccountCode?: string; postNow?: boolean }
  ) => Promise<OnboardingResult>;
  ingest?: typeof ingestCfdiFiles;
  /** Builds the LLM session the ingest pipeline classifies with. */
  createSession?: (
    ctx: AgentContext,
    onDraftCreated: (info: DraftCapture['drafts'][number]) => void
  ) => Promise<LlmSession>;
  /** Environment to read CONTALINK_API_KEY from (injectable for tests). */
  env?: NodeJS.ProcessEnv;
  /** Lists *.xml files in a folder, absolute paths (injectable for tests). */
  listXmlFiles?: (dir: string) => string[];
}

function defaultListXmlFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.xml'))
    .sort()
    .map((f) => path.join(dir, f));
}

async function defaultCreateSession(
  ctx: AgentContext,
  onDraftCreated: (info: DraftCapture['drafts'][number]) => void
): Promise<LlmSession> {
  const profile = resolveProfile(undefined, undefined);
  // Batch classification pipeline: the grounding corrective turn is
  // harness-initiated and must not add drafts behind the wizard's back.
  return createLlmSession(profile, ctx, { onDraftCreated }, { grounding: { enabled: false } });
}

export class ImportSection implements SetupSection {
  readonly id = 'importar' as const;
  readonly title = 'Bring your accounting in';
  /** Never blocks setup: starting fresh is a legitimate answer. */
  readonly required = false;

  private readonly deps: Required<ImportSectionDeps>;

  constructor(deps: ImportSectionDeps = {}) {
    this.deps = {
      resolveEntity: deps.resolveEntity ?? resolveEntity,
      resolveReviewer: deps.resolveReviewer ?? resolveReviewer,
      planOnboarding: deps.planOnboarding ?? planOnboarding,
      executeOnboarding: deps.executeOnboarding ?? executeOnboarding,
      ingest: deps.ingest ?? ingestCfdiFiles,
      createSession: deps.createSession ?? defaultCreateSession,
      env: deps.env ?? process.env,
      listXmlFiles: deps.listXmlFiles ?? defaultListXmlFiles,
    };
  }

  /** One round trip: entries, ingested XMLs and unapproved onboarding drafts. */
  private async counts(entityId: string): Promise<ImportCounts> {
    const result = await query<{ entries: string; xmls: string; onboarding_drafts: string }>(
      `SELECT
         (SELECT COUNT(*) FROM journal_entries
            WHERE entity_id = $1 AND status != 'void')::text AS entries,
         (SELECT COUNT(*) FROM xml_documents WHERE entity_id = $1)::text AS xmls,
         (SELECT COUNT(*) FROM ai_drafts
            WHERE entity_id = $1 AND status = 'pending_review'
              AND payload->>'reference' LIKE 'onboarding:%')::text AS onboarding_drafts`,
      [entityId]
    );
    const row = result.rows[0];
    return {
      entries: parseInt(row.entries, 10),
      xmls: parseInt(row.xmls, 10),
      onboardingDrafts: parseInt(row.onboarding_drafts, 10),
    };
  }

  async status(): Promise<SectionStatus> {
    try {
      const entity = await this.deps.resolveEntity(undefined);
      const c = await this.counts(entity.entityId);
      // An unapproved onboarding draft means an import is mid-flight: the
      // opening balance exists but has not reached the books yet.
      if (c.onboardingDrafts > 0) return 'partial';
      if (c.entries > 0 || c.xmls > 0) return 'ok';
      return 'missing';
    } catch {
      return 'missing';
    }
  }

  async configure(ctx: SectionContext): Promise<void> {
    let entity: AgentContext;
    try {
      entity = await this.deps.resolveEntity(ctx.flags.entity);
    } catch {
      ctx.print('  No entity resolved yet; the import comes after the entity exists.');
      return;
    }

    // Explain BEFORE asking (house idiom): why, and what happens to the data.
    ctx.print('');
    ctx.print('  Why I ask: mnemosine is most useful when it sees your real books.');
    ctx.print('  What I do: everything lands as reviewable drafts — nothing posts without you.');
    ctx.print('');
    ctx.print('  How would you like to start?');
    ctx.print('    1) Import from another accounting system by API (Contalink today)');
    ctx.print('    2) Ingest CFDI XML files from a folder');
    ctx.print('    3) Start fresh — you can import anytime later');

    // --yes mode must not ask, and an import is never a surprise default.
    if (!ctx.rl || ctx.flags.yes) {
      ctx.print('');
      ctx.print('  Non-interactive mode: starting fresh. You can import anytime: mnemosine onboard --help');
      return;
    }

    const raw = await ctx.askText('  Choice [1/2/3] (3): ', '3');
    const choice = (raw ?? '3').trim() || '3';

    if (choice === '1') {
      await this.importByApi(ctx, entity);
    } else if (choice === '2') {
      await this.ingestFolder(ctx, entity);
    } else {
      ctx.print('  Starting fresh. You can import anytime: mnemosine onboard --help');
    }
  }

  /** [1] Plan → confirm → execute over the existing onboarding service. */
  private async importByApi(ctx: SectionContext, entity: AgentContext): Promise<void> {
    const provider =
      (await ctx.askText('  External system (contalink): ', 'contalink')) ?? 'contalink';

    if (provider === 'contalink' && !this.deps.env.CONTALINK_API_KEY) {
      // No dead end: the exact line to add, and where the flow resumes.
      ctx.print('');
      ctx.print('  The contalink provider needs an API key that is not set yet.');
      ctx.print('  Add this line to your .env (the key never goes in the config):');
      ctx.print('    CONTALINK_API_KEY=<your key>');
      ctx.print('  Then re-run: mnemosine init --section import');
      ctx.print('  Section left incomplete for now.');
      return;
    }

    const cutoff = await ctx.askText('  Cutoff date, balances as of YYYY-MM-DD: ');
    if (!cutoff || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff.trim())) {
      ctx.print('  The cutoff must be YYYY-MM-DD. Nothing was imported — re-run when ready:');
      ctx.print('    mnemosine init --section import');
      return;
    }
    const cutoffDate = cutoff.trim();
    const startDate = `${cutoffDate.slice(0, 4)}-01-01`;

    let plan: OnboardingPlan;
    try {
      ctx.print('  Reading the remote trial balance…');
      plan = await this.deps.planOnboarding(entity, provider, startDate, cutoffDate);
    } catch (err) {
      ctx.print(`  Could not plan the import: ${err instanceof Error ? err.message : String(err)}`);
      ctx.print('  Nothing was created. Full control over the import: mnemosine onboard --help');
      return;
    }

    ctx.print('');
    ctx.print(
      `  Remote accounts: ${plan.remoteAccounts} · already exist: ${plan.existingAccounts} · ` +
        `to create: ${plan.accountsToCreate.length}`
    );
    ctx.print(
      `  Opening balance: ${plan.openingLines.length} line(s) · ` +
        `debits ${plan.totals.debits} · credits ${plan.totals.credits}`
    );
    if (plan.openingLines.length === 0) {
      ctx.print('  Nothing to import: the remote trial balance has no balances.');
      return;
    }

    let balanceAccountCode: string | undefined;
    if (plan.needsBalancingAccount) {
      ctx.print(`  The remote trial balance does not balance (difference ${plan.totals.imbalance}).`);
      balanceAccountCode =
        (await ctx.askText('  Balancing account code (3200): ', '3200')) ?? '3200';
    }

    // Same consequence wording the onboard command uses; default is No.
    const go = await ctx.confirm(
      `  Create ${plan.accountsToCreate.length} account(s) and the opening balance as a draft?`,
      false
    );
    if (!go) {
      ctx.print('  Cancelled. Nothing was created. You can import anytime: mnemosine onboard --help');
      return;
    }

    try {
      const reviewer = await this.deps.resolveReviewer(entity.tenantId, ctx.flags.user);
      const result = await this.deps.executeOnboarding(entity, plan, reviewer, {
        balanceAccountCode,
        postNow: false,
      });
      ctx.print(`  ✔ ${result.accountsCreated} account(s) created.`);
      ctx.print(`  ✔ Opening balance in draft ${result.draftId} (ref ${plan.reference}).`);
      ctx.print('  Review the drafts: mnemosine review');
    } catch (err) {
      ctx.print(`  Import failed: ${err instanceof Error ? err.message : String(err)}`);
      ctx.print('  Retry with full control: mnemosine onboard --help');
    }
  }

  /** [2] Folder of CFDIs through the existing ingest pipeline, auto-post OFF. */
  private async ingestFolder(ctx: SectionContext, entity: AgentContext): Promise<void> {
    const dir = await ctx.askText('  Folder with CFDI XML files: ');
    if (!dir) {
      ctx.print('  No folder given. You can ingest anytime: mnemosine ingest <files…>');
      return;
    }

    let files: string[];
    try {
      files = this.deps.listXmlFiles(dir.trim());
    } catch (err) {
      ctx.print(`  Could not read the folder: ${err instanceof Error ? err.message : String(err)}`);
      ctx.print('  You can ingest anytime: mnemosine ingest <files…>');
      return;
    }
    if (files.length === 0) {
      ctx.print('  No *.xml files found there. You can ingest anytime: mnemosine ingest <files…>');
      return;
    }

    let batch = files;
    if (files.length > XML_FIRST_RUN_CAP) {
      batch = files.slice(0, XML_FIRST_RUN_CAP);
      ctx.print(
        `  Found ${files.length} files; taking the first ${XML_FIRST_RUN_CAP} on this first run ` +
          'so the review stays manageable. Ingest the rest with: mnemosine ingest <files…>'
      );
    } else {
      ctx.print(`  Found ${files.length} file(s).`);
    }

    try {
      const reviewer = await this.deps.resolveReviewer(entity.tenantId, ctx.flags.user);
      const capture: DraftCapture = { drafts: [] };
      const session = await this.deps.createSession(entity, (info) => capture.drafts.push(info));
      // Auto-post OFF regardless of config: the wizard never posts on its own.
      const thresholds = resolveIngestThresholds({ autoPost: false });
      const report: IngestReport = await this.deps.ingest({
        ctx: entity,
        reviewer,
        files: batch,
        thresholds,
        session,
        capture,
        onProgress: (msg) => ctx.print(`    ${msg}`),
      });
      const c = report.counts;
      ctx.print(
        `  Done: ${c.rules} by rules, ${c.draft} draft(s), ${c.blocked} blocked, ` +
          `${c.duplicate} duplicate(s), ${c.invalid + c.error} with errors.`
      );
      ctx.print('  Review the drafts: mnemosine review');
    } catch (err) {
      ctx.print(`  Ingest failed: ${err instanceof Error ? err.message : String(err)}`);
      ctx.print('  Retry anytime: mnemosine ingest <files…>');
    }
  }

  async verify(): Promise<CheckResult[]> {
    const checks: CheckResult[] = [];
    try {
      const entity = await this.deps.resolveEntity(undefined);
      const c = await this.counts(entity.entityId);
      const hasData = c.entries > 0 || c.xmls > 0;
      checks.push({
        name: 'Accounting data',
        level: hasData ? 'ok' : 'warn',
        detail: hasData
          ? `${c.entries} journal entr${c.entries === 1 ? 'y' : 'ies'}, ${c.xmls} CFDI(s) ingested`
          : 'No accounting data yet',
        ...(hasData ? {} : { fix: 'Import with `mnemosine onboard` or ingest CFDIs with `mnemosine ingest`' }),
      });
      if (c.onboardingDrafts > 0) {
        checks.push({
          name: 'Onboarding draft',
          level: 'warn',
          detail: `${c.onboardingDrafts} opening-balance draft(s) awaiting approval`,
          fix: 'Approve or reject with `mnemosine review`',
        });
      }
    } catch (err) {
      checks.push({
        name: 'Accounting data',
        level: 'warn',
        detail: `Could not read: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return checks;
  }
}
